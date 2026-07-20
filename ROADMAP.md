# vlint roadmap

This expands the roadmap section of the README into concrete changes. Phases are ordered by dependency: everything downstream consumes the engine that phase 1 finishes. Within a phase, tasks are listed in the order they should land.

**Status (July 2026): all five phases and the ongoing items have landed.** Two deliberate deviations from the plan as written:

- `vlint check` exits 1 on error-severity violations only; `--strict` makes warnings fail too. The original "any violation" policy would fail every CI run, because missing-property warnings are routine when the generated CSS supplies the value.
- Token references are recognised in two forms with different depth: `var(--token)` is checked against the bound token's name, while `theme.x.y` member expressions are treated as design-system references that count as present and are exempt from value comparison (resolving them to concrete values would require evaluating the theme object).

Verified live: the Variables REST endpoint returns 403 for the current PAT (Enterprise gating), so the shipped fallback, raw variable ids in `tokens` with names filled in only when the endpoint is readable, is the active path.

## Phase 1: wire the validation engine end to end

The engine lived in `@vlint/core` while the save handler stopped at name-level checks. This phase closed that gap.

- [x] Move `normaliseValue` from `packages/extension/src/extension.ts` into core (it belongs next to the comparison logic, and the CLI will need it too).
- [x] Add `lintSource(source: string, frameSpec: FigmaFrame): Violation[]` to core. Single AST traversal that resolves `@design-component` annotations, extracts static style props via `extractStyleProps`, and diffs them against the frame spec through the normalisation layer. `Violation` carries component, property, expected, actual, severity, and source location.
- [x] Export `extractStyleProps` and the new types from `packages/core/src/index.ts`.
- [x] Replace Step 5 in the save handler with a `lintSource` call. Report each violation with its location instead of the current name-only check.
- [x] Gate `applyStyleFixes` behind an explicit setting (`vlint.autoFix`, default off). Silent rewrites on save are too aggressive as a default.
- [x] Fix auto-fix formatting before enabling it anywhere: `generate` currently reformats the whole file. Either pass `retainLines: true` or switch to recast for minimal diffs.

Done when: saving an annotated file with a wrong `borderRadius` reports the mismatch with expected and actual values, and fixes it only when auto-fix is on.

## Phase 2: headless CLI

- [x] New `packages/cli` workspace with a `vlint` bin. Reuse the manifest parser from the extension (move it into core alongside the engine).
- [x] `vlint check <file...> [--frame X] [--json]`. Human-readable output by default, structured violation list with `--json`, exit code 1 on any violation so CI can gate on it.
- [x] `vlint spec <Frame>` prints the extracted frame spec from `DESIGN_REF.json`, so an agent can generate correct code from the contract before writing anything.
- [x] `vlint extract` refreshes `DESIGN_REF.json` outside the editor (CI needs this without VS Code in the loop).
- [x] Route all core logging through an injectable logger. `console.log` in library code pollutes both the extension host and CLI output.

Done when: a GitHub Actions job can run `vlint extract && vlint check src/**/*.tsx --json` and fail the PR on drift.

## Phase 3: MCP server

- [x] New `packages/mcp` workspace exposing three tools over stdio: `list_frames`, `get_frame_spec`, `validate_file`. All three are thin wrappers over the same core functions the CLI uses.
- [x] Tool responses mirror the CLI's JSON shapes so agents see one contract regardless of entry point.
- [x] Document the agent loop in the README: pull the spec, generate, validate, repeat until clean.

Done when: a coding agent with the server configured can fetch a frame spec and validate its own edit without touching the editor.

## Phase 4: token-level contract

- [x] Stop discarding `boundVariables` and style references in `mapFigmaToCss`. Carry them through to `DESIGN_REF.json` alongside the resolved values.
- [x] Extend `lintSource` to recognise token references in code (`var(--token)`, `theme.x.y`) and report at three levels: token reference matches (clean), value matches but is hardcoded (latent drift warning), value mismatch (error).
- [x] Verify early what the PAT can read: the Variables REST endpoint is Enterprise-gated. If unavailable, fall back to token identity inferred from published style metadata already present in node responses.

Done when: a hardcoded `#1A1A38` that matches the current value of `color/primary` produces a latent-drift warning naming the token.

## Phase 5: drift direction

- [x] Stamp the Figma file `version` and `lastModified` into `DESIGN_REF.json` at extraction time.
- [x] `vlint check` compares the live file version against the stamped one and labels each run: design moved ahead of the snapshot (re-extract), code diverged from the snapshot (fix the code), or both.

Done when: the JSON output distinguishes the two failure directions and a consumer can act on each automatically.

## Ongoing, not phase-bound

- [x] Unit tests for core (`mapFigmaToCss`, `generateLayoutCss`, parser, normalisation, `lintSource`) against fixture Figma API responses, plus process-level tests for the CLI and MCP server. `npm test` in each workspace.
- [x] Editor diagnostics via `DiagnosticCollection` with quick-fix code actions ("Apply Figma value"), replacing output-channel-only reporting.
- [x] PAT in VS Code `SecretStorage` (command: "vlint: Set Figma Token"); a manifest `FIGMA_PAT` is migrated in on activation. The manifest keeps the non-secret keys.
- [x] Warn on duplicate node names during extraction; later nodes overwrite earlier ones in `childrenMap`.
- [x] Generated CSS now sets `box-sizing: border-box` and passes Figma's border-box dimensions straight through, removing the padding subtraction.

## Next

- [x] `vlint fix` with source-aware semantics. Violations carry their origin (`style` or `class`); `violationToStyleFix` only fixes inline-sourced mismatches and absent properties, never at breakpoints. A second path, `violationToClassFix` plus `applyClassFixes` plus the inverse mapping `figmaValueToUtility`, fixes class-sourced and breakpoint drift by editing the className with canonical utilities (token-bound colors become token utilities like `bg-primary`). The CLI runs class pass, re-lint, style pass; `--dry-run` and `--json` supported; unfixable drift reports as manual and exits 1. The extension's quick fixes and auto-fix inherit the stricter inline rule automatically.
- [x] `@design-override <prop...>` annotation: declared intentional divergence, exempting listed properties from validation so it stays visible in code review instead of accumulating as ignored warnings.

- [x] Responsive validation. Figma frames named `Frame@md` (sm/md/lg/xl/2xl) are the per-breakpoint specs; the resolver buckets responsive variants, `effectiveAtBreakpoint` computes the mobile-first cascade, and each breakpoint frame is checked for drift (mismatches only, to avoid repeating warnings per frame). Figma `minWidth`/`maxWidth` map to CSS and `min-w-*`/`max-w-*` utilities resolve.
- [x] Responsive CSS generation. Breakpoint frames fold into the base frame's `.figma.css` as mobile-first `@media (min-width: ...)` blocks carrying only the diff against the cascade; standalone `Frame@bp` files are no longer emitted (an orphan breakpoint frame with no base still stands alone).
- [x] Validate Tailwind `className` styling. Core ships a static resolver (`tailwind.ts`) for the utilities that map onto validated properties, three-tier semantics (concrete value / token reference / present-but-exempt), inline style winning over classes. Built against v4 (dynamic spacing, renamed radius scale, CSS-variable theme tokens); the official `__unstable__loadDesignSystem` API was evaluated and rejected for now since it is unstable and requires the target project's CSS entry.
- [x] Validate CSS modules. `className={styles.x}` resolves through the imported `.module.css` (`cssmodules.ts`): bare single-class selectors only, `var()` as token references, `calc()` exempt, standard min-width media blocks feeding the breakpoint passes. Hosts load the files via `loadCssModules`; `lintSource` stays pure. `composes` and mixed static-plus-module classNames are skipped, not guessed.
- [x] Recognise `theme.x.y` member expressions as design-system references (present, exempt from value comparison). Resolving them to concrete token identities remains open.
- Publish `@vlint/core`, `@vlint/cli`, and `@vlint/mcp` to npm, and the extension to the Marketplace. Publish-ready as of July 2026: all three packages have `files` whitelists, repository/publishConfig/engines metadata, npm-facing READMEs, and CI runs every suite plus the extension build on push. The remaining step is `npm publish` and `vsce publish` with Edward's credentials.

## Up next, ranked (July 2026)

1. **Real-file robustness sprint.** Everything live-verified so far ran against one small, clean Figma file; the extraction has known gaps that real files will hit immediately. Concretely: accept SECTION containers at page level and descend into them for frames (today only top-level FRAME children at depth 2 are found, so a sectioned page reports "No frames found"); treat gradient and image fills as present-but-exempt instead of a null color; handle `rectangleCornerRadii` for per-corner radii; skip width/height for rotated nodes (the bounding box is axis-aligned, the values would be wrong); and end each extract with a summary of skipped node types and fill kinds so future gaps surface as warnings instead of silence. No blockers, highest credibility per hour.

2. **Live validation matrix.** Needs about fifteen minutes in Figma: add a `Dashboard@md` frame, bind a color variable to a fill, wrap a frame in a Section, add a gradient, a rotated node, and per-corner radii to the test file. Then run extract, check, and fix live against all of it. The responsive and token layers currently have zero live coverage because the test file cannot exercise them. Also dogfood on a real consumer workspace rather than scratch directories.

3. **Cheap wins on existing machinery.** `vlint spec --tailwind` emitting suggested class strings from the `figmaValueToUtility` inverse mapping, so agents generate from the contract in the project's styling idiom; extension quick fixes offering the class-edit route (`applyClassFixes` exists, the extension only offers inline today); and `vlint tokens --theme` generating a Tailwind v4 `@theme` block from the DESIGN_REF token map so the Figma variables and the project theme provably share names.

4. **Publish.** `npm publish` in core, cli, mcp (core first), `vsce publish` for the extension. Optionally a `release.yml` that publishes on tag once an `NPM_TOKEN` secret exists.

5. **CI integration layer.** Done as of July 2026: the repo doubles as a composite GitHub Action (`uses: ehng359/vlint@main`, root `action.yml`) that installs from the checkout itself, so it works before the npm packages exist. The README documents the PR comment step and the design-moved-ahead issue step as `github-script` templates consumers paste in. A hosted bot with richer rendering remains future work.

## Ship plan (July 2026)

Everything in the ranked list above except the live matrix and publish has landed (robustness sprint, cheap wins, and CI integration all shipped July 17). The remaining work splits into two tracks with a deliberate ordering: prove the untested paths live before shipping the engine.

### Track A: live validation matrix (do first, needs Figma + a PAT)

The responsive and token layers have zero live coverage: the current test file cannot exercise them. Until that changes, publishing risks bad first-impression bug reports on paths that have only ever run against fixtures.

- [ ] Extend the test Figma file (~15 min): a `Dashboard@md` breakpoint frame; a color variable bound to a fill; a frame wrapped in a Section; a gradient fill and an image fill; a rotated node; per-corner radii.
- [ ] Run `vlint extract` (needs the PAT), then `check` and `fix` against every new frame; read the output for each of the six cases.
- [ ] For anything that misbehaves, fix the engine and add a fixture test capturing the real API response shape so it never regresses.
- [ ] Dogfood on one real consumer workspace, not a scratch directory. Record findings here.

Done when each of the six cases validates correctly or has a filed-and-fixed engine change with a fixture behind it.

### Track B: release automation (landed July 20; runs when Track A is green)

Publish order matters: `@vlint/cli` and `@vlint/mcp` both depend on `@vlint/core`, so core goes first, and their internal dep ranges must move with it.

- [x] `scripts/bump-version.js` moves core/cli/mcp/extension to one version in lockstep and rewrites the internal `@vlint/core` ranges, so cli never ships a dep on a stale core.
- [x] `scripts/release.sh` gates on a clean tagged tree and version consistency, runs all three suites plus the extension bundle (the CI gates), then publishes core → cli → mcp. Dry-run by default; `--live` to publish for real.
- [x] `.github/workflows/release.yml` runs on `v*` tags: verifies the tag matches core's version, reruns the CI gates, and publishes each package with `--provenance`, gated on an `NPM_TOKEN` secret.
- [ ] **You:** add the `NPM_TOKEN` repo secret (npm automation token). Then, once Track A is green, `node scripts/bump-version.js <version>`, commit, `git tag vX.Y.Z && git push --tags` (workflow publishes), or run `scripts/release.sh --live` locally.
- [ ] **You:** `./build.sh && (cd packages/extension && npx vsce publish)` for the Marketplace (separate vsce token, deliberately not in CI).

Done when `npm view @vlint/core` resolves and the extension is on the Marketplace.

### Track C: smaller open threads (after A and B, optional)

- [ ] Resolve `theme.x.y` member expressions to concrete token identities so they get real value comparison instead of present-but-exempt.
- [ ] Decide hosted-bot vs. the paste-in `github-script` templates for PR rendering. The templates are fine for launch; defer unless a consumer asks.
