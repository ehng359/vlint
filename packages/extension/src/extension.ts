import {
	applyClassFixes, applyStyleFixes, ClassFix, extractDataFigmaNames, FigmaPage,
	FrameSpec, getFileMeta, lintSource, loadCssModules, parseManifest,
	queryFigmaStyles, setLogger, StyleFix, Violation, violationMessage,
	violationToClassFix, violationToStyleFix
} from '@vlint/core';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const PAT_SECRET_KEY = 'vlint.figmaPat';

// tsconfig.json is JSONC in most real projects; a parse failure must never
// crash activation, and never trigger a rewrite that would strip comments.
function readJsonConfig(filePath: string): any | null {
	try {
		return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
	} catch {
		return null;
	}
}

function hasAliasConfigured(workspaceRoot: string): boolean {
	const tsconfigPath = path.join(workspaceRoot, 'tsconfig.json');
	if (!fs.existsSync(tsconfigPath)) return false;
	const tsconfig = readJsonConfig(tsconfigPath);
	if (tsconfig === null) return true; // unparseable: assume configured, do not touch
	return !!tsconfig?.compilerOptions?.paths?.['@/*'];
}

// The '@' alias maps to src/, so only dirs under src/ get an alias import.
function importSpecifierFor(figmaStylesDir: string): string {
	return figmaStylesDir.startsWith('src/') ? '@/' + figmaStylesDir.slice(4) : figmaStylesDir;
}

function toDiagnostic(document: vscode.TextDocument, v: Violation): vscode.Diagnostic {
	const line = v.loc ? Math.max(0, v.loc.line - 1) : 0;
	const range = v.loc
		? new vscode.Range(line, v.loc.column, line, v.loc.column + Math.max(v.property.length, 1))
		: document.lineAt(0).range;

	const diagnostic = new vscode.Diagnostic(
		range,
		violationMessage(v),
		v.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning
	);
	diagnostic.source = 'vlint';
	diagnostic.code = v.kind;
	return diagnostic;
}

// ─── Activation ───────────────────────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext) {
	console.log('[vlint] Extension activated.');

	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspaceRoot) {
		console.log('[vlint] No workspace folder open, nothing to lint.');
		return;
	}
	const manifestPath = path.join(workspaceRoot, "design.manifest");
	const designRefPath = path.join(workspaceRoot, "DESIGN_REF.json");

	let manifest = parseManifest(manifestPath);

	const outputChannel = vscode.window.createOutputChannel('vlint');
	outputChannel.show();
	setLogger({
		log: (m) => outputChannel.appendLine(m),
		warn: (m) => outputChannel.appendLine(m),
		error: (m) => outputChannel.appendLine(m),
	});

	const diagnostics = vscode.languages.createDiagnosticCollection('vlint');
	context.subscriptions.push(outputChannel, diagnostics);

	// Violations from the last lint of each document. The code action provider
	// reads from here: VS Code strips custom properties off Diagnostic objects
	// on their way through the marker store, so they cannot carry fix payloads.
	const violationsByUri = new Map<string, Violation[]>();

	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider(
			[{ language: 'typescriptreact' }, { language: 'javascriptreact' }],
			{
				provideCodeActions(document, range): vscode.CodeAction[] {
					const violations = violationsByUri.get(document.uri.toString()) ?? [];
					const actions: vscode.CodeAction[] = [];
					const offer = (title: string, command: string, payload: StyleFix | ClassFix) => {
						const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
						// The rewrite is computed when the action is invoked, against
						// the document's text at that moment, never against a snapshot
						action.command = { command, title, arguments: [document.uri, payload] };
						actions.push(action);
					};

					for (const v of violations) {
						const line = v.loc ? Math.max(0, v.loc.line - 1) : 0;
						if (range.start.line > line || range.end.line < line) continue;

						const styleFix = violationToStyleFix(v);
						if (styleFix) {
							offer(
								`Apply Figma value: ${styleFix.propName} = ${JSON.stringify(styleFix.figmaValue)}`,
								'vlint.applyFix', styleFix
							);
						}
						const classFix = violationToClassFix(v);
						if (classFix) {
							const shown = classFix.breakpoint
								? classFix.utility.split(/\s+/).map(p => `${classFix.breakpoint}:${p}`).join(' ')
								: classFix.utility;
							offer(`Apply Figma class: ${shown}`, 'vlint.applyClassFix', classFix);
						}
					}
					return actions;
				},
			},
			{ providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
		)
	);

	const applyRewrite = async (uri: vscode.Uri, rewrite: (source: string) => string) => {
		const document = await vscode.workspace.openTextDocument(uri);
		const current = document.getText();
		const fixed = rewrite(current);
		if (fixed === current) return;
		const edit = new vscode.WorkspaceEdit();
		edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(current.length)), fixed);
		await vscode.workspace.applyEdit(edit);
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('vlint.applyFix', (uri: vscode.Uri, fix: StyleFix) =>
			applyRewrite(uri, (source) => applyStyleFixes(source, [fix]))),
		vscode.commands.registerCommand('vlint.applyClassFix', (uri: vscode.Uri, fix: ClassFix) =>
			applyRewrite(uri, (source) => applyClassFixes(source, [fix])))
	);

	// ─── PAT handling ─────────────────────────────────────────────────────────
	async function getPat(): Promise<string | undefined> {
		return (await context.secrets.get(PAT_SECRET_KEY)) || manifest["FIGMA_PAT"] || undefined;
	}

	async function migratePatToSecrets(): Promise<void> {
		if (!manifest["FIGMA_PAT"]) return;
		const stored = await context.secrets.get(PAT_SECRET_KEY);
		if (stored) return;
		await context.secrets.store(PAT_SECRET_KEY, manifest["FIGMA_PAT"]);
		outputChannel.appendLine('[vlint] FIGMA_PAT copied into VS Code secret storage. The CLI still reads it from design.manifest, so keep it there (gitignored) if you use `vlint` headless; otherwise it can be removed.');
	}
	void migratePatToSecrets();

	context.subscriptions.push(
		vscode.commands.registerCommand('vlint.setFigmaPat', async () => {
			const pat = await vscode.window.showInputBox({
				prompt: 'Figma Personal Access Token',
				password: true,
				ignoreFocusOut: true,
			});
			if (pat) {
				await context.secrets.store(PAT_SECRET_KEY, pat);
				vscode.window.showInformationMessage('vlint: Figma token stored securely.');
			}
		})
	);

	// designRefContent is the parsed DESIGN_REF.json held in memory. Its
	// stamped lastModified is the freshness baseline; there is no separate
	// init flag or module-level timestamp to keep in sync.
	let designRefContent: FigmaPage | undefined;
	if (fs.existsSync(designRefPath)) {
		try {
			const parsed = JSON.parse(fs.readFileSync(designRefPath).toString());
			if (parsed.generatedCss) designRefContent = parsed;
		} catch {
			outputChannel.appendLine('[vlint] DESIGN_REF.json is unreadable, will re-fetch on next save.');
		}
	}

	// Cooldown prevents hammering the Figma API on every keystroke-save.
	let lastCheckedAt = 0;
	const CHECK_COOLDOWN_MS = 5_000;

	function ensureAliasConfigured(workspaceRoot: string): void {
		const tsconfigPath = path.join(workspaceRoot, 'tsconfig.json');
		if (fs.existsSync(tsconfigPath)) {
			const tsconfig = readJsonConfig(tsconfigPath);
			if (tsconfig === null) {
				outputChannel.appendLine('[vlint] ⚠ tsconfig.json has comments or is unparseable; add the @ alias to compilerOptions.paths manually: "@/*": ["./src/*"]');
			} else {
				tsconfig.compilerOptions ??= {};
				tsconfig.compilerOptions.paths ??= {};
				if (!tsconfig.compilerOptions.paths['@/*']) {
					tsconfig.compilerOptions.paths['@/*'] = ['./src/*'];
					fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));
					outputChannel.appendLine('[vlint] ✓ Added @ alias to tsconfig.json');
				}
			}
		}

		const viteConfigPath = path.join(workspaceRoot, 'vite.config.ts');
		if (fs.existsSync(viteConfigPath)) {
			let content = fs.readFileSync(viteConfigPath, 'utf-8');
			if (!content.includes("'@'") && !content.includes('"@"')) {
				const patched = content.replace(
					'defineConfig({',
					`defineConfig({\n  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },`
				);
				if (patched === content) {
					outputChannel.appendLine("[vlint] ⚠ Could not patch vite.config.ts automatically; add resolve.alias['@'] = path.resolve(__dirname, 'src') manually.");
				} else {
					content = patched;
					if (!content.includes("import path")) {
						content = `import path from 'path';\n` + content;
					}
					fs.writeFileSync(viteConfigPath, content);
					outputChannel.appendLine('[vlint] ✓ Added @ alias to vite.config.ts');
				}
			}
		}
	}

	if (!hasAliasConfigured(workspaceRoot)) {
		outputChannel.appendLine('[vlint] ⚠ No @ alias found in vite/webpack config. CSS imports may fail to resolve.');
		ensureAliasConfigured(workspaceRoot);
	}

	// ─── Save Handler ─────────────────────────────────────────────────────────
	vscode.workspace.onDidSaveTextDocument(async (document: vscode.TextDocument) => {
		// ── Step 0: Filter irrelevant files ──────────────────────────────────
		// Re-parse the manifest when it changes so new keys take effect without
		// reloading the window.
		if (path.basename(document.fileName) === "design.manifest") {
			manifest = parseManifest(manifestPath);
			return;
		}

		const lang = document.languageId;
		if (lang !== "javascriptreact" && lang !== "typescriptreact") return;

		// ── Step 1: Extract data-figma names from the saved document ─────────
		const documentContent = document.getText();
		const [frameName] = extractDataFigmaNames(documentContent);

		// ── Step 2: Refresh Figma data if needed ─────────────────────────────
		// Fetch when there is no usable snapshot, or the cooldown elapsed and
		// Figma's lastModified is newer than the snapshot's stamp. Without a
		// token everything still runs offline from the cached DESIGN_REF.json.
		if (!fs.existsSync(designRefPath)) designRefContent = undefined;

		const pat = await getPat();
		const canFetch = !!(pat && manifest["FIGMA_FKEY"] && manifest["FIGMA_DEV_PAGE"]);
		let shouldFetch = !designRefContent;

		const now = Date.now();
		if (designRefContent && canFetch && (now - lastCheckedAt) > CHECK_COOLDOWN_MS) {
			lastCheckedAt = now;
			try {
				const live = await getFileMeta(manifest["FIGMA_FKEY"], pat!);
				const stamped = designRefContent.lastModified;
				if (!stamped || new Date(live.lastModified) > new Date(stamped)) shouldFetch = true;
			} catch (err) {
				outputChannel.appendLine(`[vlint] Update check skipped: ${(err as Error).message}`);
			}
		}

		let fetchedThisSave = false;
		if (shouldFetch && canFetch) {
			lastCheckedAt = now;
			outputChannel.appendLine('[vlint] Fetching latest styles from Figma...');
			try {
				designRefContent = await queryFigmaStyles(
					manifest["FIGMA_DEV_PAGE"], manifest["FIGMA_FKEY"], pat!
				) as FigmaPage;
				fetchedThisSave = true;
			} catch (err) {
				outputChannel.appendLine(`[vlint] ✗ ${(err as Error).message}`);
			}

			if (fetchedThisSave) {
				const refUri = vscode.Uri.joinPath(
					vscode.workspace.workspaceFolders![0].uri, 'DESIGN_REF.json'
				);
				await vscode.workspace.fs.writeFile(
					refUri, Buffer.from(JSON.stringify(designRefContent, null, 2), 'utf8')
				);
				outputChannel.appendLine('[vlint] DESIGN_REF.json updated.');
			}
		} else if (shouldFetch && !canFetch) {
			if (!fs.existsSync(manifestPath)) {
				outputChannel.appendLine('[vlint] No design.manifest found. Create one at the workspace root to get started.');
				outputChannel.appendLine('[vlint] Required keys: FIGMA_FKEY, FIGMA_DEV_PAGE, FIGMA_STYLES_DIR (set the token via "vlint: Set Figma Token")');
			} else {
				outputChannel.appendLine('[vlint] No Figma token and no cached DESIGN_REF.json. Run "vlint: Set Figma Token" or commit a snapshot.');
			}
		}

		if (!designRefContent) {
			diagnostics.delete(document.uri);
			violationsByUri.delete(document.uri.toString());
			return;
		}

		// ── Step 3: Write CSS files ───────────────────────────────────────────
		// Only after a fresh fetch, or when a file is missing on disk; a plain
		// re-save must not rewrite identical CSS and churn the dev server.
		const figmaStylesDir = manifest["FIGMA_STYLES_DIR"] || 'src/styles/figma';
		const figmaStylesUri = vscode.Uri.joinPath(
			vscode.workspace.workspaceFolders![0].uri,
			...figmaStylesDir.split('/')
		);

		for (const [frame, css] of Object.entries(designRefContent.generatedCss || {})) {
			if (!css) continue;
			const cssUri = vscode.Uri.joinPath(figmaStylesUri, `${frame}.figma.css`);
			const exists = await vscode.workspace.fs.stat(cssUri).then(() => true, () => false);
			if (!fetchedThisSave && exists) continue;
			await vscode.workspace.fs.writeFile(cssUri, Buffer.from(css as string, 'utf8'));
			outputChannel.appendLine(`[vlint] Written ${figmaStylesDir}/${frame}.figma.css`);
		}

		// ── Step 4: Guard against missing frame ───────────────────────────────
		const frameContent = designRefContent.nodes[frameName];
		if (!frameContent) {
			outputChannel.appendLine(`[Error] Frame "${frameName}" not found in DESIGN_REF.json`);
			diagnostics.delete(document.uri);
			violationsByUri.delete(document.uri.toString());
			return;
		}

		// ── Step 5: Validate against the design contract ─────────────────────
		const violations = lintSource(
			documentContent, frameName,
			frameContent as unknown as FrameSpec,
			designRefContent.nodes as unknown as Record<string, FrameSpec>,
			loadCssModules(document.fileName, documentContent)
		);

		if (violations.length > 0) {
			outputChannel.appendLine('\n[vlint] Violations detected:');
			violations.forEach(v => outputChannel.appendLine(`  [${v.severity}] ${violationMessage(v)}`));
		} else {
			outputChannel.appendLine(`✓ ${path.basename(document.fileName)} matches frame "${frameName}".`);
		}

		violationsByUri.set(document.uri.toString(), violations);
		diagnostics.set(document.uri, violations.map(v => toDiagnostic(document, v)));

		// ── Step 6: Auto-fix (opt-in) ─────────────────────────────────────────
		const autoFix = vscode.workspace.getConfiguration('vlint').get<boolean>('autoFix', false);
		const fixable = violations
			.map(violationToStyleFix)
			.filter((f): f is StyleFix => f !== null);

		if (autoFix && fixable.length > 0) {
			const fixedSource = applyStyleFixes(documentContent, fixable);
			if (fixedSource !== documentContent) {
				outputChannel.appendLine(`[vlint] Applying ${fixable.length} fix(es)...`);
				const edit = new vscode.WorkspaceEdit();
				edit.replace(
					document.uri,
					new vscode.Range(document.positionAt(0), document.positionAt(documentContent.length)),
					fixedSource
				);
				if (await vscode.workspace.applyEdit(edit)) {
					outputChannel.appendLine('[vlint] ✓ Source updated. Saving...');
					await document.save();
					return; // the re-save re-lints and refreshes diagnostics
				}
				outputChannel.appendLine('[vlint] ✗ Failed to apply fixes.');
			}
		}

		// ── Step 7: Inject CSS import ─────────────────────────────────────────
		// The import path must track FIGMA_STYLES_DIR, the same place Step 3
		// writes to. Only writes if the import is genuinely missing.
		const importSpecifier = importSpecifierFor(figmaStylesDir);
		const cssImportLine = `import '${importSpecifier}/${frameName}.figma.css';`;
		const alreadyImported = documentContent.includes(`${importSpecifier}/${frameName}.figma.css`);

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
// Nothing to clean up currently, subscriptions are disposed by VSCode.
export function deactivate() { }
