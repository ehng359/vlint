# Releasing vlint

How to publish `@vlint/core`, `@vlint/cli`, and `@vlint/mcp` to npm, and the VS Code
extension to the Marketplace.

The three npm packages ship together at one version. `@vlint/cli` and `@vlint/mcp`
both depend on `@vlint/core`, so core is always published first and their internal
dependency ranges must move with it. The tooling here enforces that; don't hand-edit
versions in the individual `package.json` files.

## Before you release

The engine's responsive and token-level paths are only proven against fixtures. Run
the live validation matrix (Track A in `ROADMAP.md`) against a real Figma file before
you publish a version that anyone will install. Publishing is cheap to do and expensive
to undo, so gate it on that first.

You also need, one time:

- An npm account with publish rights to the `@vlint` scope, and either `npm login`
  locally (for `release.sh --live`) or an `NPM_TOKEN` repo secret (for the tag workflow).
- For the extension: a `vsce` publisher (`EdwardNg`) and its personal access token.

## The version bump

Move every package to the same version and rewrite the internal `@vlint/core` ranges
in one step:

```bash
node scripts/bump-version.js 0.2.0     # explicit version
node scripts/bump-version.js minor     # or major / minor / patch, computed off core
```

It edits `packages/{core,cli,mcp,extension}/package.json`, prints what changed, and
exits non-zero if there was nothing to do. Review the diff, then commit:

```bash
git add packages/*/package.json
git commit -m "Release 0.2.0"
```

## Publishing to npm

There are two paths. Both run the same gates as CI (all three test suites, plus the
extension type-check and bundle) before anything is published, and both publish in
dependency order: core, then cli, then mcp.

### Path A: tag workflow (preferred)

Tag the release commit and push the tag. `.github/workflows/release.yml` verifies the
tag matches core's version, reruns the gates, and publishes each package with npm
provenance.

```bash
git tag v0.2.0
git push origin v0.2.0
```

Requires the `NPM_TOKEN` repo secret (an npm automation token). Watch the run under the
repo's Actions tab. If a version is already on npm the publish step fails, which is the
correct signal that the tag was already released.

### Path B: local publish

Run the release script. It refuses to run on a dirty tree, warns if the version has no
matching `vX.Y.Z` tag, and hard-blocks a `--live` publish without that tag.

```bash
scripts/release.sh            # dry run: full gates + npm publish --dry-run, no writes
scripts/release.sh --live     # the real thing, after npm login
```

Always do the dry run first and read the tarball contents it prints.

## Publishing the extension

The extension is deliberately not part of the npm flow: the Marketplace uses `vsce`
with its own token. After the npm packages are out:

```bash
./build.sh                                   # produces vlint.vsix at the repo root
cd packages/extension && npx vsce publish    # uses the EdwardNg publisher
```

`build.sh` injects the freshly built core into the extension's local `node_modules`
and bundles with esbuild, so run it after the version bump so the packaged extension
carries the new version.

## After a release

- Confirm the packages resolve: `npm view @vlint/core version` (and cli, mcp).
- Confirm the extension version shows on the Marketplace listing.
- If anything failed partway (for example core published but cli did not), fix the
  cause and re-run. npm publishes are immutable per version, so a partial release is
  recovered by publishing the missing packages at the same version, not by republishing
  core.
