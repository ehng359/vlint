const test = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BIN = path.join(__dirname, "..", "bin", "vlint.js");

function makeWorkspace() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vlint-cli-"));
    fs.writeFileSync(path.join(dir, "DESIGN_REF.json"), JSON.stringify({
        extractedAt: "2026-07-13T00:00:00.000Z",
        version: "999",
        nodes: {
            Dashboard: {
                id: "1", type: "FRAME",
                children: {
                    StatBlock: { id: "2", name: "StatBlock", type: "FRAME", borderRadius: "12px" },
                },
            },
        },
        generatedCss: {},
    }));
    return dir;
}

function run(dir, args) {
    try {
        const stdout = execFileSync("node", [BIN, ...args], { cwd: dir, encoding: "utf-8" });
        return { code: 0, stdout };
    } catch (err) {
        return { code: err.status, stdout: err.stdout ?? "" };
    }
}

test("check exits 1 on a mismatch and reports it in --json", () => {
    const dir = makeWorkspace();
    fs.writeFileSync(path.join(dir, "Bad.tsx"), [
        "// @design-frame Dashboard",
        "// @design-component StatBlock",
        'export const S = () => <div data-figma="StatBlock" style={{ borderRadius: 8 }} />;',
    ].join("\n"));

    const { code, stdout } = run(dir, ["check", "Bad.tsx", "--no-remote", "--json"]);
    assert.strictEqual(code, 1);
    const report = JSON.parse(stdout);
    assert.strictEqual(report.summary.errors, 1);
    assert.strictEqual(report.results[0].violations[0].kind, "mismatch");
});

test("check exits 0 on a clean file", () => {
    const dir = makeWorkspace();
    fs.writeFileSync(path.join(dir, "Good.tsx"), [
        "// @design-frame Dashboard",
        "// @design-component StatBlock",
        'export const S = () => <div data-figma="StatBlock" style={{ borderRadius: 12 }} />;',
    ].join("\n"));

    const { code } = run(dir, ["check", "Good.tsx", "--no-remote"]);
    assert.strictEqual(code, 0);
});

test("spec --tailwind renders components as class strings", () => {
    const dir = makeWorkspace();
    const { code, stdout } = run(dir, ["spec", "Dashboard", "--tailwind"]);
    assert.strictEqual(code, 0);
    const out = JSON.parse(stdout);
    assert.strictEqual(out.children.StatBlock, "rounded-xl");
});

test("spec with no argument lists frames", () => {
    const dir = makeWorkspace();
    const { code, stdout } = run(dir, ["spec"]);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(JSON.parse(stdout).frames, ["Dashboard"]);
});

test("an unknown flag is a usage error (exit 2), not silently ignored", () => {
    const dir = makeWorkspace();
    const { code } = run(dir, ["check", "x.tsx", "--no-remote", "--stric"]);
    assert.strictEqual(code, 2);
});

test("fix corrects inline drift via style and class drift via className", () => {
    const dir = makeWorkspace();
    const file = path.join(dir, "Mixed.tsx");
    fs.writeFileSync(file, [
        "// @design-frame Dashboard",
        "// @design-component StatBlock",
        'export const S = () => <div data-figma="StatBlock" className="rounded-lg" style={{ borderRadius: 8 }} />;',
    ].join("\n"));

    // inline style wins the cascade, so the mismatch is style-sourced
    const { code, stdout } = run(dir, ["fix", "Mixed.tsx", "--json"]);
    const report = JSON.parse(stdout);
    assert.deepStrictEqual(report.results[0].applied, [
        { componentName: "StatBlock", propName: "borderRadius", figmaValue: "12px", via: "style" },
    ]);
    assert.strictEqual(report.results[0].written, true);
    assert.match(fs.readFileSync(file, "utf-8"), /borderRadius: "12px"/);
    assert.strictEqual(code, 0);

    // class-only drift: fixed by replacing the utility, never by adding an
    // inline override
    fs.writeFileSync(file, [
        "// @design-frame Dashboard",
        "// @design-component StatBlock",
        'export const S = () => <div data-figma="StatBlock" className="flex rounded-lg" />;',
    ].join("\n"));
    const second = run(dir, ["fix", "Mixed.tsx", "--json"]);
    const report2 = JSON.parse(second.stdout);
    assert.deepStrictEqual(report2.results[0].applied, [
        { componentName: "StatBlock", propName: "borderRadius", figmaValue: "12px", via: "class" },
    ]);
    assert.strictEqual(second.code, 0);
    const fixed = fs.readFileSync(file, "utf-8");
    assert.match(fixed, /className="flex rounded-xl"/);
    assert.doesNotMatch(fixed, /style=/);
});

test("fix --dry-run reports without writing", () => {
    const dir = makeWorkspace();
    const file = path.join(dir, "Dry.tsx");
    const original = [
        "// @design-frame Dashboard",
        "// @design-component StatBlock",
        'export const S = () => <div data-figma="StatBlock" style={{ borderRadius: 8 }} />;',
    ].join("\n");
    fs.writeFileSync(file, original);

    const { code, stdout } = run(dir, ["fix", "Dry.tsx", "--dry-run", "--json"]);
    const report = JSON.parse(stdout);
    assert.strictEqual(report.results[0].applied.length, 1);
    assert.strictEqual(report.results[0].applied[0].via, "style");
    assert.strictEqual(report.results[0].written, false);
    assert.strictEqual(fs.readFileSync(file, "utf-8"), original);
    assert.strictEqual(code, 0);
});

test("missing DESIGN_REF.json is a configuration error (exit 2)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vlint-cli-empty-"));
    const { code } = run(dir, ["check", "x.tsx", "--no-remote"]);
    assert.strictEqual(code, 2);
});
