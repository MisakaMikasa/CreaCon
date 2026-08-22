// Lightweight structural validation of the edit plan the backend returned.
// This intentionally isn't a full JSON Schema validator (ajv's code-generation
// approach is risky inside UXP's sandboxed runtime) - the backend already
// validates against schema/editPlan.schema.json. This is defense-in-depth:
// a cheap second check that every op is known and its required params exist.
//
// ALLOWED_OPS is derived from the synced schema file (src/schema/editPlan.schema.json)
// rather than hand-duplicated, so there is one real source of truth for "what's a
// valid op" - run scripts/sync-schema.js after editing schema/editPlan.schema.json.
const schema = require("./schema/editPlan.schema.json");

const ALLOWED_OPS = {};
schema.definitions.step.allOf.forEach((clause) => {
  const op = clause.if.properties.op.const;
  // Some ops (applyGeometry) have no required params - every field is optional
  // on its own. Default to [] so they don't read as unknown ops below.
  ALLOWED_OPS[op] = clause.then.properties.params.required || [];
});

// Fields that each make an applyGeometry step do something. A step with none of
// them still costs a Camera Raw dialog and changes nothing.
const GEOMETRY_ACTIONS = ["rotate", "upright", "crop", "lensProfile"];

function validateEditPlan(plan) {
  const errors = [];

  if (!plan || typeof plan !== "object") {
    return { valid: false, errors: ["Plan must be an object"] };
  }
  const hasProposals = Array.isArray(plan.proposals) && plan.proposals.length > 0;
  const hasSteps = Array.isArray(plan.steps) && plan.steps.length > 0;
  // A proposals-only reply is legitimate: it offers the user crop choices to
  // pick from rather than applying anything.
  if (!hasSteps && !hasProposals) {
    return { valid: false, errors: ["Plan must contain a non-empty 'steps' or 'proposals' array"] };
  }
  if (!hasSteps) return { valid: true, errors: [] };

  plan.steps.forEach((step, i) => {
    const requiredParams = ALLOWED_OPS[step.op];
    if (!requiredParams) {
      errors.push(`Step ${i}: unknown op "${step.op}"`);
      return;
    }
    if (!step.params || typeof step.params !== "object") {
      errors.push(`Step ${i}: missing params`);
      return;
    }
    requiredParams.forEach((key) => {
      if (!(key in step.params)) {
        errors.push(`Step ${i} (${step.op}): missing required param "${key}"`);
      }
    });
    if (step.op === "setLayerOpacity") {
      const { opacity } = step.params;
      if (typeof opacity !== "number" || opacity < 0 || opacity > 100) {
        errors.push(`Step ${i}: opacity must be a number between 0 and 100`);
      }
    }
    if (step.op === "applyGeometry") {
      if (!GEOMETRY_ACTIONS.some((k) => step.params[k] !== undefined)) {
        errors.push(
          `Step ${i} (applyGeometry): needs at least one of ${GEOMETRY_ACTIONS.join(", ")}`
        );
      }
      // 'auto' upright straightens by itself, so a rotate alongside it double-
      // corrects and the refinement can't be judged until the result is visible.
      if (step.params.upright && step.params.upright !== "off" && step.params.rotate) {
        errors.push(
          `Step ${i} (applyGeometry): don't set 'rotate' together with an upright mode - ` +
            "upright straightens too. Apply upright first, then refine in a later turn."
        );
      }
    }
  });

  // Geometry and develop settings used to be rejected in the same plan. They are
  // allowed now: the executor reorders geometry last and defers the develop
  // step's reload, so masks convert against the frame the model actually saw and
  // the pair costs one Camera Raw dialog rather than two. See orderGeometryLast
  // in executor/index.js.
  return { valid: errors.length === 0, errors };
}

module.exports = { validateEditPlan, ALLOWED_OPS };
