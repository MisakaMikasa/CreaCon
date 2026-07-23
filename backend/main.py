import logging
import time
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from jsonschema import ValidationError
from pydantic import BaseModel

from llm_client import chat, request_edit_plan
from plan_extract import extract_plan
from validator import validate_edit_plan

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("creacon")

app = FastAPI(title="CreaCon AI Backend")

# Permissive CORS for local UXP development. Tighten this before shipping.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST"],
    allow_headers=["*"],
)


class EditPlanRequest(BaseModel):
    instruction: str
    image_base64: Optional[str] = None
    layer_names: Optional[List[str]] = None
    selected_layers: Optional[List[str]] = None
    camera_raw: Optional[dict] = None  # {"raws": [{"layer": name, "settings": {...}|None}]}


@app.post("/edit-plan")
def edit_plan(req: EditPlanRequest):
    if not req.instruction.strip():
        raise HTTPException(400, "instruction must not be empty")

    context = {
        "layer_names": req.layer_names,
        "selected_layers": req.selected_layers,
        "camera_raw": req.camera_raw,
    }
    logger.info("layer context: %s", context)
    plan = request_edit_plan(req.instruction, req.image_base64, context)

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


# --- Self-check trial: auto-accept ACR AI-mask computation --------------------
# Adobe provides NO scriptable trigger for "Update AI settings" (researched and
# confirmed), but Ctrl+Shift+U inside the Camera Raw dialog runs "Update All".
# The plugin calls this endpoint, which then waits for/targets the ACR dialog,
# sends the shortcut, waits out the AI compute, and presses Enter (OK) - which
# also makes ACR write the computed digests to the sidecar.
#
# pyautogui sends OS-level key events to whatever window currently has FOCUS -
# it does not need a specific window handle. Since the ACR dialog is modal, it
# has focus the instant it opens regardless of whether our window-title search
# matches. So window search here is only a "how long do we wait" signal, not a
# targeting requirement - if it never matches, we still send the keys BLINDLY
# once a conservative fixed wait has elapsed, rather than doing nothing (silent
# no-op was the old behavior, and looked like a hang / forced a manual click).
#
# This runs synchronously in the request handler (FastAPI executes sync `def`
# endpoints in a thread pool, so it doesn't block other requests) so the
# response can report exactly what happened, instead of guessing.

ACR_WINDOW_TITLE = "Camera Raw"
ACR_WAIT_WINDOW_S = 10   # max time spent polling for the window before going blind
ACR_SETTLE_S = 1.5       # extra settle once the window is seen (or the poll times out)
ACR_COMPUTE_S = 12       # AI segmentation time before pressing OK
ACR_CLOSE_CHECK_S = 1.5  # grace period to confirm the dialog closed after Enter


def _find_acr_window(pygetwindow):
    try:
        candidates = [w for w in pygetwindow.getWindowsWithTitle(ACR_WINDOW_TITLE) if w.visible]
        return candidates[0] if candidates else None
    except Exception:
        return None


def _run_acr_auto_accept() -> dict:
    import pyautogui
    import pygetwindow

    result = {"window_seen": False, "sent_hotkey": False, "sent_enter": False, "confirmed_closed": None}

    deadline = time.time() + ACR_WAIT_WINDOW_S
    while time.time() < deadline:
        if _find_acr_window(pygetwindow):
            result["window_seen"] = True
            break
        time.sleep(0.3)
    if not result["window_seen"]:
        logger.warning(
            "acr auto-accept: Camera Raw window not detected within %ss - "
            "proceeding blind (dialog is modal, likely has focus regardless)",
            ACR_WAIT_WINDOW_S,
        )

    time.sleep(ACR_SETTLE_S)
    logger.info("acr auto-accept: sending Ctrl+Shift+U (Update All)")
    pyautogui.hotkey("ctrl", "shift", "u")
    result["sent_hotkey"] = True

    time.sleep(ACR_COMPUTE_S)
    logger.info("acr auto-accept: pressing Enter (OK)")
    pyautogui.press("enter")
    result["sent_enter"] = True

    time.sleep(ACR_CLOSE_CHECK_S)
    still_open = _find_acr_window(pygetwindow)
    if still_open:
        # First Enter may have landed before the dialog was ready to accept it -
        # retry once rather than leaving the user to close it manually.
        logger.info("acr auto-accept: dialog still open - retrying Enter")
        pyautogui.press("enter")
        time.sleep(ACR_CLOSE_CHECK_S)
        still_open = _find_acr_window(pygetwindow)
    result["confirmed_closed"] = not bool(still_open)
    return result


@app.post("/acr/auto-accept")
def acr_auto_accept():
    try:
        import pyautogui  # noqa: F401
        import pygetwindow  # noqa: F401
    except ImportError:
        raise HTTPException(
            501,
            "Keyboard automation not installed - run: pip install pyautogui pygetwindow "
            "in the backend venv.",
        )
    return _run_acr_auto_accept()


class ChatMessage(BaseModel):
    role: str  # "user" or "assistant"
    content: str


class ChatRequest(BaseModel):
    messages: List[ChatMessage]
    image_base64: Optional[str] = None
    layer_names: Optional[List[str]] = None
    selected_layers: Optional[List[str]] = None
    camera_raw: Optional[dict] = None  # {"raws": [{"layer": name, "settings": {...}|None}]}
    aggressiveness: Optional[int] = None  # 1..5; None = no guidance (default behavior)


@app.post("/chat")
def chat_endpoint(req: ChatRequest):
    if not req.messages:
        raise HTTPException(400, "messages must not be empty")

    context = {
        "layer_names": req.layer_names,
        "selected_layers": req.selected_layers,
        "camera_raw": req.camera_raw,
        "aggressiveness": req.aggressiveness,
    }
    logger.info("chat: %d messages, layer context: %s", len(req.messages), context)

    conversation = [{"role": m.role, "content": m.content} for m in req.messages]

    reply_text = _call_chat(conversation, req.image_base64, context)
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

    if plan is not None and not plan.get("summary"):
        plan["summary"] = "AI Edit"

    return {"reply": display, "edit_plan": plan}
