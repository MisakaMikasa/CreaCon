const { app } = require("photoshop");

// Searches the whole layer tree, not just the top level - a layer created while
// a layer inside a group was active gets created inside that group, so a
// top-level-only search would miss it.
function searchLayers(layers, name) {
  for (const layer of layers) {
    if (layer.name === name) return layer;
    // Group layers expose their children via `.layers`.
    if (layer.layers && layer.layers.length) {
      const found = searchLayers(layer.layers, name);
      if (found) return found;
    }
  }
  return null;
}

function findLayerByName(name) {
  const layer = searchLayers(app.activeDocument.layers, name);
  if (!layer) {
    throw new Error(`Layer named "${name}" not found`);
  }
  return layer;
}

module.exports = { findLayerByName, searchLayers };
