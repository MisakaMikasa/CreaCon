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

  await action.batchPlay(
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

  if (maskType === "invert") {
    await action.batchPlay([{ _obj: "invert" }], {});
  }
}

module.exports = { addMask };
