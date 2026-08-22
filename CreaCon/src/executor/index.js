const { core } = require("photoshop");
const { log, error, formatError } = require("../log");
const { createAdjustmentLayer, updateAdjustmentLayer } = require("./adjustmentLayer");
const { renameLayer } = require("./renameLayer");
const { setLayerOpacity } = require("./opacity");
const { createGroup } = require("./group");
const { addMask } = require("./mask");
const { setBlendMode } = require("./setBlendMode");
const { applyCameraRaw } = require("./cameraRaw");
const { applyGeometry } = require("./geometry");

const HANDLERS = {
  createAdjustmentLayer,
  updateAdjustmentLayer,
  renameLayer,
  setLayerOpacity,
  createGroup,
  addMask,
  setBlendMode,
  applyCameraRaw,
  applyGeometry,
};

// Stagger steps so the user can watch each layer/mask appear one at a time,
// rather than everything popping into the Layers panel instantly. Applied
// BETWEEN steps only - see the note at the call site. Every millisecond here is
// a millisecond the plugin panel is frozen, so keep it small.
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

const targetOf = (step) => (step.params && step.params.targetLayer) || "__single_raw__";

// Geometry and develop settings CAN share a plan - but only in this order:
// develop first, geometry second.
//
// The model authors mask coordinates against the preview it was shown, which is
// framed by the CURRENT crop. applyCameraRaw converts them using whatever
// geometry is on disk at that moment, so it has to run while the old geometry is
// still in place. Afterwards the frame can change freely: masks are stored in
// sensor space, so they stay on the same content however the crop moves.
//
// Reversed, applyCameraRaw would convert old-preview coordinates against the NEW
// crop and every mask would land displaced - silently, with no error.
//
// Geometry only touches its own raw layer, so moving those steps to the end is
// safe for every other op in the plan.
function orderGeometryLast(steps) {
  const geometry = steps.filter((s) => s.op === "applyGeometry");
  if (!geometry.length || geometry.length === steps.length) return steps;
  return [...steps.filter((s) => s.op !== "applyGeometry"), ...geometry];
}

// When a develop step is followed by geometry on the SAME raw, the develop step
// skips its reload. applyGeometry re-reads the sidecar it just wrote, carries
// those settings into its own write, and reloads once - two writes, one relink,
// one Camera Raw dialog instead of two.
function reloadSkippableIndices(steps) {
  const geometryTargets = new Set(steps.filter((s) => s.op === "applyGeometry").map(targetOf));
  const skip = new Set();
  steps.forEach((step, i) => {
    if (step.op === "applyCameraRaw" && geometryTargets.has(targetOf(step))) skip.add(i);
  });
  return skip;
}

// Runs every step inside a single executeAsModal call so the whole AI edit
// collapses into one named History Log entry - one Ctrl/Cmd+Z undoes it all,
// while the created layers/masks remain fully editable afterward.
async function applyEditPlan(plan, onStepComplete) {
  const steps = orderGeometryLast(coalesceCameraRawSteps(plan.steps));
  if (steps.length < plan.steps.length) {
    log(
      `Coalesced ${plan.steps.length - steps.length} superseded applyCameraRaw step(s); ` +
        "applying the final develop state in a single reload."
    );
  }
  const skipReload = reloadSkippableIndices(steps);
  await core.executeAsModal(
    async () => {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const handler = HANDLERS[step.op];
        if (!handler) {
          throw new Error(`No executor registered for op "${step.op}"`);
        }
        log(`Executing step ${i}: ${step.op}`, step.params);
        let result;
        try {
          // Some handlers (applyGeometry) return a report of what the change
          // actually cost - the user consented to a correction, not to losing a
          // quarter of the frame, so it has to reach the panel.
          result = await handler(step.params, { skipReload: skipReload.has(i) });
        } catch (err) {
          // Re-throw with step context so the panel shows which step broke.
          error(`Step ${i} (${step.op}) failed:`, err);
          throw new Error(`Step ${i} (${step.op}): ${formatError(err)}`);
        }
        if (onStepComplete) onStepComplete(i, step, result);
        // BETWEEN steps only. This sleep runs inside executeAsModal, and while
        // Photoshop is modal its entire UI thread is blocked - the panel cannot
        // process a single click. A trailing sleep after the LAST step therefore
        // bought nothing and froze the panel for an extra STEP_DELAY_MS on every
        // apply, including the single-step ones that make up most of them.
        if (i < steps.length - 1) await sleep(STEP_DELAY_MS);
      }
    },
    { commandName: plan.summary || "AI Edit" }
  );
}

module.exports = { applyEditPlan };
