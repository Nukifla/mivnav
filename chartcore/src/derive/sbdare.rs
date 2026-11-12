// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! SBDARE (seabed area) seabed-nature label ("fine sand", not the S-4 letter
//! code "fS" — a deliberate 2026-07-29 divergence). See
//! docs/architecture/sbdare-seabed-labels.md for the full chartsymbols.xml
//! selection rules and the S-57-vs-s57.py wording provenance.

use crate::model::{AttrValue, Cell, Feature, Geometry};

pub fn apply(cell: &mut Cell) {
    for f in &mut cell.features {
        if f.acronym != "SBDARE" {
            continue;
        }
        let wants_label = match f.geometry {
            Some(Geometry::Point(_)) | Some(Geometry::Lines(_)) => true,
            Some(Geometry::Areas(_)) => area_wants_label(f),
            _ => false,
        };
        if !wants_label {
            continue;
        }
        if let Some(txt) = seabed_label(f) {
            f.attributes.insert("txt".into(), AttrValue::Str(txt));
        }
    }
}

/// Area-row gate: `WATLEV` must be 3 or 4, and a `WATLEV`=4 rock/lava/coral
/// feature draws the deferred `AP(RCKLDG01)` pattern instead of text.
fn area_wants_label(f: &Feature) -> bool {
    let watlev = f.attr("WATLEV").and_then(AttrValue::as_int);
    if !matches!(watlev, Some(3) | Some(4)) {
        return false;
    }
    if watlev == Some(4) {
        let natsur = f
            .attr("NATSUR")
            .and_then(AttrValue::as_int_list)
            .unwrap_or_default();
        if [9, 11, 14].iter().any(|v| natsur.contains(v)) {
            return false; // AP(RCKLDG01) pattern deferred, no label
        }
    }
    true
}

/// `NATQUA` qualifier words (S-57 Appendix A, attribute 114), in
/// `s57-style.json`'s priority order — 10 before 1-9, first match wins, NOT
/// numeric order. Parsed by `frontend/src/core/info/seabedWording.test.ts`
/// as a drift guard — do not sort it.
pub const NATQUA_WORDS: &[(i64, &str)] = &[
    (10, "hard"),
    (1, "fine"),
    (2, "medium"),
    (3, "coarse"),
    (4, "broken"),
    (5, "sticky"),
    (6, "soft"),
    (7, "stiff"),
    (8, "volcanic"),
    (9, "calcareous"),
];

/// `NATSUR` surface words (S-57 Appendix A, attribute 113 — 9 is `rock` and
/// 11 is `lava`, not lagoon), in `s57-style.json`'s priority order —
/// 11/14/17/18 before 1-9. Same parse-me shape and do-not-sort rule as
/// [`NATQUA_WORDS`].
pub const NATSUR_WORDS: &[(i64, &str)] = &[
    (11, "lava"),
    (14, "coral"),
    (17, "shells"),
    (18, "boulder"),
    (1, "mud"),
    (2, "clay"),
    (3, "silt"),
    (4, "sand"),
    (5, "stone"),
    (6, "gravel"),
    (7, "pebbles"),
    (8, "cobbles"),
    (9, "rock"),
];

/// First table entry whose code the feature lists — table order, not list
/// or numeric order. Empty when none match.
fn first_word(table: &[(i64, &'static str)], codes: &[i64]) -> &'static str {
    table
        .iter()
        .find(|(code, _)| codes.contains(code))
        .map(|(_, word)| *word)
        .unwrap_or("")
}

fn seabed_label(f: &Feature) -> Option<String> {
    let natqua = f
        .attr("NATQUA")
        .and_then(AttrValue::as_int_list)
        .unwrap_or_default();
    let natsur = f
        .attr("NATSUR")
        .and_then(AttrValue::as_int_list)
        .unwrap_or_default();
    // joined by a space only when both are present, to avoid a stray edge space
    let words = [
        first_word(NATQUA_WORDS, &natqua),
        first_word(NATSUR_WORDS, &natsur),
    ];
    let label = words
        .into_iter()
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    (!label.is_empty()).then_some(label)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::{Extent, WorldXy};
    use crate::model::{Cell, CellMeta};
    use std::collections::BTreeMap;

    fn feature(acronym: &str, geom: Geometry, attrs: &[(&str, AttrValue)]) -> Feature {
        let map: BTreeMap<String, AttrValue> = attrs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();
        Feature::new(0, acronym.into(), map, Some(geom))
    }

    fn derive(f: Feature) -> Feature {
        let mut c = Cell {
            meta: CellMeta::default(),
            extent: Extent::invalid(),
            features: vec![f],
        };
        apply(&mut c);
        c.features.remove(0)
    }

    fn s(f: &Feature, key: &str) -> Option<String> {
        f.attr(key).and_then(AttrValue::as_str).map(str::to_string)
    }

    fn pt(attrs: &[(&str, AttrValue)]) -> Feature {
        feature("SBDARE", Geometry::Point(WorldXy::new(0, 0)), attrs)
    }

    fn line(attrs: &[(&str, AttrValue)]) -> Feature {
        feature(
            "SBDARE",
            Geometry::Lines(vec![vec![WorldXy::new(0, 0), WorldXy::new(1, 1)]]),
            attrs,
        )
    }

    fn area(attrs: &[(&str, AttrValue)]) -> Feature {
        feature("SBDARE", Geometry::Areas(vec![]), attrs)
    }

    #[test]
    fn fine_sand_is_spelled_out() {
        // The user-facing ask: NATQUA=1 (fine) + NATSUR=4 (sand) reads
        // "fine sand", NOT the S-4 letter code "fS".
        let f = derive(pt(&[
            ("NATQUA", AttrValue::IntList(vec![1])),
            ("NATSUR", AttrValue::IntList(vec![4])),
        ]));
        assert_eq!(s(&f, "txt").as_deref(), Some("fine sand"));
    }

    #[test]
    fn natqua_table_is_s57_appendix_a() {
        for (code, word) in [
            (1, "fine"),
            (2, "medium"),
            (3, "coarse"),
            (4, "broken"),
            (5, "sticky"),
            (6, "soft"),
            (7, "stiff"),
            (8, "volcanic"),
            (9, "calcareous"),
            (10, "hard"),
        ] {
            let f = derive(pt(&[("NATQUA", AttrValue::IntList(vec![code]))]));
            assert_eq!(s(&f, "txt").as_deref(), Some(word), "NATQUA={code}");
        }
    }

    #[test]
    fn natsur_table_is_s57_appendix_a() {
        // S-57 Appendix A attribute 113, the same words the info panel
        // decodes these codes to: 9 is "rock" (NOT s57.py's "rocky"), 5 is
        // "stone" and 18 "boulder" (NOT its plurals), 11 is lava, not lagoon.
        for (code, word) in [
            (1, "mud"),
            (2, "clay"),
            (3, "silt"),
            (4, "sand"),
            (5, "stone"),
            (6, "gravel"),
            (7, "pebbles"),
            (8, "cobbles"),
            (9, "rock"),
            (11, "lava"),
            (14, "coral"),
            (17, "shells"),
            (18, "boulder"),
        ] {
            let f = derive(pt(&[("NATSUR", AttrValue::IntList(vec![code]))]));
            assert_eq!(s(&f, "txt").as_deref(), Some(word), "NATSUR={code}");
        }
    }

    #[test]
    fn unknown_codes_bake_nothing() {
        // 10/12/13/15/16 are not in either table (NATSUR has no 10-13 etc.).
        for code in [10, 12, 13, 15, 16, 19] {
            let f = derive(pt(&[("NATSUR", AttrValue::IntList(vec![code]))]));
            assert!(f.attr("txt").is_none(), "NATSUR={code}");
        }
    }

    #[test]
    fn natqua_priority_order_is_not_numeric() {
        // 10 must win over 1 even though 1 < 10 — first-match, not sorted.
        let f = derive(pt(&[("NATQUA", AttrValue::IntList(vec![1, 10]))]));
        assert_eq!(s(&f, "txt").as_deref(), Some("hard"));
    }

    #[test]
    fn natsur_priority_order_is_not_numeric() {
        // 11 must win over 1 even though 1 < 11.
        let f = derive(pt(&[("NATSUR", AttrValue::IntList(vec![1, 11]))]));
        assert_eq!(s(&f, "txt").as_deref(), Some("lava"));
    }

    #[test]
    fn multi_valued_lists_stay_two_words() {
        // Both attributes list-valued: one word each, first-match-wins, so
        // the label never grows with the list length, and the winner is the
        // TABLE order, not the list order or the numeric one. NATQUA
        // {9 calcareous, 5 sticky, 2 medium} -> "medium" (2 is checked
        // first of the three); NATSUR {1 mud, 18 boulder, 4 sand} ->
        // "boulder" (18 is checked before 1-9).
        let f = derive(pt(&[
            ("NATQUA", AttrValue::IntList(vec![9, 5, 2])),
            ("NATSUR", AttrValue::IntList(vec![1, 18, 4])),
        ]));
        assert_eq!(s(&f, "txt").as_deref(), Some("medium boulder"));
    }

    #[test]
    fn longest_possible_label_is_two_words() {
        // Worst case: "calcareous boulder", 18 chars — the ceiling the
        // module doc claims. MapLibre's default text-max-width (10 em)
        // wraps it to two lines rather than overflowing.
        let f = derive(pt(&[
            ("NATQUA", AttrValue::IntList(vec![9])),
            ("NATSUR", AttrValue::IntList(vec![18])),
        ]));
        assert_eq!(s(&f, "txt").as_deref(), Some("calcareous boulder"));
    }

    #[test]
    fn single_attribute_has_no_stray_space() {
        // NATQUA alone: no trailing space. NATSUR alone: no LEADING space —
        // the case the old bare concatenation got for free.
        let q = derive(pt(&[("NATQUA", AttrValue::IntList(vec![6]))]));
        assert_eq!(s(&q, "txt").as_deref(), Some("soft"));
        let s_only = derive(pt(&[("NATSUR", AttrValue::IntList(vec![4]))]));
        assert_eq!(s(&s_only, "txt").as_deref(), Some("sand"));
    }

    #[test]
    fn no_codes_bakes_nothing() {
        let f = derive(pt(&[]));
        assert!(f.attr("txt").is_none());
    }

    #[test]
    fn line_row_is_unconditional() {
        let f = derive(line(&[("NATSUR", AttrValue::IntList(vec![9]))]));
        assert_eq!(s(&f, "txt").as_deref(), Some("rock"));
    }

    #[test]
    fn area_no_watlev_bakes_nothing() {
        // The "No data" row (RCID 32212/32553) — WATLEV absent.
        let f = derive(area(&[("NATSUR", AttrValue::IntList(vec![4]))]));
        assert!(f.attr("txt").is_none());
    }

    #[test]
    fn area_watlev_other_bakes_nothing() {
        for w in [1, 2, 5] {
            let f = derive(area(&[
                ("WATLEV", AttrValue::Int(w)),
                ("NATSUR", AttrValue::IntList(vec![4])),
            ]));
            assert!(f.attr("txt").is_none(), "WATLEV={w}");
        }
    }

    #[test]
    fn area_watlev3_labels() {
        let f = derive(area(&[
            ("WATLEV", AttrValue::Int(3)),
            ("NATSUR", AttrValue::IntList(vec![4])),
        ]));
        assert_eq!(s(&f, "txt").as_deref(), Some("sand"));
    }

    #[test]
    fn area_watlev4_generic_natsur_labels() {
        let f = derive(area(&[
            ("WATLEV", AttrValue::Int(4)),
            ("NATSUR", AttrValue::IntList(vec![4])),
        ]));
        assert_eq!(s(&f, "txt").as_deref(), Some("sand"));
    }

    #[test]
    fn area_watlev4_pattern_natsur_bakes_nothing() {
        // RCID 32207/32208/32209 — AP(RCKLDG01), pattern deferred.
        for natsur in [9, 11, 14] {
            let f = derive(area(&[
                ("WATLEV", AttrValue::Int(4)),
                ("NATSUR", AttrValue::IntList(vec![natsur])),
            ]));
            assert!(f.attr("txt").is_none(), "NATSUR={natsur}");
        }
    }

    #[test]
    fn area_watlev3_pattern_natsur_still_labels() {
        // The WATLEV=3 branch has no rock/lava/coral special case at all
        // (RCID 32210 is the only WATLEV3 row) — only WATLEV=4 defers to
        // the pattern fill.
        let f = derive(area(&[
            ("WATLEV", AttrValue::Int(3)),
            ("NATSUR", AttrValue::IntList(vec![9])),
        ]));
        assert_eq!(s(&f, "txt").as_deref(), Some("rock"));
    }

    #[test]
    fn other_classes_untouched() {
        let f = derive(feature(
            "LNDMRK",
            Geometry::Point(WorldXy::new(0, 0)),
            &[
                ("WATLEV", AttrValue::Int(3)),
                ("NATSUR", AttrValue::IntList(vec![4])),
            ],
        ));
        assert!(f.attr("txt").is_none());
    }
}
