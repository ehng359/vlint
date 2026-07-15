const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseCssModuleClasses } = require("../dist/cssmodules");
const { lintSource } = require("../dist/validate");
const { checkFile } = require("../dist/workspace");

const MODULE_CSS = `
/* comment with { braces } inside */
.sidebar {
    width: 220px;
    background-color: #1A1A38;
    display: flex;
    flex-direction: column;
}

.sidebar:hover { width: 999px; }
.card, .sidebar .nested { width: 1px; }

.label {
    color: var(--color-primary);
    font-size: calc(1rem + 2px);
}

@media (min-width: 768px) {
    .sidebar { width: 160px; }
}

@media print {
    .sidebar { width: 5px; }
}
`;

test("parseCssModuleClasses extracts single-class rules and camelizes props", () => {
    const classes = parseCssModuleClasses(MODULE_CSS);
    assert.strictEqual(classes.sidebar.values.width, "220px");
    assert.strictEqual(classes.sidebar.values.backgroundColor, "#1A1A38");
    assert.strictEqual(classes.sidebar.values.flexDirection, "column");
    // pseudo classes and combinator selectors are skipped; a bare class in a
    // comma list is still attributed
    assert.notStrictEqual(classes.sidebar.values.width, "999px");
    assert.strictEqual(classes.card.values.width, "1px");
    assert.strictEqual(classes.nested, undefined);
});

test("var() and calc() values become references", () => {
    const classes = parseCssModuleClasses(MODULE_CSS);
    assert.strictEqual(classes.label.references.color, "color-primary");
    assert.strictEqual(classes.label.references.fontSize, null);
});

test("min-width media blocks land in breakpoint buckets", () => {
    const classes = parseCssModuleClasses(MODULE_CSS);
    assert.strictEqual(classes.sidebar.breakpoints.md.values.width, "160px");
});

const frames = {
    Dashboard: {
        id: "1", type: "FRAME",
        children: {
            Sidebar: {
                id: "2", name: "Sidebar", type: "FRAME",
                width: "220px", backgroundColor: "#1A1A38",
                tokens: { backgroundColor: "color/primary" },
            },
        },
    },
    "Dashboard@md": {
        id: "3", type: "FRAME",
        children: {
            Sidebar: { id: "4", name: "Sidebar", type: "FRAME", width: "160px" },
        },
    },
};

const SOURCE = `
import styles from './Sidebar.module.css';
// @design-frame Dashboard

// @design-component Sidebar
export const S = () => <div data-figma="Sidebar" className={styles.sidebar} />;
`;

test("a matching module class lints clean across breakpoints", () => {
    const violations = lintSource(SOURCE, "Dashboard", frames.Dashboard, frames, {
        "./Sidebar.module.css": MODULE_CSS,
    });
    // backgroundColor is a hardcoded token match, width matches at base and md
    assert.deepStrictEqual(violations.map(v => v.kind), ["hardcoded-token"]);
});

test("a drifted module class is a mismatch at the className location", () => {
    const violations = lintSource(SOURCE, "Dashboard", frames.Dashboard, frames, {
        "./Sidebar.module.css": MODULE_CSS.replace("width: 220px", "width: 200px"),
    });
    const mismatches = violations.filter(v => v.kind === "mismatch");
    assert.strictEqual(mismatches.length, 1);
    assert.strictEqual(mismatches[0].actual, "200px");
    assert.strictEqual(mismatches[0].loc.line, 6);
});

test("a module missing its md override is caught against Dashboard@md", () => {
    const violations = lintSource(SOURCE, "Dashboard", frames.Dashboard, frames, {
        "./Sidebar.module.css": MODULE_CSS.replace(/@media \(min-width: 768px\) \{[^}]*\{[^}]*\}\s*\}/, ""),
    });
    const bp = violations.filter(v => v.breakpoint === "md");
    assert.strictEqual(bp.length, 1);
    assert.strictEqual(bp[0].actual, "220px");
    assert.strictEqual(bp[0].expected, "160px");
});

test("checkFile loads the module file from disk relative to the source", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vlint-cssmod-"));
    fs.writeFileSync(path.join(dir, "Sidebar.module.css"), MODULE_CSS.replace("width: 220px", "width: 210px"));
    fs.writeFileSync(path.join(dir, "Sidebar.tsx"), SOURCE);

    const designRef = { version: "1", nodes: frames, generatedCss: {} };
    const result = checkFile(path.join(dir, "Sidebar.tsx"), designRef);
    const mismatch = result.violations.find(v => v.kind === "mismatch");
    assert.ok(mismatch);
    assert.strictEqual(mismatch.actual, "210px");
});
