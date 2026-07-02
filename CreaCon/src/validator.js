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
  const requiredParams = clause.then.properties.params.required;
  ALLOWED_OPS[op] = requiredParams;
});

function validateEditPlan(plan) {
  const errors = [];

  if (!plan || typeof plan !== "object") {
    return { valid: false, errors: ["Plan must be an object"] };
  }
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    return { valid: false, errors: ["Plan must contain a non-empty 'steps' array"] };
  }

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
  });

  return { valid: errors.length === 0, errors };
}

module.exports = { validateEditPlan, ALLOWED_OPS };
