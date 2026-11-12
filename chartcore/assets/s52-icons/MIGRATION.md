# One icon source — migration plan

Goal (user, 2026-07-28): **get fully rid of the old sprite sheet so there is
only one source, the vendored SVGs.** Everything below serves that.

## Where the icons come from today (the problem)

Three pipelines coexist, and the frontend re-derives which one answers for a
given name three inconsistent ways:

| source | names | how the frontend routes to it |
| --- | --- | --- |
| raster atlas `public/sprites/s52.{png,json}` | `ISODGR51`, `CTNARE51`, … | `sprite.attr` — blind palette prefix, resolved from the style's `sprite:` URL |
| static SVGs `public/sprites/svg/` (`build-svg-icons.ts`) | same names | `sprite.svgAttr` — `s52svg_` prefix chosen *so that* the atlas misses |
| chartcore `/api/icons/` | `BOYSHP/4/1/3,1`, `light/red`, `TSS-arrow` | `styleimagemissing` → 404-discovery |

The defect is not "too much indirection" in general: **chartcore decides the
symbol name but does not say which namespace it is in**, so the frontend keeps
reconstructing that. `trafficRoutes.ts`'s `case sym == "TSS-arrow"` is the
clearest symptom — a hand-maintained list of chartcore-catalogue names, which
is exactly what `atonIcons.ts`'s own header says it deliberately avoids.

Cost already paid: `aidsHazards.ts` documents a "KNOWN DUSK/NIGHT REGRESSION,
flagged not fixed" — light flares stopped drawing at night, because
`derive::lights` now emits `light/red` (a day-only chartcore name) where it
used to emit `LIGHTS11` (which had `dusk_`/`dark_` artwork).

## The settled design

**Themes live in one place: JSON files in the Python backend**, runtime
updatable. One file per palette, carrying everything a theme is — `s52` (25
tokens), `canvas`, `icons` (role→hex), `chrome` (the 18 `--color-*` tokens +
`color-scheme`), `routeOverlay`/`overlay`/`poi`/`basemap`, and the optional
knobs (`rasterDim`, `basemapTint`, `contourWidth`, `sectorOutline`,
`sectorArcScale`, `fonts`).

The backend serves both halves from that one source:

- `GET /api/themes` — the JSON, for the chart style and icon recolouring.
- `GET /api/themes.css` — generated `:root[data-palette="…"]` blocks for the
  chrome. This works because `index.css`'s `@theme static` block is only
  Tailwind's *declaration* site (it needs token NAMES at build time to emit
  utilities); the twelve per-palette blocks merely override values, so they
  can move to runtime CSS without violating the Tailwind constraint
  `themes/types.ts` documents.

**The client applies the palette, not the server.** MapLibre needs raster, and
the browser already does that rasterisation (`atonIcons.ts`'s
`decodeSvgImage` → `createImageBitmap`, sized by `atonIconRaster` to
`native × scale × devicePixelRatio`). So chartcore serves ONE palette-neutral
SVG per key carrying **role tokens**, and the client substitutes role→hex from
the theme it already has, immediately before rasterising.

Consequences, all of them simplifications:

- `/api/icons/{key}.svg` stays palette-free. One cache entry per key rather
  than per key×palette — backend `lru_cache`, HTTP ETag and the SW cache all
  stay 13× smaller.
- Switching palette does not refetch a single icon.
- **chartcore holds no colour tables at all**, which is the "don't bake too
  much into the rust code" constraint satisfied properly rather than partially.
- The `dusk_`/`dark_` id prefix **goes away entirely** — it only ever encoded
  "which of three baked atlases", and there are no baked atlases any more.
  `spriteNamer` collapses to identity; `SPRITE_PREFIX` and
  `ThemeDef.spritePrefix` are deleted. This is also the night-regression fix.
- Server-side rasterisation (resvg → PNG) is deliberately NOT used: chartcore
  has usvg available, but a PNG would freeze resolution, lose the DPR
  adaptation, and spend Pi CPU per icon per palette.

One consequence that needs real code, not just deletion: with ids now
palette-neutral, a palette switch no longer changes any `icon-image`, and
`MapView.tsx:735` uses `setStyle(style, {diff: true})` whose registered images
survive (see its own comment at :417). So the loader must keep the fetched SVG
text per id and, on palette change, re-substitute → re-decode → `updateImage`.
No refetch, but not free either.

## Stages

1. **DONE** — `port-map.json` (84 tokens → vendored icon / gap / pattern) and
   `tools/gen-placeholders.py` + `placeholders.json`, so no symbol vanishes
   mid-migration. `catalog::is_placeholder` marks them; `pack::render` serves
   them raw (compositing and `usvg` normalisation both destroy a raster
   placeholder — measured).
2. **DONE** — Theme JSON in the backend + loader + `/api/themes` + `/api/themes.css`.
3. **DONE** (opt-in, `?roles=1`) — chartcore emits role tokens instead of baked hexes; delete `palette.rs`'s
   colour tables and the `,RRGGBB` *palette* override. (The `,RRGGBB` suffix
   itself survives for **per-feature** colour — `cablesPipelines.ts` drives it
   from the tile's own `bcol`, which varies feature to feature within one
   palette and so can never come from a theme lookup.)
4. **DONE** — Frontend: fetch themes (`themes/source.ts`, with
   `themes/bundled.generated.ts` as the offline fallback and a boot gate in
   `index.tsx`), substitute roles at rasterise time and refresh every
   registered image on palette change (`atonIcons.ts`), load
   `/api/themes.css` for the chrome and delete index.css's per-palette
   blocks, delete `spriteNamer`'s prefixing and `lightSymIcons.ts`. The
   twelve hand-authored `frontend/src/core/style/themes/*.ts` files are gone;
   the JSON in the backend is the only place a theme is authored.
5. **DONE** — Port `derive/` off the 84 chartsymbols tokens onto vendored names, per
   `port-map.json`. Needs a `TILE_SCHEMA_VERSION` bump (`backend/mivnav/
   features/ocharts/service.py`) — same SENC, different tile bytes.
6. **NOT CLEANUP — A BUG FIX. Do this next.** Delete `build-sprites.ts`,
   `build-svg-icons.ts`, the atlas, `svgSpriteManifest.generated.ts`; move
   `ChartSpriteIcon.tsx` to `/api/icons/`.

   The claim above that "no point symbol reads it any more" was wrong, and
   the user reported the consequence: *"the TSSLPT, TSEZNE and various area
   separating lines (PRCARE, ISTZNE, CTNARE etc) all render with an un-themed
   magenta."* MapLibre resolves an `icon-image` against the sprite sheet
   **before** firing `styleimagemissing`, so any emitted name that also
   exists in the sheet is served from the sheet and never reaches
   `atonIcons.ts`'s role-substituting loader. **27 emitted names still
   collide** — measured by intersecting the full `emitted_symbols()` sweep
   against `public/sprites/s52.json`:

   > DANGER01 DANGER51 DANGER52 DANGER53 DGPS01DRFSTA01 FAIRWY51 FAIRWY52
   > FLTHAZ02 FOULGND1 ITZARE51 LIGHTS81 LNDARE01 LOWACC03 POSGEN01 POSGEN03
   > PRDINS02 QUAPOS01 QUAPOS02 QUAPOS03 QUARRY01 QUESMRK1 RACNSP01 RCLDEF01
   > RESTRN51 TMBYRD01 TSSCRS51 TSSRON51

   `RESTRN51` is the one that explains the report: it is the `CS(RESTRN01)`
   symbol stacked on RESARE/CTNARE/PRCARE/ISTZNE/TSSLPT alike.

   And it is a **regression from stage 4**, not merely unfinished work. The
   sheet carries a full parallel `dusk_`/`dark_` set (1037 crops each, not
   "only `dark_NODATA03`" as `chartStyle.ts` claimed) — so before
   `SPRITE_PREFIX` was deleted these symbols at least got a night-tinted
   crop. Now they get the DAY crop on every palette.

   Blockers, both real, neither large:
   * the `NODATA03` area fill-pattern (`chartStyle.ts`) needs somewhere else
     to come from;
   * the six `NO_ARTWORK` names below would 404 and draw NOTHING once the
     sheet stops answering, where today they draw a crop. They need
     placeholders first (`tools/gen-placeholders.py` already does this).

   Note what this does NOT fix: the 21 collided names that DO resolve in
   chartcore mostly resolve to **raster placeholders**, which `pack::render`
   short-circuits past recolouring. Un-shadowing them stops them being
   day-baked-and-wrong-at-night, but only real vector artwork carrying
   `warn-magenta` makes them follow the theme. `placeholders.json` is that
   worklist, and `RESTRN51`/`TSSCRS51`/`TSSRON51`/`ITZARE51`/`FAIRWY51`/`52`
   are its highest-value entries.

Patterns (`AP()` area fills, `LC()` lines) are stage 6+, deliberately last:
they are a different mechanism (seamless tiling, no pivot centring — which
`pack.rs`'s `PATTERN_LITERAL_KEYS` already ran into), and the vendored set has
only `area-g`/`area-m`/`cable`/`pipeline`.

## Still un-themed after all this (found 2026-07-28, from the user's report)

The "un-themed magenta" report had THREE independent causes, only one of
which was the sprite shadowing above. The other two:

- **The theme editor could not reach the S-52 table.** `ThemeOverridePatch`
  simply had no `s52` field — an explicit v1 scope call, reasoned as
  "presentation-library data, not this app's own choice". Wrong twice: the
  twelve theme JSONs already carry twelve *different* S-52 tables, and those
  tokens (`CHMGD`/`CHMGF`/`TRFCD`/`TRFCF`) are what every restricted-area
  boundary, caution line and separation-zone fill is painted in. So the one
  family of chart colours a mariner would most want to retune was the one
  family the editor could not touch — "changing colors in the theme editor
  doesn't apply to it either". **FIXED**: the group is in the editor now.
- **`CHMGD` is barely retuned across the light themes.** day `rgb(197,69,195)`
  vs paper `rgb(180,60,170)`, slick `(190,66,176)`, whiteback `(168,59,166)`,
  graphite `(175,75,165)` — all within a few percent of each other and of the
  S-52 default, while a neighbour like `TRFCD` swings all the way to amber.
  So even with the editor fixed, the shipped values still read as "the same
  magenta everywhere". Now a JSON edit rather than a code change; the editor's
  "Export as JSON" is the intended path.
- **The selected-area overlay is a hardcoded day literal.** `MARKER_MAGENTA`
  = `#c800c8` in `frontend/src/core/style/colors.ts`, used by
  `info/highlight.ts` (the selection outline and wash), `InfoMarker.tsx` and
  MapView's crosshair. Its own comment already admits "a parallel table is
  still owed if they ever go palette-aware". NOT yet fixed — it needs a new
  theme key, which means all 12 JSONs, `bundled.generated.ts` AND the theme
  editor, or it is a half-fix.

## Open decisions for the user

- **Two low-confidence port-map picks are visibly wrong** — rendered and
  eyeballed, not merely suspected. `TNKFRM01/11`→`barrel` draws a mooring
  barrel BUOY lying in water for a tank farm; `TNKCON02/12`→`cylinder` is a
  can-buoy on a stick. Only `TOWERS01/03`→`tower` holds up. These override a
  decision `industrial.rs` had already documented and rejected — the override
  is recorded in that module's doc rather than left silent. Revert to
  placeholders, or find better artwork.
- **6 emitted tokens have no artwork anywhere**: `DANGER53`,
  `DGPS01DRFSTA01`, `FLTHAZ02`, `FOULGND1`, `LNDARE01`, `LOWACC03`. Pinned by
  `NO_ARTWORK` in `chartcore/tests/derive_symbol_coverage.rs`, which asserts
  they are BOTH still emitted AND still unresolvable, so this list cannot rot.
  Two are misfiled rather than missing: `derive/` emits the concatenation
  `DGPS01DRFSTA01` where the port map lists `DGPS01` and `DRFSTA01`
  separately, and `FOULGND1` is invoked by S-52 as an area pattern (`AP`), so
  it probably belongs in the `drop` block.
- **Lights never reach the light colour table.** `recolor_variant` tries
  `colour_hex` before `light_colour_hex`, and every `LIGHT_COLOURS` word
  except `generic` also exists in `OBJECT_COLOURS` — so `light/white` renders
  `#ffffff` where genicons.py gives `#fab20b`, and `light/orange` renders
  `#f7a837` not `#fa870b`. Seven `lit-*` roles are dead as a result. This is a
  real upstream-parity bug and lights are the highest-value dusk/night case,
  but fixing it changes day bytes — which is exactly what the sentinel work's
  byte-identity proof depends on. Its own task, deliberately not folded in.
- **The dev fixture chart is stale.** `backend/data/charts/US5OAKIQ/
  US5OAKIQ.pmtiles` is a pre-baked file still holding pre-rename tokens, and
  `TILE_SCHEMA_VERSION` does not invalidate a baked file. Needs `just ingest`
  — which also rewrites `backend/data/poi/pois.pmtiles`, a committed test
  fixture, so do it deliberately. Deployed o-charts sets are serve-time
  derived and ARE covered by the bump.
- **Every placeholder is palette-fixed.** `pack::render` short-circuits them,
  so the 30 placeholder keys stay day-coloured on every palette. Still a
  strict improvement — they now DRAW on dusk/night, where they drew nothing.
  `placeholders.json` is the worklist.
- **Day's 18 chrome tokens cannot be runtime-edited.** They are Tailwind's
  `@theme static` declaration site and the pre-JS first-paint default, so
  `/themes.css` emits no day block and editing `day.json`'s `chrome` does
  nothing. The one place "runtime-updatable" is false. The theme editor marks
  them rather than offering a control that silently no-ops.
