"""Renders where a plan's geometric masks actually land, as a coloured overlay
on the preview.

This is the mechanism that lets the model (and the user) SEE a mask instead of
placing it blind. CreaCon owns the exact gradient/radial geometry (the same
math ACR applies), so we can reproduce a correction's coverage deterministically
in the backend - no Photoshop round-trip, no ACR, no commits. Used for:
  1. within-turn verification: render the plan the model just proposed, show it
     back, and let the model correct a missed region before anything is applied;
  2. offline evaluation: compare where masks land with the coordinate grid on
     vs off, to measure whether the grid actually improved placement.

Only geometric masks (Mask/Gradient, Mask/CircularGradient) are supported - which
is exactly the set the schema now allows. AI/range masks aren't renderable from
geometry alone, another reason we restrict to shapes.
"""

import base64
import io
import logging

logger = logging.getLogger("creacon.maskrender")

# Distinct translucent tints per correction so stacked regions stay readable.
PALETTE = [
    (255, 45, 45),    # red
    (45, 140, 255),   # blue
    (60, 210, 90),    # green
    (255, 180, 40),   # amber
    (200, 80, 255),   # violet
]


def _meshgrid(w, h):
    import numpy as np

    xs = np.arange(w, dtype=np.float32)
    ys = np.arange(h, dtype=np.float32)
    return np.meshgrid(xs, ys)  # X, Y each (h, w)


def _gradient_coverage(mask, w, h, X, Y):
    """Linear gradient: 1 at (FullX,FullY), ramping to 0 at (ZeroX,ZeroY),
    clamped beyond either end. Computed in pixel space so diagonals look right."""
    import numpy as np

    fx, fy = mask.get("FullX", 0.5) * (w - 1), mask.get("FullY", 0.0) * (h - 1)
    zx, zy = mask.get("ZeroX", 0.5) * (w - 1), mask.get("ZeroY", 1.0) * (h - 1)
    dx, dy = zx - fx, zy - fy
    l2 = dx * dx + dy * dy
    if l2 < 1e-9:
        return np.ones((h, w), dtype=np.float32)
    t = ((X - fx) * dx + (Y - fy) * dy) / l2
    return np.clip(1.0 - t, 0.0, 1.0).astype(np.float32)


def _radial_coverage(mask, w, h, X, Y):
    """Elliptical gradient from Top/Left/Bottom/Right bounds. Feather (0..100)
    sets the soft edge; Flipped true (default) = full INSIDE the ellipse."""
    import numpy as np

    top, left = mask.get("Top", 0.3), mask.get("Left", 0.3)
    bottom, right = mask.get("Bottom", 0.7), mask.get("Right", 0.7)
    cx, cy = (left + right) / 2 * (w - 1), (top + bottom) / 2 * (h - 1)
    rx = max(1e-3, abs(right - left) / 2 * (w - 1))
    ry = max(1e-3, abs(bottom - top) / 2 * (h - 1))
    # ACR's Angle rotates the ellipse OPPOSITE to a standard image-space (Y-down)
    # rotation - verified against a real ACR mask on DSCF0426 (Angle 325 tilts the
    # long axis top-left->bottom-right in ACR, the mirror of a naive rotation). So
    # negate to match what the user actually sees.
    ang = np.radians(-(mask.get("Angle", 0) or 0))
    ca, sa = np.cos(ang), np.sin(ang)
    xr = (X - cx) * ca + (Y - cy) * sa
    yr = -(X - cx) * sa + (Y - cy) * ca
    d = np.sqrt((xr / rx) ** 2 + (yr / ry) ** 2)
    feather = min(0.99, max(0.0, (mask.get("Feather", 50) or 0) / 100.0))
    inner = 1.0 - feather
    cov = np.clip((1.0 - d) / max(1e-6, 1.0 - inner), 0.0, 1.0).astype(np.float32)
    if not mask.get("Flipped", True):  # Flipped true is ACR's inside-the-ellipse default
        cov = 1.0 - cov
    return cov


def _correction_coverage(correction, w, h, X, Y):
    """Combine a correction's masks the way ACR/CreaCon does: MaskBlendMode 0 =
    add (union), 1 = intersect (product); MaskInverted flips a single mask."""
    import numpy as np

    acc = None
    for mask in correction.get("CorrectionMasks", []):
        what = mask.get("What")
        if what == "Mask/Gradient":
            cov = _gradient_coverage(mask, w, h, X, Y)
        elif what == "Mask/CircularGradient":
            cov = _radial_coverage(mask, w, h, X, Y)
        else:
            continue  # non-geometric (shouldn't occur) - skip
        # NOTE: do NOT scale by MaskValue. In real ACR sidecars intersect/combine
        # components carry MaskValue="0" yet are fully active, so treating it as an
        # opacity zeroes out exactly the masks we most need to show. Coverage here
        # is a shape visualization, not an exact opacity render.
        if mask.get("MaskInverted", False):
            cov = 1.0 - cov
        if acc is None:
            acc = cov
        elif mask.get("MaskBlendMode", 0) == 1:
            acc = acc * cov            # intersect
        else:
            acc = np.maximum(acc, cov)  # add
    if acc is None:
        return np.zeros((h, w), dtype=np.float32)
    return (acc * float(correction.get("CorrectionAmount", 1))).astype(np.float32)


def corrections_from_plan(plan):
    """Pulls MaskGroupBasedCorrections out of the first applyCameraRaw step of a
    plan dict (returns [] if there are none)."""
    for step in (plan or {}).get("steps", []):
        if step.get("op") == "applyCameraRaw":
            return step.get("params", {}).get("settings", {}).get("MaskGroupBasedCorrections", []) or []
    return []


def _draw_label(draw, cx, cy, text, color, font, w, h):
    """Opaque name chip (colour-matched border) centered at (cx, cy), clamped
    inside the frame. Opaque so it stays legible on any tint."""
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    pad = 5
    x0 = int(min(max(0, cx - tw / 2 - pad), w - tw - 2 * pad))
    y0 = int(min(max(0, cy - th / 2 - pad), h - th - 2 * pad))
    draw.rectangle(
        [x0, y0, x0 + tw + 2 * pad, y0 + th + 2 * pad],
        fill=(15, 15, 15),
        outline=color,
        width=3,
    )
    draw.text((x0 + pad - bbox[0], y0 + pad - bbox[1]), text, fill=(255, 255, 255), font=font)


def _coverage_maps(corrections, w, h, X, Y):
    """[(coverage, color, name)] for each renderable, non-empty correction."""
    maps = []
    for i, correction in enumerate(corrections):
        if correction.get("Unsupported"):
            continue
        cov = _correction_coverage(correction, w, h, X, Y)
        if float(cov.max()) <= 0.01:  # empty / off-frame
            continue
        color = PALETTE[len(maps) % len(PALETTE)]
        maps.append((cov, color, correction.get("CorrectionName") or f"Correction {i + 1}"))
    return maps


def _draw_borders(arr, maps, thickness):
    """Paint each mask's boundary contour (where coverage crosses 0.5) in its
    colour, so overlapping tints stay separable. Pure-numpy erosion/dilation."""
    import numpy as np

    for cov, color, _ in maps:
        b = cov > 0.5
        er = b.copy()  # 4-neighbour erosion: pixel in b AND all neighbours in b
        er[1:, :] &= b[:-1, :]
        er[:-1, :] &= b[1:, :]
        er[:, 1:] &= b[:, :-1]
        er[:, :-1] &= b[:, 1:]
        edge = b & ~er
        for _ in range(max(0, thickness - 1)):  # dilate the 1px edge for visibility
            nxt = edge.copy()
            nxt[1:, :] |= edge[:-1, :]
            nxt[:-1, :] |= edge[1:, :]
            nxt[:, 1:] |= edge[:, :-1]
            nxt[:, :-1] |= edge[:, 1:]
            edge = nxt
        arr[edge] = np.array(color, dtype=arr.dtype)
    return arr


def _render_panel(base_arr, maps, w, h, X, Y, alpha, font):
    """Composite tints + borders + centroid labels onto a base array (the photo
    or a black canvas). Returns a PIL RGB image."""
    import numpy as np
    from PIL import Image, ImageDraw

    arr = base_arr.copy()
    for cov, color, _ in maps:
        c = np.array(color, dtype=np.float32)
        covc = cov[..., None]
        arr = arr * (1.0 - alpha * covc) + c * (alpha * covc)
    arr = _draw_borders(arr, maps, thickness=max(2, round(min(w, h) * 0.004)))

    img = Image.fromarray(np.clip(arr, 0, 255).astype("uint8"), "RGB")
    draw = ImageDraw.Draw(img)
    for cov, color, name in maps:
        total = float(cov.sum())
        if total <= 0:
            continue
        cx = float((X * cov).sum() / total)
        cy = float((Y * cov).sum() / total)
        _draw_label(draw, cx, cy, name, color, font, w, h)
    return img


def render_overlay(image_base64: str, corrections, alpha: float = 0.5) -> str:
    """Single-panel: mask tints + borders + labels over the photo. Kept for
    debug/inspection. Best-effort - returns the input unchanged on any failure."""
    if not corrections:
        return image_base64
    try:
        import numpy as np
        from PIL import Image

        from image_annotate import _font

        img = Image.open(io.BytesIO(base64.b64decode(image_base64))).convert("RGB")
        w, h = img.size
        X, Y = _meshgrid(w, h)
        maps = _coverage_maps(corrections, w, h, X, Y)
        if not maps:
            return image_base64
        font = _font(max(13, round(min(w, h) * 0.030)))
        panel = _render_panel(np.asarray(img, dtype=np.float32), maps, w, h, X, Y, alpha, font)
        buf = io.BytesIO()
        panel.save(buf, format="JPEG", quality=85)
        return base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception as exc:
        logger.warning("mask overlay failed, returning original image: %s", exc)
        return image_base64


def render_verify_image(image_base64: str, corrections, alpha: float = 0.5) -> str:
    """Two stacked panels in one image for the verify pass:
      TOP    - masks over the actual photo (with the grid) -> match to content;
      BOTTOM - the same masks on black -> the shapes, crisp and uncluttered.
    Both carry matching colours, borders and name labels. Best-effort."""
    if not corrections:
        return image_base64
    try:
        import numpy as np
        from PIL import Image, ImageDraw

        from image_annotate import _font

        img = Image.open(io.BytesIO(base64.b64decode(image_base64))).convert("RGB")
        w, h = img.size
        X, Y = _meshgrid(w, h)
        maps = _coverage_maps(corrections, w, h, X, Y)
        if not maps:
            return image_base64

        font = _font(max(13, round(min(w, h) * 0.030)))
        photo = np.asarray(img, dtype=np.float32)
        black = np.zeros_like(photo)
        top = _render_panel(photo, maps, w, h, X, Y, alpha, font)
        # Stronger tint on black so the shapes read against an empty background.
        bottom = _render_panel(black, maps, w, h, X, Y, min(0.95, alpha * 1.7), font)

        header = max(18, round(min(w, h) * 0.045))
        gap = 8
        canvas = Image.new("RGB", (w, header * 2 + h * 2 + gap), (25, 25, 25))
        hf = _font(max(12, round(header * 0.55)))
        d = ImageDraw.Draw(canvas)
        d.text((8, header // 4), "MASKS OVER PHOTO (does each cover its region?)", fill=(255, 255, 255), font=hf)
        canvas.paste(top, (0, header))
        d.text((8, header + h + gap + header // 4), "MASK SHAPES ON BLACK (same colours/labels)", fill=(255, 255, 255), font=hf)
        canvas.paste(bottom, (0, header * 2 + h + gap))

        buf = io.BytesIO()
        canvas.save(buf, format="JPEG", quality=85)
        return base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception as exc:
        logger.warning("verify image render failed, returning original image: %s", exc)
        return image_base64
