// The plugin's panel. It is no longer the interface - the desktop app is.
//
// Everything a user does now happens in CreaCon.exe: the chat, the plan cards,
// Apply, crop proposals, Open RAW, settings, cache cleanup. What is left in
// Photoshop is the part that can only be here - the executors, driven over a
// WebSocket by bridge.js.
//
// WHY THE PLUGIN GOT THINNER RATHER THAN JUST DIFFERENT. Every plugin update
// makes users re-run a .ccx install and click through two Adobe security
// warnings ("not verified by Adobe", then a third-party developer notice). A
// bridge that only executes batchPlay changes rarely, so they install once;
// the desktop app then updates freely with no Adobe involvement at all.
//
// So this panel exists to be a status light and nothing more. Resist adding
// features to it - anything added here is something users must reinstall for.
//
// The chat that used to live in this file is now backend/web/app.js, and the
// reasoning behind each piece went with it.

const { log } = require("./log");
const bridge = require("./bridge");

function el(id) {
  return document.getElementById(id);
}

function setStatus(connected, detail) {
  const dot = el("dot");
  const text = el("statusText");
  if (dot) dot.className = connected ? "dot ok" : "dot bad";
  if (text) text.textContent = detail;
}

// Polled rather than pushed. bridge.js owns the socket and reconnects on its
// own; this only has to report what it finds, and a second of lag on a status
// light costs nothing.
function watchConnection() {
  setInterval(() => {
    const state = bridge.status();
    setStatus(
      state.connected,
      state.connected
        ? `Connected to CreaCon on port ${state.port}`
        : "Waiting for CreaCon to start…"
    );
  }, 1000);
}

function setup() {
  log("Panel ready - bridge mode");
  bridge.start();
  watchConnection();
  setStatus(false, "Connecting…");
}

document.addEventListener("DOMContentLoaded", setup);
