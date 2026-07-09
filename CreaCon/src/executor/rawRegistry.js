// Maps smart-object layer IDs -> the raw file path they were placed from.
//
// Why this exists: Photoshop does NOT store an embedded smart object's source
// path anywhere a script can read (smartObjectMore.fileReference is just the
// file NAME). The sidecar-develop executor needs the real path (that's where
// the .xmp lives), so CreaCon remembers it for every raw IT places (the
// "Open RAW" button in the panel). Raw smart objects created outside CreaCon
// (e.g. via ACR's own "Open as Smart Object") can't be develop-edited - there
// is no way to find their sidecar.
//
// In-memory only: reloading the plugin clears it (re-open the raw via the
// button). Keyed by layer ID, so renaming the layer doesn't break it.

const entries = new Map(); // layerId -> { rawPath, lastSettings }

function register(layerId, rawPath) {
  entries.set(layerId, { rawPath, lastSettings: null });
}

// Caches the full settings object (including masks) after a successful apply.
// This is the source of truth for "current develop settings" shown to the
// model: CreaCon is the sole sidecar writer, and parsing nested mask XML back
// out of the sidecar is avoidable work. Caveat: edits made manually in the
// ACR dialog aren't reflected here until the next CreaCon apply.
function updateSettings(layerId, settings) {
  const entry = entries.get(layerId);
  if (entry) entry.lastSettings = settings;
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
function rawLayersIn(doc) {
  const out = [];
  for (const layer of flattenLayers(doc.layers)) {
    const entry = entries.get(layer.id);
    if (entry) {
      out.push({
        id: layer.id,
        name: layer.name,
        rawPath: entry.rawPath,
        lastSettings: entry.lastSettings,
      });
    }
  }
  return out;
}

module.exports = { register, updateSettings, rawLayersIn };
