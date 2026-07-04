const { constants } = require("photoshop");
const { findLayerByName } = require("./util");

// Maps the schema's blendMode strings to UXP's constants.BlendMode enum keys.
// Uses the DOM API (layer.blendMode) rather than batchPlay - it's reliable and
// doesn't need descriptor guesswork.
const BLEND_MODES = {
  normal: "NORMAL",
  multiply: "MULTIPLY",
  screen: "SCREEN",
  overlay: "OVERLAY",
  softLight: "SOFTLIGHT",
  hardLight: "HARDLIGHT",
  colorDodge: "COLORDODGE",
  colorBurn: "COLORBURN",
  linearDodge: "LINEARDODGE",
  linearBurn: "LINEARBURN",
  darken: "DARKEN",
  lighten: "LIGHTEN",
  difference: "DIFFERENCE",
  exclusion: "EXCLUSION",
  hue: "HUE",
  saturation: "SATURATION",
  color: "COLOR",
  luminosity: "LUMINOSITY",
};

async function setBlendMode(params) {
  const { targetLayer, blendMode } = params;
  const layer = findLayerByName(targetLayer);

  const key = BLEND_MODES[blendMode];
  const value = key && constants.BlendMode[key];
  if (!value) {
    throw new Error(`Unsupported blendMode "${blendMode}"`);
  }
  layer.blendMode = value;
}

module.exports = { setBlendMode };
