import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import { SPEC_METADATA_KEYS } from "./extraction";
import { getLogger } from "./logger";
import { parseCssModuleClasses } from "./cssmodules";
import {
  ClassFix, extractClassName, extractCssModuleImports, extractModuleClassRef,
  extractStyleProps, getDesignAnnotation, getDesignOverrides, PARSE_OPTIONS, StyleFix
} from "./parser";
import {
  BREAKPOINTS, effectiveAtBreakpoint, figmaValueToUtility,
  ResolvedUtilities, resolveTailwindClasses, UtilityBucket
} from "./tailwind";

export type ViolationKind =
  | "mismatch"        // property exists in both, values differ
  | "missing"         // property in the Figma spec, absent from the code
  | "hardcoded-token" // value matches today but the spec binds a design token
  | "unknown-component"; // annotation has no counterpart in the frame

export interface Violation {
  component: string;
  property: string;
  expected: string | number | null;
  actual: string | number | boolean | null;
  kind: ViolationKind;
  severity: "error" | "warning";
  token?: string;
  loc?: { line: number; column: number } | null;
  // Set when the violation is against a breakpoint frame (Frame@md)
  breakpoint?: string;
  // Where the offending declaration lives: an inline style prop or a
  // className (Tailwind or CSS module). Absent for missing/unknown kinds.
  source?: "style" | "class";
}

export function violationMessage(v: Violation): string {
  const base = baseViolationMessage(v);
  return v.breakpoint ? `${base} at breakpoint ${v.breakpoint}` : base;
}

function baseViolationMessage(v: Violation): string {
  switch (v.kind) {
    case "mismatch":
      return `${v.component}.${v.property} is ${JSON.stringify(v.actual)}, Figma says ${JSON.stringify(v.expected)}`;
    case "missing":
      return `${v.component}.${v.property} missing in code, Figma says ${JSON.stringify(v.expected)}`;
    case "hardcoded-token":
      return `${v.component}.${v.property} matches today but hardcodes token "${v.token}", will drift silently`;
    case "unknown-component":
      return `"${v.component}" is referenced in code but has no counterpart in the Figma frame`;
  }
}

// The single rule for which violations applyStyleFixes can safely correct.
// applyStyleFixes writes inline style props, so:
//  - a mismatch is only fixable when the wrong value IS an inline style;
//    "fixing" a class-sourced mismatch would add an inline override that
//    shadows the class and makes the code worse
//  - a missing property (absent from style, classes, and modules alike) is
//    safe to add inline
//  - breakpoint violations are never fixable inline, because inline styles
//    apply at every viewport width
export function violationToStyleFix(v: Violation): StyleFix | null {
  if (v.breakpoint || v.expected === null) return null;
  if (v.kind === "missing" || (v.kind === "mismatch" && v.source === "style")) {
    return { componentName: v.component, propName: v.property, figmaValue: v.expected };
  }
  return null;
}

// The Tailwind counterpart: class-sourced mismatches and missing props are
// fixed by editing the className, which also makes breakpoint violations
// fixable (md:w-40). Token-bound colors emit the token utility (bg-primary)
// so the fix removes the drift permanently. Inline-style mismatches stay
// with violationToStyleFix.
export function violationToClassFix(v: Violation): ClassFix | null {
  if (v.expected === null) return null;
  if (v.kind !== "mismatch" && v.kind !== "missing") return null;
  if (v.kind === "mismatch" && v.source === "style" && !v.breakpoint) return null;
  const utility = figmaValueToUtility(v.property, v.expected, v.token);
  if (!utility) return null;
  return { componentName: v.component, propName: v.property, utility, breakpoint: v.breakpoint };
}

// Ensures equivalent values in different formats compare as equal.
// e.g. "16px" === 16, "#FFF" === "#ffffff", "Bold" === 700
export function normaliseValue(value: string | number): string {
  const str = String(value).trim();

  if (/^-?\d+(\.\d+)?px$/.test(str)) {
    return parseFloat(str).toString();
  }

  const fontWeightMap: Record<string, string> = {
    thin: "100", extralight: "200", light: "300", regular: "400",
    normal: "400", medium: "500", semibold: "600", bold: "700",
    extrabold: "800", black: "900"
  };
  if (fontWeightMap[str.toLowerCase()]) {
    return fontWeightMap[str.toLowerCase()];
  }

  const hex6 = str.match(/^#([0-9a-f]{6})$/i);
  if (hex6) return "#" + hex6[1].toLowerCase();

  const hex3 = str.match(/^#([0-9a-f]{3})$/i);
  if (hex3) {
    const [r, g, b] = hex3[1].toLowerCase().split("");
    return "#" + r + r + g + g + b + b;
  }

  const rgba = str.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/);
  if (rgba) {
    const a = rgba[4] !== undefined ? parseFloat(rgba[4]) : 1;
    if (a === 1) {
      return "#" + [rgba[1], rgba[2], rgba[3]]
        .map(n => parseInt(n).toString(16).padStart(2, "0"))
        .join("");
    }
    return `rgba(${rgba[1]}, ${rgba[2]}, ${rgba[3]}, ${a})`;
  }

  return str.toLowerCase();
}

// "color/primary" (Figma) -> "color-primary" (CSS custom property name)
export function tokenToCssVarName(tokenName: string): string {
  return tokenName.toLowerCase().replace(/[\s/]+/g, "-");
}

function isTokenReference(value: string | number | boolean): boolean {
  return typeof value === "string" && /^var\(--[\w-]+/.test(value);
}

function tokenReferenceMatches(value: string, tokenName: string): boolean {
  const m = value.match(/^var\(--([\w-]+)/);
  return !!m && m[1] === tokenToCssVarName(tokenName);
}

// A spec node as lintSource consumes it: CSS-valued props plus optional
// per-prop token bindings under `tokens`.
export interface SpecNode {
  [key: string]: unknown;
  tokens?: Record<string, string>;
}

export interface FrameSpec extends SpecNode {
  children?: Record<string, SpecNode>;
}

/**
 * Statically validates a source file's annotated inline styles against a
 * DESIGN_REF frame. Pure function: no filesystem, no network.
 *
 * When `frames` (the full DESIGN_REF nodes map) is given, breakpoint frames
 * named `${frameName}@md` etc. are validated against the mobile-first
 * cascade of the element's responsive Tailwind classes.
 *
 * `cssModules` maps import specifiers ("./X.module.css") to file contents so
 * className={styles.x} resolves; hosts do the file reading, this stays pure.
 */
export function lintSource(
  sourceCode: string,
  frameName: string,
  frame: FrameSpec,
  frames?: Record<string, FrameSpec>,
  cssModules?: Record<string, string>
): Violation[] {
  let ast;
  try {
    ast = parse(sourceCode, PARSE_OPTIONS);
  } catch (err) {
    getLogger().warn(`[vlint] Parse error, skipping lint: ${(err as Error).message}`);
    return [];
  }

  // binding ("styles") -> parsed classes of the module it imports
  const moduleClasses = new Map<string, Record<string, ResolvedUtilities>>();
  if (cssModules) {
    for (const imp of extractCssModuleImports(sourceCode)) {
      const cssText = cssModules[imp.source];
      if (cssText !== undefined) {
        moduleClasses.set(imp.binding, parseCssModuleClasses(cssText));
      }
    }
  }

  const violations: Violation[] = [];
  const seenComponents = new Set<string>();

  traverse(ast, {
    JSXOpeningElement(path) {
      const componentName = getDesignAnnotation(path);
      if (!componentName) return;
      seenComponents.add(componentName);
      const overrides = getDesignOverrides(path);

      // Child-first: a child sharing the frame's name must not be shadowed
      // by the frame's own spec
      const spec: SpecNode | undefined =
        frame.children?.[componentName] ??
        (componentName === frameName ? frame : undefined);

      const elementLoc = path.node.loc
        ? { line: path.node.loc.start.line, column: path.node.loc.start.column }
        : null;

      if (!spec) {
        violations.push({
          component: componentName,
          property: "",
          expected: null,
          actual: null,
          kind: "unknown-component",
          severity: "warning",
          loc: elementLoc,
        });
        return;
      }

      // Effective declarations per property: Tailwind classes first, then
      // inline style props on top (inline style beats stylesheet in CSS,
      // media queries included). `refToken` carries a class's theme-token
      // name ("color-primary"); `reference` alone means present but
      // statically unresolvable.
      interface EffectiveProp {
        value?: string | number | boolean;
        reference: boolean;
        refToken?: string | null;
        loc: { line: number; column: number } | null;
        origin: "style" | "class";
      }

      // className resolves from either source into the same shape: a static
      // string goes through the Tailwind resolver, styles.x through the
      // parsed CSS module
      let classResolved: ResolvedUtilities | null = null;
      let classLoc = elementLoc;

      const classAttr = extractClassName(path);
      if (classAttr) {
        classResolved = resolveTailwindClasses(classAttr.value);
        if (classAttr.loc) classLoc = { line: classAttr.loc.start.line, column: classAttr.loc.start.column };
      } else {
        const moduleRef = extractModuleClassRef(path);
        if (moduleRef) {
          classResolved = moduleClasses.get(moduleRef.binding)?.[moduleRef.className] ?? null;
          if (moduleRef.loc) classLoc = { line: moduleRef.loc.start.line, column: moduleRef.loc.start.column };
        }
      }
      const inlineProps = extractStyleProps(path);

      const buildEffective = (bucket: UtilityBucket | null): Map<string, EffectiveProp> => {
        const effective = new Map<string, EffectiveProp>();
        if (bucket) {
          for (const [prop, value] of Object.entries(bucket.values)) {
            effective.set(prop, { value, reference: false, loc: classLoc, origin: "class" });
          }
          for (const [prop, refToken] of Object.entries(bucket.references)) {
            effective.set(prop, { reference: true, refToken, loc: classLoc, origin: "class" });
          }
        }
        for (const p of inlineProps) {
          effective.set(p.propName, {
            value: p.actualValue,
            reference: p.reference ?? false,
            loc: p.loc ? { line: p.loc.start.line, column: p.loc.start.column } : elementLoc,
            origin: "style",
          });
        }
        return effective;
      };

      const compare = (
        targetSpec: SpecNode,
        effective: Map<string, EffectiveProp>,
        breakpoint?: string
      ) => {
        // Breakpoint passes report drift only: repeating missing-property and
        // token warnings once per breakpoint frame would be noise.
        const mismatchOnly = breakpoint !== undefined;
        const tokens = targetSpec.tokens ?? {};

        for (const [prop, expected] of Object.entries(targetSpec)) {
          if (SPEC_METADATA_KEYS.has(prop)) continue;
          if (overrides.has(prop)) continue; // declared intentional divergence
          if (typeof expected !== "string" && typeof expected !== "number") continue;

          const token = tokens[prop];
          const found = effective.get(prop);

          if (!found) {
            if (mismatchOnly) continue;
            // Warning, not error: the generated .figma.css usually supplies it.
            violations.push({
              component: componentName,
              property: prop,
              expected,
              actual: null,
              kind: "missing",
              severity: "warning",
              token,
              loc: elementLoc,
              breakpoint,
            });
            continue;
          }

          const actual = found.value ?? null;
          const propLoc = found.loc ?? elementLoc;

          // References (theme.x.y, bg-primary, w-full) can't be resolved
          // statically: present, exempt from value comparison. Flagging a
          // class that names a different token would false-positive on
          // palette shades (color-slate-900), so references are never
          // mismatches.
          if (found.reference) continue;

          if (actual !== null && isTokenReference(actual)) {
            // var(--x) can't be resolved statically; only flag it when the
            // spec binds a token and the reference names a different one.
            if (token && !tokenReferenceMatches(actual as string, token)) {
              violations.push({
                component: componentName,
                property: prop,
                expected: `var(--${tokenToCssVarName(token)})`,
                actual,
                kind: "mismatch",
                severity: "error",
                token,
                loc: propLoc,
                breakpoint,
                source: found.origin,
              });
            }
            continue;
          }

          if (normaliseValue(actual as string | number) === normaliseValue(expected)) {
            if (token && !mismatchOnly) {
              violations.push({
                component: componentName,
                property: prop,
                expected,
                actual,
                kind: "hardcoded-token",
                severity: "warning",
                token,
                loc: propLoc,
                breakpoint,
                source: found.origin,
              });
            }
            continue;
          }

          violations.push({
            component: componentName,
            property: prop,
            expected,
            actual,
            kind: "mismatch",
            severity: "error",
            token,
            loc: propLoc,
            breakpoint,
            source: found.origin,
          });
        }
      };

      compare(spec, buildEffective(classResolved));

      // Responsive passes: a Figma frame named "Dashboard@md" is the spec at
      // the md breakpoint; the code side is the mobile-first cascade of the
      // element's classes up to that breakpoint.
      if (frames) {
        for (const bp of BREAKPOINTS) {
          const bpFrame = frames[`${frameName}@${bp}`];
          if (!bpFrame) continue;
          const bpSpec: SpecNode | undefined =
            bpFrame.children?.[componentName] ??
            (componentName === frameName ? bpFrame : undefined);
          if (!bpSpec) continue;

          const bucket = classResolved ? effectiveAtBreakpoint(classResolved, bp) : null;
          compare(bpSpec, buildEffective(bucket), bp);
        }
      }
    },
  });

  // data-figma attributes are the CSS targeting hooks; a name with no spec
  // counterpart silently loses its generated styles, so flag it even when the
  // element carries no @design-component annotation.
  const attrRe = /data-figma="([^"]+)"/g;
  let match;
  while ((match = attrRe.exec(sourceCode)) !== null) {
    const name = match[1];
    if (seenComponents.has(name)) continue;
    seenComponents.add(name);
    if (frame.children?.[name] || name === frameName) continue;

    const before = sourceCode.slice(0, match.index);
    const line = before.split("\n").length;
    const column = match.index - (before.lastIndexOf("\n") + 1);
    violations.push({
      component: name,
      property: "",
      expected: null,
      actual: null,
      kind: "unknown-component",
      severity: "warning",
      loc: { line, column },
    });
  }

  return violations;
}
