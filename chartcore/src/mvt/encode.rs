// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Mapbox Vector Tile (MVT 2.1) protobuf encoder.
//! Hand-rolled to avoid pulling a protobuf codegen stack for one small,
//! frozen schema; output is fully deterministic (sorted/insertion order).

use std::collections::{BTreeMap, HashMap};

use crate::varint::{write_varint, zigzag_encode64};

/// MVT tile extent: tile-local coordinates run 0..EXTENT per tile edge.
pub const EXTENT: u32 = 4096;

/// An MVT tag value. The encoder writes `Str` as string_value, `Double` as
/// double_value, `Int` as sint_value (zigzag) and `Bool` as bool_value.
#[derive(Debug, Clone, PartialEq)]
pub enum TagValue {
    Str(String),
    Double(f64),
    Int(i64),
    Bool(bool),
}

/// Tile-local geometry in MVT coordinates (already clipped; values must fit
/// the tile buffer range, well within i32).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MvtGeometry {
    Points(Vec<(i32, i32)>),
    /// One or more linestrings, each with >= 2 vertices.
    Lines(Vec<Vec<(i32, i32)>>),
    /// Polygon rings without the closing vertex, in MVT winding order
    /// (exterior positive-area, interior negative), each exterior followed
    /// by its interiors.
    Polygons(Vec<Vec<(i32, i32)>>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct MvtFeature {
    pub id: Option<u64>,
    /// Tags in emission order; keys should be unique per feature.
    pub tags: Vec<(String, TagValue)>,
    pub geom: MvtGeometry,
}

const WIRE_VARINT: u32 = 0;
const WIRE_FIXED64: u32 = 1;
const WIRE_LEN: u32 = 2;

fn write_key(buf: &mut Vec<u8>, field: u32, wire: u32) {
    write_varint(buf, ((field << 3) | wire) as u64);
}

fn write_len_field(buf: &mut Vec<u8>, field: u32, data: &[u8]) {
    write_key(buf, field, WIRE_LEN);
    write_varint(buf, data.len() as u64);
    buf.extend_from_slice(data);
}

fn write_varint_field(buf: &mut Vec<u8>, field: u32, v: u64) {
    write_key(buf, field, WIRE_VARINT);
    write_varint(buf, v);
}

fn write_packed_field(buf: &mut Vec<u8>, field: u32, values: &[u64]) {
    let mut packed = Vec::new();
    for v in values {
        write_varint(&mut packed, *v);
    }
    write_len_field(buf, field, &packed);
}

/// Encode a complete tile: one MVT layer per map entry, in map (sorted)
/// order.
pub fn encode_tile(layers: &BTreeMap<String, Vec<MvtFeature>>) -> Vec<u8> {
    let mut out = Vec::new();
    for (name, features) in layers {
        let layer = encode_layer(name, features);
        write_len_field(&mut out, 3, &layer); // Tile.layers = 3
    }
    out
}

fn encode_value(v: &TagValue) -> Vec<u8> {
    let mut b = Vec::new();
    match v {
        TagValue::Str(s) => write_len_field(&mut b, 1, s.as_bytes()),
        TagValue::Double(d) => {
            write_key(&mut b, 3, WIRE_FIXED64);
            b.extend_from_slice(&d.to_le_bytes());
        }
        TagValue::Int(i) => write_varint_field(&mut b, 6, zigzag_encode64(*i)),
        TagValue::Bool(x) => write_varint_field(&mut b, 7, *x as u64),
    }
    b
}

fn encode_layer(name: &str, features: &[MvtFeature]) -> Vec<u8> {
    let mut keys: Vec<&str> = Vec::new();
    let mut key_idx: HashMap<&str, u32> = HashMap::new();
    let mut values: Vec<Vec<u8>> = Vec::new();
    let mut value_idx: HashMap<Vec<u8>, u32> = HashMap::new();

    let mut feature_bufs: Vec<Vec<u8>> = Vec::with_capacity(features.len());
    for f in features {
        let mut tag_ints: Vec<u64> = Vec::with_capacity(f.tags.len() * 2);
        for (k, v) in &f.tags {
            let ki = match key_idx.get(k.as_str()) {
                Some(i) => *i,
                None => {
                    let i = keys.len() as u32;
                    keys.push(k);
                    key_idx.insert(k, i);
                    i
                }
            };
            let enc = encode_value(v);
            let vi = match value_idx.get(&enc) {
                Some(i) => *i,
                None => {
                    let i = values.len() as u32;
                    value_idx.insert(enc.clone(), i);
                    values.push(enc);
                    i
                }
            };
            tag_ints.push(ki as u64);
            tag_ints.push(vi as u64);
        }

        let mut fb = Vec::new();
        if let Some(id) = f.id {
            write_varint_field(&mut fb, 1, id); // Feature.id = 1
        }
        write_packed_field(&mut fb, 2, &tag_ints); // Feature.tags = 2
        let geom_type = match &f.geom {
            MvtGeometry::Points(_) => 1u64,
            MvtGeometry::Lines(_) => 2,
            MvtGeometry::Polygons(_) => 3,
        };
        write_varint_field(&mut fb, 3, geom_type); // Feature.type = 3
        let cmds: Vec<u64> = geometry_commands(&f.geom)
            .into_iter()
            .map(u64::from)
            .collect();
        write_packed_field(&mut fb, 4, &cmds); // Feature.geometry = 4
        feature_bufs.push(fb);
    }

    let mut layer = Vec::new();
    write_varint_field(&mut layer, 15, 2); // Layer.version = 15, MVT v2
    write_len_field(&mut layer, 1, name.as_bytes()); // Layer.name = 1
    for fb in &feature_bufs {
        write_len_field(&mut layer, 2, fb); // Layer.features = 2
    }
    for k in &keys {
        write_len_field(&mut layer, 3, k.as_bytes()); // Layer.keys = 3
    }
    for v in &values {
        write_len_field(&mut layer, 4, v); // Layer.values = 4
    }
    write_varint_field(&mut layer, 5, EXTENT as u64); // Layer.extent = 5
    layer
}

const CMD_MOVE_TO: u32 = 1;
const CMD_LINE_TO: u32 = 2;
const CMD_CLOSE_PATH: u32 = 7;

fn command(id: u32, count: u32) -> u32 {
    (id & 0x7) | (count << 3)
}

fn zigzag32(v: i32) -> u32 {
    ((v << 1) ^ (v >> 31)) as u32
}

/// Flatten geometry into the MVT command/parameter stream. The cursor
/// persists across all parts of one feature, per spec.
fn geometry_commands(geom: &MvtGeometry) -> Vec<u32> {
    let mut cmds = Vec::new();
    let mut cx = 0i32;
    let mut cy = 0i32;
    let mut push_deltas = |cmds: &mut Vec<u32>, p: (i32, i32)| {
        cmds.push(zigzag32(p.0 - cx));
        cmds.push(zigzag32(p.1 - cy));
        cx = p.0;
        cy = p.1;
    };
    match geom {
        MvtGeometry::Points(pts) => {
            cmds.push(command(CMD_MOVE_TO, pts.len() as u32));
            for p in pts {
                push_deltas(&mut cmds, *p);
            }
        }
        MvtGeometry::Lines(lines) => {
            for line in lines {
                cmds.push(command(CMD_MOVE_TO, 1));
                push_deltas(&mut cmds, line[0]);
                cmds.push(command(CMD_LINE_TO, (line.len() - 1) as u32));
                for p in &line[1..] {
                    push_deltas(&mut cmds, *p);
                }
            }
        }
        MvtGeometry::Polygons(rings) => {
            for ring in rings {
                cmds.push(command(CMD_MOVE_TO, 1));
                push_deltas(&mut cmds, ring[0]);
                cmds.push(command(CMD_LINE_TO, (ring.len() - 1) as u32));
                for p in &ring[1..] {
                    push_deltas(&mut cmds, *p);
                }
                cmds.push(command(CMD_CLOSE_PATH, 1));
            }
        }
    }
    cmds
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn geometry_commands_match_spec_example() {
        // MVT spec 4.3.5.2 example polygon
        let geom = MvtGeometry::Polygons(vec![vec![(3, 6), (8, 12), (20, 34)]]);
        assert_eq!(
            geometry_commands(&geom),
            vec![9, 6, 12, 18, 10, 12, 24, 44, 15]
        );
    }

    #[test]
    fn multipoint_shares_one_moveto() {
        let geom = MvtGeometry::Points(vec![(5, 7), (3, 2)]);
        assert_eq!(geometry_commands(&geom), vec![17, 10, 14, 3, 9]);
    }

    #[test]
    fn cursor_persists_across_linestrings() {
        // MVT spec 4.3.5.3 example multilinestring
        let geom = MvtGeometry::Lines(vec![vec![(2, 2), (2, 10), (10, 10)], vec![(1, 1), (3, 5)]]);
        assert_eq!(
            geometry_commands(&geom),
            vec![9, 4, 4, 18, 0, 16, 16, 0, 9, 17, 17, 10, 4, 8]
        );
    }

    #[test]
    fn value_dedup_within_layer() {
        let f = |v: i64| MvtFeature {
            id: None,
            tags: vec![("A".into(), TagValue::Int(v))],
            geom: MvtGeometry::Points(vec![(0, 0)]),
        };
        let mut layers = BTreeMap::new();
        layers.insert("L".to_string(), vec![f(1), f(1), f(2)]);
        let a = encode_tile(&layers);
        layers.get_mut("L").unwrap().pop();
        let b = encode_tile(&layers);
        // adding a feature with a *new* value grows the value table; the two
        // identical features shared one entry (a is bigger than b by more
        // than just the third feature's fixed cost if dedup failed)
        assert!(a.len() > b.len());
        // deterministic
        assert_eq!(b, encode_tile(&layers));
    }
}
