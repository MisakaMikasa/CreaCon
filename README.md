# CreaCon — an AI photo-editing agent inside Adobe Photoshop

CreaCon is a Photoshop plugin that lets you edit photos by talking to an AI. You describe what
you want ("make this warmer and more cinematic, but keep it natural", "dim only the left 25%",
"boost the blues in the sky") and the agent plans and performs the edit **as real, editable
Photoshop operations** — adjustment layers, masks, groups, blend modes — never a flattened,
opaque result.

The core idea: most AI photo tools *generate* a new image. CreaCon instead **operates the
software the way a retoucher would**, so every edit it makes remains inspectable, tweakable,
and reversible in the Layers panel afterward. The AI proposes; you approve; Photoshop executes.

## How it works

```
┌────────────────────┐  chat + canvas JPEG   ┌──────────────────┐   messages    ┌─────────────┐
│  Photoshop (UXP)   │  + layer context      │  FastAPI backend │──────────────▶│ Gemini or   │
│  chat panel        │──────────────────────▶│  /chat           │◀──────────────│ Claude      │
│                    │◀──────────────────────│  validate plan   │  reply +      └─────────────┘
│  plan card         │   reply + edit plan   │  (JSON Schema)   │  ```json plan
│  [Apply] [Cancel]  │                       └──────────────────┘
│        │ Apply                                      ▲
│        ▼                                            │
│  executor: batchPlay / DOM API ── applied result fed back into the conversation
└────────────────────┘
```

1. **You chat.** The panel sends the conversation, a JPEG preview of your canvas (so the model
   *sees* the photo), and the current layer stack + selection to the backend.
2. **The model talks or acts.** It can discuss/suggest freely; when you want changes applied,
   it emits a structured edit plan (a fenced JSON block matching a strict schema).
3. **The plan is validated twice** — against the JSON Schema on the backend (with one
   self-correcting retry if the model produced an invalid plan) and structurally again in the
   plugin.
4. **You approve.** The plan renders as a step list with Apply/Cancel. Nothing touches your
   document without a click.
5. **The plugin executes** each step live via Photoshop's batchPlay/DOM APIs, staggered so you
   can watch the layers appear. The whole edit is one History entry — a single Ctrl/Cmd+Z
   undoes it — and the result ("Applied: …") is fed back into the conversation so you can
   iterate ("make that curve gentler", "move the vignette left").

## What's currently supported

### Operations (7)

| Op | Description |
|---|---|
| `createAdjustmentLayer` | Create an adjustment layer with real settings applied |
| `updateAdjustmentLayer` | Modify an **existing** adjustment layer in place (refinements don't stack duplicates) |
| `addMask` | Constrain a layer's effect to part of the image |
| `setBlendMode` | Set a layer's blend mode (18 modes: multiply, screen, overlay, softLight, color, luminosity, …) |
| `setLayerOpacity` | Set layer opacity 0–100 |
| `renameLayer` | Rename a layer |
| `createGroup` | Group layers into a folder (searches nested layers) |
| `applyCameraRaw` | Develop a RAW photo (true raw latitude) by rewriting its XMP sidecar and re-importing — see below |

### Adjustment types (6)

| Type | Settings the AI controls |
|---|---|
| `brightnessContrast` | brightness, contrast |
| `hueSaturation` | hue / saturation / lightness — on **master or a single color range** (reds…magentas) |
| `colorBalance` | shadow/midtone/highlight color triples (warm/cool grading) |
| `vibrance` | vibrance, saturation |
| `exposure` | exposure (stops), offset, gamma |
| `curves` | point-based curve `[[in,out],…]`, per channel (composite/R/G/B) |

### Mask types (6)

| Type | Controls |
|---|---|
| `selectSubject` | Photoshop's built-in AI subject selection |
| `selectSky` | Photoshop's built-in sky selection |
| `linearGradient` | `direction` (left/right/top/bottom) **or** arbitrary `angle` (diagonals), `size` (how far the fade reaches — e.g. "only the left 25%"), `strength` |
| `radialGradient` | `center` [x,y] (the AI estimates the subject's position from the preview), `size` (radius), `region` (center spotlight vs edge vignette), `strength` |
| `full` / `invert` | Whole-image masks |

### RAW develop editing (Camera Raw via XMP sidecar)

Adobe Camera Raw cannot be scripted directly (its filter dialog ignores scripted settings —
a longstanding, deliberate limitation). CreaCon controls it **declaratively** instead: the
`applyCameraRaw` op writes the complete develop state (exposure, highlights/shadows, true
Kelvin white balance, texture/clarity/dehaze, vibrance/saturation — Adobe's `crs:` keys)
into the raw file's `.xmp` sidecar, then forces a re-import so ACR re-develops the photo
with the new settings. The re-import is `placedLayerRelinkToFile` (re-pointing the link at
the same raw) — NOT `placedLayerReplaceContents`, which silently converts the linked smart
object to embedded and breaks the manual-edit merge; replaceContents remains only as the
fallback for legacy embedded layers. Linked-ness is detected via `smartObject.linked` on
the full layer descriptor (`smartObjectMore.link` never carries it). Verified end-to-end
by the spike harnesses in `CreaCon/src/spike/` (kept as unwired dev tools — re-attach to a
button if the mechanism ever needs re-testing).

Flow: click **📷 Open RAW** in the panel (this places the raw as a **linked** smart object
and records its file path), then just chat: *"recover the highlights and make it warmer"*.
Linked placement is deliberate and spike-verified: manual edits made by double-clicking the
layer into ACR are written to the **same sidecar** CreaCon uses, so hand edits and AI edits
merge instead of overwriting each other (global settings today; masks once parse-back
lands). The trade: the raw file must stay at its path (a dependency the sidecar mechanism
has anyway) and the PSD alone isn't portable — keep the raws with it.

The develop vocabulary covers the Basic panel, the full **HSL color mixer**, **color
grading** (split toning), detail (sharpen/NR), grain/vignette, and **local masks** —
each `MaskGroupBasedCorrections` entry is a region (AI **sky/subject/person** via
`Mask/Image`, linear `Mask/Gradient`, radial `Mask/CircularGradient`) carrying its own
develop values (`LocalExposure2012` etc., normalized −1..+1). The mask vocabulary and
units follow Adobe's own `crs:` conventions (cross-checked against JarvisArt's).

**Routing doctrine** (encoded in `backend/prompt.py`):

| Edit intent | Route |
|---|---|
| Global tone / WB / HSL / grading / detail on a RAW layer | `applyCameraRaw` flat keys |
| Regional tone/color on RAW (sky, subject, gradients) | `applyCameraRaw` local masks |
| Anything on JPEG/PSD documents | adjustment layers + masks |
| Discrete toggleable layers, blend modes, groups | PS-native ops, even on raw docs |

Limitations:

- RAW files only (CR2/CR3/NEF/ARW/RAF/ORF/RW2). JPEG/PSD documents keep the
  adjustment-layer path. **DNG is not supported** (it embeds settings inside the file).
- Raw smart objects created *outside* CreaCon (e.g. ACR's own "Open as Smart Object")
  can't be develop-edited — their source path is unrecoverable. Use 📷 Open RAW.
- The path registry persists across sessions (`rawRegistry.json` in the plugin data
  folder, keyed by document path → layer ID, so multiple raws per document are fine).
  Caveats: raws imported into a **never-saved** document are tracked for the current
  session only (saving the document makes them permanent), and **Save As** to a new
  path orphans the mapping — re-import via 📷 in that case.
- Import applies no edits of its own; when a raw arrives with existing develop settings,
  the user chooses at import time to keep them (fully read back, masks included) or start
  fresh (timestamped backup + restorable via chat).
- Ctrl+Z undoes the visual change but not the sidecar file; the model always sees the
  sidecar's current state and can revert by re-applying previous settings.
- Requires ACR preference "Save image settings in: **Sidecar '.xmp' files**".
- Manual edits (ACR dialog on the linked layer, or Lightroom) are detected via a content
  hash and merged: the sidecar on disk is always the truth, masks included. Manual
  adjustments CreaCon can't model (brush strokes, range masks, local curves, local color
  grading) are preserved verbatim across applies and surfaced to the AI as
  `"Unsupported": true` corrections it must copy forward.
- **AI masks** (sky/subject/person) load with the sidecar, but each **new** mask needs one
  manual **"Update AI settings"** click in ACR to run the segmentation (no scriptable
  trigger exists — Adobe's design). After that, ACR's computed digests are preserved
  through CreaCon rewrites, so value tweaks don't re-prompt. Geometric masks
  (linear/radial) are fully headless. Person masks (`MaskSubType` 3) require an actual
  person in the frame — ACR errors otherwise; the prompt steers the model accordingly.

### Agent capabilities

- **Vision-grounded**: the model receives a JPEG of the current canvas each turn, so it reasons
  about the actual photo (dominant colors, subject position) — not just your words.
- **Layer-aware**: knows every layer's name and which are selected; vague targets ("this
  layer") resolve to your selection.
- **Conversational refinement**: applied results are injected back into the chat, so
  "stronger", "other side", "make the circle bigger" work as follow-ups.
- **Dual LLM providers**: Google Gemini and Anthropic Claude behind a common adapter —
  switch with one line in `.env` (`LLM_PROVIDER=gemini|anthropic`).
- **Robust plan handling**: tolerant JSON extraction (handles unclosed/missing code fences),
  schema validation, and a single corrective retry that feeds the exact validation error back
  to the model. Never loops.

## Getting started

### 1. Backend

```
cd backend
python -m venv .venv
.venv\Scripts\activate            # Windows; source .venv/bin/activate elsewhere
pip install -r requirements.txt
copy .env.example .env            # fill in your provider + API key
uvicorn main:app --reload --port 8000
```

`.env` picks the provider: set `LLM_PROVIDER` to `gemini` or `anthropic` and supply the
matching API key. Only the SDK for the provider you use needs credentials.

### 2. Plugin

1. Open Photoshop (v27.8+) with any image.
2. In **UXP Developer Tools**: *Add Plugin* → select `CreaCon/manifest.json` → *Load*.
3. The CreaCon panel opens. Type a request, review the proposed plan, press **Apply**.

## Repository layout

```
schema/editPlan.schema.json   # THE contract: single source of truth for what a valid edit is
scripts/sync-schema.js        # copies the schema into the plugin bundle (UXP can't require() outside it)
backend/
  main.py                     # FastAPI routes: /chat (conversational) + /edit-plan (legacy one-shot)
  llm_client.py               # provider dispatcher (lazy imports)
  llm_providers/              # anthropic_provider.py, gemini_provider.py
  prompt.py                   # system prompts; embeds the schema + op/settings contract
  plan_extract.py             # tolerant fenced-JSON plan extraction + validation
  validator.py                # jsonschema enforcement
CreaCon/                      # the UXP plugin
  src/panel.js                # chat UI, plan cards, Apply gate
  src/aiClient.js             # canvas JPEG capture + layer context + /chat call
  src/validator.js            # client-side structural re-check (derived from the schema)
  src/executor/               # one module per op; batchPlay + DOM API execution
```

The schema is deliberately the **single source of truth**: it is handed to the LLM (as a tool
schema or embedded in the prompt), enforced by the backend validator, and drives the plugin's
own pre-execution check — three consumers, one definition, no drift.

## Development notes

- **Schema changes**: edit `schema/editPlan.schema.json`, then run `node scripts/sync-schema.js`
  and reload the plugin.
- **Debugging the plugin**: UXP Developer Tools → ••• → *Debug*, filter the console by
  `CreaCon`. Every executor logs the exact batchPlay descriptor sent and the result Photoshop
  returned.
- **batchPlay descriptors are verified, not guessed.** Photoshop's ActionDescriptor format is
  under-documented and a wrong descriptor often silently no-ops. The workflow that works:
  record the action manually in Photoshop (Actions panel → *Copy as Javascript*, requires
  developer mode), then diff the captured descriptor against what the executor logs.
  Hard-won specifics encoded in the executors:
  - Adjustment layers are born with a reveal-all mask — delete it before adding a mask from a
    selection (otherwise "Make" is unavailable and silently fails).
  - Hue/Saturation and Curves values must be applied via a follow-up `set` on the created
    layer (create-then-set); baking them into `make` does not apply them.
  - Gradient fills need `useMask: true` to paint the layer mask, and the `grayscale` color's
    `gray` field is an **ink percentage** — 0 is white, 100 is black.
- **Anything that mutates the document** must run inside `core.executeAsModal()` — including
  exporting the preview JPEG.

## Known limitations / roadmap

- No pixel-level or content-aware edits by design — the agent's vocabulary is intentionally
  the non-destructive toolset (this is a feature, but means no healing/retouch ops).
- The model sees the *composited* canvas, not per-layer thumbnails, so it can't visually
  identify which of several image layers contains what — targeting relies on names/selection.
- Color Range masks ("mask just the skin tones / brightest areas") — captured descriptor in
  hand, not yet wired up.
- Levels, Photo Filter, Black & White, Selective Color adjustment types not yet exposed.
- Responses are non-streaming (a thinking indicator plays during the request).
- Backend is a local dev server; CORS is wide open and there is no auth — do not deploy as-is.
