// The backend picks the first free port from this list, so the plugin has to
// find it rather than assume one. /ping identifies a port as CreaCon's and
// hands back the access token; anything else answering there is not us.
//
// This list must match PORT_CANDIDATES in backend/main.py AND the network
// domains in manifest.json - UXP refuses to fetch a host:port it was not
// declared with, so an undeclared port fails before it is ever tried.
const PORT_CANDIDATES = [8000, 8731, 8732, 8733, 8734, 8735];

// Resolved once per session and reused; a backend restart on a different port
// is picked up by clearing this on the next failure.
let backend = null;

async function findBackend(force) {
  if (backend && !force) return backend;
  for (const port of PORT_CANDIDATES) {
    const base = `http://localhost:${port}`;
    try {
      const res = await fetch(`${base}/ping`, { method: "GET" });
      if (!res.ok) continue;
      const info = await res.json();
      if (info && info.app === "creacon") {
        backend = { base, token: info.token || "" };
        log(`Backend found on ${base} (v${info.version})`);
        return backend;
      }
      log(`Port ${port} answered but is not CreaCon - skipping.`);
    } catch (err) {
      // Nothing listening, or it is not speaking HTTP. Both mean "not here".
    }
  }
  throw new Error(
    `CreaCon backend not found on ports ${PORT_CANDIDATES.join(", ")}. ` +
      "Start it with: python main.py (from the backend folder)."
  );
}
const { log } = require("./log");

// Exports a small JPEG preview of the current document so the backend can
// send it to the AI as vision context. Best-effort: if it fails for any
// reason, we fall back to a text-only instruction rather than blocking.
async function capturePreviewImage() {
  try {
    const { app, core } = require("photoshop");
    const { localFileSystem, formats } = require("uxp").storage;
    const doc = app.activeDocument;

    const tempFolder = await localFileSystem.getTemporaryFolder();
    const file = await tempFolder.createFile("creacon-preview.jpg", { overwrite: true });

    // saveAs modifies document state, so it must run inside a modal scope -
    // calling it directly throws "only allowed from inside a modal scope".
    await core.executeAsModal(
      async () => {
        await doc.saveAs.jpg(file, { quality: 6 }, true);
      },
      { commandName: "CreaCon: export preview" }
    );

    const buffer = await file.read({ format: formats.binary });
    return uint8ArrayToBase64(new Uint8Array(buffer));
  } catch (err) {
    console.warn("CreaCon: could not capture a preview image, continuing text-only.", err);
    return null;
  }
}

function uint8ArrayToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// The AI needs to know what layers exist so it references real names (for
// renameLayer/setLayerOpacity/createGroup/addMask targets) instead of guessing
// "Layer 1", and which are currently selected so the user can point at a target
// by selecting it in the Layers panel. Top layer first, matching panel order.
// Also reports develop-editable RAW smart objects (CreaCon-opened ones) with
// their current sidecar settings, so the model can route global tone/color to
// applyCameraRaw and merge onto the current state instead of resetting it.
async function readLayerContext() {
  try {
    const { app } = require("photoshop");
    const { listRawLayers } = require("./executor/cameraRaw");
    const doc = app.activeDocument;
    const context = {
      layer_names: doc.layers.map((l) => l.name),
      selected_layers: doc.activeLayers.map((l) => l.name),
    };
    const raws = await listRawLayers(doc);
    if (raws.length) context.camera_raw = { raws };
    return context;
  } catch (err) {
    console.warn("CreaCon: could not read layer context.", err);
    return { layer_names: [], selected_layers: [] };
  }
}

// Sends the full conversation (array of {role, content}) plus a fresh preview
// image and layer context. Returns { reply, edit_plan } - edit_plan is null
// when the assistant just talked and didn't propose edits.
// Resolves to `fallback` if `promise` doesn't settle within ms. Needed because
// executeAsModal QUEUES (potentially forever) while any Photoshop dialog is
// open - without this, an open ACR/error dialog freezes the panel on
// "Thinking…" via the preview export.
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

async function sendChat(messages) {
  const imageBase64 = await withTimeout(capturePreviewImage(), 15000, null);
  if (imageBase64 === null) log("Preview capture skipped (timeout or failure) - text-only turn.");
  const layerContext = await withTimeout(readLayerContext(), 10000, { layer_names: [], selected_layers: [] });
  log("Layer context ->", layerContext);

  // Abort a hung backend call instead of "Thinking…" forever (LLM turns can
  // legitimately take a while - keep this generous).
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const abortTimer = controller ? setTimeout(() => controller.abort(), 120000) : null;

  let response;
  try {
    const be = await findBackend();
    response = await fetch(`${be.base}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CreaCon-Token": be.token,
      },
      body: JSON.stringify({
        messages,
        image_base64: imageBase64,
        layer_names: layerContext.layer_names,
        selected_layers: layerContext.selected_layers,
        camera_raw: layerContext.camera_raw || null,
      }),
      ...(controller ? { signal: controller.signal } : {}),
    });
  } finally {
    if (abortTimer) clearTimeout(abortTimer);
  }

  if (!response.ok) {
    const detail = await response.text();
    // A stale token (config.json regenerated between sessions) reads as 401.
    // Drop the cached backend so the next turn re-probes and picks it up.
    if (response.status === 401) backend = null;
    throw new Error(`Backend returned ${response.status}: ${detail}`);
  }

  return response.json();
}

module.exports = { sendChat, capturePreviewImage, readLayerContext, findBackend };
