// Working copies of JPEGs, and the rules for locating them.
//
// WHY COPIES. A JPEG's develop settings live inside the image file, so every
// apply rewrites it. Editing the user's original would mean mutating their photo
// on every AI turn, and leaving our settings in a file they later send someone.
// So CreaCon copies the photo once at import and links the smart object to the
// copy. The original is never opened for writing.
//
// The copy is a FORK, not a mirror: later changes to the original do not
// propagate, exactly as duplicating a raw to grade it twice does not.
//
// Copying is cheap in the way that matters. The pixels in a working copy are
// byte-identical to the user's original (we never re-encode), so the only
// irreplaceable thing in it is a few KB of settings - which the registry mirrors.
// That makes a lost or swept copy a REBUILD rather than data loss; see
// rebuildFrom().
//
// PATH RULES (docs/jpeg-develop-design.md 3.3), because this is where they bite:
//   - the cache root is resolved at runtime, never hardcoded
//   - membership is decided by path CONTAINMENT, not by filename
//   - comparison is case-insensitive with separators normalised (Windows)
//   - every copy gets a unique name, so importing one photo twice cannot collide
//   - nothing keys off the DOCUMENT's name: documents get renamed and reused
const { localFileSystem } = require("uxp").storage;
const { log, formatError } = require("../log");
const store = require("./developStore");
const pathKey = require("./pathKey");

const CACHE_FOLDER = "photos";

// Resolved once per session; the plugin data folder is stable for the install.
let cacheRootPromise = null;

// The folder working copies live in. Inside the plugin's data folder: it exists
// on every platform without asking the user where to put anything, and it is
// per-install rather than per-document, which is what the sweep wants.
async function cacheRoot() {
  if (!cacheRootPromise) {
    cacheRootPromise = (async () => {
      const dataFolder = await localFileSystem.getDataFolder();
      let folder;
      try {
        folder = await dataFolder.getEntry(CACHE_FOLDER);
      } catch {
        folder = await dataFolder.createFolder(CACHE_FOLDER);
      }
      log("photoCache: root =", folder.nativePath);
      return folder.nativePath;
    })();
  }
  return cacheRootPromise;
}

// Path identity lives in pathKey.js - ONE implementation, because two copies of
// "are these the same photo?" that drift apart is how settings end up written to
// the wrong file. Re-exported here only so existing callers keep working.
const canonical = pathKey.canonical;

// Is this file one of ours? Containment, never name matching - a user's own
// photo may share a filename with a working copy, and must not be swept.
async function isWorkingCopy(nativePath) {
  const root = canonical(await cacheRoot());
  const path = canonical(nativePath);
  return Boolean(root) && (path === root || path.startsWith(root + "/"));
}

function baseNameOf(nativePath) {
  const { name } = store.splitPath(nativePath);
  return name.replace(/\.[^.]+$/, "");
}

// Short, filename-safe, and unique enough that two imports of one photo cannot
// collide. Not a security boundary - only a name.
function shortId() {
  return (
    Date.now().toString(36).slice(-5) + Math.floor(Math.random() * 0x10000).toString(36)
  ).slice(0, 9);
}

// Keeps the folder readable at a glance: "<original name>-<id>.jpg" rather than
// an opaque hash, so a user who opens the cache can tell what they are looking
// at. Characters a filesystem dislikes are replaced rather than dropped, so two
// differently-awkward names cannot converge.
function workingNameFor(sourcePath) {
  const base = baseNameOf(sourcePath).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60) || "photo";
  const ext = (sourcePath.split(".").pop() || "jpg").toLowerCase();
  return `${base}-${shortId()}.${ext}`;
}

// Copies `sourcePath` into the cache and returns the copy's path.
//
// The copy carries whatever XMP the original had; the caller decides whether to
// keep those settings or clear them (the import dialog's keep/fresh choice).
async function createWorkingCopy(sourcePath) {
  const root = await cacheRoot();
  const separator = root.includes("\\") ? "\\" : "/";
  const target = `${root}${separator}${workingNameFor(sourcePath)}`;
  const bytes = await store.copyFile(sourcePath, target);
  log(`photoCache: copied ${sourcePath} -> ${target} (${bytes} bytes)`);
  return target;
}

// Puts a missing working copy back: re-copy the original, splice the settings we
// kept, and the layer is editable again.
//
// This is what makes the cache safe to sweep and makes a moved or deleted copy a
// recoverable inconvenience. `settingsXml` is the mirror the registry holds; null
// means the photo was at camera defaults, so a plain copy is the correct restore.
async function rebuildFrom(sourcePath, workingPath, settingsXml) {
  const source = await store.readBinaryIfExists(sourcePath);
  if (!source) {
    throw new Error(
      `Can't rebuild the working copy: the original is gone from ${sourcePath}. ` +
        "Re-import the photo to carry on editing it."
    );
  }
  await store.writeBinary(workingPath, source);
  if (settingsXml) await store.writeState(workingPath, settingsXml);
  log(`photoCache: rebuilt ${workingPath} from ${sourcePath}`);
  return workingPath;
}

// Whether the file behind a layer is still on disk. Callers use this to decide
// between carrying on and rebuilding.
async function exists(nativePath) {
  return (await store.readBinaryIfExists(nativePath)) !== null;
}

// Everything currently in the cache: { path, name, bytes }. The sweep and any
// "how much disk is this using?" report are built on this.
async function listWorkingCopies() {
  const out = [];
  try {
    const dataFolder = await localFileSystem.getDataFolder();
    const folder = await dataFolder.getEntry(CACHE_FOLDER);
    for (const entry of await folder.getEntries()) {
      if (entry.isFolder) continue;
      let bytes = 0;
      try {
        const metadata = await entry.getMetadata();
        bytes = metadata.size || 0;
      } catch {
        // Size is a nicety; a file we cannot stat is still a file we can list.
      }
      out.push({ path: entry.nativePath, name: entry.name, bytes });
    }
  } catch (err) {
    log("photoCache.listWorkingCopies failed:", formatError(err));
  }
  return out;
}

module.exports = {
  cacheRoot,
  canonical,
  isWorkingCopy,
  createWorkingCopy,
  rebuildFrom,
  exists,
  listWorkingCopies,
};
