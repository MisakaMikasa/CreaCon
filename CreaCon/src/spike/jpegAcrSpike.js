// JPEG-through-Camera-Raw spike: can a JPEG be developed by the SAME mechanism
// as a raw (linked smart object + XMP + relink), so the sidecar infrastructure
// carries over instead of being rebuilt?
//
// The mechanism has two halves and they can have DIFFERENT answers. Keep them
// apart - conflating them is how this decision gets made wrong:
//
//   WRITE path - where does ACR PERSIST settings when the user edits a JPEG by
//     hand? For raws it is the .xmp sidecar. For JPEG/TIFF Adobe has always
//     leaned towards writing XMP INSIDE the file (JPEG can carry an XMP packet
//     in an APP1 segment; a raw can't). This half decides whether manual edits
//     and CreaCon edits can merge, and whether we must learn to rewrite the
//     user's actual image file.
//   READ path - does ACR HONOUR a .xmp sidecar sitting next to a JPEG when it
//     ingests it? This half alone decides whether applyCameraRaw works at all.
//     If ACR reads sidecars for JPEG, CreaCon can apply develop settings with
//     essentially the existing executor even if ACR writes elsewhere.
//
// So the outcomes are a matrix, not a list:
//   READ sidecar + WRITE sidecar    -> free. Extend RAW_EXTENSIONS and ship.
//   READ sidecar + WRITE embedded   -> apply works today; merging manual edits
//                                      needs an APP1 XMP *reader* only (safe -
//                                      we never rewrite the user's file).
//   READ embedded only              -> need a full APP1 reader+WRITER; every
//                                      apply mutates the user's original JPEG.
//   READ neither                    -> ACR is using its database; dead end for
//                                      this approach (see NOTE at the bottom).
//
// RUN 1 RESULT (2026-08-24, Fuji JPEG, ACR 18.5, Windows):
//   GATE 1 PASS - Camera Raw opens linked JPEG smart objects.
//   GATE 2 -> **EMBEDDED**. A manual +2.70 exposure edit made ACR write a
//     6795-byte XMP packet INTO the JPEG (the file grew 6879 bytes; the original
//     had no packet at all). It holds the COMPLETE explicit flat state - 101
//     crs: attributes, same vocabulary as a raw sidecar, same HasSettings /
//     ProcessVersion root. So xmpSidecar's parser and serializer already speak
//     this content; only the CONTAINER is new.
//   The embedded READ path works: the +2.70 survived a relink, i.e. ACR
//     re-ingested and re-developed from that packet.
//   GATE 3 was INCONCLUSIVE, by construction - a flaw in the original ordering.
//     The manual edit in phase 1 creates the embedded packet, and embedded beats
//     sidecar, so by the time the sidecar test ran it could never win. A clean
//     sidecar test needs a JPEG with NO packet (see directSidecarTest).
//
// RUN 2 RESULT (2026-08-24, same machine) - VERDICT:
//   TEST A (splice) **PASS** - a packet CreaCon wrote, built by the real
//     parseFull -> merge -> serialize round-trip on ACR's own state, rendered
//     dark/B&W on relink. ACR honours our packets. The raw mechanism transfers
//     to JPEG with the sidecar swapped for an APP1 segment.
//   TEST B (sidecar, unshadowed) **FAIL** - normal picture. ACR does not consult
//     a .xmp beside a JPEG even when the file carries no packet at all. Embedded
//     XMP is the ONLY storage for JPEG develop settings, read or written.
//
// Consequence for the executor: develop state has to become storage-agnostic -
// a raw reads/writes a sidecar file, a JPEG reads/writes an APP1 segment inside
// the image. Everything above that line (parser, serializer, extras/fidelity
// layers, checkpoints, mask coordinate maths, relink reload) is unchanged.
// And because the settings live IN the image, every apply rewrites the image
// file, which makes copy-on-import mandatory rather than merely polite.
//
// PREREQUISITES on the machine running this:
//   - Camera Raw preferences -> File Handling -> "JPEG/HEIC: Automatically open
//     all supported JPEGs". Without it Photoshop opens JPEGs directly and ACR
//     never enters the picture - GATE 1 below catches that.
//   - Camera Raw preferences -> "Save image settings in: Sidecar '.xmp' files"
//     (the same pref the raw path already requires).
//
// SAFETY: the spike never touches the JPEG you pick. Phase 1 copies it to
// "<name>.creacon-spike.jpg" beside it and every read, write and splice happens
// on that copy.
//
// TWO ENTRY POINTS. If the JPEG you pick ALREADY carries an ACR-written crs:
// packet (i.e. you have run this before, or edited it in Camera Raw), the spike
// skips the manual choreography entirely and runs the two clean tests below in
// one click. Otherwise it runs the original three-phase flow to produce such a
// file in the first place.
//
// Three phases, because a manual ACR edit has to happen in the middle:
//   Phase 1 (click 1): pick a JPEG -> copy -> snapshot both possible storage
//     locations -> place the copy as a LINKED smart object. Then you edit it by
//     hand in Camera Raw.
//   Phase 2 (click 2): GATE 2 = forensics on where that edit landed, then
//     GATE 3 = write a violent look to a sidecar and relink - does ACR read it?
//   Phase 3 (click 3, only offered when GATE 3 fails and an embedded packet
//     exists): splice the same look into the JPEG's own XMP packet and relink -
//     proving (or killing) the embedded-write path.
const { app, core, action } = require("photoshop");
const { localFileSystem, formats } = require("uxp").storage;
const { log, formatError } = require("../log");
const { serialize, parse, parseFull, sidecarPathFor } = require("../executor/xmpSidecar");
const { capturePreviewImage } = require("../aiClient");

const JPEG_TYPES = ["jpg", "jpeg"];

// Dark and colourless - impossible to confuse with the +2 exposure the user is
// asked to dial in by hand, so "whose settings won" is answerable by eye.
const BOLD_LOOK = { Exposure2012: -2, Saturation: -100 };

// The XMP APP1 segment signature: a NUL-terminated namespace URI at the start
// of the segment payload. Adobe's Extended XMP (used when a packet exceeds the
// 64KB segment limit) uses a different URI and is only reported, never written.
const XMP_SIG = "http://ns.adobe.com/xap/1.0/\0";
const XMP_EXT_SIG = "http://ns.adobe.com/xmp/extension/\0";

// Cross-click state. Module-level, so it survives between clicks but not a
// plugin reload - restart from phase 1 if you reload.
let state = null;

// --- byte plumbing ------------------------------------------------------------

async function entryForPath(nativePath) {
  return localFileSystem.getEntryWithUrl("file:" + nativePath.replace(/\\/g, "/"));
}

async function readBinaryIfExists(nativePath) {
  try {
    const entry = await entryForPath(nativePath);
    return new Uint8Array(await entry.read({ format: formats.binary }));
  } catch {
    return null;
  }
}

async function readTextIfExists(nativePath) {
  try {
    const entry = await entryForPath(nativePath);
    return entry.read();
  } catch {
    return null;
  }
}

function splitPath(nativePath) {
  const sep = nativePath.includes("\\") ? "\\" : "/";
  const cut = nativePath.lastIndexOf(sep);
  return { dir: nativePath.substring(0, cut), name: nativePath.substring(cut + 1) };
}

async function createFileAt(nativePath) {
  const { dir, name } = splitPath(nativePath);
  const folder = await localFileSystem.getEntryWithUrl("file:" + dir.replace(/\\/g, "/"));
  return folder.createFile(name, { overwrite: true });
}

async function writeBinary(nativePath, bytes) {
  const file = await createFileAt(nativePath);
  // Slice so a view into a larger buffer doesn't write its neighbours too.
  await file.write(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), {
    format: formats.binary,
  });
}

async function writeText(nativePath, text) {
  const file = await createFileAt(nativePath);
  await file.write(text);
}

async function deleteIfExists(nativePath) {
  try {
    const entry = await entryForPath(nativePath);
    if (entry && entry.delete) await entry.delete();
  } catch {
    // absent or undeletable - both fine, the caller only wants it gone
  }
}

// FNV-1a. Only ever compared for equality ("did these bytes change?"), so
// collision resistance is irrelevant and a dependency-free 32-bit hash is
// plenty. Also cheaper than holding two multi-MB buffers for a byte compare.
function hashBytes(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    // UXP without TextDecoder: latin1. Only used for REPORTING an existing
    // packet (attribute names and numbers are ASCII), never for round-tripping.
    let out = "";
    for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }
}

function encodeUtf8(text) {
  try {
    return new TextEncoder().encode(text);
  } catch {
    const out = [];
    for (let i = 0; i < text.length; i++) {
      const c = text.codePointAt(i);
      if (c > 0xffff) i++; // surrogate pair consumed
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else
        out.push(
          0xf0 | (c >> 18),
          0x80 | ((c >> 12) & 63),
          0x80 | ((c >> 6) & 63),
          0x80 | (c & 63)
        );
    }
    return new Uint8Array(out);
  }
}

// --- JPEG segment walking -----------------------------------------------------

function startsWith(bytes, offset, ascii) {
  if (offset + ascii.length > bytes.length) return false;
  for (let i = 0; i < ascii.length; i++) {
    if (bytes[offset + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

// Every marker segment before the compressed image data. Stops at SOS (0xDA):
// entropy-coded scan data follows it and is not segment-structured, so nothing
// after that point can be parsed this way - and nothing there is metadata.
// Returns { list, sosAt } or null if this isn't a JPEG.
function jpegSegments(bytes) {
  if (!bytes || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const list = [];
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) return { list, sosAt: i }; // desync; treat the rest as data
    let marker = bytes[i + 1];
    let at = i;
    while (marker === 0xff && at + 2 < bytes.length) marker = bytes[++at + 1]; // fill bytes
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i = at + 2; // standalone marker, no length field
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return { list, sosAt: at };
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    if (length < 2) return { list, sosAt: at };
    const end = at + 2 + length;
    const payload = at + 4;
    list.push({
      start: at,
      end,
      marker,
      payload,
      isXmp: marker === 0xe1 && startsWith(bytes, payload, XMP_SIG),
      isExtendedXmp: marker === 0xe1 && startsWith(bytes, payload, XMP_EXT_SIG),
    });
    i = end;
  }
  return { list, sosAt: bytes.length };
}

// The XMP packet inside a JPEG, as text, plus where it lives. null when absent.
function readEmbeddedXmp(bytes) {
  const parsed = jpegSegments(bytes);
  if (!parsed) return null;
  const seg = parsed.list.find((s) => s.isXmp);
  if (!seg) return null;
  const textStart = seg.payload + XMP_SIG.length;
  return {
    at: seg.start,
    bytes: seg.end - seg.start,
    text: decodeUtf8(bytes.subarray(textStart, seg.end)),
    hasExtended: parsed.list.some((s) => s.isExtendedXmp),
  };
}

// Rebuilds the JPEG with exactly one XMP APP1 carrying `xmpText`: existing XMP
// segments are dropped and a fresh one is inserted after APP0/JFIF (where
// Adobe's own writers put it). Splicing a whole segment rather than editing the
// packet in place avoids depending on the trailing padding whitespace being
// there - which it often isn't in a file ACR wrote.
function withEmbeddedXmp(bytes, xmpText) {
  const parsed = jpegSegments(bytes);
  if (!parsed) throw new Error("Not a JPEG (no SOI marker)");

  const packet =
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
    xmpText +
    '\n<?xpacket end="w"?>';
  const payload = encodeUtf8(XMP_SIG + packet);
  const length = payload.length + 2;
  if (length > 0xffff) {
    // Over 64KB the standard splits the packet across Extended XMP segments.
    // Our sidecars are ~13KB, so this only fires on something pathological.
    throw new Error(`XMP packet too large for one APP1 segment (${length} bytes)`);
  }
  const segment = new Uint8Array(4 + payload.length);
  segment.set([0xff, 0xe1, (length >> 8) & 0xff, length & 0xff], 0);
  segment.set(payload, 4);

  // Insert after any leading APP0, before everything else.
  const kept = parsed.list.filter((s) => !s.isXmp && !s.isExtendedXmp);
  let insertAt = 2;
  if (kept.length && kept[0].marker === 0xe0) insertAt = kept[0].end;

  const head = bytes.subarray(0, insertAt);
  const tailPieces = [];
  let cursor = insertAt;
  for (const seg of parsed.list) {
    if (seg.start < insertAt) continue;
    if (seg.isXmp || seg.isExtendedXmp) {
      tailPieces.push(bytes.subarray(cursor, seg.start));
      cursor = seg.end;
    }
  }
  tailPieces.push(bytes.subarray(cursor));

  const total =
    head.length + segment.length + tailPieces.reduce((sum, piece) => sum + piece.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  out.set(head, offset);
  offset += head.length;
  out.set(segment, offset);
  offset += segment.length;
  for (const piece of tailPieces) {
    out.set(piece, offset);
    offset += piece.length;
  }
  return out;
}

// Every XMP segment removed and nothing added. Needed to make the sidecar test
// meaningful: while a packet is present ACR reads it and never looks for a
// sidecar, so a sidecar test on a packet-bearing file measures nothing.
function withoutXmp(bytes) {
  const parsed = jpegSegments(bytes);
  if (!parsed) throw new Error("Not a JPEG (no SOI marker)");
  const pieces = [];
  let cursor = 0;
  for (const seg of parsed.list) {
    if (!seg.isXmp && !seg.isExtendedXmp) continue;
    pieces.push(bytes.subarray(cursor, seg.start));
    cursor = seg.end;
  }
  pieces.push(bytes.subarray(cursor));
  const out = new Uint8Array(pieces.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const piece of pieces) {
    out.set(piece, offset);
    offset += piece.length;
  }
  return out;
}

// --- Photoshop plumbing --------------------------------------------------------

// Same detection the real executor uses: smartObject.linked off the FULL layer
// descriptor. The narrower smartObjectMore.link property-get reports nothing on
// genuinely linked layers, so it can't be used as the gate here.
async function isLinked(layerId) {
  try {
    const info = await action.batchPlay(
      [{ _obj: "get", _target: [{ _ref: "layer", _id: layerId }] }],
      {}
    );
    const so = (info[0] && info[0].smartObject) || {};
    return Boolean(so.linked || so.link);
  } catch (err) {
    log("[jpeg-spike] isLinked failed:", formatError(err));
    return false;
  }
}

// Relink to the same path - the reload primitive the raw executor uses, for the
// same reason: it forces a fresh ingest (so ACR re-reads whatever metadata it
// reads) without converting the linked SO to an embedded one.
async function relink(layerId, nativePath) {
  const entry = await entryForPath(nativePath);
  const token = localFileSystem.createSessionToken(entry);
  await core.executeAsModal(
    async () => {
      await action.batchPlay(
        [
          { _obj: "select", _target: [{ _ref: "layer", _id: layerId }], makeVisible: false },
          {
            _obj: "placedLayerRelinkToFile",
            null: { _path: token, _kind: "local" },
            _options: { dialogOptions: "dontDisplay" },
          },
        ],
        {}
      );
      try {
        await action.batchPlay(
          [{ _obj: "placedLayerUpdateAllModified", _options: { dialogOptions: "dontDisplay" } }],
          {}
        );
      } catch (err) {
        log("[jpeg-spike] updateAllModified nudge failed (non-fatal):", formatError(err));
      }
    },
    { commandName: "CreaCon spike: relink JPEG" }
  );
}

async function placeLinked(nativePath, layerName) {
  const token = localFileSystem.createSessionToken(await entryForPath(nativePath));
  let layerId = null;
  await core.executeAsModal(
    async () => {
      await action.batchPlay(
        [
          {
            _obj: "placeEvent",
            null: { _path: token, _kind: "local" },
            linked: true,
            _options: { dialogOptions: "dontDisplay" },
          },
        ],
        {}
      );
      const placed = app.activeDocument.activeLayers[0];
      if (!placed) throw new Error("Place succeeded but no active layer found");
      placed.name = layerName; // so two test layers can be told apart by eye
      layerId = placed.id;
    },
    { commandName: "CreaCon spike: place linked JPEG" }
  );
  return layerId;
}

// --- the clean tests (no manual choreography) -----------------------------------
//
// Run 1 established that ACR stores JPEG develop settings in an embedded XMP
// packet and re-reads its OWN packet on relink. Neither of the two questions
// that actually decide the refactor was answered, and both need a file that run
// 1 has already produced, so they run together off one click:
//
//   TEST A (the decisive one) - does ACR honour a packet WE wrote? Takes the
//     packet ACR wrote, runs it through parseFull -> merge -> serialize (the
//     exact round-trip applyCameraRaw performs for raws), splices the result
//     back in and relinks. A pass means the whole raw mechanism transfers with
//     the sidecar swapped for an APP1 segment.
//   TEST B - is the sidecar read path real when nothing shadows it? Same
//     original with every XMP segment stripped, plus a sidecar. A pass here is
//     a much weaker win than it looks: the first manual ACR edit writes a packet
//     that permanently shadows the sidecar, so it cannot be the primary
//     mechanism - but it is worth knowing.
//
// Each test places its own clearly-named layer, so both verdicts are readable
// off the canvas at the same time.
async function directTests(say, sourcePath, sourceBytes, packet) {
  say(
    "JPEG spike: this file already carries an ACR-written develop packet " +
      `(${packet.bytes} bytes, ${(packet.text.match(/crs:/g) || []).length} crs: keys), so the ` +
      "manual phases are unnecessary - running the two clean tests directly."
  );

  // TEST A -------------------------------------------------------------------
  // Round-trip through the REAL parser/serializer, not a hand-built packet:
  // that way a pass also proves xmpSidecar handles ACR's embedded output, and a
  // failure to parse shows up here rather than being blamed on ACR.
  const current = parseFull(packet.text);
  say(
    "JPEG spike: TEST A - parsed ACR's packet with xmpSidecar.parseFull -> " +
      JSON.stringify(current.settings) +
      ". Merging the dark/B&W look onto that state and splicing it back in."
  );
  const merged = { ...current.settings, ...BOLD_LOOK };
  const spliceXml = serialize(merged, current.extras, current.geometry);
  const splicePath = sourcePath.replace(/\.[^./\\]+$/, ".splicetest.jpg");
  await writeBinary(splicePath, withEmbeddedXmp(sourceBytes, spliceXml));

  // Re-read through our own reader before trusting the canvas at all.
  const check = readEmbeddedXmp(await readBinaryIfExists(splicePath));
  if (!check || !/crs:Exposure2012="-2/.test(check.text)) {
    say(
      "JPEG spike: TEST A ABORTED - the packet we wrote does not read back with the expected " +
        "values, so the splice is malformed and any canvas result would be meaningless."
    );
  } else {
    const beforeA = await capturePreviewImage();
    const layerA = await placeLinked(splicePath, "SPLICE TEST (expect dark B&W)");
    const afterA = await capturePreviewImage();
    say(
      "JPEG spike: **TEST A placed as layer \"SPLICE TEST\"** " +
        (beforeA && afterA && beforeA === afterA ? "(canvas pixels did not change) " : "") +
        "- LOOK AT IT: dark and black-and-white? " +
        "**YES -> ACR honours a packet we wrote. The refactor is on:** applyCameraRaw keeps its " +
        "parser, serializer, checkpoints and mask maths, and only swaps sidecar file I/O for the " +
        "APP1 splice. **NO (still +2.70 and normal colour) -> ACR only trusts its own packet** " +
        "(likely keyed to a digest or its database), and the approach dies here."
    );
    log("[jpeg-spike] TEST A layer id", layerA);
  }

  // TEST B -------------------------------------------------------------------
  const strippedPath = sourcePath.replace(/\.[^./\\]+$/, ".sidecartest.jpg");
  const stripped = withoutXmp(sourceBytes);
  await writeBinary(strippedPath, stripped);
  const strippedSidecar = sidecarPathFor(strippedPath);
  await writeText(strippedSidecar, serialize(BOLD_LOOK));
  say(
    `JPEG spike: TEST B - stripped every XMP segment (${sourceBytes.length} -> ${stripped.length} ` +
      "bytes, so nothing shadows a sidecar) and wrote the same dark/B&W look to a .xmp beside it."
  );
  const layerB = await placeLinked(strippedPath, "SIDECAR TEST (expect dark B&W)");
  say(
    "JPEG spike: **TEST B placed as layer \"SIDECAR TEST\"** - LOOK AT IT: dark and " +
      "black-and-white? **YES -> ACR does read sidecars for JPEG when no embedded packet " +
      "shadows them** (a fallback path, not a primary one - the first manual edit writes a " +
      "packet that wins forever after). **NO -> sidecars are simply not consulted for JPEG**, " +
      "and embedded XMP is the only candidate mechanism."
  );
  log("[jpeg-spike] TEST B layer id", layerB);

  say(
    "JPEG spike: done. Two test layers are on the canvas; report each separately. " +
      `Leftovers to delete when finished: ${splicePath}, ${strippedPath}, ${strippedSidecar}.`
  );
}

// --- phase 1 --------------------------------------------------------------------

async function phase1(say) {
  const picked = await localFileSystem.getFileForOpening(); // unfiltered: UXP type filters are case-sensitive in some builds
  if (!picked) {
    say("JPEG spike: cancelled (no file picked).");
    return;
  }
  const originalPath = picked.nativePath;
  const ext = (originalPath.split(".").pop() || "").toLowerCase();
  if (!JPEG_TYPES.includes(ext)) {
    say(`JPEG spike: ".${ext}" isn't a JPEG - pick a .jpg/.jpeg.`);
    return;
  }
  if (!app.activeDocument) {
    say("JPEG spike: open any document first - the JPEG is placed into it.");
    return;
  }

  const sourceBytes = await readBinaryIfExists(originalPath);
  if (!sourceBytes) {
    say(`JPEG spike: couldn't read ${originalPath}.`);
    return;
  }

  // Shortcut: a file that already carries ACR's own develop packet is exactly
  // what the two clean tests need, and re-running the manual choreography to
  // produce another one would prove nothing. Both tests work on copies, so the
  // picked file survives as the ground-truth artefact.
  const existingPacket = readEmbeddedXmp(sourceBytes);
  if (existingPacket && existingPacket.text.includes("crs:")) {
    await directTests(say, originalPath, sourceBytes, existingPacket);
    return;
  }

  // Work on a COPY. Everything downstream (a manual ACR edit, an XMP splice)
  // writes to image files, and none of that is going anywhere near the original.
  const workPath = originalPath.replace(/\.[^./\\]+$/, ".creacon-spike.jpg");
  await writeBinary(workPath, sourceBytes);

  // A sidecar left behind by an earlier run would make "a sidecar appeared"
  // meaningless in phase 2. Same for a stale embedded packet - that one we only
  // record, since stripping it would change what we're measuring.
  const sidecarPath = sidecarPathFor(workPath);
  await deleteIfExists(sidecarPath);

  const workBytes = await readBinaryIfExists(workPath);
  const embeddedBefore = readEmbeddedXmp(workBytes);
  say(
    `JPEG spike: working on a COPY - ${workPath} (your original is untouched). ` +
      `Baseline: ${workBytes.length} bytes, ` +
      (embeddedBefore
        ? `already carries an embedded XMP packet (${embeddedBefore.bytes} bytes` +
          `${embeddedBefore.text.includes("crs:") ? ", and it already has crs: develop keys" : ", no crs: keys"}).`
        : "no embedded XMP packet.") +
      " No sidecar."
  );

  const token = localFileSystem.createSessionToken(await entryForPath(workPath));
  let layerId = null;
  await core.executeAsModal(
    async () => {
      await action.batchPlay(
        [
          {
            _obj: "placeEvent",
            null: { _path: token, _kind: "local" },
            linked: true,
            _options: { dialogOptions: "dontDisplay" },
          },
        ],
        {}
      );
      const placed = app.activeDocument.activeLayers[0];
      if (!placed) throw new Error("Place succeeded but no active layer found");
      layerId = placed.id;
    },
    { commandName: "CreaCon spike: place linked JPEG" }
  );

  const linked = await isLinked(layerId);
  say(
    linked
      ? "JPEG spike: placed as a LINKED smart object (the raw path's placement works for JPEG too)."
      : "JPEG spike: WARNING - the layer does not report as linked. Everything below still runs, " +
          "but a relink may behave differently than it does for raws."
  );

  state = {
    originalPath,
    workPath,
    sidecarPath,
    layerId,
    workHash: hashBytes(workBytes),
    workLength: workBytes.length,
    embeddedBefore,
  };

  say(
    "JPEG spike: phase 1 done. **NOW DO THIS BY HAND:** (1) double-click the new layer's " +
      "thumbnail. **GATE 1 - what opens?** Camera Raw = the JPEG/HEIC auto-open preference is " +
      "on and this whole approach is live; a plain Photoshop image tab = the preference is OFF " +
      "(Camera Raw preferences -> File Handling -> JPEG/HEIC -> \"Automatically open all " +
      "supported JPEGs\"), so turn it on and rerun phase 1 - the rest of the spike measures " +
      "nothing until Camera Raw is in the loop. (2) In Camera Raw set Exposure to about +2 - " +
      "something obvious, no masks. (3) Press OK. (4) Click 🧪 again for phase 2."
  );
}

// --- phase 2 --------------------------------------------------------------------

async function phase2(say) {
  const { workPath, sidecarPath, layerId, workHash, workLength, embeddedBefore } = state;

  const previewBefore = await capturePreviewImage();

  // GATE 2: where did the manual edit land? -----------------------------------
  const sidecarNow = await readTextIfExists(sidecarPath);
  const workBytes = await readBinaryIfExists(workPath);
  const fileChanged = workBytes !== null && hashBytes(workBytes) !== workHash;
  const embeddedNow = workBytes ? readEmbeddedXmp(workBytes) : null;
  const embeddedIsNew =
    embeddedNow !== null && (embeddedBefore === null || embeddedNow.text !== embeddedBefore.text);

  const wroteSidecar = sidecarNow !== null;
  const wroteEmbedded = fileChanged && embeddedIsNew;

  if (wroteSidecar) {
    say(
      "JPEG spike: **GATE 2 -> SIDECAR.** Camera Raw wrote a .xmp next to the JPEG, exactly " +
        `like a raw (${sidecarNow.length} bytes). Our parser reads it as: ` +
        JSON.stringify(parse(sidecarNow)) +
        ". This is the best possible answer for the WRITE half - manual edits and CreaCon " +
        "edits share one file, with no need to ever touch the user's image."
    );
  }
  if (wroteEmbedded) {
    say(
      "JPEG spike: **GATE 2 -> EMBEDDED XMP.** The JPEG's own bytes changed " +
        `(${workLength} -> ${workBytes.length}) and it now carries an XMP packet at offset ` +
        `${embeddedNow.at}, ${embeddedNow.bytes} bytes` +
        (embeddedNow.hasExtended ? ", PLUS an Extended XMP segment (packet is split!)" : "") +
        `. Contains crs: develop keys: ${embeddedNow.text.includes("crs:") ? "YES" : "NO"}. ` +
        "Our existing parser reads it as: " +
        JSON.stringify(parse(embeddedNow.text)) +
        ". If those values match what you dialled in, xmpSidecar.parseFull works unchanged on " +
        "embedded packets and only the container is new."
    );
  } else if (fileChanged) {
    say(
      "JPEG spike: the JPEG's bytes changed but no NEW XMP packet is visible - Camera Raw may " +
        "have rewritten other metadata (EXIF/thumbnail). Treat GATE 2 as inconclusive and say " +
        "what you see."
    );
  }
  if (!wroteSidecar && !wroteEmbedded && !fileChanged) {
    say(
      "JPEG spike: **GATE 2 -> NEITHER.** Nothing on disk changed, so Camera Raw kept your edit " +
        "in its own database (or never opened - see GATE 1). If GATE 1 really showed Camera Raw, " +
        "check the 'Save image settings in: Sidecar .xmp files' preference before concluding, " +
        "because a database-only answer kills the merge story: manual edits would be invisible " +
        "to CreaCon and every apply would silently clobber them."
    );
  }

  // GATE 3: does ACR READ a sidecar for a JPEG? --------------------------------
  // CAVEAT, learned the hard way in run 1: this gate is only meaningful when no
  // embedded packet exists. An embedded packet SHADOWS the sidecar - ACR reads
  // the packet and never looks beside the file - so once the manual edit above
  // has written one, a "fail" here says nothing about sidecar support. The clean
  // version of this test lives in directTests (TEST B), which strips the packet
  // first. Left in place because on a JPEG where ACR wrote no packet, this is
  // still the fastest way to see the read path work.
  await writeText(sidecarPath, serialize(BOLD_LOOK));
  say(
    "JPEG spike: GATE 3 - wrote a sidecar with a violent look (Exposure -2, Saturation -100 = " +
      "dark and colourless) and relinking now. Camera Raw may open a dialog - just press OK." +
      (embeddedNow
        ? " NOTE: this file now has an embedded packet, which shadows any sidecar - so a " +
          "negative result here is expected and proves nothing either way."
        : "")
  );
  await relink(layerId, workPath);
  const previewAfter = await capturePreviewImage();
  const pixelsChanged =
    previewBefore && previewAfter ? previewBefore !== previewAfter : null;

  state = { ...state, gate3Changed: pixelsChanged, embeddedNow, wroteSidecar, wroteEmbedded };

  if (pixelsChanged === true) {
    say(
      "JPEG spike: GATE 3 - the pixels changed. **LOOK AT THE CANVAS: is the layer now dark and " +
        "black-and-white?** If YES -> **GATE 3 PASS: ACR reads sidecars for JPEG.** applyCameraRaw " +
        "works on JPEGs with the existing sidecar executor; the refactor is mostly extending " +
        "RAW_EXTENSIONS and teaching the prompt about 8-bit latitude. (If it changed but does NOT " +
        "look dark/B&W, the relink merely re-ingested the file and the sidecar was ignored - " +
        "report that, it counts as a FAIL.)"
    );
  } else if (pixelsChanged === false) {
    say(
      "JPEG spike: **GATE 3 - sidecar ignored on ingest** (identical pixels)." +
        (state.embeddedNow
          ? " Expected: the embedded packet shadows it, so this is not evidence against sidecar " +
            "support. The real remaining question is whether ACR honours a packet WE write - " +
            "click 🧪 once more for phase 3, which splices the same look into the JPEG's own XMP. " +
            "(Or run 🧪 again and pick this working copy: it now carries an ACR packet, so the " +
            "spike will jump straight to the two clean tests instead.)"
          : " No embedded packet to fall back on either - this approach is dead for JPEG and the " +
            "adjustment-layer path stays.")
    );
    if (!state.embeddedNow) state = null;
  } else {
    say(
      "JPEG spike: GATE 3 - preview capture unavailable, so judge by eye: is the layer now dark " +
        "and black-and-white? That is the whole question."
    );
  }

  if (pixelsChanged === true) state = null; // done - phase 3 would prove nothing
}

// --- phase 3 --------------------------------------------------------------------

async function phase3(say) {
  const { workPath, sidecarPath, layerId } = state;
  state = null;

  // The sidecar we wrote in GATE 3 was ignored, but leave nothing ambiguous:
  // if it vanishes and the picture still changes, the embedded packet did it.
  await deleteIfExists(sidecarPath);

  const bytes = await readBinaryIfExists(workPath);
  if (!bytes) {
    say(`JPEG spike: the working copy is gone (${workPath}) - rerun from phase 1.`);
    return;
  }
  const previewBefore = await capturePreviewImage();

  let spliced;
  try {
    spliced = withEmbeddedXmp(bytes, serialize(BOLD_LOOK));
  } catch (err) {
    say(`JPEG spike: GATE 4 - couldn't build the XMP segment: ${formatError(err)}`);
    return;
  }
  await writeBinary(workPath, spliced);

  // Read back through our own parser: a packet we can't re-read is a packet we
  // shouldn't trust, whatever the canvas ends up showing.
  const verify = readEmbeddedXmp(await readBinaryIfExists(workPath));
  say(
    "JPEG spike: GATE 4 - spliced the dark/B&W look into the JPEG's XMP packet " +
      `(${bytes.length} -> ${spliced.length} bytes; packet re-reads as ` +
      (verify ? JSON.stringify(parse(verify.text)) : "UNREADABLE - the splice is malformed") +
      "). Relinking - press OK if Camera Raw opens."
  );
  await relink(layerId, workPath);
  const previewAfter = await capturePreviewImage();
  const pixelsChanged = previewBefore && previewAfter ? previewBefore !== previewAfter : null;

  say(
    pixelsChanged === false
      ? "JPEG spike: **GATE 4 FAIL** - pixels unchanged. ACR ignores an externally-written " +
          "embedded packet too, which leaves no route to drive JPEG develop declaratively. " +
          "Keep the adjustment-layer path for JPEG and close this line of enquiry."
      : "JPEG spike: GATE 4 - pixels changed. **LOOK AT THE CANVAS: dark and black-and-white?** " +
          "If YES -> ACR reads embedded XMP we wrote ourselves. The mechanism works, but every " +
          "apply rewrites the user's actual JPEG: that needs a copy-on-import policy (edit a " +
          "CreaCon-owned copy, never the original) before it ships. If the picture changed but " +
          "isn't dark/B&W, the relink just re-ingested and this is a FAIL."
  );
  say(
    `JPEG spike: done. Delete ${workPath} and any .creacon-spike.xmp beside it when you're ` +
      "finished - your original was never modified."
  );
}

async function runJpegAcrSpike(report) {
  const say = (text) => {
    log("[jpeg-spike]", text);
    report(text);
  };
  try {
    if (state === null) await phase1(say);
    else if (state.gate3Changed === undefined) await phase2(say);
    else await phase3(say);
  } catch (err) {
    state = null;
    say(`JPEG spike: failed - ${formatError(err)} (state reset; start again from phase 1).`);
    throw err;
  }
}

module.exports = { runJpegAcrSpike };

// NOTE on the "database" outcome: ACR's fallback store is a local sqlite file in
// the user's roaming profile, keyed by file identity. It is not a documented or
// stable interface and it is per-machine, so it is not a candidate mechanism -
// if GATE 2 lands there and GATE 3 fails, JPEG develop via ACR is off the table
// and the adjustment-layer ops stay as the JPEG path.
