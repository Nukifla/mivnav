// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! **The single-icon-source invariant**: every symbol `derive/` can emit must
//! be a name `icons::resolve` — and therefore the backend's `/api/icons/`
//! endpoint — can answer for. That is the whole point of the migration off
//! the chartsymbols.xml sprite atlas (`assets/s52-icons/port-map.json`), and
//! this file is what stops it rotting: add an emit site with no artwork behind
//! it and one of these two tests fails.
//!
//! It takes **two** tests, because neither alone is enough:
//!
//! 1. [`every_symbol_derive_can_emit_resolves`] runs the REAL
//!    `derive::apply` pipeline over synthetic features spanning each class's
//!    branch attributes and resolves whatever `sym*` it finds. It proves the
//!    values are right, by construction rather than by us writing the same
//!    string twice — but a fixture sweep can never prove it reached every
//!    arm of ~50 classes, so on its own an unreached emit site hides.
//! 2. [`no_unexpected_chartsymbols_token_in_derive_sources`] closes that by
//!    scanning the derive sources themselves for chartsymbols.xml-shaped
//!    tokens and pinning the set. It IS exhaustive (it reads every line) and
//!    costs nothing, so a literal the sweep's fixtures never reach still
//!    shows up.
//!
//! Three things deliberately do NOT have to resolve:
//!
//! * **`lc` line-pattern names.** A different mechanism — seamless tiling, no
//!   pivot — and a separate, later migration stage (`port-map.json`'s `drop`
//!   block). They share spellings with symbols (`CTYARE51` is both a centred
//!   caution symbol and a dashed magenta boundary), which is exactly why the
//!   sweep looks at `sym*` attributes only and never at `lc`.
//! * **`bcol`/`lsty`/`fill`/`txt`** and the rest of the derived schema — not
//!   symbol names at all.
//! * The [`NO_ARTWORK`] list: symbols the chart genuinely still needs and
//!   that nothing in the tree can draw. They are named one by one, and the
//!   sweep asserts each is still BOTH reachable and unresolvable — so the
//!   list cannot quietly outlive the gap it documents.

use std::collections::{BTreeMap, BTreeSet};

use chartcore::coords::{Extent, WorldXy};
use chartcore::icons;
use chartcore::model::{AttrValue, Cell, CellMeta, Feature, Geometry, Polygon};

// ---------------------------------------------------------------------------
// the symbols with no artwork anywhere
// ---------------------------------------------------------------------------

/// Symbol values `derive/` still emits that resolve to NOTHING — not real
/// vendored artwork, not even a traced chartsymbols.xml stand-in.
///
/// These are not an oversight of the port: neither is a `<symbol>` in
/// chartsymbols.xml, so there is no HPGL to trace and never was, and the old
/// raster atlas ALIASED both onto the question-mark glyph — which is why
/// `tools/gen-placeholders.py` refused to generate for them (cropping the
/// atlas would have produced byte-identical "?" images labelled as different
/// symbols).
///
/// jt task ntyrwnnr closed the other four this list used to carry, and how it
/// closed them is the template for these two — none of the four needed a
/// speculative drawing:
///
/// * `DGPS01DRFSTA01` and `FLTHAZ02` were RENAMED onto artwork that already
///   existed. chartsymbols.xml's *Paper* row for RDOSTA CATROS=10 spells out
///   what its *Simplified* row's run-together name meant (`SY(RDOSTA02);
///   TX('DGPS')`), and `s57-style.json`'s own OBSTRN layer routes the FLTHAZ02
///   rows to `obstruction`.
/// * `DANGER53` and `LOWACC03` became real drawn artwork under their own token
///   name — see [`expected::DRAWN_AS_TOKEN`] and each SVG's header.
///
/// `FOULGND1` was the second survivor until 2026-07-29 and closed the same way
/// as the first two: RENAMED onto artwork that already existed. It was never a
/// missing drawing — S-52 invokes it as an area PATTERN (`AP`), never a point
/// symbol — so emitting the bare token 404'd `/api/icons/FOULGND1.svg` and drew
/// a question mark on the chart. Its three `derive::hazards` sites now emit the
/// vendored `foul`: `s57-style.json`'s OBSTRN layer sends CATOBS 6/7 there
/// (which [`obstrn_area`]'s own doc already stated as the rule), and
/// `port-map.json` carries `OBSTRN11 -> foul` at `confidence: high` for the
/// same rows. WRECKS CATWRK=3 goes there too, as a recorded divergence — see
/// that call site.
///
/// The one survivor is not in `port-map.json` at all, which is worth knowing
/// when picking it up:
///
/// * `LNDARE01` (`derive::hazards`, OBSTRN with WATLEV 1/2) is the land-area
///   fill, and `port-map.json`'s `drop` block already says so — an OBSTRN that
///   is always above water is drawn as land, not as a point symbol.
const NO_ARTWORK: &[&str] = &["LNDARE01"];

// ---------------------------------------------------------------------------
// 1. the runtime sweep
// ---------------------------------------------------------------------------

/// One attribute's branch-relevant value domain. `Absent` is always included
/// explicitly — "attribute missing" is a real arm in nearly every CS table.
#[derive(Clone, Copy)]
enum Val {
    Absent,
    Int(i64),
    IntList(&'static [i64]),
    Float(f64),
}

impl Val {
    fn set(self, attrs: &mut BTreeMap<String, AttrValue>, key: &str) {
        let v = match self {
            Val::Absent => return,
            Val::Int(i) => AttrValue::Int(i),
            Val::IntList(l) => AttrValue::IntList(l.to_vec()),
            Val::Float(f) => AttrValue::Float(f),
        };
        attrs.insert(key.to_string(), v);
    }
}

#[derive(Clone, Copy)]
enum Geom {
    Point,
    Line,
    Area,
}

struct Sweep {
    classes: &'static [&'static str],
    geoms: &'static [Geom],
    attrs: &'static [(&'static str, &'static [Val])],
}

/// RESTRN's whole domain plus a few multi-value lists — RESARE02/RESTRN01
/// bucket it (entry 7/8/14, anchoring 1/2, fishing 3-6, other 9-13) and the
/// buckets combine, so the pairs matter as much as the singletons.
const RESTRN: &[Val] = &[
    Val::Absent,
    Val::IntList(&[]),
    Val::IntList(&[1]),
    Val::IntList(&[2]),
    Val::IntList(&[3]),
    Val::IntList(&[4]),
    Val::IntList(&[5]),
    Val::IntList(&[6]),
    Val::IntList(&[7]),
    Val::IntList(&[8]),
    Val::IntList(&[9]),
    Val::IntList(&[10]),
    Val::IntList(&[11]),
    Val::IntList(&[12]),
    Val::IntList(&[13]),
    Val::IntList(&[14]),
    Val::IntList(&[99]),
    Val::IntList(&[1, 3]),
    Val::IntList(&[1, 9]),
    Val::IntList(&[7, 1]),
    Val::IntList(&[7, 3]),
    Val::IntList(&[7, 9]),
    Val::IntList(&[3, 9]),
];

/// CATREA's whole domain (1..=28) — RESARE02's creaC/creaI buckets pick out
/// scattered members of it, and 27/28 are the D8 no-symbol special case.
const CATREA: &[Val] = &[
    Val::Absent,
    Val::IntList(&[1]),
    Val::IntList(&[4]),
    Val::IntList(&[5]),
    Val::IntList(&[6]),
    Val::IntList(&[7]),
    Val::IntList(&[8]),
    Val::IntList(&[9]),
    Val::IntList(&[10]),
    Val::IntList(&[12]),
    Val::IntList(&[14]),
    Val::IntList(&[18]),
    Val::IntList(&[19]),
    Val::IntList(&[20]),
    Val::IntList(&[21]),
    Val::IntList(&[22]),
    Val::IntList(&[23]),
    Val::IntList(&[24]),
    Val::IntList(&[25]),
    Val::IntList(&[26]),
    Val::IntList(&[27]),
    Val::IntList(&[28]),
    Val::IntList(&[1, 4]),
];

const ORIENT: &[Val] = &[Val::Absent, Val::Float(90.0)];
const CONVIS: &[Val] = &[Val::Absent, Val::Int(1), Val::Int(2)];
const VALSOU: &[Val] = &[Val::Absent, Val::Float(5.0), Val::Float(25.0)];
const WATLEV: &[Val] = &[
    Val::Absent,
    Val::Int(1),
    Val::Int(2),
    Val::Int(3),
    Val::Int(4),
    Val::Int(5),
    Val::Int(6),
    Val::Int(7),
];

/// Every branch attribute of every class `derive/` bakes a symbol for, with
/// the full domain of each. The product is taken per class, so a class with
/// two three-valued attributes really does see all nine combinations.
const SWEEPS: &[Sweep] = &[
    // -- derive::restricted (area rows) -----------------------------------
    Sweep {
        classes: &["RESARE"],
        geoms: &[Geom::Area],
        attrs: &[("RESTRN", RESTRN), ("CATREA", CATREA)],
    },
    Sweep {
        classes: &["ACHARE"],
        geoms: &[Geom::Area],
        attrs: &[
            ("RESTRN", RESTRN),
            ("CATREA", CATREA),
            (
                "CATACH",
                &[Val::Absent, Val::Int(1), Val::Int(8), Val::Int(9)],
            ),
        ],
    },
    Sweep {
        classes: &[
            "CTNARE", "MIPARE", "CBLARE", "TSSCRS", "TSSRON", "ISTZNE", "PRCARE", "MARCUL",
            "CTSARE",
        ],
        geoms: &[Geom::Area],
        attrs: &[("RESTRN", RESTRN)],
    },
    Sweep {
        classes: &["TSSLPT"],
        geoms: &[Geom::Area],
        attrs: &[("RESTRN", RESTRN), ("ORIENT", ORIENT)],
    },
    Sweep {
        classes: &["DMPGRD"],
        geoms: &[Geom::Area],
        attrs: &[
            ("RESTRN", RESTRN),
            (
                "CATDPG",
                &[
                    Val::Absent,
                    Val::Int(1),
                    Val::Int(2),
                    Val::Int(3),
                    Val::Int(4),
                    Val::Int(5),
                ],
            ),
        ],
    },
    Sweep {
        classes: &["PIPARE"],
        geoms: &[Geom::Area],
        attrs: &[
            ("RESTRN", RESTRN),
            (
                "CATPIP",
                &[
                    Val::Absent,
                    Val::IntList(&[1]),
                    Val::IntList(&[2]),
                    Val::IntList(&[3]),
                    Val::IntList(&[4]),
                    Val::IntList(&[5]),
                    Val::IntList(&[6]),
                ],
            ),
            (
                "PRODCT",
                &[Val::Absent, Val::IntList(&[1]), Val::IntList(&[3])],
            ),
        ],
    },
    Sweep {
        classes: &["FAIRWY"],
        geoms: &[Geom::Area],
        attrs: &[
            ("RESTRN", RESTRN),
            ("ORIENT", ORIENT),
            (
                "TRAFIC",
                &[
                    Val::Absent,
                    Val::Int(1),
                    Val::Int(2),
                    Val::Int(3),
                    Val::Int(4),
                    Val::Int(9),
                ],
            ),
        ],
    },
    Sweep {
        classes: &["FERYRT"],
        geoms: &[Geom::Area, Geom::Line],
        attrs: &[(
            "CATFRY",
            &[
                Val::Absent,
                Val::Int(1),
                Val::Int(2),
                Val::Int(3),
                Val::Int(4),
            ],
        )],
    },
    // -- derive::restricted / stations (genuine point rows) ----------------
    Sweep {
        classes: &[
            "ACHARE", "CTNARE", "MIPARE", "DMPGRD", "PIPARE", "PRCARE", "MARCUL", "CTSARE",
            "RSCSTA", "SISTAT", "SISTAW", "PILBOP",
        ],
        geoms: &[Geom::Point],
        attrs: &[("RESTRN", RESTRN)],
    },
    Sweep {
        classes: &["PILBOP"],
        geoms: &[Geom::Area],
        attrs: &[("RESTRN", RESTRN)],
    },
    Sweep {
        classes: &["RDOSTA"],
        geoms: &[Geom::Point],
        attrs: &[(
            "CATROS",
            &[
                Val::Absent,
                Val::IntList(&[1]),
                Val::IntList(&[5]),
                Val::IntList(&[10]),
                Val::IntList(&[10, 1]),
                Val::IntList(&[11]),
            ],
        )],
    },
    Sweep {
        classes: &["RDOCAL"],
        geoms: &[Geom::Point, Geom::Line],
        attrs: &[
            ("ORIENT", ORIENT),
            (
                "TRAFIC",
                &[
                    Val::Absent,
                    Val::Int(1),
                    Val::Int(2),
                    Val::Int(3),
                    Val::Int(4),
                    Val::Int(9),
                ],
            ),
        ],
    },
    // -- derive::hazards ---------------------------------------------------
    Sweep {
        classes: &["WRECKS", "OBSTRN", "UWTROC"],
        geoms: &[Geom::Point, Geom::Line, Geom::Area],
        attrs: &[
            ("VALSOU", VALSOU),
            ("WATLEV", WATLEV),
            (
                "CATWRK",
                &[
                    Val::Absent,
                    Val::Int(1),
                    Val::Int(2),
                    Val::Int(3),
                    Val::Int(4),
                    Val::Int(5),
                    Val::Int(6),
                ],
            ),
            (
                "CATOBS",
                &[
                    Val::Absent,
                    Val::Int(1),
                    Val::Int(2),
                    Val::Int(3),
                    Val::Int(4),
                    Val::Int(5),
                    Val::Int(6),
                    Val::Int(7),
                    Val::Int(8),
                    Val::Int(9),
                    Val::Int(10),
                    Val::Int(11),
                ],
            ),
        ],
    },
    // QUAPOS is orthogonal to the symbol pick (it only feeds `sym_pos`), so
    // it gets its own pass rather than multiplying the table above by 9.
    Sweep {
        classes: &["WRECKS", "OBSTRN", "UWTROC"],
        geoms: &[Geom::Point],
        attrs: &[(
            "QUAPOS",
            &[
                Val::Absent,
                Val::Int(1),
                Val::Int(2),
                Val::Int(3),
                Val::Int(4),
                Val::Int(5),
                Val::Int(6),
                Val::Int(7),
                Val::Int(8),
                Val::Int(9),
                Val::Int(10),
                Val::Int(11),
            ],
        )],
    },
    // -- derive::industrial ------------------------------------------------
    Sweep {
        classes: &["SILTNK"],
        geoms: &[Geom::Point, Geom::Area],
        attrs: &[
            (
                "CATSIL",
                &[
                    Val::Absent,
                    Val::Int(1),
                    Val::Int(2),
                    Val::Int(3),
                    Val::Int(4),
                    Val::Int(9),
                ],
            ),
            ("CONVIS", CONVIS),
        ],
    },
    Sweep {
        classes: &["PRDARE"],
        geoms: &[Geom::Point, Geom::Area],
        attrs: &[
            (
                "CATPRA",
                &[
                    Val::Absent,
                    Val::Int(1),
                    Val::Int(2),
                    Val::Int(3),
                    Val::Int(4),
                    Val::Int(5),
                    Val::Int(6),
                    Val::Int(7),
                    Val::Int(8),
                    Val::Int(9),
                    Val::Int(10),
                    Val::Int(11),
                ],
            ),
            ("CONVIS", CONVIS),
        ],
    },
    // -- derive::lndmrk ----------------------------------------------------
    Sweep {
        classes: &["LNDMRK"],
        geoms: &[Geom::Point, Geom::Line, Geom::Area],
        attrs: &[
            ("CATLMK", &CATLMK_DOMAIN),
            ("FUNCTN", &FUNCTN_DOMAIN),
            ("CONVIS", CONVIS),
        ],
    },
    // -- derive::cables ----------------------------------------------------
    Sweep {
        classes: &["CBLSUB", "CBLOHD", "PIPSOL", "PIPOHD"],
        geoms: &[Geom::Line],
        attrs: &[
            (
                "CATCBL",
                &[
                    Val::Absent,
                    Val::IntList(&[1]),
                    Val::IntList(&[4]),
                    Val::IntList(&[6]),
                ],
            ),
            (
                "CATPIP",
                &[
                    Val::Absent,
                    Val::IntList(&[1]),
                    Val::IntList(&[2]),
                    Val::IntList(&[3]),
                    Val::IntList(&[4]),
                    Val::IntList(&[5]),
                    Val::IntList(&[6]),
                ],
            ),
            (
                "CONRAD",
                &[
                    Val::Absent,
                    Val::Int(1),
                    Val::Int(2),
                    Val::Int(3),
                    Val::Int(4),
                ],
            ),
        ],
    },
    // -- derive::lights ----------------------------------------------------
    Sweep {
        classes: &["LIGHTS"],
        geoms: &[Geom::Point],
        attrs: &[
            ("CATLIT", &CATLIT_DOMAIN),
            ("COLOUR", &COLOUR_DOMAIN),
            ("VALNMR", &[Val::Absent, Val::Float(5.0), Val::Float(25.0)]),
            ("SECTR1", &[Val::Absent, Val::Float(0.0)]),
            ("SECTR2", &[Val::Absent, Val::Float(90.0)]),
        ],
    },
    // -- derive::aton ------------------------------------------------------
    // The combinatorial catalogue: shape x colour-pattern x colour. Every
    // shape id in the S-57 domain, including the ones with no vendored
    // artwork (BOYSHP=8 ice buoy), which must degrade rather than fail.
    Sweep {
        classes: &["BOYLAT", "BOYCAR", "BOYSAW", "BOYSPP", "BOYINB", "BOYISD"],
        geoms: &[Geom::Point],
        attrs: &[
            ("BOYSHP", &SHAPE_DOMAIN),
            ("COLPAT", &COLPAT_DOMAIN),
            ("COLOUR", &COLOUR_DOMAIN),
        ],
    },
    Sweep {
        classes: &["BCNLAT", "BCNCAR", "BCNSAW", "BCNSPP", "BCNISD"],
        geoms: &[Geom::Point],
        attrs: &[
            ("BCNSHP", &SHAPE_DOMAIN),
            ("COLPAT", &COLPAT_DOMAIN),
            ("COLOUR", &COLOUR_DOMAIN),
        ],
    },
    Sweep {
        classes: &["TOPMAR", "DAYMAR"],
        geoms: &[Geom::Point],
        attrs: &[
            ("TOPSHP", &TOPSHP_DOMAIN),
            ("COLOUR", &COLOUR_DOMAIN),
            ("COLPAT", &COLPAT_DOMAIN),
        ],
    },
    Sweep {
        classes: &["MORFAC"],
        geoms: &[Geom::Point],
        attrs: &[
            ("CATMOR", &SHAPE_DOMAIN),
            ("BOYSHP", &SHAPE_DOMAIN),
            ("COLOUR", &COLOUR_DOMAIN),
        ],
    },
    Sweep {
        classes: &["LITVES", "LITFLT"],
        geoms: &[Geom::Point],
        attrs: &[("COLOUR", &COLOUR_DOMAIN), ("COLPAT", &COLPAT_DOMAIN)],
    },
    Sweep {
        classes: &["BOYSPP", "BCNSPP"],
        geoms: &[Geom::Point],
        attrs: &[("CATSPM", &CATSPM_DOMAIN), ("BOYSHP", &SHAPE_DOMAIN)],
    },
];

const CATLMK_DOMAIN: [Val; 22] = int_domain_22();
const FUNCTN_DOMAIN: [Val; 34] = int_domain_34();
const CATLIT_DOMAIN: [Val; 18] = list_domain_18();
const COLOUR_DOMAIN: [Val; 14] = list_domain_14();
const SHAPE_DOMAIN: [Val; 10] = int_domain_10();
const TOPSHP_DOMAIN: [Val; 34] = int_domain_34();
const COLPAT_DOMAIN: [Val; 8] = list_domain_8();
const CATSPM_DOMAIN: [Val; 56] = list_domain_56();

// `const fn` domain builders: `Val::Absent` then 1..N as the right shape.
// Written out rather than generated at runtime so the tables above stay
// `const` and the sweep needs no lazy initialisation.
macro_rules! domain {
    ($name:ident, $n:literal, $ctor:ident) => {
        const fn $name() -> [Val; $n] {
            let mut out = [Val::Absent; $n];
            let mut i = 1;
            while i < $n {
                out[i] = $ctor(i as i64);
                i += 1;
            }
            out
        }
    };
}

const fn int_val(i: i64) -> Val {
    Val::Int(i)
}

/// `IntList` needs a `&'static [i64]`, which a `const fn` cannot synthesise
/// per element — so list-shaped domains index a fixed table of singletons.
const SINGLETONS: [[i64; 1]; 56] = {
    let mut t = [[0i64; 1]; 56];
    let mut i = 0;
    while i < 56 {
        t[i] = [i as i64];
        i += 1;
    }
    t
};

const fn list_val(i: i64) -> Val {
    Val::IntList(&SINGLETONS[i as usize])
}

domain!(int_domain_10, 10, int_val);
domain!(int_domain_22, 22, int_val);
domain!(int_domain_34, 34, int_val);
domain!(list_domain_8, 8, list_val);
domain!(list_domain_14, 14, list_val);
domain!(list_domain_18, 18, list_val);
domain!(list_domain_56, 56, list_val);

fn geometry(g: Geom, n: i32) -> Geometry {
    // Distinct coordinates per feature: `derive::aid_group` joins CO-LOCATED
    // features, and a sweep is not a co-location fixture — stacking every
    // synthetic feature on the origin would have them fold into each other.
    let (x, y) = (n * 1_000, n * 1_000);
    match g {
        Geom::Point => Geometry::Point(WorldXy::new(x, y)),
        Geom::Line => Geometry::Lines(vec![vec![WorldXy::new(x, y), WorldXy::new(x + 10, y + 10)]]),
        Geom::Area => Geometry::Areas(vec![Polygon {
            outer: vec![
                WorldXy::new(x, y),
                WorldXy::new(x + 10, y),
                WorldXy::new(x + 10, y + 10),
                WorldXy::new(x, y + 10),
                WorldXy::new(x, y),
            ],
            holes: vec![],
        }]),
    }
}

/// Every feature the [`SWEEPS`] table describes, as the cartesian product of
/// each class's attribute domains.
fn sweep_features() -> Vec<Feature> {
    let mut out = Vec::new();
    for s in SWEEPS {
        let total: usize = s.attrs.iter().map(|(_, d)| d.len()).product();
        for class in s.classes {
            for g in s.geoms {
                for i in 0..total {
                    let mut attrs = BTreeMap::new();
                    let mut rest = i;
                    for (key, domain) in s.attrs {
                        domain[rest % domain.len()].set(&mut attrs, key);
                        rest /= domain.len();
                    }
                    let n = (out.len() % 1_000_000) as i32;
                    out.push(Feature::new(
                        0,
                        (*class).to_string(),
                        attrs,
                        Some(geometry(*g, n)),
                    ));
                }
            }
        }
    }
    out
}

/// Run the real pipeline and collect every distinct `sym*` value it produced.
fn emitted_symbols() -> BTreeSet<String> {
    let features = sweep_features();
    assert!(
        features.len() > 20_000,
        "the sweep collapsed to {} features — the domain tables are wrong",
        features.len()
    );
    let mut found = BTreeSet::new();
    // Chunked: `derive::apply` has cross-feature passes (contour prev,
    // co-location grouping) that are superlinear in one cell's feature count,
    // and nothing in this sweep depends on cross-feature state.
    for chunk in features.chunks(500) {
        let mut cell = Cell {
            meta: CellMeta::default(),
            extent: Extent::invalid(),
            features: chunk.to_vec(),
        };
        chartcore::derive::apply(&mut cell);
        for f in &cell.features {
            for (key, value) in &f.attributes {
                // Every symbol-name attribute in the derived schema is
                // `sym`-prefixed (`sym`, `sym_cs`, `sym_s`,
                // `sym_extra`, `sym_pos`, `sym_topmark`) — matching the
                // prefix rather than a fixed list means a NEW one is covered
                // the day it is added, which is the point of this file.
                if !key.starts_with("sym") {
                    continue;
                }
                if let Some(v) = value.as_str() {
                    found.insert(v.to_string());
                }
            }
        }
    }
    found
}

#[test]
fn every_symbol_derive_can_emit_resolves() {
    let found = emitted_symbols();
    assert!(
        found.len() > 50,
        "only {} distinct symbols emitted — the sweep is not reaching the \
         emit sites it is supposed to cover",
        found.len()
    );

    let mut unresolvable: Vec<String> = Vec::new();
    for key in &found {
        if icons::resolve(key).is_err() {
            unresolvable.push(key.clone());
        }
    }
    unresolvable.sort();

    let mut expected: Vec<String> = NO_ARTWORK.iter().map(|s| (*s).to_string()).collect();
    expected.sort();

    assert_eq!(
        unresolvable, expected,
        "\nEVERY symbol derive/ emits must resolve through icons::resolve, so \
         that /api/icons/ can answer for it — see this file's module doc.\n\
         If a name is missing from the left side, artwork landed for it and \
         NO_ARTWORK should shed that entry.\n\
         If a name is EXTRA on the left, a new emit site was added with \
         nothing to draw it: either map it in assets/s52-icons/port-map.json \
         and emit the vendored name, or add artwork for it under \
         chartcore/assets/s52-icons/."
    );
}

/// The `NO_ARTWORK` list is only honest if the sweep actually reaches every
/// name on it — otherwise an entry could survive long after its emit site was
/// deleted, quietly widening the exemption for the next person.
#[test]
fn every_no_artwork_symbol_is_still_actually_emitted() {
    let found = emitted_symbols();
    let missing: Vec<&&str> = NO_ARTWORK.iter().filter(|n| !found.contains(**n)).collect();
    assert!(
        missing.is_empty(),
        "NO_ARTWORK names no longer emitted by derive/ (drop them from the \
         list, or fix the sweep if it stopped reaching them): {missing:?}"
    );
}

/// Resolving is necessary but NOT sufficient: a name can resolve to real
/// vendored artwork and still be the WRONG artwork, if it names one of the
/// **parametric ATON shape assets**.
///
/// Those are the `COLORING{}` base icons (`icons::catalog::is_parametric` —
/// `barrel`, `cylinder`, `tower`, `can`, `conical`, `spar`, …): buoy bodies,
/// beacon bodies and topmark shapes, whose S-57 names are shape words from
/// `s57.py`'s `BOYSHP`/`BCNSHP`/`TOPSHP` domains. They exist only to be
/// addressed through `derive::aton`'s COMPOSED numeric form
/// (`BOYSHP/6/0/3`), which picks the colour/pattern variant. Named bare by
/// any other module they render the uncoloured template — so a tank farm
/// asking for `barrel` draws a barrel BUOY, which is exactly the bug this
/// test exists to prevent (jt task wyzqklzz; `derive::lndmrk` had already hit
/// it and dodged it by hand with `tower-lmk`/`cairn-lmk`).
///
/// The invariant is **universal, with no exception list**: `aton.rs` composes
/// its names at runtime and never writes a bare shape word, so no legitimate
/// emit site names one. Add an exception here and the bug class comes back.
#[test]
fn no_derive_symbol_names_a_bare_parametric_icon() {
    let mut offenders: Vec<String> = emitted_symbols()
        .iter()
        .filter(|name| {
            icons::catalog::load_icon(name).is_ok_and(|svg| icons::catalog::is_parametric(&svg))
        })
        .cloned()
        .collect();
    offenders.sort();
    assert!(
        offenders.is_empty(),
        "\nderive/ emits bare PARAMETRIC ATON shape names: {offenders:?}\n\
         These render the uncoloured buoy/beacon/topmark template, not the \
         land structure the emitting class means.\n\
         Pick a non-parametric vendored icon (the `-lmk` variants exist for \
         exactly this: tower-lmk, cairn-lmk, cross-lmk) and record the change \
         in assets/s52-icons/port-map.json."
    );
}

// ---------------------------------------------------------------------------
// 2. the source inventory
// ---------------------------------------------------------------------------

/// Every `chartcore/src/derive/*.rs`, at compile time. Listed by hand because
/// `include_str!` needs a literal — a new module added here without being
/// listed is caught by `all_derive_modules_are_scanned` below.
const DERIVE_SOURCES: &[(&str, &str)] = &[
    ("aid_group.rs", include_str!("../src/derive/aid_group.rs")),
    ("aton.rs", include_str!("../src/derive/aton.rs")),
    ("bridges.rs", include_str!("../src/derive/bridges.rs")),
    ("cables.rs", include_str!("../src/derive/cables.rs")),
    ("hazards.rs", include_str!("../src/derive/hazards.rs")),
    ("industrial.rs", include_str!("../src/derive/industrial.rs")),
    ("lights.rs", include_str!("../src/derive/lights.rs")),
    ("lndmrk.rs", include_str!("../src/derive/lndmrk.rs")),
    ("mod.rs", include_str!("../src/derive/mod.rs")),
    ("restricted.rs", include_str!("../src/derive/restricted.rs")),
    ("sbdare.rs", include_str!("../src/derive/sbdare.rs")),
    ("stations.rs", include_str!("../src/derive/stations.rs")),
    ("tss.rs", include_str!("../src/derive/tss.rs")),
    ("waterways.rs", include_str!("../src/derive/waterways.rs")),
];

/// chartsymbols.xml symbol tokens still named in derive CODE (comments
/// stripped), grouped by why each is allowed to still be there.
///
/// A token here means a name the OLD raster sprite atlas answered for. After
/// the port the only legitimate reasons to still write one are the three
/// below; anything else is an unported emit site.
mod expected {
    /// S-52 complex line-style names — `lc`, a different mechanism from a
    /// point symbol and a separate migration stage (`port-map.json`'s `drop`
    /// block). These are NOT symbols and must never be resolved as one.
    pub const LINE_PATTERNS: &[&str] = &[
        "ACHRES51", "CBLARE51", "CBLSUB06", "CTNARE51", "CTYARE51", "ESSARE01", "FERYRT01",
        "FERYRT02", "FSHRES51", "NAVARE51", "PIPARE51", "PIPARE61", "PIPSOL05", "PIPSOL06",
        "PRCARE51", "RESARE51",
    ];

    /// Symbols with no vendored equivalent, TRACED from chartsymbols.xml's
    /// own HPGL (`port-map.json`'s `gap` block). They keep their token as
    /// their icon name and DO resolve.
    pub const TRACED_AS_TOKEN: &[&str] = &[
        "DANGER01", "FAIRWY51", "FAIRWY52", "ITZARE51", "LIGHTS81", "POSGEN01", "POSGEN03",
        "PRDINS02", "QUAPOS01", "QUARRY01", "QUESMRK1", "RACNSP01", "RCLDEF01", "TMBYRD01",
        "TSSCRS51", "TSSRON51",
    ];

    /// Symbols whose artwork was DRAWN for mivnav (jt task lppokvtq) rather
    /// than renamed onto a vendored equivalent, so they keep the S-52 token as
    /// their icon name — `port-map.json`'s `drawn` block, files in
    /// `assets/s52-icons/` proper.
    ///
    /// The difference from [`TRACED_AS_TOKEN`] is provenance, and one served
    /// consequence: both sets are real vector art in the normal catalogue and
    /// both follow the theme through `icons::roles` (xytoltso closed that gap
    /// — the traced set used to be short-circuited placeholders that could
    /// not), but the traced canvases are inflated to centre the presentation
    /// library's own PIVOT and so must never be composited
    /// (`icons::pack::TRACED_LITERAL_KEYS`), while these composite normally.
    /// Keeping the token as the name is the same choice `TSS-arrow`/`VHF`
    /// already represent — there was simply no better upstream name to rename
    /// onto, unlike `ACHARE02` -> `anchor`.
    ///
    /// `ISODGR51` is in the `drawn` block too but not here: only the frontend
    /// ever names it, never `derive/`.
    pub const DRAWN_AS_TOKEN: &[&str] = &[
        "DANGER51", "DANGER52", "DANGER53", "LOWACC03", "QUAPOS02", "QUAPOS03",
    ];
}

/// Is `s` shaped like a chartsymbols.xml symbol token? Their form is a
/// 6-letter class-ish stem plus a 2-digit variant (`ACHARE02`), with a
/// 7-letter/1-digit minority (`QUESMRK1`, `FOULGND1`). Deliberately tight
/// enough that S-57 ATTRIBUTE names in the same sources (`DRVAL1`, `SECTR2`,
/// `COLOUR1`, `BCNSHP1`) don't match — they are 6 or 7 characters, never 8.
fn is_token(s: &str) -> bool {
    if s.len() != 8
        || !s
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
    {
        return false;
    }
    let letters = s.bytes().take_while(u8::is_ascii_uppercase).count();
    let digits = s.len() - letters;
    s.bytes().skip(letters).all(|b| b.is_ascii_digit()) && (letters, digits) >= (6, 1)
}

/// Quoted string literals on non-comment parts of `src`.
fn code_string_literals(src: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in src.lines() {
        // `//` never appears inside a string literal anywhere in derive/, so
        // a plain split is enough to drop doc comments, line comments and
        // trailing comments alike.
        let code = line.split("//").next().unwrap_or("");
        for (i, part) in code.split('"').enumerate() {
            if i % 2 == 1 {
                out.push(part.to_string());
            }
        }
    }
    out
}

#[test]
fn no_unexpected_chartsymbols_token_in_derive_sources() {
    let mut found: BTreeSet<String> = BTreeSet::new();
    for (_, src) in DERIVE_SOURCES {
        for lit in code_string_literals(src) {
            if is_token(&lit) {
                found.insert(lit);
            }
        }
    }

    let mut expected: BTreeSet<String> = BTreeSet::new();
    for group in [
        expected::LINE_PATTERNS,
        expected::TRACED_AS_TOKEN,
        expected::DRAWN_AS_TOKEN,
        NO_ARTWORK,
    ] {
        expected.extend(group.iter().map(|s| (*s).to_string()));
    }

    let extra: Vec<&String> = found.difference(&expected).collect();
    let gone: Vec<&String> = expected.difference(&found).collect();
    assert!(
        extra.is_empty(),
        "unported chartsymbols.xml token(s) in chartcore/src/derive: {extra:?}\n\
         Map each in chartcore/assets/s52-icons/port-map.json and emit the \
         vendored icon name instead — the old raster sprite atlas is the one \
         thing that could draw these, and it is being retired."
    );
    assert!(
        gone.is_empty(),
        "these tokens are no longer named in chartcore/src/derive — drop them \
         from the expected lists in this file: {gone:?}"
    );
}

/// `DERIVE_SOURCES` is hand-listed (`include_str!` needs a literal), so pin
/// that it really is every module — otherwise a new file could carry an
/// unported token past the scan above without anyone noticing.
#[test]
fn all_derive_modules_are_scanned() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/derive");
    let mut on_disk: Vec<String> = std::fs::read_dir(&dir)
        .expect("src/derive is readable")
        .map(|e| {
            e.expect("dir entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .filter(|n| n.ends_with(".rs"))
        .collect();
    on_disk.sort();
    let mut listed: Vec<String> = DERIVE_SOURCES.iter().map(|(n, _)| n.to_string()).collect();
    listed.sort();
    assert_eq!(on_disk, listed);
}

/// The port map is the migration's authority, so pin that its `port` block —
/// the rename list — has real artwork behind every target. An entry pointing
/// at a name `icons::resolve` cannot answer for would make the rename it
/// prescribes impossible, and this says so at the map rather than at the
/// twentieth call site.
/// The vendored icon names `port-map.json`'s `port` block prescribes.
fn port_map_target_icons() -> BTreeSet<String> {
    let map = include_str!("../assets/s52-icons/port-map.json");
    let port = map
        .split("\"port\":")
        .nth(1)
        .and_then(|s| s.split("\"gap\":").next())
        .expect("port-map.json has a `port` block followed by a `gap` block");

    let mut icons: BTreeSet<String> = BTreeSet::new();
    for line in port.lines() {
        if let Some(rest) = line.split("\"icon\": \"").nth(1) {
            if let Some(name) = rest.split('"').next() {
                icons.insert(name.to_string());
            }
        }
    }
    assert!(
        icons.len() > 20,
        "only parsed {} icon names out of port-map.json's `port` block — the \
         file's shape changed and this scan needs updating",
        icons.len()
    );
    icons
}

#[test]
fn every_port_map_target_icon_resolves() {
    for name in &port_map_target_icons() {
        icons::resolve(name).unwrap_or_else(|e| {
            panic!("port-map.json maps onto {name:?}, which does not resolve: {e}")
        });
    }
}

/// The other half of the port: `port-map.json` prescribing a rename is only
/// worth anything if `derive/` actually emits the vendored name. Two entries
/// Note this passes on the target ICON, not on the source token, which is
/// what lets three misfiled `port` entries through harmlessly: `FERYRT01`/
/// `FERYRT02` -> `ferry` and `RESARE51` -> `no-entry` name `lc` line patterns
/// everywhere derive writes them, so those three tokens were NOT renamed —
/// but both target icons are emitted anyway, by FERYRT's area `sym` and
/// RESARE02/RESTRN01's own entry-restricted arms.
#[test]
fn every_port_map_target_icon_is_actually_emitted() {
    let emitted = emitted_symbols();
    let missing: Vec<String> = port_map_target_icons()
        .into_iter()
        .filter(|i| !emitted.contains(i))
        .collect();
    assert!(
        missing.is_empty(),
        "port-map.json renames onto these vendored icons but derive/ never \
         emits them — an emit site was missed by the port, or the map entry \
         describes an `lc` line pattern rather than a symbol: {missing:?}"
    );
}
