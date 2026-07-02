import json
from pathlib import Path

from jsonschema import validate

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schema" / "editPlan.schema.json"
_schema = json.loads(SCHEMA_PATH.read_text())


def validate_edit_plan(plan: dict) -> None:
    """Raises jsonschema.ValidationError if the plan doesn't match editPlan.schema.json."""
    validate(instance=plan, schema=_schema)
