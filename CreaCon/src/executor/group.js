const { app } = require("photoshop");
const { searchLayers } = require("./util");

async function createGroup(params) {
  const { groupName, layerNames } = params;
  const doc = app.activeDocument;
  // Search the whole tree, not just top level - layers created while a layer
  // inside a group was active end up nested inside that group.
  const layers = layerNames
    .map((name) => searchLayers(doc.layers, name))
    .filter(Boolean);

  if (layers.length === 0) {
    throw new Error(`None of the layers [${layerNames.join(", ")}] were found`);
  }

  // The option that moves existing layers into the group is `fromLayers`.
  // Passing `layers` is silently ignored and creates an empty group.
  return doc.createLayerGroup({ name: groupName, fromLayers: layers });
}

module.exports = { createGroup };
