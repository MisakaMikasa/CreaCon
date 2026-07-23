const CHAT_URL = "http://localhost:8000/chat";
const AUTO_ACCEPT_URL = "http://localhost:8000/acr/auto-accept";
const { log } = require("./log");

// Drives the Camera Raw dialog (Update All + OK) once it opens. This call is
// synchronous on the backend and BLOCKS until it finishes (~15-25s) - start it
// concurrently with opening the ACR dialog (don't await this before that),
// then Promise.all both. Returns status so the caller can report accurately
// instead of guessing whether it worked.
async function runAcrAutoAccept() {
  const response = await fetch(AUTO_ACCEPT_URL, { method: "POST" });
  if (!response.ok) throw new Error(`auto-accept failed: ${await response.text()}`);
  return response.json(); // { window_seen, sent_hotkey, sent_enter, confirmed_closed }
}

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

async function sendChat(messages, options = {}) {
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
    response = await fetch(CHAT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        image_base64: imageBase64,
        layer_names: layerContext.layer_names,
        selected_layers: layerContext.selected_layers,
        camera_raw: layerContext.camera_raw || null,
        aggressiveness: options.aggressiveness ?? null,
      }),
      ...(controller ? { signal: controller.signal } : {}),
    });
  } finally {
    if (abortTimer) clearTimeout(abortTimer);
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Backend returned ${response.status}: ${detail}`);
  }

  return response.json();
}

module.exports = { sendChat, capturePreviewImage, runAcrAutoAccept };
