const BACKEND_URL = "http://localhost:8000/edit-plan";

// Exports a small JPEG preview of the current document so the backend can
// send it to the AI as vision context. Best-effort: if it fails for any
// reason, we fall back to a text-only instruction rather than blocking.
async function capturePreviewImage() {
  try {
    const { app } = require("photoshop");
    const { localFileSystem, formats } = require("uxp").storage;
    const doc = app.activeDocument;

    const tempFolder = await localFileSystem.getTemporaryFolder();
    const file = await tempFolder.createFile("creacon-preview.jpg", { overwrite: true });
    await doc.saveAs.jpg(file, { quality: 6 }, true);

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

// The AI needs to know what layers already exist so it references real names
// (for renameLayer/setLayerOpacity/createGroup/addMask targets) instead of
// guessing "Layer 1". Top layer first, matching the Layers panel order.
function currentLayerNames() {
  try {
    const { app } = require("photoshop");
    return app.activeDocument.layers.map((l) => l.name);
  } catch (err) {
    console.warn("CreaCon: could not read layer names.", err);
    return [];
  }
}

async function requestEditPlan(instruction) {
  const imageBase64 = await capturePreviewImage();
  const layerNames = currentLayerNames();

  const response = await fetch(BACKEND_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instruction, image_base64: imageBase64, layer_names: layerNames }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Backend returned ${response.status}: ${detail}`);
  }

  return response.json();
}

module.exports = { requestEditPlan };
