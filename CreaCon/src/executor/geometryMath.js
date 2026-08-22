// Pure geometry for crop / straighten / perspective. No Photoshop, no XMP, no
// I/O - so every claim here is testable in plain node against the real sidecars
// in the project's test raws. That matters: this module decides how much of a
// photo a correction throws away, and a silent error would misframe pictures.
//
// COORDINATE SPACES (established from real ACR 18.4 sidecars, see the plan):
//
//   raw -> [lens correction] -> SENSOR SPACE -> [perspective warp H] -> [crop] -> preview
//                               ^^^^^^^^^^^^
//                               masks are stored HERE
//
// Lens correction sits UPSTREAM of the mask coordinate frame, so it cancels out
// of every conversion below - proven by a gradient drawn vertical with lens
// correction ON that lands at 0.52 deg from vertical once warped by H alone.
// Only the warp and the crop have to be undone, and both are in the sidecar.
//
// All coordinates are normalized 0..1 (x across width, y down height). Because
// that makes them anisotropic on a non-square frame, anything measuring a real
// ANGLE or DISTANCE takes the frame aspect ratio.

// --- 3x3 homographies (row-major, ACR's UprightTransform_N layout) -------------

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function isIdentity(H) {
  return !H || H.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-9);
}

// Maps a point through H. ACR's matrices act on normalized coords with the
// origin at the top-left corner (verified: the frame centre maps to itself under
// a pure-rotation Upright).
function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return {
    x: (H[0] * x + H[1] * y + H[2]) / w,
    y: (H[3] * x + H[4] * y + H[5]) / w,
  };
}

function invertH(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null; // degenerate
  return [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ];
}

// --- wedge detection ------------------------------------------------------------

// Where the photo's four corners land after the warp, in frame order.
function warpedCorners(H) {
  return [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => applyH(H, x, y));
}

// A homography maps a rectangle to a convex quad, so "inside" is a consistent
// sign of the cross product against all four edges.
function insideQuad(quad, px, py) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const cross = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
    if (cross === 0) continue; // exactly on an edge counts as inside
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

// Does the warped photo still fill the frame, or are there transparent wedges?
//
// Upright hides its own wedges by ZOOMING rather than cropping - but only while
// the zoom is enough. Beyond that it gives up and the corners show through.
// Verified: predicts wedges on DSCF0528 (diagonal terms < 1, the photo shrinks)
// and none on DSCF1136 (terms > 1, it zooms in).
function frameCoverage(H) {
  const quad = warpedCorners(H);
  const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const names = ["topLeft", "topRight", "bottomRight", "bottomLeft"];
  const uncovered = names.filter((_, i) => !insideQuad(quad, corners[i][0], corners[i][1]));
  return { covered: uncovered.length === 0, uncovered, quad };
}

// Largest centred rectangle of the ORIGINAL aspect ratio that fits inside the
// warped photo - i.e. the crop that removes the wedges. Binary search on scale
// against the same point-in-quad test; monotonic, so it converges cleanly.
//
// Centred is a deliberate simplification: an off-centre rectangle could keep a
// little more on an asymmetric warp, at the cost of moving the framing in a way
// the user did not ask for.
function correctiveCrop(H) {
  const { covered, quad } = frameCoverage(H);
  if (covered) return { needed: false, scale: 1, retained: 1, crop: null };
  let lo = 0;
  let hi = 1;
  for (let n = 0; n < 60; n++) {
    const k = (lo + hi) / 2;
    const half = k / 2;
    const fits = [
      [0.5 - half, 0.5 - half], [0.5 + half, 0.5 - half],
      [0.5 + half, 0.5 + half], [0.5 - half, 0.5 + half],
    ].every(([x, y]) => insideQuad(quad, x, y));
    if (fits) lo = k;
    else hi = k;
  }
  const half = lo / 2;
  return {
    needed: true,
    scale: lo,
    retained: lo * lo,
    crop: { left: 0.5 - half, top: 0.5 - half, right: 0.5 + half, bottom: 0.5 + half },
  };
}

// --- straighten -----------------------------------------------------------------

// Largest axis-aligned rectangle of the original aspect that fits inside a WxH
// frame rotated by `deg`. Used only to PREDICT the cost of a straighten - ACR
// computes the actual crop itself when given CropAngle plus a full-frame rect.
//
// Half-extents (u,v) with u/v held at W/H must satisfy BOTH
//   u*cos + v*sin <= W/2   and   u*sin + v*cos <= H/2
// which normalise to two DIFFERENT ratios, so the answer is their min.
// Collapsing them into one numerator silently breaks portrait orientation -
// verified against a brute-force corner search.
//
// Straightening is expensive on 3:2: 1 deg costs 5%, 3 deg 14%, 5 deg 21%,
// 10 deg 35%. Bound the COST, not the angle.
function maxInscribedCrop(width, height, deg) {
  const rad = (Math.abs(deg) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const s = Math.min(
    width / (width * cos + height * sin),
    height / (width * sin + height * cos)
  );
  const half = s / 2;
  return {
    scale: s,
    retained: s * s,
    crop: { left: 0.5 - half, top: 0.5 - half, right: 0.5 + half, bottom: 0.5 + half },
  };
}

// --- mask drift -----------------------------------------------------------------

// How far the warp moves points across the frame, as a fraction of the frame
// DIAGONAL (aspect-corrected, so it is a real distance rather than a mix of two
// differently-scaled axes).
//
// This is what an existing mask visibly shifts by on screen. The mask stays glued
// to its subject - it warps along with the photo - but a carefully placed one
// will look different afterwards, which is worth telling the user.
function driftStats(H, aspect = 1.5, steps = 20) {
  if (isIdentity(H)) return { max: 0, mean: 0 };
  const diag = Math.hypot(aspect, 1);
  let max = 0;
  let sum = 0;
  let n = 0;
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const x = i / steps;
      const y = j / steps;
      const p = applyH(H, x, y);
      const d = Math.hypot((p.x - x) * aspect, p.y - y) / diag;
      if (d > max) max = d;
      sum += d;
      n++;
    }
  }
  return { max, mean: sum / n };
}

// --- preview <-> sensor ---------------------------------------------------------

// The crop rectangle as normalized sensor coords + its rotation, or null when the
// photo is uncropped.
function cropRectOf(geometry) {
  const g = geometry || {};
  if (!g.HasCrop) return null;
  const left = g.CropLeft ?? 0;
  const top = g.CropTop ?? 0;
  const right = g.CropRight ?? 1;
  const bottom = g.CropBottom ?? 1;
  if (!(right > left) || !(bottom > top)) return null;
  return { left, top, right, bottom, angle: g.CropAngle ?? 0 };
}

// Converts a point from PREVIEW space (0..1 across the cropped, rotated, warped
// image the model is shown) to SENSOR space (what ACR resolves mask coordinates
// against). Undo the crop first, then the warp - the pipeline applies them in the
// opposite order.
//
// The crop half is exact: a gradient dragged horizontal on a -16.5 deg crop is
// stored at 17.0 deg, i.e. ACR does NOT apply the crop rotation for us, and the
// rotation uses CropAngle's signed value directly with no negation.
//
// Without this, every mask on a cropped raw lands wrong in proportion to the
// crop: on a crop keeping the bottom 80%, a horizon the model reads at 0.6 of
// what it sees would be written as sensor 0.6 and render at 0.5.
//
// `aspect` is width/height; only the RATIO matters, not pixel dimensions.
function previewToSensor(u, v, { crop = null, warp = null, aspect = 1.5 } = {}) {
  let x = u;
  let y = v;

  if (crop) {
    const cx = (crop.left + crop.right) / 2;
    const cy = (crop.top + crop.bottom) / 2;
    // Offsets inside the rotated crop frame, expressed against a width of 1 and
    // a height of 1/aspect so the rotation below is geometrically true.
    const px = (u - 0.5) * (crop.right - crop.left);
    const py = ((v - 0.5) * (crop.bottom - crop.top)) / aspect;
    const rad = ((crop.angle || 0) * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    x = cx + (px * cos - py * sin);
    y = cy + (px * sin + py * cos) * aspect;
  }

  if (warp && !isIdentity(warp)) {
    const inv = invertH(warp);
    if (inv) {
      const p = applyH(inv, x, y);
      x = p.x;
      y = p.y;
    }
  }
  return { x, y };
}

// Inverse of previewToSensor: sensor -> what the model sees. Used when SHOWING
// the current develop state, so the model always reads and writes coordinates in
// the one space it can actually observe.
function sensorToPreview(x, y, { crop = null, warp = null, aspect = 1.5 } = {}) {
  let u = x;
  let v = y;

  if (warp && !isIdentity(warp)) {
    const p = applyH(warp, u, v);
    u = p.x;
    v = p.y;
  }

  if (crop) {
    const cx = (crop.left + crop.right) / 2;
    const cy = (crop.top + crop.bottom) / 2;
    const rad = ((crop.angle || 0) * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const dx = u - cx;
    const dy = (v - cy) / aspect;
    const px = dx * cos + dy * sin; // rotate by -angle
    const py = -dx * sin + dy * cos;
    u = 0.5 + px / (crop.right - crop.left);
    v = 0.5 + (py * aspect) / (crop.bottom - crop.top);
  }
  return { x: u, y: v };
}

// --- mask coordinate remapping ---------------------------------------------------

// The model reads mask positions off the PREVIEW; ACR resolves them against the
// SENSOR. Every mask crossing that boundary is remapped here.
//
// Shape-specific, because the three mask types carry position differently:
//   Mask/Gradient          two points (Zero/Full) - map both
//   Mask/CircularGradient  an ellipse (Top/Left/Bottom/Right + Angle) - map the
//                          centre, rescale the extents, offset the angle
//   Mask/Paint             a list of [x,y,r] dabs - map each
//
// `toSensor` picks the direction. Returns a new mask; the input is untouched.
function remapMask(mask, toSensor, opts = {}) {
  const { crop = null, aspect = 1.5 } = opts;
  if (!crop) return mask; // nothing to undo
  const map = (x, y) => (toSensor ? previewToSensor(x, y, opts) : sensorToPreview(x, y, opts));
  const out = { ...mask };

  if (mask.What === "Mask/Gradient") {
    if (typeof mask.ZeroX === "number" && typeof mask.ZeroY === "number") {
      const p = map(mask.ZeroX, mask.ZeroY);
      out.ZeroX = p.x;
      out.ZeroY = p.y;
    }
    if (typeof mask.FullX === "number" && typeof mask.FullY === "number") {
      const p = map(mask.FullX, mask.FullY);
      out.FullX = p.x;
      out.FullY = p.y;
    }
    return out;
  }

  if (mask.What === "Mask/CircularGradient") {
    const { Top, Left, Bottom, Right } = mask;
    if ([Top, Left, Bottom, Right].every((n) => typeof n === "number")) {
      const c = map((Left + Right) / 2, (Top + Bottom) / 2);
      // A rotation preserves lengths, so only the crop's SIZE rescales the
      // ellipse; the crop's angle rotates it, which ACR carries in `Angle`.
      const sx = toSensor ? crop.right - crop.left : 1 / (crop.right - crop.left);
      const sy = toSensor ? crop.bottom - crop.top : 1 / (crop.bottom - crop.top);
      const halfW = ((Right - Left) / 2) * sx;
      const halfH = ((Bottom - Top) / 2) * sy;
      out.Left = c.x - halfW;
      out.Right = c.x + halfW;
      out.Top = c.y - halfH;
      out.Bottom = c.y + halfH;
      // UNVERIFIED SIGN. A rotated crop must rotate the ellipse with it, and the
      // magnitude is certainly CropAngle - but whether ACR's `Angle` measures in
      // the same direction as `CropAngle` has never been checked against a real
      // sidecar (none of the test files contain a radial mask). Harmless while
      // the ellipse is circular, which is the common case; on an elongated one
      // over a rotated crop a wrong sign tilts it by twice the crop angle.
      // Settle it with: rotated crop + a deliberately elongated radial, then
      // read Angle back out of the .xmp.
      const delta = (crop.angle || 0) * (toSensor ? 1 : -1);
      out.Angle = (((mask.Angle || 0) + delta) % 360 + 360) % 360;
    }
    return out;
  }

  if (mask.What === "Mask/Paint" && Array.isArray(mask.Dabs)) {
    const sx = toSensor ? crop.right - crop.left : 1 / (crop.right - crop.left);
    out.Dabs = mask.Dabs.map((pt) => {
      const p = map(pt[0], pt[1]);
      return pt.length > 2 ? [p.x, p.y, pt[2] * sx] : [p.x, p.y];
    });
    return out;
  }

  return out;
}

// Walks a full MaskGroupBasedCorrections array. Corrections marked Unsupported
// are opaque passthroughs whose coordinates we never parsed, so they are left
// strictly alone.
function remapCorrections(corrections, toSensor, opts = {}) {
  if (!Array.isArray(corrections) || !opts.crop) return corrections;
  return corrections.map((correction) => {
    if (correction.Unsupported || !Array.isArray(correction.CorrectionMasks)) return correction;
    return {
      ...correction,
      CorrectionMasks: correction.CorrectionMasks.map((m) => remapMask(m, toSensor, opts)),
    };
  });
}

module.exports = {
  IDENTITY,
  isIdentity,
  sensorToPreview,
  remapMask,
  remapCorrections,
  applyH,
  invertH,
  warpedCorners,
  insideQuad,
  frameCoverage,
  correctiveCrop,
  maxInscribedCrop,
  driftStats,
  cropRectOf,
  previewToSensor,
};
