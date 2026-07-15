const test = require("node:test");
const assert = require("node:assert");
const { resolveTailwindClasses } = require("../dist/tailwind");
const { lintSource } = require("../dist/validate");

test("spacing-scale utilities resolve at 4px per step", () => {
    const { values } = resolveTailwindClasses("w-55 h-16 gap-6 p-5");
    assert.strictEqual(values.width, "220px");
    assert.strictEqual(values.height, "64px");
    assert.strictEqual(values.gap, "24px");
    assert.strictEqual(values.padding, "20px 20px");
});

test("arbitrary values resolve exactly", () => {
    const { values } = resolveTailwindClasses("w-[220px] rounded-[25px] bg-[#431717] text-[36px] tracking-[0.04em]");
    assert.strictEqual(values.width, "220px");
    assert.strictEqual(values.borderRadius, "25px");
    assert.strictEqual(values.backgroundColor, "#431717");
    assert.strictEqual(values.fontSize, "36px");
    assert.strictEqual(values.letterSpacing, "0.04em");
});

test("v4 radius and text scales resolve to px", () => {
    const { values } = resolveTailwindClasses("rounded-xl text-4xl font-semibold");
    assert.strictEqual(values.borderRadius, "12px");
    assert.strictEqual(values.fontSize, "36px");
    assert.strictEqual(values.lineHeight, "40px");
    assert.strictEqual(values.fontWeight, 600);
});

test("asymmetric padding serializes like the extraction shorthand", () => {
    const { values } = resolveTailwindClasses("py-5 px-6");
    assert.strictEqual(values.padding, "20px 24px");
    const four = resolveTailwindClasses("pt-1 pr-2 pb-3 pl-4").values;
    assert.strictEqual(four.padding, "4px 8px 12px 16px");
});

test("partial padding is a reference, not a comparable value", () => {
    const { values, references } = resolveTailwindClasses("pt-4");
    assert.strictEqual(values.padding, undefined);
    assert.ok("padding" in references);
});

test("flex utilities map to their CSS equivalents", () => {
    const { values } = resolveTailwindClasses("flex flex-col items-center justify-between self-stretch flex-1");
    assert.strictEqual(values.display, "flex");
    assert.strictEqual(values.flexDirection, "column");
    assert.strictEqual(values.alignItems, "center");
    assert.strictEqual(values.justifyContent, "space-between");
    assert.strictEqual(values.alignSelf, "stretch");
    assert.strictEqual(values.flex, "1");
});

test("theme color utilities become token references", () => {
    const { references } = resolveTailwindClasses("bg-primary text-accent");
    assert.strictEqual(references.backgroundColor, "color-primary");
    assert.strictEqual(references.color, "color-accent");
    const varForm = resolveTailwindClasses("bg-(--color-primary)").references;
    assert.strictEqual(varForm.backgroundColor, "color-primary");
});

test("unresolvable and unknown classes never produce values", () => {
    const { values, references } = resolveTailwindClasses("card w-full leading-tight hover:bg-red-500 md:w-10 text-nowrap");
    assert.deepStrictEqual(values, {});
    assert.strictEqual(references.width, null);      // w-full: present, exempt
    assert.strictEqual(references.lineHeight, null); // leading-tight: unitless
    assert.strictEqual(references.color, undefined); // text-nowrap is not a color
});

test("last conflicting utility wins", () => {
    const { values } = resolveTailwindClasses("w-10 w-[220px]");
    assert.strictEqual(values.width, "220px");
});

// ── merge semantics through lintSource ──────────────────────────────────────

const frame = {
    id: "1", type: "FRAME",
    children: {
        Sidebar: {
            id: "2", name: "Sidebar", type: "FRAME",
            width: "220px", backgroundColor: "#1A1A38", borderRadius: "12px",
            tokens: { backgroundColor: "color/primary" },
        },
    },
};

test("matching Tailwind classes lint clean", () => {
    const violations = lintSource(`
        // @design-component Sidebar
        const S = () => <div data-figma="Sidebar" className="w-55 rounded-xl bg-[#1A1A38]" />;
    `, "Dashboard", frame);
    // bg is a hardcoded token match: value equal, token bound
    assert.deepStrictEqual(violations.map(v => v.kind), ["hardcoded-token"]);
});

test("a drifted Tailwind class is a mismatch with the class attr location", () => {
    const violations = lintSource(`
        // @design-component Sidebar
        const S = () => <div data-figma="Sidebar" className="w-40 rounded-xl bg-primary" />;
    `, "Dashboard", frame);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].kind, "mismatch");
    assert.strictEqual(violations[0].property, "width");
    assert.strictEqual(violations[0].actual, "160px");
    assert.ok(violations[0].loc && violations[0].loc.line === 3);
});

test("bg-primary satisfies the token-bound backgroundColor", () => {
    const violations = lintSource(`
        // @design-component Sidebar
        const S = () => <div data-figma="Sidebar" className="w-55 rounded-xl bg-primary" />;
    `, "Dashboard", frame);
    assert.deepStrictEqual(violations, []);
});

test("inline style wins over a conflicting Tailwind class", () => {
    const violations = lintSource(`
        // @design-component Sidebar
        const S = () => <div data-figma="Sidebar" className="w-40 rounded-xl bg-primary" style={{ width: 220 }} />;
    `, "Dashboard", frame);
    assert.deepStrictEqual(violations, []);
});

test("dynamic className expressions are ignored, not crashed on", () => {
    const violations = lintSource(`
        // @design-component Sidebar
        const S = () => <div data-figma="Sidebar" className={clsx("w-55", active && "bg-primary")} style={{ width: 220, backgroundColor: "var(--color-primary)", borderRadius: 12 }} />;
    `, "Dashboard", frame);
    assert.deepStrictEqual(violations, []);
});
