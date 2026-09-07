// Correctness tests for the cache sweep's classification rules.
//
//   node scripts/test-cache-sweep.js
//
// This is the logic that decides whether a file gets DELETED, so it is worth
// checking without Photoshop in the loop. cacheSweep requires photoCache lazily
// for exactly that reason.
//
// The rules that matter, in order of how bad it is to break them:
//   1. never propose a copy whose ORIGINAL is gone - it holds the only surviving
//      pixels of that photo
//   2. never propose a copy of unknown origin - it cannot be rebuilt
//   3. never propose something merely unobserved - mark it and start its clock,
//      or the first run after shipping sweeps everything
//   4. only propose after the full grace period
const sweep = require("../CreaCon/src/executor/cacheSweep");

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

const NOW = 1_800_000_000_000; // fixed clock, so these never rot
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => NOW - n * DAY;
const entry = (over) => ({
  filePath: "C:\\Cache\\p-abc.jpg",
  sourcePath: "C:\\Pics\\p.jpg",
  lastSeenAt: daysAgo(200),
  ...over,
});

console.log("\nrefusals - these must NEVER be proposed for deletion");
check(
  "no registry entry (unknown origin, cannot be rebuilt)",
  sweep.classifyFile(null, false, NOW).removable === false
);
check(
  "unknown origin is reported as such",
  sweep.classifyFile(null, false, NOW).reason === sweep.REASON.NO_ENTRY
);
check(
  "original missing - our copy is the last copy",
  sweep.classifyFile(entry(), false, NOW).removable === false
);
check(
  "original missing is reported as such",
  sweep.classifyFile(entry(), false, NOW).reason === sweep.REASON.NO_SOURCE
);
check(
  "entry with no sourcePath at all",
  sweep.classifyFile(entry({ sourcePath: null }), true, NOW).removable === false
);
check(
  "ancient but original missing still refused",
  sweep.classifyFile(entry({ lastSeenAt: daysAgo(9999) }), false, NOW).removable === false
);

console.log("\nmark and sweep - never observed means start the clock, not delete");
const marked = sweep.classifyFile(entry({ lastSeenAt: null }), true, NOW);
check("unobserved is not removable", marked.removable === false);
check("unobserved is reported as newly marked", marked.reason === sweep.REASON.MARKED);
check(
  "unobserved with a missing original still refuses for the SAFER reason",
  sweep.classifyFile(entry({ lastSeenAt: null }), false, NOW).reason === sweep.REASON.NO_SOURCE
);

console.log("\ngrace period");
check(
  "seen today is in use",
  sweep.classifyFile(entry({ lastSeenAt: NOW }), true, NOW).reason === sweep.REASON.IN_USE
);
check(
  "one day short of the grace period is kept",
  sweep.classifyFile(entry({ lastSeenAt: daysAgo(sweep.GRACE_DAYS - 1) }), true, NOW)
    .removable === false
);
check(
  "exactly the grace period is removable",
  sweep.classifyFile(entry({ lastSeenAt: daysAgo(sweep.GRACE_DAYS) }), true, NOW).removable === true
);
check(
  "well past the grace period is removable",
  sweep.classifyFile(entry({ lastSeenAt: daysAgo(365) }), true, NOW).removable === true
);
check(
  "reports how long it has been idle",
  sweep.classifyFile(entry({ lastSeenAt: daysAgo(365) }), true, NOW).idleDays === 365
);
check(
  "a future stamp (clock skew) is treated as in use, not deleted",
  sweep.classifyFile(entry({ lastSeenAt: NOW + 10 * DAY }), true, NOW).removable === false
);

console.log("\nformatBytes");
check("KB", sweep.formatBytes(2048) === "2 KB", sweep.formatBytes(2048));
check("MB", sweep.formatBytes(11 * 1024 * 1024) === "11 MB", sweep.formatBytes(11 * 1024 * 1024));
check("GB", sweep.formatBytes(3 * 1024 ** 3) === "3.0 GB", sweep.formatBytes(3 * 1024 ** 3));
check("a tiny file never reads as 0", sweep.formatBytes(10) === "1 KB", sweep.formatBytes(10));

console.log("\ndescribe - must state what is KEPT and why, not just what goes");
check("empty cache", sweep.describe({ totalCount: 0, totalBytes: 0, removable: [], kept: [] }).includes("empty"));

const summary = sweep.describe({
  totalCount: 4,
  totalBytes: 40 * 1024 * 1024,
  removable: [{ bytes: 10 * 1024 * 1024 }, { bytes: 10 * 1024 * 1024 }],
  kept: [{ reason: sweep.REASON.NO_SOURCE }, { reason: sweep.REASON.NO_ENTRY }],
});
check("counts the removable", summary.includes("2 unused"));
check("says a rebuild is possible", summary.toLowerCase().includes("rebuilt"));
check("explains the missing original", summary.includes("original photo is gone"));
check("explains the unknown origin", summary.includes("origin is unknown"));

const nothing = sweep.describe({
  totalCount: 2,
  totalBytes: 1024,
  removable: [],
  kept: [{ reason: sweep.REASON.IN_USE }, { reason: sweep.REASON.IN_USE }],
});
check("says plainly when nothing is old enough", nothing.includes("Nothing has been unused"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
