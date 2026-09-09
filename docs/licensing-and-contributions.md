# Licensing and contributions

Decisions and open actions around who may do what with CreaCon. Written
2026-09-08, before the repository goes public.

Not legal advice. This is a record of decisions and the reasoning behind them,
so the reasoning is still available later.

---

## The decision

CreaCon is **source-available, not open source**. Anyone may use it, free, for
anything including commercially. Nobody may modify or redistribute it.

`LICENSE` at the repository root. The previous Apache-2.0 file under `CreaCon/`
was removed on 2026-09-08 — it granted exactly the permissions this project does
not want to give, including commercial redistribution of modified copies.

### Why this and not "no licence at all"

An absent licence grants nothing, so nobody could legally *run* CreaCon either.
That is more restrictive than intended. The licence explicitly permits the
copying that running requires — cloning, installing dependencies, building —
because a source-shipped project cannot be run without it, and a licence that
forbade that would contradict itself.

### Why not open source

The comments and design notes are the substance of this project. Publishing them
is deliberate: they are what makes the repository worth reading, and they are the
case for the author's engineering ability. The licence protects the work; hiding
the reasoning would only make it less valuable to everyone, the author included.

---

## THE ACTION THAT MATTERS: contributions

**Status: NOT DONE. Do this before the repository goes public.**

Today the author is the sole copyright holder, so CreaCon can be relicensed to
anything, at any time, unilaterally — commercial, subscription, dual-licence,
open source. That freedom is the single most valuable legal asset the project
has, and it costs nothing to keep.

**Merging one pull request destroys it.** A contributor owns the copyright in
their contribution. The codebase becomes jointly owned, and relicensing then
requires tracking down every contributor for permission. Projects have been
permanently stuck this way, unable to change their own licence.

Going public is exactly when unsolicited pull requests start arriving.

### Chosen approach: decline code contributions

A `CONTRIBUTING.md` stating that code contributions are not accepted, and that
bug reports and feature requests are welcome. This is consistent with a licence
that already forbids modification — accepting patches under a no-modification
licence would be incoherent.

Draft text:

> ## Contributing
>
> Thank you for the interest, but **CreaCon does not accept code contributions.**
>
> The licence does not permit modification, and keeping sole authorship means the
> project can be relicensed later without tracking down every past contributor.
>
> **Bug reports and feature requests are very welcome** — please open an issue.
> If you have found something interesting about how Camera Raw or UXP behaves,
> that is welcome too; that kind of finding is most of what this project is made
> of.
>
> If a pull request is opened it will be closed unread, with no offence intended.
> Reading a proposed patch and later writing similar code creates exactly the
> ambiguity this policy exists to avoid.

The last paragraph matters and is easy to miss: **not reading unsolicited patches
is part of the point.** Having read someone's implementation and then written
similar code yourself is a much weaker position than never having seen it.

### The alternative, not chosen

A **CLA** — contributors keep ownership but grant unrestricted rights including
relicensing. GitHub has bot tooling for this. Worth adopting only if
contributions are actually wanted, which they are not while the licence forbids
modification. Revisit if the licence ever changes.

---

## Copyright registration

Copyright exists automatically on creation in every Berne Convention country. No
filing is needed to *own* CreaCon.

**Jurisdiction is unresolved and determines whether this is worth doing.**

If US-based, registration is worth timing to the public release:

- Registration is **required before an infringement suit can be filed** for works
  of US origin.
- Registering **within three months of first publication** unlocks **statutory
  damages ($750–$150,000 per work) and attorney's fees**. Without it, only actual
  damages — which in a software case are expensive and often impossible to prove.
- ~$65, filed online.

The three-month clock starts at publication, so this is a release-time action,
not something to do afterwards.

If Canada / UK / EU, registration is generally far less consequential. Check the
rules for wherever the author actually is before spending anything.

---

## Obligations CreaCon takes on when it ships

**Third-party notices — required, not optional. Phase 3 blocker.**

The packaged build redistributes FastAPI, uvicorn, scipy, numpy, Pillow,
pywebview, jsonschema, pydantic and the provider SDKs. Most of their licences
(MIT, BSD, Apache-2.0) require their copyright notices to be included in any
distribution.

This is a condition of using *their* code and is unaffected by CreaCon's own
licence. A generated `THIRD-PARTY-NOTICES.txt` shipped in the installer satisfies
it; `pip-licenses` produces most of the content.

---

## Adobe

Confirmed 2026-09-07: the Creative Cloud Marketplace is a **non-exclusive**
channel. CreaCon can be sold independently, and independent distribution requires
no Adobe review. No revenue share applies to sales made directly.

A plugin ID from the Adobe Developer Distribution portal is still needed before
distributing the `.ccx` at all.

---

## If revenue ever happens

Nothing has to change — a paid product under the current terms is ordinary
commercial licensing.

The established middle paths, if community goodwill ever matters more than it
does now:

| Licence | Model |
|---|---|
| **BSL** (MariaDB, HashiCorp, Sentry) | Source-available, auto-converts to open source after ≤4 years |
| **FSL** (Sentry, 2023) | Same idea, 2 years, simpler text |
| **PolyForm** | A menu: noncommercial, trial-only, small-business-only |

All of these presuppose an eventual open-source conversion. If the goal is simply
to sell software, the current licence is already the right shape.

**Order of value: relicensing freedom > the specific licence text.** Which is why
the contributions policy above outranks everything else on this page.

---

## Checklist

- [x] Replace Apache-2.0 with the source-available licence — 2026-09-08
- [x] README licence section
- [ ] **`CONTRIBUTING.md`** — before the repository goes public
- [ ] `THIRD-PARTY-NOTICES.txt` in the installer — Phase 3
- [ ] Decide whether copyright registration applies, based on jurisdiction
- [ ] Plugin ID from the Adobe Developer Distribution portal — Phase 3
