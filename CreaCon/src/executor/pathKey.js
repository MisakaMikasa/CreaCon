// One canonical form for a file path, so the same file always produces the same
// key however it was spelled.
//
// This matters more than it looks. Photoshop hands back a native path
// ("C:\Users\...\a.jpg") in one place and a URL ("file:///C:/Users/.../a.jpg")
// in another, for the same file. Windows is case-insensitive. The registry is
// keyed on this, so two spellings that fail to converge means a photo silently
// stops being develop-editable, and two that converge WRONGLY means writing
// settings into the wrong photo.
//
// Deliberately dependency-free: no photoshop, no uxp. It is the one piece of
// identity logic that can be tested properly (scripts/test-registry.js).

// Windows paths are case-insensitive; POSIX ones are not. Photoshop's UXP host
// runs on both, and getting this wrong in either direction is a real bug: fold
// case on POSIX and two genuinely different files collide.
const CASE_INSENSITIVE = typeof process === "undefined" || process.platform !== "linux";

function canonical(nativePath) {
  if (!nativePath) return "";
  let path = String(nativePath);

  // file:/// URLs: three slashes on Windows ("file:///C:/x"), two elsewhere.
  if (path.startsWith("file:///")) path = path.slice("file:///".length);
  else if (path.startsWith("file://")) path = path.slice("file://".length);

  try {
    path = decodeURI(path);
  } catch {
    // Not percent-encoded, or malformed - the raw string is the better guess.
  }

  path = path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return CASE_INSENSITIVE ? path.toLowerCase() : path;
}

function sameFile(a, b) {
  const left = canonical(a);
  return left !== "" && left === canonical(b);
}

function baseName(nativePath) {
  return (nativePath || "").split(/[\\/]/).pop() || "";
}

module.exports = { canonical, sameFile, baseName };
