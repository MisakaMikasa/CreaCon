const { core } = require("photoshop");
const { log, error, formatError } = require("../log");
const { createAdjustmentLayer, updateAdjustmentLayer } = require("./adjustmentLayer");
const { renameLayer } = require("./renameLayer");
const { setLayerOpacity } = require("./opacity");
const { createGroup } = require("./group");
const { addMask } = require("./mask");
const { setBlendMode } = require("./setBlendMode");
const { applyCameraRaw } = require("./cameraRaw");

const HANDLERS = {
  createAdjustmentLayer,
  updateAdjustmentLayer,
  renameLayer,
  setLayerOpacity,
  createGroup,
  addMask,
  setBlendMode,
  applyCameraRaw,
};

// Stagger steps so the user can watch each layer/mask appear one at a time,
// rather than everything popping into the Layers panel instantly.
const STEP_DELAY_MS = 400;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Each applyCameraRaw carries the COMPLETE develop state (the full-state rule),
// so when a plan has several targeting the SAME raw layer - e.g. the model
// builds the edit up mask-by-mask, emitting a cumulative full state each time -
// only the LAST one matters. The earlier ones produce identical intermediate
// results but each triggers its own sidecar rewrite + ACR relink, and every
// relink reopens the Camera Raw dialog for a manual OK. Drop the superseded
// ones so a multi-mask raw edit applies in a single reload (one dialog, not N).
function coalesceCameraRawSteps(steps) {
  const lastIndexByTarget = new Map();
  steps.forEach((step, i) => {
    if (step.op !== "applyCameraRaw") return;
    const key = (step.params && step.params.targetLayer) || "__single_raw__";
    lastIndexByTarget.set(key, i);
  });
  return steps.filter((step, i) => {
    if (step.op !== "applyCameraRaw") return true;
    const key = (step.params && step.params.targetLayer) || "__single_raw__";
    return lastIndexByTarget.get(key) === i;
  });
}

// Runs every step inside a single executeAsModal call so the whole AI edit
// collapses into one named History Log entry - one Ctrl/Cmd+Z undoes it all,
// while the created layers/masks remain fully editable afterward.
async function applyEditPlan(plan, onStepComplete) {
  const steps = coalesceCameraRawSteps(plan.steps);
  if (steps.length < plan.steps.length) {
    log(
      `Coalesced ${plan.steps.length - steps.length} superseded applyCameraRaw step(s); ` +
        "applying the final develop state in a single reload."
    );
  }
  await core.executeAsModal(
    async () => {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const handler = HANDLERS[step.op];
        if (!handler) {
          throw new Error(`No executor registered for op "${step.op}"`);
        }
        log(`Executing step ${i}: ${step.op}`, step.params);
        try {
          await handler(step.params);
        } catch (err) {
          // Re-throw with step context so the panel shows which step broke.
          error(`Step ${i} (${step.op}) failed:`, err);
          throw new Error(`Step ${i} (${step.op}): ${formatError(err)}`);
        }
        if (onStepComplete) onStepComplete(i, step);
        await sleep(STEP_DELAY_MS);
      }
    },
    { commandName: plan.summary || "AI Edit" }
  );
}

module.exports = { applyEditPlan };
