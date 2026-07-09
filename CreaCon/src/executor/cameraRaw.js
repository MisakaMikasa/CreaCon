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
const { sidecarPathFor, serialize, parse } = require("./xmpSidecar");
const registry = require("./rawRegistry");

// DNG excluded: it embeds develop settings inside the file, so the sidecar
// mechanism can't reach it.
const RAW_EXTENSIONS = ["cr2", "cr3", "nef", "arw", "raf", "orf", "rw2"];

async function entryForPath(nativePath) {
  const url = "file:" + nativePath.replace(/\\/g, "/");
  return localFileSystem.getEntryWithUrl(url);
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

// Lets the user pick a raw, places it as an embedded smart object (the exact
// mechanism the spike validated), and registers layerId -> path so later
// applyCameraRaw steps know where the sidecar lives.
// Returns the new layer's name, or null if the user cancelled/picked a non-raw.
async function openRawAsSmartObject(report) {
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

  const token = localFileSystem.createSessionToken(entry);
  let layerName = null;
  await core.executeAsModal(
    async () => {
      await action.batchPlay(
        [
          {
            _obj: "placeEvent",
            null: { _path: token, _kind: "local" },
            _options: { dialogOptions: "dontDisplay" },
          },
        ],
        {}
      );
      const placed = app.activeDocument.activeLayers[0];
      if (!placed) throw new Error("Place succeeded but no active layer found");
      registry.register(placed.id, entry.nativePath);
      layerName = placed.name;
    },
    { commandName: "CreaCon: open RAW" }
  );
  log(`Opened raw as smart object: "${layerName}" <- ${entry.nativePath}`);
  return layerName;
}

// --- per-turn context for the model ------------------------------------------

// All develop-editable raw layers in the doc + their current develop state.
// Fed to the backend so the model (a) knows applyCameraRaw is available and
// (b) can merge onto the CURRENT settings instead of resetting sliders.
// The registry cache is preferred: it's exact and includes masks (which the
// sidecar flat-parse can't recover). Sidecar parse covers first-load only.
async function listRawLayers(doc) {
  const raws = [];
  for (const { name, rawPath, lastSettings } of registry.rawLayersIn(doc)) {
    if (lastSettings) {
      raws.push({ layer: name, settings: lastSettings });
    } else {
      const xml = await readTextFileIfExists(sidecarPathFor(rawPath));
      raws.push({ layer: name, settings: xml ? parse(xml) : null });
    }
  }
  return raws;
}

// --- the plan op ---------------------------------------------------------------

// Runs inside applyEditPlan's executeAsModal like every other handler.
async function applyCameraRaw(params) {
  const doc = app.activeDocument;
  const rawLayers = registry.rawLayersIn(doc);
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
  const sidecarPath = sidecarPathFor(target.rawPath);
  await writeTextFile(sidecarPath, serialize(params.settings));
  log(`Sidecar written: ${sidecarPath}`, params.settings);

  // 2+3. Select the layer, then re-import so ACR re-develops from the sidecar.
  // replaceContents operates on the SELECTED layer, hence the explicit select.
  const entry = await entryForPath(target.rawPath);
  const token = localFileSystem.createSessionToken(entry);
  try {
    await action.batchPlay(
      [
        {
          _obj: "select",
          _target: [{ _ref: "layer", _id: target.id }],
          makeVisible: false,
        },
        {
          _obj: "placedLayerReplaceContents",
          null: { _path: token, _kind: "local" },
          _options: { dialogOptions: "dontDisplay" },
        },
      ],
      {}
    );
  } catch (err) {
    throw new Error(`Camera Raw re-import failed: ${formatError(err)}`);
  }

  // Cache the applied state (incl. masks) as the truth shown to the model.
  registry.updateSettings(target.id, params.settings);
}

module.exports = { applyCameraRaw, openRawAsSmartObject, listRawLayers, RAW_EXTENSIONS };
