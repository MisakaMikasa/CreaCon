const { sendChat, runAcrAutoAccept } = require("./aiClient");
const { validateEditPlan } = require("./validator");
const { applyEditPlan } = require("./executor/index");
const { openRawAsSmartObject, openInAcrDialog } = require("./executor/cameraRaw");
const { log, error, formatError } = require("./log");

// Each entry: { role: "user"|"assistant"|"system"|"error", text, plan?, planStatus?,
// thinking?, selfCheck? } - role drives bubble styling; plan (if present) renders an
// Apply/Cancel card; selfCheck tags the automated review turn (loop guard).
const conversation = [];
let busy = false;
// Self-check trial toggle (🔁): after an apply, auto-accept AI masks in ACR
// and send the rendered result back to the agent for verification.
let selfCheckEnabled = false;

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

// "auto" = no aggressiveness guidance sent (the default behavior).
function currentAggressiveness() {
  const intensity = el("intensitySelect").value;
  return intensity === "auto" ? null : Number(intensity);
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
    log("Sending chat,", apiMessages.length, "messages, intensity:", el("intensitySelect").value);
    const { reply, edit_plan } = await sendChat(apiMessages, {
      aggressiveness: currentAggressiveness(),
    });
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

// Shared apply core: validate -> execute -> status. Used by the user-gated
// Apply button AND the self-check's auto-applied correction, so both paths
// behave identically (same validation, same "Applied: …" note, same errors).
// Returns whether it applied AND whether any applyCameraRaw step reported a
// genuinely uncomputed AI mask (see cameraRaw.hasUncomputedAiMasks) - NOT
// merely "the plan contains a mask", so a follow-up apply that only tweaks an
// already-computed mask's values doesn't needlessly reopen Camera Raw.
async function executeApply(msg) {
  const { valid, errors } = validateEditPlan(msg.plan);
  if (!valid) {
    conversation.push({ role: "error", text: `Plan failed validation: ${errors.join("; ")}` });
    render();
    return { applied: false, needsAiMaskCompute: false };
  }
  msg.planStatus = "applying";
  render();
  let needsAiMaskCompute = false;
  try {
    await applyEditPlan(msg.plan, (i, step, result) => {
      log(`Step ${i} done:`, step.op);
      if (result && result.needsAiMaskCompute) needsAiMaskCompute = true;
    });
    msg.planStatus = "applied";
    conversation.push({ role: "system", text: `Applied: ${msg.plan.summary || "the edit"}` });
    return { applied: true, needsAiMaskCompute };
  } catch (err) {
    error("Apply failed:", err);
    msg.planStatus = undefined; // allow retry
    conversation.push({ role: "error", text: `Error applying edit: ${formatError(err)}` });
    return { applied: false, needsAiMaskCompute: false };
  } finally {
    render();
  }
}

// Runs the ACR "Update AI settings" dialog concurrently with the backend's
// keyboard-automation worker (which sends Ctrl+Shift+U then Enter once inside
// it), and reports honestly based on the backend's confirmed result rather
// than assuming success.
async function autoAcceptAiMasks(plan) {
  const acrStep = plan.steps.find((s) => s.op === "applyCameraRaw");
  conversation.push({
    role: "system",
    text: "Computing AI masks in Camera Raw (auto-accept)… please leave keyboard/mouse alone briefly.",
  });
  render();
  try {
    // Both must start together: opening the dialog and the backend's key
    // automation race against the same clock (see aiClient.runAcrAutoAccept).
    const [, acceptResult] = await Promise.all([
      openInAcrDialog(acrStep && acrStep.params.targetLayer),
      runAcrAutoAccept(),
    ]);
    // Full diagnostic fields, not just the verdict - so a failure is
    // reportable/diagnosable from the chat alone, no backend terminal needed.
    log("Auto-accept result:", acceptResult);
    conversation.push({
      role: "system",
      text:
        (acceptResult.confirmed_closed
          ? "AI masks updated automatically."
          : "Could not confirm Camera Raw closed automatically - if the masked region still " +
            "looks unchanged, open the layer in Camera Raw once and click \"Update AI " +
            "settings\".") +
        ` [diagnostic: window_seen=${acceptResult.window_seen}, ` +
        `sent_hotkey=${acceptResult.sent_hotkey}, sent_enter=${acceptResult.sent_enter}]`,
    });
    return acceptResult.confirmed_closed;
  } catch (err) {
    error("Auto-accept failed:", err);
    conversation.push({
      role: "error",
      text:
        `AI-mask auto-accept failed (${formatError(err)}) - open the layer in Camera Raw ` +
        "and click \"Update AI settings\" if the masked region looks unchanged.",
    });
    return false;
  } finally {
    render();
  }
}

async function onApply(idx) {
  const msg = conversation[idx];
  if (!msg || !msg.plan || msg.planStatus) return;

  const { applied, needsAiMaskCompute } = await executeApply(msg);
  if (!applied) return;

  if (selfCheckEnabled) {
    let aiComputeConfirmed = true;
    if (needsAiMaskCompute) aiComputeConfirmed = await autoAcceptAiMasks(msg.plan);
    await runSelfCheckFlow(aiComputeConfirmed);
  } else if (needsAiMaskCompute) {
    conversation.push({
      role: "system",
      text:
        "Note: this edit uses AI masks (sky/subject/person). If the masked region looks " +
        "unchanged, click \"Update AI settings\" when Photoshop offers it (or open the " +
        "layer in Camera Raw once) so the selection is computed.",
    });
    render();
  }
}

// Self-check trial (🔁): sends the freshly rendered snapshot back to the agent
// to verify the result against the request and the intensity level. Any
// correction it proposes is applied IMMEDIATELY (no Apply click) - the one
// deliberate exception to the app's apply-gate, scoped to this opt-in toggle
// and capped at exactly one round: this function is never called again for
// whatever it applies (no recursion), so at most one correction ever happens
// per user-initiated apply.
async function runSelfCheckFlow(aiComputeConfirmed) {
  conversation.push({
    role: "user",
    text:
      "[Self-check] The plan was applied; the attached preview is the CURRENT rendered " +
      "result. Verify it against my original request AND the edit-intensity level in " +
      "effect, including its hard limits. If both are satisfied, reply in one short " +
      "sentence with no plan. If something clearly misses, propose ONE corrective plan." +
      (aiComputeConfirmed
        ? ""
        : " NOTE: AI-mask computation could not be confirmed - the preview may not yet " +
          "reflect a masked region; if a masked area looks unnaturally unchanged rather " +
          "than clearly wrong, say so instead of guessing."),
  });
  const thinkingMsg = { role: "assistant", text: "", thinking: true };
  conversation.push(thinkingMsg);
  busy = true;
  startThinking();
  render();

  let reply, edit_plan;
  try {
    ({ reply, edit_plan } = await sendChat(conversationForApi(), {
      aggressiveness: currentAggressiveness(),
    }));
  } catch (err) {
    error("Self-check failed:", err);
    removeMessage(thinkingMsg);
    conversation.push({ role: "error", text: `Self-check failed: ${formatError(err)}` });
    busy = false;
    stopThinking();
    render();
    return;
  }
  removeMessage(thinkingMsg);
  busy = false;
  stopThinking();

  const correctionMsg = { role: "assistant", text: reply || "(no reply)", plan: edit_plan || null };
  conversation.push(correctionMsg);
  render();
  if (!edit_plan) return; // agent confirmed the result - nothing to apply

  // sets planStatus -> renders as a read-only card (no Apply/Cancel - see doc comment above)
  const result = await executeApply(correctionMsg);
  if (result.applied && result.needsAiMaskCompute) {
    await autoAcceptAiMasks(edit_plan); // no further self-check round - see doc comment above
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
  el("btnSelfCheck").addEventListener("click", () => {
    selfCheckEnabled = !selfCheckEnabled;
    el("btnSelfCheck").setAttribute("variant", selfCheckEnabled ? "cta" : "secondary");
    conversation.push({
      role: "system",
      text: selfCheckEnabled
        ? "Self-check ON: after each apply, AI masks are auto-accepted in Camera Raw and " +
          "the agent reviews the rendered result (one refinement proposal max, still gated " +
          "by Apply)."
        : "Self-check OFF.",
    });
    render();
  });
  el("chatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  });
  log("Panel ready");
}

module.exports = { setup };
