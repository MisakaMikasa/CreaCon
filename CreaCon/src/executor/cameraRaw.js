// Camera Raw develop executor - the sidecar-reload path proven by the spike
// (src/spike/acrReloadSpike.js): ACR can't be scripted directly, but it
// re-reads the raw's .xmp sidecar whenever placedLayerReplaceContents
// re-imports the file. So "apply develop settings" =
//   1. write the full desired state into the sidecar (xmpSidecar.serialize)
//   2. select the raw smart-object layer
//   3. replaceContents with the same raw -> ACR re-develops with the new state
const { app, core, action } = require("photoshop");
const { localFileSystem } = require("uxp").storage;
const fs = require("fs");
const { log, formatError } = require("../log");
const {
  sidecarPathFor,
  serialize,
  parse,
  parseFull,
  DEFAULT_GEOMETRY,
} = require("./xmpSidecar");
const geometryMath = require("./geometryMath");
const registry = require("./rawRegistry");

// DNG excluded: it embeds develop settings inside the file, so the sidecar
// mechanism can't reach it.
const RAW_EXTENSIONS = ["cr2", "cr3", "nef", "arw", "raf", "orf", "rw2"];

async function entryForPath(nativePath) {
  const url = "file:" + nativePath.replace(/\\/g, "/");
  return localFileSystem.getEntryWithUrl(url);
}

// Detects whether a smart object layer is LINKED (vs embedded). The truthful
// signal is smartObject.linked on the full layer descriptor - the narrower
// property-get on smartObjectMore.link gives false negatives on genuinely
// linked layers (it never carries link info; verified against real layers).
async function isLinked(layerId) {
  try {
    const info = await action.batchPlay(
      [{ _obj: "get", _target: [{ _ref: "layer", _id: layerId }] }],
      {}
    );
    const so = (info[0] && info[0].smartObject) || {};
    return Boolean(so.linked || so.link);
  } catch (err) {
    log("isLinked failed (treating as embedded):", formatError(err));
    return false;
  }
}

async function writeTextFile(nativePath, text) {
  await fs.writeFile(nativePath, text, { encoding: "utf-8" });
}

async function readTextFileIfExists(nativePath) {
  try {
    return await fs.readFile(nativePath, { encoding: "utf-8" });
  } catch {
    return null;
  }
}

// Best-effort delete (used when the user picks "start fresh" - we remove the old
// sidecar instead of backing it up). Missing file / delete failure is non-fatal.
async function removeFileIfExists(nativePath) {
  try {
    const entry = await entryForPath(nativePath);
    if (entry && entry.delete) await entry.delete();
    return true;
  } catch (err) {
    log("removeFileIfExists: nothing to delete or delete failed:", formatError(err));
    return false;
  }
}

// ============================================================================
// DO NOT REMOVE. This looks like a pointless extra dialog. It is not.
// ============================================================================
//
// Opens the placed raw into Camera Raw once, immediately after import, purely to
// make ACR register the file. Without it, every adjustment the user makes in the
// Camera Raw dialog during an apply is SILENTLY THROWN AWAY.
//
// WHY IT IS NEEDED
// Applying settings works by rewriting the .xmp sidecar and relinking the smart
// object, which makes ACR pop its dialog. Users naturally tweak sliders there.
// But ACR only writes settings back to a sidecar for a file it holds an EDITING
// SESSION for, and the relink dialog does not create one - to ACR that is an
// import, so whatever the user sets applies to that single placement and is
// never persisted. The change shows on canvas, disappears when the layer is next
// opened, and the following apply overwrites it from the sidecar. Nothing errors.
//
// ESTABLISHED BY EXPERIMENT (also recorded in the README):
//   apply -> edit in dialog -> apply -> edit in dialog          =>  lost, lost
//   apply -> edit -> DOUBLE-CLICK layer + OK -> apply -> edit    =>  lost, KEPT
// So it is not a first-apply effect: repeated applies keep failing. What unlocks
// it is one real editing session, and OK-ing with no changes at all is enough.
//
// HOW THIS FIXES IT
// placedLayerEditContents is the scripted equivalent of double-clicking the
// layer, so it creates exactly that session. One dialog at import, and every
// dialog edit for the rest of the file's life is persisted and merged normally.
// Verified working end to end.
//
// COST: one extra Camera Raw dialog when a raw is imported - which doubles as a
// natural place to set a starting look, so it is framed that way to the user.
//
// IF YOU DELETE THIS, nothing will break visibly. Users will simply lose every
// manual Camera Raw adjustment they make during an apply, with no error, and it
// will take a long time to work out why. The `ACR wrote back: YES/NO` line
// logged by reloadRaw() is the detector.
//
// Best-effort: a failure here leaves the import fine, only dialog edits unsafe,
// and says so.
async function establishAcrSession(layerId, report) {
  if (!layerId) return;
  report(
    "Camera Raw will open once now. This is deliberate - it registers the file so " +
      "adjustments you make in the Camera Raw dialog later are actually saved (without " +
      "it they are silently discarded). Set a starting look if you like, or just click OK."
  );
  try {
    await core.executeAsModal(
      async () => {
        await action.batchPlay(
          [
            { _obj: "select", _target: [{ _ref: "layer", _id: layerId }], makeVisible: false },
            { _obj: "placedLayerEditContents", _options: { dialogOptions: "display" } },
          ],
          {}
        );
      },
      { commandName: "CreaCon: register RAW with Camera Raw" }
    );
    log("establishAcrSession: Camera Raw session registered for layer", layerId);
  } catch (err) {
    log("establishAcrSession failed (non-fatal):", formatError(err));
    report(
      "Couldn't open Camera Raw automatically. Edits you make in the Camera Raw dialog " +
        "during an apply may not be saved - double-click the layer once to fix that."
    );
  }
}

// --- ingestion (the panel's "Open RAW" button) -------------------------------

// Lets the user pick a raw, places it as a LINKED smart object, and registers
// layerId -> path so later applyCameraRaw steps know where the sidecar lives.
// askChoice(fileName) -> Promise<"keep"|"fresh"|"cancel"> is called when the
// raw already has develop settings (panel supplies the dialog).
// Returns the new layer's name, or null if the user cancelled/picked a non-raw.
async function openRawAsSmartObject(report, askChoice) {
  const entry = await localFileSystem.getFileForOpening(); // unfiltered: UXP type filters are case-sensitive in some builds
  if (!entry) return null;

  const ext = (entry.nativePath.split(".").pop() || "").toLowerCase();
  if (!RAW_EXTENSIONS.includes(ext)) {
    report(
      ext === "dng"
        ? "DNG files store develop settings internally and can't be developed via sidecar yet - pick a CR2/CR3/NEF/ARW/RAF/ORF/RW2."
        : `".${ext}" isn't a supported raw type (${RAW_EXTENSIONS.join(", ")}).`
    );
    return null;
  }
  if (!app.activeDocument) {
    report("Open any document first - the raw is placed into it.");
    return null;
  }

  // A raw file has exactly ONE develop state (its sidecar). Two layers backed
  // by the same raw would fight over it - later applies would clobber each
  // other on every reload - so refuse instead of corrupting both.
  const already = (await registry.rawLayersIn(app.activeDocument)).find(
    (l) => l.rawPath === entry.nativePath
  );
  if (already) {
    report(
      `This raw is already imported as layer "${already.name}". A raw file has a single ` +
        "develop state, so it can't be graded twice independently - edit that layer, or " +
        "duplicate the raw file on disk to grade a second version."
    );
    return null;
  }

  // Existing develop settings (from a previous CreaCon layer, Lightroom, or
  // manual ACR work): the USER decides at import time - keep them, or start
  // fresh from camera defaults ("new layer = new edit"). Fresh keeps a backup
  // and reports the old settings to the chat so the model can restore them on
  // request. This must happen BEFORE placing - ACR reads the sidecar at place
  // time. askChoice is injected by the panel (it owns the dialog UI).
  const sidecarPath = sidecarPathFor(entry.nativePath);
  const existingXml = await readTextFileIfExists(sidecarPath);
  let previousSettings = null;
  let keptExisting = false;
  const previousHadMasks =
    existingXml !== null && existingXml.includes("MaskGroupBasedCorrections");
  if (existingXml !== null) {
    const fileName = entry.name || entry.nativePath;
    const choice = askChoice ? await askChoice(fileName) : "fresh";
    if (choice === "cancel") {
      report("Import cancelled.");
      return null;
    }
    if (choice === "fresh") {
      // The user chose fresh, so DISCARD the old sidecar outright - no backup
      // file is kept (previous settings are still reported to the chat below so
      // they can be re-applied this session if wanted). Delete the .xmp, then
      // write camera defaults so ACR develops from a known clean state at place.
      previousSettings = parse(existingXml);
      await removeFileIfExists(sidecarPath);
      // DEFAULT_GEOMETRY, not {}: writing any sidecar makes ACR treat it as
      // authoritative and skip the lens correction it enables on a normal
      // import, so an empty one silently ships a distorted, vignetted photo.
      await writeTextFile(sidecarPath, serialize({}, undefined, DEFAULT_GEOMETRY));
    } else {
      // "keep": leave the sidecar untouched; ACR applies it at place time and
      // the per-turn context parses it as the current state.
      keptExisting = true;
    }
  }

  const token = localFileSystem.createSessionToken(entry);
  let layerName = null;
  let placedId = null;
  await core.executeAsModal(
    async () => {
      await action.batchPlay(
        [
          {
            // LINKED, not embedded (spike-verified): a linked raw SO routes
            // manual ACR-dialog edits into the sidecar - the same file this
            // executor reads/writes - so user edits and CreaCon edits merge
            // instead of clobbering. Embedded SOs lock manual edits in a
            // container no script can read. Costs: the raw must stay at its
            // path (a dependency the sidecar mechanism already has) and the
            // PSD isn't self-contained.
            _obj: "placeEvent",
            null: { _path: token, _kind: "local" },
            linked: true,
            _options: { dialogOptions: "dontDisplay" },
          },
        ],
        {}
      );
      const placed = app.activeDocument.activeLayers[0];
      if (!placed) throw new Error("Place succeeded but no active layer found");
      // Record the frame proportions while the layer is still uncropped - mask
      // coordinate conversion needs them once a rotated crop exists.
      await registry.register(
        app.activeDocument,
        placed.id,
        entry.nativePath,
        aspectOf(placed)
      );
      if (!keptExisting) {
        // Fresh import = camera defaults; {} is the accurate develop state.
        // (When keeping existing edits, lastSettings stays null so the
        // per-turn context falls back to parsing the sidecar itself.)
        await registry.updateSettings(app.activeDocument, placed.id, {});
      }
      layerName = placed.name;
      placedId = placed.id;
    },
    { commandName: "CreaCon: open RAW" }
  );
  log(`Opened raw as smart object: "${layerName}" <- ${entry.nativePath}`);

  if (previousSettings !== null) {
    // The settings JSON goes into the chat, so the model can restore them
    // through a normal applyCameraRaw when asked.
    report(
      "This raw had previous develop settings - they were discarded so you start fresh " +
        '(no backup kept). Say "restore the previous edits" to re-apply them from the ' +
        `values below this session. Previous settings: ${JSON.stringify(previousSettings)}` +
        (previousHadMasks
          ? " (they also included local masks, which are not preserved once discarded)."
          : "")
    );
  } else if (keptExisting) {
    report(
      "Kept the raw's existing develop settings (masks included) - they're shown to the " +
        "AI as the current state and further edits merge on top of them."
    );
  }

  // Last, so the import's own messages are on screen before Camera Raw takes
  // over the window.
  await establishAcrSession(placedId, report);
  return layerName;
}

// Width/height of a placed layer, or null if bounds are unreadable (the caller
// then falls back to 3:2, which only matters when a rotated crop exists).
function aspectOf(layer) {
  try {
    const b = layer && layer.bounds;
    if (!b) return null;
    const w = Number(b.right) - Number(b.left);
    const h = Number(b.bottom) - Number(b.top);
    return w > 0 && h > 0 ? w / h : null;
  } catch (err) {
    log("aspectOf failed (falling back to default):", formatError(err));
    return null;
  }
}

// --- mask coordinate space ----------------------------------------------------

// Converts a settings object's mask coordinates between the space the model sees
// (the cropped preview) and the space ACR stores (the full sensor frame).
// `toSensor` false = sensor -> preview (showing), true = preview -> sensor
// (writing). A no-op on uncropped raws, which is the common case.
//
// Only the crop half is applied. A perspective warp also moves masks, but
// undoing it needs the homography ACR computes, and the measured drift is under
// 5% of the frame - inside what the prompt's "feather generously" doctrine
// already absorbs, and not worth the risk of a wrong inversion.
function maskSpace(settings, geometry, aspect, toSensor) {
  const corrections = settings && settings.MaskGroupBasedCorrections;
  if (!Array.isArray(corrections) || !corrections.length) return settings;
  const crop = geometryMath.cropRectOf(geometry);
  if (!crop) return settings;
  return {
    ...settings,
    MaskGroupBasedCorrections: geometryMath.remapCorrections(corrections, toSensor, {
      crop,
      aspect: aspect || 1.5,
    }),
  };
}

// --- per-turn context for the model ------------------------------------------

// All develop-editable raw layers in the doc + their current develop state.
// Fed to the backend so the model (a) knows applyCameraRaw is available and
// (b) can merge onto the CURRENT settings instead of resetting sliders.
// External-change detection: the registry remembers a hash of the sidecar
// content its cached settings correspond to. If the file on disk differs
// (manual ACR edit, Lightroom, ACR's own AI-digest write-back), the sidecar
// is the truth - re-parse it fully (masks included) and adopt it.
async function listRawLayers(doc) {
  const raws = [];
  for (const { name, rawPath, lastSettings, aspect } of await registry.rawLayersIn(doc)) {
    const xml = await readTextFileIfExists(sidecarPathFor(rawPath));
    if (xml === null) {
      // Registered but no sidecar on disk (deleted externally). The last applied
      // state is the best guess left.
      raws.push({ layer: name, settings: lastSettings || null });
      continue;
    }
    // ALWAYS re-parse. There was once a hash-compare fast path here that returned
    // the cached settings when the file hadn't changed; it was removed because it
    // made a wrong cache entry PERMANENT - a writer that cached the wrong
    // coordinate space also stored a matching hash, so the check passed and the
    // file was never re-read. Parsing ~13KB of XML once a turn costs nothing, and
    // the file on disk is the only real source of truth (the user can edit it in
    // ACR or Lightroom behind our back at any time).
    const { settings, geometry } = parseFull(xml);
    // The sidecar holds mask coordinates in SENSOR space; the model reads them
    // off the preview, which is the cropped view. Show it preview coordinates so
    // the numbers it sees match the picture it sees - applyCameraRaw converts
    // back on the way out.
    raws.push({ layer: name, settings: maskSpace(settings, geometry, aspect, false) });
  }
  return raws;
}

// --- shared plumbing (applyCameraRaw + applyGeometry) --------------------------

// Resolves which registered RAW layer a plan step targets.
async function resolveRawTarget(doc, targetLayer) {
  const rawLayers = await registry.rawLayersIn(doc);
  if (rawLayers.length === 0) {
    throw new Error(
      'No CreaCon-opened RAW layer in this document. Use the panel\'s "Open RAW" button first ' +
        "(raw smart objects opened outside CreaCon can't be develop-edited - their file path is unknown)."
    );
  }
  if (targetLayer) {
    const found = rawLayers.find((l) => l.name === targetLayer);
    if (!found) {
      throw new Error(
        `"${targetLayer}" is not a develop-editable RAW layer. Available: ` +
          rawLayers.map((l) => `"${l.name}"`).join(", ")
      );
    }
    return found;
  }
  if (rawLayers.length === 1) return rawLayers[0];
  throw new Error(
    "Multiple RAW layers exist - the plan must set targetLayer to one of: " +
      rawLayers.map((l) => `"${l.name}"`).join(", ")
  );
}

// Re-imports the raw so ACR re-develops it from the sidecar on disk. Two paths:
//  - LINKED layer: relink to the same file (a relink can't embed, and it forces
//    a fresh read of raw + sidecar). placedLayerReplaceContents is NOT used
//    here - it force-embeds the smart object (verified in the wild), after which
//    manual ACR edits and Update-AI-settings write-backs go into the PSD's
//    private container instead of the sidecar.
//  - EMBEDDED layer (legacy imports): replaceContents, the proven path.
// replaceContents operates on the SELECTED layer, hence the explicit select.
// `wroteXml` is what we just put in the sidecar. Passing it makes the reload log
// whether ACR wrote its own version back afterwards.
//
// KEEP THIS - it is the detector for the failure establishAcrSession() exists to
// prevent. A "NO" means ACR is discarding whatever the user does in the apply
// dialog, silently. If that ever starts appearing again, the import-time session
// registration has stopped working.
async function reloadRaw(target, label, wroteXml) {
  const entry = await entryForPath(target.rawPath);
  const wasLinked = await isLinked(target.id);
  try {
    await action.batchPlay(
      [
        { _obj: "select", _target: [{ _ref: "layer", _id: target.id }], makeVisible: false },
        wasLinked
          ? {
              _obj: "placedLayerRelinkToFile",
              null: { _path: localFileSystem.createSessionToken(entry), _kind: "local" },
              _options: { dialogOptions: "dontDisplay" },
            }
          : {
              _obj: "placedLayerReplaceContents",
              null: { _path: localFileSystem.createSessionToken(entry), _kind: "local" },
              _options: { dialogOptions: "dontDisplay" },
            },
      ],
      {}
    );
    if (wasLinked) {
      // Nudge PS to reload the (re)linked content in case relink-to-same-path
      // alone doesn't refresh the render. Best-effort.
      try {
        await action.batchPlay(
          [{ _obj: "placedLayerUpdateAllModified", _options: { dialogOptions: "dontDisplay" } }],
          {}
        );
      } catch (err) {
        log(`${label}: updateAllModified nudge failed (non-fatal):`, formatError(err));
      }
    }
  } catch (err) {
    throw new Error(`Camera Raw re-import failed: ${formatError(err)}`);
  }
  const linkedAfter = await isLinked(target.id);
  log(
    `${label}: re-import via ${wasLinked ? "RELINK" : "replaceContents"}; ` +
      `layer linked after: ${linkedAfter ? "YES" : "NO (embedded - manual-edit merge broken)"}`
  );

  if (wroteXml === undefined) return undefined;
  const after = await readTextFileIfExists(sidecarPathFor(target.rawPath));
  const acrWroteBack = after !== null && after !== wroteXml;
  log(
    `${label}: ACR wrote back: ${acrWroteBack ? "YES" : "NO"} ` +
      `(sidecar ${after === null ? "missing" : `${after.length}b`}, we wrote ${wroteXml.length}b). ` +
      (acrWroteBack
        ? "Any edits made in the dialog are in the file and will be picked up."
        : "Edits made in the dialog were NOT persisted - re-open the layer in ACR to keep them.")
  );
  return acrWroteBack;
}

// --- the plan op ---------------------------------------------------------------

// Runs inside applyEditPlan's executeAsModal like every other handler.
// `opts.skipReload` is set by applyEditPlan when an applyGeometry step follows
// for the same raw: it will re-read this sidecar, fold these settings into its
// own write, and reload once. Saves the user a second Camera Raw dialog.
async function applyCameraRaw(params, opts = {}) {
  const doc = app.activeDocument;
  const target = await resolveRawTarget(doc, params.targetLayer);

  // 1. Sidecar = the complete new develop state (model already merged).
  // Harvest everything the model doesn't manage from the current sidecar
  // first - AI-mask digests (so ACR reuses cached segmentations instead of
  // demanding "Update AI settings"), attrs outside our vocabulary, opaque
  // manual corrections - and carry it into the new write.
  const sidecarPath = sidecarPathFor(target.rawPath);
  const currentXml = await readTextFileIfExists(sidecarPath);
  const current = currentXml ? parseFull(currentXml) : null;
  // Geometry (crop/straighten/perspective/lens) is NOT part of the model's
  // full-state settings - see GEOMETRY_KEYS in xmpSidecar.js. Carry it forward
  // verbatim, or a plain "make it warmer" would silently un-crop the photo.
  // With no sidecar yet this is the FIRST one written for this raw, so seed
  // ACR's import defaults - otherwise the first edit turns lens correction off.
  const geometry = current ? current.geometry : DEFAULT_GEOMETRY;
  // The model authored these against the preview; ACR resolves them against the
  // sensor. Convert before writing (see maskSpace).
  const settings = maskSpace(params.settings, geometry, target.aspect, true);
  const xmlOut = serialize(settings, current ? current.extras : undefined, geometry);
  // Save the bytes we are about to replace, so this exact state can be restored
  // later by id - not "undo the last thing", which stops meaning anything once
  // another edit has happened.
  const checkpoint = await registry.saveCheckpoint(
    doc,
    target.id,
    currentXml,
    "develop settings"
  );
  await writeTextFile(sidecarPath, xmlOut);
  log(`Sidecar written: ${sidecarPath}`, params.settings);

  if (opts.skipReload) {
    log("applyCameraRaw: reload deferred to the applyGeometry step on this raw");
  } else {
    await reloadRaw(target, "applyCameraRaw", xmlOut);
  }

  // Fallback copy of the applied state, in PREVIEW space (what the model was
  // shown and sent). The sidecar on disk is the real source of truth and is
  // re-parsed every turn; this only matters if that file goes missing.
  await registry.updateSettings(doc, target.id, params.settings);
  return { checkpoint, layer: target.name };
}

module.exports = {
  applyCameraRaw,
  openRawAsSmartObject,
  listRawLayers,
  resolveRawTarget,
  reloadRaw,
  maskSpace,
  RAW_EXTENSIONS,
};
