import os
from typing import Optional

import anthropic

from prompt import SYSTEM_PROMPT, build_user_message
from schema_tool import EDIT_PLAN_TOOL

MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-opus-4-8")

# Resolves credentials from ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / an
# `ant auth login` profile - never hardcode a key here.
_client = anthropic.Anthropic()


def request_edit_plan(instruction: str, image_base64: Optional[str] = None, layer_names=None) -> dict:
    content: list = []
    if image_base64:
        content.append(
            {
                "type": "image",
                "source": {"type": "base64", "media_type": "image/jpeg", "data": image_base64},
            }
        )
    content.append({"type": "text", "text": build_user_message(instruction, layer_names)})

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
