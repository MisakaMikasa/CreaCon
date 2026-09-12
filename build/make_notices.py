"""Generate THIRD-PARTY-NOTICES.txt for the packaged build.

Not a nicety. CreaCon's installer redistributes FastAPI, uvicorn, scipy, numpy,
Pillow, pywebview and the provider SDKs, and their MIT / BSD / Apache licences
require their copyright notices to travel with any redistribution. That is a
condition of using their code and is unaffected by CreaCon's own licence.

Run:  python build/make_notices.py
"""

import importlib.metadata as md
import pathlib
import sys

OUT = pathlib.Path(__file__).parent / "THIRD-PARTY-NOTICES.txt"

# Everything the frozen app actually imports, plus what those pull in. Listed
# explicitly rather than walking the whole venv: the venv also holds PyInstaller
# and its hooks, which are BUILD tools and are not redistributed.
SHIPPED = [
    "fastapi", "uvicorn", "starlette", "pydantic", "pydantic-core",
    "anyio", "sniffio", "idna", "click", "h11", "httptools",
    "python-dotenv", "PyYAML", "watchfiles", "websockets",
    "jsonschema", "jsonschema-specifications", "referencing", "rpds-py",
    "attrs", "typing-extensions", "annotated-types",
    "numpy", "scipy", "pillow",
    "google-genai", "anthropic", "httpx", "httpcore", "certifi",
    "distro", "jiter", "tqdm", "requests", "urllib3", "charset-normalizer",
    "google-auth", "pyasn1", "pyasn1-modules", "rsa", "cachetools",
    "pywebview", "proxy-tools", "bottle", "typing-inspection",
    "pythonnet", "clr-loader", "cffi", "pycparser", "cryptography",
]

LICENCE_FILES = ("LICENSE", "LICENSE.txt", "LICENSE.md", "LICENCE",
                 "COPYING", "COPYING.txt", "NOTICE")


def licence_texts(dist):
    """Every licence file the package shipped, as (relative name, text).

    Modern wheels put these in `<name>.dist-info/licenses/`, and
    Distribution.read_text() resolves relative to the .dist-info directory - so
    passing it the path from dist.files looks in the wrong place and silently
    finds nothing. locate() gives the real path on disk; read that.

    All of them, not just the first: numpy alone ships ten, because it vendors
    code under separate terms and every one of those notices has to travel too.
    """
    out = []
    for f in dist.files or []:
        parts = [p.upper() for p in f.parts]
        is_licence = (
            f.name.upper().startswith(("LICENSE", "LICENCE", "COPYING", "NOTICE"))
            or "LICENSES" in parts
        )
        if not is_licence or f.name.endswith((".py", ".pyc", ".so", ".pyd")):
            continue
        try:
            text = pathlib.Path(str(f.locate())).read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        if text.strip():
            out.append((f.name, text.strip()))
    return out


def main():
    chunks, missing, nolicence, found = [], [], [], 0

    for name in sorted(SHIPPED, key=str.lower):
        try:
            dist = md.distribution(name)
        except md.PackageNotFoundError:
            missing.append(name)
            continue

        meta = dist.metadata
        texts = licence_texts(dist)
        found += 1

        chunks.append("=" * 78)
        chunks.append(f"{meta['Name']} {meta['Version']}")
        if meta.get("License-Expression"):
            chunks.append(f"License: {meta['License-Expression']}")
        elif meta.get("License") and len(meta["License"]) < 90:
            chunks.append(f"License: {meta['License']}")
        if meta.get("Home-page"):
            chunks.append(f"Homepage: {meta['Home-page']}")
        chunks.append("")
        # The full text, not just the SPDX name - a licence reproduced by name
        # only does not satisfy "include this notice".
        if texts:
            for i, (name, text) in enumerate(texts):
                if len(texts) > 1:
                    chunks.append(f"--- {name} ---")
                chunks.append(text)
                chunks.append("")
        else:
            nolicence.append(meta["Name"])
            chunks.append("(This distribution shipped no licence file. See the "
                          "project homepage for its terms.)")
            chunks.append("")

    header = [
        "THIRD-PARTY NOTICES",
        "",
        "CreaCon is distributed with the open-source components listed below.",
        "Each remains under its own licence, reproduced here as those licences",
        "require. Nothing in this file changes CreaCon's own terms - see LICENSE.",
        "",
        f"{found} components.",
        "",
    ]
    OUT.write_text("\n".join(header + chunks), encoding="utf-8")

    print(f"wrote {OUT}  ({found} components, {OUT.stat().st_size // 1024} KB)")
    if missing:
        print(f"not installed, skipped: {', '.join(missing)}")
        print("  (fine if unused - but check none of them ship in the bundle)")
    if nolicence:
        print(f"NO LICENCE FILE SHIPPED, needs a manual look: {', '.join(nolicence)}")


if __name__ == "__main__":
    sys.exit(main())
