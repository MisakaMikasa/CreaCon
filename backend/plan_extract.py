import json
import re

from jsonschema import ValidationError

from validator import validate_edit_plan

# A properly closed ```json ... ``` fenced block.
_FENCED = re.compile(r"```json\s*(.*?)```", re.DOTALL)


def extract_plan(reply_text: str):
    """Splits a chat reply into (display_text, edit_plan_or_None, error_or_None).

    The model proposes edits as a ```json block. Extraction is tolerant:
    1. a properly fenced ```json ... ``` block, else
    2. the outermost { ... } object (handles the common case where the model
       opens ```json but forgets/truncates the closing fence, or emits raw JSON).

    - No JSON candidate at all -> (text, None, None): plain conversation.
    - A candidate that fails to parse/validate -> (text, None, "<reason>"): the
      model *tried* to produce a plan but it's broken; `error` lets the caller
      offer one corrective retry.
    - A valid plan -> (display_without_json, plan, None).
    """
    match = _FENCED.search(reply_text)
    if match:
        candidate, span = match.group(1), match.span()
    else:
        start = reply_text.find("{")
        end = reply_text.rfind("}")
        if start == -1 or end <= start:
            return reply_text, None, None
        candidate, span = reply_text[start : end + 1], (start, end + 1)

    try:
        plan = json.loads(candidate.strip())
    except json.JSONDecodeError as exc:
        return reply_text, None, f"the JSON did not parse ({exc})"
    try:
        validate_edit_plan(plan)
    except ValidationError as exc:
        return reply_text, None, f"the plan failed schema validation: {exc.message}"

    # Strip the JSON (and any dangling fence markers) from the visible reply.
    display = (reply_text[: span[0]] + reply_text[span[1] :]).strip()
    display = display.replace("```json", "").replace("```", "").strip()
    if not display:
        display = plan.get("summary", "Here's the edit I'd apply:")
    return display, plan, None
