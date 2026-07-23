// Serializes/parses Camera Raw develop settings as XMP sidecar files.
//
// This is the entire "API" to Camera Raw: ACR cannot be driven imperatively
// (its filter dialog ignores scripted settings), but it reads the sidecar
// .xmp next to a raw file whenever the raw is (re)imported. So CreaCon
// controls ACR declaratively - write the sidecar, then force a re-import
// (see cameraRaw.js). Proven by the spike in src/spike/acrReloadSpike.js.
//
// Reading goes through THREE fidelity layers so nothing the user (or
// Lightroom, or ACR itself) writes is ever silently destroyed:
//   1. model-visible settings  - our schema vocabulary (flat keys + mask
//      corrections); the LLM merges its changes on top of these.
//   2. executor-preserved extras - attributes we don't model (AI-mask
//      digests, LocalColorGrade*, root keys like SharpenRadius...), carried
//      byte-exact from the current sidecar into the next write.
//   3. opaque fragments - whole corrections we can't model as attributes
//      (brush Dabs, range masks, local curves): kept as verbatim XML and
//      re-emitted; the model sees only { CorrectionName, Unsupported: true }.
//
// The key names are Adobe's own crs: vocabulary (the same one Lightroom
// presets use). Ground truth for conventions: real ACR 18.4 sidecars written
// on this machine (see the project README's development notes).

// Flat (scalar-attribute) vocabulary: Basic panel + HSL mixer + color grading
// + detail + effects. Must stay in sync with the applyCameraRaw.settings
// properties in the schema.
const HSL_KEYS = ["Red", "Orange", "Yellow", "Green", "Aqua", "Blue", "Purple", "Magenta"].flatMap(
  (hue) => [`HueAdjustment${hue}`, `SaturationAdjustment${hue}`, `LuminanceAdjustment${hue}`]
);

const SETTING_KEYS = [
  "Exposure2012",
  "Contrast2012",
  "Highlights2012",
  "Shadows2012",
  "Whites2012",
  "Blacks2012",
  "Texture",
  "Clarity2012",
  "Dehaze",
  "Vibrance",
  "Saturation",
  "Temperature",
  "Tint",
  ...HSL_KEYS,
  "SplitToningShadowHue",
  "SplitToningShadowSaturation",
  "SplitToningHighlightHue",
  "SplitToningHighlightSaturation",
  "SplitToningBalance",
  "ColorGradeBlending",
  "Sharpness",
  "LuminanceSmoothing",
  "ColorNoiseReduction",
  "GrainAmount",
  "PostCropVignetteAmount",
];

// Schema vocabulary for corrections and masks (model-visible). Anything else
// found in a sidecar is preserved as executor-side extras.
const CORRECTION_KEYS = [
  "CorrectionName",
  "CorrectionAmount",
  "CorrectionActive",
  "LocalExposure2012",
  "LocalContrast2012",
  "LocalHighlights2012",
  "LocalShadows2012",
  "LocalWhites2012",
  "LocalBlacks2012",
  "LocalClarity2012",
  "LocalDehaze",
  "LocalTexture",
  "LocalSaturation",
  "LocalTemperature",
  "LocalTint",
  "LocalSharpness",
];

const MASK_KEYS = [
  "What",
  "MaskName",
  "MaskInverted",
  "MaskValue",
  "MaskBlendMode",
  "MaskSubType",
  "ReferencePoint",
  "Top",
  "Left",
  "Bottom",
  "Right",
  "Angle",
  "Midpoint",
  "Feather",
  "Roundness",
  "Flipped",
  "ZeroX",
  "ZeroY",
  "FullX",
  "FullY",
];

// Always-positive keys that ACR writes unsigned (no "+" prefix convention).
const UNSIGNED_KEYS = new Set([
  "Temperature",
  "SplitToningShadowHue",
  "SplitToningShadowSaturation",
  "SplitToningHighlightHue",
  "SplitToningHighlightSaturation",
  "ColorGradeBlending",
  "Sharpness",
  "LuminanceSmoothing",
  "ColorNoiseReduction",
  "GrainAmount",
]);

// Root attrs we own or that must not be duplicated from a parsed file.
const ROOT_ATTR_EXCLUDE = new Set([
  ...SETTING_KEYS,
  "Version",
  "ProcessVersion",
  "CompatibleVersion",
  "WhiteBalance",
  "HasSettings",
]);

// Root-level structural crs elements we don't model but must not destroy
// (a manual tone-curve edit lives here, for example).
const ROOT_ELEMENT_TAGS = [
  "crs:ToneCurvePV2012",
  "crs:ToneCurvePV2012Red",
  "crs:ToneCurvePV2012Green",
  "crs:ToneCurvePV2012Blue",
  "crs:PointColors",
  "crs:ColorVariance",
  "crs:Look",
  "crs:LensBlur",
  "crs:DepthMapInfo",
  "crs:RetouchAreas",
];

function sidecarPathFor(rawPath) {
  return rawPath.replace(/\.[^./\\]+$/, ".xmp");
}

// ACR's own convention: explicit "+" on positive values of SIGNED sliders.
// Exposure is the one fractional global slider; everything else is an integer.
// Always-positive keys (Kelvin, hues, amounts) are written unsigned.
function formatValue(key, value) {
  const num = Number(value);
  const text = key === "Exposure2012" ? num.toFixed(2) : String(Math.round(num));
  return num > 0 && !UNSIGNED_KEYS.has(key) ? `+${text}` : text;
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Integer-formatted mask keys (ACR writes these unpadded); other numbers get
// ACR's 6-decimal float convention.
const INT_MASK_KEYS = new Set(["MaskBlendMode", "MaskSubType", "Midpoint", "Feather", "Roundness", "Angle"]);

function maskAttr(key, value) {
  if (typeof value === "boolean") return `crs:${key}="${value}"`;
  if (typeof value === "number") {
    const text =
      Number.isInteger(value) && INT_MASK_KEYS.has(key) ? String(value) : value.toFixed(6);
    return `crs:${key}="${text}"`;
  }
  return `crs:${key}="${escapeXml(value)}"`;
}

// Deterministic 32-hex "GUID" from a seed string (4x salted FNV-1a). Real ACR
// sidecars carry CorrectionSyncID/MaskSyncID GUIDs, and ACR caches computed AI
// masks keyed by them. We derive IDs from the correction's IDENTITY (name +
// mask type) rather than random, so the same conceptual mask keeps the same ID
// across applies -> ACR can reuse its cached AI segmentation instead of
// demanding "Update AI settings" after every apply. Verified: ACR preserves
// these IDs through its own sidecar rewrites, so they double as the join key
// for the preserved extras (which include ACR's original IDs for manual masks,
// overriding ours at serialize time).
function stableId(seed) {
  let out = "";
  for (let i = 0; i < 4; i++) {
    let h = (0x811c9dc5 ^ i) >>> 0;
    const s = `${seed} ${i}`;
    for (let j = 0; j < s.length; j++) {
      h ^= s.charCodeAt(j);
      h = Math.imul(h, 0x01000193);
    }
    out += (h >>> 0).toString(16).padStart(8, "0");
  }
  return out.toUpperCase();
}

// Content hash for external-change detection (did something other than
// CreaCon rewrite the sidecar since we last wrote it?).
function hashText(text) {
  return stableId(`hash:${text.length}:${text}`);
}

function correctionSeed(name, index) {
  return `correction:${name || `correction-${index}`}`;
}

function maskSeed(correctionKey, maskIndex, what, subType) {
  return `mask:${correctionKey}:${maskIndex}:${what}:${subType || ""}`;
}

// --- low-level XML helpers ----------------------------------------------------

function parseAttrs(tagText) {
  const attrs = {};
  const re = /crs:([A-Za-z0-9]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(tagText)) !== null) attrs[m[1]] = m[2];
  return attrs;
}

function coerce(raw) {
  if (raw === "true" || raw === "True") return true;
  if (raw === "false" || raw === "False") return false;
  const num = Number(raw.replace(/^\+/, ""));
  return Number.isFinite(num) && raw.trim() !== "" ? num : raw;
}

// First <tag ...>...</tag> occurrence (no same-tag nesting expected).
function extractElement(xml, tag) {
  let open = xml.indexOf(`<${tag}>`);
  if (open === -1) open = xml.indexOf(`<${tag} `);
  if (open === -1) return null;
  const close = xml.indexOf(`</${tag}>`, open);
  if (close === -1) return null;
  const innerStart = xml.indexOf(">", open) + 1;
  return {
    outer: xml.slice(open, close + `</${tag}>`.length),
    inner: xml.slice(innerStart, close),
  };
}

// Slices the top-level <rdf:li>…</rdf:li> blocks of a Seq, tolerating nested
// rdf:li (masks inside corrections) via depth counting. Self-closing lis at
// top level are returned as-is.
function topLevelLiBlocks(seqText) {
  const blocks = [];
  const re = /<rdf:li\b[^>]*?(\/?)>|<\/rdf:li>/g;
  let depth = 0;
  let start = -1;
  let m;
  while ((m = re.exec(seqText)) !== null) {
    const isClose = m[0].startsWith("</");
    const selfClosing = m[1] === "/";
    if (isClose) {
      depth--;
      if (depth === 0 && start !== -1) {
        blocks.push(seqText.slice(start, m.index + m[0].length));
        start = -1;
      }
    } else if (selfClosing) {
      if (depth === 0) blocks.push(m[0]);
    } else {
      if (depth === 0) start = m.index;
      depth++;
    }
  }
  return blocks;
}

// --- parsing -------------------------------------------------------------------

function parseFlatSettings(xml) {
  const settings = {};
  const re = /crs:([A-Za-z0-9]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const [, key, raw] = m;
    if (!SETTING_KEYS.includes(key)) continue;
    const num = Number(raw.replace(/^\+/, ""));
    if (Number.isFinite(num) && settings[key] === undefined) settings[key] = num;
  }
  return settings;
}

// One correction rdf:li block -> model-visible correction (or Unsupported
// stub) + extras entries. Returns null for unparseable blocks.
function parseCorrection(liBlock, index, extras) {
  const descOpen = liBlock.match(/<rdf:Description\b[^>]*>/);
  if (!descOpen) return null;
  const attrs = parseAttrs(descOpen[0]);
  const name = attrs.CorrectionName || `Manual adjustment ${index + 1}`;

  const descClose = liBlock.lastIndexOf("</rdf:Description>");
  const inner = liBlock.slice(liBlock.indexOf(descOpen[0]) + descOpen[0].length, descClose);

  // Supported = the ONLY child element is CorrectionMasks whose items are all
  // attribute-only (self-closing) rdf:li masks. Anything else (local curves,
  // brush Dabs, range masks, point colors) -> opaque verbatim passthrough.
  const cm = extractElement(inner, "crs:CorrectionMasks");
  const remainder = cm ? inner.replace(cm.outer, "") : inner;
  const maskLis = cm ? cm.inner.match(/<rdf:li\b[^>]*\/>/g) || [] : [];
  const maskCount = cm ? (cm.inner.match(/<rdf:li\b/g) || []).length : 0;
  const supported = cm !== null && !/<\w/.test(remainder) && maskLis.length === maskCount && maskLis.length > 0;

  if (!supported) {
    extras.opaqueByName[name] = liBlock;
    return { CorrectionName: name, Unsupported: true };
  }

  const correctionKey = attrs.CorrectionName || `correction-${index}`;
  const detCorrId = stableId(correctionSeed(attrs.CorrectionName, index));
  const correction = {};
  const preservedCorr = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (CORRECTION_KEYS.includes(key)) correction[key] = coerce(value);
    else if (key !== "What") preservedCorr[key] = value; // incl. original CorrectionSyncID
  }
  if (Object.keys(preservedCorr).length) extras.correctionAttrs[detCorrId] = preservedCorr;

  correction.CorrectionMasks = maskLis.map((liTag, mi) => {
    const maskAttrs = parseAttrs(liTag);
    const mask = {};
    const preservedMask = {};
    for (const [key, value] of Object.entries(maskAttrs)) {
      if (MASK_KEYS.includes(key)) mask[key] = coerce(value);
      else preservedMask[key] = value; // MaskSyncID, Version, digests, geometry extras...
    }
    if (Object.keys(preservedMask).length) {
      const detMaskId = stableId(maskSeed(correctionKey, mi, maskAttrs.What, maskAttrs.MaskSubType));
      extras.maskAttrs[detMaskId] = preservedMask;
    }
    return mask;
  });

  return correction;
}

function emptyExtras() {
  return { rootAttrs: {}, rootElements: [], correctionAttrs: {}, maskAttrs: {}, opaqueByName: {} };
}

// Full-fidelity read: { settings, extras }. `settings` is what the model sees
// and merges; `extras` is everything else, re-attached verbatim on serialize.
function parseFull(xml) {
  const settings = parseFlatSettings(xml);
  const extras = emptyExtras();

  // Non-schema crs attrs on the root rdf:Description (SharpenRadius,
  // CameraProfile, Parametric*, ...) - preserved so manual/global state we
  // don't model survives our rewrites.
  const rootOpen = xml.match(/<rdf:Description\b[^>]*>/);
  if (rootOpen) {
    for (const [key, value] of Object.entries(parseAttrs(rootOpen[0]))) {
      if (!ROOT_ATTR_EXCLUDE.has(key)) extras.rootAttrs[key] = value;
    }
  }

  for (const tag of ROOT_ELEMENT_TAGS) {
    const el = extractElement(xml, tag);
    if (el) extras.rootElements.push(el.outer);
  }

  const maskGroup = extractElement(xml, "crs:MaskGroupBasedCorrections");
  if (maskGroup) {
    const corrections = [];
    topLevelLiBlocks(maskGroup.inner).forEach((block, i) => {
      const parsed = parseCorrection(block, i, extras);
      if (parsed) corrections.push(parsed);
    });
    if (corrections.length) settings.MaskGroupBasedCorrections = corrections;
  }

  return { settings, extras };
}

// Flat-only convenience (import notes, spikes).
function parse(xml) {
  return parseFlatSettings(xml);
}

// --- serialization ---------------------------------------------------------------

// Serializes MaskGroupBasedCorrections (schema shape = ACR's native shape) into
// the nested RDF element ACR expects: corrections as rdf:li/rdf:Description,
// masks as attribute-only rdf:li items. extras re-attaches preserved
// attributes (they win over ours - e.g. ACR's refined ReferencePoint and its
// original SyncIDs for manual masks) and emits opaque corrections verbatim.
function serializeMasks(corrections, extras) {
  const correctionItems = corrections
    .map((correction, ci) => {
      if (correction.Unsupported) {
        // Manual correction we can't model: verbatim passthrough (or drop it
        // if the fragment is gone - nothing sensible to emit).
        return extras.opaqueByName[correction.CorrectionName] || null;
      }

      const correctionKey = correction.CorrectionName || `correction-${ci}`;
      const detCorrId = stableId(correctionSeed(correction.CorrectionName, ci));
      const attrs = ['crs:What="Correction"'];
      const withDefaults = {
        CorrectionAmount: 1,
        CorrectionActive: true,
        CorrectionSyncID: detCorrId,
        ...correction,
        ...(extras.correctionAttrs[detCorrId] || {}),
      };
      for (const [key, value] of Object.entries(withDefaults)) {
        if (key === "CorrectionMasks" || key === "Unsupported") continue;
        attrs.push(maskAttr(key, value));
      }

      const maskItems = (correction.CorrectionMasks || [])
        .map((mask, mi) => {
          const isRadial = mask.What === "Mask/CircularGradient";
          const detMaskId = stableId(maskSeed(correctionKey, mi, mask.What, mask.MaskSubType));
          const withMaskDefaults = {
            MaskActive: true,
            MaskBlendMode: 0,
            MaskInverted: false,
            MaskValue: 1,
            // Radial conventions from ACR ground truth: Flipped=true means the
            // effect is INSIDE the ellipse (the normal case - omitting it put
            // the effect outside, which read as "mask not applied").
            ...(isRadial
              ? { Angle: 0, Midpoint: 50, Roundness: 0, Feather: 50, Flipped: true, Version: "2" }
              : {}),
            MaskSyncID: detMaskId,
            ...mask,
            ...(extras.maskAttrs[detMaskId] || {}),
          };
          const maskAttrs = Object.entries(withMaskDefaults).map(([k, v]) => maskAttr(k, v));
          return `        <rdf:li\n         ${maskAttrs.join("\n         ")}/>`;
        })
        .join("\n");

      return `    <rdf:li>
     <rdf:Description
      ${attrs.join("\n      ")}>
      <crs:CorrectionMasks>
       <rdf:Seq>
${maskItems}
       </rdf:Seq>
      </crs:CorrectionMasks>
     </rdf:Description>
    </rdf:li>`;
    })
    .filter(Boolean)
    .join("\n");

  return `   <crs:MaskGroupBasedCorrections>
    <rdf:Seq>
${correctionItems}
    </rdf:Seq>
   </crs:MaskGroupBasedCorrections>`;
}

// Full-state semantics: the given settings ARE the develop state - no merging
// here (the model merges; see the full-state rule in backend/prompt.py).
// extras (from parseFull of the current sidecar) carries forward everything
// the model doesn't manage.
function serialize(settings, extras = emptyExtras()) {
  const lines = [];
  for (const key of SETTING_KEYS) {
    if (settings[key] !== undefined && settings[key] !== null) {
      lines.push(`    crs:${key}="${formatValue(key, settings[key])}"`);
    }
  }
  // Temperature/Tint are ignored by ACR unless WhiteBalance is "Custom".
  if (settings.Temperature !== undefined || settings.Tint !== undefined) {
    lines.push('    crs:WhiteBalance="Custom"');
  }
  // Preserved root attrs (already XML-escaped - they came out of valid XML).
  for (const [key, value] of Object.entries(extras.rootAttrs || {})) {
    lines.push(`    crs:${key}="${value}"`);
  }

  const corrections = settings.MaskGroupBasedCorrections;
  const hasMasks = Array.isArray(corrections) && corrections.length > 0;
  const rootElements = extras.rootElements || [];
  const children = [
    ...rootElements.map((el) => `   ${el}`),
    ...(hasMasks ? [serializeMasks(corrections, extras)] : []),
  ];
  const descriptionBody = children.length
    ? `>\n${children.join("\n")}\n  </rdf:Description>`
    : "/>";

  return `<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    crs:Version="17.0"
    crs:ProcessVersion="15.4"
    crs:HasSettings="True"
${lines.join("\n")}${descriptionBody}
 </rdf:RDF>
</x:xmpmeta>
`;
}

// True if the given settings contain at least one AI mask (Mask/Image) whose
// deterministic MaskSyncID has no preserved MaskDigest in extras - i.e. ACR
// has never computed it. `extras` must come from parsing the sidecar as it
// stood BEFORE this write (the harvested state applyCameraRaw carries
// forward). A mask whose identity (correction name + index + type + subtype)
// is unchanged from a previous apply keeps its digest and does NOT need
// recomputing - only genuinely new/changed AI masks do. Used to decide
// whether re-opening Camera Raw is actually necessary, instead of opening it
// any time a plan merely CONTAINS an AI mask (which re-triggers it needlessly
// on every follow-up apply that just tweaks the same mask's values).
function hasUncomputedAiMasks(settings, extras) {
  const corrections = settings.MaskGroupBasedCorrections || [];
  return corrections.some((correction, ci) => {
    if (correction.Unsupported) return false;
    const correctionKey = correction.CorrectionName || `correction-${ci}`;
    return (correction.CorrectionMasks || []).some((mask, mi) => {
      if (mask.What !== "Mask/Image") return false;
      const syncId = stableId(maskSeed(correctionKey, mi, mask.What, mask.MaskSubType));
      const preserved = (extras && extras.maskAttrs && extras.maskAttrs[syncId]) || null;
      return !preserved || !preserved.MaskDigest;
    });
  });
}

module.exports = {
  SETTING_KEYS,
  sidecarPathFor,
  serialize,
  serializeMasks,
  parse,
  parseFull,
  hashText,
  hasUncomputedAiMasks,
};
