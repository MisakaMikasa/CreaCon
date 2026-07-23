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

// Runs every step inside a single executeAsModal call so the whole AI edit
// collapses into one named History Log entry - one Ctrl/Cmd+Z undoes it all,
// while the created layers/masks remain fully editable afterward. Returns the
// array of each step's handler return value (most handlers return undefined;
// applyCameraRaw returns { needsAiMaskCompute, targetLayer } so callers can
// decide whether AI-mask compute is actually needed - see cameraRaw.js).
async function applyEditPlan(plan, onStepComplete) {
  return core.executeAsModal(
    async () => {
      const results = [];
      for (let i = 0; i < plan.steps.length; i++) {
        const step = plan.steps[i];
        const handler = HANDLERS[step.op];
        if (!handler) {
          throw new Error(`No executor registered for op "${step.op}"`);
        }
        log(`Executing step ${i}: ${step.op}`, step.params);
        let result;
        try {
          result = await handler(step.params);
        } catch (err) {
          // Re-throw with step context so the panel shows which step broke.
          error(`Step ${i} (${step.op}) failed:`, err);
          throw new Error(`Step ${i} (${step.op}): ${formatError(err)}`);
        }
        results.push(result);
        if (onStepComplete) onStepComplete(i, step, result);
        await sleep(STEP_DELAY_MS);
      }
      return results;
    },
    { commandName: plan.summary || "AI Edit" }
  );
}

module.exports = { applyEditPlan };
