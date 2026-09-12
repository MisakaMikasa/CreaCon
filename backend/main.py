import asyncio
import base64
import json
import logging
import secrets
import os
import time
from typing import List, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from jsonschema import ValidationError
from pydantic import BaseModel

from geometry_render import crop_thumbnails, rotation_preview
from image_annotate import add_coordinate_grid
import config
from bridge import bridge
from llm_client import chat, request_edit_plan
from mask_render import corrections_from_plan, render_verify_image
from paths import resource, userdata
from plan_extract import extract_plan
from validator import validate_edit_plan

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("creacon")

VERSION = "0.7.0"
# Shown wherever a human reads it. The version string itself stays numeric:
# Adobe's manifest expects major.minor.patch and a suffix risks rejection
# at packaging time.
RELEASE_LABEL = "Early Access"

# Feature toggles (env). GRID_OVERLAY draws the coordinate ruler on previews
# (default on; set 0 to A/B against the un-gridded baseline). VERIFY_MASKS runs
# the within-turn mask check (default off - it costs one extra model call per
# masked plan).
GRID_OVERLAY = os.environ.get("GRID_OVERLAY", "1") != "0"
VERIFY_MASKS = os.environ.get("VERIFY_MASKS", "0") == "1"
# Write the rendered mask overlays to disk so they can be eyeballed (the two-panel
# image = masks over the photo + the same masks on black). Default on for dev.
SAVE_OVERLAYS = os.environ.get("SAVE_OVERLAYS", "1") != "0"
OVERLAY_DIR = os.environ.get("OVERLAY_DIR") or str(userdata("debug_overlays"))


def _prepare_preview(image_base64):
    """The preview we hand the model: coordinate grid drawn on unless disabled."""
    if not image_base64:
        return None
    return add_coordinate_grid(image_base64) if GRID_OVERLAY else image_base64


def _save_overlay(gridded_image, corrections, tag):
    """Render the two-panel mask overlay (masks-on-photo + masks-on-black) and
    write it to OVERLAY_DIR for inspection. Returns the overlay base64 (so the
    caller can reuse it) or None. Best-effort - never breaks a turn."""
    corrections = [c for c in (corrections or []) if not c.get("Unsupported")]
    if not (SAVE_OVERLAYS and gridded_image and corrections):
        return None
    try:
        os.makedirs(OVERLAY_DIR, exist_ok=True)
        overlay = render_verify_image(gridded_image, corrections)
        if overlay == gridded_image:  # nothing renderable
            return None
        ts = time.strftime("%Y%m%d-%H%M%S")
        path = os.path.join(OVERLAY_DIR, f"{ts}_{tag}.jpg")
        with open(path, "wb") as f:
            f.write(base64.b64decode(overlay))
        names = ", ".join(c.get("CorrectionName", "?") for c in corrections)
        logger.info("mask overlay [%s] saved -> %s  (%d correction(s): %s)", tag, path, len(corrections), names)
        return overlay
    except Exception as exc:
        logger.warning("could not save overlay image: %s", exc)
        return None

app = FastAPI(title="CreaCon AI Backend")

# This server can drive Photoshop, so reaching it must be harder than knowing
# the port. Three layers, none sufficient alone:
#
#   1. It binds 127.0.0.1 (see __main__), so nothing off this machine can
#      connect at all.
#   2. No browser origin is allowed. A page the user is visiting cannot read a
#      response, and because every real endpoint needs a JSON content type and
#      a custom header, its request is preflighted - and the preflight fails.
#   3. Mutating endpoints require the shared token from config.json. The UXP
#      plugin is not a browser origin and reads it from /ping.
#
# Removing any one of these puts "any website you visit can edit your photos"
# back on the table, which is what allow_origins=["*"] meant here before.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[],
    allow_methods=["POST"],
    allow_headers=["X-CreaCon-Token", "Content-Type"],
)

TOKEN = config.ensure_token()


def require_token(x_creacon_token: str = Header(default="")) -> None:
    """Rejects anything that cannot present the token from config.json."""
    if not secrets.compare_digest(x_creacon_token, TOKEN):
        raise HTTPException(401, "missing or invalid X-CreaCon-Token")


@app.get("/ping")
def ping():
    """Identifies this port as CreaCon and hands the plugin its token.

    Deliberately unauthenticated: it is how the plugin discovers both which
    port we ended up on and what token to send. Safe because the socket is
    bound to loopback and no browser origin can read the response.
    """
    return {
        "app": "creacon",
        "version": VERSION,
        "release_label": RELEASE_LABEL,
        "token": TOKEN,
        "plugin_connected": bridge.connected(),
    }


class EditPlanRequest(BaseModel):
    instruction: str
    image_base64: Optional[str] = None
    layer_names: Optional[List[str]] = None
    selected_layers: Optional[List[str]] = None
    camera_raw: Optional[dict] = None  # {"raws": [{"layer": name, "settings": {...}|None}]}


@app.post("/edit-plan", dependencies=[Depends(require_token)])
def edit_plan(req: EditPlanRequest):
    if not req.instruction.strip():
        raise HTTPException(400, "instruction must not be empty")

    context = {
        "layer_names": req.layer_names,
        "selected_layers": req.selected_layers,
        "camera_raw": req.camera_raw,
    }
    logger.info("layer context: %s", context)
    image = _prepare_preview(req.image_base64)
    plan = request_edit_plan(req.instruction, image, context)

    # `summary` is required by the schema but is only a cosmetic label (shown
    # before Apply, and used as the undo name). Gemini occasionally omits it -
    # don't reject an otherwise-valid plan over a missing label.
    if isinstance(plan, dict) and not plan.get("summary"):
        plan["summary"] = "AI Edit"

    try:
        validate_edit_plan(plan)
    except ValidationError as exc:
        logger.warning("LLM returned a plan that failed schema validation: %s", exc.message)
        raise HTTPException(502, f"AI returned an invalid edit plan: {exc.message}")

    return plan


FORMAT_REMINDER = (
    "Your previous reply looks like it contained an edit plan, but it couldn't be used - "
    '{error}. Reply again with the corrected plan as a single fenced ```json code block that '
    'exactly matches the schema (top-level "summary" and "steps"; each step has "op", '
    '"description", and "params"; use only the allowed ops, enums, and settings keys). '
    "Close the code fence with ```."
)


def _call_chat(conversation, image_base64, context):
    """Calls the provider, converting provider errors into clean HTTP responses."""
    try:
        return chat(conversation, image_base64, context)
    except Exception as exc:  # provider/network errors - clean message, not a 500 traceback
        msg = str(exc)
        logger.warning("chat provider error: %s", msg)
        lowered = msg.lower()
        if "429" in msg or "resource_exhausted" in lowered or "quota" in lowered or "rate limit" in lowered:
            raise HTTPException(
                429,
                "AI provider rate limit reached (Gemini free tier is ~20 requests/day). "
                "Wait for the quota to reset, upgrade your plan, or switch LLM_PROVIDER in .env.",
            )
        raise HTTPException(502, f"AI request failed: {msg[:300]}")


MASK_VERIFY_INSTRUCTION = (
    "Below is a MASK PREVIEW of your proposed edit - a diagnostic image, NOT the actual photo. It "
    "has two stacked panels sharing the same colours and name labels:\n"
    "  TOP - your masks tinted over the real photo (with the coordinate grid), each correction in "
    "its own colour with a coloured BORDER around its region and a name chip at its centre. Use "
    "this to check the mask against image CONTENT.\n"
    "  BOTTOM - the same mask shapes on black, so the coverage and its soft edges are unambiguous.\n"
    "\n"
    "DEFAULT TO KEEPING THE PLAN. These masks are meant to be SOFT and FEATHERED, so a little "
    "spill onto neighbouring areas is normal and desirable - do NOT shrink a mask just because it "
    "bleeds slightly past the target. The ONLY things worth correcting are CLEAR failures:\n"
    "  1. The target is largely NOT covered (the tint misses most of the intended subject/region), or\n"
    "  2. The mask is on the WRONG place entirely, or grossly oversized (e.g. a radial covering "
    "most of the whole frame when a small area was intended).\n"
    "When you do fix a miss, it is usually because the mask is too SMALL or off-centre - prefer to "
    "ENLARGE/MOVE it to cover the whole target rather than tightening it. Never trade covering the "
    "target for avoiding spill.\n"
    "\n"
    "If every mask adequately covers its target, you have two acceptable choices: keep the plan "
    "UNCHANGED, or make a SMALL refining nudge - e.g. shift a mask a little (right/left/up/down) or "
    "grow it slightly - when you see a clear, minor improvement in the fit. Keep such nudges small "
    "and NEVER reduce coverage of the target to make them. Make a LARGE change ONLY for a clear "
    "failure (1 or 2 above). Reply with exactly ONE ```json edit-plan block and a one-line note - "
    "nothing else."
)


def _verify_masks(conversation, plan, gridded_image, context):
    """Within-turn self-check: render where the plan's geometric masks land, show
    it back to the model, and adopt its corrected plan if it fixes a miss. Returns
    the (possibly updated) plan. Best-effort - any failure keeps the original."""
    corrections = [c for c in corrections_from_plan(plan) if not c.get("Unsupported")]
    if not corrections or not gridded_image:
        logger.info("verify: skipped (no geometric masks to check)")
        return plan
    logger.info(
        "verify: checking %d correction(s): %s",
        len(corrections),
        ", ".join(c.get("CorrectionName", "?") for c in corrections),
    )
    # Render + save the exact overlay we show the model (two panels).
    overlay = _save_overlay(gridded_image, corrections, "verify") or render_verify_image(gridded_image, corrections)
    if overlay == gridded_image:
        return plan  # nothing renderable (no geometric masks) or render failed

    verify_conversation = conversation + [
        {"role": "assistant", "content": f"```json\n{json.dumps(plan)}\n```"},
        {"role": "user", "content": MASK_VERIFY_INSTRUCTION},
    ]
    try:
        verify_text = chat(verify_conversation, overlay, context)
    except Exception as exc:
        logger.warning("mask verify pass failed, keeping original plan: %s", exc)
        return plan
    _, verified_plan, _ = extract_plan(verify_text)
    if verified_plan is None:
        return plan
    if not verified_plan.get("summary"):
        verified_plan["summary"] = plan.get("summary", "AI Edit")
    logger.info("mask verify pass produced a %s plan", "revised" if verified_plan != plan else "confirmed")
    return verified_plan


class ChatMessage(BaseModel):
    role: str  # "user" or "assistant"
    content: str


class ChatRequest(BaseModel):
    messages: List[ChatMessage]
    image_base64: Optional[str] = None
    layer_names: Optional[List[str]] = None
    selected_layers: Optional[List[str]] = None
    camera_raw: Optional[dict] = None  # {"raws": [{"layer": name, "settings": {...}|None}]}


@app.post("/chat", dependencies=[Depends(require_token)])
async def chat_endpoint(req: ChatRequest):
    context_notes: List[str] = []
    # The plugin sends its own context; the desktop app cannot - exporting a
    # canvas JPEG and listing layers both need the document. So when the caller
    # supplied none, collect it from Photoshop over the bridge. That is what
    # keeps this endpoint identical for both callers.
    if req.image_base64 is None and not req.layer_names and bridge.connected():
        try:
            ctx = await bridge.context()
            req.image_base64 = ctx.get("image_base64")
            req.layer_names = ctx.get("layer_names") or []
            req.selected_layers = ctx.get("selected_layers") or []
            req.camera_raw = ctx.get("camera_raw")
            # Warnings the plugin raised while collecting context - e.g. two
            # layers that are secretly one photo. They must reach the MODEL
            # before it plans, not just the user afterwards, so they go in as a
            # [note] turn exactly as the panel used to do.
            context_notes = ctx.get("notes") or []
            logger.info("collected context from the plugin: %d layer(s), preview %s, %d note(s)",
                        len(req.layer_names), "yes" if req.image_base64 else "no",
                        len(context_notes))
        except Exception as exc:
            # A text-only turn is degraded but useful; a failed turn is not.
            logger.warning("could not collect context from the plugin: %s", exc)

    if not req.messages:
        raise HTTPException(400, "messages must not be empty")

    context = {
        "layer_names": req.layer_names,
        "selected_layers": req.selected_layers,
        "camera_raw": req.camera_raw,
    }
    logger.info("chat: %d messages, layer context: %s", len(req.messages), context)

    conversation = [{"role": m.role, "content": m.content} for m in req.messages]

    # Context warnings go in BEFORE the model plans, not just to the user
    # afterwards. Two layers that are secretly one photo change what a sensible
    # edit looks like - the panel pushed these into the conversation for exactly
    # this reason, and collecting context server-side must not lose it.
    for note in context_notes:
        conversation.append({"role": "user", "content": f"[note] {note}"})

    # Draw the labeled 0..1 coordinate grid onto the preview so the model can
    # read mask coordinates off anchors instead of guessing (see image_annotate).
    image = _prepare_preview(req.image_base64)
    reply_text = _call_chat(conversation, image, context)
    display, plan, err = extract_plan(reply_text)

    # Single corrective retry: only when the model clearly attempted a plan but
    # it was invalid (err is set). Never retry plain conversation, and never more
    # than once, so we can't loop. No image on the retry - it's only a reformat.
    if plan is None and err is not None:
        logger.info("plan invalid (%s); retrying once with a format reminder", err)
        retry_conversation = conversation + [
            {"role": "assistant", "content": reply_text},
            {"role": "user", "content": FORMAT_REMINDER.format(error=err)},
        ]
        try:
            retry_text = chat(retry_conversation, None, context)
        except Exception as exc:
            logger.warning("retry attempt failed, keeping original reply: %s", exc)
            retry_text = None
        if retry_text:
            retry_display, retry_plan, _ = extract_plan(retry_text)
            if retry_plan is not None:
                display, plan = retry_display, retry_plan

    # Optional within-turn mask verification: render where the masks land and let
    # the model correct a miss before the user ever applies it.
    if VERIFY_MASKS and plan is not None:
        plan = _verify_masks(conversation, plan, image, context)

    if plan is not None and not plan.get("summary"):
        plan["summary"] = "AI Edit"

    # Always save the final plan's mask overlay (what will actually be applied)
    # for inspection, whether or not verification ran.
    if plan is not None:
        _save_overlay(image, corrections_from_plan(plan), "final")

    # Geometry previews, rendered from the preview JPEG we already have. Every
    # apply costs the user a manual Camera Raw dialog, so showing candidate crops
    # by trial-applying them would cost one dialog each; cropping the preview
    # costs nothing and they pick once. Rendered from the UNGRIDDED original so
    # the thumbnails are of the photo, not of our coordinate overlay.
    previews = _geometry_previews(plan, req.image_base64)

    return {
        "reply": display,
        "edit_plan": plan,
        "geometry_previews": previews,
        "context_notes": context_notes,
    }


def _geometry_previews(plan, image_base64):
    """Thumbnails for a plan's crop proposals, or for a straighten it proposes."""
    if not plan or not image_base64:
        return None
    try:
        proposals = plan.get("proposals") or []
        if proposals:
            cards = crop_thumbnails(image_base64, proposals)
            return {"kind": "crops", "options": cards} if cards else None

        for step in plan.get("steps") or []:
            if step.get("op") != "applyGeometry":
                continue
            params = step.get("params") or {}
            # Only a plain straighten is previewable. Upright is fitted to the
            # image content by Camera Raw and cannot be known until it has run.
            if params.get("rotate") and not params.get("upright"):
                return {"kind": "rotation", **rotation_preview(image_base64, params["rotate"])}
    except Exception as exc:  # a preview is a nicety; never fail the turn over it
        logger.warning("geometry preview failed: %s", exc)
    return None


# Candidate ports, tried in order. 8000 stays first so an existing plugin
# build keeps working untouched; the 87xx range is the fallback because 8000
# is one of the most contended ports on a developer machine, and a user whose
# machine already has something there would otherwise just see a dead app.
#
# Every candidate is also declared in the plugin manifest's network domains -
# UXP refuses to fetch a host:port that is not listed, so this list and that
# one must stay in step.
PORT_CANDIDATES = [8000, 8731, 8732, 8733, 8734, 8735]


def choose_port():
    """The configured port if it is free, else the first candidate that is.

    Returns the port and records it in config.json so the desktop app and any
    tooling can find the running server without probing.
    """
    import socket

    configured = config.get("port")
    order = ([int(configured)] if configured else []) + PORT_CANDIDATES

    for port in order:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", port))
            except OSError:
                logger.info("port %d busy, trying the next", port)
                continue
        config.save(port=port)
        return port

    raise SystemExit(
        f"No free port among {order}. Close whatever is using them, or set "
        f'"port" in {config.CONFIG_FILE}.'
    )


class ApplyRequest(BaseModel):
    plan: dict


class SettingsRequest(BaseModel):
    gemini_api_key: Optional[str] = None
    anthropic_api_key: Optional[str] = None
    llm_provider: Optional[str] = None


@app.get("/settings", dependencies=[Depends(require_token)])
def read_settings():
    """What the settings screen shows. Keys are reported as present or absent,
    never returned - there is no reason to hand a secret back out, and doing so
    would put it in any log that captures a response body."""
    return {
        "llm_provider": config.get("llm_provider", "gemini"),
        "has_gemini_key": bool(config.get("gemini_api_key")),
        "has_anthropic_key": bool(config.get("anthropic_api_key")),
    }


@app.post("/settings", dependencies=[Depends(require_token)])
def write_settings(req: SettingsRequest):
    """Persist to config.json - the file an installed build reads instead of
    backend/.env, which it has no way to reach."""
    updates = {k: v for k, v in req.model_dump().items() if v}
    if not updates:
        raise HTTPException(400, "nothing to save")
    config.save(**updates)
    # The provider modules read their key and model at import time, so a change
    # here does not reach a module that is already loaded.
    return {"saved": sorted(updates), "restart_required": True}


@app.websocket("/bridge")
async def bridge_socket(ws: WebSocket):
    """The plugin's connection. It dials us, because a UXP plugin cannot be
    dialled - Adobe gives it no way to listen for an incoming connection."""
    await bridge.serve(ws, TOKEN)


@app.post("/apply", dependencies=[Depends(require_token)])
async def apply_plan(req: ApplyRequest):
    """Hand a plan to Photoshop and wait for the verdict.

    503 rather than 500 when nothing is attached: "Photoshop is not running"
    is an ordinary state the UI has to render, not a server fault.
    """
    if not bridge.connected():
        raise HTTPException(503, "Photoshop plugin is not connected")
    try:
        result = await bridge.apply(req.plan)
    except asyncio.TimeoutError:
        raise HTTPException(504, "the plugin did not answer in time")
    except ConnectionError as exc:
        raise HTTPException(503, str(exc))
    if result.get("type") == "error":
        raise HTTPException(422, result.get("message", "apply failed"))
    return result


# The desktop window loads this page. Served over http from the same origin
# it will call, rather than opened as a file:// URL - a file:// page counts as
# a different origin, so every fetch("/ping") from it would be blocked as
# cross-origin. Declared last: FastAPI matches in order, and "/" would
# otherwise sit in front of the real endpoints.
WEB_DIR = resource("backend", "web")


class RestoreRequest(BaseModel):
    checkpoint: str
    layer: Optional[str] = None


@app.post("/restore", dependencies=[Depends(require_token)])
async def restore_checkpoint(req: RestoreRequest):
    if not bridge.connected():
        raise HTTPException(503, "Photoshop plugin is not connected")
    try:
        result = await bridge.restore(req.checkpoint, req.layer)
    except asyncio.TimeoutError:
        raise HTTPException(504, "the plugin did not answer in time")
    except ConnectionError as exc:
        raise HTTPException(503, str(exc))
    if result.get("type") == "error":
        raise HTTPException(422, result.get("message", "restore failed"))
    return result


@app.post("/open-raw", dependencies=[Depends(require_token)])
async def open_raw():
    """The 'Open RAW' import, driven from the desktop window."""
    if not bridge.connected():
        raise HTTPException(503, "Photoshop plugin is not connected")
    try:
        result = await bridge.open_raw()
    except asyncio.TimeoutError:
        raise HTTPException(504, "the import was not completed in time")
    except ConnectionError as exc:
        raise HTTPException(503, str(exc))
    if result.get("type") == "error":
        raise HTTPException(422, result.get("message", "import failed"))
    return result


class CacheRemoveRequest(BaseModel):
    paths: List[str]


@app.post("/cache/survey", dependencies=[Depends(require_token)])
async def cache_survey():
    if not bridge.connected():
        raise HTTPException(503, "Photoshop plugin is not connected")
    try:
        return await bridge.cache_survey()
    except (asyncio.TimeoutError, ConnectionError) as exc:
        raise HTTPException(503, str(exc) or "the plugin did not answer")


@app.post("/cache/remove", dependencies=[Depends(require_token)])
async def cache_remove(req: CacheRemoveRequest):
    """Deletes working copies. Only ever called after the user confirmed a
    survey, and only with paths that survey returned."""
    if not bridge.connected():
        raise HTTPException(503, "Photoshop plugin is not connected")
    try:
        return await bridge.cache_remove(req.paths)
    except (asyncio.TimeoutError, ConnectionError) as exc:
        raise HTTPException(503, str(exc) or "the plugin did not answer")


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    return FileResponse(resource("assets", "creacon.ico"))


@app.get("/")
def index():
    return FileResponse(WEB_DIR / "index.html")


app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")


if __name__ == "__main__":
    # A frozen build has no command line, so `uvicorn main:app` is not
    # available to start it. This is the entry point that replaces it; running
    # the module directly and running the .exe now take the same path.
    import uvicorn

    port = choose_port()
    logger.info("CreaCon %s listening on http://127.0.0.1:%d", VERSION, port)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
