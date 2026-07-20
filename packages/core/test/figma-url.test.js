const test = require("node:test");
const assert = require("node:assert");
const { parseFigmaUrl, looksLikeNodeId } = require("../dist/figma-url");

test("parses a /file/ URL with a dash-form node id", () => {
    const ref = parseFigmaUrl("https://www.figma.com/file/AbC123/Dashboard?node-id=285-31");
    assert.deepStrictEqual(ref, { fileKey: "AbC123", nodeId: "285:31" });
});

test("parses a /design/ URL and decodes an encoded colon node id", () => {
    const ref = parseFigmaUrl("https://www.figma.com/design/XyZ789/App?node-id=0%3A1&t=abc");
    assert.deepStrictEqual(ref, { fileKey: "XyZ789", nodeId: "0:1" });
});

test("parses a /proto/ URL", () => {
    const ref = parseFigmaUrl("https://figma.com/proto/KEY42/Flow?node-id=12-3");
    assert.deepStrictEqual(ref, { fileKey: "KEY42", nodeId: "12:3" });
});

test("a URL with no node-id yields a null nodeId", () => {
    const ref = parseFigmaUrl("https://www.figma.com/file/AbC123/Dashboard");
    assert.deepStrictEqual(ref, { fileKey: "AbC123", nodeId: null });
});

test("a bare file key is accepted", () => {
    assert.deepStrictEqual(parseFigmaUrl("AbC123"), { fileKey: "AbC123", nodeId: null });
});

test("non-figma URLs and junk return null", () => {
    assert.strictEqual(parseFigmaUrl("https://example.com/file/AbC123/x"), null);
    assert.strictEqual(parseFigmaUrl("not a url"), null);
    assert.strictEqual(parseFigmaUrl(""), null);
    // hostname must be figma.com, not a lookalike
    assert.strictEqual(parseFigmaUrl("https://notfigma.com/file/K/x"), null);
    assert.strictEqual(parseFigmaUrl("https://figma.com.evil.com/file/K/x"), null);
});

test("looksLikeNodeId distinguishes ids from page names", () => {
    assert.ok(looksLikeNodeId("285:31"));
    assert.ok(looksLikeNodeId("285-31"));
    assert.ok(looksLikeNodeId("0:1"));
    assert.strictEqual(looksLikeNodeId("Dashboard"), false);
    assert.strictEqual(looksLikeNodeId("dev"), false);
});
