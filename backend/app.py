"""The desktop app: the backend plus a window to look at it through.

Separate from main.py on purpose. main.py is the server, and `python main.py`
is still the headless way to run it - that is what the Photoshop plugin talks
to today and it must keep working on a machine with no GUI toolkit installed.
This module is the thing that additionally puts a window around it.

Why the threading below is shaped the way it is:

`uvicorn.run()` never returns - it loops forever serving requests.
`webview.start()` never returns either - it loops forever handling clicks and
redraws. Two calls that each block forever cannot be made one after the other,
so one of them has to move to a second thread.

It has to be the server that moves. A window belongs to the operating system,
and Windows delivers its events (click, resize, close) to a queue owned by the
thread that created it, on top of graphics initialisation that must happen on
the process's first thread. Create the window off the main thread and the
events go somewhere nobody is listening. Every GUI toolkit has this rule; the
server is simply the half that is free to move.
"""

import logging
import os
import threading
import time
import urllib.error
import urllib.request

import uvicorn
import webview

import main

logger = logging.getLogger("creacon.app")

WINDOW_TITLE = "CreaCon"
WINDOW_SIZE = (460, 760)  # portrait, roughly the proportions of the PS panel


def _serve(port: int) -> None:
    """Run the API. Never returns."""
    uvicorn.run(main.app, host="127.0.0.1", port=port, log_level="warning")


def _wait_until_up(port: int, timeout: float = 20.0) -> bool:
    """Block until the server answers, or give up.

    Starting a thread returns immediately; it does not mean the socket is
    bound yet. Opening the window before then loads a page from a server that
    is not listening, which renders as a connection error and reads like the
    app is broken when it is merely early.
    """
    deadline = time.time() + timeout
    url = f"http://127.0.0.1:{port}/ping"
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=0.5):
                return True
        except (urllib.error.URLError, OSError):
            time.sleep(0.1)
    return False


def run() -> None:
    port = main.choose_port()

    # daemon=True is what stops a zombie process. A normal thread keeps the
    # interpreter alive until it finishes, and this one never finishes - so
    # closing the window would leave an invisible process running forever,
    # still holding the port. As a daemon it dies with the main thread.
    threading.Thread(target=_serve, args=(port,), daemon=True, name="uvicorn").start()

    if not _wait_until_up(port):
        raise SystemExit(f"backend did not come up on port {port} - nothing to show")

    logger.info("CreaCon %s ready on http://127.0.0.1:%d", main.VERSION, port)
    webview.create_window(
        WINDOW_TITLE,
        f"http://127.0.0.1:{port}/",
        width=WINDOW_SIZE[0],
        height=WINDOW_SIZE[1],
    )
    # debug=True turns on the WebView2 devtools (right-click -> Inspect, or F12).
    # Without it the page's console is unreachable, which makes a UI bug in here
    # far harder to diagnose than the same bug in the UXP panel, where Adobe's
    # debugger was always a click away. Off unless CREACON_DEBUG is set, so a
    # shipped build does not hand users a devtools window.
    debug = os.environ.get("CREACON_DEBUG", "") not in ("", "0")
    if debug:
        logger.info("devtools enabled (CREACON_DEBUG) - right-click the window to inspect")
    webview.start(debug=debug)  # returns only when the user closes the window


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run()
