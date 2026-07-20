#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { parseArgs } = require("util");
const core = require("@vlint/core");

const USAGE = `vlint: validate React sources against a Figma design contract

Usage:
  vlint init <figma-url> [--page <id|name>]   Configure design.manifest from a pasted link
  vlint extract                           Fetch from Figma, write DESIGN_REF.json + CSS
  vlint check <file...> [options]         Lint files against DESIGN_REF.json
  vlint fix <file...> [options]           Rewrite drifted inline styles to match the spec
  vlint spec [Frame] [--tailwind]         Print a frame's spec (no arg lists frames)
  vlint tokens                            Print a Tailwind @theme block from token bindings

Options for check and fix:
  --frame <name>   Validate against this frame instead of the file's @design-frame
  --json           Machine-readable output on stdout
  --strict         check only: warnings also fail the run
  --no-remote      check only: skip the live Figma version probe
  --dry-run        fix only: report what would change without writing

fix only rewrites what is safe to rewrite: inline-style mismatches and
properties missing everywhere. Violations sourced from Tailwind classes or
CSS modules are reported for manual fixing, never shadowed with an inline
override, and breakpoint violations are never fixed inline.

Reads design.manifest and DESIGN_REF.json from the current directory.
Exit codes: 0 clean, 1 violations found, 2 usage or configuration error.`;

function parseCliArgs(argv) {
    // strict: an unknown flag or a --frame with no value is a usage error,
    // not something to silently misread
    const { values, positionals } = parseArgs({
        args: argv,
        options: {
            frame: { type: "string" },
            page: { type: "string" },
            json: { type: "boolean" },
            strict: { type: "boolean" },
            "no-remote": { type: "boolean" },
            "dry-run": { type: "boolean" },
            tailwind: { type: "boolean" },
        },
        strict: true,
        allowPositionals: true,
    });
    return { flags: values, positional: positionals };
}

// Core logs go to stderr so --json output on stdout stays parseable
core.setLogger({
    log: (m) => console.error(m),
    warn: (m) => console.error(m),
    error: (m) => console.error(m),
});

function fail(message, code = 2) {
    console.error(`[vlint] ${message}`);
    process.exit(code);
}

function loadManifest(root) {
    return core.parseManifest(path.join(root, "design.manifest"));
}

async function cmdExtract(root) {
    const manifest = loadManifest(root);
    for (const key of ["FIGMA_PAT", "FIGMA_FKEY", "FIGMA_DEV_PAGE"]) {
        if (!manifest[key]) fail(`Missing ${key} in design.manifest`);
    }

    const page = await core.queryFigmaStyles(
        manifest.FIGMA_DEV_PAGE, manifest.FIGMA_FKEY, manifest.FIGMA_PAT
    );

    const refPath = path.join(root, "DESIGN_REF.json");
    fs.writeFileSync(refPath, JSON.stringify(page, null, 2));
    console.error(`[vlint] Wrote DESIGN_REF.json (version ${page.version})`);

    const stylesDir = path.join(root, manifest.FIGMA_STYLES_DIR || "src/styles/figma");
    fs.mkdirSync(stylesDir, { recursive: true });
    for (const [frame, css] of Object.entries(page.generatedCss || {})) {
        if (!css) continue;
        fs.writeFileSync(path.join(stylesDir, `${frame}.figma.css`), css);
        console.error(`[vlint] Wrote ${path.relative(root, path.join(stylesDir, `${frame}.figma.css`))}`);
    }
}

async function cmdCheck(root, positional, flags) {
    if (positional.length === 0) fail("check needs at least one file.\n\n" + USAGE);

    const designRef = core.loadDesignRef(root);
    if (!designRef) fail("No DESIGN_REF.json in this directory. Run `vlint extract` first.");

    // Kick the drift probe off first so the network round trip overlaps the
    // CPU-bound lint work.
    const manifest = loadManifest(root);
    const probeWanted = !flags["no-remote"] && designRef.version && manifest.FIGMA_FKEY && manifest.FIGMA_PAT;
    const livePromise = probeWanted
        ? core.getFileMeta(manifest.FIGMA_FKEY, manifest.FIGMA_PAT).catch((err) => {
            console.error(`[vlint] Drift probe skipped: ${err.message}`);
            return null;
        })
        : Promise.resolve(null);

    const results = positional.map((file) =>
        core.checkFile(path.resolve(root, file), designRef, flags.frame)
    );

    // Drift direction: has the design moved past the committed snapshot?
    let drift = null;
    const live = await livePromise;
    if (live) {
        drift = {
            stampedVersion: designRef.version,
            liveVersion: live.version,
            designMovedAhead: live.version !== designRef.version,
            liveLastModified: live.lastModified,
        };
    }

    const allViolations = results.flatMap((r) => r.violations);
    const errors = allViolations.filter((v) => v.severity === "error").length;
    const warnings = allViolations.filter((v) => v.severity === "warning").length;
    const configErrors = results.filter((r) => r.error);

    if (flags.json) {
        console.log(JSON.stringify({ results, drift, summary: { errors, warnings } }, null, 2));
    } else {
        for (const result of results) {
            if (result.error) {
                console.log(`${result.file}: ${result.error}`);
                continue;
            }
            if (result.violations.length === 0) {
                console.log(`${result.file}: clean against frame "${result.frame}"`);
                continue;
            }
            console.log(`${result.file} (frame "${result.frame}"):`);
            for (const v of result.violations) {
                const where = v.loc ? `:${v.loc.line}` : "";
                const tag = v.severity === "error" ? "error" : "warn ";
                console.log(`  ${tag}${where}  ${core.violationMessage(v)}`);
            }
        }
        if (drift?.designMovedAhead) {
            console.log(`\nDesign moved ahead of the snapshot (Figma version ${drift.liveVersion}, snapshot ${drift.stampedVersion}). Run \`vlint extract\`.`);
        }
        console.log(`\n${errors} error(s), ${warnings} warning(s)`);
    }

    if (configErrors.length > 0) process.exit(2);
    if (errors > 0 || (flags.strict && warnings > 0)) process.exit(1);
}

function cmdFix(root, positional, flags) {
    if (positional.length === 0) fail("fix needs at least one file.\n\n" + USAGE);

    const designRef = core.loadDesignRef(root);
    if (!designRef) fail("No DESIGN_REF.json in this directory. Run `vlint extract` first.");

    const results = [];
    let manualErrors = 0;
    const fixableKey = (v) => `${v.component}|${v.property}|${v.breakpoint ?? ""}|${v.kind}`;
    const fixableKeys = (r) => new Set(
        r.violations.filter(v => v.kind === "mismatch" || v.kind === "missing").map(fixableKey)
    );

    for (const file of positional) {
        const filePath = path.resolve(root, file);
        const original = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : null;
        const before = original === null
            ? { file: filePath, frame: null, violations: [], error: "File not found" }
            : core.checkSource(filePath, original, designRef, flags.frame);
        if (before.error) {
            results.push({ file: filePath, frame: before.frame, error: before.error, applied: [], manual: [] });
            continue;
        }

        // Pass 1: Tailwind-native fixes. Class-sourced and breakpoint drift
        // is corrected in the className; elements without a static className
        // are skipped by applyClassFixes and fall through to pass 2.
        const classFixes = before.violations.map(core.violationToClassFix).filter(Boolean);
        const afterClassSource = core.applyClassFixes(original, classFixes);
        const afterClass = afterClassSource === original
            ? before
            : core.checkSource(filePath, afterClassSource, designRef, flags.frame);

        // Pass 2: inline-style fixes for what remains safely fixable.
        const styleFixes = afterClass.violations.map(core.violationToStyleFix).filter(Boolean);
        const finalSource = core.applyStyleFixes(afterClassSource, styleFixes);
        const after = finalSource === afterClassSource
            ? afterClass
            : core.checkSource(filePath, finalSource, designRef, flags.frame);

        let written = false;
        if (finalSource !== original && !flags["dry-run"]) {
            fs.writeFileSync(filePath, finalSource);
            written = true;
        }

        // Attribute each resolved violation to the pass that fixed it: gone
        // after the class pass means "class", surviving it means "style"
        const keys1 = fixableKeys(afterClass);
        const keys2 = fixableKeys(after);
        const applied = before.violations
            .filter(v => (v.kind === "mismatch" || v.kind === "missing") && !keys2.has(fixableKey(v)))
            .map(v => ({
                componentName: v.component,
                propName: v.property,
                figmaValue: v.expected,
                via: keys1.has(fixableKey(v)) ? "style" : "class",
                ...(v.breakpoint ? { breakpoint: v.breakpoint } : {}),
            }));

        const manual = after.violations.filter(v => v.severity === "error");
        manualErrors += manual.length;
        results.push({
            file: filePath,
            frame: before.frame,
            applied,
            manual,
            written,
            dryRun: !!flags["dry-run"],
        });
    }

    if (flags.json) {
        console.log(JSON.stringify({ results }, null, 2));
    } else {
        for (const r of results) {
            if (r.error) { console.log(`${r.file}: ${r.error}`); continue; }
            const action = r.dryRun ? "would fix" : (r.written ? "fixed" : "nothing to fix,");
            console.log(`${r.file}: ${action} ${r.applied.length} propert${r.applied.length === 1 ? "y" : "ies"}`);
            for (const f of r.applied) {
                const where = f.breakpoint ? ` at ${f.breakpoint}` : "";
                console.log(`  ${r.dryRun ? "would set" : "set"}  ${f.componentName}.${f.propName} = ${JSON.stringify(f.figmaValue)} (via ${f.via}${where})`);
            }
            for (const v of r.manual) {
                console.log(`  manual     ${core.violationMessage(v)} (source: ${v.source ?? "class"})`);
            }
        }
    }

    if (results.some(r => r.error)) process.exit(2);
    if (manualErrors > 0) process.exit(1);
}

function cmdSpec(root, positional, flags) {
    const designRef = core.loadDesignRef(root);
    if (!designRef) fail("No DESIGN_REF.json in this directory. Run `vlint extract` first.");

    const frameName = positional[0];
    if (!frameName) {
        console.log(JSON.stringify(core.listFrames(designRef), null, 2));
        return;
    }

    try {
        const spec = core.getFrameSpec(designRef, frameName);
        if (flags.tailwind) {
            // The contract rendered as suggested class strings, for agents
            // generating in the project's styling idiom
            const children = {};
            for (const [name, child] of Object.entries(spec.children || {})) {
                children[name] = core.specToClassName(child);
            }
            console.log(JSON.stringify({ frame: core.specToClassName(spec), children }, null, 2));
        } else {
            console.log(JSON.stringify(spec, null, 2));
        }
    } catch (err) {
        fail(err.message);
    }
}

function cmdTokens(root) {
    const designRef = core.loadDesignRef(root);
    if (!designRef) fail("No DESIGN_REF.json in this directory. Run `vlint extract` first.");

    const theme = core.designRefToTheme(designRef);
    if (!theme) {
        console.error("[vlint] No named token bindings in DESIGN_REF.json (Variables API may be unreadable on this plan).");
        return;
    }
    console.log(theme.trimEnd());
}

// `vlint init <figma-url>`: derive the file key (and page, if the link carries
// a node id) from a pasted Figma link and write design.manifest, so onboarding
// needs no hand-typed keys. The PAT is never written to the manifest: it comes
// from the FIGMA_PAT env var (CI) or the extension's secret storage.
function cmdInit(root, positional, flags) {
    const url = positional[0];
    if (!url) fail("Usage: vlint init <figma-url> [--page <id|name>]");

    const ref = core.parseFigmaUrl(url);
    if (!ref) fail(`Not a Figma file link or key: "${url}"`);

    const manifestPath = path.join(root, "design.manifest");
    const existing = core.parseManifest(manifestPath);
    const next = { ...existing, FIGMA_FKEY: ref.fileKey };

    const page = flags.page || ref.nodeId;
    if (page) next.FIGMA_DEV_PAGE = page;

    const lines = ["# vlint design contract. FIGMA_PAT is intentionally absent:",
        "# provide it via the FIGMA_PAT env var or the editor's secret storage.", ""];
    for (const [k, v] of Object.entries(next)) {
        if (k === "FIGMA_PAT") continue; // never persist the token to the manifest
        lines.push(`${k}=${v}`);
    }
    fs.writeFileSync(manifestPath, lines.join("\n") + "\n");

    console.error(`[vlint] Wrote design.manifest: FIGMA_FKEY=${ref.fileKey}` +
        (next.FIGMA_DEV_PAGE ? `, FIGMA_DEV_PAGE=${next.FIGMA_DEV_PAGE}` : ""));
    if (!next.FIGMA_DEV_PAGE) {
        console.error("[vlint] No page in the link. Add one with --page <id|name> or paste a link with a frame selected.");
    }
    console.error("[vlint] Set FIGMA_PAT in your environment, then run `vlint extract`.");
}

async function main() {
    let flags, positional;
    try {
        ({ flags, positional } = parseCliArgs(process.argv.slice(2)));
    } catch (err) {
        fail(`${err.message}\n\n${USAGE}`);
    }
    const command = positional.shift();
    const root = process.cwd();

    switch (command) {
        case "init": cmdInit(root, positional, flags); break;
        case "extract": await cmdExtract(root); break;
        case "check": await cmdCheck(root, positional, flags); break;
        case "fix": cmdFix(root, positional, flags); break;
        case "spec": cmdSpec(root, positional, flags); break;
        case "tokens": cmdTokens(root); break;
        case "help": case undefined: console.log(USAGE); break;
        default: fail(`Unknown command "${command}".\n\n` + USAGE);
    }
}

main().catch((err) => fail(err.message));
