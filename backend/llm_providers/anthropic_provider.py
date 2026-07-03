import os
from typing import List, Optional

import anthropic

from prompt import CHAT_SYSTEM_PROMPT, SYSTEM_PROMPT, augment_user_text, build_user_message
from schema_tool import EDIT_PLAN_TOOL

MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-opus-4-8")

# Resolves credentials from ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / an
# `ant auth login` profile - never hardcode a key here.
_client = anthropic.Anthropic()


def request_edit_plan(instruction: str, image_base64: Optional[str] = None, context: Optional[dict] = None) -> dict:
    content: list = []
    if image_base64:
        content.append(
            {
                "type": "image",
                "source": {"type": "base64", "media_type": "image/jpeg", "data": image_base64},
            }
        )
    content.append({"type": "text", "text": build_user_message(instruction, context)})

    response = _client.messages.create(
        model=MODEL,
        max_tokens=2048,
        system=SYSTEM_PROMPT,
        tools=[EDIT_PLAN_TOOL],
        tool_choice={"type": "tool", "name": "submit_edit_plan"},
        messages=[{"role": "user", "content": content}],
    )

    for block in response.content:
        if block.type == "tool_use" and block.name == "submit_edit_plan":
            return block.input

    raise RuntimeError("Model did not return a submit_edit_plan tool call")


def _to_anthropic_messages(messages: List[dict], image_base64: Optional[str], context: Optional[dict]) -> list:
    """Maps chat messages to Anthropic format, attaching the image + layer
    context to the most recent user turn."""
    last_user = max((i for i, m in enumerate(messages) if m["role"] == "user"), default=-1)
    out = []
    for i, m in enumerate(messages):
        text = m["content"]
        if i == last_user:
            text = augment_user_text(text, context)
            if image_base64:
                out.append(
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "image",
                                "source": {"type": "base64", "media_type": "image/jpeg", "data": image_base64},
                            },
                            {"type": "text", "text": text},
                        ],
                    }
                )
                continue
        out.append({"role": m["role"], "content": text})
    return out


def chat(messages: List[dict], image_base64: Optional[str] = None, context: Optional[dict] = None) -> str:
    response = _client.messages.create(
        model=MODEL,
        max_tokens=2048,
        system=CHAT_SYSTEM_PROMPT,
        output_config={"effort": "low"},
        messages=_to_anthropic_messages(messages, image_base64, context),
    )
    return "".join(block.text for block in response.content if block.type == "text")
