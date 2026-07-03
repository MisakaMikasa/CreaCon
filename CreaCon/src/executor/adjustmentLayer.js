const { app, action, constants } = require("photoshop");
const { log } = require("../log");

// The UXP document DOM has no createAdjustmentLayer(), so we create adjustment
// layers via batchPlay's `make` descriptor, baking the AI-provided settings
// into the `type` object. The settings key names the AI is expected to emit are
// documented in backend/prompt.py so the two stay in sync.
//
// IMPORTANT: these value descriptors are a best-effort reconstruction of
// Photoshop's batchPlay format. A WRONG descriptor often silently no-ops (layer
// appears, image unchanged) rather than throwing. If a given adjustment type
// creates a layer but doesn't change the image, capture the real descriptor by
// performing that adjustment manually with a descriptor logger (e.g. Alchemist)
// and correct the matching builder below - the log() call prints exactly what
// we sent so you can diff it against the recorded one.
const DEFAULT_PRESET = { _enum: "presetKindType", _value: "presetKindDefault" };

function num(v, fallback) {
  return typeof v === "number" ? v : fallback;
}

// Hue/Saturation can target a specific color range instead of the master.
// localRange is the range id; the four ramp values are the hue-degree window
// that defines that color (verified against a Photoshop "Copy as Javascript"
// recording - blues = localRange 5, ramps 195/225/255/285). Master omits both.
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

const BUILDERS = {
  hueSaturation() {
    // Create a plain default layer here; the real values are applied by a
    // follow-up `set` in createAdjustmentLayer. Baking values into the `make`
    // call selects the color range but does NOT apply the value (verified).
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
    // Each triple is [red-cyan, green-magenta, blue-yellow], each -100..100.
    // Warmer = positive red + negative blue (e.g. midtones [15, 0, -15]).
    return {
      _obj: "colorBalance",
      shadowLevels: s.shadows || [0, 0, 0],
      midtoneLevels: s.midtones || [0, 0, 0],
      highlightLevels: s.highlights || [0, 0, 0],
      preserveLuminosity: s.preserveLuminosity !== false,
    };
  },
  curves() {
    // Curves settings (per-channel point lists) are not mapped yet - creates a
    // default no-op curves layer. Prefer other adjustment types for now.
    return { _obj: "curves", presetKind: DEFAULT_PRESET };
  },
};

async function createAdjustmentLayer(params) {
  const { adjustmentType, layerName, settings, groupName } = params;

  const builder = BUILDERS[adjustmentType];
  if (!builder) {
    throw new Error(`Unsupported adjustmentType "${adjustmentType}"`);
  }

  const typeDescriptor = builder(settings || {});
  const makeDescriptor = {
    _obj: "make",
    _target: [{ _ref: "adjustmentLayer" }],
    using: { _obj: "adjustmentLayer", type: typeDescriptor },
  };

  log(`createAdjustmentLayer "${layerName}" settings:`, settings);
  log("batchPlay descriptor:", JSON.stringify(makeDescriptor));
  const result = await action.batchPlay([makeDescriptor], {});
  log("batchPlay result:", JSON.stringify(result));

  // The newly created adjustment layer is now the active layer.
  const layer = app.activeDocument.activeLayers[0];
  if (layer && layerName) {
    layer.name = layerName;
  }

  // Hue/Saturation values must be applied via a `set` on the now-existing
  // layer (create-then-set), matching the verified batchPlay descriptor.
  if (adjustmentType === "hueSaturation") {
    const setDescriptor = {
      _obj: "set",
      _target: [{ _ref: "adjustmentLayer", _enum: "ordinal", _value: "targetEnum" }],
      to: { _obj: "hueSaturation", adjustment: [hueSatEntry(settings || {})] },
    };
    log("hueSaturation set descriptor:", JSON.stringify(setDescriptor));
    const setResult = await action.batchPlay([setDescriptor], {});
    log("hueSaturation set result:", JSON.stringify(setResult));
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

module.exports = { createAdjustmentLayer };
