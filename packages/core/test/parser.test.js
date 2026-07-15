const test = require("node:test");
const assert = require("node:assert");
const { applyStyleFixes, extractDataFigmaNames } = require("../dist/parser");

test("extractDataFigmaNames pulls frame and component names", () => {
    const [frame, names] = extractDataFigmaNames(`
        // @design-frame Dashboard
        const D = () => (
            <div data-figma="Dashboard">
                <div data-figma="Sidebar" />
            </div>
        );
    `);
    assert.strictEqual(frame, "Dashboard");
    assert.deepStrictEqual(names, ["Dashboard", "Sidebar"]);
});

test("applyStyleFixes updates an existing property in place", () => {
    const source = [
        `// @design-component StatBlock`,
        `const S = () => <div data-figma="StatBlock" style={{ borderRadius: 8 }} />;`,
    ].join("\n");
    const fixed = applyStyleFixes(source, [
        { componentName: "StatBlock", propName: "borderRadius", figmaValue: "12px" },
    ]);
    assert.match(fixed, /borderRadius: "12px"/);
    assert.doesNotMatch(fixed, /borderRadius: 8/);
});

test("applyStyleFixes inserts a missing property and creates absent style props", () => {
    const source = [
        `// @design-component StatBlock`,
        `const S = () => <div data-figma="StatBlock" />;`,
    ].join("\n");
    const fixed = applyStyleFixes(source, [
        { componentName: "StatBlock", propName: "width", figmaValue: "198px" },
    ]);
    assert.match(fixed, /style=\{\{[\s\S]*width: "198px"[\s\S]*\}\}/);
});

test("applyStyleFixes keeps untouched lines stable (retainLines)", () => {
    const source = [
        `import React from "react";`,
        ``,
        `// @design-component StatBlock`,
        `const S = () => <div data-figma="StatBlock" style={{ borderRadius: 8 }} />;`,
        ``,
        `export default S;`,
    ].join("\n");
    const fixed = applyStyleFixes(source, [
        { componentName: "StatBlock", propName: "borderRadius", figmaValue: "12px" },
    ]);
    const fixedLines = fixed.split("\n");
    assert.strictEqual(fixedLines[0], `import React from "react";`);
    assert.match(fixedLines[3], /borderRadius: "12px"/);
});

test("applyStyleFixes returns source unchanged when it cannot parse", () => {
    const broken = "const x = <div";
    assert.strictEqual(applyStyleFixes(broken, []), broken);
});

test("statement annotation resolves through an export wrapper", () => {
    const source = [
        `// @design-component StatBlock`,
        `export const S = () => <div data-figma="StatBlock" style={{ borderRadius: 8 }} />;`,
    ].join("\n");
    const fixed = applyStyleFixes(source, [
        { componentName: "StatBlock", propName: "borderRadius", figmaValue: "12px" },
    ]);
    assert.match(fixed, /borderRadius: "12px"/);
});

test("statement annotation does not leak into ternary branches", () => {
    const source = [
        `// @design-component StatBlock`,
        `const S = (ok) => ok ? <div style={{ borderRadius: 8 }} /> : <span style={{ borderRadius: 8 }} />;`,
    ].join("\n");
    const fixed = applyStyleFixes(source, [
        { componentName: "StatBlock", propName: "borderRadius", figmaValue: "12px" },
    ]);
    // Neither branch can unambiguously claim the comment, so neither is rewritten
    assert.doesNotMatch(fixed, /12px/);
});
