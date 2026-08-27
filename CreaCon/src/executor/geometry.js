// Crop / straighten / perspective, via the same sidecar-then-relink path as
// applyCameraRaw. Two rungs, both a single sidecar write and therefore a single
// Camera Raw dialog:
//
//   STRAIGHTEN  HasCrop + CropAngle + a FULL-FRAME crop rect. ACR inscribes the
//               rotated rectangle itself, so no transparent wedges and no crop
//               for us to compute. The angle is fully previewable beforehand,
//               and the cost is closed-form (1 deg = 5% of a 3:2 frame, 3 deg
//               = 14%, 5 deg = 21%).
//
//   UPRIGHT     PerspectiveUpright=1 (auto) + a full-frame rect +
//               CropConstrainToWarp. ACR fits a homography from the image
//               content, so the result cannot be known until it has run. It
//               hides its own wedges by ZOOMING - but only up to a point, past
//               which corners show through. Afterwards ACR writes the matrix
//               into the sidecar, which is what lets this report what happened.
//
// The report is the point: the user consented to a correction, not to losing a
// quarter of the frame, so every apply comes back with what it cost.
const { app } = require("photoshop");
const { log, formatError } = require("../log");
const {
  serialize,
  parseFull,
  parseGeometry,
  activeUprightTransform,
  withoutUprightCache,
  DEFAULT_GEOMETRY,
} = require("./xmpSidecar");
const geometryMath = require("./geometryMath");
const registry = require("./rawRegistry");
const store = require("./developStore");
const { resolveRawTarget, reloadRaw, maskSpace, ensureFileAvailable } = require("./cameraRaw");

const UPRIGHT_MODES = { off: 0, auto: 1, level: 2, vertical: 3, full: 4 };

// A straighten past this is almost never accidental, and costs over a third of
// the frame. The model is told to stay well under it; this is the backstop.
const MAX_AUTO_ANGLE = 10;

// Develop-state IO through the store, so geometry works on a JPEG (settings
// inside the image) exactly as it does on a raw (settings in a sidecar).
const readState = store.readState;
const writeState = store.writeState;

function pct(fraction) {
  return `${Math.round(fraction * 100)}%`;
}

// Builds the geometry block to write. Starts from what is already on the raw so
// unrelated state (lens profile, an existing crop the user made by hand) is
// preserved, then applies only what this step asked for.
function nextGeometry(current, params) {
  const next = { ...(current || DEFAULT_GEOMETRY) };

  if (params.lensProfile !== undefined) next.LensProfileEnable = !!params.lensProfile;

  const wantsUpright = params.upright && params.upright !== "off";
  const wantsAngle = typeof params.rotate === "number" && params.rotate !== 0;
  const wantsCrop = params.crop && typeof params.crop === "object";

  if (params.upright !== undefined) {
    next.PerspectiveUpright = UPRIGHT_MODES[params.upright] ?? 0;
  }

  if (wantsAngle) {
    const angle = Math.max(-MAX_AUTO_ANGLE, Math.min(MAX_AUTO_ANGLE, params.rotate));
    if (angle !== params.rotate) {
      log(`applyGeometry: clamped rotate ${params.rotate} -> ${angle} (max ${MAX_AUTO_ANGLE} deg)`);
    }
    next.CropAngle = angle;
  }

  // Any geometry at all needs HasCrop plus a rectangle: CropConstrainToWarp and
  // CropAngle both operate ON a crop, and with none set ACR has nothing to
  // constrain and renders the transparent wedges raw.
  if (wantsUpright || wantsAngle || wantsCrop) {
    const hadCrop = !!(current && current.HasCrop);
    next.HasCrop = true;
    if (wantsCrop) {
      // An explicit rectangle replaces whatever was there - that is the point.
      const c = params.crop;
      next.CropLeft = typeof c.left === "number" ? c.left : 0;
      next.CropTop = typeof c.top === "number" ? c.top : 0;
      next.CropRight = typeof c.right === "number" ? c.right : 1;
      next.CropBottom = typeof c.bottom === "number" ? c.bottom : 1;
    } else if (!hadCrop) {
      // No crop yet: full frame, so ACR has something to constrain.
      next.CropLeft = 0;
      next.CropTop = 0;
      next.CropRight = 1;
      next.CropBottom = 1;
    }
    // else: KEEP the existing rectangle. A straighten or an upright must not
    // silently un-crop the photo - the user's framing is a decision they already
    // made, and CropConstrainToWarp shrinks whatever rectangle is there to fit
    // the warp, so an existing crop works just as well as a full-frame one.
    next.CropConstrainToUnitSquare = true;
    if (wantsUpright) next.CropConstrainToWarp = true;
    if (!wantsAngle && next.CropAngle === undefined) next.CropAngle = 0;
  }

  return next;
}

// Everything the user should be told about what just happened. Read from the
// sidecar ACR wrote back, so these are measurements rather than predictions.
function reportFor(xmlAfter, geometry, aspect) {
  const report = { wedges: false, retained: 1, drift: 0, correctiveCrop: null };

  const crop = geometryMath.cropRectOf(geometry);
  if (crop) {
    report.retained = (crop.right - crop.left) * (crop.bottom - crop.top);
  }

  const H = xmlAfter ? activeUprightTransform(xmlAfter) : null;
  if (H) {
    const coverage = geometryMath.frameCoverage(H);
    report.wedges = !coverage.covered;
    report.uncovered = coverage.uncovered;
    report.drift = geometryMath.driftStats(H, aspect || 1.5).max;
    if (report.wedges) {
      const fix = geometryMath.correctiveCrop(H);
      report.correctiveCrop = fix.crop;
      report.retainedAfterFix = fix.retained;
    }
  }
  return report;
}

// Human-readable summary, pushed into the chat so both the user and (next turn)
// the model know what the correction cost.
function describe(report) {
  const parts = [];
  if (report.retained < 0.999) parts.push(`kept ${pct(report.retained)} of the frame`);
  if (report.drift > 0.01) {
    parts.push(`existing masks shifted up to ${pct(report.drift)} of the frame`);
  }
  if (report.wedges) {
    parts.push(
      `the correction leaves empty corners - removing them would keep ` +
        `${pct(report.retainedAfterFix)} of the frame`
    );
  }
  return parts.length ? parts.join("; ") : "no measurable loss";
}

// --- the plan op ---------------------------------------------------------------

async function applyGeometry(params) {
  const doc = app.activeDocument;
  const target = await resolveRawTarget(doc, params.targetLayer);
  await ensureFileAvailable(target);

  const currentXml = await readState(target.filePath);
  const current = currentXml ? parseFull(currentXml) : null;

  const geometry = nextGeometry(current ? current.geometry : DEFAULT_GEOMETRY, params);

  // ACR caches its computed Upright per mode, keyed by a digest that covers the
  // SETTINGS but not the image - two different photos here produced identical
  // digests. So it cannot notice a stale transform, and carrying one across a
  // geometry change would replay a fit made for a different state.
  const extras = current ? withoutUprightCache(current.extras) : undefined;

  const xmlOut = serialize(current ? current.settings : {}, extras, geometry);
  const checkpoint = await registry.saveCheckpoint(
    doc,
    target.id,
    currentXml,
    params.upright && params.upright !== "off" ? "perspective correction" : "crop / straighten"
  );
  await writeState(target.filePath, xmlOut);
  log(`applyGeometry: state written to ${store.describeLocation(target.filePath)}`, geometry);

  await reloadRaw(target, "applyGeometry", xmlOut);

  // Re-read: an Upright writes its computed matrix (and possibly a constrained
  // crop) back, and that write-back is the only source of truth for what the
  // correction actually did.
  const xmlAfter = await readState(target.filePath);
  const finalGeometry = xmlAfter ? parseGeometry(xmlAfter) : geometry;
  const report = reportFor(xmlAfter, finalGeometry, target.aspect);
  report.summary = describe(report);
  // Carried back to the panel so its restore button targets THIS state rather
  // than whatever happened to be applied most recently.
  report.checkpoint = checkpoint;
  report.layer = target.name;

  // Stored in PREVIEW space, matching everything else that writes here - it is
  // only a fallback for a missing state file, but a mismatched space would be a
  // silent wrong answer rather than an error.
  await registry.updateSettings(
    doc,
    target.id,
    maskSpace(current ? current.settings : {}, finalGeometry, target.aspect, false)
  );
  // Mirror what ACR ended up with, not what we asked for: an Upright rewrites
  // the state, and a rebuild has to restore the corrected version.
  await registry.updateStateMirror(doc, target.id, xmlAfter || xmlOut);
  log(`applyGeometry: ${report.summary}`);
  return report;
}

// --- checkpoints (panel action, not a model op) ---------------------------------

// Puts a photo back to a specific saved state, by id. Exact, because it replays
// the stored settings rather than re-deriving what they used to be.
//
// By ID, not "the last one": a card in the chat refers to one particular edit,
// and "undo the most recent apply" would take back something else entirely once
// anything has happened since. Deliberately not in the schema - restoring should
// be one click, not a plan to approve a second time.
async function restoreCheckpoint(checkpointId, targetLayer) {
  const doc = app.activeDocument;
  const target = await resolveRawTarget(doc, targetLayer);
  const previous = await registry.checkpointXml(doc, target.id, checkpointId);
  if (previous === undefined) {
    throw new Error(
      "That restore point is gone - checkpoints last for the session and only the " +
        "ten most recent per layer are kept."
    );
  }
  await ensureFileAvailable(target);

  // Restoring is itself an edit, so snapshot what it replaces. Without this,
  // going back would be a one-way trip.
  await registry.saveCheckpoint(
    doc,
    target.id,
    await readState(target.filePath),
    "before restore"
  );
  let restoredXml = previous;
  if (previous === null) {
    // There was no develop state before: the closest restore is ACR's import
    // defaults. (For a JPEG that is genuinely "as the camera wrote it", since
    // clearing leaves no packet at all - but writing defaults is harmless and
    // keeps one code path.)
    restoredXml = serialize({}, undefined, DEFAULT_GEOMETRY);
  }
  await writeState(target.filePath, restoredXml);
  await reloadRaw(target, "restoreCheckpoint");

  // Same as applyGeometry: cache in PREVIEW space, using the geometry that has
  // just been restored.
  const restored = previous === null ? null : parseFull(previous);
  await registry.updateSettings(
    doc,
    target.id,
    restored ? maskSpace(restored.settings, restored.geometry, target.aspect, false) : {}
  );
  await registry.updateStateMirror(doc, target.id, restoredXml);
  // The checkpoint is NOT consumed: restoring is itself an edit, so it saved a
  // checkpoint of its own, and going back and forth between two states has to
  // stay possible.
  log(`restoreCheckpoint: "${target.name}" restored to ${checkpointId}`);
  return target.name;
}

// describe() and nextGeometry() are deliberately NOT exported. They were, for
// testability - but this module requires "photoshop" at load, so it cannot be
// required from plain node anyway. The genuinely testable geometry lives in
// geometryMath.js, which has no host dependencies and is covered by
// scripts/test-geometry.js.
module.exports = { applyGeometry, restoreCheckpoint };
