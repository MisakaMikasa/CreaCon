const { app } = require("photoshop");

async function createGroup(params) {
  const { groupName, layerNames } = params;
  const doc = app.activeDocument;
  const layers = layerNames
    .map((name) => doc.layers.find((l) => l.name === name))
    .filter(Boolean);

  if (layers.length === 0) {
    throw new Error(`None of the layers [${layerNames.join(", ")}] were found`);
  }

  return doc.createLayerGroup({ name: groupName, layers });
}

module.exports = { createGroup };
