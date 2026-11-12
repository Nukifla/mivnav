// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! §8.4's chain-contracted shortcuts, over one band's [`super::portals::Portal`]
//! set.
//!
//! # What gets contracted, and why
//!
//! [`super::portals::detect_portals`] gives one edge per tile-boundary
//! crossing. A long, straight, unobstructed channel — a river reach, a
//! buoyed fairway running through a dozen same-rung tiles — produces a
//! dozen `Portal`s in a row, every one of them a plain pass-through with
//! nothing to search: enter one side, cross, arrive the other side, with
//! exactly one way to keep going. §12's topology search over the raw
//! portal set would re-derive that "no real choice here" fact at every
//! single hop, for a fraction of the graph that plays no part in any
//! ACTUAL decision. Chain contraction removes exactly that waste: every
//! maximal run of tiles with no real branching collapses into one
//! [`Shortcut`], leaving the query-time search a graph sized by real
//! decision points (branches, dead ends, capacity changes worth stopping
//! at) rather than by tile count. This is not a contraction *hierarchy*
//! (no recursive levels) — §8.4's own scope note applies: the portal
//! graph is portal-scale (hundreds to low thousands of nodes per band per
//! region), not road-network-scale, so one flat contraction pass is
//! enough.
//!
//! Original `Portal`s are never touched, let alone deleted — this module
//! only ever *reads* `built`/`portals` and returns a new, independent
//! `Vec<Shortcut>`. §12.4's local refinement and any query-time fallback
//! always have the real per-tile portals to drop back to; a `Shortcut` is
//! a search-time convenience over them, never the only record.
//!
//! # The graph: tiles are nodes, one seam is one edge
//!
//! A node is a tile (identified the same way `Portal::tile` already
//! does: an index into `built.tiles`). An edge is one PHYSICAL seam —
//! [`physical_edges`] first collapses `Portal`'s own bidirectional pair
//! (one seam, two `Portal`s, per `portals`' own documented convention)
//! back into one graph edge, the same way a road has one shape even
//! though you can drive it both ways. A tile's DEGREE is the number of
//! distinct physical edges touching it, counting a seam split into
//! several portals by a mid-run obstruction as that many distinct edges
//! (they really are separate navigable connections, not one).
//!
//! A JUNCTION is any node that is not a plain pass-through: a dead end
//! (degree 1, nothing to contract past), a real branch or crossroads
//! (degree 3+), an isolated tile (degree 0, no shortcut touches it at
//! all) — or, the one case raw degree-counting gets wrong, a tile with
//! EXACTLY TWO edges that both lead to the SAME neighbour (a seam split
//! into two disjoint navigable crossings by a mid-run obstruction, e.g.
//! an islet splitting a strait into two channels). That last shape has
//! degree 2 but is a real, simultaneous CHOICE between two routes, not
//! an unbranching corridor — [`is_pass_through`] is the one place this
//! distinction is made, and every junction/contraction decision in this
//! module goes through it rather than a bare edge-count check. Every
//! other node is a genuine pass-through, and it is exactly those nodes —
//! chains of them, between two junctions — that get contracted.
//!
//! # Bidirectional, exactly like `Portal` and `StitchRun`
//!
//! One physical chain between two junctions produces TWO `Shortcut`s,
//! `tile → other_tile` and `other_tile → tile`, each carrying its own
//! ordered `portal_chain` (the constituent portal ids in TRAVERSAL
//! order, each one "the portal as seen leaving the node you are AT",
//! matching `Portal`'s own per-direction identity) — the same convention
//! `detect_portals` documents for its own output, extended here rather
//! than broken. This is deliberate even though §7's directional rules
//! (§11, Phase 7) do not exist yet: when they land, a `Shortcut` already
//! has a natural per-direction home for them, instead of a second
//! structural change to retrofit direction onto an object built
//! direction-less.
//!
//! A physical edge missing its mirror `Portal` — the well-formed pipeline
//! never produces one (`detect_portals` walks both directions of every
//! `StitchRun`, which `stitch.rs` itself always emits in pairs), so this
//! can only mean a corrupted or version-skewed file — is dropped from the
//! graph entirely rather than guessed at asymmetrically. Same defensive
//! direction `resolve_run_pair` already takes for exactly this class of
//! input.
//!
//! # Capacity: min-aggregated, exactly §8.4's own words
//!
//! `max_draft_dm` of a `Shortcut` is the minimum `max_draft_dm` over
//! every portal in its chain — the shallowest constriction anywhere
//! along the run is the real ceiling for the whole thing, same
//! conservative direction `Portal`'s own capacity already takes over
//! `depth_min`.
//!
//! # Cost bounds: distance, not yet the real cost model
//!
//! §8.4 asks for "summed lower[,] one recorded upper bound". This module
//! computes both from GEOMETRY, not from `Portal::lower_bound_cost`
//! (§8.2's fourth capacity field, still explicitly deferred in
//! `portals.rs` — there is nothing to sum yet): the per-edge length is
//! [`super::field::TileEntry::centre_distance_m`], a topology-scale
//! approximation — not the exact crossing-cell geometry `stitch.rs`
//! could in principle give — traded deliberately for simplicity at this
//! layer, since Phase 4/6's corridor-local exact search re-derives the
//! real geometry anyway once a `Shortcut` has done its job of picking
//! which corridor to look at. [`super::query`]'s own topology search
//! uses the identical helper for its admissible heuristic and per-portal
//! step cost — one distance model, defined once, shared by both.
//!
//! Reusing `routing::artifact::cost` (widened to `pub(crate)` for exactly
//! this, see that module's own comment) rather than a second mm-rounding
//! implementation:
//!
//! * `lower_bound_mm` = [`heuristic_mm`] at [`MIN_MULTIPLIER`] — the most
//!   PESSIMISTIC (largest-discount) scaling `cost::step_cost_mm`'s own
//!   §10.1 floor allows. Phase 5 now assigns real per-PORTAL multipliers
//!   (`query::TopologyWeights`, fairway preference and TSS avoidance —
//!   see that module's own docs), and `MIN_MULTIPLIER` is exactly what
//!   those multipliers floor at too, so this stays a true lower bound
//!   against ANY weight combination they carry, not merely a
//!   distance-only search — the same admissibility argument
//!   `heuristic_mm`'s own doc comment makes, just with "the caller's
//!   smallest multiplier this search could carry" instantiated to "we
//!   don't know yet, so assume the most generous one possible".
//! * `upper_bound_mm` = [`step_cost_mm`] at multiplier 1.0 — the NEUTRAL
//!   reference cost if nothing along this shortcut is ever penalized or
//!   discounted. This is not a true worst-case bound under arbitrary
//!   future penalties (a caution-area or against-buoyage penalty could
//!   still push a real route's cost above it) — it is "the plain
//!   distance cost", recorded once, consistent with Phase 4's own scope
//!   note that no soft costs beyond distance exist yet.
//!
//! # Canonical numbering
//!
//! Same rule as [`super::topology::Components`] and
//! [`super::portals::Portal`]: not an accident of which junction the
//! build happened to visit first. A `Shortcut`'s "lowest member" is the
//! smallest id in its own `portal_chain` (a shortcut has no cell of its
//! own to rank by, but every constituent portal does, and portal ids are
//! already canonical) — shortcuts are sorted ascending by that value
//! before ids are assigned.
//!
//! # Pure cycles
//!
//! A closed loop with no junction anywhere on it (every tile on the ring
//! has degree exactly 2 — a channel that circles an island back to
//! itself) has no natural starting point. [`build_shortcuts`] picks the
//! lowest tile index anywhere on the ring as a deterministic canonical
//! start (see [`lowest_node_on_cycle`]), so the result does not depend on
//! iteration or build order. The resulting `Shortcut` has `tile ==
//! other_tile` — a real, meaningful object (a self-loop through the
//! whole ring), not a bug: entering that tile and completing the loop is
//! a genuine, if unusual, corridor choice.

use std::collections::BTreeMap;

use crate::routing::artifact::cost::{heuristic_mm, step_cost_mm, MIN_MULTIPLIER};

use super::build::BuiltRegion;
use super::format::{BandTag, BAND_TAG_LEN};
use super::portals::Portal;
use super::topology::NO_COMPONENT;

/// One chain-contracted edge of the portal graph — see the module docs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shortcut {
    /// Canonical id — ascending by this shortcut's own lowest-member
    /// portal id, see the module docs.
    pub id: u32,
    /// The component every constituent portal shares (see the module
    /// docs' graph-construction argument for why they always agree).
    pub component: u32,
    pub tile: u32,
    pub other_tile: u32,
    /// The constituent portal ids, in traversal order from `tile` to
    /// `other_tile` — never empty (a `Shortcut` always spans at least
    /// one physical edge).
    pub portal_chain: Vec<u32>,
    /// Decimetres — the minimum `max_draft_dm` over every portal in the
    /// chain.
    pub max_draft_dm: u16,
    /// Millimetre-equivalents, `cost::heuristic_mm` at `MIN_MULTIPLIER` —
    /// see the module docs' cost-bounds section.
    pub lower_bound_mm: i64,
    /// Millimetre-equivalents, `cost::step_cost_mm` at multiplier 1.0 —
    /// see the module docs' cost-bounds section.
    pub upper_bound_mm: i64,
}

/// One deduplicated physical seam — `portals`' own bidirectional pair
/// collapsed back into a single graph edge. `tile_a < tile_b` always
/// (the pair is stored in a canonical, swap-invariant order so grouping
/// by key never depends on which direction's `Portal` the walk happened
/// to see first).
struct PhysicalEdge {
    tile_a: usize,
    tile_b: usize,
    /// The portal id "as seen leaving `tile_a` toward `tile_b`".
    id_from_a: u32,
    /// The portal id "as seen leaving `tile_b` toward `tile_a`".
    id_from_b: u32,
    length_m: f64,
    max_draft_dm: u16,
}

/// A node is a plain pass-through — safe to contract straight through —
/// only when it has EXACTLY TWO incident edges AND those two edges lead
/// to two DIFFERENT tiles. Two edges to the SAME tile (a seam split into
/// two disjoint navigable crossings by a mid-run obstruction — an islet
/// or shoal splitting a strait into two channels, `portals.rs`'s own
/// `a_blocked_row_splits_the_seam_into_two_portals` shape one layer
/// down) is a real, simultaneous CHOICE between two routes, not a single
/// unbranching corridor — raw edge COUNT alone cannot tell the two
/// apart, and an earlier version of this function used count alone,
/// which silently merged a multi-edge tile pair into a bogus
/// junction-free "pure cycle": one tile vanished as a shortcut endpoint
/// entirely, and the other reported a doubled cost bound covering both
/// channels at once (found by code review, reproduced, fixed here; see
/// `a_multi_edge_seam_stays_a_junction_not_a_pure_cycle` below).
fn is_pass_through(incident: &[(usize, usize)]) -> bool {
    incident.len() == 2 && incident[0].1 != incident[1].1
}

/// Every `Shortcut` derivable from `portals` (all bands/components
/// `portals` itself spans — see the module docs for why the graph
/// naturally partitions along component boundaries without this function
/// needing to filter by one explicitly).
pub fn build_shortcuts(built: &BuiltRegion, portals: &[Portal]) -> Vec<Shortcut> {
    let edges = physical_edges(built, portals);
    if edges.is_empty() {
        return Vec::new();
    }
    let adjacency = build_adjacency(&edges);
    let mut visited = vec![false; edges.len()];
    let mut raw: Vec<Shortcut> = Vec::new();

    // Pass 1: every chain anchored at a real junction — a dead end, a
    // branch, a multi-edge tile pair (see `is_pass_through`), or an
    // isolated node. `BTreeMap` keys iterate in ascending tile-index
    // order already, so this pass alone is deterministic; the per-node
    // incident list is sorted at construction too.
    let junctions: Vec<usize> = adjacency
        .iter()
        .filter(|(_, incident)| !is_pass_through(incident))
        .map(|(&tile, _)| tile)
        .collect();
    for start in junctions {
        let incident = adjacency[&start].clone();
        for (edge_idx, other) in incident {
            if visited[edge_idx] {
                continue;
            }
            let walk = walk_chain(start, (edge_idx, other), &adjacency, &edges, &mut visited);
            push_chain_shortcuts(portals, &edges, walk, &mut raw);
        }
    }

    // Pass 2: whatever is left must be a pure cycle — see the module
    // docs. Each cycle is handled once, from its own deterministic
    // canonical start, regardless of which of its edges happened to
    // still be unvisited when this pass reaches it.
    for edge_idx in 0..edges.len() {
        if visited[edge_idx] {
            continue;
        }
        let cycle_start = lowest_node_on_cycle(edge_idx, &adjacency, &edges);
        let incident = adjacency[&cycle_start].clone();
        for (eidx, other) in incident {
            if visited[eidx] {
                continue;
            }
            let walk = walk_chain(cycle_start, (eidx, other), &adjacency, &edges, &mut visited);
            push_chain_shortcuts(portals, &edges, walk, &mut raw);
        }
    }

    canonicalize(raw)
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

/// `(tile, tile_start, tile_end, neighbour_tile, neighbour_start,
/// neighbour_end)` in the swap-invariant order [`physical_edges`]
/// groups by — named so clippy's `type_complexity` has something to
/// point at other than an anonymous 6-tuple, not because it means
/// anything beyond "the fields that must match for two `Portal`s to be
/// the same physical seam".
type SeamKey = (u32, u16, u16, u32, u16, u16);

/// Deduplicate `portals`' bidirectional pairs into one [`PhysicalEdge`]
/// per physical seam, with a straight-line tile-centre-to-tile-centre
/// length. A seam missing either direction's `Portal` — see the module
/// docs — is silently dropped, not guessed at.
fn physical_edges(built: &BuiltRegion, portals: &[Portal]) -> Vec<PhysicalEdge> {
    // Keyed by the swap-invariant (lower tile, its range, higher tile,
    // its range) tuple: both of a seam's two `Portal`s produce the
    // IDENTICAL key, since one's (tile, tile_start, tile_end,
    // neighbour_tile, neighbour_start, neighbour_end) is exactly the
    // other's with `tile`/`neighbour_tile` (and their ranges) swapped.
    let mut by_key: BTreeMap<SeamKey, Vec<&Portal>> = BTreeMap::new();
    for p in portals {
        let key = if p.tile <= p.neighbour_tile {
            (
                p.tile,
                p.tile_start,
                p.tile_end,
                p.neighbour_tile,
                p.neighbour_start,
                p.neighbour_end,
            )
        } else {
            (
                p.neighbour_tile,
                p.neighbour_start,
                p.neighbour_end,
                p.tile,
                p.tile_start,
                p.tile_end,
            )
        };
        by_key.entry(key).or_default().push(p);
    }

    let mut edges = Vec::with_capacity(by_key.len());
    for group in by_key.into_values() {
        let (tile_a, tile_b) = {
            let p = group[0];
            (p.tile.min(p.neighbour_tile), p.tile.max(p.neighbour_tile))
        };
        let Some(id_from_a) = group.iter().find(|p| p.tile == tile_a).map(|p| p.id) else {
            continue;
        };
        let Some(id_from_b) = group.iter().find(|p| p.tile == tile_b).map(|p| p.id) else {
            continue;
        };
        let Some(a_entry) = built.tiles.get(tile_a as usize) else {
            continue;
        };
        let Some(b_entry) = built.tiles.get(tile_b as usize) else {
            continue;
        };
        let length_m = a_entry.centre_distance_m(b_entry);
        let max_draft_dm = group
            .iter()
            .map(|p| p.max_draft_dm)
            .min()
            .unwrap_or(u16::MAX);
        edges.push(PhysicalEdge {
            tile_a: tile_a as usize,
            tile_b: tile_b as usize,
            id_from_a,
            id_from_b,
            length_m,
            max_draft_dm,
        });
    }
    // Deterministic order independent of `BTreeMap`'s own key ordering
    // (which sorts by cell RANGE before tile id) — downstream adjacency
    // construction wants edges ordered by the tiles they touch.
    edges.sort_by_key(|e| (e.tile_a, e.tile_b, e.id_from_a));
    edges
}

/// `tile -> [(edge index into the `edges` slice, the tile at the OTHER
/// end)]`, sorted, one entry per node PER DIRECTION it can depart in —
/// i.e. every tile with at least one physical edge gets an entry, even a
/// degree-0 "isolated" one only reachable via `physical_edges` having
/// dropped its sole edge (in which case it never appears here at all,
/// which is correct: nothing shortcuts through a tile with no edges).
fn build_adjacency(edges: &[PhysicalEdge]) -> BTreeMap<usize, Vec<(usize, usize)>> {
    let mut adjacency: BTreeMap<usize, Vec<(usize, usize)>> = BTreeMap::new();
    for (i, e) in edges.iter().enumerate() {
        adjacency.entry(e.tile_a).or_default().push((i, e.tile_b));
        adjacency.entry(e.tile_b).or_default().push((i, e.tile_a));
    }
    for incident in adjacency.values_mut() {
        incident.sort();
    }
    adjacency
}

// ---------------------------------------------------------------------------
// Chain walking
// ---------------------------------------------------------------------------

/// One maximal chain: the ordered nodes and edges walked, its two
/// endpoints, total length, and min-aggregated draft.
struct Walk {
    node_path: Vec<usize>,
    edge_path: Vec<usize>,
    end: usize,
    length_m: f64,
    max_draft_dm: u16,
}

/// Walk from `start` along `first` (an incident `(edge index, other
/// tile)` pair) through as many degree-2 pass-through nodes as the graph
/// offers, stopping at the next junction — or back at `start` itself,
/// which is what closes a pure cycle (see the module docs). Marks every
/// edge it consumes as `visited` so no other walk in the same pass can
/// reuse it.
fn walk_chain(
    start: usize,
    first: (usize, usize),
    adjacency: &BTreeMap<usize, Vec<(usize, usize)>>,
    edges: &[PhysicalEdge],
    visited: &mut [bool],
) -> Walk {
    let mut node_path = vec![start];
    let mut edge_path = Vec::new();
    let mut length_m = 0.0;
    let mut max_draft_dm = u16::MAX;
    let (mut edge_idx, mut current) = first;

    loop {
        visited[edge_idx] = true;
        edge_path.push(edge_idx);
        length_m += edges[edge_idx].length_m;
        max_draft_dm = max_draft_dm.min(edges[edge_idx].max_draft_dm);
        node_path.push(current);

        let pass_through = adjacency.get(&current).is_some_and(|i| is_pass_through(i));
        if !pass_through || current == start {
            break;
        }
        let prev_edge = edge_idx;
        let Some(&(next_edge, next_tile)) = adjacency[&current]
            .iter()
            .find(|&&(eidx, _)| eidx != prev_edge && !visited[eidx])
        else {
            // Both incident edges already visited (can only happen at a
            // degree-2 node that is itself the walk's own start,
            // reached by wrapping around a tiny cycle from the wrong
            // side) — stop rather than loop.
            break;
        };
        edge_idx = next_edge;
        current = next_tile;
    }

    Walk {
        end: current,
        node_path,
        edge_path,
        length_m,
        max_draft_dm,
    }
}

/// The lowest tile index anywhere on the cycle `seed_edge` belongs to —
/// [`build_shortcuts`]'s pure-cycle pass's deterministic canonical start.
/// Read-only: does not touch `visited`, so it is safe to call before
/// deciding how to walk the cycle for real.
fn lowest_node_on_cycle(
    seed_edge: usize,
    adjacency: &BTreeMap<usize, Vec<(usize, usize)>>,
    edges: &[PhysicalEdge],
) -> usize {
    let start = edges[seed_edge].tile_a;
    let mut lowest = start;
    let mut current = start;
    let mut prev_edge = usize::MAX;
    loop {
        lowest = lowest.min(current);
        let Some(&(next_edge, next_tile)) = adjacency[&current]
            .iter()
            .find(|&&(eidx, _)| eidx != prev_edge)
            .or_else(|| adjacency[&current].first())
        else {
            break;
        };
        prev_edge = next_edge;
        current = next_tile;
        if current == start {
            break;
        }
    }
    lowest
}

// ---------------------------------------------------------------------------
// Turning a walk into Shortcuts
// ---------------------------------------------------------------------------

/// The chain's constituent portal ids, forward (`node_path[0] ->
/// end`) and reverse (`end -> node_path[0]`) — see the module docs for
/// why each direction uses the OTHER side's own portal id per edge.
fn chain_portal_ids(edges: &[PhysicalEdge], walk: &Walk) -> (Vec<u32>, Vec<u32>) {
    let mut forward = Vec::with_capacity(walk.edge_path.len());
    let mut backward_rev = Vec::with_capacity(walk.edge_path.len());
    for (i, &edge_idx) in walk.edge_path.iter().enumerate() {
        let e = &edges[edge_idx];
        if walk.node_path[i] == e.tile_a {
            forward.push(e.id_from_a);
            backward_rev.push(e.id_from_b);
        } else {
            forward.push(e.id_from_b);
            backward_rev.push(e.id_from_a);
        }
    }
    backward_rev.reverse();
    (forward, backward_rev)
}

fn push_chain_shortcuts(
    portals: &[Portal],
    edges: &[PhysicalEdge],
    walk: Walk,
    out: &mut Vec<Shortcut>,
) {
    let start = walk.node_path[0];
    let (forward, backward) = chain_portal_ids(edges, &walk);
    out.push(make_shortcut(
        portals,
        start,
        walk.end,
        forward,
        walk.length_m,
        walk.max_draft_dm,
    ));
    out.push(make_shortcut(
        portals,
        walk.end,
        start,
        backward,
        walk.length_m,
        walk.max_draft_dm,
    ));
}

fn make_shortcut(
    portals: &[Portal],
    tile: usize,
    other_tile: usize,
    portal_chain: Vec<u32>,
    length_m: f64,
    max_draft_dm: u16,
) -> Shortcut {
    // Portal ids are dense `0..n` indices into `portals` itself
    // (`detect_portals`'s own canonical numbering) — no separate lookup
    // table needed.
    let component = portal_chain
        .first()
        .and_then(|&id| portals.get(id as usize))
        .map_or(NO_COMPONENT, |p| p.component);
    debug_assert!(
        portal_chain
            .iter()
            .all(|&id| portals.get(id as usize).map(|p| p.component) == Some(component)),
        "a shortcut's constituent portals must all share one component — \
         the graph only ever connects tiles a real Portal joins, and a \
         Portal never bridges two different components (portals.rs's own \
         invariant), so a mismatch here means that invariant broke, not a \
         bug local to this module"
    );
    Shortcut {
        id: 0, // assigned by canonicalize()
        component,
        tile: tile as u32,
        other_tile: other_tile as u32,
        portal_chain,
        max_draft_dm,
        lower_bound_mm: heuristic_mm(length_m, MIN_MULTIPLIER),
        upper_bound_mm: step_cost_mm(length_m, 1.0),
    }
}

// ---------------------------------------------------------------------------
// Canonical numbering
// ---------------------------------------------------------------------------

fn canonicalize(mut raw: Vec<Shortcut>) -> Vec<Shortcut> {
    raw.sort_by_key(|s| s.portal_chain.iter().copied().min().unwrap_or(u32::MAX));
    for (id, s) in raw.iter_mut().enumerate() {
        s.id = id as u32;
    }
    raw
}

// ---------------------------------------------------------------------------
// §8.4's on-disk form — SectionKind::Topology, one section per band
// ---------------------------------------------------------------------------

/// Serialized size of one [`Shortcut`] record, bytes.
///
/// ```text
/// off  len  field
///   0    4  id              u32
///   4    4  component       u32
///   8    4  tile            u32
///  12    4  other_tile      u32
///  16    4  chain_offset    u32  first entry in the chain pool
///  20    4  chain_len       u32  entries; never 0 (see Shortcut::portal_chain)
///  24    2  max_draft_dm    u16
///  26    6  reserved             zero, ignored on read
///  32    8  lower_bound_mm  i64
///  40    8  upper_bound_mm  i64
/// ```
///
/// This record plus its chain-pool slice covers **every** field of
/// [`Shortcut`]; `a_shortcut_record_covers_every_field_of_the_struct`
/// below is the test that makes adding one without extending the
/// encoding fail loudly.
pub const SHORTCUT_RECORD_LEN: usize = 48;

/// Fixed header length of a [`super::format::SectionKind::Topology`]
/// payload.
const SHORTCUTS_HEADER_LEN: usize = BAND_TAG_LEN + 16;

/// Serialize `shortcuts` as the per-band
/// [`super::format::SectionKind::Topology`] payload for `tag`'s band.
///
/// ```text
/// off  len  field
///   0    8  BandTag
///   8    4  count           u32  shortcut records
///  12    4  stride          u32  bytes per record (SHORTCUT_RECORD_LEN today)
///  16    8  chain_pool_len  u64  u32 entries in the chain pool
///  24  ...  records: count * stride
///  ...  ...  chain pool: chain_pool_len * u32, little-endian
/// ```
///
/// # Why a fixed record plus a shared pool, and not a length-prefixed one
///
/// [`Shortcut`] is the only variable-length product in the artifact —
/// [`Shortcut::portal_chain`] is however many portals §8.4's chain
/// contraction swallowed. A length-prefixed variable record would be
/// simpler to write and would give up two things this file format keeps
/// everywhere else: random access to record `i` (the whole reason
/// [`super::field::encode_tile_index`] and
/// [`super::stitch::encode_stitch`] carry a stride) and the
/// skip-what-you-do-not-know forward compatibility that stride buys.
///
/// Splitting the chain out into a trailing pool of plain `u32`s keeps
/// both: the record table stays a fixed stride, and the pool is exactly
/// the flat SoA column shape [`super::format`]'s docs want to read
/// zero-copy out of an mmap one day. It also deduplicates nothing and
/// hides nothing — `chain_offset`/`chain_len` are a straightforward
/// slice of the pool, in the same traversal order the in-memory `Vec`
/// has.
///
/// The pool is written after ALL records, so both regions stay 8-byte
/// aligned within the section (the section payload itself is 8-aligned
/// by [`super::format::ArtifactWriter`], the header is 24 bytes and the
/// stride is a multiple of 8).
pub fn encode_shortcuts(tag: BandTag, shortcuts: &[Shortcut]) -> Vec<u8> {
    let pool_len: usize = shortcuts.iter().map(|s| s.portal_chain.len()).sum();
    // `chain_offset` is a `u32`, so a pool of more than `u32::MAX`
    // entries is not addressable — that needs upwards of four billion
    // portals in one band of one region, orders of magnitude past
    // anything §5.3 sizes. It still must not corrupt anything silently
    // if it ever happened: `chain_pool_len` is written as the true `u64`
    // regardless, and `decode_shortcuts` refuses any value above the
    // `u32` bound outright, so such a file fails loudly on read instead
    // of handing back chains sliced at saturated offsets.
    debug_assert!(
        pool_len <= u32::MAX as usize,
        "chain pool too large to address"
    );
    let mut out = Vec::with_capacity(
        SHORTCUTS_HEADER_LEN + shortcuts.len() * SHORTCUT_RECORD_LEN + pool_len * 4,
    );
    out.extend_from_slice(&tag.to_bytes());
    out.extend_from_slice(&(shortcuts.len() as u32).to_le_bytes());
    out.extend_from_slice(&(SHORTCUT_RECORD_LEN as u32).to_le_bytes());
    out.extend_from_slice(&(pool_len as u64).to_le_bytes());

    let mut chain_offset: u32 = 0;
    for s in shortcuts {
        let mut b = [0u8; SHORTCUT_RECORD_LEN];
        b[0..4].copy_from_slice(&s.id.to_le_bytes());
        b[4..8].copy_from_slice(&s.component.to_le_bytes());
        b[8..12].copy_from_slice(&s.tile.to_le_bytes());
        b[12..16].copy_from_slice(&s.other_tile.to_le_bytes());
        b[16..20].copy_from_slice(&chain_offset.to_le_bytes());
        b[20..24].copy_from_slice(&(s.portal_chain.len() as u32).to_le_bytes());
        b[24..26].copy_from_slice(&s.max_draft_dm.to_le_bytes());
        // 26..32 reserved
        b[32..40].copy_from_slice(&s.lower_bound_mm.to_le_bytes());
        b[40..48].copy_from_slice(&s.upper_bound_mm.to_le_bytes());
        out.extend_from_slice(&b);
        chain_offset = chain_offset.saturating_add(s.portal_chain.len() as u32);
    }
    for s in shortcuts {
        for &id in &s.portal_chain {
            out.extend_from_slice(&id.to_le_bytes());
        }
    }
    out
}

/// Parse a per-band [`SectionKind::Topology`] payload.
///
/// `None` on a structurally impossible payload: short header, a stride
/// below [`SHORTCUT_RECORD_LEN`], a truncated record table or chain
/// pool, a chain that runs off the end of the pool, a chain that does
/// not start where the previous one ended (the chains must PARTITION
/// the pool in record order — see the comment in the loop for why that
/// is a memory-safety bound, not a tidiness rule), or an EMPTY chain —
/// [`Shortcut::portal_chain`]'s own documented invariant is that a
/// shortcut always spans at least one physical edge, and a decoder that
/// happily produced a chainless `Shortcut` would hand every downstream
/// consumer a value the type says cannot exist.
///
/// As with [`super::portals::decode_portals`], nothing SEMANTIC is
/// checked: a `tile` or a chain entry naming something this artifact
/// does not contain decodes fine and is caught where it is used.
///
/// [`SectionKind::Topology`]: super::format::SectionKind::Topology
pub fn decode_shortcuts(bytes: &[u8]) -> Option<Vec<Shortcut>> {
    let head = bytes.get(..SHORTCUTS_HEADER_LEN)?;
    let count = u32::from_le_bytes(head[8..12].try_into().unwrap()) as usize;
    let stride = u32::from_le_bytes(head[12..16].try_into().unwrap()) as usize;
    let pool_len = u64::from_le_bytes(head[16..24].try_into().unwrap());
    if stride < SHORTCUT_RECORD_LEN {
        return None;
    }
    // See `encode_shortcuts`: `chain_offset` is a `u32`, so a pool this
    // large could not have been written by any addressable encoding and
    // every offset into it would be ambiguous.
    if pool_len > u64::from(u32::MAX) {
        return None;
    }
    let pool_len = usize::try_from(pool_len).ok()?;
    let records_end = count
        .checked_mul(stride)?
        .checked_add(SHORTCUTS_HEADER_LEN)?;
    let need = pool_len.checked_mul(4)?.checked_add(records_end)?;
    if bytes.len() < need {
        return None;
    }

    let pool_at = |i: usize| -> u32 {
        let at = records_end + i * 4;
        u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
    };

    let mut out = Vec::with_capacity(count);
    // The chains must PARTITION the pool in record order, exactly as
    // `encode_shortcuts` writes them. Checking each chain individually
    // fits inside the pool is NOT enough, and the difference is a
    // denial of service rather than a nicety: with only a per-chain
    // bound, every one of `count` records may legally name the WHOLE
    // pool, so the decoded chains total `count * pool_len` entries out
    // of a file holding `48 * count + 4 * pool_len` bytes. Maximising
    // that under an N-byte section gives N^2/192 bytes allocated — a
    // 1 MB section demands 5.2 GB, and because the chain is collected
    // from an `ExactSizeIterator` the whole thing is reserved up front,
    // so on the Pi it is `handle_alloc_error` -> abort(): no unwind, no
    // error return, the server process simply gone. (Found by code
    // review of this commit; the encoder never emitted such a file, but
    // a corrupted or hostile one can.)
    //
    // Requiring `chain_offset == cursor` bounds the total decoded
    // entries by `pool_len`, which `need` already bounds by the file's
    // own length. A trailing unused pool tail is tolerated rather than
    // refused — the bytes still had to be present to get this far, so
    // it costs nothing, and refusing it would be a forward-compatibility
    // rule this format has no reason to make.
    let mut cursor = 0usize;
    for i in 0..count {
        let at = SHORTCUTS_HEADER_LEN + i * stride;
        let b = &bytes[at..at + SHORTCUT_RECORD_LEN];
        let u32_at = |o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap());
        let chain_offset = u32_at(16) as usize;
        let chain_len = u32_at(20) as usize;
        if chain_len == 0 {
            return None;
        }
        if chain_offset != cursor {
            return None;
        }
        // Checked add, then a single bound compare: `chain_offset +
        // chain_len` is two untrusted u32s and would wrap on a 32-bit
        // target without it.
        let chain_end = chain_offset.checked_add(chain_len)?;
        if chain_end > pool_len {
            return None;
        }
        cursor = chain_end;
        out.push(Shortcut {
            id: u32_at(0),
            component: u32_at(4),
            tile: u32_at(8),
            other_tile: u32_at(12),
            portal_chain: (chain_offset..chain_end).map(pool_at).collect(),
            max_draft_dm: u16::from_le_bytes(b[24..26].try_into().unwrap()),
            lower_bound_mm: i64::from_le_bytes(b[32..40].try_into().unwrap()),
            upper_bound_mm: i64::from_le_bytes(b[40..48].try_into().unwrap()),
        });
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::lat_lon_to_world;
    use crate::mivnav::bands::global_index;
    use crate::mivnav::field::{RegionLattice, TileEntry};
    use crate::mivnav::stitch::compute_stitch;
    use crate::mivnav::topology::label_band;

    const LAT: f64 = 54.0;
    const LON: f64 = 11.0;

    fn lattice() -> RegionLattice {
        RegionLattice::for_region(crate::coords::Extent::new(
            lat_lon_to_world(LAT, LON - 0.2).x,
            lat_lon_to_world(LAT, LON + 0.2).x,
            lat_lon_to_world(LAT + 0.2, LON).y,
            lat_lon_to_world(LAT - 0.2, LON).y,
        ))
    }

    /// `count` same-rung tiles in a west-to-east row, every cell open
    /// water — a straight, unbranching channel with two dead ends.
    fn open_row(count: usize) -> BuiltRegion {
        let l = lattice();
        let p = lat_lon_to_world(LAT, LON);
        let first = l.tile_at(3, p.x, p.y);
        let mut tiles = Vec::with_capacity(count);
        for i in 0..count {
            tiles.push(TileEntry {
                origin_x: first.origin_x + i as i32 * i32::from(first.cols) * first.cell_world,
                payload_offset: (i * first.cell_count()) as u64,
                ..first
            });
        }
        let n_each = first.cell_count();
        let n = n_each * count;
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
    fn a_straight_channel_contracts_to_one_shortcut_each_way() {
        let built = open_row(5);
        let comps = label_band(&built, 5.0);
        let portals = super::super::portals::detect_portals(&built, &comps);
        let shortcuts = build_shortcuts(&built, &portals);

        // Two dead-end junctions (the first and last tile), one chain
        // between them, two directions.
        assert_eq!(shortcuts.len(), 2, "{shortcuts:#?}");
        let fwd = shortcuts.iter().find(|s| s.tile == 0).unwrap();
        let bwd = shortcuts.iter().find(|s| s.other_tile == 0).unwrap();
        assert_eq!(fwd.other_tile, 4);
        assert_eq!(bwd.tile, 4);
        // 5 tiles in a row -> 4 seams -> 4 portals per direction.
        assert_eq!(fwd.portal_chain.len(), 4);
        assert_eq!(bwd.portal_chain.len(), 4);
        // The reverse chain must be the exact reverse of the forward one
        // (mirrored portal ids, matching Portal's own bidirectional
        // pairing) — not merely the same length.
        let fwd_mirrors: Vec<u32> = fwd
            .portal_chain
            .iter()
            .rev()
            .map(|&id| {
                let p = &portals[id as usize];
                // Find the mirror portal: same seam, opposite direction.
                portals
                    .iter()
                    .find(|q| q.tile == p.neighbour_tile && q.neighbour_tile == p.tile)
                    .unwrap()
                    .id
            })
            .collect();
        assert_eq!(bwd.portal_chain, fwd_mirrors);
        assert!(fwd.lower_bound_mm > 0);
        assert!(fwd.lower_bound_mm <= fwd.upper_bound_mm);
        assert_eq!(fwd.max_draft_dm, 50);
    }

    #[test]
    fn a_blocked_link_leaves_two_separate_shortcuts_instead_of_one() {
        // Same 5-tile row, but the middle seam (tiles 1-2) is fully
        // land, so there is no portal across it at all: the chain must
        // split into two independent 2-tile shortcuts rather than one
        // 4-tile one.
        use super::super::format::FLAG_LAND;
        let mut built = open_row(5);
        let seam_tile = &built.tiles[1];
        let blocked_col = u32::from(seam_tile.cols) - 1;
        for row in 0..u32::from(seam_tile.rows) {
            let i = global_index(seam_tile, blocked_col, row);
            built.flags[i] = FLAG_LAND;
            let neighbour = &built.tiles[2];
            let j = global_index(neighbour, 0, row);
            built.flags[j] = FLAG_LAND;
        }
        let comps = label_band(&built, 5.0);
        let portals = super::super::portals::detect_portals(&built, &comps);
        let shortcuts = build_shortcuts(&built, &portals);

        // Two independent chains (0-1 and 2-3-4), two directions each.
        assert_eq!(shortcuts.len(), 4, "{shortcuts:#?}");
        let ends: std::collections::BTreeSet<(u32, u32)> =
            shortcuts.iter().map(|s| (s.tile, s.other_tile)).collect();
        assert!(ends.contains(&(0, 1)));
        assert!(ends.contains(&(1, 0)));
        assert!(ends.contains(&(2, 4)));
        assert!(ends.contains(&(4, 2)));
    }

    #[test]
    fn a_multi_edge_seam_stays_a_junction_not_a_pure_cycle() {
        // Two same-rung tiles whose shared seam is split into two
        // disjoint navigable runs by ONE blocked row in the middle
        // (`portals.rs`'s own `a_blocked_row_splits_the_seam_into_two_portals`
        // shape) — a real islet/shoal splitting a strait into two
        // channels. Both tiles end up with exactly two edges, both
        // leading to the SAME other tile: a multi-edge pair, not a
        // pass-through. Regression for the bug code review found: raw
        // edge-count treated this as a junction-free "pure cycle",
        // dropping tile 1 as a shortcut endpoint entirely and doubling
        // the reported cost of what should have been two separate
        // single-hop crossings.
        use super::super::field::TILE_CELLS;
        use super::super::format::FLAG_LAND;
        let mut built = open_row(2);
        let mid = TILE_CELLS / 2;
        let west = built.tiles[0];
        let east = built.tiles[1];
        built.flags[global_index(&west, u32::from(west.cols) - 1, mid)] = FLAG_LAND;
        built.flags[global_index(&east, 0, mid)] = FLAG_LAND;

        let comps = label_band(&built, 5.0);
        let portals = super::super::portals::detect_portals(&built, &comps);
        assert_eq!(
            portals.len(),
            4,
            "one blocked row splits the seam into two crossings, each direction: {portals:#?}"
        );

        let shortcuts = build_shortcuts(&built, &portals);
        assert_eq!(shortcuts.len(), 4, "{shortcuts:#?}");
        for s in &shortcuts {
            assert_eq!(
                s.portal_chain.len(),
                1,
                "a direct multi-edge crossing must not be merged into a self-loop: {s:?}"
            );
            assert_ne!(
                s.tile, s.other_tile,
                "neither tile may vanish as a self-loop endpoint: {s:?}"
            );
        }
        assert!(shortcuts.iter().any(|s| s.tile == 0 && s.other_tile == 1));
        assert!(shortcuts.iter().any(|s| s.tile == 1 && s.other_tile == 0));

        let again = build_shortcuts(&built, &portals);
        assert_eq!(again, shortcuts);
    }

    #[test]
    fn a_coarse_fine_seam_split_by_a_block_still_contracts_correctly() {
        // The same coarse/fine grouped-pairing shape
        // `portals.rs`'s own `a_mid_run_block_splits_a_coarse_fine_seam_correctly`
        // test exercises, driven one layer up through `build_shortcuts` —
        // `physical_edges`' swap-invariant key must still pair up a
        // coarse/fine seam's two mirrored `Portal`s correctly even when
        // `expand()`'s ranges are grouped many-fine-to-one-coarse rather
        // than 1:1.
        use super::super::format::FLAG_LAND;
        let l = lattice();
        let p = lat_lon_to_world(LAT, LON);
        let coarse = l.tile_at(4, p.x, p.y);
        let fine_cell_world = l.cell_world(3);
        let cells = super::super::field::TILE_CELLS as u16;
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
        let ratio = (coarse.cell_world / fine.cell_world) as u32;
        fine.payload_offset = 0;

        let n_fine = fine.cell_count();
        let n_coarse = coarse.cell_count();
        let mut flags = vec![0u8; n_fine + n_coarse];
        let blocked_fine_row = fine.rows as u32 / 2;
        let blocked_coarse_row = blocked_fine_row / ratio;
        flags[global_index(&fine, u32::from(fine.cols) - 1, blocked_fine_row)] = FLAG_LAND;
        flags[global_index(&coarse, 0, blocked_coarse_row)] = FLAG_LAND;

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
        let portals = super::super::portals::detect_portals(&built, &comps);
        let shortcuts = build_shortcuts(&built, &portals);

        // Every portal must still be used exactly once, mirroring the
        // real-chart integration test's own invariant, now exercised on
        // a genuinely mixed-resolution seam rather than only same-rung
        // ones.
        let mut used: Vec<u32> = shortcuts
            .iter()
            .flat_map(|s| s.portal_chain.iter().copied())
            .collect();
        used.sort_unstable();
        assert_eq!(used, (0..portals.len() as u32).collect::<Vec<_>>());
        for s in &shortcuts {
            assert!((s.tile == 0 && s.other_tile == 1) || (s.tile == 1 && s.other_tile == 0));
        }
    }

    #[test]
    fn a_branch_point_produces_one_shortcut_per_arm() {
        // A T: a shared centre tile with three same-rung arms, each one
        // seam long. The centre has degree 3 (a junction), so no
        // contraction happens at all — three arms, six shortcuts (one
        // pair each), every chain length 1.
        let l = lattice();
        let p = lat_lon_to_world(LAT, LON);
        let centre = l.tile_at(3, p.x, p.y);
        let step = i32::from(centre.cols) * centre.cell_world;
        let west = TileEntry {
            origin_x: centre.origin_x - step,
            payload_offset: centre.cell_count() as u64,
            ..centre
        };
        let east = TileEntry {
            origin_x: centre.origin_x + step,
            payload_offset: 2 * centre.cell_count() as u64,
            ..centre
        };
        let north = TileEntry {
            origin_y: centre.origin_y - step,
            payload_offset: 3 * centre.cell_count() as u64,
            ..centre
        };
        let mut centre = centre;
        centre.payload_offset = 0;

        let tiles = vec![centre, west, east, north];
        let n_each = centre.cell_count();
        let n = n_each * tiles.len();
        let stitch = compute_stitch(&tiles);
        let built = BuiltRegion {
            tiles,
            depth_min: vec![50u16; n],
            depth_max: vec![100u16; n],
            flags: vec![0u8; n],
            stitch,
            report: Default::default(),
        };
        let comps = label_band(&built, 5.0);
        let portals = super::super::portals::detect_portals(&built, &comps);
        let shortcuts = build_shortcuts(&built, &portals);

        assert_eq!(shortcuts.len(), 6, "{shortcuts:#?}");
        for s in &shortcuts {
            assert_eq!(
                s.portal_chain.len(),
                1,
                "a direct branch arm must not be split further"
            );
            assert!(
                s.tile == 0 || s.other_tile == 0,
                "every arm touches the centre tile"
            );
        }
    }

    #[test]
    fn a_closed_ring_with_no_junction_contracts_to_a_self_loop() {
        // Four same-rung 2x2 tiles arranged NW/NE/SW/SE — the exact
        // "quadrants meeting at a point" shape topology.rs's own corner
        // tests use, which forms a genuine 4-cycle (each tile touches
        // exactly its two orthogonal neighbours, no diagonal stitch run
        // exists — see topology.rs's module docs). Every node has
        // degree exactly 2, so there is NO junction anywhere; the whole
        // ring contracts into one self-loop shortcut per direction.
        let mk = |dx: i32, dy: i32, offset: u64| TileEntry {
            origin_x: dx * 200,
            origin_y: dy * 200,
            cell_world: 100,
            rung: 0,
            tile_flags: 0,
            cols: 2,
            rows: 2,
            triggers: 0,
            payload_offset: offset,
        };
        let tiles = vec![mk(0, 0, 0), mk(1, 0, 4), mk(0, 1, 8), mk(1, 1, 12)];
        let n = 16;
        let stitch = compute_stitch(&tiles);
        let built = BuiltRegion {
            tiles,
            depth_min: vec![50u16; n],
            depth_max: vec![100u16; n],
            flags: vec![0u8; n],
            stitch,
            report: Default::default(),
        };
        let comps = label_band(&built, 1.0);
        let portals = super::super::portals::detect_portals(&built, &comps);
        let shortcuts = build_shortcuts(&built, &portals);

        assert_eq!(shortcuts.len(), 2, "{shortcuts:#?}");
        for s in &shortcuts {
            assert_eq!(
                s.tile, s.other_tile,
                "a pure cycle contracts to a self-loop"
            );
            assert_eq!(s.portal_chain.len(), 4, "all four seams of the ring");
        }
        // Deterministic regardless of which physical edge the pure-cycle
        // pass happened to reach first.
        for _ in 0..3 {
            assert_eq!(build_shortcuts(&built, &portals), shortcuts);
        }
    }

    #[test]
    fn capacity_is_the_shallowest_link_in_the_whole_chain() {
        let mut built = open_row(4);
        // Shoal just one boundary cell, in the middle seam.
        let mid_tile = &built.tiles[1];
        let i = global_index(mid_tile, u32::from(mid_tile.cols) - 1, 0);
        built.depth_min[i] = 5; // 0.5 m
        let comps = label_band(&built, 0.1);
        let portals = super::super::portals::detect_portals(&built, &comps);
        let shortcuts = build_shortcuts(&built, &portals);
        let fwd = shortcuts.iter().find(|s| s.tile == 0).unwrap();
        assert_eq!(
            fwd.max_draft_dm, 5,
            "the one shoal link must set the whole shortcut's ceiling"
        );
    }

    #[test]
    fn ids_are_deterministic_and_ascend_by_lowest_member_portal() {
        let built = open_row(5);
        let comps = label_band(&built, 5.0);
        let portals = super::super::portals::detect_portals(&built, &comps);
        let first = build_shortcuts(&built, &portals);
        for _ in 0..2 {
            assert_eq!(build_shortcuts(&built, &portals), first);
        }
        let mut ids: Vec<u32> = first.iter().map(|s| s.id).collect();
        ids.sort_unstable();
        assert_eq!(ids, (0..first.len() as u32).collect::<Vec<_>>());
    }

    #[test]
    fn no_edges_at_all_yields_no_shortcuts() {
        let l = lattice();
        let p = lat_lon_to_world(LAT, LON);
        let tile = l.tile_at(3, p.x, p.y);
        let n = tile.cell_count();
        let built = BuiltRegion {
            tiles: vec![TileEntry {
                payload_offset: 0,
                ..tile
            }],
            depth_min: vec![50u16; n],
            depth_max: vec![100u16; n],
            flags: vec![0u8; n],
            stitch: vec![],
            report: Default::default(),
        };
        let comps = label_band(&built, 5.0);
        let portals = super::super::portals::detect_portals(&built, &comps);
        assert!(portals.is_empty());
        assert!(build_shortcuts(&built, &portals).is_empty());
    }

    // -----------------------------------------------------------------
    // §8.4's on-disk form
    // -----------------------------------------------------------------

    fn band_tag() -> BandTag {
        BandTag {
            band_index: 6,
            band_dm: 50,
        }
    }

    /// Distinct values in every field, so a layout that swaps two
    /// same-width fields is visible — same reasoning as
    /// `portals::tests::distinct_portal`.
    fn distinct_shortcut() -> Shortcut {
        Shortcut {
            id: 0x1111_1111,
            component: 0x2222_2222,
            tile: 0x3333_3333,
            other_tile: 0x4444_4444,
            portal_chain: vec![0x5555_5555, 0x6666_6666, 0x7777_7777],
            max_draft_dm: 0x0888,
            lower_bound_mm: -0x0999_AAAA_BBBB_CCCC,
            upper_bound_mm: 0x0DDD_EEEE_FFFF_0001,
        }
    }

    #[test]
    fn a_shortcut_record_covers_every_field_of_the_struct() {
        // As in `portals.rs`: the destructuring is a COMPILE-time guard
        // that a new `Shortcut` field cannot be added without this test
        // being updated, and the per-field comparisons are the run-time
        // guard that each one actually survives the encoding.
        let s = distinct_shortcut();
        let Shortcut {
            id,
            component,
            tile,
            other_tile,
            portal_chain,
            max_draft_dm,
            lower_bound_mm,
            upper_bound_mm,
        } = s.clone();
        let bytes = encode_shortcuts(band_tag(), std::slice::from_ref(&s));
        let back = decode_shortcuts(&bytes).expect("a whole payload parses");
        assert_eq!(back.len(), 1);
        let back = &back[0];
        assert_eq!(back.id, id);
        assert_eq!(back.component, component);
        assert_eq!(back.tile, tile);
        assert_eq!(back.other_tile, other_tile);
        assert_eq!(back.portal_chain, portal_chain);
        assert_eq!(back.max_draft_dm, max_draft_dm);
        assert_eq!(back.lower_bound_mm, lower_bound_mm);
        assert_eq!(back.upper_bound_mm, upper_bound_mm);
        assert_eq!(back, &s);
    }

    #[test]
    fn shortcuts_round_trip_with_chains_of_differing_lengths() {
        // Differing chain lengths are the whole reason the pool exists —
        // a uniform-length fixture could not catch an offset that is
        // right only when every chain is the same size.
        let shortcuts = vec![
            Shortcut {
                portal_chain: vec![7],
                ..distinct_shortcut()
            },
            distinct_shortcut(),
            Shortcut {
                id: 2,
                portal_chain: (100..142).collect(),
                ..distinct_shortcut()
            },
            Shortcut {
                id: 3,
                portal_chain: vec![u32::MAX, 0],
                ..distinct_shortcut()
            },
        ];
        let bytes = encode_shortcuts(band_tag(), &shortcuts);
        assert_eq!(BandTag::parse(&bytes), Some(band_tag()));
        let pool_len: usize = shortcuts.iter().map(|s| s.portal_chain.len()).sum();
        assert_eq!(
            bytes.len(),
            SHORTCUTS_HEADER_LEN + shortcuts.len() * SHORTCUT_RECORD_LEN + pool_len * 4
        );
        assert_eq!(decode_shortcuts(&bytes), Some(shortcuts));

        // A band with no shortcuts at all is a real answer.
        assert_eq!(
            decode_shortcuts(&encode_shortcuts(band_tag(), &[])),
            Some(Vec::new())
        );
    }

    #[test]
    fn a_malformed_shortcuts_payload_is_refused_and_never_panics() {
        let good = encode_shortcuts(
            band_tag(),
            &[
                distinct_shortcut(),
                Shortcut {
                    portal_chain: vec![1, 2],
                    ..distinct_shortcut()
                },
            ],
        );
        assert!(decode_shortcuts(&good).is_some());

        // Every truncation, byte by byte.
        for len in 0..good.len() {
            let got = decode_shortcuts(&good[..len]);
            assert!(
                got.is_none(),
                "a payload truncated to {len} of {} bytes decoded as {got:?}",
                good.len()
            );
        }

        // A chain running off the end of the pool must be refused, not
        // silently clamped: a clamped chain is a DIFFERENT route through
        // the region than the one that was built.
        let mut past_pool = good.clone();
        past_pool[SHORTCUTS_HEADER_LEN + 20..SHORTCUTS_HEADER_LEN + 24]
            .copy_from_slice(&99u32.to_le_bytes());
        assert_eq!(decode_shortcuts(&past_pool), None);
        let mut past_offset = good.clone();
        past_offset[SHORTCUTS_HEADER_LEN + 16..SHORTCUTS_HEADER_LEN + 20]
            .copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(decode_shortcuts(&past_offset), None);

        // An empty chain contradicts `Shortcut::portal_chain`'s own
        // invariant — a decoder must not manufacture a value the type
        // says cannot exist.
        let mut empty_chain = good.clone();
        empty_chain[SHORTCUTS_HEADER_LEN + 20..SHORTCUTS_HEADER_LEN + 24]
            .copy_from_slice(&0u32.to_le_bytes());
        assert_eq!(decode_shortcuts(&empty_chain), None);

        // A pool length past what a u32 chain_offset could address.
        let mut huge_pool = good.clone();
        huge_pool[16..24].copy_from_slice(&(u64::from(u32::MAX) + 1).to_le_bytes());
        assert_eq!(decode_shortcuts(&huge_pool), None);

        // A stride below one record, and a count/stride that overflows.
        let mut short_stride = good.clone();
        short_stride[12..16].copy_from_slice(&16u32.to_le_bytes());
        assert_eq!(decode_shortcuts(&short_stride), None);
        let mut overflow = good.clone();
        overflow[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
        overflow[12..16].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(decode_shortcuts(&overflow), None);

        for len in [0usize, 1, 8, 23, 24, 47, 71, 4096] {
            assert_eq!(decode_shortcuts(&vec![0xFF; len]), None, "0xFF len {len}");
        }
    }

    /// Chains must PARTITION the pool in record order — checking only
    /// that each one individually fits inside it is not enough.
    ///
    /// The code-review finding this exists for: with a per-chain bound
    /// alone, every record may legally name the WHOLE pool, so the
    /// decoded chains total `count * pool_len` entries out of a file
    /// holding `48 * count + 4 * pool_len` bytes — `N^2/192` bytes of
    /// allocation from an `N`-byte section. The chain is collected from
    /// an `ExactSizeIterator`, so the whole demand is reserved up front:
    /// on the Pi that is `handle_alloc_error` -> `abort()`, with no
    /// unwind and no error return.
    ///
    /// The payload below is deliberately TINY (it has to be, or the
    /// test would have to allocate what it is proving cannot be
    /// allocated). It is the same shape as the megabyte version, at a
    /// size that is merely wrong rather than fatal.
    #[test]
    fn overlapping_chains_are_refused_rather_than_amplified() {
        let pool: Vec<u32> = (0..64).collect();
        let count = 8usize;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&band_tag().to_bytes());
        bytes.extend_from_slice(&(count as u32).to_le_bytes());
        bytes.extend_from_slice(&(SHORTCUT_RECORD_LEN as u32).to_le_bytes());
        bytes.extend_from_slice(&(pool.len() as u64).to_le_bytes());
        for i in 0..count {
            let mut b = [0u8; SHORTCUT_RECORD_LEN];
            b[0..4].copy_from_slice(&(i as u32).to_le_bytes());
            // EVERY record claims the entire pool: each chain is
            // individually in bounds, and together they are 8x the pool.
            b[16..20].copy_from_slice(&0u32.to_le_bytes());
            b[20..24].copy_from_slice(&(pool.len() as u32).to_le_bytes());
            bytes.extend_from_slice(&b);
        }
        for &id in &pool {
            bytes.extend_from_slice(&id.to_le_bytes());
        }
        // Every individual chain fits inside the pool (offset 0, length
        // exactly `pool_len`) — which is precisely why a per-chain bound
        // alone let this through.
        assert_eq!(
            decode_shortcuts(&bytes),
            None,
            "chains that overlap must be refused, not expanded to {} entries \
             out of a {}-byte section",
            count * pool.len(),
            bytes.len()
        );

        // The same payload with the chains actually partitioning the
        // pool (8 records x 8 entries) is fine — so the rule above
        // rejects the overlap, not the shape.
        let per = pool.len() / count;
        let mut ok = Vec::new();
        ok.extend_from_slice(&band_tag().to_bytes());
        ok.extend_from_slice(&(count as u32).to_le_bytes());
        ok.extend_from_slice(&(SHORTCUT_RECORD_LEN as u32).to_le_bytes());
        ok.extend_from_slice(&(pool.len() as u64).to_le_bytes());
        for i in 0..count {
            let mut b = [0u8; SHORTCUT_RECORD_LEN];
            b[0..4].copy_from_slice(&(i as u32).to_le_bytes());
            b[16..20].copy_from_slice(&((i * per) as u32).to_le_bytes());
            b[20..24].copy_from_slice(&(per as u32).to_le_bytes());
            ok.extend_from_slice(&b);
        }
        for &id in &pool {
            ok.extend_from_slice(&id.to_le_bytes());
        }
        let decoded = decode_shortcuts(&ok).expect("a real partition decodes");
        assert_eq!(decoded.len(), count);
        assert_eq!(decoded[0].portal_chain, (0..per as u32).collect::<Vec<_>>());
        assert_eq!(
            decoded[count - 1].portal_chain,
            ((count - 1) * per..pool.len())
                .map(|i| i as u32)
                .collect::<Vec<_>>()
        );

        // A chain that merely starts in the wrong PLACE — in bounds,
        // right length, but not where the previous one ended — is
        // refused too: the pool is a partition, not a free-for-all.
        let mut shifted = ok.clone();
        shifted[SHORTCUTS_HEADER_LEN + 16..SHORTCUTS_HEADER_LEN + 20]
            .copy_from_slice(&1u32.to_le_bytes());
        assert_eq!(decode_shortcuts(&shifted), None);
    }

    #[test]
    fn a_newer_builds_wider_shortcut_record_still_decodes() {
        // TWO records with DIFFERENT chain lengths, not one: the chain
        // pool starts after `count * stride` bytes, so a decoder that
        // computed the pool base from `SHORTCUT_RECORD_LEN` instead of
        // the file's declared stride would still pass with a single
        // record whose chain_offset is 0. With two, the second record's
        // chain lands at the wrong pool entries and the test fails.
        let a = distinct_shortcut();
        let b = Shortcut {
            id: 77,
            portal_chain: vec![900, 901, 902, 903, 904],
            ..distinct_shortcut()
        };
        let wide = SHORTCUT_RECORD_LEN + 8;
        let pool: Vec<u32> = a
            .portal_chain
            .iter()
            .chain(&b.portal_chain)
            .copied()
            .collect();

        let mut bytes = Vec::new();
        bytes.extend_from_slice(&band_tag().to_bytes());
        bytes.extend_from_slice(&2u32.to_le_bytes());
        bytes.extend_from_slice(&(wide as u32).to_le_bytes());
        bytes.extend_from_slice(&(pool.len() as u64).to_le_bytes());
        let mut chain_offset = 0u32;
        for s in [&a, &b] {
            let mut record = vec![0u8; wide];
            record[0..4].copy_from_slice(&s.id.to_le_bytes());
            record[4..8].copy_from_slice(&s.component.to_le_bytes());
            record[8..12].copy_from_slice(&s.tile.to_le_bytes());
            record[12..16].copy_from_slice(&s.other_tile.to_le_bytes());
            record[16..20].copy_from_slice(&chain_offset.to_le_bytes());
            record[20..24].copy_from_slice(&(s.portal_chain.len() as u32).to_le_bytes());
            record[24..26].copy_from_slice(&s.max_draft_dm.to_le_bytes());
            record[32..40].copy_from_slice(&s.lower_bound_mm.to_le_bytes());
            record[40..48].copy_from_slice(&s.upper_bound_mm.to_le_bytes());
            // Bytes only a NEWER build knows the meaning of: an older
            // reader must step over them, not choke on them.
            record[SHORTCUT_RECORD_LEN..].copy_from_slice(&[0x5A; 8]);
            bytes.extend_from_slice(&record);
            chain_offset += s.portal_chain.len() as u32;
        }
        for &id in &pool {
            bytes.extend_from_slice(&id.to_le_bytes());
        }
        assert_eq!(decode_shortcuts(&bytes), Some(vec![a, b]));
    }

    #[test]
    fn real_shortcuts_off_a_real_build_survive_the_round_trip() {
        // Not a hand-built fixture: the same synthetic-but-real pipeline
        // the rest of this module's tests drive, so the round trip sees
        // whatever chain lengths §8.4's contraction actually produces
        // rather than what a test author imagined.
        let built = open_row(5);
        let comps = label_band(&built, 5.0);
        let portals = super::super::portals::detect_portals(&built, &comps);
        let shortcuts = build_shortcuts(&built, &portals);
        assert!(!shortcuts.is_empty(), "the fixture must produce shortcuts");
        let bytes = encode_shortcuts(band_tag(), &shortcuts);
        assert_eq!(decode_shortcuts(&bytes), Some(shortcuts));
    }
}
