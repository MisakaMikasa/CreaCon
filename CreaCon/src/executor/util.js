const { app } = require("photoshop");

function findLayerByName(name) {
  const layer = app.activeDocument.layers.find((l) => l.name === name);
  if (!layer) {
    throw new Error(`Layer named "${name}" not found`);
  }
  return layer;
}

module.exports = { findLayerByName };
