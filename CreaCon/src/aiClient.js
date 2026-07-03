const CHAT_URL = "http://localhost:8000/chat";
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
function readLayerContext() {
  try {
    const { app } = require("photoshop");
    const doc = app.activeDocument;
    return {
      layer_names: doc.layers.map((l) => l.name),
      selected_layers: doc.activeLayers.map((l) => l.name),
    };
  } catch (err) {
    console.warn("CreaCon: could not read layer context.", err);
    return { layer_names: [], selected_layers: [] };
  }
}

// Sends the full conversation (array of {role, content}) plus a fresh preview
// image and layer context. Returns { reply, edit_plan } - edit_plan is null
// when the assistant just talked and didn't propose edits.
async function sendChat(messages) {
  const imageBase64 = await capturePreviewImage();
  const layerContext = readLayerContext();
  log("Layer context ->", layerContext);

  const response = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages,
      image_base64: imageBase64,
      layer_names: layerContext.layer_names,
      selected_layers: layerContext.selected_layers,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Backend returned ${response.status}: ${detail}`);
  }

  return response.json();
}

module.exports = { sendChat };
