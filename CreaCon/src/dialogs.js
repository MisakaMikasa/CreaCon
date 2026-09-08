// Dialogs shown inside the Photoshop panel.
//
// Extracted from panel.js so bridge.js can use them too: panel.js requires
// bridge.js, so bridge.js cannot require panel.js back.
//
// These stay in Photoshop rather than moving to the desktop window, and that is
// deliberate. 📷 opens Photoshop's own file picker, so the user is already
// looking at Photoshop when the follow-up question arrives - bouncing them to
// another window for the second half of one decision would be worse.

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

module.exports = { askImportChoice };
