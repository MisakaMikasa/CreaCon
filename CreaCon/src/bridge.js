// The plugin's end of the desktop-app link.
//
// The desktop app owns the chat; the executor that drives Photoshop can only
// run in here. So a plan arrives as a message rather than a function call.
//
// This side dials out and the app answers, which is backwards from the usual
// arrangement - but a UXP plugin cannot be dialled. Adobe gives us fetch and
// WebSocket to reach out with, and nothing at all to listen with.
//
// Additive: panel.js still applies plans directly, exactly as before. This is
// a second door into the same room, not a replacement, and it stays that way
// until the desktop UI has proven itself.

const { capturePreviewImage, readLayerContext } = require("./aiClient");
const { validateEditPlan } = require("./validator");
const { applyEditPlan } = require("./executor/index");
const { core } = require("photoshop");
const { openRawAsSmartObject } = require("./executor/cameraRaw");
const { askImportChoice } = require("./dialogs");
const { log, error, formatError } = require("./log");

// Must match PORT_CANDIDATES in backend/main.py and the network domains in
// manifest.json. UXP refuses to open a host:port it was not declared with.
const PORT_CANDIDATES = [8000, 8731, 8732, 8733, 8734, 8735];

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

let socket = null;
let stopped = false;
let attempt = 0;

// One apply at a time. panel.js's Apply button and this socket both reach
// applyEditPlan, and two overlapping executeAsModal scopes against one
// document means two writers each believing they know the layer stack.
// Rejecting is deliberate: the alternative, queueing, would run a plan that
// was composed against the document as it looked BEFORE the running apply -
// stale layer names, and mask coordinates measured against a frame that has
// since moved.
let busy = false;

function backoffMs() {
  // Grow the gap so a backend that is down for a while is not hammered, but
  // cap it so recovery after a restart still feels immediate.
  const ms = Math.min(RECONNECT_MIN_MS * 2 ** attempt, RECONNECT_MAX_MS);
  attempt += 1;
  return ms;
}

async function discover() {
  for (const port of PORT_CANDIDATES) {
    try {
      const res = await fetch(`http://localhost:${port}/ping`);
      if (!res.ok) continue;
      const info = await res.json();
      if (info && info.app === "creacon") return { port, token: info.token || "" };
    } catch (err) {
      /* nothing listening there */
    }
  }
  return null;
}

function send(msg) {
  if (socket && socket.readyState === 1) socket.send(JSON.stringify(msg));
}

async function runApply(msg) {
  if (busy) {
    send({ type: "error", id: msg.id, message: "an apply is already running" });
    return;
  }
  busy = true;
  try {
    // Re-checked here even though the backend validated it. The plugin's own
    // structural check is the existing defence-in-depth design and the bridge
    // must not weaken it just because the plan arrived over a socket.
    const check = validateEditPlan(msg.plan);
    if (!check.valid) throw new Error(check.errors.join("; "));

    // Two step results are not just progress - they drive cards in the UI, and
    // only this side can pick them out, because only this side sees step.op.
    let geometryReport = null;
    let developResult = null;

    const results = await applyEditPlan(msg.plan, (i, step, result) => {
      if (step.op === "applyGeometry" && result) geometryReport = result;
      if (step.op === "applyCameraRaw" && result) developResult = result;
      send({ type: "progress", id: msg.id, step: i, op: step.op, result });
    });

    // Camera Raw loads AI mask PARAMETERS headlessly but may not run the
    // segmentation until nudged ("Update AI settings"), so an unchanged region
    // would otherwise look like a failed edit.
    const usesAiMask = (msg.plan.steps || []).some(
      (s) =>
        s.op === "applyCameraRaw" &&
        ((s.params && s.params.settings && s.params.settings.MaskGroupBasedCorrections) || []).some(
          (c) => (c.CorrectionMasks || []).some((m) => m.What === "Mask/Image")
        )
    );

    send({
      type: "done",
      id: msg.id,
      ok: true,
      results: results || [],
      summary: msg.plan.summary || "the edit",
      geometryReport,
      developResult,
      usesAiMask,
    });
    log(`bridge: applied plan ${String(msg.id).slice(0, 8)}`);
  } catch (err) {
    error("bridge: apply failed", err);
    send({ type: "error", id: msg.id, message: formatError(err) });
  } finally {
    busy = false;
  }
}

// The desktop app cannot export a canvas JPEG or list layers - both need the
// document, which only exists in here. So the backend asks for them on the
// app's behalf whenever a chat turn arrives without any.
async function sendContext(msg) {
  const context = { layer_names: [], selected_layers: [] };
  try {
    context.image_base64 = await capturePreviewImage();
  } catch (err) {
    // A text-only turn is degraded but still useful, so a failed preview must
    // not fail the turn. capturePreviewImage already returns null on its own
    // failures; this catches anything it does not.
    error("bridge: preview capture failed", err);
    context.image_base64 = null;
  }
  try {
    Object.assign(context, await readLayerContext());
  } catch (err) {
    error("bridge: layer context failed", err);
  }
  send({ type: "context_result", id: msg.id, context });
  log(
    `bridge: sent context (${context.layer_names.length} layer(s), preview ` +
      `${context.image_base64 ? "yes" : "no"})`
  );
}

// Puts a photo back to the state saved before one specific edit, by id. Not
// "undo the last apply": each card holds its own checkpoint, so restoring an
// older one still does what that card says even after later edits.
//
// Its own command rather than a synthetic plan, because it is not an edit -
// there is no applyGeometry that means "go back".
async function runRestore(msg) {
  if (busy) {
    send({ type: "error", id: msg.id, message: "an apply is already running" });
    return;
  }
  busy = true;
  try {
    const { restoreCheckpoint } = require("./executor/geometry");
    const name = await core.executeAsModal(
      async () => restoreCheckpoint(msg.checkpoint, msg.layer),
      { commandName: "CreaCon: restore checkpoint" }
    );
    send({ type: "done", id: msg.id, ok: true, layerName: name });
    log(`bridge: restored "${name}"`);
  } catch (err) {
    error("bridge: restore failed", err);
    send({ type: "error", id: msg.id, message: formatError(err) });
  } finally {
    busy = false;
  }
}

// 📷 from the desktop window. The file picker and the keep-or-fresh dialog both
// appear in Photoshop - the picker has to, and keeping the follow-up question
// beside it means one dialog flow rather than a decision split across two
// windows.
//
// Progress notes are collected rather than streamed: they are short, the whole
// import is quick, and the window shows them together with the result.
async function runOpenRaw(msg) {
  if (busy) {
    send({ type: "error", id: msg.id, message: "an apply is already running" });
    return;
  }
  busy = true;
  const notes = [];
  try {
    const layerName = await openRawAsSmartObject((text) => notes.push(text), askImportChoice);
    send({ type: "done", id: msg.id, ok: true, layerName: layerName || null, notes });
    log(`bridge: opened "${layerName}"`);
  } catch (err) {
    error("bridge: open raw failed", err);
    send({ type: "error", id: msg.id, message: formatError(err), notes });
  } finally {
    busy = false;
  }
}

async function connect() {
  if (stopped) return;

  let found = null;
  try {
    found = await discover();
  } catch (err) {
    // discover() should swallow its own failures, but an unhandled rejection
    // here would abandon the retry loop in total silence.
    error("bridge: discovery threw", err);
  }

  if (!found) {
    const wait = backoffMs();
    // Logged every attempt on purpose. A backend that is simply not running is
    // the single most likely reason this plugin appears to do nothing, and a
    // silent retry loop gives the user no way to find that out. The backoff
    // grows to 30s, so this cannot flood the console.
    log(`bridge: no backend on ports ${PORT_CANDIDATES.join(", ")} - retrying in ${wait}ms`);
    setTimeout(connect, wait);
    return;
  }

  const url = `ws://localhost:${found.port}/bridge`;
  try {
    socket = new WebSocket(url);
  } catch (err) {
    error("bridge: could not open a socket", err);
    setTimeout(connect, backoffMs());
    return;
  }

  socket.onopen = () => {
    log(`bridge: socket open to ${url}, authenticating`);
    // The token comes from /ping, which the discovery call above already made,
    // so there is no second secret and nothing to configure.
    send({ type: "hello", token: found.token });
  };

  socket.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (err) {
      return;
    }
    if (msg.type === "hello_ack") {
      attempt = 0; // authenticated, so the next drop retries promptly
      log(`bridge: connected to ${url}`);
    } else if (msg.type === "apply") {
      runApply(msg);
    } else if (msg.type === "context") {
      sendContext(msg);
    } else if (msg.type === "restore") {
      runRestore(msg);
    } else if (msg.type === "open_raw") {
      runOpenRaw(msg);
    }
  };

  socket.onclose = (event) => {
    socket = null;
    log(`bridge: disconnected (code ${event && event.code}) - will retry`);
    // A backend restart closes this silently. Without the retry the plugin
    // looks perfectly healthy and simply does nothing, which is the worst
    // failure mode available.
    if (!stopped) setTimeout(connect, backoffMs());
  };

  socket.onerror = (event) => {
    // onclose follows and owns the retry; this line exists so the cause is not
    // invisible when the socket fails rather than closes cleanly.
    error("bridge: socket error", (event && (event.message || event.type)) || event);
  };
}

function start() {
  stopped = false;
  attempt = 0;
  log("bridge: starting");
  connect();
}

function stop() {
  stopped = true;
  if (socket) socket.close();
  socket = null;
}

module.exports = { start, stop };
