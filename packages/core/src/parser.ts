import generate from "@babel/generator";
import { parse, ParserOptions } from "@babel/parser";
import traverse, { NodePath } from "@babel/traverse";
import * as t from "@babel/types";

import {
  isNumericLiteral, isStringLiteral,
  JSXAttribute,
  JSXExpressionContainer,
  JSXOpeningElement,
  ObjectExpression,
  SourceLocation
} from "@babel/types";

export interface StyleProp {
  propName: string;
  actualValue: string | number | boolean;
  loc: SourceLocation;
}

const PARSE_OPTIONS: ParserOptions = {
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

function getDesignAnnotation(path: NodePath<JSXOpeningElement>): string | null {
  // Case 1: line comment attached to the JSXElement as leadingComments
  const leading = path.parent.leadingComments ?? [];
  for (const c of leading) {
    const match = c.value.match(ANNOTATION_RE);
    if (match) return match[1];
  }

  // Case 2: JSX comment as a sibling in the parent's children array
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
        const match = c.value.match(ANNOTATION_RE);
        if (match) return match[1];
      }
      return null; // comment exists but isn't an annotation, bail
    }

    break; // hit something else — bail
  }

  return null;
}

export function extractStyleProps(path: NodePath<JSXOpeningElement>): StyleProp[] {
  const results: StyleProp[] = [];

  for (const attr of path.node.attributes) {
    if (attr.type !== "JSXAttribute") continue;
    if (attr.name?.type !== "JSXIdentifier") continue;
    if (attr.name.name !== "style") continue;

    const container = attr.value as JSXExpressionContainer;
    const obj = container.expression as ObjectExpression;

    if (obj.type !== "ObjectExpression") continue;

    for (const prop of obj.properties) {
      if (prop.type !== "ObjectProperty") continue; // skip SpreadElement
      if (prop.computed) continue;                  // skip [dynamic] keys

      let key = prop.key.type === "Identifier" ? prop.key.name : ""
      if (!isStringLiteral(prop.value) && !isNumericLiteral(prop.value)) continue;

      results.push({ propName: key, actualValue: prop.value.value, loc: prop.loc! })
    }
  }

  return results;
}

export interface StyleFix {
  componentName: string;
  propName: string;
  figmaValue: string | number;
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
        const container = styleAttr.value as JSXExpressionContainer;
        const obj = container.expression as ObjectExpression;
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

  // retainLines minimises diff noise; original source passed for comment preservation
  return generate(ast, { concise: false }, sourceCode).code;
}