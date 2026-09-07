// Correctness tests for path identity and the registry's v1 -> v2 migration.
//
//   node scripts/test-registry.js
//
// pathKey.js is pure, and rawRegistry.js requires uxp only lazily (inside the
// disk functions), so both load under plain node and the parts with real failure
// modes are testable without Photoshop.
//
// Why these two in particular:
//   - canonical() decides whether two spellings of a path are the SAME PHOTO.
//     Fail to converge and a photo silently stops being develop-editable;
//     converge wrongly and CreaCon writes settings into the wrong photo.
//   - migrateStore() runs once against a registry a user already has. Getting it
//     wrong orphans every photo they have ever imported.
const pathKey = require("../CreaCon/src/executor/pathKey");
const registry = require("../CreaCon/src/executor/rawRegistry");

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

console.log("\npathKey.canonical - spellings of the same file must converge");
const WIN = "C:\\Users\\sharl\\Pictures\\DSCF0426.raf";
check("backslashes vs forward slashes", pathKey.sameFile(WIN, "C:/Users/sharl/Pictures/DSCF0426.raf"));
check("case differences (Windows)", pathKey.sameFile(WIN, "c:\\users\\SHARL\\pictures\\dscf0426.RAF"));
check("file:/// URL form", pathKey.sameFile(WIN, "file:///C:/Users/sharl/Pictures/DSCF0426.raf"));
check("file:// URL form", pathKey.sameFile(WIN, "file://C:/Users/sharl/Pictures/DSCF0426.raf"));
check(
  "percent-encoded spaces",
  pathKey.sameFile("C:\\My Photos\\a b.jpg", "file:///C:/My%20Photos/a%20b.jpg")
);
check("doubled separators", pathKey.sameFile("C:\\a\\\\b\\c.jpg", "C:/a/b/c.jpg"));
check("trailing separator", pathKey.sameFile("C:\\a\\b\\", "C:/a/b"));

console.log("\npathKey.canonical - genuinely different files must NOT converge");
check("different folders, same name", !pathKey.sameFile("C:\\a\\x.jpg", "C:\\b\\x.jpg"));
check("different extensions", !pathKey.sameFile("C:\\a\\x.jpg", "C:\\a\\x.raf"));
check("empty is never equal to itself", !pathKey.sameFile("", ""));
check("empty vs a real path", !pathKey.sameFile("", WIN));
check("null-safe", pathKey.canonical(null) === "" && pathKey.canonical(undefined) === "");

console.log("\npathKey.baseName");
check("windows path", pathKey.baseName(WIN) === "DSCF0426.raf", pathKey.baseName(WIN));
check("posix path", pathKey.baseName("/a/b/c.jpg") === "c.jpg");
check("bare name", pathKey.baseName("c.jpg") === "c.jpg");

console.log("\nmigrateStore - v1 (docKey -> layerId -> entry) becomes path-keyed");
const V1 = {
  "C:\\Docs\\a.psd": {
    6: { rawPath: "C:\\Pics\\DSCF0657.raf", lastSettings: { Exposure2012: 1 }, aspect: 1.5 },
    7: {
      filePath: "C:\\Cache\\photo-abc.jpg",
      sourcePath: "C:\\Pics\\photo.jpg",
      kind: "jpeg",
      stateXml: "<x/>",
    },
  },
  "C:\\Docs\\b.psd": {
    // Same photo as a.psd layer 6, reached from a different document.
    2: { rawPath: "C:/pics/dscf0657.raf", stateXml: "<better/>" },
    // No path at all: an embedded smart object from an older version.
    3: { lastSettings: { Dehaze: 20 } },
  },
};
const v2 = registry.migrateStore(JSON.parse(JSON.stringify(V1)));

check("stamps the current version", v2.version === registry.STORE_VERSION);
check("collapses duplicate paths to one photo", Object.keys(v2.photos).length === 2, `got ${Object.keys(v2.photos).length}`);

const raf = v2.photos[pathKey.canonical("C:\\Pics\\DSCF0657.raf")];
check("v1 rawPath becomes filePath", raf && raf.filePath === "C:\\Pics\\DSCF0657.raf");
check("sourcePath defaults to filePath for raws", raf && raf.sourcePath === "C:\\Pics\\DSCF0657.raf");
check("carries lastSettings across", raf && raf.lastSettings && raf.lastSettings.Exposure2012 === 1);
check("carries aspect across", raf && raf.aspect === 1.5);
check(
  "duplicate resolution prefers the entry WITH a state mirror",
  raf && raf.stateXml === "<better/>",
  `got ${raf && raf.stateXml}`
);

const jpeg = v2.photos[pathKey.canonical("C:\\Cache\\photo-abc.jpg")];
check("keeps a JPEG's separate sourcePath", jpeg && jpeg.sourcePath === "C:\\Pics\\photo.jpg");
check("keeps kind", jpeg && jpeg.kind === "jpeg");

check("pathless entries go to legacy", Object.keys(v2.legacy["C:\\Docs\\b.psd"] || {}).length === 1);
check("legacy keeps its layer id", Boolean((v2.legacy["C:\\Docs\\b.psd"] || {})["3"]));
check("pathless entries are NOT in photos", !Object.values(v2.photos).some((p) => !p.filePath));

console.log("\nmigrateStore - degenerate input must not throw");
check("null", registry.migrateStore(null).version === registry.STORE_VERSION);
check("empty object", Object.keys(registry.migrateStore({}).photos).length === 0);
check("a string", registry.migrateStore("nonsense").version === registry.STORE_VERSION);
check(
  "junk values inside a doc bucket are skipped",
  Object.keys(registry.migrateStore({ "C:\\d.psd": { 1: null, 2: "x" } }).photos).length === 0
);

console.log("\nmigrateStore - already v2 passes through unchanged");
const already = { version: registry.STORE_VERSION, photos: { "c:/a.jpg": { filePath: "C:\\a.jpg" } }, legacy: {} };
const again = registry.migrateStore(already);
check("photos preserved", again.photos["c:/a.jpg"].filePath === "C:\\a.jpg");
check("migrating twice is stable", JSON.stringify(registry.migrateStore(again)) === JSON.stringify(again));

console.log("\ncheckpoints are keyed by path, not by layer");
const id = registry.saveCheckpoint("C:\\Pics\\x.raf", "<before/>", "test");
check("returns an id", Boolean(id));
check("reads back by the same path", registry.checkpointXml("C:\\Pics\\x.raf", id) === "<before/>");
check(
  "reads back by a different spelling of that path",
  registry.checkpointXml("c:/pics/X.RAF", id) === "<before/>"
);
check("unknown id is undefined", registry.checkpointXml("C:\\Pics\\x.raf", "nope") === undefined);
check("unknown path is undefined", registry.checkpointXml("C:\\Pics\\other.raf", id) === undefined);
check("null xml round-trips as null (a restorable state)", (() => {
  const nullId = registry.saveCheckpoint("C:\\Pics\\y.raf", null, "none");
  return registry.checkpointXml("C:\\Pics\\y.raf", nullId) === null;
})());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
