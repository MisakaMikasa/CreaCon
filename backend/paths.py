"""Where files live, in both of the layouts this code has to run in.

Running from source, the repo layout is fixed and a path can be walked
relative to this file:

    CreaCon/
      backend/paths.py          <- here
      schema/editPlan.schema.json

Frozen by PyInstaller into an .exe, it is not. The .py files are packed into
a compressed archive and bundled data lands in an `_internal` folder beside
the executable:

    creacon-backend/
      creacon-backend.exe
      _internal/
        paths.pyc               <- inside an archive
        schema/editPlan.schema.json

`__file__` still returns something there, but it names a location that does
not exist on disk, so "up one directory from me" lands nowhere. PyInstaller
sets `sys._MEIPASS` to the real root of the bundled files, and sets
`sys.frozen` so code can tell which layout it is in.

Two kinds of path, and the distinction matters:

  resource()  files we SHIP and only ever read (the schema).
  userdata()  files we WRITE at runtime. These must never go next to the
              program: an installed build lives in Program Files, where
              Windows denies writes to a normal user.
"""

import os
import sys
from pathlib import Path


def resource(*parts) -> Path:
    """A read-only file shipped with the app. resource("schema", "x.json")"""
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS).joinpath(*parts)
    return Path(__file__).resolve().parent.parent.joinpath(*parts)


def userdata(*parts) -> Path:
    """A path we may write to, under the user's own data directory.

    Creates the parent directory. Falls back to the repo when LOCALAPPDATA is
    absent (non-Windows dev), so this never raises just because it was
    imported somewhere unexpected.
    """
    root = os.environ.get("LOCALAPPDATA") or os.environ.get("XDG_DATA_HOME")
    base = Path(root, "CreaCon") if root else Path(__file__).resolve().parent
    p = base.joinpath(*parts)
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def config_dir() -> Path:
    """Where settings live: %APPDATA%\\CreaCon (roaming, unlike userdata)."""
    root = os.environ.get("APPDATA") or os.environ.get("XDG_CONFIG_HOME")
    base = Path(root, "CreaCon") if root else Path(__file__).resolve().parent
    base.mkdir(parents=True, exist_ok=True)
    return base
