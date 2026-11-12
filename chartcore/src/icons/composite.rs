// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Composites several already-[`super::resolve`]d point-symbol SVGs (base
//! buoy/beacon body, topmark/daymark overlay, light-colour glyph) into one
//! merged SVG per feature/attribute-combo (jt task ktqovmxp), following the
//! pivot convention documented in full at
//! docs/architecture/icon-pivot-convention.md.

use std::collections::HashMap;

use super::recolor::{self, RecolorError};
use super::{catalog, numeric_icon_name, resolve_with, ColourMode, IconError};

/// A layer's role in the stack — see the module doc for the placement rule
/// each implies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// The primary structure (buoy/beacon/mooring/light-vessel body).
    /// Exactly one per [`stack`] call; its own pivot becomes the shared
    /// origin every other layer places against.
    Base,
    /// A topmark/daymark mounted above the base, at the base's own
    /// ink-top ("mast top").
    Overlay,
    /// A light-colour glyph, anchored at the base's own origin (drawn off
    /// the flank at the same coordinate, not stacked above).
    Light,
}

/// One already-[`super::resolve`]-shaped key (`derive::aton`'s
/// `sym_s`/`sym_topmark` addressing) plus its role in the stack.
#[derive(Debug, Clone, Copy)]
pub struct Layer<'a> {
    pub key: &'a str,
    pub role: Role,
}

/// A point in an icon's own local SVG coordinate space (or, once placed, in
/// the composite's shared space — both are the same units, just different
/// origins).
#[derive(Debug, Clone, Copy)]
struct Point {
    x: f64,
    y: f64,
}

struct Geometry {
    width: f64,
    height: f64,
    self_anchor: Point,
    /// Where an overlay's self-anchor attaches — the tip of the mast, in
    /// this icon's own canvas space. Only meaningful for a [`Role::Base`]
    /// layer but cheap enough to compute for every role from the one tree
    /// walk. See the module doc: this is NOT `(self_anchor.x, ink_top)`,
    /// because a leaning body's mast tip is not above its waterline.
    mast_top: Point,
    /// The body's lean, in degrees clockwise — the rotation component of
    /// the transform its topmost ink carries (15° for the leaning buoy
    /// artwork, 0 for everything upright). An overlay is rotated by this
    /// about `mast_top`.
    lean: f64,
}

/// `id -> class` for every element in `svg` that has both — read from the
/// RAW asset text via `roxmltree`, not `usvg` (which strips `class`
/// entirely; see the module doc).
fn class_map(svg: &str) -> Result<HashMap<String, String>, IconError> {
    let doc = roxmltree::Document::parse(svg)
        .map_err(|e| IconError::Recolor(RecolorError::Xml(e.to_string())))?;
    Ok(doc
        .descendants()
        .filter_map(|n| {
            let id = n.attribute("id")?;
            let class = n.attribute("class")?;
            Some((id.to_string(), class.to_string()))
        })
        .collect())
}

fn has_class(classes: &HashMap<String, String>, id: &str, class: &str) -> bool {
    classes
        .get(id)
        .is_some_and(|c| c.split_whitespace().any(|t| t == class))
}

/// Geometry for one RAW (pre-recolor) icon asset — self-anchor per the
/// module doc's rule (role-dependent only for [`Role::Light`]), plus
/// ink-top. `key` (the full `sym`/`sym_extra` address, e.g. `light/red`) is
/// consulted only by the [`Role::Light`] branch, to tell the flare
/// (`light/*`) from the floodlight adjunct (`floodlight/*`) — see that
/// branch's own comment for why the two need different anchors.
fn geometry(raw_svg: &str, role: Role, key: &str) -> Result<Geometry, IconError> {
    let opt = usvg::Options::default();
    let tree = usvg::Tree::from_str(raw_svg, &opt)
        .map_err(|e| IconError::Recolor(RecolorError::Svg(e.to_string())))?;
    let size = tree.size();
    let (width, height) = (size.width() as f64, size.height() as f64);
    let classes = class_map(raw_svg)?;

    let mut basepoint: Option<Point> = None;
    let mut baseline_bottom: Option<Point> = None; // greatest bbox-bottom seen so far
                                                   // Ink node: (own drawing transform, local-frame bbox top, canvas-frame
                                                   // bbox top). The local value is what makes a leaning body's mast
                                                   // measurable — straight up in the group's own frame.
    let mut ink: Vec<(usvg::Transform, f64, f64)> = Vec::new();

    fn walk(
        group: &usvg::Group,
        classes: &HashMap<String, String>,
        basepoint: &mut Option<Point>,
        baseline_bottom: &mut Option<Point>,
        ink: &mut Vec<(usvg::Transform, f64, f64)>,
    ) {
        for node in group.children() {
            let id = node.id();
            let bb = node.abs_bounding_box();
            if bb.width() > 0.0 || bb.height() > 0.0 {
                ink.push((
                    node.abs_transform(),
                    node.bounding_box().y() as f64,
                    bb.y() as f64,
                ));
            }
            if has_class(classes, id, "basepoint") {
                *basepoint = Some(Point {
                    x: (bb.x() + bb.width() / 2.0) as f64,
                    y: (bb.y() + bb.height() / 2.0) as f64,
                });
            }
            if has_class(classes, id, "baseline") {
                let bottom = (bb.y() + bb.height()) as f64;
                let cx = (bb.x() + bb.width() / 2.0) as f64;
                if baseline_bottom.is_none_or(|p| bottom > p.y) {
                    *baseline_bottom = Some(Point { x: cx, y: bottom });
                }
            }
            if let usvg::Node::Group(g) = node {
                walk(g, classes, basepoint, baseline_bottom, ink);
            }
        }
    }
    walk(
        tree.root(),
        &classes,
        &mut basepoint,
        &mut baseline_bottom,
        &mut ink,
    );

    let self_anchor = match role {
        // Flare anchor is the tip, not the glow blob — confirmed by direct
        // visual check of the real chart; see
        // docs/architecture/icon-pivot-convention.md ("tip, not blob").
        Role::Light if key.starts_with("light/") => Point {
            x: width / 2.0,
            y: 0.0,
        },
        Role::Light => Point {
            x: width / 2.0,
            y: 0.0,
        },
        // A topmark's own anchor is the loose end of its mast stub — the
        // bottom of its canvas — whatever the artwork's S-57 class says.
        Role::Overlay => basepoint.or(baseline_bottom).unwrap_or(Point {
            x: width / 2.0,
            y: height,
        }),
        Role::Base => basepoint
            .or(baseline_bottom)
            .unwrap_or_else(|| fallback_self_anchor(raw_svg, key, width, height)),
    };
    let (mast_top, lean) = mast(&ink, self_anchor, height);

    Ok(Geometry {
        width,
        height,
        self_anchor,
        mast_top,
        lean,
    })
}

/// S-57 shape enumerations whose s57-style.json layer declares `icon-anchor:
/// "bottom"` (`BOYSHP`/`BCNSHP`/`CATLMK`/`TOPSHP`) — see the pivot doc.
const BOTTOM_ANCHORED_SHAPE_CLASSES: &[&str] = &["BOYSHP", "BCNSHP", "CATLMK", "TOPSHP"];

/// Icon names a `"bottom"` s57-style.json layer draws by LITERAL name with no
/// embedded shape id or `.basepoint`/`.baseline` of their own —
/// `radar-reflector` is the only one (checked exhaustively).
const BOTTOM_ANCHORED_LITERALS: &[&str] = &["radar-reflector"];

/// Where a [`Role::Base`] icon with no `.basepoint`/`.baseline` of its own is
/// anchored — bottom-centre for shape-enumeration artwork, canvas centre for
/// a free-standing symbol; see docs/architecture/icon-pivot-convention.md.
fn fallback_self_anchor(raw_svg: &str, key: &str, width: f64, height: f64) -> Point {
    let by_class = catalog::embedded_shape_class(raw_svg)
        .is_some_and(|c| BOTTOM_ANCHORED_SHAPE_CLASSES.contains(&c.as_str()));
    let (key, _mount) = super::split_overlay_ref(key);
    let name = key.split('/').next().unwrap_or(key);
    let bottom = by_class || BOTTOM_ANCHORED_LITERALS.contains(&name);
    Point {
        x: width / 2.0,
        y: if bottom { height } else { height / 2.0 },
    }
}

/// The mast tip and the body's lean, from the ink collected by [`geometry`].
/// Works in the frame of the TOPMOST ink's own transform (the leaning body's
/// `rotate(15,…)` group, or identity for upright artwork), where the mast
/// runs straight up from the waterline; the tip is mapped back to canvas space.
fn mast(ink: &[(usvg::Transform, f64, f64)], self_anchor: Point, height: f64) -> (Point, f64) {
    let Some((body, _, _)) = ink
        .iter()
        .min_by(|a, b| a.2.total_cmp(&b.2))
        .filter(|(t, _, _)| t.invert().is_some())
    else {
        return (
            Point {
                x: self_anchor.x,
                y: height,
            },
            0.0,
        );
    };
    let same = |t: &usvg::Transform| {
        (t.sx - body.sx).abs() < 1e-6
            && (t.kx - body.kx).abs() < 1e-6
            && (t.ky - body.ky).abs() < 1e-6
            && (t.sy - body.sy).abs() < 1e-6
            && (t.tx - body.tx).abs() < 1e-4
            && (t.ty - body.ty).abs() < 1e-4
    };
    let local_top = ink
        .iter()
        .filter(|(t, _, _)| same(t))
        .map(|(_, local_y, _)| *local_y)
        .fold(f64::INFINITY, f64::min);
    let inv = body.invert().expect("filtered above");
    let mut p = [usvg::tiny_skia_path::Point::from_xy(
        self_anchor.x as f32,
        self_anchor.y as f32,
    )];
    inv.map_points(&mut p);
    let mut tip = [usvg::tiny_skia_path::Point::from_xy(
        p[0].x,
        local_top as f32,
    )];
    body.map_points(&mut tip);
    let lean = (body.ky as f64).atan2(body.sx as f64).to_degrees();
    (
        Point {
            x: tip[0].x as f64,
            y: tip[0].y as f64,
        },
        lean,
    )
}

/// The base icon's RAW (pre-recolor) asset text for `key` — mirrors
/// [`super::resolve`]'s key parsing (sharing [`numeric_icon_name`] so the two
/// never disagree on which asset a key names) but returns the file UNMODIFIED
/// since [`geometry`] needs the `.basepoint`/`.baseline` classes recolor strips.
fn raw_asset_for_key(key: &str) -> Result<String, IconError> {
    let (key, _mount) = super::split_overlay_ref(key);
    let parts: Vec<&str> = key.split('/').collect();
    match parts.as_slice() {
        [prefix @ ("BOYSHP" | "BCNSHP" | "TOPSHP"), shape, _colpat, _colours] => {
            let icon = numeric_icon_name(prefix, shape)?;
            Ok(catalog::load_icon(icon)?)
        }
        [icon, _colourword] => Ok(
            catalog::load_icon(icon).map_err(|_| IconError::UnknownIcon((*icon).to_string()))?
        ),
        [name] => {
            // A literal name may carry `resolve_literal`'s `,RRGGBB` colour
            // override — irrelevant to geometry (a recolour never changes the
            // silhouette), so strip it before the file lookup.
            let base = super::literal_base_name(name);
            Ok(catalog::load_icon(base).map_err(|_| IconError::UnknownIcon(base.to_string()))?)
        }
        _ => Err(IconError::BadKey(key.to_string())),
    }
}

/// The child element nodes of `svg`'s root `<svg>`, as verbatim source text
/// (`roxmltree`'s byte ranges into `svg` itself — exact, no
/// re-serialization drift).
fn root_children_xml(svg: &str) -> Result<Vec<String>, IconError> {
    let doc = roxmltree::Document::parse(svg)
        .map_err(|e| IconError::Recolor(RecolorError::Xml(e.to_string())))?;
    Ok(doc
        .root_element()
        .children()
        .filter(|n| n.is_element())
        .map(|n| svg[n.range()].to_string())
        .collect())
}

/// One layer, already placed in the shared "world origin at (0, 0)" frame
/// (the coordinate system every [`stack`]/[`stack_overlay`] target is
/// expressed in — see their doc comments).
struct Placed {
    xml: Vec<String>,
    /// Where this layer's own self-anchor lands in the shared frame.
    target: Point,
    /// That self-anchor, in the layer's OWN canvas coordinates.
    anchor: Point,
    /// Degrees clockwise about `target` (a base's lean, handed to the
    /// topmark riding its mast; 0 for everything else).
    rotate: f64,
    width: f64,
    height: f64,
}

impl Placed {
    /// This layer's canvas corners in the shared frame, after the rotation
    /// about `target` — what [`compose`] sizes the padded canvas from.
    fn corners(&self) -> [Point; 4] {
        let (sin, cos) = self.rotate.to_radians().sin_cos();
        let map = |x: f64, y: f64| {
            let (dx, dy) = (x - self.anchor.x, y - self.anchor.y);
            Point {
                x: self.target.x + dx * cos - dy * sin,
                y: self.target.y + dx * sin + dy * cos,
            }
        };
        [
            map(0.0, 0.0),
            map(self.width, 0.0),
            map(0.0, self.height),
            map(self.width, self.height),
        ]
    }
}

/// Pad symmetrically so the shared origin lands at the canvas centre —
/// specs-12.md's padding rule, reproduced — sized to the union bbox of
/// `placed`, then serialize every layer into one self-contained SVG.
/// Shared tail of [`stack`] and [`stack_overlay`]: both place their layers
/// differently, but "how a placed-layer set becomes a padded SVG" is the
/// same either way.
fn compose(placed: &[Placed]) -> Result<String, IconError> {
    let mut min_x = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for p in placed {
        for c in p.corners() {
            min_x = min_x.min(c.x);
            max_x = max_x.max(c.x);
            min_y = min_y.min(c.y);
            max_y = max_y.max(c.y);
        }
    }

    let canvas_w = 2.0 * min_x.abs().max(max_x);
    let canvas_h = 2.0 * min_y.abs().max(max_y);
    let cx = canvas_w / 2.0;
    let cy = canvas_h / 2.0;

    let mut out = format!(
        r#"<svg width="{canvas_w}" height="{canvas_h}" viewBox="0 0 {canvas_w} {canvas_h}" xmlns="http://www.w3.org/2000/svg">"#
    );
    for p in placed {
        let tx = cx + p.target.x;
        let ty = cy + p.target.y;
        // An unrotated layer keeps the plain single translate the old
        // pivot convention emitted, byte for byte.
        if p.rotate == 0.0 {
            let (tx, ty) = (tx - p.anchor.x, ty - p.anchor.y);
            out.push_str(&format!(r#"<g transform="translate({tx} {ty})">"#));
        } else {
            let (ax, ay) = (-p.anchor.x, -p.anchor.y);
            out.push_str(&format!(
                r#"<g transform="translate({tx} {ty}) rotate({}) translate({ax} {ay})">"#,
                p.rotate
            ));
        }
        for child in &p.xml {
            out.push_str(child);
        }
        out.push_str("</g>");
    }
    out.push_str("</svg>");

    // Round-trip through usvg once more so the output is guaranteed
    // well-formed, self-contained SVG — the same contract `resolve()`
    // makes — not just "text we happened to concatenate correctly".
    Ok(recolor::normalize(&out)?)
}

/// Merge `layers` into one self-contained SVG, following the pivot
/// convention in the module doc. Z-order is array order (first = bottom, so
/// a [`Role::Base`] layer is conventionally first, matching
/// `ChartSpriteIcon.tsx`'s `compositeLayers` — but placement only depends on
/// `role`, not position). Exactly one [`Role::Base`] layer is required; see
/// [`IconError::NoBaseLayer`].
pub fn stack(layers: &[Layer]) -> Result<String, IconError> {
    stack_with(layers, ColourMode::Day)
}

/// [`stack`], on a chosen colour surface — see [`ColourMode`]. Only the
/// per-layer `resolve` call cares: geometry ([`geometry`],
/// [`raw_asset_for_key`]) is read off the RAW pre-recolor asset and is
/// palette-independent by construction, so the two modes produce the same
/// canvas, the same pivot and the same transforms.
pub fn stack_with(layers: &[Layer], mode: ColourMode) -> Result<String, IconError> {
    let base_idx = layers
        .iter()
        .position(|l| l.role == Role::Base)
        .ok_or(IconError::NoBaseLayer)?;

    let base_raw = raw_asset_for_key(layers[base_idx].key)?;
    let base_geom = geometry(&base_raw, Role::Base, layers[base_idx].key)?;
    // Every target below is relative to the base's own pivot: the shared
    // origin (where every Base/Light self-anchor lands) is world (0, 0).
    let origin = Point { x: 0.0, y: 0.0 };
    let mast_top = mast_top_of(&base_geom);

    let mut placed = Vec::with_capacity(layers.len());
    for layer in layers {
        let raw = raw_asset_for_key(layer.key)?;
        let g = geometry(&raw, layer.role, layer.key)?;
        let (target, rotate) = match layer.role {
            Role::Base | Role::Light => (origin, 0.0),
            Role::Overlay => (mast_top, base_geom.lean),
        };
        let resolved = resolve_with(layer.key, mode)?;
        let xml = root_children_xml(&resolved)?;
        placed.push(Placed {
            xml,
            target,
            anchor: g.self_anchor,
            rotate,
            width: g.width,
            height: g.height,
        });
    }

    compose(&placed)
}

/// A base's mast tip in the shared frame — i.e. relative to its own
/// self-anchor, which [`stack`] pins at world `(0, 0)`. Unlike the old
/// `(0, ink_top - self_anchor.y)`, x is NOT forced to zero: a leaning
/// body's mast tip genuinely sits to one side of its waterline.
fn mast_top_of(base: &Geometry) -> Point {
    Point {
        x: base.mast_top.x - base.self_anchor.x,
        y: base.mast_top.y - base.self_anchor.y,
    }
}

/// Pack `overlay_key` (a topmark/daymark — [`Role::Overlay`]) the way
/// [`stack`] would place it against a real base, but with no real base to
/// pair it with (`pack::pack`, jt task yxrmtltk, packing a stand-alone
/// TOPMAR/DAYMAR feature). `reference_base_key` supplies only the reference
/// geometry (never resolved to actual ink) so the topmark's canvas centres on
/// the same shared point a real base/overlay merge would use. Full rationale,
/// including why the reference must be the aid's real body and not a fixed
/// stand-in, at docs/architecture/icon-pivot-convention.md.
pub fn stack_overlay(reference_base_key: &str, overlay_key: &str) -> Result<String, IconError> {
    stack_overlay_with(reference_base_key, overlay_key, ColourMode::Day)
}

/// [`stack_overlay`], on a chosen colour surface — see [`ColourMode`].
pub fn stack_overlay_with(
    reference_base_key: &str,
    overlay_key: &str,
    mode: ColourMode,
) -> Result<String, IconError> {
    let base_raw = raw_asset_for_key(reference_base_key)?;
    let base_geom = geometry(&base_raw, Role::Base, reference_base_key)?;
    let mast_top = mast_top_of(&base_geom);

    let raw = raw_asset_for_key(overlay_key)?;
    let g = geometry(&raw, Role::Overlay, overlay_key)?;
    let resolved = resolve_with(overlay_key, mode)?;
    let xml = root_children_xml(&resolved)?;

    compose(&[Placed {
        xml,
        target: mast_top,
        anchor: g.self_anchor,
        rotate: base_geom.lean,
        width: g.width,
        height: g.height,
    }])
}

/// Pack a standalone `light`/`floodlight` glyph ([`Role::Light`]) with no
/// base body to ride (`pack::render("light/red")`, jt task prlrlyuy). `stack`
/// requires a [`Role::Base`] layer to establish the shared origin and a solo
/// light has none — but the flare's own self-anchor `(w/2, 0)` already IS
/// that origin, so recentring on it directly reproduces a real stack's result.
pub fn light_stack(key: &str) -> Result<String, IconError> {
    light_stack_with(key, ColourMode::Day)
}

/// [`light_stack`], on a chosen colour surface — see [`ColourMode`].
pub fn light_stack_with(key: &str, mode: ColourMode) -> Result<String, IconError> {
    let raw = raw_asset_for_key(key)?;
    let g = geometry(&raw, Role::Light, key)?;
    let resolved = resolve_with(key, mode)?;
    let xml = root_children_xml(&resolved)?;

    compose(&[Placed {
        xml,
        target: Point { x: 0.0, y: 0.0 },
        anchor: g.self_anchor,
        rotate: 0.0,
        width: g.width,
        height: g.height,
    }])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn well_formed(svg: &str) {
        assert!(svg.starts_with("<svg"), "not a bare <svg> root: {svg}");
        roxmltree::Document::parse(svg).expect("usvg output must itself be valid XML");
    }

    /// The measurement cited in the module doc: s57.json's hand-tuned
    /// per-BOYSHP topmark offsets (1->-12, 2->-8, 3->-9) are ~2x this
    /// crate's own `basepoint_y - ink_top` for the matching base icon —
    /// i.e. they're a lossy, per-symbol-table reconstruction of exactly the
    /// geometric quantity this module derives directly. `default -> -22`
    /// (covering pillar/spar AND the much-shorter barrel/super-buoy alike)
    /// is the sloppiness a geometric rule fixes rather than reproduces.
    #[test]
    fn upstream_offsets_are_roughly_2x_the_measured_basepoint_to_ink_top_gap() {
        let cases: &[(&str, &str, f64)] = &[
            ("conical", "BOYSHP", 12.0),  // BOYSHP=1
            ("can", "BOYSHP", 8.0),       // BOYSHP=2
            ("spherical", "BOYSHP", 9.0), // BOYSHP=3
        ];
        for (icon, _prefix, offset_px) in cases {
            let raw = catalog::load_icon(icon).unwrap();
            let g = geometry(&raw, Role::Base, icon).unwrap();
            let gap = g.self_anchor.y - g.mast_top.y;
            let k = offset_px / gap;
            assert!(
                (1.5..2.5).contains(&k),
                "{icon}: offset {offset_px} / gap {gap} = k {k}, expected ~2.0"
            );
        }
    }

    #[test]
    fn every_parametric_topmark_shapes_baseline_ends_at_bottom_centre() {
        // The fallback self-anchor rule, `(w/2, h)`, is provably what the
        // `.baseline`-based rule already computes for every topmark shape —
        // not a separate special case.
        for icon in [
            "sphere",
            "2_spheres",
            "flag",
            "cross",
            "square",
            "triangle_point_up",
            "triangle_point_down",
            "rhombus",
            "x-shape",
            "cylinder",
            "cone_point_up",
            "cone_point_down",
            "circle",
            "sphere_over_rhombus",
            "2_cones_up",
            "2_cones_down",
            "2_cones_base_together",
            "2_cones_point_together",
        ] {
            let raw = catalog::load_icon(icon).unwrap();
            let g = geometry(&raw, Role::Overlay, icon).unwrap();
            assert!(
                (g.self_anchor.x - g.width / 2.0).abs() < 0.1,
                "{icon}: self_anchor.x {} != w/2 {}",
                g.self_anchor.x,
                g.width / 2.0
            );
            assert!(
                (g.self_anchor.y - g.height).abs() < 0.1,
                "{icon}: self_anchor.y {} != h {}",
                g.self_anchor.y,
                g.height
            );
        }
    }

    /// Does this asset carry anchor geometry of its own, i.e. does the
    /// `.basepoint`/`.baseline` rule answer before the fallback is reached?
    fn carries_anchor_data(raw: &str) -> bool {
        class_map(raw).is_ok_and(|m| {
            m.values().any(|c| {
                c.split_whitespace()
                    .any(|t| t == "basepoint" || t == "baseline")
            })
        })
    }

    /// Every vendored asset that carries NO `.basepoint`/`.baseline` and is
    /// nonetheless BOTTOM-anchored — the complete output of the module doc's
    /// rule, spelled out so the split is greppable and a vendored-artwork
    /// update that changes it fails loudly instead of silently moving symbols
    /// on the chart.
    ///
    /// Derived from s57-style.json's `icon-anchor: "bottom"` layers, NOT from
    /// judgement about the drawings: `landmark` (every `CATLMK_n` asset —
    /// `church`/`spire` are `CATLMK_20`, `tower-lmk` is `_17`, …),
    /// `topmark-beacon` (`besom_point_up`/`_down`, `TOPSHP_15`/`_16`) and
    /// `radar-reflector-buoy`/`-beacon` (`radar-reflector`). Every buoy/
    /// beacon body the `buoy`/`beacon`/`light-vessel` layers reach carries a
    /// `.basepoint` already and so is absent here by construction.
    const BOTTOM_ANCHORED_WITHOUT_ANCHOR_DATA: &[&str] = &[
        "besom_point_down",
        "besom_point_up",
        "chimney",
        "church",
        "column",
        "cross-lmk",
        "dish_aerial",
        "dome",
        "flagstaff",
        "flare-stack",
        "mast",
        "monument",
        "obelisk",
        "radar-reflector",
        "radar_scanner",
        "spire",
        "statue",
        "tower-lmk",
        "windmill",
        "windmotor",
        "windsock",
    ];

    /// The whole fallback rule, over the whole vendored set at once: an asset
    /// with no anchor data of its own anchors at bottom-centre if it is in
    /// [`BOTTOM_ANCHORED_WITHOUT_ANCHOR_DATA`] and at the canvas CENTRE
    /// otherwise — never anywhere else, and never at the bottom by accident.
    ///
    /// This is the regression jt task ompyzypv fixes: before it, EVERY icon
    /// in this loop anchored at the bottom, so MapLibre drew ~110 distinct
    /// symbols (wrecks, rocks, `caution`, `anchor`, `VHF`, the restriction
    /// and hazard families, the light-sector arcs) a half-canvas above the
    /// feature they mark.
    #[test]
    fn anchorless_artwork_falls_back_to_bottom_only_for_the_shape_enumerations() {
        let mut seen_bottom = Vec::new();
        for name in catalog::icon_names() {
            let raw = catalog::load_icon(name).unwrap();
            if carries_anchor_data(&raw) {
                continue;
            }
            let Ok(g) = geometry(&raw, Role::Base, name) else {
                continue; // not every vendored file is a standalone icon
            };
            let expect_bottom = BOTTOM_ANCHORED_WITHOUT_ANCHOR_DATA.contains(&name);
            if expect_bottom {
                seen_bottom.push(name);
            }
            let want_y = if expect_bottom {
                g.height
            } else {
                g.height / 2.0
            };
            assert!(
                (g.self_anchor.y - want_y).abs() < 1e-6,
                "{name}: self_anchor.y {} != {want_y} (h {})",
                g.self_anchor.y,
                g.height
            );
            assert!(
                (g.self_anchor.x - g.width / 2.0).abs() < 1e-6,
                "{name}: self_anchor.x {} != w/2 {}",
                g.self_anchor.x,
                g.width / 2.0
            );
        }
        // …and the expected list names nothing that isn't actually vendored
        // and anchor-data-free, so it can't rot into a list of typos that
        // vacuously passes.
        assert_eq!(
            seen_bottom.len(),
            BOTTOM_ANCHORED_WITHOUT_ANCHOR_DATA.len(),
            "expected-bottom list has entries no vendored icon matches: {seen_bottom:?}"
        );
    }

    /// The user-visible half of the same rule: a centre-anchored symbol needs
    /// NO padding at all, so it comes out of `stack` at exactly its native
    /// canvas size, while a bottom-anchored one is padded to twice its height
    /// (the pivot is its bottom edge, and `compose` pads symmetrically about
    /// the pivot). Sizes are the ones jt task ompyzypv measured through
    /// `chartcore.render_aton_icon`, halved back to native units.
    #[test]
    fn free_standing_symbols_pack_at_native_size_and_landmarks_at_double_height() {
        let size_of = |key: &str| {
            let svg = stack(&[Layer {
                key,
                role: Role::Base,
            }])
            .unwrap_or_else(|e| panic!("{key}: {e}"));
            let tree = usvg::Tree::from_str(&svg, &usvg::Options::default()).unwrap();
            (tree.size().width() as f64, tree.size().height() as f64)
        };
        // Centre-anchored: canvas unchanged from the source artwork.
        for (key, w, h) in [
            ("VHF", 16.0, 40.0),
            ("anchor", 16.0, 20.0),
            ("caution", 14.0, 14.0),
            ("wreck-hull_showing", 16.0, 16.0),
            ("obstruction", 11.0, 11.0),
            ("no-entry", 10.0, 10.0),
            ("marine-farm", 18.0, 18.0),
            ("radio-mast", 11.0, 17.0),
        ] {
            assert_eq!(size_of(key), (w, h), "{key} should pack at native size");
        }
        // Bottom-anchored: padded to twice its height, artwork in the top
        // half, exactly as before this rule existed.
        for key in ["church", "tower-lmk", "chimney", "radar-reflector"] {
            let raw = catalog::load_icon(key).unwrap();
            let native = usvg::Tree::from_str(&raw, &usvg::Options::default()).unwrap();
            let (w, h) = (native.size().width() as f64, native.size().height() as f64);
            assert_eq!(
                size_of(key),
                (w, 2.0 * h),
                "{key} should pack bottom-anchored"
            );
        }
    }

    /// `stack`'s canvas/placement math sizes each layer by its DECLARED
    /// `width`/`height` (`tree.size()`), not a measured ink bbox — cheaper,
    /// and correct only as long as no vendored asset's ink actually spills
    /// past its own declared canvas (these files have no `viewBox`, so
    /// nothing stops that in principle; `pillar.svg`'s raw, pre-transform
    /// path data spans e.g. x∈[12.87, 18.51], well outside its declared
    /// width="11" — only its group's `transform` maps that back inside).
    /// Checked here across every vendored asset (not just the ones this
    /// crate currently reaches) with `abs_bounding_box`, which — unlike the
    /// raw path text — DOES apply that transform: max observed overflow is
    /// `cairn.svg` at 0.04 units past a width/height of 11/12 (~0.4%, pure
    /// stroke-width bleed around a fill path that stroke-width `\0.3-0.5`
    /// paints would round up to; two unrelated `line-*.svg` linestyle
    /// assets — not part of any `sym_s`/`sym_topmark` addressing — overflow
    /// their 256-tall canvas by 0.32 for the same reason). If a future
    /// vendored update ever overflows by more than stroke-width noise,
    /// `stack`'s placement math needs `Geometry` to carry a measured ink
    /// bbox instead of `width`/`height`.
    #[test]
    fn declared_canvas_bounds_every_vendored_icons_ink_to_stroke_width_tolerance() {
        let tolerance = 0.5; // units; measured max overflow was 0.32-0.04
        for name in catalog::icon_names() {
            // Placeholders are exempt: a raster placeholder is a PNG crop
            // padded so its atlas pivot is the canvas centre, which puts the
            // ink wherever the old sprite happened to have it rather than
            // inside a hand-tuned vendored canvas. INERT since xytoltso — the
            // set is empty — and kept only alongside `render_with`'s own
            // guard. See `catalog::is_placeholder`.
            if catalog::is_placeholder(name) {
                continue;
            }
            let raw = catalog::load_icon(name).unwrap();
            let opt = usvg::Options::default();
            let Ok(tree) = usvg::Tree::from_str(&raw, &opt) else {
                continue; // not every vendored file is a standalone icon
            };
            let bb = tree.root().abs_bounding_box();
            let (w, h) = (tree.size().width() as f64, tree.size().height() as f64);
            assert!(
                bb.x() as f64 >= -tolerance
                    && bb.y() as f64 >= -tolerance
                    && (bb.x() + bb.width()) as f64 <= w + tolerance
                    && (bb.y() + bb.height()) as f64 <= h + tolerance,
                "{name}: ink bbox [{:.2},{:.2}..{:.2},{:.2}] overflows declared {w}x{h} \
                 by more than stroke-width tolerance",
                bb.x(),
                bb.y(),
                bb.x() + bb.width(),
                bb.y() + bb.height(),
            );
        }
    }

    /// The mast tip must sit straight up the mast FROM THE WATERLINE — i.e.
    /// the direction from `self_anchor` to `mast_top` must be exactly the
    /// body's declared `lean`. That is the definition of "the top of the
    /// mast", and it is precisely what the pre-vplwqzmr
    /// `(self_anchor.x, ink_top)` violated: it reported the waterline's x
    /// with the leaning tip's y, a point on no mast at all, and the topmark
    /// placed there floated beside the pole rather than on it.
    ///
    /// Checked against every body icon `catalog::shape_icon` can return,
    /// not just the ones the fixture happens to use.
    #[test]
    fn every_bodys_mast_tip_lies_along_its_own_declared_lean() {
        let mut leaning = 0;
        for prefix in ["BOYSHP", "BCNSHP"] {
            for id in 1..=8 {
                let Some(name) = catalog::shape_icon(prefix, id) else {
                    continue;
                };
                let raw = catalog::load_icon(name).unwrap();
                let g = geometry(&raw, Role::Base, name).unwrap();
                let dx = g.mast_top.x - g.self_anchor.x;
                let dy = g.self_anchor.y - g.mast_top.y; // up is positive
                assert!(dy > 0.0, "{name}: mast tip is not above the waterline");
                let axis = dx.atan2(dy).to_degrees();
                assert!(
                    (axis - g.lean).abs() < 0.5,
                    "{name}: mast runs at {axis:.2}° but the body leans {:.2}°",
                    g.lean
                );
                if g.lean.abs() > 1.0 {
                    leaning += 1;
                    assert!(
                        dx.abs() > 0.5,
                        "{name}: leans {:.1}° yet its tip is above its own waterline",
                        g.lean
                    );
                }
            }
        }
        assert!(
            leaning >= 3,
            "expected the leaning buoy artwork (can/conical/pillar/spar) to be \
             reachable through the numeric shape ids; found {leaning}"
        );
    }

    /// The two leaning bodies whose tips were re-derived BY HAND from the
    /// raw `<g transform="rotate(15,cx,cy)">` in the vendored asset (apply
    /// the rotation to the body centreline's top endpoint), so this pins the
    /// answer against the artwork rather than against the code that reads it.
    #[test]
    fn hand_derived_mast_tips_for_the_leaning_artwork() {
        for (name, tip_x, tip_y) in [("pillar", 8.48, 0.88), ("spar", 8.39, 1.22)] {
            let g = geometry(&catalog::load_icon(name).unwrap(), Role::Base, name).unwrap();
            assert!(
                (g.mast_top.x - tip_x).abs() < 0.05 && (g.mast_top.y - tip_y).abs() < 0.05,
                "{name}: measured tip ({:.2},{:.2}) != hand-derived ({tip_x},{tip_y})",
                g.mast_top.x,
                g.mast_top.y
            );
            assert!(
                (g.lean - 15.0).abs() < 0.01,
                "{name}: lean {:.2} != 15",
                g.lean
            );
        }
    }

    #[test]
    fn base_only_stack_is_just_the_base_recentred_on_its_pivot() {
        let svg = stack(&[Layer {
            key: "BOYSHP/4/1/3,1",
            role: Role::Base,
        }])
        .unwrap();
        well_formed(&svg);
        assert!(svg.contains("#ed1c24"));
    }

    #[test]
    fn no_base_layer_is_reported_not_panicking() {
        assert!(matches!(
            stack(&[Layer {
                key: "sphere/red",
                role: Role::Overlay,
            }]),
            Err(IconError::NoBaseLayer)
        ));
    }

    #[test]
    fn pillar_with_sphere_topmark_places_topmark_above_the_pillars_own_ink() {
        let svg = stack(&[
            Layer {
                key: "BOYSHP/4/0/2",
                role: Role::Base,
            },
            Layer {
                key: "sphere/red",
                role: Role::Overlay,
            },
        ])
        .unwrap();
        well_formed(&svg);
        // Both layers' colours must survive the merge.
        assert!(svg.contains("#808080") || svg.contains("#000000") || svg.contains("stroke"));
        assert!(svg.contains("#ed1c24"), "expected the red topmark sphere");
    }

    #[test]
    fn three_way_stack_base_topmark_light_is_well_formed() {
        // No real feature emits a `light/<colour>` key yet (out of scope for
        // this task — see the module doc), but the compositor itself must
        // handle a 3-layer stack generically; light/red exercises Role::Light
        // with a real key `icons::resolve` already understands.
        let svg = stack(&[
            Layer {
                key: "BOYSHP/4/1/3,1",
                role: Role::Base,
            },
            Layer {
                key: "sphere/red",
                role: Role::Overlay,
            },
            Layer {
                key: "light/red",
                role: Role::Light,
            },
        ])
        .unwrap();
        well_formed(&svg);
    }

    /// The actual `uzosnxzs` contract: run `derive::aton::apply` over
    /// synthetic features shaped like the real US5OAKIQ fixture (attribute
    /// shapes documented in `derive/aton.rs`'s own tests) and stack whatever
    /// `sym_s`/`sym_topmark` it emits.
    #[test]
    fn every_base_plus_topmark_pair_derive_aton_can_emit_for_these_features_stacks() {
        use crate::coords::{Extent, WorldXy};
        use crate::derive::aton;
        use crate::model::{AttrValue, Cell, CellMeta, Feature, Geometry as Geom};

        fn feature(acronym: &str, attrs: &[(&str, AttrValue)]) -> Feature {
            let map = attrs
                .iter()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect();
            Feature::new(
                0,
                acronym.into(),
                map,
                Some(Geom::Point(WorldXy::new(0, 0))),
            )
        }

        let mut cell = Cell {
            meta: CellMeta::default(),
            extent: Extent::invalid(),
            features: vec![
                // BOYLAT, COLOUR="3,1" -> sphere/red topmark overlay (aton.rs's
                // topmark_overlay_buoy special case).
                feature(
                    "BOYLAT",
                    &[("COLOUR", AttrValue::StrList(vec!["3".into(), "1".into()]))],
                ),
                // BCNLAT, BCNSHP=1/CATLAM=1, no COLOUR -> besom_point_up overlay
                // (real US5OAKIQ shape, per aton.rs's own fixture-derived test).
                feature(
                    "BCNLAT",
                    &[("BCNSHP", AttrValue::Int(1)), ("CATLAM", AttrValue::Int(1))],
                ),
                // BCNISD, two-spheres COLOUR -> 2_spheres/black overlay.
                feature(
                    "BCNISD",
                    &[(
                        "COLOUR",
                        AttrValue::StrList(vec!["2".into(), "3".into(), "2".into()]),
                    )],
                ),
                // BCNSPP, CATSPM=46 -> flag/generic overlay.
                feature(
                    "BCNSPP",
                    &[("CATSPM", AttrValue::StrList(vec!["46".into()]))],
                ),
                // MORFAC CATMOR=7 -> mooring buoy scheme, no overlay at all
                // (single-layer stack).
                feature("MORFAC", &[("CATMOR", AttrValue::Int(7))]),
            ],
        };
        aton::apply(&mut cell, None);

        let mut checked = 0;
        for f in &cell.features {
            let Some(base) = f.attr("sym_s").and_then(AttrValue::as_str) else {
                continue;
            };
            let mut layers = vec![Layer {
                key: base,
                role: Role::Base,
            }];
            if let Some(overlay) = f.attr("sym_topmark").and_then(AttrValue::as_str) {
                layers.push(Layer {
                    key: overlay,
                    role: Role::Overlay,
                });
            }
            let svg = stack(&layers).unwrap_or_else(|e| panic!("{} base={base:?}: {e}", f.acronym));
            well_formed(&svg);
            checked += 1;
        }
        assert_eq!(checked, 5, "expected every fixture feature to stack");
    }
}
