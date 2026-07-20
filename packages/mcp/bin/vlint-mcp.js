#!/usr/bin/env node
const path = require("path");
const core = require("@vlint/core");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");

// stdout carries the protocol; everything else goes to stderr
core.setLogger({
    log: (m) => console.error(m),
    warn: (m) => console.error(m),
    error: (m) => console.error(m),
});

const ROOT = process.env.VLINT_ROOT || process.cwd();

const TOOLS = [
    {
        name: "list_frames",
        description:
            "List the Figma frames available in this workspace's DESIGN_REF.json, " +
            "with the snapshot version. Call this first to discover valid frame names.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
        name: "get_frame_spec",
        description:
            "Get the full design spec for one Figma frame: CSS-valued properties per " +
            "component, plus token bindings under `tokens`. Use this before writing " +
            "code so the implementation starts from the contract.",
        inputSchema: {
            type: "object",
            properties: { frame: { type: "string", description: "Frame name from list_frames" } },
            required: ["frame"],
            additionalProperties: false,
        },
    },
    {
        name: "validate_file",
        description:
            "Statically validate a React source file's annotated inline styles against " +
            "the design contract. Returns violations (mismatch, missing, hardcoded-token, " +
            "token-mismatch, unknown-component) with source locations. Same shape as `vlint check --json`.",
        inputSchema: {
            type: "object",
            properties: {
                file: { type: "string", description: "Path to a .jsx/.tsx file, relative to the workspace root" },
                frame: { type: "string", description: "Optional frame override; defaults to the file's @design-frame" },
            },
            required: ["file"],
            additionalProperties: false,
        },
    },
];

function requireDesignRef() {
    const designRef = core.loadDesignRef(ROOT);
    if (!designRef) {
        throw new Error(`No DESIGN_REF.json in ${ROOT}. Run \`vlint extract\` there first.`);
    }
    return designRef;
}

function runTool(name, args) {
    switch (name) {
        case "list_frames":
            return core.listFrames(requireDesignRef());
        case "get_frame_spec":
            return core.getFrameSpec(requireDesignRef(), args.frame);
        case "validate_file": {
            const designRef = requireDesignRef();
            return core.checkFile(path.resolve(ROOT, args.file), designRef, args.frame);
        }
        default:
            throw new Error(`Unknown tool "${name}"`);
    }
}

async function main() {
    const server = new Server(
        { name: "vlint", version: "0.1.0" },
        { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        try {
            const result = runTool(request.params.name, request.params.arguments ?? {});
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
            return { content: [{ type: "text", text: err.message }], isError: true };
        }
    });

    await server.connect(new StdioServerTransport());
    console.error(`[vlint-mcp] Serving design contract from ${ROOT}`);
}

main().catch((err) => {
    console.error(`[vlint-mcp] Fatal: ${err.message}`);
    process.exit(1);
});
