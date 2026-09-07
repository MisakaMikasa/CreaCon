// Finding working copies nobody uses any more, and removing them on request.
//
// Every JPEG import copies the photo into the cache (photoCache.js), because a
// JPEG's develop settings live inside the image and CreaCon will not write to a
// user's original. Nothing has ever deleted those copies, so the folder grows for
// the life of the install.
//
// WHY THIS IS NEVER AUTOMATIC. "Is this file still used?" cannot be answered with
// certainty. A document that is not open right now is not abandoned - it might be
// opened tomorrow, or live on a drive that is currently unplugged. The only
// evidence available is "a document referencing it was open at some point", which
// proves use but never proves disuse. So this proposes, and a human decides.
//
// WHY A WRONG SWEEP IS SURVIVABLE. A working copy's pixels are byte-identical to
// the user's original, and the registry mirrors its settings, so
// cameraRaw.ensureFileAvailable rebuilds a missing one on next use. Deleting a
// copy too early costs a rebuild, not an edit. That is what lets the grace period
// be a judgement call rather than a proof - but it holds ONLY while the original
// still exists, which is why the survey refuses to touch a copy whose original
// has gone.
//
// The liveness evidence itself is stamped by registry.touch(), called from
// cameraRaw.photoLayersIn on every layer walk.
const { log, formatError } = require("../log");
const registry = require("./rawRegistry");
const pathKey = require("./pathKey");

// photoCache and developStore pull in uxp at load, so they are required lazily -
// which lets plain node load this module and test the classification rules, the
// part that decides whether a file gets deleted. See scripts/test-cache-sweep.js.
const photoCache = () => require("./photoCache");
const developStore = () => require("./developStore");

// Long on purpose. The cost of waiting is disk space; the cost of being early is
// a user reopening a project and finding CreaCon rebuilding files. Disk is cheap.
const GRACE_DAYS = 90;
const GRACE_MS = GRACE_DAYS * 24 * 60 * 60 * 1000;

const REASON = {
  IN_USE: "in use",
  MARKED: "first seen now",
  NO_ENTRY: "unknown origin",
  NO_SOURCE: "original is gone",
};

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// Decides one file's fate. Pure - no disk, no clock of its own - because this is
// the logic that determines whether a file gets deleted, and it should be
// checkable without Photoshop.
//
// `entry` is the registry record for this file (or null), `sourceExists` whether
// its original is still on disk, `now` the reference time.
// Returns { removable, reason, idleDays }.
function classifyFile(entry, sourceExists, now) {
  // No registry entry: we do not know which original this came from, so it
  // cannot be rebuilt and deleting it would be irreversible. Report, never
  // propose. (A non-empty bucket here would argue for writing sourcePath into
  // the copy's own XMP so it is self-describing.)
  if (!entry) return { removable: false, reason: REASON.NO_ENTRY };

  // The original is gone, so this copy holds the only surviving pixels of that
  // photo. Never propose deleting it, however old it is.
  if (!entry.sourcePath || !sourceExists) {
    return { removable: false, reason: REASON.NO_SOURCE };
  }

  // Never observed. Treating "no evidence" as "abandoned" would sweep everything
  // imported before liveness stamping existed, on the very first run. Mark it
  // and let the clock start: mark and sweep, not sweep on sight.
  if (!entry.lastSeenAt) return { removable: false, reason: REASON.MARKED };

  const idleDays = Math.floor((now - entry.lastSeenAt) / (24 * 60 * 60 * 1000));
  if (idleDays < GRACE_DAYS) return { removable: false, reason: REASON.IN_USE, idleDays };
  return { removable: true, reason: null, idleDays };
}

// Looks at every file in the cache and sorts it into removable / kept, changing
// nothing except the first-sighting stamp (see MARKED above).
//
// Returns { totalCount, totalBytes, removable: [...], kept: [...] } where each
// item is { path, name, bytes, reason, sourcePath?, idleDays? }.
async function survey() {
  const cache = photoCache();
  const files = await cache.listWorkingCopies();
  const photos = await registry.allPhotos();
  const byPath = new Map(photos.map((p) => [pathKey.canonical(p.filePath), p]));
  const now = Date.now();

  const removable = [];
  const kept = [];
  let totalBytes = 0;

  for (const file of files) {
    totalBytes += file.bytes;
    const entry = byPath.get(pathKey.canonical(file.path)) || null;
    const sourceExists = Boolean(
      entry && entry.sourcePath && (await cache.exists(entry.sourcePath))
    );
    const verdict = classifyFile(entry, sourceExists, now);

    if (verdict.reason === REASON.MARKED) await registry.touch(entry.filePath);

    const item = {
      ...file,
      reason: verdict.reason,
      idleDays: verdict.idleDays,
      sourcePath: entry ? entry.sourcePath : null,
    };
    (verdict.removable ? removable : kept).push(item);
  }

  return { totalCount: files.length, totalBytes, removable, kept };
}

// Deletes the given working copies and forgets their registry entries.
//
// Only ever called with paths that came from survey().removable and that a human
// has confirmed. Failures are collected rather than thrown: one undeletable file
// (open elsewhere, permissions) must not abandon the rest of the cleanup.
async function remove(paths) {
  const cache = photoCache();
  const sizes = new Map(
    (await cache.listWorkingCopies()).map((f) => [pathKey.canonical(f.path), f.bytes])
  );
  let freedBytes = 0;
  const removed = [];
  const errors = [];

  for (const path of paths) {
    try {
      if (!(await cache.isWorkingCopy(path))) {
        // Belt and braces. Nothing should ever reach here with a path outside
        // the cache, and if it does, deleting a user's own photo is exactly the
        // kind of mistake worth an extra check to avoid.
        errors.push({ path, error: "not inside the photo cache - refused" });
        continue;
      }
      await developStore().removeFileIfExists(path);
      await registry.forgetPhoto(path);
      freedBytes += sizes.get(pathKey.canonical(path)) || 0;
      removed.push(path);
    } catch (err) {
      errors.push({ path, error: formatError(err) });
    }
  }

  log(`cacheSweep: removed ${removed.length} working copy/copies, freed ${freedBytes} bytes`);
  return { removed, freedBytes, errors };
}

// One human-readable paragraph describing a survey, for the confirmation dialog
// and the chat. Says what will be removed AND what is being left alone and why -
// a cleanup tool that silently skips things is one people stop trusting.
function describe(result) {
  if (result.totalCount === 0) return "The photo cache is empty - nothing to clean up.";

  const lines = [
    `Photo cache: ${result.totalCount} working ` +
      `${result.totalCount === 1 ? "copy" : "copies"}, ${formatBytes(result.totalBytes)}.`,
  ];

  if (result.removable.length) {
    const bytes = result.removable.reduce((sum, f) => sum + f.bytes, 0);
    lines.push(
      `${result.removable.length} unused for ${GRACE_DAYS}+ days (${formatBytes(bytes)}). ` +
        "Removing them is safe: each one can be rebuilt from your original photo with its " +
        "edits intact, automatically, the next time you open it."
    );
  } else {
    lines.push(`Nothing has been unused for ${GRACE_DAYS}+ days.`);
  }

  const counts = {};
  for (const item of result.kept) counts[item.reason] = (counts[item.reason] || 0) + 1;
  const notes = [];
  if (counts[REASON.NO_SOURCE]) {
    notes.push(
      `${counts[REASON.NO_SOURCE]} kept because the original photo is gone - CreaCon's copy ` +
        "is the only one left"
    );
  }
  if (counts[REASON.NO_ENTRY]) {
    notes.push(`${counts[REASON.NO_ENTRY]} kept because their origin is unknown`);
  }
  if (counts[REASON.MARKED]) {
    notes.push(
      `${counts[REASON.MARKED]} seen for the first time just now, so their ${GRACE_DAYS}-day ` +
        "clock starts today"
    );
  }
  if (notes.length) lines.push(`${notes.join("; ")}.`);

  return lines.join(" ");
}

module.exports = {
  survey,
  remove,
  describe,
  classifyFile, // pure; covered by scripts/test-cache-sweep.js
  formatBytes,
  GRACE_DAYS,
  REASON,
};
