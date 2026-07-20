const test = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BIN = path.join(__dirname, "..", "bin", "vlint.js");

function tmpdir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "vlint-init-"));
}

function run(dir, args) {
    try {
        // init writes progress to stderr; capture both streams
        const stdout = execFileSync("node", [BIN, ...args], { cwd: dir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
        return { code: 0, stdout };
    } catch (err) {
        return { code: err.status, stderr: err.stderr ?? "" };
    }
}

test("init writes FIGMA_FKEY and FIGMA_DEV_PAGE from a pasted link", () => {
    const dir = tmpdir();
    const { code } = run(dir, ["init", "https://www.figma.com/file/AbC123/Dashboard?node-id=285-31"]);
    assert.strictEqual(code, 0);
    const manifest = fs.readFileSync(path.join(dir, "design.manifest"), "utf-8");
    assert.match(manifest, /^FIGMA_FKEY=AbC123$/m);
    assert.match(manifest, /^FIGMA_DEV_PAGE=285:31$/m);
    // the token must never be persisted to the manifest
    assert.doesNotMatch(manifest, /FIGMA_PAT=/);
});

test("init preserves existing manifest keys and overrides --page", () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, "design.manifest"), "FIGMA_STYLES_DIR=src/styles/figma\n");
    const { code } = run(dir, ["init", "https://www.figma.com/design/XyZ789/App", "--page", "Home"]);
    assert.strictEqual(code, 0);
    const manifest = fs.readFileSync(path.join(dir, "design.manifest"), "utf-8");
    assert.match(manifest, /^FIGMA_FKEY=XyZ789$/m);
    assert.match(manifest, /^FIGMA_DEV_PAGE=Home$/m);
    assert.match(manifest, /^FIGMA_STYLES_DIR=src\/styles\/figma$/m);
});

test("init rejects a non-Figma link with exit 2", () => {
    const dir = tmpdir();
    const { code } = run(dir, ["init", "https://example.com/x"]);
    assert.strictEqual(code, 2);
    assert.strictEqual(fs.existsSync(path.join(dir, "design.manifest")), false);
});

test("init with no argument is a usage error", () => {
    const dir = tmpdir();
    const { code } = run(dir, ["init"]);
    assert.strictEqual(code, 2);
});
