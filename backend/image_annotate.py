"""Overlays a labeled 0..1 coordinate grid on the preview image sent to the
vision model.

Why: masks are placed in a normalized top-left-origin unit square (see the XMP
coordinate system - Mask/Gradient Full/Zero, Mask/CircularGradient Top/Left/
Bottom/Right, all fractions of width/height). Vision models are poor at absolute
coordinate estimation from a bare photo, so we draw their ruler ONTO the image:
thin gridlines at the exact fractions they output, labeled, with the center and
rule-of-thirds emphasized. The model reads coordinates off the grid instead of
guessing. Best-effort: any failure returns the original image unchanged.
"""

import base64
import io
import logging
import os

logger = logging.getLogger("creacon.annotate")

# Long-edge cap: downscale big previews so gridlines stay crisp and token cost
# stays predictable. ~1280 is plenty for spatial grounding.
MAX_EDGE = int(os.environ.get("PREVIEW_MAX_EDGE", "1280"))
MAJOR = 0.1   # labeled gridlines
MINOR = 0.05  # unlabeled border ticks (finer reading)
JPEG_QUALITY = 85


def _font(size):
    from PIL import ImageFont

    for name in ("arial.ttf", "DejaVuSans.ttf", "LiberationSans-Regular.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except Exception:
            continue
    try:
        return ImageFont.load_default(size)  # Pillow >= 10.1 accepts a size
    except Exception:
        return ImageFont.load_default()


def add_coordinate_grid(image_base64: str) -> str:
    """Returns a base64 JPEG of the image with a labeled 0..1 grid drawn on it.
    On any error (missing Pillow, decode failure) returns the input unchanged."""
    try:
        from PIL import Image, ImageDraw
    except Exception as exc:  # Pillow not installed - degrade gracefully
        logger.warning("Pillow unavailable, sending un-gridded preview: %s", exc)
        return image_base64

    try:
        img = Image.open(io.BytesIO(base64.b64decode(image_base64))).convert("RGB")

        # Downscale large previews (keep aspect).
        w, h = img.size
        scale = min(1.0, MAX_EDGE / max(w, h))
        if scale < 1.0:
            img = img.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
            w, h = img.size

        overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(overlay)

        # Dual-stroke lines: a dark under-stroke + a light core reads on both
        # bright skies and dark foregrounds without hiding detail.
        LIGHT = (255, 255, 255, 95)
        DARK = (0, 0, 0, 70)
        THIRDS = (120, 220, 255, 120)   # cyan rule-of-thirds
        CENTER = (255, 70, 200, 150)    # magenta center

        fsz = max(11, round(min(w, h) * 0.026))
        font = _font(fsz)

        def X(f):
            return round(f * (w - 1))

        def Y(f):
            return round(f * (h - 1))

        def is_near(a, b):
            return abs(a - b) < 1e-6

        # Border minor ticks at 0.05 (short marks on all four edges).
        tick = max(4, round(min(w, h) * 0.010))
        n_minor = round(1 / MINOR)
        for i in range(n_minor + 1):
            f = i * MINOR
            d.line([(X(f), 0), (X(f), tick)], fill=(255, 255, 255, 150), width=1)
            d.line([(X(f), h - tick), (X(f), h)], fill=(255, 255, 255, 150), width=1)
            d.line([(0, Y(f)), (tick, Y(f))], fill=(255, 255, 255, 150), width=1)
            d.line([(w - tick, Y(f)), (w, Y(f))], fill=(255, 255, 255, 150), width=1)

        # Major gridlines at 0.1, with thirds + center emphasized.
        n_major = round(1 / MAJOR)
        for i in range(n_major + 1):
            f = i * MAJOR
            emphasized = is_near(f, 0.5)
            thirds = is_near(f, 1 / 3) or is_near(f, 2 / 3)
            core = CENTER if emphasized else THIRDS if thirds else LIGHT
            cw = 2 if (emphasized or thirds) else 1
            for (x0, y0, x1, y1) in [(X(f), 0, X(f), h), (0, Y(f), w, Y(f))]:
                d.line([(x0, y0), (x1, y1)], fill=DARK, width=cw + 2)
                d.line([(x0, y0), (x1, y1)], fill=core, width=cw)

        # Labels: fraction along the top edge (X) and left edge (Y). A chip
        # behind the text keeps it legible over any content.
        def label(cx, cy, text):
            bbox = d.textbbox((0, 0), text, font=font)
            tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
            pad = max(2, round(fsz * 0.22))
            x0 = min(max(0, cx - tw // 2 - pad), w - tw - 2 * pad)
            y0 = min(max(0, cy - th // 2 - pad), h - th - 2 * pad)
            d.rectangle([x0, y0, x0 + tw + 2 * pad, y0 + th + 2 * pad], fill=(0, 0, 0, 150))
            d.text((x0 + pad - bbox[0], y0 + pad - bbox[1]), text, fill=(255, 255, 255, 240), font=font)

        edge = max(10, round(fsz * 0.9))
        for i in range(n_major + 1):
            f = i * MAJOR
            txt = f"{f:.1f}"
            label(X(f), edge, txt)          # X ruler along the top
            if i != 0:                       # skip 0.0 twice at the corner
                label(edge, Y(f), txt)      # Y ruler along the left

        out = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
        buf = io.BytesIO()
        out.save(buf, format="JPEG", quality=JPEG_QUALITY)
        return base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception as exc:
        logger.warning("grid overlay failed, sending original preview: %s", exc)
        return image_base64
