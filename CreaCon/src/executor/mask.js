const { app, action } = require("photoshop");
const { findLayerByName } = require("./util");
const { log } = require("../log");

// Uses Photoshop's own built-in AI selection commands (Select Subject / Select
// Sky) rather than asking the LLM to draw pixel-precise mask data - general
// vision models are not reliable at that. The batchPlay descriptors below
// (`autoCutout`, `selectSky`) should be verified against a live Photoshop
// instance - the reliable way to do that is to perform the equivalent menu
// action manually once and capture the generated descriptor with a batchPlay
// logger, then compare it to what's used here.
async function addMask(params) {
  const { targetLayer, maskType, feather } = params;
  const doc = app.activeDocument;
  const layer = findLayerByName(targetLayer);
  log(`addMask on "${targetLayer}" type=${maskType} feather=${feather}`);

  doc.activeLayers = [layer];

  // Adjustment layers are created WITH a default reveal-all mask, which makes
  // "add layer mask from selection" unavailable (the -25920 "Make not available"
  // error). Discard any existing mask first so we can build one from the
  // selection. If there's no mask, batchPlay returns an error descriptor (not a
  // throw) and we simply proceed.
  const deleteResult = await action.batchPlay(
    [{ _obj: "delete", _target: [{ _ref: "channel", _enum: "channel", _value: "mask" }] }],
    {}
  );
  log("delete existing mask result:", JSON.stringify(deleteResult));

  if (maskType === "selectSubject") {
    const r = await action.batchPlay([{ _obj: "autoCutout", sampleAllLayers: false }], {});
    log("autoCutout result:", JSON.stringify(r));
  } else if (maskType === "selectSky") {
    const r = await action.batchPlay([{ _obj: "selectSky" }], {});
    log("selectSky result:", JSON.stringify(r));
  } else if (maskType === "full") {
    await action.batchPlay([{ _obj: "selectAll" }], {});
  }

  if (feather) {
    await action.batchPlay(
      [{ _obj: "feather", radius: { _unit: "pixelsUnit", _value: feather } }],
      {}
    );
  }

  // NOTE: adjustment layers may be created WITH a default reveal-all mask. If so,
  // this "add layer mask from selection" can be a no-op (a mask already exists),
  // which would leave the adjustment affecting the whole image. The result/error
  // logged here tells us whether that's happening.
  try {
    const maskResult = await action.batchPlay(
      [
        {
          _obj: "make",
          new: { _class: "channel" },
          at: { _ref: "channel", _enum: "channel", _value: "mask" },
          using: { _enum: "userMaskEnabled", _value: "revealSelection" },
        },
      ],
      {}
    );
    log("make mask result:", JSON.stringify(maskResult));
  } catch (err) {
    log("make mask FAILED:", err && err.message ? err.message : String(err));
    throw err;
  }

  if (maskType === "invert") {
    await action.batchPlay([{ _obj: "invert" }], {});
  }

  log(`addMask complete for "${targetLayer}"`);
}

module.exports = { addMask };
