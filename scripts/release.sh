#!/usr/bin/env bash
# Publish the vlint packages to npm in dependency order: core, then cli and mcp
# (both depend on it). Dry-run by default so you can watch what npm would send;
# pass --live to actually publish.
#
#   scripts/release.sh                          # dry run, no network writes
#   scripts/release.sh --live                   # real publish
#   scripts/release.sh --live --otp 123456      # with a 2FA one-time password
#   scripts/release.sh --live --otp 123456 --skip-gates  # skip re-running tests
#
# npm requires 2FA to publish. Either pass --otp with a fresh code from your
# authenticator, or publish from CI with a granular/automation token that has
# 2FA bypass enabled (see .github/workflows/release.yml). --skip-gates is for
# the OTP path only: it avoids spending the code's ~30s window on the suites,
# so use it only right after a green run.
#
# The extension is NOT published here: the Marketplace uses vsce with a separate
# token. Build it with ./build.sh and `vsce publish` by hand.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

LIVE=0
OTP=""
SKIP_GATES=0
# Flags in any order: --live to publish, --otp <code> for a 2FA one-time
# password, --skip-gates to publish without re-running the suites (use only
# right after a green run, so a 30-second OTP window is not spent on tests).
while [[ $# -gt 0 ]]; do
  case "$1" in
    --live) LIVE=1; shift ;;
    --otp) OTP="${2:-}"; shift 2 ;;
    --skip-gates) SKIP_GATES=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

PACKAGES=(core cli mcp)

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# 1. Refuse to publish a dirty or untagged tree. A published version must
#    correspond to a commit anyone can check out.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree is dirty. Commit or stash before releasing." >&2
  exit 1
fi

VERSION="$(node -p "require('./packages/core/package.json').version")"
say "Releasing @vlint/* at ${VERSION} (live=${LIVE})"

if ! git rev-parse "v${VERSION}" >/dev/null 2>&1; then
  echo "warning: no git tag v${VERSION} points at this version." >&2
  echo "         Tag it (git tag v${VERSION}) so the release is traceable." >&2
  [[ "$LIVE" == "1" ]] && { echo "refusing to publish --live without the tag." >&2; exit 1; }
fi

# Guard the lockstep invariant the bump script enforces, in case someone edited
# a package.json by hand.
for p in cli mcp; do
  v="$(node -p "require('./packages/$p/package.json').version")"
  [[ "$v" == "$VERSION" ]] || { echo "error: packages/$p is $v, core is $VERSION. Run bump-version.js." >&2; exit 1; }
  dep="$(node -p "require('./packages/$p/package.json').dependencies['@vlint/core']")"
  [[ "$dep" == "^$VERSION" ]] || { echo "error: packages/$p depends on @vlint/core $dep, expected ^$VERSION." >&2; exit 1; }
done

# The lockfile records each workspace's version. If a bump did not refresh it,
# `npm ci` in CI and the release workflow fails. Catch that here, not there.
LOCK_VERSION="$(node -p "require('./package-lock.json').packages['packages/core'].version")"
[[ "$LOCK_VERSION" == "$VERSION" ]] || { echo "error: package-lock.json has core at $LOCK_VERSION, expected $VERSION. Run 'npm install' and commit the lockfile." >&2; exit 1; }

# 2. Same gates as CI. Never publish something that would fail CI.
if [[ "$SKIP_GATES" == "1" ]]; then
  say "Skipping gates (--skip-gates); publishing straight away"
else
  say "Running test suites"
  npm test --workspace=packages/core
  npm test --workspace=packages/cli
  npm test --workspace=packages/mcp

  say "Type-checking and bundling the extension"
  npx tsc -p packages/extension --noEmit
  npm run bundle --workspace=packages/extension
fi

# 3. Publish in dependency order.
FLAGS=()
[[ "$LIVE" == "1" ]] || FLAGS+=(--dry-run)
[[ -n "$OTP" ]] && FLAGS+=(--otp "$OTP")
for p in "${PACKAGES[@]}"; do
  say "npm publish @vlint/$p ${FLAGS[*]:-}"
  # ${FLAGS[@]+"${FLAGS[@]}"} expands to nothing when the array is empty (live
  # mode), instead of injecting a stray empty-string argument.
  npm publish --workspace="packages/$p" ${FLAGS[@]+"${FLAGS[@]}"}
done

if [[ "$LIVE" == "1" ]]; then
  say "Published @vlint/{core,cli,mcp} at ${VERSION}"
  echo "Next: ./build.sh && (cd packages/extension && npx vsce publish) for the Marketplace."
else
  say "Dry run complete. Re-run with --live to publish."
fi
