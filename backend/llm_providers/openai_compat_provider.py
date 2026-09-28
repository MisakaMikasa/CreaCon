"""Any OpenAI-compatible endpoint: OpenRouter, LiteLLM, a self-hosted relay...

These proxies do not speak Gemini's own protocol - they expose OpenAI's
/chat/completions shape and translate to the upstream model themselves. So
this is a separate provider, not a base_url on the Gemini one (for a proxy that
DOES speak Gemini's protocol, set gemini_base_url instead).

Plain httpx rather than the openai SDK: it is one POST, httpx already ships
with google-genai and anthropic, and it keeps the installer free of another
package PyInstaller would need telling about.
"""

import base64
import json
import os
import re
from typing import List, Optional

import httpx

import config
from prompt import (
    CHAT_SYSTEM_PROMPT,
    SYSTEM_PROMPT,
    augment_user_text,
    build_user_message,
)

BASE_URL = str(config.get("openai_compat_base_url", "https://openrouter.ai/api/v1")).rstrip("/")
# OpenRouter names models "<vendor>/<model>". Check the exact slug on
# openrouter.ai/models - it is what the proxy routes on, not Google's id.
MODEL = config.get("openai_compat_model", "google/gemini-3.8-flash")
API_KEY = config.get("openai_compat_api_key")
TIMEOUT = float(os.environ.get("OPENAI_COMPAT_TIMEOUT", "180"))

# `reasoning` is an OpenRouter extension. A stricter OpenAI-compatible server
# may reject unknown fields, so it is only sent where it is known to be understood.
_IS_OPENROUTER = "openrouter.ai" in BASE_URL

_client = httpx.Client(timeout=TIMEOUT)


def _image_part(image_bytes: bytes) -> dict:
    b64 = base64.b64encode(image_bytes).decode("ascii")
    return {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}}


def complete(messages: list, json_mode: bool = False, max_tokens: Optional[int] = None,
             reasoning_tokens: Optional[int] = None) -> str:
    """One /chat/completions call; returns the reply text.

    reasoning_tokens mirrors Gemini's thinking_budget (0 = off). Ignored off OpenRouter.
    """
    if not API_KEY:
        raise RuntimeError("No API key set for the OpenAI-compatible provider (openai_compat_api_key)")

    body: dict = {"model": MODEL, "messages": messages}
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    if max_tokens:
        body["max_tokens"] = max_tokens
    if _IS_OPENROUTER and reasoning_tokens is not None:
        body["reasoning"] = {"enabled": False} if reasoning_tokens == 0 else {"max_tokens": reasoning_tokens}

    headers = {"Authorization": f"Bearer {API_KEY}"}
    if _IS_OPENROUTER:
        headers["X-Title"] = "CreaCon"  # shows in the user's OpenRouter activity log

    resp = _client.post(f"{BASE_URL}/chat/completions", json=body, headers=headers)
    if resp.status_code >= 400:
        # Keep the status code in the message: main.py maps "429" to a rate-limit reply.
        raise RuntimeError(f"{resp.status_code} from {BASE_URL}: {resp.text[:300]}")
    data = resp.json()
    # OpenRouter reports upstream failures as 200 + an "error" object.
    if data.get("error"):
        err = data["error"]
        raise RuntimeError(f"{err.get('code', '')} {err.get('message', err)}".strip())

    choices = data.get("choices") or []
    text = (choices[0].get("message") or {}).get("content") if choices else None
    if not text:
        raise RuntimeError("The model returned an empty response (possibly blocked or filtered)")
    return text


def _parse_json(raw: str):
    # json_object mode is a request, not a guarantee through every proxy/model.
    fenced = re.search(r"```(?:json)?\s*(.*?)```", raw, re.S)
    return json.loads(fenced.group(1) if fenced else raw)


def request_edit_plan(instruction: str, image_base64: Optional[str] = None, context: Optional[dict] = None) -> dict:
    content: list = []
    if image_base64:
        content.append(_image_part(base64.b64decode(image_base64)))
    content.append({"type": "text", "text": build_user_message(instruction, context)})

    raw = complete(
        [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": content}],
        json_mode=True,
    )
    return _parse_json(raw)


def chat(messages: List[dict], image_base64: Optional[str] = None, context: Optional[dict] = None) -> str:
    last_user = max((i for i, m in enumerate(messages) if m["role"] == "user"), default=-1)
    out: list = [{"role": "system", "content": CHAT_SYSTEM_PROMPT}]
    for i, m in enumerate(messages):
        text = m["content"]
        if i == last_user:
            text = augment_user_text(text, context)
            if image_base64:
                out.append({"role": "user", "content": [
                    _image_part(base64.b64decode(image_base64)),
                    {"type": "text", "text": text},
                ]})
                continue
        out.append({"role": m["role"], "content": text})

    thinking = int(os.environ.get("GEMINI_THINKING_BUDGET", "512"))
    return complete(out, reasoning_tokens=thinking)


def segment_json(image_bytes: bytes, prompt: str, max_tokens: int) -> str:
    """segment.py's call: image + prompt -> raw JSON text, thinking off.

    No json_mode: segmentation answers with a JSON *list*, and strict OpenAI
    json_object mode only allows an object. segment.py strips any fence itself."""
    return complete(
        [{"role": "user", "content": [_image_part(image_bytes), {"type": "text", "text": prompt}]}],
        max_tokens=max_tokens,
        reasoning_tokens=0,
    )
