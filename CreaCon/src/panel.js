const { requestEditPlan } = require("./aiClient");
const { validateEditPlan } = require("./validator");
const { applyEditPlan } = require("./executor/index");
const { log, error, formatError } = require("./log");

let currentPlan = null;

function els() {
  return {
    instruction: document.getElementById("instruction"),
    btnGenerate: document.getElementById("btnGenerate"),
    planPreview: document.getElementById("planPreview"),
    stepList: document.getElementById("stepList"),
    btnApply: document.getElementById("btnApply"),
    btnCancel: document.getElementById("btnCancel"),
    trace: document.getElementById("trace"),
  };
}

function renderPlanPreview(plan) {
  const { planPreview, stepList } = els();
  stepList.innerHTML = plan.steps
    .map((step) => `<li>${escapeHtml(step.description)}</li>`)
    .join("");
  planPreview.classList.remove("hidden");
}

function appendTrace(message, isError) {
  const { trace } = els();
  const line = document.createElement("div");
  line.className = isError ? "trace-error" : "trace-line";
  line.textContent = message;
  trace.appendChild(line);
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

async function onGenerate() {
  const { instruction, btnGenerate } = els();
  const text = instruction.value.trim();
  if (!text) return;

  btnGenerate.disabled = true;
  appendTrace(`You: ${text}`);
  log("Requesting edit plan for:", text);

  try {
    const plan = await requestEditPlan(text);
    log("Received plan:", plan);

    const { valid, errors } = validateEditPlan(plan);
    if (!valid) {
      error("Plan failed validation:", errors);
      appendTrace(`Plan failed validation: ${errors.join("; ")}`, true);
      return;
    }
    currentPlan = plan;
    renderPlanPreview(plan);
  } catch (err) {
    error("Generate failed:", err);
    appendTrace(`Error: ${formatError(err)}`, true);
  } finally {
    btnGenerate.disabled = false;
  }
}

async function onApply() {
  if (!currentPlan) return;
  const { planPreview, btnApply } = els();
  btnApply.disabled = true;
  log("Applying plan with", currentPlan.steps.length, "steps");

  try {
    await applyEditPlan(currentPlan, (index, step) => {
      log(`Step ${index} done:`, step.op);
      appendTrace(`✓ ${step.description}`);
    });
    log("Plan applied successfully");
  } catch (err) {
    error("Apply failed:", err);
    appendTrace(`Error applying edit: ${formatError(err)}`, true);
  } finally {
    btnApply.disabled = false;
    planPreview.classList.add("hidden");
    currentPlan = null;
  }
}

function onCancel() {
  currentPlan = null;
  els().planPreview.classList.add("hidden");
}

function setup() {
  const { btnGenerate, btnApply, btnCancel } = els();
  btnGenerate.addEventListener("click", onGenerate);
  btnApply.addEventListener("click", onApply);
  btnCancel.addEventListener("click", onCancel);
  log("Panel ready");
}

module.exports = { setup };
