const test = require("node:test");
const assert = require("node:assert");
const { lintSource, normaliseValue, tokenToCssVarName, violationToStyleFix } = require("../dist/validate");

test("normaliseValue treats equivalent representations as equal", () => {
    assert.strictEqual(normaliseValue("16px"), normaliseValue(16));
    assert.strictEqual(normaliseValue("#FFF"), normaliseValue("#ffffff"));
    assert.strictEqual(normaliseValue("rgba(255, 255, 255, 1)"), normaliseValue("#FFFFFF"));
    assert.strictEqual(normaliseValue("Bold"), normaliseValue(700));
    assert.notStrictEqual(normaliseValue("#fff"), normaliseValue("#eee"));
});

test("tokenToCssVarName maps Figma token paths to custom property names", () => {
    assert.strictEqual(tokenToCssVarName("color/primary"), "color-primary");
    assert.strictEqual(tokenToCssVarName("Spacing / Md"), "spacing-md");
});

const frame = {
    id: "285:30",
    type: "FRAME",
    width: "1100px",
    children: {
        Sidebar: {
            id: "285:31",
            name: "Sidebar",
            type: "FRAME",
            width: "220px",
            backgroundColor: "#1A1A38",
            tokens: { backgroundColor: "color/primary" }
        },
        StatBlock: {
            id: "285:40",
            name: "StatBlock",
            type: "FRAME",
            borderRadius: "12px"
        }
    }
};

function lint(jsx) {
    return lintSource(jsx, "Dashboard", frame);
}

test("clean file produces no violations", () => {
    const violations = lint(`
        // @design-component StatBlock
        const S = () => <div data-figma="StatBlock" style={{ borderRadius: 12 }} />;
    `);
    assert.deepStrictEqual(violations, []);
});

test("value mismatch is an error with expected and actual", () => {
    const violations = lint(`
        // @design-component StatBlock
        const S = () => <div data-figma="StatBlock" style={{ borderRadius: 8 }} />;
    `);
    assert.strictEqual(violations.length, 1);
    const v = violations[0];
    assert.strictEqual(v.kind, "mismatch");
    assert.strictEqual(v.severity, "error");
    assert.strictEqual(v.property, "borderRadius");
    assert.strictEqual(v.expected, "12px");
    assert.strictEqual(v.actual, 8);
    assert.ok(v.loc && v.loc.line > 0);
});

test("spec property absent from code is a missing warning", () => {
    const violations = lint(`
        // @design-component StatBlock
        const S = () => <div data-figma="StatBlock" style={{}} />;
    `);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].kind, "missing");
    assert.strictEqual(violations[0].severity, "warning");
});

test("hardcoded value matching a token-bound property is a latent-drift warning", () => {
    const violations = lint(`
        // @design-component Sidebar
        const S = () => <div data-figma="Sidebar" style={{ width: 220, backgroundColor: "#1A1A38" }} />;
    `);
    const tokenWarnings = violations.filter(v => v.kind === "hardcoded-token");
    assert.strictEqual(tokenWarnings.length, 1);
    assert.strictEqual(tokenWarnings[0].property, "backgroundColor");
    assert.strictEqual(tokenWarnings[0].token, "color/primary");
    assert.strictEqual(tokenWarnings[0].severity, "warning");
});

test("matching var() reference to the bound token is clean", () => {
    const violations = lint(`
        // @design-component Sidebar
        const S = () => <div data-figma="Sidebar" style={{ width: 220, backgroundColor: "var(--color-primary)" }} />;
    `);
    assert.deepStrictEqual(violations, []);
});

test("var() reference naming a different token is a mismatch", () => {
    const violations = lint(`
        // @design-component Sidebar
        const S = () => <div data-figma="Sidebar" style={{ width: 220, backgroundColor: "var(--color-accent)" }} />;
    `);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].kind, "mismatch");
    assert.strictEqual(violations[0].token, "color/primary");
});

test("annotation without a spec counterpart is unknown-component", () => {
    const violations = lint(`
        // @design-component Ghost
        const S = () => <div data-figma="Ghost" style={{ width: 10 }} />;
    `);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].kind, "unknown-component");
});

test("frame-level annotation validates against the frame itself", () => {
    const violations = lintSource(`
        // @design-component Dashboard
        const D = () => <div data-figma="Dashboard" style={{ width: 900 }} />;
    `, "Dashboard", frame);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].kind, "mismatch");
    assert.strictEqual(violations[0].expected, "1100px");
});

test("unparseable source returns no violations instead of throwing", () => {
    assert.deepStrictEqual(lint("const broken = <div"), []);
});

test("legacy snapshots with raw Figma metadata produce no bogus warnings", () => {
    // Shape taken from a real pre-engine DESIGN_REF.json found in the wild
    const legacyFrame = {
        id: "1", type: "FRAME",
        layoutMode: "NONE", itemSpacing: 0, layoutAlign: "INHERIT",
        layoutGrow: 0, borderRadius: 0, alignItems: "MIN", justifyContent: "MIN",
        width: "1440px",
        children: {},
    };
    const violations = lintSource(`
        // @design-component Home
        const H = () => <div data-figma="Home" style={{ width: 1440 }} />;
    `, "Home", legacyFrame);
    assert.deepStrictEqual(violations, []);
});

test("violations carry their source and violationToStyleFix respects it", () => {
    const inline = lint(`
        // @design-component StatBlock
        const S = () => <div data-figma="StatBlock" style={{ borderRadius: 8 }} />;
    `)[0];
    assert.strictEqual(inline.source, "style");
    assert.deepStrictEqual(violationToStyleFix(inline), {
        componentName: "StatBlock", propName: "borderRadius", figmaValue: "12px",
    });

    const fromClass = lint(`
        // @design-component StatBlock
        const S = () => <div data-figma="StatBlock" className="rounded-lg" />;
    `)[0];
    assert.strictEqual(fromClass.kind, "mismatch");
    assert.strictEqual(fromClass.source, "class");
    // class-sourced mismatch: never shadow the class with an inline override
    assert.strictEqual(violationToStyleFix(fromClass), null);

    const missing = lint(`
        // @design-component StatBlock
        const S = () => <div data-figma="StatBlock" />;
    `)[0];
    assert.strictEqual(missing.kind, "missing");
    assert.ok(violationToStyleFix(missing));

    // breakpoint violations are never fixable inline
    assert.strictEqual(violationToStyleFix({ ...inline, breakpoint: "md" }), null);
});

test("data-figma attribute without annotation or spec is unknown-component", () => {
    const violations = lint(`
        const S = () => <div data-figma="Renamed" />;
    `);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].kind, "unknown-component");
    assert.strictEqual(violations[0].component, "Renamed");
    assert.ok(violations[0].loc && violations[0].loc.line === 2);
});

test("data-figma attribute matching a spec node produces no violation", () => {
    const violations = lint(`
        const S = () => <div data-figma="StatBlock" />;
    `);
    assert.deepStrictEqual(violations, []);
});

test("theme member expression naming the bound token is clean", () => {
    // Sidebar binds backgroundColor to color/primary; theme.colors.primary
    // resolves to the same identity across the color/colors category gap.
    const violations = lint(`
        // @design-component Sidebar
        const S = () => <div data-figma="Sidebar" style={{ width: 220, backgroundColor: theme.colors.primary }} />;
    `);
    assert.deepStrictEqual(violations, []);
});

test("theme member expression naming the wrong token is a token-mismatch error", () => {
    const violations = lint(`
        // @design-component Sidebar
        const S = () => <div data-figma="Sidebar" style={{ width: 220, backgroundColor: theme.colors.secondary }} />;
    `);
    assert.strictEqual(violations.length, 1);
    const v = violations[0];
    assert.strictEqual(v.kind, "token-mismatch");
    assert.strictEqual(v.severity, "error");
    assert.strictEqual(v.property, "backgroundColor");
    assert.strictEqual(v.token, "color/primary");
    assert.strictEqual(v.actual, "theme.colors.secondary");
});

test("theme reference stays exempt when the spec binds no token", () => {
    // StatBlock has no token binding on borderRadius, so a theme reference
    // has nothing to compare against and must not be flagged.
    const violations = lint(`
        // @design-component StatBlock
        const S = () => <div data-figma="StatBlock" style={{ borderRadius: theme.radius.card }} />;
    `);
    assert.deepStrictEqual(violations, []);
});

test("a bare identifier reference also counts as present", () => {
    const violations = lint(`
        // @design-component StatBlock
        const S = () => <div data-figma="StatBlock" style={{ borderRadius: cardRadius }} />;
    `);
    assert.deepStrictEqual(violations, []);
});

test("a child sharing the frame's name wins over the frame's own spec", () => {
    const shadowFrame = {
        id: "1", type: "FRAME", width: "1000px",
        children: {
            Dashboard: { id: "2", name: "Dashboard", type: "FRAME", width: "300px" },
        },
    };
    const violations = lintSource(`
        // @design-component Dashboard
        const D = () => <div data-figma="Dashboard" style={{ width: 300 }} />;
    `, "Dashboard", shadowFrame);
    assert.deepStrictEqual(violations, []);
});
