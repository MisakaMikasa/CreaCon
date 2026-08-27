// Where a photo's develop state lives, and how to read and write it.
//
// This is the seam that lets one executor drive both formats. Camera Raw keeps
// develop settings in two different places depending on the file, and the two
// have nothing in common except the settings themselves:
//
//   RAW   a ".xmp" sidecar FILE beside the photo
//   JPEG  an XMP packet INSIDE the image, in an APP1 segment
//
// Both hold the same crs: vocabulary, so xmpSidecar.js parses and serializes
// either one unchanged - which is the whole reason the JPEG work was a day and
// not a rewrite. Everything above this module (the parser, the fidelity layers,
// checkpoints, mask coordinate maths, the relink reload) is format-blind.
//
// Spike-verified, both directions, on real files - see docs/jpeg-develop-design.md:
// ACR writes JPEG settings into the image and never to a sidecar, ignores a
// sidecar beside a JPEG even when the image carries no packet, and honours a
// packet we wrote ourselves.
//
// A JPEG write rewrites the whole file (a metadata segment at the front shifts
// everything after it) but never re-encodes it: the compressed scan data is
// copied byte-for-byte, so repeated edits cost nothing in quality.
const { localFileSystem, formats } = require("uxp").storage;
const fs = require("fs");
const { log, formatError } = require("../log");
const { sidecarPathFor } = require("./xmpSidecar");
const xmpEmbedded = require("./xmpEmbedded");

// DNG is excluded on purpose: it embeds develop settings in its own container,
// which is neither of the two mechanisms here.
const RAW_EXTENSIONS = ["cr2", "cr3", "nef", "arw", "raf", "orf", "rw2"];

const KIND_RAW = "raw";
const KIND_JPEG = "jpeg";

function extensionOf(nativePath) {
  return (nativePath.split(".").pop() || "").toLowerCase();
}

// "raw" | "jpeg" | null. null means CreaCon cannot develop this file.
function kindOf(nativePath) {
  const ext = extensionOf(nativePath);
  if (RAW_EXTENSIONS.includes(ext)) return KIND_RAW;
  if (xmpEmbedded.JPEG_EXTENSIONS.includes(ext)) return KIND_JPEG;
  return null;
}

function isSupported(nativePath) {
  return kindOf(nativePath) !== null;
}

// Human-readable, for messages that have to explain where edits went.
function describeLocation(nativePath) {
  return kindOf(nativePath) === KIND_JPEG
    ? "inside the image file"
    : `the sidecar ${sidecarPathFor(nativePath)}`;
}

// --- file plumbing ---------------------------------------------------------------

async function entryForPath(nativePath) {
  return localFileSystem.getEntryWithUrl("file:" + nativePath.replace(/\\/g, "/"));
}

function splitPath(nativePath) {
  const separator = nativePath.includes("\\") ? "\\" : "/";
  const cut = nativePath.lastIndexOf(separator);
  return { dir: nativePath.substring(0, cut), name: nativePath.substring(cut + 1) };
}

async function readTextIfExists(nativePath) {
  try {
    return await fs.readFile(nativePath, { encoding: "utf-8" });
  } catch {
    return null;
  }
}

async function writeText(nativePath, text) {
  await fs.writeFile(nativePath, text, { encoding: "utf-8" });
}

async function readBinaryIfExists(nativePath) {
  try {
    const entry = await entryForPath(nativePath);
    return new Uint8Array(await entry.read({ format: formats.binary }));
  } catch {
    return null;
  }
}

async function writeBinary(nativePath, bytes) {
  const { dir, name } = splitPath(nativePath);
  const folder = await localFileSystem.getEntryWithUrl("file:" + dir.replace(/\\/g, "/"));
  const file = await folder.createFile(name, { overwrite: true });
  // Slice: a Uint8Array can be a view into a larger buffer, and writing the
  // whole buffer would append its neighbours to the user's photo.
  await file.write(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), {
    format: formats.binary,
  });
}

async function removeFileIfExists(nativePath) {
  try {
    const entry = await entryForPath(nativePath);
    if (entry && entry.delete) await entry.delete();
    return true;
  } catch (err) {
    log("developStore.removeFileIfExists: nothing to delete or delete failed:", formatError(err));
    return false;
  }
}

async function copyFile(fromPath, toPath) {
  const bytes = await readBinaryIfExists(fromPath);
  if (!bytes) throw new Error(`Couldn't read ${fromPath}`);
  await writeBinary(toPath, bytes);
  return bytes.length;
}

// --- the seam ----------------------------------------------------------------------

// The develop-settings XML for this photo, or null when it has none.
//
// null is meaningful and distinct from empty: it means "no develop state here"
// (a fresh photo at camera defaults), which callers treat differently from a
// state that exists and happens to be neutral.
async function readState(nativePath) {
  if (kindOf(nativePath) === KIND_JPEG) {
    const bytes = await readBinaryIfExists(nativePath);
    if (!bytes) return null;
    return xmpEmbedded.readState(bytes);
  }
  return readTextIfExists(sidecarPathFor(nativePath));
}

// Replaces the photo's develop state with `xml`.
//
// For a JPEG this rewrites the image file in place. The caller is responsible for
// having pointed us at a working copy rather than the user's original - see
// photoCache.js.
async function writeState(nativePath, xml) {
  if (kindOf(nativePath) !== KIND_JPEG) {
    await writeText(sidecarPathFor(nativePath), xml);
    return;
  }
  const bytes = await readBinaryIfExists(nativePath);
  if (!bytes) throw new Error(`Couldn't read ${nativePath} to update its settings`);
  await writeBinary(nativePath, xmpEmbedded.writePacket(bytes, xml));
}

// Removes the develop state entirely, so ACR ingests the photo at camera
// defaults. Used by the "start fresh" import choice.
//
// For RAW this deletes the sidecar. For JPEG the settings are part of the image
// file, so we strip the packet and leave the picture itself untouched.
async function clearState(nativePath) {
  if (kindOf(nativePath) !== KIND_JPEG) {
    await removeFileIfExists(sidecarPathFor(nativePath));
    return;
  }
  const bytes = await readBinaryIfExists(nativePath);
  if (!bytes) return;
  const stripped = xmpEmbedded.stripPacket(bytes);
  if (stripped !== bytes) await writeBinary(nativePath, stripped);
}

module.exports = {
  KIND_RAW,
  KIND_JPEG,
  RAW_EXTENSIONS,
  kindOf,
  isSupported,
  describeLocation,
  readState,
  writeState,
  clearState,
  // file helpers, shared with photoCache
  entryForPath,
  splitPath,
  readBinaryIfExists,
  writeBinary,
  readTextIfExists,
  writeText,
  removeFileIfExists,
  copyFile,
};
