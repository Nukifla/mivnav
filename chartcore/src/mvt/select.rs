//! Reference-scale cell selection — which cells of a set serve a tile.
//!
//! See docs/architecture/cell-selection.md for the two-phase algorithm, the
//! #vzvprkqo/#ymwnqnmr masking invariants, and the measured bugs they fix.
//!
//! Generic over [`CoverageLike`] so unit tests drive it with a token fake while
//! the serve path passes the real [`crate::coverage::Coverage`].

use std::cmp::Reverse;

use crate::coverage::Coverage;
use crate::mvt::{coverage_has_residual_in_tile, coverage_tile_state, TileState};

/// The coverage questions selection asks — abstracted so tests can fake them.
pub trait CoverageLike {
    fn tile_state(&self, z: u8, x: u32, y: u32) -> TileState;
    /// Does this cell chart ground in the tile that none of `finer` charts?
    fn residual(&self, finer: &[&Self], z: u8, x: u32, y: u32) -> bool
    where
        Self: Sized;
    /// Is the declaration nothing but the cell's extent rectangle? See
    /// docs/architecture/cell-selection.md, "a bare extent box is not
    /// evidence".
    fn is_extent_box(&self) -> bool;
}

impl CoverageLike for Coverage {
    fn tile_state(&self, z: u8, x: u32, y: u32) -> TileState {
        coverage_tile_state(self, z, x, y)
    }
    fn residual(&self, finer: &[&Self], z: u8, x: u32, y: u32) -> bool {
        coverage_has_residual_in_tile(self, finer, z, x, y)
    }
    fn is_extent_box(&self) -> bool {
        Coverage::is_extent_box(self)
    }
}

/// See docs/architecture/cell-selection.md, "a bare extent box is not evidence".
fn only_a_box<C: CoverageLike>(cell: &CellDesc<'_, C>) -> bool {
    cell.coverage.is_none_or(|cov| cov.is_extent_box())
}

/// The subset of `others` that may be weighed against a candidate which
/// declares `cand_only_a_box` — everything when the candidate is itself a
/// box, otherwise only the cells that declared real coverage rings.
fn evidence_against<'c, C: CoverageLike>(
    cand_only_a_box: bool,
    others: &[(&'c C, bool)],
) -> Vec<&'c C> {
    others
        .iter()
        .filter(|&&(_, other_is_box)| cand_only_a_box || !other_is_box)
        .map(|&(cov, _)| cov)
        .collect()
}

/// Phase-1 coverage completion: appends `candidates` still charting ground no
/// kept cell does (rescued if beyond the band). Same evidence rule as
/// [`authority`]; shared by both Phase-1 branches (#qvpunzlw).
fn complete_coverage<C: CoverageLike>(
    cells: &[CellDesc<'_, C>],
    kept: &mut Vec<usize>,
    candidates: Vec<usize>,
    z: u8,
    x: u32,
    y: u32,
) -> bool {
    let mut added = false;
    let mut kept_cov: Vec<(&C, bool)> = kept
        .iter()
        .filter_map(|&i| cells[i].coverage.map(|c| (c, c.is_extent_box())))
        .collect();
    for i in candidates {
        let Some(cov) = cells[i].coverage else {
            continue;
        };
        let against = evidence_against(only_a_box(&cells[i]), &kept_cov);
        if cov.residual(&against, z, x, y) {
            kept.push(i);
            kept_cov.push((cov, cov.is_extent_box()));
            added = true;
        }
    }
    added
}

/// One candidate cell — only the fields selection needs.
pub struct CellDesc<'a, C: CoverageLike> {
    pub scale: u32,
    pub max_zoom: u8,
    pub name: &'a str,
    pub coverage: Option<&'a C>,
}

// Hand-written so `C` need not be `Clone`/`Copy`: only the shared reference is.
impl<'a, C: CoverageLike> Clone for CellDesc<'a, C> {
    fn clone(&self) -> Self {
        *self
    }
}
impl<'a, C: CoverageLike> Copy for CellDesc<'a, C> {}

/// The reference-scale reach knobs (runtime `ocharts.*` config).
#[derive(Clone, Copy)]
pub struct Knobs {
    pub over_zoom: u8,
    pub under_zoom: u8,
    pub detail_gap: u8,
    /// How many zoom-levels finer than the tile zoom Phase 2 may reach.
    /// Requires `overview_detail_cutoff > over_zoom`; see
    /// docs/architecture/cell-selection.md for the z5-explosion rationale.
    pub overview_detail_cutoff: u8,
    pub max_cells: usize,
}

/// The cap bit — for the caller to log. `(name, scale)` of each dropped cell.
pub struct CapOverflow {
    pub rescued: bool,
    pub kept_before_trim: usize,
    pub cap: usize,
    pub dropped: Vec<(String, u32)>,
}

/// The outcome — indices into the input `cells` slice.
pub struct Selection {
    /// Served cells, coarse→fine (the merge order: detail draws on top).
    pub kept: Vec<usize>,
    /// Parallel to [`kept`](Self::kept): the cells whose coverage masks
    /// `kept[i]` ([`mask`](super::mask)), as indices into `cells`. Only a
    /// **strictly finer** kept cell may mask — see
    /// docs/architecture/cell-selection.md, "`Selection::masks`".
    pub masks: Vec<Vec<usize>>,
    /// SCAMIN reconciliation donor pool, coarse-first; always ⊇ `kept`.
    pub donors: Vec<usize>,
    /// Some served cell is overzoomed beyond the band → the no-data claim must
    /// refuse and the tighter cap applies.
    pub rescued: bool,
    /// The set claims "no ENC data here" over this tile (gate the caller ANDs
    /// with "the set has cells and its bounds reach the tile").
    pub claims_nodata: bool,
    /// Set when the cap trimmed cells — the caller logs it (loud for the
    /// non-rescued authoritative set, which should never overflow).
    pub overflow: Option<CapOverflow>,
}

/// The tighter cap for rescued (overzoomed-speck) cells.
pub const MAX_RESCUED_CELLS_PER_TILE: usize = 8;

/// Region authority: finest→coarsest, keep a cell iff no strictly finer kept
/// cell already charts its ground; coverage-None is kept unconditionally.
/// Invariants #vzvprkqo and #ymwnqnmr — see docs/architecture/cell-selection.md.
fn authority<'a, C: CoverageLike>(
    cells: &[CellDesc<'a, C>],
    idx: &[usize],
    z: u8,
    x: u32,
    y: u32,
) -> (Vec<usize>, Vec<usize>) {
    authority_with(cells, idx, |cov, finer| cov.residual(finer, z, x, y))
}

/// [`authority`]'s tier-ordering / bare-extent-box core, with the residual
/// test left to the caller — the same rules, decoupled from `(z, x, y)` and
/// from any particular geometry backend.
///
/// `residual(cand, finer)` answers exactly what [`CoverageLike::residual`]
/// answers, over whatever region the caller is resolving: "does `cand` chart
/// ground here that none of `finer` charts?". [`authority`] passes the
/// MVT-tile-quantized test (`coverage_has_residual_in_tile`); the routing
/// artifact's region-wide pass ([`crate::mivnav::authority::region_authority`],
/// v3 §3.2) passes a world-space ring-differencing one over its own grid,
/// which is neither a tile nor pixel-quantized.
///
/// It exists so those two are the *same* authority rule and not two
/// implementations that agree by convention: everything this file documents
/// above — only a strictly finer tier may silence (#vzvprkqo), a bare extent
/// box is not evidence (#ymwnqnmr), a `coverage is None` cell is kept
/// unconditionally, and the deterministic finest-first ordering — lives here,
/// once. The artifact build asserts equality against the tiler by calling
/// this, not by reimplementing it.
pub(crate) fn authority_with<'a, C: CoverageLike>(
    cells: &[CellDesc<'a, C>],
    idx: &[usize],
    mut residual: impl FnMut(&C, &[&C]) -> bool,
) -> (Vec<usize>, Vec<usize>) {
    let mut ordered = idx.to_vec();
    // finest first; scale/name only make output order deterministic — within
    // one max_zoom they no longer decide who masks whom (see tier loop below).
    ordered.sort_by(|&a, &b| {
        let (ca, cb) = (&cells[a], &cells[b]);
        cb.max_zoom
            .cmp(&ca.max_zoom)
            .then(ca.scale.cmp(&cb.scale))
            .then(ca.name.cmp(cb.name))
    });
    let mut kept = Vec::new();
    let mut kept_cov: Vec<(&C, bool)> = Vec::new();
    let mut redundant = Vec::new();
    let mut tier_start = 0;
    while tier_start < ordered.len() {
        // one detail tier: the run of equal `max_zoom` the sort has grouped
        let mz = cells[ordered[tier_start]].max_zoom;
        let tier_end = ordered[tier_start..]
            .iter()
            .position(|&i| cells[i].max_zoom != mz)
            .map_or(ordered.len(), |n| tier_start + n);
        // `kept_cov` holds only strictly finer tiers; this tier's survivors
        // join it once every member has been judged (never tested against peers)
        let mut tier_cov: Vec<(&C, bool)> = Vec::new();
        for &i in &ordered[tier_start..tier_end] {
            match cells[i].coverage {
                None => kept.push(i),
                Some(cov) => {
                    let finer = evidence_against(only_a_box(&cells[i]), &kept_cov);
                    if finer.is_empty() || residual(cov, &finer) {
                        kept.push(i);
                        tier_cov.push((cov, cov.is_extent_box()));
                    } else {
                        redundant.push(i);
                    }
                }
            }
        }
        kept_cov.extend(tier_cov);
        tier_start = tier_end;
    }
    (kept, redundant)
}

/// Select the serving cells for tile `z`/`x`/`y` from `cells` (the set's cells
/// that chart the tile — coverage `tile_state != none`, or a coverage-None cell
/// whose extent reaches it; the caller filters that).
pub fn select<'a, C: CoverageLike>(
    cells: &[CellDesc<'a, C>],
    z: u8,
    x: u32,
    y: u32,
    k: &Knobs,
) -> Selection {
    let n = cells.len();
    if n == 0 {
        return Selection {
            kept: vec![],
            masks: vec![],
            donors: vec![],
            rescued: false,
            claims_nodata: true,
            overflow: None,
        };
    }
    let band_top = z as i32 + k.over_zoom as i32;
    let band_bottom = z as i32 - k.under_zoom as i32;

    // Phase 1: primary band, then complete coverage from out-of-band. The
    // coarse (under_zoom) edge binds only cells WITH coverage — a coverage-None
    // cell can't be re-added by residual, so it must never fall out for being
    // coarse.
    let in_band: Vec<usize> = (0..n)
        .filter(|&i| {
            let mz = cells[i].max_zoom as i32;
            mz <= band_top && (cells[i].coverage.is_none() || mz >= band_bottom)
        })
        .collect();

    // NOTHING in-band (distinct from `rescued`, which also fires when a coarser
    // cell is pulled to complete an otherwise-populated band). Phase 2 and the
    // tighter cap key on THIS — see docs/architecture/cell-selection.md.
    let whole_tile_rescue = in_band.is_empty();

    let mut rescued;
    let mut kept;
    let mut redundant;
    if !in_band.is_empty() {
        let (k1, r1) = authority(cells, &in_band, z, x, y);
        kept = k1;
        redundant = r1;
        rescued = false;
        let in_band_set: std::collections::HashSet<usize> = in_band.iter().copied().collect();
        let mut out: Vec<usize> = (0..n)
            .filter(|&i| !in_band_set.contains(&i) && cells[i].coverage.is_some())
            .collect();
        // nearest the reference first; ties finer-first
        out.sort_by(|&a, &b| {
            let (ca, cb) = (&cells[a], &cells[b]);
            let da = (ca.max_zoom as i32 - z as i32).abs();
            let db = (cb.max_zoom as i32 - z as i32).abs();
            da.cmp(&db)
                .then(cb.max_zoom.cmp(&ca.max_zoom))
                .then(ca.scale.cmp(&cb.scale))
                .then(ca.name.cmp(cb.name))
        });
        rescued |= complete_coverage(cells, &mut kept, out, z, x, y);
    } else {
        // Nothing in band: serve ONE tier, overzoomed — nearest the reference
        // zoom (#qvpunzlw), not coarsest-present (that throws away the finest
        // chart when zooming IN empties the band). See docs/architecture/cell-selection.md.
        let key = |i: usize| {
            (
                (i32::from(cells[i].max_zoom) - i32::from(z)).abs(),
                Reverse(cells[i].max_zoom),
            )
        };
        let nearest = (0..n).map(key).min().expect("n > 0");
        let band: Vec<usize> = (0..n).filter(|&i| key(i) == nearest).collect();
        let (k1, r1) = authority(cells, &band, z, x, y);
        kept = k1;
        redundant = r1;
        rescued = true;
        // Complete coverage from strictly COARSER tiers: needed now that this
        // branch may pick the finest tier present, not always the coarsest —
        // see docs/architecture/cell-selection.md ("whole_tile_rescue and #qvpunzlw").
        let chosen = cells[band[0]].max_zoom;
        let mut coarser: Vec<usize> = (0..n)
            .filter(|&i| cells[i].max_zoom < chosen && cells[i].coverage.is_some())
            .collect();
        coarser.sort_by(|&a, &b| {
            let (ca, cb) = (&cells[a], &cells[b]);
            cb.max_zoom // finest of the coarser first: the least overzoom that fills
                .cmp(&ca.max_zoom)
                .then(ca.scale.cmp(&cb.scale))
                .then(ca.name.cmp(cb.name))
        });
        complete_coverage(cells, &mut kept, coarser, z, x, y);
    }
    // Coverage is now complete: union(kept) == union(charting).

    // Phase 2: equalize detail (the staircase killer). Runs whenever the band
    // has a reference (`!whole_tile_rescue`) — NOT gated on `rescued`, see
    // docs/architecture/cell-selection.md.
    if !whole_tile_rescue {
        let kept_set: std::collections::HashSet<usize> = kept.iter().copied().collect();
        let mut finer: Vec<usize> = (0..n)
            .filter(|&i| {
                let mz = cells[i].max_zoom as i32;
                mz > band_top
                    // pull a detail cell only within its own serving band —
                    // beyond it content is SCAMIN-hidden (the z5 explosion)
                    && mz <= z as i32 + k.overview_detail_cutoff as i32
                    && !kept_set.contains(&i)
                    && cells[i].coverage.is_some()
            })
            .collect();
        // coarsest-finer first, so a pulled tier anchors the next and the pull
        // stops at the first scale that satisfies coverage
        finer.sort_by(|&a, &b| {
            let (ca, cb) = (&cells[a], &cells[b]);
            ca.max_zoom
                .cmp(&cb.max_zoom)
                .then(ca.scale.cmp(&cb.scale))
                .then(ca.name.cmp(cb.name))
        });
        // NO per-tile count cap here — capping by count would drop different
        // cells on adjacent tiles and reopen the seam; `max_cells` below is the
        // real cap. See docs/architecture/cell-selection.md ("Phase 2's anchor").
        for i in finer {
            let fmz = cells[i].max_zoom as i32;
            // Anchor = kept cells within detail_gap of THIS candidate's zoom,
            // not a per-tile reference — see docs/architecture/cell-selection.md.
            // Empty anchor means "charts anything" (true), admitting the coarsest tier first.
            let anchor: Vec<(&C, bool)> = kept
                .iter()
                .filter_map(|&j| {
                    let c = &cells[j];
                    match c.coverage {
                        Some(cov) if c.max_zoom as i32 >= fmz - k.detail_gap as i32 => {
                            Some((cov, cov.is_extent_box()))
                        }
                        _ => None,
                    }
                })
                .collect();
            let anchor = evidence_against(only_a_box(&cells[i]), &anchor);
            let cov = cells[i].coverage.expect("filtered to Some above");
            if cov.residual(&anchor, z, x, y) {
                kept.push(i);
            }
        }
    }

    // Final authority: exact finest-per-region; the rest become donors.
    let (mut kept, red2) = authority(cells, &kept, z, x, y);
    redundant.extend(red2);

    // Tighter cap only for the genuine speck case (no band reference): a tile
    // with an in-band reference keeps the full `max_cells` so Phase 2's
    // legitimately-pulled detail is not trimmed back into a seam.
    let cap = if whole_tile_rescue {
        MAX_RESCUED_CELLS_PER_TILE
    } else {
        k.max_cells
    };
    let mut overflow = None;
    if kept.len() > cap {
        // nearest native zoom first; ties coarsest-first (most likely to
        // cover the tile)
        kept.sort_by(|&a, &b| {
            let (ca, cb) = (&cells[a], &cells[b]);
            let da = (ca.max_zoom as i32 - z as i32).abs();
            let db = (cb.max_zoom as i32 - z as i32).abs();
            da.cmp(&db)
                .then(cb.scale.cmp(&ca.scale))
                .then(ca.name.cmp(cb.name))
        });
        let kept_before_trim = kept.len();
        let dropped_by_cap = kept.split_off(cap);
        overflow = Some(CapOverflow {
            // benign (debug log) only for the speck case; overflowing WITH a
            // band reference drops authoritative chart and must log loud
            rescued: whole_tile_rescue,
            kept_before_trim,
            cap,
            dropped: dropped_by_cap
                .iter()
                .map(|&i| (cells[i].name.to_string(), cells[i].scale))
                .collect(),
        });
        // trimmed cells still hold permissive SCAMIN — keep as donors, ahead
        // of the residual-dropped ones
        let mut new_red = dropped_by_cap;
        new_red.extend(redundant);
        redundant = new_red;
    }

    // merge order (coarse→fine = scale desc), and the donor pool (coarse-first).
    let merge_order = |a: &usize, b: &usize| {
        cells[*b]
            .scale
            .cmp(&cells[*a].scale)
            .then(cells[*a].name.cmp(cells[*b].name))
    };
    kept.sort_by(merge_order);
    redundant.sort_by(merge_order);
    let room = cap.saturating_sub(kept.len());
    let mut donors = kept.clone();
    donors.extend(redundant.into_iter().take(room));

    // Who masks whom: strictly finer kept cells only, subject to the same
    // bare-extent-box rule as `authority` — see `Selection::masks`.
    let masks: Vec<Vec<usize>> = kept
        .iter()
        .map(|&i| {
            let masked_only_a_box = only_a_box(&cells[i]);
            kept.iter()
                .copied()
                .filter(|&j| {
                    cells[j].max_zoom > cells[i].max_zoom
                        && (masked_only_a_box || !only_a_box(&cells[j]))
                })
                .collect()
        })
        .collect();

    // The set claims no-data only where no kept cell charts (= where no charting
    // cell charts, by the union equality) and nothing overzoomed is at risk.
    let claims_nodata = !rescued
        && !kept.iter().any(|&i| {
            matches!(
                cells[i].coverage.map(|c| c.tile_state(z, x, y)),
                Some(TileState::Full)
            )
        });

    Selection {
        kept,
        masks,
        donors,
        rescued,
        claims_nodata,
        overflow,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    /// A token coverage: each tile maps to a set of opaque region tokens. `full`
    /// tiles cover the sentinel `*` (masks anything under them). Mirrors the old
    /// Python `_FakeCoverage`.
    struct Fake {
        full: HashSet<(u8, u32, u32)>,
        regions: HashMap<(u8, u32, u32), HashSet<&'static str>>,
        /// The cell declared nothing but its extent rectangle — see
        /// [`CoverageLike::is_extent_box`]. Off unless a test says otherwise,
        /// so every pre-existing case still reads as a real ring declaration.
        boxed: bool,
    }
    impl Fake {
        fn regions(tile: (u8, u32, u32), toks: &[&'static str]) -> Self {
            Fake {
                full: HashSet::new(),
                regions: HashMap::from([(tile, toks.iter().copied().collect())]),
                boxed: false,
            }
        }
        fn full(tile: (u8, u32, u32)) -> Self {
            Fake {
                full: HashSet::from([tile]),
                regions: HashMap::new(),
                boxed: false,
            }
        }
        /// The same claim, but declared as a bare extent rectangle.
        fn as_box(mut self) -> Self {
            self.boxed = true;
            self
        }
        fn covered(&self, z: u8, x: u32, y: u32) -> HashSet<&'static str> {
            if self.full.contains(&(z, x, y)) {
                return HashSet::from(["*"]);
            }
            self.regions.get(&(z, x, y)).cloned().unwrap_or_default()
        }
    }
    impl CoverageLike for Fake {
        fn tile_state(&self, z: u8, x: u32, y: u32) -> TileState {
            if self.full.contains(&(z, x, y)) {
                TileState::Full
            } else if self.regions.get(&(z, x, y)).is_some_and(|r| !r.is_empty()) {
                TileState::Partial
            } else {
                TileState::Uncovered
            }
        }
        fn residual(&self, finer: &[&Self], z: u8, x: u32, y: u32) -> bool {
            let mine = self.covered(z, x, y);
            let mut cov: HashSet<&str> = HashSet::new();
            for f in finer {
                let fset = f.covered(z, x, y);
                if fset.contains("*") {
                    return false;
                }
                cov.extend(fset);
            }
            if mine.contains("*") {
                return true;
            }
            !mine.is_subset(&cov)
        }
        fn is_extent_box(&self) -> bool {
            self.boxed
        }
    }

    const Z: u8 = 11;
    const X: u32 = 1074;
    const Y: u32 = 628;
    const TILE: (u8, u32, u32) = (Z, X, Y);

    fn knobs() -> Knobs {
        Knobs {
            over_zoom: 4,
            under_zoom: 4,
            detail_gap: 1,
            overview_detail_cutoff: 6,
            max_cells: 48,
        }
    }

    fn desc<'a>(name: &'a str, max_zoom: u8, scale: u32, cov: &'a Fake) -> CellDesc<'a, Fake> {
        CellDesc {
            scale,
            max_zoom,
            name,
            coverage: Some(cov),
        }
    }

    fn names<'a>(sel: &Selection, cells: &[CellDesc<'a, Fake>]) -> HashSet<&'a str> {
        sel.kept.iter().map(|&i| cells[i].name).collect()
    }

    #[test]
    fn reference_scale_removes_the_detail_staircase() {
        // ES (native 15) and SRJE (native 16) chart disjoint adjacent ground;
        // OSRON (native 9) blankets both. At z11 over_zoom=4 the finer SRJE is
        // just out of band — the old gate stranded it and its region fell to
        // OSRON's overview. Phase 2 must pull it.
        let es_c = Fake::regions(TILE, &["es"]);
        let srje_c = Fake::regions(TILE, &["srje"]);
        let osron_c = Fake::regions(TILE, &["es", "srje", "rest"]);
        let cells = [
            desc("ES", 15, 22_000, &es_c),
            desc("SRJE", 16, 14_000, &srje_c),
            desc("OSRON", 9, 1_500_000, &osron_c),
        ];
        let sel = select(&cells, Z, X, Y, &knobs());
        assert!(!sel.rescued);
        assert_eq!(
            names(&sel, &cells),
            HashSet::from(["ES", "SRJE", "OSRON"]),
            "SRJE must be pulled so its region shows 1:14k, not OSRON's overview"
        );

        // detail_gap huge → OSRON counts as adequate → staircase returns.
        let flat = select(
            &cells,
            Z,
            X,
            Y,
            &Knobs {
                detail_gap: 99,
                ..knobs()
            },
        );
        assert!(!names(&flat, &cells).contains("SRJE"));
    }

    #[test]
    fn detail_fill_is_not_count_capped_so_neighbours_agree() {
        // The tile-edge seam: a tile with MANY finer cells, each charting distinct
        // ground, must keep ALL of them — not a fixed subset. A per-tile count cap
        // drops authoritative detail by sort order, and an adjacent tile with a
        // different count drops DIFFERENT cells, so the same water is fine on one
        // side of the edge and coarse on the other. z10 → band_top 14; the harbour
        // cells (native 15) are out of band, pulled by Phase 2. A FULL coarse cell
        // (native 12) blankets the tile so none are added in Phase 1 completion.
        let full_c = Fake::full((10, 100, 100));
        let hs: Vec<Fake> = (0..6)
            .map(|i| {
                let tok: &'static str = Box::leak(format!("h{i}").into_boxed_str());
                Fake::regions((10, 100, 100), &[tok])
            })
            .collect();
        let hn: Vec<String> = (0..6).map(|i| format!("H{i}")).collect();
        let mut cells = vec![desc("COARSE", 12, 180_000, &full_c)];
        for (i, cov) in hs.iter().enumerate() {
            cells.push(CellDesc {
                scale: 22_000,
                max_zoom: 15,
                name: &hn[i],
                coverage: Some(cov),
            });
        }
        let sel = select(&cells, 10, 100, 100, &knobs());
        let kept = names(&sel, &cells);
        for name in &hn {
            assert!(
                kept.contains(name.as_str()),
                "{name} charts distinct ground and must be kept — a count cap would \
                 drop it and seam the neighbour that keeps a different subset"
            );
        }
    }

    /// Zooming IN must never hand back a COARSER chart (#qvpunzlw). Past the
    /// `under_zoom` edge of the finest cell that exists here, the primary band
    /// empties and one tier is served overzoomed; that tier has to be the one
    /// NEAREST the zoom, not the coarsest present, or the step from "in band"
    /// to "out of band" swaps the 1:180k cell for the 1:1.5M general chart.
    ///
    /// Measured on the real DE/NL/DK union at 4.5E 53.5N with the boat's own
    /// knobs (`under_zoom = 2`): z14 served DE2NO000 (max_zoom 12) and z15 —
    /// one zoom further in — served DE1NO000 (max_zoom 9). Across a 50-point
    /// grid over the same union, 11 points had such a step; after the fix, none.
    #[test]
    fn zooming_in_past_the_band_keeps_the_finest_chart_not_the_coarsest() {
        // full at both zooms under test, so only the band rule differs
        let both = |_: ()| Fake {
            full: HashSet::from([(13, X, Y), (15, X, Y)]),
            regions: HashMap::new(),
            boxed: false,
        };
        let (fine_c, coarse_c) = (both(()), both(()));
        let cells = [
            desc("FINE", 12, 180_000, &fine_c),
            desc("COARSE", 9, 1_500_000, &coarse_c),
        ];
        // under_zoom 2: at z13 the band is [11, 17] and FINE is in it; at z15
        // the band is [13, 21] and NOTHING is, so the whole-tile rescue decides.
        let k = Knobs {
            under_zoom: 2,
            ..knobs()
        };
        assert_eq!(
            names(&select(&cells, 13, X, Y, &k), &cells),
            HashSet::from(["FINE"]),
            "in band: the finer cell authors"
        );
        let out = select(&cells, 15, X, Y, &k);
        assert_eq!(
            names(&out, &cells),
            HashSet::from(["FINE"]),
            "out of band by zooming IN: still the finer cell, overzoomed"
        );
        assert!(out.rescued, "it is overzoomed beyond the band");
    }

    /// …and it must not open a hole doing it. The tier nearest `z` past the
    /// band's coarse edge is the FINEST present — the one most likely to stop at
    /// a cell boundary — so the whole-tile-rescue branch now completes coverage
    /// from strictly coarser tiers, which it never had to when it always chose
    /// the blanket overview. Without it this tile keeps FINE alone, paints
    /// nothing east of it, and (being `rescued`, so not claiming no-data) serves
    /// that half as unpainted basemap — ymwnqnmr's failure class by another
    /// route.
    #[test]
    fn zooming_in_past_the_band_still_completes_coverage() {
        let tile = (15, X, Y);
        let fine_c = Fake::regions(tile, &["west"]);
        let coarse_c = Fake::regions(tile, &["west", "east"]);
        let cells = [
            desc("FINE", 12, 180_000, &fine_c),
            desc("COARSE", 9, 1_500_000, &coarse_c),
        ];
        let k = Knobs {
            under_zoom: 2,
            ..knobs()
        };
        assert_eq!(
            names(&select(&cells, 15, X, Y, &k), &cells),
            HashSet::from(["FINE", "COARSE"]),
            "COARSE fills the ground FINE does not chart"
        );
    }

    /// The other reason the band empties — every cell too FINE — still wants the
    /// COARSEST tier, and nearest-to-`z` gives it unchanged: at a true overview
    /// zoom every candidate sits above `z`, so the smallest `|max_zoom − z|` is
    /// the coarsest one. This is the low-zoom rescue / coarsest-cell exemption
    /// the branch has always implemented, pinned so the #qvpunzlw fix cannot
    /// quietly invert it.
    #[test]
    fn a_true_overview_zoom_still_serves_the_coarsest_tier() {
        let overview_c = Fake::full((2, 1, 1));
        let coastal_c = Fake::full((2, 1, 1));
        let harbour_c = Fake::full((2, 1, 1));
        let cells = [
            desc("OVERVIEW", 9, 1_500_000, &overview_c),
            desc("COASTAL", 12, 180_000, &coastal_c),
            desc("HARBOUR", 16, 12_000, &harbour_c),
        ];
        let sel = select(&cells, 2, 1, 1, &knobs());
        assert_eq!(names(&sel, &cells), HashSet::from(["OVERVIEW"]));
        assert!(sel.rescued);
        // and the new completion pass is a no-op here: the chosen tier IS the
        // coarsest, so it has no strictly-coarser candidate to pull, which is
        // what keeps this branch clear of the z5 cell explosion.
        assert_eq!(sel.kept.len(), 1);
    }

    #[test]
    fn detail_fill_survives_a_coverage_completion_rescue() {
        // The per-tile seam bug: with a narrow under_zoom the coarse overview
        // (OSRON) is out of band, so a tile that needs it to complete coverage
        // (a "corner" only OSRON charts) marks `rescued` — and the old code gated
        // Phase 2 on `!rescued`, so the detail pass was skipped and FINE's ground
        // ("a", in-band covered only by OSRON's overview) collapsed to 1:1.5M. A
        // neighbouring tile WITHOUT that corner kept `rescued=false`, ran Phase 2
        // and showed FINE — the two tiles disagreeing at their shared edge.
        //
        // Phase 2 now runs whenever the band has a reference, so FINE is pulled
        // here too: the tile is `rescued` (OSRON overzoomed for the corner) AND
        // fully detailed. z11, under_zoom 1 → OSRON (native 9) is out of band.
        let mid_c = Fake::regions(TILE, &["b"]);
        let fine_c = Fake::regions(TILE, &["a"]);
        let osron_c = Fake::regions(TILE, &["a", "b", "corner"]);
        let cells = [
            desc("MID", 13, 90_000, &mid_c),
            desc("FINE", 16, 14_000, &fine_c),
            desc("OSRON", 9, 1_500_000, &osron_c),
        ];
        let k = Knobs {
            under_zoom: 1,
            ..knobs()
        };
        let sel = select(&cells, Z, X, Y, &k);
        assert!(sel.rescued, "OSRON is overzoomed to chart the corner");
        assert!(
            names(&sel, &cells).contains("FINE"),
            "the detail pass must still pull FINE even though the tile was rescued \
             — else its region collapses to OSRON's overview and seams the neighbour"
        );
        assert_eq!(names(&sel, &cells), HashSet::from(["MID", "FINE", "OSRON"]));
    }

    #[test]
    fn coarser_cell_completes_coverage_beyond_the_under_zoom_bound() {
        // At z14 OSRON (native 9) is past under_zoom 4, but it charts a corner
        // nothing else does → coverage completion must re-add it (as a rescue).
        let fine_c = Fake::regions((14, 100, 100), &["most"]);
        let osron_c = Fake::regions((14, 100, 100), &["most", "corner"]);
        let cells = [
            desc("FINE", 13, 90_000, &fine_c),
            desc("OSRON", 9, 1_500_000, &osron_c),
        ];
        let sel = select(&cells, 14, 100, 100, &knobs());
        assert_eq!(names(&sel, &cells), HashSet::from(["FINE", "OSRON"]));
        assert!(sel.rescued);
    }

    #[test]
    fn a_finer_full_cell_silences_all_coarser() {
        let fine_c = Fake::full(TILE);
        let coarse_c = Fake::regions(TILE, &["a"]);
        let cells = [
            desc("FINE", 15, 22_000, &fine_c),
            desc("COARSE", 12, 180_000, &coarse_c),
        ];
        let sel = select(&cells, Z, X, Y, &knobs());
        assert_eq!(names(&sel, &cells), HashSet::from(["FINE"]));
        // the silenced coarse cell survives as a SCAMIN donor
        assert!(sel.donors.len() >= 2);
        assert!(!sel.claims_nodata, "a full cell blankets the tile");
    }

    #[test]
    fn rescue_takes_only_the_nearest_tier_capped() {
        // z8: a 1:90k coastal (native 13) and 20 harbour plans (native 16), all
        // out of band, all too FINE — so the tier nearest z IS the coarsest one
        // and the rescue takes the coastal only (#qvpunzlw kept this arm as it
        // was; the arm it changed is the one where every cell is too COARSE).
        let coastal_c = Fake::regions((8, 137, 80), &["c"]);
        // each plan charts its own ground (distinct token) → all authoritative,
        // so the rescue cap — not mutual masking — is what bounds them
        let plan_covs: Vec<Fake> = (0..20)
            .map(|i| {
                let tok: &'static str = Box::leak(format!("p{i}").into_boxed_str());
                Fake::regions((8, 137, 80), &[tok])
            })
            .collect();
        let mut cells = vec![desc("coastal", 13, 90_000, &coastal_c)];
        let plan_names: Vec<String> = (0..20).map(|i| format!("plan{i:02}")).collect();
        for (i, cov) in plan_covs.iter().enumerate() {
            cells.push(CellDesc {
                scale: 4_000,
                max_zoom: 16,
                name: &plan_names[i],
                coverage: Some(cov),
            });
        }
        let sel = select(&cells, 8, 137, 80, &knobs());
        assert_eq!(
            sel.kept.iter().map(|&i| cells[i].name).collect::<Vec<_>>(),
            vec!["coastal"]
        );
        assert!(sel.rescued);

        // only the plans → the tighter rescue cap holds.
        let only_plans: Vec<CellDesc<Fake>> = cells[1..].to_vec();
        let sel2 = select(&only_plans, 8, 137, 80, &knobs());
        assert_eq!(sel2.kept.len(), MAX_RESCUED_CELLS_PER_TILE);
    }

    #[test]
    fn all_in_band_cells_with_distinct_ground_are_kept_uncapped() {
        // 20 same-band cells each charting distinct ground → all authoritative;
        // the default cap keeps them all, a lower cap thins to exactly it.
        let covs: Vec<Fake> = (0..20)
            .map(|i| {
                let tok: &'static str = Box::leak(format!("r{i}").into_boxed_str());
                Fake::regions((9, 100, 100), &[tok])
            })
            .collect();
        let cn: Vec<String> = (0..20).map(|i| format!("C{i:02}")).collect();
        let cells: Vec<CellDesc<Fake>> = (0..20)
            .map(|i| CellDesc {
                scale: 90_000,
                max_zoom: 13,
                name: &cn[i],
                coverage: Some(&covs[i]),
            })
            .collect();
        assert_eq!(select(&cells, 9, 100, 100, &knobs()).kept.len(), 20);
        assert_eq!(
            select(
                &cells,
                9,
                100,
                100,
                &Knobs {
                    max_cells: 8,
                    ..knobs()
                }
            )
            .kept
            .len(),
            8
        );
    }

    #[test]
    fn coverage_none_cell_follows_the_fineness_bound_only() {
        // A coverage-None general cell (native 9) is kept at z16 (under fine),
        // where the under_zoom bound would otherwise drop it — it can't be
        // re-added by residual, so it must never fall out for being coarse.
        let harb_c = Fake::regions((16, 1, 1), &["h"]);
        let cells = [
            CellDesc {
                scale: 1_500_000,
                max_zoom: 9,
                name: "GEN",
                coverage: None,
            },
            desc("HARB", 16, 4_000, &harb_c),
        ];
        assert_eq!(
            names(&select(&cells, 16, 1, 1, &knobs()), &cells),
            HashSet::from(["GEN", "HARB"])
        );
        // and a coverage-None cell finer than the reach is not served (old gate).
        let cells2: [CellDesc<Fake>; 1] = [CellDesc {
            scale: 4_000,
            max_zoom: 16,
            name: "HARBNONE",
            coverage: None,
        }];
        // z10: 16 > 10+4 → out of band, in_band empty → whole-tile rescue keeps it
        assert_eq!(select(&cells2, 10, 1, 1, &knobs()).kept.len(), 1);
    }

    #[test]
    fn overview_detail_cutoff_bounds_the_z5_explosion() {
        // #Z5-FRAG: at overview zoom a single coarse cell blankets the tile, but
        // ~120 fine harbour plans (max_zoom 16, ~11 levels above z5's band_top)
        // each chart distinct ground. Phase 2's detail-equalization pulled EVERY
        // one — their content is SCAMIN-hidden at z5, so decoding them is wasted
        // Pi CPU and it blows past max_cells, reopening holes. The upper bound
        // (`overview_detail_cutoff`) must exclude them: with the default the
        // tile keeps only the coarse overview; with the cutoff disabled it
        // reproduces the ~121-cell blow-up.
        const N: usize = 120;
        let z: u8 = 5;
        let (tx, ty) = (16u32, 10u32);
        let tile = (z, tx, ty);
        let coarse_c = Fake::full(tile);
        let harb_covs: Vec<Fake> = (0..N)
            .map(|i| {
                let tok: &'static str = Box::leak(format!("harb{i}").into_boxed_str());
                Fake::regions(tile, &[tok])
            })
            .collect();
        let harb_names: Vec<String> = (0..N).map(|i| format!("HARB{i:03}")).collect();
        let mut cells = vec![desc("COARSE", 8, 700_000, &coarse_c)];
        for (i, cov) in harb_covs.iter().enumerate() {
            cells.push(CellDesc {
                scale: 4_000,
                max_zoom: 16,
                name: &harb_names[i],
                coverage: Some(cov),
            });
        }

        // Default cutoff (6): band_top = z+over_zoom = 9; harbours (max_zoom 16)
        // exceed z+cutoff = 11, so Phase 2 excludes them. Only the coarse
        // overview survives — no hole, its full coverage already blankets the
        // tile and the harbour content is SCAMIN-hidden at z5 anyway.
        let sel = select(&cells, z, tx, ty, &knobs());
        assert_eq!(
            names(&sel, &cells),
            HashSet::from(["COARSE"]),
            "the default cutoff must exclude the 11-levels-finer harbour plans"
        );

        // Cutoff disabled (99) + a cap high enough to expose the raw count:
        // every harbour charts distinct ground so Phase 2 pulls all N, plus the
        // coarse cell (full → residual against the finer harbours) = N + 1.
        let disabled = select(
            &cells,
            z,
            tx,
            ty,
            &Knobs {
                overview_detail_cutoff: 99,
                max_cells: 999,
                ..knobs()
            },
        );
        assert_eq!(
            disabled.kept.len(),
            N + 1,
            "with the cutoff disabled the z5 explosion returns (~121 cells)"
        );
    }

    /// #ymwnqnmr, union tile 8/137/81 (Baltic): a freenauticalchart German
    /// 1:90k cell declares one extent RECTANGLE and charts only the German
    /// side of the DE/DK boundary; the o-charts Danish 1:180k cell beside it
    /// declares an 802-point ring and charts the Danish side. Strictly finer,
    /// the box both silenced and masked the ring cell, and the water it charts
    /// went unpainted.
    ///
    /// `Fake::full(..).as_box()` is that claim in its strongest form: it
    /// blankets the tile (so `residual` short-circuits) *and* declares nothing
    /// but a box. The ring cell must survive it, kept AND unmasked.
    #[test]
    fn a_bare_extent_box_neither_silences_nor_masks_a_ring_cell() {
        let boxy = Fake::full(TILE).as_box();
        let ring = Fake::regions(TILE, &["dk"]);
        let cells = [
            desc("RING_COARSE", 12, 180_000, &ring),
            desc("BOX_FINE", 13, 90_000, &boxy),
        ];
        let sel = select(&cells, Z, X, Y, &knobs());
        assert!(
            names(&sel, &cells).contains("RING_COARSE"),
            "a claim that is only a bounding box may not silence the cell that \
             declared where it actually charts"
        );
        let pos = sel
            .kept
            .iter()
            .position(|&i| cells[i].name == "RING_COARSE")
            .expect("kept above");
        assert!(
            sel.masks[pos].is_empty(),
            "...and may not mask it either, or the hole just moves from \
             selection into the cut: masked by {:?}",
            sel.masks[pos]
                .iter()
                .map(|&j| cells[j].name)
                .collect::<Vec<_>>()
        );
    }

    /// The other half of the rule, and the one that keeps [`super::mask`]'s
    /// reason for existing: a producer that declares only rectangles (all 314
    /// freenauticalchart German cells do) still has a scale ladder, and its
    /// finer cell still supersedes its coarser one over the same box. Without
    /// this, one 1:180k overview would draw its contours under four 1:90k
    /// cells — the doubling the mask module exists to remove.
    #[test]
    fn a_bare_extent_box_still_masks_another_bare_extent_box() {
        let fine = Fake::full(TILE).as_box();
        let coarse = Fake::regions(TILE, &["a"]).as_box();
        let cells = [
            desc("BOX_COARSE", 12, 180_000, &coarse),
            desc("BOX_FINE", 13, 90_000, &fine),
        ];
        let sel = select(&cells, Z, X, Y, &knobs());
        // silenced outright by the blanketing finer box — unchanged behaviour
        assert_eq!(names(&sel, &cells), HashSet::from(["BOX_FINE"]));

        // and where it does survive, it is still masked
        let coarse = Fake::regions(TILE, &["a", "elsewhere"]).as_box();
        let fine = Fake::regions(TILE, &["a"]).as_box();
        let cells = [
            desc("BOX_COARSE", 12, 180_000, &coarse),
            desc("BOX_FINE", 13, 90_000, &fine),
        ];
        let sel = select(&cells, Z, X, Y, &knobs());
        let pos = sel
            .kept
            .iter()
            .position(|&i| cells[i].name == "BOX_COARSE")
            .expect("it charts ground the finer box does not");
        assert_eq!(
            sel.masks[pos]
                .iter()
                .map(|&j| cells[j].name)
                .collect::<Vec<_>>(),
            vec!["BOX_FINE"],
            "box-against-box masking is load-bearing and must not change"
        );
    }

    /// A ring cell masking a box cell is untouched: the informative claim is
    /// the one that gets to delete chart, in whichever direction it points.
    #[test]
    fn a_ring_cell_still_masks_a_bare_extent_box() {
        let coarse = Fake::regions(TILE, &["a", "elsewhere"]).as_box();
        let fine = Fake::regions(TILE, &["a"]);
        let cells = [
            desc("BOX_COARSE", 12, 180_000, &coarse),
            desc("RING_FINE", 13, 90_000, &fine),
        ];
        let sel = select(&cells, Z, X, Y, &knobs());
        let pos = sel
            .kept
            .iter()
            .position(|&i| cells[i].name == "BOX_COARSE")
            .expect("kept: it charts ground the finer cell does not");
        assert_eq!(
            sel.masks[pos]
                .iter()
                .map(|&j| cells[j].name)
                .collect::<Vec<_>>(),
            vec!["RING_FINE"]
        );
    }

    #[test]
    fn an_equally_detailed_cell_never_silences_its_peers() {
        // #vzvprkqo, union tile 7/66/40 (German Bight): the freenautical German
        // 1:180k overview declares its coverage as one extent rectangle over the
        // whole tile while its geometry stops at the DE/DK boundary. It shares
        // `max_zoom` with the three o-charts 1:180k cells that DO chart the
        // Danish half, and — sorting first on the old `name asc` tiebreak — it
        // swallowed all three, leaving an unpainted diagonal slice.
        //
        // `Fake::full` is that over-claim in its strongest form (it covers the
        // sentinel `*`, so `residual` short-circuits to false for anything under
        // it). The peers must survive it, and — the point of the second run —
        // the answer must not depend on which name sorts first. A fix that
        // merely flipped the tiebreak would pass the first assertion and fail
        // the second.
        let over_claim = Fake::full(TILE);
        let dk: Vec<Fake> = (0..3)
            .map(|i| {
                let tok: &'static str = Box::leak(format!("dk{i}").into_boxed_str());
                Fake::regions(TILE, &[tok])
            })
            .collect();
        for over_name in ["A_OVERCLAIM", "Z_OVERCLAIM"] {
            let peer_names = ["PEER0", "PEER1", "PEER2"];
            let mut cells = vec![desc(over_name, 12, 180_000, &over_claim)];
            for (i, cov) in dk.iter().enumerate() {
                cells.push(desc(peer_names[i], 12, 180_000, cov));
            }
            let kept = names(&select(&cells, Z, X, Y, &knobs()), &cells);
            let mut expected: HashSet<&str> = peer_names.into_iter().collect();
            expected.insert(over_name);
            assert_eq!(
                kept,
                expected,
                "with {over_name} sorting {}, every same-max_zoom peer must be \
                 kept — none of them is finer than any other",
                if over_name.starts_with('A') {
                    "first"
                } else {
                    "last"
                }
            );
        }

        // The rule is about EQUAL detail only: a strictly finer full cell still
        // silences a coarser one (`a_finer_full_cell_silences_all_coarser`), and
        // so does a finer one inside the same tier's scale band.
        let coarse = Fake::regions(TILE, &["c"]);
        let cells = [
            desc("FINE_FULL", 15, 22_000, &over_claim),
            desc("COARSE", 12, 180_000, &coarse),
        ];
        assert_eq!(
            names(&select(&cells, Z, X, Y, &knobs()), &cells),
            HashSet::from(["FINE_FULL"])
        );
    }

    #[test]
    fn masks_carry_only_strictly_finer_cells() {
        // The second half of the equal-detail rule (#vzvprkqo): keeping the
        // peers is not enough if they may still MASK each other, because both
        // sides of the 7/66/40 seam over-claim coverage — restoring the o-charts
        // cells while letting them mask simply moved the hole onto the German
        // cell's geometry instead. `masks[i]` must therefore exclude every
        // same-`max_zoom` peer and keep every strictly finer kept cell.
        let a_c = Fake::regions(TILE, &["a"]);
        let b_c = Fake::regions(TILE, &["b"]);
        let fine_c = Fake::regions(TILE, &["f"]);
        let cells = [
            desc("PEER_A", 12, 180_000, &a_c),
            desc("PEER_B", 12, 180_000, &b_c),
            desc("FINE", 15, 22_000, &fine_c),
        ];
        let sel = select(&cells, Z, X, Y, &knobs());
        assert_eq!(sel.kept.len(), 3, "all three chart distinct ground");
        assert_eq!(sel.masks.len(), sel.kept.len(), "parallel to `kept`");
        for (pos, &i) in sel.kept.iter().enumerate() {
            for &j in &sel.masks[pos] {
                assert!(
                    cells[j].max_zoom > cells[i].max_zoom,
                    "{} must not be masked by the no-finer {}",
                    cells[i].name,
                    cells[j].name
                );
            }
        }
        // and the strictly finer cell is not merely omitted from everyone.
        for (pos, &i) in sel.kept.iter().enumerate() {
            if cells[i].max_zoom == 12 {
                assert_eq!(
                    sel.masks[pos]
                        .iter()
                        .map(|&j| cells[j].name)
                        .collect::<Vec<_>>(),
                    vec!["FINE"],
                    "a 1:180k peer is still masked by the 1:22k cell over it"
                );
            }
        }
    }

    #[test]
    fn empty_charting_claims_nodata() {
        let cells: [CellDesc<Fake>; 0] = [];
        let sel = select(&cells, Z, X, Y, &knobs());
        assert!(sel.kept.is_empty());
        assert!(sel.claims_nodata);
    }
}
