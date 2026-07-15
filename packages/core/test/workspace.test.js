const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { listFrames, getFrameSpec } = require("../dist/workspace");
const { parseManifest } = require("../dist/manifest");

const designRef = {
    extractedAt: "2026-07-13T00:00:00.000Z",
    version: "999",
    nodes: { Dashboard: { id: "1", type: "FRAME", children: {} } },
};

test("listFrames returns frames with snapshot metadata", () => {
    assert.deepStrictEqual(listFrames(designRef), {
        frames: ["Dashboard"],
        version: "999",
        extractedAt: "2026-07-13T00:00:00.000Z",
    });
});

test("getFrameSpec throws with known frames for a bad name", () => {
    assert.throws(() => getFrameSpec(designRef, "Nope"), /known frames: Dashboard/);
});

test("parseManifest ignores valueless lines and indented comments", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vlint-manifest-")), "design.manifest");
    fs.writeFileSync(file, [
        "FIGMA_FKEY = abc123",
        "FIGMA_PAT",
        "   # indented comment",
        "",
        "FIGMA_DEV_PAGE=dev",
    ].join("\n"));
    assert.deepStrictEqual(parseManifest(file), {
        FIGMA_FKEY: "abc123",
        FIGMA_DEV_PAGE: "dev",
    });
});

test("parseManifest returns empty for a missing file", () => {
    assert.deepStrictEqual(parseManifest("/nonexistent/design.manifest"), {});
});
