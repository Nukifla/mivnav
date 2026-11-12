// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! §14's landmark / lower-bound tables — the ALT (A\*, Landmarks,
//! Triangle-inequality) precompute that lets a query state *how close to
//! optimal* a returned route is.
//!
//! # What this is
//!
//! For each band, a small set of **anchor** tiles is chosen by
//! farthest-point (greedy k-center) sampling over the band's topology
//! graph, and the shortest-path distance from every anchor to every graph
//! node is stored. At query time the triangle inequality turns those
//! stored distances into a lower bound on the **topology-graph** cost of
//! any route between two tiles:
//!
//! ```text
//! lower_bound(s, g) = max over anchors a of | D'(a, s) − D'(a, g) |
//! ```
//!
//! # What this bounds — and what it does NOT
//!
//! `D'` is shortest-path distance in the band's portal graph under the
//! **reduced edge weight** `w'(p) = Portal::lower_bound_cost_mm` =
//! `heuristic_mm(centre_distance_m, MIN_MULTIPLIER)`, the identical
//! admissible per-portal lower bound [`super::shortcuts::Shortcut::
//! lower_bound_mm`] and [`super::portals::Portal::lower_bound_cost_mm`]
//! already document. `w' ≤ w` pointwise (a real portal step floors its
//! multiplier at `MIN_MULTIPLIER` and only adds non-negative §11
//! penalties), so `D'(s,g) ≤ D_topology(s,g)` — the cost
//! [`super::query::topology_route`] would return.
//!
//! It is a bound on that **tile-centre-to-tile-centre topology cost, not
//! on the fine grid route's cost.** The fine search cuts corners the
//! centre-to-centre graph cannot (a diagonal passage costs it ~√2× the
//! Euclidean length), so the topology cost can exceed the fine route
//! cost, and a bound on the former is not a bound on the latter. Phase
//! 8's [`super::query::RouteResult::best_known_lower_bound_mm`] therefore
//! uses the straight-line great-circle bound
//! ([`super::query::straight_line_lower_bound_mm`]) against the fine
//! route, and keeps THIS bound for the topology layer's own diagnostics
//! (`MivnavRoute::topology_lower_bound_mm`) and for the deferred
//! landmark-tightened A\* heuristic below.
//!
//! # Symmetry — the triangle-inequality step
//!
//! [`super::portals::detect_portals`] emits one seam as a bidirectional
//! pair of `Portal` records (its own documented convention, reused by
//! [`super::shortcuts`]), and `centre_distance_m` is symmetric (pinned by
//! its own test), so the reverse portal carries the identical `w'`. `D'`
//! is therefore a symmetric graph metric and `|D'(a,s) − D'(a,g)| ≤
//! D'(s,g)`. That is an invariant of `detect_portals`, not of this
//! module; if it ever stops holding, the directed-safe form
//! `max(0, D'(a,g) − D'(a,s))` stays valid but loses half its anchors'
//! reach. `mivnav_landmarks_de6ostim.rs` guards the pairing on real chart
//! data, and every `lower_bound_mm ≤ topology_route cost` assertion there
//! is a second, end-to-end check on the whole claim.
//!
//! The bound is otherwise **vessel-independent** (§6): the table is built
//! once at `required_draft_dm = 0` over the whole band graph. A deeper
//! draft only removes portals, which can only *raise* the real cost, so
//! the bound stays admissible for every draft — the same one-directional
//! slack `select_band` already accepts.
//!
//! # Not wired into the search heuristic (yet)
//!
//! [`super::query`]'s A\* still uses the straight-line
//! `heuristic_mm(centre_distance_m(tile, goal), MIN_MULTIPLIER)`. Raising
//! it to `max(straight_line, lower_bound_mm(tile, goal))` would be
//! admissible and would cut node expansions, but it also reorders the
//! open set and can perturb a route among equal-cost paths — a
//! determinism-sensitive change to safety-critical routing that deserves
//! its own commit with the `route(A,B) == route(B,A)` / byte-identical
//! assertions re-run. Left as the natural next optimisation now that the
//! tables exist.

use std::cmp::Reverse;
use std::collections::BinaryHeap;

use super::build::BuiltRegion;
use super::format::{BandTag, BAND_TAG_LEN};
use super::portals::Portal;

/// How many anchors per band. Small and fixed: the portal graph is
/// portal-scale (§8.4), farthest-point sampling covers it well with a
/// handful of anchors, and every anchor costs one stored `i64` per graph
/// node in the `.mivnav`. Capped at the node count on a tiny band.
pub const LANDMARK_ANCHORS: usize = 8;

/// One band's ALT table: the topology-graph nodes, the chosen anchors,
/// and the anchor→node reduced-weight distance matrix.
///
/// Empty (`node_tiles.is_empty()`) for a band whose portal set is empty —
/// a single-tile region, or a band nothing is navigable at. A caller then
/// gets `lower_bound_mm == 0` and falls back to the straight-line bound.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BandLandmarks {
    /// Sorted ascending, deduplicated. Every tile that is an endpoint of
    /// at least one portal in this band — the topology graph's node set.
    /// A tile absent here is isolated at this band and no route runs
    /// through it. This is the binary-search key for [`Self::
    /// lower_bound_mm`].
    pub node_tiles: Vec<u32>,
    /// The chosen anchor tiles, in selection order (the farthest-point
    /// seed first). A subset of [`Self::node_tiles`];
    /// `len() == min(LANDMARK_ANCHORS, node_tiles.len())` on a connected
    /// band, fewer only when the graph runs out of reachable un-chosen
    /// nodes before `LANDMARK_ANCHORS` are picked.
    pub anchors: Vec<u32>,
    /// Row-major, anchor-major: `dist_mm[a * node_tiles.len() + i]` is the
    /// reduced-weight shortest-path cost from `anchors[a]` to
    /// `node_tiles[i]` in millimetre fixed-point, or [`i64::MAX`] when the
    /// anchor cannot reach that node.
    pub dist_mm: Vec<i64>,
}

impl BandLandmarks {
    /// No anchors / no graph — every `lower_bound_mm` is `0`.
    pub fn is_empty(&self) -> bool {
        self.node_tiles.is_empty() || self.anchors.is_empty()
    }

    /// An admissible lower bound, in millimetre fixed-point, on the
    /// **topology-graph** route cost ([`super::query::topology_route`]'s
    /// own `cost_mm`) from `start_tile` to `goal_tile` at this band — the
    /// ALT differential `max_a |D'(a,s) − D'(a,g)|`.
    ///
    /// This bounds the tile-centre-to-tile-centre topology cost, **not**
    /// the fine grid route cost — see the module docs. `0` when either
    /// tile is not a graph node, when the two are equal, or when no anchor
    /// reaches both. Never negative.
    pub fn lower_bound_mm(&self, start_tile: u32, goal_tile: u32) -> i64 {
        if start_tile == goal_tile || self.is_empty() {
            return 0;
        }
        let n = self.node_tiles.len();
        let (Ok(si), Ok(gi)) = (
            self.node_tiles.binary_search(&start_tile),
            self.node_tiles.binary_search(&goal_tile),
        ) else {
            return 0;
        };
        let mut gap = 0i64;
        for a in 0..self.anchors.len() {
            let ds = self.dist_mm[a * n + si];
            let dg = self.dist_mm[a * n + gi];
            if ds == i64::MAX || dg == i64::MAX {
                continue;
            }
            gap = gap.max((dg - ds).abs());
        }
        gap
    }
}

/// Build one band's [`BandLandmarks`] from its already-detected portals.
///
/// `portals` is [`super::portals::detect_portals`]'s output for this band
/// — a bidirectional edge set — and nothing else about the band is
/// needed: the anchors are graph nodes and the distances are graph
/// distances. Deterministic: the seed is the lowest tile id, every
/// Dijkstra breaks ties by node position (ascending tile id), and the
/// farthest-point pick breaks ties the same way.
pub fn build_band_landmarks(built: &BuiltRegion, portals: &[Portal]) -> BandLandmarks {
    let _ = built; // reserved: a future revision may weight anchors by tile size
    let mut node_tiles: Vec<u32> = Vec::with_capacity(portals.len() * 2);
    for p in portals {
        node_tiles.push(p.tile);
        node_tiles.push(p.neighbour_tile);
    }
    node_tiles.sort_unstable();
    node_tiles.dedup();
    if node_tiles.is_empty() {
        return BandLandmarks::default();
    }
    let n = node_tiles.len();
    let pos = |tile: u32| node_tiles.binary_search(&tile).ok();

    // Adjacency by node position: (neighbour position, reduced weight).
    let mut adj: Vec<Vec<(usize, i64)>> = vec![Vec::new(); n];
    for p in portals {
        if let (Some(u), Some(v)) = (pos(p.tile), pos(p.neighbour_tile)) {
            adj[u].push((v, p.lower_bound_cost_mm.max(0)));
        }
    }

    let k = LANDMARK_ANCHORS.min(n);
    let mut anchor_pos: Vec<usize> = Vec::with_capacity(k);
    let mut rows: Vec<Vec<i64>> = Vec::with_capacity(k);
    let mut mindist: Vec<i64> = vec![i64::MAX; n];

    let mut next = 0usize; // node_tiles[0] — the lowest tile id
    for _ in 0..k {
        let row = dijkstra_from(next, &adj, n);
        for (i, &d) in row.iter().enumerate() {
            if d != i64::MAX {
                mindist[i] = mindist[i].min(d);
            }
        }
        anchor_pos.push(next);
        rows.push(row);

        // Farthest reachable node not already an anchor; ties → lowest
        // position (= lowest tile id, node_tiles is sorted).
        let mut best_pos: Option<usize> = None;
        let mut best_d = -1i64;
        for (i, &d) in mindist.iter().enumerate() {
            if d == i64::MAX || anchor_pos.contains(&i) {
                continue;
            }
            if d > best_d {
                best_d = d;
                best_pos = Some(i);
            }
        }
        match best_pos {
            Some(p) => next = p,
            None => break, // graph exhausted before k anchors
        }
    }

    let anchors: Vec<u32> = anchor_pos.iter().map(|&i| node_tiles[i]).collect();
    let mut dist_mm = Vec::with_capacity(anchors.len() * n);
    for row in &rows {
        dist_mm.extend_from_slice(row);
    }
    BandLandmarks {
        node_tiles,
        anchors,
        dist_mm,
    }
}

/// Plain Dijkstra from node position `src` over `adj`, returning a
/// distance per node ([`i64::MAX`] = unreachable). Ties in the frontier
/// break by node position so the result is a pure function of the graph.
fn dijkstra_from(src: usize, adj: &[Vec<(usize, i64)>], n: usize) -> Vec<i64> {
    let mut dist = vec![i64::MAX; n];
    dist[src] = 0;
    let mut heap: BinaryHeap<Reverse<(i64, usize)>> = BinaryHeap::new();
    heap.push(Reverse((0, src)));
    while let Some(Reverse((d, u))) = heap.pop() {
        if d != dist[u] {
            continue; // stale entry
        }
        for &(v, w) in &adj[u] {
            let nd = d.saturating_add(w);
            if nd < dist[v] {
                dist[v] = nd;
                heap.push(Reverse((nd, v)));
            }
        }
    }
    dist
}

const LANDMARKS_HEADER_LEN: usize = BAND_TAG_LEN + 8; // tag + n_nodes:u32 + n_anchors:u32

/// Serialize one band's table as a [`super::format::SectionKind::
/// Landmarks`] payload:
///
/// ```text
///   0   8  BandTag
///   8   4  n_nodes    u32
///  12   4  n_anchors  u32
///  16  4·n_nodes      node_tiles   u32, ascending
///   .   4·n_anchors   anchors      u32, each one of node_tiles
///   .   8·n_anchors·n_nodes  dist_mm  i64, row-major anchor-major
/// ```
pub fn encode_landmarks(tag: BandTag, l: &BandLandmarks) -> Vec<u8> {
    let n = l.node_tiles.len();
    let a = l.anchors.len();
    debug_assert_eq!(
        l.dist_mm.len(),
        a * n,
        "dist_mm is not an n_anchors × n_nodes matrix"
    );
    let mut out = Vec::with_capacity(LANDMARKS_HEADER_LEN + n * 4 + a * 4 + a * n * 8);
    out.extend_from_slice(&tag.to_bytes());
    out.extend_from_slice(&(n as u32).to_le_bytes());
    out.extend_from_slice(&(a as u32).to_le_bytes());
    for &t in &l.node_tiles {
        out.extend_from_slice(&t.to_le_bytes());
    }
    for &t in &l.anchors {
        out.extend_from_slice(&t.to_le_bytes());
    }
    for &d in &l.dist_mm {
        out.extend_from_slice(&d.to_le_bytes());
    }
    out
}

/// Parse a [`super::format::SectionKind::Landmarks`] payload. `None` on a
/// short header, a length that does not match the declared dimensions,
/// `node_tiles` that is not strictly ascending, or an anchor that is not
/// one of the nodes — every structural guarantee [`lower_bound_mm`] then
/// relies on without re-checking.
///
/// The [`BandTag`] prefix is not returned; [`super::persist::load_band`]
/// matches it against the band it asked for via `band_sections`.
///
/// [`lower_bound_mm`]: BandLandmarks::lower_bound_mm
pub fn decode_landmarks(bytes: &[u8]) -> Option<BandLandmarks> {
    let hdr = bytes.get(..LANDMARKS_HEADER_LEN)?;
    let n = u32::from_le_bytes(hdr[BAND_TAG_LEN..BAND_TAG_LEN + 4].try_into().unwrap()) as usize;
    let a =
        u32::from_le_bytes(hdr[BAND_TAG_LEN + 4..BAND_TAG_LEN + 8].try_into().unwrap()) as usize;
    let want = LANDMARKS_HEADER_LEN
        .checked_add(n.checked_mul(4)?)?
        .checked_add(a.checked_mul(4)?)?
        .checked_add(a.checked_mul(n)?.checked_mul(8)?)?;
    if bytes.len() != want {
        return None;
    }
    let mut off = LANDMARKS_HEADER_LEN;
    let mut node_tiles = Vec::with_capacity(n);
    for _ in 0..n {
        node_tiles.push(u32::from_le_bytes(bytes[off..off + 4].try_into().unwrap()));
        off += 4;
    }
    if node_tiles.windows(2).any(|w| w[0] >= w[1]) {
        return None;
    }
    let mut anchors = Vec::with_capacity(a);
    for _ in 0..a {
        let t = u32::from_le_bytes(bytes[off..off + 4].try_into().unwrap());
        if node_tiles.binary_search(&t).is_err() {
            return None;
        }
        anchors.push(t);
        off += 4;
    }
    let mut dist_mm = Vec::with_capacity(a * n);
    for _ in 0..a * n {
        dist_mm.push(i64::from_le_bytes(bytes[off..off + 8].try_into().unwrap()));
        off += 8;
    }
    Some(BandLandmarks {
        node_tiles,
        anchors,
        dist_mm,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tiny hand-built portal set: a 4-tile path 10 ─ 20 ─ 30 ─ 40 with
    /// reduced weights 100, 100, 100 mm, plus an isolated stub 40 ─ 50 at
    /// 50 mm. Bidirectional pairs, as `detect_portals` would emit.
    fn path_portals() -> Vec<Portal> {
        let mk = |id: u32, tile: u32, nbr: u32, w: i64| Portal {
            id,
            component: 0,
            tile,
            tile_start: 0,
            tile_end: 1,
            neighbour_tile: nbr,
            neighbour_start: 0,
            neighbour_end: 1,
            max_draft_dm: 1000,
            min_horizontal_width_dm: 1000,
            touches_fairway: false,
            touches_tss: false,
            lower_bound_cost_mm: w,
        };
        vec![
            mk(0, 10, 20, 100),
            mk(1, 20, 10, 100),
            mk(2, 20, 30, 100),
            mk(3, 30, 20, 100),
            mk(4, 30, 40, 100),
            mk(5, 40, 30, 100),
            mk(6, 40, 50, 50),
            mk(7, 50, 40, 50),
        ]
    }

    fn dummy_built() -> BuiltRegion {
        BuiltRegion {
            tiles: Vec::new(),
            depth_min: Vec::new(),
            depth_max: Vec::new(),
            flags: Vec::new(),
            stitch: Vec::new(),
            report: Default::default(),
        }
    }

    #[test]
    fn nodes_are_the_sorted_unique_portal_endpoints() {
        let l = build_band_landmarks(&dummy_built(), &path_portals());
        assert_eq!(l.node_tiles, vec![10, 20, 30, 40, 50]);
    }

    #[test]
    fn anchors_are_graph_nodes_and_start_from_the_lowest_tile_id() {
        let l = build_band_landmarks(&dummy_built(), &path_portals());
        assert_eq!(l.anchors.len(), 5); // min(LANDMARK_ANCHORS, 5)
        assert_eq!(l.anchors[0], 10, "seed is the lowest tile id");
        for a in &l.anchors {
            assert!(l.node_tiles.contains(a));
        }
        // Farthest-point: from 10 the farthest node is 50 (300 mm away),
        // so it is picked second.
        assert_eq!(l.anchors[1], 50);
    }

    #[test]
    fn lower_bound_is_exact_on_a_path_where_the_reduced_metric_is_the_true_one() {
        let l = build_band_landmarks(&dummy_built(), &path_portals());
        // 10 → 40 is three 100-unit hops. With an anchor at each end of
        // the path the ALT differential recovers it exactly.
        assert_eq!(l.lower_bound_mm(10, 40), 300);
        assert_eq!(l.lower_bound_mm(40, 10), 300);
        assert_eq!(l.lower_bound_mm(20, 30), 100);
        assert_eq!(l.lower_bound_mm(10, 10), 0);
    }

    #[test]
    fn lower_bound_is_zero_for_a_non_node_tile() {
        let l = build_band_landmarks(&dummy_built(), &path_portals());
        assert_eq!(l.lower_bound_mm(10, 999), 0);
        assert_eq!(l.lower_bound_mm(999, 40), 0);
    }

    #[test]
    fn an_unreachable_anchor_is_skipped_not_counted_as_zero() {
        // Two disjoint edges: 1 ─ 2 (100) and 8 ─ 9 (100). An anchor in
        // one component cannot see the other; the bound must still be a
        // clean 0 (fall back to straight line), never a bogus value from
        // an i64::MAX subtraction.
        let mk = |id, t, nb, w| Portal {
            id,
            component: 0,
            tile: t,
            tile_start: 0,
            tile_end: 1,
            neighbour_tile: nb,
            neighbour_start: 0,
            neighbour_end: 1,
            max_draft_dm: 1000,
            min_horizontal_width_dm: 1000,
            touches_fairway: false,
            touches_tss: false,
            lower_bound_cost_mm: w,
        };
        let portals = vec![
            mk(0, 1, 2, 100),
            mk(1, 2, 1, 100),
            mk(2, 8, 9, 100),
            mk(3, 9, 8, 100),
        ];
        let l = build_band_landmarks(&dummy_built(), &portals);
        assert_eq!(l.lower_bound_mm(1, 9), 0);
        assert_eq!(l.lower_bound_mm(1, 2), 100);
    }

    #[test]
    fn empty_portal_set_gives_an_empty_table() {
        let l = build_band_landmarks(&dummy_built(), &[]);
        assert!(l.is_empty());
        assert_eq!(l.lower_bound_mm(1, 2), 0);
    }

    #[test]
    fn section_payload_round_trips() {
        let tag = BandTag {
            band_index: 3,
            band_dm: 40,
        };
        let l = build_band_landmarks(&dummy_built(), &path_portals());
        let bytes = encode_landmarks(tag, &l);
        assert_eq!(BandTag::parse(&bytes), Some(tag));
        assert_eq!(decode_landmarks(&bytes), Some(l));
    }

    #[test]
    fn empty_table_round_trips() {
        let tag = BandTag {
            band_index: 0,
            band_dm: 5,
        };
        let l = BandLandmarks::default();
        let bytes = encode_landmarks(tag, &l);
        assert_eq!(decode_landmarks(&bytes), Some(l));
    }

    #[test]
    fn decode_rejects_a_truncated_or_inconsistent_payload() {
        let tag = BandTag {
            band_index: 1,
            band_dm: 10,
        };
        let l = build_band_landmarks(&dummy_built(), &path_portals());
        let good = encode_landmarks(tag, &l);
        assert!(decode_landmarks(&good[..good.len() - 1]).is_none());
        assert!(decode_landmarks(&good[..4]).is_none());
        let mut extra = good.clone();
        extra.push(0);
        assert!(decode_landmarks(&extra).is_none());
    }

    #[test]
    fn decode_rejects_unsorted_nodes() {
        // Hand-forge a 2-node / 0-anchor payload with descending nodes.
        let tag = BandTag {
            band_index: 0,
            band_dm: 5,
        };
        let mut b = tag.to_bytes().to_vec();
        b.extend_from_slice(&2u32.to_le_bytes());
        b.extend_from_slice(&0u32.to_le_bytes());
        b.extend_from_slice(&9u32.to_le_bytes());
        b.extend_from_slice(&4u32.to_le_bytes());
        assert!(decode_landmarks(&b).is_none());
    }
}
