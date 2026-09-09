# Proposal: auto-register linked photo layers, so 📷 stops being mandatory

Status: **proposal, not built.** Raised 2026-09-07.
Related: `engineering-notes/03-identity.md`, `04-working-copies.md`,
`01-camera-raw-control.md`.

---

## The friction

Today a photo is only editable if it was imported through **📷 Open RAW**.
Open a PSD someone else built, or one you placed a raw into by hand, and
CreaCon cannot see the photo at all.

That reads as a limitation of what CreaCon *knows*. It is not — it is a
limitation of what it will *admit to knowing*.

## What the code already does

`photoLayersIn()` (`cameraRaw.js:483`) already walks every layer in the
document and already asks Photoshop which file is behind each one:

```js
const info = await layerFileInfo(layer.id);
if (!info.isSmartObject) continue;

if (info.path) {
  const entry = await registry.photoFor(info.path);
  if (!entry) continue;            // <- a smart object CreaCon never imported
```

The path arrives fine. `layerFileInfo` (`cameraRaw.js:445`) reads
`smartObject.link._path` off the full descriptor — confirmed 2026-08-26, and
the reason the registry became path-keyed in the first place.

So discovery is not missing. The registry lookup is a gate standing in front
of a mechanism that already works.

The gate made sense when it was written. Under the old identity model an
EMBEDDED smart object retained no source path, so CreaCon had to have imported
a photo in order to know anything about it. That model is gone
(`rawRegistry.js:1-22`); the gate outlived it.

## So what does 📷 still do?

Three things. They are not equally load-bearing.

### 1. `establishAcrSession()` — real, but not tied to import

`cameraRaw.js:96`. Camera Raw writes settings back only for a file it holds an
editing session for. Without one, **edits the user makes in the ACR dialog
during an apply are silently discarded** — isolated by experiment, and the
notes say *do not remove it* in capitals.

But this needs *a session*, not an *import*. It could run once, lazily, before
the first develop of an auto-discovered layer. Same dialog, same cost to the
user, later in the flow.

### 2. JPEG working copies — the genuine blocker

`cameraRaw.js:188-195`. A JPEG stores its develop settings *inside the image
file*, so CreaCon edits a copy and never the user's original.

Auto-registering a JPEG the user placed themselves would mean **editing their
original in place.** That is a data-loss risk, not an inconvenience, and it is
the one case where the gate is doing real work.

### 3. Keep-or-fresh — a prompt, not a barrier

`cameraRaw.js:201-238`. On import the user chooses whether to keep a photo's
existing develop settings or start from camera defaults.

An auto-discovered photo can simply default to **keep**: `lastSettings: null`
already means "read the sidecar", and the sidecar is the source of truth every
turn regardless. Ask only if the user asks for something that would overwrite
settings they may not know are there.

## Proposal

| Layer | Behaviour |
|---|---|
| **Linked RAW** | Auto-register on discovery. Path is known, the sidecar is truth, the ACR session is established lazily before the first develop. |
| **JPEG** | Do NOT auto-register. Surface it: *"this JPEG isn't imported — import a copy so your original is never modified?"* One click, and it explains itself. |
| **Embedded SO** | Impossible, unchanged. No path exists to recover; that information was discarded at placement. |

Registry entries for auto-discovered raws hold less than imported ones, and
that is fine — most of what the table stores is either derivable or nullable:

| Field | Auto-discovered raw |
|---|---|
| `filePath` | from `smartObject.link._path` |
| `sourcePath` | same as `filePath` (no working copy exists) |
| `kind` | from the extension |
| `lastSettings` | `null` → read the sidecar, which is correct anyway |
| `aspect` | read on first develop, or left null |
| `stateXml` | read from the sidecar on demand |

## What this buys

The common case — open a PSD containing linked raws and start editing —
works with no 📷 at all. 📷 becomes what it should be: the way to bring a NEW
photo in, and the safe path for JPEGs.

It also removes a class of confusion that currently has no error message:
a photo layer that CreaCon can see, can name, and silently refuses to edit.

## Risks

- **A raw whose sidecar holds settings the user did not make.** Defaulting to
  "keep" is right, but the first develop should report what it found, the way
  import does today.
- **The lazy ACR session appears at a surprising moment** — a dialog opens on
  the first develop rather than at a moment the user chose. It needs saying in
  the chat before it happens.
- **Auto-discovery is silent by nature.** If it goes wrong it goes wrong
  invisibly, which is the failure mode that has cost the most time on this
  project. Whatever gets registered should be logged and visible.

## Open question

Does `smartObject.link._path` populate for a linked smart object placed by
*Photoshop's own* File → Place Linked, or only for ones CreaCon placed? The
mechanism is Photoshop's, so it should be the former, but that has not been
tested and the whole proposal rests on it.

`spike/linkPathProbe.js` answers this directly — it dumps every path-shaped
value in each layer's descriptor. Wire it to a button, open a PSD with a
hand-placed linked raw, and read the output. Twenty minutes, and it decides
whether any of the above is worth building.
