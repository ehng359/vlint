import * as fs from "fs";
import * as path from "path";
import { extractCssModuleImports, extractDataFigmaNames } from "./parser";
import { FrameSpec, lintSource, Violation } from "./validate";

// One file checked against one frame. This shape is shared verbatim by the
// CLI's --json output and the MCP server's tool responses.
export interface CheckResult {
  file: string;
  frame: string | null;
  violations: Violation[];
  error?: string;
}

export function loadDesignRef(workspaceRoot: string): any | null {
  const refPath = path.join(workspaceRoot, "DESIGN_REF.json");
  if (!fs.existsSync(refPath)) return null;
  return JSON.parse(fs.readFileSync(refPath, "utf-8"));
}

// The one payload both `vlint spec` (no arg) and the MCP list_frames tool emit.
export function listFrames(designRef: any): { frames: string[]; version: string | null; extractedAt: string | null } {
  return {
    frames: Object.keys(designRef?.nodes ?? {}),
    version: designRef?.version ?? null,
    extractedAt: designRef?.extractedAt ?? null,
  };
}

export function getFrameSpec(designRef: any, frame: string): FrameSpec {
  const spec = designRef?.nodes?.[frame];
  if (!spec) {
    const known = Object.keys(designRef?.nodes ?? {}).join(", ") || "none";
    throw new Error(`Frame "${frame}" not found in DESIGN_REF.json (known frames: ${known})`);
  }
  return spec as FrameSpec;
}

// Reads the .module.css files a source file imports (relative specifiers
// only), keyed by specifier as written, for lintSource's cssModules param.
export function loadCssModules(filePath: string, sourceCode: string): Record<string, string> {
  const cssModules: Record<string, string> = {};
  for (const imp of extractCssModuleImports(sourceCode)) {
    if (!imp.source.startsWith(".")) continue;
    const cssPath = path.resolve(path.dirname(filePath), imp.source);
    if (fs.existsSync(cssPath)) {
      cssModules[imp.source] = fs.readFileSync(cssPath, "utf-8");
    }
  }
  return cssModules;
}

export function checkFile(
  filePath: string,
  designRef: any,
  frameOverride?: string
): CheckResult {
  if (!fs.existsSync(filePath)) {
    return { file: filePath, frame: null, violations: [], error: "File not found" };
  }
  return checkSource(filePath, fs.readFileSync(filePath, "utf-8"), designRef, frameOverride);
}

// checkFile minus the file read, for callers holding modified source in
// memory (vlint fix re-lints between its class and style passes)
export function checkSource(
  filePath: string,
  source: string,
  designRef: any,
  frameOverride?: string
): CheckResult {
  const [declaredFrame] = extractDataFigmaNames(source);
  const frame = frameOverride || declaredFrame || null;

  if (!frame) {
    return {
      file: filePath, frame: null, violations: [],
      error: "No @design-frame declaration in file and no frame override given",
    };
  }

  let spec: FrameSpec;
  try {
    spec = getFrameSpec(designRef, frame);
  } catch (err) {
    return { file: filePath, frame, violations: [], error: (err as Error).message };
  }

  return {
    file: filePath,
    frame,
    violations: lintSource(source, frame, spec, designRef?.nodes, loadCssModules(filePath, source)),
  };
}
