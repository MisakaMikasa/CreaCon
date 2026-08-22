// Maps smart-object layers -> the raw file path they were placed from, plus
// the last develop settings CreaCon applied. Persistent across sessions.
//
// Why this exists: Photoshop does NOT store an embedded smart object's source
// path anywhere a script can read (smartObjectMore.fileReference is just the
// file NAME). The sidecar-develop executor needs the real path (that's where
// the .xmp lives), so CreaCon remembers it for every raw IT places (the
// "Open RAW" button). Raw smart objects created outside CreaCon can't be
// develop-edited - there is no way to find their sidecar.
//
// Identity model: entries are keyed by DOCUMENT PATH -> LAYER ID. Layer IDs
// are unique within a document and stable across save/reopen (stored in the
// PSD), so multiple raws in one document can't be confused. Persisted to
// rawRegistry.json in the plugin's data folder. Caveats: an unsaved document
// has no path, so its entries live under a session-only key (migrated to the
// real path automatically once the doc is saved and any registry read runs);
// "Save As" to a new path orphans the mapping - re-import the raw then.
const { localFileSystem } = require("uxp").storage;
const { log } = require("../log");

const REGISTRY_FILE = "rawRegistry.json";

// { [docKey]: { [layerId]: { rawPath, lastSettings } } }
let store = null;
let loadPromise = null;

function docKeyFor(doc) {
  try {
    // Document.path is "" until the document has been saved.
    if (doc.path) return doc.path;
  } catch {
    // path getter can throw for freshly created docs - treat as unsaved
  }
  return `unsaved:${doc.id}`;
}

async function ensureLoaded() {
  if (store) return;
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const folder = await localFileSystem.getDataFolder();
        const entry = await folder.getEntry(REGISTRY_FILE);
        store = JSON.parse(await entry.read());
      } catch {
        store = {}; // first run / unreadable file - start fresh
      }
    })();
  }
  await loadPromise;
}

async function saveToDisk() {
  try {
    // Session-only keys aren't worth persisting: unsaved doc ids don't
    // survive the session.
    const persistable = {};
    for (const [docKey, layers] of Object.entries(store)) {
      if (docKey.startsWith("unsaved:")) continue;
      // Checkpoints are whole sidecars (tens of KB each) and this file is
      // rewritten on every settings update - keep them in memory only. They are
      // session-scoped by design; see saveCheckpoint.
      persistable[docKey] = Object.fromEntries(
        Object.entries(layers).map(([layerId, entry]) => {
          const { checkpoints, ...rest } = entry;
          return [layerId, rest];
        })
      );
    }
    const folder = await localFileSystem.getDataFolder();
    const file = await folder.createFile(REGISTRY_FILE, { overwrite: true });
    await file.write(JSON.stringify(persistable));
  } catch (err) {
    log("rawRegistry: persistence write failed (registry stays in-memory):", err);
  }
}

// `aspect` is the raw's width/height as placed, before any crop. Mask
// coordinates are normalized to different axis lengths, so converting them
// between the preview and the sensor needs the frame's proportions whenever a
// rotated crop is involved (at CropAngle 0 the aspect cancels out entirely).
// Recorded once at import because the placed layer is uncropped at that moment.
async function register(doc, layerId, rawPath, aspect) {
  await ensureLoaded();
  const key = docKeyFor(doc);
  if (!store[key]) store[key] = {};
  store[key][layerId] = { rawPath, lastSettings: null, aspect: aspect || null };
  await saveToDisk();
}

// Records the model-visible settings after a successful apply. This is only a
// FALLBACK for when the sidecar has gone missing from disk - the file itself is
// the source of truth and is re-parsed every turn. (A hash was stored here once,
// to let listRawLayers skip re-parsing when the file was unchanged; that fast
// path is gone, because it could pin a bad cache entry in place permanently.)
async function updateSettings(doc, layerId, settings) {
  await ensureLoaded();
  const entry = (store[docKeyFor(doc)] || {})[layerId];
  if (entry) {
    entry.lastSettings = settings;
    delete entry.syncedHash; // drop the field from registries written earlier
    await saveToDisk();
  }
}

// --- checkpoints ----------------------------------------------------------------
//
// Every apply first saves the sidecar bytes it is about to overwrite, tagged with
// an id. Restoring is then an EXACT replay of a specific saved state rather than
// "undo the last thing" - which was the old behaviour and was ambiguous the
// moment you did anything after the edit you meant to take back.
//
// SESSION-SCOPED and memory-only. A sidecar is tens of KB and the registry file
// is rewritten on every settings update, so persisting a stack of them would
// bloat it badly. Photoshop's own history is gone by the next session anyway.
const MAX_CHECKPOINTS = 10;
let checkpointSeq = 0;

// xml === null is meaningful: "there was no sidecar here", itself a restorable
// state (the raw at camera defaults).
async function saveCheckpoint(doc, layerId, xml, label) {
  await ensureLoaded();
  const entry = (store[docKeyFor(doc)] || {})[layerId];
  if (!entry) return null;
  if (!entry.checkpoints) entry.checkpoints = [];
  const id = `cp${++checkpointSeq}`;
  entry.checkpoints.push({
    id,
    label: label || "edit",
    at: Date.now(),
    xml: xml === undefined ? null : xml,
  });
  // Oldest out first. Ten deep is far more than anyone unwinds by hand, and it
  // bounds what is a few hundred KB of strings per layer.
  if (entry.checkpoints.length > MAX_CHECKPOINTS) entry.checkpoints.shift();
  return id;
}

// The saved sidecar for one checkpoint, or undefined if it has been dropped -
// which happens once ten newer ones exist, or on a plugin reload.
async function checkpointXml(doc, layerId, id) {
  await ensureLoaded();
  const entry = (store[docKeyFor(doc)] || {})[layerId];
  if (!entry || !entry.checkpoints) return undefined;
  const found = entry.checkpoints.find((c) => c.id === id);
  return found ? found.xml : undefined;
}


function flattenLayers(layers, acc = []) {
  for (const layer of layers) {
    acc.push(layer);
    if (layer.layers && layer.layers.length) flattenLayers(layer.layers, acc);
  }
  return acc;
}

// Registered raw layers that still exist in the given document, with their
// CURRENT names (rename-safe). Order matches the layer stack.
async function rawLayersIn(doc) {
  await ensureLoaded();
  const key = docKeyFor(doc);

  // The doc was saved since its raws were registered: move its session-only
  // bucket under the real path so the entries survive future sessions.
  const unsavedKey = `unsaved:${doc.id}`;
  if (key !== unsavedKey && store[unsavedKey]) {
    store[key] = { ...(store[key] || {}), ...store[unsavedKey] };
    delete store[unsavedKey];
    await saveToDisk();
  }

  const layers = store[key] || {};
  const out = [];
  for (const layer of flattenLayers(doc.layers)) {
    const entry = layers[layer.id];
    if (entry) {
      out.push({
        id: layer.id,
        name: layer.name,
        rawPath: entry.rawPath,
        lastSettings: entry.lastSettings,
        aspect: entry.aspect || null,
      });
    }
  }
  return out;
}

module.exports = {
  register,
  updateSettings,
  rawLayersIn,
  saveCheckpoint,
  checkpointXml,
};
