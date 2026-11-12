// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! LIGHTS derived facts (specs-12.md §1.2) — the settings-independent parts
//! of LIGHTS06 (`S52CondRules.cpp:1092-1237`) and the full LITDSN01 light
//! description string (`:783-1091`). Emits `lit_arc`/`lit_range` (sector arc
//! and its range-derived overlay radius), `sym`/`sym_extra` (flare/QUESMRK1
//! icon plus flood/strip adjunct), `sym_star` (position star — see
//! docs/architecture/light-position-star.md), `lit_col` and `litdsn*`
//! (description text). Full field-by-field derivation and the D6/D7
//! divergences: docs/architecture/lights-derive.md.

use std::collections::BTreeSet;

use crate::model::{AttrValue, Cell, Feature, Geometry};

/// Attributes that mean "this feature draws a symbol ON its own position".
/// `sym_topmark` is deliberately absent — a topmark is drawn stacked ABOVE
/// its body, not on the point itself. See docs/architecture/light-position-star.md.
const POSITION_SYMBOL_ATTRS: [&str; 3] = ["sym", "sym_s", "sym_cs"];

/// World coordinates where something already draws a symbol on the position;
/// decides whether a light earns `sym_star`. LIGHTS features are excluded
/// (a light's own flare is offset away from its point and must not mark
/// itself). Matched on the EXACT coordinate, not a tolerance — see
/// docs/architecture/light-position-star.md.
fn marked_positions(cell: &Cell) -> BTreeSet<(i32, i32)> {
    cell.features
        .iter()
        .filter(|f| f.acronym != "LIGHTS")
        .filter(|f| POSITION_SYMBOL_ATTRS.iter().any(|k| f.attr(k).is_some()))
        .filter_map(|f| match &f.geometry {
            Some(Geometry::Point(p)) => Some((p.x, p.y)),
            _ => None,
        })
        .collect()
}

pub fn apply(cell: &mut Cell) {
    let marked = marked_positions(cell);
    for f in &mut cell.features {
        if f.acronym != "LIGHTS" {
            continue;
        }
        let position_marked = match &f.geometry {
            Some(Geometry::Point(p)) => marked.contains(&(p.x, p.y)),
            _ => false,
        };
        let mut derived: Vec<(&str, AttrValue)> = Vec::new();

        // colour code list; empty or missing means magenta {12}
        // (S52CondRules.cpp:1106-1108)
        let mut colours = f
            .attr("COLOUR")
            .and_then(AttrValue::as_int_list)
            .unwrap_or_default();
        if colours.is_empty() {
            colours = vec![12];
        }
        let catlit = f
            .attr("CATLIT")
            .and_then(AttrValue::as_int_list)
            .unwrap_or_default();
        let valnmr = f
            .attr("VALNMR")
            .and_then(AttrValue::as_float)
            .unwrap_or(9.0);
        let directional = catlit.contains(&1) || catlit.contains(&16); // D6

        // sector sweep (S52CondRules.cpp:1129-1174)
        let sectr1 = f.attr("SECTR1").and_then(AttrValue::as_float);
        let sectr2 = f.attr("SECTR2").and_then(AttrValue::as_float);
        let lit_arc = match (sectr1, sectr2) {
            (Some(s1), Some(s2)) => {
                let sweep = if s1 > s2 { s2 - s1 + 360.0 } else { s2 - s1 };
                (1.0..360.0).contains(&sweep)
            }
            _ => false,
        };

        if lit_arc {
            derived.push(("lit_arc", AttrValue::Bool(true)));
            // Raw, unclamped VALNMR for the frontend's own radius mapping —
            // distinct from the scamin gate's [4,30] cap below.
            derived.push(("lit_range", AttrValue::Float(valnmr)));
        } else if directional {
            derived.push(("sym", AttrValue::Str("QUESMRK1".into())));
        } else if valnmr < 10.0 {
            derived.push(("sym", AttrValue::Str(flare_symbol(&colours).into())));
        } else {
            // All-round ring: same sector-lights overlay as the arc, sized
            // by radiusForRange(lit_range) — see lights-derive.md.
            derived.push(("lit_range", AttrValue::Float(valnmr)));
        }
        // Branch-independent by design; only `position_marked` withholds it.
        // See docs/architecture/light-position-star.md.
        if !position_marked {
            derived.push(("sym_star", AttrValue::Str(star_symbol(valnmr).into())));
        }
        // Every light form takes the same VALNMR-derived scamin gate, so the
        // server owns range-driven declutter uniformly (see lights-derive.md).
        gate_by_range(f, valnmr);

        // Flood/strip/spot adjunct, independent of sectors (:1097-1104). See
        // lights-derive.md for the LIGHTS82/LIGHTS81 vendoring rationale.
        if catlit.contains(&8) || catlit.contains(&11) {
            derived.push((
                "sym_extra",
                AttrValue::Str(format!("floodlight/{}", light_colour_word(&colours))),
            ));
        } else if catlit.contains(&9) {
            derived.push(("sym_extra", AttrValue::Str("LIGHTS81".into())));
        }

        derived.push(("lit_col", AttrValue::Str(light_colour(&colours).into())));

        let dsn = litdsn(f, 1.0);
        if !dsn.is_empty() {
            derived.push(("litdsn", AttrValue::Str(dsn.clone())));
            if f.attr("HEIGHT").and_then(AttrValue::as_float).is_some() {
                // ft/fm variants differ only in the HEIGHT term (S52Data.cpp:517-533)
                derived.push(("litdsn_ft", AttrValue::Str(litdsn(f, METERS_TO_FEET))));
                derived.push(("litdsn_fm", AttrValue::Str(litdsn(f, METERS_TO_FEET / 6.0))));
            }
        }

        for (k, v) in derived {
            f.attributes.insert(k.into(), v);
        }
    }
}

const METERS_TO_FEET: f64 = 3.2808399;

/// SCAMIN scale-denominator per nautical mile of VALNMR range. Matches the
/// frontend's own sector-arc/ring fade endpoint (`sectorGate.ts` `hideDenom`)
/// so a light stays on the wire exactly as long as its annotation is visible.
const SCAMIN_PER_NM: f64 = 60_000.0;

/// Caps (not just defaults) `f.scamin` to `60000*VALNMR` — see
/// docs/architecture/lights-derive.md for why a coarse charted SCAMIN must be
/// capped down rather than kept (constant-screen-size arcs/rings would
/// otherwise clutter a whole-country overview). A finer charted SCAMIN wins.
fn gate_by_range(f: &mut Feature, valnmr: f64) {
    let v = valnmr.clamp(4.0, 30.0);
    let range_gate = (SCAMIN_PER_NM * v).round() as u32;
    f.scamin = Some(match f.scamin {
        Some(charted) => charted.min(range_gate),
        None => range_gate,
    });
}

/// `s57-style.json`'s `light-star` icon pick, verbatim: strictly `> 10`, not
/// the ring branch's own `>= 10` — see docs/architecture/light-position-star.md.
fn star_symbol(valnmr: f64) -> &'static str {
    if valnmr > 10.0 {
        "light-major"
    } else {
        "light-minor"
    }
}

/// Flare symbol by colour set (`lightSymbol`, S52CondRules.cpp:720-748).
/// NOT [`light_colour_word`]'s bucket — orange/11 stays `light/generic` here
/// even though `light_colour` calls it LITYW; a real, pre-existing
/// divergence preserved verbatim, see docs/architecture/lights-derive.md.
fn flare_symbol(colours: &[i64]) -> &'static str {
    match colours {
        [c] => match c {
            3 => "light/red",
            4 => "light/green",
            1 | 6 | 9 => "light/yellow",
            _ => "light/generic",
        },
        [a, b] => {
            let has = |c: i64| *a == c || *b == c;
            if has(1) && has(3) {
                "light/red"
            } else if has(1) && has(4) {
                "light/green"
            } else {
                "light/generic"
            }
        }
        _ => "light/generic",
    }
}

/// [`light_colour`]'s CHART-token bucket, mapped onto the icon catalogue's
/// word set (red/green/yellow/generic). Floodlight adjunct only — unlike the
/// flare, it has no pre-existing colour rule to stay bug-compatible with, so
/// it simply reuses `lit_col`'s bucket.
fn light_colour_word(colours: &[i64]) -> &'static str {
    match light_colour(colours) {
        "LITRD" => "red",
        "LITGN" => "green",
        "LITYW" => "yellow",
        _ => "generic",
    }
}

/// Resolved light colour token — D7-unified yellow set {1,6,9,11}.
fn light_colour(colours: &[i64]) -> &'static str {
    match colours {
        [c] => match c {
            3 => "LITRD",
            4 => "LITGN",
            1 | 6 | 9 | 11 => "LITYW",
            _ => "CHMGD",
        },
        [a, b] => {
            let has = |c: i64| *a == c || *b == c;
            if has(1) && has(3) {
                "LITRD"
            } else if has(1) && has(4) {
                "LITGN"
            } else {
                "CHMGD"
            }
        }
        _ => "CHMGD",
    }
}

/// LITCHR code → (abbreviation, expects-two-signal-groups, postfix).
fn litchr_abbrev(code: i64) -> (&'static str, bool, &'static str) {
    match code {
        1 => ("F", false, ""),
        2 => ("Fl", false, ""),
        3 => ("LFl", false, ""),
        4 => ("Q", false, ""),
        5 => ("VQ", false, ""),
        6 => ("UQ", false, ""),
        7 => ("Iso", false, ""),
        8 => ("Occ", false, ""),
        9 => ("IQ", false, ""),
        10 => ("IVQ", false, ""),
        11 => ("IUQ", false, ""),
        12 => ("Mo", false, ""),
        13 => ("F + Fl", true, ""),
        14 => ("Fl + LFl", true, ""),
        15 => ("Occ + Fl", true, ""),
        16 => ("F + LFl", true, ""),
        17 => ("Al Occ", false, ""),
        18 => ("Al LFl", false, ""),
        19 => ("Al Fl", false, ""),
        20 => ("Al Grp", false, ""),
        21 | 23 => ("F", false, " (vert)"),
        22 | 24 => ("F", false, " (horz)"),
        25 => ("Q + LFl", true, ""),
        26 => ("VQ + LFl", true, ""),
        27 => ("UQ + LFl", true, ""),
        28 => ("Alt", false, ""),
        29 => ("F + Alt", true, ""),
        _ => ("", false, ""),
    }
}

/// `_LITDSN01` (S52CondRules.cpp:783-1091) with the height in metres
/// scaled by `height_scale` (1.0 → `m` suffix, ×3.28… → `ft`, /6 of that →
/// `fm`). Reproduces the C `printf` width padding exactly — the leading
/// space is the only separator (`" 5s"`, `"  5m"`).
fn litdsn(f: &Feature, height_scale: f64) -> String {
    let mut rt = String::new();

    // 1-2: LITCHR abbreviation, with the (?) group placeholder after the
    // first word when two signal groups are expected
    let (mut grp2, mut postfix) = (false, "");
    if let Some(litchr) = f.attr("LITCHR").and_then(AttrValue::as_int) {
        let (abbrev, g2, post) = litchr_abbrev(litchr);
        rt.push_str(abbrev);
        (grp2, postfix) = (g2, post);
    }
    if grp2 {
        if let Some(space) = rt.find(' ') {
            rt.insert_str(space, "(?)");
        }
    }

    // 3: SIGGRP, raw string like "(2)" or "(2)(3)"
    if let Some(grp) = f.attr("SIGGRP").and_then(AttrValue::as_str) {
        let grp = grp.replace(' ', "");
        if grp2 {
            let parts: Vec<&str> = grp.split(")(").collect();
            if parts.len() > 1 {
                rt = rt.replace("(?)", &format!("{})", parts[0]));
                if parts[1] != "1)" {
                    rt.push_str(&format!("({}", parts[1]));
                }
            }
        } else if grp != "(1)" {
            rt.push_str(&grp);
        }
    }

    // 4: colour letters in list order — applied even for sectored lights
    for c in f
        .attr("COLOUR")
        .and_then(AttrValue::as_int_list)
        .unwrap_or_default()
    {
        rt.push_str(match c {
            1 => "W",
            3 => "R",
            4 => "G",
            6 => "Y",
            _ => "",
        });
    }

    // 5: SIGPER — %4.1fs when fractional, %2.0fs otherwise
    if let Some(sigper) = f.attr("SIGPER").and_then(AttrValue::as_float) {
        if (sigper.round() - sigper).abs() > 0.01 {
            rt.push_str(&format!("{sigper:4.1}s"));
        } else {
            rt.push_str(&format!("{sigper:2.0}s"));
        }
    }

    // 6: HEIGHT — %3.0f + unit suffix
    if let Some(height) = f.attr("HEIGHT").and_then(AttrValue::as_float) {
        let (value, unit) = if height_scale == 1.0 {
            (height, "m")
        } else if height_scale > 1.0 {
            (height * height_scale, "ft")
        } else {
            (height * height_scale, "fm")
        };
        rt.push_str(&format!("{value:3.0}{unit}"));
    }

    // 7: VALNMR — only when SECTR1 absent
    if let Some(valnmr) = f.attr("VALNMR").and_then(AttrValue::as_float) {
        if f.attr("SECTR1").and_then(AttrValue::as_float).is_none() {
            rt.push_str(&format!("{valnmr:2.0}Nm"));
        }
    }

    rt.push_str(postfix);

    // 9: STATUS, first list value only
    if let Some(status) = f.attr("STATUS").and_then(AttrValue::as_int_list) {
        if let Some(first) = status.first() {
            rt.push_str(match first {
                2 => "(occas)",
                7 => "(temp)",
                8 => "(priv)",
                11 => "(exting)",
                17 => "(U)",
                _ => "",
            });
        }
    }
    rt
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::{Extent, WorldXy};
    use crate::model::{CellMeta, Geometry};
    use std::collections::BTreeMap;

    fn light(attrs: &[(&str, AttrValue)]) -> Feature {
        let map: BTreeMap<String, AttrValue> = attrs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();
        Feature::new(
            75,
            "LIGHTS".into(),
            map,
            Some(Geometry::Point(WorldXy::new(0, 0))),
        )
    }

    fn derive(attrs: &[(&str, AttrValue)]) -> Feature {
        let mut c = Cell {
            meta: CellMeta::default(),
            extent: Extent::invalid(),
            features: vec![light(attrs)],
        };
        apply(&mut c);
        c.features.remove(0)
    }

    fn s(f: &Feature, key: &str) -> Option<String> {
        f.attr(key).and_then(AttrValue::as_str).map(str::to_string)
    }

    /// Run `lights::apply` over a single light whose struct `scamin` is preset
    /// (as the decoder would from a charted SCAMIN), returning it afterwards.
    fn derive_with_scamin(scamin: u32, attrs: &[(&str, AttrValue)]) -> Feature {
        let mut l = light(attrs);
        l.scamin = Some(scamin);
        let mut c = Cell {
            meta: CellMeta::default(),
            extent: Extent::invalid(),
            features: vec![l],
        };
        apply(&mut c);
        c.features.remove(0)
    }

    #[test]
    fn scamin_capped_at_range_gate() {
        // VALNMR 22 Nm → range gate 60000·22 = 1320000.
        let range_gate = (SCAMIN_PER_NM * 22.0).round() as u32;
        assert_eq!(range_gate, 1_320_000);

        // No charted SCAMIN → the range gate outright.
        let f = derive(&[("VALNMR", AttrValue::Float(22.0))]);
        assert_eq!(f.scamin, Some(range_gate));

        // A very-small-scale charted SCAMIN (~1:1.5M, as major lights carry so an
        // ECDIS shows them on passage charts) is CAPPED to the range gate — else
        // the constant-screen-size arcs/rings clutter a whole-country overview
        // (user-reported regression). This is the fail→pass case.
        let f = derive_with_scamin(1_499_999, &[("VALNMR", AttrValue::Float(22.0))]);
        assert_eq!(
            f.scamin,
            Some(range_gate),
            "a coarse charted SCAMIN must be capped to the light's range gate"
        );

        // A charted SCAMIN finer than the range gate wins (chart wanted it
        // decluttered even sooner — keep it).
        let f = derive_with_scamin(200_000, &[("VALNMR", AttrValue::Float(22.0))]);
        assert_eq!(f.scamin, Some(200_000), "a finer charted SCAMIN is kept");
    }

    #[test]
    fn flare_by_colour() {
        for (colour, sym, col) in [
            ("3", "light/red", "LITRD"),
            ("4", "light/green", "LITGN"),
            ("1", "light/yellow", "LITYW"),
            ("6", "light/yellow", "LITYW"),
            ("9", "light/yellow", "LITYW"),
            ("1,3", "light/red", "LITRD"),
            ("3,1", "light/red", "LITRD"), // order-free pair
            ("1,4", "light/green", "LITGN"),
            ("5", "light/generic", "CHMGD"),
            ("1,3,4", "light/generic", "CHMGD"),
        ] {
            let list = AttrValue::StrList(colour.split(',').map(String::from).collect());
            let f = derive(&[("COLOUR", list), ("VALNMR", AttrValue::Float(5.0))]);
            assert_eq!(s(&f, "sym").as_deref(), Some(sym), "COLOUR {colour}");
            assert_eq!(s(&f, "lit_col").as_deref(), Some(col), "COLOUR {colour}");
            // a light with its own icon (flare/QUESMRK1) never also carries
            // lit_range — only the arc/ring cases the overlay draws need it.
            assert!(f.attr("lit_range").is_none());
        }
        // missing/empty COLOUR counts as magenta
        let f = derive(&[("VALNMR", AttrValue::Float(5.0))]);
        assert_eq!(s(&f, "sym").as_deref(), Some("light/generic"));
        assert_eq!(s(&f, "lit_col").as_deref(), Some("CHMGD"));
        let f = derive(&[
            ("COLOUR", AttrValue::StrList(vec![])),
            ("VALNMR", AttrValue::Float(5.0)),
        ]);
        assert_eq!(s(&f, "sym").as_deref(), Some("light/generic"));
        // VALNMR defaults to 9 (< 10): flare without VALNMR
        let f = derive(&[("COLOUR", AttrValue::StrList(vec!["3".into()]))]);
        assert_eq!(s(&f, "sym").as_deref(), Some("light/red"));
        // orange (11) is LITYW under D7 even though the flare would be light/generic
        let f = derive(&[("COLOUR", AttrValue::StrList(vec!["11".into()]))]);
        assert_eq!(s(&f, "sym").as_deref(), Some("light/generic"));
        assert_eq!(s(&f, "lit_col").as_deref(), Some("LITYW"));
    }

    #[test]
    fn ring_case_carries_lit_range() {
        // All-round major-light ring (no sector, VALNMR >= 10): no sym, and
        // now carries raw lit_range like the arc does — the frontend
        // overlay sizes the ring off it via the same radiusForRange as the
        // arc (slsynkln), replacing the retired per-colour `lit_ring_off`
        // pixel offset. EXCLIT's fog-detector inset is applied frontend-side
        // off the raw EXCLIT attribute, identically to the arc — no colour
        // or fog handling left to do here.
        for colour in ["3", "4", "1", "12", "5", "1,3", "1,4", "2,5", "1,3,4"] {
            let list = AttrValue::StrList(colour.split(',').map(String::from).collect());
            let f = derive(&[("COLOUR", list), ("VALNMR", AttrValue::Float(15.0))]);
            assert!(
                f.attr("sym").is_none(),
                "COLOUR {colour}: ring case has no sym"
            );
            assert_eq!(
                f.attr("lit_range"),
                Some(&AttrValue::Float(15.0)),
                "COLOUR {colour}"
            );
        }
    }

    /// The two branches that emit no `sym` — all-round ring and sector arc —
    /// carry `sym_star` like every other light, so the annotation the overlay
    /// draws AROUND them still has its centre marked. (szrwnlum's original
    /// case; stlozvlo widened it to all four branches, see
    /// `every_light_carries_a_position_star`.) Icon pick follows
    /// `s57-style.json`'s `light-star` literally
    /// (`> 10` -> major), which is NOT the ring branch's own `>= 10` test:
    /// a light at exactly 10 nm draws a ring and a MINOR star.
    #[test]
    fn ring_and_arc_carry_a_position_star() {
        // ring branch (no sector, VALNMR >= 10)
        for (valnmr, star) in [
            (10.0, "light-minor"),
            (10.5, "light-major"),
            (25.0, "light-major"),
        ] {
            let f = derive(&[
                ("COLOUR", AttrValue::StrList(vec!["3".into()])),
                ("VALNMR", AttrValue::Float(valnmr)),
            ]);
            assert!(f.attr("sym").is_none(), "VALNMR {valnmr}: ring has no sym");
            assert_eq!(s(&f, "sym_star").as_deref(), Some(star), "VALNMR {valnmr}");
        }
        // arc branch — a sector at any range, including below 10 nm and with
        // no VALNMR at all (the local default 9 -> minor). Upstream's
        // `["has","VALNMR"]` filter would draw nothing for the last case;
        // it still draws an arc with nothing at the light, so we star it.
        for (attr, star) in [
            (Some(3.0), "light-minor"),
            (Some(10.0), "light-minor"),
            (Some(22.0), "light-major"),
            (None, "light-minor"),
        ] {
            let mut attrs: Vec<(&str, AttrValue)> = vec![
                ("SECTR1", AttrValue::Float(45.0)),
                ("SECTR2", AttrValue::Float(135.0)),
                ("COLOUR", AttrValue::StrList(vec!["3".into()])),
            ];
            if let Some(v) = attr {
                attrs.push(("VALNMR", AttrValue::Float(v)));
            }
            let f = derive(&attrs);
            assert_eq!(f.attr("lit_arc"), Some(&AttrValue::Bool(true)));
            assert!(f.attr("sym").is_none());
            assert_eq!(s(&f, "sym_star").as_deref(), Some(star), "VALNMR {attr:?}");
        }
    }

    /// stlozvlo: EVERY light carries a position star, whichever of the four
    /// branches it takes — the reversal of szrwnlum's narrowing (see the
    /// module doc's `sym_star` entry). This is the half-fix guard: the defect
    /// was "four branches, two remembered", so assert all four by name.
    #[test]
    fn every_light_carries_a_position_star() {
        let cases: [(&str, Vec<(&str, AttrValue)>, &str, Option<&str>); 4] = [
            (
                "flare (VALNMR < 10, no sector, not directional)",
                vec![
                    ("COLOUR", AttrValue::StrList(vec!["3".into()])),
                    ("VALNMR", AttrValue::Float(5.0)),
                ],
                "light-minor",
                Some("light/red"),
            ),
            (
                "directional -> QUESMRK1, even at a ring-sized range",
                vec![
                    ("CATLIT", AttrValue::IntList(vec![1])),
                    ("COLOUR", AttrValue::StrList(vec!["3".into()])),
                    ("VALNMR", AttrValue::Float(25.0)),
                ],
                "light-major",
                Some("QUESMRK1"),
            ),
            (
                "all-round ring (no sector, VALNMR >= 10)",
                vec![
                    ("COLOUR", AttrValue::StrList(vec!["3".into()])),
                    ("VALNMR", AttrValue::Float(15.0)),
                ],
                "light-major",
                None,
            ),
            (
                "sector arc",
                vec![
                    ("SECTR1", AttrValue::Float(45.0)),
                    ("SECTR2", AttrValue::Float(135.0)),
                    ("COLOUR", AttrValue::StrList(vec!["3".into()])),
                    ("VALNMR", AttrValue::Float(5.0)),
                ],
                "light-minor",
                None,
            ),
        ];
        for (what, attrs, star, sym) in cases {
            let f = derive(&attrs);
            assert_eq!(s(&f, "sym_star").as_deref(), Some(star), "{what}");
            assert_eq!(s(&f, "sym").as_deref(), sym, "{what}");
        }

        // The bare standalone minor light the user reported: no buoy/beacon
        // body anywhere near it, no sector, no VALNMR at all (local default
        // 9 -> minor). It used to draw a lone off-centre flare and nothing on
        // the position itself. Upstream's `["has","VALNMR"]` filter would
        // draw no star here either; we are a superset, deliberately.
        let f = derive(&[("COLOUR", AttrValue::StrList(vec!["3".into()]))]);
        assert_eq!(s(&f, "sym").as_deref(), Some("light/red"));
        assert_eq!(s(&f, "sym_star").as_deref(), Some("light-minor"));

        // The `> 10` icon boundary is branch-independent: it is the reference
        // layer's own test, not the ring branch's `>= 10`.
        for (valnmr, star) in [
            (9.9, "light-minor"),
            (10.0, "light-minor"),
            (10.1, "light-major"),
        ] {
            let f = derive(&[
                ("CATLIT", AttrValue::IntList(vec![1])), // directional branch
                ("VALNMR", AttrValue::Float(valnmr)),
            ]);
            assert_eq!(s(&f, "sym_star").as_deref(), Some(star), "VALNMR {valnmr}");
        }
    }

    /// mtxkkkom: the star marks a position that is OTHERWISE UNMARKED, so a
    /// light sitting on a charted body does not get one — the body IS the
    /// position mark, and stacking a star on it is the redundant clutter the
    /// user reported. The predicate is co-location, NOT the light's branch and
    /// NOT the body's class: any non-LIGHTS feature at the same point that
    /// bakes a position symbol suppresses it, which is the broad rule the user
    /// chose (buoys, beacons, landmarks — all of them).
    #[test]
    fn a_light_on_a_charted_body_draws_no_star() {
        // Every attribute name that means "I draw a symbol on my own point",
        // and one class per family, so the rule cannot quietly narrow to buoys.
        for (acronym, key) in [
            ("BOYLAT", "sym_s"),  // buoy body, from derive::aton
            ("BOYCAR", "sym_s"),  // ... another one
            ("BCNLAT", "sym_s"),  // beacon body
            ("LNDMRK", "sym"),    // landmark / structure
            ("RESARE", "sym_cs"), // anything else with a centred point symbol
        ] {
            let mut body = Feature::new(
                1,
                acronym.into(),
                BTreeMap::new(),
                Some(Geometry::Point(WorldXy::new(0, 0))),
            );
            body.attributes
                .insert(key.into(), AttrValue::Str("whatever".into()));
            let mut c = Cell {
                meta: CellMeta::default(),
                extent: Extent::invalid(),
                features: vec![
                    body,
                    light(&[("COLOUR", AttrValue::StrList(vec!["3".into()]))]),
                ],
            };
            apply(&mut c);
            let f = &c.features[1];
            assert_eq!(s(f, "sym_star"), None, "{acronym} ({key}) should suppress");
            // ... and only the star: the flare and the rest are untouched.
            assert_eq!(s(f, "sym").as_deref(), Some("light/red"), "{acronym}");
        }
    }

    /// The three ways a neighbour must NOT satisfy the predicate. Each of
    /// these silently reintroduces a shipped bug if it does.
    #[test]
    fn only_a_real_co_located_position_symbol_suppresses_the_star() {
        let lit = |extra: Vec<Feature>| {
            let mut features = extra;
            features.push(light(&[("COLOUR", AttrValue::StrList(vec!["3".into()]))]));
            let mut c = Cell {
                meta: CellMeta::default(),
                extent: Extent::invalid(),
                features,
            };
            apply(&mut c);
            s(c.features.last().unwrap(), "sym_star")
        };
        let at = |acronym: &str, key: &str, x: i32| {
            let mut f = Feature::new(
                1,
                acronym.into(),
                BTreeMap::new(),
                Some(Geometry::Point(WorldXy::new(x, 0))),
            );
            f.attributes
                .insert(key.into(), AttrValue::Str("whatever".into()));
            f
        };

        // A body somewhere ELSE in the cell marks nothing here.
        assert_eq!(
            lit(vec![at("BOYLAT", "sym_s", 5)]).as_deref(),
            Some("light-minor")
        );
        // A co-located body with no symbol of its own marks nothing either.
        let mut bare = at("BOYLAT", "sym_s", 0);
        bare.attributes.remove("sym_s");
        assert_eq!(lit(vec![bare]).as_deref(), Some("light-minor"));
        // A TOPMAR stacks ABOVE the body, so it is not a position mark.
        assert_eq!(
            lit(vec![at("TOPMAR", "sym_topmark", 0)]).as_deref(),
            Some("light-minor")
        );
        // A SECOND light at the same point does not mark it: `-lights-sym` is
        // rotated and offset [0,2] AWAY from the position. This is the exact
        // shape of the bug stlozvlo fixed, so it is pinned here, not assumed.
        assert_eq!(
            lit(vec![light(&[(
                "COLOUR",
                AttrValue::StrList(vec!["1".into()])
            )])])
            .as_deref(),
            Some("light-minor")
        );
    }

    /// The star must not escape the VALNMR declutter gate `gate_by_range`
    /// applies to every light form: it rides the SAME feature as the ring/arc
    /// it marks, so it carries that feature's `scamin` by construction and
    /// cannot outlive the annotation it belongs to.
    #[test]
    fn the_star_rides_the_same_range_gate_as_its_ring() {
        let f = derive(&[
            ("COLOUR", AttrValue::StrList(vec!["3".into()])),
            ("VALNMR", AttrValue::Float(15.0)),
        ]);
        assert!(f.attr("sym_star").is_some());
        // 60000·15, the same gate the ring itself rides
        assert_eq!(f.scamin, Some(900_000));
        // and a coarse charted SCAMIN is still capped to it
        let f = derive_with_scamin(
            1_499_999,
            &[
                ("COLOUR", AttrValue::StrList(vec!["3".into()])),
                ("VALNMR", AttrValue::Float(15.0)),
            ],
        );
        assert!(f.attr("sym_star").is_some());
        assert_eq!(f.scamin, Some(900_000));
    }

    #[test]
    fn icon_lights_get_valnmr_scamin_gate() {
        // flare: scamin = 60000·VALNMR
        let f = derive(&[
            ("COLOUR", AttrValue::StrList(vec!["3".into()])),
            ("VALNMR", AttrValue::Float(5.0)),
        ]);
        assert_eq!(f.scamin, Some(300_000));
        // absent VALNMR -> default 9
        let f = derive(&[("COLOUR", AttrValue::StrList(vec!["3".into()]))]);
        assert_eq!(f.scamin, Some(540_000));
        // clamp low end to 4 nm
        let f = derive(&[
            ("COLOUR", AttrValue::StrList(vec!["3".into()])),
            ("VALNMR", AttrValue::Float(1.0)),
        ]);
        assert_eq!(f.scamin, Some(240_000));
        // directional (QUESMRK1) is an icon too -> gated; clamp high end to 30
        let f = derive(&[
            ("CATLIT", AttrValue::IntList(vec![1])),
            ("COLOUR", AttrValue::StrList(vec!["3".into()])),
            ("VALNMR", AttrValue::Float(50.0)),
        ]);
        assert_eq!(s(&f, "sym").as_deref(), Some("QUESMRK1"));
        assert_eq!(f.scamin, Some(1_800_000));

        // rings and arcs now ALSO get the VALNMR gate — the filtering moved
        // server-side, so every light form carries the same 60000·VALNMR scamin
        let f = derive(&[
            ("COLOUR", AttrValue::StrList(vec!["3".into()])),
            ("VALNMR", AttrValue::Float(15.0)),
        ]);
        assert!(f.attr("lit_range").is_some());
        assert_eq!(f.scamin, Some(900_000)); // 60000·15
        let f = derive(&[
            ("SECTR1", AttrValue::Float(45.0)),
            ("SECTR2", AttrValue::Float(135.0)),
            ("COLOUR", AttrValue::StrList(vec!["3".into()])),
            ("VALNMR", AttrValue::Float(5.0)),
        ]);
        assert_eq!(f.attr("lit_arc"), Some(&AttrValue::Bool(true)));
        assert_eq!(f.scamin, Some(300_000)); // 60000·5

        // a real charted SCAMIN wins — never overridden
        let f = derive(&[
            ("COLOUR", AttrValue::StrList(vec!["3".into()])),
            ("VALNMR", AttrValue::Float(5.0)),
            ("SCAMIN", AttrValue::Int(29_999)),
        ]);
        assert_eq!(f.scamin, Some(29_999));
    }

    #[test]
    fn directional_light_is_quesmrk() {
        for catlit in [vec![1], vec![16], vec![4, 16]] {
            let f = derive(&[
                ("CATLIT", AttrValue::IntList(catlit.clone())),
                ("COLOUR", AttrValue::StrList(vec!["3".into()])),
                ("VALNMR", AttrValue::Float(15.0)),
            ]);
            assert_eq!(
                s(&f, "sym").as_deref(),
                Some("QUESMRK1"),
                "CATLIT {catlit:?}"
            );
            assert!(f.attr("lit_range").is_none());
        }
        // 14 is NOT directional for us (the reference's \016 bug, D6)
        let f = derive(&[
            ("CATLIT", AttrValue::IntList(vec![14])),
            ("COLOUR", AttrValue::StrList(vec!["3".into()])),
        ]);
        assert_eq!(s(&f, "sym").as_deref(), Some("light/red"));
    }

    #[test]
    fn sector_arc_marker() {
        let sect = |s1: f64, s2: f64| {
            derive(&[
                ("SECTR1", AttrValue::Float(s1)),
                ("SECTR2", AttrValue::Float(s2)),
                ("COLOUR", AttrValue::StrList(vec!["3".into()])),
            ])
        };
        let f = sect(45.0, 135.0);
        assert_eq!(f.attr("lit_arc"), Some(&AttrValue::Bool(true)));
        assert!(f.attr("sym").is_none());
        // wrap-around sweep
        assert!(sect(350.0, 10.0).attr("lit_arc").is_some());
        // degenerate sweeps are not arcs
        assert!(sect(10.0, 10.5).attr("lit_arc").is_none());
        assert!(sect(0.0, 360.0).attr("lit_arc").is_none());
        // only one sector attribute -> not an arc
        let f = derive(&[
            ("SECTR1", AttrValue::Float(45.0)),
            ("COLOUR", AttrValue::StrList(vec!["3".into()])),
        ]);
        assert!(f.attr("lit_arc").is_none());
    }

    #[test]
    fn arc_carries_raw_valnmr_as_lit_range() {
        // VALNMR rides the arc feature raw (unclamped) — the frontend does its
        // own clamp/log-scale for the radius mapping (tpkonpry).
        let f = derive(&[
            ("SECTR1", AttrValue::Float(45.0)),
            ("SECTR2", AttrValue::Float(135.0)),
            ("COLOUR", AttrValue::StrList(vec!["3".into()])),
            ("VALNMR", AttrValue::Float(22.0)),
        ]);
        assert_eq!(f.attr("lit_range"), Some(&AttrValue::Float(22.0)));

        // out-of-[4,30]-range values still ride raw — no server-side clamp.
        let f = derive(&[
            ("SECTR1", AttrValue::Float(45.0)),
            ("SECTR2", AttrValue::Float(135.0)),
            ("COLOUR", AttrValue::StrList(vec!["3".into()])),
            ("VALNMR", AttrValue::Float(50.0)),
        ]);
        assert_eq!(f.attr("lit_range"), Some(&AttrValue::Float(50.0)));

        // default VALNMR (9.0, when absent) still rides the arc.
        let f = derive(&[
            ("SECTR1", AttrValue::Float(45.0)),
            ("SECTR2", AttrValue::Float(135.0)),
            ("COLOUR", AttrValue::StrList(vec!["3".into()])),
        ]);
        assert_eq!(f.attr("lit_range"), Some(&AttrValue::Float(9.0)));

        // a light with its own icon (flare, VALNMR < 10) never carries
        // lit_range — only the arc and ring cases the overlay draws need it.
        let f = derive(&[
            ("COLOUR", AttrValue::StrList(vec!["3".into()])),
            ("VALNMR", AttrValue::Float(5.0)),
        ]);
        assert!(f.attr("lit_range").is_none());

        // the non-arc ring case (VALNMR >= 10, no sector) ALSO carries
        // lit_range now (slsynkln) — see `ring_case_carries_lit_range`.
        let f = derive(&[
            ("COLOUR", AttrValue::StrList(vec!["3".into()])),
            ("VALNMR", AttrValue::Float(22.0)),
        ]);
        assert_eq!(f.attr("lit_range"), Some(&AttrValue::Float(22.0)));
    }

    #[test]
    fn sym_extra_is_sector_independent() {
        // No COLOUR set here -> the "generic"/magenta bucket for the
        // colour-parametric floodlight case; see `sym_extra_floodlight_is_colour_parametric`
        // for the red/green/yellow buckets.
        for (catlit, sym) in [
            (vec![8], Some("floodlight/generic")),
            (vec![11], Some("floodlight/generic")),
            (vec![9], Some("LIGHTS81")),
            (vec![8, 9], Some("floodlight/generic")), // 8|11 wins over 9
            (vec![4], None),
        ] {
            let f = derive(&[
                ("CATLIT", AttrValue::IntList(catlit.clone())),
                ("SECTR1", AttrValue::Float(0.0)),
                ("SECTR2", AttrValue::Float(90.0)),
            ]);
            assert_eq!(s(&f, "sym_extra").as_deref(), sym, "CATLIT {catlit:?}");
        }
    }

    #[test]
    fn sym_extra_floodlight_is_colour_parametric() {
        // The floodlight adjunct (CATLIT 8/11) rides the SAME red/green/
        // yellow/generic bucket as the flare (`light_colour_word`) — a
        // red light's floodlight adjunct is `floodlight/red`, not a fixed
        // colour, matching quantenschaum's own `"floodlight/" + COLOUR`.
        for (colour, extra) in [
            ("3", "floodlight/red"),
            ("4", "floodlight/green"),
            ("1", "floodlight/yellow"),
        ] {
            let list = AttrValue::StrList(colour.split(',').map(String::from).collect());
            let f = derive(&[
                ("CATLIT", AttrValue::IntList(vec![8])),
                ("COLOUR", list),
                ("SECTR1", AttrValue::Float(0.0)),
                ("SECTR2", AttrValue::Float(90.0)),
            ]);
            assert_eq!(
                s(&f, "sym_extra").as_deref(),
                Some(extra),
                "COLOUR {colour}"
            );
        }
    }

    #[test]
    fn litdsn_spec_example() {
        // specs-12.md §5.1: Fl(3)R10s 12m 5Nm
        let f = derive(&[
            ("LITCHR", AttrValue::Int(2)),
            ("SIGGRP", AttrValue::Str("(3)".into())),
            ("COLOUR", AttrValue::StrList(vec!["3".into()])),
            ("SIGPER", AttrValue::Float(10.0)),
            ("HEIGHT", AttrValue::Float(12.0)),
            ("VALNMR", AttrValue::Float(5.0)),
        ]);
        assert_eq!(s(&f, "litdsn").as_deref(), Some("Fl(3)R10s 12m 5Nm"));
        // height variants: 12 m = 39.4 ft = 6.6 fm
        assert_eq!(s(&f, "litdsn_ft").as_deref(), Some("Fl(3)R10s 39ft 5Nm"));
        assert_eq!(s(&f, "litdsn_fm").as_deref(), Some("Fl(3)R10s  7fm 5Nm"));
    }

    #[test]
    fn litdsn_formatting_details() {
        // (1) group suppressed; fractional period; C-style width padding
        let f = derive(&[
            ("LITCHR", AttrValue::Int(2)),
            ("SIGGRP", AttrValue::Str("(1)".into())),
            ("COLOUR", AttrValue::StrList(vec!["4".into()])),
            ("SIGPER", AttrValue::Float(2.5)),
            ("HEIGHT", AttrValue::Float(4.6)),
            ("VALNMR", AttrValue::Float(4.0)),
        ]);
        assert_eq!(s(&f, "litdsn").as_deref(), Some("FlG 2.5s  5m 4Nm"));

        // two-group characteristic: first group replaces the (?) slot
        let f = derive(&[
            ("LITCHR", AttrValue::Int(13)), // "F + Fl", grp2
            ("SIGGRP", AttrValue::Str("(2)(3)".into())),
            ("COLOUR", AttrValue::StrList(vec!["1".into()])),
        ]);
        assert_eq!(s(&f, "litdsn").as_deref(), Some("F(2) + Fl(3)W"));
        // second group "(1)" is dropped
        let f = derive(&[
            ("LITCHR", AttrValue::Int(13)),
            ("SIGGRP", AttrValue::Str("(2)(1)".into())),
        ]);
        assert_eq!(s(&f, "litdsn").as_deref(), Some("F(2) + Fl"));

        // vert postfix and STATUS abbreviation (first value only)
        let f = derive(&[
            ("LITCHR", AttrValue::Int(21)),
            ("COLOUR", AttrValue::StrList(vec!["3".into()])),
            ("STATUS", AttrValue::StrList(vec!["8".into(), "2".into()])),
        ]);
        assert_eq!(s(&f, "litdsn").as_deref(), Some("FR (vert)(priv)"));

        // VALNMR suppressed for sectored lights; colours still appended
        let f = derive(&[
            ("LITCHR", AttrValue::Int(2)),
            ("COLOUR", AttrValue::StrList(vec!["3".into()])),
            ("VALNMR", AttrValue::Float(12.0)),
            ("SECTR1", AttrValue::Float(0.0)),
            ("SECTR2", AttrValue::Float(90.0)),
        ]);
        assert_eq!(s(&f, "litdsn").as_deref(), Some("FlR"));

        // nothing to say -> no litdsn at all
        let f = derive(&[("COLOUR", AttrValue::StrList(vec!["2".into()]))]);
        assert!(f.attr("litdsn").is_none());
        assert!(f.attr("litdsn_ft").is_none());
    }

    #[test]
    fn litdsn_height_variants_only_with_height() {
        let f = derive(&[
            ("LITCHR", AttrValue::Int(2)),
            ("COLOUR", AttrValue::StrList(vec!["6".into()])),
            ("SIGPER", AttrValue::Float(2.0)),
        ]);
        assert_eq!(s(&f, "litdsn").as_deref(), Some("FlY 2s"));
        assert!(f.attr("litdsn_ft").is_none());
        assert!(f.attr("litdsn_fm").is_none());
    }
}
