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

// Classifies one CorrectionMasks <rdf:li> block. Returns:
//   { maskAttrs, rangeAttrs: null } - a self-closing geometric/AI mask
//   { maskAttrs, rangeAttrs: {...} } - a luminance range mask (nested
//     rdf:Description carrying a self-closing CorrectionRangeMask child)
//   null - a nested mask form we don't model (brush Dabs, colour-range
//     PointModels, nested sub-mask groups) -> caller keeps the whole
//     correction as an opaque verbatim passthrough.
function classifyMaskBlock(block) {
  const trimmed = block.trim();
  // ONLY attribute-only (self-closing) geometric masks are model-editable.
  // Everything else is preserved verbatim (the whole correction becomes an
  // opaque passthrough the model can copy forward but not author or edit):
  //   - nested masks: luminance/colour RANGE masks, brush Dabs, sub-mask groups
  //   - AI/content masks (Mask/Image)
  // Range + AI masks are intentionally DISABLED here; the parser/serializer
  // still carry range-mask support (serializeRangeChild) so re-enabling is just
  // restoring them in the schema and returning them from this function.
  if (/<rdf:Description/.test(trimmed)) return null; // any nested mask -> verbatim
  const maskAttrs = parseAttrs(trimmed);
  if (maskAttrs.What === "Mask/Image" || maskAttrs.What === "Mask/RangeMask") return null;
  return { maskAttrs, rangeAttrs: null }; // self-closing geometric mask
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

  // Supported = the only child element is CorrectionMasks whose items are each
  // either an attribute-only (self-closing) mask (gradient/radial/AI) or a
  // luminance range mask (nested Description + a CorrectionRangeMask child).
  // Anything else (brush Dabs, colour-range PointModels, nested sub-mask
  // groups, local curves) -> opaque verbatim passthrough.
  const cm = extractElement(inner, "crs:CorrectionMasks");
  const remainder = cm ? inner.replace(cm.outer, "") : inner;
  const blocks = cm ? topLevelLiBlocks(cm.inner) : [];
  const classified = blocks.map(classifyMaskBlock);
  const supported =
    cm !== null && !/<\w/.test(remainder) && blocks.length > 0 && classified.every(Boolean);

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

  correction.CorrectionMasks = classified.map(({ maskAttrs, rangeAttrs }, mi) => {
    const mask = {};
    const preservedMask = {};
    for (const [key, value] of Object.entries(maskAttrs)) {
      if (MASK_KEYS.includes(key)) mask[key] = coerce(value);
      else preservedMask[key] = value; // MaskSyncID, MaskActive, Version, digests...
    }
    const detMaskId = stableId(maskSeed(correctionKey, mi, maskAttrs.What, maskAttrs.MaskSubType));
    if (Object.keys(preservedMask).length) extras.maskAttrs[detMaskId] = preservedMask;

    // Luminance range mask: expose Type/LumRange/Invert to the model, and
    // preserve ACR's computed Version/SampleType/LuminanceDepthSampleInfo as
    // extras so a byte-faithful copy round-trips even though the model can't
    // author those.
    if (rangeAttrs) {
      const rc = {};
      const preservedRange = {};
      for (const [key, value] of Object.entries(rangeAttrs)) {
        if (key === "Type") rc.Type = coerce(value);
        else if (key === "Invert") rc.Invert = coerce(value);
        else if (key === "LumRange") rc.LumRange = value.trim().split(/\s+/).map(Number);
        else preservedRange[key] = value; // Version, SampleType, LuminanceDepthSampleInfo
      }
      mask.CorrectionRangeMask = rc;
      if (Object.keys(preservedRange).length) extras.rangeMaskAttrs[detMaskId] = preservedRange;
    }
    return mask;
  });

  return correction;
}

function emptyExtras() {
  return {
    rootAttrs: {},
    rootElements: [],
    correctionAttrs: {},
    maskAttrs: {},
    rangeMaskAttrs: {},
    opaqueByName: {},
  };
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
// A luminance range mask's <crs:CorrectionRangeMask> child. The model supplies
// Type/LumRange/Invert; Version/SampleType/LuminanceDepthSampleInfo come from
// preserved extras (ACR-computed) when round-tripping, or from these defaults
// for a freshly authored mask.
function serializeRangeChild(range, preserved) {
  const withDefaults = { Version: 4, Type: 2, Invert: false, SampleType: 2, ...range, ...(preserved || {}) };
  const attrs = Object.entries(withDefaults).map(([key, value]) => {
    if (key === "LumRange") {
      const s = Array.isArray(value) ? value.map((n) => Number(n).toFixed(6)).join(" ") : String(value);
      return `crs:LumRange="${s}"`;
    }
    if (typeof value === "boolean") return `crs:${key}="${value}"`;
    if (typeof value === "number")
      return `crs:${key}="${Number.isInteger(value) ? value : value.toFixed(6)}"`;
    return `crs:${key}="${escapeXml(value)}"`;
  });
  return `         <crs:CorrectionRangeMask\n          ${attrs.join("\n          ")}/>`;
}

// One mask -> its <rdf:li>. Geometric/AI masks are attribute-only self-closing
// lis; a luminance range mask nests an rdf:Description carrying the
// CorrectionRangeMask child. Deterministic MaskSyncID + preserved extras keep
// ACR's cached digests/IDs attached across rewrites.
function serializeMask(mask, mi, correctionKey, extras) {
  const isRadial = mask.What === "Mask/CircularGradient";
  const isRange = mask.What === "Mask/RangeMask";
  const detMaskId = stableId(maskSeed(correctionKey, mi, mask.What, mask.MaskSubType));
  const withMaskDefaults = {
    MaskActive: true,
    MaskBlendMode: 0,
    MaskInverted: false,
    // Intersect/range components store MaskValue 0 in ACR ground truth; add
    // masks store 1.
    MaskValue: isRange ? 0 : 1,
    ...(isRadial
      ? { Angle: 0, Midpoint: 50, Roundness: 0, Feather: 50, Flipped: true, Version: "2" }
      : {}),
    MaskSyncID: detMaskId,
    ...mask,
    ...(extras.maskAttrs[detMaskId] || {}),
  };
  // CorrectionRangeMask is a child element, not an attribute - pull it aside.
  const rangeChild = withMaskDefaults.CorrectionRangeMask;
  delete withMaskDefaults.CorrectionRangeMask;
  const attrLines = Object.entries(withMaskDefaults).map(([k, v]) => maskAttr(k, v));

  if (isRange) {
    return `        <rdf:li>
         <rdf:Description
          ${attrLines.join("\n          ")}>
${serializeRangeChild(rangeChild || {}, extras.rangeMaskAttrs[detMaskId])}
         </rdf:Description>
        </rdf:li>`;
  }
  return `        <rdf:li\n         ${attrLines.join("\n         ")}/>`;
}

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
        .map((mask, mi) => serializeMask(mask, mi, correctionKey, extras))
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

module.exports = {
  SETTING_KEYS,
  sidecarPathFor,
  serialize,
  serializeMasks,
  parse,
  parseFull,
  hashText,
};
