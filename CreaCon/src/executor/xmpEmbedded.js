// Reading and writing the XMP packet inside a JPEG's APP1 segment.
//
// Camera Raw stores a JPEG's develop settings INSIDE the image file, never in a
// sidecar - spike-verified both directions (see docs/jpeg-develop-design.md and
// the header of src/spike/jpegAcrSpike.js). The settings themselves are the same
// crs: vocabulary as a raw sidecar, so xmpSidecar.js parses and serializes them
// unchanged; only the container differs, and this module is that container.
//
// The image is never decoded. A write replaces one metadata segment and copies
// the compressed scan data byte-for-byte, so there is no re-encoding and no
// generation loss however many times a photo is edited. Verified: identical
// pixels out of an independent decoder, and the entropy-coded data unchanged.
const { log } = require("../log");

// APP1 segments are identified by a NUL-terminated namespace URI at the start of
// their payload - that is what distinguishes an XMP APP1 from the EXIF APP1 that
// usually sits right before it, and which must never be touched.
const XMP_SIG = "http://ns.adobe.com/xap/1.0/\0";
// Adobe splits packets larger than one segment into "extended" XMP. We never
// write those (our packets are single-segment by a wide margin) but we detect
// them, because silently dropping half a packet would be far worse than failing.
const XMP_EXT_SIG = "http://ns.adobe.com/xmp/extension/\0";

// A JPEG segment's length field is 16 bits and includes its own 2 bytes, so this
// is the ceiling for signature + packet.
const MAX_SEGMENT_PAYLOAD = 0xffff - 2;

const JPEG_EXTENSIONS = ["jpg", "jpeg"];

function isJpegPath(nativePath) {
  return JPEG_EXTENSIONS.includes((nativePath.split(".").pop() || "").toLowerCase());
}

// --- text encoding -------------------------------------------------------------
// XMP is UTF-8. UXP has TextEncoder/TextDecoder in current builds; the manual
// fallbacks exist because a silently wrong encoding here corrupts a user's file.

function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
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
      const code = text.codePointAt(i);
      if (code > 0xffff) i++; // surrogate pair consumed by codePointAt
      if (code < 0x80) out.push(code);
      else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
      else if (code < 0x10000)
        out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
      else
        out.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 63),
          0x80 | ((code >> 6) & 63),
          0x80 | (code & 63)
        );
    }
    return new Uint8Array(out);
  }
}

// --- segment walking ------------------------------------------------------------

function startsWith(bytes, offset, ascii) {
  if (offset + ascii.length > bytes.length) return false;
  for (let i = 0; i < ascii.length; i++) {
    if (bytes[offset + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

// Every marker segment before the compressed image data, in order.
//
// Stops at SOS (0xDA): entropy-coded scan data follows and is not
// segment-structured, so nothing past that point can be walked - and no metadata
// lives there anyway. Returns null when the bytes are not a JPEG.
function segments(bytes) {
  if (!bytes || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const list = [];
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) return { list, sosAt: i }; // desync - treat the remainder as data
    let marker = bytes[i + 1];
    let at = i;
    while (marker === 0xff && at + 2 < bytes.length) marker = bytes[++at + 1]; // skip fill bytes
    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i = at + 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return { list, sosAt: at };
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    if (length < 2) return { list, sosAt: at }; // malformed - stop rather than loop
    const payload = at + 4;
    list.push({
      start: at,
      end: at + 2 + length,
      marker,
      payload,
      isXmp: marker === 0xe1 && startsWith(bytes, payload, XMP_SIG),
      isExtendedXmp: marker === 0xe1 && startsWith(bytes, payload, XMP_EXT_SIG),
    });
    i = at + 2 + length;
  }
  return { list, sosAt: bytes.length };
}

function isJpeg(bytes) {
  return segments(bytes) !== null;
}

// --- read ------------------------------------------------------------------------

// The XMP packet's text, or null when the file carries none. `hasExtended` warns
// that part of the packet lives in segments we do not read.
function readPacket(bytes) {
  const parsed = segments(bytes);
  if (!parsed) return null;
  const segment = parsed.list.find((s) => s.isXmp);
  if (!segment) return null;
  const textStart = segment.payload + XMP_SIG.length;
  return {
    text: decodeUtf8(bytes.subarray(textStart, segment.end)),
    at: segment.start,
    bytes: segment.end - segment.start,
    hasExtended: parsed.list.some((s) => s.isExtendedXmp),
  };
}

// The develop-settings XML for xmpSidecar.parseFull, or null if this file has no
// Camera Raw settings in it. A packet with no crs: keys (plain EXIF-ish XMP from
// a camera or an exporter) is not develop state and must read as absent, or a
// fresh import would look like it already had edits.
function readState(bytes) {
  const packet = readPacket(bytes);
  if (!packet) return null;
  if (packet.hasExtended) {
    log(
      "xmpEmbedded: packet has an Extended XMP continuation; reading the main segment only " +
        "(develop settings live in the main packet)."
    );
  }
  return packet.text.includes("crs:") ? packet.text : null;
}

// --- write -------------------------------------------------------------------------

// The JPEG rebuilt with exactly one XMP APP1 carrying `xmpText`.
//
// Existing XMP segments are dropped and a fresh one inserted after APP0/JFIF,
// where Adobe's own writers put it. We splice a whole segment rather than editing
// the packet in place because in-place editing depends on trailing padding
// whitespace that a packet ACR wrote often does not have.
//
// EXIF and every other segment are preserved untouched, as is all scan data.
function writePacket(bytes, xmpText) {
  const parsed = segments(bytes);
  if (!parsed) throw new Error("Not a JPEG (no SOI marker)");

  // The xpacket wrapper is the conventional form for embedded XMP; readers
  // accept a bare x:xmpmeta but ACR's own packets carry it, so we match them.
  const packet =
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
    xmpText +
    '\n<?xpacket end="w"?>';
  const payload = encodeUtf8(XMP_SIG + packet);
  if (payload.length > MAX_SEGMENT_PAYLOAD) {
    // Splitting into Extended XMP is the standard answer, but our packets run a
    // few KB and this would mean something has gone badly wrong upstream.
    throw new Error(
      `XMP packet too large for one APP1 segment (${payload.length} bytes, max ${MAX_SEGMENT_PAYLOAD})`
    );
  }
  const length = payload.length + 2;
  const segment = new Uint8Array(4 + payload.length);
  segment.set([0xff, 0xe1, (length >> 8) & 0xff, length & 0xff], 0);
  segment.set(payload, 4);

  const surviving = parsed.list.filter((s) => !s.isXmp && !s.isExtendedXmp);
  const insertAt = surviving.length && surviving[0].marker === 0xe0 ? surviving[0].end : 2;

  // Everything from insertAt on, minus the XMP segments being replaced.
  const tail = [];
  let cursor = insertAt;
  for (const seg of parsed.list) {
    if (seg.start < insertAt || (!seg.isXmp && !seg.isExtendedXmp)) continue;
    tail.push(bytes.subarray(cursor, seg.start));
    cursor = seg.end;
  }
  tail.push(bytes.subarray(cursor));

  const head = bytes.subarray(0, insertAt);
  const total = head.length + segment.length + tail.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  out.set(head, offset);
  offset += head.length;
  out.set(segment, offset);
  offset += segment.length;
  for (const piece of tail) {
    out.set(piece, offset);
    offset += piece.length;
  }
  return out;
}

// Every XMP segment removed and nothing added. Used when an import is asked to
// start from camera defaults: leaving a packet in place would make ACR develop
// from the previous owner's settings.
function stripPacket(bytes) {
  const parsed = segments(bytes);
  if (!parsed) throw new Error("Not a JPEG (no SOI marker)");
  const pieces = [];
  let cursor = 0;
  for (const seg of parsed.list) {
    if (!seg.isXmp && !seg.isExtendedXmp) continue;
    pieces.push(bytes.subarray(cursor, seg.start));
    cursor = seg.end;
  }
  if (!pieces.length) return bytes; // nothing to strip - hand back the original
  pieces.push(bytes.subarray(cursor));
  const out = new Uint8Array(pieces.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const piece of pieces) {
    out.set(piece, offset);
    offset += piece.length;
  }
  return out;
}

module.exports = {
  isJpegPath,
  isJpeg,
  readPacket,
  readState,
  writePacket,
  stripPacket,
  segments,
  JPEG_EXTENSIONS,
};
