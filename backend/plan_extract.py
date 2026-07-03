import json
import re

from jsonschema import ValidationError

from validator import validate_edit_plan

# Matches the first ```json ... ``` fenced block in the assistant's reply.
_BLOCK = re.compile(r"```json\s*(.*?)```", re.DOTALL)


def extract_plan(reply_text: str):
    """Splits a chat reply into (display_text, edit_plan_or_None).

    The model proposes edits as a fenced ```json block. If a valid plan is
    found, it's parsed + schema-validated and stripped from the display text.
    A missing or malformed/invalid block yields (original_text, None) - we
    treat it as pure conversation rather than surfacing broken JSON.
    """
    match = _BLOCK.search(reply_text)
    if not match:
        return reply_text, None

    try:
        plan = json.loads(match.group(1))
        validate_edit_plan(plan)
    except (json.JSONDecodeError, ValidationError):
        return reply_text, None

    display = _BLOCK.sub("", reply_text).strip()
    if not display:
        display = plan.get("summary", "Here's the edit I'd apply:")
    return display, plan
