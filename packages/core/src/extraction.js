const fs = require("fs")
const FIGMA_API_URL = "https://api.figma.com/v1";
let lastKnownChange = null; // ← add this

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
          effects: node.effects || []
        },
        textDetails: node.type === "TEXT" ? {
          text: node.characters || "",
          fontStyle: node.style || {}
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
    itemSpacing: node.itemSpacing || 0,
    // Add Resizing Logic
    layoutAlign: node.layoutAlign || "INHERIT",
    layoutGrow: node.layoutGrow || 0,
    minWidth: node.minWidth || null,
    maxWidth: node.maxWidth || null,

    // Add Radius
    borderRadius: node.cornerRadius || 0,

    padding: {
      top: node.paddingTop || 0,
      right: node.paddingRight || 0,
      bottom: node.paddingBottom || 0,
      left: node.paddingLeft || 0
    },
    alignItems: node.counterAxisAlignItems || "MIN",
    justifyContent: node.primaryAxisAlignItems || "MIN",

    // Important: Use absoluteRenderBounds for true visual size 
    // (includes strokes/effects)
    visualDimensions: node.absoluteRenderBounds || node.absoluteBoundingBox,

    // Variables check
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

            // Translate the child node
            const translatedChild = mapFigmaToCss(node);

            if (translatedChild.name) {
                childrenMap[translatedChild.name] = translatedChild;
            }

            // Recursively dive into children
            const kids = node.childrenElements || node.children;
            if (kids && Array.isArray(kids)) {
                kids.forEach(walk);
                // Clean up the tree references to keep JSON small
                delete translatedChild.childrenElements;
                delete translatedChild.children;
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
    return figmaNodes;
}

/**
 * Checks if the Figma file has been updated since the last check.
 * @returns {Promise<boolean>} True if updated, false otherwise.
 */
async function hasFileBeenUpdated(fileKey, accessToken) {
  const requestInit = {
    method: "GET",
    headers: {
      'X-Figma-Token': accessToken,
    },
  };

  try {
    // We use depth=1 to get ONLY the root metadata and page names
    const response = await fetch(`${FIGMA_API_URL}/files/${fileKey}?depth=1`, requestInit);
    
    if (!response.ok) {
      throw new Error(`Status: ${response.status}`);
    }

    const { lastModified } = await response.json();

    // If this is the first time running, just store the date and return false
    if (!lastKnownChange) {
      lastKnownChange = lastModified;
      console.log(`Initial timestamp stored: ${lastModified}`);
      return false;
    }

    // Compare timestamps
    if (new Date(lastModified) > new Date(lastKnownChange)) {
      console.log(`Update detected! Old: ${lastKnownChange} -> New: ${lastModified}`);
      lastKnownChange = lastModified; // Update the reference
      return true;
    }

    console.log("No changes detected.");
    return false;

  } catch (error) {
    console.error("Metadata check failed:", error);
    return false;
  }
}

function mapFigmaToCss(node) {
    const css = {};

    // --- 1. BOX MODEL ---
    if (node.visualDimensions) {
        css.width = `${Math.round(node.visualDimensions.width)}px`;
        css.height = `${Math.round(node.visualDimensions.height)}px`;
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
        css.backgroundColor = processColor(node.visuals.fills[0]);
    }

    if (node.visuals?.strokes?.length > 0) {
        const color = processColor(node.visuals.strokes[0]);
        if (color) css.border = `${node.visuals.strokeWeight || 1}px solid ${color}`;
    }

    // --- 3. TYPOGRAPHY ---
    if (node.type === "TEXT" && node.textDetails?.style) {
        const s = node.textDetails.style;
        css.fontFamily = s.fontFamily;
        css.fontSize = `${s.fontSize}px`;
        css.fontWeight = s.fontWeight;
        css.textAlign = s.textAlignHorizontal?.toLowerCase() || 'left';
        if (s.lineHeightPx) css.lineHeight = `${Math.round(s.lineHeightPx)}px`;
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
        layoutMode,
        itemSpacing,
        alignItems,
        justifyContent,
        padding,          // Removing original object to favor CSS string
        visuals,          // Removing raw fills/strokes array
        textDetails,      // Removing raw typography object
        visualDimensions, // Removing raw box data
        ...remainingMetadata
    } = node;

    return {
        ...remainingMetadata,
        ...css
    };
}

module.exports = {queryFigmaStyles, hasFileBeenUpdated}