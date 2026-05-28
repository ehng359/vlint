const fs = require("fs")
const FIGMA_API_URL = "https://api.figma.com/v1";
let lastKnownChange = null;

// non-CSS Figma internals
const FIGMA_METADATA_KEYS = new Set([
    // Identity — never CSS
    'id', 'name', 'type',
    // Raw Figma data objects — never CSS
    'resolvedDesignTokens', 'variables',
    'visuals', 'textDetails', 'visualDimensions',
    // Tree references — never CSS
    'children', 'childrenElements',
    // Figma layout enums — transformed to CSS equivalents, raw values must never leak
    'layoutMode', 'layoutAlign', 'layoutGrow',
    'primaryAxisSizingMode', 'counterAxisSizingMode',
    'itemSpacing', 'minWidth', 'maxWidth',
]);
// CSS property default values — skip these to keep generated files clean.
// A property matching its browser default adds no value to the stylesheet.
const CSS_DEFAULTS = {
    display: 'block',
    flexDirection: 'row',
    alignItems: 'stretch',
    justifyContent: 'flex-start',
    gap: '0px',
    padding: '0px 0px',
    borderRadius: '0px',
    opacity: '1',
    overflow: 'visible',
    textAlign: 'left',
    fontStyle: 'normal',
    textDecoration: 'none',
    textTransform: 'none',
    letterSpacing: '0em',
    marginBottom: '0px',
    textIndent: '0px',
};

// All CSS properties that are typography-specific.
// These are written to typography.figma.css only, not to layout CSS.
const TYPOGRAPHY_PROPS = new Set([
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle',
    'lineHeight', 'letterSpacing', 'textAlign', 'textTransform',
    'textDecoration', 'textIndent', 'color',
    'marginBottom', 'hangingPunctuation'
]);

function camelToKebab(str) {
    return str.replace(/([A-Z])/g, '-$1').toLowerCase();
}

// Retrieves the Node IDs based on the targeted Figma file.
async function getTargetNodeIds(targetPageName, fileKey, accessToken) { // Added parameter for flexibility
  const requestInit = {
    method: "GET",
    headers: {
      'X-Figma-Token': accessToken,
      'Content-Type': 'application/json'
    },
  };

  try {
    // depth=2 is perfect here: it gives us the Page (depth 1) and the Frames (depth 2)
    const response = await fetch(`${FIGMA_API_URL}/files/${fileKey}?depth=2`, requestInit);

    if (!response.ok) {
      throw new Error(`API Error: ${response.status} ${response.statusText}`);
    }

    const fileData = await response.json();
    const frameIdentifiers = [];

    if (fileData.document && fileData.document.children) {
      // 1. Find the specific page first
      const targetPage = fileData.document.children.find(
        page => page.type === "CANVAS" && page.name === targetPageName
      );

      // 2. Only if the page exists, iterate through its top-level frames
      if (targetPage && targetPage.children) {
        targetPage.children.forEach(child => {
          if (child.type === "FRAME") {
            frameIdentifiers.push({
              id: child.id,
              name: child.name,
              pageName: targetPage.name
            });
          }
        });
      } else {
        console.warn(`Page named "${targetPageName}" not found in file.`);
      }
    }

    if (frameIdentifiers.length > 0) {
      console.log(`Found ${frameIdentifiers.length} Top-Level Frames on page: "${targetPageName}"`);
      console.table(frameIdentifiers);

      const idListForNextQuery = frameIdentifiers.map(f => f.id).join(",");
      console.log(`\nTargeted ID string for page "${targetPageName}":\n?ids=${idListForNextQuery}`);
      return idListForNextQuery;
    }

    return null;
  } catch (error) {
    console.error("Failed to map base nodes:", error);
  }
}

// Extract the Figma nodes based on the available identifiers in the file.
async function extractFigmaNodes(nodeQuery, fileKey, accessToken) {
  const requestInit = {
    method: "GET",
    headers: {
      'X-Figma-Token': accessToken,
      'Content-Type': 'application/json'
    },
  };

  // Construct URL with explicit comma-separated node ID filters
  const targetUrl = `${FIGMA_API_URL}/files/${fileKey}/nodes?ids=${nodeQuery}`;

  try {
    console.log(`Querying targeted nodes: ${nodeQuery}...`);
    let response = await fetch(targetUrl, requestInit);

    if (!response.ok) {
      throw new Error(`Figma API returned ${response.status}: ${response.statusText}`);
    }

    const apiData = await response.json();
    const finalStructuredData = parseTargetedNodes(apiData);

    // Save out the isolated design source of truth
    return finalStructuredData
  } catch (error) {
    console.error("Extraction workflow failed:", error);
  }
}

function parseTargetedNodes(apiData) {
  const output = {
    extractedAt: new Date().toISOString(),
    nodes: {}
  };

  // Global catalog files returned specifically for the requested nodes
  const globalComponents = apiData.components || {};
  const globalComponentSets = apiData.componentSets || {};
  const globalStyles = apiData.styles || {};

  // Loop through each isolated root node requested in the query parameter
  Object.keys(apiData.nodes).forEach(nodeId => {
    const rootNodeData = apiData.nodes[nodeId];
    const documentRoot = rootNodeData.document;

    output.nodes[documentRoot.name || nodeId] = {
      id: documentRoot.id,
      type: documentRoot.type,
      ...extractLayoutProperties(documentRoot),
      childrenElements: []
    };

    // Begin deep recursive extraction on children nodes
    function recurse(node) {
      const elementNode = {
        id: node.id,
        name: node.name,
        type: node.type,
        ...extractLayoutProperties(node),
        visuals: {
            fills: node.fills || [],
            strokes: node.strokes || [],
            strokeWeight: node.strokeWeight || 1,
            strokeAlign: node.strokeAlign || "CENTER",
            individualStrokeWeights: node.individualStrokeWeights || null,
            effects: node.effects || []
        },
        textDetails: node.type === "TEXT" ? {
            text: node.characters || "",
            style: node.style || {}       // ← correct key
        } : null,
        resolvedDesignTokens: {}
      };

      // Extract specific component mapping + check for design token overrides
      if (node.componentId && globalComponents[node.componentId]) {
        elementNode.resolvedDesignTokens.component = {
          id: node.componentId,
          ...globalComponents[node.componentId]
        };

        // Link component variant parent tracking (e.g. Size=48 group properties)
        const setId = globalComponents[node.componentId].componentSetId;
        if (setId && globalComponentSets[setId]) {
          elementNode.resolvedDesignTokens.componentSet = {
            id: setId,
            ...globalComponentSets[setId]
          };
        }
      }

      // Link specific styling references
      if (node.styles) {
        elementNode.resolvedDesignTokens.styles = {};
        Object.entries(node.styles).forEach(([styleKey, styleId]) => {
          if (globalStyles[styleId]) {
            elementNode.resolvedDesignTokens.styles[styleKey] = {
              id: styleId,
              ...globalStyles[styleId]
            };
          }
        });
      }

      // Push flattened element into parent container map
      output.nodes[documentRoot.name || nodeId].childrenElements.push(elementNode);

      if (node.children && Array.isArray(node.children)) {
        node.children.forEach(recurse);
      }
    }

    // Run recursion on the children of the requested target root node
    if (documentRoot.children) {
      documentRoot.children.forEach(recurse);
    }
  });

  return output;
}

function extractLayoutProperties(node) {
    return {
        layoutMode: node.layoutMode || "NONE",
        primaryAxisSizingMode: node.primaryAxisSizingMode || "FIXED",   // ← add
        counterAxisSizingMode: node.counterAxisSizingMode || "FIXED",   // ← add
        itemSpacing: node.itemSpacing || 0,
        layoutAlign: node.layoutAlign || "INHERIT",
        layoutGrow: node.layoutGrow || 0,
        minWidth: node.minWidth || null,
        maxWidth: node.maxWidth || null,
        borderRadius: node.cornerRadius || null,
        padding: {
            top: node.paddingTop || 0,
            right: node.paddingRight || 0,
            bottom: node.paddingBottom || 0,
            left: node.paddingLeft || 0
        },
        alignItems: node.counterAxisAlignItems || "MIN",
        justifyContent: node.primaryAxisAlignItems || "MIN",
        visualDimensions: node.absoluteBoundingBox,
        variables: node.boundVariables || {}
    };
}

/**
 * Queries and maps Figma nodes for a given page into CSS-translated style data.
 * @returns {{
 *  extractedAt: string,
 *  nodes: {
 *    [frameName: string]: FigmaFrame
 *  }
 * }}
 */
async function queryFigmaStyles(page, fileKey, accessToken) {
    const nodes = await getTargetNodeIds(page, fileKey, accessToken);
    const figmaNodes = await extractFigmaNodes(nodes, fileKey, accessToken);

    const registry = {};

    // 1. Iterate through each top-level Frame (e.g., "ProductModule")
    for (const key in figmaNodes.nodes) {
        const frameNode = figmaNodes.nodes[key]
        
        // Translate the frame itself
        const translatedFrame = mapFigmaToCss(frameNode);
        
        // Prepare the container for this frame's flattened children
        const childrenMap = {};

        // 2. Define a nested walker that only populates this frame's childrenMap
        function walk(node) {
            if (!node) return;

            // Grab children from the RAW node before translation strips them
            var kids = node.childrenElements || node.children;

            var translatedChild = mapFigmaToCss(node);

            // Scrub any residual tree references from the translated output
            delete translatedChild.childrenElements;
            delete translatedChild.children;

            if (translatedChild.name) {
                childrenMap[translatedChild.name] = translatedChild;
            }

            // Recurse using the raw kids captured before translation
            if (kids && Array.isArray(kids)) {
                kids.forEach(walk);
            }
        }

        // 3. Start the walk from the frame's children (don't walk the frame again)
        const frameChildren = frameNode.childrenElements || frameNode.children;
        if (frameChildren) {
            frameChildren.forEach(walk);
        }

        // 4. Clean up the frame object and assign the flattened map
        delete translatedFrame.childrenElements;
        delete translatedFrame.children;
        
        registry[key] = {
            ...translatedFrame,
            children: childrenMap // This is now a flat object { "CardName": {...} }
        };
    };

    console.log(registry)
    figmaNodes.nodes = registry

    // Prime lastKnownChange so the first hasFileBeenUpdated call after
    // this fetch has a real baseline — without this it always returns false
    // on the first check because lastKnownChange is still null
    try {
        const metaResponse = await fetch(
            `${FIGMA_API_URL}/files/${fileKey}?depth=1`,
            { method: "GET", headers: { 'X-Figma-Token': accessToken } }
        );
        if (metaResponse.ok) {
            const meta = await metaResponse.json();
            lastKnownChange = meta.lastModified;
            console.log(`[vlint] Baseline timestamp set: ${lastKnownChange}`);
        }
    } catch (e) {
        console.warn('[vlint] Could not prime lastKnownChange:', e);
    }

    figmaNodes.generatedCss = {};
    for (const [frameName, frame] of Object.entries(registry)) {
        figmaNodes.generatedCss[frameName] = generateLayoutCss(frameName, frame.children || {});
    }

    return figmaNodes;
}

/**
 * Checks if the Figma file has been updated since the last check.
 * @returns {Promise<boolean>} True if updated, false otherwise.
 */
async function hasFileBeenUpdated(fileKey, accessToken) {
  const MAX_RETRIES = 4;
  const BASE_DELAY_MS = 1000;

  async function fetchWithBackoff(attempt) {
    const requestInit = {
      method: "GET",
      headers: { 'X-Figma-Token': accessToken },
    };

    try {
      const response = await fetch(`${FIGMA_API_URL}/files/${fileKey}?depth=1`, requestInit);

      // Retry on 429 with exponential backoff
      if (response.status === 429) {
        if (attempt >= MAX_RETRIES) {
          console.warn(`[vlint] Rate limit hit after ${MAX_RETRIES} retries. Skipping update check.`);
          return false;
        }

        // Respect Retry-After header if Figma sends one, otherwise back off exponentially
        const retryAfter = response.headers.get('Retry-After');
        const delayMs = retryAfter
          ? parseInt(retryAfter) * 1000
          : BASE_DELAY_MS * Math.pow(2, attempt);

        console.warn(`[vlint] Rate limited (429). Retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})...`);
        await new Promise(function(resolve) { setTimeout(resolve, delayMs); });
        return fetchWithBackoff(attempt + 1);
      }

      if (!response.ok) {
        throw new Error(`Status: ${response.status}`);
      }

      const data = await response.json();
      const lastModified = data.lastModified;

      if (!lastKnownChange) {
        lastKnownChange = lastModified;
        console.log(`[vlint] Initial timestamp stored: ${lastModified}`);
        return false;
      }

      if (new Date(lastModified) > new Date(lastKnownChange)) {
        console.log(`[vlint] Update detected! Old: ${lastKnownChange} -> New: ${lastModified}`);
        lastKnownChange = lastModified;
        return true;
      }

      console.log("[vlint] No changes detected.");
      return false;

    } catch (error) {
      console.error("Metadata check failed:", error);
      return false;
    }
  }

  return fetchWithBackoff(0);
}

function mapFigmaToCss(node) {
    const css = {};

    // --- 1. BOX MODEL ---
    if (node.visualDimensions) {
        var totalWidth  = Math.round(node.visualDimensions.width);
        var totalHeight = Math.round(node.visualDimensions.height);

        // Figma dimensions are border-box (padding included).
        // CSS defaults to content-box, so subtract padding to get the true content size.
        var padLeft   = node.padding ? node.padding.left   : 0;
        var padRight  = node.padding ? node.padding.right  : 0;
        var padTop    = node.padding ? node.padding.top    : 0;
        var padBottom = node.padding ? node.padding.bottom : 0;

        var contentWidth  = totalWidth  - padLeft - padRight;
        var contentHeight = totalHeight - padTop  - padBottom;

        if (node.layoutGrow === 1) {
            css.flex = "1";
        } else {
            css.width = contentWidth + "px";
        }

        if (node.layoutAlign === "STRETCH") {
            css.alignSelf = "stretch";
        } else {
            css.height = contentHeight + "px";
        }
    }

    // Hug-content frames shouldn't have a fixed dimension on their hug axis
    if (node.primaryAxisSizingMode === "AUTO") {
        if (node.layoutMode === "VERTICAL")   delete css.height;
        if (node.layoutMode === "HORIZONTAL") delete css.width;
    }
    if (node.counterAxisSizingMode === "AUTO") {
        if (node.layoutMode === "VERTICAL")   delete css.width;
        if (node.layoutMode === "HORIZONTAL") delete css.height;
    }

    if (node.borderRadius !== undefined && node.borderRadius !== 0) {
        css.borderRadius = `${node.borderRadius}px`;
    }

    // --- 2. COLORS ---
    const processColor = (paint) => {
        if (paint?.type === 'SOLID' && paint.color) {
            const { r, g, b } = paint.color;
            const a = paint.opacity ?? paint.color.a ?? 1;
            const toHex = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
            return a === 1 
                ? `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase()
                : `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a.toFixed(2)})`;
        }
        return null;
    };

    if (node.visuals?.fills?.length > 0) {
        const color = processColor(node.visuals.fills[0]);
        if (node.type === "TEXT") {
            css.color = color;  // text fill = text color
        } else {
            css.backgroundColor = color;
        }
    }

    if (node.visuals?.strokes?.length > 0) {
        const color = processColor(node.visuals.strokes[0]);
        if (color) {
            const individual = node.visuals.individualStrokeWeights;
            if (individual) {
                const sides = { borderTop: individual.top, borderRight: individual.right, borderBottom: individual.bottom, borderLeft: individual.left };
                Object.entries(sides).forEach(function([prop, weight]) {
                    if (weight > 0) css[prop] = weight + "px solid " + color;
                });
            } else {
                const w = node.visuals.strokeWeight || 1;
                const align = node.visuals.strokeAlign;
                // INSIDE stroke in Figma renders like a box-shadow inset in CSS
                if (align === "INSIDE") {
                    css.boxShadow = "inset 0 0 0 " + w + "px " + color;
                } else {
                    css.border = w + "px solid " + color;
                }
            }
        }
    }

    // --- 3. TYPOGRAPHY ---
    // node.textDetails.style mirrors the Figma REST API's `style` object on TEXT nodes
    if (node.type === "TEXT" && node.textDetails && node.textDetails.style) {
        const s = node.textDetails.style;

        if (s.fontFamily)  css.fontFamily  = `"${s.fontFamily}", sans-serif`;
        if (s.fontSize)    css.fontSize    = `${s.fontSize}px`;
        if (s.fontWeight)  css.fontWeight  = s.fontWeight;
        if (s.italic)      css.fontStyle   = 'italic';

        // lineHeightUnit can be AUTO, PIXELS, or PERCENT
        if (s.lineHeightUnit === "PIXELS" && s.lineHeightPx) {
            css.lineHeight = `${Math.round(s.lineHeightPx)}px`;
        } else if (s.lineHeightUnit === "PERCENT" && s.lineHeightPercentFontSize) {
            css.lineHeight = `${s.lineHeightPercentFontSize}%`;
        }

        // Figma letterSpacing is in px — convert to em for scalability
        if (s.letterSpacing && s.letterSpacing !== 0) {
            css.letterSpacing = `${(s.letterSpacing / s.fontSize).toFixed(4)}em`;
        }

        if (s.textAlignHorizontal) {
            css.textAlign = s.textAlignHorizontal.toLowerCase().replace('justified', 'justify');
        }

        if (s.textDecoration && s.textDecoration !== 'NONE') {
            const decorationMap = {
                'UNDERLINE':     'underline',
                'STRIKETHROUGH': 'line-through'
            };
            css.textDecoration = decorationMap[s.textDecoration] || s.textDecoration.toLowerCase();
        }

        if (s.textCase && s.textCase !== 'ORIGINAL') {
            const caseMap = {
                'UPPER':      'uppercase',
                'LOWER':      'lowercase',
                'TITLE':      'capitalize',
                'SMALL_CAPS': 'small-caps'
            };
            css.textTransform = caseMap[s.textCase];
        }

        if (s.paragraphSpacing && s.paragraphSpacing > 0) {
            css.marginBottom = `${s.paragraphSpacing}px`;
        }

        if (s.paragraphIndent && s.paragraphIndent > 0) {
            css.textIndent = `${s.paragraphIndent}px`;
        }
    }

    // --- 4. AUTO-LAYOUT ---
    if (node.layoutMode && node.layoutMode !== "NONE") {
        css.display = 'flex';
        css.flexDirection = node.layoutMode === 'VERTICAL' ? 'column' : 'row';
        css.gap = `${node.itemSpacing || 0}px`;

        const alignMap = { "MIN": "flex-start", "CENTER": "center", "MAX": "flex-end", "SPACE_BETWEEN": "space-between" };
        css.alignItems = alignMap[node.alignItems] || 'stretch';
        css.justifyContent = alignMap[node.justifyContent] || 'flex-start';
    }

    // --- 5. PADDING ---
    if (node.padding) {
        const { top, right, bottom, left } = node.padding;
        css.padding = top === bottom && left === right
            ? `${top}px ${right}px`
            : `${top}px ${right}px ${bottom}px ${left}px`;
    }

    // --- 6. CLEANUP & MERGE ---
    // Destructure properties we want to REMOVE from the final object
    const {
        // Figma layout primitives — already mapped to css.display, css.flexDirection etc.
        layoutMode,
        primaryAxisSizingMode,
        counterAxisSizingMode,
        itemSpacing,
        layoutAlign,        // mapped to css.alignSelf
        layoutGrow,         // mapped to css.flex
        // Figma enums — mapped to CSS equivalents, raw "MIN"/"MAX" must not leak
        alignItems,         // "MIN" → css.alignItems: "flex-start"
        justifyContent,     // "MIN" → css.justifyContent: "flex-start"
        // Figma objects — mapped to CSS strings, raw objects must not leak
        padding,            // {top,right,bottom,left} → css.padding: "20px 24px"
        borderRadius,       // 12 → css.borderRadius: "12px"
        // Raw Figma data — never CSS
        visuals,
        textDetails,
        visualDimensions,
        resolvedDesignTokens,
        variables,
        minWidth,
        maxWidth,
        children,
        childrenElements,
        ...remainingMetadata  // now only contains id, name, type — filtered by FIGMA_METADATA_KEYS
    } = node;

    return {
        ...remainingMetadata,
        ...css
    };
}

function generateLayoutCss(frameName, childrenMap) {
    const layoutBlocks = [];
    const typographyBlocks = [];

    for (const [componentName, props] of Object.entries(childrenMap)) {
        if (props.type === "TEXT") {
            // ── Typography block ────────────────────────────────────────────
            const declarations = Object.entries(props)
                .filter(([k]) => TYPOGRAPHY_PROPS.has(k))
                .filter(([_, v]) => v !== null && v !== undefined && v !== '')
                .filter(([k, v]) => {
                    const def = CSS_DEFAULTS[k];
                    return def === undefined || String(v) !== String(def);
                })
                .map(([k, v]) => `        ${camelToKebab(k)}: ${v};`)
                .join('\n');

            if (declarations) {
                typographyBlocks.push(`    [data-figma="${componentName}"] {\n${declarations}\n    }`);
            }
        } else {
            // ── Layout block ────────────────────────────────────────────────
            const declarations = Object.entries(props)
                .filter(([k]) => !FIGMA_METADATA_KEYS.has(k))
                .filter(([k]) => !TYPOGRAPHY_PROPS.has(k))
                .filter(([_, v]) => v !== null && v !== undefined && v !== '' && typeof v !== 'object')
                .filter(([k, v]) => {
                    const def = CSS_DEFAULTS[k];
                    return def === undefined || String(v) !== String(def);
                })
                .map(([k, v]) => `        ${camelToKebab(k)}: ${v};`)
                .join('\n');

            if (declarations) {
                layoutBlocks.push(`    [data-figma="${componentName}"] {\n${declarations}\n    }`);
            }
        }
    }

    if (layoutBlocks.length === 0 && typographyBlocks.length === 0) return '';

    const sections = [
        `/* ${frameName}.figma.css — auto-generated by vlint, do not edit */`,
        `/* Developer styles always win — @layer figma sits below unlayered CSS */`,
        `/* Within this file: figma.layout < figma.typography < unlayered styles */`,
        `@layer figma.layout, figma.typography;`,
        '',
    ];

    if (layoutBlocks.length > 0) {
        sections.push(
            `@layer figma.layout {`,
            layoutBlocks.join('\n\n'),
            `}`,
            ''
        );
    }

    if (typographyBlocks.length > 0) {
        sections.push(
            `@layer figma.typography {`,
            typographyBlocks.join('\n\n'),
            `}`
        );
    }

    return sections.join('\n');
}

module.exports = { queryFigmaStyles, hasFileBeenUpdated, generateLayoutCss };