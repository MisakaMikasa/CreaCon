// Linked-SO spike (option A): can LINKED raw smart objects unify manual ACR
// edits and CreaCon edits in the ONE sidecar file?
//
// Background: an EMBEDDED raw SO stores manual ACR-dialog edits in a private
// container inside the PSD that no script can read, so CreaCon's sidecar
// re-import clobbers them. A LINKED SO has no private container - the raw
// stays on disk - so ACR *should* write manual edits to the sidecar, the same
// file CreaCon reads/writes. If true, manual and AI edits merge cleanly and
// the two-sources-of-truth problem disappears.
//
// Two phases, because the test needs a manual ACR edit in the middle:
//   Phase 1 (first 🧪 click):  pick raw -> place as LINKED smart object ->
//     snapshot the sidecar -> instruct the user to double-click the layer,
//     make an obvious GLOBAL change in ACR (e.g. Exposure +2, no masks),
//     press OK, then click 🧪 again.
//   Phase 2 (second 🧪 click): GATE A = did the sidecar's content change?
//     - YES: ACR writes linked-SO edits to the sidecar. Then round-trip:
//       parse the sidecar, add Dehaze +80 on top, replaceContents - the
//       canvas should show the user's manual edit AND the dehaze, proving
//       preservation through CreaCon's own mechanism.
//     - NO: linked SOs also store edits elsewhere -> option A fails, fall
//       back to plan B (sidecar-first manual workflow) + C (clobber guard).
const { app, core, action } = require("photoshop");
const { localFileSystem } = require("uxp").storage;
const fs = require("fs");
const { log } = require("../log");
const { serialize, parse, sidecarPathFor } = require("../executor/xmpSidecar");
const registry = require("../executor/rawRegistry");

const RAW_TYPES = ["cr2", "cr3", "nef", "arw", "raf", "orf", "rw2"];

// Cross-click state (module-level; survives between the two 🧪 clicks but not
// a plugin reload - rerun phase 1 in that case).
let state = null; // { rawPath, sidecarPath, layerId, sidecarSnapshot }

async function writeTextFile(nativePath, text) {
  await fs.writeFile(nativePath, text, { encoding: "utf-8" });
}

async function readTextFileIfExists(nativePath) {
  try {
    return await fs.readFile(nativePath, { encoding: "utf-8" });
  } catch {
    return null;
  }
}

async function getLinkInfo() {
  const result = await action.batchPlay(
    [
      {
        _obj: "get",
        _target: [
          { _property: "smartObjectMore" },
          { _ref: "layer", _enum: "ordinal", _value: "targetEnum" },
        ],
      },
    ],
    {}
  );
  return (result[0] && result[0].smartObjectMore && result[0].smartObjectMore.link) || null;
}

async function phase1(say) {
  const entry = await localFileSystem.getFileForOpening();
  if (!entry) {
    say("Linked spike: cancelled (no file picked).");
    return;
  }
  const rawPath = entry.nativePath;
  const ext = (rawPath.split(".").pop() || "").toLowerCase();
  if (!RAW_TYPES.includes(ext)) {
    say(`Linked spike: ".${ext}" isn't a supported raw type (${RAW_TYPES.join(", ")}).`);
    return;
  }
  if (!app.activeDocument) {
    say("Linked spike: open any document first - the raw is placed into it.");
    return;
  }

  const token = localFileSystem.createSessionToken(entry);
  let layerId = null;
  await core.executeAsModal(
    async () => {
      await action.batchPlay(
        [
          {
            _obj: "placeEvent",
            null: { _path: token, _kind: "local" },
            linked: true,
            _options: { dialogOptions: "dontDisplay" },
          },
        ],
        {}
      );
      const placed = app.activeDocument.activeLayers[0];
      if (!placed) throw new Error("Place succeeded but no active layer found");
      layerId = placed.id;
      await registry.registerPhoto(rawPath);
    },
    { commandName: "CreaCon spike: place linked raw" }
  );

  // Confirm it actually placed as LINKED (link info carries the source path).
  const link = await getLinkInfo();
  say(
    link
      ? "Linked spike: placed as a LINKED smart object (source: " + JSON.stringify(link) + ")."
      : "Linked spike: WARNING - layer does not report link info; it may have embedded. " +
          "Results below may not be meaningful."
  );

  const sidecarPath = sidecarPathFor(rawPath);
  const sidecarSnapshot = await readTextFileIfExists(sidecarPath);
  state = { rawPath, sidecarPath, layerId, sidecarSnapshot };

  say(
    "Linked spike: phase 1 done. NOW DO THIS BY HAND: (1) double-click the new layer's " +
      "thumbnail - Camera Raw opens; (2) make one OBVIOUS global change, e.g. Exposure +2 " +
      "(NO masks this time); (3) press OK; (4) click 🧪 again for phase 2."
  );
}

async function phase2(say) {
  const { rawPath, sidecarPath, layerId, sidecarSnapshot } = state;
  state = null; // next click starts over

  // GATE A: did the manual ACR edit land in the sidecar on disk?
  const current = await readTextFileIfExists(sidecarPath);
  if (current === null || current === sidecarSnapshot) {
    say(
      "Linked spike: GATE A FAIL - the sidecar did NOT change after your manual ACR edit " +
        "(ACR stored it in its database or the document instead). Linked SOs do not unify " +
        "storage here. Fall back: sidecar-first manual workflow (edit the original raw via " +
        "Bridge/ACR 'Done') + a clobber guard. Also check: ACR preferences must say " +
        "'Save image settings in: Sidecar .xmp files'."
    );
    return;
  }

  const manualSettings = parse(current);
  say(
    "Linked spike: **GATE A PASS** - your manual ACR edit was written to the sidecar. " +
      "Recovered flat settings: " +
      JSON.stringify(manualSettings) +
      ". Now round-tripping through CreaCon's mechanism (your edit + Dehaze +80)…"
  );

  // Round-trip: CreaCon-style apply that MERGES the manual state instead of
  // clobbering it, then re-imports. Canvas should show BOTH.
  const merged = { ...manualSettings, Dehaze: 80 };
  await writeTextFile(sidecarPath, serialize(merged));

  const url = "file:" + rawPath.replace(/\\/g, "/");
  const entry = await localFileSystem.getEntryWithUrl(url);
  const token = localFileSystem.createSessionToken(entry);
  await core.executeAsModal(
    async () => {
      await action.batchPlay(
        [
          { _obj: "select", _target: [{ _ref: "layer", _id: layerId }], makeVisible: false },
          {
            _obj: "placedLayerReplaceContents",
            null: { _path: token, _kind: "local" },
            _options: { dialogOptions: "dontDisplay" },
          },
        ],
        {}
      );
    },
    { commandName: "CreaCon spike: linked round-trip" }
  );
  await registry.updateSettings(rawPath, merged);

  say(
    "Linked spike: round-trip applied. LOOK AT THE CANVAS: does the image show YOUR manual " +
      "change (e.g. still +2 exposure) PLUS heavy dehaze? " +
      "- BOTH visible -> **GATE B PASS: option A works end-to-end.** Manual ACR edits and " +
      "CreaCon edits share the sidecar; next step is switching 📷 to linked placement + " +
      "mask parse-back so masks merge too. " +
      "- Only dehaze (your edit gone) -> replaceContents didn't preserve; report exactly " +
      "what you see."
  );
}

async function runLinkedSoSpike(report) {
  const say = (text) => {
    log("[linked-spike]", text);
    report(text);
  };
  if (state === null) {
    await phase1(say);
  } else {
    await phase2(say);
  }
}

module.exports = { runLinkedSoSpike };
