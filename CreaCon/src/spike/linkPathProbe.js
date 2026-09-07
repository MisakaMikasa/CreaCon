// Layer/file diagnostic: what file does Photoshop say is behind each layer, and
// does CreaCon know anything about it?
//
// Photoshop has no single "list every layer and its file" call - you walk the
// layer tree yourself and pull each layer's descriptor. This does that and prints
// the result, which is the fastest way to see the state of the world when working
// on the registry.
//
// A LINKED smart object reports its source path at smartObject.link._path on the
// full descriptor (confirmed 2026-08-26; NOT smartObjectMore.link, which is
// empty). That is what makes the registry path-keyed: the layer answers "which
// file am I?" itself, so there is no (document, layer id) claim left to go stale.
// Embedded smart objects report no path, which is exactly why the old key existed
// and why those entries are stuck in the legacy bucket.
//
// The dump of every path-shaped value in the descriptor is kept deliberately: it
// is how link._path was found in the first place, and the same sweep would turn
// up a per-layer UUID or anything else Adobe adds later.
//
// Read-only: nothing is modified, nothing is written, no entry is forgotten.
// Diagnosing and repairing are kept separate on purpose - look first.
//
// Unwired by default. Add a panel button when working on the registry:
//   index.html   <sp-button id="btnLinkProbe">🔗</sp-button>
//   panel.js     el("btnLinkProbe").addEventListener("click", () => runLinkPathProbe(say))
const { app, action } = require("photoshop");
const { log, formatError } = require("../log");
const registry = require("../executor/rawRegistry");
const pathKey = require("../executor/pathKey");

// Deliberately loose. A false positive is dismissed by eye; a miss could hide the
// one key that carries something useful.
function looksLikePath(value) {
  if (typeof value !== "string" || value.length < 3) return false;
  return (
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith("file:") ||
    value.startsWith("/Users/") ||
    value.startsWith("/Volumes/") ||
    /[\\/][^\\/]+\.(jpg|jpeg|raf|cr2|cr3|nef|arw|orf|rw2|psd|psb|png|tif|tiff)$/i.test(value)
  );
}

// Every path-shaped string in the structure, with the key route that reaches it
// (e.g. "smartObject.link._path") so a hit is actionable rather than just
// exciting.
function findPaths(node, route = "", out = [], seen = new Set(), depth = 0) {
  if (depth > 12 || node === null || node === undefined) return out;
  if (typeof node === "string") {
    if (looksLikePath(node)) out.push({ route: route || "(root)", value: node });
    return out;
  }
  if (typeof node !== "object" || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) {
    node.forEach((item, i) => findPaths(item, `${route}[${i}]`, out, seen, depth + 1));
    return out;
  }
  for (const [key, value] of Object.entries(node)) {
    findPaths(value, route ? `${route}.${key}` : key, out, seen, depth + 1);
  }
  return out;
}

function flattenLayers(layers, acc = [], depth = 0) {
  for (const layer of layers) {
    acc.push({ layer, depth });
    if (layer.layers && layer.layers.length) flattenLayers(layer.layers, acc, depth + 1);
  }
  return acc;
}

async function layerDescriptor(layerId) {
  const result = await action.batchPlay(
    [{ _obj: "get", _target: [{ _ref: "layer", _id: layerId }] }],
    {}
  );
  return result[0] || {};
}

async function runLinkPathProbe(report) {
  const say = (text) => {
    log("[layer-files]", text);
    report(text);
  };

  const doc = app.activeDocument;
  if (!doc) {
    say("Layer/file report: open a document first.");
    return;
  }

  const photos = await registry.allPhotos();
  const nodes = flattenLayers(doc.layers);
  say(
    `Layer/file report for "${doc.name}"\n` +
      "The registry is keyed by FILE PATH - a layer reports its own file, so there is\n" +
      "no document or layer-id key left to go stale.\n" +
      `${nodes.length} layer(s) here, ${photos.length} photo(s) known to CreaCon in total.`
  );

  const referenced = new Set();
  let withPath = 0;
  let smartObjects = 0;

  for (const { layer, depth } of nodes) {
    const indent = "  ".repeat(depth);
    let descriptor;
    try {
      descriptor = await layerDescriptor(layer.id);
    } catch (err) {
      say(`${indent}id ${layer.id} "${layer.name}" - descriptor unreadable: ${formatError(err)}`);
      continue;
    }

    const so = descriptor.smartObject;
    if (!so) {
      say(`${indent}id ${layer.id} "${layer.name}" - ordinary layer.`);
      continue;
    }
    smartObjects++;

    const link = so.link || {};
    const path = typeof link._path === "string" ? link._path : null;
    const name =
      (descriptor.smartObjectMore || {}).fileReference || so.fileReference || "(none)";
    const hits = findPaths(descriptor);
    log(`[layer-files] FULL DESCRIPTOR id ${layer.id}:`, JSON.stringify(descriptor));

    let verdict;
    if (path) {
      withPath++;
      referenced.add(pathKey.canonical(path));
      const entry = await registry.photoFor(path);
      verdict = entry
        ? `develop-editable (${entry.kind || "kind unknown"}` +
          `${entry.sourcePath && !pathKey.sameFile(entry.sourcePath, path) ? `, working copy of ${entry.sourcePath}` : ""}).`
        : "**not known to CreaCon** - placed outside the plugin, so it can't be develop-edited.";
    } else {
      const legacy = await registry.legacyFor(doc, layer.id);
      verdict = legacy
        ? `EMBEDDED, legacy entry -> ${legacy.filePath}. Still keyed by layer id, so it ` +
          "carries the id-reuse risk that path keying removes elsewhere."
        : "**EMBEDDED and unknown** - no path and no legacy entry; not develop-editable.";
    }

    say(
      `${indent}id ${layer.id} "${layer.name}" - smart object` +
        `${so.linked || so.link ? " (LINKED)" : " (embedded)"}, reports name "${name}".\n` +
        `${indent}   path: ${path || "(none)"}\n` +
        `${indent}   ${verdict}` +
        (hits.length
          ? `\n${indent}   descriptor paths: ` +
            hits.map((h) => `${h.route} = "${h.value}"`).join(" | ")
          : "")
    );
  }

  // Photos this document does not use. Under path keying these are NOT
  // necessarily dead - another document may well use them - so this is a
  // starting point for the cache sweep, not a delete list.
  const unused = photos.filter((p) => !referenced.has(pathKey.canonical(p.filePath)));
  if (unused.length) {
    say(
      `${unused.length} known photo(s) are not used by THIS document. That does not make ` +
        "them dead - another document may use them - it is what a cache sweep would start " +
        "from:\n" +
        unused
          .map(
            (p) =>
              `   ${p.filePath} (${p.kind || "kind unknown"}` +
              `${p.lastSeenAt ? `, last seen ${new Date(p.lastSeenAt).toISOString().slice(0, 10)}` : ", never seen since keying changed"})`
          )
          .join("\n")
    );
  }

  say(
    `${smartObjects} smart object(s), ${withPath} reporting a full path. ` +
      (withPath === smartObjects
        ? "Every one is path-resolvable, so none of them can be mis-identified."
        : `${smartObjects - withPath} report no path and depend on the legacy layer-id key.`)
  );
}

module.exports = { runLinkPathProbe };
