const test = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BIN = path.join(__dirname, "..", "bin", "vlint-mcp.js");

function makeWorkspace() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vlint-mcp-"));
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
    fs.writeFileSync(path.join(dir, "Bad.tsx"), [
        "// @design-frame Dashboard",
        "// @design-component StatBlock",
        'export const S = () => <div data-figma="StatBlock" style={{ borderRadius: 8 }} />;',
    ].join("\n"));
    return dir;
}

function session(dir, messages) {
    const input = messages.map(m => JSON.stringify(m)).join("\n") + "\n";
    const stdout = execFileSync("node", [BIN], {
        cwd: dir, input, encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"],
    });
    return stdout.trim().split("\n").map(line => JSON.parse(line));
}

const HANDSHAKE = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
];

test("exposes the three contract tools", () => {
    const responses = session(makeWorkspace(), [
        ...HANDSHAKE,
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    const tools = responses.find(r => r.id === 2).result.tools.map(t => t.name);
    assert.deepStrictEqual(tools, ["list_frames", "get_frame_spec", "validate_file"]);
});

test("validate_file returns the CLI's CheckResult shape", () => {
    const responses = session(makeWorkspace(), [
        ...HANDSHAKE,
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "validate_file", arguments: { file: "Bad.tsx" } } },
    ]);
    const result = JSON.parse(responses.find(r => r.id === 2).result.content[0].text);
    assert.strictEqual(result.frame, "Dashboard");
    assert.strictEqual(result.violations[0].kind, "mismatch");
    assert.strictEqual(result.violations[0].expected, "12px");
});

test("get_frame_spec on an unknown frame is a tool error, not a crash", () => {
    const responses = session(makeWorkspace(), [
        ...HANDSHAKE,
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_frame_spec", arguments: { frame: "Nope" } } },
    ]);
    const reply = responses.find(r => r.id === 2).result;
    assert.strictEqual(reply.isError, true);
    assert.match(reply.content[0].text, /known frames: Dashboard/);
});
