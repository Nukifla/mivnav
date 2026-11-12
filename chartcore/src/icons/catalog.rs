// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Maps `aton.rs`'s numeric symbol-name prefixes (`BOYSHP`, `BCNSHP`,
//! `TOPSHP`) to a base icon filename under `chartcore/assets/s52-icons/`.
//! Provenance and shape-id lookup details: docs/architecture/icon-key-addressing.md

use std::collections::HashMap;
use std::sync::OnceLock;

use super::recolor::RecolorError;

// `EMBEDDED_ICONS: &[(&str, &str)]` from `chartcore/assets/s52-icons/`,
// baked in at compile time by build.rs rather than read from
// `CARGO_MANIFEST_DIR`: the pyo3 wheel on the Pi has no source tree to read at serve time.
include!(concat!(env!("OUT_DIR"), "/s52_icons.rs"));

/// Every vendored base icon's name, in sorted order.
pub fn icon_names() -> impl Iterator<Item = &'static str> {
    EMBEDDED_ICONS.iter().map(|(name, _)| *name)
}

/// Is `name` a TEMPORARY placeholder rather than real vendored artwork?
/// Always false today; see docs/architecture/aton-icon-loading.md for why
/// the mechanism is kept anyway.
pub fn is_placeholder(name: &str) -> bool {
    PLACEHOLDER_ICONS.contains(&name)
}

/// Every placeholder's name, sorted — the same worklist, for callers that want
/// to report on it rather than test one name.
pub fn placeholder_names() -> impl Iterator<Item = &'static str> {
    PLACEHOLDER_ICONS.iter().copied()
}

pub fn load_icon(name: &str) -> Result<String, RecolorError> {
    EMBEDDED_ICONS
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, svg)| (*svg).to_string())
        .ok_or_else(|| RecolorError::Xml(format!("{name}.svg: no such vendored icon")))
}

pub fn is_parametric(svg: &str) -> bool {
    svg.contains("COLORING{}")
}

/// `id="PREFIX_n"` embedded in `svg` — first in document order (mirrors
/// genicons.py's `re.search` first-match semantics; equivalent here because
/// no vendored icon reorders content after the id via `<defs>`/`<use>`).
fn embedded_shape_id(svg: &str) -> Option<(String, u32)> {
    let doc = roxmltree::Document::parse(svg).ok()?;
    for node in doc.descendants() {
        let Some(id) = node.attribute("id") else {
            continue;
        };
        let Some((prefix, suffix)) = id.split_once('_') else {
            continue;
        };
        if prefix.len() == 6
            && prefix.bytes().all(|b| b.is_ascii_uppercase())
            && !suffix.is_empty()
            && suffix.bytes().all(|b| b.is_ascii_digit())
        {
            if let Ok(n) = suffix.parse::<u32>() {
                return Some((prefix.to_string(), n));
            }
        }
    }
    None
}

/// The S-57 attribute class an icon's artwork belongs to (`"BOYSHP"` for
/// `pillar.svg`, `None` for a free-standing symbol like `caution.svg`).
/// `composite::geometry` uses it to pick which end of the canvas an
/// anchor-less icon binds to; see docs/architecture/icon-key-addressing.md.
pub fn embedded_shape_class(svg: &str) -> Option<String> {
    embedded_shape_id(svg).map(|(prefix, _)| prefix)
}

/// `(prefix, id) -> base icon name`, scanned from every embedded icon
/// ([`icon_names`]). Ambiguous ids (e.g. `BCNSHP_1`) resolve deterministically
/// by sorted filename order, first claimant wins — see
/// docs/architecture/icon-key-addressing.md.
fn build_table() -> HashMap<(String, u32), String> {
    let mut table = HashMap::new();
    for (name, svg) in EMBEDDED_ICONS {
        if let Some((prefix, id)) = embedded_shape_id(svg) {
            table
                .entry((prefix, id))
                .or_insert_with(|| (*name).to_string());
        }
    }
    table
}

fn table() -> &'static HashMap<(String, u32), String> {
    static TABLE: OnceLock<HashMap<(String, u32), String>> = OnceLock::new();
    TABLE.get_or_init(build_table)
}

/// Mirrors `derive::aton`'s fallback for a missing S-57 attribute
/// (`BOYSHP`->5/spar, `BCNSHP`->5/pile, `TOPSHP`->3/sphere), reused when the
/// attribute is present but names a shape id with no vendored artwork —
/// see docs/architecture/icon-key-addressing.md.
fn default_id(prefix: &str) -> u32 {
    match prefix {
        "BOYSHP" => 5,
        "BCNSHP" => 5,
        "TOPSHP" => 3,
        _ => 0,
    }
}

/// Base icon name for `PREFIX/id`, falling back to [`default_id`]'s shape
/// when `id` has no vendored artwork.
pub fn shape_icon(prefix: &str, id: u32) -> Option<&'static str> {
    let t = table();
    t.get(&(prefix.to_string(), id))
        .or_else(|| t.get(&(prefix.to_string(), default_id(prefix))))
        .map(String::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boyshp_bcnshp_topshp_cover_the_shapes_aton_rs_defaults_to() {
        // aton.rs's own attribute defaults must resolve to real artwork,
        // or every ATON feature missing that attribute would fail to
        // render.
        assert_eq!(shape_icon("BOYSHP", 5), Some("spar"));
        assert_eq!(shape_icon("BCNSHP", 5), Some("pile"));
        assert_eq!(shape_icon("TOPSHP", 3), Some("sphere"));
    }

    #[test]
    fn pillar_is_boyshp_4() {
        assert_eq!(shape_icon("BOYSHP", 4), Some("pillar"));
    }

    #[test]
    fn missing_shape_id_falls_back_to_the_class_default() {
        // BOYSHP=8 (ice-buoy) has no vendored artwork.
        assert_eq!(shape_icon("BOYSHP", 8), shape_icon("BOYSHP", 5));
    }

    #[test]
    fn bcnshp_1_collision_resolves_to_perch() {
        assert_eq!(shape_icon("BCNSHP", 1), Some("perch"));
    }
}
