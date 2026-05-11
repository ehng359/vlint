const fs = require("fs")
const FIGMA_API_URL = "https://api.figma.com/v1";

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

async function queryFigmaStyles(page, fileKey, accessToken) {
  const nodes = await getTargetNodeIds(page, fileKey, accessToken)
  return extractFigmaNodes(nodes, fileKey, accessToken)
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

module.exports = {queryFigmaStyles, hasFileBeenUpdated}