// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only
//
// Line/ring assembly ported from ochartsng's OESUChart.cpp
// (`buildLineGeometries`, `S57Object::LineIndex`; GPLv2, Andreas Vogel).

//! Geometry assembly from OSENC edge-node topology: line/area records carry
//! only index tuples into cell-global edge/node tables, chained into
//! polylines and (for areas) rings classified into outer/hole by
//! containment. See docs/architecture/osenc-record-format.md.

use std::collections::HashMap;

use crate::coords::WorldXy;
use crate::model::Polygon;

/// One boundary tuple of a line or area record (`S57Object.h:178-209`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LineIndex {
    pub start_node: i32,
    pub edge: i32,
    pub end_node: i32,
    pub forward: bool,
}

impl LineIndex {
    /// Parse one tuple. `vals` holds `stride` ints (3 or 4); `above_v200`
    /// selects the stride-4 layout.
    pub fn parse(vals: &[i32], above_v200: bool) -> LineIndex {
        let forward = if above_v200 {
            vals[3] == 0
        } else {
            vals[1] >= 0
        };
        LineIndex {
            start_node: vals[0],
            edge: vals[1].unsigned_abs() as i32,
            end_node: vals[2],
            forward,
        }
    }
}

/// Cell-global vector tables filled from records 96/85 (edges) and
/// 97/86 (connected nodes).
#[derive(Debug, Default)]
pub struct VectorTables {
    pub edges: HashMap<i32, Vec<WorldXy>>,
    pub nodes: HashMap<i32, WorldXy>,
}

impl VectorTables {
    /// The tuple's full point sequence: start node, edge interior points
    /// (reversed when not forward), end node, deduped. Missing table
    /// entries are skipped (the reference logs and carries on).
    fn tuple_points(&self, li: &LineIndex) -> Vec<WorldXy> {
        let mut pts: Vec<WorldXy> = Vec::new();
        let mut push = |p: WorldXy| {
            if pts.last() != Some(&p) {
                pts.push(p);
            }
        };
        if let Some(&p) = self.nodes.get(&li.start_node) {
            push(p);
        }
        if let Some(edge) = self.edges.get(&li.edge) {
            if li.forward {
                edge.iter().copied().for_each(&mut push);
            } else {
                edge.iter().rev().copied().for_each(&mut push);
            }
        }
        if let Some(&p) = self.nodes.get(&li.end_node) {
            push(p);
        }
        pts
    }

    /// Chain boundary tuples into polylines. A tuple continues the open
    /// chain when its start node equals the chain's current end node, or
    /// its first point equals the chain's last point.
    pub fn assemble_chains(&self, tuples: &[LineIndex]) -> Vec<Vec<WorldXy>> {
        let mut chains: Vec<Vec<WorldXy>> = Vec::new();
        let mut current: Vec<WorldXy> = Vec::new();
        // connected-node index the current chain ends on, when known
        let mut current_end_node: Option<i32> = None;
        for li in tuples {
            let pts = self.tuple_points(li);
            if pts.is_empty() {
                continue;
            }
            let node_continues =
                current_end_node == Some(li.start_node) && self.nodes.contains_key(&li.start_node);
            let point_continues = current.last() == pts.first();
            if !current.is_empty() && !node_continues && !point_continues {
                chains.push(std::mem::take(&mut current));
            }
            for p in pts {
                if current.last() != Some(&p) {
                    current.push(p);
                }
            }
            // the reference only tracks the end node when both endpoint
            // nodes resolved; otherwise continuation falls back to
            // point-equality only
            current_end_node = (self.nodes.contains_key(&li.start_node)
                && self.nodes.contains_key(&li.end_node))
            .then_some(li.end_node);
        }
        if !current.is_empty() {
            chains.push(current);
        }
        chains
    }

    /// Assemble a line feature's geometry: open (or naturally closed)
    /// polylines. Chains shorter than 2 points are dropped.
    pub fn assemble_lines(&self, tuples: &[LineIndex]) -> Vec<Vec<WorldXy>> {
        self.assemble_chains(tuples)
            .into_iter()
            .filter(|c| c.len() >= 2)
            .collect()
    }

    /// Assemble an area feature's geometry: chains close into rings
    /// (appending the first point if unclosed), then classify into polygons
    /// by even-odd containment depth.
    pub fn assemble_areas(&self, tuples: &[LineIndex]) -> Vec<Polygon> {
        let mut rings = Vec::new();
        for mut chain in self.assemble_chains(tuples) {
            if chain.first() != chain.last() {
                chain.push(chain[0]);
            }
            // a closed ring needs 3 distinct points + the closing repeat
            if chain.len() >= 4 {
                rings.push(chain);
            }
        }
        classify_rings(rings)
    }
}

/// Twice the signed area of a closed ring, y-down (i128: coordinates span
/// 2^29, long rings could overflow i64).
fn signed_area2(ring: &[WorldXy]) -> i128 {
    let mut sum = 0i128;
    for w in ring.windows(2) {
        sum += w[0].x as i128 * w[1].y as i128 - w[1].x as i128 * w[0].y as i128;
    }
    sum
}

/// Even-odd point-in-polygon test (ring closed, boundary points give an
/// arbitrary but harmless verdict — see `classify_rings`).
fn contains(ring: &[WorldXy], p: WorldXy) -> bool {
    let (px, py) = (p.x as i64, p.y as i64);
    let mut inside = false;
    for w in ring.windows(2) {
        let (x0, y0) = (w[0].x as i64, w[0].y as i64);
        let (x1, y1) = (w[1].x as i64, w[1].y as i64);
        if (y0 > py) != (y1 > py) {
            // x coordinate of the edge at height py, compared without
            // division: px < x0 + (py-y0)(x1-x0)/(y1-y0)
            let lhs = (px - x0) * (y1 - y0);
            let rhs = (py - y0) * (x1 - x0);
            if (y1 > y0 && lhs < rhs) || (y1 < y0 && lhs > rhs) {
                inside = !inside;
            }
        }
    }
    inside
}

/// Group closed rings into polygons: even containment depth is an outer
/// boundary, odd depth a hole of its immediately enclosing outer.
/// Containment uses one representative vertex — safe since S-57 areas'
/// rings don't intersect. Winding normalized: outers positive, holes negative.
fn classify_rings(rings: Vec<Vec<WorldXy>>) -> Vec<Polygon> {
    let n = rings.len();
    if n == 0 {
        return Vec::new();
    }
    if n == 1 {
        let mut only = rings;
        return vec![Polygon {
            outer: oriented(only.pop().unwrap(), true),
            holes: vec![],
        }];
    }
    let areas: Vec<i128> = rings.iter().map(|r| signed_area2(r).abs()).collect();
    // parents[i]: smallest ring strictly containing ring i, and depth
    let mut parent: Vec<Option<usize>> = vec![None; n];
    let mut depth: Vec<usize> = vec![0; n];
    for i in 0..n {
        let probe = rings[i][0];
        let mut best: Option<usize> = None;
        for j in 0..n {
            // only larger rings can contain ring i; ties can't nest
            if j != i && areas[j] > areas[i] && contains(&rings[j], probe) {
                depth[i] += 1;
                if best.is_none_or(|b| areas[j] < areas[b]) {
                    best = Some(j);
                }
            }
        }
        parent[i] = best;
    }
    let mut polygons: Vec<(usize, Polygon)> = Vec::new();
    // outers first, in input order
    for (i, ring) in rings.iter().enumerate() {
        if depth[i].is_multiple_of(2) {
            polygons.push((
                i,
                Polygon {
                    outer: oriented(ring.clone(), true),
                    holes: vec![],
                },
            ));
        }
    }
    for (i, ring) in rings.iter().enumerate() {
        if !depth[i].is_multiple_of(2) {
            let owner = parent[i].expect("odd depth implies a containing ring");
            if let Some((_, poly)) = polygons.iter_mut().find(|(idx, _)| *idx == owner) {
                poly.holes.push(oriented(ring.clone(), false));
            }
            // owner not an outer (even-depth) ring can't happen: the
            // smallest container of an odd-depth ring has even depth
        }
    }
    polygons.into_iter().map(|(_, p)| p).collect()
}

fn oriented(mut ring: Vec<WorldXy>, positive: bool) -> Vec<WorldXy> {
    if (signed_area2(&ring) > 0) != positive {
        ring.reverse();
    }
    ring
}

#[cfg(test)]
mod tests {
    use super::*;

    fn xy(x: i32, y: i32) -> WorldXy {
        WorldXy::new(x, y)
    }

    fn tables() -> VectorTables {
        let mut t = VectorTables::default();
        t.nodes.insert(1, xy(0, 0));
        t.nodes.insert(2, xy(100, 0));
        t.nodes.insert(3, xy(100, 100));
        t.edges.insert(10, vec![xy(30, 0), xy(60, 0)]); // between nodes 1 and 2
        t.edges.insert(11, vec![xy(100, 40)]); // between nodes 2 and 3
        t
    }

    #[test]
    fn stride_parsing() {
        let li = LineIndex::parse(&[5, 7, 6, 0], true);
        assert_eq!(
            li,
            LineIndex {
                start_node: 5,
                edge: 7,
                end_node: 6,
                forward: true
            }
        );
        let li = LineIndex::parse(&[5, 7, 6, 1], true);
        assert!(!li.forward);
        // stride 3: sign of the edge index carries direction
        let li = LineIndex::parse(&[5, -7, 6], false);
        assert_eq!(
            li,
            LineIndex {
                start_node: 5,
                edge: 7,
                end_node: 6,
                forward: false
            }
        );
        assert!(LineIndex::parse(&[5, 7, 6], false).forward);
    }

    #[test]
    fn chains_tuples_into_polylines() {
        let t = tables();
        let tuples = [
            LineIndex {
                start_node: 1,
                edge: 10,
                end_node: 2,
                forward: true,
            },
            LineIndex {
                start_node: 2,
                edge: 11,
                end_node: 3,
                forward: true,
            },
        ];
        let lines = t.assemble_lines(&tuples);
        assert_eq!(
            lines,
            vec![vec![
                xy(0, 0),
                xy(30, 0),
                xy(60, 0),
                xy(100, 0),
                xy(100, 40),
                xy(100, 100)
            ]]
        );
    }

    #[test]
    fn reversed_edge_and_broken_chain() {
        let t = tables();
        let tuples = [
            // edge traversed backwards: interior points reversed
            LineIndex {
                start_node: 2,
                edge: 10,
                end_node: 1,
                forward: false,
            },
            // not a continuation: separate polyline
            LineIndex {
                start_node: 2,
                edge: 11,
                end_node: 3,
                forward: true,
            },
        ];
        let lines = t.assemble_lines(&tuples);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], vec![xy(100, 0), xy(60, 0), xy(30, 0), xy(0, 0)]);
        assert_eq!(lines[1][0], xy(100, 0));
    }

    #[test]
    fn missing_nodes_fall_back_to_edge_points() {
        let t = tables();
        // senc.py writes -1 node indices: only edge interior points remain
        let tuples = [LineIndex {
            start_node: -1,
            edge: 10,
            end_node: -1,
            forward: true,
        }];
        let lines = t.assemble_lines(&tuples);
        assert_eq!(lines, vec![vec![xy(30, 0), xy(60, 0)]]);
    }

    fn ring_tables(rings: &[&[(i32, i32)]]) -> (VectorTables, Vec<LineIndex>) {
        // each ring becomes one edge holding all its vertices, no nodes
        let mut t = VectorTables::default();
        let mut tuples = Vec::new();
        for (i, ring) in rings.iter().enumerate() {
            let id = i as i32 + 1;
            t.edges
                .insert(id, ring.iter().map(|&(x, y)| xy(x, y)).collect());
            tuples.push(LineIndex {
                start_node: -1,
                edge: id,
                end_node: -1,
                forward: true,
            });
        }
        (t, tuples)
    }

    #[test]
    fn area_with_hole_classifies_and_orients() {
        // outer 0..100 square (CCW in y-down = negative → must flip),
        // hole 25..75 square (CW = positive → must flip)
        let (t, tuples) = ring_tables(&[
            &[(0, 0), (0, 100), (100, 100), (100, 0)],
            &[(25, 25), (75, 25), (75, 75), (25, 75)],
        ]);
        let polys = t.assemble_areas(&tuples);
        assert_eq!(polys.len(), 1);
        let p = &polys[0];
        assert_eq!(p.outer.len(), 5); // closed
        assert_eq!(p.outer.first(), p.outer.last());
        assert!(signed_area2(&p.outer) > 0, "outer must be positive");
        assert_eq!(p.holes.len(), 1);
        assert!(signed_area2(&p.holes[0]) < 0, "hole must be negative");
    }

    #[test]
    fn island_in_hole_becomes_second_outer() {
        let (t, tuples) = ring_tables(&[
            &[(0, 0), (100, 0), (100, 100), (0, 100)], // outer
            &[(20, 20), (80, 20), (80, 80), (20, 80)], // hole
            &[(40, 40), (60, 40), (60, 60), (40, 60)], // island (depth 2)
        ]);
        let polys = t.assemble_areas(&tuples);
        assert_eq!(polys.len(), 2);
        assert_eq!(polys[0].holes.len(), 1);
        assert!(polys[1].holes.is_empty());
        assert!(signed_area2(&polys[1].outer) > 0);
    }

    #[test]
    fn two_disjoint_outers() {
        let (t, tuples) = ring_tables(&[
            &[(0, 0), (10, 0), (10, 10), (0, 10)],
            &[(50, 0), (60, 0), (60, 10), (50, 10)],
        ]);
        let polys = t.assemble_areas(&tuples);
        assert_eq!(polys.len(), 2);
        assert!(polys.iter().all(|p| p.holes.is_empty()));
    }

    #[test]
    fn unclosed_chain_is_closed() {
        let mut t = VectorTables::default();
        t.nodes.insert(1, xy(0, 0));
        t.nodes.insert(2, xy(100, 0));
        t.edges.insert(10, vec![xy(50, 80)]);
        // one open chain 1→2 via a bend: finalize appends the start point
        let tuples = [LineIndex {
            start_node: 1,
            edge: 10,
            end_node: 2,
            forward: true,
        }];
        let polys = t.assemble_areas(&tuples);
        assert_eq!(polys.len(), 1);
        assert_eq!(polys[0].outer.first(), polys[0].outer.last());
        assert_eq!(polys[0].outer.len(), 4);
    }
}
