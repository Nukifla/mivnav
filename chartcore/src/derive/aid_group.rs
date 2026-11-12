// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Aid-to-navigation grouping (specs-12.md §1.1): a shared `aid_group` id on
//! every component of one *physical* aid. See docs/architecture/aid-group.md
//! for the relationship-vs-co-location algorithm and id-determinism rules.

use std::collections::BTreeMap;

use crate::model::{AttrValue, Cell, Geometry};

/// Is this an aid-component class eligible for grouping (buoy/beacon
/// structures plus the slave marks)? Mirrors the frontend's
/// `AID_COMPONENT_CLASSES` (post-`layer_name` merge: `BOY*`/`BCN*` → `ATON`).
fn is_aid_component(acronym: &str) -> bool {
    let up = acronym.to_ascii_uppercase();
    up.starts_with("BOY")
        || up.starts_with("BCN")
        || up == "TOPMAR"
        || up == "LIGHTS"
        || up == "DAYMAR"
}

/// Primary-selection rank: the structure is the master, then a light, then the
/// marks. Mirrors the frontend `PRIMARY_ORDER` so the id's master and the
/// panel's primary hit agree. Lower = more likely the master.
fn primary_rank(acronym: &str) -> u8 {
    let up = acronym.to_ascii_uppercase();
    if up.starts_with("BOY") || up.starts_with("BCN") {
        0
    } else if up == "LIGHTS" {
        1
    } else if up == "TOPMAR" {
        2
    } else {
        3 // DAYMAR
    }
}

/// Emit `aid_group` on every component of a multi-member physical aid.
pub fn apply(cell: &mut Cell) {
    // Positions (into cell.features) of the aid-component features.
    let idxs: Vec<usize> = cell
        .features
        .iter()
        .enumerate()
        .filter(|(_, f)| is_aid_component(&f.acronym))
        .map(|(i, _)| i)
        .collect();
    if idxs.len() < 2 {
        return; // nothing can group
    }

    // LNAM → local position, for resolving relationship edges.
    let mut by_lnam: BTreeMap<&str, usize> = BTreeMap::new();
    for (pos, &fi) in idxs.iter().enumerate() {
        if let Some(lnam) = &cell.features[fi].lnam {
            by_lnam.insert(lnam.as_str(), pos);
        }
    }

    let mut uf = crate::union_find::UnionFind::new(idxs.len());
    let mut has_rel = vec![false; idxs.len()];

    // Relationship edges (undirected): a component's LNAM_REFS that name
    // another aid component in this cell bind the two.
    for (pos, &fi) in idxs.iter().enumerate() {
        for r in &cell.features[fi].lnam_refs {
            if let Some(&other) = by_lnam.get(r.as_str()) {
                uf.union(pos, other);
                has_rel[pos] = true;
                has_rel[other] = true;
            }
        }
    }

    // Co-location fallback: bucket point components by exact coordinate; union
    // a bucket only where the relationship left a gap (some member unlinked).
    let mut by_coord: BTreeMap<(i32, i32), Vec<usize>> = BTreeMap::new();
    for (pos, &fi) in idxs.iter().enumerate() {
        if let Some(Geometry::Point(p)) = &cell.features[fi].geometry {
            by_coord.entry((p.x, p.y)).or_default().push(pos);
        }
    }
    for members in by_coord.values() {
        if members.len() < 2 || members.iter().all(|&m| has_rel[m]) {
            continue;
        }
        let first = members[0];
        for &m in &members[1..] {
            uf.union(first, m);
        }
    }

    // Collect groups by root, in deterministic (root, member) order.
    let mut groups: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for pos in 0..idxs.len() {
        let root = uf.find(pos);
        groups.entry(root).or_default().push(pos);
    }

    // Assign an id to each multi-member group, then write it. Reads finish
    // before the mutation so the borrow of cell.features stays clean.
    let mut assignments: Vec<(usize, String)> = Vec::new();
    for members in groups.values() {
        if members.len() < 2 {
            continue;
        }
        // Master = lowest primary_rank; ties broken by feature index (stable
        // per cell) so the chosen id is deterministic.
        let master_pos = *members
            .iter()
            .min_by_key(|&&pos| (primary_rank(&cell.features[idxs[pos]].acronym), idxs[pos]))
            .unwrap();
        let master = &cell.features[idxs[master_pos]];
        let id = match &master.lnam {
            Some(lnam) => lnam.clone(),
            None => match &master.geometry {
                Some(Geometry::Point(p)) => format!("@{}:{}", p.x, p.y),
                _ => format!("@rcid:{}", master.rcid.unwrap_or(0)),
            },
        };
        for &pos in members {
            assignments.push((idxs[pos], id.clone()));
        }
    }
    for (fi, id) in assignments {
        cell.features[fi]
            .attributes
            .insert("aid_group".into(), AttrValue::Str(id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::{Extent, WorldXy};
    use crate::model::{CellMeta, Feature};

    fn comp(acronym: &str, at: WorldXy, lnam: Option<&str>, refs: &[&str]) -> Feature {
        let mut f = Feature::new(
            0,
            acronym.into(),
            std::collections::BTreeMap::new(),
            Some(Geometry::Point(at)),
        );
        f.lnam = lnam.map(str::to_string);
        f.lnam_refs = refs.iter().map(|s| s.to_string()).collect();
        f
    }

    fn cell(features: Vec<Feature>) -> Cell {
        Cell {
            meta: CellMeta::default(),
            extent: Extent::invalid(),
            features,
        }
    }

    fn group_of<'a>(c: &'a Cell, i: usize) -> Option<&'a str> {
        c.features[i].attr("aid_group").and_then(AttrValue::as_str)
    }

    #[test]
    fn relationship_binds_a_lit_buoy_with_a_topmark() {
        // Structure (buoy) lists its slaves' LNAMs, master→slave (real S-57).
        let at = WorldXy::new(100, 200);
        let mut c = cell(vec![
            comp("BOYLAT", at, Some("BUOY"), &["TOP", "LIT"]),
            comp("TOPMAR", at, Some("TOP"), &[]),
            comp("LIGHTS", at, Some("LIT"), &[]),
        ]);
        apply(&mut c);
        // all three share the master's LNAM as the id
        assert_eq!(group_of(&c, 0), Some("BUOY"));
        assert_eq!(group_of(&c, 1), Some("BUOY"));
        assert_eq!(group_of(&c, 2), Some("BUOY"));
    }

    #[test]
    fn slave_pointing_at_master_binds_too() {
        // The other direction: the light lists its master. Undirected edge.
        let at = WorldXy::new(1, 1);
        let mut c = cell(vec![
            comp("BCNLAT", at, Some("BEACON"), &[]),
            comp("LIGHTS", at, Some("LIT"), &["BEACON"]),
        ]);
        apply(&mut c);
        assert_eq!(group_of(&c, 0), Some("BEACON"));
        assert_eq!(group_of(&c, 1), Some("BEACON"));
    }

    #[test]
    fn co_location_fallback_groups_when_refs_absent() {
        // No LNAM_REFS at all (e.g. OSENC path): co-location fires; the master
        // has no LNAM either, so the id is coordinate-derived.
        let at = WorldXy::new(500, 600);
        let mut c = cell(vec![
            comp("BOYLAT", at, None, &[]),
            comp("TOPMAR", at, None, &[]),
            comp("LIGHTS", at, None, &[]),
        ]);
        apply(&mut c);
        assert_eq!(group_of(&c, 0), Some("@500:600"));
        assert_eq!(group_of(&c, 1), Some("@500:600"));
        assert_eq!(group_of(&c, 2), Some("@500:600"));
    }

    #[test]
    fn a_lone_buoy_and_a_standalone_light_get_none() {
        let mut c = cell(vec![
            comp("BOYLAT", WorldXy::new(10, 10), Some("A"), &[]),
            comp("LIGHTS", WorldXy::new(9000, 9000), Some("B"), &[]),
        ]);
        apply(&mut c);
        assert!(c.features[0].attr("aid_group").is_none());
        assert!(c.features[1].attr("aid_group").is_none());
    }

    #[test]
    fn two_distinct_aids_do_not_collide() {
        // Two separate lit buoys, each its own relationship group at its own
        // coordinate. They must not share an id.
        let a = WorldXy::new(100, 100);
        let b = WorldXy::new(800, 800);
        let mut c = cell(vec![
            comp("BOYLAT", a, Some("A"), &["ATOP"]),
            comp("TOPMAR", a, Some("ATOP"), &[]),
            comp("BOYLAT", b, Some("B"), &["BTOP"]),
            comp("TOPMAR", b, Some("BTOP"), &[]),
        ]);
        apply(&mut c);
        assert_eq!(group_of(&c, 0), Some("A"));
        assert_eq!(group_of(&c, 1), Some("A"));
        assert_eq!(group_of(&c, 2), Some("B"));
        assert_eq!(group_of(&c, 3), Some("B"));
    }

    #[test]
    fn non_aid_neighbours_are_untouched() {
        // A wreck sharing the buoy's coordinate is not an aid component.
        let at = WorldXy::new(7, 7);
        let mut c = cell(vec![
            comp("BOYLAT", at, None, &[]),
            comp("LIGHTS", at, None, &[]),
            comp("WRECKS", at, None, &[]),
        ]);
        apply(&mut c);
        assert!(group_of(&c, 0).is_some());
        assert!(group_of(&c, 1).is_some());
        assert!(c.features[2].attr("aid_group").is_none());
    }

    #[test]
    fn idempotent() {
        let at = WorldXy::new(3, 3);
        let mut c = cell(vec![
            comp("BOYLAT", at, Some("BUOY"), &["LIT"]),
            comp("LIGHTS", at, Some("LIT"), &[]),
        ]);
        apply(&mut c);
        let once = c.clone();
        apply(&mut c);
        assert_eq!(c, once);
    }
}
