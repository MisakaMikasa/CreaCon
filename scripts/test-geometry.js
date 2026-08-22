// Correctness tests for the geometry layer, run against REAL ACR sidecars.
//
//   node scripts/test-geometry.js [path/to/raws]
//
// Both modules under test are pure (no photoshop/uxp imports), so the bulk of the
// correctness surface is checkable without launching Photoshop. Ground truth is
// four sidecars written by ACR 18.4 on a Fujifilm X-S20, covering the cases that
// actually differ: uncropped, cropped, rotated crop, Upright with wedges, and
// Upright without.
const fs = require("fs");
const path = require("path");
const xmp = require("../CreaCon/src/executor/xmpSidecar");
const geo = require("../CreaCon/src/executor/geometryMath");

const DIR = process.argv[2] || "C:/Users/sharl/OneDrive/Pictures/Japan 2026 RAW";
const ASPECT = 6240 / 4160;

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
const close = (a, b, tol) => Math.abs(a - b) <= tol;

// --- pure maths, no files -------------------------------------------------------

console.log("\ninscribed crop (vs brute-force corner search)");
{
  const brute = (W, H, deg) => {
    const r = (Math.abs(deg) * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    const inside = (x, y) =>
      Math.abs(x * c + y * s) <= W / 2 + 1e-9 && Math.abs(-x * s + y * c) <= H / 2 + 1e-9;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 60; i++) {
      const k = (lo + hi) / 2;
      const u = (k * W) / 2;
      const v = (k * H) / 2;
      const ok = [[u, v], [u, -v], [-u, v], [-u, -v]].every(([x, y]) => inside(x, y));
      if (ok) lo = k;
      else hi = k;
    }
    return lo;
  };
  for (const [W, H, label] of [[6240, 4160, "landscape"], [4160, 6240, "portrait"], [4000, 4000, "square"]]) {
    for (const d of [0, 1, 3, 5, 10]) {
      const got = geo.maxInscribedCrop(W, H, d).scale;
      check(`${label} @${d}deg`, close(got, brute(W, H, d), 1e-9), `scale=${got.toFixed(5)}`);
    }
  }
  // Orientation symmetry: a 3:2 frame loses the same fraction either way up.
  const land = geo.maxInscribedCrop(6240, 4160, 5).retained;
  const port = geo.maxInscribedCrop(4160, 6240, 5).retained;
  check("orientation symmetric", close(land, port, 1e-12), `${(land * 100).toFixed(1)}%`);
}

console.log("\nhomography round-trip");
{
  const H = [1.0454, 0.0153, -0.0168, 0.0261, 1.0904, -0.0275, -0.0169, 0.0629, 1.0];
  const inv = geo.invertH(H);
  const p = geo.applyH(inv, ...Object.values(geo.applyH(H, 0.37, 0.81)));
  check("H then H^-1 is identity", close(p.x, 0.37, 1e-9) && close(p.y, 0.81, 1e-9));
  check("degenerate matrix returns null", geo.invertH([0, 0, 0, 0, 0, 0, 0, 0, 0]) === null);
  check("identity detected", geo.isIdentity(geo.IDENTITY));
}

// --- against the real sidecars --------------------------------------------------

const files = ["DSCF0919.xmp", "DSCF0929.xmp", "DSCF1136.xmp", "DSCF0528.xmp"]
  .map((f) => path.join(DIR, f))
  .filter((f) => fs.existsSync(f));

if (!files.length) {
  console.log(`\nSKIPPED sidecar tests - no files found in ${DIR}`);
} else {
  console.log("\nsidecar round-trip (geometry must survive serialize -> parse)");
  for (const f of files) {
    const parsed = xmp.parseFull(fs.readFileSync(f, "utf-8"));
    const back = xmp.parseGeometry(xmp.serialize(parsed.settings, parsed.extras, parsed.geometry));
    const keys = Object.keys(parsed.geometry);
    const same =
      keys.length === Object.keys(back).length &&
      keys.every((k) => String(parsed.geometry[k]) === String(back[k]));
    check(path.basename(f), same, `${keys.length} keys`);
  }

  console.log("\ncrop preservation (the regression that would un-crop photos)");
  for (const f of files) {
    const parsed = xmp.parseFull(fs.readFileSync(f, "utf-8"));
    if (!parsed.geometry.HasCrop) continue;
    // A colour-only edit that knows nothing about geometry must not drop the crop.
    const out = xmp.parseGeometry(
      xmp.serialize({ Exposure2012: 0.5 }, parsed.extras, parsed.geometry)
    );
    check(
      `${path.basename(f)} keeps crop through a colour edit`,
      out.HasCrop === true && out.CropAngle === parsed.geometry.CropAngle
    );
  }

  console.log("\nUpright cache is stripped on geometry change");
  for (const f of files) {
    const parsed = xmp.parseFull(fs.readFileSync(f, "utf-8"));
    const before = Object.keys(parsed.extras.rootAttrs).filter((k) => /^Upright/.test(k)).length;
    if (!before) continue;
    const after = Object.keys(xmp.withoutUprightCache(parsed.extras).rootAttrs).filter((k) =>
      /^Upright/.test(k)
    ).length;
    check(`${path.basename(f)} ${before} cache keys removed`, after === 0);
  }

  console.log("\nwedge prediction (ground truth: 0528 wedges, 1136 does not)");
  const expected = { "DSCF0528.xmp": true, "DSCF1136.xmp": false, "DSCF0919.xmp": false };
  for (const f of files) {
    const xml = fs.readFileSync(f, "utf-8");
    const H = xmp.activeUprightTransform(xml);
    const name = path.basename(f);
    if (!H) {
      check(`${name} has no Upright`, expected[name] === undefined || expected[name] === false, "(skipped)");
      continue;
    }
    const cov = geo.frameCoverage(H);
    const fix = geo.correctiveCrop(H);
    const drift = geo.driftStats(H, ASPECT);
    check(
      `${name} wedges=${!cov.covered}`,
      expected[name] === undefined || expected[name] === !cov.covered,
      `retain ${(fix.retained * 100).toFixed(1)}%  drift max ${(drift.max * 100).toFixed(1)}% mean ${(drift.mean * 100).toFixed(1)}%`
    );
  }

  console.log("\npreview -> sensor conversion");
  for (const f of files) {
    const xml = fs.readFileSync(f, "utf-8");
    const parsed = xmp.parseFull(xml);
    const crop = geo.cropRectOf(parsed.geometry);
    if (!crop || !crop.angle) continue;
    // A line drawn horizontal in the preview must come out tilted by exactly the
    // crop angle in sensor space - ACR does not apply the crop rotation for us.
    const a = geo.previewToSensor(0.06, 0.5, { crop, aspect: ASPECT });
    const b = geo.previewToSensor(0.94, 0.5, { crop, aspect: ASPECT });
    const tilt = (Math.atan2((b.y - a.y) / ASPECT, b.x - a.x) * 180) / Math.PI;
    check(
      `${path.basename(f)} horizontal preview line -> ${tilt.toFixed(4)}deg`,
      close(tilt, crop.angle, 1e-6),
      `CropAngle=${crop.angle}`
    );
  }
  // No crop and no warp must be a pure passthrough.
  const id = geo.previewToSensor(0.3, 0.7, {});
  check("uncropped, unwarped is identity", id.x === 0.3 && id.y === 0.7);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
