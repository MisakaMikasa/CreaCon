const { core } = require("photoshop");
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
//
// It updates ONLY its own bubble. It used to call render(), which wipes and
// rebuilds the whole conversation - and once previews existed that meant
// re-decoding every base64 thumbnail two and a half times a second. The panel
// got so busy that clicks on Apply were dropped for seconds at a time.
let thinkingTimer = null;
let thinkingDots = 0;
let thinkingBubble = null;

function startThinking() {
  thinkingDots = 0;
  stopThinking();
  thinkingTimer = setInterval(() => {
    thinkingDots = (thinkingDots + 1) % 4;
    if (thinkingBubble) thinkingBubble.textContent = "Thinking" + ".".repeat(thinkingDots);
    else render(); // bubble not on screen yet - one full pass to create it
  }, 400);
}

function stopThinking() {
  if (thinkingTimer) {
    clearInterval(thinkingTimer);
    thinkingTimer = null;
  }
  thinkingBubble = null;
}

function el(id) {
  return document.getElementById(id);
}

// Clicks inside the message list are handled by ONE delegated listener on the
// container, bound once in setup(), rather than by listeners attached to each
// button as it is built.
//
// render() destroys and rebuilds every row, so per-button listeners were being
// re-attached constantly - and worse, attached to sp-button elements before they
// were connected to the document, so whether a click registered depended on when
// the custom element happened to upgrade. That is what made Apply dead for the
// first few seconds after a reply.
//
// A listener on a container that never gets replaced cannot have that problem.
function tagAction(node, action, ...args) {
  node.setAttribute("data-action", action);
  node.setAttribute("data-args", JSON.stringify(args));
  return node;
}

function onMessagesClick(event) {
  // Walk UP from whatever was clicked. Do NOT rely on composedPath() alone: UXP
  // does not implement it, and its absence is not obvious because the two kinds
  // of clickable behave differently.
  //   - sp-button: shadow DOM retargets, so event.target IS the tagged element
  //     and a target-only check appears to work.
  //   - a crop proposal: a plain div wrapping an <img> and three text divs, so
  //     event.target is one of those CHILDREN and a target-only check finds
  //     nothing and silently does nothing.
  // That asymmetry is what made proposals dead while every button still worked.
  const container = el("messages");
  let node = event.target;
  while (node && node !== container) {
    const action = node.getAttribute && node.getAttribute("data-action");
    if (action) {
      let args = [];
      try {
        args = JSON.parse(node.getAttribute("data-args") || "[]");
      } catch {
        args = [];
      }
      const handler = ACTIONS[action];
      if (handler) handler(...args);
      else log("No handler for click action:", action);
      return;
    }
    node = node.parentNode;
  }
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

// An <img> for a preview, created ONCE and cached on the object that owns it.
//
// render() wipes the message list and rebuilds it on every state change. Setting
// a fresh `src="data:image/jpeg;base64,..."` each time makes the panel re-parse
// and re-decode the whole payload - and three crop thumbnails plus a rotation
// preview run to ~300 KB. With several previews in scrollback that blocked the
// UI thread long enough to swallow clicks on Apply, for a wait that grew with
// how much was on screen.
//
// Re-appending an existing node MOVES it, so the decoded image is reused.
function previewImage(holder, alt) {
  if (!holder._imgNode) {
    const img = document.createElement("img");
    img.src = `data:image/jpeg;base64,${holder.image_base64}`;
    img.alt = alt;
    holder._imgNode = img;
  }
  return holder._imgNode;
}

// Crop choices, shown as clickable thumbnails rendered by the backend from the
// preview JPEG. Nothing is applied until one is picked, so browsing them costs
// none of the Camera Raw dialogs a trial-apply would.
function buildProposalCards(msg, idx) {
  const wrap = document.createElement("div");
  wrap.className = "plan-card";

  const heading = document.createElement("div");
  heading.className = "plan-status";
  heading.textContent =
    msg.proposalStatus === "picked"
      ? "✓ Crop applied"
      : "Pick a crop, or ignore these to keep the photo as it is:";
  wrap.appendChild(heading);
  if (msg.proposalStatus === "picked") return wrap;

  const strip = document.createElement("div");
  strip.className = "proposal-strip";

  msg.previews.options.forEach((option, i) => {
    const item = document.createElement("div");
    // Dimmed and untagged while an apply is running - Photoshop is modal, so the
    // click would be swallowed anyway.
    item.className = busy ? "proposal proposal-disabled" : "proposal";

    item.appendChild(previewImage(option, option.label));

    const label = document.createElement("div");
    label.className = "proposal-label";
    label.textContent = option.label;
    item.appendChild(label);

    const reason = document.createElement("div");
    reason.className = "proposal-reason";
    reason.textContent = option.reason;
    item.appendChild(reason);

    // Frame cost and shape - the two things a thumbnail can't tell you. Both are
    // measured from the rectangle rather than taken on trust.
    const facts = document.createElement("div");
    facts.className = "proposal-reason";
    facts.textContent = `keeps ${Math.round(option.retained * 100)}%${
      option.aspect_label ? ` · ${option.aspect_label}` : ""
    }`;
    item.appendChild(facts);

    if (!busy) tagAction(item, "pickProposal", idx, i);
    strip.appendChild(item);
  });

  wrap.appendChild(strip);
  return wrap;
}

// What a geometry apply actually cost, plus the way back. The user agreed to a
// correction, not to losing a quarter of the frame, so this is never silent.
function buildGeometryReport(msg) {
  const card = document.createElement("div");
  card.className = "plan-card";

  const line = document.createElement("div");
  line.className = "plan-status";
  line.textContent = msg.report.summary;
  card.appendChild(line);

  const actions = document.createElement("div");
  actions.className = "plan-actions";

  if (msg.report.wedges && msg.report.correctiveCrop) {
    const fixBtn = document.createElement("sp-button");
    fixBtn.setAttribute("variant", "cta");
    fixBtn.textContent = `Trim the empty corners (keeps ${Math.round(
      msg.report.retainedAfterFix * 100
    )}%)`;
    if (busy) fixBtn.setAttribute("disabled", "true");
    tagAction(fixBtn, "fixWedges", conversation.indexOf(msg));
    actions.appendChild(fixBtn);
  }

  if (msg.report.checkpoint) {
    const restoreBtn = document.createElement("sp-button");
    restoreBtn.setAttribute("variant", "secondary");
    restoreBtn.textContent = "Restore to before this";
    if (busy) restoreBtn.setAttribute("disabled", "true");
    tagAction(restoreBtn, "restore", conversation.indexOf(msg));
    actions.appendChild(restoreBtn);
  }

  card.appendChild(actions);
  return card;
}

function buildPlanCard(msg, idx) {
  const card = document.createElement("div");
  card.className = "plan-card";

  const ul = document.createElement("ul");
  (msg.plan.steps || []).forEach((step) => {
    const li = document.createElement("li");
    li.textContent = step.description;
    ul.appendChild(li);
  });
  card.appendChild(ul);

  // A straighten is fully predictable, so show the resulting frame before the
  // user commits a Camera Raw dialog to it.
  if (msg.previews && msg.previews.kind === "rotation" && !msg.planStatus) {
    const preview = document.createElement("div");
    preview.className = "proposal";
    preview.appendChild(previewImage(msg.previews, "Straightened preview"));
    const note = document.createElement("div");
    note.className = "proposal-reason";
    note.textContent = `Result after straightening — keeps ${Math.round(
      msg.previews.retained * 100
    )}% of the frame`;
    preview.appendChild(note);
    card.appendChild(preview);
  }

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
  // Disabled while ANY apply is running, not just this card's - Photoshop is
  // modal and will not process a click from anywhere in the panel.
  if (msg.planStatus === "applying" || busy) applyBtn.setAttribute("disabled", "true");
  tagAction(applyBtn, "apply", idx);

  const cancelBtn = document.createElement("sp-button");
  cancelBtn.setAttribute("variant", "secondary");
  cancelBtn.textContent = "Cancel";
  tagAction(cancelBtn, "cancel", idx);

  actions.appendChild(applyBtn);
  actions.appendChild(cancelBtn);
  card.appendChild(actions);
  return card;
}

function render() {
  const container = el("messages");
  // Detach children rather than innerHTML = "", which can tear the nodes down
  // and would defeat the cached preview images (see previewImage).
  while (container.firstChild) container.removeChild(container.firstChild);
  thinkingBubble = null; // the old node is gone; startThinking re-finds it below

  conversation.forEach((msg, idx) => {
    const roleClass = msg.thinking ? "assistant" : msg.role;

    const row = document.createElement("div");
    row.className = `row row-${roleClass}`;

    const bubble = document.createElement("div");
    if (msg.thinking) {
      bubble.className = "bubble bubble-thinking";
      bubble.textContent = "Thinking" + ".".repeat(thinkingDots);
      thinkingBubble = bubble; // animated in place, without re-rendering the list
    } else {
      bubble.className = `bubble bubble-${msg.role}`;
      bubble.textContent = msg.text;
    }
    row.appendChild(bubble);
    container.appendChild(row);

    // A proposals-only reply offers choices instead of an action, so it gets
    // thumbnails rather than an Apply button.
    if (msg.previews && msg.previews.kind === "crops") {
      container.appendChild(buildProposalCards(msg, idx));
    } else if (msg.plan && (msg.plan.steps || []).length) {
      container.appendChild(buildPlanCard(msg, idx));
    }
    if (msg.report) {
      container.appendChild(buildGeometryReport(msg));
    }
  });

  container.scrollTop = container.scrollHeight;
}

// Duplicating a photo layer in Photoshop does NOT duplicate the photo - both
// layers point at the same file, and a file has exactly one develop state. So
// the two layers are locked together forever: any edit changes both, and there
// is no way to grade them differently.
//
// That is genuinely surprising, and silent, so say it once. Warned per set of
// duplicates rather than per turn, so it does not become noise the user learns
// to scroll past.
const warnedDuplicates = new Set();

async function warnAboutDuplicateLayers() {
  try {
    const { app } = require("photoshop");
    const { photoLayersIn } = require("./executor/cameraRaw");
    const doc = app.activeDocument;
    if (!doc) return;

    for (const photo of await photoLayersIn(doc)) {
      const names = photo.aliases || [photo.name];
      if (names.length < 2) continue;

      const key = `${photo.filePath}::${names.slice().sort().join("|")}`;
      if (warnedDuplicates.has(key)) continue;
      warnedDuplicates.add(key);

      const listed = names.map((n) => `"${n}"`).join(" and ");
      // The remedy differs by format. A JPEG is copied on import, so importing
      // the same photo again really does give an independent second version.
      // A raw is edited in place, so the user has to make the copy themselves.
      const remedy =
        photo.kind === "jpeg"
          ? "To grade this photo two different ways, use 📷 to import it a second time - " +
            "CreaCon copies each import, so the two versions stay independent."
          : "To grade this photo two different ways, duplicate the raw file on disk and " +
            "import the copy with 📷 - a raw file holds a single set of develop settings.";

      conversation.push({
        role: "system",
        text:
          `Heads up: layers ${listed} are the same photo. Duplicating a layer doesn't ` +
          "duplicate the photo - both point at one file, and a file has one set of develop " +
          `settings, so any edit changes both. ${remedy}`,
      });
    }
  } catch (err) {
    // A warning is a nicety; never let it stop the message being sent.
    log("Duplicate-layer check skipped:", formatError(err));
  }
}

async function onSend() {
  const input = el("chatInput");
  const text = (input.value || "").trim();
  if (!text || busy) return;

  input.value = "";
  conversation.push({ role: "user", text });
  // Before the thinking bubble, not after: the warning explains why the edit
  // about to be planned will land on two layers at once, and pushing it later
  // would render it underneath "Thinking…". It also reaches the model as a
  // [note], which is the point - it should plan for one photo, not two.
  await warnAboutDuplicateLayers();

  const thinkingMsg = { role: "assistant", text: "", thinking: true };
  conversation.push(thinkingMsg);
  busy = true;
  startThinking();
  render();

  try {
    const apiMessages = conversationForApi();
    log("Sending chat,", apiMessages.length, "messages");
    const { reply, edit_plan, geometry_previews } = await sendChat(apiMessages);
    log(
      "Reply:",
      reply,
      "| plan:",
      edit_plan ? `${(edit_plan.steps || []).length} steps` : "none",
      "| previews:",
      geometry_previews ? geometry_previews.kind : "none"
    );

    removeMessage(thinkingMsg);
    conversation.push({
      role: "assistant",
      text: reply || "(no reply)",
      plan: edit_plan || null,
      previews: geometry_previews || null,
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
  if (busy || !msg || !msg.plan || msg.planStatus) return;

  const { valid, errors } = validateEditPlan(msg.plan);
  if (!valid) {
    conversation.push({ role: "error", text: `Plan failed validation: ${errors.join("; ")}` });
    render();
    return;
  }

  // Marks the panel busy so every OTHER card renders its buttons disabled.
  // Applying enters executeAsModal, and Photoshop blocks the whole UI thread
  // while modal - no click anywhere in the panel is processed. Buttons that look
  // live but swallow clicks read as broken; greyed-out ones read as "wait".
  busy = true;
  msg.planStatus = "applying";
  render();

  try {
    let geometryReport = null;
    let developResult = null;
    await applyEditPlan(msg.plan, (i, step, result) => {
      log(`Step ${i} done:`, step.op);
      if (step.op === "applyGeometry" && result) geometryReport = result;
      if (step.op === "applyCameraRaw" && result) developResult = result;
    });
    msg.planStatus = "applied";
    conversation.push({
      role: "system",
      text: `Applied: ${msg.plan.summary || "the edit"}`,
      // Every raw apply saves a restore point, so a develop edit gets one too -
      // not just geometry. No cost figures to show, hence the bare summary.
      report:
        !geometryReport && developResult && developResult.checkpoint
          ? {
              summary: msg.plan.summary || "the edit",
              checkpoint: developResult.checkpoint,
              layer: developResult.layer,
            }
          : undefined,
    });
    if (geometryReport) {
      // Goes in as a "system" note so the MODEL sees it next turn too - it has
      // to know the frame changed before it places any mask.
      conversation.push({
        role: "system",
        text: `Geometry applied: ${geometryReport.summary}.`,
        report: geometryReport,
      });
    }
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
    busy = false;
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

// Places a user-picked photo (RAW or JPEG) as a smart object and registers it so
// chat plans can develop it via applyCameraRaw (write state + re-import). This is
// the REQUIRED entry point for develop editing: smart objects created outside
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
          `Opened photo as smart object layer "${layerName}". ` +
          "Ask for develop edits - exposure, white balance, dehaze, color…",
      });
    }
  } catch (err) {
    error("Open photo failed:", err);
    conversation.push({ role: "error", text: `Open photo failed: ${formatError(err)}` });
  } finally {
    busy = false;
    render();
  }
}

// Runs a one-step geometry plan built by the panel itself (a picked crop, or a
// wedge trim). These are the user's direct choices, so they skip the Apply card.
async function runGeometry(params, summary, sourceMsg) {
  if (busy) return;
  busy = true;
  render();
  try {
    let report = null;
    await applyEditPlan(
      { summary, steps: [{ op: "applyGeometry", description: summary, params }] },
      (i, step, result) => {
        if (result) report = result;
      }
    );
    conversation.push({
      role: "system",
      text: report ? `${summary}: ${report.summary}.` : `${summary}.`,
      report: report || undefined,
    });
    if (report) report.summary = `${summary} — ${report.summary}`;
    if (sourceMsg) sourceMsg.proposalStatus = "picked";
  } catch (err) {
    error("Geometry apply failed:", err);
    conversation.push({ role: "error", text: `Error: ${formatError(err)}` });
  } finally {
    busy = false;
    render();
  }
}

function onPickProposal(idx, optionIndex) {
  const msg = conversation[idx];
  if (!msg || !msg.previews || msg.proposalStatus) return;
  const option = msg.previews.options[optionIndex];
  if (!option) return;
  runGeometry(
    { targetLayer: option.targetLayer || undefined, crop: option.crop },
    `Cropped: ${option.label}`,
    msg
  );
}

// Trims the transparent corners a strong perspective correction can leave. The
// rectangle comes from the transform Camera Raw wrote back, so it is measured
// rather than guessed.
function onFixWedges(idx) {
  const msg = conversation[idx];
  if (!msg || !msg.report || !msg.report.correctiveCrop) return;
  runGeometry({ crop: msg.report.correctiveCrop }, "Trimmed the empty corners", null);
  msg.report = { ...msg.report, wedges: false };
}

// Puts the raw back to the state saved before THIS edit, by id. Each card holds
// its own checkpoint, so restoring an older one still does what the card says
// even after later edits - which "undo the last apply" could not.
async function onRestoreCheckpoint(idx) {
  const msg = conversation[idx];
  if (busy || !msg || !msg.report || !msg.report.checkpoint) return;
  busy = true;
  render();
  try {
    const { restoreCheckpoint } = require("./executor/geometry");
    const name = await core.executeAsModal(
      async () => restoreCheckpoint(msg.report.checkpoint, msg.report.layer),
      { commandName: "CreaCon: restore checkpoint" }
    );
    conversation.push({
      role: "system",
      text: `Restored "${name}" to before that edit.`,
    });
    // The card's restore point has been used up as a destination, but the state
    // it replaced is now a checkpoint of its own, so nothing is a dead end.
    msg.report = undefined;
  } catch (err) {
    error("Restore failed:", err);
    conversation.push({ role: "error", text: `Couldn't restore: ${formatError(err)}` });
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

// Dispatch table for the delegated listener above. Defined here, after every
// handler exists.
const ACTIONS = {
  apply: onApply,
  cancel: onCancel,
  pickProposal: onPickProposal,
  fixWedges: onFixWedges,
  restore: onRestoreCheckpoint,
};

function setup() {
  el("btnSend").addEventListener("click", onSend);
  el("btnOpenRaw").addEventListener("click", onOpenRaw);
  // One listener for every button inside the message list - see onMessagesClick.
  el("messages").addEventListener("click", onMessagesClick);
  el("chatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  });
  log("Panel ready");
}

module.exports = { setup };
