"""Native image segmentation via Gemini.

The editing agent never produces coordinates - it just names a target in
natural language (e.g. "the red pagoda in the trees"). This module turns that
name into a pixel mask using Gemini's built-in segmentation (a purpose-trained
capability, separate from the conversational plan call). The returned mask feeds
mask_raster.py, which shifts/feathers it and converts it to ACR brush dabs.

Swap-out point: `segment()` is the only Gemini-specific piece; a SAM backend
would implement the same signature for model-portability.

Gemini's contract (2.5+): a JSON list where each item has
  box_2d = [ymin, xmin, ymax, xmax]  normalized 0-1000,
  mask   = base64 PNG (a probability map sized to that box),
  label  = text.
We decode deterministically and paste each box's mask into a full-frame buffer.
"""

import base64
import io
import json
import logging
import os
import re

logger = logging.getLogger("creacon.segment")

_SEG_PROMPT = (
    "Trace the outline of: {query}.\n"
    "Output ONLY a JSON list. Each entry MUST have:\n"
    '  "box_2d": [ymin, xmin, ymax, xmax] as integers normalized to 0-1000,\n'
    '  "polygon": a list of [x, y] points (integers normalized to 0-1000) tracing '
    "the object's outline as a single closed contour - use about 20-40 points, more "
    "where the boundary is detailed, and\n"
    '  "label": a short text label.\n'
    "Do NOT output a PNG or base64 mask - only the polygon points. "
    "ALWAYS include the polygon: even if the object is partly hidden, low-contrast, "
    "or blends into its background, trace your best estimate of its actual outline - "
    "NEVER return only a bounding box. "
    "Return the single best-matching region (or a few if the target is plural). "
    "If the target is not visible at all, output an empty list []."
)

# Accurate raster fallback: Gemini's native per-pixel PNG mask. Slower/bulkier
# than a polygon, but it always gives the real shape (used only when the polygon
# path fails, so we never resort to a bounding box).
_SEG_PROMPT_PNG = (
    "Give the segmentation mask for: {query}.\n"
    "Output ONLY a JSON list. Each entry MUST have:\n"
    '  "box_2d": [ymin, xmin, ymax, xmax] as integers normalized to 0-1000,\n'
    '  "mask": a base64 PNG data URI - the per-pixel probability mask for that box '
    "(the object's ACTUAL shape, not a filled rectangle), and\n"
    '  "label": a short text label.\n'
    "Return the single best-matching region. Empty list [] if not visible."
)


_CLIENT = None


def _client():
    # Module-level singleton: a per-call Client gets garbage-collected mid-request
    # (its __del__ closes the httpx transport -> "client has been closed"),
    # especially on Python 3.14. gemini_provider.py keeps a singleton for the same
    # reason.
    global _CLIENT
    if _CLIENT is None:
        from google import genai

        _CLIENT = genai.Client(api_key=os.environ.get("GEMINI_API_KEY"))
    return _CLIENT


def _model():
    return os.environ.get("SEGMENT_MODEL") or os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")


def _downscaled_jpeg(image_bytes, max_edge=None):
    """A small JPEG for the API call. Segmentation runs fine at ~1024px and
    returns box_2d normalized 0-1000, so shrinking the input doesn't affect the
    mask mapping - it just makes the upload + call far faster and cheaper."""
    import io as _io

    from PIL import Image

    max_edge = int(os.environ.get("SEGMENT_MAX_EDGE", str(max_edge or 1024)))
    img = Image.open(_io.BytesIO(image_bytes)).convert("RGB")
    w, h = img.size
    s = min(1.0, max_edge / max(w, h))
    if s < 1.0:
        img = img.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)
    buf = _io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return buf.getvalue()


def _decode_entry(entry, W, H, out):
    """Rasterize one entry into the full-frame float buffer `out`. Prefers a
    polygon (fast, compact); falls back to a PNG mask, then the bounding box."""
    import numpy as np
    from PIL import Image, ImageDraw

    # 1. Polygon outline (the fast path). Points are [x, y] normalized 0-1000.
    poly = entry.get("polygon")
    if poly is None and isinstance(entry.get("mask"), list):
        poly = entry.get("mask")
    if isinstance(poly, list) and len(poly) >= 3:
        # Gemini's polygon points are [y, x] (y-first, matching box_2d), NOT [x, y].
        pts = [
            (float(p[1]) / 1000 * W, float(p[0]) / 1000 * H)
            for p in poly
            if isinstance(p, (list, tuple)) and len(p) == 2
        ]
        if len(pts) >= 3:
            m = Image.new("L", (W, H), 0)
            ImageDraw.Draw(m).polygon(pts, fill=255)
            np.maximum(out, np.asarray(m, dtype=np.float32) / 255.0, out=out)
            return "polygon"

    box = entry.get("box_2d")
    data = entry.get("mask") if isinstance(entry.get("mask"), str) else None
    if not box or len(box) != 4:
        return None
    ymin, xmin, ymax, xmax = box
    x0, x1 = round(xmin / 1000 * W), round(xmax / 1000 * W)
    y0, y1 = round(ymin / 1000 * H), round(ymax / 1000 * H)
    x0, x1 = max(0, min(x0, x1)), min(W, max(x0, x1))
    y0, y1 = max(0, min(y0, y1)), min(H, max(y0, y1))
    bw, bh = x1 - x0, y1 - y0
    if bw <= 0 or bh <= 0:
        return None
    # No/truncated mask -> fall back to filling the bounding box (coarse - a box,
    # not the object's shape; the caller retries to try for a real polygon).
    if not data:
        out[y0:y1, x0:x1] = 1.0
        return "box"
    b64 = re.sub(r"^data:image/\w+;base64,", "", data.strip())
    try:
        png = Image.open(io.BytesIO(base64.b64decode(b64))).convert("L").resize((bw, bh), Image.BILINEAR)
        patch = np.asarray(png, dtype=np.float32) / 255.0
    except Exception:
        patch = np.ones((bh, bw), dtype=np.float32)  # decode failed -> box fill
    out[y0:y1, x0:x1] = np.maximum(out[y0:y1, x0:x1], patch)  # union across entries
    return "png"


def _segment_once(image_bytes, query, mime="image/jpeg", want_png=False):
    """One segmentation call. Returns (mask_float HxW 0..1, meta with 'formats').
    want_png requests the accurate raster mask instead of a polygon."""
    import numpy as np
    from google.genai import types
    from PIL import Image

    W, H = Image.open(io.BytesIO(image_bytes)).size
    api_bytes = _downscaled_jpeg(image_bytes)  # small copy for the API; W,H stay original
    prompt = (_SEG_PROMPT_PNG if want_png else _SEG_PROMPT).format(query=query)

    client = _client()  # keep a strong local ref for the whole call
    resp = client.models.generate_content(
        model=_model(),
        contents=[
            types.Content(
                role="user",
                parts=[
                    types.Part.from_bytes(data=api_bytes, mime_type="image/jpeg"),
                    types.Part.from_text(text=prompt),
                ],
            )
        ],
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            thinking_config=types.ThinkingConfig(thinking_budget=0),
            # The base64 PNG mask is large; the default output cap truncates it
            # mid-string. Give it room.
            max_output_tokens=int(os.environ.get("SEGMENT_MAX_TOKENS", "65536")),
        ),
    )
    raw = (resp.text or "").strip()
    # Tolerate a ```json ... ``` fence despite response_mime_type=application/json.
    fenced = re.search(r"```(?:json)?\s*(.*?)```", raw, re.S)
    if fenced:
        raw = fenced.group(1).strip()
    try:
        entries = json.loads(raw)
    except Exception:
        # Usually the huge base64 mask got truncated. Salvage any complete
        # box_2d as a coarse rectangular fallback so the pipeline still runs.
        boxes = re.findall(
            r'"box_2d"\s*:\s*\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]', raw
        )
        if not boxes:
            raise RuntimeError(f"segmentation returned unparseable JSON: {raw[:200]}")
        entries = [{"box_2d": [int(a), int(b), int(c), int(d)]} for a, b, c, d in boxes]
    if not isinstance(entries, list) or not entries:
        return None, {"query": query, "count": 0, "labels": []}

    out = np.zeros((H, W), dtype=np.float32)
    labels = []
    formats = []
    for e in entries:
        if isinstance(e, dict):
            fmt = _decode_entry(e, W, H, out)
            if fmt:
                formats.append(fmt)
            if e.get("label"):
                labels.append(e["label"])
    meta = {"query": query, "count": len(entries), "labels": labels, "formats": formats}
    if out.max() <= 0:
        return None, meta
    meta["size"] = [W, H]
    return out, meta


def _is_shape(meta):
    """True if we got a real object shape (polygon or PNG), not just a box."""
    return bool(set(meta.get("formats", [])) & {"polygon", "png"})


def segment(image_bytes, query, mime="image/jpeg"):
    """Segment `query` -> (mask_float HxW 0..1 at image resolution, meta). mask is
    None if nothing was found. Tiered so we (almost) never resort to a box:
      1-2. polygon (fast) - retry once, since the call is stochastic;
      3.   PNG mask (accurate, slower) - Gemini's native per-pixel shape;
      last: whatever we have (a box) only if all of the above failed."""
    mask, meta = _segment_once(image_bytes, query, mime)
    if mask is None or _is_shape(meta):
        logger.info("segment '%s' -> formats=%s labels=%s", query, meta.get("formats"), meta.get("labels"))
        return mask, meta

    logger.warning("segment '%s': got box-only %s, retrying for a polygon", query, meta.get("formats"))
    mask2, meta2 = _segment_once(image_bytes, query, mime)
    if mask2 is not None and _is_shape(meta2):
        logger.info("segment '%s' -> formats=%s (retry)", query, meta2.get("formats"))
        return mask2, meta2

    logger.warning("segment '%s': still box-only, falling back to the accurate PNG mask", query)
    mask3, meta3 = _segment_once(image_bytes, query, mime, want_png=True)
    if mask3 is not None and _is_shape(meta3):
        logger.info("segment '%s' -> formats=%s (png fallback)", query, meta3.get("formats"))
        return mask3, meta3

    logger.warning("segment '%s': no real shape after retries+PNG - using the box (last resort)", query)
    return mask, meta


if __name__ == "__main__":
    # Standalone probe:  python segment.py <image> "<query>"  -> writes <query>.mask.png
    import sys

    import numpy as np
    from dotenv import load_dotenv
    from PIL import Image

    load_dotenv()
    img_path, q = sys.argv[1], sys.argv[2]
    data = open(img_path, "rb").read()
    mask, meta = segment(data, q)
    print("meta:", meta)
    if mask is not None:
        out = (mask * 255).astype("uint8")
        p = os.path.splitext(img_path)[0] + ".mask.png"
        Image.fromarray(out).save(p)
        print("coverage fraction:", round(float((mask > 0.5).mean()), 4), "-> wrote", p)
