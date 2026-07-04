const { app, action, constants } = require("photoshop");
const { log } = require("../log");
const { findLayerByName } = require("./util");

// The UXP document DOM has no createAdjustmentLayer(), so we create adjustment
// layers via batchPlay's `make` descriptor, baking the AI-provided settings
// into the `type` object. The settings key names the AI is expected to emit are
// documented in backend/prompt.py so the two stay in sync.
const DEFAULT_PRESET = { _enum: "presetKindType", _value: "presetKindDefault" };

function num(v, fallback) {
  return typeof v === "number" ? v : fallback;
}

// Hue/Saturation can target a specific color range instead of the master.
const HS_CHANNELS = {
  reds: { localRange: 1, beginRamp: 315, beginSustain: 345, endSustain: 15, endRamp: 45 },
  yellows: { localRange: 2, beginRamp: 15, beginSustain: 45, endSustain: 75, endRamp: 105 },
  greens: { localRange: 3, beginRamp: 75, beginSustain: 105, endSustain: 135, endRamp: 165 },
  cyans: { localRange: 4, beginRamp: 135, beginSustain: 165, endSustain: 195, endRamp: 225 },
  blues: { localRange: 5, beginRamp: 195, beginSustain: 225, endSustain: 255, endRamp: 285 },
  magentas: { localRange: 6, beginRamp: 255, beginSustain: 285, endSustain: 315, endRamp: 345 },
};

function hueSatEntry(s) {
  const entry = {
    _obj: "hueSatAdjustmentV2",
    hue: num(s.hue, 0),
    saturation: num(s.saturation, 0),
    lightness: num(s.lightness, 0),
  };
  const range = s.channel && HS_CHANNELS[String(s.channel).toLowerCase()];
  if (range) {
    entry.localRange = range.localRange;
    entry.beginRamp = range.beginRamp;
    entry.beginSustain = range.beginSustain;
    entry.endSustain = range.endSustain;
    entry.endRamp = range.endRamp;
  }
  return entry;
}

const CURVE_CHANNELS = {
  composite: "composite",
  rgb: "composite",
  red: "red",
  green: "grain", // Photoshop's internal name for the green channel
  blue: "blue",
};

function curvesTo(settings) {
  const points =
    Array.isArray(settings.points) && settings.points.length >= 2
      ? settings.points
      : [[0, 0], [255, 255]];
  const channel =
    CURVE_CHANNELS[String(settings.channel || "composite").toLowerCase()] || "composite";
  return {
    _obj: "curves",
    adjustment: [
      {
        _obj: "curvesAdjustment",
        channel: { _ref: "channel", _enum: "channel", _value: channel },
        curve: points.map(([input, output]) => ({
          _obj: "point",
          horizontal: input,
          vertical: output,
        })),
      },
    ],
  };
}

// `type` descriptors baked into the `make` call (these apply directly on create).
const BUILDERS = {
  hueSaturation() {
    // Values are applied by a follow-up `set` (baking into make selects the
    // color range but doesn't apply the value).
    return { _obj: "hueSaturation", presetKind: DEFAULT_PRESET };
  },
  brightnessContrast(s) {
    return {
      _obj: "brightnessEvent",
      brightness: num(s.brightness, 0),
      center: num(s.contrast, 0), // "center" is Photoshop's key for contrast
      useLegacy: false,
    };
  },
  vibrance(s) {
    return {
      _obj: "vibrance",
      vibrance: num(s.vibrance, 0),
      saturation: num(s.saturation, 0),
    };
  },
  exposure(s) {
    return {
      _obj: "exposure",
      exposure: num(s.exposure, 0),
      offset: num(s.offset, 0),
      gammaCorrection: num(s.gamma, 1),
    };
  },
  colorBalance(s) {
    return {
      _obj: "colorBalance",
      shadowLevels: s.shadows || [0, 0, 0],
      midtoneLevels: s.midtones || [0, 0, 0],
      highlightLevels: s.highlights || [0, 0, 0],
      preserveLuminosity: s.preserveLuminosity !== false,
    };
  },
  curves() {
    // Points applied by a follow-up `set`.
    return { _obj: "curves", presetKind: DEFAULT_PRESET };
  },
};

// hueSaturation and curves can't have their values baked into `make` - they need
// a follow-up `set` (used both after create and for updateAdjustmentLayer).
const NEEDS_SET = new Set(["hueSaturation", "curves"]);

// Returns the `to` object for a `set adjustmentLayer` descriptor - i.e. how the
// layer's values are (re)applied. Shared by create's post-set and update.
function buildAdjustmentTo(adjustmentType, settings) {
  if (adjustmentType === "hueSaturation") {
    return { _obj: "hueSaturation", adjustment: [hueSatEntry(settings)] };
  }
  if (adjustmentType === "curves") {
    return curvesTo(settings);
  }
  const builder = BUILDERS[adjustmentType];
  if (!builder) {
    throw new Error(`Unsupported adjustmentType "${adjustmentType}"`);
  }
  return builder(settings);
}

async function applySet(adjustmentType, settings) {
  const setDescriptor = {
    _obj: "set",
    _target: [{ _ref: "adjustmentLayer", _enum: "ordinal", _value: "targetEnum" }],
    to: buildAdjustmentTo(adjustmentType, settings),
  };
  log(`${adjustmentType} set descriptor:`, JSON.stringify(setDescriptor));
  const result = await action.batchPlay([setDescriptor], {});
  log(`${adjustmentType} set result:`, JSON.stringify(result));
}

async function createAdjustmentLayer(params) {
  const { adjustmentType, layerName, settings, groupName } = params;

  const builder = BUILDERS[adjustmentType];
  if (!builder) {
    throw new Error(`Unsupported adjustmentType "${adjustmentType}"`);
  }

  const makeDescriptor = {
    _obj: "make",
    _target: [{ _ref: "adjustmentLayer" }],
    using: { _obj: "adjustmentLayer", type: builder(settings || {}) },
  };

  log(`createAdjustmentLayer "${layerName}" settings:`, settings);
  log("batchPlay descriptor:", JSON.stringify(makeDescriptor));
  const result = await action.batchPlay([makeDescriptor], {});
  log("batchPlay result:", JSON.stringify(result));

  const layer = app.activeDocument.activeLayers[0];
  if (layer && layerName) {
    layer.name = layerName;
  }

  // Types whose values couldn't be baked into `make` get a follow-up `set`.
  if (NEEDS_SET.has(adjustmentType)) {
    await applySet(adjustmentType, settings || {});
  }

  if (groupName && layer) {
    const group = app.activeDocument.layers.find(
      (l) => l.name === groupName && l.kind === constants.LayerKind.GROUP
    );
    if (group) {
      layer.move(group, constants.ElementPlacement.PLACEINSIDE);
    }
  }

  return layer;
}

// Modifies an EXISTING adjustment layer's values in place, instead of stacking a
// new duplicate. Used when the user asks to refine/tweak a previous adjustment.
async function updateAdjustmentLayer(params) {
  const { targetLayer, adjustmentType, settings } = params;
  const layer = findLayerByName(targetLayer);
  app.activeDocument.activeLayers = [layer];
  log(`updateAdjustmentLayer "${targetLayer}" (${adjustmentType}) settings:`, settings);
  await applySet(adjustmentType, settings || {});
  return layer;
}

module.exports = { createAdjustmentLayer, updateAdjustmentLayer };
