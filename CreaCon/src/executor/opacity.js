const { findLayerByName } = require("./util");

async function setLayerOpacity(params) {
  const { targetLayer, opacity } = params;
  const layer = findLayerByName(targetLayer);
  layer.opacity = opacity;
}

module.exports = { setLayerOpacity };
