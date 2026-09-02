// What CreaCon knows about a photo, keyed by the photo's FILE PATH.
//
// IDENTITY MODEL, and why it changed. This used to be keyed by (document path,
// layer id), because an EMBEDDED smart object does not retain its source path -
// so CreaCon had to remember it. That key was wrong in three ways at once:
// Photoshop REUSES layer ids after a layer is deleted (which once made CreaCon
// write one photo's develop settings into an unrelated photo's sidecar), "Save
// As" changed the document key and silently orphaned every mapping, and an
// unsaved document had no key at all and needed a whole parallel code path.
//
// A LINKED smart object reports its own source path (smartObject.link._path on
// the full layer descriptor - confirmed 2026-08-26). CreaCon has placed linked
// since v0.4, so Photoshop can answer "which file is this layer?" itself. That
// makes the file path the natural key, and this table only has to hold what
// Photoshop does NOT know: which original a working copy came from, the format,
// the last applied settings, and the frame aspect.
//
// Consequences, all of them good: layer-id reuse is structurally impossible
// rather than merely detected, Save As and moving a document are irrelevant,
// unsaved documents need no special case, and two documents using the same photo
// correctly share one develop state.
//
// LEGACY. Smart objects embedded by older versions report no path, so those
// entries are kept in a separate read-only bucket still keyed the old way. They
// carry the id-reuse risk they always had; it cannot be fixed for them, because
// the information needed to fix it is exactly what an embedded SO throws away.
const { log } = require("../log");
const pathKey = require("./pathKey");

const REGISTRY_FILE = "rawRegistry.json";
const STORE_VERSION = 2;

// { version, photos: { [canonicalPath]: entry }, legacy: { [docKey]: { [layerId]: entry } } }
let store = null;
let loadPromise = null;

// uxp is required lazily so this module can be loaded by plain node for tests.
// Everything above the disk layer is pure logic and worth covering; see
// scripts/test-registry.js.
function fileSystem() {
  return require("uxp").storage.localFileSystem;
}

function emptyStore() {
  return { version: STORE_VERSION, photos: {}, legacy: {} };
}

// Field-wise union of two entries for the same file. First non-null wins, so the
// entry seen first keeps its spelling of the path while still gaining anything it
// was missing. `lastSeenAt` takes the later of the two - it answers "when was
// this last in use", and the answer is the most recent sighting.
function mergeEntries(existing, incoming) {
  if (!existing) return incoming;
  const merged = { ...incoming };
  for (const [key, value] of Object.entries(existing)) {
    if (value !== null && value !== undefined) merged[key] = value;
  }
  merged.lastSeenAt = Math.max(existing.lastSeenAt || 0, incoming.lastSeenAt || 0) || null;
  return merged;
}

// Turns any older on-disk shape into the current one. Pure and exported so the
// migration - the one part with real failure modes - is testable.
//
// v1 was { [docKey]: { [layerId]: { rawPath|filePath, ... } } }. Entries with a
// file path become path-keyed photos; entries without one (embedded smart
// objects) keep the old key in `legacy`, which is the only thing that can
// identify them at all.
function migrateStore(raw) {
  if (!raw || typeof raw !== "object") return emptyStore();
  if (raw.version === STORE_VERSION && raw.photos) {
    return { version: STORE_VERSION, photos: raw.photos || {}, legacy: raw.legacy || {} };
  }

  const migrated = emptyStore();
  for (const [docKey, layers] of Object.entries(raw)) {
    if (!layers || typeof layers !== "object" || docKey === "version") continue;
    for (const [layerId, entry] of Object.entries(layers)) {
      if (!entry || typeof entry !== "object") continue;
      const filePath = entry.filePath || entry.rawPath || null;
      const normalized = {
        filePath,
        sourcePath: entry.sourcePath || filePath,
        kind: entry.kind || null,
        lastSettings: entry.lastSettings || null,
        stateXml: entry.stateXml || null,
        aspect: entry.aspect || null,
        lastSeenAt: entry.lastSeenAt || null,
      };
      if (filePath) {
        // Duplicates across documents describe the SAME file and therefore the
        // same develop state, but they need not carry the same FIELDS - one may
        // have the settings, another the state mirror. MERGE them rather than
        // letting the last one win, or migrating quietly drops whichever half
        // the loser was holding.
        const key = pathKey.canonical(filePath);
        migrated.photos[key] = mergeEntries(migrated.photos[key], normalized);
      } else {
        if (!migrated.legacy[docKey]) migrated.legacy[docKey] = {};
        migrated.legacy[docKey][layerId] = normalized;
      }
    }
  }
  const photoCount = Object.keys(migrated.photos).length;
  const legacyCount = Object.values(migrated.legacy).reduce(
    (sum, layers) => sum + Object.keys(layers).length,
    0
  );
  log(
    `rawRegistry: migrated to v${STORE_VERSION} - ${photoCount} photo(s) keyed by path, ` +
      `${legacyCount} legacy embedded entr(ies) kept.`
  );
  return migrated;
}

async function ensureLoaded() {
  if (store) return;
  if (!loadPromise) {
    loadPromise = (async () => {
      let raw = null;
      try {
        const folder = await fileSystem().getDataFolder();
        const entry = await folder.getEntry(REGISTRY_FILE);
        raw = JSON.parse(await entry.read());
      } catch {
        raw = null; // first run / unreadable - start fresh
      }
      const before = raw && raw.version;
      store = migrateStore(raw);
      if (before !== STORE_VERSION) await saveToDisk();
    })();
  }
  await loadPromise;
}

async function saveToDisk() {
  try {
    const folder = await fileSystem().getDataFolder();
    const file = await folder.createFile(REGISTRY_FILE, { overwrite: true });
    await file.write(JSON.stringify(store));
  } catch (err) {
    log("rawRegistry: persistence write failed (registry stays in-memory):", err);
  }
}

// --- photos (path-keyed) ----------------------------------------------------------

// `aspect` is the photo's width/height as placed, before any crop. Mask
// coordinates are normalized to different axis lengths, so converting them
// between the preview and the sensor needs the frame's proportions whenever a
// rotated crop is involved (at CropAngle 0 the aspect cancels out entirely).
// Recorded at import, while the layer is still uncropped.
async function registerPhoto(filePath, options = {}) {
  await ensureLoaded();
  store.photos[pathKey.canonical(filePath)] = {
    filePath,
    // Defaults to filePath so a raw, which has no separate original, needs no
    // special-casing downstream.
    sourcePath: options.sourcePath || filePath,
    kind: options.kind || null,
    lastSettings: null,
    stateXml: null,
    aspect: options.aspect || null,
    lastSeenAt: null,
  };
  await saveToDisk();
}

// What we know about the photo at this path, or null. No document, no layer id:
// the caller got the path from the layer itself, so there is nothing to go stale.
async function photoFor(filePath) {
  await ensureLoaded();
  return store.photos[pathKey.canonical(filePath)] || null;
}

async function updateSettings(filePath, settings) {
  await ensureLoaded();
  const entry = store.photos[pathKey.canonical(filePath)];
  if (entry) {
    entry.lastSettings = settings;
    await saveToDisk();
  }
}

// Mirrors the develop state XML we just wrote. Small (a few KB) and worth
// persisting: with the original still on disk, this is enough to rebuild a
// working copy that has been swept, moved or deleted.
async function updateStateMirror(filePath, xml) {
  await ensureLoaded();
  const entry = store.photos[pathKey.canonical(filePath)];
  if (entry) {
    entry.stateXml = xml || null;
    await saveToDisk();
  }
}

// How stale an on-disk stamp may get before a touch bothers to rewrite the file.
// This fires on every layer walk - once per chat turn - so persisting each time
// would rewrite the registry constantly for a value measured in days. Six hours
// keeps writes to a handful a day while never losing more than six hours of
// evidence, which is nothing against a 90-day grace period.
const TOUCH_PERSIST_MS = 6 * 60 * 60 * 1000;

// Marks a photo as still in use, for the cache sweep to tell a live working copy
// from an abandoned one. Cheap: the caller is already walking the layers.
async function touch(filePath) {
  await ensureLoaded();
  const entry = store.photos[pathKey.canonical(filePath)];
  if (!entry) return false;
  const now = Date.now();
  const stale = !entry.lastSeenAt || now - entry.lastSeenAt > TOUCH_PERSIST_MS;
  entry.lastSeenAt = now;
  // Must reach disk eventually or the sweep sees everything as never-used and
  // proposes deleting files that are in a document open right now.
  if (stale) await saveToDisk();
  return true;
}

async function allPhotos() {
  await ensureLoaded();
  return Object.values(store.photos);
}

async function forgetPhoto(filePath) {
  await ensureLoaded();
  const key = pathKey.canonical(filePath);
  if (store.photos[key]) {
    delete store.photos[key];
    await saveToDisk();
    return true;
  }
  return false;
}

// --- legacy (embedded smart objects placed by older versions) -----------------------

function legacyDocKey(doc) {
  try {
    if (doc.path) return doc.path;
  } catch {
    // path getter throws on freshly created docs - treat as unsaved
  }
  return `unsaved:${doc.id}`;
}

// Embedded smart objects report no path, so these keep the old (document, layer)
// key and its id-reuse risk. Nothing new is ever written here.
async function legacyFor(doc, layerId) {
  await ensureLoaded();
  return (store.legacy[legacyDocKey(doc)] || {})[layerId] || null;
}

async function updateLegacySettings(doc, layerId, settings) {
  await ensureLoaded();
  const entry = (store.legacy[legacyDocKey(doc)] || {})[layerId];
  if (entry) {
    entry.lastSettings = settings;
    await saveToDisk();
  }
}

// --- checkpoints ---------------------------------------------------------------------
//
// Every apply first saves the develop state it is about to overwrite, tagged with
// an id. Restoring is then an EXACT replay of a specific saved state rather than
// "undo the last thing" - which was the old behaviour and was ambiguous the
// moment you did anything after the edit you meant to take back.
//
// SESSION-SCOPED and memory-only, in their own map rather than inside the entries:
// a develop state is tens of KB and the registry file is rewritten on every
// settings update, so persisting a stack of them would bloat it badly. Keeping
// them out of `store` also means saveToDisk no longer has to strip them.
//
// NOTE: this is why the layer-id incident was unrecoverable - a plugin reload
// loses every checkpoint. A durable per-file backup is on the list.
const MAX_CHECKPOINTS = 10;
const checkpoints = new Map(); // canonicalPath -> [{ id, label, at, xml }]
let checkpointSeq = 0;

// xml === null is meaningful: "there was no develop state here", itself a
// restorable state (the photo at camera defaults).
function saveCheckpoint(filePath, xml, label) {
  const key = pathKey.canonical(filePath);
  if (!key) return null;
  const list = checkpoints.get(key) || [];
  const id = `cp${++checkpointSeq}`;
  list.push({ id, label: label || "edit", at: Date.now(), xml: xml === undefined ? null : xml });
  // Oldest out first. Ten deep is far more than anyone unwinds by hand, and it
  // bounds what is a few hundred KB of strings per photo.
  if (list.length > MAX_CHECKPOINTS) list.shift();
  checkpoints.set(key, list);
  return id;
}

// The saved state for one checkpoint, or undefined if it has been dropped -
// which happens once ten newer ones exist, or on a plugin reload.
function checkpointXml(filePath, id) {
  const list = checkpoints.get(pathKey.canonical(filePath));
  if (!list) return undefined;
  const found = list.find((c) => c.id === id);
  return found ? found.xml : undefined;
}

module.exports = {
  STORE_VERSION,
  migrateStore, // exported for tests
  registerPhoto,
  photoFor,
  updateSettings,
  updateStateMirror,
  touch,
  allPhotos,
  forgetPhoto,
  legacyFor,
  updateLegacySettings,
  saveCheckpoint,
  checkpointXml,
};
