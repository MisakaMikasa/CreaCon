"""Renders geometry previews from the JPEG the panel already captured.

The point of this module is that it needs NO Photoshop round-trip. Every apply in
CreaCon costs the user a manual Camera Raw dialog, so showing three candidate
crops by trial-applying them would cost three dialogs. Cropping and rotating the
preview image instead costs nothing, and the user picks once.

Two previews:
  crop_thumbnails  - the candidate rectangles from a plan's `proposals`
  rotation_preview - a straighten, with the frame ACR will inscribe

Both report how much of the frame survives, which is the number a person cannot
eyeball: straightening 3 degrees quietly discards 14% of a 3:2 photo.
"""

import base64
import io
import math

from PIL import Image

THUMB_MAX_EDGE = 480


def _decode(image_base64: str) -> Image.Image:
    return Image.open(io.BytesIO(base64.b64decode(image_base64))).convert("RGB")


def _encode(image: Image.Image, max_edge: int = THUMB_MAX_EDGE) -> str:
    if max(image.size) > max_edge:
        scale = max_edge / max(image.size)
        image = image.resize(
            (max(1, int(image.width * scale)), max(1, int(image.height * scale))),
            Image.LANCZOS,
        )
    buf = io.BytesIO()
    image.save(buf, format="JPEG", quality=82)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def max_inscribed_scale(width: int, height: int, degrees: float) -> float:
    """Largest same-aspect rectangle fitting inside a rotated frame, as a scale.

    Mirrors maxInscribedCrop in CreaCon/src/executor/geometryMath.js - keep the
    two in step. Half-extents (u,v) with u/v held at W/H must satisfy BOTH
    u*cos + v*sin <= W/2 and u*sin + v*cos <= H/2, which normalise to two
    DIFFERENT ratios, so the answer is their min. Collapsing them into one
    silently breaks portrait orientation.
    """
    rad = math.radians(abs(degrees))
    cos, sin = math.cos(rad), math.sin(rad)
    return min(
        width / (width * cos + height * sin),
        height / (width * sin + height * cos),
    )


def crop_thumbnails(image_base64: str, proposals: list) -> list:
    """One thumbnail per proposed crop, with the fraction of frame it keeps.

    Rectangles are normalized 0..1 read off the preview grid. Anything degenerate
    or inverted is skipped rather than raising - a malformed proposal should cost
    the user one missing card, not the whole reply.
    """
    if not proposals:
        return []
    image = _decode(image_base64)
    w, h = image.size
    out = []
    for proposal in proposals:
        rect = (proposal or {}).get("crop") or {}
        try:
            left, top = float(rect["left"]), float(rect["top"])
            right, bottom = float(rect["right"]), float(rect["bottom"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (0 <= left < right <= 1 and 0 <= top < bottom <= 1):
            continue
        box = (
            max(0, int(left * w)),
            max(0, int(top * h)),
            min(w, int(round(right * w))),
            min(h, int(round(bottom * h))),
        )
        if box[2] - box[0] < 8 or box[3] - box[1] < 8:
            continue
        # The rectangle is normalized to width and height SEPARATELY, so the
        # shape is preserved exactly when the two fractions match. Computed here
        # rather than trusted from the model, and surfaced on the card: "keeps
        # the original shape" is the difference between a tidy-up and a reframe,
        # and it is not obvious from a thumbnail.
        span_x, span_y = right - left, bottom - top
        keeps_aspect = abs(span_x - span_y) < 0.01
        result_ratio = (span_x * w) / (span_y * h) if span_y * h else 0
        out.append(
            {
                "label": proposal.get("label") or "Crop",
                "reason": proposal.get("reason") or "",
                "crop": {"left": left, "top": top, "right": right, "bottom": bottom},
                "targetLayer": proposal.get("targetLayer"),
                "retained": span_x * span_y,
                "keeps_aspect": keeps_aspect,
                "aspect_label": "same shape" if keeps_aspect else f"{result_ratio:.2f}:1",
                "image_base64": _encode(image.crop(box)),
            }
        )
    return out


def rotation_preview(image_base64: str, degrees: float) -> dict:
    """What a straighten will look like, and what it costs.

    Rotates the preview and crops to the rectangle Camera Raw will inscribe, so
    the user sees the actual resulting frame rather than a tilted picture with
    empty corners.
    """
    image = _decode(image_base64)
    w, h = image.size
    # expand=False keeps the canvas, matching ACR: the frame does not grow, the
    # picture rotates inside it and the corners are cropped away.
    rotated = image.rotate(-degrees, resample=Image.BICUBIC, expand=False)
    scale = max_inscribed_scale(w, h, degrees)
    cw, ch = w * scale, h * scale
    box = (
        int((w - cw) / 2),
        int((h - ch) / 2),
        int((w + cw) / 2),
        int((h + ch) / 2),
    )
    return {
        "degrees": degrees,
        "retained": scale * scale,
        "image_base64": _encode(rotated.crop(box)),
    }
