import generate from "@babel/generator";
import { parse, ParserOptions } from "@babel/parser";
import traverse, { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { resolveTailwindClasses } from "./tailwind";

import {
  isNumericLiteral, isStringLiteral,
  JSXAttribute,
  JSXOpeningElement,
  SourceLocation
} from "@babel/types";

export interface StyleProp {
  propName: string;
  actualValue: string | number | boolean;
  loc: SourceLocation;
  // true when the value is an identifier/member-expression reference
  // (theme.colors.primary) rather than a static literal
  reference?: boolean;
}

export const PARSE_OPTIONS: ParserOptions = {
  sourceType: "module",
  plugins: ["jsx", "typescript"],
};

const ANNOTATION_RE = /@design-component\s+(\S+)/;

export function extractDataFigmaNames(sourceCode: string): [string, string[]] {
  const frameMatch = sourceCode.match(/@design-frame\s+(\S+)/);
  const frame = frameMatch ? frameMatch[1] : "";

  const names: string[] = [];
  const re = /data-figma="([^"]+)"/g;
  let match;
  while ((match = re.exec(sourceCode)) !== null) {
    names.push(match[1]);
  }

  return [frame, names];
}

export function getDesignAnnotation(path: NodePath<JSXOpeningElement>): string | null {
  const match = matchAnnotationComment(path, ANNOTATION_RE);
  return match ? match[1] : null;
}

const OVERRIDE_RE = /@design-override\s+([^\n*]+)/;

// Properties this element intentionally diverges on, declared with
// `@design-override width borderRadius` next to the component annotation.
// Overridden props are exempt from validation: divergence stays visible in
// the code instead of silently accumulating as suppressed violations.
export function getDesignOverrides(path: NodePath<JSXOpeningElement>): Set<string> {
  const match = matchAnnotationComment(path, OVERRIDE_RE);
  if (!match) return new Set();
  return new Set(match[1].trim().split(/[\s,]+/).filter(Boolean));
}

function matchAnnotationComment(
  path: NodePath<JSXOpeningElement>,
  re: RegExp
): RegExpMatchArray | null {
  // Case 1: line comment attached to the JSXElement as leadingComments
  const leading = path.parent.leadingComments ?? [];
  for (const c of leading) {
    const match = c.value.match(re);
    if (match) return match;
  }

  // Case 2: for the outermost JSX element, Babel attaches the comment to the
  // enclosing statement (`// @design-component X` above `const X = () => <div/>`).
  // Only applies when every node between the element and the statement is a
  // plain wrapper; a fragment, ternary, or logical expression means multiple
  // elements could claim the statement's comment, so none of them do.
  const STATEMENT_WRAPPERS = new Set([
    "ReturnStatement", "ArrowFunctionExpression", "FunctionDeclaration",
    "FunctionExpression", "VariableDeclarator", "VariableDeclaration",
    "ExportNamedDeclaration", "ExportDefaultDeclaration",
    "ParenthesizedExpression", "ExpressionStatement",
    "TSAsExpression", "TSSatisfiesExpression",
  ]);
  const stmt = path.getStatementParent();
  if (stmt) {
    let cursor = path.parentPath?.parentPath ?? null;
    let unambiguous = true;
    while (cursor && cursor.node !== stmt.node) {
      if (!STATEMENT_WRAPPERS.has(cursor.node.type)) {
        unambiguous = false;
        break;
      }
      cursor = cursor.parentPath;
    }
    if (unambiguous) {
      // `export const X = ...` attaches the comment to the export wrapper
      const stmtComments = stmt.node.leadingComments
        ?? (stmt.parentPath?.isExportDeclaration() ? stmt.parentPath.node.leadingComments : null)
        ?? [];
      for (const c of stmtComments) {
        const match = c.value.match(re);
        if (match) return match;
      }
    }
  }

  // Case 3: JSX comment as a sibling in the parent's children array
  const parentNode = path.parentPath?.parent;
  if (!parentNode || parentNode.type !== "JSXElement") return null;

  const siblings = parentNode.children;
  const idx = siblings.indexOf(path.parent as any);

  for (let i = idx - 1; i >= 0; i--) {
    const sibling = siblings[i];

    if (sibling.type === "JSXText" && sibling.value.trim() === "") continue;

    if (sibling.type === "JSXExpressionContainer" &&
      sibling.expression.type === "JSXEmptyExpression") {
      const comments = sibling.expression.innerComments ?? [];
      for (const c of comments) {
        const match = c.value.match(re);
        if (match) return match;
      }
      continue; // stacked JSX comments: keep scanning upward
    }

    break; // hit something else — bail
  }

  return null;
}

// "theme.colors.primary" from a non-computed member chain, null otherwise
function memberPath(node: t.Node): string | null {
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") {
    const objectPath = memberPath(node.object);
    return objectPath ? `${objectPath}.${node.property.name}` : null;
  }
  return null;
}

export function extractStyleProps(path: NodePath<JSXOpeningElement>): StyleProp[] {
  const results: StyleProp[] = [];

  for (const attr of path.node.attributes) {
    if (attr.type !== "JSXAttribute") continue;
    if (attr.name?.type !== "JSXIdentifier") continue;
    if (attr.name.name !== "style") continue;

    // style="..." or style={styles.card}: nothing static to extract
    if (attr.value?.type !== "JSXExpressionContainer") continue;
    const obj = attr.value.expression;
    if (obj.type !== "ObjectExpression") continue;

    for (const prop of obj.properties) {
      if (prop.type !== "ObjectProperty") continue; // skip SpreadElement
      if (prop.computed) continue;                  // skip [dynamic] keys

      let key = prop.key.type === "Identifier" ? prop.key.name : ""

      if (isStringLiteral(prop.value) || isNumericLiteral(prop.value)) {
        results.push({ propName: key, actualValue: prop.value.value, loc: prop.loc! });
        continue;
      }

      // theme.colors.primary and friends: a reference, not a comparable value
      const refPath = memberPath(prop.value);
      if (refPath) {
        results.push({ propName: key, actualValue: refPath, loc: prop.loc!, reference: true });
      }
    }
  }

  return results;
}

export interface ClassNameAttr {
  value: string;
  loc: SourceLocation | null;
}

export interface CssModuleImport {
  // local binding of the default import, e.g. "styles"
  binding: string;
  // import specifier as written, e.g. "./Sidebar.module.css"
  source: string;
}

// import styles from './X.module.css' bindings in a source file. Hosts use
// this to know which CSS files to load for lintSource's cssModules map.
export function extractCssModuleImports(sourceCode: string): CssModuleImport[] {
  const imports: CssModuleImport[] = [];
  const re = /import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+\.module\.css)['"]/g;
  let match;
  while ((match = re.exec(sourceCode)) !== null) {
    imports.push({ binding: match[1], source: match[2] });
  }
  return imports;
}

export interface ModuleClassRef {
  // "styles" in className={styles.sidebar}
  binding: string;
  // "sidebar"
  className: string;
  loc: SourceLocation | null;
}

// className={styles.sidebar} -> the binding and class it references
export function extractModuleClassRef(path: NodePath<JSXOpeningElement>): ModuleClassRef | null {
  for (const attr of path.node.attributes) {
    if (attr.type !== "JSXAttribute") continue;
    if (attr.name?.type !== "JSXIdentifier" || attr.name.name !== "className") continue;
    if (attr.value?.type !== "JSXExpressionContainer") return null;

    const expr = attr.value.expression;
    if (
      expr.type === "MemberExpression" &&
      !expr.computed &&
      expr.object.type === "Identifier" &&
      expr.property.type === "Identifier"
    ) {
      return { binding: expr.object.name, className: expr.property.name, loc: attr.loc ?? null };
    }
    return null;
  }
  return null;
}

// Static className strings only; clsx()/cva()/template expressions have
// nothing statically resolvable
export function extractClassName(path: NodePath<JSXOpeningElement>): ClassNameAttr | null {
  for (const attr of path.node.attributes) {
    if (attr.type !== "JSXAttribute") continue;
    if (attr.name?.type !== "JSXIdentifier" || attr.name.name !== "className") continue;

    if (attr.value?.type === "StringLiteral") {
      return { value: attr.value.value, loc: attr.loc ?? null };
    }
    if (attr.value?.type === "JSXExpressionContainer" && attr.value.expression.type === "StringLiteral") {
      return { value: attr.value.expression.value, loc: attr.loc ?? null };
    }
    return null;
  }
  return null;
}

export interface StyleFix {
  componentName: string;
  propName: string;
  figmaValue: string | number;
}

export interface ClassFix {
  componentName: string;
  propName: string;
  // may be multi-part, e.g. "py-5 px-6" for a padding shorthand
  utility: string;
  breakpoint?: string;
}

function classTouchesProp(cls: string, propName: string): boolean {
  const resolved = resolveTailwindClasses(cls);
  return resolved.values[propName] !== undefined || resolved.references[propName] !== undefined;
}

/**
 * Rewrites the className string on annotated elements: utilities targeting
 * the fixed property are removed (at the fix's breakpoint only) and the
 * canonical utility appended. Elements without a static className are left
 * untouched, so callers can fall back to inline-style fixes for those.
 */
export function applyClassFixes(sourceCode: string, fixes: ClassFix[]): string {
  if (fixes.length === 0) return sourceCode;
  let ast;
  try {
    ast = parse(sourceCode, PARSE_OPTIONS);
  } catch {
    return sourceCode;
  }

  const byComponent = new Map<string, ClassFix[]>();
  for (const fix of fixes) {
    (byComponent.get(fix.componentName) ?? byComponent.set(fix.componentName, []).get(fix.componentName)!).push(fix);
  }

  let changed = false;
  traverse(ast, {
    JSXOpeningElement(path) {
      const componentName = getDesignAnnotation(path);
      if (!componentName) return;
      const componentFixes = byComponent.get(componentName);
      if (!componentFixes) return;

      for (const attr of path.node.attributes) {
        if (attr.type !== "JSXAttribute") continue;
        if (attr.name?.type !== "JSXIdentifier" || attr.name.name !== "className") continue;

        let literal: t.StringLiteral | null = null;
        if (attr.value?.type === "StringLiteral") literal = attr.value;
        else if (attr.value?.type === "JSXExpressionContainer" && attr.value.expression.type === "StringLiteral") {
          literal = attr.value.expression;
        }
        if (!literal) return; // dynamic className: not editable statically

        let classes = literal.value.trim().split(/\s+/).filter(Boolean);
        for (const fix of componentFixes) {
          classes = classes.filter((cls) => {
            if (fix.breakpoint) {
              if (!cls.startsWith(fix.breakpoint + ":")) return true;
              return !classTouchesProp(cls.slice(fix.breakpoint.length + 1), fix.propName);
            }
            if (cls.includes(":")) return true; // base fix leaves variants alone
            return !classTouchesProp(cls, fix.propName);
          });
          for (const part of fix.utility.split(/\s+/)) {
            classes.push(fix.breakpoint ? `${fix.breakpoint}:${part}` : part);
          }
        }
        literal.value = classes.join(" ");
        changed = true;
        return;
      }
    },
  });

  if (!changed) return sourceCode;
  return generate(ast, { retainLines: true, concise: false }, sourceCode).code;
}

/**
 * Takes source code and a list of fixes, returns corrected source.
 * Preserves formatting as much as possible via retainLines.
 */
export function applyStyleFixes(sourceCode: string, fixes: StyleFix[]): string {
  let ast;
  try {
    ast = parse(sourceCode, PARSE_OPTIONS);
  } catch (err) {
    console.warn("[vlint] Parse error during fix:", (err as Error).message);
    return sourceCode;
  }

  // Build a nested lookup: componentName -> propName -> figmaValue
  const fixMap = new Map<string, Map<string, string | number>>();
  for (const fix of fixes) {
    if (!fixMap.has(fix.componentName)) {
      fixMap.set(fix.componentName, new Map());
    }
    fixMap.get(fix.componentName)!.set(fix.propName, fix.figmaValue);
  }

  traverse(ast, {
    JSXOpeningElement(path) {
      const componentName = getDesignAnnotation(path);
      if (!componentName) return;

      const propFixes = fixMap.get(componentName);
      if (!propFixes) return;

      const styleAttr = path.node.attributes.find(
        attr =>
          attr.type === "JSXAttribute" &&
          attr.name?.type === "JSXIdentifier" &&
          attr.name.name === "style"
      ) as JSXAttribute | undefined;

      if (styleAttr) {
        if (styleAttr.value?.type !== "JSXExpressionContainer") return;
        const obj = styleAttr.value.expression;
        if (obj.type !== "ObjectExpression") return;

        const applied = new Set<string>();

        // Update existing properties
        for (const prop of obj.properties) {
          if (prop.type !== "ObjectProperty" || prop.computed) continue;
          const key = prop.key.type === "Identifier" ? prop.key.name : "";
          if (!propFixes.has(key)) continue;

          const correctValue = propFixes.get(key)!;
          prop.value = typeof correctValue === "number"
            ? t.numericLiteral(correctValue)
            : t.stringLiteral(String(correctValue));
          applied.add(key);
        }

        // Insert properties absent from the style object (handles style={{}})
        propFixes.forEach((correctValue, propName) => {
          if (applied.has(propName)) return;
          obj.properties.push(
            t.objectProperty(
              t.identifier(propName),
              typeof correctValue === "number"
                ? t.numericLiteral(correctValue)
                : t.stringLiteral(String(correctValue))
            )
          );
        });
      } else {
        // No style prop at all — build one from scratch and attach it
        const properties: t.ObjectProperty[] = [];

        propFixes.forEach((correctValue, propName) => {
          properties.push(
            t.objectProperty(
              t.identifier(propName),
              typeof correctValue === "number"
                ? t.numericLiteral(correctValue)
                : t.stringLiteral(String(correctValue))
            )
          );
        });

        path.node.attributes.push(
          t.jsxAttribute(
            t.jsxIdentifier("style"),
            t.jsxExpressionContainer(t.objectExpression(properties))
          )
        );
      }
    },
  });

  // retainLines keeps the fix diff minimal; original source passed so
  // comments survive regeneration
  return generate(ast, { retainLines: true, concise: false }, sourceCode).code;
}