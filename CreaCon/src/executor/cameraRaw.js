// Camera Raw develop executor - the write-then-reimport path proven by spike
// (src/spike/acrReloadSpike.js, src/spike/jpegAcrSpike.js): ACR can't be
// scripted directly, but it re-reads a photo's develop state whenever the smart
// object is re-imported. So "apply develop settings" =
//   1. write the full desired state (xmpSidecar.serialize)
//   2. select the photo's smart-object layer
//   3. relink to the same file -> ACR re-develops with the new state
//
// WHERE that state is written depends on the format and is the one thing this
// module does not decide for itself - developStore.js owns it. A raw keeps its
// settings in a .xmp sidecar beside the photo; a JPEG keeps them INSIDE the
// image. Both hold the same crs: vocabulary, so everything here is format-blind.
// See docs/jpeg-develop-design.md.
const { app, core, action } = require("photoshop");
const { localFileSystem } = require("uxp").storage;
const { log, formatError } = require("../log");
const { serialize, parse, parseFull, DEFAULT_GEOMETRY } = require("./xmpSidecar");
const geometryMath = require("./geometryMath");
const registry = require("./rawRegistry");
const store = require("./developStore");
const pathKey = require("./pathKey");
const photoCache = require("./photoCache");

// Kept as an export for callers that still speak in raw extensions; the real
// support test is store.isSupported, which also covers JPEG.
const RAW_EXTENSIONS = store.RAW_EXTENSIONS;

const entryForPath = store.entryForPath;

// Detects whether a smart object layer is LINKED (vs embedded). The truthful
// signal is smartObject.linked on the full layer descriptor - the narrower
// property-get on smartObjectMore.link gives false negatives on genuinely
// linked layers (it never carries link info; verified against real layers).
//
// smartObject.LINK, on the same full descriptor, is a different thing entirely
// and DOES carry the source path at `_path` - see layerFileInfo below.
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

// Develop-state IO goes through the store so raws and JPEGs behave identically
// here. readState returns null when the photo has no develop settings at all,
// which is distinct from "settings that happen to be neutral".
const readState = store.readState;
const writeState = store.writeState;

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

// Removes a working copy that was created for an import which then did not
// happen. Only ever called with a path this function's caller just created, and
// only for JPEG - a raw's filePath is the user's own photo.
async function discardWorkingCopy(kind, filePath) {
  if (kind !== store.KIND_JPEG) return;
  try {
    await store.removeFileIfExists(filePath);
    log(`Discarded unused working copy: ${filePath}`);
  } catch (err) {
    log("Couldn't discard unused working copy (harmless, it will be swept):", formatError(err));
  }
}

// --- ingestion (the panel's "Open photo" button) -----------------------------

// Lets the user pick a photo, places it as a LINKED smart object, and registers
// layerId -> path so later applyCameraRaw steps know where its develop state
// lives. Handles both raws and JPEGs; the only difference is that a JPEG is
// copied into the photo cache first, because its settings live inside the image
// and we will not write to a user's original (docs/jpeg-develop-design.md 3.2).
//
// askChoice(fileName) -> Promise<"keep"|"fresh"|"cancel"> is called when the
// photo already has develop settings (panel supplies the dialog).
// Returns the new layer's name, or null if the user cancelled/picked a bad file.
async function openRawAsSmartObject(report, askChoice) {
  const picked = await localFileSystem.getFileForOpening(); // unfiltered: UXP type filters are case-sensitive in some builds
  if (!picked) return null;

  const sourcePath = picked.nativePath;
  const kind = store.kindOf(sourcePath);
  if (!kind) {
    const ext = (sourcePath.split(".").pop() || "").toLowerCase();
    report(
      ext === "dng"
        ? "DNG files store develop settings internally in a way CreaCon can't reach yet - pick a CR2/CR3/NEF/ARW/RAF/ORF/RW2 or a JPEG."
        : `".${ext}" isn't a supported photo type (${RAW_EXTENSIONS.join(", ")}, jpg, jpeg).`
    );
    return null;
  }
  if (!app.activeDocument) {
    report("Open any document first - the photo is placed into it.");
    return null;
  }

  // A RAW file has exactly ONE develop state (its sidecar), so two layers backed
  // by the same raw would clobber each other on every reload - refuse instead of
  // corrupting both. A JPEG has no such limit here: it is copied per import, so
  // grading the same photo two ways in one document just works.
  if (kind === store.KIND_RAW) {
    const already = (await photoLayersIn(app.activeDocument)).find((l) =>
      pathKey.sameFile(l.filePath, sourcePath)
    );
    if (already) {
      report(
        `This raw is already imported as layer "${already.name}". A raw file has a single ` +
          "develop state, so it can't be graded twice independently - edit that layer, or " +
          "duplicate the raw file on disk to grade a second version."
      );
      return null;
    }
  }

  // For a JPEG, everything from here on operates on OUR copy. The user's file is
  // read once, at this line, and never written to.
  let filePath = sourcePath;
  if (kind === store.KIND_JPEG) {
    try {
      filePath = await photoCache.createWorkingCopy(sourcePath);
    } catch (err) {
      report(`Couldn't prepare a working copy of that photo: ${formatError(err)}`);
      return null;
    }
  }

  // Existing develop settings (from a previous CreaCon layer, Lightroom, or
  // manual ACR work): the USER decides at import time - keep them, or start
  // fresh from camera defaults ("new layer = new edit"). Fresh discards them and
  // reports the old values to the chat so the model can restore them on request.
  // This must happen BEFORE placing - ACR reads the state at place time.
  // askChoice is injected by the panel (it owns the dialog UI).
  const existingXml = await readState(filePath);
  let previousSettings = null;
  let keptExisting = false;
  const previousHadMasks =
    existingXml !== null && existingXml.includes("MaskGroupBasedCorrections");
  if (existingXml !== null) {
    const fileName = picked.name || sourcePath;
    const choice = askChoice ? await askChoice(fileName) : "fresh";
    if (choice === "cancel") {
      // The working copy was made before this dialog (ACR reads develop state at
      // place time, so it has to exist first). Cancelling must not leave an
      // orphaned copy behind - nothing else would ever clean it up.
      await discardWorkingCopy(kind, filePath);
      report("Import cancelled.");
      return null;
    }
    if (choice === "fresh") {
      // Discard outright - no backup file is kept (the previous settings are
      // still reported to the chat below, so they can be re-applied this
      // session if wanted).
      previousSettings = parse(existingXml);
      await store.clearState(filePath);
      if (kind === store.KIND_RAW) {
        // DEFAULT_GEOMETRY, not {}: writing any sidecar makes ACR treat it as
        // authoritative and skip the lens correction it enables on a normal
        // import, so an empty one silently ships a distorted, vignetted photo.
        // A JPEG has no such default profile, and clearing its packet already
        // leaves the file exactly as the camera wrote it - writing a state back
        // would only put settings into a file that had none.
        await writeState(filePath, serialize({}, undefined, DEFAULT_GEOMETRY));
      }
    } else {
      // "keep": leave the state untouched; ACR applies it at place time and the
      // per-turn context parses it as the current state.
      keptExisting = true;
    }
  }

  const token = localFileSystem.createSessionToken(await entryForPath(filePath));
  let layerName = null;
  let placedId = null;
  try {
    await core.executeAsModal(
      async () => {
        await action.batchPlay(
          [
            {
              // LINKED, not embedded (spike-verified): a linked SO routes manual
              // ACR-dialog edits into the same place this executor reads and
              // writes, so user edits and CreaCon edits merge instead of
              // clobbering. Embedded SOs lock manual edits in a container no
              // script can read, and do not even retain their source path.
              // Costs: the file must stay put, and the PSD isn't self-contained.
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
        await registry.registerPhoto(filePath, {
          sourcePath,
          kind,
          aspect: aspectOf(placed),
        });
        if (!keptExisting) {
          // Fresh import = camera defaults; {} is the accurate develop state.
          // (When keeping existing edits, lastSettings stays null so the
          // per-turn context falls back to parsing the file itself.)
          await registry.updateSettings(filePath, {});
        }
        layerName = placed.name;
        placedId = placed.id;
      },
      { commandName: "CreaCon: open photo" }
    );
  } catch (err) {
    // Placement failed after the copy was made - same orphan problem as cancel.
    await discardWorkingCopy(kind, filePath);
    throw err;
  }
  log(`Opened ${kind} as smart object: "${layerName}" <- ${filePath}`);

  if (kind === store.KIND_JPEG) {
    // Say this once, at import. Two things people get wrong otherwise: that we
    // are editing their file (we are not), and that the working copy is a
    // shareable edited photo (it is not - the pixels are the original's, and
    // only Adobe apps apply the settings riding along in its metadata).
    report(
      "Imported as a JPEG develop layer. Your original is untouched - edits go to a working " +
        "copy CreaCon keeps, and they're saved as you go, so nothing is lost if you close " +
        "without saving. That copy only looks edited in Photoshop, Lightroom and Bridge, so " +
        "export from Photoshop as usual when you want a finished image to share."
    );
  }

  if (previousSettings !== null) {
    // The settings JSON goes into the chat, so the model can restore them
    // through a normal applyCameraRaw when asked.
    report(
      "This photo had previous develop settings - they were discarded so you start fresh " +
        '(no backup kept). Say "restore the previous edits" to re-apply them from the ' +
        `values below this session. Previous settings: ${JSON.stringify(previousSettings)}` +
        (previousHadMasks
          ? " (they also included local masks, which are not preserved once discarded)."
          : "")
    );
  } else if (keptExisting) {
    report(
      "Kept the photo's existing develop settings (masks included) - they're shown to the " +
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

// All develop-editable photo layers in the doc + their current develop state.
// Fed to the backend so the model (a) knows applyCameraRaw is available and
// (b) can merge onto the CURRENT settings instead of resetting sliders.
// External-change detection: the state on disk (sidecar for a raw, embedded
// packet for a JPEG) is re-read every turn, so a manual ACR edit, a Lightroom
// edit, or ACR's own AI-digest write-back is picked up and adopted.
// The OTHER layer names this same photo appears under. Duplicating a linked
// smart object gives two layers on one file; they share one develop state, so
// the model has to be told they are one photo and not two - otherwise it plans
// two different looks for the same file and the second silently wins.
function duplicates(entry) {
  const names = entry.aliases || [entry.name];
  return names.filter((n) => n !== entry.name);
}

async function listRawLayers(doc) {
  const raws = [];
  for (const entry of await photoLayersIn(doc)) {
    const { name, filePath, lastSettings, aspect } = entry;
    // The model is told which format each layer is, because it decides how hard
    // the photo can be pushed - a JPEG is 8-bit and already clipped, so
    // raw-sized exposure and white-balance moves fall apart on it. Older
    // registry entries predate `kind`, so fall back to the path.
    const kind = entry.kind || store.kindOf(filePath) || store.KIND_RAW;
    const xml = await readState(filePath);
    if (xml === null) {
      // Registered but no develop state readable - the file was deleted or moved
      // externally. The last applied state is the best guess left. (For a JPEG
      // this is also the signal that the working copy needs rebuilding; the
      // apply path handles that, and a read-only context turn should not.)
      raws.push({ layer: name, kind, aliases: duplicates(entry), settings: lastSettings || null });
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
    // The stored state holds mask coordinates in SENSOR space; the model reads
    // them off the preview, which is the cropped view. Show it preview
    // coordinates so the numbers it sees match the picture it sees -
    // applyCameraRaw converts back on the way out.
    raws.push({
      layer: name,
      kind,
      aliases: duplicates(entry),
      settings: maskSpace(settings, geometry, aspect, false),
    });
  }
  return raws;
}

// --- resolving layers to photos ---------------------------------------------------
//
// Photoshop is the authority on WHICH FILE a layer holds; the registry only adds
// what Photoshop does not know (the original a working copy came from, the
// format, the last applied settings, the frame aspect).
//
// That ordering is the whole point. The registry used to be asked "what file is
// layer 6?", and its answer could be left over from a DIFFERENT layer 6 that had
// since been deleted - Photoshop reuses layer ids. That once wrote one photo's
// develop settings into an unrelated photo's sidecar. Now the layer is asked
// first and its answer is the key, so there is no claim left to be stale.

// What Photoshop says is behind a layer: { path, name }, either possibly null.
// A LINKED smart object carries its source path at smartObject.link._path on the
// full layer descriptor (confirmed 2026-08-26). Note smartObject.link, NOT
// smartObjectMore.link - the latter really is empty, and is what the older note
// at the top of this file refers to.
async function layerFileInfo(layerId) {
  try {
    const result = await action.batchPlay(
      [{ _obj: "get", _target: [{ _ref: "layer", _id: layerId }] }],
      {}
    );
    const descriptor = result[0] || {};
    const so = descriptor.smartObject || {};
    const link = so.link || {};
    const path = typeof link._path === "string" && link._path ? link._path : null;
    const name =
      (descriptor.smartObjectMore || {}).fileReference || so.fileReference || null;
    return {
      isSmartObject: Boolean(descriptor.smartObject),
      path,
      name: typeof name === "string" && name ? name : null,
    };
  } catch (err) {
    log("layerFileInfo failed:", formatError(err));
    return { isSmartObject: false, path: null, name: null };
  }
}

function flattenLayers(layers, acc = []) {
  for (const layer of layers) {
    acc.push(layer);
    if (layer.layers && layer.layers.length) flattenLayers(layer.layers, acc);
  }
  return acc;
}

// Every develop-editable photo layer in the document.
//
// Two layers can be linked to the SAME file - duplicating a linked smart object
// does exactly that - and one file has one develop state, so they are one photo
// with two names. They are collapsed into a single entry carrying `aliases`, and
// resolveRawTarget accepts any of those names. Reporting them separately would
// invite the model to write two different states to one file.
async function photoLayersIn(doc) {
  const out = [];
  const byPath = new Map();
  for (const layer of flattenLayers(doc.layers)) {
    const info = await layerFileInfo(layer.id);
    if (!info.isSmartObject) continue;

    if (info.path) {
      const entry = await registry.photoFor(info.path);
      if (!entry) continue; // a smart object CreaCon never imported
      const key = pathKey.canonical(info.path);
      const already = byPath.get(key);
      if (already) {
        already.aliases.push(layer.name);
        continue;
      }
      const resolved = {
        id: layer.id,
        name: layer.name,
        aliases: [layer.name],
        filePath: entry.filePath,
        sourcePath: entry.sourcePath,
        kind: entry.kind || store.kindOf(entry.filePath) || store.KIND_RAW,
        lastSettings: entry.lastSettings,
        stateXml: entry.stateXml,
        aspect: entry.aspect,
        legacy: false,
      };
      byPath.set(key, resolved);
      out.push(resolved);
      continue;
    }

    // No path: an embedded smart object from a version that placed embedded.
    // These still carry the layer-id risk, which cannot be fixed for them - the
    // information needed to fix it is what embedding throws away.
    const legacy = await registry.legacyFor(doc, layer.id);
    if (!legacy || !legacy.filePath) continue;
    if (info.name && info.name.toLowerCase() !== pathKey.baseName(legacy.filePath).toLowerCase()) {
      log(
        `photoLayersIn: skipping legacy entry for layer "${layer.name}" (id ${layer.id}) - it ` +
          `contains "${info.name}" but the entry names "${legacy.filePath}".`
      );
      continue;
    }
    out.push({
      id: layer.id,
      name: layer.name,
      aliases: [layer.name],
      filePath: legacy.filePath,
      sourcePath: legacy.sourcePath || legacy.filePath,
      kind: legacy.kind || store.kindOf(legacy.filePath) || store.KIND_RAW,
      lastSettings: legacy.lastSettings,
      stateXml: legacy.stateXml,
      aspect: legacy.aspect,
      legacy: true,
    });
  }
  return out;
}

// --- shared plumbing (applyCameraRaw + applyGeometry) --------------------------

// Resolves which registered photo layer a plan step targets. Raw and JPEG layers
// are interchangeable here - both are develop-editable and both resolve the same
// way; only how hard they can be pushed differs, and that is the model's problem.
async function resolveRawTarget(doc, targetLayer) {
  const photoLayers = await photoLayersIn(doc);
  if (photoLayers.length === 0) {
    throw new Error(
      'No CreaCon-opened photo layer in this document. Use the panel\'s photo button first ' +
        "(smart objects opened outside CreaCon can't be develop-edited - their file path is unknown)."
    );
  }
  // Match against EVERY name this photo goes by, not just the first. Duplicating
  // a linked smart object gives two layers on one file, and the document's layer
  // list (which the model also sees) shows both names - so the plan can legitimately
  // target either one.
  const names = (entry) => entry.aliases || [entry.name];
  const describe = (entry) =>
    names(entry).length > 1
      ? `"${entry.name}" (also duplicated as ${names(entry).slice(1).map((n) => `"${n}"`).join(", ")})`
      : `"${entry.name}"`;

  if (targetLayer) {
    const found = photoLayers.find((l) => names(l).includes(targetLayer));
    if (!found) {
      throw new Error(
        `"${targetLayer}" is not a develop-editable photo layer. Available: ` +
          photoLayers.map(describe).join(", ")
      );
    }
    return found;
  }
  if (photoLayers.length === 1) return photoLayers[0];
  throw new Error(
    "Multiple photo layers exist - the plan must set targetLayer to one of: " +
      photoLayers.map(describe).join(", ")
  );
}

// Re-imports the photo so ACR re-develops it from the state on disk. Two paths:
//  - LINKED layer: relink to the same file (a relink can't embed, and it forces
//    a fresh read of the photo and its settings). placedLayerReplaceContents is
//    NOT used here - it force-embeds the smart object (verified in the wild),
//    after which manual ACR edits and Update-AI-settings write-backs go into the
//    PSD's private container instead of the file we read.
//  - EMBEDDED layer (legacy imports): replaceContents, the proven path.
// replaceContents operates on the SELECTED layer, hence the explicit select.
// `wroteXml` is what we just wrote. Passing it makes the reload log whether ACR
// wrote its own version back afterwards.
//
// KEEP THIS - it is the detector for the failure establishAcrSession() exists to
// prevent. A "NO" means ACR is discarding whatever the user does in the apply
// dialog, silently. If that ever starts appearing again, the import-time session
// registration has stopped working.
async function reloadRaw(target, label, wroteXml) {
  const entry = await entryForPath(target.filePath);
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
  const after = await readState(target.filePath);
  const acrWroteBack = after !== null && after !== wroteXml;
  log(
    `${label}: ACR wrote back: ${acrWroteBack ? "YES" : "NO"} ` +
      `(state ${after === null ? "missing" : `${after.length}b`}, we wrote ${wroteXml.length}b). ` +
      (acrWroteBack
        ? "Any edits made in the dialog are in the file and will be picked up."
        : "Edits made in the dialog were NOT persisted - re-open the layer in ACR to keep them.")
  );
  return acrWroteBack;
}

// --- the plan op ---------------------------------------------------------------

// A working copy that has gone missing - swept from the cache, moved, deleted -
// is a rebuild, not an error: its pixels are byte-identical to the user's
// original and the registry mirrors the settings. Rebuild silently and carry on.
// Raws are skipped: the file IS the user's photo, so there is nothing to rebuild
// it from, and the caller should fail loudly instead.
async function ensureFileAvailable(target) {
  if (target.kind !== store.KIND_JPEG) return;
  if (await photoCache.exists(target.filePath)) return;
  log(`applyCameraRaw: working copy missing (${target.filePath}) - rebuilding from source`);
  await photoCache.rebuildFrom(target.sourcePath, target.filePath, target.stateXml);
}

// Runs inside applyEditPlan's executeAsModal like every other handler.
// `opts.skipReload` is set by applyEditPlan when an applyGeometry step follows
// for the same photo: it will re-read this state, fold these settings into its
// own write, and reload once. Saves the user a second Camera Raw dialog.
async function applyCameraRaw(params, opts = {}) {
  const doc = app.activeDocument;
  const target = await resolveRawTarget(doc, params.targetLayer);
  await ensureFileAvailable(target);

  // 1. The write = the complete new develop state (model already merged).
  // Harvest everything the model doesn't manage from the current state first -
  // AI-mask digests (so ACR reuses cached segmentations instead of demanding
  // "Update AI settings"), attrs outside our vocabulary, opaque manual
  // corrections - and carry it into the new write.
  const currentXml = await readState(target.filePath);
  const current = currentXml ? parseFull(currentXml) : null;
  // Geometry (crop/straighten/perspective/lens) is NOT part of the model's
  // full-state settings - see GEOMETRY_KEYS in xmpSidecar.js. Carry it forward
  // verbatim, or a plain "make it warmer" would silently un-crop the photo.
  // With no state yet this is the FIRST write for this photo, so seed ACR's
  // import defaults - otherwise the first edit turns lens correction off.
  const geometry = current ? current.geometry : DEFAULT_GEOMETRY;
  // The model authored these against the preview; ACR resolves them against the
  // sensor. Convert before writing (see maskSpace).
  const settings = maskSpace(params.settings, geometry, target.aspect, true);
  const xmlOut = serialize(settings, current ? current.extras : undefined, geometry);
  // Save what we are about to replace, so this exact state can be restored later
  // by id - not "undo the last thing", which stops meaning anything once another
  // edit has happened. Checkpoints hold the settings XML only, a few KB, never
  // the image: cheap enough to keep ten deep per layer for both formats.
  const checkpoint = registry.saveCheckpoint(target.filePath, currentXml, "develop settings");
  await writeState(target.filePath, xmlOut);
  log(`Develop state written to ${store.describeLocation(target.filePath)}`, params.settings);

  if (opts.skipReload) {
    log("applyCameraRaw: reload deferred to the applyGeometry step on this photo");
  } else {
    await reloadRaw(target, "applyCameraRaw", xmlOut);
  }

  // Fallback copy of the applied state, in PREVIEW space (what the model was
  // shown and sent). The state on disk is the real source of truth and is
  // re-parsed every turn; this only matters if that file goes missing.
  await registry.updateSettings(target.filePath, params.settings);
  // The mirror is what makes a missing working copy rebuildable, so it has to
  // track every write - see ensureFileAvailable.
  await registry.updateStateMirror(target.filePath, xmlOut);
  return { checkpoint, layer: target.name };
}

module.exports = {
  applyCameraRaw,
  openRawAsSmartObject,
  listRawLayers,
  resolveRawTarget,
  photoLayersIn,
  layerFileInfo,
  reloadRaw,
  ensureFileAvailable,
  maskSpace,
  RAW_EXTENSIONS,
};
