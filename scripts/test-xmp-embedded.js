// Correctness tests for the JPEG XMP container, run against REAL files.
//
//   node scripts/test-xmp-embedded.js [path/to/a.jpg ...]
//
// xmpEmbedded.js has no photoshop/uxp imports, so the whole byte-level surface
// is checkable without launching Photoshop - which matters, because this module
// rewrites the user's image files and a bug here corrupts photos.
//
// The invariants worth defending, in order of how bad it is to break them:
//   1. scan data is preserved byte-for-byte  (no re-encoding, no quality loss)
//   2. non-XMP segments survive              (EXIF must not be eaten)
//   3. what we write, we can read back       (round-trip through xmpSidecar)
//   4. writing twice == writing once         (packets must not accumulate)
//   5. malformed input is refused, not mangled
const fs = require("fs");
const path = require("path");
const embedded = require("../CreaCon/src/executor/xmpEmbedded");
const xmp = require("../CreaCon/src/executor/xmpSidecar");

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}${detail ? "  " + detail : ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? "  " + detail : ""}`);
  }
}

function read(file) {
  return new Uint8Array(fs.readFileSync(file));
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Everything from SOS onward: the compressed image. If this ever differs, the
// picture has been altered and the whole "no generation loss" claim is void.
function scanData(bytes) {
  const parsed = embedded.segments(bytes);
  return bytes.subarray(parsed.sosAt);
}

function nonXmpMarkers(bytes) {
  return embedded
    .segments(bytes)
    .list.filter((s) => !s.isXmp && !s.isExtendedXmp)
    .map((s) => s.marker);
}

const SAMPLE_XML = xmp.serialize({ Exposure2012: -2, Saturation: -100, Texture: 29 });

function testFile(file) {
  console.log(`\n${path.basename(file)}`);
  const original = read(file);

  if (!embedded.isJpeg(original)) {
    check("is a JPEG", false, "(no SOI marker - skipping)");
    return;
  }

  const hadPacket = embedded.readPacket(original);
  console.log(
    `  (${original.length.toLocaleString()} bytes, ` +
      `${hadPacket ? `existing packet ${hadPacket.bytes} bytes` : "no XMP packet"})`
  );

  // --- write ------------------------------------------------------------------
  const written = embedded.writePacket(original, SAMPLE_XML);

  check("scan data preserved byte-for-byte", sameBytes(scanData(original), scanData(written)));
  check(
    "non-XMP segments preserved (EXIF included)",
    JSON.stringify(nonXmpMarkers(original)) === JSON.stringify(nonXmpMarkers(written)),
    `[${nonXmpMarkers(original).map((m) => "0x" + m.toString(16))}]`
  );
  check(
    "exactly one XMP segment afterwards",
    embedded.segments(written).list.filter((s) => s.isXmp).length === 1
  );

  // --- read back --------------------------------------------------------------
  const state = embedded.readState(written);
  check("readState returns the packet", state !== null);
  if (state) {
    const parsed = xmp.parse(state);
    check("round-trips Exposure2012", parsed.Exposure2012 === -2, `got ${parsed.Exposure2012}`);
    check("round-trips Saturation", parsed.Saturation === -100, `got ${parsed.Saturation}`);
    check("round-trips Texture", parsed.Texture === 29, `got ${parsed.Texture}`);
  }

  // --- idempotence ------------------------------------------------------------
  const twice = embedded.writePacket(written, SAMPLE_XML);
  check("writing twice equals writing once", sameBytes(twice, written));

  // --- strip ------------------------------------------------------------------
  const stripped = embedded.stripPacket(written);
  check("stripPacket removes every XMP segment", embedded.readPacket(stripped) === null);
  check("stripPacket preserves scan data", sameBytes(scanData(original), scanData(stripped)));
  check(
    "stripPacket keeps the other segments",
    JSON.stringify(nonXmpMarkers(original)) === JSON.stringify(nonXmpMarkers(stripped))
  );
  check("readState on a stripped file is null", embedded.readState(stripped) === null);

  // A file whose packet carries no crs: keys is NOT develop state - reading it
  // as such would make a fresh import look like it already had edits.
  const plainXmp = embedded.writePacket(
    original,
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/></x:xmpmeta>'
  );
  check("packet without crs: keys reads as no state", embedded.readState(plainXmp) === null);
}

function testMalformed() {
  console.log("\nmalformed input");
  check("empty buffer is not a JPEG", !embedded.isJpeg(new Uint8Array(0)));
  check("random bytes are not a JPEG", !embedded.isJpeg(new Uint8Array([1, 2, 3, 4, 5])));
  check("readPacket on non-JPEG is null", embedded.readPacket(new Uint8Array([1, 2, 3])) === null);
  check("readState on non-JPEG is null", embedded.readState(new Uint8Array([1, 2, 3])) === null);

  let threw = false;
  try {
    embedded.writePacket(new Uint8Array([1, 2, 3]), SAMPLE_XML);
  } catch {
    threw = true;
  }
  check("writePacket refuses a non-JPEG", threw);

  // A packet larger than one APP1 segment must be refused rather than silently
  // truncated - truncation would write a corrupt file.
  threw = false;
  try {
    embedded.writePacket(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), "x".repeat(70000));
  } catch {
    threw = true;
  }
  check("writePacket refuses an oversized packet", threw);
}

const files = process.argv.slice(2);
if (!files.length) {
  // Any JPEG will do - these are the ones that ship with the repo.
  const dir = path.join(__dirname, "..", "backend", "debug_overlays");
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir).filter((n) => /\.jpe?g$/i.test(n)).slice(0, 2)) {
      files.push(path.join(dir, name));
    }
  }
}
if (!files.length) {
  console.error("No JPEGs to test. Pass one or more paths as arguments.");
  process.exit(2);
}

for (const file of files) testFile(file);
testMalformed();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
