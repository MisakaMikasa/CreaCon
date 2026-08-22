// Geometry spike, ROUND 2.
//
// Round 1 (on DSCF0919.raf, 6240x4160) established:
//   - crs:PerspectiveRotate works with PerspectiveUpright="0" -> the deterministic
//     tier is real.
//   - crs:PerspectiveVertical works too, but leaves so much empty frame that the
//     manual keystone rung was dropped; perspective goes to Upright instead.
//   - PerspectiveUpright="3" computes headlessly from the sidecar alone.
//   - Mask coordinates are SENSOR-relative: a gradient spanning the left half of
//     the sensor covered the ENTIRE left-half crop. Crops therefore do not move
//     existing masks.
//   - CropConstrainToWarp="1" did NOT prevent transparent wedges, because HasCrop
//     was never set - there was no crop rectangle for it to constrain.
//
// That last finding is what this round is about. Every geometry change has to
// carry an explicit crop, and the open question is who computes it: ACR (if a
// full-frame crop plus CropConstrainToWarp makes it shrink to fit the warp) or us
// (the closed-form inscribed rectangle below). The answer decides whether the
// straighten path can stay one dialog.
//
// It also switches straightening from crs:PerspectiveRotate to crs:CropAngle.
// CropAngle rotates the CROP RECTANGLE - the straighten tool - so empty corners
// are impossible by construction, where PerspectiveRotate rotates image content
// and leaves wedges behind.
//
//   R0  baseline: clean sidecar, placed linked
//   R1a CropAngle + FULL-frame crop        -> does ACR inscribe the rect itself?
//   R1b CropAngle + computed inscribed crop -> does our math land clean?
//   R2  Upright=auto + full-frame crop + CropConstrainToWarp
//                                          -> does ACR kill the wedges here?
//
// Unwired by design - call runGeometrySpike(report) from the temporary button in
// panel.js.
const { app, core, action } = require("photoshop");
const { localFileSystem } = require("uxp").storage;
const fs = require("fs");
const { log, formatError } = require("../log");
const { capturePreviewImage } = require("../aiClient");
const { serialize, sidecarPathFor } = require("../executor/xmpSidecar");
const registry = require("../executor/rawRegistry");

const RAW_TYPES = ["cr2", "cr3", "nef", "arw", "raf", "orf", "rw2"];

// Big enough to be unmistakable, small enough to be a plausible real straighten.
const TEST_ANGLE = 5;

// Largest axis-aligned rectangle of the ORIGINAL aspect ratio that fits inside a
// WxH frame rotated by `deg`, as a centred normalized crop rect.
//
// Half-extents (u,v) with u/v held at W/H must satisfy BOTH
//   u*cos + v*sin <= W/2   and   u*sin + v*cos <= H/2
// Substituting u = (W/H)v and normalising by H/2 gives two DIFFERENT ratios:
//   s <= W / (W*cos + H*sin)      and      s <= H / (W*sin + H*cos)
// so the answer is their min. (Collapsing them into a single numerator is wrong
// and silently breaks portrait orientation - verified against a brute-force
// corner search, which this now matches exactly and symmetrically.)
//
// The same function backs the rotation simulator's "keeps N% of the frame"
// figure, so validating it here is double duty. Note how expensive straightening
// is on 3:2: 1 deg costs 5%, 3 deg costs 14%, 5 deg costs 21%, 10 deg costs 35%.
function maxInscribedCrop(width, height, deg) {
  const rad = (Math.abs(deg) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const s = Math.min(
    width / (width * cos + height * sin),
    height / (width * sin + height * cos)
  );
  const half = s / 2;
  return {
    top: 0.5 - half,
    left: 0.5 - half,
    bottom: 0.5 + half,
    right: 0.5 + half,
    scale: s,
    retained: s * s,
  };
}

function cropAttrs({ top, left, bottom, right }, angle) {
  return {
    HasCrop: "True",
    CropTop: String(top),
    CropLeft: String(left),
    CropBottom: String(bottom),
    CropRight: String(right),
    CropAngle: String(angle),
    CropConstrainToWarp: "1",
  };
}

// serialize() writes extras.rootAttrs through verbatim as crs:Key="value" on the
// root rdf:Description. That is the injection point this spike rides: geometry
// keys stay out of SETTING_KEYS until the spike says which ones ACR honours.
function extrasWith(rootAttrs) {
  return {
    rootAttrs,
    rootElements: [],
    correctionAttrs: {},
    maskAttrs: {},
    rangeMaskAttrs: {},
    opaqueByName: {},
  };
}

async function writeTextFile(nativePath, text) {
  try {
    await fs.writeFile(nativePath, text, { encoding: "utf-8" });
    return;
  } catch (err) {
    log("fs.writeFile failed, falling back to entry write:", formatError(err));
  }
  const sep = nativePath.includes("\\") ? "\\" : "/";
  const dir = nativePath.substring(0, nativePath.lastIndexOf(sep));
  const name = nativePath.substring(nativePath.lastIndexOf(sep) + 1);
  const folder = await localFileSystem.getEntryWithUrl("file:" + dir.replace(/\\/g, "/"));
  const file = await folder.createFile(name, { overwrite: true });
  await file.write(text);
}

async function readTextFileIfExists(nativePath) {
  try {
    return await fs.readFile(nativePath, { encoding: "utf-8" });
  } catch {
    return null;
  }
}

// Every crs: attribute on the root rdf:Description. Deliberately a raw regex
// rather than parseFull(): the point is to see EVERYTHING ACR wrote, including
// keys our parser filters out as excluded or unmodelled.
function crsRootAttrs(xml) {
  const out = {};
  const rootOpen = xml && xml.match(/<rdf:Description\b[^>]*>/);
  if (!rootOpen) return out;
  const re = /crs:([A-Za-z0-9_]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(rootOpen[0])) !== null) out[m[1]] = m[2];
  return out;
}

function newOrChangedKeys(before, after) {
  return Object.keys(after)
    .filter((k) => before[k] !== after[k])
    .sort()
    .map((k) => `${k}="${after[k]}"`);
}

function boundsOf(layer) {
  try {
    const b = layer.bounds;
    if (!b) return null;
    const left = Number(b.left);
    const top = Number(b.top);
    const right = Number(b.right);
    const bottom = Number(b.bottom);
    if ([left, top, right, bottom].some((n) => !Number.isFinite(n))) return null;
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  } catch (err) {
    log("boundsOf failed:", formatError(err));
    return null;
  }
}

function fmtBounds(b) {
  if (!b) return "(bounds unavailable)";
  return `${Math.round(b.width)}x${Math.round(b.height)} at (${Math.round(b.left)},${Math.round(b.top)})`;
}

function retainedPct(baseline, current) {
  if (!baseline || !current) return null;
  const base = baseline.width * baseline.height;
  if (!(base > 0)) return null;
  return Math.round((current.width * current.height * 100) / base);
}

async function relink(entry) {
  await action.batchPlay(
    [
      {
        _obj: "placedLayerRelinkToFile",
        null: { _path: localFileSystem.createSessionToken(entry), _kind: "local" },
        _options: { dialogOptions: "dontDisplay" },
      },
    ],
    {}
  );
  try {
    await action.batchPlay(
      [{ _obj: "placedLayerUpdateAllModified", _options: { dialogOptions: "dontDisplay" } }],
      {}
    );
  } catch (err) {
    log("updateAllModified nudge failed (non-fatal):", formatError(err));
  }
}

// --- the spike ---------------------------------------------------------------

async function runGeometrySpike(report) {
  const say = (text) => {
    log("[geometry-spike]", text);
    report(text);
  };

  if (!app.activeDocument) {
    say("Geometry spike: open any document first (the raw is placed into it).");
    return;
  }

  const entry = await localFileSystem.getFileForOpening();
  if (!entry) {
    say("Geometry spike: cancelled (no file picked).");
    return;
  }
  const rawPath = entry.nativePath;
  const ext = (rawPath.split(".").pop() || "").toLowerCase();
  if (ext === "dng") {
    say("Geometry spike: DNG embeds its settings - pick a CR2/CR3/NEF/ARW/RAF/ORF/RW2.");
    return;
  }
  if (!RAW_TYPES.includes(ext)) {
    say(`Geometry spike: ".${ext}" isn't a supported raw type (${RAW_TYPES.join(", ")}).`);
    return;
  }

  say(
    `Geometry spike round 2: raw = ${rawPath}\n` +
      "Use the SAME photo as round 1 so the results are comparable. Every test below " +
      "is judged on ONE question: are there transparent corners?"
  );

  const sidecarPath = sidecarPathFor(rawPath);
  const existing = await readTextFileIfExists(sidecarPath);
  if (existing !== null) {
    await writeTextFile(sidecarPath + ".creacon-backup", existing);
    say(`Geometry spike: existing sidecar backed up to ${sidecarPath}.creacon-backup`);
  }

  // R0 - baseline -------------------------------------------------------------
  await writeTextFile(sidecarPath, serialize({}));
  const token = localFileSystem.createSessionToken(entry);
  // UXP Layer objects are live proxies keyed on id, so the reference stays valid
  // across relinks - simpler than re-finding it (doc.layers is a collection this
  // codebase only ever iterates with for...of, never .find).
  let placedLayer = null;
  let baseline = null;
  await core.executeAsModal(
    async () => {
      await action.batchPlay(
        [
          {
            _obj: "placeEvent",
            null: { _path: token, _kind: "local" },
            linked: true, // matches cameraRaw.js: relink only works on linked SOs
            _options: { dialogOptions: "dontDisplay" },
          },
        ],
        {}
      );
      const placed = app.activeDocument.activeLayers[0];
      if (!placed) throw new Error("Place succeeded but no active layer found");
      placedLayer = placed;
      baseline = boundsOf(placed);
      await registry.register(app.activeDocument, placed.id, rawPath);
      await registry.updateSettings(app.activeDocument, placed.id, {});
    },
    { commandName: "CreaCon geometry spike: place raw" }
  );
  const doc = app.activeDocument;
  say(
    `Geometry spike: R0 baseline placed. Layer ${fmtBounds(baseline)}; ` +
      `canvas ${doc.width}x${doc.height}.`
  );

  const W = baseline ? baseline.width : 6240;
  const H = baseline ? baseline.height : 4160;
  const inscribed = maxInscribedCrop(W, H, TEST_ANGLE);
  say(
    `Geometry spike: for ${Math.round(W)}x${Math.round(H)} at ${TEST_ANGLE} deg the ` +
      `inscribed crop is ${inscribed.left.toFixed(4)}..${inscribed.right.toFixed(4)} ` +
      `(keeps ${Math.round(inscribed.retained * 100)}% of the frame). R1b tests that number.`
  );

  async function step(label, rootAttrs, settings, question) {
    await writeTextFile(sidecarPath, serialize(settings || {}, extrasWith(rootAttrs)));
    say(
      `Geometry spike: ${label} - sidecar written (${Object.keys(rootAttrs).join(", ")}). Relinking…`
    );
    await core.executeAsModal(async () => relink(entry), {
      commandName: `CreaCon geometry spike: ${label}`,
    });
    const bounds = placedLayer ? boundsOf(placedLayer) : null;
    const preview = await capturePreviewImage();
    const pct = retainedPct(baseline, bounds);
    say(
      `Geometry spike: ${label} applied. Layer ${fmtBounds(bounds)}` +
        (pct !== null ? ` (${pct}% of baseline area)` : "") +
        `; canvas ${doc.width}x${doc.height}.\n${question}`
    );
    return { preview, bounds };
  }

  // R1a - does ACR inscribe a full-frame crop for us? -------------------------
  await step(
    "R1a angle+fullcrop",
    cropAttrs({ top: 0, left: 0, bottom: 1, right: 1 }, TEST_ANGLE),
    {},
    `Straightened by ${TEST_ANGLE} deg via crs:CropAngle, with the crop left at FULL frame.\n` +
      "  NO transparent corners -> ACR inscribes the rotated crop itself. We never have to " +
      "compute a crop for straightening; the simulator only needs the retained-area number " +
      "for display. Simplest possible outcome.\n" +
      "  Transparent corners -> ACR takes the rect literally and we must supply the " +
      "inscribed crop ourselves (R1b)."
  );

  // R1b - does our inscribed-rectangle math land clean? -----------------------
  await step(
    "R1b angle+inscribed",
    cropAttrs(inscribed, TEST_ANGLE),
    {},
    `Same ${TEST_ANGLE} deg, but with our computed inscribed crop ` +
      `(keeps ~${Math.round(inscribed.retained * 100)}%).\n` +
      "  Clean edges, no transparency -> the closed-form math is correct AND crop coords are " +
      "in the ROTATED frame. This is the straighten path: one sidecar write, one dialog.\n" +
      "  Still transparent, or visibly over-cropped -> crop coords are in the UNROTATED frame " +
      "and the rect needs converting into rotated space first. Say which it looks like."
  );

  // R2 - Upright auto: can ACR kill its own wedges? ---------------------------
  const uprightAttrs = {
    PerspectiveUpright: "1", // 1 = Auto, per round 1's preference
    ...cropAttrs({ top: 0, left: 0, bottom: 1, right: 1 }, 0),
  };
  const wroteR2 = serialize({}, extrasWith(uprightAttrs));
  await step(
    "R2 upright-auto+constrain",
    uprightAttrs,
    {},
    "Upright AUTO with a full-frame crop and CropConstrainToWarp=1.\n" +
      "  NO transparent corners -> ACR constrains the crop to its own computed warp. The " +
      "Upright path is self-contained: one write, one dialog, no wedges, and we only need " +
      "the layer bounds afterward to report what it cost.\n" +
      "  Transparent corners -> we cannot clean up after Upright without reading its " +
      "computed transform back and writing a second time (two dialogs). That would make " +
      "Upright materially worse than the deterministic path and it should drop down the ladder."
  );

  const afterR2 = await readTextFileIfExists(sidecarPath);
  const added = newOrChangedKeys(crsRootAttrs(wroteR2), crsRootAttrs(afterR2));
  if (added.length) {
    say(
      "Geometry spike: R2 write-back - ACR added/changed these crs: keys:\n  " +
        added.join("\n  ") +
        "\nIf Crop* values appear here, ACR computed the constrained crop for us and we can " +
        "read the exact cost from the sidecar. Upright*/digest keys are the ones the executor " +
        "must INVALIDATE rather than carry forward as extras whenever geometry changes."
    );
  } else {
    say(
      "Geometry spike: R2 write-back - ACR wrote nothing new. It recomputes Upright on every " +
        "develop, so there is no cached transform to invalidate (simpler for the executor)."
    );
  }

  say(
    "Geometry spike round 2: done. Test sidecar left at " +
      sidecarPath +
      (existing !== null
        ? " - your original is in the .creacon-backup file; restore it by hand when finished."
        : " (there was no original).") +
      "\nThe three answers needed: R1a wedges? R1b wedges? R2 wedges?"
  );
}

module.exports = { runGeometrySpike, maxInscribedCrop };
