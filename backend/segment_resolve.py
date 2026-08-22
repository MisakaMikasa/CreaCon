"""Resolve `Mask/Paint` segment masks in an edit plan into real masks.

The model emits a mask like:
    { "What": "Mask/Paint", "Segment": "the red pagoda", "Feather": 5, "EdgeShift": 0 }
This module calls Gemini segmentation for each such mask, processes the result
(EdgeShift + Feather), and produces the two-panel verify overlay (segment masks +
any geometry masks in the same plan). It also stamps each resolved mask with the
brush dabs for the eventual ACR serializer.

Best-effort: a failed/empty segmentation just drops that one mask so the rest of
the plan still applies; nothing here raises into the request path.
"""

import base64
import io
import logging

logger = logging.getLogger("creacon.segresolve")


def _corrections(plan):
    for step in (plan or {}).get("steps", []):
        if step.get("op") != "applyCameraRaw":
            continue
        for corr in step.get("params", {}).get("settings", {}).get("MaskGroupBasedCorrections", []) or []:
            yield corr


def _segment_mask(correction):
    """The first Mask/Paint-with-Segment in a correction, or None."""
    for mask in correction.get("CorrectionMasks", []) or []:
        if mask.get("What") == "Mask/Paint" and mask.get("Segment"):
            return mask
    return None


def has_segments(plan):
    return any(_segment_mask(c) for c in _corrections(plan))


def resolve(plan, image_base64):
    """Segment every Mask/Paint in the plan and render the verify overlay.
    Returns (overlay_base64_or_None, resolved_names). `image_base64` is the PLAIN
    preview (segmentation must not see the grid); the overlay is drawn on a
    gridded copy so coordinates still read."""
    corrections = list(_corrections(plan))
    if not corrections or not image_base64:
        return None, []

    import numpy as np
    from PIL import Image

    import mask_raster
    import segment
    from image_annotate import add_coordinate_grid
    from mask_render import PALETTE, coverage_maps_for

    img_bytes = base64.b64decode(image_base64)  # full-res plain image, for segmentation
    geometry = [c for c in corrections if _segment_mask(c) is None]
    gridded = add_coordinate_grid(image_base64)  # the overlay base (downscaled + grid)
    # Coverage maps must match the OVERLAY's resolution, not the original image.
    GW, GH = Image.open(io.BytesIO(base64.b64decode(gridded))).size

    maps = []
    # Geometry masks (gradients/radials) first, at image resolution.
    try:
        gmaps, _ = coverage_maps_for(gridded, geometry)
        maps.extend(gmaps)
    except Exception as exc:
        logger.warning("geometry coverage failed: %s", exc)

    names = []
    for corr in corrections:
        mask = _segment_mask(corr)
        if mask is None:
            continue
        query = mask["Segment"]
        feather = float(mask.get("Feather", 50))
        edge = float(mask.get("EdgeShift", -3))
        try:
            raw, meta = segment.segment(img_bytes, query)
        except Exception as exc:
            logger.warning("segment '%s' failed: %s", query, exc)
            raw = None
        if raw is None:
            logger.info("segment '%s' returned nothing - dropping this mask", query)
            continue

        # Fill the region with dabs (greedy disk + boundary-stroke feather).
        dab_pts = mask_raster.to_dabs(raw, feather=feather, edge_shift=edge)
        # Overlay coverage from the ACTUAL dabs, so what we show matches ACR.
        covf = mask_raster.dab_coverage(dab_pts, GW, GH)
        name = corr.get("CorrectionName") or query
        maps.append((covf, PALETTE[len(maps) % len(PALETTE)], name))
        names.append(name)

        # Rewrite the mask into the concrete ACR brush form. Feather/EdgeShift are
        # consumed here; the plugin's serializer just emits the per-dab Dabs.
        mask.pop("Segment", None)
        mask.pop("Feather", None)
        mask.pop("EdgeShift", None)
        mask["Dabs"] = [[round(float(x), 6), round(float(y), 6), round(float(r), 6)] for (x, y, r) in dab_pts]
        mask["Flow"] = 1.0
        mask["CenterWeight"] = 0
        if not mask.get("MaskName"):
            mask["MaskName"] = name
        logger.info("segment '%s' -> %s | %d dab(s)", query, meta, len(dab_pts))

    if not maps:
        return None, names

    from mask_render import render_two_panel

    return render_two_panel(gridded, maps), names
