// Layer/file diagnostic: what does Photoshop say each layer's file is, what does
// the registry CLAIM it is, and do the two agree?
//
// Photoshop has no single "list every layer and its file" call. You enumerate the
// layer tree yourself and pull each layer's descriptor. This does that, and puts
// three views side by side:
//
//   PHOTOSHOP   what the layer descriptor reports - the file NAME via
//               smartObjectMore.fileReference (confirmed available; it is what
//               cameraRaw.verifiedPhotoLayers checks against), plus anything
//               path-shaped found ANYWHERE in the descriptor. That last part is
//               the open question: if a full path is exposed, orphan detection
//               and Save As recovery both get much easier, and the registry stops
//               being a single point of failure.
//   REGISTRY    the (document, layer id) -> file mapping CreaCon persists
//   VERDICT     agree / mismatch / unregistered / can't tell
//
// It also lists registry entries whose layer is GONE. Those are invisible to
// rawLayersIn (it only returns entries it can match to a live layer), so they
// accumulate silently - and a dead entry is what captured a reused layer id and
// made CreaCon write one photo's settings into another photo's sidecar.
//
// Read-only: nothing is modified, nothing is written, no entry is forgotten.
// Diagnosing and repairing are kept separate on purpose - look first.
const { app, action } = require("photoshop");
const { log, formatError } = require("../log");
const registry = require("../executor/rawRegistry");

// Deliberately loose. A false positive is dismissed by eye; a miss could hide
// the one key that carries the path.
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
// (e.g. "smartObject.link.path") so a hit is actionable rather than just exciting.
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

function baseNameOf(path) {
  return (path || "").split(/[\\/]/).pop().toLowerCase();
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

  const entries = await registry.entriesFor(doc);
  const byLayerId = new Map(entries.map((e) => [e.layerId, e]));
  const nodes = flattenLayers(doc.layers);
  say(
    `Layer/file report for "${doc.name}"\n` +
      `Registry key: ${registry.docKeyOf(doc)}\n` +
      `${nodes.length} layer(s) in the document, ${entries.length} registry entr(ies).`
  );

  const seenLayerIds = new Set();
  let pathHits = 0;
  let mismatches = 0;

  for (const { layer, depth } of nodes) {
    seenLayerIds.add(layer.id);
    const indent = "  ".repeat(depth);
    let descriptor;
    try {
      descriptor = await layerDescriptor(layer.id);
    } catch (err) {
      say(`${indent}id ${layer.id} "${layer.name}" - descriptor unreadable: ${formatError(err)}`);
      continue;
    }

    const so = descriptor.smartObject;
    const more = descriptor.smartObjectMore || {};
    const claimed = byLayerId.get(layer.id);
    const reported = more.fileReference || (so || {}).fileReference || null;

    // Only smart objects can carry a file, but an unregistered smart object is
    // worth showing too - that is what the spike layers were.
    if (!so && !claimed) {
      say(`${indent}id ${layer.id} "${layer.name}" - ordinary layer.`);
      continue;
    }

    const hits = findPaths(descriptor);
    pathHits += hits.length;
    log(`[layer-files] FULL DESCRIPTOR id ${layer.id}:`, JSON.stringify(descriptor));

    let verdict;
    if (!claimed) {
      verdict = "**UNREGISTERED** - CreaCon cannot develop this layer.";
    } else if (!reported) {
      verdict =
        `registry claims "${baseNameOf(claimed.filePath)}" but Photoshop reports no file ` +
        "name - **CAN'T VERIFY** (the mapping is trusted by default).";
    } else if (baseNameOf(claimed.filePath) === reported.toLowerCase()) {
      verdict = `registry agrees (${claimed.kind || "kind unknown"}).`;
    } else {
      mismatches++;
      verdict =
        `**MISMATCH** - registry claims "${baseNameOf(claimed.filePath)}". ` +
        "Editing this layer would write to the WRONG photo; it is dropped on next use.";
    }

    say(
      `${indent}id ${layer.id} "${layer.name}" - smart object` +
        `${so && (so.linked || so.link) ? " (LINKED)" : " (embedded)"}, ` +
        `Photoshop reports file: ${reported ? `"${reported}"` : "(none)"}. ${verdict}` +
        (hits.length
          ? `\n${indent}   **FULL PATH EXPOSED:** ` +
            hits.map((h) => `${h.route} = "${h.value}"`).join(" | ")
          : `\n${indent}   no full path anywhere in the descriptor.`)
    );
  }

  // Entries whose layer is gone. These are the ones that accumulate unseen and
  // can capture a reused id later.
  const dead = entries.filter((e) => !seenLayerIds.has(e.layerId));
  if (dead.length) {
    say(
      `**${dead.length} DEAD registry entr(ies)** - their layer no longer exists in this ` +
        "document, but they persist in rawRegistry.json and will match any future layer that " +
        "reuses the id:\n" +
        dead
          .map((e) => `   id ${e.layerId} -> ${e.filePath} (${e.kind || "kind unknown"})`)
          .join("\n")
    );
  } else if (entries.length) {
    say("No dead registry entries for this document.");
  }

  say(
    (pathHits > 0
      ? "**A full path IS exposed by the layer descriptor** (see the routes above). Orphan " +
        "detection can use it directly, and Save As can re-derive its mapping instead of " +
        "orphaning the layer."
      : "**No full path is exposed on any layer** - only the file name. Name checking stays " +
        "the verification method, and the PSD's own linked-file table (already proven " +
        "readable on disk) is the route to full paths.") +
      (mismatches ? ` ${mismatches} layer(s) are mapped to the wrong file.` : "")
  );
}

module.exports = { runLinkPathProbe };
