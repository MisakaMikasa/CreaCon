// The chat, ported from CreaCon/src/panel.js.
//
// Most of it is unchanged: panel.js already built its interface with
// document.createElement, which is ordinary web code. UXP is a stripped-down
// browser-like environment and WebView2 is a complete one, so what was written
// for the limited one runs in the full one.
//
// What is deliberately GONE, and why:
//
//   - panel.js walked up the DOM by hand from event.target because UXP does not
//     implement composedPath(). A real DOM has Element.closest(), so that whole
//     workaround is one line here.
//   - sp-button / sp-textarea were Adobe's Spectrum components. Plain <button>
//     and <textarea> now, which also removes the cause of the dropped-clicks
//     bug panel.js documented: listeners were being attached to Spectrum
//     elements before they had upgraded.
//   - require("photoshop"). Nothing here can touch the document. Applying goes
//     through POST /apply, over the bridge, to the plugin.
//

const conversation = [];
let busy = false;
let pluginConnected = false;

// Every mutating endpoint is token-gated, and /ping hands the token out. The
// page is served by the very server it calls, so this is same-origin and there
// is no CORS question to answer - which is exactly why the window loads over
// http rather than from a file:// URL.
let token = "";

// ---------------------------------------------------------------- utilities

function el(id) {
  return document.getElementById(id);
}

function tagAction(node, action, ...args) {
  node.dataset.action = action;
  node.dataset.args = JSON.stringify(args);
  return node;
}

// One delegated listener on a container that is never replaced, exactly as in
// panel.js. The difference is closest(): panel.js had to walk parentNode by
// hand, because UXP gave it no way to ask "which tagged ancestor was clicked".
function onMessagesClick(event) {
  const node = event.target.closest("[data-action]");
  if (!node) return;
  const args = JSON.parse(node.dataset.args || "[]");
  const handler = ACTIONS[node.dataset.action];
  if (handler) handler(...args);
}

// ------------------------------------------------------------ thinking dots

let thinkingTimer = null;
let thinkingDots = 0;
let thinkingBubble = null;

function startThinking() {
  stopThinking();
  thinkingDots = 0;
  thinkingTimer = setInterval(() => {
    thinkingDots = (thinkingDots + 1) % 4;
    // Updates only its own bubble. panel.js learned this the hard way: calling
    // render() on a timer re-decoded every base64 preview two and a half times
    // a second and made the panel swallow clicks.
    if (thinkingBubble) thinkingBubble.textContent = "Thinking" + ".".repeat(thinkingDots);
    else render();
  }, 400);
}

function stopThinking() {
  if (thinkingTimer) clearInterval(thinkingTimer);
  thinkingTimer = null;
  thinkingBubble = null;
}

// --------------------------------------------------------------- rendering

// Created once and cached on the object that owns it. render() rebuilds the
// list on every state change, and re-setting a data: URL each time makes the
// engine re-decode the whole payload - three crop thumbnails plus a rotation
// preview run to ~300 KB. Re-appending an existing node moves it instead.
function previewImage(holder, alt) {
  if (!holder._imgNode) {
    const img = document.createElement("img");
    img.src = `data:image/jpeg;base64,${holder.image_base64}`;
    img.alt = alt;
    holder._imgNode = img;
  }
  return holder._imgNode;
}

function button(label, { cta = false, disabled = false } = {}) {
  const b = document.createElement("button");
  b.textContent = label;
  if (cta) b.className = "cta";
  if (disabled) b.disabled = true;
  return b;
}

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

    // Frame cost and shape - the two things a thumbnail cannot tell you.
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

function buildGeometryReport(msg, idx) {
  const card = document.createElement("div");
  card.className = "plan-card";

  const line = document.createElement("div");
  line.className = "plan-status";
  line.textContent = msg.report.summary;
  card.appendChild(line);

  const actions = document.createElement("div");
  actions.className = "plan-actions";

  if (msg.report.wedges && msg.report.correctiveCrop) {
    const fix = button(
      `Trim the empty corners (keeps ${Math.round(msg.report.retainedAfterFix * 100)}%)`,
      { cta: true, disabled: busy }
    );
    actions.appendChild(tagAction(fix, "fixWedges", idx));
  }
  if (msg.report.checkpoint) {
    const restore = button("Restore to before this", { disabled: busy });
    actions.appendChild(tagAction(restore, "restore", idx));
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

  // A straighten is fully predictable, so the resulting frame is shown before
  // the user commits a Camera Raw dialog to it.
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

  // Disabled when no plugin is attached as well as when busy. In the panel
  // that case could not arise - the panel WAS inside Photoshop. Here the app
  // runs happily with Photoshop closed, and an Apply would fail with a 503
  // the user had no way to see coming.
  const applying = msg.planStatus === "applying";
  const apply = button(applying ? "Applying…" : "Apply", {
    cta: true,
    disabled: applying || busy || !pluginConnected,
  });
  if (!pluginConnected && !applying) apply.title = "Photoshop plugin is not connected";
  actions.appendChild(tagAction(apply, "apply", idx));
  actions.appendChild(tagAction(button("Cancel"), "cancel", idx));

  card.appendChild(actions);
  return card;
}

function render() {
  const container = el("messages");
  while (container.firstChild) container.removeChild(container.firstChild);
  thinkingBubble = null;

  conversation.forEach((msg, idx) => {
    const roleClass = msg.thinking ? "assistant" : msg.role;

    const row = document.createElement("div");
    row.className = `row row-${roleClass}`;

    const bubble = document.createElement("div");
    if (msg.thinking) {
      bubble.className = "bubble bubble-thinking";
      bubble.textContent = "Thinking" + ".".repeat(thinkingDots);
      thinkingBubble = bubble;
    } else {
      bubble.className = `bubble bubble-${msg.role}`;
      bubble.textContent = msg.text;
    }
    row.appendChild(bubble);
    container.appendChild(row);

    if (msg.previews && msg.previews.kind === "crops") {
      container.appendChild(buildProposalCards(msg, idx));
    } else if (msg.plan && (msg.plan.steps || []).length) {
      container.appendChild(buildPlanCard(msg, idx));
    }
    if (msg.report) container.appendChild(buildGeometryReport(msg, idx));
  });

  container.scrollTop = container.scrollHeight;
}

// ------------------------------------------------------------------ actions

// Only user and assistant turns are real conversation for the model. "system"
// notes go as user "[note] ..." so it knows the document changed; thinking
// placeholders and errors are display-only. Same rule as panel.js.
function conversationForApi() {
  return conversation
    .filter((m) => !m.thinking && m.role !== "error")
    .map((m) =>
      m.role === "system"
        ? { role: "user", content: `[note] ${m.text}` }
        : { role: m.role, content: m.text }
    );
}

function removeMessage(msg) {
  const i = conversation.indexOf(msg);
  if (i !== -1) conversation.splice(i, 1);
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
    // No preview or layer list is sent. The backend collects those from the
    // plugin over the bridge - this window cannot produce them, because both
    // need the open document.
    const res = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CreaCon-Token": token },
      body: JSON.stringify({ messages: conversationForApi() }),
    });
    if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 300)}`);
    const { reply, edit_plan, geometry_previews } = await res.json();

    // panel.js logged this and the desktop version did not, which made "no
    // Apply button" impossible to tell apart from "the model proposed nothing".
    // The card only renders when a plan has at least one step, so those two
    // cases look identical on screen and completely different here.
    console.log(
      "chat reply |",
      "plan:", edit_plan ? `${(edit_plan.steps || []).length} step(s)` : "none",
      "| proposals:", (edit_plan && edit_plan.proposals || []).length,
      "| previews:", geometry_previews ? geometry_previews.kind : "none"
    );

    removeMessage(thinkingMsg);
    conversation.push({
      role: "assistant",
      text: reply || "(no reply)",
      plan: edit_plan || null,
      previews: geometry_previews || null,
    });
  } catch (err) {
    removeMessage(thinkingMsg);
    conversation.push({ role: "error", text: `Error: ${err.message}` });
  } finally {
    busy = false;
    stopThinking();
    render();
  }
}

async function onApply(idx) {
  const msg = conversation[idx];
  if (busy || !msg || !msg.plan || msg.planStatus) return;

  // No validateEditPlan here: this window has no schema. The backend validates
  // against it, and the plugin re-checks structurally before executing, so the
  // existing defence in depth is intact - it just no longer has a third copy
  // living in the UI.
  //
  // busy disables every OTHER card's buttons too. Photoshop is modal for the
  // duration, so nothing can be applied meanwhile, and a live-looking button
  // that swallows clicks reads as broken where a greyed one reads as "wait".
  busy = true;
  msg.planStatus = "applying";
  render();

  try {
    const res = await fetch("/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CreaCon-Token": token },
      body: JSON.stringify({ plan: msg.plan }),
    });
    if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 300)}`);
    const done = await res.json();

    msg.planStatus = "applied";

    // Goes in as a "system" note so the MODEL sees it next turn as well. It has
    // to know the document changed before it plans anything else.
    conversation.push({
      role: "system",
      text: `Applied: ${done.summary || "the edit"}`,
      // Every raw apply saves a restore point, so a develop edit gets one too,
      // not just geometry. No cost figures to show, hence the bare summary.
      report:
        !done.geometryReport && done.developResult && done.developResult.checkpoint
          ? {
              summary: done.summary || "the edit",
              checkpoint: done.developResult.checkpoint,
              layer: done.developResult.layer,
            }
          : undefined,
    });

    if (done.geometryReport) {
      conversation.push({
        role: "system",
        text: `Geometry applied: ${done.geometryReport.summary}.`,
        report: done.geometryReport,
      });
    }

    if (done.usesAiMask) {
      conversation.push({
        role: "system",
        text:
          "This edit uses an AI mask (sky / subject / person). Camera Raw loads the " +
          "settings but does not always run the segmentation on its own - if the region " +
          'looks untouched, open the photo in Camera Raw and click "Update AI settings" once.',
      });
    }
  } catch (err) {
    // Cleared rather than left as "applying", so the card can be retried once
    // whatever went wrong is fixed - a disconnected plugin, usually.
    msg.planStatus = null;
    conversation.push({ role: "error", text: `Apply failed: ${err.message}` });
  } finally {
    busy = false;
    render();
  }
}

// A crop or a wedge-trim is just an applyGeometry plan with one step, so both
// go down the same /apply path an ordinary plan does. No new bridge command:
// "crop to this rectangle" is an edit like any other.
async function runGeometry(params, summary, sourceMsg) {
  if (busy) return;
  busy = true;
  render();
  try {
    const res = await fetch("/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CreaCon-Token": token },
      body: JSON.stringify({
        plan: { summary, steps: [{ op: "applyGeometry", description: summary, params }] },
      }),
    });
    if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 300)}`);
    const done = await res.json();
    const report = done.geometryReport || null;

    conversation.push({
      role: "system",
      text: report ? `${summary}: ${report.summary}.` : `${summary}.`,
      report: report || undefined,
    });
    if (report) report.summary = `${summary} — ${report.summary}`;
    if (sourceMsg) sourceMsg.proposalStatus = "picked";
  } catch (err) {
    conversation.push({ role: "error", text: `Error: ${err.message}` });
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

// Restore is NOT an edit - there is no applyGeometry meaning "go back" - so it
// has its own endpoint and its own bridge command.
async function onRestoreCheckpoint(idx) {
  const msg = conversation[idx];
  if (busy || !msg || !msg.report || !msg.report.checkpoint) return;
  busy = true;
  render();
  try {
    const res = await fetch("/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CreaCon-Token": token },
      body: JSON.stringify({ checkpoint: msg.report.checkpoint, layer: msg.report.layer }),
    });
    if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 300)}`);
    const done = await res.json();
    conversation.push({
      role: "system",
      text: `Restored "${done.layerName}" to before that edit.`,
    });
    // The card's restore point is used up as a destination, but the state it
    // replaced is now a checkpoint of its own, so nothing becomes a dead end.
    msg.report = undefined;
  } catch (err) {
    conversation.push({ role: "error", text: `Couldn't restore: ${err.message}` });
  } finally {
    busy = false;
    render();
  }
}

const ACTIONS = {
  apply: onApply,
  cancel: (idx) => {
    conversation[idx].planStatus = "cancelled";
    render();
  },
  pickProposal: onPickProposal,
  fixWedges: onFixWedges,
  restore: onRestoreCheckpoint,
};

// ------------------------------------------------------------------- status

// Polled rather than pushed. /ping is cheap, the answer changes only when
// Photoshop opens or closes, and polling needs no second socket for the app.
async function refreshStatus() {
  try {
    const res = await fetch("/ping");
    const info = await res.json();
    token = info.token || token;
    pluginConnected = !!info.plugin_connected;
    el("statusDot").className = pluginConnected ? "ok" : "bad";
    el("statusText").textContent = pluginConnected
      ? `Photoshop connected · v${info.version}`
      : "Photoshop plugin not connected";
  } catch (err) {
    pluginConnected = false;
    el("statusDot").className = "bad";
    el("statusText").textContent = "backend unreachable";
  }
  // Apply buttons are enabled from pluginConnected, so they have to be redrawn
  // when it changes.
  render();
}

// ----------------------------------------------------------------- settings

async function showSettings(show) {
  el("settings").hidden = !show;
  el("messages").hidden = show;
  el("inputRow").hidden = show;
  if (!show) return;

  el("settingsMsg").textContent = "";
  el("settingsMsg").className = "";
  try {
    const res = await fetch("/settings", { headers: { "X-CreaCon-Token": token } });
    const s = await res.json();
    el("provider").value = s.llm_provider || "gemini";
    // The key itself is never sent back - there is no reason to hand a secret
    // out again, and it would land in any log that captures a response body.
    // The placeholder is how the user knows one is already stored.
    el("apiKey").value = "";
    el("apiKey").placeholder = s.has_gemini_key ? "•••••••• (saved)" : "AIza…";
  } catch (err) {
    say(el("settingsMsg"), `Couldn't load settings: ${err.message}`, "bad");
  }
  el("apiKey").focus();
}

function say(node, text, kind) {
  node.textContent = text;
  node.className = kind || "";
}

async function onSaveSettings() {
  const body = { llm_provider: el("provider").value };
  const key = el("apiKey").value.trim();
  if (key) body.gemini_api_key = key;

  try {
    const res = await fetch("/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CreaCon-Token": token },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
    const done = await res.json();
    el("apiKey").value = "";
    // The provider modules read their key and model at IMPORT time, so a change
    // does not reach a module that is already loaded. Saying so beats the user
    // concluding the setting did not save.
    say(
      el("settingsMsg"),
      done.restart_required
        ? `Saved (${done.saved.join(", ")}). Restart CreaCon for it to take effect.`
        : `Saved (${done.saved.join(", ")}).`,
      "ok"
    );
  } catch (err) {
    say(el("settingsMsg"), `Couldn't save: ${err.message}`, "bad");
  }
}

// 📷 opens a photo for develop editing. The file picker and the keep-or-fresh
// question both live in Photoshop: the picker has to, and putting the follow-up
// question in the same place keeps one dialog flow rather than bouncing the
// user between two windows for one decision.
async function onOpenRaw() {
  if (busy) return;
  busy = true;
  render();
  try {
    const res = await fetch("/open-raw", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CreaCon-Token": token },
      body: "{}",
    });
    if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 300)}`);
    const done = await res.json();
    (done.notes || []).forEach((text) => conversation.push({ role: "system", text }));
    if (done.layerName) {
      conversation.push({
        role: "system",
        text: `Imported "${done.layerName}" — ask for develop edits on it now.`,
      });
    }
  } catch (err) {
    conversation.push({ role: "error", text: `Couldn't open the photo: ${err.message}` });
  } finally {
    busy = false;
    render();
  }
}

// -------------------------------------------------------------------- setup

function setup() {
  el("messages").addEventListener("click", onMessagesClick);
  el("btnSettings").addEventListener("click", () => showSettings(true));
  el("btnCloseSettings").addEventListener("click", () => showSettings(false));
  el("btnSend").addEventListener("click", onSend);
  el("btnOpenRaw").addEventListener("click", onOpenRaw);
  el("btnSaveSettings").addEventListener("click", onSaveSettings);

  // Enter sends, Shift+Enter makes a newline - what every chat box does, and
  // impossible to get right against UXP's sp-textarea.
  el("chatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  });

  render();
  // Awaited so the token is in hand before anything can be sent.
  refreshStatus();
  setInterval(refreshStatus, 3000);
}

document.addEventListener("DOMContentLoaded", setup);
