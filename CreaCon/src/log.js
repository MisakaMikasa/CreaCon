// Central logging + error formatting for the plugin.
// console.* shows up in the plugin's UXP DevTools console (••• -> Debug).
const PREFIX = "[CreaCon]";

// UXP's console prints objects as "[object Object]" when passed alongside a
// string, so serialize them ourselves for readable logs.
function fmt(a) {
  if (a instanceof Error) return a.message || String(a);
  if (a !== null && typeof a === "object") {
    try {
      return JSON.stringify(a);
    } catch (e) {
      return String(a);
    }
  }
  return a;
}

function log(...args) {
  console.log(PREFIX, ...args.map(fmt));
}

function warn(...args) {
  console.warn(PREFIX, ...args.map(fmt));
}

function error(...args) {
  console.error(PREFIX, ...args.map(fmt));
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
