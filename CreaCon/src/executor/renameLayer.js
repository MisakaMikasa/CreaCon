const { findLayerByName } = require("./util");

async function renameLayer(params) {
  const { targetLayer, newName } = params;
  const layer = findLayerByName(targetLayer);
  layer.name = newName;
}

module.exports = { renameLayer };
