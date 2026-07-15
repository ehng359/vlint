# @vlint/mcp

MCP server exposing the [vlint](https://github.com/ehng359/vlint) design contract to coding agents over stdio.

| Tool | Purpose |
|---|---|
| `list_frames` | Frames in `DESIGN_REF.json` plus the snapshot version |
| `get_frame_spec` | One frame's full spec, including token bindings |
| `validate_file` | Lint a source file; same JSON shape as `vlint check --json` |

```json
{
  "mcpServers": {
    "vlint": {
      "command": "vlint-mcp",
      "env": { "VLINT_ROOT": "/path/to/your/app" }
    }
  }
}
```

The intended loop: `get_frame_spec` before writing code, `validate_file` after each edit, repeat until clean. Full documentation lives in the [repository README](https://github.com/ehng359/vlint#readme).
