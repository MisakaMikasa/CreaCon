import base64
import json
import os
from typing import Optional

from google import genai
from google.genai import types

from prompt import SYSTEM_PROMPT, build_user_message

MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

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
def request_edit_plan(instruction: str, image_base64: Optional[str] = None, layer_names=None) -> dict:
    parts = []
    if image_base64:
        parts.append(types.Part.from_bytes(data=base64.b64decode(image_base64), mime_type="image/jpeg"))
    parts.append(types.Part.from_text(text=build_user_message(instruction, layer_names)))

    response = _client.models.generate_content(
        model=MODEL,
        contents=[types.Content(role="user", parts=parts)],
        config=types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            response_mime_type="application/json",
        ),
    )

    return json.loads(response.text)
