// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! One `sym_s`/`sym_topmark` key -> one pivot-centred SVG, rendered ON
//! DEMAND ([`render`]) rather than pre-baked into a spritesheet (jt task
//! qkmvmwps). See docs/architecture/on-demand-icon-rendering.md for the full
//! design rationale: why on-demand, what the enumeration test covers and why
//! not more, and the Base/Overlay/Light role split.

use super::composite::{self, Layer, Role};
#[cfg(test)]
use super::{catalog, palette, recolor};
use super::{split_overlay_ref, ColourMode, IconError};

#[cfg(test)]
fn base_stack(key: &str) -> Result<String, IconError> {
    base_stack_with(key, ColourMode::Day)
}

fn base_stack_with(key: &str, mode: ColourMode) -> Result<String, IconError> {
    composite::stack_with(
        &[Layer {
            key,
            role: Role::Base,
        }],
        mode,
    )
}

/// The stand-in base [`composite::stack_overlay`] measures `mast_top`
/// against when a topmark carries no reference of its own — a genuinely
/// stand-alone TOPMAR has no better answer. See [`render`].
const REFERENCE_BASE_FOR_OVERLAY: &str = "pillar";

#[cfg(test)]
fn overlay_stack(key: &str) -> Result<String, IconError> {
    overlay_stack_with(key, ColourMode::Day)
}

fn overlay_stack_with(key: &str, mode: ColourMode) -> Result<String, IconError> {
    composite::stack_overlay_with(REFERENCE_BASE_FOR_OVERLAY, key, mode)
}

/// `light/*`/`floodlight/*` keys ([`Role::Light`]): no base body to ride, so
/// this goes through [`composite::light_stack`], not [`composite::stack`]
/// (which requires a `Role::Base` layer — see its doc). See [`role_for_key`].
#[cfg(test)]
fn light_stack(key: &str) -> Result<String, IconError> {
    light_stack_with(key, ColourMode::Day)
}

fn light_stack_with(key: &str, mode: ColourMode) -> Result<String, IconError> {
    composite::light_stack_with(key, mode)
}

/// Body (`Role::Base`) or topmark/daymark (`Role::Overlay`)? NOT derivable
/// from the key's grammar alone — a wrong answer is a silently MISPLACED
/// icon, not a missing one. See docs/architecture/on-demand-icon-rendering.md.
fn role_for_key(key: &str) -> Role {
    if key.starts_with("TOPSHP/") {
        return Role::Overlay;
    }
    if key.starts_with("BOYSHP/") || key.starts_with("BCNSHP/") {
        return Role::Base;
    }
    if key.starts_with("light/") || key.starts_with("floodlight/") {
        return Role::Light;
    }
    if OVERLAY_LITERAL_KEYS.contains(&key) {
        Role::Overlay
    } else {
        Role::Base
    }
}

/// Literal base-icon names that are TILEABLE LINE-PATTERN images
/// (cable/pipeline), never pivot-padded like point symbols — padding would
/// break their repeating period. See docs/architecture/on-demand-icon-rendering.md.
const PATTERN_LITERAL_KEYS: &[&str] = &["cable", "pipeline"];

/// The 16 symbols TRACED from chartsymbols.xml's own HPGL, served on their
/// hand-placed canvas verbatim — `composite::stack`'s padding would silently
/// shift them. See docs/architecture/on-demand-icon-rendering.md.
const TRACED_LITERAL_KEYS: &[&str] = &[
    "DANGER01", "FAIRWY51", "FAIRWY52", "ITZARE51", "LIGHTS81", "POSGEN01", "POSGEN03", "PRDINS02",
    "QUAPOS01", "QUARRY01", "QUESMRK1", "RACNSP01", "RCLDEF01", "TMBYRD01", "TSSCRS51", "TSSRON51",
];

/// Render one `sym_s`/`sym_topmark` key to a standalone, pivot-centred SVG
/// with an explicit `viewBox` (usvg's writer otherwise drops it as redundant
/// — every consumer needs it, see docs/architecture/on-demand-icon-rendering.md).
/// A key may name the base body it rides via [`super::OVERLAY_REF_SEP`]; an
/// unresolvable reference degrades to the `pillar` stand-in rather than 404ing.
pub fn render(key: &str) -> Result<String, IconError> {
    render_with(key, ColourMode::Day)
}

/// [`render`], on a chosen colour surface — see [`ColourMode`]. The only
/// entry point exposing the mode (pyo3 bridge / `/icons` route). Every key
/// now honours [`ColourMode::Roles`]; [`TRACED_LITERAL_KEYS`] is the last
/// holdout, and only for its CANVAS, not its colour.
pub fn render_with(key: &str, mode: ColourMode) -> Result<String, IconError> {
    let (key, reference) = split_overlay_ref(key);
    // A placeholder is an opaque document exempt from recolouring (usvg
    // drops the `<image>` a PNG crop needs). Empty list today, kept as a
    // guard for a future gap. See `catalog::is_placeholder`.
    if super::catalog::is_placeholder(super::literal_base_name(key)) {
        return Ok(with_viewbox(&super::catalog::load_icon(
            super::literal_base_name(key),
        )?));
    }
    if TRACED_LITERAL_KEYS.contains(&super::literal_base_name(key)) {
        // Recoloured like any other literal art, but served on its own
        // pivot-centred canvas — see TRACED_LITERAL_KEYS' own doc.
        return Ok(with_viewbox(&super::resolve_with(key, mode)?));
    }
    if PATTERN_LITERAL_KEYS.contains(&super::literal_base_name(key)) {
        // No compositing at all — see PATTERN_LITERAL_KEYS' own doc. `resolve`
        // (not `composite`) already gives the exact, unpadded native canvas.
        return Ok(with_viewbox(&super::resolve_with(key, mode)?));
    }
    let svg = match role_for_key(key) {
        Role::Overlay => match reference {
            Some(base) => composite::stack_overlay_with(base, key, mode)
                .or_else(|_| overlay_stack_with(key, mode)),
            None => overlay_stack_with(key, mode),
        },
        Role::Light => light_stack_with(key, mode),
        Role::Base => base_stack_with(key, mode),
    }?;
    Ok(with_viewbox(&svg))
}

/// Insert `viewBox="0 0 w h"` right after the opening `<svg` tag, unless one
/// is already present. Moved here from the deleted `pack-icons` bin, which
/// needed the identical fix for its on-disk copies.
fn with_viewbox(svg: &str) -> String {
    if svg.contains("viewBox=") {
        return svg.to_string();
    }
    let Ok(tree) = usvg::Tree::from_str(svg, &usvg::Options::default()) else {
        return svg.to_string();
    };
    let size = tree.size();
    svg.replacen(
        "<svg",
        &format!("<svg viewBox=\"0 0 {} {}\"", size.width(), size.height()),
        1,
    )
}

// The full-catalogue enumeration — TEST-ONLY since jt qkmvmwps. `render` is
// reached from a network endpoint now, so a bad key is a blank icon on the
// water, not a build warning; this enumeration is what catches that.

/// The S-57 attribute domain for each numeric prefix — the FULL legal id
/// range, not just ids with vendored artwork ([`catalog::shape_icon`] falls
/// back to the class default). Erring low would silently drop real coverage.
#[cfg(test)]
fn shape_domain(prefix: &str) -> std::ops::RangeInclusive<u32> {
    match prefix {
        "TOPSHP" => 1..=36,
        _ => 1..=8,
    }
}

/// Every `PREFIX/shape/colpat/colour` key reachable through `aton.rs`'s
/// numeric addressing, across [`shape_domain`]'s full legal id range for
/// `prefix`.
#[cfg(test)]
fn numeric_entries(
    prefix: &str,
    mode: ColourMode,
    out: &mut Vec<(String, String)>,
    errors: &mut Vec<String>,
) {
    for id in shape_domain(prefix) {
        let Some(icon) = catalog::shape_icon(prefix, id) else {
            continue;
        };
        let Ok(base_svg) = catalog::load_icon(icon) else {
            continue;
        };
        if !catalog::is_parametric(&base_svg) {
            // A non-parametric base has no `COLORING{}`; `resolve_numeric`
            // requires one, so this id could never resolve via the numeric
            // form anyway (besom_point_up/_down ARE packed, via their own literal key instead).
            continue;
        }
        if prefix == "TOPSHP" {
            // topshp_symbol defaults absent COLOUR to literal "0", which
            // isn't in OBJECT_COLOURS — no colour WORD round-trips to it, so
            // pack it directly, matching how resolve_numeric resolves it at runtime.
            let key = format!("{prefix}/{id}/0/0");
            match render_with(&key, mode) {
                Ok(svg) => out.push((key, svg)),
                Err(e) => errors.push(format!("{key}: {e}")),
            }
        }
        let combos = match recolor::legal_combinations(icon, &base_svg) {
            Ok(c) => c,
            Err(e) => {
                errors.push(format!("{icon}: legal_combinations: {e}"));
                continue;
            }
        };
        for (pattern, colours) in combos {
            let Some(colour_ids) = colour_words_to_ids(&colours) else {
                continue; // a blank segment — aton.rs's raw_list never emits one
            };
            push_numeric_key(prefix, id, mode, pattern, &colour_ids, out, errors);
        }

        // legal_combinations never repeats a colour across segments, but a
        // real chart can (US5OAKIQ's TOPSHP/19/6/4,4 border pattern) — pack
        // every "all segments same colour" variant too, for real (pattern, count) pairs.
        let structural = match recolor::structural_patterns(&base_svg) {
            Ok(s) => s,
            Err(e) => {
                errors.push(format!("{icon}: structural_patterns: {e}"));
                continue;
            }
        };
        let pool = palette::colours_for(icon);
        for (pattern, sections) in structural {
            for &n in &sections {
                if n < 2 {
                    continue; // n==1 (uniform) is already covered above
                }
                for &word in pool.iter().flatten() {
                    let Some(id_) = palette::colour_id_for_name(word) else {
                        continue;
                    };
                    let colour_ids = vec![id_; n];
                    push_numeric_key(prefix, id, mode, pattern, &colour_ids, out, errors);
                }
            }
        }
    }
}

/// Colour WORDS to numeric S-57 ids, or `None` if any segment is blank — a
/// blank segment only occurs at `s == 1` in [`palette::colour_combinations`]'
/// output, which `aton.rs`'s numeric `raw_list` scheme never emits.
#[cfg(test)]
fn colour_words_to_ids(colours: &[Option<&'static str>]) -> Option<Vec<u32>> {
    let ids: Option<Vec<u32>> = colours
        .iter()
        .copied()
        .map(|c| c.and_then(palette::colour_id_for_name))
        .collect();
    ids.filter(|v| !v.is_empty())
}

#[cfg(test)]
fn push_numeric_key(
    prefix: &str,
    id: u32,
    mode: ColourMode,
    pattern: Option<&str>,
    colour_ids: &[u32],
    out: &mut Vec<(String, String)>,
    errors: &mut Vec<String>,
) {
    let colpat_id = match pattern {
        None => 0,
        Some(p) => match palette::pattern_id_for_name(p) {
            Some(id) => id,
            // e.g. "cross" — no numeric COLPAT id, unreachable via
            // aton.rs's numeric form (see the module doc).
            None => return,
        },
    };
    let colour_csv = colour_ids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let key = format!("{prefix}/{id}/{colpat_id}/{colour_csv}");
    match render_with(&key, mode) {
        Ok(svg) => out.push((key, svg)),
        Err(e) => errors.push(format!("{key}: {e}")),
    }
}

/// Literal/word-form keys `aton.rs` emits outside the numeric scheme — a
/// fixed, exhaustively-checked list (test-only; drives catalogue coverage).
/// All bodies (`Role::Base`): the glyph IS the whole aid, not something mounted on another shape.
#[cfg(test)]
const BASE_LITERAL_KEYS: &[&str] = &[
    // bcnshp_symbol's withy special case
    "withy-starboard",
    "withy-port",
    // mooring_symbol's non-buoy fallback
    "pilpnt",
    // dir_buoyage_symbol
    "dir-buoyage-a",
    "dir-buoyage-b",
    // light_vessel_symbol's colour words (palette::COLOUR_BUCKETS' buoy
    // bucket, which `light_float` belongs to, plus "x" — the raw-COLOUR-
    // unrecognised fallback `resolve_word` degrades to "no colour")
    "light_float/white",
    "light_float/black",
    "light_float/red",
    "light_float/green",
    "light_float/yellow",
    "light_float/grey",
    "light_float/x",
];

/// `topmark_overlay_*`'s literal keys — all topmarks (`Role::Overlay`),
/// mounted above a buoy/beacon body. Packed via `overlay_stack`: a
/// `Role::Base`-style pack would centre the canvas on the mast-stub end instead.
const OVERLAY_LITERAL_KEYS: &[&str] = &[
    "sphere/red",
    "2_spheres/black",
    "flag/generic",
    "2_cones_up/black",
    "2_cones_base_together/black",
    "2_cones_down/black",
    "2_cones_point_together/black",
    // topmark_overlay_beacon's besom special case
    "besom_point_down",
    "besom_point_up",
];

#[cfg(test)]
fn literal_entries(mode: ColourMode, out: &mut Vec<(String, String)>, errors: &mut Vec<String>) {
    for &key in BASE_LITERAL_KEYS {
        match render_with(key, mode) {
            Ok(svg) => out.push((key.to_string(), svg)),
            Err(e) => errors.push(format!("{key}: {e}")),
        }
    }
    for &key in OVERLAY_LITERAL_KEYS {
        match render_with(key, mode) {
            Ok(svg) => out.push((key.to_string(), svg)),
            Err(e) => errors.push(format!("{key}: {e}")),
        }
    }
}

/// One enumerated entry: the exact `sym_s`/`sym_topmark` string
/// value (or literal key) `aton.rs` can emit, paired with its
/// [`render`]ed, pivot-centred SVG.
#[cfg(test)]
struct IconEntry {
    key: String,
    svg: String,
}

/// The full day-palette catalogue, deduplicated and sorted by key. Errors
/// are collected rather than failing the run: one unreachable combination
/// shouldn't blank the other few thousand entries.
#[cfg(test)]
fn day_catalog() -> (Vec<IconEntry>, Vec<String>) {
    catalog_on(ColourMode::Day)
}

/// [`day_catalog`]'s enumeration on a chosen colour surface — the same key
/// space either way, which is what makes the two runs comparable key for
/// key in `roles_mode_round_trips_to_byte_identical_day_output`.
#[cfg(test)]
fn catalog_on(mode: ColourMode) -> (Vec<IconEntry>, Vec<String>) {
    let mut out = Vec::new();
    let mut errors = Vec::new();
    for prefix in ["BOYSHP", "BCNSHP", "TOPSHP"] {
        numeric_entries(prefix, mode, &mut out, &mut errors);
    }
    literal_entries(mode, &mut out, &mut errors);

    let by_key: std::collections::BTreeMap<String, String> = out.into_iter().collect();
    (
        by_key
            .into_iter()
            .map(|(key, svg)| IconEntry { key, svg })
            .collect(),
        errors,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::icons::OVERLAY_REF_SEP;

    /// `render` must reproduce, byte for byte, the exact constructor the
    /// key's ROLE calls for — the one thing the key's own grammar cannot
    /// tell you (see `role_for_key`). Both ambiguous literal forms are
    /// pinned here in both directions, because getting one wrong is a
    /// silently misplaced icon rather than a missing one, and that is
    /// precisely the regression jt task yxrmtltk had just finished fixing
    /// when this task moved rendering to the serve path.
    #[test]
    fn render_picks_the_same_role_the_artwork_needs_for_the_ambiguous_forms() {
        // <icon>/<colourword>: light_float is a body, sphere/flag are topmarks.
        for key in ["light_float/white", "pilpnt", "withy-port", "dir-buoyage-a"] {
            assert_eq!(
                render(key).unwrap(),
                with_viewbox(&base_stack(key).unwrap()),
                "{key} must render as a Role::Base body"
            );
        }
        for key in [
            "sphere/red",
            "2_spheres/black",
            "flag/generic",
            "besom_point_up",
            "besom_point_down",
        ] {
            assert_eq!(
                render(key).unwrap(),
                with_viewbox(&overlay_stack(key).unwrap()),
                "{key} must render as a Role::Overlay topmark"
            );
        }
        // The numeric prefixes decide themselves.
        assert_eq!(
            render("BOYSHP/4/1/3,1").unwrap(),
            with_viewbox(&base_stack("BOYSHP/4/1/3,1").unwrap())
        );
        assert_eq!(
            render("TOPSHP/3/0/0").unwrap(),
            with_viewbox(&overlay_stack("TOPSHP/3/0/0").unwrap())
        );
    }

    /// prlrlyuy: `light/*`/`floodlight/*` keys must route through
    /// `light_stack` (`Role::Light`), not fall through to the `Role::Base`
    /// default `role_for_key` used to give them — the exact bug that task
    /// fixed (neither `light.svg` nor `floodlight.svg` has a
    /// `.basepoint`/`.baseline`, so a `Role::Base` render silently fell back
    /// to `(w/2, h)`, bottom-centre).
    ///
    /// This exercises the REAL production path (`render`/`role_for_key`),
    /// not a hand-built `Role::Light` layer like
    /// `composite::tests::three_way_stack_base_topmark_light_is_well_formed`
    /// does — that test passed throughout prlrlyuy's own bug because it
    /// never went through `role_for_key` at all.
    ///
    /// Both `floodlight/*` (the flood/spot adjunct, a short wide fan) and
    /// `light/*` (the flare, a tall comet/teardrop) anchor on their own ray
    /// tip — prlrlyuy's original choice. Task tqmympsq briefly flipped
    /// `light/*` to the glow end, reasoning from an isolated chartcore
    /// render's vertical-overlap measurement against a buoy body (see git
    /// history for those numbers) — but a direct visual check of the actual
    /// deployed chart (not just an isolated render) confirmed that was
    /// wrong and reverted it. The two families share one assertion again:
    /// ink hangs below the canvas centre (`min_y` near zero, `max_y` well
    /// below) — `floodlight/red` measures centred ink
    /// `(-6.14, 0.46, 6.15, 7.01)`.
    ///
    /// Lesson: the isolated-render overlap measurement that justified
    /// tqmympsq's flip does not reliably predict what the real composited
    /// map/info-panel render looks like — a real visual check on the
    /// deployed app is the authoritative signal for this class of bug, not
    /// a synthetic geometry comparison. See `light_flare_may_not_overlap_
    /// the_body_it_rides_in_isolated_measurement` below for why this test
    /// suite deliberately no longer asserts a vertical-overlap threshold.
    #[test]
    fn light_and_floodlight_keys_anchor_on_their_tip_not_their_bottom_margin() {
        for (prefix, _) in [("light", ()), ("floodlight", ())] {
            for (word, _) in palette::LIGHT_COLOURS {
                let key = format!("{prefix}/{word}");
                assert_eq!(
                    render(&key).unwrap(),
                    with_viewbox(&light_stack(&key).unwrap()),
                    "{key} must render as a Role::Light glyph"
                );
                let svg = render(&key).unwrap();
                let (_, min_y, _, max_y) = centred_ink(&svg);
                assert!(
                    min_y.abs() < 2.0,
                    "{key}: tip should sit near the canvas centre (small |min_y|), got {min_y}"
                );
                assert!(
                    max_y > 5.0,
                    "{key}: the wide end should hang well below centre, got max_y={max_y}"
                );
            }
        }
    }

    /// NOT a regression guard — a documented CAUTION. jt task tqmympsq
    /// measured this exact overlap (body ink vs. an isolated `light/red`
    /// render, both independently centred, mimicking how
    /// `aidsHazards.ts`/`ChartSpriteIcon.tsx` composite them today) and used
    /// a LARGER number here as justification for flipping the flare's
    /// anchor to the glow end. A direct visual check of the real deployed
    /// chart then confirmed the tip anchor (the smaller-overlap case) is
    /// actually correct — so this specific measurement does not reliably
    /// predict "looks attached" for this icon pair, and asserting a
    /// threshold on it again would just re-encode the same mistake with a
    /// passing test. Kept only as a comment recording the numbers for
    /// whoever revisits this: at the tip anchor, `BOYSHP/5/0/4` centred ink
    /// `(-3.0, -11.04, 3.85, 1.0)` vs. `light/red` `(-2.27, 0.81, 2.27,
    /// 13.57)` overlap by 0.19 units — and yet this is the visually correct
    /// pairing. Do not resurrect a `overlap > threshold` assertion here
    /// without a real rendered/visual check backing it, per
    /// `[[visually-verify-icon-anchor-fixes]]`.
    #[test]
    fn light_flare_may_not_overlap_the_body_it_rides_in_isolated_measurement() {
        // Deliberately no assertion beyond "these both render" — see the
        // doc comment above for why a vertical-overlap threshold here is a
        // trap, not a safety net.
        for base in [
            "BOYSHP/1/0/4",
            "BOYSHP/4/0/2",
            "BOYSHP/6/0/2",
            "BCNSHP/4/0/1",
        ] {
            render(base).unwrap();
        }
        render("light/red").unwrap();
    }

    /// Every consumer of the endpoint (`<img>`/`createImageBitmap` at a
    /// non-native size, `ChartSpriteIcon.tsx`'s `tightenViewBox` regex)
    /// needs the `viewBox` usvg's writer drops — see [`render`].
    #[test]
    fn rendered_svgs_carry_an_explicit_viewbox() {
        for key in ["BOYSHP/4/1/3,1", "TOPSHP/3/0/0", "pilpnt", "sphere/red"] {
            let svg = render(key).unwrap();
            assert!(svg.contains("viewBox=\""), "{key}: no viewBox: {svg}");
            roxmltree::Document::parse(&svg).unwrap_or_else(|e| panic!("{key}: {e}"));
        }
    }

    #[test]
    fn pattern_keys_render_at_their_native_unpadded_canvas_size() {
        // nsplrzus: cable/pipeline are repeating line-pattern tiles, not point
        // symbols — `render` (the on-demand icon endpoint's own function) must
        // NOT run them through `composite::stack`'s pivot-centred padding, or
        // the returned canvas would no longer repeat seamlessly at its own
        // declared width. Pin the exact vendored dimensions (cable.svg
        // 14.645x4, pipeline.svg 12x4 — lssxoxyr's own measurements) so a
        // future accidental re-routing through `base_stack` fails loudly
        // (padding a canvas out to make its pivot the centre always changes
        // its size unless the pivot already IS the centre, which neither of
        // these happens to be).
        for (key, width, height) in [("cable", "14.645", "4"), ("pipeline", "12", "4")] {
            let svg = render(key).unwrap();
            assert!(
                svg.contains(&format!("viewBox=\"0 0 {width} {height}\"")),
                "{key}: {svg}"
            );
            roxmltree::Document::parse(&svg).unwrap_or_else(|e| panic!("{key}: {e}"));
        }
    }

    #[test]
    fn pattern_keys_accept_the_same_colour_override_literal_names_do() {
        // The mechanism `resolve_literal` added for TSS-arrow (yxnrrtwk) is
        // generic, not name-specific — cable/pipeline reuse it unchanged
        // (through `render`, not just bare `resolve`), so CBLSUB/PIPSOL's
        // pattern can match their own per-feature/per-palette `bcol` exactly
        // like the line layers' own `line-color` already does.
        let day = render("pipeline").unwrap();
        let recoloured = render("pipeline,808080").unwrap();
        assert!(recoloured.contains("#808080"), "{recoloured}");
        assert!(
            !recoloured.contains(crate::icons::palette::VENDORED_WARNING_MAGENTA),
            "{recoloured}"
        );
        assert_eq!(
            day.replace(crate::icons::palette::VENDORED_WARNING_MAGENTA, "#808080"),
            recoloured,
        );
    }

    #[test]
    fn render_applies_a_literal_colour_override_through_the_full_serve_path() {
        // yxnrrtwk: this is the exact call the backend's /api/icons/ route
        // makes (`render`, not the lower-level `resolve` the other test in
        // this file already covers) — proving the `,RRGGBB` suffix survives
        // `base_stack`'s composite/pivot-centring pass, not just bare
        // `resolve`. Also proves `raw_asset_for_key` (geometry lookup) copes
        // with the suffixed key: a wrong role or a failed geometry lookup
        // here would error before colour ever entered into it.
        let day = render("TSS-arrow").unwrap();
        let recoloured = render("TSS-arrow,c545c3").unwrap();
        assert!(recoloured.contains("#c545c3"), "{recoloured}");
        assert!(
            !recoloured.contains(crate::icons::palette::VENDORED_WARNING_MAGENTA),
            "{recoloured}"
        );
        // Same canvas/pivot/silhouette — only the colour differs.
        assert_eq!(
            day.replace(crate::icons::palette::VENDORED_WARNING_MAGENTA, "#c545c3"),
            recoloured,
        );
    }

    /// The union ink of the two sprites MapLibre actually draws — the base
    /// on the ATON layer, the topmark on the TOPMAR/DAYMAR layer, both
    /// `icon-anchor: center` on the same feature point — must equal the ink
    /// of the one true merge. That equality is the contract the two-layer
    /// map render rests on, and it holds only once the topmark's sprite is
    /// padded against the body it actually caps (jt task vplwqzmr): mast
    /// height AND lean are per-shape.
    ///
    /// A union bbox is a NECESSARY, not sufficient, condition — where one
    /// layer's ink contains the other's on an axis it cannot see a small
    /// shift (a pillar's own ink already spans its topmark's, so that pair
    /// contributes nothing here). `composite`'s
    /// `every_bodys_mast_tip_lies_along_its_own_declared_lean` and
    /// `hand_derived_mast_tips_for_the_leaning_artwork` are the exact,
    /// per-icon checks; this one catches canvas-sizing and pivot drift
    /// between the two independently padded sprites, which those cannot.
    #[test]
    fn the_two_sprites_the_map_draws_union_to_the_one_true_merge() {
        for (base, overlay) in REAL_PAIRS {
            let merged = composite::stack(&[
                Layer {
                    key: base,
                    role: Role::Base,
                },
                Layer {
                    key: overlay,
                    role: Role::Overlay,
                },
            ])
            .unwrap();
            let union = union_ink(
                &render(base).unwrap(),
                &render(&format!("{overlay}{OVERLAY_REF_SEP}{base}")).unwrap(),
            );
            let want = centred_ink(&merged);
            for (got, want, axis) in [
                (union.0, want.0, "min_x"),
                (union.1, want.1, "min_y"),
                (union.2, want.2, "max_x"),
                (union.3, want.3, "max_y"),
            ] {
                assert!(
                    (got - want).abs() < 0.01,
                    "{base} + {overlay}: {axis} {got:.3} != merged {want:.3}"
                );
            }
        }
    }

    /// …and the fixed `pillar` stand-in this replaced does NOT satisfy it:
    /// on a body shorter or straighter than a pillar the topmark hangs in
    /// mid-air, off to one side. Pinned with a real magnitude so a future
    /// "simplify" back to a constant reference fails loudly rather than
    /// quietly re-opening the P0.
    #[test]
    fn the_fixed_stand_in_reference_misplaces_a_topmark_by_units_not_noise() {
        for (base, overlay, least) in [
            ("BOYSHP/2/0/4", "TOPSHP/2/0/0", 6.0), // can: mast far shorter (7.2)
            ("BOYSHP/3/0/1", "TOPSHP/3/0/0", 6.0), // spherical: shorter still (6.5)
            ("BCNSHP/1/0/4", "TOPSHP/19/6/4,4", 2.5), // pole: upright, so the
                                                   // stand-in's own 15° lean throws the board sideways (3.0)
        ] {
            let unmounted = union_ink(&render(base).unwrap(), &render(overlay).unwrap());
            let want = centred_ink(&render_merged(base, overlay));
            let err = (unmounted.0 - want.0)
                .abs()
                .max((unmounted.1 - want.1).abs())
                .max((unmounted.2 - want.2).abs())
                .max((unmounted.3 - want.3).abs());
            assert!(
                err > least,
                "{base} + {overlay}: stand-in error {err:.2} < {least} — \
                 has the stand-in stopped being wrong, or the measurement?"
            );
        }
    }

    #[test]
    fn an_unresolvable_mount_reference_degrades_to_the_stand_in_not_a_404() {
        // A blank icon on the water is worse than a misplaced one.
        for key in ["TOPSHP/3/0/0", "sphere/red"] {
            assert_eq!(
                render(&format!("{key}{OVERLAY_REF_SEP}no-such-icon")).unwrap(),
                render(key).unwrap(),
                "{key}: an unknown mount must fall back, not error"
            );
        }
        // A malformed reference is not half-parsed into an asset lookup: it
        // comes back whole and fails as the unrecognised key it is. Nothing
        // `derive::aton` emits can look like this — only a hand-typed URL.
        assert!(render("TOPSHP/3/0/0@").is_err());
        assert!(render("TOPSHP/3/0/0@a@b").is_err());
        assert!(render("@BOYSHP/2/0/4").is_err());
    }

    /// A body key's own rendering never depends on a mount reference — it is
    /// the thing being mounted ON.
    #[test]
    fn a_mount_reference_on_a_body_key_changes_nothing() {
        assert_eq!(
            render("BOYSHP/4/1/3,1@BOYSHP/2/0/4").unwrap(),
            render("BOYSHP/4/1/3,1").unwrap()
        );
    }

    /// The base/overlay pairs `derive::aton` emits for real charted aids,
    /// one per distinct body shape the vendored artwork draws differently
    /// (leaning vs upright, tall vs short).
    const REAL_PAIRS: &[(&str, &str)] = &[
        ("BOYSHP/1/0/4", "TOPSHP/1/0/0"),     // conical, leans
        ("BOYSHP/2/0/4", "TOPSHP/2/0/0"),     // can, leans
        ("BOYSHP/3/0/1", "TOPSHP/3/0/0"),     // spherical, upright
        ("BOYSHP/4/0/2", "sphere/red"),       // pillar, leans
        ("BOYSHP/5/0/2", "TOPSHP/2/0/0"),     // spar, leans
        ("BOYSHP/6/0/2", "2_cones_up/black"), // barrel, upright
        ("BCNSHP/1/0/4", "TOPSHP/19/6/4,4"),  // stake/pole, upright (fixture)
        ("BCNSHP/4/0/1", "TOPSHP/24/6/3,3"),  // tower, upright (fixture)
        ("BCNSHP/1/0/2", "besom_point_up"),   // literal-form overlay
    ];

    fn render_merged(base: &str, overlay: &str) -> String {
        composite::stack(&[
            Layer {
                key: base,
                role: Role::Base,
            },
            Layer {
                key: overlay,
                role: Role::Overlay,
            },
        ])
        .unwrap()
    }

    /// An SVG's ink bounding box relative to its own canvas CENTRE — the
    /// pivot every sprite here is padded around, and the point MapLibre puts
    /// on the feature. `(min_x, min_y, max_x, max_y)`.
    fn centred_ink(svg: &str) -> (f64, f64, f64, f64) {
        let tree = usvg::Tree::from_str(svg, &usvg::Options::default()).unwrap();
        let bb = tree.root().abs_bounding_box();
        let (cx, cy) = (
            tree.size().width() as f64 / 2.0,
            tree.size().height() as f64 / 2.0,
        );
        (
            bb.x() as f64 - cx,
            bb.y() as f64 - cy,
            (bb.x() + bb.width()) as f64 - cx,
            (bb.y() + bb.height()) as f64 - cy,
        )
    }

    /// Two sprites drawn centre-on-centre, as the map draws them.
    fn union_ink(a: &str, b: &str) -> (f64, f64, f64, f64) {
        let (a, b) = (centred_ink(a), centred_ink(b));
        (a.0.min(b.0), a.1.min(b.1), a.2.max(b.2), a.3.max(b.3))
    }

    #[test]
    fn unknown_key_is_reported_not_panicking() {
        assert!(render("nonsense").is_err());
        assert!(render("BOYSHP/x/y").is_err());
    }

    #[test]
    fn day_catalog_covers_every_real_fixture_shape_with_no_errors() {
        // The exact keys aton.rs's own tests assert (derive/aton.rs), PLUS
        // the real US5OAKIQ-fixture-derived ones chartcore/tests/
        // derive_phase5.rs pins (TOPSHP/19/6/4,4 and TOPSHP/24/6/3,3 — a
        // real chart repeating the SAME colour across a 2-segment `border`
        // pattern, which legal_combinations' own adjacent-must-differ
        // enumeration would never generate on its own — see the
        // `structural_patterns`-based pass in `numeric_entries`) — must all
        // be present, and legal_combinations must not have rejected a
        // single one of them structurally.
        let (entries, errors) = day_catalog();
        assert!(errors.is_empty(), "unexpected pack errors: {errors:?}");
        let keys: std::collections::BTreeSet<&str> =
            entries.iter().map(|e| e.key.as_str()).collect();
        for want in [
            "BOYSHP/5/0/4",
            "BOYSHP/5/0/2",
            "BCNSHP/1/0/4",
            "BCNSHP/1/0/2",
            "BCNSHP/2/0/3",
            "BCNSHP/4/0/1",
            "withy-starboard",
            "withy-port",
            "TOPSHP/1/0/0",
            "TOPSHP/3/0/0",
            "TOPSHP/19/6/4,4",
            "TOPSHP/24/6/3,3",
            "pilpnt",
            "light_float/green",
            "light_float/x",
            "dir-buoyage-a",
            "dir-buoyage-b",
            "sphere/red",
            "2_spheres/black",
            "flag/generic",
            "2_cones_down/black",
            "besom_point_up",
            "besom_point_down",
        ] {
            assert!(keys.contains(want), "missing packed entry: {want}");
        }
    }

    #[test]
    fn every_entry_is_a_well_formed_pivot_centred_svg() {
        let (entries, _) = day_catalog();
        assert!(
            entries.len() > 50,
            "suspiciously few entries: {}",
            entries.len()
        );
        for e in &entries {
            assert!(
                e.svg.starts_with("<svg"),
                "{}: not a bare <svg> root: {}",
                e.key,
                e.svg
            );
            roxmltree::Document::parse(&e.svg)
                .unwrap_or_else(|err| panic!("{}: invalid XML: {err}", e.key));
        }
    }

    #[test]
    fn keys_are_sorted_and_unique() {
        let (entries, _) = day_catalog();
        let mut prev: Option<&str> = None;
        for e in &entries {
            if let Some(p) = prev {
                assert!(p < e.key.as_str(), "not sorted: {p} >= {}", e.key);
            }
            prev = Some(&e.key);
        }
    }

    /// The traced-HPGL placeholders must be drawn at the SAME scale as the
    /// vendored/drawn artwork they sit beside on the chart (jt task qqqxqskl).
    ///
    /// They were generated at ~1/25 of a chartsymbols.xml HPGL unit, which is
    /// ~1.27x the presentation library's OWN bitmap px for the same symbol and
    /// about TWICE the vendored quantenschaum set — so every one of them drew
    /// roughly double the size of its neighbours (user report). The whole set
    /// was scaled x0.5; `DANGER01` is the one placeholder with an exact sibling
    /// to pin that against — it and `DANGER51`/`DANGER52` are the SAME dotted
    /// danger ellipse, and the latter two are drawn from `wreck-dangerous.svg`'s
    /// own geometry, so their widths must agree.
    ///
    /// Guarding the WIDTH only is deliberate: chartsymbols draws DANGER01
    /// rounder than DANGER51 (bitmaps 24x19 vs 29x21), so the heights
    /// legitimately differ. Width is the dimension the eye compares.
    ///
    /// The band is deliberately WIDE (0.75-1.33x, i.e. "same scale family",
    /// not "same number"). Today the two land on the same 16 units exactly,
    /// but that is a coincidence of the x0.5 factor: chartsymbols' own bitmaps
    /// make the proportionally-correct DANGER01 about 13 units, and redrawing
    /// it that way is a REFINEMENT, not a regression. What must never come
    /// back is the 2x it had.
    #[test]
    fn placeholder_scale_matches_the_vendored_set_danger01_vs_danger51() {
        fn view_width(key: &str) -> f64 {
            let svg = render(key).unwrap();
            let vb = svg.split("viewBox=\"").nth(1).expect("viewBox");
            let vb = vb.split('"').next().unwrap();
            vb.split_whitespace().nth(2).unwrap().parse().unwrap()
        }
        let placeholder = view_width("DANGER01");
        let drawn = view_width("DANGER51");
        let ratio = placeholder / drawn;
        assert!(
            (0.75..=1.33).contains(&ratio),
            "DANGER01 is {placeholder} units wide against {drawn} for the same \
             danger ellipse drawn as real artwork (DANGER51) — ratio {ratio:.2}, \
             outside the 0.75-1.33 same-scale-family band. The placeholder set \
             is out of scale with the vendored artwork again"
        );
    }
}

// ---------------------------------------------------------------------------
// The ColourMode::Roles acceptance suite (jt task: palette-neutral icons).
//
// One test carries the weight: substitute every sentinel in a roles-mode
// render back to its `day` value and the bytes must equal the day render,
// for every key in the enumerated space. That proves the plumbing is
// colour-neutral AND that no colour was missed, double-mapped, or given the
// wrong role — a far stronger signal than "the icons still render".
// ---------------------------------------------------------------------------

#[cfg(test)]
mod roles_tests {
    use super::*;
    use crate::icons::roles;

    /// Every key `render` serves that is NOT in `day_catalog`'s numeric/
    /// literal-overlay space: the 136 non-parametric vendored icons (the
    /// whole literal-art surface — `arc-*` light sectors, the compass rose,
    /// the landmark glyphs, the `cable`/`pipeline` line patterns), plus the
    /// `light`/`floodlight` colour words, which are the only keys that reach
    /// `palette::LIGHT_COLOURS` at all.
    ///
    /// Placeholders are excluded, and so are the 36 parametric icons
    /// addressed by BARE name: `resolve("pillar")` leaves `COLORING{}`
    /// unsubstituted and lets the file's own Inkscape PREVIEW stylesheet
    /// survive (`#ff0000`, bare `grey`/`red`). No production key reaches
    /// that path — see `icon-roles.json`'s `$measurement` block, which
    /// deliberately gave those colours no role.
    fn extra_keys() -> Vec<String> {
        let mut keys = Vec::new();
        for name in catalog::icon_names() {
            if catalog::is_placeholder(name) {
                continue;
            }
            let Ok(raw) = catalog::load_icon(name) else {
                continue;
            };
            if catalog::is_parametric(&raw) {
                continue;
            }
            keys.push(name.to_string());
        }
        for prefix in ["light", "floodlight"] {
            for (word, _) in palette::LIGHT_COLOURS {
                keys.push(format!("{prefix}/{word}"));
            }
        }
        keys
    }

    /// THE acceptance test. `render_with(key, Roles)`, with every sentinel
    /// substituted back to its `day` hex, must be byte-identical to
    /// `render_with(key, Day)` — across the entire enumerated key space.
    ///
    /// The `day` values come from `roles::ROLES`, which
    /// `roles::tests::the_rust_table_matches_icon_roles_json` pins against
    /// `assets/s52-icons/icon-roles.json` field by field — so this is not
    /// circular: a wrong `day` fails there, a wrong ROLE fails here.
    #[test]
    fn roles_mode_round_trips_to_byte_identical_day_output() {
        let (day, day_errors) = catalog_on(ColourMode::Day);
        let (roles_entries, role_errors) = catalog_on(ColourMode::Roles);
        assert!(day_errors.is_empty(), "day errors: {day_errors:?}");
        assert_eq!(
            role_errors, day_errors,
            "roles mode must fail on exactly the keys day mode does"
        );
        assert_eq!(
            day.len(),
            roles_entries.len(),
            "the two modes must enumerate the same key space"
        );

        let mut checked = 0usize;
        for (d, r) in day.iter().zip(&roles_entries) {
            assert_eq!(d.key, r.key, "key spaces diverged");
            assert_eq!(
                roles::substitute_to_day(&r.svg),
                d.svg,
                "{}: roles-mode render does not substitute back to the day render",
                d.key
            );
            checked += 1;
        }

        for key in extra_keys() {
            let d =
                render_with(&key, ColourMode::Day).unwrap_or_else(|e| panic!("{key} (day): {e}"));
            let r = render_with(&key, ColourMode::Roles)
                .unwrap_or_else(|e| panic!("{key} (roles): {e}"));
            assert_eq!(
                roles::substitute_to_day(&r),
                d,
                "{key}: roles-mode render does not substitute back to the day render"
            );
            checked += 1;
        }

        // A floor, not an exact count — the enumeration is allowed to grow.
        assert!(
            checked > 5000,
            "only round-tripped {checked} keys, expected the whole catalogue"
        );
        println!("round-tripped {checked} keys byte-identically");
    }

    /// The other half of the proof: a colour with NO role would survive
    /// roles mode as a raw day hex and silently stay day-coloured on a dark
    /// chart. Nothing outside the `#fe00XX` block may remain.
    ///
    /// Placeholders are exempt by design — `render` short-circuits them
    /// before any recolouring (usvg destroys a raster placeholder's
    /// `<image>`), so they bake day `rgb()` in both modes. That is the whole
    /// reason `placeholders.json` is a worklist.
    #[test]
    fn roles_mode_emits_no_hex_outside_the_sentinel_block() {
        let (entries, _) = catalog_on(ColourMode::Roles);
        let mut offenders: std::collections::BTreeMap<String, String> =
            std::collections::BTreeMap::new();
        let note = |svg: &str, key: &str, into: &mut std::collections::BTreeMap<_, _>| {
            for hex in painted_hexes(svg) {
                if !hex.starts_with(roles::SENTINEL_PREFIX) {
                    into.entry(hex).or_insert_with(|| key.to_string());
                }
            }
        };
        for e in &entries {
            note(&e.svg, &e.key, &mut offenders);
        }
        for key in extra_keys() {
            let svg = render_with(&key, ColourMode::Roles).unwrap();
            note(&svg, &key, &mut offenders);
        }
        assert!(
            offenders.is_empty(),
            "roles mode left day hexes with no role: {offenders:?}"
        );
    }

    /// Every hex in an attribute of an element that actually PAINTS —
    /// i.e. every element not inside a `<clipPath>`.
    ///
    /// The exclusion is not a convenience: usvg's writer emits
    /// `fill="#000000"` on every clip-path child unconditionally (it is
    /// clip GEOMETRY, and its fill is meaningless), overwriting whatever
    /// the input said — measured on `dish_aerial`, whose clip path comes
    /// out of `resolve` carrying the `ink` sentinel and out of `compose`'s
    /// second usvg pass carrying `#000000` again, in BOTH modes. It is not
    /// a colour with no role; it is not a colour at all.
    fn painted_hexes(svg: &str) -> Vec<String> {
        let doc = roxmltree::Document::parse(svg).expect("rendered SVG is valid XML");
        let mut out = Vec::new();
        for node in doc.descendants().filter(roxmltree::Node::is_element) {
            if node.ancestors().any(|a| a.has_tag_name("clipPath")) {
                continue;
            }
            for attr in node.attributes() {
                out.extend(hexes(attr.value()));
            }
        }
        out
    }

    /// Every `#rrggbb` literal in `s`, lowercased. Rendered output carries
    /// no `rgb()` and no named colours except `none` (verified — see
    /// `icon-roles.json`'s `$comment`), so scanning for `#` + 6 hex digits
    /// finds every painted value.
    fn hexes(svg: &str) -> Vec<String> {
        let b = svg.as_bytes();
        let mut out = Vec::new();
        let mut i = 0;
        while i + 7 <= b.len() {
            if b[i] == b'#' && b[i + 1..i + 7].iter().all(u8::is_ascii_hexdigit) {
                out.push(svg[i..i + 7].to_ascii_lowercase());
                i += 7;
            } else {
                i += 1;
            }
        }
        out
    }

    /// Roles mode is OPT-IN: the no-argument entry points must keep serving
    /// day paint, byte for byte, or every icon on the chart would render in
    /// sentinel colours the moment this landed.
    #[test]
    fn the_default_entry_points_are_unchanged_day_output() {
        for key in [
            "BOYSHP/4/1/3,1",
            "TOPSHP/3/0/0",
            "pilpnt",
            "sphere/red",
            "light/red",
            "TSS-arrow",
            "cable",
        ] {
            let day = render_with(key, ColourMode::Day).unwrap();
            assert_eq!(render(key).unwrap(), day, "{key}");
            assert!(
                !day.contains(roles::SENTINEL_PREFIX),
                "{key}: a sentinel leaked into day output: {day}"
            );
        }
    }

    /// `ink` is the outline of every parametric buoy — the role a dark
    /// palette lives or dies on, and the one that is hardcoded in
    /// `recolor.rs` rather than sitting in a table. Pin that it actually
    /// comes out, alongside `paper` (the basepoint disc) and a real S-57
    /// COLOUR role.
    #[test]
    fn a_parametric_buoy_carries_ink_paper_and_its_colour_roles() {
        let svg = render_with("BOYSHP/4/1/3,1", ColourMode::Roles).unwrap();
        assert!(svg.contains(roles::INK), "no ink role: {svg}");
        assert!(svg.contains(roles::PAPER), "no paper role: {svg}");
        assert!(
            svg.contains(roles::object_colour("red").unwrap()),
            "no obj-red role: {svg}"
        );
        assert!(
            svg.contains(roles::object_colour("white").unwrap()),
            "no obj-white role: {svg}"
        );
        // ...and none of the day hexes those replaced.
        for hex in ["#000000", "#ffffff", "#ed1c24"] {
            assert!(!svg.contains(hex), "{hex} survived roles mode: {svg}");
        }
    }

    /// `lit-generic` is the ONLY `palette::LIGHT_COLOURS` role that is
    /// reachable: every other word in that table also exists in
    /// `OBJECT_COLOURS`, which `recolor_variant` consults first. Pinned so
    /// the day-parity fix (making lights read `light_colors` first, which
    /// CHANGES day bytes) shows up here as a deliberate change rather than
    /// as a surprise.
    #[test]
    fn only_lit_generic_is_reachable_through_the_light_colour_table() {
        let generic = render_with("light/generic", ColourMode::Roles).unwrap();
        assert!(
            generic.contains(roles::light_colour("generic").unwrap()),
            "no lit-generic role: {generic}"
        );
        for word in ["white", "red", "green", "blue", "yellow", "orange", "amber"] {
            let svg = render_with(&format!("light/{word}"), ColourMode::Roles).unwrap();
            assert!(
                svg.contains(roles::object_colour(word).unwrap()),
                "light/{word} should paint obj-{word} (OBJECT_COLOURS wins the lookup): {svg}"
            );
            assert!(
                !svg.contains(roles::light_colour(word).unwrap()),
                "light/{word} unexpectedly reached the light table"
            );
        }
    }

    /// The per-feature `,RRGGBB` override is NOT a palette mechanism — it
    /// carries the tile's own `bcol`, which varies feature to feature within
    /// one palette — so it must survive roles mode untouched. Order matters:
    /// the art is role-substituted first and the override then replaces the
    /// warn-magenta SENTINEL, because a real `bcol` can be `#808080`, which
    /// is `obj-grey`'s day hex and would otherwise be captured as a role.
    #[test]
    fn the_per_feature_colour_override_still_applies_in_roles_mode() {
        for (key, hex) in [
            ("TSS-arrow,c545c3", "#c545c3"),
            ("pipeline,808080", "#808080"),
        ] {
            let svg = render_with(key, ColourMode::Roles).unwrap();
            assert!(svg.contains(hex), "{key}: override lost: {svg}");
            assert!(
                !svg.contains(roles::WARN_MAGENTA),
                "{key}: the overridden magenta is still a role: {svg}"
            );
        }
        // Without an override, the same art carries the role instead.
        let plain = render_with("TSS-arrow", ColourMode::Roles).unwrap();
        assert!(plain.contains(roles::WARN_MAGENTA), "{plain}");
        assert!(
            !plain.contains(palette::VENDORED_WARNING_MAGENTA),
            "{plain}"
        );
    }

    /// The placeholder worklist is CLOSED (xytoltso). Nothing is exempt from
    /// role substitution any more, and this pins the inverse of the test that
    /// used to live here: every one of the 16 traced symbols now emits
    /// sentinels rather than coming back byte-identical in both modes.
    ///
    /// If a future gap ever re-populates `assets/s52-icons/placeholder/`,
    /// `render_with`'s guard still short-circuits it — but that is a
    /// regression to file, not a state to assert.
    #[test]
    fn the_placeholder_worklist_is_closed_and_the_traced_symbols_carry_roles() {
        assert_eq!(
            catalog::placeholder_names().count(),
            0,
            "a placeholder is back — it will render day-fixed under every theme"
        );
        for name in TRACED_LITERAL_KEYS {
            let day = render_with(name, ColourMode::Day).unwrap();
            let roles = render_with(name, ColourMode::Roles).unwrap();
            assert_ne!(roles, day, "{name}: still day-fixed in roles mode");
            assert!(
                roles.contains(roles::SENTINEL_PREFIX),
                "{name}: no role sentinel in roles-mode output"
            );
            assert_eq!(roles::substitute_to_day(&roles), day, "{name}");
        }
    }
}
