// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! OGR feature → model feature conversion.

use std::collections::BTreeMap;

use gdal::vector::geometry_type_to_name;
use gdal::vector::Feature as OgrFeature;
use gdal::vector::{FieldValue, Geometry as OgrGeometry, OGRwkbGeometryType as Wkb};

use super::S57Error;
use crate::coords::lat_lon_to_world;
use crate::model::{AttrValue, CellMeta, Feature, Geometry, PointZ, Polygon};

/// OGR S57 bookkeeping fields, not S-57 object attributes (RCID/LNAM/GRUP/
/// LNAM_REFS are lifted into typed `Feature` fields instead). FFPT_RIND is
/// dropped: `aid_group` treats LNAM_REFS edges as undirected, so direction is unneeded.
const CONTROL_FIELDS: &[&str] = &[
    "RCID",
    "PRIM",
    "GRUP",
    "OBJL",
    "RVER",
    "RUIN",
    "AGEN",
    "FIDN",
    "FIDS",
    "LNAM",
    "FFPT_RIND",
    "NAME_RCNM",
    "NAME_RCID",
    "ORNT",
    "USAG",
    "MASK",
];

/// A feature's FSPT pointers into the spatial record tables, as
/// `(RCNM, RCID)` pairs (110 = isolated node, 120 = connected node, 130 =
/// edge). Present only when opened with `RETURN_LINKAGES=ON`.
pub(super) type SpatialRefs = Vec<(i64, i64)>;

/// Convert one OGR feature into a model feature, plus its spatial-record
/// references (empty without `RETURN_LINKAGES`).
pub(super) fn to_model(
    layer_name: &str,
    f: &OgrFeature,
) -> Result<(Feature, SpatialRefs), S57Error> {
    let mut attributes = BTreeMap::new();
    let mut type_code: u16 = 0;
    let mut rcid = None;
    let mut lnam = None;
    let mut lnam_refs: Vec<String> = Vec::new();
    let mut group = None;
    let mut name_rcnm: Vec<i64> = Vec::new();
    let mut name_rcid: Vec<i64> = Vec::new();

    for (name, value) in f.fields() {
        let Some(value) = value else { continue };
        match name.as_str() {
            "OBJL" => {
                type_code = value
                    .into_int()
                    .and_then(|v| u16::try_from(v).ok())
                    .unwrap_or(0);
            }
            "RCID" => rcid = value.into_int().and_then(|v| u32::try_from(v).ok()),
            "LNAM" => lnam = value.into_string(),
            "LNAM_REFS" => lnam_refs = str_list(value),
            "GRUP" => group = value.into_int().and_then(|v| u8::try_from(v).ok()),
            "NAME_RCNM" => name_rcnm = int_list(value),
            "NAME_RCID" => name_rcid = int_list(value),
            _ if CONTROL_FIELDS.contains(&name.as_str()) => {}
            _ => {
                attributes.insert(name, field_to_attr(value));
            }
        }
    }

    let geometry = match f.geometry() {
        Some(g) => Some(to_model_geometry(layer_name, g)?),
        None => None,
    };

    let mut feature = Feature::new(type_code, layer_name.to_string(), attributes, geometry);
    feature.rcid = rcid;
    feature.lnam = lnam;
    feature.lnam_refs = lnam_refs;
    feature.group = group;
    Ok((feature, name_rcnm.into_iter().zip(name_rcid).collect()))
}

/// An OGR string-list field (S57 `LNAM_REFS` is `OFTStringList`) as a plain
/// `Vec<String>`. A comma-joined single string is defensively split, though
/// the S57 driver returns a real list.
fn str_list(value: FieldValue) -> Vec<String> {
    match value {
        FieldValue::StringListValue(v) => v,
        FieldValue::StringValue(s) => s
            .split(',')
            .filter(|x| !x.is_empty())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

/// An integer or integer-list field as a plain `Vec<i64>` (point features
/// may carry a scalar where line/area features carry lists).
fn int_list(value: FieldValue) -> Vec<i64> {
    match value {
        FieldValue::IntegerValue(v) => vec![v.into()],
        FieldValue::Integer64Value(v) => vec![v],
        FieldValue::IntegerListValue(v) => v.into_iter().map(i64::from).collect(),
        FieldValue::Integer64ListValue(v) => v,
        _ => Vec::new(),
    }
}

/// QUAPOS of one spatial-primitive record (`RETURN_PRIMITIVES=ON` layers:
/// IsolatedNode/ConnectedNode/Edge/Face), keyed for [`SpatialRefs`] lookup.
/// `None` when the record has no QUAPOS or lacks the id fields.
pub(super) fn primitive_quapos(f: &OgrFeature) -> Option<((i64, i64), i64)> {
    fn int(f: &OgrFeature, name: &str) -> Option<i64> {
        f.field_index(name)
            .ok()
            .and_then(|i| f.field(i).ok().flatten())
            .and_then(|v| match v {
                FieldValue::IntegerValue(v) => Some(v.into()),
                FieldValue::Integer64Value(v) => Some(v),
                _ => None,
            })
    }
    Some(((int(f, "RCNM")?, int(f, "RCID")?), int(f, "QUAPOS")?))
}

/// Extract cell metadata from the DSID pseudo-feature. The numeric DSID
/// fields arrive as strings (EDTN/UPDN/ISDT…); missing or unparsable values
/// become 0.
pub(super) fn dsid_to_meta(f: &OgrFeature) -> CellMeta {
    fn str_field(f: &OgrFeature, name: &str) -> Option<String> {
        f.field_index(name)
            .ok()
            .and_then(|i| f.field(i).ok().flatten())
            .and_then(|v| match v {
                FieldValue::StringValue(s) => Some(s),
                FieldValue::IntegerValue(i) => Some(i.to_string()),
                _ => None,
            })
    }
    fn int_field(f: &OgrFeature, name: &str) -> u32 {
        str_field(f, name)
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(0)
    }
    CellMeta {
        name: str_field(f, "DSID_DSNM").unwrap_or_default(),
        edition: int_field(f, "DSID_EDTN"),
        update: int_field(f, "DSID_UPDN"),
        compilation_scale: int_field(f, "DSPM_CSCL"),
    }
}

/// Map an OGR field value to a model attribute value. The S57 driver reports
/// enum-list attributes (COLOUR, CATLIT, …) as string lists of numeric codes;
/// preserved as `StrList` — normalization is the consumer's call (`AttrValue::as_int_list`).
fn field_to_attr(value: FieldValue) -> AttrValue {
    match value {
        FieldValue::IntegerValue(v) => AttrValue::Int(v.into()),
        FieldValue::Integer64Value(v) => AttrValue::Int(v),
        FieldValue::RealValue(v) => AttrValue::Float(v),
        FieldValue::StringValue(v) => AttrValue::Str(v),
        FieldValue::IntegerListValue(v) => {
            AttrValue::IntList(v.into_iter().map(i64::from).collect())
        }
        FieldValue::Integer64ListValue(v) => AttrValue::IntList(v),
        FieldValue::RealListValue(v) => AttrValue::FloatList(v),
        FieldValue::StringListValue(v) => AttrValue::StrList(v),
        FieldValue::DateValue(v) => AttrValue::Str(v.to_string()),
        FieldValue::DateTimeValue(v) => AttrValue::Str(v.to_string()),
    }
}

/// Convert OGR geometry (lon/lat WGS84) to model geometry in world coords.
fn to_model_geometry(layer_name: &str, g: &OgrGeometry) -> Result<Geometry, S57Error> {
    // strip the 2.5D / Z flag: wkbPoint25D → wkbPoint etc.
    match gdal::vector::geometry_type_flatten(g.geometry_type()) {
        Wkb::wkbPoint => {
            let (lon, lat, _) = g.get_point(0);
            Ok(Geometry::Point(lat_lon_to_world(lat, lon)))
        }
        Wkb::wkbMultiPoint => {
            let points = (0..g.geometry_count())
                .map(|i| {
                    let (lon, lat, z) = g.get_geometry(i).get_point(0);
                    PointZ {
                        pos: lat_lon_to_world(lat, lon),
                        z,
                    }
                })
                .collect();
            Ok(Geometry::MultiPoint(points))
        }
        Wkb::wkbLineString => Ok(Geometry::Lines(vec![line_points(g)])),
        Wkb::wkbMultiLineString => Ok(Geometry::Lines(
            (0..g.geometry_count())
                .map(|i| line_points(&g.get_geometry(i)))
                .collect(),
        )),
        Wkb::wkbPolygon => Ok(Geometry::Areas(vec![polygon(g)])),
        Wkb::wkbMultiPolygon => Ok(Geometry::Areas(
            (0..g.geometry_count())
                .map(|i| polygon(&g.get_geometry(i)))
                .collect(),
        )),
        other => Err(S57Error::UnsupportedGeometry {
            layer: layer_name.to_string(),
            wkb_type: geometry_type_to_name(other),
        }),
    }
}

/// Vertices of a line string / linear ring, converted to world coordinates.
fn line_points(g: &OgrGeometry) -> Vec<crate::coords::WorldXy> {
    (0..g.point_count())
        .map(|i| {
            let (lon, lat, _) = g.get_point(i as i32);
            lat_lon_to_world(lat, lon)
        })
        .collect()
}

/// A polygon from its rings: ring 0 is the outer boundary, the rest holes.
fn polygon(g: &OgrGeometry) -> Polygon {
    let mut rings = (0..g.geometry_count()).map(|i| line_points(&g.get_geometry(i)));
    let outer = rings.next().unwrap_or_default();
    Polygon {
        outer,
        holes: rings.collect(),
    }
}
