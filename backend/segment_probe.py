"""Phase-0 probe: segment a target on a photo with Gemini and render the
processed (feathered + edge-shifted) mask overlay, so you can eyeball whether
Gemini's segmentation actually lands on the target before we build the rest.

Needs a working network + GEMINI_API_KEY in backend/.env. Run from backend/:

  python segment_probe.py "C:/path/photo.jpg" "the red pagoda"
  python segment_probe.py "C:/path/photo.jpg" "the path buildings" 70 -6
        (optional trailing args: feather 0-100, edge_shift px  neg=shrink)

Writes <photo>.seg_<feather>_<edge>.jpg next to the input.
"""

import base64
import io
import os
import sys

from dotenv import load_dotenv

load_dotenv()

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

import mask_raster  # noqa: E402
import segment  # noqa: E402
from image_annotate import add_coordinate_grid  # noqa: E402


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return
    img_path, query = sys.argv[1], sys.argv[2]
    feather = float(sys.argv[3]) if len(sys.argv) > 3 else 50
    edge = float(sys.argv[4]) if len(sys.argv) > 4 else -3

    import time

    data = open(img_path, "rb").read()
    print(f"segmenting '{query}'  (model={segment._model()}) ... waiting for Gemini", flush=True)
    t0 = time.time()
    mask, meta = segment.segment(data, query)
    print(f"...done in {time.time() - t0:.1f}s | meta:", meta)
    if mask is None:
        print("No segmentation returned - try a different phrasing.")
        return

    cov = mask_raster.process(mask, feather=feather, edge_shift=edge)
    dabs, r = mask_raster.to_dabs(mask, feather=feather, edge_shift=edge)
    gridded = base64.b64decode(add_coordinate_grid(base64.b64encode(data).decode()))
    base = np.asarray(Image.open(io.BytesIO(gridded)).convert("RGB"))
    out = mask_raster.render_coverage(cov, base)

    dst = f"{os.path.splitext(img_path)[0]}.seg_{feather:.0f}_{edge:.0f}.jpg"
    Image.fromarray(out).save(dst, quality=88)
    print(
        f"raw coverage {float((mask > 0.5).mean()):.4f} | dabs {len(dabs)} "
        f"(r={r:.4f}) | wrote {dst}"
    )


if __name__ == "__main__":
    main()
