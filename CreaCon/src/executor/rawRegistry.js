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
      if (!docKey.startsWith("unsaved:")) persistable[docKey] = layers;
    }
    const folder = await localFileSystem.getDataFolder();
    const file = await folder.createFile(REGISTRY_FILE, { overwrite: true });
    await file.write(JSON.stringify(persistable));
  } catch (err) {
    log("rawRegistry: persistence write failed (registry stays in-memory):", err);
  }
}

async function register(doc, layerId, rawPath) {
  await ensureLoaded();
  const key = docKeyFor(doc);
  if (!store[key]) store[key] = {};
  store[key][layerId] = { rawPath, lastSettings: null };
  await saveToDisk();
}

// Caches the model-visible settings after a successful apply (or after
// adopting an externally-edited sidecar), plus a hash of the sidecar content
// those settings correspond to. When the sidecar on disk no longer matches
// syncedHash, someone else (the user in ACR, Lightroom) edited it - the
// executor then re-parses the file and calls this again to adopt it.
async function updateSettings(doc, layerId, settings, syncedHash) {
  await ensureLoaded();
  const entry = (store[docKeyFor(doc)] || {})[layerId];
  if (entry) {
    entry.lastSettings = settings;
    if (syncedHash !== undefined) entry.syncedHash = syncedHash;
    await saveToDisk();
  }
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
        syncedHash: entry.syncedHash,
      });
    }
  }
  return out;
}

module.exports = { register, updateSettings, rawLayersIn };
