// Static CSS module resolution: turns a .module.css file into per-class
// UtilityBucket shapes so className={styles.sidebar} validates through the
// same pipeline as Tailwind classes. Small on purpose: single-class
// selectors, flat declarations, and @media (min-width) blocks that match the
// Tailwind breakpoint widths. Anything fancier (composes, nesting, pseudo
// selectors) is skipped rather than guessed at.

import { ResolvedUtilities } from "./tailwind";

const MEDIA_BREAKPOINTS: Record<string, string> = {
  "640": "sm", "768": "md", "1024": "lg", "1280": "xl", "1536": "2xl",
};

function kebabToCamel(prop: string): string {
  return prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

// "color: var(--color-primary)" -> reference name "color-primary"
function varName(value: string): string | null {
  const m = value.match(/^var\(--([\w-]+)\s*(?:,[^)]*)?\)$/);
  return m ? m[1] : null;
}

interface Rule {
  selector: string;
  body: string;
  breakpoint?: string;
}

// Flatten a stylesheet into rules, unwrapping matching min-width media blocks
function collectRules(cssText: string): Rule[] {
  const src = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];

  const walk = (text: string, breakpoint?: string) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf("{", i);
      if (open === -1) break;
      const selector = text.slice(i, open).trim();

      // find the matching close brace
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}") depth--;
        j++;
      }
      const body = text.slice(open + 1, j - 1);

      if (selector.startsWith("@media")) {
        const width = selector.match(/min-width:\s*(\d+)px/);
        const bp = width ? MEDIA_BREAKPOINTS[width[1]] : undefined;
        if (bp) walk(body, bp); // media blocks at unknown widths are skipped
      } else if (!selector.startsWith("@")) {
        rules.push({ selector, body, breakpoint });
      }
      i = j;
    }
  };

  walk(src);
  return rules;
}

/**
 * Class name -> resolved declarations, keyed exactly like the Tailwind
 * resolver's output so validation treats both identically.
 */
export function parseCssModuleClasses(cssText: string): Record<string, ResolvedUtilities> {
  const classes: Record<string, ResolvedUtilities> = {};

  for (const rule of collectRules(cssText)) {
    // Only bare single-class selectors are attributable to one class;
    // combinators, pseudo classes, and element selectors are skipped
    for (const part of rule.selector.split(",")) {
      const m = part.trim().match(/^\.([A-Za-z_][\w-]*)$/);
      if (!m) continue;
      const className = m[1];

      const entry = (classes[className] ??= { values: {}, references: {} });
      let bucket: { values: Record<string, string | number>; references: Record<string, string | null> } = entry;
      if (rule.breakpoint) {
        entry.breakpoints ??= {};
        bucket = (entry.breakpoints[rule.breakpoint] ??= { values: {}, references: {} });
      }

      for (const decl of rule.body.split(";")) {
        const colon = decl.indexOf(":");
        if (colon === -1) continue;
        const rawProp = decl.slice(0, colon).trim();
        const value = decl.slice(colon + 1).trim();
        if (!rawProp || !value || rawProp.startsWith("--")) continue;
        const prop = kebabToCamel(rawProp);

        const ref = varName(value);
        if (ref) {
          bucket.references[prop] = ref;
          delete bucket.values[prop];
        } else if (value.includes("var(") || value.includes("calc(")) {
          bucket.references[prop] = null; // present, not statically comparable
          delete bucket.values[prop];
        } else {
          bucket.values[prop] = value;
          delete bucket.references[prop];
        }
      }
    }
  }

  return classes;
}
