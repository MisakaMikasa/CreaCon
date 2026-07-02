import json
from pathlib import Path

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schema" / "editPlan.schema.json"
_schema = json.loads(SCHEMA_PATH.read_text())

# Reuse the same schema as the tool's input_schema so the LLM, the backend
# validator, and the plugin's structural check all derive from one file.
EDIT_PLAN_TOOL = {
    "name": "submit_edit_plan",
    "description": "Submit the structured Photoshop edit plan.",
    "input_schema": _schema,
}
