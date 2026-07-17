// Static Tailwind class resolution for the properties vlint validates.
//
// Built against Tailwind v4 semantics (spacing = n * 0.25rem, the renamed
// radius scale, CSS-variable theme tokens) with v3 fallbacks where they are
// unambiguous. Deliberately not a full Tailwind implementation: anything this
// resolver cannot pin to a concrete value becomes a "reference", which marks
// the property as present but exempt from value comparison. False silence is
// acceptable; false errors are not.

const REM = 16; // Figma specs are px; assume the default root font size

// Mobile-first responsive order, from the v4 default --breakpoint-* scale
export const BREAKPOINTS = ["sm", "md", "lg", "xl", "2xl"] as const;
const BREAKPOINT_SET = new Set<string>(BREAKPOINTS);

export interface UtilityBucket {
  // Concrete declarations, comparable against the spec
  values: Record<string, string | number>;
  // prop -> referenced theme token in CSS custom property form
  // ("color-primary"), or null when present but statically unresolvable
  references: Record<string, string | null>;
}

export interface ResolvedUtilities extends UtilityBucket {
  // md:w-40 etc., keyed by breakpoint; only present when such classes exist
  breakpoints?: Partial<Record<string, UtilityBucket>>;
}

/**
 * The declarations in effect at one breakpoint under the mobile-first
 * cascade: base utilities, then each smaller-or-equal breakpoint in order.
 */
export function effectiveAtBreakpoint(resolved: ResolvedUtilities, breakpoint: string): UtilityBucket {
  const values = { ...resolved.values };
  const references = { ...resolved.references };
  for (const bp of BREAKPOINTS) {
    const bucket = resolved.breakpoints?.[bp];
    if (bucket) {
      for (const [prop, value] of Object.entries(bucket.values)) {
        values[prop] = value;
        delete references[prop];
      }
      for (const [prop, token] of Object.entries(bucket.references)) {
        references[prop] = token;
        delete values[prop];
      }
    }
    if (bp === breakpoint) break;
  }
  return { values, references };
}

const px = (n: number) => `${Math.round(n * 100) / 100}px`;
const spacingPx = (n: number) => px(n * 0.25 * REM);

const RADIUS: Record<string, string> = {
  xs: px(0.125 * REM), sm: px(0.25 * REM), md: px(0.375 * REM),
  lg: px(0.5 * REM), xl: px(0.75 * REM), "2xl": px(1 * REM),
  "3xl": px(1.5 * REM), "4xl": px(2 * REM), full: "9999px", none: "0px",
};

// [fontSize, lineHeight] in px, from the v4 default --text-* variables
const TEXT_SIZES: Record<string, [string, string]> = {
  xs: [px(12), px(16)], sm: [px(14), px(20)], base: [px(16), px(24)],
  lg: [px(18), px(28)], xl: [px(20), px(28)], "2xl": [px(24), px(32)],
  "3xl": [px(30), px(36)], "4xl": [px(36), px(40)], "5xl": [px(48), px(48)],
  "6xl": [px(60), px(60)], "7xl": [px(72), px(72)], "8xl": [px(96), px(96)],
  "9xl": [px(128), px(128)],
};

const FONT_WEIGHTS: Record<string, number> = {
  thin: 100, extralight: 200, light: 300, normal: 400, medium: 500,
  semibold: 600, bold: 700, extrabold: 800, black: 900,
};

const TRACKING: Record<string, string> = {
  tighter: "-0.05em", tight: "-0.025em", normal: "0em",
  wide: "0.025em", wider: "0.05em", widest: "0.1em",
};

// text-*/bg-* suffixes that are not colors and must not claim the color prop
const NON_COLOR_TEXT = new Set(["wrap", "nowrap", "balance", "pretty", "ellipsis", "clip"]);
const NON_COLOR_BG = new Set([
  "none", "cover", "contain", "auto", "fixed", "local", "scroll",
  "center", "top", "bottom", "left", "right", "repeat", "no-repeat",
]);

const ALIGN_ITEMS: Record<string, string> = {
  start: "flex-start", end: "flex-end", center: "center",
  baseline: "baseline", stretch: "stretch",
};

const JUSTIFY: Record<string, string> = {
  start: "flex-start", end: "flex-end", center: "center",
  between: "space-between", around: "space-around", evenly: "space-evenly",
};

// "55" -> 220px, "0.5" -> 2px, "px" -> 1px, "[220px]" -> 220px, others null
function resolveLength(suffix: string): string | null {
  if (suffix === "px") return "1px";
  const arbitrary = suffix.match(/^\[(-?[\d.]+(?:px|rem|em))\]$/);
  if (arbitrary) {
    const raw = arbitrary[1];
    if (raw.endsWith("rem")) return px(parseFloat(raw) * REM);
    if (raw.endsWith("em")) return raw; // em depends on font size, keep as-is
    return raw;
  }
  if (/^\d+(\.\d+)?$/.test(suffix)) return spacingPx(parseFloat(suffix));
  return null;
}

// bg-[#1A1A38] / bg-[rgb(...)] -> concrete color; null otherwise
function resolveArbitraryColor(suffix: string): string | null {
  const m = suffix.match(/^\[(#[0-9a-fA-F]{3,8}|rgba?\([^\]]+\)|hsla?\([^\]]+\))\]$/);
  return m ? m[1].replace(/_/g, " ") : null;
}

// bg-(--color-primary) / bg-[var(--color-primary)] -> "color-primary"
function resolveVarReference(suffix: string): string | null {
  const m = suffix.match(/^\(--([\w-]+)\)$/) || suffix.match(/^\[var\(--([\w-]+)\)\]$/);
  return m ? m[1] : null;
}

interface Sides { top?: string; right?: string; bottom?: string; left?: string; }

function paddingUtility(prefix: string, value: string, sides: Sides): boolean {
  switch (prefix) {
    case "p": sides.top = sides.right = sides.bottom = sides.left = value; return true;
    case "px": sides.left = sides.right = value; return true;
    case "py": sides.top = sides.bottom = value; return true;
    case "pt": sides.top = value; return true;
    case "pr": sides.right = value; return true;
    case "pb": sides.bottom = value; return true;
    case "pl": sides.left = value; return true;
  }
  return false;
}

// "color/primary" (Figma) -> "color-primary" (CSS custom property name)
export function tokenToCssVarName(tokenName: string): string {
  return tokenName.toLowerCase().replace(/[\s/]+/g, "-");
}

// ── inverse mapping: spec value -> canonical utility ─────────────────────────

const STATIC_UTILITIES: Record<string, Record<string, string>> = {
  display: { flex: "flex", "inline-flex": "inline-flex" },
  flexDirection: { row: "flex-row", "row-reverse": "flex-row-reverse", column: "flex-col", "column-reverse": "flex-col-reverse" },
  alignItems: { "flex-start": "items-start", "flex-end": "items-end", center: "items-center", baseline: "items-baseline", stretch: "items-stretch" },
  justifyContent: { "flex-start": "justify-start", "flex-end": "justify-end", center: "justify-center", "space-between": "justify-between", "space-around": "justify-around", "space-evenly": "justify-evenly" },
  alignSelf: { stretch: "self-stretch", center: "self-center" },
  flex: { "1": "flex-1" },
  textAlign: { left: "text-left", center: "text-center", right: "text-right", justify: "text-justify" },
};

const LENGTH_PREFIXES: Record<string, string> = {
  width: "w", height: "h", gap: "gap", borderRadius: "rounded",
  minWidth: "min-w", maxWidth: "max-w", lineHeight: "leading",
};

const invert = (table: Record<string, string | number>) =>
  Object.fromEntries(Object.entries(table).map(([k, v]) => [String(v), k]));
const RADIUS_NAMES = invert(RADIUS);
const WEIGHT_NAMES = invert(FONT_WEIGHTS);
const TRACKING_NAMES = invert(TRACKING);

// "220px" -> "w-55" when on the 4px scale, "w-[221px]" otherwise
function lengthUtility(prefix: string, pxValue: string): string {
  const n = parseFloat(pxValue);
  if (Number.isFinite(n) && n % 4 === 0 && n >= 0) return `${prefix}-${n / 4}`;
  return `${prefix}-[${pxValue}]`;
}

/**
 * The canonical Tailwind utility for one spec property. When the property is
 * bound to a design token, color props emit the token utility (`bg-primary`)
 * so the fix removes the drift permanently instead of freezing today's value.
 * Returns null for properties with no reasonable single-utility form.
 */
export function figmaValueToUtility(prop: string, value: string | number, token?: string): string | null {
  const str = String(value);

  if (STATIC_UTILITIES[prop]?.[str]) return STATIC_UTILITIES[prop][str];

  if (prop === "backgroundColor" || prop === "color") {
    const prefix = prop === "backgroundColor" ? "bg" : "text";
    if (token) {
      const varName = token.toLowerCase().replace(/[\s/]+/g, "-");
      return varName.startsWith("color-")
        ? `${prefix}-${varName.slice(6)}`
        : `${prefix}-(--${varName})`;
    }
    return `${prefix}-[${str}]`;
  }

  if (prop === "borderRadius") {
    return RADIUS_NAMES[str] ? `rounded-${RADIUS_NAMES[str]}` : `rounded-[${str}]`;
  }
  if (prop === "fontWeight") {
    return WEIGHT_NAMES[str] ? `font-${WEIGHT_NAMES[str]}` : `font-[${str}]`;
  }
  if (prop === "letterSpacing") {
    return TRACKING_NAMES[str] ? `tracking-${TRACKING_NAMES[str]}` : `tracking-[${str}]`;
  }
  if (prop === "fontSize") {
    for (const [name, [size]] of Object.entries(TEXT_SIZES)) {
      if (size === str) return `text-${name}`;
    }
    return `text-[${str}]`;
  }
  if (prop === "padding") {
    const parts = str.split(/\s+/);
    if (parts.length === 2) {
      return `${lengthUtility("py", parts[0])} ${lengthUtility("px", parts[1])}`;
    }
    if (parts.length === 4) {
      return [
        lengthUtility("pt", parts[0]), lengthUtility("pr", parts[1]),
        lengthUtility("pb", parts[2]), lengthUtility("pl", parts[3]),
      ].join(" ");
    }
    return null;
  }
  if (LENGTH_PREFIXES[prop] && /px$/.test(str)) {
    return lengthUtility(LENGTH_PREFIXES[prop], str);
  }

  return null;
}

/**
 * The suggested className for one spec node: every mappable property as its
 * canonical utility, token-bound colors as token utilities. Agents call this
 * (via `vlint spec --tailwind`) to generate from the contract in the
 * project's styling idiom instead of translating px values by hand.
 */
export function specToClassName(spec: Record<string, any>): string {
  const tokens: Record<string, string> = spec.tokens ?? {};
  const parts: string[] = [];

  // A named text size utility implies its line height; only emit leading-*
  // when the pair doesn't match
  const fontSizeUtility = typeof spec.fontSize === "string"
    ? figmaValueToUtility("fontSize", spec.fontSize, tokens.fontSize)
    : null;
  const namedSize = fontSizeUtility && !fontSizeUtility.includes("[")
    ? fontSizeUtility.slice("text-".length) : null;
  const lineHeightImplied = !!(namedSize && TEXT_SIZES[namedSize]
    && TEXT_SIZES[namedSize][1] === spec.lineHeight);

  for (const [prop, value] of Object.entries(spec)) {
    if (typeof value !== "string" && typeof value !== "number") continue;
    if (prop === "id" || prop === "name" || prop === "type") continue;
    if (prop === "lineHeight" && lineHeightImplied) continue;
    const utility = prop === "fontSize" ? fontSizeUtility : figmaValueToUtility(prop, value, tokens[prop]);
    if (utility) parts.push(utility);
  }
  return parts.join(" ");
}

/**
 * A Tailwind v4 @theme block from a DESIGN_REF's token bindings, so the
 * Figma variables and the project theme provably share names. Values come
 * from the spec properties the tokens are bound to; raw VariableID bindings
 * (Variables API unreadable) are skipped since they have no usable name.
 */
export function designRefToTheme(designRef: any): string {
  const entries: Record<string, string | number> = {};

  const collect = (node: any) => {
    if (!node?.tokens) return;
    for (const [prop, tokenName] of Object.entries(node.tokens as Record<string, string>)) {
      if (tokenName.startsWith("VariableID:")) continue;
      const varName = tokenToCssVarName(tokenName);
      const value = node[prop];
      if ((typeof value === "string" || typeof value === "number") && !(varName in entries)) {
        entries[varName] = value;
      }
    }
  };

  for (const frame of Object.values(designRef?.nodes ?? {}) as any[]) {
    collect(frame);
    for (const child of Object.values(frame?.children ?? {})) collect(child);
  }

  const names = Object.keys(entries).sort();
  if (names.length === 0) return "";
  return [
    "@theme {",
    ...names.map((n) => `  --${n}: ${entries[n]};`),
    "}",
  ].join("\n") + "\n";
}

interface Sink extends UtilityBucket {
  padding: Sides;
}

const newSink = (): Sink => ({ values: {}, references: {}, padding: {} });

export function resolveTailwindClasses(className: string): ResolvedUtilities {
  const base = newSink();
  const breakpointSinks: Record<string, Sink> = {};
  let target = base;

  const setValue = (prop: string, value: string | number) => {
    target.values[prop] = value;
    delete target.references[prop]; // last conflicting utility wins
  };
  const setReference = (prop: string, token: string | null) => {
    target.references[prop] = token;
    delete target.values[prop];
  };

  for (let cls of className.trim().split(/\s+/)) {
    if (!cls) continue;

    // Responsive variants get their own bucket; state variants (hover:,
    // dark:, ...) target other states and stay out of scope.
    target = base;
    const colon = cls.indexOf(":");
    if (colon > 0) {
      const variant = cls.slice(0, colon);
      const rest = cls.slice(colon + 1);
      if (!BREAKPOINT_SET.has(variant) || rest.includes(":")) continue;
      target = breakpointSinks[variant] ??= newSink();
      cls = rest;
    }
    cls = cls.replace(/^!/, "").replace(/!$/, ""); // v3 and v4 important markers

    // ── static utilities ─────────────────────────────────────────────────
    if (cls === "flex") { setValue("display", "flex"); continue; }
    if (cls === "inline-flex") { setValue("display", "inline-flex"); continue; }
    if (cls === "flex-row") { setValue("flexDirection", "row"); continue; }
    if (cls === "flex-row-reverse") { setValue("flexDirection", "row-reverse"); continue; }
    if (cls === "flex-col") { setValue("flexDirection", "column"); continue; }
    if (cls === "flex-col-reverse") { setValue("flexDirection", "column-reverse"); continue; }
    if (cls === "flex-1") { setValue("flex", "1"); continue; }
    if (cls === "rounded") { setValue("borderRadius", RADIUS.sm); continue; } // v3 compat
    if (cls === "border") { setReference("border", null); continue; }

    const items = cls.match(/^items-(\w+)$/);
    if (items && ALIGN_ITEMS[items[1]]) { setValue("alignItems", ALIGN_ITEMS[items[1]]); continue; }

    const justify = cls.match(/^justify-(\w+)$/);
    if (justify && JUSTIFY[justify[1]]) { setValue("justifyContent", JUSTIFY[justify[1]]); continue; }

    const self = cls.match(/^self-(\w+)$/);
    if (self && ALIGN_ITEMS[self[1]]) { setValue("alignSelf", ALIGN_ITEMS[self[1]]); continue; }

    // ── prefixed utilities ───────────────────────────────────────────────
    const dash = cls.indexOf("-");
    if (dash <= 0) continue;
    const prefix = cls.slice(0, dash);
    const suffix = cls.slice(dash + 1);

    switch (prefix) {
      case "w": case "h": {
        const prop = prefix === "w" ? "width" : "height";
        const length = resolveLength(suffix);
        if (length) setValue(prop, length);
        else setReference(prop, resolveVarReference(suffix)); // w-full, w-auto, ...
        continue;
      }
      case "gap": {
        const length = resolveLength(suffix);
        if (length) setValue("gap", length);
        continue; // gap-x-*/gap-y-* have no spec counterpart
      }
      case "min": case "max": {
        const dim = suffix.match(/^([wh])-(.+)$/);
        if (dim) {
          const prop = prefix + (dim[1] === "w" ? "Width" : "Height");
          const length = resolveLength(dim[2]);
          if (length) setValue(prop, length);
          else setReference(prop, null); // min-w-full etc.
        }
        continue;
      }
      case "p": case "px": case "py": case "pt": case "pr": case "pb": case "pl":
        break; // handled below, prefix split differs
      case "rounded": {
        if (RADIUS[suffix]) { setValue("borderRadius", RADIUS[suffix]); continue; }
        const length = resolveLength(suffix);
        if (length) { setValue("borderRadius", length); continue; }
        continue; // per-corner rounded-tl-* etc. have no spec counterpart
      }
      case "bg": {
        const color = resolveArbitraryColor(suffix);
        if (color) { setValue("backgroundColor", color); continue; }
        if (NON_COLOR_BG.has(suffix) || suffix.startsWith("gradient") || suffix.startsWith("clip") || suffix.startsWith("origin")) continue;
        const varRef = resolveVarReference(suffix);
        // bg-primary references --color-primary; palette shades resolve the
        // same way and simply never match a Figma token name
        setReference("backgroundColor", varRef ?? `color-${suffix}`);
        continue;
      }
      case "text": {
        if (TEXT_SIZES[suffix]) {
          setValue("fontSize", TEXT_SIZES[suffix][0]);
          setValue("lineHeight", TEXT_SIZES[suffix][1]);
          continue;
        }
        const length = resolveLength(suffix);
        if (length) { setValue("fontSize", length); continue; }
        const color = resolveArbitraryColor(suffix);
        if (color) { setValue("color", color); continue; }
        const varRef = resolveVarReference(suffix);
        if (suffix === "left" || suffix === "center" || suffix === "right" || suffix === "justify") {
          setValue("textAlign", suffix);
          continue;
        }
        if (NON_COLOR_TEXT.has(suffix)) continue;
        setReference("color", varRef ?? `color-${suffix}`);
        continue;
      }
      case "font": {
        if (FONT_WEIGHTS[suffix] !== undefined) { setValue("fontWeight", FONT_WEIGHTS[suffix]); continue; }
        const arbitraryWeight = suffix.match(/^\[(\d{3})\]$/);
        if (arbitraryWeight) { setValue("fontWeight", parseInt(arbitraryWeight[1])); continue; }
        setReference("fontFamily", resolveVarReference(suffix)); // font-sans, font-display
        continue;
      }
      case "leading": {
        const length = resolveLength(suffix);
        if (length) setValue("lineHeight", length);
        else setReference("lineHeight", null); // leading-tight etc. are unitless
        continue;
      }
      case "tracking": {
        if (TRACKING[suffix]) { setValue("letterSpacing", TRACKING[suffix]); continue; }
        const arbitrary = suffix.match(/^\[(-?[\d.]+em)\]$/);
        if (arbitrary) setValue("letterSpacing", arbitrary[1]);
        continue;
      }
      case "opacity": {
        if (/^\d+$/.test(suffix)) setValue("opacity", String(parseInt(suffix) / 100));
        continue;
      }
      case "border": {
        // Widths and colors compose into one shorthand statically; too many
        // combinations to reconstruct, so border is present-but-exempt
        setReference("border", null);
        continue;
      }
    }

    // padding needs the un-split class because px/py collide with the loop's
    // single-dash split (p-4 vs px-4 have different prefixes already handled)
    const pad = cls.match(/^(p[xytrbl]?)-(.+)$/);
    if (pad) {
      const length = resolveLength(pad[2]);
      if (length) paddingUtility(pad[1], length, target.padding);
      else setReference("padding", null);
      continue;
    }
    // every other class (component classes, unknown utilities) is ignored
  }

  // Serialize padding with the same rule extraction uses, so values compare
  const finalizePadding = (sink: Sink) => {
    const sides = [sink.padding.top, sink.padding.right, sink.padding.bottom, sink.padding.left];
    const defined = sides.filter(s => s !== undefined).length;
    if (defined === 4) {
      const [t, r, b, l] = sides as string[];
      sink.values.padding = t === b && l === r ? `${t} ${r}` : `${t} ${r} ${b} ${l}`;
      delete sink.references.padding;
    } else if (defined > 0 && !("padding" in sink.references)) {
      sink.references.padding = null; // partial padding: present, not comparable
    }
  };
  finalizePadding(base);
  Object.values(breakpointSinks).forEach(finalizePadding);

  const result: ResolvedUtilities = { values: base.values, references: base.references };
  if (Object.keys(breakpointSinks).length > 0) {
    result.breakpoints = {};
    for (const [bp, sink] of Object.entries(breakpointSinks)) {
      result.breakpoints[bp] = { values: sink.values, references: sink.references };
    }
  }
  return result;
}
