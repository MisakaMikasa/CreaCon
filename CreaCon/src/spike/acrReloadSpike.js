// ACR reload spike: answers ONE question - after rewriting a raw file's XMP
// sidecar on disk, does `placedLayerReplaceContents` make Camera Raw re-develop
// the smart object with the NEW settings, or does it reuse the settings cached
// inside the smart object at place time?
//
// Research (Adobe forums) established that ACR cannot be driven imperatively
// (batchPlay can open its dialog but not set sliders), so the only candidate
// path for agent-driven raw develop is: write crs: settings into the sidecar,
// then force a re-ingest. This spike proves or kills that path. See the plan:
// Stage 2 (the applyCameraRaw executor) is built only if T2 passes.
//
// Test sequence (each result is reported into the chat panel):
//   T0  user picks a raw file (DNG excluded - it embeds settings, no sidecar)
//   T1  write sidecar A (bright B&W), place the raw     -> proves ACR reads
//       sidecars on this machine at all (prefs sanity check)
//   T2  rewrite sidecar B (dark/punchy), replaceContents -> THE GATE
//   T3  only if T2 failed: rewrite sidecar C, delete layer, place fresh
//       -> proves the heavy delete+re-place fallback
const { app, core, action } = require("photoshop");
const { localFileSystem } = require("uxp").storage;
const fs = require("fs");
const { log, error, formatError } = require("../log");
const { capturePreviewImage } = require("../aiClient");
const { serialize } = require("../executor/xmpSidecar");
const registry = require("../executor/rawRegistry");

// DNG deliberately excluded: it stores develop settings inside the file, not
// in a sidecar, so it can't validate the sidecar-reload mechanism.
const RAW_TYPES = ["cr2", "cr3", "nef", "arw", "raf", "orf", "rw2"];

// Three visually unmistakable, mutually distinct looks, in schema units -
// serialized through the REAL xmpSidecar.serialize(), so the spike also
// validates the exact XML the applyCameraRaw executor writes.
const LOOK_A = { Exposure2012: 2, Saturation: -100 }; // bright B&W
const LOOK_B = { Exposure2012: -1.5, Saturation: 40, Dehaze: 80 }; // dark, punchy
const LOOK_C = { Exposure2012: 1, Dehaze: -50, Saturation: 0 }; // hazy, bright

function sidecarPathFor(rawPath) {
  return rawPath.replace(/\.[^./\\]+$/, ".xmp");
}

// Write with the UXP fs module (accepts native paths under the manifest's
// localFileSystem "fullAccess"); fall back to an entry-based write in case a
// UXP version rejects plain native paths.
async function writeTextFile(nativePath, text) {
  try {
    await fs.writeFile(nativePath, text, { encoding: "utf-8" });
    return;
  } catch (err) {
    log("fs.writeFile failed, falling back to entry write:", formatError(err));
  }
  const sep = nativePath.includes("\\") ? "\\" : "/";
  const dir = nativePath.substring(0, nativePath.lastIndexOf(sep));
  const name = nativePath.substring(nativePath.lastIndexOf(sep) + 1);
  const folderUrl = "file:" + dir.replace(/\\/g, "/");
  const folder = await localFileSystem.getEntryWithUrl(folderUrl);
  const file = await folder.createFile(name, { overwrite: true });
  await file.write(text);
}

async function readTextFileIfExists(nativePath) {
  try {
    return await fs.readFile(nativePath, { encoding: "utf-8" });
  } catch {
    return null; // doesn't exist / unreadable - both fine for our purposes
  }
}

// --- batchPlay wrappers -----------------------------------------------------
// Descriptors follow the recorded ("Copy as JavaScript") shapes. dontDisplay
// matters: placing a raw normally opens the ACR dialog; we need silent
// placement that uses whatever the sidecar says.

async function placeRaw(token) {
  await action.batchPlay(
    [
      {
        _obj: "placeEvent",
        null: { _path: token, _kind: "local" },
        _options: { dialogOptions: "dontDisplay" },
      },
    ],
    {}
  );
}

async function replaceContents(token) {
  await action.batchPlay(
    [
      {
        _obj: "placedLayerReplaceContents",
        null: { _path: token, _kind: "local" },
        _options: { dialogOptions: "dontDisplay" },
      },
    ],
    {}
  );
}

// --- the spike ---------------------------------------------------------------

// report(text) appends a visible line to the chat panel; everything is also
// mirrored to the debug console via log().
async function runAcrReloadSpike(report) {
  const say = (text) => {
    log("[spike]", text);
    report(text);
  };

  if (!app.activeDocument) {
    say("ACR spike: open any document first (the raw is placed into it).");
    return;
  }

  // T0 - pick the raw --------------------------------------------------------
  // No `types` filter: UXP's picker filter is case-sensitive in some builds
  // (greys out "IMG.CR3" against a "cr3" filter), so we accept any file and
  // validate the extension ourselves.
  const entry = await localFileSystem.getFileForOpening();
  if (!entry) {
    say("ACR spike: cancelled (no file picked).");
    return;
  }
  const rawPath = entry.nativePath;
  const ext = (rawPath.split(".").pop() || "").toLowerCase();
  if (ext === "dng") {
    say(
      "ACR spike: DNG stores its develop settings INSIDE the file, not in a sidecar, " +
        "so it can't test the sidecar mechanism. Pick a CR2/CR3/NEF/ARW/RAF/ORF/RW2 instead."
    );
    return;
  }
  if (!RAW_TYPES.includes(ext)) {
    say(`ACR spike: ".${ext}" isn't a raw type this spike supports (${RAW_TYPES.join(", ")}).`);
    return;
  }
  const sidecarPath = sidecarPathFor(rawPath);
  say(`ACR spike: raw = ${rawPath}`);

  // Never clobber real edits: back up an existing sidecar once.
  const existing = await readTextFileIfExists(sidecarPath);
  if (existing !== null) {
    await writeTextFile(sidecarPath + ".creacon-backup", existing);
    say(`ACR spike: existing sidecar backed up to ${sidecarPath}.creacon-backup`);
  }

  // T1 - sidecar respected at place time --------------------------------------
  await writeTextFile(sidecarPath, serialize(LOOK_A));
  say("ACR spike: T1 - sidecar A written (Exposure +2, Saturation -100 = bright B&W). Placing raw…");

  const token = localFileSystem.createSessionToken(entry);
  let placedId = null;
  await core.executeAsModal(
    async () => {
      await placeRaw(token);
      const placed = app.activeDocument.activeLayers[0];
      if (placed) {
        // Register so the placed layer is develop-editable via chat afterward
        // (same bookkeeping the panel's Open RAW button does).
        placedId = placed.id;
        registry.register(placedId, rawPath);
        registry.updateSettings(placedId, LOOK_A);
      }
    },
    { commandName: "CreaCon spike: place raw" }
  );
  const previewT1 = await capturePreviewImage();
  say(
    "ACR spike: T1 placed. LOOK AT THE CANVAS - is the placed image a very bright " +
      "black-and-white? If YES, ACR reads sidecars on this machine (T1 PASS). If it " +
      "looks like the normal photo, ACR ignored the sidecar (T1 FAIL - check Camera Raw " +
      "preferences: 'Save image settings in: Sidecar .xmp files')."
  );

  // T2 - THE GATE: does replaceContents re-read the rewritten sidecar? --------
  await writeTextFile(sidecarPath, serialize(LOOK_B));
  say("ACR spike: T2 - sidecar rewritten to B (dark, saturated, heavy dehaze). Replacing contents…");

  const token2 = localFileSystem.createSessionToken(entry);
  await core.executeAsModal(async () => replaceContents(token2), {
    commandName: "CreaCon spike: replace contents",
  });
  registry.updateSettings(placedId, LOOK_B);
  const previewT2 = await capturePreviewImage();

  const t2Changed =
    previewT1 && previewT2 ? previewT1 !== previewT2 : null; // null = couldn't compare
  if (t2Changed === true) {
    say(
      "ACR spike: T2 pixels CHANGED after replaceContents. If the canvas now shows the " +
        "dark/punchy look: **T2 PASS - the reload path works.** Stage 2 (applyCameraRaw " +
        "executor) is a go."
    );
  } else if (t2Changed === false) {
    say(
      "ACR spike: T2 pixels IDENTICAL after replaceContents - ACR reused the cached " +
        "settings. **T2 FAIL.** Running T3 (delete + fresh place fallback)…"
    );
  } else {
    say(
      "ACR spike: T2 preview capture unavailable - compare visually: did the canvas " +
        "switch from bright-B&W to dark/punchy? That is the entire question."
    );
  }

  // T3 - heavy fallback, only meaningful if T2 failed --------------------------
  if (t2Changed === false) {
    await writeTextFile(sidecarPath, serialize(LOOK_C));
    say("ACR spike: T3 - sidecar rewritten to C (bright, de-hazed). Deleting layer + placing fresh…");

    const token3 = localFileSystem.createSessionToken(entry);
    await core.executeAsModal(
      async () => {
        const placed = app.activeDocument.activeLayers[0];
        if (placed) await placed.delete();
        await placeRaw(token3);
        const fresh = app.activeDocument.activeLayers[0];
        if (fresh) {
          registry.register(fresh.id, rawPath);
          registry.updateSettings(fresh.id, LOOK_C);
        }
      },
      { commandName: "CreaCon spike: fresh place" }
    );
    const previewT3 = await capturePreviewImage();
    const t3Changed = previewT2 && previewT3 ? previewT2 !== previewT3 : null;
    say(
      t3Changed === true
        ? "ACR spike: T3 pixels changed on fresh place - **T3 PASS.** The heavy " +
            "delete+re-place fallback works even though in-place reload doesn't."
        : "ACR spike: T3 showed no change either - sidecar mechanism is not working at " +
            "all here. Re-check T1 and ACR preferences before concluding."
    );
  }

  // T4 - local masks: does ACR apply mask corrections (incl. AI sky) on reload?
  // Only meaningful if T2's in-place reload worked. Uses the REAL serializer,
  // so a pass here validates the exact XML the applyCameraRaw executor writes.
  if (t2Changed === true) {
    const maskSettings = {
      // Neutral globals so ONLY the masked regions should change vs look B...
      // (they won't equal look B though - T4 resets globals - so judge by eye.)
      MaskGroupBasedCorrections: [
        {
          CorrectionName: "T4 Sky (AI)",
          LocalExposure2012: -1,
          LocalSaturation: 0.6,
          CorrectionMasks: [
            { What: "Mask/Image", MaskSubType: 2, MaskName: "Sky", ReferencePoint: "0.500000 0.250000" },
          ],
        },
        {
          CorrectionName: "T4 Left fade",
          LocalExposure2012: -0.8,
          CorrectionMasks: [
            { What: "Mask/Gradient", MaskName: "Left", FullX: 0, FullY: 0.5, ZeroX: 0.5, ZeroY: 0.5 },
          ],
        },
      ],
    };
    await writeTextFile(sidecarPath, serialize(maskSettings));
    say("ACR spike: T4 - sidecar rewritten with LOCAL MASKS (AI sky: very dark+saturated; linear left fade: dark). Replacing contents…");

    const token4 = localFileSystem.createSessionToken(entry);
    await core.executeAsModal(async () => replaceContents(token4), {
      commandName: "CreaCon spike: T4 masks",
    });
    registry.updateSettings(placedId, maskSettings);
    const previewT4 = await capturePreviewImage();
    const t4Changed = previewT2 && previewT4 ? previewT2 !== previewT4 : null;
    say(
      "ACR spike: T4 " +
        (t4Changed === false ? "pixels did NOT change - masks were ignored. " : "applied. ") +
        "LOOK AT THE CANVAS and judge each mask type separately: " +
        "(1) Is the SKY dramatically dark/saturated while the ground is normal? " +
        "-> AI masks work headlessly (the big win). " +
        "(2) Does the LEFT HALF fade to dark? -> geometric masks work. " +
        "If only (2) holds, AI masks need the ACR dialog - report that and " +
        "we'll disable Mask/Image in the vocabulary while keeping gradients."
    );
  }

  say(
    "ACR spike: done. The spike's test sidecar remains at " +
      sidecarPath +
      (existing !== null ? " (your original is in the .creacon-backup file)." : ".")
  );
}

module.exports = { runAcrReloadSpike };
