const { app, action } = require("photoshop");
const { findLayerByName } = require("./util");
const { log } = require("../log");

// Gradient-mask stops use grayscale (gray 0=hide/black .. 100=reveal/white),
// matching Photoshop's own "Copy as Javascript" recording. `useMask: true` is
// what makes the gradient paint into the layer MASK rather than its pixels.
function grayStop(gray, location) {
  return {
    _obj: "colorStop",
    color: { _obj: "grayscale", gray },
    type: { _enum: "colorStopType", _value: "userStop" },
    location,
    midpoint: 50,
  };
}

function gradientDescriptor(type, from, to, startGray, endGray) {
  return {
    _obj: "gradientClassEvent",
    gradientsInterpolationMethod: { _enum: "gradientInterpolationMethodType", _value: "smooth" },
    type: { _enum: "gradientType", _value: type }, // "linear" | "radial"
    dither: true,
    useMask: true,
    from: {
      _obj: "paint",
      horizontal: { _unit: "pixelsUnit", _value: from.x },
      vertical: { _unit: "pixelsUnit", _value: from.y },
    },
    to: {
      _obj: "paint",
      horizontal: { _unit: "pixelsUnit", _value: to.x },
      vertical: { _unit: "pixelsUnit", _value: to.y },
    },
    gradient: {
      _obj: "gradientClassEvent",
      gradientForm: { _enum: "gradientForm", _value: "customStops" },
      interfaceIconFrameDimmed: 4096,
      name: "Foreground to Background",
      colors: [grayStop(startGray, 0), grayStop(endGray, 4096)],
      transparency: [
        { _obj: "transferSpec", opacity: { _unit: "percentUnit", _value: 100 }, location: 0, midpoint: 50 },
        { _obj: "transferSpec", opacity: { _unit: "percentUnit", _value: 100 }, location: 4096, midpoint: 50 },
      ],
    },
  };
}

// Creates an empty reveal-all mask, then paints a gradient into it so the
// layer's effect fades across the image. The "reveal" stop is white at full
// strength, or a proportional grey when strength < 100 (a subtler effect).
// center/size position and scale the radial gradient; direction sets the linear
// one. Falls back to sensible defaults when params are omitted.
async function applyGradientMask(params) {
  const { maskType, direction, region, center, size, strength, angle } = params;
  const doc = app.activeDocument;
  const w = typeof doc.width === "number" ? doc.width : doc.width.value;
  const h = typeof doc.height === "number" ? doc.height : doc.height.value;
  const cx = w / 2;
  const cy = h / 2;

  // Photoshop's `grayscale` color is an INK percentage - gray 0 = WHITE and
  // gray 100 = BLACK (verified: a white->black foreground-to-background drag on
  // a mask records as gray 0 -> gray 100 in Copy-as-Javascript). White reveals
  // the effect, so full strength = gray 0, and strength scales toward black.
  const strengthPct = typeof strength === "number" ? strength : 100;
  const reveal = 100 - strengthPct; // gray 0 (white) at full strength
  const hide = 100; // gray 100 (black) = no effect

  log(
    `gradient mask: type=${maskType} dims=${w}x${h} direction=${direction} ` +
      `region=${region} center=${JSON.stringify(center)} size=${size} strength=${strengthPct}`
  );

  // Fresh reveal-all mask to paint the gradient into.
  const maskResult = await action.batchPlay(
    [
      {
        _obj: "make",
        new: { _class: "channel" },
        at: { _ref: "channel", _enum: "channel", _value: "mask" },
        using: { _enum: "userMaskEnabled", _value: "revealAll" },
      },
    ],
    {}
  );
  log("create mask result:", JSON.stringify(maskResult));

  let type = "linear";
  let from;
  let to;
  let startGray = reveal; // gray at `from`
  let endGray = hide;

  if (maskType === "radialGradient") {
    type = "radial";
    const c = Array.isArray(center) && center.length === 2 ? center : [0.5, 0.5];
    const fx = c[0] * w;
    const fy = c[1] * h;
    const sz = typeof size === "number" ? size : 0.5;
    const radius = (sz * Math.hypot(w, h)) / 2; // radius = distance from `from` to `to`
    from = { x: fx, y: fy };
    to = { x: fx + radius, y: fy };
    if (region === "edges") {
      startGray = hide; // black center -> reveal at edges (vignette)
      endGray = reveal;
    }
  } else if (typeof angle === "number") {
    // Arbitrary-angle linear gradient: the reveal side is toward `angle`
    // (0=right, 90=bottom, 180=left, 270=top). The gradient runs through the
    // center; `size` (default 1) scales how much of the image the fade spans -
    // smaller = a tighter, more localized transition band.
    const rad = (angle * Math.PI) / 180;
    const dx = Math.cos(rad);
    const dy = Math.sin(rad);
    const sz = typeof size === "number" ? size : 1;
    const span = (sz * Math.hypot(w, h)) / 2;
    from = { x: cx + dx * span, y: cy + dy * span }; // reveal side
    to = { x: cx - dx * span, y: cy - dy * span }; // hide side
  } else {
    // linearGradient by cardinal direction: reveal at that edge, fading to black
    // by `size` fraction of the way across (default 1 = full span). e.g. size 0.25
    // with direction "left" affects only the left 25%, untouched beyond that.
    const d = direction || "bottom";
    const sz = typeof size === "number" ? size : 1;
    if (d === "left") {
      from = { x: 0, y: cy };
      to = { x: sz * w, y: cy };
    } else if (d === "right") {
      from = { x: w, y: cy };
      to = { x: w - sz * w, y: cy };
    } else if (d === "top") {
      from = { x: cx, y: 0 };
      to = { x: cx, y: sz * h };
    } else {
      from = { x: cx, y: h };
      to = { x: cx, y: h - sz * h };
    }
  }

  const descriptor = gradientDescriptor(type, from, to, startGray, endGray);
  log("gradient descriptor:", JSON.stringify(descriptor));
  const result = await action.batchPlay([descriptor], {});
  log("gradient result:", JSON.stringify(result));

  // batchPlay returns errors in the result array rather than throwing - surface
  // them so a failed gradient doesn't silently report success.
  const err = Array.isArray(result) && result[0] && result[0]._obj === "error" ? result[0] : null;
  if (err) {
    throw new Error(`gradient fill failed: ${err.message || "unknown error"}`);
  }
}

async function addMask(params) {
  const { targetLayer, maskType, feather, direction, region } = params;
  const doc = app.activeDocument;
  const layer = findLayerByName(targetLayer);
  log(`addMask on "${targetLayer}" type=${maskType} feather=${feather}`);

  // A hidden layer can't have a mask painted on it (-25800 "target layer is
  // hidden"). Masking a hidden adjustment is pointless anyway, so make it visible.
  if (layer.visible === false) {
    layer.visible = true;
  }
  doc.activeLayers = [layer];

  // Adjustment layers ship with a default reveal-all mask, which blocks adding a
  // new one. Discard any existing mask first (harmless error if none exists).
  const deleteResult = await action.batchPlay(
    [{ _obj: "delete", _target: [{ _ref: "channel", _enum: "channel", _value: "mask" }] }],
    {}
  );
  log("delete existing mask result:", JSON.stringify(deleteResult));

  if (maskType === "linearGradient" || maskType === "radialGradient") {
    await applyGradientMask(params);
    log(`addMask complete for "${targetLayer}"`);
    return;
  }

  // Selection-based masks.
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

  const makeResult = await action.batchPlay(
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
  log("make mask result:", JSON.stringify(makeResult));

  if (maskType === "invert") {
    await action.batchPlay([{ _obj: "invert" }], {});
  }

  log(`addMask complete for "${targetLayer}"`);
}

module.exports = { addMask };
