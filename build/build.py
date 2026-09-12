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


def find_ccx():
    """The packaged plugin, wherever UXP Developer Tools left it.

    UDT writes <PluginName>_PS.ccx next to the manifest rather than taking a
    path, so looking only in build/ finds nothing even when the file exists.
    Newest wins, so repackaging just works.
    """
    # Three places, because UXP Developer Tools does not take a path and has
    # been observed writing to both the plugin folder and the repo root.
    found = [f for d in (BUILD, ROOT / "CreaCon", ROOT) for f in d.glob("*.ccx")]
    return max(found, key=lambda f: f.stat().st_mtime) if found else None


def installer(v):
    say("installer")
    ccx = find_ccx()
    if ccx is None:
        sys.exit(
            chr(10).join([
                "No plugin package (.ccx) found.",
                "",
                "It comes out of UXP Developer Tools, not the command line:",
                "load CreaCon/manifest.json, then the ... menu -> Package.",
                "Leave it anywhere under CreaCon/ or build/, then run this again.",
            ])
        )
    # The .ccx carries its own copy of manifest.json, frozen at whatever the
    # version was when UXP Developer Tools packaged it. Bumping the repo does
    # not update it, so without this check a 0.7.0 installer happily ships a
    # 0.6.4 plugin and nothing says so.
    import zipfile

    with zipfile.ZipFile(ccx) as z:
        plugin_v = json.loads(z.read("manifest.json"))["version"]
    if plugin_v != v:
        sys.exit(
            f"{ccx.name} contains plugin version {plugin_v}, but this build is {v}."
            " Re-export it: UXP Developer Tools -> ... -> Package."
        )
    print(f"plugin: {ccx.name} (v{plugin_v})")
    # installer.iss expects one fixed name, but UXP Developer Tools names the
    # file after the plugin and writes it beside the manifest - so copy it
    # rather than making the user move it after every repackage.
    staged = BUILD / "CreaCon.ccx"
    if ccx.resolve() != staged.resolve():
        shutil.copy2(ccx, staged)

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
    if not out.exists():
        # Inno reported success but produced nothing at the expected name.
        # That happened once: a hardcoded #define AppVersion overrode the /D
        # on the command line, so the installer was built and named after the
        # wrong version while this check quietly passed.
        built = sorted(f.name for f in DIST.glob("CreaCon-*-setup.exe"))
        sys.exit(
            f"Expected {out.name}, which was not produced. "
            + (f"Found instead: {built}" if built else "Nothing was built.")
        )
    print()
    print(f"{out}  ({out.stat().st_size / 1024 / 1024:.0f} MB)")


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
