# Developing JPEGs through Camera Raw

Design note and decision record for routing JPEG editing through Camera Raw
instead of Photoshop adjustment layers.

Status: **working end to end in the app** (first successful JPEG develop
2026-08-26). Everything marked *verified* below was proven on real files, not
reasoned from docs.

Built: `xmpEmbedded.js` (the JPEG container), `developStore.js` (the seam),
`photoCache.js` (working copies + rebuild), copy-on-import, the registry's state
mirror, `verifiedPhotoLayers` (§3.5a), and the prompt's latitude rules. Covered
by `scripts/test-xmp-embedded.js`.

**Not built yet:** the liveness sweep of §3.4 and the PSD link-table parser it
needs. Nothing is deleted from the cache today, so its absence is safe, only
untidy — working copies accumulate in the plugin data folder until someone
clears them by hand.

**Also outstanding:** develop applies write to files OUTSIDE the open document
(a sidecar beside the user's raw, or a working copy), where Photoshop's undo
cannot reach. Checkpoints cover this but are memory-only and session-scoped, so a
plugin reload loses them — which is exactly how the §3.5a incident became
unrecoverable. A durable `.creacon-backup` written the first time CreaCon ever
touches a file would bound that damage; the old `acrReloadSpike` did this and it
is maybe twenty lines.

---

## 1. The question

CreaCon edits RAW photos by writing develop settings into the file's `.xmp`
sidecar and forcing Camera Raw to re-ingest it. JPEGs got a completely different
treatment: Photoshop adjustment layers (`brightnessContrast`, `curves`,
`hueSaturation`, `colorBalance`, `vibrance`, `exposure`) plus layer masks.

That split costs us twice. The model has to learn two vocabularies and pick
between them by file type, and the JPEG vocabulary is much the weaker one — no
Texture, no Clarity, no Dehaze, no highlight/shadow recovery, no per-colour HSL,
no split toning, no parametric curves, and only crude regional control.

So: can a JPEG go through the same Camera Raw path a RAW does?

## 2. What we tried, and what it taught us

### 2.1 First instinct: Smart Object + Camera Raw *Filter* — rejected

The obvious move is "convert the layer to a Smart Object, apply the Camera Raw
Filter." We rejected it before spiking, because it reuses none of the
infrastructure:

- The filter stores its settings in the PSD's `filterFX` descriptor, **not on
  disk**. `xmpSidecar.js`, checkpoints and external-edit detection would all have
  to be rebuilt against an opaque action descriptor.
- We already know Camera Raw cannot be driven imperatively — batchPlay can open
  its dialog but not set sliders. That wall is exactly what the sidecar mechanism
  was invented to get around, and this approach walks straight back into it.
- The Camera Raw **Filter** has no crop panel, so `geometry.js` doesn't transfer
  either.

The alternative — place the JPEG as a **linked smart object from disk**, exactly
like a RAW — reuses placement, the registry, the relink-reload, checkpoints,
geometry, and the mask coordinate maths. Only the storage location was in
question. So that is what we spiked.

### 2.2 The distinction that decided everything

Early on we nearly asked the wrong question. "Where does Camera Raw keep JPEG
settings?" is really **two** questions with possibly different answers:

- **WRITE path** — where ACR persists a user's own manual edit. Determines
  whether manual edits and agent edits can merge.
- **READ path** — what ACR consults when it ingests the file. Determines whether
  `applyCameraRaw` works *at all*.

A sidecar-read + file-write outcome, for instance, would have meant the existing
executor worked unchanged while we only needed a *reader* for the file's own
metadata. Conflating the two would have produced the wrong plan.

### 2.3 Spike run 1 — where ACR writes

`CreaCon/src/spike/jpegAcrSpike.js`, on a Fuji JPEG, ACR 18.5, Windows.

*Verified:*

- Camera Raw does open linked JPEG smart objects, given the ACR preference
  *File Handling → JPEG/HEIC → automatically open all supported JPEGs*.
- A manual +2.70 exposure edit made ACR write a **6,795-byte XMP packet into the
  JPEG itself** (file grew 6,879 bytes; the original had no packet at all). ACR
  never wrote a sidecar.
- That packet holds the **complete explicit flat state** — 101 `crs:` attributes,
  the same vocabulary and the same `HasSettings` / `ProcessVersion` root as a RAW
  sidecar.
- The embedded **read** path works: the +2.70 survived a relink, so ACR
  re-ingested and re-developed from its own packet.

*A flaw in our own test, worth recording:* the sidecar gate in run 1 was
inconclusive **by construction**. The manual edit creates the embedded packet
first, and an embedded packet shadows any sidecar, so that gate could never have
passed no matter what ACR supports. Sequencing bug, not a finding.

### 2.4 Spike run 2 — the decisive test

The open question was whether ACR honours a packet *we* wrote, as opposed to one
it wrote itself. Two clean tests, no manual choreography:

- **TEST A — PASS.** We took ACR's own packet, ran it through the real
  `parseFull → merge → serialize` round-trip (the exact path `applyCameraRaw`
  takes for a RAW), spliced the result back into the file and relinked. It
  rendered dark and colourless as instructed. **ACR honours packets we write.**
- **TEST B — FAIL.** The same JPEG with every XMP segment stripped, plus a
  sidecar carrying the same look, rendered normally. **ACR does not consult a
  `.xmp` beside a JPEG even when nothing shadows it.**

Verdict: **embedded XMP is the only storage for JPEG develop settings, read or
written.**

### 2.5 What this means for quality — no re-encoding

A worry worth killing explicitly: "every edit rewrites the file" sounds like
repeated JPEG re-saves and generation loss. It isn't.

```
[ metadata block  ~7 KB ]  [ compressed image data  ~11 MB ]
        ↑ replaced                ↑ copied byte-for-byte
```

*Verified offline:* after splicing, the entropy-coded scan data is identical
byte-for-byte, and an independent decoder (Pillow) produces identical pixels. The
image is never decoded or re-encoded. An "edit" is a metadata swap plus a file
write. Also verified: the splice is idempotent, and the EXIF `APP1` segment is
left untouched.

### 2.6 The orphan problem, and the PSD link table

Because settings live inside the image, editing the user's original would mean
mutating their photo on every turn. So we edit a **working copy**. That raises
the question of how copies are ever cleaned up — and the trap is that *absence
from our own registry does not prove a file is unused*. `Save As`, moving a PSD,
or a lost `rawRegistry.json` all leave live files looking orphaned. Sweeping on
that basis deletes files that open documents depend on.

*Verified:* a PSD on disk lists the full path of every linked file it uses.
Parsing a real saved document produced:

```
record: type=liFE  filename=<name>.jpg  dataLength=0
   path: <absolute path>
   url:  file:///<absolute path>
```

`liFE` = external reference, `dataLength=0` (nothing embedded). By contrast an
*embedded* smart object is stored as `liFD` with the whole file inline and **no
path kept** — which is precisely why `rawRegistry.js` had to exist in the first
place. Each record also carries a UUID that appears in the per-layer block, so
**layer → file path is recoverable from the PSD alone.**

That turns orphan detection from guesswork into a real reference check, and it
needs no Photoshop API.

## 3. The design

### 3.1 Storage seam

Develop state becomes storage-agnostic. One interface, two implementations:

| | RAW | JPEG |
| --- | --- | --- |
| read state | `.xmp` sidecar file | `APP1` XMP packet in the image |
| write state | `.xmp` sidecar file | `APP1` XMP packet in the image |
| everything else | *identical* | |

`parseFull`, `serialize`, the extras/fidelity layers, checkpoints, mask
coordinate maths, geometry, the relink reload and the step coalescing are all
unchanged. This is the whole point of the design: the spike proved the *content*
is the same vocabulary, so only the container differs.

### 3.2 Copy on import

On importing a JPEG, CreaCon copies it into a cache and links the smart object to
the copy. The user's original is never opened for writing.

```
<cache root>/photos/<original-name>-<short-id>.jpg
```

The copy is a **fork, not a mirror** — later changes to the original don't
propagate, the same way duplicating a RAW to grade it twice doesn't.

A side benefit: this removes a limitation the RAW path has. Importing the same
RAW twice is refused today, because one file holds one develop state and two
layers would fight over it. Since JPEG import copies anyway, grading the same
photo two ways in one document just works.

### 3.3 Path handling — rules

Paths are the sharp edge here, so these are rules, not preferences:

- **Never key on a document's name.** Users rename documents and reuse names
  across projects. Identity comes from the linked *file path* recorded in the
  PSD, and from the per-record UUID.
- **Never hardcode a cache location.** Resolve it at runtime from the platform's
  data/Documents folder. Nothing in the codebase should contain a literal user
  path.
- **Cache membership is decided by containment, not by name.** A file is ours if
  its normalised absolute path sits inside the resolved cache root — compared
  case-insensitively on Windows, with separators normalised.
- **Accept both path forms.** The PSD stores a native path *and* a `file:///`
  URL for the same file; normalise both to one canonical form before comparing.
- **Working-copy filenames must be unique per import**, not derived from the
  source name alone, or two imports of the same photo collide.
- Treat an absolute path as a hint that can go stale. A missing working copy is a
  repair job, not an error (§3.5).

### 3.4 Liveness and cleanup

1. Whenever a saved document is in play, read its own file, parse the linked-file
   table, and stamp every referenced cache file as seen.
2. A cache file unseen for a long grace period is a **candidate**, never an
   automatic deletion.
3. Skip any candidate whose original no longer exists — our copy is then the
   user's last copy of that photo.

### 3.5 Deletion is recoverable, by construction

The single safeguard that makes the rest of this tolerable: **mirror the settings
packet (~5 KB) into the registry.**

The expensive part of a working copy is pixels that are byte-identical to the
user's original. The irreplaceable part is a few kilobytes of settings. Keeping
the small part forever means a missing copy is a cache miss rather than data loss:

```
working copy missing on reopen
  → re-copy the original → splice the stored settings → relink
```

So the sweep doesn't have to be perfect, and a broken link from moving files
repairs itself.

### 3.5a Layer identity must be verified, not assumed

Found the hard way during the first live JPEG test (2026-08-26), and worth
recording in full because the failure was silent, destructive, and cost a user's
file.

**What happened.** A plan targeting a JPEG layer wrote its develop settings into
`DSCF0657.xmp` — the sidecar of an unrelated raw photo, in a different folder,
belonging to a document that was not even open. The log looked entirely normal;
the only visible clue was `kind: "raw"` on a layer that was a JPEG. The settings
were unrecoverable: the checkpoint that would have restored them was memory-only
and was lost with the session, and the registry's own mirror had already been
overwritten by the same bad apply.

The registry keys entries by `(document path, layer id)` and used to match on the
id alone. **Photoshop reuses layer ids once a layer is deleted.** A JPEG placed
into a document picked up the id of a raw that had been imported into that same
document earlier and removed, matched its stale entry, and CreaCon wrote the
JPEG's develop settings into an unrelated photo's sidecar — a file the user had
not opened, in a different folder.

So a registry hit is a *claim*, and it is now checked: the layer must actually
contain the file the entry names, compared by the file name Photoshop reports for
a smart object. A filename is weak evidence of identity but strong evidence of
NON-identity, and non-identity is what has to be caught. Entries proven stale are
forgotten, so they cannot capture the next layer to reuse that id either.

The check is deliberately one-sided: an entry is dropped only on positive
evidence of mismatch. When Photoshop reports no file name, the entry is kept and
a warning logged — a check that cannot see must not start deleting mappings that
were working.

`registry.rawLayersIn` is now internal and unverified; `verifiedPhotoLayers` is
the only supported way to read the registry.

**A linked layer reports its full path** — `smartObject.link._path` on the full
layer descriptor, confirmed 2026-08-26 by the layer/file report. (Not
`smartObjectMore.link`, which genuinely is empty; the two are unrelated fields
and the older note in `cameraRaw.js` was about the latter.)

**That removed the problem rather than catching it — see §3.6.** Verification by
comparison was an interim step and no longer exists: the registry is keyed by the
path, and the path comes from the layer, so there is no claim left to be stale.

### 3.6 The registry is keyed by file path

Because a linked layer reports its own path (§3.5a), Photoshop is the authority
on *which file* a layer holds and the registry only has to store what Photoshop
does not know: `sourcePath` (which original a working copy came from), `kind`,
`lastSettings`, `stateXml`, `aspect`.

```
photos[canonical(filePath)] = { filePath, sourcePath, kind, lastSettings, stateXml, aspect, lastSeenAt }
legacy[docKey][layerId]     = { ... }   // read-only, embedded smart objects only
```

Four problems stop existing rather than being handled:

- **Layer-id reuse** is structurally impossible — no layer id is stored.
- **Save As** is irrelevant — no document key is stored. This was a real bug: a
  renamed document silently lost every mapping and its photos stopped being
  develop-editable with no explanation.
- **Unsaved documents** need no special case. The old `unsaved:<doc.id>` bucket
  and its blind-merge-on-save are gone; `doc.id` restarts each launch, so that
  merge could silently overwrite a persisted entry with a session one.
- **Two documents using one photo** correctly share one develop state, since one
  file has one develop state.

`canonical()` lives in `pathKey.js` — dependency-free, because it decides whether
two spellings are the same photo. Failing to converge silently un-registers a
photo; converging wrongly writes settings into the wrong one. Covered by
`scripts/test-registry.js` along with the v1→v2 migration, which is the only part
that runs against a registry a user already has.

**Duplicates merge field-wise.** Two v1 entries for one file may each hold
different halves (one the settings, one the state mirror), so migration unions
them; last-writer-wins silently dropped whatever the loser held.

**What remains keyed by layer id:** embedded smart objects placed by older
versions, which report no path. They keep the old key and its id-reuse risk,
which cannot be fixed for them — the information needed is exactly what embedding
discards.

**Still open:** working copies are never swept, so the cache grows until cleared
by hand. `lastSeenAt` exists and is stamped, ready for that. Pruning naively is
wrong — Photoshop's undo restores a deleted layer *with its original id*, and a
document that is simply not open right now is not abandoned — so it needs a grace
period and explicit confirmation.

### 3.7 The PSD link table, and why it is no longer needed

§2.6 established that a PSD lists its linked files' full paths on disk, and that
was going to be the mechanism for both liveness and Save As recovery. The live
API turned out to expose the same thing per layer (§3.5a), which is simpler,
cheaper than parsing a 400 MB file, and works on unsaved documents.

The file-parsing route is therefore **not built**, and is only worth revisiting
for a use case nothing needs yet: answering "which files does this document use?"
about a document that is *not open*. The Python proofs are in the session
scratchpad and the format is documented in §2.6 if that day comes.

## 4. What is *not* removed

Worth stating plainly, because "collapse two paths into one" was part of the
original motivation and it is only half true.

The adjustment-layer ops stay. Three things only they can do:

- Blend modes (`multiply`, `softLight`, …) — no Camera Raw equivalent.
- Groups, opacity, and layers the user can toggle.
- **Subject and sky selection that runs headlessly.** Camera Raw's AI masks need
  a manual "Update AI settings" click each time and are deliberately disabled;
  the Photoshop ones don't.

What genuinely simplifies is the **prompt**: one way to edit a photo, with
adjustment layers demoted to a narrow, well-defined role. That is a real gain,
but it lands in `backend/prompt.py`, not in deleted executor code.

## 5. Consequences to accept

- **A second required ACR preference** (JPEG/HEIC auto-open) on top of the
  sidecar one. More setup, more support burden.
- **The Camera Raw dialog on apply** now reaches JPEG users too. RAW users
  already live with this.
- **8-bit latitude.** A JPEG is not a RAW: no meaningful highlight recovery, big
  white-balance and exposure pushes fall apart. `prompt.py` must teach smaller
  moves and clipping awareness, or the model will apply RAW-scale corrections.
- **Disk use.** A working copy per import, which is what §3.4 exists to manage.
- **PSDs are not self-contained**, and the working copy must stay put — the same
  trade the RAW path already makes.

## 6. Open items

- Whether the live Photoshop API exposes a linked layer's path directly. Would be
  cheaper than parsing a large PSD and would cover *unsaved* documents, which have
  no file to read. Read-only probe: `CreaCon/src/spike/linkPathProbe.js`.
  Not blocking — the file parser is the fallback and it works.
- Whether the import-time `establishAcrSession` dance is needed for JPEG. Likely
  yes, same cause; verify during the build.
- Whether `DEFAULT_GEOMETRY` seeding is relevant to JPEG. It exists so that
  writing a sidecar doesn't silently disable ACR's default lens correction on a
  RAW; JPEGs have no lens profile applied by default, so it may be a no-op.
- TIFF and HEIC are the same mechanism in principle and are untested.

## 7. Provenance

The spikes are kept as the record, with their results in their file headers:

- `CreaCon/src/spike/jpegAcrSpike.js` — storage location, and whether ACR honours
  packets we write. Both runs' results are recorded in the header.
- `CreaCon/src/spike/linkPathProbe.js` — read-only layer/file report: what
  Photoshop says is behind each layer, what the registry claims, and which
  registry entries have outlived their layer. Answers §6's first item and
  §3.5a's open questions 2 and 3.

Both are unwired — their questions are answered and the files are kept as the
record of how. Re-wire `linkPathProbe.js` to a panel button when working on the
registry; it is the fastest way to see the current layer/file/registry state and
which entries have outlived their layer.
