import { parse, ParserOptions } from "@babel/parser";
import traverse, { NodePath } from "@babel/traverse";
import {
  isNumericLiteral, isStringLiteral, JSXExpressionContainer,
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

export function extractStyles(sourceCode: string): [string, Record<string, StyleProp[]>] {
  let ast;

  try {
    ast = parse(sourceCode, PARSE_OPTIONS);
  } catch (err: unknown) {
    console.warn("[vlint] Parse error:", (err as Error).message);
    return ["", {}];
  }

  // Define a state object to collect data during traversal
  const state = {
    frame: "",
    findings: {} as Record<string, StyleProp[]>
  };

  const frameMatch = sourceCode.match(/@design-frame\s+(\S+)/);

  if (frameMatch) {
    state.frame = frameMatch[1];
  }

  traverse(ast, {
    JSXOpeningElement(path, state) {
      const componentName = getDesignAnnotation(path);
      if (!componentName) return;

      const styleProps = extractStyleProps(path);

      if (styleProps.length > 0) {
        state.findings[componentName] = [
          ...(state.findings[componentName] || []),
          ...styleProps
        ];
      }
    },
  }, undefined, state); // Pass state as the 4th argument

  return [state.frame, state.findings];
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

function extractStyleProps(path: NodePath<JSXOpeningElement>): StyleProp[] {
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

export default extractStyles;