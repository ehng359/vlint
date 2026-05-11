require("dotenv").config();
const fs = require("fs")
const FIGMA_API_URL = "https://api.figma.com/v1";
const FIGMA_FKEY = process.env.FIGMA_FKEY
const FIGMA_PAT = process.env.FIGMA_PAT

// Retrieves the Node IDs based on the targeted Figma file.
async function getTargetNodeIds() {
  const requestInit = {
    method: "GET",
    headers: {
      'X-Figma-Token': FIGMA_PAT,
      'Content-Type': 'application/json'
    },
  };

  try {
    // depth=2 drops inner layer data, leaving only structural Frames & Pages
    const response = await fetch(`${FIGMA_API_URL}/files/${FIGMA_FKEY}?depth=2`, requestInit);
    
    if (!response.ok) {
      throw new Error(`API Error: ${response.status} ${response.statusText}`);
    }

    const fileData = await response.json();
    const frameIdentifiers = [];

    // Traverse down to find top-level frames on each design page
    if (fileData.document && fileData.document.children) {
      fileData.document.children.forEach(page => {
        if (page.type === "CANVAS" && page.children) { // CANVAS represents a Figma Page
          page.children.forEach(child => {
            if (child.type === "FRAME") {
              frameIdentifiers.push({
                id: child.id,
                name: child.name,
                pageName: page.name
              });
            }
          });
        }
      });
    }

    console.log("Found Top-Level Frames available for deep targeted queries:");
    console.table(frameIdentifiers);

    // Join IDs to easily paste directly into your targeted fetch script
    const idListForNextQuery = frameIdentifiers.map(f => f.id).join(",");
    console.log(`\nTargeted ID string query parameter:\n?ids=${idListForNextQuery}`);
    return idListForNextQuery
  } catch (error) {
    console.error("Failed to map base nodes:", error);
  }
}

// Extract the Figma nodes based on the available identifiers in the file.
async function extractFigmaNodes(nodeQuery) {
  const requestInit = {
    method: "GET",
    headers: {
      'X-Figma-Token': FIGMA_PAT,
      'Content-Type': 'application/json'
    },
  };

  // Construct URL with explicit comma-separated node ID filters
  const targetUrl = `${FIGMA_API_URL}/files/${FIGMA_FKEY}/nodes?ids=${nodeQuery}`;

  try {
    console.log(`Querying targeted nodes: ${nodeQuery}...`);
    let response = await fetch(targetUrl, requestInit);
    
    if (!response.ok) {
      throw new Error(`Figma API returned ${response.status}: ${response.statusText}`);
    }

    const apiData = await response.json();
    const finalStructuredData = parseTargetedNodes(apiData);

    // Save out the isolated design source of truth
    fs.writeFileSync("DESIGN_REF.json", JSON.stringify(finalStructuredData, null, 2));
    console.log("Extraction complete! Output saved to DESIGN_REF.json");

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

async function runRoutine() {
    const nodes = await getTargetNodeIds()
    extractFigmaNodes(nodes)
}

runRoutine()