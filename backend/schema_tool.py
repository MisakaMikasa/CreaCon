import json
from pathlib import Path

from paths import resource

from anthropic.types import ToolParam

SCHEMA_PATH = resource("schema", "editPlan.schema.json")
_schema = json.loads(SCHEMA_PATH.read_text())

# Reuse the same schema as the tool's input_schema so the LLM, the backend
# validator, and the plugin's structural check all derive from one file.
# Typed as ToolParam so it matches the SDK's expected `tools=[...]` shape.
EDIT_PLAN_TOOL: ToolParam = {
    "name": "submit_edit_plan",
    "description": "Submit the structured Photoshop edit plan.",
    "input_schema": _schema,
}
