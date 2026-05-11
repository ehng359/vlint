// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { extractStyles, hasFileBeenUpdated, queryFigmaStyles } from '@vlint/core';
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
	let manifest = parseManifest(path.join(workspaceRoot!, "design.manifest"));
	let init = true

	const outputChannel = vscode.window.createOutputChannel('vlint');
	outputChannel.show();
	vscode.workspace.onDidSaveTextDocument(async (document: vscode.TextDocument) => {
		if (document.fileName === "design.manifest") {
			manifest = parseManifest(path.join(workspaceRoot!, "design.manifest"));
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
			const figmaStyles = await queryFigmaStyles(manifest["FIGMA_DEV_PAGE"], manifest["FIGMA_FKEY"], manifest["FIGMA_PAT"])
			const fileUri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0].uri!, 'DESIGN_REF.json');
			const content = Buffer.from(JSON.stringify(figmaStyles, null, 2), 'utf8');

			// This handles the writing natively
			await vscode.workspace.fs.writeFile(fileUri, content);
		}

		let documentContent = document.getText()
		const styleMapping = extractStyles(documentContent)

		outputChannel.appendLine(JSON.stringify(styleMapping, null, 2))
		outputChannel.show()

		// TODO: Make direct comparisons between key information within this file and corresponding Figma file.

		// TODO: Make programmatic updates to mismatched styles.

	})

	// const save = vscode.commands.registerCommand("vlint.save", () => {
	// 	vscode.window.showInformationMessage('Hello World (save) from vlint!');
	// })
	// context.subscriptions.push(save);
}

// This method is called when your extension is deactivated
export function deactivate() { }
