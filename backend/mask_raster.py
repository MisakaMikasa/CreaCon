"""Mask processing: a segmentation raster -> shifted + feathered coverage, and
-> ACR brush dabs.

Provider-agnostic: whatever produced the raster (Gemini segmentation now, SAM
later), the same two agent-controlled knobs shape it:
  EdgeShift (px, at WORK resolution): negative = shrink inward (erode) to keep
     the effect off neighbours; 0 = trace exactly; positive = expand/spill over.
  Feather   (0-100): soft-edge width, realized as a distance-transform ramp for
     the overlay and (later) matched to ACR's brush feather on the dabs.

Everything is computed at WORK_LONG_EDGE so the px units of EdgeShift/Feather are
consistent regardless of the source image size.
"""

import os

WORK_LONG_EDGE = 1280   # process masks at this long edge (matches the preview)
MAX_FEATHER_PX = 60     # Feather=100 -> ~this many px of soft edge at WORK res

# Dab generation (calibration knobs, tunable via env without code edits):
DAB_WORK_EDGE = int(os.environ.get("DAB_WORK_EDGE", "512"))   # coarse buffer for greedy fill (fast; dabs are normalized)
DAB_MIN_R = float(os.environ.get("DAB_MIN_R", "0.006"))       # min dab radius (frac of long edge) so a dab is visible in ACR
DAB_STOP_PX = float(os.environ.get("DAB_STOP_PX", "1.5"))     # greedy fill stops when the deepest uncovered point is this close to an edge
DAB_RADIUS_MULT = float(os.environ.get("DAB_RADIUS_MULT", "1.0"))  # scale ALL emitted dab radii (raise if ACR renders dabs too small to fill)


def _to_work(mask_float):
    """Resize an arbitrary-resolution 0..1 mask to WORK_LONG_EDGE (keep aspect)."""
    import numpy as np
    from PIL import Image

    h, w = mask_float.shape
    scale = WORK_LONG_EDGE / max(w, h)
    if scale < 1.0:
        nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
        img = Image.fromarray((mask_float * 255).astype("uint8")).resize((nw, nh), Image.BILINEAR)
        return np.asarray(img, dtype=np.float32) / 255.0
    return mask_float.astype("float32")


def process(mask_float, feather=50, edge_shift=-3):
    """Segmentation raster (HxW, 0..1) -> feathered coverage (HxW work-res, 0..1).
    Applies EdgeShift (erode/dilate) then a distance-transform feather."""
    import numpy as np
    from scipy import ndimage

    m = _to_work(mask_float)
    binm = m > 0.5
    if not binm.any():
        return np.zeros_like(m)

    n = int(round(abs(edge_shift)))
    if edge_shift < 0 and n:
        eroded = ndimage.binary_erosion(binm, iterations=n)
        if eroded.any():  # never let a shrink erase the whole (thin) region
            binm = eroded
    elif edge_shift > 0 and n:
        binm = ndimage.binary_dilation(binm, iterations=n)

    dist = ndimage.distance_transform_edt(binm)
    max_d = float(dist.max())  # half-thickness of the region's thickest part
    fpx = max(0.0, float(feather) / 100.0 * MAX_FEATHER_PX)
    # Cap the feather so the region's core still reaches full strength - a wide
    # feather must not swallow a thin target (e.g. a pagoda ~30px wide).
    fpx = min(fpx, 0.7 * max_d)
    if fpx >= 1.0:
        cov = np.clip(dist / fpx, 0.0, 1.0)
    else:
        cov = binm.astype(np.float32)
    return cov.astype("float32")


def to_dabs(mask_float, feather=50, edge_shift=-3):
    """Segmentation raster -> ACR brush dabs [(x, y, r)] (normalized, PER-DAB
    radius). Two passes:
      1. INTERIOR fill by greedy maximal-disk covering - repeatedly drop the
         biggest circle that fits at the deepest still-uncovered point, until the
         region is covered. Guarantees no gaps, on any (concave/holey) shape.
      2. BOUNDARY stroke - uniform-radius dabs along the edge, giving a uniform
         feather ring (radius from Feather) that also fills thin shapes on its own.
    Runs on a coarse buffer for speed (dabs are normalized)."""
    import numpy as np
    from scipy import ndimage
    from PIL import Image

    h0, w0 = mask_float.shape
    scale = DAB_WORK_EDGE / max(w0, h0)
    if scale < 1.0:
        m = np.asarray(
            Image.fromarray((mask_float * 255).astype("uint8")).resize(
                (max(1, round(w0 * scale)), max(1, round(h0 * scale))), Image.BILINEAR
            )
        ).astype("float32") / 255.0
    else:
        m = mask_float.astype("float32")
    binm = m > 0.5

    n = int(round(abs(edge_shift) * (DAB_WORK_EDGE / WORK_LONG_EDGE)))  # edge_shift px scaled to this buffer
    if edge_shift < 0 and n:
        eroded = ndimage.binary_erosion(binm, iterations=n)
        if eroded.any():
            binm = eroded
    elif edge_shift > 0 and n:
        binm = ndimage.binary_dilation(binm, iterations=n)
    if not binm.any():
        return []

    h, w = binm.shape
    L = max(w, h)
    dist = ndimage.distance_transform_edt(binm)
    ys, xs = np.mgrid[0:h, 0:w]
    min_r_px = DAB_MIN_R * L
    dabs = []

    # 1. greedy maximal-disk fill
    covered = np.zeros_like(binm)
    for _ in range(600):
        ud = np.where(binm & ~covered, dist, 0.0)
        r = float(ud.max())
        if r < DAB_STOP_PX:
            break
        fy, fx = np.unravel_index(int(ud.argmax()), ud.shape)
        dabs.append((fx / (w - 1), fy / (h - 1), max(r, min_r_px) / L * DAB_RADIUS_MULT))
        covered |= (xs - fx) ** 2 + (ys - fy) ** 2 <= (r * 0.8) ** 2  # 0.8 -> disks overlap

    # 2. uniform boundary stroke (feather ring)
    feather_px = feather / 100.0 * MAX_FEATHER_PX * (DAB_WORK_EDGE / WORK_LONG_EDGE)
    edge_r = max(feather_px, min_r_px)
    boundary = binm & ~ndimage.binary_erosion(binm)
    step = max(1, int(edge_r * 0.7))
    seen = set()
    for py, px in np.argwhere(boundary):
        key = (py // step, px // step)
        if key not in seen:
            seen.add(key)
            dabs.append((float(px) / (w - 1), float(py) / (h - 1), edge_r / L * DAB_RADIUS_MULT))

    if not dabs:  # degenerate: stamp the centroid
        yy, xx = np.nonzero(binm)
        dabs = [(float(xx.mean()) / (w - 1), float(yy.mean()) / (h - 1), max(min_r_px, 1) / L)]
    return dabs


def dab_coverage(dabs, W, H, softness=0.35):
    """Rasterize dabs [(x,y,r)] as soft circles (union) -> coverage float (H,W) in
    0..1. This is what ACR roughly renders, so the overlay built from it matches
    the applied mask. Per-dab bounding box keeps it fast."""
    import numpy as np

    L = max(W, H)
    cov = np.zeros((H, W), np.float32)
    for x, y, r in dabs:
        cx, cy, rp = x * (W - 1), y * (H - 1), r * L
        x0, x1 = max(0, int(cx - rp - 1)), min(W, int(cx + rp + 2))
        y0, y1 = max(0, int(cy - rp - 1)), min(H, int(cy + rp + 2))
        if x1 <= x0 or y1 <= y0:
            continue
        yy, xx = np.mgrid[y0:y1, x0:x1]
        d = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
        core = rp * (1 - softness)
        dcov = np.clip((rp - d) / max(1e-3, rp - core), 0.0, 1.0)
        cov[y0:y1, x0:x1] = np.maximum(cov[y0:y1, x0:x1], dcov)
    return cov


def render_dabs(dabs, base_rgb, softness=0.35, alpha=0.6, color=(255, 45, 45)):
    """Tint the dab coverage over an RGB array (offline visualization)."""
    import numpy as np

    H, W = base_rgb.shape[:2]
    covc = dab_coverage(dabs, W, H, softness)[..., None]
    c = np.array(color, np.float32)
    out = base_rgb.astype(np.float32) * (1 - alpha * covc) + c * (alpha * covc)
    return np.clip(out, 0, 255).astype("uint8")


def render_coverage(mask_or_cov, base_rgb, alpha=0.5, color=(255, 45, 45)):
    """Quick visualization: tint `mask_or_cov` (HxW 0..1) over an RGB uint8 array.
    Used by the offline test and (later) the overlay renderer."""
    import numpy as np
    from PIL import Image

    H, W = base_rgb.shape[:2]
    cov = np.asarray(Image.fromarray((mask_or_cov * 255).astype("uint8")).resize((W, H), Image.BILINEAR))
    cov = (cov.astype(np.float32) / 255.0)[..., None]
    c = np.array(color, dtype=np.float32)
    out = base_rgb.astype(np.float32) * (1 - alpha * cov) + c * (alpha * cov)
    return np.clip(out, 0, 255).astype("uint8")
