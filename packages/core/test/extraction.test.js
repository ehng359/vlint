const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const { queryFigmaStyles, generateLayoutCss, mapFigmaToCss } = require("../dist/extraction");
const { setLogger } = require("../dist/logger");

const fixture = (name) =>
    JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf-8"));

// Silence core logging during tests, but capture warnings for assertions
let warnings = [];
setLogger({
    log: () => { },
    warn: (m) => warnings.push(m),
    error: () => { },
});

function stubFetch(routes) {
    global.fetch = async (url) => {
        for (const [match, body] of routes) {
            if (String(url).includes(match)) {
                return { ok: true, status: 200, json: async () => body };
            }
        }
        return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) };
    };
}

test("mapFigmaToCss passes Figma border-box dimensions straight through", () => {
    const css = mapFigmaToCss({
        id: "1", name: "Card", type: "FRAME",
        visualDimensions: { width: 198, height: 77 },
        padding: { top: 20, right: 24, bottom: 20, left: 24 },
    });
    assert.strictEqual(css.width, "198px");
    assert.strictEqual(css.height, "77px");
    assert.strictEqual(css.padding, "20px 24px");
});

test("mapFigmaToCss drops a null cornerRadius instead of emitting 'nullpx'", () => {
    const css = mapFigmaToCss({
        id: "1", name: "Label", type: "TEXT",
        borderRadius: null,
        visualDimensions: { width: 100, height: 20 },
    });
    assert.strictEqual(css.borderRadius, undefined);
});

test("mapFigmaToCss maps auto-layout and solid fills", () => {
    const css = mapFigmaToCss({
        id: "1", name: "Row", type: "FRAME",
        layoutMode: "HORIZONTAL", itemSpacing: 16,
        alignItems: "CENTER", justifyContent: "SPACE_BETWEEN",
        visuals: { fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }] },
    });
    assert.strictEqual(css.display, "flex");
    assert.strictEqual(css.flexDirection, "row");
    assert.strictEqual(css.gap, "16px");
    assert.strictEqual(css.alignItems, "center");
    assert.strictEqual(css.justifyContent, "space-between");
    assert.strictEqual(css.backgroundColor, "#FFFFFF");
});

test("mapFigmaToCss carries token bindings from boundVariables", () => {
    const css = mapFigmaToCss({
        id: "1", name: "Sidebar", type: "FRAME",
        visuals: { fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }] },
        variables: { fills: [{ type: "VARIABLE_ALIAS", id: "VariableID:1:100" }] },
    });
    assert.deepStrictEqual(css.tokens, { backgroundColor: "VariableID:1:100" });
});

test("generateLayoutCss emits border-box and skips browser defaults", () => {
    const css = generateLayoutCss("Dashboard", {
        Sidebar: { id: "1", name: "Sidebar", type: "FRAME", width: "220px", opacity: "1" },
    });
    assert.match(css, /box-sizing: border-box/);
    assert.match(css, /\[data-figma="Sidebar"\]/);
    assert.match(css, /width: 220px/);
    assert.doesNotMatch(css, /opacity/);
    assert.match(css, /@layer figma\.layout/);
});

test("queryFigmaStyles builds the DESIGN_REF shape from API fixtures", async () => {
    warnings = [];
    stubFetch([
        ["?depth=", fixture("file-depth2-response.json")],
        ["/nodes?ids=", fixture("nodes-response.json")],
        ["/variables/local", { meta: { variables: { "VariableID:1:100": { name: "color/primary" } } } }],
    ]);

    const page = await queryFigmaStyles("dev", "FKEY", "PAT");

    // Version stamp for drift direction
    assert.strictEqual(page.version, "1234567890");
    assert.strictEqual(page.lastModified, "2026-06-08T23:15:40Z");

    const dashboard = page.nodes.Dashboard;
    assert.ok(dashboard);
    assert.strictEqual(dashboard.children.Sidebar.width, "220px");
    assert.strictEqual(dashboard.children.Sidebar.backgroundColor, "#1A1A38");

    // Variable id resolved to a token name via the Variables API, for
    // children and for the frame node itself
    assert.deepStrictEqual(dashboard.children.Sidebar.tokens, { backgroundColor: "color/primary" });
    assert.deepStrictEqual(dashboard.tokens, { backgroundColor: "color/primary" });
    assert.deepStrictEqual(page.variables, { "VariableID:1:100": "color/primary" });

    // Style reference carried through
    assert.deepStrictEqual(dashboard.children.NavLabel.styleRefs, { text: "Body/Sm" });

    // Duplicate StatBlock nodes in the fixture must produce a warning
    assert.ok(warnings.some(w => w.includes('Duplicate node name "StatBlock"')));

    // Generated CSS present and layered
    assert.match(page.generatedCss.Dashboard, /@layer figma\.layout/);
    assert.match(page.generatedCss.Dashboard, /box-sizing: border-box/);

    // The Dashboard@md frame stays in nodes for validation but folds into
    // the base stylesheet as a media block instead of its own file
    assert.ok(page.nodes["Dashboard@md"]);
    assert.strictEqual(page.generatedCss["Dashboard@md"], undefined);
    assert.match(page.generatedCss.Dashboard, /@media \(min-width: 768px\)/);
    const mdBlock = page.generatedCss.Dashboard.split("@media (min-width: 768px)")[1];
    assert.match(mdBlock, /width: 160px/);
});

test("frames inside SECTION containers are found and extracted", async () => {
    warnings = [];
    stubFetch([
        ["?depth=", fixture("file-depth2-response.json")],
        ["/nodes?ids=", fixture("nodes-response.json")],
    ]);

    const page = await queryFigmaStyles("dev", "FKEY", "PAT");
    const pricing = page.nodes.Pricing;
    assert.ok(pricing, "section-wrapped frame missing from extraction");
    assert.strictEqual(pricing.width, "900px");

    // per-corner radii serialize as the four-value shorthand
    assert.strictEqual(pricing.children.Hero.borderRadius, "8px 8px 0px 0px");
    // gradient fill: backgroundColor omitted entirely, never null
    assert.ok(!("backgroundColor" in pricing.children.Hero));
    // rotated node: dimensions omitted, solid fill still translated
    assert.strictEqual(pricing.children.Badge.width, undefined);
    assert.strictEqual(pricing.children.Badge.backgroundColor, "#FF0000");

    assert.ok(warnings.some(w => w.includes("gradient/image fill")));
    assert.ok(warnings.some(w => w.includes("rotated node")));
});

test("queryFigmaStyles keeps raw variable ids when the Variables API is gated", async () => {
    stubFetch([
        ["?depth=", fixture("file-depth2-response.json")],
        ["/nodes?ids=", fixture("nodes-response.json")],
        // no /variables/local route: falls through to 404, the Enterprise-gated case
    ]);

    const page = await queryFigmaStyles("dev", "FKEY", "PAT");
    assert.deepStrictEqual(page.nodes.Dashboard.children.Sidebar.tokens, { backgroundColor: "VariableID:1:100" });
    assert.strictEqual(page.variables, undefined);
});

test("queryFigmaStyles throws a descriptive error for a missing page", async () => {
    stubFetch([["?depth=", fixture("file-depth2-response.json")]]);
    await assert.rejects(
        () => queryFigmaStyles("nonexistent-page", "FKEY", "PAT"),
        /No frames found on page "nonexistent-page"/
    );
});
