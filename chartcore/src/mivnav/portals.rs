// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! §8.1's "portals: boundary crossings between components and tiles",
//! and the start of §8.2's capacity.
//!
//! # What a portal is, concretely
//!
//! The doc names two things a portal marks a crossing OF — components
//! and tiles — and this module builds the reading that makes both real
//! without inventing a second graph on top of what Phase 2/3a already
//! computed: a portal is one maximal run of a [`super::stitch::StitchRun`]
//! where BOTH sides are navigable at the given band. Two consequences
//! fall out of that directly:
//!
//! * It is always a TILE crossing, because it is always a sub-run of a
//!   `StitchRun`, which only ever exists between two different tiles.
//! * The two sides are always in the SAME [`super::topology::Components`]
//!   label, because [`super::topology::union_stitch_run`] already unions
//!   any such navigable pair — a portal never bridges two DIFFERENT
//!   components (nothing in this architecture has a search that would
//!   ever need to cross between two components at the SAME band; §9's
//!   query is a search WITHIN one component). What it marks is the
//!   ACCELERATION point for §12's corridor search: "here is a tile
//!   boundary within this component, with this capacity" is exactly the
//!   §8.2 scan §12 wants, instead of a per-cell rescan of `built.stitch`.
//!
//! # Splitting a run into portals
//!
//! A single `StitchRun` can be PARTIALLY navigable (a tile boundary
//! where some of the run is open water and some is not). Portals are the
//! maximal CONTIGUOUS sub-runs (in the run's own `expand()` walk order)
//! where every pair is mutually navigable — one `StitchRun` can produce
//! zero, one, or several portals.
//!
//! # Bidirectional, exactly like `StitchRun` itself
//!
//! `built.stitch` already carries every seam twice — once from each
//! tile's own side (stitch.rs's documented judgment call: a lookup by
//! `tile` id alone must work from either side without a second index).
//! [`detect_portals`] walks every run, so one physical seam produces TWO
//! `Portal`s, one per direction, mirroring that same convention rather
//! than de-duplicating it away — a corridor search entering a tile needs
//! to find "which portal did I just cross" by tile id symmetrically,
//! same as `union_stitch_run` does for connectivity.
//!
//! # Capacity: `max_draft`, `min_horizontal_width`, `lower_bound_cost`, `touches_fairway`/`touches_tss`
//!
//! §8.2 lists `max_draft`, `max_air_draft`, `min_horizontal_width` and
//! `lower_bound_cost` as this phase's capacity fields. All but
//! `max_air_draft` are built here:
//!
//! * `max_draft` comes straight from `depth_min` (the SHALLOWEST charted
//!   bound — §5.2's own conservative direction), the minimum over every
//!   member cell on both sides. This needs nothing this phase does not
//!   already have.
//! * `lower_bound_cost` turned out NOT to need the separate portal-to-
//!   portal graph search this doc originally expected (§8.4's shortcuts
//!   ARE built from exactly such a search, over the whole CHAIN a
//!   `Shortcut` contracts) — a single PORTAL's own lower bound is just
//!   the tile-to-tile distance heuristic every search at this layer
//!   already computes per edge, cached here instead of recomputed on
//!   every query. See [`Portal::lower_bound_cost_mm`]'s own docs for the
//!   exact formula (identical to `Shortcut::lower_bound_mm`'s).
//! * `min_horizontal_width` is the portal-local distance transform the
//!   plan named — see the whole section below, which is where the real
//!   design work of this field lives.
//! * `max_air_draft` needs real `VERCLR` numbers, which `flags`' own
//!   `FLAG_OVERHEAD` is explicitly a PRESENCE bit, not a value —
//!   [`super::field`]'s own docs: "the artifact never knows the boat's
//!   mast". A real number needs the semantics store this crate has not
//!   built yet. Deferred, not guessed at.
//!
//! Alongside that (Phase 5 — "the cheapest phase", per the plan, since
//! most of the underlying data already existed): [`Portal::touches_
//! fairway`]/[`Portal::touches_tss`], read straight off the SAME per-cell
//! `FLAG_FAIRWAY`/`FLAG_TSS` bits [`super::field::rasterize_tile`]
//! already stamps for the fine search's own preference weights. This is
//! NOT the semantics store `max_air_draft` above still needs — a boolean
//! presence bit already lived on every cell; this phase's only new work
//! is reading it once per crossing instead of once per fine-search cell.
//! [`super::query::topology_route_with`] is what actually spends these —
//! see its own docs for the cost model.
//!
//! # `min_horizontal_width`: how wide is the water AT this crossing
//!
//! The plan's own wording: "portal-local width via a Felzenszwalb–
//! Huttenlocher distance transform — reusing
//! `routing::raster::distance_field::DistanceField` directly". Reusing
//! the transform is the easy half; every real decision is about what to
//! run it over and what to read out of it. Five, each resolved here and
//! each revisitable on its own:
//!
//! **1. What the number MEANS.** `min_horizontal_width_dm` is the
//! diameter of the largest disc of navigable water (at this band) that
//! can be centred somewhere on this crossing: the classic medial-axis
//! reading of a clearance field, and the one quantity a beam constraint
//! actually wants ("can a hull this wide sit on this crossing at all").
//! It is deliberately NOT the minimum over the crossing's own cells: a
//! crossing spans the channel from bank to bank, so its END cells sit
//! against the bank BY CONSTRUCTION and have ~zero clearance — a
//! minimum would report ~one cell for every portal in the region and
//! carry no information at all. The MAXIMUM over the crossing is the
//! narrowest thing the crossing itself imposes, which is what §8.2 is
//! after. It is also not the run's own cell count times a cell size:
//! that overstates an OBLIQUE crossing (a channel meeting the seam at
//! 45° has a seam run √2 times its real width) and ignores hazards that
//! sit just off the seam but pinch the disc.
//!
//! **2. Where the number is READ.** At the crossing itself: the two
//! window cell lines immediately either side of the seam, over the
//! crossing's own along-seam extent. NOT swept up/downstream. A sweep
//! (min over several offsets into each tile) was considered and
//! rejected: a channel that BENDS just past the seam — extremely common
//! in the real harbour geometry this artifact is built for — has an
//! offset line that is entirely land inside the crossing's own along
//! range, so a min-over-offsets would report ~zero width for a perfectly
//! usable crossing. A pinch BETWEEN two seams is not this field's job
//! and never was: §8.4's own rule is that "the topology is an
//! acceleration structure and never overrides §5.2 or §16" — the exact
//! verifier and (Phase 6) §12.4's local refinement are what enforce
//! clearance along a real leg, at the real resolution.
//!
//! **3. The window.** A square-ish window centred on the crossing:
//! `margin` fine cells beyond each end of the crossing's along-seam
//! extent, and `margin` fine cells into EACH tile across the seam, where
//! `margin = along_cells.clamp(8, 32)` and `along_cells` is the
//! crossing's own length in fine cells. Sized off the portal's own run
//! because the disc this measures is usually bounded by that run
//! anyway — blocked ground is what ends a run, except where a run
//! instead ends at a TILE CORNER, which is exactly the case the
//! saturation below already handles by understating — so looking much
//! further is measurably wasted work; floored at 8 cells so a
//! one-cell crossing still gets a window with real geometry in it, and
//! ceilinged at 32 cells to bound the per-portal cost (a whole-tile-edge
//! crossing is `TILE_CELLS` = 256 cells long; at the ceiling its window
//! is 320x64 cells, not 768x512). The ceiling is what makes the value
//! SATURATING: the field is a truncated clearance, so
//! `min_horizontal_width_dm` is exact up to the cap and reads "at least
//! this wide" above it. The cap is `margin - 1 - sqrt(2)/2` cells of
//! RADIUS, not a round `margin`, and the shortfall is not fudge: the
//! window is centred on the SEAM while the cells it is read from are
//! half a cell off it, so the window only provably contains every
//! blocked cell within `margin - 1` cells of a crossing cell, and the
//! half-diagonal is the same blocked-cell-footprint discount
//! [`CELL_HALF_DIAGONAL`] applies everywhere else. Capping at a round
//! `margin` instead would let a saturated reading exceed the true
//! clearance by up to ~1.7 cells — small, but on the wrong side of a
//! bound whose whole job is to never be generous. That cap is relative
//! to the tile's own resolution, which is the right scale — a
//! tile is fine because the ground under it is intricate (§4.3's
//! triggers), and that is exactly where tens of metres of width matter;
//! a 1024 m open-water tile saturates at kilometres, where nothing
//! floats that cares.
//!
//! **4. The coarse/fine seam.** The window is rasterized at the FINER of
//! the two tiles' `cell_world`, never the coarser: a coarse
//! rasterization would smear a fine tile's real hazard away and
//! OVERSTATE the channel, the one direction a safety-relevant capacity
//! bound must never go. [`super::field::RegionLattice`]'s power-of-two
//! guarantee is what makes this exact rather than approximate — every
//! fine window cell nests wholly inside exactly one cell of whichever
//! tile covers it, so sampling the coarse side is a replication, not a
//! resample. The crossing's own along extent is taken as the
//! INTERSECTION of the two sides' member ranges (i.e. the finer side's
//! ground), which also makes the measurement identical for a seam's two
//! directional `Portal`s — see `stitch.rs`'s bidirectional convention,
//! and `both_directions_of_one_seam_measure_the_same_width` below.
//!
//! **5. What counts as BLOCKED.** Exactly what `components` already
//! says: a window cell is free iff the cell covering it carries THIS
//! portal's own component label. That is `bands::navigable` at this
//! band (`label_band` labels every navigable cell and only those), so
//! the width is the width of the channel *this band's* vessel can use —
//! a shoal that a 3 m draft cannot cross does narrow the channel for it,
//! and land-only would have overstated exactly that case. Requiring the
//! SAME component additionally answers "whose water is this": a
//! navigable pool on the far side of a spit is not this crossing's
//! channel. Two consequences, both deliberately on the pessimistic side:
//! ground covered by NEITHER of the two tiles (past a tile corner, or a
//! third tile's) is treated as blocked, so a crossing whose channel
//! continues into a diagonal neighbour reads NARROWER than it is; and a
//! window cell only partly covered by a tile is blocked too. Both
//! understate, never overstate. The optimism `bands.rs` documents for
//! MIXED depth cells is inherited unchanged and is the one place this
//! number can be generous — the same trade the components themselves
//! already make, resolved by §16, not here.
//!
//! **Cost.** One transform per portal, bounded by the window ceiling
//! rather than by how much coastline is nearby — the same property
//! `routing::raster::distance_field`'s own docs claim for its first
//! consumer. Measured (release, the real DE6OSTIM region): ~500 µs per
//! portal, essentially all of it the window fill plus the transform's
//! own per-row/column allocations. Irrelevant beside `build_region`'s
//! rasterization on the same input, and it rides on a walk that already
//! exists — but it IS the dominant cost of this pass, so if a
//! whole-chart-set build ever needs the time back, reusing one scratch
//! buffer across portals (rather than allocating per portal) is the
//! obvious lever, before anything cleverer.
//!
//! Finally, §8.3's demotion rule: a marginal-width portal is FLAGGED for
//! query-time refinement, never rejected by the capacity scan.
//! [`detect_portals`] therefore filters nothing on width — every portal
//! it would have emitted before this field existed is still emitted,
//! byte for byte, with a measured width attached. Nothing in the query
//! path reads it yet (`topology_route_with` filters on
//! `required_draft_dm` only); wiring a real beam threshold to it belongs
//! with Phase 6's local refinement, which is what a demoted portal would
//! be demoted TO.
//!
//! A `Portal` this phase produces is real and usable for `max_draft`
//! feasibility, `min_horizontal_width` beam feasibility, an admissible
//! cost lower bound, and fairway/TSS preference today; only
//! `max_air_draft` belongs to a later, separately scoped commit, with
//! its own real subsystem behind it.

use rayon::prelude::*;

use crate::coords::WorldXy;
use crate::routing::artifact::cost::{heuristic_mm, MIN_MULTIPLIER};
use crate::routing::raster::distance_field::DistanceField;

use super::build::BuiltRegion;
use super::field::TileEntry;
use super::format::{
    BandTag, BAND_TAG_LEN, DEPTH_NO_COVERAGE, DEPTH_UNIT_DM_PER_M, FLAG_FAIRWAY, FLAG_TSS,
};
use super::stitch::{resolve_run_pair, Side, StitchRun};
use super::topology::{Components, NO_COMPONENT};

/// One tile-boundary crossing, entirely within one [`Components`]
/// labelling.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Portal {
    /// Canonical id — §13.1's "not an accident of build order", same
    /// convention [`super::topology::Components`] already uses: assigned
    /// by ascending lowest-member flat cell index.
    pub id: u32,
    /// The component both sides belong to (see the module docs for why
    /// there is only ever one).
    pub component: u32,
    pub tile: u32,
    pub tile_start: u16,
    pub tile_end: u16,
    pub neighbour_tile: u32,
    pub neighbour_start: u16,
    pub neighbour_end: u16,
    /// Decimetres — see the module docs' capacity section. `u16::MAX`
    /// (== [`super::format::DEPTH_NO_COVERAGE`]) never occurs: every
    /// member cell is navigable at the band `components` was built for,
    /// which already excludes the sentinel (`bands::navigable`'s own
    /// defensive rule).
    pub max_draft_dm: u16,
    /// Decimetres — §8.2's own second capacity field: the DIAMETER of the
    /// widest disc of band-navigable water that can be centred anywhere
    /// on this crossing, i.e. how wide a hull this crossing admits at
    /// all. See the module docs' `min_horizontal_width` section for the
    /// full design (what it means, where it is read, the window, the
    /// coarse/fine seam, and what counts as blocked) — everything below
    /// is only the part a caller must not misread:
    ///
    /// * **SATURATING, never a sentinel.** The measurement is truncated
    ///   at a cap set by the window's own reach (below the window
    ///   margin, not equal to it — see the module docs' design point 3),
    ///   so a value at the cap means "at least this wide", not "exactly
    ///   this wide"; `u16::MAX` likewise means "at least 6553.5 m" (a
    ///   real reading on an open-water seam, NOT
    ///   [`super::format::DEPTH_NO_COVERAGE`]'s no-data meaning — this
    ///   field has no no-data value).
    /// * **`0` means "not measurable here"**, which only a structurally
    ///   broken tile entry (non-positive `cell_world`, a `rung` outside
    ///   the resolution ladder, an absurd cell count) can produce — the
    ///   same conservative direction [`shallowest_dm`] takes on a corrupt
    ///   file, and safe precisely because nothing filters on this field
    ///   (see the next point).
    /// * **Nothing is rejected on it.** §8.3 demotes a marginal-width
    ///   portal to query-time refinement rather than dropping it, so
    ///   [`detect_portals`]'s own output is unchanged by this field
    ///   existing.
    pub min_horizontal_width_dm: u16,
    /// Does ANY member cell on EITHER side of this crossing carry
    /// [`super::format::FLAG_FAIRWAY`]? Read straight off the SAME bit
    /// [`super::field::rasterize_tile`] already stamps from `RECTRC`/
    /// `NAVLNE`/`DWRTPT`/marked-fairway geometry — no new classification,
    /// just reused at this layer's own portal granularity. Used by
    /// [`super::query::topology_route_with`]'s own soft-preference cost
    /// (Phase 5, §21's "cheapest phase" per the plan — most of the
    /// underlying data already existed). OR'd across the whole crossing
    /// (not "every cell"): a portal is "in a fairway" if any part of it
    /// is, matching the discount direction being the SAFE one to
    /// over-apply (a route gets nudged toward a fairway a little too
    /// eagerly, never AWAY from one it should have preferred).
    pub touches_fairway: bool,
    /// Same as [`Self::touches_fairway`], for [`super::format::FLAG_TSS`]
    /// — a TSS-family zone this crossing should be soft-avoided through,
    /// not the hard directional rule Phase 7 will eventually add.
    pub touches_tss: bool,
    /// Millimetre fixed-point (§13.1), admissible LOWER bound on the real
    /// cost of crossing this one portal — `heuristic_mm` at
    /// `MIN_MULTIPLIER` (`routing::artifact::cost`) over
    /// [`super::field::TileEntry::centre_distance_m`] between `tile` and
    /// `neighbour_tile`, the IDENTICAL formula
    /// [`super::shortcuts::Shortcut::lower_bound_mm`] already uses for a
    /// whole contracted CHAIN of portals — see that field's own docs for
    /// the full admissibility argument, which applies here unchanged:
    /// `topology_route_with`'s own per-portal multiplier floors at
    /// `MIN_MULTIPLIER`, which is what keeps this a true lower bound
    /// against ANY [`super::query::TopologyWeights`] combination, today
    /// or later. Of §8.2's own Portal capacity fields only
    /// `max_air_draft` is still deferred (see the module docs' capacity
    /// section).
    pub lower_bound_cost_mm: i64,
}

/// Every portal in `built`, for the SAME band `components` was labelled
/// at ([`super::topology::label_band`]'s own return value — this
/// function trusts it rather than re-deriving navigability, so passing a
/// `Components` from a DIFFERENT band silently produces nonsense).
///
/// Canonically numbered: sorted by each portal's own lowest-member flat
/// cell index before assigning ids, exactly [`Components`]'s own
/// convention.
pub fn detect_portals(built: &BuiltRegion, components: &Components) -> Vec<Portal> {
    // `components` is indexed by the SAME flat SoA order `built`'s own
    // columns use, and `min_horizontal_width_dm`'s window samples it by
    // that index — a mismatched length would read as "blocked" past the
    // end and silently narrow every portal near it. `label.get()` keeps
    // that from panicking; this makes it loud in tests instead. Same
    // caller-bug-not-file-corruption reasoning `topology::label_band`'s
    // own length debug_asserts already state.
    debug_assert_eq!(components.label.len(), built.depth_min.len());

    // `(Portal, lowest-member flat cell index, run index)`. `low` is the
    // canonical sort key (§13.1); `run_ix` is the tiebreak that keeps the
    // order a TOTAL one regardless of which worker finished first. `low`
    // is unique within a run (consecutive groups are split by a flush, so
    // their member cells never overlap), but a CORNER cell shared by two
    // seams could be the `low` of a portal on each — so two entries can
    // collide on `low` alone. The serial `for run in &built.stitch` loop
    // this replaces broke that tie by append order, i.e. ascending run
    // index; `(low, run_ix)` reproduces that exactly.
    //
    // Each stitch run is otherwise walked independently — a run's open
    // groups never reference another run's cells — so `rayon`'s
    // `flat_map_iter` fans the walk out while keeping each run's own
    // serial open-group state machine intact inside the closure.
    // Byte-identical to the serial loop (`mivnav_persist_de6ostim.rs`
    // pins the portals section round-trip on a real 52-tile cell).
    let mut raw: Vec<(Portal, usize, u32)> = built
        .stitch
        .par_iter()
        .enumerate()
        .flat_map_iter(|(run_ix, run)| {
            let run_ix = run_ix as u32;
            let mut out: Vec<(Portal, usize)> = Vec::new();
            let (Some(tile), Some(neighbour)) = (
                built.tiles.get(run.tile as usize),
                built.tiles.get(run.neighbour_tile as usize),
            ) else {
                return with_run_ix(out, run_ix);
            };
            let ctx = RunCtx {
                components,
                run,
                tile,
                neighbour,
                neighbour_side: run.side.opposite(),
            };
            let neighbour_side = ctx.neighbour_side;

            // One open group at a time. Flushed whenever the walk hits a
            // non-navigable, different-component, or (a corrupted file's)
            // out-of-range pair, or at the run's own end.
            let mut open: Option<OpenGroup> = None;

            for (a_idx, b_idx) in run.expand() {
                // Shared with `topology::union_stitch_run` — see
                // `resolve_run_pair`'s own docs for why a corrupted or
                // version-skewed file must not panic here.
                let Some((a, b)) =
                    resolve_run_pair(tile, run.side, neighbour, neighbour_side, a_idx, b_idx)
                else {
                    flush(open.take(), &ctx, &mut out);
                    continue;
                };
                let a_label = components.label.get(a).copied().unwrap_or(NO_COMPONENT);
                let b_label = components.label.get(b).copied().unwrap_or(NO_COMPONENT);
                let joined = a_label != NO_COMPONENT && a_label == b_label;

                if !joined {
                    flush(open.take(), &ctx, &mut out);
                    continue;
                }
                let draft = shallowest_dm(&built.depth_min, a, b);
                let lowest = a.min(b);
                let fairway = has_flag(&built.flags, a, b, FLAG_FAIRWAY);
                let tss = has_flag(&built.flags, a, b, FLAG_TSS);
                match &mut open {
                    // Extend: this pair continues the current group.
                    // Either side advancing by exactly one is a genuine
                    // continuation — the coarse side can legitimately
                    // repeat across several fine steps, per `expand()`'s
                    // own grouped-pairing shape, so only ONE of the two
                    // need move for this to still be the same crossing.
                    Some(g) if g.tile_end == a_idx || g.neighbour_end == b_idx => {
                        g.tile_end = a_idx + 1;
                        g.neighbour_end = g.neighbour_end.max(b_idx + 1);
                        g.max_draft_dm = g.max_draft_dm.min(draft);
                        g.lowest_member = g.lowest_member.min(lowest);
                        g.touches_fairway |= fairway;
                        g.touches_tss |= tss;
                    }
                    _ => {
                        flush(open.take(), &ctx, &mut out);
                        open = Some(OpenGroup {
                            tile_start: a_idx,
                            tile_end: a_idx + 1,
                            neighbour_start: b_idx,
                            neighbour_end: b_idx + 1,
                            component: a_label,
                            max_draft_dm: draft,
                            lowest_member: lowest,
                            touches_fairway: fairway,
                            touches_tss: tss,
                        });
                    }
                }
            }
            flush(open.take(), &ctx, &mut out);
            with_run_ix(out, run_ix)
        })
        .collect();

    // §13.1's canonical order — "not an accident of build order". Sort by
    // `low` (unique within a run), then `run_ix` to break a cross-seam
    // corner-cell tie the way the old serial append order did. The `id`
    // is assigned only after this, so it is a pure function of the
    // sorted position.
    raw.sort_by_key(|&(_, low, run_ix)| (low, run_ix));
    raw.into_iter()
        .enumerate()
        .map(|(id, (mut p, _, _))| {
            p.id = id as u32;
            p
        })
        .collect()
}

/// Tag each of a run's `(portal, low)` results with the run's index, so
/// `detect_portals`' final sort has a total order even though `rayon`
/// finishes the runs in an arbitrary order. One concrete iterator type,
/// so both of `flat_map_iter`'s exit paths agree.
fn with_run_ix(v: Vec<(Portal, usize)>, run_ix: u32) -> impl Iterator<Item = (Portal, usize, u32)> {
    v.into_iter().map(move |(p, low)| (p, low, run_ix))
}

/// One in-progress portal, mid-walk — a named struct rather than a
/// positional tuple specifically so a future edit swapping, say,
/// `tile_end`/`neighbour_end` is a compile error (field name mismatch)
/// rather than a silently-transposed value of the identical type.
struct OpenGroup {
    tile_start: u16,
    tile_end: u16,
    neighbour_start: u16,
    neighbour_end: u16,
    component: u32,
    max_draft_dm: u16,
    lowest_member: usize,
    touches_fairway: bool,
    touches_tss: bool,
}

/// Everything about the ONE [`StitchRun`] currently being walked that
/// [`flush`] needs, resolved once per run instead of per group — a named
/// bundle rather than five positional arguments, so that adding
/// [`Portal::min_horizontal_width_dm`]'s own extra inputs (`components`,
/// which the width window samples, and the neighbour's own side) did not
/// turn `flush`'s four call sites into something unreadable.
struct RunCtx<'a> {
    components: &'a Components,
    run: &'a StitchRun,
    tile: &'a TileEntry,
    neighbour: &'a TileEntry,
    /// `run.side.opposite()` — which of `neighbour`'s own edges this run
    /// lands on, per [`Side::opposite`]'s own docs.
    neighbour_side: Side,
}

fn flush(group: Option<OpenGroup>, ctx: &RunCtx, out: &mut Vec<(Portal, usize)>) {
    if let Some(g) = group {
        out.push((
            Portal {
                id: 0, // assigned by the caller's final canonicalization pass
                component: g.component,
                tile: ctx.run.tile,
                tile_start: g.tile_start,
                tile_end: g.tile_end,
                neighbour_tile: ctx.run.neighbour_tile,
                neighbour_start: g.neighbour_start,
                neighbour_end: g.neighbour_end,
                max_draft_dm: g.max_draft_dm,
                min_horizontal_width_dm: portal_width_dm(ctx, &g),
                touches_fairway: g.touches_fairway,
                touches_tss: g.touches_tss,
                lower_bound_cost_mm: heuristic_mm(
                    ctx.tile.centre_distance_m(ctx.neighbour),
                    MIN_MULTIPLIER,
                ),
            },
            g.lowest_member,
        ));
    }
}

// ---------------------------------------------------------------------------
// §8.2's `min_horizontal_width` — the portal-local clearance transform.
// Every judgment call below is argued in the module docs' own
// `min_horizontal_width` section; the comments here only say what the
// code does.
// ---------------------------------------------------------------------------

/// Window margin either side of the crossing, in FINE cells: the floor
/// and ceiling on the crossing's own along-seam length (module docs,
/// design point 3). The ceiling is also what makes
/// [`Portal::min_horizontal_width_dm`] saturate — at
/// `2 * (ceiling - 1 - CELL_HALF_DIAGONAL)` = 60.586 fine cells, not at
/// a round `2 * ceiling`; the shortfall is the window's own guaranteed
/// reach, derived where it is used rather than restated as a constant.
const WIDTH_MARGIN_MIN_CELLS: i64 = 8;
const WIDTH_MARGIN_MAX_CELLS: i64 = 32;

/// Defensive ceiling on one window's cell count. Unreachable for any
/// tile [`super::field::RegionLattice`] produces ([`super::field::
/// TILE_CELLS`] = 256 caps a real crossing at a 320x64 window); real
/// only for a corrupted or version-skewed tile index claiming a
/// `cols`/`rows` in the tens of thousands, which must not turn into a
/// gigabyte allocation.
const WIDTH_WINDOW_MAX_CELLS: i64 = 1 << 20;

/// Half the diagonal of one raster cell, in cells.
///
/// [`DistanceField`] measures centre-to-centre, but a blocked cell is a
/// whole cell of blocked GROUND, and every point of it lies within
/// `sqrt(2)/2` of its own centre — so a disc of radius
/// `dist - sqrt(2)/2` around a free cell's centre is guaranteed to touch
/// no blocked cell's area at all, while `dist` itself is not. Subtracted
/// rather than ignored for the same reason `MIN_MULTIPLIER` floors and
/// "shallowest wins" exist in this crate: the whole point of a capacity
/// bound is that it is never generous.
const CELL_HALF_DIAGONAL: f64 = std::f64::consts::SQRT_2 / 2.0;

/// Which world axis runs ACROSS a seam, and which runs ALONG it.
///
/// A West/East seam is a vertical line: crossing it moves in world x,
/// and the crossing's own extent runs in world y. North/South is the
/// transpose. Naming the two roles (rather than branching on [`Side`]
/// four times) is what lets one window builder serve both orientations.
#[derive(Clone, Copy, PartialEq, Eq)]
enum SeamAxis {
    /// West/East seam: across = world x, along = world y.
    AcrossX,
    /// North/South seam: across = world y, along = world x.
    AcrossY,
}

impl SeamAxis {
    fn of(side: Side) -> SeamAxis {
        match side {
            Side::West | Side::East => SeamAxis::AcrossX,
            Side::North | Side::South => SeamAxis::AcrossY,
        }
    }

    /// A tile-local `(across, along)` index pair as `(col, row)`.
    fn col_row(self, across: i64, along: i64) -> (i64, i64) {
        match self {
            SeamAxis::AcrossX => (across, along),
            SeamAxis::AcrossY => (along, across),
        }
    }

    /// `tile`'s own world bounds as
    /// `(across_min, across_max, along_min, along_max)`.
    fn tile_bounds(self, tile: &TileEntry) -> (i64, i64, i64, i64) {
        let cw = i64::from(tile.cell_world);
        let x0 = i64::from(tile.origin_x);
        let y0 = i64::from(tile.origin_y);
        let x1 = x0 + i64::from(tile.cols) * cw;
        let y1 = y0 + i64::from(tile.rows) * cw;
        match self {
            SeamAxis::AcrossX => (x0, x1, y0, y1),
            SeamAxis::AcrossY => (y0, y1, x0, x1),
        }
    }
}

/// The world coordinate of `tile`'s own `side` edge — the seam line
/// itself. Both directions of one seam necessarily produce the same
/// number (one tile's East edge IS its eastern neighbour's West edge),
/// which is half of why the two directional portals measure identically.
fn seam_coord(tile: &TileEntry, side: Side) -> i64 {
    let cw = i64::from(tile.cell_world);
    match side {
        Side::West => i64::from(tile.origin_x),
        Side::East => i64::from(tile.origin_x) + i64::from(tile.cols) * cw,
        Side::North => i64::from(tile.origin_y),
        Side::South => i64::from(tile.origin_y) + i64::from(tile.rows) * cw,
    }
}

/// The world-unit ALONG range `[lo, hi)` that `tile`'s own edge cells
/// `start..end` cover.
fn along_range(tile: &TileEntry, side: Side, start: u16, end: u16) -> (i64, i64) {
    let cw = i64::from(tile.cell_world);
    let origin = match SeamAxis::of(side) {
        SeamAxis::AcrossX => i64::from(tile.origin_y),
        SeamAxis::AcrossY => i64::from(tile.origin_x),
    };
    (origin + i64::from(start) * cw, origin + i64::from(end) * cw)
}

/// Which of `tile`'s four edges `neighbour` sits across, or `None` when
/// the two are not edge-adjacent at all (a corrupted stitch table, or a
/// caller pairing tiles that never shared a seam). The global tile
/// lattice guarantees an adjacent neighbour's near edge coincides
/// exactly with `tile`'s far edge, so comparing the two tiles' bounds
/// against the shared coordinate is all this needs — a differently-sized
/// neighbour on the resolution ladder still meets `tile`'s edge exactly,
/// it just does not span the whole of it.
fn seam_side(tile: &TileEntry, neighbour: &TileEntry) -> Option<Side> {
    let t = tile.extent();
    let n = neighbour.extent();
    // A real shared EDGE needs the OTHER axis's ranges to actually
    // overlap, not merely touch at a corner: a neighbour that satisfies
    // `n.xmin >= t.xmax` *and* `n.ymin >= t.ymax` shares only the SE
    // corner point, no seam — return `None` there, as the doc promises,
    // rather than reporting a seam that has zero length.
    let y_overlap = n.ymin < t.ymax && n.ymax > t.ymin;
    let x_overlap = n.xmin < t.xmax && n.xmax > t.xmin;
    if n.xmin >= t.xmax && y_overlap {
        Some(Side::East)
    } else if n.xmax <= t.xmin && y_overlap {
        Some(Side::West)
    } else if n.ymin >= t.ymax && x_overlap {
        // `Extent`'s y grows SOUTH — the larger-y edge is the South one
        // (`Side`'s own docs).
        Some(Side::South)
    } else if n.ymax <= t.ymin && x_overlap {
        Some(Side::North)
    } else {
        None
    }
}

/// A representative world point for `portal`'s tile-boundary crossing:
/// the midpoint of the crossing's own along-seam extent, sitting exactly
/// on the shared seam line between [`Portal::tile`] and
/// [`Portal::neighbour_tile`].
///
/// This is the point [`super::refine::refine_demoted_route`] brackets a
/// dense route around when it consumes
/// [`super::query::TopologyRoute::demoted_portals`]. It does not need to
/// be the exact narrowest point of the gap — only close enough to pick
/// out which leg of the fine route crosses this demoted portal. `None`
/// when either tile index is out of range, or the two tiles are not
/// edge-adjacent (see [`seam_side`]).
pub fn portal_crossing_point(built: &BuiltRegion, portal: &Portal) -> Option<WorldXy> {
    let tile = built.tiles.get(portal.tile as usize)?;
    let neighbour = built.tiles.get(portal.neighbour_tile as usize)?;
    let side = seam_side(tile, neighbour)?;
    let across = seam_coord(tile, side);
    let (lo, hi) = along_range(tile, side, portal.tile_start, portal.tile_end);
    let along = (lo + hi) / 2;
    let (x, y) = SeamAxis::of(side).col_row(across, along);
    let clamp = |v: i64| v.clamp(i32::MIN as i64, i32::MAX as i64) as i32;
    Some(WorldXy::new(clamp(x), clamp(y)))
}

/// One portal's own local raster: `blocked` at the finer of the two
/// tiles' cell sizes, indexed `along * across_n + across`.
struct WidthWindow {
    axis: SeamAxis,
    /// World coordinate of the window's first cell, per axis role.
    across0: i64,
    along0: i64,
    /// World units per window cell — the FINER tile's `cell_world`.
    cell_world: i64,
    across_n: i64,
    along_n: i64,
    blocked: Vec<bool>,
}

impl WidthWindow {
    /// Everything blocked to start with: a window cell is opened only by
    /// a tile that genuinely covers it and calls it navigable, so ground
    /// no tile in `[tile, neighbour]` reaches stays blocked (module docs,
    /// design point 5).
    fn new(
        axis: SeamAxis,
        across0: i64,
        along0: i64,
        cell_world: i64,
        across_n: i64,
        along_n: i64,
    ) -> WidthWindow {
        WidthWindow {
            axis,
            across0,
            along0,
            cell_world,
            across_n,
            along_n,
            blocked: vec![true; (across_n * along_n) as usize],
        }
    }

    /// Free every window cell that `tile` covers WHOLLY and labels with
    /// `component`.
    ///
    /// Exact, not resampled: [`super::field::RegionLattice`] guarantees
    /// every rung's cell size is a power-of-two multiple of every finer
    /// one and every tile origin lands on every finer lattice, so a fine
    /// window cell nests wholly inside exactly one of `tile`'s cells and
    /// the index arithmetic is integer division with no remainder to
    /// round. The `span_lo`/`span_hi` floor/ceil pair is what keeps a
    /// PARTIALLY covered window cell (only reachable from a tile whose
    /// bounds do not line up, i.e. a corrupt file) blocked rather than
    /// half-read.
    fn mark_navigable(&mut self, tile: &TileEntry, components: &Components, component: u32) {
        let cw = i64::from(tile.cell_world);
        if cw <= 0 || component == NO_COMPONENT {
            return;
        }
        let (a_min, a_max, l_min, l_max) = self.axis.tile_bounds(tile);
        let i_lo = span_lo(a_min - self.across0, self.cell_world).clamp(0, self.across_n);
        let i_hi = span_hi(a_max - self.across0, self.cell_world).clamp(0, self.across_n);
        let j_lo = span_lo(l_min - self.along0, self.cell_world).clamp(0, self.along_n);
        let j_hi = span_hi(l_max - self.along0, self.cell_world).clamp(0, self.along_n);
        if i_lo >= i_hi || j_lo >= j_hi {
            return;
        }
        // The ACROSS index into `tile` is the same for every row of the
        // window, so it is resolved once per column here rather than once
        // per cell in the inner loop below.
        let across_idx: Vec<i64> = (i_lo..i_hi)
            .map(|i| (self.across0 + i * self.cell_world - a_min).div_euclid(cw))
            .collect();
        for j in j_lo..j_hi {
            let along_idx = (self.along0 + j * self.cell_world - l_min).div_euclid(cw);
            for (k, i) in (i_lo..i_hi).enumerate() {
                let (col, row) = self.axis.col_row(across_idx[k], along_idx);
                if !tile.in_range(col, row) {
                    continue;
                }
                let global = super::bands::global_index(tile, col as u32, row as u32);
                if components.label.get(global).copied() == Some(component) {
                    self.blocked[(j * self.across_n + i) as usize] = false;
                }
            }
        }
    }
}

/// First window cell index whose own cell lies entirely at or past
/// `delta` world units (ceiling division).
fn span_lo(delta: i64, cell: i64) -> i64 {
    delta.div_euclid(cell) + i64::from(delta.rem_euclid(cell) != 0)
}

/// One past the last window cell index whose own cell ends at or before
/// `delta` world units (floor division).
fn span_hi(delta: i64, cell: i64) -> i64 {
    delta.div_euclid(cell)
}

/// [`Portal::min_horizontal_width_dm`] for one group, mid-walk — the
/// module docs' `min_horizontal_width` section is the design; this is
/// the arithmetic.
fn portal_width_dm(ctx: &RunCtx, g: &OpenGroup) -> u16 {
    let (tile, neighbour) = (ctx.tile, ctx.neighbour);
    // The FINER of the two tiles sets the window's resolution — never
    // the coarser, which would smear a real fine-tile hazard away and
    // overstate the channel (module docs, design point 4).
    let (finer, coarser) = if tile.cell_world <= neighbour.cell_world {
        (tile, neighbour)
    } else {
        (neighbour, tile)
    };
    let fine_cw = i64::from(finer.cell_world);
    // `cell_size_m_checked`, not `cell_size_m`: `rung` is read straight
    // off a decoded tile index with no validation
    // ([`super::field::TileEntry::parse`]), and this is the first
    // consumer to index the resolution ladder with one — the same
    // never-panic-on-a-corrupt-file rule `resolve_run_pair` states two
    // lines up in `detect_portals`'s own walk. Found by code review,
    // which reproduced the panic on a hand-built `rung: 200` entry.
    //
    // BOTH tiles are checked, not just the finer one whose value is
    // actually used: a `rung` the ladder has no entry for means that
    // tile entry is not trustworthy at all, and checking only the finer
    // side would make one seam's two directional portals disagree (one
    // measuring, one reporting 0) on the same corrupt file.
    let (Some(cell_m), Some(_)) = (finer.cell_size_m_checked(), coarser.cell_size_m_checked())
    else {
        return 0;
    };
    if fine_cw <= 0 || !cell_m.is_finite() || cell_m <= 0.0 {
        return 0;
    }

    let axis = SeamAxis::of(ctx.run.side);
    let seam = seam_coord(tile, ctx.run.side);
    // The crossing's own extent is what the two sides' member cells BOTH
    // cover — for a coarse/fine seam that is the finer side's range, and
    // it is the same ground segment whichever direction of the seam this
    // portal is (module docs, design point 4).
    //
    // Numerically inert, and kept anyway: measured (a deliberate mutant
    // that used `tile`'s own range instead survives the whole suite),
    // because a group only ever ends where one SIDE went blocked, and a
    // blocked cell reads as zero clearance while the cell facing it on
    // the other read line is one cell away from it — so the extra ground
    // the wider range would sweep can never raise the maximum. It stays
    // because it is the honest statement of what the crossing IS, and
    // because it is what makes the two directional portals report the
    // same `along_cells` (and hence the same `margin`, and hence the
    // same saturation cap) rather than merely the same answer today.
    let (t_lo, t_hi) = along_range(tile, ctx.run.side, g.tile_start, g.tile_end);
    let (n_lo, n_hi) = along_range(
        neighbour,
        ctx.neighbour_side,
        g.neighbour_start,
        g.neighbour_end,
    );
    let lo = t_lo.max(n_lo);
    let hi = t_hi.min(n_hi);
    let along_cells = (hi - lo).div_euclid(fine_cw);
    if along_cells <= 0 {
        return 0;
    }

    let margin = along_cells.clamp(WIDTH_MARGIN_MIN_CELLS, WIDTH_MARGIN_MAX_CELLS);
    let across_n = 2 * margin;
    let along_n = along_cells + 2 * margin;
    if across_n.saturating_mul(along_n) > WIDTH_WINDOW_MAX_CELLS {
        return 0;
    }
    let mut window = WidthWindow::new(
        axis,
        seam - margin * fine_cw,
        lo - margin * fine_cw,
        fine_cw,
        across_n,
        along_n,
    );
    window.mark_navigable(tile, ctx.components, g.component);
    window.mark_navigable(neighbour, ctx.components, g.component);

    // The truncated clearance, in metres. The window provably contains
    // every blocked cell within `reach` cells of any crossing cell (the
    // window is centred on the SEAM; a crossing cell's own centre sits
    // half a cell off it, which costs one cell of guaranteed reach on
    // the near side), and `CELL_HALF_DIAGONAL` is the usual discount for
    // the blocked cell's own footprint — so capping the radius there
    // makes the reading exact below the cap and a true lower bound at
    // it, rather than merely bounded by the window. See the module docs'
    // design point 3.
    //
    // Derived from `across_n`, NOT from `margin`, deliberately: the
    // proof above is a statement about how far the WINDOW reaches, and
    // code review demonstrated that writing it as `margin - 1` instead
    // lets a later edit to `across_n` alone (say, halving it for speed)
    // silently make every saturated reading generous, with every test
    // still passing. Tied to the window's own size, that edit changes
    // the cap with it.
    let reach = (across_n / 2 - 1) as f64;
    let cap_m = (reach - CELL_HALF_DIAGONAL).max(0.0) * cell_m;
    let radius_m = match DistanceField::from_blocked(
        window.across_n as u32,
        window.along_n as u32,
        &window.blocked,
    ) {
        // Nothing blocked in the whole window — every crossing cell is
        // at least the cap from anything. Defensive rather than routine:
        // the padding reaches past the crossing's own ends, which are
        // blocked ground or unreached ground either way.
        None => cap_m,
        Some(field) => {
            let mut best = 0.0f64;
            for along in margin..(margin + along_cells) {
                // The two cell lines either side of the seam — half a
                // fine cell apart, so which one a disc is "centred on"
                // is below this raster's own resolution; taking both
                // keeps the reading symmetric between the seam's two
                // directional portals.
                for across in [margin - 1, margin] {
                    let d = field.dist_m(across as i32, along as i32, cell_m);
                    let r = (d - CELL_HALF_DIAGONAL * cell_m).clamp(0.0, cap_m);
                    if r > best {
                        best = r;
                    }
                }
            }
            best
        }
    };

    // Diameter, not radius: the disc's own width is what a hull has to
    // fit through. Saturating at `u16::MAX` — "at least 6553.5 m", a
    // real reading on an open-water seam, never a no-data sentinel.
    // FLOORED, not rounded: rounding to nearest would be up to 5 cm
    // generous, which is nothing in practice but is still the wrong
    // direction for a bound whose every other step is scrupulous about
    // which way it errs (code review's own framing).
    let width_dm = 2.0 * radius_m * f64::from(DEPTH_UNIT_DM_PER_M);
    width_dm.floor().clamp(0.0, f64::from(u16::MAX)) as u16
}

/// `min(depth_min[a], depth_min[b])` in decimetres — the shallowest
/// charted bound on either side of the crossing, §5.2's own conservative
/// direction (`depth_min`, never `depth_max`, is what a real vessel's
/// draft is checked against for "definitely navigable").
fn shallowest_dm(depth_min: &[u16], a: usize, b: usize) -> u16 {
    let da = depth_min.get(a).copied().unwrap_or(DEPTH_NO_COVERAGE);
    let db = depth_min.get(b).copied().unwrap_or(DEPTH_NO_COVERAGE);
    da.min(db)
}

/// Does either `a` or `b` carry `bit` in `flags`? Out-of-range reads as
/// absent, the same defensive direction [`shallowest_dm`] takes on a
/// corrupted/short `flags` column — a missing flag is never treated as
/// "definitely present" from a version-skewed or truncated file.
fn has_flag(flags: &[u8], a: usize, b: usize, bit: u8) -> bool {
    flags.get(a).copied().unwrap_or(0) & bit != 0 || flags.get(b).copied().unwrap_or(0) & bit != 0
}

// ---------------------------------------------------------------------------
// §8.2's on-disk form — SectionKind::Portals, one section per band
// ---------------------------------------------------------------------------

/// Portal record flag bit 0 — [`Portal::touches_fairway`].
const PORTAL_FLAG_FAIRWAY: u8 = 1 << 0;
/// Portal record flag bit 1 — [`Portal::touches_tss`].
const PORTAL_FLAG_TSS: u8 = 1 << 1;

/// Serialized size of one [`Portal`], bytes.
///
/// ```text
/// off  len  field
///   0    4  id                       u32
///   4    4  component                u32
///   8    4  tile                     u32
///  12    4  neighbour_tile           u32
///  16    2  tile_start               u16
///  18    2  tile_end                 u16
///  20    2  neighbour_start          u16
///  22    2  neighbour_end            u16
///  24    2  max_draft_dm             u16
///  26    2  min_horizontal_width_dm  u16
///  28    1  portal_flags             u8   touches_fairway / touches_tss
///  29    3  reserved                      zero, ignored on read
///  32    8  lower_bound_cost_mm      i64
/// ```
///
/// Fields are grouped by width rather than kept in declaration order, so
/// every one lands naturally aligned inside an 8-aligned record — the
/// same nicety [`super::format::FileHeader`]'s own layout keeps, and the
/// precondition a future zero-copy read would need.
///
/// This record covers **every** field of [`Portal`]; adding one is a
/// [`super::format::ArtifactVersions::schema_version`] bump, and
/// `a_portal_record_covers_every_field_of_the_struct` below is the test
/// that makes forgetting it fail loudly rather than silently drop data.
pub const PORTAL_RECORD_LEN: usize = 40;

/// Fixed header length of a [`super::format::SectionKind::Portals`]
/// payload — [`BandTag`], then the record table's own `(count, stride)`
/// header, exactly [`super::field::encode_tile_index`]'s shape.
const PORTALS_HEADER_LEN: usize = BAND_TAG_LEN + 8;

impl Portal {
    fn to_bytes(self) -> [u8; PORTAL_RECORD_LEN] {
        let mut b = [0u8; PORTAL_RECORD_LEN];
        b[0..4].copy_from_slice(&self.id.to_le_bytes());
        b[4..8].copy_from_slice(&self.component.to_le_bytes());
        b[8..12].copy_from_slice(&self.tile.to_le_bytes());
        b[12..16].copy_from_slice(&self.neighbour_tile.to_le_bytes());
        b[16..18].copy_from_slice(&self.tile_start.to_le_bytes());
        b[18..20].copy_from_slice(&self.tile_end.to_le_bytes());
        b[20..22].copy_from_slice(&self.neighbour_start.to_le_bytes());
        b[22..24].copy_from_slice(&self.neighbour_end.to_le_bytes());
        b[24..26].copy_from_slice(&self.max_draft_dm.to_le_bytes());
        b[26..28].copy_from_slice(&self.min_horizontal_width_dm.to_le_bytes());
        let mut portal_flags = 0u8;
        if self.touches_fairway {
            portal_flags |= PORTAL_FLAG_FAIRWAY;
        }
        if self.touches_tss {
            portal_flags |= PORTAL_FLAG_TSS;
        }
        b[28] = portal_flags;
        // 29..32 reserved
        b[32..40].copy_from_slice(&self.lower_bound_cost_mm.to_le_bytes());
        b
    }

    /// Parse one record. `None` only on a short slice — every field is a
    /// fixed-width integer with no invalid encodings, so structural
    /// validity is entirely a length question here.
    ///
    /// Unknown `portal_flags` bits are IGNORED rather than rejected: a
    /// newer build adding, say, a `touches_anchorage` bit must not make
    /// its artifact unreadable on an older boat, which is the same rule
    /// [`super::format::SectionKind::Unknown`] gives whole sections.
    fn parse(b: &[u8]) -> Option<Portal> {
        let b = b.get(..PORTAL_RECORD_LEN)?;
        let u32_at = |o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap());
        let u16_at = |o: usize| u16::from_le_bytes(b[o..o + 2].try_into().unwrap());
        Some(Portal {
            id: u32_at(0),
            component: u32_at(4),
            tile: u32_at(8),
            neighbour_tile: u32_at(12),
            tile_start: u16_at(16),
            tile_end: u16_at(18),
            neighbour_start: u16_at(20),
            neighbour_end: u16_at(22),
            max_draft_dm: u16_at(24),
            min_horizontal_width_dm: u16_at(26),
            touches_fairway: b[28] & PORTAL_FLAG_FAIRWAY != 0,
            touches_tss: b[28] & PORTAL_FLAG_TSS != 0,
            lower_bound_cost_mm: i64::from_le_bytes(b[32..40].try_into().unwrap()),
        })
    }
}

/// Serialize `portals` as the per-band
/// [`super::format::SectionKind::Portals`] payload for `tag`'s band:
/// [`BandTag`], `count`, record stride, then the records in `portals`'
/// own (canonical, id-ascending) order.
///
/// ```text
/// off  len  field
///   0    8  BandTag
///   8    4  count   u32  portal records
///  12    4  stride  u32  bytes per record (PORTAL_RECORD_LEN today)
///  16  ...  records: count * stride
/// ```
///
/// The stride is written out for the same reason
/// [`super::field::encode_tile_index`] writes one — a reader built
/// against an older [`PORTAL_RECORD_LEN`] still walks a newer file's
/// table, reading the prefix it understands and stepping over the rest.
pub fn encode_portals(tag: BandTag, portals: &[Portal]) -> Vec<u8> {
    let mut out = Vec::with_capacity(PORTALS_HEADER_LEN + portals.len() * PORTAL_RECORD_LEN);
    out.extend_from_slice(&tag.to_bytes());
    out.extend_from_slice(&(portals.len() as u32).to_le_bytes());
    out.extend_from_slice(&(PORTAL_RECORD_LEN as u32).to_le_bytes());
    for p in portals {
        out.extend_from_slice(&p.to_bytes());
    }
    out
}

/// Parse a per-band [`SectionKind::Portals`] payload.
///
/// `None` on a structurally impossible payload: short header, a stride
/// below [`PORTAL_RECORD_LEN`], or a truncated record table. Nothing
/// SEMANTIC is checked here — a `tile` index outside this artifact's own
/// tile count, or a `component` above the labelling's `count`, decodes
/// fine and is caught where it is used ([`super::query::topology_route_with`]
/// looks every tile up with `get`, and has to regardless, since a portal
/// set can legitimately be handed to it alongside a different region).
/// Validating it here would duplicate that check and still not remove it.
///
/// [`SectionKind::Portals`]: super::format::SectionKind::Portals
pub fn decode_portals(bytes: &[u8]) -> Option<Vec<Portal>> {
    let head = bytes.get(..PORTALS_HEADER_LEN)?;
    let count = u32::from_le_bytes(head[8..12].try_into().unwrap()) as usize;
    let stride = u32::from_le_bytes(head[12..16].try_into().unwrap()) as usize;
    if stride < PORTAL_RECORD_LEN {
        return None;
    }
    let need = count.checked_mul(stride)?.checked_add(PORTALS_HEADER_LEN)?;
    if bytes.len() < need {
        return None;
    }
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let at = PORTALS_HEADER_LEN + i * stride;
        out.push(Portal::parse(&bytes[at..at + stride])?);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::lat_lon_to_world;
    use crate::mivnav::bands::global_index;
    use crate::mivnav::field::{RegionLattice, TileEntry, TILE_CELLS};
    use crate::mivnav::stitch::compute_stitch;
    use crate::mivnav::topology::label_band;

    const LAT: f64 = 54.0;
    const LON: f64 = 11.0;

    fn lattice() -> RegionLattice {
        RegionLattice::for_region(crate::coords::Extent::new(
            lat_lon_to_world(LAT, LON - 0.05).x,
            lat_lon_to_world(LAT, LON + 0.05).x,
            lat_lon_to_world(LAT + 0.05, LON).y,
            lat_lon_to_world(LAT - 0.05, LON).y,
        ))
    }

    /// Two same-rung tiles, west/east, `n` cells each; `blocked_rows`
    /// (rows, 0-indexed) are `FLAG_LAND` in BOTH tiles at the seam
    /// column, splitting the boundary into navigable runs.
    fn two_tiles_with_gaps(blocked_rows: &[u16]) -> BuiltRegion {
        use super::super::format::FLAG_LAND;
        let l = lattice();
        let p = lat_lon_to_world(LAT, LON);
        let west = l.tile_at(3, p.x, p.y);
        let east = TileEntry {
            origin_x: west.origin_x + i32::from(west.cols) * west.cell_world,
            ..west
        };
        let n = west.cell_count();
        let cells = TILE_CELLS;
        assert_eq!(cells, west.cols as u32);

        let mut west_t = west;
        west_t.payload_offset = 0;
        let mut east_t = east;
        east_t.payload_offset = n as u64;

        let mut flags = vec![0u8; n * 2];
        for &row in blocked_rows {
            let wi = global_index(&west_t, u32::from(west_t.cols) - 1, u32::from(row));
            let ei = global_index(&east_t, 0, u32::from(row));
            flags[wi] = FLAG_LAND;
            flags[ei] = FLAG_LAND;
        }
        let depth_min = vec![50u16; n * 2];
        let depth_max = vec![100u16; n * 2];
        let stitch = compute_stitch(&[west_t, east_t]);

        BuiltRegion {
            tiles: vec![west_t, east_t],
            depth_min,
            depth_max,
            flags,
            stitch,
            report: Default::default(),
        }
    }

    #[test]
    fn a_fully_open_seam_is_one_portal_spanning_the_whole_edge() {
        let built = two_tiles_with_gaps(&[]);
        let comps = label_band(&built, 5.0);
        let portals = detect_portals(&built, &comps);
        // Bidirectional, exactly like `built.stitch` itself — one seam,
        // one portal per direction.
        assert_eq!(portals.len(), 2);
        let west_side: Vec<_> = portals.iter().filter(|p| p.tile == 0).collect();
        assert_eq!(west_side.len(), 1);
        let p = west_side[0];
        assert_eq!((p.tile_start, p.tile_end), (0, built.tiles[0].rows));
        assert_eq!(p.max_draft_dm, 50);
        assert!(p.lower_bound_cost_mm > 0);
    }

    #[test]
    fn portal_crossing_point_sits_on_the_shared_seam_within_the_crossing_span() {
        // Blocked rows 20..23 split the seam into two navigable runs, so
        // there is more than one crossing and each has a non-trivial
        // along-seam extent to place a midpoint in.
        let built = two_tiles_with_gaps(&[20, 21, 22]);
        let comps = label_band(&built, 5.0);
        let portals = detect_portals(&built, &comps);
        assert!(portals.len() >= 2, "the split seam must yield >1 crossing");
        let seam_x =
            built.tiles[0].origin_x + i32::from(built.tiles[0].cols) * built.tiles[0].cell_world;
        for p in &portals {
            let cx = portal_crossing_point(&built, p)
                .expect("edge-adjacent tiles always have a seam point");
            // West/East seam: the crossing sits exactly on the shared x.
            assert_eq!(cx.x, seam_x, "portal {} not on the seam line", p.id);
            // ...and its y is inside the crossing's own cell span.
            let tile = &built.tiles[p.tile as usize];
            let cw = i64::from(tile.cell_world);
            let lo = i64::from(tile.origin_y) + i64::from(p.tile_start) * cw;
            let hi = i64::from(tile.origin_y) + i64::from(p.tile_end) * cw;
            assert!(
                (lo..=hi).contains(&i64::from(cx.y)),
                "portal {} midpoint y {} outside its span [{lo}, {hi}]",
                p.id,
                cx.y
            );
        }
    }

    #[test]
    fn seam_side_returns_none_for_a_corner_touching_pair() {
        // A neighbour shifted a full tile BOTH east and south shares only
        // the SE corner point with `west` — no edge. `seam_side`'s doc
        // promises `None` there; without the cross-axis overlap guard the
        // first `n.xmin >= t.xmax` branch would wrongly claim `East`.
        let built = two_tiles_with_gaps(&[]);
        let west = built.tiles[0];
        let diag = TileEntry {
            origin_x: west.origin_x + i32::from(west.cols) * west.cell_world,
            origin_y: west.origin_y + i32::from(west.rows) * west.cell_world,
            ..west
        };
        assert_eq!(seam_side(&west, &diag), None);
        // The real east neighbour (edge-adjacent) still resolves.
        let east = TileEntry {
            origin_x: west.origin_x + i32::from(west.cols) * west.cell_world,
            ..west
        };
        assert_eq!(seam_side(&west, &east), Some(Side::East));
    }

    #[test]
    fn lower_bound_cost_mm_matches_the_shared_heuristic_formula_exactly() {
        use crate::routing::artifact::cost::{heuristic_mm, MIN_MULTIPLIER};
        let built = two_tiles_with_gaps(&[]);
        let comps = label_band(&built, 5.0);
        let portals = detect_portals(&built, &comps);
        let p = portals.iter().find(|p| p.tile == 0).unwrap();
        let a = &built.tiles[p.tile as usize];
        let b = &built.tiles[p.neighbour_tile as usize];
        let expected = heuristic_mm(a.centre_distance_m(b), MIN_MULTIPLIER);
        assert_eq!(
            p.lower_bound_cost_mm, expected,
            "must be the exact same formula shortcuts.rs's own lower_bound_mm uses, not an \
             approximation of it"
        );
    }

    #[test]
    fn lower_bound_cost_mm_is_symmetric_across_both_directions() {
        // Bidirectional portals (one per direction, same seam) must
        // report the SAME lower bound either way — centre_distance_m
        // itself is symmetric, and nothing about which side is "tile"
        // vs "neighbour_tile" should change a real physical distance.
        let built = two_tiles_with_gaps(&[]);
        let comps = label_band(&built, 5.0);
        let portals = detect_portals(&built, &comps);
        let forward = portals.iter().find(|p| p.tile == 0).unwrap();
        let backward = portals.iter().find(|p| p.tile == 1).unwrap();
        assert_eq!(forward.lower_bound_cost_mm, backward.lower_bound_cost_mm);
    }

    /// Three tiles of three DIFFERENT rungs in a row (finest — coarsest —
    /// medium), so the two seams have genuinely UNEQUAL real distances —
    /// unlike every other fixture in this file, where either only two
    /// tiles exist (so any consistent pairing is trivially symmetric) or
    /// both tiles share a rung (so distance alone cannot tell two seams
    /// apart). Built specifically for `each_portal_gets_its_own_tile_
    /// pairs_distance_not_a_neighbours` below — found worth having by
    /// code review: the earlier two tests above cannot actually catch a
    /// `flush()` call site using a STALE or TRANSPOSED `(tile,
    /// neighbour)` pair, because on a 2-tile or same-rung fixture every
    /// wrong-but-consistent pairing happens to produce the identical
    /// number anyway.
    fn three_tiles_of_differing_rungs() -> BuiltRegion {
        let l = lattice();
        let p = lat_lon_to_world(LAT, LON);
        let cells = TILE_CELLS as u16;
        let middle = l.tile_at(4, p.x, p.y); // coarsest, centre
        let west_cell_world = l.cell_world(2); // finest
        let east_cell_world = l.cell_world(3); // medium

        let west = TileEntry {
            origin_x: middle.origin_x - i32::from(cells) * west_cell_world,
            origin_y: middle.origin_y,
            cell_world: west_cell_world,
            rung: 2,
            tile_flags: 0,
            cols: cells,
            rows: cells,
            triggers: 0,
            payload_offset: 0,
        };
        let n_west = west.cell_count();
        let middle = TileEntry {
            payload_offset: n_west as u64,
            ..middle
        };
        let n_middle = middle.cell_count();
        let east = TileEntry {
            origin_x: middle.origin_x + i32::from(middle.cols) * middle.cell_world,
            origin_y: middle.origin_y,
            cell_world: east_cell_world,
            rung: 3,
            tile_flags: 0,
            cols: cells,
            rows: cells,
            triggers: 0,
            payload_offset: (n_west + n_middle) as u64,
        };
        let n_east = east.cell_count();

        let n = n_west + n_middle + n_east;
        let tiles = vec![west, middle, east];
        let stitch = compute_stitch(&tiles);
        BuiltRegion {
            tiles,
            depth_min: vec![50u16; n],
            depth_max: vec![100u16; n],
            flags: vec![0u8; n],
            stitch,
            report: Default::default(),
        }
    }

    #[test]
    fn each_portal_gets_its_own_tile_pairs_distance_not_a_neighbours() {
        use crate::routing::artifact::cost::{heuristic_mm, MIN_MULTIPLIER};
        let built = three_tiles_of_differing_rungs();
        let comps = label_band(&built, 1.0);
        let portals = detect_portals(&built, &comps);

        let west_middle = portals
            .iter()
            .find(|p| p.tile == 0 && p.neighbour_tile == 1)
            .expect("west-middle portal must exist");
        let middle_east = portals
            .iter()
            .find(|p| p.tile == 1 && p.neighbour_tile == 2)
            .expect("middle-east portal must exist");

        let expected_wm = heuristic_mm(
            built.tiles[0].centre_distance_m(&built.tiles[1]),
            MIN_MULTIPLIER,
        );
        let expected_me = heuristic_mm(
            built.tiles[1].centre_distance_m(&built.tiles[2]),
            MIN_MULTIPLIER,
        );
        assert_ne!(
            expected_wm, expected_me,
            "sanity: this fixture's own two seams must have genuinely different real \
             distances, or this test cannot distinguish anything at all"
        );

        // The real proof: each portal's own lower_bound_cost_mm must
        // match ITS OWN seam's distance, not the other one's — a stale
        // or transposed `(tile, neighbour)` pair reaching `flush()` for
        // either portal would swap or duplicate these two numbers, and
        // this fixture is built specifically so that failure mode
        // produces a visibly wrong, not merely different-looking, value.
        assert_eq!(west_middle.lower_bound_cost_mm, expected_wm);
        assert_eq!(middle_east.lower_bound_cost_mm, expected_me);
        assert_ne!(
            west_middle.lower_bound_cost_mm,
            middle_east.lower_bound_cost_mm
        );
    }

    #[test]
    fn a_blocked_row_splits_the_seam_into_two_portals() {
        let mid = (TILE_CELLS / 2) as u16;
        let built = two_tiles_with_gaps(&[mid]);
        let comps = label_band(&built, 5.0);
        let portals = detect_portals(&built, &comps);
        let west_side: Vec<_> = portals.iter().filter(|p| p.tile == 0).collect();
        assert_eq!(west_side.len(), 2, "one blocked row splits the seam in two");
        let total: u32 = west_side
            .iter()
            .map(|p| u32::from(p.tile_end - p.tile_start))
            .sum();
        assert_eq!(
            total,
            TILE_CELLS - 1,
            "every open row accounted for, the blocked one excluded"
        );
        for p in &west_side {
            assert!(!(p.tile_start..p.tile_end).contains(&mid));
        }
    }

    #[test]
    fn max_draft_is_the_shallowest_member_cell_not_the_deepest() {
        let built_shallow_west = {
            let mut b = two_tiles_with_gaps(&[]);
            // Shoal the western seam cell alone.
            let i = global_index(&b.tiles[0], u32::from(b.tiles[0].cols) - 1, 0);
            b.depth_min[i] = 5; // 0.5 m
            b
        };
        let comps = label_band(&built_shallow_west, 0.1);
        let portals = detect_portals(&built_shallow_west, &comps);
        let west_side: Vec<_> = portals.iter().filter(|p| p.tile == 0).collect();
        assert_eq!(west_side.len(), 1);
        assert_eq!(
            west_side[0].max_draft_dm, 5,
            "the one shoal cell must set the whole portal's ceiling"
        );
    }

    /// Two same-rung tiles, west/east, with one east-west CHANNEL of
    /// `open_rows` cut through solid land: every row outside `open_rows`
    /// is `FLAG_LAND` across the FULL WIDTH of both tiles.
    ///
    /// Deliberately not the same shape as [`two_tiles_with_gaps`], which
    /// blocks only the seam column itself and leaves open water either
    /// side of it — fine for splitting a seam into runs (all that fixture
    /// was built for), useless for measuring a width, since the widest
    /// disc centred on such a "crossing" is bounded by two lone blocked
    /// cells rather than by two banks.
    fn two_tiles_with_a_channel(open_rows: std::ops::Range<u16>) -> BuiltRegion {
        two_tiles_with_channels(&[open_rows])
    }

    /// [`two_tiles_with_a_channel`] with SEVERAL parallel channels
    /// through the same land.
    fn two_tiles_with_channels(open_rows: &[std::ops::Range<u16>]) -> BuiltRegion {
        two_tiles_with_channels_through_a_spit(open_rows, u16::MAX)
    }

    /// [`two_tiles_with_channels`], but the land between the channels is
    /// only `spit_cols` wide either side of the seam — a MOLE reaching
    /// out to the boundary rather than a coast running to the horizon.
    ///
    /// The difference is not cosmetic: with land running the full width
    /// of both tiles, each channel is its own connected COMPONENT, and
    /// this module's own component-label blocked predicate already keeps
    /// one channel's water out of another's window. Around a spit they
    /// are ONE component, so the only thing keeping a neighbouring
    /// channel out of this crossing's reading is that the reading is
    /// scoped to the crossing's own along-seam extent — which is what
    /// `a_wider_channel_nearby_never_leaks_into_this_crossings_own_width`
    /// exists to pin, and cannot pin on a full-width fixture.
    fn two_tiles_with_channels_through_a_spit(
        open_rows: &[std::ops::Range<u16>],
        spit_cols: u16,
    ) -> BuiltRegion {
        use super::super::format::FLAG_LAND;
        let l = lattice();
        let p = lat_lon_to_world(LAT, LON);
        let west = l.tile_at(3, p.x, p.y);
        let east = TileEntry {
            origin_x: west.origin_x + i32::from(west.cols) * west.cell_world,
            ..west
        };
        let n = west.cell_count();
        let mut west_t = west;
        west_t.payload_offset = 0;
        let mut east_t = east;
        east_t.payload_offset = n as u64;

        let mut flags = vec![0u8; n * 2];
        for (t, west_side) in [(&west_t, true), (&east_t, false)] {
            let reach = u32::from(spit_cols).min(u32::from(t.cols));
            for row in 0..u32::from(t.rows) {
                if open_rows.iter().any(|r| r.contains(&(row as u16))) {
                    continue;
                }
                // Land only within `reach` of the shared seam: the west
                // tile's LAST columns, the east tile's FIRST ones.
                let cols = if west_side {
                    (u32::from(t.cols) - reach)..u32::from(t.cols)
                } else {
                    0..reach
                };
                for col in cols {
                    flags[global_index(t, col, row)] = FLAG_LAND;
                }
            }
        }
        let stitch = compute_stitch(&[west_t, east_t]);
        BuiltRegion {
            tiles: vec![west_t, east_t],
            depth_min: vec![50u16; n * 2],
            depth_max: vec![100u16; n * 2],
            flags,
            stitch,
            report: Default::default(),
        }
    }

    /// Metres per cell of the same rung-3 tiles every same-rung fixture
    /// in this file uses.
    fn fixture_cell_m() -> f64 {
        lattice().tile_at(3, 0, 0).cell_size_m()
    }

    #[test]
    fn a_wide_open_seam_measures_the_window_saturated_width() {
        let built = two_tiles_with_gaps(&[]);
        let comps = label_band(&built, 5.0);
        let portals = detect_portals(&built, &comps);
        let p = portals.iter().find(|p| p.tile == 0).unwrap();
        // Nothing charted narrows this seam anywhere, so the measurement
        // runs into its own window margin and SATURATES — "at least this
        // wide", exactly as the field's own docs say. Asserted as the
        // exact saturation value rather than "big", because a
        // window-sizing change should show up here as a deliberate edit,
        // not a silent drift in what every open-water portal reports.
        // The `- 1 - CELL_HALF_DIAGONAL` is the guaranteed-reach
        // shortfall the module docs' design point 3 argues, not slack.
        let expected_dm = 2.0
            * (WIDTH_MARGIN_MAX_CELLS as f64 - 1.0 - CELL_HALF_DIAGONAL)
            * fixture_cell_m()
            * 10.0;
        assert!(
            (f64::from(p.min_horizontal_width_dm) - expected_dm).abs() <= 1.0,
            "an unobstructed seam must report the saturated window width (~{expected_dm} dm), \
             got {} dm",
            p.min_horizontal_width_dm
        );
        assert!(
            p.min_horizontal_width_dm
                < (2.0 * WIDTH_MARGIN_MAX_CELLS as f64 * fixture_cell_m() * 10.0) as u16,
            "even saturated, the reading must stay under the window's own raw margin — a \
             saturated value is a LOWER bound on the real width, not the window's size"
        );
    }

    #[test]
    fn a_channel_between_two_banks_measures_about_its_real_charted_width() {
        let cell_m = fixture_cell_m();
        for rows in [5u16, 15] {
            let mid = (TILE_CELLS / 2) as u16;
            let built = two_tiles_with_a_channel(mid..mid + rows);
            let comps = label_band(&built, 5.0);
            let portals = detect_portals(&built, &comps);
            let p = portals
                .iter()
                .find(|p| p.tile == 0)
                .expect("the channel crosses the seam");
            let real_m = f64::from(rows) * cell_m;
            let measured_m = f64::from(p.min_horizontal_width_dm) / 10.0;
            // Never GENEROUS: the transform measures centre-to-centre and
            // this module discounts `CELL_HALF_DIAGONAL` off it, so the
            // answer always lands just under the real charted width, by
            // strictly less than one cell either side of the channel.
            assert!(
                measured_m <= real_m && measured_m >= real_m - 2.0 * cell_m,
                "{rows}-cell channel ({real_m} m) measured {measured_m} m — must be just \
                 under the real width, never over it"
            );
        }
    }

    #[test]
    fn a_narrow_channel_measures_far_narrower_than_a_wide_open_seam() {
        // The whole point of the field: it has to DISCRIMINATE, not just
        // return a plausible-looking number.
        let mid = (TILE_CELLS / 2) as u16;
        let narrow = {
            let built = two_tiles_with_a_channel(mid..mid + 3);
            let comps = label_band(&built, 5.0);
            detect_portals(&built, &comps)
                .into_iter()
                .find(|p| p.tile == 0)
                .unwrap()
                .min_horizontal_width_dm
        };
        let open = {
            let built = two_tiles_with_gaps(&[]);
            let comps = label_band(&built, 5.0);
            detect_portals(&built, &comps)
                .into_iter()
                .find(|p| p.tile == 0)
                .unwrap()
                .min_horizontal_width_dm
        };
        assert!(
            u32::from(narrow) * 10 < u32::from(open),
            "a 3-cell channel ({narrow} dm) must measure an order of magnitude narrower \
             than an unobstructed seam ({open} dm)"
        );
    }

    #[test]
    fn a_marginal_width_portal_is_still_emitted_never_dropped() {
        // §8.3's demotion rule: the capacity scan FLAGS a marginal-width
        // crossing for query-time refinement, it does not reject it. The
        // narrowest crossing this fixture can express is one single cell
        // — it must still be a portal, with a real measured width on it.
        let mid = (TILE_CELLS / 2) as u16;
        let built = two_tiles_with_a_channel(mid..mid + 1);
        let comps = label_band(&built, 5.0);
        let portals = detect_portals(&built, &comps);
        let p = portals
            .iter()
            .find(|p| p.tile == 0)
            .expect("a one-cell channel is still a real crossing");
        assert_eq!((p.tile_start, p.tile_end), (mid, mid + 1));
        assert!(
            p.min_horizontal_width_dm < (fixture_cell_m() * 10.0) as u16,
            "a one-cell channel must measure under one cell wide, not be filtered out or \
             rounded up: got {} dm",
            p.min_horizontal_width_dm
        );
    }

    /// [`two_tiles_with_a_channel`], transposed: two same-rung tiles
    /// stacked NORTH/SOUTH, with a north-south channel of `open_cols`
    /// cut through solid land. The same physical situation the east-west
    /// fixture builds, rotated 90 degrees, so a
    /// [`SeamAxis::AcrossY`] mistake (a transposed `col`/`row`, an
    /// along-range read off the wrong origin) produces a visibly
    /// different number instead of no number at all.
    fn stacked_tiles_with_a_channel(open_cols: std::ops::Range<u16>) -> BuiltRegion {
        use super::super::format::FLAG_LAND;
        let l = lattice();
        let p = lat_lon_to_world(LAT, LON);
        let north = l.tile_at(3, p.x, p.y);
        // World y grows SOUTHWARD (`Side`'s own docs), so the southern
        // tile's origin is the northern one's origin PLUS its height.
        let south = TileEntry {
            origin_y: north.origin_y + i32::from(north.rows) * north.cell_world,
            ..north
        };
        let n = north.cell_count();
        let mut north_t = north;
        north_t.payload_offset = 0;
        let mut south_t = south;
        south_t.payload_offset = n as u64;

        let mut flags = vec![0u8; n * 2];
        for t in [&north_t, &south_t] {
            for col in 0..u32::from(t.cols) {
                if open_cols.contains(&(col as u16)) {
                    continue;
                }
                for row in 0..u32::from(t.rows) {
                    flags[global_index(t, col, row)] = FLAG_LAND;
                }
            }
        }
        let stitch = compute_stitch(&[north_t, south_t]);
        BuiltRegion {
            tiles: vec![north_t, south_t],
            depth_min: vec![50u16; n * 2],
            depth_max: vec![100u16; n * 2],
            flags,
            stitch,
            report: Default::default(),
        }
    }

    #[test]
    fn a_north_south_seam_measures_the_same_channel_identically() {
        // Every other width fixture in this file is a West/East pair, so
        // without this one `SeamAxis::AcrossY` — the transposed half of
        // `col_row`/`tile_bounds`/`along_range` — is exercised only by
        // the real-chart integration test (code review's finding: a
        // deliberate transposition there passed every unit test in the
        // crate). One physical channel geometry, measured on a vertical
        // seam and on a horizontal one, must give the IDENTICAL number:
        // nothing about a rotation changes how wide water is.
        let mid = (TILE_CELLS / 2) as u16;
        for width in [3u16, 9] {
            let east_west = {
                let built = two_tiles_with_a_channel(mid..mid + width);
                let comps = label_band(&built, 5.0);
                detect_portals(&built, &comps)
                    .into_iter()
                    .find(|p| p.tile == 0)
                    .expect("the east-west channel crosses its seam")
                    .min_horizontal_width_dm
            };
            let north_south = {
                let built = stacked_tiles_with_a_channel(mid..mid + width);
                let comps = label_band(&built, 5.0);
                detect_portals(&built, &comps)
                    .into_iter()
                    .find(|p| p.tile == 0)
                    .expect("the north-south channel crosses its seam")
                    .min_horizontal_width_dm
            };
            assert_eq!(
                east_west, north_south,
                "a {width}-cell channel must measure the same across a North/South seam as \
                 across a West/East one"
            );
            assert!(north_south > 0);
        }
    }

    #[test]
    fn the_width_is_read_at_the_seam_not_a_cell_deeper_into_a_tile() {
        use super::super::format::FLAG_LAND;
        // A quay wall PARALLEL to the seam, one cell inside the western
        // tile: the whole seam stays navigable (west's last column is
        // water, east is open), so this is one full-edge portal — but
        // the widest disc that fits ON the crossing is bounded by that
        // wall two cells away, not by anything further east.
        //
        // Pins design point 2's "the two cell lines immediately either
        // side of the seam": reading one cell deeper into the eastern
        // tile instead would see the wall three cells away and report
        // half again as wide. Code review found that read position
        // completely unpinned by the other fixtures here, all of which
        // are symmetric about their own seam.
        let mut built = two_tiles_with_gaps(&[]);
        let west = built.tiles[0];
        let wall_col = u32::from(west.cols) - 2;
        for row in 0..u32::from(west.rows) {
            built.flags[global_index(&west, wall_col, row)] = FLAG_LAND;
        }
        let comps = label_band(&built, 5.0);
        let portals = detect_portals(&built, &comps);
        let p = portals
            .iter()
            .find(|p| p.tile == 0)
            .expect("a one-cell-wide strip along the seam is still a real crossing");
        assert_eq!((p.tile_start, p.tile_end), (0, west.rows));

        let cell_m = fixture_cell_m();
        let at_the_seam_dm = 2.0 * (2.0 - CELL_HALF_DIAGONAL) * cell_m * 10.0;
        let one_cell_deeper_dm = 2.0 * (3.0 - CELL_HALF_DIAGONAL) * cell_m * 10.0;
        assert!(
            (f64::from(p.min_horizontal_width_dm) - at_the_seam_dm).abs() <= 1.0,
            "expected the crossing's own clearance (~{at_the_seam_dm} dm), got {} dm — \
             ~{one_cell_deeper_dm} dm would mean the read moved a cell off the seam",
            p.min_horizontal_width_dm
        );
    }

    #[test]
    fn a_wider_channel_nearby_never_leaks_into_this_crossings_own_width() {
        // Two parallel channels through the same land, close enough that
        // the narrow one's own window (padded by `margin` cells beyond
        // its ends) reaches into the wide one's water. Each portal must
        // report ITS OWN crossing — the read is scoped to the crossing's
        // along-seam extent, not to the whole window. Without this,
        // reading the full window instead passes every other test here,
        // because in every other fixture the padding is solid land.
        let narrow_rows = 100u16..103;
        let wide_rows = 106u16..120;
        // A SPIT, not a full-width coast: see
        // `two_tiles_with_channels_through_a_spit`'s own docs for why a
        // full-width one would make this test pass for the wrong reason
        // (two components rather than one scoped read). 16 columns is
        // twice the window's own margin here, so the window sees solid
        // land either side of the crossing exactly as it would on a
        // coast — only the connectivity far from the seam differs.
        let built =
            two_tiles_with_channels_through_a_spit(&[narrow_rows.clone(), wide_rows.clone()], 16);
        let comps = label_band(&built, 5.0);
        let portals = detect_portals(&built, &comps);
        let west: Vec<_> = portals.iter().filter(|p| p.tile == 0).collect();
        assert_eq!(west.len(), 2, "two channels, two crossings");

        let narrow = west
            .iter()
            .find(|p| p.tile_start == narrow_rows.start)
            .expect("the narrow crossing");
        let wide = west
            .iter()
            .find(|p| p.tile_start == wide_rows.start)
            .expect("the wide crossing");
        let cell_m = fixture_cell_m();
        let narrow_expect_dm = 2.0 * (2.0 - CELL_HALF_DIAGONAL) * cell_m * 10.0;
        assert!(
            (f64::from(narrow.min_horizontal_width_dm) - narrow_expect_dm).abs() <= 1.0,
            "the 3-cell crossing must measure its own ~{narrow_expect_dm} dm, not borrow the \
             14-cell channel {} cells away: got {} dm",
            wide_rows.start - narrow_rows.end,
            narrow.min_horizontal_width_dm
        );
        assert!(
            wide.min_horizontal_width_dm > narrow.min_horizontal_width_dm * 2,
            "and the wide crossing, measured from the same fixture, must still read wide"
        );
    }

    #[test]
    fn span_lo_and_span_hi_are_ceil_and_floor_including_below_the_window_origin() {
        // The pair that keeps a window cell only PARTIALLY covered by a
        // tile blocked rather than half-read (`mark_navigable`'s own
        // docs). Tested directly because a real fixture cannot express a
        // partially-covered cell — `RegionLattice` guarantees every tile
        // origin lands on every finer lattice, so only a corrupted file
        // could produce one, which is exactly why the guard exists.
        assert_eq!(span_lo(0, 10), 0);
        assert_eq!(span_lo(1, 10), 1, "a cell starting mid-tile is not covered");
        assert_eq!(span_lo(10, 10), 1);
        assert_eq!(span_lo(11, 10), 2);
        // Negative deltas: a tile whose bounds start BEFORE the window's
        // own origin, the ordinary case for the near side of a seam.
        assert_eq!(span_lo(-10, 10), -1);
        assert_eq!(span_lo(-9, 10), 0, "ceil, not truncation toward zero");
        assert_eq!(span_hi(0, 10), 0);
        assert_eq!(span_hi(9, 10), 0, "a cell ending mid-tile is not covered");
        assert_eq!(span_hi(10, 10), 1);
        assert_eq!(span_hi(-1, 10), -1, "floor, not truncation toward zero");
    }

    #[test]
    fn a_rung_outside_the_resolution_ladder_measures_zero_instead_of_panicking() {
        // `TileEntry::parse` reads `rung` straight off the file without
        // validating it, and this field is the first consumer to index
        // `RESOLUTION_LADDER_M` with one — so a corrupted or
        // version-skewed tile index must produce "not measurable", not
        // an index-out-of-bounds panic (`resolve_run_pair`'s own
        // never-panic rule, which `detect_portals` already follows for
        // edge-cell indices). Found by code review, which reproduced the
        // panic this test now prevents.
        let mut built = two_tiles_with_gaps(&[]);
        built.tiles[1].rung = 200;
        let comps = label_band(&built, 5.0);
        let portals = detect_portals(&built, &comps);
        assert_eq!(
            portals.len(),
            2,
            "the crossing itself is unaffected — only its width is unmeasurable"
        );
        for p in &portals {
            assert_eq!(
                p.min_horizontal_width_dm, 0,
                "both directions must report the same 'not measurable' answer: {p:?}"
            );
            assert_ne!(p.max_draft_dm, 0, "every other capacity field still works");
        }
    }

    #[test]
    fn both_directions_of_one_seam_measure_the_same_width() {
        // Same invariant `lower_bound_cost_mm_is_symmetric_across_both_
        // directions` pins for the cost: one physical seam, two directed
        // portals, one physical channel — the window is built from the
        // seam line and the two sides' COMMON ground extent precisely so
        // that neither direction can read differently.
        let mid = (TILE_CELLS / 2) as u16;
        for built in [
            two_tiles_with_a_channel(mid..mid + 7),
            two_tiles_with_gaps(&[]),
            // The load-bearing one, added by code review: the two
            // same-rung fixtures above are mirror-symmetric about their
            // own seam, so EVERY input to the measurement is literally
            // identical from either direction and the test cannot fail
            // however the code picks a side. The review demonstrated
            // that directly — swapping `finer.cell_size_m()` for
            // `tile.cell_size_m()` makes this coarse/fine seam report
            // 414 dm one way and 827 dm the other (a 2x disagreement AND
            // a 2x OVERSTATEMENT on the coarse side) while every other
            // test in the crate still passed.
            // 3 FINE rows open against 2 COARSE ones, so the two sides
            // of this crossing genuinely cover DIFFERENT ground (fine
            // 128..131, coarse 128..132) — the shape `portal_width_dm`'s
            // along-range intersection is written for. (Measured, so
            // nobody re-derives it: the intersection is not what makes
            // this test pass. See that intersection's own comment for
            // why the choice is numerically inert.)
            fine_coarse_channel(128..131, 64..66),
        ] {
            let comps = label_band(&built, 5.0);
            let portals = detect_portals(&built, &comps);
            let forward = portals.iter().find(|p| p.tile == 0).unwrap();
            let backward = portals.iter().find(|p| p.tile == 1).unwrap();
            assert_eq!(
                forward.min_horizontal_width_dm,
                backward.min_horizontal_width_dm
            );
        }
    }

    /// A rung-3 (FINE) tile west of a rung-4 (COARSE) one — the same
    /// pairing `a_mid_run_block_splits_a_coarse_fine_seam_correctly`
    /// uses — with an east-west channel `open_fine` FINE rows wide cut
    /// through solid land on both sides, and `open_coarse` COARSE rows
    /// open on the coarse side. The two ranges are given INDEPENDENTLY
    /// rather than derived from each other so a caller can build a
    /// crossing whose two sides cover DIFFERENT ground — the case
    /// `portal_width_dm`'s along-range intersection exists for, and one
    /// that cannot arise when the fine range is a whole number of coarse
    /// cells.
    fn fine_coarse_channel(
        open_fine: std::ops::Range<u32>,
        open_coarse: std::ops::Range<u32>,
    ) -> BuiltRegion {
        use super::super::format::FLAG_LAND;
        let l = lattice();
        let p = lat_lon_to_world(LAT, LON);
        let cells = TILE_CELLS as u16;
        let coarse_t = l.tile_at(4, p.x, p.y);
        let fine_cell_world = l.cell_world(3);
        let mut fine = TileEntry {
            origin_x: coarse_t.origin_x - i32::from(cells) * fine_cell_world,
            origin_y: coarse_t.origin_y,
            cell_world: fine_cell_world,
            rung: 3,
            tile_flags: 0,
            cols: cells,
            rows: cells,
            triggers: 0,
            payload_offset: 0,
        };
        let mut coarse = coarse_t;
        fine.payload_offset = 0;
        coarse.payload_offset = fine.cell_count() as u64;

        let n = fine.cell_count() + coarse.cell_count();
        let mut flags = vec![0u8; n];
        for row in 0..u32::from(fine.rows) {
            if open_fine.contains(&row) {
                continue;
            }
            for col in 0..u32::from(fine.cols) {
                flags[global_index(&fine, col, row)] = FLAG_LAND;
            }
        }
        for row in 0..u32::from(coarse.rows) {
            if open_coarse.contains(&row) {
                continue;
            }
            for col in 0..u32::from(coarse.cols) {
                flags[global_index(&coarse, col, row)] = FLAG_LAND;
            }
        }
        let tiles = vec![fine, coarse];
        let stitch = compute_stitch(&tiles);
        BuiltRegion {
            tiles,
            depth_min: vec![50u16; n],
            depth_max: vec![100u16; n],
            flags,
            stitch,
            report: Default::default(),
        }
    }

    #[test]
    fn a_coarse_fine_seam_is_rasterized_at_the_finer_tiles_cell_size() {
        let open_fine: std::ops::Range<u32> = 128..132;
        let built = fine_coarse_channel(open_fine.clone(), 64..66);
        let comps = label_band(&built, 5.0);
        let portals = detect_portals(&built, &comps);
        let p = portals
            .iter()
            .find(|p| p.tile == 0)
            .expect("the channel crosses the seam");

        let fine_m = built.tiles[0].cell_size_m();
        let coarse_m = built.tiles[1].cell_size_m();
        let measured_m = f64::from(p.min_horizontal_width_dm) / 10.0;
        let real_m = f64::from(open_fine.end - open_fine.start) * fine_m;
        // The fine rasterization fits a disc of radius (2 - sqrt(2)/2)
        // FINE cells in this channel; a coarse one would only fit
        // (1 - sqrt(2)/2) COARSE cells, less than half as wide. Both are
        // under the channel's real width — the point is WHICH under.
        let fine_expect = 2.0 * (2.0 - std::f64::consts::SQRT_2 / 2.0) * fine_m;
        let coarse_expect = 2.0 * (1.0 - std::f64::consts::SQRT_2 / 2.0) * coarse_m;
        assert!(
            (measured_m - fine_expect).abs() < fine_m / 2.0,
            "expected the FINE tile's own {fine_m} m cells to set the window resolution \
             (~{fine_expect} m), got {measured_m} m"
        );
        assert!(
            measured_m > coarse_expect * 1.5,
            "a window rasterized at the COARSE {coarse_m} m cell would have reported \
             ~{coarse_expect} m — understating a fine tile's own hazard geometry is the \
             one direction this must never go"
        );
        assert!(measured_m <= real_m);
    }

    #[test]
    fn a_portal_touching_no_fairway_or_tss_cell_reports_neither() {
        let built = two_tiles_with_gaps(&[]);
        let comps = label_band(&built, 5.0);
        let portals = detect_portals(&built, &comps);
        assert!(portals.iter().all(|p| !p.touches_fairway && !p.touches_tss));
    }

    #[test]
    fn touches_fairway_and_touches_tss_are_ord_across_the_whole_crossing() {
        use super::super::format::{FLAG_FAIRWAY, FLAG_TSS};
        let built = {
            let mut b = two_tiles_with_gaps(&[]);
            // FLAG_FAIRWAY on ONE western seam cell, FLAG_TSS on a
            // DIFFERENT one — neither flag covers the whole crossing, so
            // this proves accumulation is a real OR across every member
            // pair, not "the first pair sets it" or "every pair must
            // agree".
            let fairway_i = global_index(&b.tiles[0], u32::from(b.tiles[0].cols) - 1, 0);
            let tss_i = global_index(&b.tiles[0], u32::from(b.tiles[0].cols) - 1, 1);
            b.flags[fairway_i] |= FLAG_FAIRWAY;
            b.flags[tss_i] |= FLAG_TSS;
            b
        };
        let comps = label_band(&built, 5.0);
        let portals = detect_portals(&built, &comps);
        let west_side: Vec<_> = portals.iter().filter(|p| p.tile == 0).collect();
        assert_eq!(
            west_side.len(),
            1,
            "neither flag blocks navigability, so this is still one portal"
        );
        assert!(west_side[0].touches_fairway);
        assert!(west_side[0].touches_tss);
    }

    #[test]
    fn a_neighbouring_portal_the_flagged_cells_never_touch_reports_neither() {
        // Sanity on the other direction of the OR: a blocked row splits
        // the seam into two portals (same shape
        // `a_blocked_row_splits_the_seam_into_two_portals` already
        // proves); flagging a cell in ONE half must not leak onto the
        // OTHER half's own portal.
        use super::super::format::FLAG_FAIRWAY;
        let mid = (TILE_CELLS / 2) as u16;
        let built = {
            let mut b = two_tiles_with_gaps(&[mid]);
            let i = global_index(&b.tiles[0], u32::from(b.tiles[0].cols) - 1, 0);
            b.flags[i] |= FLAG_FAIRWAY;
            b
        };
        let comps = label_band(&built, 5.0);
        let portals = detect_portals(&built, &comps);
        let west_side: Vec<_> = portals.iter().filter(|p| p.tile == 0).collect();
        assert_eq!(west_side.len(), 2);
        let flagged = west_side
            .iter()
            .find(|p| p.tile_start == 0)
            .expect("the row-0 portal must exist");
        let other = west_side
            .iter()
            .find(|p| p.tile_start != 0)
            .expect("the other half's portal must exist");
        assert!(flagged.touches_fairway);
        assert!(!other.touches_fairway);
    }

    #[test]
    fn portals_never_bridge_different_components() {
        // Hand-built `Components`, not `label_band`'s own output: within
        // the real pipeline, two stitched navigable cells are ALWAYS in
        // the same component by construction (`union_stitch_run` sees to
        // that), so a fixture reaching an inconsistent state honestly
        // would just be re-testing `label_band` again. This instead
        // tests `detect_portals`'s own defensive side directly: handed
        // an INCONSISTENT `Components` where the boundary's own two
        // halves disagree about which component they belong to (as a
        // corrupted or mismatched-band input might produce), it must
        // still only ever connect the half that genuinely agrees.
        let built = two_tiles_with_gaps(&[]);
        let west = &built.tiles[0];
        let mid = u32::from(west.rows) / 2;
        let n = built.depth_min.len();
        let mut label = vec![0u32; n];
        // West rows [mid, rows) disagree with east's own component —
        // east stays entirely component 0.
        for row in mid..u32::from(west.rows) {
            label[global_index(west, u32::from(west.cols) - 1, row)] = 1;
        }
        let comps = Components { label, count: 2 };
        let portals = detect_portals(&built, &comps);

        let west_side: Vec<_> = portals.iter().filter(|p| p.tile == 0).collect();
        assert_eq!(
            west_side.len(),
            1,
            "only the agreeing half must produce a portal"
        );
        assert_eq!(
            (west_side[0].tile_start, west_side[0].tile_end),
            (0, mid as u16)
        );
        assert_eq!(west_side[0].component, 0);
        // The mismatched half genuinely produced nothing — not merged
        // in under either side's label.
        assert!(!portals
            .iter()
            .any(|p| p.tile == 0 && p.tile_start >= mid as u16));
    }

    #[test]
    fn canonical_ids_are_deterministic_and_ordered_by_lowest_member() {
        let mid = (TILE_CELLS / 2) as u16;
        let built = two_tiles_with_gaps(&[mid]);
        let comps = label_band(&built, 5.0);
        let first = detect_portals(&built, &comps);
        for _ in 0..2 {
            assert_eq!(detect_portals(&built, &comps), first);
        }
        // The lower-numbered portal must be the one starting at row 0.
        let lowest = first.iter().min_by_key(|p| p.tile_start).unwrap();
        assert_eq!(lowest.id, 0);
    }

    #[test]
    fn no_portals_at_all_when_the_whole_seam_is_blocked() {
        let all_rows: Vec<u16> = (0..TILE_CELLS as u16).collect();
        let built = two_tiles_with_gaps(&all_rows);
        let comps = label_band(&built, 5.0);
        let portals = detect_portals(&built, &comps);
        assert!(portals.is_empty());
    }

    /// A fine (rung 3) tile immediately west of a coarse (rung 4) one —
    /// the same hand-built pairing `stitch.rs`'s own
    /// `a_coarse_tile_stitches_many_to_one_against_a_finer_neighbour`
    /// test uses, exercising `expand()`'s GROUPED pairing (several fine
    /// cells per one coarse cell) rather than the 1:1 same-rung case
    /// every other test in this file uses.
    #[test]
    fn a_mid_run_block_splits_a_coarse_fine_seam_correctly() {
        use super::super::format::FLAG_LAND;
        let l = lattice();
        let p = lat_lon_to_world(LAT, LON);
        let coarse = l.tile_at(4, p.x, p.y);
        let fine_cell_world = l.cell_world(3);
        let cells = TILE_CELLS as u16;
        let mut fine = TileEntry {
            origin_x: coarse.origin_x - i32::from(cells) * fine_cell_world,
            origin_y: coarse.origin_y,
            cell_world: fine_cell_world,
            rung: 3,
            tile_flags: 0,
            cols: cells,
            rows: cells,
            triggers: 0,
            payload_offset: 0,
        };
        let mut coarse = coarse;
        coarse.payload_offset = fine.cell_count() as u64;
        let ratio = (coarse.cell_world / fine.cell_world) as u16;
        fine.payload_offset = 0;

        let n_fine = fine.cell_count();
        let n_coarse = coarse.cell_count();
        let mut flags = vec![0u8; n_fine + n_coarse];
        // Block one fine row in the middle of the seam, on BOTH sides of
        // the crossing it falls in — the fine side directly, and the
        // coarse cell it maps into (so the coarse side genuinely loses
        // navigability there too, not just the fine one).
        let blocked_fine_row = fine.rows / 2;
        let blocked_coarse_row = blocked_fine_row / ratio;
        flags[global_index(&fine, u32::from(fine.cols) - 1, u32::from(blocked_fine_row))] =
            FLAG_LAND;
        flags[global_index(&coarse, 0, u32::from(blocked_coarse_row))] = FLAG_LAND;

        let depth_min = vec![50u16; n_fine + n_coarse];
        let depth_max = vec![100u16; n_fine + n_coarse];
        let stitch = compute_stitch(&[fine, coarse]);
        let built = BuiltRegion {
            tiles: vec![fine, coarse],
            depth_min,
            depth_max,
            flags,
            stitch,
            report: Default::default(),
        };
        let comps = label_band(&built, 5.0);
        let portals = detect_portals(&built, &comps);
        let fine_side: Vec<_> = portals.iter().filter(|p| p.tile == 0).collect();

        // The blocked coarse cell takes out `ratio` consecutive fine
        // rows' worth of crossing (every fine row mapping to that one
        // coarse cell loses its partner), splitting the seam into (at
        // most) two portals either side of that gap.
        assert!(
            fine_side.len() == 2 || fine_side.len() == 1,
            "expected one or two portals depending on where the block falls, got {}: {fine_side:?}",
            fine_side.len()
        );
        let blocked_coarse_start = blocked_coarse_row * ratio;
        let blocked_coarse_end = blocked_coarse_start + ratio;
        for p in &fine_side {
            let overlaps_block =
                p.tile_start < blocked_coarse_end && blocked_coarse_start < p.tile_end;
            assert!(
                !overlaps_block,
                "no portal may span the blocked coarse cell's own fine range: {p:?}"
            );
        }
        // Every fine row outside the blocked coarse cell's range must be
        // covered by exactly one portal — none dropped, none doubled.
        let mut covered = vec![false; fine.rows as usize];
        for p in &fine_side {
            for row in p.tile_start..p.tile_end {
                assert!(!covered[row as usize], "row {row} covered twice");
                covered[row as usize] = true;
            }
        }
        for row in 0..fine.rows {
            let in_block = row >= blocked_coarse_start && row < blocked_coarse_end;
            assert_eq!(covered[row as usize], !in_block, "row {row}");
        }
    }

    // -----------------------------------------------------------------
    // §8.2's on-disk form
    // -----------------------------------------------------------------

    fn band_tag() -> BandTag {
        BandTag {
            band_index: 2,
            band_dm: 20,
        }
    }

    /// A portal with a DISTINCT value in every field, so a record layout
    /// that swaps two same-width fields (the failure a round-trip of
    /// zeroes or of repeated values cannot see) shows up immediately.
    fn distinct_portal() -> Portal {
        Portal {
            id: 0x1111_1111,
            component: 0x2222_2222,
            tile: 0x3333_3333,
            tile_start: 0x4444,
            tile_end: 0x5555,
            neighbour_tile: 0x6666_6666,
            neighbour_start: 0x7777,
            neighbour_end: 0x0888,
            max_draft_dm: 0x0999,
            min_horizontal_width_dm: 0x0AAA,
            touches_fairway: true,
            touches_tss: false,
            lower_bound_cost_mm: -0x0BBB_CCCC_DDDD_EEEE,
        }
    }

    #[test]
    fn a_portal_record_covers_every_field_of_the_struct() {
        // The destructuring is the point: adding a field to `Portal`
        // makes this pattern non-exhaustive and the test STOPS COMPILING,
        // which is the only way to notice a new field silently missing
        // from `to_bytes`/`parse` before an artifact is published with it
        // dropped. Each binding is then compared against the decoded
        // record, so a field that is in the pattern but not in the
        // encoding fails at runtime too.
        let p = distinct_portal();
        let Portal {
            id,
            component,
            tile,
            tile_start,
            tile_end,
            neighbour_tile,
            neighbour_start,
            neighbour_end,
            max_draft_dm,
            min_horizontal_width_dm,
            touches_fairway,
            touches_tss,
            lower_bound_cost_mm,
        } = p;
        let back = Portal::parse(&p.to_bytes()).expect("a whole record parses");
        assert_eq!(back.id, id);
        assert_eq!(back.component, component);
        assert_eq!(back.tile, tile);
        assert_eq!(back.tile_start, tile_start);
        assert_eq!(back.tile_end, tile_end);
        assert_eq!(back.neighbour_tile, neighbour_tile);
        assert_eq!(back.neighbour_start, neighbour_start);
        assert_eq!(back.neighbour_end, neighbour_end);
        assert_eq!(back.max_draft_dm, max_draft_dm);
        assert_eq!(back.min_horizontal_width_dm, min_horizontal_width_dm);
        assert_eq!(back.touches_fairway, touches_fairway);
        assert_eq!(back.touches_tss, touches_tss);
        assert_eq!(back.lower_bound_cost_mm, lower_bound_cost_mm);
        assert_eq!(back, p);
    }

    #[test]
    fn portals_round_trip_through_their_section_payload() {
        let both = Portal {
            touches_fairway: true,
            touches_tss: true,
            ..distinct_portal()
        };
        let neither = Portal {
            touches_fairway: false,
            touches_tss: false,
            lower_bound_cost_mm: i64::MAX,
            ..distinct_portal()
        };
        let tss_only = Portal {
            touches_fairway: false,
            touches_tss: true,
            max_draft_dm: u16::MAX,
            min_horizontal_width_dm: 0,
            ..distinct_portal()
        };
        // All four flag combinations, so neither bit can stand in for
        // the other.
        let portals = vec![distinct_portal(), both, neither, tss_only];
        let bytes = encode_portals(band_tag(), &portals);
        assert_eq!(BandTag::parse(&bytes), Some(band_tag()));
        assert_eq!(
            bytes.len(),
            PORTALS_HEADER_LEN + portals.len() * PORTAL_RECORD_LEN
        );
        assert_eq!(decode_portals(&bytes), Some(portals));

        // An empty band is a real answer, not a missing section.
        let empty = encode_portals(band_tag(), &[]);
        assert_eq!(decode_portals(&empty), Some(Vec::new()));
    }

    #[test]
    fn a_malformed_portals_payload_is_refused_and_never_panics() {
        let good = encode_portals(band_tag(), &[distinct_portal(), distinct_portal()]);
        assert!(decode_portals(&good).is_some());

        // Every truncation, byte by byte: no panic, and no short payload
        // may decode as if it carried both records.
        for len in 0..good.len() {
            let got = decode_portals(&good[..len]);
            assert!(
                got.is_none(),
                "a payload truncated to {len} of {} bytes decoded as {got:?}",
                good.len()
            );
        }

        // A count that claims more records than the bytes hold.
        let mut over = good.clone();
        over[8..12].copy_from_slice(&1000u32.to_le_bytes());
        assert_eq!(decode_portals(&over), None);
        // ...and one whose count * stride overflows outright.
        let mut overflow = good.clone();
        overflow[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
        overflow[12..16].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(decode_portals(&overflow), None);

        // A stride below one record could not address the table at all.
        let mut short_stride = good.clone();
        short_stride[12..16].copy_from_slice(&8u32.to_le_bytes());
        assert_eq!(decode_portals(&short_stride), None);

        for len in [0usize, 1, 8, 15, 16, 39, 55, 4096] {
            assert_eq!(decode_portals(&vec![0xFF; len]), None, "0xFF len {len}");
        }
    }

    #[test]
    fn a_newer_builds_wider_portal_record_still_decodes() {
        // Forward compatibility, the same rule `decode_tile_index` and
        // `decode_stitch` already follow: an older reader walks a newer
        // file's table by its declared stride, reads the prefix it knows
        // and steps over the rest — rather than refusing the file.
        let p = distinct_portal();
        let wide = PORTAL_RECORD_LEN + 16;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&band_tag().to_bytes());
        bytes.extend_from_slice(&1u32.to_le_bytes());
        bytes.extend_from_slice(&(wide as u32).to_le_bytes());
        let mut record = vec![0u8; wide];
        record[..PORTAL_RECORD_LEN].copy_from_slice(&p.to_bytes());
        record[PORTAL_RECORD_LEN..].copy_from_slice(&[0xA5; 16]);
        bytes.extend_from_slice(&record);
        assert_eq!(decode_portals(&bytes), Some(vec![p]));

        // Unknown flag bits are likewise ignored, not rejected.
        let mut future_flags = encode_portals(band_tag(), &[p]);
        future_flags[PORTALS_HEADER_LEN + 28] |= 0b1111_1100;
        let back = decode_portals(&future_flags).expect("unknown flag bits must not reject");
        assert_eq!(back, vec![p]);
    }
}
