#!/usr/bin/env node
// Move every publishable package to the same version and keep the internal
// @vlint/core dependency ranges in lockstep. A drifted internal range is the
// classic monorepo publish bug: cli@0.2.0 shipping a dep on core@^0.1.0 pulls
// the old engine for anyone who installs it.
//
//   node scripts/bump-version.js 0.2.0
//   node scripts/bump-version.js patch   # or minor / major
//
// Prints the resulting versions and exits non-zero if nothing changed.

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// Order is publish order: core first, everything else depends on it.
const PACKAGES = ["core", "cli", "mcp", "extension"].map((name) => ({
  name,
  file: path.join(ROOT, "packages", name, "package.json"),
}));

function bumpSemver(current, kind) {
  const [major, minor, patch] = current.split(".").map(Number);
  if ([major, minor, patch].some(Number.isNaN)) {
    throw new Error(`cannot ${kind}-bump non-semver version "${current}"`);
  }
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function resolveTarget(arg, currentCoreVersion) {
  if (["major", "minor", "patch"].includes(arg)) {
    return bumpSemver(currentCoreVersion, arg);
  }
  if (!/^\d+\.\d+\.\d+/.test(arg)) {
    throw new Error(`"${arg}" is not a semver version or a bump keyword (major|minor|patch)`);
  }
  return arg;
}

function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: node scripts/bump-version.js <version|major|minor|patch>");
    process.exit(2);
  }

  const manifests = PACKAGES.map((pkg) => ({
    ...pkg,
    json: JSON.parse(fs.readFileSync(pkg.file, "utf8")),
  }));

  const core = manifests.find((m) => m.name === "core");
  const target = resolveTarget(arg, core.json.version);

  let changed = false;
  for (const m of manifests) {
    if (m.json.version !== target) {
      console.log(`${m.json.name}: ${m.json.version} -> ${target}`);
      m.json.version = target;
      changed = true;
    }
    // Pin internal core deps to the version we are shipping, not a stale range.
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      const deps = m.json[field];
      if (deps && deps["@vlint/core"]) {
        const next = `^${target}`;
        if (deps["@vlint/core"] !== next) {
          console.log(`${m.json.name}: ${field}.@vlint/core -> ${next}`);
          deps["@vlint/core"] = next;
          changed = true;
        }
      }
    }
  }

  if (!changed) {
    console.error(`nothing to do: everything is already at ${target}`);
    process.exit(1);
  }

  for (const m of manifests) {
    fs.writeFileSync(m.file, JSON.stringify(m.json, null, 2) + "\n");
  }
  console.log(`\n✓ all packages at ${target}. Review, commit, then tag v${target}.`);
}

main();
