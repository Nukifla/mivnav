// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! §3.2's region-wide authority resolution: **finest cell wins**, decided
//! once per artifact region rather than once per rendered tile.
//!
//! The artifact is built over its *own* grid (§4.1's resolution ladder,
//! fixed cell-count tiles — not the MVT pyramid), so "which cell is
//! authoritative over this piece of ground" has to be answered at that
//! grid, in world coordinates. But it must be answered by the **same rule**
//! the tiler already uses, or the routing artifact and the chart the
//! mariner is looking at disagree about which chart is in charge of a
//! stretch of water — the exact class of defect `mvt::select`'s own history
//! is a list of (#vzvprkqo, #ymwnqnmr).
//!
//! So this module supplies geometry, not policy. The policy —
//! finest-tier-first ordering, "only a strictly finer tier may silence",
//! "a bare extent box is not evidence", "a `coverage is None` cell is kept
//! unconditionally" — is [`crate::mvt::select::authority_with`], shared
//! verbatim with the tiler. Read that function's own docs (and
//! [`authority`](crate::mvt::select)'s, above it) for *why* each of those
//! rules exists; none of it is restated here, because there is only one
//! copy of it.
//!
//! # Judgment calls (stated, per this tree's convention)
//!
//! * **World-space ring differencing, not [`crate::mvt::mask::TileMask`].**
//!   The tiler's residual test (`coverage_has_residual_in_tile`) clips
//!   coverage to one MVT tile and rounds every vertex onto that tile's
//!   integer pixel grid — the right thing when the answer's only consumer
//!   is a tile that will be drawn at that quantization, and the wrong thing
//!   here: at overview zoom one MVT unit is tens of metres, and this
//!   artifact's finest ladder level is metres. [`has_residual_in_region`]
//!   therefore differences the raw `Coverage` rings at full world precision
//!   against an arbitrary world-coordinate [`Extent`], the same way
//!   `routing::hazards::clip_to_authority` already clips a hazard union to
//!   the ground finer charts vouch for.
//!
//! * **One ring at a time, folded.** Not a stylistic choice:
//!   `clip_to_authority`'s own docs record a measured `i_overlay`
//!   non-monotonicity (#owqqcdqe, found live at Grenen) where handing the
//!   engine many real, edge-to-edge-tiling coverage rings *at once* — as a
//!   difference subtrahend or pre-unioned — produced a result that got
//!   *less* clipped as more rings joined the set, which is impossible for a
//!   correct set difference. `(A − B) − C == A − (B ∪ C)` by plain set
//!   algebra, so folding one small subtrahend at a time computes the
//!   identical answer while never asking the overlay engine to reason about
//!   more than two polygons at once. This pass runs over a whole chart set,
//!   which is precisely the input size that triggered it.
//!
//! * **Only the tier-ordering core of `mvt::select` is reused** — not its
//!   Phase-1 coverage completion, Phase-2 detail equalization, `rescued`
//!   handling, SCAMIN donor pool or cell cap. Those exist to make a
//!   *rendered* tile look right at a chosen display zoom (a rendering-LOD
//!   concern); the artifact has no display zoom and no styling, it has
//!   ground truth and a resolution ladder chosen by §4.1's own rules.
//!
//! * **The tier key is the tiler's, by call and not by convention.**
//!   [`RegionCell::from_meta`] derives `max_zoom` with
//!   [`crate::mvt::zoom_range_for_scale`] — the one function the whole tree
//!   already derives it with (the backend's `_cell_info` in
//!   `mivnav/features/ocharts/sets.py` calls the same one through pyo3, and
//!   that is where the `max_zoom` handed to `mvt::select` comes from). §3.2
//!   asks for this equality to be *asserted*, not assumed; a test below
//!   pins it against real fixture metadata.

use geo::BooleanOps;

use crate::coords::{unwrap_towards, Extent, WorldXy};
use crate::coverage::{cell_coverage, signed_area2_world, Coverage};
use crate::model::{Cell, CellMeta};
use crate::mvt::select::CellDesc;
use crate::routing::hazards::geo_ring;

/// One candidate cell for the region-wide pass, owning its coverage.
///
/// [`CellDesc`] only *borrows* name and coverage (it is `Copy`, built per
/// tile on the serve path from data the caller already holds). The artifact
/// build has no such caller: it decodes cells and derives coverage itself,
/// so something has to own the result. Build a `Vec<RegionCell>` once for
/// the chart set, then hand [`cell_descs`] to [`region_authority`] for every
/// region.
#[derive(Debug, Clone, PartialEq)]
pub struct RegionCell {
    /// Dataset name — the last sort tiebreak, so the output order is
    /// deterministic (§13.1 depends on that).
    pub name: String,
    /// Compilation scale denominator (CSCL).
    pub scale: u32,
    /// The cell's native zoom — its **detail tier**. See
    /// [`RegionCell::from_meta`] for why it is derived, never chosen.
    pub max_zoom: u8,
    /// The cell's declared coverage, or `None` when it declared none (an
    /// absence of information: such a cell can neither be silenced nor
    /// silence others — `mvt::select::authority`'s rule, unchanged).
    pub coverage: Option<Coverage>,
}

impl RegionCell {
    /// From a cell's metadata plus a coverage the caller already has.
    ///
    /// The coverage a real chart cell arrives with is the OSENC
    /// `CELL_COVR`/`CELL_NOCOVR` block, available from a *header-only* read
    /// ([`crate::osenc::read_header`]) without decoding the cell — which is
    /// exactly what the serve path passes to `mvt::select`, so passing it
    /// here keeps the two passes reasoning about identical inputs. Use
    /// [`from_cell`](Self::from_cell) only when all you have is a decoded
    /// cell.
    ///
    /// `max_zoom` is [`crate::mvt::zoom_range_for_scale`]`(scale).1` — the
    /// crate's single derivation of a compilation scale's native zoom,
    /// reused rather than reimplemented. If this ever stops matching what
    /// the tiler feeds `mvt::select`, the artifact's notion of "finer" and
    /// the chart's diverge silently, so it is pinned by a test.
    pub fn from_meta(meta: &CellMeta, coverage: Option<Coverage>) -> RegionCell {
        RegionCell {
            name: meta.name.clone(),
            scale: meta.compilation_scale,
            max_zoom: crate::mvt::zoom_range_for_scale(meta.compilation_scale).1,
            coverage,
        }
    }

    /// From a decoded cell alone, taking coverage from its `M_COVR`
    /// features ([`crate::coverage::cell_coverage`]) — the other half of
    /// the same fact (see [`crate::osenc`]'s module docs), for callers that
    /// never did a header read.
    pub fn from_cell(cell: &Cell) -> RegionCell {
        RegionCell::from_meta(&cell.meta, cell_coverage(cell))
    }
}

/// Borrow a `RegionCell` slice as the [`CellDesc`] slice the shared
/// authority core takes. Indices line up with the input, so
/// [`region_authority`]'s returned indices index `cells` directly.
pub fn cell_descs(cells: &[RegionCell]) -> Vec<CellDesc<'_, Coverage>> {
    cells
        .iter()
        .map(|c| CellDesc {
            scale: c.scale,
            max_zoom: c.max_zoom,
            name: &c.name,
            coverage: c.coverage.as_ref(),
        })
        .collect()
}

/// v3 §3.2's authority pass at the artifact's own region-wide grid,
/// sharing `mvt::select`'s tier-ordering core
/// ([`crate::mvt::select::authority_with`]) so "assert equality against the
/// tiler" is a real, testable claim.
///
/// Returns `(kept, redundant)` as indices into `cells`: `kept` is the set
/// of cells authoritative over some ground inside `extent`, coarse tiers
/// surviving only where they chart ground no finer tier does; `redundant`
/// are the cells a strictly finer tier already charts in full here.
/// `candidate_idx` selects which cells take part — the caller filters to
/// the cells that reach `extent` at all, exactly as the serve path filters
/// by `tile_state != none`.
///
/// `extent` is the region being resolved, in world coordinates: an artifact
/// tile, a whole band, or a whole chart set's bounds. Nothing about it is
/// tile- or zoom-shaped.
pub fn region_authority(
    cells: &[CellDesc<'_, Coverage>],
    candidate_idx: &[usize],
    extent: Extent,
) -> (Vec<usize>, Vec<usize>) {
    crate::mvt::select::authority_with(cells, candidate_idx, |cov, finer| {
        has_residual_in_region(cov, finer, &extent)
    })
}

/// Does `cov` chart ground inside `extent` that none of `finer` charts?
///
/// The world-space twin of `mvt::mask::coverage_has_residual_in_tile`: the
/// same `coverage − ⋃(finer coverage) ∩ region` algebra and the same
/// fast-path structure (cheap extent tests first, real geometry only for
/// the candidates that survive them), but over an arbitrary world
/// rectangle at full ring precision instead of over one MVT tile's integer
/// pixel grid.
///
/// # Conservative in the SAFE direction, exactly as the tiler is
///
/// Returns `false` ("already fully charted by finer cells — drop") **only**
/// when that is provable. Every case where it is not — no finer coverage
/// overlaps, the candidate does not reach `extent`, a degenerate `extent`,
/// rings that build no polygon — returns `true` (keep). Over-claiming
/// "fully covered" drops a cell that charts real ground, which in this
/// pipeline means the artifact has no chart truth for that water and the
/// router treats it as unknown; under-claiming only keeps a cell that had
/// nothing to add. That asymmetry is the same one
/// `coverage_has_residual_in_tile` documents, and it is why a candidate
/// that does not reach `extent` at all is *kept* here rather than dropped:
/// the tiler answers `true` in that case too (its `TileMask::new` returns
/// `None`), and this pass exists to agree with the tiler.
///
/// # Nonzero winding, honoured
///
/// A [`Coverage`] is one flat ring set under the nonzero winding rule —
/// positive rings chart, negative rings *declare no data* (see
/// [`crate::coverage`]'s module docs). The boolean engine has no such rule,
/// so each side is rebuilt as `union(positive) − union(negative)`. Getting
/// this wrong in the subtrahend would subtract ground a finer chart
/// explicitly says it does *not* cover, silently deleting the coarser
/// cell that is genuinely authoritative there.
pub fn has_residual_in_region(cov: &Coverage, finer: &[&Coverage], extent: &Extent) -> bool {
    if !extent.valid || extent.xmin >= extent.xmax || extent.ymin >= extent.ymax {
        return true; // nothing can be proven over a degenerate region
    }
    // Every coverage is unwrapped into its own ±180° frame (`Coverage`'s
    // constructors anchor each cell's rings to that cell's first ring), so
    // cells either side of the antimeridian can sit a whole world apart in
    // x while charting adjacent water. Slide each one, as a unit, into the
    // region's frame before any of them are compared.
    let anchor = extent.midpoint().x as i64;
    let cand_dx = seam_shift(cov, anchor);
    if !extent_overlaps(extent, &cov.extent, cand_dx) {
        return true; // the candidate charts nothing here (see above: keep)
    }
    // Fast path, no geometry at all: nothing finer even reaches the ground
    // the candidate claims inside this region. The common case on a real
    // set — the finest cell of every region, and every cell with no finer
    // cell over it — and the gate this pass leans on for cost.
    let finer: Vec<(&Coverage, f64)> = finer
        .iter()
        .map(|f| {
            let dx = seam_shift(f, anchor);
            (*f, dx)
        })
        .filter(|(f, dx)| {
            extent_overlaps(extent, &f.extent, *dx)
                && extent_overlaps(&shifted_extent(&cov.extent, cand_dx), &f.extent, *dx)
        })
        .collect();
    if finer.is_empty() {
        return true;
    }
    // The candidate's own region inside `extent`. Unbuildable ⇒ nothing can
    // be proven ⇒ keep.
    let Some(mut acc) = region_within(cov, cand_dx, extent) else {
        return true;
    };
    for (f, dx) in finer {
        // `f`'s no-data rings, if any: subtracted from each of its charting
        // rings before that ring is subtracted from `acc`, so
        // `⋃ᵢ(Pᵢ − ⋃ⱼNⱼ) == (⋃ᵢPᵢ) − ⋃ⱼNⱼ` — `f`'s real region — comes out
        // of `acc` and nothing else does.
        let negatives: Vec<&Vec<WorldXy>> = f
            .rings
            .iter()
            .filter(|r| signed_area2_world(r) < 0)
            .collect();
        for ring in &f.rings {
            if acc.0.is_empty() {
                break; // fully charted by finer cells already — stop folding
            }
            if signed_area2_world(ring) <= 0 {
                continue;
            }
            // Cheap per-ring gate before the boolean: `acc` only ever
            // shrinks and never leaves `extent`, so a ring whose own bbox
            // misses `extent` cannot touch any of it.
            if !ring_reaches(ring, dx, extent) {
                continue;
            }
            let mut one = single(ring, dx);
            for neg in &negatives {
                if one.0.is_empty() {
                    break;
                }
                one = one.difference(&single(neg, dx));
            }
            if one.0.is_empty() {
                continue;
            }
            acc = acc.difference(&one);
        }
    }
    !acc.0.is_empty()
}

/// `cov`'s charted region, clipped to `extent`, in the region's seam frame
/// (`dx` from [`seam_shift`]). `None` when it is empty.
fn region_within(cov: &Coverage, dx: f64, extent: &Extent) -> Option<geo::MultiPolygon<f64>> {
    let mut adds: Vec<geo::Polygon<f64>> = Vec::new();
    let mut subs: Vec<&Vec<WorldXy>> = Vec::new();
    for ring in &cov.rings {
        match signed_area2_world(ring) {
            a if a > 0 => adds.push(polygon(ring, dx)),
            a if a < 0 => subs.push(ring),
            _ => {}
        }
    }
    if adds.is_empty() {
        return None;
    }
    // One `unary_union` over a SINGLE cell's charting rings — the same
    // per-cell shape `mvt::mask::TileMask::new` uses, and well clear of the
    // many-cell input size that measured non-monotonic (module docs). The
    // no-data rings and the finer cells' rings are still folded one at a
    // time.
    let mut region = geo::unary_union(&adds);
    for neg in subs {
        if region.0.is_empty() {
            return None;
        }
        region = region.difference(&single(neg, dx));
    }
    let clipped = region.intersection(&rect(extent));
    (!clipped.0.is_empty()).then_some(clipped)
}

/// One coverage ring as a hole-less polygon, slid by `dx`.
fn polygon(ring: &[WorldXy], dx: f64) -> geo::Polygon<f64> {
    let mut ls = geo_ring(ring);
    if dx != 0.0 {
        for c in ls.0.iter_mut() {
            c.x += dx;
        }
    }
    geo::Polygon::new(ls, vec![])
}

/// …as a one-polygon `MultiPolygon`, the shape `BooleanOps` takes.
fn single(ring: &[WorldXy], dx: f64) -> geo::MultiPolygon<f64> {
    geo::MultiPolygon::new(vec![polygon(ring, dx)])
}

/// `extent` as a rectangle to clip against.
fn rect(e: &Extent) -> geo::MultiPolygon<f64> {
    let (x0, x1) = (e.xmin as f64, e.xmax as f64);
    let (y0, y1) = (e.ymin as f64, e.ymax as f64);
    geo::MultiPolygon::new(vec![geo::Polygon::new(
        geo::LineString::new(vec![
            geo::Coord { x: x0, y: y0 },
            geo::Coord { x: x1, y: y0 },
            geo::Coord { x: x1, y: y1 },
            geo::Coord { x: x0, y: y1 },
            geo::Coord { x: x0, y: y0 },
        ]),
        vec![],
    )])
}

/// How far to slide `cov`'s whole ring set, in whole worlds, so it shares a
/// ±180° frame with `anchor` (a world x). Zero for everything that is not
/// near the antimeridian, which is every chart set anyone sails with.
///
/// One shift for the WHOLE coverage — never per ring: `Coverage`'s
/// constructors already put a cell's rings in one common frame
/// ([`crate::coords::unwrap_anchor`]), and re-anchoring them individually
/// would tear a multi-ring coverage apart.
fn seam_shift(cov: &Coverage, anchor: i64) -> f64 {
    if !cov.extent.valid {
        return 0.0;
    }
    let mid = cov.extent.midpoint().x;
    f64::from(unwrap_towards(mid, anchor)) - f64::from(mid)
}

/// `e` slid by `dx`, as `f64` bounds (`(xmin, xmax, ymin, ymax)`) — a
/// shifted extent can leave the `i32` world range, which is the whole point
/// of the seam headroom, so this never round-trips through `Extent`.
fn shifted_bounds(e: &Extent, dx: f64) -> (f64, f64, f64, f64) {
    (
        f64::from(e.xmin) + dx,
        f64::from(e.xmax) + dx,
        f64::from(e.ymin),
        f64::from(e.ymax),
    )
}

/// `e` slid by `dx`, clamped back into an `Extent` for a further overlap
/// test against another shifted extent.
fn shifted_extent(e: &Extent, dx: f64) -> Extent {
    let mut out = *e;
    if dx != 0.0 {
        let clamp = |v: f64| v.clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32;
        out.xmin = clamp(f64::from(e.xmin) + dx);
        out.xmax = clamp(f64::from(e.xmax) + dx);
    }
    out
}

/// Does the region overlap `cov_extent` once slid by `dx`? Extents are a
/// superset of the rings they bound, so a false "overlap" costs one wasted
/// boolean and a missed overlap is impossible — the safe direction, same as
/// `mvt::mask`'s own `extents_overlap`.
fn extent_overlaps(region: &Extent, cov_extent: &Extent, dx: f64) -> bool {
    if !cov_extent.valid || !region.valid {
        return false;
    }
    let (xmin, xmax, ymin, ymax) = shifted_bounds(cov_extent, dx);
    !(xmax < f64::from(region.xmin)
        || f64::from(region.xmax) < xmin
        || ymax < f64::from(region.ymin)
        || f64::from(region.ymax) < ymin)
}

/// Does one ring's own bounding box reach `extent` once slid by `dx`? The
/// per-ring twin of the above, and the same gate
/// `routing::hazards::clip_to_authority` puts in front of its own fold.
fn ring_reaches(ring: &[WorldXy], dx: f64, extent: &Extent) -> bool {
    let mut bb: Option<(f64, f64, f64, f64)> = None;
    for p in ring {
        let (x, y) = (f64::from(p.x) + dx, f64::from(p.y));
        bb = Some(match bb {
            None => (x, x, y, y),
            Some((x0, x1, y0, y1)) => (x0.min(x), x1.max(x), y0.min(y), y1.max(y)),
        });
    }
    let Some((xmin, xmax, ymin, ymax)) = bb else {
        return false;
    };
    !(xmax < f64::from(extent.xmin)
        || f64::from(extent.xmax) < xmin
        || ymax < f64::from(extent.ymin)
        || f64::from(extent.ymax) < ymin)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::WORLD_SHIFT;
    use std::collections::HashSet;

    /// A closed, positively-wound (y-down) rectangle.
    fn boxr(x0: i32, y0: i32, x1: i32, y1: i32) -> Vec<WorldXy> {
        vec![
            WorldXy::new(x0, y0),
            WorldXy::new(x1, y0),
            WorldXy::new(x1, y1),
            WorldXy::new(x0, y1),
            WorldXy::new(x0, y0),
        ]
    }

    fn cov(rings: Vec<Vec<WorldXy>>) -> Coverage {
        Coverage::from_rings(rings, vec![]).expect("a positive ring")
    }

    fn cell(name: &str, scale: u32, max_zoom: u8, coverage: Option<Coverage>) -> RegionCell {
        RegionCell {
            name: name.to_string(),
            scale,
            max_zoom,
            coverage,
        }
    }

    fn kept_names(cells: &[RegionCell], extent: Extent) -> HashSet<&str> {
        let descs = cell_descs(cells);
        let idx: Vec<usize> = (0..cells.len()).collect();
        let (kept, _) = region_authority(&descs, &idx, extent);
        kept.iter().map(|&i| cells[i].name.as_str()).collect()
    }

    const REGION: Extent = Extent::new(0, 1000, 0, 1000);

    /// The base case, in world space: a finer cell whose coverage contains
    /// the coarser one's, over the whole region — the coarse cell has
    /// nothing left to be authoritative about and is dropped.
    #[test]
    fn a_superseded_coarse_cell_is_dropped() {
        let cells = [
            cell(
                "COARSE",
                180_000,
                12,
                Some(cov(vec![boxr(100, 100, 400, 400)])),
            ),
            cell("FINE", 22_000, 15, Some(cov(vec![boxr(0, 0, 900, 900)]))),
        ];
        assert_eq!(kept_names(&cells, REGION), HashSet::from(["FINE"]));
    }

    /// …and the residual case: the coarse cell reaches ground the finer one
    /// does not chart, so it survives. This is the whole point of the pass —
    /// dropping it here leaves the artifact with no chart truth over that
    /// water.
    #[test]
    fn a_coarse_cell_with_residual_ground_survives() {
        let cells = [
            cell("COARSE", 180_000, 12, Some(cov(vec![boxr(0, 0, 900, 900)]))),
            cell("FINE", 22_000, 15, Some(cov(vec![boxr(0, 0, 400, 400)]))),
        ];
        assert_eq!(
            kept_names(&cells, REGION),
            HashSet::from(["COARSE", "FINE"])
        );
    }

    /// The residual test is scoped to the REGION, not to the whole world:
    /// the very same pair of cells above, resolved over a region the finer
    /// cell wholly covers, drops the coarse cell — even though it charts
    /// residual ground elsewhere. Region-wide authority that ignored its own
    /// extent would keep every coarse cell everywhere.
    #[test]
    fn residual_is_measured_inside_the_region_only() {
        let cells = [
            cell("COARSE", 180_000, 12, Some(cov(vec![boxr(0, 0, 900, 900)]))),
            cell("FINE", 22_000, 15, Some(cov(vec![boxr(0, 0, 400, 400)]))),
        ];
        assert_eq!(
            kept_names(&cells, Extent::new(50, 300, 50, 300)),
            HashSet::from(["FINE"]),
            "inside the finer cell, the coarse one adds nothing"
        );
        assert_eq!(
            kept_names(&cells, Extent::new(500, 800, 500, 800)),
            HashSet::from(["COARSE", "FINE"]),
            "beyond it FINE charts nothing — and a cell that charts nothing \
             inside the region is KEPT, never dropped: it is the tiler's own \
             answer (`TileMask::new` returns None there, so its residual test \
             says keep too), and the caller is the one that filters candidates \
             down to the cells that reach the region"
        );
    }

    /// A finer cell's declared NO-DATA ring is not coverage. Subtracting a
    /// coverage's raw rings without honouring the nonzero winding rule
    /// (positive charts, negative un-charts) would take the hole out of the
    /// coarse cell too, and delete the one cell that is genuinely
    /// authoritative over that ground.
    #[test]
    fn a_finer_cells_nodata_hole_leaves_the_coarse_cell_authoritative() {
        let holed = Coverage::from_rings(
            vec![boxr(0, 0, 900, 900)],
            vec![boxr(300, 300, 600, 600)], // "no coverage available" here
        )
        .expect("a positive ring");
        let cells = [
            cell("COARSE", 180_000, 12, Some(cov(vec![boxr(0, 0, 900, 900)]))),
            cell("FINE", 22_000, 15, Some(holed)),
        ];
        assert_eq!(
            kept_names(&cells, REGION),
            HashSet::from(["COARSE", "FINE"])
        );
        // and with the hole gone the coarse cell really is superseded —
        // proving the assertion above is about the hole, not about the boxes
        let cells = [
            cell("COARSE", 180_000, 12, Some(cov(vec![boxr(0, 0, 900, 900)]))),
            cell("FINE", 22_000, 15, Some(cov(vec![boxr(0, 0, 900, 900)]))),
        ];
        assert_eq!(kept_names(&cells, REGION), HashSet::from(["FINE"]));
    }

    /// #ymwnqnmr in world space, ported from `mvt::select`'s
    /// `a_bare_extent_box_neither_silences_nor_masks_a_ring_cell`: on the
    /// real Baltic union tile 8/137/81 a freenauticalchart German 1:90k cell
    /// declares one extent RECTANGLE while its geometry stops at the DE/DK
    /// maritime boundary, and — strictly finer — it silenced the o-charts
    /// Danish 1:180k cell beside it, whose 802-point ring follows that
    /// boundary. The rule that fixed it lives in the shared core, so it must
    /// hold identically under this geometry backend; this pins that it does,
    /// rather than merely that the code compiles.
    #[test]
    fn a_bare_extent_box_does_not_silence_a_ring_cell_in_world_space() {
        // the box blankets the region — the strongest form of the over-claim
        let boxy = cov(vec![boxr(0, 0, 1000, 1000)]);
        assert!(boxy.is_extent_box(), "the German cell's claim, exactly");
        // a real ring declaration inside it (chamfered so it is not a box)
        let mut ring = boxr(100, 100, 500, 500);
        ring.insert(1, WorldXy::new(400, 100));
        ring[2] = WorldXy::new(500, 200);
        let ring_cov = cov(vec![ring]);
        assert!(!ring_cov.is_extent_box());

        let cells = [
            cell("RING_COARSE", 180_000, 12, Some(ring_cov)),
            cell("BOX_FINE", 90_000, 13, Some(boxy)),
        ];
        assert_eq!(
            kept_names(&cells, REGION),
            HashSet::from(["RING_COARSE", "BOX_FINE"]),
            "a claim that is only a bounding box may not silence the cell \
             that declared where it actually charts"
        );
    }

    /// The other half of that rule, also ported: box-against-box masking is
    /// load-bearing (a producer that declares only rectangles still has a
    /// scale ladder), so a finer box DOES silence a coarser one.
    #[test]
    fn a_bare_extent_box_still_silences_another_bare_extent_box() {
        let cells = [
            cell(
                "BOX_COARSE",
                180_000,
                12,
                Some(cov(vec![boxr(100, 100, 400, 400)])),
            ),
            cell(
                "BOX_FINE",
                90_000,
                13,
                Some(cov(vec![boxr(0, 0, 900, 900)])),
            ),
        ];
        assert_eq!(kept_names(&cells, REGION), HashSet::from(["BOX_FINE"]));
    }

    /// Equal detail is not authority (#vzvprkqo): two cells of the same
    /// tier are one generalization of adjacent ground, never two
    /// generalizations of one piece of it, so neither may silence the
    /// other — whichever way the name tiebreak happens to sort them.
    #[test]
    fn an_equally_detailed_peer_never_silences_another() {
        for over_name in ["A_OVERCLAIM", "Z_OVERCLAIM"] {
            let cells = [
                cell(
                    over_name,
                    180_000,
                    12,
                    Some(cov(vec![boxr(0, 0, 1000, 1000)])),
                ),
                cell(
                    "PEER",
                    180_000,
                    12,
                    Some(cov(vec![boxr(100, 100, 400, 400)])),
                ),
            ];
            assert_eq!(
                kept_names(&cells, REGION),
                HashSet::from([over_name, "PEER"]),
                "{over_name} shares a tier with PEER and cannot silence it"
            );
        }
    }

    /// A `coverage is None` cell declared nothing, so nothing can be proven
    /// about it: kept unconditionally, and unable to silence anyone.
    #[test]
    fn a_coverage_none_cell_is_kept_and_silences_nobody() {
        let cells = [
            cell("COARSE", 180_000, 12, Some(cov(vec![boxr(0, 0, 900, 900)]))),
            cell("NOCOV", 22_000, 15, None),
        ];
        assert_eq!(
            kept_names(&cells, REGION),
            HashSet::from(["COARSE", "NOCOV"])
        );
    }

    /// The pass is region-scoped, so a cell that charts nothing inside the
    /// region cannot silence one that does — a residual test that ignored
    /// `extent` on the subtrahend side would let a far-away finer cell
    /// delete real chart truth.
    #[test]
    fn a_finer_cell_elsewhere_silences_nothing_here() {
        let cells = [
            cell("HERE", 180_000, 12, Some(cov(vec![boxr(0, 0, 900, 900)]))),
            cell(
                "FAR",
                22_000,
                15,
                Some(cov(vec![boxr(100_000, 100_000, 200_000, 200_000)])),
            ),
        ];
        assert_eq!(kept_names(&cells, REGION), HashSet::from(["HERE", "FAR"]));
    }

    /// Coverages either side of the ±180° seam are each unwrapped into
    /// their OWN frame, so the same water can sit a whole world apart in x.
    /// The pass slides each coverage into the region's frame before
    /// comparing, so a finer cell written in the other frame still
    /// supersedes the coarser one.
    #[test]
    fn coverages_in_opposite_seam_frames_are_compared_in_one_frame() {
        let w = WORLD_SHIFT;
        let coarse = cov(vec![boxr(w - 400, 100, w - 100, 400)]);
        // the identical ground, written a whole world to the left
        let fine = cov(vec![boxr(-400 - 1, 0, -1, 500)]);
        let region = Extent::new(w - 500, w - 50, 0, 500);
        let cells = [
            cell("COARSE", 180_000, 12, Some(coarse)),
            cell("FINE", 22_000, 15, Some(fine)),
        ];
        assert_eq!(
            kept_names(&cells, region),
            HashSet::from(["FINE"]),
            "the finer cell charts the same ground, one world over"
        );
    }

    /// A degenerate or absent region proves nothing, so everything is kept.
    #[test]
    fn a_degenerate_region_keeps_everything() {
        let cells = [
            cell("COARSE", 180_000, 12, Some(cov(vec![boxr(0, 0, 900, 900)]))),
            cell("FINE", 22_000, 15, Some(cov(vec![boxr(0, 0, 900, 900)]))),
        ];
        assert_eq!(
            kept_names(&cells, Extent::invalid()),
            HashSet::from(["COARSE", "FINE"])
        );
        assert_eq!(
            kept_names(&cells, Extent::new(10, 10, 10, 10)),
            HashSet::from(["COARSE", "FINE"])
        );
    }

    /// §3.2's own requirement: the artifact's tier key must be the tiler's,
    /// "asserted against the tiler in the test suite, not by convention".
    /// The tiler's `max_zoom` reaches `mvt::select` from
    /// `chartcore.zoom_range_for_scale(header["scale"])`
    /// (`mivnav/features/ocharts/sets.py::_cell_info`), so this asserts
    /// `RegionCell` derives the identical value from the identical input —
    /// on the real fixture's real metadata, and across the whole scale
    /// ladder.
    #[test]
    fn the_tier_key_is_the_tilers() {
        let header = de6ostim_header();
        assert_eq!(
            RegionCell::from_meta(&header.meta, header.coverage.clone()).max_zoom,
            crate::mvt::zoom_range_for_scale(header.meta.compilation_scale).1,
        );
        for scale in [1u32, 4_000, 12_000, 22_000, 90_000, 180_000, 1_500_000] {
            let meta = CellMeta {
                name: "X".into(),
                compilation_scale: scale,
                ..CellMeta::default()
            };
            assert_eq!(
                RegionCell::from_meta(&meta, None).max_zoom,
                crate::mvt::zoom_range_for_scale(scale).1,
                "scale 1:{scale}"
            );
        }
    }

    fn de6ostim_header() -> crate::osenc::CellHeader {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../backend/data/fnc/DE6OSTIM.S57");
        let file = std::fs::File::open(&path).expect("DE6OSTIM fixture reads");
        crate::osenc::read_header(file).expect("DE6OSTIM fixture header decodes")
    }

    /// A real cell's real coverage, against synthetic neighbours placed
    /// from its own extent — the geometry backend on chart-authored rings,
    /// not on hand-drawn rectangles.
    ///
    /// `DE6OSTIM.S57` is a freenauticalchart cell, so its declared coverage
    /// is the bare extent rectangle every one of those 314 cells declares
    /// (CLAUDE.md; `Coverage::is_extent_box`'s own docs) — which makes it
    /// the honest input for exactly the case #ymwnqnmr is about.
    #[test]
    fn de6ostim_resolves_against_its_neighbours() {
        let header = de6ostim_header();
        let cov = header
            .coverage
            .clone()
            .expect("the fixture declares coverage");
        let e = cov.extent;
        assert!(e.valid);
        assert!(
            cov.is_extent_box(),
            "a freenauticalchart cell declares exactly one extent rectangle"
        );
        let real = RegionCell::from_meta(&header.meta, Some(cov));
        let mid = e.midpoint();
        let inner = Extent::new(mid.x - 100, mid.x + 100, mid.y - 100, mid.y + 100);
        let outside = Extent::new(e.xmax + 200, e.xmax + 800, e.ymin, e.ymin + 600);

        let coarse = |name: &str, coverage: Coverage| {
            RegionCell::from_meta(
                &CellMeta {
                    name: name.into(),
                    compilation_scale: real.scale.saturating_mul(10).max(1_500_000),
                    ..CellMeta::default()
                },
                Some(coverage),
            )
        };
        let blanket = vec![
            WorldXy::new(e.xmin - 1000, e.ymin - 1000),
            WorldXy::new(e.xmax + 1000, e.ymin - 1000),
            WorldXy::new(e.xmax + 1000, e.ymax + 1000),
            WorldXy::new(e.xmin - 1000, e.ymax + 1000),
        ];

        // (a) A coarser neighbour that declared real RINGS (one extra
        // vertex is enough to make it more than its own bounding box). The
        // fixture is finer AND blanketing, but its claim is only a box, so
        // #ymwnqnmr says it may not silence the honest declaration — the
        // real 8/137/81 defect, on real cell metadata.
        let mut ringed = blanket.clone();
        ringed.insert(1, WorldXy::new(e.xmax, e.ymin - 500));
        let ringed = cov_of(ringed);
        assert!(!ringed.is_extent_box());
        let cells = [coarse("RING_OVERVIEW", ringed), real.clone()];
        assert!(
            cells[0].max_zoom < cells[1].max_zoom,
            "the synthetic neighbour must be a genuinely coarser tier"
        );
        assert_eq!(
            kept_names(&cells, inner),
            HashSet::from(["RING_OVERVIEW", real.name.as_str()]),
            "the fixture's bare extent box may not delete a ring declaration"
        );

        // (b) The same neighbour declaring only ITS box: box-against-box is
        // a real scale ladder, so inside the fixture's coverage the coarser
        // cell is genuinely superseded…
        let cells = [coarse("BOX_OVERVIEW", cov_of(blanket)), real.clone()];
        assert_eq!(
            kept_names(&cells, inner),
            HashSet::from([real.name.as_str()]),
            "the harbour cell is authoritative over its own water"
        );
        // …while beyond that coverage it is authoritative again. (The
        // fixture is the finest tier present, so it is kept either way —
        // nothing finer exists to measure it against. The claim under test
        // is about the coarse cell, and it flips.)
        assert!(
            kept_names(&cells, outside).contains("BOX_OVERVIEW"),
            "outside the fixture's coverage the overview charts the water"
        );
    }

    fn cov_of(ring: Vec<WorldXy>) -> Coverage {
        Coverage::from_rings(vec![ring], vec![]).expect("a positive ring")
    }
}
