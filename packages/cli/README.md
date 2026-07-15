# @vlint/cli

Headless [vlint](https://github.com/ehng359/vlint): validate React sources against a Figma design contract from CI or a coding agent's edit loop.

```bash
vlint extract                    # fetch from Figma, write DESIGN_REF.json + CSS
vlint check src/*.tsx --json     # structured violations, exit 1 on drift
vlint spec Dashboard             # print a frame's spec (no arg lists frames)
```

Reads `design.manifest` and `DESIGN_REF.json` from the current directory. Exit codes: 0 clean, 1 violations, 2 configuration error. `--strict` makes warnings fail; `--no-remote` skips the live drift probe.

Full documentation lives in the [repository README](https://github.com/ehng359/vlint#readme).
