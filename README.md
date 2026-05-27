# vlint: Visual Linter for Design-to-Development

> A VS Code extension that enforces a binding contract between Figma design specifications and their React implementations using static AST analysis and the Figma REST API.

---

## Overview

**vlint** bridges the gap between design and engineering by introducing a formal, verifiable relationship between a Figma component and its corresponding code. Rather than relying on manual design reviews or visual QA, vlint treats the Figma file as a typed source of truth and statically validates that the implementation honours it — at save time, in the editor.

The core primitive is the **Design-Code Contract**: when a developer annotates a component with `@design-component`, they are making an explicit declaration that the annotated code is the canonical implementation of a named Figma node. The extension holds them accountable to that declaration by diffing the extracted Figma styles against the inline styles present in the JSX.

```tsx
// @design-component PricingCard
const PricingCard = () => (
  <div style={{ padding: "24px", backgroundColor: "#FFFFFF" }}>
    {/* @design-component Header */}
    <h2 style={{ fontSize: "20px" }} />
  </div>
);
```

Unannotated children are treated as black boxes and are not validated unless they carry their own annotation.

---

## Architecture

The system is composed of four sequential stages.

### 1. Figma Extraction

On activation — and on every subsequent save where the Figma file has changed — the extension calls the Figma REST API to pull the geometry, colour, and layout data for a targeted page.

- **Endpoint:** `GET /v1/files/:key/nodes`
- **Scope:** Only the frames declared in the workspace manifest are queried. A `depth=2` pre-flight retrieves page and top-level frame IDs; a second targeted request retrieves the full node tree.
- **Output:** A `DESIGN_REF.json` file written to the workspace root, containing CSS-translated style properties keyed by component name.

The extraction pipeline handles component variants, design token resolution (via `boundVariables`), and style library references. Layout properties from Figma's Auto Layout system (`layoutMode`, `itemSpacing`, `paddingTop`, etc.) are mapped to their CSS equivalents (`flexDirection`, `gap`, `padding`, etc.).

### 2. The Token Manifest

The extracted data is normalised into a flat, queryable registry — `DESIGN_REF.json` — that lives at the workspace root and is regenerated whenever the upstream Figma file changes.

```json
{
  "extractedAt": "2025-01-01T00:00:00.000Z",
  "nodes": {
    "PricingCard": {
      "id": "14:205",
      "width": "320px",
      "height": "480px",
      "backgroundColor": "#FFFFFF",
      "padding": "24px 24px",
      "display": "flex",
      "flexDirection": "column",
      "gap": "12px",
      "children": {
        "Header": {
          "fontSize": "20px",
          "fontWeight": 600,
          "color": "#111111"
        },
        "Action": {
          "borderRadius": "8px",
          "backgroundColor": "#0052FF"
        }
      }
    }
  }
}
```

The manifest is the single shared artefact that decouples the Figma API call from the per-save validation pass. If the file is unchanged, the saved manifest is used directly, avoiding redundant API round-trips.

### 3. The Annotation Layer

The developer marks their JSX with `@design-component` annotations, declaring the relationship between a code block and a named Figma node.

vlint's parser — built on top of Babel Parser with the `jsx` and `typescript` plugins — traverses the AST of every saved `.jsx` or `.tsx` file, resolves annotations from both line comments and inline JSX expression containers, and extracts the static style properties from each annotated element's `style` prop.

```tsx
<div
  {/* @design-component Header */}
  <h2 style={{ fontSize: "18px", fontWeight: 700 }} />
>
```

The parser returns a map of `componentName → StyleProp[]`, where each `StyleProp` carries the property name, the literal value found in the code, and its source location.

### 4. The Validation and Auto-Fix Engine

On every `.jsx` / `.tsx` save, the extension:

1. Looks up the `@design-frame` declaration in the file to identify which root Figma frame to compare against.
2. Iterates over every annotated component and cross-references its extracted style props against the corresponding node in `DESIGN_REF.json`.
3. Detects two categories of violation:
   - **Value mismatch** — the property exists in both code and Figma but the values differ.
   - **Missing property** — the property exists in the Figma specification but is absent from the code entirely.
4. Queues all violations as structured `StyleFix` objects and applies them in a single Babel AST transformation pass, writing the corrected source back to disk via VS Code's `WorkspaceEdit` API.

All findings are reported to a dedicated **vlint** output channel in the VS Code panel.

---

## Workspace Configuration

vlint expects a `design.manifest` file at the workspace root with the following keys:

```ini
# Figma Personal Access Token
FIGMA_PAT = your_personal_access_token

# Figma file key (from the URL: figma.com/file/<KEY>/...)
FIGMA_FKEY = your_file_key

# Name of the Figma page to target
FIGMA_DEV_PAGE = Development
```

The manifest is re-parsed automatically whenever it is saved, so credentials and targets can be updated without reloading the extension.

---

## Annotation Schema

| Annotation | Placement | Purpose |
|---|---|---|
| `@design-frame <FrameName>` | File-level comment | Declares which root Figma frame this file maps to |
| `@design-component <NodeName>` | Leading comment or inline JSX comment on a JSX element | Declares that the annotated element implements the named Figma node |

### File-level example

```tsx
// @design-frame PricingCard

// @design-component PricingCard
export const PricingCard = () => (
  <div style={{ padding: "24px", backgroundColor: "#FFFFFF" }}>
    {/* @design-component Header */}
    <h2 style={{ fontSize: "20px" }}>Pro Plan</h2>

    {/* @design-component Action */}
    <button style={{ borderRadius: "8px" }}>Get Started</button>
  </div>
);
```

Unannotated descendants are ignored by the linter. Annotations are opt-in — developers explicitly declare which boundaries they want enforced.

---

## Package Structure

```
packages/
├── core/                  # Shared logic, published as @vlint/core
│   ├── extraction.js      # Figma REST API client and CSS mapping
│   ├── parser.ts          # Babel AST annotation extractor and style fixer
│   └── index.ts           # Type definitions and public exports
└── extension/             # VS Code extension host
    └── extension.ts       # Activation, manifest parsing, save hook, diff engine
```

---

## How the Auto-Fix Works

When a violation is detected, vlint does not just report it — it corrects the source file directly.

The fix pipeline uses Babel's `traverse` and `generate` APIs to perform a targeted AST mutation:

- For **value mismatches**, the existing `ObjectProperty` node in the `style` expression is updated in place.
- For **missing properties**, a new `ObjectProperty` is constructed and appended to the existing `ObjectExpression`.
- When the `style` prop is **empty** (`style={{}}`) or **absent entirely**, the object is populated or the attribute is created from scratch and attached to the `JSXOpeningElement`.

The transformed AST is then regenerated into source code and written back to the file via a `WorkspaceEdit`, replacing the full document range atomically. The file is then saved programmatically to persist the changes to disk.

---

## Output

All linter output is written to the **vlint** output channel in VS Code:

```
✓ PricingCard matches Figma spec.

[vlint] Mismatches detected:
  Style Mismatch in "Header":
    Property: fontSize
    Code:  18px
    Figma: 20px

  Missing in code — "Action.borderRadius": Figma has 8px

[vlint] Applying 2 fix(es)...
[vlint] ✓ Source updated. Saving...
```

---

## Dependencies

| Package | Purpose |
|---|---|
| `@babel/parser` | JSX + TypeScript AST parsing |
| `@babel/traverse` | AST traversal and mutation |
| `@babel/generator` | AST-to-source code generation |
| `@babel/types` | AST node constructors |
| `vscode` | Extension API, WorkspaceEdit, OutputChannel |

--

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