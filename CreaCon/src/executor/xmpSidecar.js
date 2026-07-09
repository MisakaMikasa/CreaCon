// Serializes/parses Camera Raw develop settings as XMP sidecar files.
//
// This is the entire "API" to Camera Raw: ACR cannot be driven imperatively
// (its filter dialog ignores scripted settings), but it reads the sidecar
// .xmp next to a raw file whenever the raw is (re)imported. So CreaCon
// controls ACR declaratively - write the sidecar, then force a re-import
// (see cameraRaw.js). Proven by the T1/T2 spike in src/spike/acrReloadSpike.js.
//
// The key names are Adobe's own crs: vocabulary (the same one Lightroom
// presets use), so this list can grow toward HSL/color-grading/masks later
// by adding keys here + in schema/editPlan.schema.json.

// Flat (scalar-attribute) vocabulary: Basic panel + HSL mixer + color grading
// + detail + effects. Must stay in sync with the applyCameraRaw.settings
// properties in the schema. Local masks are handled separately
// (MaskGroupBasedCorrections - a nested element, not an attribute).
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

// Attribute formatting inside mask corrections: ACR writes these as 6-decimal
// floats (booleans/ints/strings as themselves).
function maskAttr(key, value) {
  if (typeof value === "boolean") return `crs:${key}="${value}"`;
  if (typeof value === "number") {
    const text = Number.isInteger(value) && ["MaskBlendMode", "MaskSubType"].includes(key)
      ? String(value)
      : value.toFixed(6);
    return `crs:${key}="${text}"`;
  }
  return `crs:${key}="${escapeXml(value)}"`;
}

// Serializes MaskGroupBasedCorrections (schema shape = ACR's native shape) into
// the nested RDF element ACR expects: corrections as rdf:li/rdf:Description
// (they contain the CorrectionMasks child element), masks as attribute-only
// rdf:li items - mirroring the structures real sidecars use (and that
// JarvisArt's xmp_converter.py parses).
function serializeMasks(corrections) {
  const correctionItems = corrections
    .map((correction) => {
      const attrs = ['crs:What="Correction"'];
      // Defaults ACR expects to be explicit.
      const withDefaults = { CorrectionAmount: 1, CorrectionActive: true, ...correction };
      for (const [key, value] of Object.entries(withDefaults)) {
        if (key === "CorrectionMasks") continue;
        attrs.push(maskAttr(key, value));
      }

      const maskItems = (correction.CorrectionMasks || [])
        .map((mask) => {
          const withMaskDefaults = {
            MaskActive: true,
            MaskBlendMode: 0,
            MaskInverted: false,
            MaskValue: 1,
            ...mask,
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
    .join("\n");

  return `   <crs:MaskGroupBasedCorrections>
    <rdf:Seq>
${correctionItems}
    </rdf:Seq>
   </crs:MaskGroupBasedCorrections>`;
}

// Full-state semantics: the given settings ARE the develop state - no merging
// here (the model merges; see the full-state rule in backend/prompt.py).
// MaskGroupBasedCorrections (if any) becomes a nested child element, which
// requires the open <rdf:Description>...</rdf:Description> form.
function serialize(settings) {
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

  const corrections = settings.MaskGroupBasedCorrections;
  const hasMasks = Array.isArray(corrections) && corrections.length > 0;
  const descriptionBody = hasMasks
    ? `>\n${serializeMasks(corrections)}\n  </rdf:Description>`
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

// Extracts our known keys from any sidecar XML (attribute-style crs:, which is
// how ACR/Lightroom write scalars). Unknown keys are ignored - the context
// shown to the model stays within the vocabulary it's allowed to emit.
function parse(xml) {
  const settings = {};
  const re = /crs:([A-Za-z0-9]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const [, key, raw] = m;
    if (!SETTING_KEYS.includes(key)) continue;
    const num = Number(raw.replace(/^\+/, ""));
    if (Number.isFinite(num)) settings[key] = num;
  }
  return settings;
}

module.exports = { SETTING_KEYS, sidecarPathFor, serialize, serializeMasks, parse };
