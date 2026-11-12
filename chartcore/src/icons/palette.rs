// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! S-57 colour/pattern tables ported from quantenschaum/mapping's
//! `scripts/s57.py`/`scripts/genicons.py` (commit `96b1104866af7aa2a040a1d33bb3d7989b8117ce`,
//! also the source of `chartcore/assets/s52-icons/`). See docs/architecture/s52-palette-tables.md.

use std::collections::BTreeSet;

/// `S57["COLOUR"]` x `object_colors`: S-57 numeric id, name, hex. Order and
/// values copied verbatim from genicons.py's `object_colors` dict (comments
/// there already annotate the S-57 id per entry).
pub const OBJECT_COLOURS: &[(u32, &str, &str)] = &[
    (1, "white", "#ffffff"),
    (2, "black", "#000000"),
    (3, "red", "#ed1c24"),
    (4, "green", "#00a650"),
    (5, "blue", "#10508c"),
    (6, "yellow", "#fab20b"),
    (7, "grey", "#808080"),
    (8, "brown", "#A52A2A"),
    (9, "amber", "#FFBF00"),
    (10, "violet", "#EE82EE"),
    (11, "orange", "#F7A837"),
    (12, "magenta", "#ec008c"),
    (13, "pink", "#FFC0CB"),
];

/// genicons.py's `light_colors`, keyed by colour word (not S-57 `COLOUR` id).
/// Copied verbatim, including the upstream quirk that `"white"` and
/// `"yellow"` share the same hex (`#fab20b`) — a faithful port, not a typo.
pub const LIGHT_COLOURS: &[(&str, &str)] = &[
    ("generic", "#800080"),
    ("white", "#fab20b"),
    ("red", "#ed1c24"),
    ("green", "#00a650"),
    ("blue", "#10508c"),
    ("yellow", "#fab20b"),
    ("orange", "#fa870b"),
    ("amber", "#FFBF00"),
];

/// Icons addressed through [`LIGHT_COLOURS`] instead of [`OBJECT_COLOURS`].
pub const LIGHTS: &[&str] = &["light", "floodlight"];

/// `TSS-arrow.svg` and siblings bake this "IHO warning magenta" verbatim
/// (no `COLORING{}` placeholder); never matches the frontend's own S-52
/// palette tokens — see docs/architecture/s52-palette-tables.md.
pub const VENDORED_WARNING_MAGENTA: &str = "#ec008c";

/// `color_types`: icons restricted to a subset of [`OBJECT_COLOURS`] (blank
/// implicitly allowed in addition, matching genicons' `[""] + cols.split()`).
/// Icons not listed here (and not in [`LIGHTS`]) may use the full
/// [`OBJECT_COLOURS`] palette (genicons' `object_colors.keys()` fallback).
pub const COLOUR_BUCKETS: &[(&[&str], &[&str])] = &[
    (
        &[
            "pillar",
            "spar",
            "can",
            "spherical",
            "barrel",
            "super-buoy",
            "conical",
            "light_float",
        ],
        &["white", "black", "red", "green", "yellow", "grey"],
    ),
    (
        &["tower", "lattice", "pile", "stake", "cairn"],
        &[
            "white", "black", "red", "green", "yellow", "brown", "grey", "orange", "blue",
        ],
    ),
    (&["sphere"], &["black", "white", "red", "green", "yellow"]),
    (&["x-shape", "cross"], &["white", "black", "yellow"]),
    (
        &[
            "2_spheres",
            "2_cones_up",
            "2_cones_down",
            "2_cones_base_together",
            "2_cones_point_together",
        ],
        &["black", "red", "green", "yellow"],
    ),
    (
        &["cylinder", "cone_point_down", "cone_point_up"],
        &["black", "white", "red", "green", "yellow"],
    ),
    (
        &["circle", "sphere_over_rhombus"],
        &["black", "white", "red", "green"],
    ),
    (
        &[
            "triangle_point_up",
            "triangle_point_down",
            "square",
            "rhombus",
            "flag",
        ],
        &["black", "white", "red", "green", "yellow", "grey"],
    ),
];

/// `patterns` tuple, in genicons.py's own order (`None` first = "uniform",
/// the no-pattern single-colour case). `"saltire"` stays commented out
/// upstream and is not ported.
pub const PATTERNS: &[Option<&str>] = &[
    None,
    Some("horizontal"),
    Some("vertical"),
    Some("squared"),
    Some("border"),
    Some("cross"),
];

/// `S57["COLPAT"]` entries genicons.py's pattern names correspond to.
/// `"cross"` deliberately has no numeric id here — upstream's lookup
/// accidentally aliases it to `TOPSHP`'s id 8; see docs/architecture/s52-palette-tables.md.
pub const PATTERN_S57_ID: &[(u32, &str)] = &[
    (1, "horizontal"),
    (2, "vertical"),
    (4, "squared"),
    (6, "border"),
];

pub fn pattern_name_for_id(id: u32) -> Option<&'static str> {
    PATTERN_S57_ID
        .iter()
        .find(|(i, _)| *i == id)
        .map(|(_, n)| *n)
}

/// The reverse of [`pattern_name_for_id`], used by [`super::pack`] to turn a
/// pattern name back into its numeric `COLPAT` id. `None` for `"cross"` (and
/// any pattern with no `S57["COLPAT"]` entry) — see [`PATTERN_S57_ID`].
pub fn pattern_id_for_name(name: &str) -> Option<u32> {
    PATTERN_S57_ID
        .iter()
        .find(|(_, n)| *n == name)
        .map(|(i, _)| *i)
}

pub fn colour_name_for_id(id: u32) -> Option<&'static str> {
    OBJECT_COLOURS
        .iter()
        .find(|(i, ..)| *i == id)
        .map(|(_, n, _)| *n)
}

/// The reverse of [`colour_name_for_id`] — used by [`super::pack`] to turn a
/// colour word back into the numeric S-57 `COLOUR` id `derive::aton`'s
/// `raw_list` scheme addresses it by.
pub fn colour_id_for_name(name: &str) -> Option<u32> {
    OBJECT_COLOURS
        .iter()
        .find(|(_, n, _)| *n == name)
        .map(|(i, ..)| *i)
}

pub fn colour_hex(name: &str) -> Option<&'static str> {
    OBJECT_COLOURS
        .iter()
        .find(|(_, n, _)| *n == name)
        .map(|(_, _, h)| *h)
}

pub fn light_colour_hex(name: &str) -> Option<&'static str> {
    LIGHT_COLOURS
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, h)| *h)
}

/// genicons.py's `colors_for`: the legal colour-word palette for `icon`
/// (`None` = blank/"no colour"). Only used by [`legal_combinations`] — see
/// docs/architecture/s52-palette-tables.md for why `resolve` doesn't consult this.
pub fn colours_for(icon: &str) -> Vec<Option<&'static str>> {
    if LIGHTS.contains(&icon) {
        return LIGHT_COLOURS.iter().map(|(n, _)| Some(*n)).collect();
    }
    for (icons, cols) in COLOUR_BUCKETS {
        if icons.contains(&icon) {
            let mut v = vec![None];
            v.extend(cols.iter().map(|c| Some(*c)));
            return v;
        }
    }
    let mut v = vec![None];
    v.extend(OBJECT_COLOURS.iter().map(|(_, n, _)| Some(*n)));
    v
}

/// genicons.py's `product`+filter: every colouring of `s` segments using at
/// most 2 distinct colours from `pool`, with adjacent segments always
/// differing. `pool` should already be blank-filtered (see [`colours_for`]).
pub fn colour_combinations(
    pool: &[Option<&'static str>],
    s: usize,
) -> Vec<Vec<Option<&'static str>>> {
    let pool: Vec<Option<&'static str>> = pool
        .iter()
        .copied()
        .filter(|c| c.is_some() || s == 1)
        .collect();
    if s == 0 {
        return vec![];
    }
    let mut out = Vec::new();
    let mut combo = Vec::with_capacity(s);
    fn rec(
        pool: &[Option<&'static str>],
        s: usize,
        combo: &mut Vec<Option<&'static str>>,
        out: &mut Vec<Vec<Option<&'static str>>>,
    ) {
        if combo.len() == s {
            let distinct: BTreeSet<Option<&'static str>> = combo.iter().copied().collect();
            if distinct.len() <= 2 {
                out.push(combo.clone());
            }
            return;
        }
        for &c in pool {
            if let Some(&prev) = combo.last() {
                if prev == c {
                    continue; // adjacent segments must differ
                }
            }
            combo.push(c);
            rec(pool, s, combo, out);
            combo.pop();
        }
    }
    rec(&pool, s, &mut combo, &mut out);
    out
}
