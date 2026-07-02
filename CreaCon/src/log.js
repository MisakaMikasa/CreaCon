// Central logging + error formatting for the plugin.
// console.* shows up in the plugin's UXP DevTools console (••• -> Debug).
const PREFIX = "[CreaCon]";

function log(...args) {
  console.log(PREFIX, ...args);
}

function warn(...args) {
  console.warn(PREFIX, ...args);
}

function error(...args) {
  console.error(PREFIX, ...args);
}

// Photoshop/UXP throws a mix of real Errors, plain objects, and strings.
// This coerces any of them into a readable string so we never surface
// "undefined" to the user again.
function formatError(err) {
  if (err == null) return "unknown error";
  if (typeof err === "string") return err;
  if (err.message) return err.message;
  try {
    return JSON.stringify(err);
  } catch (e) {
    return String(err);
  }
}

module.exports = { log, warn, error, formatError };
