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
  hashText,
  hasUncomputedAiMasks,
} = require("./xmpSidecar");
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
  let backupPath = null;
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
      // Timestamped so repeated fresh imports never destroy older backups
      // (the oldest one is often the most precious - original LR edits).
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      backupPath = `${sidecarPath}.creacon-prev-${stamp}`;
      await writeTextFile(backupPath, existingXml);
      previousSettings = parse(existingXml);
      await writeTextFile(sidecarPath, serialize({}));
    } else {
      // "keep": leave the sidecar untouched; ACR applies it at place time and
      // the per-turn context parses it as the current state.
      keptExisting = true;
    }
  }

  const token = localFileSystem.createSessionToken(entry);
  let layerName = null;
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
      await registry.register(app.activeDocument, placed.id, entry.nativePath);
      if (!keptExisting) {
        // Fresh import = camera defaults; {} is the accurate develop state.
        // (When keeping existing edits, lastSettings stays null so the
        // per-turn context falls back to parsing the sidecar itself.)
        await registry.updateSettings(app.activeDocument, placed.id, {});
      }
      layerName = placed.name;
    },
    { commandName: "CreaCon: open RAW" }
  );
  log(`Opened raw as smart object: "${layerName}" <- ${entry.nativePath}`);

  if (previousSettings !== null) {
    // The settings JSON goes into the chat, so the model can restore them
    // through a normal applyCameraRaw when asked.
    report(
      "This raw had previous develop settings - they were set aside so you start fresh " +
        `(backup: ${backupPath}). Say "restore the previous edits" to bring ` +
        `them back. Previous settings: ${JSON.stringify(previousSettings)}` +
        (previousHadMasks
          ? " (they also included local masks, which live only in the backup file for now)."
          : "")
    );
  } else if (keptExisting) {
    report(
      "Kept the raw's existing develop settings (masks included) - they're shown to the " +
        "AI as the current state and further edits merge on top of them."
    );
  }
  return layerName;
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
  for (const { id, name, rawPath, lastSettings, syncedHash } of await registry.rawLayersIn(doc)) {
    const xml = await readTextFileIfExists(sidecarPathFor(rawPath));
    if (xml === null) {
      raws.push({ layer: name, settings: lastSettings || null });
      continue;
    }
    const currentHash = hashText(xml);
    if (lastSettings && syncedHash === currentHash) {
      raws.push({ layer: name, settings: lastSettings }); // fast path: nothing changed
      continue;
    }
    const { settings } = parseFull(xml);
    await registry.updateSettings(doc, id, settings, currentHash);
    raws.push({ layer: name, settings });
  }
  return raws;
}

// --- the plan op ---------------------------------------------------------------

// Runs inside applyEditPlan's executeAsModal like every other handler.
async function applyCameraRaw(params) {
  const doc = app.activeDocument;
  const rawLayers = await registry.rawLayersIn(doc);
  if (rawLayers.length === 0) {
    throw new Error(
      'No CreaCon-opened RAW layer in this document. Use the panel\'s "Open RAW" button first ' +
        "(raw smart objects opened outside CreaCon can't be develop-edited - their file path is unknown)."
    );
  }

  let target;
  if (params.targetLayer) {
    target = rawLayers.find((l) => l.name === params.targetLayer);
    if (!target) {
      throw new Error(
        `"${params.targetLayer}" is not a develop-editable RAW layer. Available: ` +
          rawLayers.map((l) => `"${l.name}"`).join(", ")
      );
    }
  } else if (rawLayers.length === 1) {
    target = rawLayers[0];
  } else {
    throw new Error(
      "Multiple RAW layers exist - the plan must set targetLayer to one of: " +
        rawLayers.map((l) => `"${l.name}"`).join(", ")
    );
  }

  // 1. Sidecar = the complete new develop state (model already merged).
  // Harvest everything the model doesn't manage from the current sidecar
  // first - AI-mask digests (so ACR reuses cached segmentations instead of
  // demanding "Update AI settings"), attrs outside our vocabulary, opaque
  // manual corrections - and carry it into the new write.
  const sidecarPath = sidecarPathFor(target.rawPath);
  const currentXml = await readTextFileIfExists(sidecarPath);
  const extras = currentXml ? parseFull(currentXml).extras : undefined;
  // Computed BEFORE writing: does this plan touch any AI mask that ACR has
  // never computed (no preserved digest)? A mask whose identity is unchanged
  // from a prior apply keeps its digest and needs no recompute - only a
  // genuinely new/changed AI mask does. Lets the caller skip re-opening
  // Camera Raw when nothing actually needs it (see hasUncomputedAiMasks doc).
  const needsAiMaskCompute = hasUncomputedAiMasks(params.settings, extras);
  const xmlOut = serialize(params.settings, extras);
  await writeTextFile(sidecarPath, xmlOut);
  log(`Sidecar written: ${sidecarPath}`, params.settings, "needsAiMaskCompute:", needsAiMaskCompute);

  // 2+3. Select the layer, then re-import so ACR re-develops from the sidecar.
  // replaceContents operates on the SELECTED layer, hence the explicit select.
  // Re-import so ACR re-develops from the new sidecar. Two paths:
  //  - LINKED layer: relink to the same file (a relink can't embed, and it
  //    forces a fresh read of raw + sidecar). placedLayerReplaceContents is
  //    NOT used here - it force-embeds the smart object (verified in the
  //    wild), after which manual ACR edits and Update-AI-settings write-backs
  //    go into the PSD's private container instead of the sidecar.
  //  - EMBEDDED layer (legacy imports): replaceContents, the proven path.
  const entry = await entryForPath(target.rawPath);
  const wasLinked = await isLinked(target.id);
  try {
    await action.batchPlay(
      [
        {
          _obj: "select",
          _target: [{ _ref: "layer", _id: target.id }],
          makeVisible: false,
        },
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
        log("applyCameraRaw: updateAllModified nudge failed (non-fatal):", formatError(err));
      }
    }
  } catch (err) {
    throw new Error(`Camera Raw re-import failed: ${formatError(err)}`);
  }

  const linkedAfter = await isLinked(target.id);
  log(
    `applyCameraRaw: re-import via ${wasLinked ? "RELINK" : "replaceContents"}; ` +
      `layer linked after: ${linkedAfter ? "YES" : "NO (embedded - manual-edit merge broken)"}`
  );

  // Cache the applied state (incl. masks) + the hash of what we wrote, so
  // any future divergence on disk is recognized as an external edit.
  await registry.updateSettings(doc, target.id, params.settings, hashText(xmlOut));

  return { needsAiMaskCompute, targetLayer: target.name };
}

// Opens the given (or sole) registered RAW layer in the Camera Raw dialog via
// Edit Contents. The batchPlay call BLOCKS until the dialog closes - the
// backend's /acr/auto-accept worker must be armed BEFORE calling this, so it
// can drive the dialog (Ctrl+Shift+U, Enter) while we're suspended here.
// On OK, ACR writes the computed AI-mask digests to the sidecar.
async function openInAcrDialog(layerName) {
  const doc = app.activeDocument;
  const rawLayers = await registry.rawLayersIn(doc);
  const target = layerName ? rawLayers.find((l) => l.name === layerName) : rawLayers[0];
  if (!target) throw new Error("No registered RAW layer to open in Camera Raw");
  await core.executeAsModal(
    async () => {
      await action.batchPlay(
        [
          { _obj: "select", _target: [{ _ref: "layer", _id: target.id }], makeVisible: false },
          { _obj: "placedLayerEditContents" }, // opens the ACR modal; returns when it closes
        ],
        {}
      );
    },
    { commandName: "CreaCon: update AI masks" }
  );
}

module.exports = {
  applyCameraRaw,
  openRawAsSmartObject,
  openInAcrDialog,
  listRawLayers,
  RAW_EXTENSIONS,
};
