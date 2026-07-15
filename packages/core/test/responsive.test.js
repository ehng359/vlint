const test = require("node:test");
const assert = require("node:assert");
const { resolveTailwindClasses, effectiveAtBreakpoint } = require("../dist/tailwind");
const { lintSource } = require("../dist/validate");
const { mapFigmaToCss } = require("../dist/extraction");

test("responsive variants land in their own breakpoint bucket", () => {
    const resolved = resolveTailwindClasses("w-55 md:w-40 lg:w-[500px] hover:w-10");
    assert.strictEqual(resolved.values.width, "220px");
    assert.strictEqual(resolved.breakpoints.md.values.width, "160px");
    assert.strictEqual(resolved.breakpoints.lg.values.width, "500px");
    assert.strictEqual(resolved.breakpoints.hover, undefined);
});

test("effectiveAtBreakpoint applies the mobile-first cascade in order", () => {
    const resolved = resolveTailwindClasses("w-55 gap-2 md:w-40 lg:w-[500px]");
    assert.strictEqual(effectiveAtBreakpoint(resolved, "sm").values.width, "220px");
    assert.strictEqual(effectiveAtBreakpoint(resolved, "md").values.width, "160px");
    // lg inherits md's override chain, then applies its own
    assert.strictEqual(effectiveAtBreakpoint(resolved, "lg").values.width, "500px");
    assert.strictEqual(effectiveAtBreakpoint(resolved, "2xl").values.width, "500px");
    // untouched props survive the cascade
    assert.strictEqual(effectiveAtBreakpoint(resolved, "lg").values.gap, "8px");
});

test("responsive padding buckets serialize independently", () => {
    const resolved = resolveTailwindClasses("p-5 md:py-6 md:px-4");
    assert.strictEqual(resolved.values.padding, "20px 20px");
    assert.strictEqual(resolved.breakpoints.md.values.padding, "24px 16px");
});

test("min-w and max-w utilities resolve", () => {
    const { values } = resolveTailwindClasses("min-w-40 max-w-[708px]");
    assert.strictEqual(values.minWidth, "160px");
    assert.strictEqual(values.maxWidth, "708px");
});

test("Figma minWidth/maxWidth map into the spec", () => {
    const css = mapFigmaToCss({
        id: "1", name: "Card", type: "FRAME",
        minWidth: 160, maxWidth: 708.4,
        visualDimensions: { width: 300, height: 100 },
    });
    assert.strictEqual(css.minWidth, "160px");
    assert.strictEqual(css.maxWidth, "708px");
});

// ── responsive CSS generation ───────────────────────────────────────────────

const { generateLayoutCss } = require("../dist/extraction");

test("breakpoint frames become mobile-first @media blocks with only the diff", () => {
    const base = {
        Sidebar: { id: "1", name: "Sidebar", type: "FRAME", width: "220px", backgroundColor: "#1A1A38" },
    };
    const css = generateLayoutCss("Dashboard", base, {
        md: { Sidebar: { id: "2", name: "Sidebar", type: "FRAME", width: "160px", backgroundColor: "#1A1A38" } },
        lg: { Sidebar: { id: "3", name: "Sidebar", type: "FRAME", width: "500px", backgroundColor: "#1A1A38" } },
    });

    assert.match(css, /@media \(min-width: 768px\)/);
    assert.match(css, /@media \(min-width: 1024px\)/);
    // md block carries only the changed width, not the unchanged background
    const mdBlock = css.split("@media (min-width: 768px)")[1].split("@media")[0];
    assert.match(mdBlock, /width: 160px/);
    assert.doesNotMatch(mdBlock, /background-color/);
    // lg diffs against the cascade (base + md), not against base
    const lgBlock = css.split("@media (min-width: 1024px)")[1];
    assert.match(lgBlock, /width: 500px/);
    // media blocks come after the base layer, mobile-first order
    assert.ok(css.indexOf("min-width: 768px") < css.indexOf("min-width: 1024px"));
});

test("a breakpoint frame identical to the cascade emits no media block", () => {
    const base = { Sidebar: { id: "1", name: "Sidebar", type: "FRAME", width: "220px" } };
    const css = generateLayoutCss("Dashboard", base, {
        md: { Sidebar: { id: "2", name: "Sidebar", type: "FRAME", width: "220px" } },
    });
    assert.doesNotMatch(css, /@media/);
});

// ── breakpoint frame validation ─────────────────────────────────────────────

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

function lintResponsive(jsx) {
    return lintSource(jsx, "Dashboard", frames.Dashboard, frames);
}

test("matching responsive classes lint clean at every breakpoint", () => {
    const violations = lintResponsive(`
        // @design-component Sidebar
        const S = () => <div data-figma="Sidebar" className="w-55 md:w-40" />;
    `);
    assert.deepStrictEqual(violations, []);
});

test("a missing breakpoint override is caught against the breakpoint frame", () => {
    const violations = lintResponsive(`
        // @design-component Sidebar
        const S = () => <div data-figma="Sidebar" className="w-55" />;
    `);
    // base w-55 cascades to md, where the design says 160px
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].breakpoint, "md");
    assert.strictEqual(violations[0].kind, "mismatch");
    assert.strictEqual(violations[0].actual, "220px");
    assert.strictEqual(violations[0].expected, "160px");
});

test("a wrong breakpoint override is a mismatch at that breakpoint only", () => {
    const violations = lintResponsive(`
        // @design-component Sidebar
        const S = () => <div data-figma="Sidebar" className="w-55 md:w-48" />;
    `);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].breakpoint, "md");
    assert.strictEqual(violations[0].actual, "192px");
});

test("breakpoint passes do not repeat missing-property warnings", () => {
    const violations = lintResponsive(`
        // @design-component Sidebar
        const S = () => <div data-figma="Sidebar" />;
    `);
    // one missing warning from the base pass, nothing extra from Dashboard@md
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].kind, "missing");
    assert.strictEqual(violations[0].breakpoint, undefined);
});

test("no breakpoint frames means no responsive passes", () => {
    const violations = lintSource(`
        // @design-component Sidebar
        const S = () => <div data-figma="Sidebar" className="w-55 md:w-40" />;
    `, "Dashboard", frames.Dashboard, { Dashboard: frames.Dashboard });
    assert.deepStrictEqual(violations, []);
});
