# Vlint: Visual Linter for Design-to-Development

## Testing Extension Updates
Development & Testing
This project is a monorepo. To test the VS Code extension and the core AST logic locally, follow these steps:

1. Initial Setup
From the project root, install all dependencies for the workspace:
```bash
npm install
```

2. Start the Compiler
We use esbuild for lightning-fast bundling. You must have the watcher running so that changes in the core or extension packages are updated in real-time.

```bash
# From the root directory
npm run watch --workspace=packages/extension
```

3. Launch the Extension Sandbox
Open this project in VS Code.

Press F5 or go to the Run and Debug view and select "Launch Extension".

A new window titled [Extension Development Host] will open. This is your sandbox.

4. Verifying the Extension
Once the sandbox window is open:

Command Palette: Press Cmd+Shift+P (Mac) or Ctrl+Shift+P (Windows) and search for Vlint: Save and Check Design.

On Save: Open any .jsx or .tsx file in the sandbox and save it (Cmd+S). You should see an information message or linting diagnostics appear.

5. Debugging
Logs from the extension (including console.log) will appear in the Debug Console of your primary VS Code window.

To apply code changes made in extension.ts, click the Reload button (circular arrow icon) on the floating debug toolbar.