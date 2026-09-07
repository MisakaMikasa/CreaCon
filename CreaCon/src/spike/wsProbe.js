// SPIKE - throwaway. Delete once it has answered.
//
// ONE question: will UXP open a plain ws:// WebSocket to localhost?
//
// It matters because the desktop app has to hand edit plans down to this
// plugin, and a plugin can only ever connect OUT - it cannot be called. A
// WebSocket is the shape we want, because the executor reports progress after
// every step and those updates travel back up while the apply is still
// running. Polling would carry the plan down but not the progress back.
//
// Adobe documents a WebSocket API and says network.domains covers WebSocket
// entries, but every example uses wss://. We need ws:// - localhost has no
// certificate - and nothing says whether the insecure scheme is allowed.
//
// Requires "ws://localhost:<port>" in manifest.json network.domains.
//
// Reads the port the same way aiClient does, because the backend picks the
// first free one rather than always landing on 8000.

const { log } = require("../log");

const PORT_CANDIDATES = [8000, 8731, 8732, 8733, 8734, 8735];

async function findPort() {
  for (const port of PORT_CANDIDATES) {
    try {
      const res = await fetch(`http://localhost:${port}/ping`);
      const info = await res.json();
      if (info && info.app === "creacon") return port;
    } catch (err) {
      /* nothing there */
    }
  }
  return null;
}

async function probe() {
  const port = await findPort();
  if (!port) {
    log("WS PROBE: no backend found - start it first (python main.py)");
    return;
  }

  const url = `ws://localhost:${port}/bridge`;
  log(`WS PROBE: opening ${url}`);

  let ws;
  try {
    ws = new WebSocket(url);
  } catch (err) {
    // A throw here means UXP refused before any network traffic - almost
    // certainly the manifest domain, i.e. ws:// is not permitted.
    log("WS PROBE: RESULT = BLOCKED (constructor threw)", err && err.message);
    return;
  }

  ws.onopen = () => {
    log("WS PROBE: RESULT = CONNECTED - ws:// is allowed");
    ws.send("hello from the plugin");
  };
  ws.onmessage = (event) => {
    log("WS PROBE: message from backend ->", event.data);
  };
  ws.onerror = (event) => {
    log("WS PROBE: RESULT = ERROR", (event && (event.message || event.type)) || event);
  };
  ws.onclose = (event) => {
    log(`WS PROBE: closed (code ${event && event.code})`);
  };
}

module.exports = { probe };
