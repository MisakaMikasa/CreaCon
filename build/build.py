"""One command to produce the installer.

    python build/build.py           # notices -> freeze -> installer
    python build/build.py --app     # stop after freezing

Each step says what it did and why it stopped, because a build that fails
halfway with a wall of PyInstaller output is worse than no build script.
"""

import argparse
import json
import os
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
DIST = ROOT / "dist"
VENV_PY = ROOT / "backend" / ".venv" / "Scripts" / "python.exe"

def find_iscc():
    """Inno Setup's compiler, whichever major version is installed.

    Globbed rather than hard-coded: 7 is current, 6 is still widely installed,
    and a pinned "Inno Setup 6" path silently fails the day someone upgrades.
    Newest version wins.
    """
    found = []
    for base in (r"C:\Program Files (x86)", r"C:\Program Files"):
        for d in pathlib.Path(base).glob("Inno Setup *"):
            exe = d / "ISCC.exe"
            if exe.exists():
                found.append(exe)
    if not found:
        return None
    return sorted(found, key=lambda p: p.parent.name)[-1]


def say(msg):
    print(f"\n=== {msg}", flush=True)


def version():
    """From manifest.json, which is the one Adobe reads - so it is the one that
    has to be right, and everything else follows it."""
    return json.loads((ROOT / "CreaCon" / "manifest.json").read_text())["version"]


def check_versions(v):
    """All three version strings must agree, or the installer name lies about
    what is inside it."""
    pkg = json.loads((ROOT / "CreaCon" / "package.json").read_text())["version"]
    main = (ROOT / "backend" / "main.py").read_text(encoding="utf-8")
    backend = main.split('VERSION = "')[1].split('"')[0]
    if not (v == pkg == backend):
        sys.exit(
            f"Version mismatch - fix before building:\n"
            f"  manifest.json {v}\n  package.json  {pkg}\n  main.py       {backend}"
        )
    print(f"version {v}, consistent across all three")


def notices():
    say("third-party notices")
    subprocess.run([str(VENV_PY), str(BUILD / "make_notices.py")], check=True)


def freeze():
    say("freezing the app")
    if DIST.exists():
        shutil.rmtree(DIST, ignore_errors=True)
    subprocess.run(
        [str(VENV_PY), "-m", "PyInstaller", str(BUILD / "creacon.spec"),
         "--distpath", str(DIST), "--workpath", str(BUILD / "work"), "--noconfirm"],
        check=True, cwd=ROOT,
    )
    app = DIST / "CreaCon" / "CreaCon.exe"
    if not app.exists():
        sys.exit("PyInstaller finished but produced no CreaCon.exe")
    size = sum(f.stat().st_size for f in (DIST / "CreaCon").rglob("*") if f.is_file())
    print(f"built {app}  ({size / 1024 / 1024:.0f} MB)")


def installer(v):
    say("installer")
    ccx = BUILD / "CreaCon.ccx"
    if not ccx.exists():
        sys.exit(
            f"No plugin package at {ccx}\n\n"
            "The .ccx cannot be produced from the command line - it comes out of\n"
            "UXP Developer Tools: load CreaCon/manifest.json, then Actions -> Package.\n"
            "Save the result as build/CreaCon.ccx and run this again."
        )

    iscc = find_iscc()
    if iscc is None:
        sys.exit(
            "Inno Setup 6 is not installed.\n"
            "  https://jrsoftware.org/isdl.php\n"
            "It is only needed for this last step - the app in dist/CreaCon already runs."
        )

    print(f"using {iscc}")
    subprocess.run([str(iscc), f"/DAppVersion={v}", str(BUILD / "installer.iss")], check=True)
    out = DIST / f"CreaCon-{v}-setup.exe"
    if out.exists():
        print(f"\n{out}  ({out.stat().st_size / 1024 / 1024:.0f} MB)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--app", action="store_true", help="stop after freezing")
    args = ap.parse_args()

    if not VENV_PY.exists():
        sys.exit(f"No venv at {VENV_PY}")

    v = version()
    check_versions(v)
    notices()
    freeze()
    if args.app:
        print("\nStopped after the app, as asked. dist/CreaCon is runnable.")
        return
    installer(v)


if __name__ == "__main__":
    main()
