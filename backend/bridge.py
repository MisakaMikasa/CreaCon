"""The link between the desktop app and the plugin running inside Photoshop.

The desktop app owns the chat; the executor that actually drives Photoshop can
only ever live inside the plugin. Two separate programs, so an edit plan has to
travel as a message rather than a function call.

Direction is forced: **a UXP plugin cannot be connected to.** Adobe exposes
ways for a plugin to reach out (fetch, WebSocket) and nothing to listen with.
So the plugin opens the connection, even though the app is the side with
something to say, and this module holds whatever connection turns up.

WebSocket rather than polling because of the RETURN path. applyEditPlan reports
after every step - that is why layers appear one at a time - and those updates
travel plugin -> app while the apply is still running and Photoshop is frozen,
which is exactly when the user most needs to see progress. Polling carries the
plan down fine and brings progress back badly.

The bit worth understanding: POST /apply is an ordinary HTTP request, but its
answer arrives on a different connection entirely, seconds or minutes later.
`_pending` is what lets the two find each other - the request parks an empty
box under a ticket number and suspends; the socket handler fills the box by
that number, which wakes the request.
"""

import asyncio
import logging
import secrets
import uuid
from typing import Any, Optional

logger = logging.getLogger("creacon.bridge")

# An apply enters executeAsModal and Camera Raw re-develops the photo - seconds
# for a 26MP raw, and a multi-step plan runs several. A conventional 30s
# default would abort work that was going to succeed.
APPLY_TIMEOUT = 180.0

# How long the plugin gets to send its "hello" before we hang up. Short: a real
# client sends it immediately on open.
HELLO_TIMEOUT = 10.0

# Exporting a canvas JPEG and reading the layer stack. Quick, but it enters
# executeAsModal, so it waits behind anything already modal.
CONTEXT_TIMEOUT = 30.0


class Bridge:
    """Holds the one live plugin connection. One Photoshop, one socket.

    A second connection replaces the first rather than being refused - that is
    what happens when the plugin is reloaded in UXP Developer Tools, and
    refusing would leave the stale socket owning the slot forever.
    """

    def __init__(self) -> None:
        self._ws = None
        self._pending: dict[str, asyncio.Future] = {}

    # ---- state -----------------------------------------------------------

    def connected(self) -> bool:
        return self._ws is not None

    # ---- connection lifecycle -------------------------------------------

    async def attach(self, ws) -> None:
        if self._ws is not None:
            logger.info("a plugin was already attached - replacing it")
            try:
                await self._ws.close()
            except Exception:
                pass  # already gone; nothing to salvage
        self._ws = ws
        logger.info("plugin attached")

    async def detach(self, ws) -> None:
        """Drop the connection, and fail anything still waiting on it.

        Without this, a request parked in apply() would sit until its timeout
        even though its answer can no longer arrive. Failing fast turns a
        three-minute hang into an immediate, accurate error.
        """
        if self._ws is not ws:
            return  # a newer connection already replaced this one
        self._ws = None
        logger.info("plugin detached")
        for future in list(self._pending.values()):
            if not future.done():
                future.set_exception(ConnectionError("plugin disconnected mid-apply"))
        self._pending.clear()

    # ---- request / response ---------------------------------------------

    async def request(self, kind: str, payload: dict, timeout: float) -> dict:
        """Ask the plugin something and wait for the matching reply.

        Every call in and out of Photoshop goes through here. The reply lands
        on the socket rather than on this request, so a Future is parked under
        a ticket id and this coroutine suspends until the socket handler fills
        it - see resolve(). The event loop keeps serving other requests, which
        is why /ping stays live during a two-minute apply.
        """
        if self._ws is None:
            raise ConnectionError("no plugin connected")

        request_id = str(uuid.uuid4())
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future

        try:
            await self._ws.send_json({"type": kind, "id": request_id, **payload})
            return await asyncio.wait_for(future, timeout)
        finally:
            # Covers every exit - timeout, disconnect, success - so a dropped
            # request can never leak an entry into _pending.
            self._pending.pop(request_id, None)

    async def apply(self, plan: dict, timeout: float = APPLY_TIMEOUT) -> dict:
        """Send a plan to the plugin and wait for its verdict."""
        logger.info("sending a plan (%d step(s))", len(plan.get("steps") or []))
        return await self.request("apply", {"plan": plan}, timeout)

    async def context(self, timeout: float = CONTEXT_TIMEOUT) -> dict:
        """Canvas JPEG + layer names + raw develop state, read from Photoshop.

        The desktop app cannot produce any of this - exporting a preview and
        listing layers both need the document. So the backend collects it on
        the app's behalf when the caller did not supply it, which is what makes
        /chat identical for the app and for the existing plugin.
        """
        reply = await self.request("context", {}, timeout)
        return reply.get("context") or {}

    def resolve(self, msg: dict) -> None:
        """Fill the box a parked apply() is waiting on."""
        future = self._pending.pop(msg.get("id", ""), None)
        if future is None or future.done():
            # A reply that arrives after its request already timed out, or a
            # duplicate. Dropping it quietly is correct - raising here would
            # kill the socket handler and take the connection down with it.
            logger.debug("ignoring reply with no waiting request: %s", msg.get("id"))
            return
        future.set_result(msg)

    # ---- the socket handler ---------------------------------------------

    async def serve(self, ws, expected_token: str) -> None:
        """Run one plugin connection start to finish.

        First frame must be {"type": "hello", "token": ...}. Same token that
        gates /chat, so there is one secret rather than two, and the plugin
        already has it from /ping.
        """
        await ws.accept()
        try:
            hello = await asyncio.wait_for(ws.receive_json(), HELLO_TIMEOUT)
        except (asyncio.TimeoutError, Exception):
            await ws.close(code=1008)
            logger.warning("client never sent hello - closed")
            return

        token = str(hello.get("token", "")) if isinstance(hello, dict) else ""
        if not secrets.compare_digest(token, expected_token):
            await ws.close(code=1008)
            logger.warning("client sent a bad token - closed")
            return

        await ws.send_json({"type": "hello_ack"})
        await self.attach(ws)

        try:
            while True:
                msg = await ws.receive_json()
                kind = msg.get("type")
                if kind == "progress":
                    # Logged for now. In step 2b these are forwarded to the
                    # desktop UI so the user sees steps land one at a time.
                    logger.info("  step %s: %s", msg.get("step"), msg.get("result"))
                elif kind in ("done", "error", "context_result"):
                    self.resolve(msg)
                else:
                    logger.debug("unknown frame from plugin: %r", kind)
        except Exception as exc:
            logger.info("plugin connection ended (%s)", type(exc).__name__)
        finally:
            await self.detach(ws)


bridge = Bridge()
