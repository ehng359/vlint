const test = require("node:test");
const assert = require("node:assert");
const { designRefToTheme, figmaValueToUtility, specToClassName } = require("../dist/tailwind");
const { applyClassFixes } = require("../dist/parser");
const { lintSource, violationToClassFix } = require("../dist/validate");

test("figmaValueToUtility prefers scale utilities, falls back to arbitrary", () => {
    assert.strictEqual(figmaValueToUtility("width", "220px"), "w-55");
    assert.strictEqual(figmaValueToUtility("width", "221px"), "w-[221px]");
    assert.strictEqual(figmaValueToUtility("borderRadius", "12px"), "rounded-xl");
    assert.strictEqual(figmaValueToUtility("borderRadius", "25px"), "rounded-[25px]");
    assert.strictEqual(figmaValueToUtility("fontWeight", 600), "font-semibold");
    assert.strictEqual(figmaValueToUtility("fontSize", "36px"), "text-4xl");
    assert.strictEqual(figmaValueToUtility("padding", "20px 24px"), "py-5 px-6");
    assert.strictEqual(figmaValueToUtility("flexDirection", "column"), "flex-col");
    assert.strictEqual(figmaValueToUtility("border", "1px solid #000"), null);
});

test("token-bound colors emit the token utility, not the frozen value", () => {
    assert.strictEqual(figmaValueToUtility("backgroundColor", "#1A1A38", "color/primary"), "bg-primary");
    assert.strictEqual(figmaValueToUtility("backgroundColor", "#1A1A38", "spacing/weird"), "bg-(--spacing-weird)");
    assert.strictEqual(figmaValueToUtility("backgroundColor", "#1A1A38"), "bg-[#1A1A38]");
});

test("specToClassName renders a node as canonical utilities", () => {
    const className = specToClassName({
        id: "1", name: "Sidebar", type: "FRAME",
        width: "220px", backgroundColor: "#1A1A38", borderRadius: "12px",
        display: "flex", flexDirection: "column", gap: "8px", padding: "20px 24px",
        tokens: { backgroundColor: "color/primary" },
    });
    const parts = className.split(" ");
    assert.ok(parts.includes("w-55"));
    assert.ok(parts.includes("bg-primary"));
    assert.ok(parts.includes("rounded-xl"));
    assert.ok(parts.includes("flex"));
    assert.ok(parts.includes("flex-col"));
    assert.ok(parts.includes("gap-2"));
    assert.ok(parts.includes("py-5"));
    assert.ok(parts.includes("px-6"));
});

test("specToClassName skips lineHeight implied by a named text size", () => {
    const className = specToClassName({
        id: "1", name: "Title", type: "TEXT",
        fontSize: "36px", lineHeight: "40px", fontWeight: 600,
    });
    assert.ok(className.includes("text-4xl"));
    assert.ok(!className.includes("leading"));
    // a non-matching pair keeps its explicit leading
    const custom = specToClassName({ id: "2", name: "T", type: "TEXT", fontSize: "36px", lineHeight: "44px" });
    assert.ok(custom.includes("leading-11"));
});

test("designRefToTheme emits token variables with their bound values", () => {
    const theme = designRefToTheme({
        nodes: {
            Dashboard: {
                id: "1", type: "FRAME",
                tokens: { backgroundColor: "color/surface" },
                backgroundColor: "#FFFFFF",
                children: {
                    Sidebar: {
                        id: "2", name: "Sidebar", type: "FRAME",
                        backgroundColor: "#1A1A38", gap: "8px",
                        tokens: { backgroundColor: "color/primary", gap: "VariableID:9:9" },
                    },
                },
            },
        },
    });
    assert.match(theme, /^@theme \{/);
    assert.match(theme, /--color-primary: #1A1A38;/);
    assert.match(theme, /--color-surface: #FFFFFF;/);
    assert.doesNotMatch(theme, /VariableID/);
});

test("applyClassFixes replaces the conflicting utility in place", () => {
    const source = [
        `// @design-component StatBlock`,
        `const S = () => <div data-figma="StatBlock" className="flex rounded-lg gap-2" />;`,
    ].join("\n");
    const fixed = applyClassFixes(source, [
        { componentName: "StatBlock", propName: "borderRadius", utility: "rounded-xl" },
    ]);
    assert.match(fixed, /className="flex gap-2 rounded-xl"/);
});

test("applyClassFixes scopes breakpoint fixes to the variant", () => {
    const source = [
        `// @design-component Sidebar`,
        `const S = () => <div data-figma="Sidebar" className="w-55 md:w-48" />;`,
    ].join("\n");
    const fixed = applyClassFixes(source, [
        { componentName: "Sidebar", propName: "width", utility: "w-40", breakpoint: "md" },
    ]);
    // base w-55 untouched, md:w-48 replaced
    assert.match(fixed, /className="w-55 md:w-40"/);
});

test("applyClassFixes leaves dynamic classNames untouched", () => {
    const source = [
        `// @design-component StatBlock`,
        `const S = () => <div data-figma="StatBlock" className={clsx("rounded-lg")} />;`,
    ].join("\n");
    assert.strictEqual(applyClassFixes(source, [
        { componentName: "StatBlock", propName: "borderRadius", utility: "rounded-xl" },
    ]), source);
});

const frames = {
    Dashboard: {
        id: "1", type: "FRAME",
        children: {
            Sidebar: { id: "2", name: "Sidebar", type: "FRAME", width: "220px" },
        },
    },
    "Dashboard@md": {
        id: "3", type: "FRAME",
        children: {
            Sidebar: { id: "4", name: "Sidebar", type: "FRAME", width: "160px" },
        },
    },
};

test("violationToClassFix turns a breakpoint mismatch into a variant utility", () => {
    const violations = lintSource(`
        // @design-component Sidebar
        const S = () => <div data-figma="Sidebar" className="w-55 md:w-48" />;
    `, "Dashboard", frames.Dashboard, frames);
    const fix = violationToClassFix(violations.find(v => v.breakpoint === "md"));
    assert.deepStrictEqual(fix, {
        componentName: "Sidebar", propName: "width", utility: "w-40", breakpoint: "md",
    });
});

test("@design-override exempts declared properties from validation", () => {
    const violations = lintSource(`
        // @design-component Sidebar
        // @design-override width
        const S = () => <div data-figma="Sidebar" className="w-96" />;
    `, "Dashboard", frames.Dashboard, frames);
    assert.deepStrictEqual(violations, []);

    const stillCaught = lintSource(`
        // @design-component Sidebar
        // @design-override height
        const S = () => <div data-figma="Sidebar" className="w-96" />;
    `, "Dashboard", frames.Dashboard, frames);
    assert.ok(stillCaught.some(v => v.property === "width" && v.kind === "mismatch"));
});
