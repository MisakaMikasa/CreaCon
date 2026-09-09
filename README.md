<img src="assets/icon-512.png" width="96" align="left" alt="">

# CreaCon

**Edit photos in Photoshop by describing what you want.**

<br clear="left">

You type *"warmer and more cinematic, but keep it natural"*. CreaCon looks at your
photo, plans the edit, shows you the steps, and — once you approve — performs them
as **real Camera Raw develop settings and real adjustment layers**.

Nothing is generated. Nothing is flattened. Every edit it makes is one you could
have made yourself, and you can adjust or undo any of it afterwards in the panels
you already know.

<!-- TODO: drag an MP4 into GitHub's README editor and paste the
     user-attachments URL here. ~30s: type a request, plan card, layers appear. -->

---

## What you can ask for

**Develop a photo** — RAW or JPEG, through Camera Raw:

> *"recover the highlights and warm it up"*
> *"give me a faded film look"*
> *"the sky is too pale — deepen the blues"*

Exposure, contrast, true Kelvin white balance, highlight and shadow recovery,
texture, clarity, dehaze, the full HSL colour mixer, split-tone colour grading,
sharpening, noise reduction, grain and vignette.

**Edit part of a photo** — it works out the masks itself:

> *"darken just the sky"*
> *"brighten her face a little"*
> *"warm the left third of the frame"*

Sky, subject and person selection, plus linear and radial gradients — each
carrying its own develop settings.

**Recompose:**

> *"straighten the horizon"*
> *"fix the converging verticals"*
> *"crop this tighter"*

It measures what a straighten costs before doing it, and says so: *"straightening
2 degrees, which trims about 10% of the frame."* On open-ended requests it offers
crop options as thumbnails rather than deciding for you.

**Work on ordinary layers** too — adjustment layers, masks, blend modes and groups
on any PSD.

**Then refine.** It knows what it just did, so *"stronger"*, *"other side"*,
*"make that gentler"* all work as follow-ups.

---

## Setup

You need **Photoshop 27.8 or newer** and a **Google Gemini API key**
([get one free](https://aistudio.google.com/apikey)).

### 1. Settings you must change first

CreaCon cannot work without these. Two are in Camera Raw, one is in Photoshop.

#### Camera Raw → File Handling

Open Camera Raw (double-click any raw photo), click the **⚙ gear icon**, then
**File Handling**:

| Setting | Set it to | Why |
|---|---|---|
| **Save image settings in** | **Sidecar ".xmp" files** | **Required.** Otherwise Camera Raw keeps your develop settings in its own database, where CreaCon can neither read nor write them. Nothing will work. |
| **JPEG/HEIC → Automatically open all supported JPEGs** | ✅ on | Required only if you want to edit JPEGs. Without it Photoshop opens them directly and skips Camera Raw entirely. |

#### Photoshop → Performance

**Ctrl+K → Performance → Graphics Processor Settings → untick "Use Graphics
Processor"**, then restart Photoshop.

**This is a Photoshop bug, not a CreaCon one**, and it is worth knowing what it
looks like: on **Photoshop 27.10** the canvas renders noticeably *more saturated*
than the Camera Raw dialog showing the same photo. The GPU canvas skips the
document-to-display colour conversion — so the canvas is wrong and Camera Raw is
right.

It affects the **canvas only**; files you save or export are correct either way,
and it happens on every import, with or without CreaCon.

Turning the GPU off costs some canvas performance. 27.9.1 is unaffected and Adobe
has escalated it, so try switching it back on once 27.11 ships.

> ⚠️ If colours ever differ between Camera Raw and the canvas, check your Photoshop
> version before suspecting CreaCon. CreaCon writes develop settings and touches
> nothing to do with colour management.

### 2. Install

1. Run the CreaCon installer and launch the app.
2. Open **⚙ Settings**, paste your Gemini API key, **Save**, then restart CreaCon.
3. Open Photoshop. The CreaCon panel should show a green dot and *"Connected"*.

---

## Using it

1. **Open a photo with the 📷 button.** This matters — it is how CreaCon places the
   photo so it can develop it later. A photo you opened yourself cannot be
   develop-edited. If it already has develop settings, you will be asked whether to
   keep them or start fresh.
2. **Type what you want.**
3. **Read the plan, click Apply.** Nothing touches your document until you do.
4. **Keep going.** Refine, or restore any earlier state from its card.

**Photoshop freezes while an edit applies.** That is Photoshop, not a crash — it
blocks its own interface while a script runs, and Camera Raw takes a few seconds to
re-develop a large raw. The CreaCon window stays responsive throughout.

---

## Things worth knowing

**AI masks need one manual nudge, the first time.** When CreaCon adds a sky,
subject or person mask, Camera Raw loads the settings but does not always run the
selection itself. If the region looks untouched, double-click the layer to open
Camera Raw and click **"Update AI settings"** once. It stays put after that.
Gradient masks never need this.

**Ctrl+Z undoes the picture, not the file.** Develop settings live in a sidecar
file beside your photo, which Photoshop's undo cannot reach. Use **"Restore to
before this"** on the edit's card instead — every develop edit saves one.

**One photo, one set of edits.** Duplicating a photo layer does not duplicate the
photo: both layers point at the same file, and a file holds one develop state, so
editing one changes both. To grade the same photo two ways, import it twice with 📷
(JPEG) or duplicate the raw file on disk first (RAW). CreaCon warns you when it
spots this.

**Keep your photos where they are.** CreaCon edits raws in place through their
sidecar files, so the PSD alone is not portable — move the photos and the link
breaks.

**Your API key stays on your machine.** It is stored in your own AppData folder and
sent only to Google, only when you ask for an edit.

---

## Limitations

- **RAW** (CR2, CR3, NEF, ARW, RAF, ORF, RW2) and **JPEG**. **DNG is not
  supported** — it stores settings somewhere CreaCon cannot reach.
- **No retouching.** No healing, cloning or content-aware fill. CreaCon works with
  the non-destructive toolset by design, so everything stays reversible.
- **It sees the flattened image**, not individual layers, so it cannot tell which of
  several image layers holds what. Name them, or select the one you mean.
- Photos opened outside CreaCon cannot be develop-edited — use 📷.
- Windows only for now.

---

## How it works

```
  You                CreaCon app                Photoshop
   │                      │                          │
   │─ "warmer, please" ──▶│                          │
   │                      │── what am I looking at? ▶│
   │                      │◀── photo + layers ───────│
   │                      │                          │
   │                      │──▶ Gemini ──▶ a plan     │
   │◀──── plan card ──────│                          │
   │                      │                          │
   │──── Apply ──────────▶│── do this ──────────────▶│
   │                      │                          │ Camera Raw
   │◀──── "Applied" ──────│◀── done ─────────────────│ + layers
```

The app holds the conversation and talks to the model. A small Photoshop plugin
does the actual work, because only something running inside Photoshop can. Every
plan is checked against a strict schema before it is allowed to run, and nothing
runs without your click.

The interesting part: **Camera Raw cannot be scripted.** Adobe deliberately ignores
settings sent to its dialog. CreaCon controls it a different way — it writes the
develop settings into the photo's `.xmp` sidecar and makes Camera Raw re-read the
file. That is also why the sidecar preference above is not optional.

---

## License

Source-available, not open source. You may **use** CreaCon freely, for anything,
including commercially. You may not modify or redistribute it. See
[LICENSE](LICENSE).

The source is here to be read and run — the comments explain *why* each mechanism
is shaped the way it is, which is most of the value.
