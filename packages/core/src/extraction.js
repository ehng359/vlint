const { getLogger } = require("./logger");
const FIGMA_API_URL = "https://api.figma.com/v1";
let lastKnownChange = null;

// non-CSS Figma internals
const FIGMA_METADATA_KEYS = new Set([
    // Identity — never CSS
    'id', 'name', 'type',
    // Raw Figma data objects — never CSS
    'resolvedDesignTokens', 'variables',
    'visuals', 'textDetails', 'visualDimensions',
    // Token bindings carried through for validation, never CSS
    'tokens', 'styleRefs',
    // Tree references — never CSS
    'children', 'childrenElements',
    // Figma layout enums — transformed to CSS equivalents, raw values must never leak
    'layoutMode', 'layoutAlign', 'layoutGrow',
    'primaryAxisSizingMode', 'counterAxisSizingMode',
    'itemSpacing',
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

// Spec-level metadata riders on DESIGN_REF nodes. validate.ts consumes this
// as the single source of truth for which keys are not CSS properties.
const SPEC_METADATA_KEYS = new Set([
    'id', 'name', 'type', 'children', 'tokens', 'styleRefs', 'visible',
]);

function camelToKebab(str) {
    return str.replace(/([A-Z])/g, '-$1').toLowerCase();
}

// Retrieves the Node IDs based on the targeted Figma file, plus the file
// version metadata that rides along on the same response.
async function getTargetNodeIds(targetPageName, fileKey, accessToken) {
  const requestInit = {
    method: "GET",
    headers: {
      'X-Figma-Token': accessToken,
      'Content-Type': 'application/json'
    },
  };

  // depth=3 covers the Page, its top-level frames, and frames one level
  // inside SECTION containers, which is how most real files are organised.
  // API/network failures propagate so callers can report the real cause
  // instead of misdiagnosing a transient error as a bad page name or token.
  const response = await fetch(`${FIGMA_API_URL}/files/${fileKey}?depth=3`, requestInit);

  if (!response.ok) {
    throw new Error(`Figma API returned ${response.status}: ${response.statusText}`);
  }

  const fileData = await response.json();
  const frameIdentifiers = [];
  let sectionsTraversed = 0;

  if (fileData.document && fileData.document.children) {
    // A pasted Figma link yields a node id (285:31), not a page name, so match
    // on either: id when the value looks like one, name otherwise. Figma's URL
    // dash form (285-31) is folded to the API colon form before comparison. A
    // link usually selects a frame, not its page, so an id can match the page
    // directly or any node inside it (within the depth we fetched).
    const wantsId = /^[A-Za-z]?\d+[:-]\d+/.test(targetPageName);
    const normalisedTarget = wantsId ? targetPageName.replace("-", ":") : targetPageName;
    const pages = fileData.document.children.filter(p => p.type === "CANVAS");
    const containsId = (node) =>
      node.id === normalisedTarget ||
      (node.children || []).some(containsId);
    const targetPage = wantsId
      ? pages.find(p => p.id === normalisedTarget) || pages.find(containsId)
      : pages.find(p => p.name === targetPageName);

    if (targetPage && targetPage.children) {
      const takeFrame = (child, pageName) => {
        if (child.type === "FRAME") {
          frameIdentifiers.push({ id: child.id, name: child.name, pageName });
        }
      };
      targetPage.children.forEach(child => {
        if (child.type === "SECTION" && child.children) {
          sectionsTraversed++;
          child.children.forEach(inner => takeFrame(inner, targetPage.name));
        } else {
          takeFrame(child, targetPage.name);
        }
      });
    } else {
      getLogger().warn(`No page ${wantsId ? `containing node ${targetPageName}` : `named "${targetPageName}"`} found in file.`);
    }
  }

  if (sectionsTraversed > 0) {
    getLogger().log(`[vlint] Traversed ${sectionsTraversed} section(s) for frames.`);
  }

  if (frameIdentifiers.length > 0) {
    getLogger().log(`Found ${frameIdentifiers.length} top-level frames on page "${targetPageName}"`);
    return {
      ids: frameIdentifiers.map(f => f.id).join(","),
      version: fileData.version,
      lastModified: fileData.lastModified
    };
  }

  return null;
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

  const targetUrl = `${FIGMA_API_URL}/files/${fileKey}/nodes?ids=${nodeQuery}`;
  const response = await fetch(targetUrl, requestInit);

  if (!response.ok) {
    throw new Error(`Figma API returned ${response.status}: ${response.statusText}`);
  }

  return parseTargetedNodes(await response.json());
}

function parseTargetedNodes(apiData) {
  const output = {
    extractedAt: new Date().toISOString(),
    nodes: {}
  };

  // Component/style catalogs come back scoped to the requested nodes
  const globalComponents = apiData.components || {};
  const globalComponentSets = apiData.componentSets || {};
  const globalStyles = apiData.styles || {};

  Object.keys(apiData.nodes).forEach(nodeId => {
    const rootNodeData = apiData.nodes[nodeId];
    const documentRoot = rootNodeData.document;

    output.nodes[documentRoot.name || nodeId] = {
      id: documentRoot.id,
      type: documentRoot.type,
      ...extractLayoutProperties(documentRoot),
      childrenElements: []
    };

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
            style: node.style || {}
        } : null,
        resolvedDesignTokens: {}
      };

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

      output.nodes[documentRoot.name || nodeId].childrenElements.push(elementNode);

      if (node.children && Array.isArray(node.children)) {
        node.children.forEach(recurse);
      }
    }

    if (documentRoot.children) {
      documentRoot.children.forEach(recurse);
    }
  });

  return output;
}

function extractLayoutProperties(node) {
    return {
        layoutMode: node.layoutMode || "NONE",
        primaryAxisSizingMode: node.primaryAxisSizingMode || "FIXED",
        counterAxisSizingMode: node.counterAxisSizingMode || "FIXED",
        itemSpacing: node.itemSpacing || 0,
        layoutAlign: node.layoutAlign || "INHERIT",
        layoutGrow: node.layoutGrow || 0,
        minWidth: node.minWidth || null,
        maxWidth: node.maxWidth || null,
        rotation: node.rotation || 0,
        // rectangleCornerRadii is [tl, tr, br, bl] when corners differ
        borderRadius: node.rectangleCornerRadii ?? node.cornerRadius ?? null,
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
 * Resolves to the DESIGN_REF.json shape: { extractedAt, nodes, generatedCss }.
 */
async function queryFigmaStyles(page, fileKey, accessToken) {
    const target = await getTargetNodeIds(page, fileKey, accessToken);
    if (!target) {
        throw new Error(`No frames found on page "${page}". Check FIGMA_DEV_PAGE and FIGMA_PAT.`);
    }

    const figmaNodes = await extractFigmaNodes(target.ids, fileKey, accessToken);

    // Version stamp lets a checker tell "design moved ahead of the snapshot"
    // apart from "code diverged from the snapshot"
    figmaNodes.version = target.version;
    figmaNodes.lastModified = target.lastModified;
    lastKnownChange = target.lastModified;

    const registry = {};
    const stats = { unsupportedFills: 0, rotatedNodes: 0 };

    for (const key in figmaNodes.nodes) {
        const frameNode = figmaNodes.nodes[key]
        const translatedFrame = mapFigmaToCss(frameNode, stats);
        const childrenMap = {};

        function walk(node) {
            if (!node) return;

            // Grab children from the RAW node before translation strips them
            var kids = node.childrenElements || node.children;

            var translatedChild = mapFigmaToCss(node, stats);

            // Scrub any residual tree references from the translated output
            delete translatedChild.childrenElements;
            delete translatedChild.children;

            if (translatedChild.name) {
                if (childrenMap[translatedChild.name]) {
                    getLogger().warn(`[vlint] Duplicate node name "${translatedChild.name}" in frame "${key}", later node overwrites the earlier one.`);
                }
                childrenMap[translatedChild.name] = translatedChild;
            }

            if (kids && Array.isArray(kids)) {
                kids.forEach(walk);
            }
        }

        // Start from the frame's children, the frame itself is already translated
        const frameChildren = frameNode.childrenElements || frameNode.children;
        if (frameChildren) {
            frameChildren.forEach(walk);
        }

        delete translatedFrame.childrenElements;
        delete translatedFrame.children;
        
        registry[key] = {
            ...translatedFrame,
            children: childrenMap // flat object { "CardName": {...} }
        };
    };

    figmaNodes.nodes = registry

    // Anything skipped rather than translated is worth a visible note;
    // silent gaps are how real files end up "passing" incorrectly
    if (stats.unsupportedFills > 0) {
        getLogger().warn(`[vlint] ${stats.unsupportedFills} gradient/image fill(s) had no comparable color and were omitted.`);
    }
    if (stats.rotatedNodes > 0) {
        getLogger().warn(`[vlint] ${stats.rotatedNodes} rotated node(s) had width/height omitted (bounding box is axis-aligned).`);
    }

    // Swap raw variable ids in token bindings for names when the Variables
    // API is readable (Enterprise plans); ids stay put otherwise. Skipped
    // entirely when nothing in the file binds a variable.
    const tokenBearers = [];
    for (const frame of Object.values(registry)) {
        if (frame.tokens) tokenBearers.push(frame);
        for (const child of Object.values(frame.children || {})) {
            if (child.tokens) tokenBearers.push(child);
        }
    }
    if (tokenBearers.length > 0) {
        const variableNames = await resolveVariableNames(fileKey, accessToken);
        if (variableNames) {
            figmaNodes.variables = variableNames;
            for (const node of tokenBearers) {
                for (const [prop, id] of Object.entries(node.tokens)) {
                    if (variableNames[id]) node.tokens[prop] = variableNames[id];
                }
            }
        }
    }

    figmaNodes.generatedCss = {};
    for (const [frameName, frame] of Object.entries(registry)) {
        // Breakpoint frames fold into their base frame's stylesheet as
        // @media blocks; only orphans (no base frame) stand alone
        const bpMatch = frameName.match(BREAKPOINT_FRAME_RE);
        if (bpMatch && registry[bpMatch[1]]) continue;

        const breakpointFrames = {};
        for (const bp of Object.keys(BREAKPOINT_MIN_WIDTHS)) {
            const bpFrame = registry[`${frameName}@${bp}`];
            if (bpFrame) breakpointFrames[bp] = bpFrame.children || {};
        }
        figmaNodes.generatedCss[frameName] = generateLayoutCss(frameName, frame.children || {}, breakpointFrames);
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
          getLogger().warn(`[vlint] Rate limit hit after ${MAX_RETRIES} retries. Skipping update check.`);
          return false;
        }

        // Respect Retry-After header if Figma sends one, otherwise back off exponentially
        const retryAfter = response.headers.get('Retry-After');
        const delayMs = retryAfter
          ? parseInt(retryAfter) * 1000
          : BASE_DELAY_MS * Math.pow(2, attempt);

        getLogger().warn(`[vlint] Rate limited (429). Retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})...`);
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
        getLogger().log(`[vlint] Initial timestamp stored: ${lastModified}`);
        return false;
      }

      if (new Date(lastModified) > new Date(lastKnownChange)) {
        getLogger().log(`[vlint] Update detected! Old: ${lastKnownChange} -> New: ${lastModified}`);
        lastKnownChange = lastModified;
        return true;
      }

      getLogger().log("[vlint] No changes detected.");
      return false;

    } catch (error) {
      getLogger().error(`Metadata check failed: ${error}`);
      return false;
    }
  }

  return fetchWithBackoff(0);
}

/**
 * Lightweight version probe for drift-direction checks.
 */
async function getFileMeta(fileKey, accessToken) {
    const response = await fetch(
        `${FIGMA_API_URL}/files/${fileKey}?depth=1`,
        { method: "GET", headers: { 'X-Figma-Token': accessToken } }
    );
    if (!response.ok) {
        throw new Error(`Figma API returned ${response.status}: ${response.statusText}`);
    }
    const data = await response.json();
    return { version: data.version, lastModified: data.lastModified };
}

/**
 * Resolves variable ids to names via the Variables API.
 * Returns null when the endpoint is unreadable (it is Enterprise-gated),
 * in which case token bindings keep their raw VariableID keys.
 */
async function resolveVariableNames(fileKey, accessToken) {
    try {
        const response = await fetch(
            `${FIGMA_API_URL}/files/${fileKey}/variables/local`,
            { method: "GET", headers: { 'X-Figma-Token': accessToken } }
        );
        if (!response.ok) {
            getLogger().warn(`[vlint] Variables API unavailable (${response.status}), token bindings keep raw variable ids.`);
            return null;
        }
        const data = await response.json();
        const names = {};
        for (const [id, variable] of Object.entries(data.meta?.variables || {})) {
            if (variable && variable.name) names[id] = variable.name;
        }
        return Object.keys(names).length > 0 ? names : null;
    } catch (error) {
        getLogger().warn(`[vlint] Variables lookup failed: ${error}`);
        return null;
    }
}

// Which boundVariables fields bind to which CSS property in the spec.
// fills is special-cased per node type inside extractTokenBindings.
const BOUND_VARIABLE_FIELDS = {
    strokes: 'border',
    cornerRadius: 'borderRadius',
    topLeftRadius: 'borderRadius',
    itemSpacing: 'gap',
    // padding is deliberately unmapped: the spec stores one shorthand string,
    // so a single-side binding would mistag all four sides as token-bound
    width: 'width', height: 'height', opacity: 'opacity',
    fontSize: 'fontSize', fontWeight: 'fontWeight', fontFamily: 'fontFamily',
    lineHeight: 'lineHeight', letterSpacing: 'letterSpacing',
};

function extractTokenBindings(node) {
    const bound = node.variables || {};
    const tokens = {};

    const aliasId = (value) => {
        const alias = Array.isArray(value) ? value[0] : value;
        return alias && alias.type === 'VARIABLE_ALIAS' ? alias.id : null;
    };

    for (const [field, value] of Object.entries(bound)) {
        const cssProp = field === 'fills'
            ? (node.type === 'TEXT' ? 'color' : 'backgroundColor')
            : BOUND_VARIABLE_FIELDS[field];
        if (!cssProp) continue;
        const id = aliasId(value);
        if (id && !tokens[cssProp]) tokens[cssProp] = id;
    }

    return tokens;
}

function mapFigmaToCss(node, stats) {
    const css = {};

    // --- 1. BOX MODEL ---
    // Figma dimensions are border-box (padding included). Generated CSS sets
    // box-sizing: border-box on [data-figma], so the values pass straight through.
    // Rotated nodes are skipped: absoluteBoundingBox is the axis-aligned box,
    // so its width/height would be wrong for the element itself.
    const rotated = !!node.rotation;
    if (rotated && stats) stats.rotatedNodes++;

    if (node.visualDimensions && !rotated) {
        var totalWidth  = Math.round(node.visualDimensions.width);
        var totalHeight = Math.round(node.visualDimensions.height);

        if (node.layoutGrow === 1) {
            css.flex = "1";
        } else {
            css.width = totalWidth + "px";
        }

        if (node.layoutAlign === "STRETCH") {
            css.alignSelf = "stretch";
        } else {
            css.height = totalHeight + "px";
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

    if (Array.isArray(node.borderRadius)) {
        const [tl, tr, br, bl] = node.borderRadius;
        css.borderRadius = (tl === tr && tr === br && br === bl)
            ? `${tl}px`
            : `${tl}px ${tr}px ${br}px ${bl}px`;
    } else if (node.borderRadius != null && node.borderRadius !== 0) {
        css.borderRadius = `${node.borderRadius}px`;
    }

    // Figma's responsive resizing bounds
    if (node.minWidth != null) css.minWidth = `${Math.round(node.minWidth)}px`;
    if (node.maxWidth != null) css.maxWidth = `${Math.round(node.maxWidth)}px`;

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
        // First visible solid fill wins; gradient and image fills have no
        // single comparable color, so the property is omitted (never null)
        const visible = node.visuals.fills.filter(f => f.visible !== false);
        const solid = visible.find(f => f.type === 'SOLID');
        const color = solid ? processColor(solid) : null;
        if (color) {
            if (node.type === "TEXT") css.color = color;
            else css.backgroundColor = color;
        } else if (visible.length > 0 && stats) {
            stats.unsupportedFills++;
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
        rotation,           // gates the box model, never CSS itself
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

    const result = {
        ...remainingMetadata,
        ...css
    };

    // Token bindings ride along as metadata so validation can check token
    // identity in addition to value equality
    const tokens = extractTokenBindings(node);
    if (Object.keys(tokens).length > 0) result.tokens = tokens;

    if (resolvedDesignTokens && resolvedDesignTokens.styles) {
        const styleRefs = {};
        for (const [kind, style] of Object.entries(resolvedDesignTokens.styles)) {
            if (style && style.name) styleRefs[kind] = style.name;
        }
        if (Object.keys(styleRefs).length > 0) result.styleRefs = styleRefs;
    }

    return result;
}

// Tailwind's default min-width breakpoints; a Figma frame named "Frame@md"
// becomes an @media block at these widths inside the base frame's CSS
const BREAKPOINT_MIN_WIDTHS = { sm: 640, md: 768, lg: 1024, xl: 1280, '2xl': 1536 };
const BREAKPOINT_FRAME_RE = /^(.+)@(sm|md|lg|xl|2xl)$/;

/**
 * Declarations for one node. With a baseline (the effective props from the
 * mobile-first cascade so far) only changed props are emitted; without one,
 * browser defaults are skipped.
 */
function buildDeclarations(props, isTypography, baseline) {
    return Object.entries(props)
        .filter(([k]) => isTypography
            ? TYPOGRAPHY_PROPS.has(k)
            : (!FIGMA_METADATA_KEYS.has(k) && !TYPOGRAPHY_PROPS.has(k)))
        .filter(([_, v]) => v !== null && v !== undefined && v !== '' && typeof v !== 'object')
        .filter(([k, v]) => {
            if (baseline && baseline[k] !== undefined) return String(v) !== String(baseline[k]);
            const def = CSS_DEFAULTS[k];
            return def === undefined || String(v) !== String(def);
        })
        .map(([k, v]) => `        ${camelToKebab(k)}: ${v};`)
        .join('\n');
}

function buildBlocks(childrenMap, baselineMap) {
    const layout = [];
    const typography = [];
    for (const [componentName, props] of Object.entries(childrenMap)) {
        const isText = props.type === "TEXT";
        const baseline = baselineMap ? baselineMap[componentName] : undefined;
        const declarations = buildDeclarations(props, isText, baseline);
        if (declarations) {
            (isText ? typography : layout).push(`    [data-figma="${componentName}"] {\n${declarations}\n    }`);
        }
    }
    return { layout, typography };
}

function generateLayoutCss(frameName, childrenMap, breakpointFrames) {
    const { layout: layoutBlocks, typography: typographyBlocks } = buildBlocks(childrenMap);

    // Mobile-first media sections: each breakpoint frame is diffed against
    // the effective props accumulated from the base and smaller breakpoints,
    // so a block only carries what actually changes at that width.
    const mediaSections = [];
    if (breakpointFrames) {
        const accumulated = {};
        for (const [name, props] of Object.entries(childrenMap)) accumulated[name] = { ...props };

        for (const [bp, minWidth] of Object.entries(BREAKPOINT_MIN_WIDTHS)) {
            const bpChildren = breakpointFrames[bp];
            if (!bpChildren) continue;

            const blocks = buildBlocks(bpChildren, accumulated);
            for (const [name, props] of Object.entries(bpChildren)) {
                accumulated[name] = { ...(accumulated[name] || {}), ...props };
            }
            if (blocks.layout.length === 0 && blocks.typography.length === 0) continue;

            const indent = (text) => text.replace(/^/gm, '    ');
            const inner = [];
            if (blocks.layout.length > 0) {
                inner.push(`    @layer figma.layout {`, indent(blocks.layout.join('\n\n')), `    }`);
            }
            if (blocks.typography.length > 0) {
                inner.push(`    @layer figma.typography {`, indent(blocks.typography.join('\n\n')), `    }`);
            }
            mediaSections.push([`@media (min-width: ${minWidth}px) {`, ...inner, `}`, ''].join('\n'));
        }
    }

    if (layoutBlocks.length === 0 && typographyBlocks.length === 0 && mediaSections.length === 0) return '';

    const sections = [
        `/* ${frameName}.figma.css — auto-generated by vlint, do not edit */`,
        `/* Developer styles always win — @layer figma sits below unlayered CSS */`,
        `/* Within this file: figma.layout < figma.typography < unlayered styles */`,
        `@layer figma.layout, figma.typography;`,
        '',
    ];

    sections.push(`[data-figma] { box-sizing: border-box; }`, '')

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
            `}`,
            ''
        );
    }

    sections.push(...mediaSections);

    return sections.join('\n').trimEnd() + '\n';
}

module.exports = {
    queryFigmaStyles, hasFileBeenUpdated, generateLayoutCss, mapFigmaToCss,
    getFileMeta, SPEC_METADATA_KEYS, FIGMA_METADATA_KEYS, CSS_DEFAULTS
};