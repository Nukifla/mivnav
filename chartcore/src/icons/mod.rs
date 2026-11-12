// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! S-52-style ATON icon artwork: the shape x colour x pattern combinatorial
//! recolor pass, ported from quantenschaum/mapping's `scripts/genicons.py`
//! (commit `96b1104866af7aa2a040a1d33bb3d7989b8117ce`, the same one
//! `chartcore/assets/s52-icons/` was vendored from) — see [`recolor`] for
//! the port and why it goes through `usvg` rather than line-based text
//! substitution.
//!
//! [`resolve`] closes the loop with `derive::aton`, which emits symbol names
//! in exactly this addressing:
//!
//! * `PREFIX/shape/colpat/colour[,colour...]` (`PREFIX` one of `BOYSHP`,
//!   `BCNSHP`, `TOPSHP`) — raw S-57 attribute values, resolved against
//!   [`catalog`]'s shape table.
//! * `<icon>/<colourword>` (`sphere/red`, `flag/generic`) — genicons.py's
//!   word-based address for the no-pattern variant. `generic` means a real
//!   colour for `light`/`floodlight` but "no colour" for everything else
//!   (see `palette` module doc).
//! * A bare name (`withy-starboard`, `pilpnt`, …) — a fixed, non-parametric
//!   base icon, passed through [`recolor::normalize`] unchanged.

pub mod catalog;
pub mod composite;
pub mod pack;
pub mod palette;
pub mod recolor;
pub mod roles;

use std::fmt;

pub use recolor::RecolorError;

/// Which colour surface an icon renders onto. [`ColourMode::Roles`] bakes a
/// `#fe00XX` sentinel per [`roles`] role for client-side substitution;
/// strictly OPT-IN (`Day` default) — pinned by `pack`'s day-round-trip test.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ColourMode {
    #[default]
    Day,
    Roles,
}

#[derive(Debug)]
pub enum IconError {
    /// `key` doesn't match any of the three address forms `resolve`
    /// understands.
    BadKey(String),
    /// A bare/word-form name that isn't a vendored base icon at all (not a
    /// "no artwork for this variant" gap — a genuinely unknown icon name).
    UnknownIcon(String),
    Recolor(RecolorError),
    /// [`composite::stack`] was called with no [`composite::Role::Base`]
    /// layer — every other layer places relative to the base's own pivot,
    /// so there is nothing to place them against.
    NoBaseLayer,
}

impl fmt::Display for IconError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            IconError::BadKey(k) => write!(f, "not a recognised icon key: {k:?}"),
            IconError::UnknownIcon(n) => write!(f, "no vendored base icon named {n:?}"),
            IconError::Recolor(e) => write!(f, "{e}"),
            IconError::NoBaseLayer => write!(f, "composite: no Role::Base layer in the stack"),
        }
    }
}

impl std::error::Error for IconError {}

impl From<RecolorError> for IconError {
    fn from(e: RecolorError) -> Self {
        IconError::Recolor(e)
    }
}

/// Separates a topmark/daymark key from the base-body key whose mast it
/// rides: `TOPSHP/3/0/0@BOYSHP/3/0/1` (jt task vplwqzmr). See
/// docs/architecture/icon-key-addressing.md ("OVERLAY_REF_SEP").
pub const OVERLAY_REF_SEP: char = '@';

/// Split a key into its symbol address and its optional reference-body key.
/// Anything malformed (empty side, a second separator) comes back whole, so
/// the ordinary resolution path reports it instead of it being silently
/// half-parsed into an asset lookup.
pub fn split_overlay_ref(key: &str) -> (&str, Option<&str>) {
    match key.split_once(OVERLAY_REF_SEP) {
        Some((k, r)) if !k.is_empty() && !r.is_empty() && !r.contains(OVERLAY_REF_SEP) => {
            (k, Some(r))
        }
        _ => (key, None),
    }
}

/// Render the icon `aton.rs`'s `sym_s`/`sym_topmark` key names — see the
/// module doc for the three address forms understood. A [`OVERLAY_REF_SEP`]
/// mount reference is placement, not shape, and is ignored here.
pub fn resolve(key: &str) -> Result<String, IconError> {
    resolve_with(key, ColourMode::Day)
}

/// [`resolve`], on a chosen colour surface — see [`ColourMode`]. In
/// [`ColourMode::Roles`], [`roles::ASSET_HEXES`] runs after the recolor pass
/// to catch inline-style colours baked into asset text, even for parametric icons.
pub fn resolve_with(key: &str, mode: ColourMode) -> Result<String, IconError> {
    let (key, _mount) = split_overlay_ref(key);
    let parts: Vec<&str> = key.split('/').collect();
    let svg = match parts.as_slice() {
        [prefix @ ("BOYSHP" | "BCNSHP" | "TOPSHP"), shape, colpat, colours] => {
            resolve_numeric(prefix, shape, colpat, colours, mode)?
        }
        [icon, colourword] => resolve_word(icon, colourword, mode)?,
        // The literal form applies the pass itself: its `,RRGGBB` override
        // has to land AFTER it, on the sentinel rather than on the hex.
        [name] => return resolve_literal(name, mode),
        _ => return Err(IconError::BadKey(key.to_string())),
    };
    Ok(match mode {
        ColourMode::Day => svg,
        ColourMode::Roles => roles::substitute_asset_hexes(&svg),
    })
}

/// The base icon name for a `PREFIX/shape` pair (`BOYSHP/4` -> `"pillar"`),
/// shared with [`composite`] so it reads pivot geometry off the exact same
/// asset `resolve` recolors — the two can never disagree on which file a
/// numeric key names.
pub(crate) fn numeric_icon_name(prefix: &str, shape: &str) -> Result<&'static str, IconError> {
    let shape_id: u32 = shape
        .parse()
        .map_err(|_| IconError::BadKey(format!("{prefix}/{shape}")))?;
    catalog::shape_icon(prefix, shape_id)
        .ok_or_else(|| IconError::UnknownIcon(format!("{prefix}/{shape}")))
}

fn resolve_numeric(
    prefix: &str,
    shape: &str,
    colpat: &str,
    colours: &str,
    mode: ColourMode,
) -> Result<String, IconError> {
    let icon = numeric_icon_name(prefix, shape)?;
    let colpat_id: u32 = colpat
        .parse()
        .map_err(|_| IconError::BadKey(format!("{prefix}/{shape}/{colpat}/{colours}")))?;
    let colour_ids: Vec<u32> = colours
        .split(',')
        .map(str::parse)
        .collect::<Result<_, _>>()
        .map_err(|_| IconError::BadKey(format!("{prefix}/{shape}/{colpat}/{colours}")))?;

    let base = catalog::load_icon(icon)?;

    // Unknown COLPAT ids (S-57 defines 3/diagonal and 5/stripes, neither of
    // which genicons.py's icon set has artwork for; anything outside
    // 0..=6 is malformed data) fall back to the no-pattern/uniform variant.
    let pattern = if colpat_id == 0 {
        None
    } else {
        palette::pattern_name_for_id(colpat_id)
    };
    let colour_names: Vec<Option<&'static str>> = colour_ids
        .iter()
        .map(|&id| palette::colour_name_for_id(id))
        .collect();

    // A "pattern" that didn't resolve (unknown COLPAT) also falls to
    // uniform here, alongside the explicit colpat==0 case.
    let effective_pattern = if colpat_id != 0 && pattern.is_none() {
        None
    } else {
        pattern
    };

    if effective_pattern.is_none() {
        // Uniform icons are single-colour by construction; a raw COLOUR
        // list longer than 1 (legal when COLPAT is absent/0 but COLOUR
        // still lists e.g. "3,1") only ever contributes its first value.
        let first = colour_names.first().copied().flatten();
        return Ok(resolve_with_fallback(&base, None, &[first], mode)?);
    }

    resolve_with_fallback(&base, effective_pattern, &colour_names, mode).map_err(IconError::from)
}

/// `recolor_variant`, degrading through genicons.py's exact combo, then
/// "uniform, first colour only", then "uniform, no colour" before giving up.
/// [`RecolorError::NotParametric`] (fixed-colour art addressed numerically,
/// e.g. `besom_point_up`/`down`) is not a failure — see
/// docs/architecture/icon-key-addressing.md for the degrade ladder and why.
fn resolve_with_fallback(
    base: &str,
    pattern: Option<&str>,
    colours: &[Option<&str>],
    mode: ColourMode,
) -> Result<String, RecolorError> {
    match recolor::recolor_variant_with(base, pattern, colours, mode) {
        Ok(svg) => return Ok(svg),
        Err(RecolorError::UnknownVariant { .. }) => {}
        Err(RecolorError::NotParametric) => return recolor::normalize(base),
        Err(e) => return Err(e),
    }

    // Tier 2: uniform, first colour only — skip if that's the exact call
    // that just failed (pattern already `None` and a single colour).
    let first = colours.first().copied().flatten();
    if pattern.is_some() || colours.len() != 1 {
        match recolor::recolor_variant_with(base, None, &[first], mode) {
            Ok(svg) => return Ok(svg),
            Err(RecolorError::UnknownVariant { .. }) => {}
            Err(e) => return Err(e),
        }
    }

    // Tier 3: uniform, no colour at all — skip if that's what tier 2 (or
    // the original call) already tried.
    if first.is_some() {
        return recolor::recolor_variant_with(base, None, &[None], mode);
    }
    Err(RecolorError::UnknownVariant {
        pattern: None,
        sections: 1,
    })
}

fn resolve_word(icon: &str, colourword: &str, mode: ColourMode) -> Result<String, IconError> {
    let base = catalog::load_icon(icon).map_err(|_| IconError::UnknownIcon(icon.to_string()))?;
    let is_light = palette::LIGHTS.contains(&icon);

    let colour: Option<&str> = if colourword == "generic" {
        // `light`/`floodlight` treat "generic" as a real purple; every other
        // icon (light_float included, despite the name) treats it as
        // blank/no-colour (see module doc).
        if is_light {
            Some("generic")
        } else {
            None
        }
    } else if is_light && palette::light_colour_hex(colourword).is_none() {
        // A colour word outside `light_colors` has no artwork; fall back to
        // the colour-agnostic "generic" purple rather than fail outright.
        Some("generic")
    } else {
        // `light_float`'s word set is the ordinary object-colour palette;
        // every word `light_vessel_symbol` emits is a real entry there
        // except "x" (its unrecognised-COLOUR fallback), which resolves to
        // None here and is left uncoloured — no special case needed.
        Some(colourword)
    };

    resolve_with_fallback(&base, None, &[colour], mode).map_err(IconError::from)
}

/// Is `s` exactly 6 ASCII hex digits (an `RRGGBB` colour override, no `#`)?
fn is_hex6(s: &str) -> bool {
    s.len() == 6 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Split a literal icon name from its optional `,RRGGBB` colour-override
/// suffix (valid or not), returning just the base name — the geometry a
/// colour override rides on is identical to the unsuffixed icon's, so
/// [`composite`]'s own raw-asset lookup (which needs the base file, not the
/// recoloured one) shares this rather than re-deriving the same split.
pub(crate) fn literal_base_name(name: &str) -> &str {
    name.split_once(',').map_or(name, |(n, _)| n)
}

/// A bare vendored-icon name, optionally suffixed `,RRGGBB` (a caller colour
/// override). In [`ColourMode::Roles`] the art is role-substituted FIRST, then
/// the override replaces THAT sentinel — reversed, a real `bcol` could alias a theme role.
fn resolve_literal(name: &str, mode: ColourMode) -> Result<String, IconError> {
    let base_name = literal_base_name(name);
    let override_hex = name
        .split_once(',')
        .map(|(_, hex)| hex)
        .filter(|hex| is_hex6(hex));
    let base =
        catalog::load_icon(base_name).map_err(|_| IconError::UnknownIcon(base_name.to_string()))?;
    if mode == ColourMode::Roles {
        // Substituted AFTER `normalize`, where every value is guaranteed
        // lowercase `#rrggbb` — raw assets mix `#231F20`, inline styles and
        // bare colour names, none of which source-text substitution catches.
        let svg = roles::substitute_asset_hexes(&recolor::normalize(&base)?);
        return Ok(match override_hex {
            Some(hex) => svg.replace(roles::WARN_MAGENTA, &format!("#{hex}")),
            None => svg,
        });
    }
    let recoloured = match override_hex {
        Some(hex) => base.replace(palette::VENDORED_WARNING_MAGENTA, &format!("#{hex}")),
        None => base,
    };
    Ok(recolor::normalize(&recoloured)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn well_formed(svg: &str) {
        assert!(svg.starts_with("<svg"), "not a bare <svg> root: {svg}");
        roxmltree::Document::parse(svg).expect("usvg output must itself be valid XML");
    }

    #[test]
    fn numeric_boyshp_pillar_red_white() {
        // BOYSHP=4 (pillar), COLPAT=1 (horizontal), COLOUR=3,1 (red,white)
        // — matches `gen/BOYSHP/4/1/3,1.svg` in genicons.py's own reference
        // output (spot-checked by hand against a real run of genicons.py).
        let svg = resolve("BOYSHP/4/1/3,1").unwrap();
        well_formed(&svg);
        assert!(svg.contains("#ed1c24"), "expected red: {svg}");
        assert!(svg.contains("#ffffff"), "expected white: {svg}");
    }

    #[test]
    fn numeric_topshp_default_sphere_no_colour() {
        // TOPSHP defaults: shape 3 (sphere), COLPAT 0, COLOUR 0 — the
        // "no attribute present at all" case `topshp_symbol` produces.
        let svg = resolve("TOPSHP/3/0/0").unwrap();
        well_formed(&svg);
    }

    #[test]
    fn word_form_matches_aton_rs_topmark_overlay_names() {
        for key in [
            "sphere/red",
            "2_spheres/black",
            "flag/generic",
            "light_float/white",
        ] {
            well_formed(&resolve(key).unwrap_or_else(|e| panic!("{key}: {e}")));
        }
    }

    #[test]
    fn literal_names_pass_through() {
        for key in [
            "withy-starboard",
            "withy-port",
            "besom_point_down",
            "besom_point_up",
            "pilpnt",
            "dir-buoyage-a",
            "dir-buoyage-b",
            // derive::restricted's MARCUL/FERYRT point symbols — real
            // vendored artwork, not the old chartsymbols.xml sheet's
            // abstract MARCUL02/FRYARE51/52 tokens.
            "marine-farm",
            "ferry",
            // derive::restricted's TSSLPT ORIENT-branch symbol — real
            // vendored artwork (TSS-arrow.svg), not the old chartsymbols.xml
            // TSSLPT51 token.
            "TSS-arrow",
            // derive::industrial's SILTNK/PRDARE point symbols — real
            // vendored artwork, not the old chartsymbols.xml TOWERS12/
            // FLASTK11/01 tokens.
            "watertower",
            "flare-stack",
            // derive::lndmrk's CATLMK/FUNCTN point symbols — real vendored
            // artwork, not the old chartsymbols.xml CAIRNS/CHIMNY/DSHAER/
            // FLGSTF/MSTCON/MONUMT/DOMES/RASCAN/TOWERS/WNDMIL/WIMCON/BUIREL
            // tokens. "flare-stack" (above) is reused, not re-listed.
            "cairn-lmk",
            "chimney",
            "dish_aerial",
            "flagstaff",
            "mast",
            "monument",
            "column",
            "obelisk",
            "statue",
            "dome",
            "radar_scanner",
            "tower-lmk",
            "windmill",
            "windmotor",
            "church",
        ] {
            well_formed(&resolve(key).unwrap_or_else(|e| panic!("{key}: {e}")));
        }
    }

    /// szrwnlum: the light position star (`derive::lights`'s `sym_star`) must
    /// follow the THEME PALETTE, not bake the asset's literal black. Both
    /// stars are plain literal art whose only colours are `#000000` (the star
    /// itself) and, for the major, `#ffffff` (the punched-out centre), so
    /// `roles::ASSET_HEXES` already maps them onto `ink`/`paper` — this pins
    /// that, because a baked black star on a night palette is exactly the
    /// regression this epic's palette work just removed elsewhere.
    #[test]
    fn the_light_stars_follow_the_theme_palette() {
        for name in ["light-major", "light-minor"] {
            let roles = resolve_with(name, ColourMode::Roles).unwrap();
            well_formed(&roles);
            assert!(
                roles.contains(roles::INK),
                "{name}: no ink sentinel: {roles}"
            );
            assert!(
                !roles.contains("#000000"),
                "{name}: literal black survived: {roles}"
            );
            // Round-trip: substituting every sentinel back to its day hex
            // must reproduce the Day render byte for byte.
            assert_eq!(
                roles::substitute_to_day(&roles),
                resolve(name).unwrap(),
                "{name}"
            );
        }
        // the major star's centre is punched out in `paper`, so it inverts
        // with the palette rather than staying a fixed white dot.
        let major = resolve_with("light-major", ColourMode::Roles).unwrap();
        assert!(major.contains(roles::PAPER), "{major}");
        assert!(!major.contains("#ffffff"), "{major}");
    }

    #[test]
    fn literal_colour_override_substitutes_the_vendored_warning_magenta() {
        // yxnrrtwk: TSS-arrow.svg bakes a fixed magenta that never matches any
        // of the frontend's theme-dependent CHMGD hexes. The frontend asks for
        // its own resolved hex via a `,RRGGBB` suffix on the literal name.
        let day = resolve("TSS-arrow").unwrap();
        assert!(day.contains(palette::VENDORED_WARNING_MAGENTA), "{day}");

        let recoloured = resolve("TSS-arrow,c545c3").unwrap();
        assert!(recoloured.contains("#c545c3"), "{recoloured}");
        assert!(
            !recoloured.contains(palette::VENDORED_WARNING_MAGENTA),
            "{recoloured}"
        );
        // Only the colour changed — same silhouette (same non-colour markup).
        assert_eq!(
            day.replace(palette::VENDORED_WARNING_MAGENTA, "#c545c3"),
            recoloured,
        );
    }

    #[test]
    fn literal_colour_override_degrades_to_default_on_malformed_hex() {
        // A missing/non-hex suffix is a display nuance, not a "no artwork"
        // gap: it must still resolve, at the vendored default colour.
        for key in ["TSS-arrow,not-a-colour", "TSS-arrow,fff", "TSS-arrow,"] {
            let svg = resolve(key).unwrap_or_else(|e| panic!("{key}: {e}"));
            assert!(
                svg.contains(palette::VENDORED_WARNING_MAGENTA),
                "{key}: {svg}"
            );
        }
    }

    #[test]
    fn literal_colour_override_only_applies_to_the_one_placeholder_hex() {
        // An icon whose only colour is NOT the warning magenta is untouched by
        // an override suffix — nothing to substitute, no error either.
        let plain = resolve("pilpnt").unwrap();
        let with_suffix = resolve("pilpnt,c545c3").unwrap();
        assert_eq!(plain, with_suffix);
    }

    #[test]
    fn light_vessel_colour_words_aton_rs_can_emit_all_resolve() {
        // derive::aton::light_vessel_symbol emits white/black/red/green/
        // yellow/grey/x, all against the "light_float/<word>" key —
        // light_float's own bucket (palette::COLOUR_BUCKETS) covers
        // white/black/red/green/yellow/grey directly; "x" (its raw-
        // COLOUR-unrecognised fallback) is not a real colour anywhere and
        // must degrade to an uncoloured segment rather than error.
        for word in ["white", "black", "red", "green", "yellow", "grey", "x"] {
            let key = format!("light_float/{word}");
            well_formed(&resolve(&key).unwrap_or_else(|e| panic!("{key}: {e}")));
        }
    }

    #[test]
    fn ice_buoy_boyshp_8_falls_back_rather_than_erroring() {
        // No vendored artwork for BOYSHP=8 at all.
        well_formed(&resolve("BOYSHP/8/0/2").unwrap());
    }

    #[test]
    fn unknown_colpat_falls_back_to_uniform() {
        // COLPAT=3 (diagonal) has no icon set artwork for any icon.
        well_formed(&resolve("BOYSHP/4/3/3").unwrap());
    }

    #[test]
    fn unknown_bare_name_is_reported_not_panicking() {
        assert!(matches!(
            resolve("nonsense"),
            Err(IconError::UnknownIcon(_))
        ));
    }

    #[test]
    fn malformed_key_is_reported_not_panicking() {
        assert!(matches!(resolve("BOYSHP/x/y"), Err(IconError::BadKey(_))));
    }

    /// wvrlupqx: the same by-construction contract as
    /// `every_sym_key_derive_aton_can_emit_for_these_features_resolves`
    /// below, but for `derive::lights` — run `derive::lights::apply` over
    /// synthetic LIGHTS features spanning every colour bucket and CATLIT
    /// arm, and resolve whatever `sym`/`sym_extra` it emits (`light/<word>`,
    /// `floodlight/<word>`, or the literal QUESMRK1/LIGHTS81 it still emits
    /// for the two cases with no vendored quantenschaum equivalent).
    #[test]
    fn every_sym_key_derive_lights_can_emit_resolves() {
        use crate::coords::{Extent, WorldXy};
        use crate::derive::lights;
        use crate::model::{AttrValue, Cell, CellMeta, Feature, Geometry};

        fn light(attrs: &[(&str, AttrValue)]) -> Feature {
            let map = attrs
                .iter()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect();
            Feature::new(
                0,
                "LIGHTS".into(),
                map,
                Some(Geometry::Point(WorldXy::new(0, 0))),
            )
        }

        let mut cell = Cell {
            meta: CellMeta::default(),
            extent: Extent::invalid(),
            features: vec![
                // flare: red, green, yellow-bucket, generic/default — light/<word>
                light(&[
                    ("COLOUR", AttrValue::IntList(vec![3])),
                    ("VALNMR", AttrValue::Float(5.0)),
                ]),
                light(&[
                    ("COLOUR", AttrValue::IntList(vec![4])),
                    ("VALNMR", AttrValue::Float(5.0)),
                ]),
                light(&[
                    ("COLOUR", AttrValue::IntList(vec![6])),
                    ("VALNMR", AttrValue::Float(5.0)),
                ]),
                light(&[("VALNMR", AttrValue::Float(5.0))]), // no COLOUR -> generic
                // directional -> literal QUESMRK1 (no vendored equivalent)
                light(&[
                    ("CATLIT", AttrValue::IntList(vec![1])),
                    ("COLOUR", AttrValue::IntList(vec![3])),
                ]),
                // flood/spot adjunct -> floodlight/<word>
                light(&[
                    ("CATLIT", AttrValue::IntList(vec![8])),
                    ("COLOUR", AttrValue::IntList(vec![4])),
                    ("SECTR1", AttrValue::Float(0.0)),
                    ("SECTR2", AttrValue::Float(90.0)),
                ]),
                // strip adjunct -> literal LIGHTS81 (no vendored equivalent)
                light(&[
                    ("CATLIT", AttrValue::IntList(vec![9])),
                    ("SECTR1", AttrValue::Float(0.0)),
                    ("SECTR2", AttrValue::Float(90.0)),
                ]),
            ],
        };
        lights::apply(&mut cell);

        // EVERY sym/sym_extra value must resolve — including QUESMRK1
        // (directional) and LIGHTS81 (strip light), which have no vendored
        // quantenschaum equivalent and are drawn from chartsymbols.xml's own
        // HPGL instead. That is the whole point of the single-icon-source
        // migration: chartcore's catalogue answers for every name derive can
        // emit, so the frontend needs no second pipeline to cover the gaps.
        // This test used to assert the OPPOSITE for these two — that they
        // must NOT resolve — back when they were served by
        // ./lightSymIcons.ts's separate static-SVG path.
        let mut checked = 0;
        let mut placeholders = 0;
        for f in &cell.features {
            for key_attr in ["sym", "sym_extra", "sym_star"] {
                let Some(key) = f.attr(key_attr).and_then(AttrValue::as_str) else {
                    continue;
                };
                resolve(key).unwrap_or_else(|e| panic!("{} {key_attr}={key:?}: {e}", f.acronym));
                if catalog::is_placeholder(literal_base_name(key)) {
                    placeholders += 1;
                }
                checked += 1;
            }
        }
        // 7 sym/sym_extra + one `sym_star` per feature: the position star is
        // branch-independent, so ALL 7 lights carry one (stlozvlo widened
        // szrwnlum's ring/arc-only emission — see derive/lights.rs).
        assert_eq!(
            checked, 14,
            "expected 14 sym/sym_extra/sym_star values above"
        );
        assert_eq!(
            placeholders, 0,
            "nothing here may resolve via a TEMPORARY placeholder — one that \
             does is served day-fixed under every theme. QUESMRK1 and \
             LIGHTS81 were the last two; xytoltso recoloured them onto role \
             hexes and emptied `placeholders.json`"
        );
    }

    /// The actual `uzosnxzs`<->`nomqnsqw` contract: run `derive::aton::apply`
    /// over synthetic features (not hand-written key strings) and resolve
    /// whatever `sym_s`/`sym_topmark` it emits. Proves the two tasks agree
    /// on the addressing scheme by construction, not by us independently
    /// guessing the same string twice.
    #[test]
    fn every_sym_key_derive_aton_can_emit_for_these_features_resolves() {
        use crate::coords::{Extent, WorldXy};
        use crate::derive::aton;
        use crate::model::{AttrValue, Cell, CellMeta, Feature, Geometry};

        fn feature(acronym: &str, attrs: &[(&str, AttrValue)]) -> Feature {
            let map = attrs
                .iter()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect();
            Feature::new(
                0,
                acronym.into(),
                map,
                Some(Geometry::Point(WorldXy::new(0, 0))),
            )
        }

        let mut cell = Cell {
            meta: CellMeta::default(),
            extent: Extent::invalid(),
            features: vec![
                // BOYLAT, BOYSHP=4 (pillar), COLPAT=1 (horizontal), COLOUR=3,1 (red,white).
                feature(
                    "BOYLAT",
                    &[
                        ("BOYSHP", AttrValue::Int(4)),
                        ("COLPAT", AttrValue::IntList(vec![1])),
                        ("COLOUR", AttrValue::IntList(vec![3, 1])),
                    ],
                ),
                // BCNSPP with no COLOUR at all — bcnshp_symbol's numeric fallback path.
                feature("BCNSPP", &[]),
                // TOPMAR, TOPSHP=13 (2 cones up / north).
                feature("TOPMAR", &[("TOPSHP", AttrValue::Int(13))]),
                // MORFAC, CATMOR=7 (mooring buoy) — reuses boyshp_symbol.
                feature("MORFAC", &[("CATMOR", AttrValue::Int(7))]),
                // LITVES, COLOUR=2 (black) — light_vessel_symbol's "black" word,
                // which light_float's own bucket covers directly (no fallback needed).
                feature("LITVES", &[("COLOUR", AttrValue::IntList(vec![2]))]),
                // BOYSPP with CATSPM=46 (special-purpose flag) — topmark_overlay's
                // "flag/generic" arm (blank colour, not a real one).
                feature("BOYSPP", &[("CATSPM", AttrValue::IntList(vec![46]))]),
            ],
        };
        aton::apply(&mut cell, None);

        let mut checked = 0;
        for f in &cell.features {
            for key_attr in ["sym_s", "sym_topmark"] {
                if let Some(key) = f.attr(key_attr).and_then(AttrValue::as_str) {
                    resolve(key)
                        .unwrap_or_else(|e| panic!("{} {key_attr}={key:?}: {e}", f.acronym));
                    checked += 1;
                }
            }
        }
        assert!(
            checked >= 6,
            "only resolved {checked} sym_* keys, expected at least one per feature"
        );
    }
}
