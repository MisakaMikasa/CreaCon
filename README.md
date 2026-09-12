<img src="assets/icon-512.png" width="110" align="left" alt="">

# CreaCon

### Your AI copilot for photo editing.

**Lives inside Photoshop. Edits like a human photographer, not an image generator.**

<br clear="left">

Tell it what you want, in your own words:

> *"make this photo look better"*
> *"emphasize the skyscraper"*
> *"imitate the vibe of Fuji Classic Negative"*
> *"propose a better composition"*
> *"recover the highlights and warm it up"*
> *"darken just the sky"*

CreaCon looks at your photo, works out what that means, and shows you a plan.
You click Apply, and it performs the edit **as real Camera Raw develop settings
and real adjustment layers** — the same moves you would have made by hand.

**Nothing is generated. Nothing is flattened.** Every slider it touches is one
you can find afterwards and change. Your photo stays yours; CreaCon just knows
where the controls are.

## See it work

<!-- INLINE PLAYER: drag each MP4 into GitHub's README editor (or into any
     issue) and paste the resulting user-attachments URL on its own line here.
     GitHub renders those as a real player; it strips YouTube iframes. -->

[![Demonstration 1](https://img.youtube.com/vi/CujDVSj0CaY/maxresdefault.jpg)](https://www.youtube.com/watch?v=CujDVSj0CaY)

[![Demonstration 2](https://img.youtube.com/vi/UTCQHWtEFmQ/maxresdefault.jpg)](https://www.youtube.com/watch?v=UTCQHWtEFmQ)

## Why it is different

Most AI photo tools **generate a new image**. You get a picture back and no way
into it — you cannot nudge one thing, and you cannot tell what it changed.

CreaCon **operates the software instead.** It writes develop settings and builds
adjustment layers, so:

- **Everything stays editable.** Every edit lands in Camera Raw or the Layers
  panel where you can adjust or delete it.
- **Nothing is destroyed.** Your original file is never overwritten.
- **You approve before anything happens.** It proposes a plan; you decide.
- **You can keep talking.** *"stronger"*, *"other side"*, *"make that gentler"* —
  it knows what it just did.

It is a copilot, not an autopilot. It does the fiddly part; you keep the taste.

---

## What you can ask for

**Develop a photo** — RAW or JPEG, through Camera Raw:

> *"give me a faded film look"*
> *"the sky is too pale — deepen the blues"*
> *"push the greens toward teal, but keep skin natural"*

Exposure, contrast, true Kelvin white balance, highlight and shadow recovery,
texture, clarity, dehaze, the full HSL colour mixer, split-tone colour grading,
sharpening, noise reduction, grain and vignette.

**Edit part of a photo** — it works out the masks itself:

> *"brighten her face a little"*
> *"warm the left third of the frame"*
> *"lift the shadows on the building, not the sky"*

Sky, subject and person selection, plus linear and radial gradients — each
carrying its own develop settings.

**Recompose:**

> *"straighten the horizon"*
> *"fix the converging verticals"*
> *"crop this tighter"*

On open-ended requests it offers crop options as thumbnails rather than deciding
for you.

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

CreaCon is two pieces: **the app**, which holds the chat, and **a Photoshop
plugin**, which performs the edits. You need both.

1. **Run the installer.** It lays down the app and registers the plugin with
   Photoshop. Windows will ask for administrator rights, and Adobe will warn
   that the plugin is not verified by them — that warning appears for every
   plugin outside Adobe's own marketplace.
2. **Open ⚙ Settings**, paste your Gemini API key, **Save**, then restart
   CreaCon.
3. **Open Photoshop.** The CreaCon panel should appear, and the app's status
   strip should show a green dot and *"Connected"*.

**If the panel does not appear/stays unconnected**, the plugin did not register. Install it by
hand: double-click **`CreaCon.ccx`** in CreaCon's install folder (next to
`CreaCon.exe`), and accept Adobe's prompt. This needs the Creative Cloud
desktop app, which is what installs plugins on Windows.

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

## Running from source

You do not need the installer. The licence allows cloning, building and
changing CreaCon for your own use &mdash; what it does not allow is
redistributing it or building a commercial product from it.

You still need **Photoshop 27.8+**, the two Camera Raw preferences above, and
your own Gemini key.

### The app

```
git clone https://github.com/MisakaMikasa/CreaCon.git
cd CreaCon/backend

python -m venv .venv
.venv\Scripts\activate            # Windows; source .venv/bin/activate elsewhere
pip install -r requirements.txt

copy .env.example .env             # then put your Gemini key in it
python app.py
```

`python app.py` opens the desktop window. `python main.py` runs the backend
headless without a window, which is useful when you only want the API.

Settings resolve in this order: `%APPDATA%\CreaCon\config.json` &rarr; environment
&rarr; `backend/.env`. From source you will normally use the `.env`; an installed
build has none and uses `config.json`, which its settings screen writes.

### The plugin

Load it through **UXP Developer Tools** (free, from Creative Cloud):
*Add Plugin* &rarr; select `CreaCon/manifest.json` &rarr; *Load*.

The plugin finds the app by itself &mdash; it tries ports 8000 and 8731&ndash;8735
and connects to whichever answers, so nothing needs configuring. Watch the app's
status light to confirm.

---

## License

Source-available, not open source. Read it, run it, tinker with it — use
CreaCon for anything, personal or commercial, and change it for yourself.

What you may not do is build a commercial product from it or redistribute it,
modified or not. Share the link, not the code. See [LICENSE](LICENSE).

The source is here to be read and run — the comments explain *why* each mechanism
is shaped the way it is, which is most of the value.
