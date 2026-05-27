// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { applyStyleFixes, extractStyles, FigmaElement, FigmaPage, hasFileBeenUpdated, queryFigmaStyles, StyleFix } from '@vlint/core';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';


function parseManifest(filePath: string): Record<string, string> {
	const content = fs.readFileSync(filePath, 'utf-8');
	return Object.fromEntries(
		content
			.split('\n')
			.filter(line => line.trim() && !line.startsWith('#'))
			.map(line => line.split('=').map(s => s.trim()))
	);
}

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

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "vlint" is now active!');
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
	const manifestPath = path.join(workspaceRoot!, "design.manifest")
	const designRefPath = path.join(workspaceRoot!, "DESIGN_REF.json")

	let manifest = parseManifest(manifestPath);
	let designRefContent: FigmaPage;
	if (fs.existsSync(designRefPath)) {
		designRefContent = JSON.parse(fs.readFileSync(designRefPath).toString())
	}

	let init = true

	const outputChannel = vscode.window.createOutputChannel('vlint');
	outputChannel.show();
	vscode.workspace.onDidSaveTextDocument(async (document: vscode.TextDocument) => {
		if (document.fileName === "design.manifest") {
			manifest = parseManifest(manifestPath);
			return
		}

		const lang = document.languageId
		if (lang !== "javascriptreact" && lang !== "typescriptreact") {
			return
		}

		// Query the Figma file if and only if it has been updated since. Otherwise
		// refer to the DESIGN_REF.json file.
		if (init || await hasFileBeenUpdated(manifest["FIGMA_FKEY"], manifest["FIGMA_PAT"])) {
			init = false
			// Read from the local workspace for the DESIGN_REF.md file when file updated.
			const figmaStyles = await queryFigmaStyles(manifest["FIGMA_DEV_PAGE"], manifest["FIGMA_FKEY"], manifest["FIGMA_PAT"])
			const fileUri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0].uri!, 'DESIGN_REF.json');
			const content = Buffer.from(JSON.stringify(figmaStyles, null, 2), 'utf8');
			designRefContent = figmaStyles

			// This handles the writing natively
			await vscode.workspace.fs.writeFile(fileUri, content);
		}

		let documentContent = document.getText()
		const [frameName, styleMapping] = extractStyles(documentContent)

		outputChannel.appendLine(JSON.stringify(styleMapping, null, 2))
		outputChannel.show()

		// TODO: Make direct comparisons between key information within this file and corresponding Figma file.
		// Use the extracted style from the current document and compare to the design reference
		const frameContent = designRefContent.nodes[frameName]
		if (!frameContent) {
			// Frame doesn't exist, create some kind of flag
			outputChannel.appendLine(`[Error] Frame "${frameName}" not found in DESIGN_REF.json`);
			return
		}

		// Track mismatches to report at the end
		const mismatches: string[] = [];

		Object.entries(styleMapping).forEach(([componentName, codeStyles]) => {
			// 1. Find the corresponding element in the Figma reference
			const figmaElement = frameContent.children[componentName]

			if (!figmaElement) {
				mismatches.push(`Component "${componentName}" exists in code but not in Figma frame.`);
				return;
			}

			// 2. Cross-check specific style properties (e.g., color, spacing)
			// Assuming codeStyles and figmaElement.styles share similar keys
			let componentMatch = true;

			for (const style of codeStyles) {
				const figmaValue = figmaElement[style.propName as keyof FigmaElement];
				if (figmaValue === undefined) {
					outputChannel.appendLine(`[Warn] Property "${style.propName}" not found in Figma for "${componentName}"`);
					continue;
				}

				// AFTER
				if (normaliseValue(style.actualValue as string | number) !== normaliseValue(figmaValue as string | number)) {
					mismatches.push(`
						Style Mismatch in "${componentName}": 
							Property: ${style.propName}
							Code: ${style.actualValue} 
							Figma: ${figmaValue}
						`
					);
					componentMatch = false;
				}
			}

			if (componentMatch) {
				outputChannel.appendLine(`${componentName} matches Figma spec.`);
			}
		});
		const pendingFixes: StyleFix[] = [];  // <-- structured fixes to apply

		Object.entries(styleMapping).forEach(([componentName, codeStyles]) => {
			const figmaElement = frameContent.children[componentName];
			if (!figmaElement) {
				mismatches.push(`Component "${componentName}" exists in code but not in Figma frame.`);
				return;
			}

			let componentMatch = true;

			for (const style of codeStyles) {
				// Actively catch backgroundColor written onto TEXT nodes by a previous
				// bad extraction — swap it to color using the figma fill value
				if (figmaElement.type === 'TEXT' && style.propName === 'backgroundColor') {
					const correctColor = figmaElement.color as string | undefined;
					if (correctColor) {
						mismatches.push(`TEXT node "${componentName}" has backgroundColor in code — replacing with color: ${correctColor}`);
						pendingFixes.push({ componentName, propName: 'backgroundColor', figmaValue: '' });   // remove it
						pendingFixes.push({ componentName, propName: 'color', figmaValue: correctColor });   // add correct one
					}
					componentMatch = false;
					continue;
				}

				const figmaValue = figmaElement[style.propName as keyof FigmaElement];

				if (figmaValue === undefined) {
					outputChannel.appendLine(`[Warn] Property "${style.propName}" not found in Figma for "${componentName}"`);
					continue;
				}

				if (normaliseValue(style.actualValue as string | number) !== normaliseValue(figmaValue as string | number)) {
					mismatches.push(
						`Style Mismatch in "${componentName}": ${style.propName} — Code: ${style.actualValue}, Figma: ${figmaValue}`
					);
					componentMatch = false;

					const isTextBackgroundLeak = figmaElement.type === 'TEXT' && style.propName === 'backgroundColor';
					if (!isTextBackgroundLeak) {
						pendingFixes.push({
							componentName,
							propName: style.propName,
							figmaValue: figmaValue as string | number,
						});
					}
				}
			}

			// Keys that are Figma/extraction metadata, not CSS properties
			const FIGMA_METADATA_KEYS = new Set([
				'id', 'name', 'type', 'resolvedDesignTokens', 'variables',
				'layoutAlign', 'layoutGrow', 'minWidth', 'maxWidth',
				'children', 'childrenElements', 'boxSizing',
				'primaryAxisSizingMode', 'counterAxisSizingMode'
			]);

			const codePropNames = new Set(codeStyles.map(s => s.propName));

			for (const [prop, figmaValue] of Object.entries(figmaElement)) {
				if (FIGMA_METADATA_KEYS.has(prop)) continue;
				if (codePropNames.has(prop)) continue;
				if (figmaValue === null || figmaValue === undefined) continue;
				if (typeof figmaValue === 'object') continue;

				// Fixed: was comparing figmaValue to itself (always false)
				const isTextBackgroundLeak = figmaElement.type === 'TEXT' && prop === 'backgroundColor';
				if (!isTextBackgroundLeak) {
					mismatches.push(`Missing in code — "${componentName}.${prop}": Figma has ${figmaValue}`);
					pendingFixes.push({
						componentName,
						propName: prop,
						figmaValue: figmaValue as string | number,
					});
				}
			}

			if (componentMatch) {
				outputChannel.appendLine(`✓ ${componentName} matches Figma spec.`);
			}
		});

		// Apply all queued fixes in a single pass if any mismatches were found
		if (pendingFixes.length > 0) {
			outputChannel.appendLine(`\n[vlint] Applying ${pendingFixes.length} fix(es)...`);

			const originalSource = document.getText();
			const fixedSource = applyStyleFixes(originalSource, pendingFixes);

			if (fixedSource !== originalSource) {
				const edit = new vscode.WorkspaceEdit();
				const fullRange = new vscode.Range(
					document.positionAt(0),
					document.positionAt(originalSource.length)
				);

				edit.replace(document.uri, fullRange, fixedSource);

				const success = await vscode.workspace.applyEdit(edit);

				if (success) {
					outputChannel.appendLine(`[vlint] ✓ Source updated. Saving...`);
					await document.save(); // persist to disk
				} else {
					outputChannel.appendLine(`[vlint] ✗ WorkspaceEdit failed — no changes written.`);
				}
			}
		}

		// Surface mismatches regardless of whether fixes were applied
		if (mismatches.length > 0) {
			outputChannel.appendLine("\n[vlint] Mismatches detected:");
			mismatches.forEach(m => outputChannel.appendLine(m));
		}
	})

}

// This method is called when your extension is deactivated
export function deactivate() { }
