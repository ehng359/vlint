import { extractDataFigmaNames, FigmaPage, hasFileBeenUpdated, queryFigmaStyles } from '@vlint/core';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// ─── Manifest Parser ──────────────────────────────────────────────────────────
// Reads key=value pairs from design.manifest, ignoring blank lines and comments.
// Called on activation and again whenever design.manifest is saved.
function parseManifest(filePath: string): Record<string, string> {
	const content = fs.readFileSync(filePath, 'utf-8');
	return Object.fromEntries(
		content
			.split('\n')
			.filter(line => line.trim() && !line.startsWith('#'))
			.map(line => line.split('=').map(s => s.trim()))
	);
}

// ─── Value Normalisation ──────────────────────────────────────────────────────
// Ensures equivalent values in different formats compare as equal.
// e.g. "16px" === 16, "#FFF" === "#ffffff", "Bold" === 700
function normaliseValue(value: string | number): string {
	const str = String(value).trim();

	// Strip px and compare as numbers: "16px" === 16
	if (/^-?\d+(\.\d+)?px$/.test(str)) {
		return parseFloat(str).toString();
	}

	// Normalise font weight keywords to numbers
	const fontWeightMap: Record<string, string> = {
		thin: "100", extralight: "200", light: "300", regular: "400",
		normal: "400", medium: "500", semibold: "600", bold: "700",
		extrabold: "800", black: "900"
	};
	if (fontWeightMap[str.toLowerCase()]) {
		return fontWeightMap[str.toLowerCase()];
	}

	// Normalise hex colors to lowercase #rrggbb (handles #FFF -> #ffffff)
	const hex6 = str.match(/^#([0-9a-f]{6})$/i);
	if (hex6) return "#" + hex6[1].toLowerCase();

	const hex3 = str.match(/^#([0-9a-f]{3})$/i);
	if (hex3) {
		const [r, g, b] = hex3[1].split("");
		return "#" + r + r + g + g + b + b;
	}

	// Normalise rgba(255, 255, 255, 1) -> #ffffff
	const rgba = str.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/);
	if (rgba) {
		const a = rgba[4] !== undefined ? parseFloat(rgba[4]) : 1;
		if (a === 1) {
			return "#" + [rgba[1], rgba[2], rgba[3]]
				.map(n => parseInt(n).toString(16).padStart(2, "0"))
				.join("");
		}
		return `rgba(${rgba[1]}, ${rgba[2]}, ${rgba[3]}, ${a})`;
	}

	return str.toLowerCase();
}

function hasAliasConfigured(workspaceRoot: string): boolean {
	const tsconfig = path.join(workspaceRoot, 'tsconfig.json');
	if (!fs.existsSync(tsconfig)) return false;
	const content = JSON.parse(fs.readFileSync(tsconfig, 'utf-8'));
	return !!content?.compilerOptions?.paths?.['@/*'];
}

// ─── Activation ───────────────────────────────────────────────────────────────
// Called once when the extension is first activated (i.e. on first .tsx save).
export function activate(context: vscode.ExtensionContext) {
	console.log('[vlint] Extension activated.');

	const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
	const manifestPath = path.join(workspaceRoot!, "design.manifest");
	const designRefPath = path.join(workspaceRoot!, "DESIGN_REF.json");

	let manifest = parseManifest(manifestPath);

	// designRefContent is the parsed DESIGN_REF.json held in memory.
	// It is loaded from disk on activation, then kept fresh by the save handler.
	let designRefContent: FigmaPage;
	if (fs.existsSync(designRefPath)) {
		const parsed = JSON.parse(fs.readFileSync(designRefPath).toString());
		// If the cached file predates CSS generation, force a fresh fetch on next save.
		// generatedCss and typographyCss were added in the CSS-layer refactor.
		if (!parsed.generatedCss) {
			console.log('[vlint] DESIGN_REF.json is stale — will re-fetch on next save.');
		} else {
			designRefContent = parsed;
		}
	}

	// init forces a Figma fetch on the very first save after activation,
	// even if the cooldown hasn't elapsed.
	let init = true;

	// Cooldown prevents hammering the Figma API on every keystroke-save.
	// The metadata check (hasFileBeenUpdated) runs at most once per minute.
	let lastCheckedAt = 0;
	const CHECK_COOLDOWN_MS = 5_000;

	const outputChannel = vscode.window.createOutputChannel('vlint');
	outputChannel.show();

	function ensureAliasConfigured(workspaceRoot: string): void {
		const tsconfigPath = path.join(workspaceRoot, 'tsconfig.json');
		if (fs.existsSync(tsconfigPath)) {
			const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf-8'));
			tsconfig.compilerOptions ??= {};
			tsconfig.compilerOptions.paths ??= {};
			if (!tsconfig.compilerOptions.paths['@/*']) {
				tsconfig.compilerOptions.paths['@/*'] = ['./src/*'];
				fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));
				outputChannel.appendLine('[vlint] ✓ Added @ alias to tsconfig.json');
			}
		}

		const viteConfigPath = path.join(workspaceRoot, 'vite.config.ts');
		if (fs.existsSync(viteConfigPath)) {
			let content = fs.readFileSync(viteConfigPath, 'utf-8');
			if (!content.includes("'@'") && !content.includes('"@"')) {
				content = content.replace(
					'defineConfig({',
					`defineConfig({\n  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },`
				);
				if (!content.includes("import path")) {
					content = `import path from 'path';\n` + content;
				}
				fs.writeFileSync(viteConfigPath, content);
				outputChannel.appendLine('[vlint] ✓ Added @ alias to vite.config.ts');
			}
		}
	}

	if (!hasAliasConfigured(workspaceRoot!)) {
		outputChannel.appendLine('[vlint] ⚠ No @ alias found in vite/webpack config. CSS imports may fail to resolve.');
		ensureAliasConfigured(workspaceRoot!);
	}

	// ─── Save Handler ─────────────────────────────────────────────────────────
	// Runs on every document save. Orchestration order matters — see step comments.
	vscode.workspace.onDidSaveTextDocument(async (document: vscode.TextDocument) => {
		if (!fs.existsSync(manifestPath)) {
			outputChannel.appendLine('[vlint] No design.manifest found. Create one at the worksapce root to get started.')
			outputChannel.appendLine('[vlint] Required keys: FIGMA_PAT, FIGMA_FKEY, FIGMA_DEV_PAGE, FIGMA_STYLES_DIR')
		}
		// ── Step 0: Filter irrelevant files ──────────────────────────────────
		// Re-parse the manifest when it changes so new tokens/keys take effect
		// without needing to reload the window.
		if (document.fileName === "design.manifest") {
			manifest = parseManifest(manifestPath);
			return;
		}

		const lang = document.languageId;
		if (lang !== "javascriptreact" && lang !== "typescriptreact") return;

		// ── Step 1: Extract data-figma names from the saved document ─────────
		// extractDataFigmaNames reads @design-frame for the frame name and
		// scans all data-figma="X" attributes for component names.
		// This must happen before any later step that references componentNames.
		const documentContent = document.getText();
		const [frameName, componentNames] = extractDataFigmaNames(documentContent);

		// ── Step 2: Refresh Figma data if needed ─────────────────────────────
		// Fetches fresh styles from Figma only when:
		//   a) This is the first save since activation (init), OR
		//   b) The cooldown has elapsed AND Figma reports a newer lastModified.
		// On a cache hit, designRefContent and DESIGN_REF.json stay as-is.
		// AFTER
		const now = Date.now();
		const cooldownElapsed = (now - lastCheckedAt) > CHECK_COOLDOWN_MS;

		let shouldFetch = init;

		if (!init && cooldownElapsed) {
			// Always advance lastCheckedAt when a check is attempted — prevents
			// hammering the API on every save once the cooldown elapses
			lastCheckedAt = now;
			const updated = await hasFileBeenUpdated(manifest["FIGMA_FKEY"], manifest["FIGMA_PAT"]);
			if (updated) shouldFetch = true;
		}

		if (shouldFetch) {
			init = false;
			if (cooldownElapsed || lastCheckedAt === 0) lastCheckedAt = now;

			outputChannel.appendLine('[vlint] Fetching latest styles from Figma...');
			const figmaStyles = await queryFigmaStyles(
				manifest["FIGMA_DEV_PAGE"],
				manifest["FIGMA_FKEY"],
				manifest["FIGMA_PAT"]
			) as FigmaPage;

			designRefContent = figmaStyles;

			const refUri = vscode.Uri.joinPath(
				vscode.workspace.workspaceFolders![0].uri,
				'DESIGN_REF.json'
			);
			await vscode.workspace.fs.writeFile(
				refUri,
				Buffer.from(JSON.stringify(figmaStyles, null, 2), 'utf8')
			);
			outputChannel.appendLine('[vlint] DESIGN_REF.json updated.');
		}

		// ── Step 3: Write CSS files ───────────────────────────────────────────
		// Runs on every save using the cached designRefContent.
		// All generated CSS lives under src/styles/figma/ (configurable via
		// FIGMA_STYLES_DIR in design.manifest) so imports are always predictable.
		//
		// Two files are written:
		//   {FrameName}.figma.css  — layout + visual styles, @layer figma
		//   typography.figma.css   — text styles, @layer figma.typography
		//
		// Both layers sit below unlayered CSS, so developer overrides always win.
		if (designRefContent) {
			const figmaStylesDir = manifest["FIGMA_STYLES_DIR"] || 'src/styles/figma';
			const figmaStylesUri = vscode.Uri.joinPath(
				vscode.workspace.workspaceFolders![0].uri,
				...figmaStylesDir.split('/')
			);

			for (const [frame, css] of Object.entries(designRefContent.generatedCss || {})) {
				if (!css) continue;
				const cssUri = vscode.Uri.joinPath(figmaStylesUri, `${frame}.figma.css`);
				await vscode.workspace.fs.writeFile(cssUri, Buffer.from(css as string, 'utf8'));
				outputChannel.appendLine(`[vlint] Written ${figmaStylesDir}/${frame}.figma.css`);
			}
		}

		// ── Step 4: Guard against missing frame ───────────────────────────────
		// If the @design-frame annotation doesn't match any frame in DESIGN_REF.json,
		// there's nothing to compare against — bail early with a clear error.
		const frameContent = designRefContent?.nodes[frameName];
		if (!frameContent) {
			outputChannel.appendLine(`[Error] Frame "${frameName}" not found in DESIGN_REF.json`);
			return;
		}

		// ── Step 5: Mismatch reporting ────────────────────────────────────────
		// Cross-references every data-figma name in the document against
		// the Figma frame. Reports components that exist in code but are
		// absent from the Figma spec — likely a rename or deletion upstream.
		// No source edits happen here; this is read-only reporting.
		const mismatches: string[] = [];

		for (const componentName of componentNames) {
			const figmaElement = frameContent.children[componentName];

			if (!figmaElement) {
				mismatches.push(
					`[Warn] "${componentName}" has data-figma attribute but no match in Figma frame.`
				);
				continue;
			}

			outputChannel.appendLine(`✓ ${componentName} found in Figma spec.`);
		}

		if (mismatches.length > 0) {
			outputChannel.appendLine("\n[vlint] Mismatches detected:");
			mismatches.forEach(m => outputChannel.appendLine(m));
		}

		// ── Step 6: Inject CSS import ─────────────────────────────────────────
		// Adds the frame's .figma.css import to the top of the file if absent.
		// Uses the @/ alias so the path is stable regardless of where the
		// component lives in the directory tree.
		// Only writes if the import is genuinely missing to avoid save loops.
		const figmaStylesDir = manifest["FIGMA_STYLES_DIR"] || 'src/styles/figma';
		const cssImportLine = `import '@/styles/figma/${frameName}.figma.css';`;
		const alreadyImported = documentContent.includes(`styles/figma/${frameName}.figma.css`);

		const figmaStylesUri = vscode.Uri.joinPath(
			vscode.workspace.workspaceFolders![0].uri,
			...figmaStylesDir.split('/')
		);
		const cssUri = vscode.Uri.joinPath(figmaStylesUri, `${frameName}.figma.css`);
		const cssFileExists = await vscode.workspace.fs.stat(cssUri).then(() => true, () => false);

		if (!alreadyImported && cssFileExists) {
			const finalSource = cssImportLine + '\n' + documentContent;
			const edit = new vscode.WorkspaceEdit();
			edit.replace(
				document.uri,
				new vscode.Range(
					document.positionAt(0),
					document.positionAt(documentContent.length)
				),
				finalSource
			);
			const success = await vscode.workspace.applyEdit(edit);
			if (success) {
				outputChannel.appendLine(`[vlint] ✓ CSS import injected. Saving...`);
				await document.save();
			} else {
				outputChannel.appendLine(`[vlint] ✗ Failed to inject CSS import.`);
			}
		}
	});
}

// ─── Deactivation ─────────────────────────────────────────────────────────────
// Nothing to clean up currently — VSCode disposes the save listener automatically.
export function deactivate() { }