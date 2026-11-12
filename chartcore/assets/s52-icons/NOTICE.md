# Vendored: quantenschaum/mapping seamark icons

Source: https://github.com/quantenschaum/mapping
Commit: 96b1104866af7aa2a040a1d33bb3d7989b8117ce (2026-06-30)
Path:   `icons/*.svg`
License: GPL3 (see `LICENSE-GPL3` in this directory, copied verbatim from
the upstream repo's `LICENSE`) — the icon SVGs are the "code" half of that
repo's split license; the *charts* it renders are CC0, but that clause does
not apply to these hand-drawn symbol assets.

172 hand-drawn seamark symbols (buoy/beacon/topmark shapes, lights, wrecks,
rocks, restrictions, landmarks), copied verbatim, unmodified, with their
original upstream filenames.

Also vendored: `s57.py` (path `scripts/s57.py` upstream), same commit,
same licence. This is the reference declaration file — a single Python
dict (`S57`) mapping every S-57 ENC attribute CODE this pipeline cares
about (COLOUR, COLPAT, BOYSHP, BCNSHP, TOPSHP, CATLMK, CATSIL, CATOFP,
CATHAF, CATCRN, CATOBS, CATWED, CATWRK, NATSUR, NATQUA, MARSYS, and more —
grep the file for the full list) directly to the semantic name used to
pick an icon file (e.g. `CATLMK: {3: "chimney", 6: "flare_stack", 17:
"tower", 20: "spire", ...}`, `CATWED: {1: "kelp", 3: "sea_grass", ...}`).
These names correspond 1:1 (modulo underscore/hyphen normalisation —
`flare_stack` → `flare-stack.svg`, `sea_grass` → `seagrass.svg`) with the
icon filenames in this directory, since `scripts/genicons.py` in the same
upstream repo generates every recoloured/patterned variant from exactly
this table. **Read `s57.py` FIRST when porting any new S-57 object class
through chartcore's derive pipeline** — it turns "guess an icon name, then
verify against chartsymbols.xml" into a direct lookup, and is what made
the LNDMRK/SBDARE backlog (previously estimated as a big lift) far more
tractable than expected. Not itself wired into any build step — a
reference file for whoever writes the next `derive/*.rs` module, not
code this repo executes.

Also vendored: `s57-style.json` (path `vector/styles/s57.json` upstream),
same commit, same licence. A complete MapLibre GL style rendering raw S-57
ENC data directly (its `layers[].source-layer` values are literal S-57
class codes — CATLMK/SBDARE/CBLOHD/LIGHTS/etc, ~100 of them — not the
OSM `seamark:*` tag scheme `icons/extra.mapcss` in the same upstream repo
uses for a different rendering path; don't confuse the two). This is the
single most direct reference for how upstream actually renders a class:
its `icon-image` expressions show not just WHICH icon but the exact
selection logic (e.g. `LNDMRK`'s `landmark` layer: `FUNCTN` 20/21 → forces
`church` regardless of `CATLMK`; `CATLMK=17` (tower) + a `COLOUR` attribute
present → renders as `BCNSHP/3/<colpat>/<colour>`, i.e. the same
beacon-body recolour system aton.rs already has, not a plain icon; default
→ literal `CATLMK/<value>`) plus real `icon-anchor`/`icon-offset`/
`icon-rotate` layout values. **Before writing a new `derive/*.rs` module's
icon-selection logic from scratch, grep this file for the class's
source-layer name — upstream has almost certainly already solved the same
branching problem.** Also confirms some classes are genuinely
label/text-only in the reference implementation too (e.g. `SBDARE`'s
`seabed` layer has no `icon-image` at all — just a `text-field` built from
`NATSUR`/`NATQUA` codes, e.g. "fS" for fine sand) — useful negative
information, not just positive matches.

## Why

Foundation for replacing the S-52-derived icon pipeline
(`frontend/tools/s52-sprites/build-sprites.ts` +
`frontend/src/.../official-plib.ts`), which depends on ochartsng's
`chartsymbols.xml` and the alios/iho-presentation IHO PLIB mirror. User
decision 2026-07-26: GPL3 is acceptable for this private/internal tool, extending the project's existing "we are ok with
everything being GPL" stance (GPL-2.0-only baseline) to this specific GPL3
import. This mirrors the project's precedent of freely porting from GPLv2
reference sources (ochartsng) — see `chartcore/src/coords/point.rs` etc. for
that house style of citing provenance in source comments.

The icon SVGs are consumed by chartcore's icon pipeline
(`chartcore/src/icons/{catalog,composite,pack,recolor}.rs`), which several
`derive/*.rs` modules now reference directly (`aton.rs`, `lights.rs`,
`restricted.rs`, `industrial.rs`) — this is no longer a pure vendoring drop
with nothing reading it, as an earlier version of this note said.

## Updating

Re-clone `github.com/quantenschaum/mapping` at the desired commit, copy
`icons/*.svg`, `scripts/s57.py`, and `vector/styles/s57.json` (as
`s57-style.json`) over this directory's files (`LICENSE-GPL3` and
`NOTICE.md` are not part of upstream and should not be overwritten by a
raw copy), and update the commit hash above.
