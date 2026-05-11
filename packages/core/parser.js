const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;

const PARSE_OPTIONS = {
  sourceType: "module",
  plugins: ["jsx", "typescript"],
};

/**
 * Main entry point.
 * @param {string} sourceCode
 * @returns {Finding[]}
 */
function extractFindings(sourceCode) {
  let ast;

  try {
    ast = parser.parse(sourceCode, PARSE_OPTIONS);
  } catch (err) {
    console.warn("[vlint] Parse error:", err.message);
    return [];
  }

  const findings = [];

  traverse(ast, {
    JSXOpeningElement(path) {
      // TODO: Check if this node has a @design-component comment above it.
      // If not, return early.
      const componentName = getDesignAnnotation(path);
      if (!componentName) return;

      // TODO: Pull style props off this JSX node.
      const styleProps = extractStyleProps(path);

      // TODO: Push each prop into findings with its location.
      for (const sp of styleProps) {
        findings.push({ componentName, ...sp });
      }
    },
  });

  return findings;
}

/**
 * Look for a `// @design-component <Name>` comment near this node.
 * @returns {string|null} component name, or null if not annotated
 */
function getDesignAnnotation(jsxOpeningPath) {
  // TODO: Check leadingComments on the parent node for the annotation pattern.
  // Hint: /@design-component\s+(\S+)/
  return null;
}

/**
 * Extract static style props from a JSX node.
 * Handles: style={{ padding: 8 }}
 * @returns {{ propName, actualValue, loc }[]}
 */
function extractStyleProps(jsxOpeningPath) {
  const results = [];

  for (const attr of jsxOpeningPath.node.attributes) {
    if (attr.type !== "JSXAttribute") continue;

    if (attr.name?.name === "style") {
      // TODO: Unwrap the JSXExpressionContainer → ObjectExpression.
      // Then iterate over its properties and collect key/value pairs.
      // Skip anything computed or non-static.
    }
  }

  return results;
}

module.exports = { extractFindings };