const { sendChat } = require("./aiClient");
const { validateEditPlan } = require("./validator");
const { applyEditPlan } = require("./executor/index");
const { openRawAsSmartObject } = require("./executor/cameraRaw");
const { log, error, formatError } = require("./log");

// Each entry: { role: "user"|"assistant"|"system"|"error", text, plan?, planStatus?, thinking? }
// role drives bubble styling; plan (if present) renders an Apply/Cancel card.
const conversation = [];
let busy = false;

// JS-driven "Thinking…" animation (UXP doesn't reliably animate CSS ::after).
let thinkingTimer = null;
let thinkingDots = 0;

function startThinking() {
  thinkingDots = 0;
  stopThinking();
  thinkingTimer = setInterval(() => {
    thinkingDots = (thinkingDots + 1) % 4;
    render();
  }, 400);
}

function stopThinking() {
  if (thinkingTimer) {
    clearInterval(thinkingTimer);
    thinkingTimer = null;
  }
}

function el(id) {
  return document.getElementById(id);
}

// Only user/assistant turns are real conversation for the model. "system" notes
// (e.g. "Applied ...") are sent as user "[note] ..." so the model knows the
// document changed; thinking placeholders and errors are display-only.
function conversationForApi() {
  return conversation
    .filter((m) => !m.thinking && m.role !== "error")
    .map((m) =>
      m.role === "system"
        ? { role: "user", content: `[note] ${m.text}` }
        : { role: m.role, content: m.text }
    );
}

function buildPlanCard(msg, idx) {
  const card = document.createElement("div");
  card.className = "plan-card";

  const ul = document.createElement("ul");
  msg.plan.steps.forEach((step) => {
    const li = document.createElement("li");
    li.textContent = step.description;
    ul.appendChild(li);
  });
  card.appendChild(ul);

  if (msg.planStatus === "applied" || msg.planStatus === "cancelled") {
    const status = document.createElement("div");
    status.className = "plan-status";
    status.textContent = msg.planStatus === "applied" ? "✓ Applied" : "Cancelled";
    card.appendChild(status);
    return card;
  }

  const actions = document.createElement("div");
  actions.className = "plan-actions";

  const applyBtn = document.createElement("sp-button");
  applyBtn.setAttribute("variant", "cta");
  applyBtn.textContent = msg.planStatus === "applying" ? "Applying…" : "Apply";
  if (msg.planStatus === "applying") applyBtn.setAttribute("disabled", "true");
  applyBtn.addEventListener("click", () => onApply(idx));

  const cancelBtn = document.createElement("sp-button");
  cancelBtn.setAttribute("variant", "secondary");
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => onCancel(idx));

  actions.appendChild(applyBtn);
  actions.appendChild(cancelBtn);
  card.appendChild(actions);
  return card;
}

function render() {
  const container = el("messages");
  container.innerHTML = "";

  conversation.forEach((msg, idx) => {
    const roleClass = msg.thinking ? "assistant" : msg.role;

    const row = document.createElement("div");
    row.className = `row row-${roleClass}`;

    const bubble = document.createElement("div");
    if (msg.thinking) {
      bubble.className = "bubble bubble-thinking";
      bubble.textContent = "Thinking" + ".".repeat(thinkingDots);
    } else {
      bubble.className = `bubble bubble-${msg.role}`;
      bubble.textContent = msg.text;
    }
    row.appendChild(bubble);
    container.appendChild(row);

    if (msg.plan) {
      container.appendChild(buildPlanCard(msg, idx));
    }
  });

  container.scrollTop = container.scrollHeight;
}

async function onSend() {
  const input = el("chatInput");
  const text = (input.value || "").trim();
  if (!text || busy) return;

  input.value = "";
  conversation.push({ role: "user", text });
  const thinkingMsg = { role: "assistant", text: "", thinking: true };
  conversation.push(thinkingMsg);
  busy = true;
  startThinking();
  render();

  try {
    const apiMessages = conversationForApi();
    log("Sending chat,", apiMessages.length, "messages");
    const { reply, edit_plan } = await sendChat(apiMessages);
    log("Reply:", reply, "| plan:", edit_plan ? `${edit_plan.steps.length} steps` : "none");

    removeMessage(thinkingMsg);
    conversation.push({
      role: "assistant",
      text: reply || "(no reply)",
      plan: edit_plan || null,
    });
  } catch (err) {
    error("Chat failed:", err);
    removeMessage(thinkingMsg);
    conversation.push({ role: "error", text: `Error: ${formatError(err)}` });
  } finally {
    busy = false;
    stopThinking();
    render();
  }
}

async function onApply(idx) {
  const msg = conversation[idx];
  if (!msg || !msg.plan || msg.planStatus) return;

  const { valid, errors } = validateEditPlan(msg.plan);
  if (!valid) {
    conversation.push({ role: "error", text: `Plan failed validation: ${errors.join("; ")}` });
    render();
    return;
  }

  msg.planStatus = "applying";
  render();

  try {
    await applyEditPlan(msg.plan, (i, step) => log(`Step ${i} done:`, step.op));
    msg.planStatus = "applied";
    conversation.push({ role: "system", text: `Applied: ${msg.plan.summary || "the edit"}` });
    // ACR loads AI mask *parameters* headlessly but may not run the actual
    // segmentation until nudged (the "Update AI settings" affordance) - warn
    // the user so an unchanged region isn't mistaken for a failed edit.
    const usesAiMask = msg.plan.steps.some(
      (s) =>
        s.op === "applyCameraRaw" &&
        (s.params.settings.MaskGroupBasedCorrections || []).some((c) =>
          (c.CorrectionMasks || []).some((m) => m.What === "Mask/Image")
        )
    );
    if (usesAiMask) {
      conversation.push({
        role: "system",
        text:
          "Note: this edit uses AI masks (sky/subject/person). If the masked region looks " +
          "unchanged, click \"Update AI settings\" when Photoshop offers it (or open the " +
          "layer in Camera Raw once) so the selection is computed.",
      });
    }
  } catch (err) {
    error("Apply failed:", err);
    msg.planStatus = undefined; // allow retry
    conversation.push({ role: "error", text: `Error applying edit: ${formatError(err)}` });
  } finally {
    render();
  }
}

// Modal choice shown when an imported raw already has develop settings.
// Resolves to "keep" | "fresh" | "cancel" (ESC = cancel).
async function askImportChoice(fileName) {
  const dialog = document.createElement("dialog");

  const wrap = document.createElement("div");
  wrap.style.padding = "16px";
  wrap.style.maxWidth = "380px";

  const heading = document.createElement("h3");
  heading.textContent = "Existing edits found";
  const body = document.createElement("p");
  body.textContent =
    `"${fileName}" already has Camera Raw develop settings ` +
    "(from an earlier CreaCon layer, Lightroom, or manual Camera Raw edits).";
  const tip = document.createElement("p");
  tip.style.opacity = "0.7";
  tip.textContent =
    "Tip: a raw file holds ONE set of edits. To grade the same photo two different " +
    "ways, duplicate the raw file on disk and import the copy.";

  const footer = document.createElement("div");
  footer.style.display = "flex";
  footer.style.gap = "8px";
  footer.style.justifyContent = "flex-end";
  const mkButton = (label, variant, value) => {
    const btn = document.createElement("sp-button");
    btn.setAttribute("variant", variant);
    btn.textContent = label;
    btn.addEventListener("click", () => dialog.close(value));
    return btn;
  };
  footer.appendChild(mkButton("Cancel", "secondary", "cancel"));
  footer.appendChild(mkButton("Keep existing edits", "secondary", "keep"));
  footer.appendChild(mkButton("Start fresh", "cta", "fresh"));

  wrap.appendChild(heading);
  wrap.appendChild(body);
  wrap.appendChild(tip);
  wrap.appendChild(footer);
  dialog.appendChild(wrap);
  document.body.appendChild(dialog);

  // UXP's dialog.showModal() returns a promise resolving when closed;
  // returnValue is whatever close() was given ("" on ESC).
  const result = await dialog.showModal();
  dialog.remove();
  return result === "keep" || result === "fresh" ? result : "cancel";
}

// Places a user-picked raw file as a smart object and registers its path so
// chat plans can develop it via applyCameraRaw (sidecar + re-import). This is
// the REQUIRED entry point for raw editing: smart objects created outside
// CreaCon have no recoverable file path (see rawRegistry.js).
async function onOpenRaw() {
  if (busy) return;
  busy = true;
  render();
  try {
    const layerName = await openRawAsSmartObject((text) => {
      conversation.push({ role: "system", text });
      render();
    }, askImportChoice);
    if (layerName) {
      conversation.push({
        role: "system",
        text:
          `Opened RAW as smart object layer "${layerName}". ` +
          "Ask for develop edits - exposure, white balance, dehaze, color…",
      });
    }
  } catch (err) {
    error("Open RAW failed:", err);
    conversation.push({ role: "error", text: `Open RAW failed: ${formatError(err)}` });
  } finally {
    busy = false;
    render();
  }
}

function onCancel(idx) {
  const msg = conversation[idx];
  if (msg) msg.planStatus = "cancelled";
  render();
}

function removeMessage(msg) {
  const i = conversation.indexOf(msg);
  if (i !== -1) conversation.splice(i, 1);
}

function setup() {
  el("btnSend").addEventListener("click", onSend);
  el("btnOpenRaw").addEventListener("click", onOpenRaw);
  el("chatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  });
  log("Panel ready");
}

module.exports = { setup };
