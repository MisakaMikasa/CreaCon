import logging
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from jsonschema import ValidationError
from pydantic import BaseModel

from llm_client import request_edit_plan
from validator import validate_edit_plan

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("creacon")

app = FastAPI(title="CreaCon AI Backend")

# Permissive CORS for local UXP development. Tighten this before shipping.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST"],
    allow_headers=["*"],
)


class EditPlanRequest(BaseModel):
    instruction: str
    image_base64: Optional[str] = None
    layer_names: Optional[List[str]] = None


@app.post("/edit-plan")
def edit_plan(req: EditPlanRequest):
    if not req.instruction.strip():
        raise HTTPException(400, "instruction must not be empty")

    plan = request_edit_plan(req.instruction, req.image_base64, req.layer_names)

    # `summary` is required by the schema but is only a cosmetic label (shown
    # before Apply, and used as the undo name). Gemini occasionally omits it -
    # don't reject an otherwise-valid plan over a missing label.
    if isinstance(plan, dict) and not plan.get("summary"):
        plan["summary"] = "AI Edit"

    try:
        validate_edit_plan(plan)
    except ValidationError as exc:
        logger.warning("LLM returned a plan that failed schema validation: %s", exc.message)
        raise HTTPException(502, f"AI returned an invalid edit plan: {exc.message}")

    return plan
