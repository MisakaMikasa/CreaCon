// What the bridge needs to read out of Photoshop.
//
// The chat call that used to live here is gone: the desktop app talks to the
// backend directly, and the backend asks this plugin for context over the
// bridge when it needs it. Port discovery went with it - bridge.js does its
// own, because it is the thing holding the connection.

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
module.exports = { capturePreviewImage, readLayerContext };
