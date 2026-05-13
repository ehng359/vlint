// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { extractStyles, FigmaElement, FigmaPage, hasFileBeenUpdated, queryFigmaStyles } from '@vlint/core';
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
			const figmaElement = frameContent.childrenElements.find(elem => elem.name === componentName);

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

				if (String(style.actualValue).toLowerCase() !== String(figmaValue).toLowerCase()) {
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
		// TODO: Make programmatic updates to mismatched styles.

	})

}

// This method is called when your extension is deactivated
export function deactivate() { }
