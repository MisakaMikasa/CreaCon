import base64
import json
import os
from typing import List, Optional

from google import genai
from google.genai import types

from prompt import (
    CHAT_SYSTEM_PROMPT,
    SYSTEM_PROMPT,
    augment_user_text,
    build_user_message,
)

MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
# A small positive budget keeps Gemini snappy for chat; 0 disables thinking.
THINKING_BUDGET = int(os.environ.get("GEMINI_THINKING_BUDGET", "512"))

_client = genai.Client(api_key=os.environ.get("GEMINI_API_KEY"))


# Gemini's Developer API structured-output mode (response_schema) can't express
# our edit-plan schema: the free-form `params` object requires
# `additionalProperties`, which that mode rejects. So we don't use
# response_schema at all - we just ask for JSON (response_mime_type) and rely on
# two things that already exist: SYSTEM_PROMPT embeds the full JSON schema so
# Gemini knows the exact shape, and backend/validator.py does the strict per-op
# enforcement afterward (the same check the Anthropic path goes through). That
# keeps the real rules in one place - schema/editPlan.schema.json - regardless
# of which model produced the plan.
def request_edit_plan(instruction: str, image_base64: Optional[str] = None, context: Optional[dict] = None) -> dict:
    parts = []
    if image_base64:
        parts.append(types.Part.from_bytes(data=base64.b64decode(image_base64), mime_type="image/jpeg"))
    parts.append(types.Part.from_text(text=build_user_message(instruction, context)))

    response = _client.models.generate_content(
        model=MODEL,
        contents=[types.Content(role="user", parts=parts)],
        config=types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            response_mime_type="application/json",
        ),
    )

    # response.text is Optional[str] - Gemini returns None if it produced no
    # text (e.g. the response was blocked). Guard it so json.loads never gets
    # None, and so the type checker is satisfied.
    raw = response.text
    if not raw:
        raise RuntimeError("Gemini returned an empty response (possibly blocked or filtered)")
    return json.loads(raw)


def _to_gemini_contents(messages: List[dict], image_base64: Optional[str], context: Optional[dict]) -> list:
    """Maps chat messages to Gemini contents (assistant -> 'model'), attaching
    the image + layer context to the most recent user turn."""
    last_user = max((i for i, m in enumerate(messages) if m["role"] == "user"), default=-1)
    contents = []
    for i, m in enumerate(messages):
        role = "model" if m["role"] == "assistant" else "user"
        text = m["content"]
        parts = []
        if i == last_user:
            text = augment_user_text(text, context)
            if image_base64:
                parts.append(types.Part.from_bytes(data=base64.b64decode(image_base64), mime_type="image/jpeg"))
        parts.append(types.Part.from_text(text=text))
        contents.append(types.Content(role=role, parts=parts))
    return contents


def chat(messages: List[dict], image_base64: Optional[str] = None, context: Optional[dict] = None) -> str:
    response = _client.models.generate_content(
        model=MODEL,
        contents=_to_gemini_contents(messages, image_base64, context),
        config=types.GenerateContentConfig(
            system_instruction=CHAT_SYSTEM_PROMPT,
            thinking_config=types.ThinkingConfig(thinking_budget=THINKING_BUDGET),
        ),
    )
    raw = response.text
    if not raw:
        raise RuntimeError("Gemini returned an empty response (possibly blocked or filtered)")
    return raw
