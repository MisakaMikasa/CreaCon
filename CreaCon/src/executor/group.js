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

  // The option that moves existing layers into the group is `fromLayers`.
  // Passing `layers` is silently ignored and creates an empty group.
  return doc.createLayerGroup({ name: groupName, fromLayers: layers });
}

module.exports = { createGroup };
