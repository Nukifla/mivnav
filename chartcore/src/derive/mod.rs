// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Settings-independent derived-fact pass: computes facts on the decoded
//! cell before tiling, so comparisons against user settings live only in
//! the client-side style. See docs/architecture/derive-facts.md.

pub mod aid_group;
pub mod aton;
pub mod bridges;
pub mod cables;
pub mod hazards;
pub mod industrial;
pub mod lights;
pub mod lndmrk;
pub mod restricted;
pub mod sbdare;
pub mod stations;
pub mod tss;
pub mod waterways;

use crate::model::{AttrValue, Cell, Feature, Geometry};
use crate::s52::{LupTable, S52Data};

/// Object class acronyms getting `drval1`/`drval2`.
const DEPTH_AREAS: [&str; 2] = ["DEPARE", "DRGARE"];

/// Object class acronyms getting the `quapos` lift. The Phase 5 hazard
/// classes are included: CSQUAPNT01 and the hazard boundary styles branch
/// on the same lifted value.
const QUAPOS_CLASSES: [&str; 7] = [
    "COALNE", "SLCONS", "DEPCNT", "LNDARE", "WRECKS", "OBSTRN", "UWTROC",
];

/// Idempotent. Equivalent to [`apply_with`] without S-52 lookup data:
/// everything except ATON `sym_*`/`lbl_*` resolution, which needs
/// `chartsymbols.xml`.
pub fn apply(cell: &mut Cell) {
    apply_with(cell, None);
}

/// Run all derived-fact computations, resolving ATON point symbols against
/// the S-52 lookup tables when provided. Idempotent.
pub fn apply_with(cell: &mut Cell, s52: Option<&S52Data>) {
    depth_area_range(cell);
    contour_prev(cell); // after depth_area_range: reads derived drval1
    contour_native_scamin(cell);
    quapos(cell);
    catlnd_marsh(cell);
    hazards::apply(cell); // after depth_area_range (encl_drval1) and quapos
    restricted::apply(cell);
    cables::apply(cell);
    bridges::apply(cell);
    tss::apply(cell);
    waterways::apply(cell);
    industrial::apply(cell);
    lndmrk::apply(cell);
    sbdare::apply(cell);
    stations::apply(cell);
    aton::apply(cell, s52);
    // AFTER aton (mtxkkkom): a light's position star is withheld when a
    // co-located feature already marks the point, via aton's `sym_s`.
    lights::apply(cell);
    aid_group::apply(cell); // settings-independent LNAM_REFS/co-location join
    scamin(cell, s52); // last: reads the CS-derived `dispcat`
}

/// `drval1`/`drval2` for depth and dredged areas (see module docs).
fn depth_area_range(cell: &mut Cell) {
    for f in &mut cell.features {
        if !DEPTH_AREAS.contains(&f.acronym.as_str()) {
            continue;
        }
        let raw1 = f.attr("DRVAL1").and_then(AttrValue::as_float);
        if raw1.is_none() && f.acronym == "DRGARE" {
            continue; // DEPARE01: attribute-less DRGARE renders DEPMD
        }
        let drval1 = raw1.unwrap_or(-1.0);
        let drval2 = f
            .attr("DRVAL2")
            .and_then(AttrValue::as_float)
            .unwrap_or(drval1 + 0.01);
        f.attributes
            .insert("drval1".into(), AttrValue::Float(drval1));
        f.attributes
            .insert("drval2".into(), AttrValue::Float(drval2));
    }
}

/// `valdco_prev` for depth contours and line-primitive DEPARE (see module
/// docs).
fn contour_prev(cell: &mut Cell) {
    let mut values: Vec<f64> = cell
        .features_of("DEPCNT")
        .filter_map(|f| f.attr("VALDCO").and_then(AttrValue::as_float))
        .collect();
    values.sort_by(f64::total_cmp);
    values.dedup();
    // predecessor: the largest distinct VALDCO strictly below `depth`
    let prev = |depth: f64| {
        let idx = values.partition_point(|v| *v < depth);
        (idx > 0).then(|| values[idx - 1])
    };
    for f in &mut cell.features {
        let depth = match f.acronym.as_str() {
            "DEPCNT" => f.attr("VALDCO").and_then(AttrValue::as_float),
            // line DEPARE draws as a contour of depth drval1 (DEPCNT02);
            // only a drval1 that IS a cell contour value can be the next
            // safety contour, so snap within 1e-4 or omit
            "DEPARE" if matches!(f.geometry, Some(Geometry::Lines(_))) => f
                .attr("drval1")
                .and_then(AttrValue::as_float)
                .and_then(|d| values.iter().find(|v| (*v - d).abs() < 1e-4).copied()),
            _ => None,
        };
        if let Some(p) = depth.and_then(prev) {
            f.attributes
                .insert("valdco_prev".into(), AttrValue::Float(p));
        }
    }
}

/// Is this feature the DEPCNT source-layer (see module docs and
/// [`crate::mvt::layer_name`]'s routing of line-primitive DEPARE into it)?
fn is_contour_layer_feature(f: &Feature) -> bool {
    f.acronym == "DEPCNT"
        || (f.acronym == "DEPARE" && matches!(f.geometry, Some(Geometry::Lines(_))))
}

/// Synthetic SCAMIN-equivalent for DEPCNT / line-primitive DEPARE, since they
/// rarely carry a real SCAMIN and would otherwise never declutter. See
/// docs/architecture/derive-facts.md.
fn contour_native_scamin(cell: &mut Cell) {
    let native_min_zoom = crate::mvt::zoom_range_for_scale(cell.meta.compilation_scale).0;
    let native_scamin = crate::mvt::display_scale_denom(native_min_zoom).ceil() as i64;
    for f in &mut cell.features {
        if !is_contour_layer_feature(f) {
            continue;
        }
        f.attributes
            .insert("native_scamin".into(), AttrValue::Int(native_scamin));
    }
}

/// `quapos` positional-quality lift (see module docs).
fn quapos(cell: &mut Cell) {
    fn worst(f: &Feature) -> Option<i64> {
        f.spatial_quapos
            .iter()
            .copied()
            .chain(f.attr("QUAPOS").and_then(AttrValue::as_int))
            .filter(|q| (2..10).contains(q))
            .max()
    }
    for f in &mut cell.features {
        if !QUAPOS_CLASSES.contains(&f.acronym.as_str()) {
            continue;
        }
        if let Some(q) = worst(f) {
            f.attributes.insert("quapos".into(), AttrValue::Int(q));
        }
    }
}

/// `catlnd_marsh` for land regions (see module docs). Emitted only when
/// true — absence is the false case, like every other derived flag.
fn catlnd_marsh(cell: &mut Cell) {
    for f in &mut cell.features {
        if f.acronym != "LNDRGN" {
            continue;
        }
        let marsh = f
            .attr("CATLND")
            .and_then(AttrValue::as_int_list)
            .is_some_and(|codes| codes.iter().any(|c| *c == 2 || *c == 12));
        if marsh {
            f.attributes
                .insert("catlnd_marsh".into(), AttrValue::Bool(true));
        }
    }
}

/// Synthetic SCAMIN for a point symbol with no charted SCAMIN (the DAYMAR
/// bug: without it, `None` read as "render at every scale"). See
/// docs/architecture/derive-facts.md.
const DEFAULT_POINT_SCAMIN: i64 = 45_000;

/// Synthetic SCAMIN for an **area** object with a CS-resolved fixed-pixel
/// `sym` — coarser than [`DEFAULT_POINT_SCAMIN`], which made a real TSS lane
/// invisible. See docs/architecture/derive-facts.md.
const DEFAULT_AREA_SYMBOL_SCAMIN: i64 = 350_000;

/// How far past its cell's compilation scale an uncharted `LNDARE` point
/// stays visible. OpenCPN's Super SCAMIN multiplier (`s52plib.cpp:10903`),
/// also where its `s57chart::GetNormalScaleMax` ends a cell's normal range.
const LAND_POINT_SCAMIN_FACTOR: i64 = 4;

/// SCAMIN as a *gate*, emitted only for features S-52 may hide; a charted
/// SCAMIN wins, a non-exempt point symbol without one gets the synthetic
/// default. Without S-52 lookup tables nothing is gated. See
/// docs/architecture/derive-facts.md.
fn scamin(cell: &mut Cell, s52: Option<&S52Data>) {
    let Some(s52) = s52 else { return };
    let cell_scale = cell.meta.compilation_scale;
    for f in &mut cell.features {
        if let Some(value) = land_point_scamin(f, cell_scale) {
            f.attributes.insert("scamin".into(), AttrValue::Int(value));
            continue;
        }
        if scamin_exempt(f, s52) {
            continue;
        }
        let value = match f.scamin {
            Some(v) => i64::from(v),
            None if matches!(
                f.geometry,
                Some(Geometry::Point(_) | Geometry::MultiPoint(_))
            ) =>
            {
                DEFAULT_POINT_SCAMIN
            }
            None if renders_as_symbol(f) => DEFAULT_AREA_SYMBOL_SCAMIN,
            None => continue,
        };
        f.attributes.insert("scamin".into(), AttrValue::Int(value));
    }
}

/// The gate for an `LNDARE` point: a deliberate exception to the DISPLAYBASE
/// bypass, for land areas only make sense without one. A charted SCAMIN wins,
/// otherwise 4× the cell's compilation scale. `None` for anything else, and
/// for a point in a cell with no known scale, which stays ungated. See
/// docs/architecture/derive-facts.md.
fn land_point_scamin(f: &Feature, cell_scale: u32) -> Option<i64> {
    if f.acronym != "LNDARE"
        || !matches!(
            f.geometry,
            Some(Geometry::Point(_) | Geometry::MultiPoint(_))
        )
    {
        return None;
    }
    f.scamin
        .map(i64::from)
        .or_else(|| (cell_scale > 0).then(|| i64::from(cell_scale) * LAND_POINT_SCAMIN_FACTOR))
}

/// A non-point feature a CS procedure resolved a `sym` onto (e.g. RESTRN01's
/// TSSLPT arrow) draws as a fixed-pixel icon like a real point symbol, so it
/// needs the same synthetic-SCAMIN treatment. See docs/architecture/derive-facts.md.
fn renders_as_symbol(f: &Feature) -> bool {
    f.attr("sym").is_some()
}

/// A CS-computed display category wins over the LUP's. Exemption over a
/// Simplified/Paper or Plain/Symbolized pair is the **intersection**, not
/// the union — the union wrongly exempted charted-SCAMIN rows (#mkvsousw).
fn scamin_exempt(f: &Feature, s52: &S52Data) -> bool {
    if f.attr("dispcat").and_then(AttrValue::as_str) == Some("base") {
        return true;
    }
    let tables: &[LupTable] = match f.geometry {
        Some(Geometry::Point(_) | Geometry::MultiPoint(_)) => {
            &[LupTable::Simplified, LupTable::PaperChart]
        }
        Some(Geometry::Lines(_)) => &[LupTable::Lines],
        Some(Geometry::Areas(_)) => &[LupTable::PlainBoundaries, LupTable::SymbolizedBoundaries],
        None => return true, // nothing rendered, nothing to gate
    };
    for table in tables {
        let Some(lup) = s52.find_lup(*table, &f.acronym, &f.attributes) else {
            continue; // this setting has no row for the class: abstain
        };
        if !(lup.disp_prio == 1 || lup.display_cat == "displaybase") {
            return false; // some setting renders it as an ordinary gated object
        }
    }
    // unresolvable class or every resolved table exempts: safe to exempt
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{CellMeta, Feature};
    use std::collections::BTreeMap;

    fn feature(acronym: &str, attrs: &[(&str, AttrValue)]) -> Feature {
        let map: BTreeMap<String, AttrValue> = attrs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();
        Feature::new(0, acronym.into(), map, None)
    }

    fn cell(features: Vec<Feature>) -> Cell {
        Cell {
            meta: CellMeta::default(),
            extent: crate::coords::Extent::invalid(),
            features,
        }
    }

    fn float(f: &Feature, key: &str) -> Option<f64> {
        f.attr(key).and_then(AttrValue::as_float)
    }

    #[test]
    fn depare_defaults_follow_depare01() {
        let mut c = cell(vec![
            feature(
                "DEPARE",
                &[
                    ("DRVAL1", AttrValue::Float(2.0)),
                    ("DRVAL2", AttrValue::Float(5.0)),
                ],
            ),
            feature("DEPARE", &[("DRVAL1", AttrValue::Int(3))]), // int widens
            feature("DEPARE", &[]),                              // both missing
            feature("LNDARE", &[]),                              // untouched class
        ]);
        apply(&mut c);
        assert_eq!(float(&c.features[0], "drval1"), Some(2.0));
        assert_eq!(float(&c.features[0], "drval2"), Some(5.0));
        assert_eq!(float(&c.features[1], "drval1"), Some(3.0));
        assert_eq!(float(&c.features[1], "drval2"), Some(3.01));
        assert_eq!(float(&c.features[2], "drval1"), Some(-1.0));
        assert_eq!(float(&c.features[2], "drval2"), Some(-0.99));
        assert!(c.features[3].attr("drval1").is_none());
        // raw attributes untouched
        assert_eq!(float(&c.features[0], "DRVAL1"), Some(2.0));
    }

    #[test]
    fn attributeless_drgare_gets_no_range() {
        let mut c = cell(vec![
            feature("DRGARE", &[("DRVAL1", AttrValue::Float(7.2))]),
            feature("DRGARE", &[]),
        ]);
        apply(&mut c);
        assert_eq!(float(&c.features[0], "drval1"), Some(7.2));
        assert_eq!(float(&c.features[0], "drval2"), Some(7.21));
        assert!(c.features[1].attr("drval1").is_none());
        assert!(c.features[1].attr("drval2").is_none());
    }

    #[test]
    fn valdco_prev_is_the_next_shallower_distinct_contour() {
        let mut c = cell(vec![
            feature("DEPCNT", &[("VALDCO", AttrValue::Float(5.4))]),
            feature("DEPCNT", &[("VALDCO", AttrValue::Float(1.8))]),
            feature("DEPCNT", &[("VALDCO", AttrValue::Float(5.4))]), // duplicate value
            feature("DEPCNT", &[("VALDCO", AttrValue::Float(9.1))]),
            feature("DEPCNT", &[]), // no VALDCO: skipped
        ]);
        apply(&mut c);
        assert_eq!(float(&c.features[0], "valdco_prev"), Some(1.8));
        assert!(c.features[1].attr("valdco_prev").is_none()); // shallowest
        assert_eq!(float(&c.features[2], "valdco_prev"), Some(1.8));
        assert_eq!(float(&c.features[3], "valdco_prev"), Some(5.4));
        assert!(c.features[4].attr("valdco_prev").is_none());
    }

    #[test]
    fn native_scamin_tags_depcnt_and_line_depare_only() {
        let mut c = cell(vec![
            feature("DEPCNT", &[("VALDCO", AttrValue::Float(5.4))]),
            feature("LNDARE", &[]),
        ]);
        c.meta.compilation_scale = 12_000; // harbour: zoom_range_for_scale -> (10, 16)
        apply(&mut c);
        assert_eq!(
            c.features[0]
                .attr("native_scamin")
                .and_then(AttrValue::as_int),
            Some(crate::mvt::display_scale_denom(10).ceil() as i64)
        );
        assert!(c.features[1].attr("native_scamin").is_none());
    }

    #[test]
    fn native_scamin_tags_line_depare_not_area_depare() {
        let mut c = cell(vec![
            line_feature("DEPARE", &[]),
            area_feature("DEPARE", &[]),
        ]);
        c.meta.compilation_scale = 1_500_000; // general: zoom_range_for_scale -> (3, 9)
        apply(&mut c);
        assert_eq!(
            c.features[0]
                .attr("native_scamin")
                .and_then(AttrValue::as_int),
            Some(crate::mvt::display_scale_denom(3).ceil() as i64)
        );
        assert!(c.features[1].attr("native_scamin").is_none());
    }

    /// The `ceil()` rounding (see [`contour_native_scamin`]) must not perturb
    /// which INTEGER zoom the frontend's fade snaps to: `⌊log2(native_scamin)
    /// − log2(RENDER_SCALE_DENOM_Z0)⌋` must equal `−native_min_zoom` exactly, for
    /// every zoom the derive pass can produce (0..=16, `zoom_range_for_scale`'s
    /// clamp range) — proves the ceil-vs-exact gap (< 1 part in the scale
    /// denominator) never crosses the floor a zoom early or late.
    #[test]
    fn native_scamin_snaps_to_native_min_zoom_exactly() {
        for z in 0u8..=16 {
            let native_scamin = crate::mvt::display_scale_denom(z).ceil();
            let snapped = (native_scamin.log2() - crate::mvt::RENDER_SCALE_DENOM_Z0.log2()).floor();
            assert_eq!(snapped as i64, -(z as i64), "zoom {z}");
        }
    }

    fn with_geometry(acronym: &str, attrs: &[(&str, AttrValue)], geom: Geometry) -> Feature {
        let map: BTreeMap<String, AttrValue> = attrs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();
        Feature::new(0, acronym.into(), map, Some(geom))
    }

    fn line_feature(acronym: &str, attrs: &[(&str, AttrValue)]) -> Feature {
        let line = vec![
            crate::coords::WorldXy::new(0, 0),
            crate::coords::WorldXy::new(10, 10),
        ];
        with_geometry(acronym, attrs, Geometry::Lines(vec![line]))
    }

    fn point_feature(acronym: &str, attrs: &[(&str, AttrValue)]) -> Feature {
        with_geometry(
            acronym,
            attrs,
            Geometry::Point(crate::coords::WorldXy::new(0, 0)),
        )
    }

    fn area_feature(acronym: &str, attrs: &[(&str, AttrValue)]) -> Feature {
        let outer = vec![
            crate::coords::WorldXy::new(0, 0),
            crate::coords::WorldXy::new(10, 0),
            crate::coords::WorldXy::new(10, 10),
            crate::coords::WorldXy::new(0, 0),
        ];
        let poly = crate::model::Polygon {
            outer,
            holes: Vec::new(),
        };
        with_geometry(acronym, attrs, Geometry::Areas(vec![poly]))
    }

    #[test]
    fn depare_line_gets_valdco_prev_when_drval1_is_a_contour_value() {
        let mut c = cell(vec![
            feature("DEPCNT", &[("VALDCO", AttrValue::Float(1.8))]),
            feature("DEPCNT", &[("VALDCO", AttrValue::Float(5.4))]),
            // drval1 matches 5.4 within 1e-4: predecessor 1.8
            line_feature("DEPARE", &[("DRVAL1", AttrValue::Float(5.40001))]),
            // drval1 matches the shallowest contour: no predecessor
            line_feature("DEPARE", &[("DRVAL1", AttrValue::Float(1.8))]),
            // drval1 not in the contour set: omitted
            line_feature("DEPARE", &[("DRVAL1", AttrValue::Float(3.0))]),
        ]);
        // area DEPARE never gets valdco_prev even with a matching drval1
        c.features
            .push(feature("DEPARE", &[("DRVAL1", AttrValue::Float(5.4))]));
        apply(&mut c);
        assert_eq!(float(&c.features[2], "valdco_prev"), Some(1.8));
        assert!(c.features[3].attr("valdco_prev").is_none());
        assert!(c.features[4].attr("valdco_prev").is_none());
        assert!(c.features[5].attr("valdco_prev").is_none());
    }

    #[test]
    fn quapos_lifts_worst_low_accuracy_value() {
        let mut coalne = line_feature("COALNE", &[]);
        coalne.spatial_quapos = vec![1, 4, 3]; // worst in [2,10) is 4
        let mut accurate = line_feature("DEPCNT", &[("VALDCO", AttrValue::Float(2.0))]);
        accurate.spatial_quapos = vec![1, 10, 11]; // nothing in [2,10)

        // raw QUAPOS attribute (pre-lifted decoder) also counts
        let slcons = line_feature("SLCONS", &[("QUAPOS", AttrValue::Int(5))]);
        // class not in the lift set: untouched
        let mut fence = line_feature("FNCLNE", &[]);
        fence.spatial_quapos = vec![4];
        let mut c = cell(vec![coalne, accurate, slcons, fence]);
        apply(&mut c);
        assert_eq!(c.features[0].attr("quapos"), Some(&AttrValue::Int(4)));
        assert!(c.features[1].attr("quapos").is_none());
        assert_eq!(c.features[2].attr("quapos"), Some(&AttrValue::Int(5)));
        assert!(c.features[3].attr("quapos").is_none());
        // raw QUAPOS attribute untouched
        assert_eq!(c.features[2].attr("QUAPOS"), Some(&AttrValue::Int(5)));
    }

    #[test]
    fn catlnd_marsh_from_the_catlnd_list() {
        let mut c = cell(vec![
            feature(
                "LNDRGN",
                &[("CATLND", AttrValue::StrList(vec!["2".into()]))],
            ),
            feature("LNDRGN", &[("CATLND", AttrValue::IntList(vec![5, 12]))]),
            feature(
                "LNDRGN",
                &[("CATLND", AttrValue::StrList(vec!["5".into()]))],
            ),
            feature("LNDRGN", &[]),
            // other classes with CATLND are not LNDRGN: untouched
            feature(
                "LNDARE",
                &[("CATLND", AttrValue::StrList(vec!["2".into()]))],
            ),
        ]);
        apply(&mut c);
        assert_eq!(
            c.features[0].attr("catlnd_marsh"),
            Some(&AttrValue::Bool(true))
        );
        assert_eq!(
            c.features[1].attr("catlnd_marsh"),
            Some(&AttrValue::Bool(true))
        );
        assert!(c.features[2].attr("catlnd_marsh").is_none());
        assert!(c.features[3].attr("catlnd_marsh").is_none());
        assert!(c.features[4].attr("catlnd_marsh").is_none());
    }

    /// Minimal LUP set for the SCAMIN exemption tests.
    fn lups(rows: &[(&str, &str, &str, &str)]) -> S52Data {
        let mut xml = String::from("<chartsymbols><lookups>");
        for (i, (class, table, prio, cat)) in rows.iter().enumerate() {
            xml.push_str(&format!(
                "<lookup RCID=\"{i}\" name=\"{class}\"><table-name>{table}</table-name>\
                 <disp-prio>{prio}</disp-prio><display-cat>{cat}</display-cat>\
                 <instruction></instruction></lookup>"
            ));
        }
        xml.push_str("</lookups></chartsymbols>");
        let mut data = S52Data::default();
        data.parse_xml(&xml);
        assert_eq!(data.len(), rows.len());
        data
    }

    fn scamin_of(f: &Feature) -> Option<i64> {
        f.attr("scamin").and_then(AttrValue::as_int)
    }

    fn with_scamin(mut f: Feature, value: u32) -> Feature {
        f.attributes
            .insert("SCAMIN".into(), AttrValue::Int(value.into()));
        f.scamin = Some(value);
        f
    }

    #[test]
    fn scamin_gates_only_non_displaybase_objects() {
        let data = lups(&[
            ("SOUNDG", "Simplified", "Area Symbol", "Other"),
            ("DEPCNT", "Lines", "Line Symbol", "Other"),
            ("CBLOHD", "Lines", "Hazards", "Displaybase"),
            ("DEPARE", "Plain", "Group 1", "Other"),
        ]);
        let mut c = cell(vec![
            with_scamin(point_feature("SOUNDG", &[]), 17999),
            with_scamin(line_feature("DEPCNT", &[]), 21999),
            with_scamin(line_feature("CBLOHD", &[]), 44999), // Displaybase
            with_scamin(area_feature("DEPARE", &[]), 21999), // display priority group 1
            // no SCAMIN: a non-exempt POINT symbol gets the synthetic default
            point_feature("SOUNDG", &[]),
            // no SCAMIN: a non-exempt LINE stays ungated (default is point-only)
            line_feature("DEPCNT", &[]),
        ]);
        apply_with(&mut c, Some(&data));
        assert_eq!(scamin_of(&c.features[0]), Some(17999));
        assert_eq!(scamin_of(&c.features[1]), Some(21999));
        assert_eq!(scamin_of(&c.features[2]), None);
        assert_eq!(scamin_of(&c.features[3]), None);
        assert_eq!(scamin_of(&c.features[4]), Some(DEFAULT_POINT_SCAMIN));
        assert_eq!(scamin_of(&c.features[5]), None);
    }

    /// The DAYMAR bug: a non-exempt point symbol with NO charted SCAMIN used to
    /// get no gate (`None`) and so drew at every zoom. It now gets the synthetic
    /// [`DEFAULT_POINT_SCAMIN`] default; a charted SCAMIN still wins, and lines
    /// and areas without one stay ungated ("absent = always show").
    #[test]
    fn pointsymbol_without_scamin_gets_the_synthetic_default() {
        let data = lups(&[
            ("DAYMAR", "Simplified", "Point Symbol", "Standard"),
            ("SLCONS", "Lines", "Line Symbol", "Standard"),
            ("DEPARE", "Plain", "Group 1", "Other"), // group 1 -> exempt
        ]);
        let mut c = cell(vec![
            point_feature("DAYMAR", &[]),                    // no SCAMIN -> default
            with_scamin(point_feature("DAYMAR", &[]), 9999), // charted wins
            line_feature("SLCONS", &[]),                     // line -> no default
            area_feature("DEPARE", &[]),                     // exempt -> no gate
        ]);
        apply_with(&mut c, Some(&data));
        assert_eq!(scamin_of(&c.features[0]), Some(DEFAULT_POINT_SCAMIN));
        assert_eq!(scamin_of(&c.features[1]), Some(9999));
        assert_eq!(scamin_of(&c.features[2]), None);
        assert_eq!(scamin_of(&c.features[3]), None);
    }

    /// #TSSLPT-OVERSCALE: `CS(RESTRN01)` places a symbol (TSSLPT's
    /// `ORIENT`-rotated arrow) at a point on an AREA object — on screen that
    /// is a fixed-pixel icon exactly like a genuine point symbol's, so
    /// without a charted SCAMIN of its own it must decongest too, or it
    /// renders at a constant screen size, unbounded, at every zoom (the
    /// reported bug: a TSS lane arrow spanning tens of kilometres once zoomed
    /// out far enough). Runs the real `restricted::apply` first so this pins
    /// the actual pipeline's `sym`, not a hand-inserted stand-in.
    ///
    /// #TSSLPT-OVERSCALE-2: gets [`DEFAULT_AREA_SYMBOL_SCAMIN`], NOT the
    /// point default — reusing the point default made a real deployed TSS
    /// lane disappear at every scale a mariner would actually view one at
    /// (a "Coastal"-band object gated at a "Harbour"-band threshold).
    #[test]
    fn area_symbol_without_scamin_gets_the_coarser_area_default() {
        let data = lups(&[("TSSLPT", "Plain", "Area Symbol", "Other")]);
        let mut c = cell(vec![area_feature(
            "TSSLPT",
            &[("ORIENT", AttrValue::Float(90.0))],
        )]);
        restricted::apply(&mut c);
        assert_eq!(
            c.features[0].attr("sym"),
            Some(&AttrValue::Str("TSS-arrow".into()))
        );
        scamin(&mut c, Some(&data));
        assert_eq!(scamin_of(&c.features[0]), Some(DEFAULT_AREA_SYMBOL_SCAMIN));
    }

    /// A CS-computed display category wins over the LUP's, like the
    /// reference's getDisplayCat(): an OBSTRN the hazard pass moved to
    /// DISPLAYBASE keeps rendering however far out we zoom.
    #[test]
    fn scamin_honours_the_cs_display_category() {
        let data = lups(&[("OBSTRN", "Plain", "Hazards", "Standard")]);
        let mut c = cell(vec![with_scamin(
            area_feature("OBSTRN", &[("CATOBS", AttrValue::Int(9))]), // foul ground -> base
            21999,
        )]);
        apply_with(&mut c, Some(&data));
        assert_eq!(
            c.features[0].attr("dispcat").and_then(AttrValue::as_str),
            Some("base")
        );
        assert_eq!(scamin_of(&c.features[0]), None);
    }

    /// Simplified/Paper and Plain/Symbolized are picked by a user setting, so
    /// the exemption is the INTERSECTION over the pair (#mkvsousw): exempt only
    /// where both tables exempt, so a row that bypasses SCAMIN under one
    /// setting and not the other does not get to throw away a charted SCAMIN.
    /// Still settings-independent, just resolved the other way.
    #[test]
    fn scamin_exemption_intersects_the_sibling_lup_tables() {
        let data = lups(&[
            // the real MORFAC/SLCONS/PRCARE shape: exempt in one table only
            ("MORFAC", "Plain", "Area 1", "Standard"),
            ("MORFAC", "Symbolized", "Group 1", "Standard"),
            ("PRCARE", "Plain", "Point Symbol", "Standard"),
            ("PRCARE", "Symbolized", "Point Symbol", "Displaybase"),
            ("topmar", "Simplified", "Point Symbol", "Standard"),
            ("topmar", "Paper", "Point Symbol", "Displaybase"),
            // agreeing pair: exempt in both, and stays exempt
            ("DEPARE", "Plain", "Group 1", "Standard"),
            ("DEPARE", "Symbolized", "Group 1", "Standard"),
            // only one table of the pair has a row at all (M_PROD/NATARE):
            // the absent one abstains rather than voting against
            ("NATARE", "Symbolized", "Area 1", "Displaybase"),
        ]);
        let mut c = cell(vec![
            with_scamin(area_feature("MORFAC", &[]), 21999),
            with_scamin(area_feature("PRCARE", &[]), 21999),
            with_scamin(point_feature("topmar", &[]), 21999),
            with_scamin(area_feature("DEPARE", &[]), 21999),
            with_scamin(area_feature("NATARE", &[]), 21999),
        ]);
        apply_with(&mut c, Some(&data));
        assert_eq!(scamin_of(&c.features[0]), Some(21999), "MORFAC area");
        assert_eq!(scamin_of(&c.features[1]), Some(21999), "PRCARE area");
        assert_eq!(scamin_of(&c.features[2]), Some(21999), "topmar point");
        assert_eq!(scamin_of(&c.features[3]), None, "both tables exempt");
        assert_eq!(scamin_of(&c.features[4]), None, "one table, and it exempts");
    }

    /// `LNDARE` points leave the DISPLAYBASE bypass: charted SCAMIN wins, else
    /// 4× the cell's scale, while land areas stay exempt even when charted.
    #[test]
    fn land_points_gate_at_four_times_cell_scale() {
        let data = lups(&[
            ("LNDARE", "Simplified", "Point Symbol", "Displaybase"),
            ("LNDARE", "Paper", "Point Symbol", "Displaybase"),
            ("LNDARE", "Plain", "Group 1", "Displaybase"),
            ("LNDARE", "Symbolized", "Group 1", "Displaybase"),
        ]);
        let mut c = cell(vec![
            point_feature("LNDARE", &[]),
            with_scamin(point_feature("LNDARE", &[]), 21_999),
            area_feature("LNDARE", &[]),
            with_scamin(area_feature("LNDARE", &[]), 21_999),
        ]);
        c.meta.compilation_scale = 22_000;
        apply_with(&mut c, Some(&data));
        assert_eq!(scamin_of(&c.features[0]), Some(88_000), "uncharted point");
        assert_eq!(scamin_of(&c.features[1]), Some(21_999), "charted point");
        assert_eq!(scamin_of(&c.features[2]), None, "area");
        assert_eq!(scamin_of(&c.features[3]), None, "charted area");
    }

    /// With no compilation scale there is no 4× to take: stay ungated.
    #[test]
    fn land_point_without_cell_scale_stays_ungated() {
        let data = lups(&[("LNDARE", "Simplified", "Point Symbol", "Displaybase")]);
        let mut c = cell(vec![point_feature("LNDARE", &[])]);
        c.meta.compilation_scale = 0;
        apply_with(&mut c, Some(&data));
        assert_eq!(scamin_of(&c.features[0]), None);
    }

    /// The intersection can only ever REMOVE an exemption, and a non-exempt
    /// area with neither a charted SCAMIN nor a `sym` still falls through
    /// `scamin`'s `None => continue`. So it cannot invent decluttering: the
    /// 1397 uncharted DE SLCONS areas bake byte-identically (#mkvsousw).
    #[test]
    fn losing_the_exemption_does_not_invent_a_gate() {
        let data = lups(&[
            ("SLCONS", "Plain", "Routing", "Standard"),
            ("SLCONS", "Symbolized", "Routing", "Displaybase"),
        ]);
        let mut c = cell(vec![area_feature("SLCONS", &[])]);
        apply_with(&mut c, Some(&data));
        assert_eq!(scamin_of(&c.features[0]), None);
    }

    /// No lookup tables (or no lookup for the class) -> no gate: we cannot
    /// prove SCAMIN applies, and rendering is the safe direction.
    #[test]
    fn scamin_needs_lookup_data() {
        let mut c = cell(vec![with_scamin(point_feature("SOUNDG", &[]), 17999)]);
        apply(&mut c);
        assert_eq!(scamin_of(&c.features[0]), None);

        let mut c = cell(vec![with_scamin(point_feature("SOUNDG", &[]), 17999)]);
        apply_with(
            &mut c,
            Some(&lups(&[("DEPCNT", "Lines", "Line Symbol", "Other")])),
        );
        assert_eq!(scamin_of(&c.features[0]), None);
    }

    #[test]
    fn apply_is_idempotent() {
        let mut marsh = feature(
            "LNDRGN",
            &[("CATLND", AttrValue::StrList(vec!["12".into()]))],
        );
        marsh.spatial_quapos = vec![4];
        let mut coastline = line_feature("COALNE", &[]);
        coastline.spatial_quapos = vec![4];
        let mut c = cell(vec![
            feature("DEPARE", &[]),
            feature("DEPCNT", &[("VALDCO", AttrValue::Float(2.0))]),
            feature("DEPCNT", &[("VALDCO", AttrValue::Float(5.0))]),
            line_feature("DEPARE", &[("DRVAL1", AttrValue::Float(5.0))]),
            marsh,
            coastline,
        ]);
        apply(&mut c);
        let once = c.clone();
        apply(&mut c);
        assert_eq!(c, once);
    }
}
