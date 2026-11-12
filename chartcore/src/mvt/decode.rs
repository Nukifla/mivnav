// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Minimal MVT decoder — the read side of [`super::encode`], used by the
//! golden-tile tests and for debugging tile output. Accepts any spec-conform
//! tile (all seven value types, unknown fields skipped), not just our own
//! encoder's output.

use std::collections::BTreeMap;

use super::TagValue;
use crate::varint::{read_varint, zigzag_decode64};

#[derive(Debug, Clone, PartialEq)]
pub struct DecodedTile {
    pub layers: Vec<DecodedLayer>,
}

impl DecodedTile {
    pub fn layer(&self, name: &str) -> Option<&DecodedLayer> {
        self.layers.iter().find(|l| l.name == name)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DecodedLayer {
    pub name: String,
    pub version: u32,
    pub extent: u32,
    pub features: Vec<DecodedFeature>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GeomType {
    Unknown,
    Point,
    Line,
    Polygon,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DecodedFeature {
    pub id: Option<u64>,
    pub tags: BTreeMap<String, TagValue>,
    pub geom_type: GeomType,
    /// Geometry parts: point runs, linestrings, or rings (rings without the
    /// closing vertex, as on the wire).
    pub parts: Vec<Vec<(i32, i32)>>,
}

enum FieldValue<'a> {
    Varint(u64),
    Fixed64(u64),
    Bytes(&'a [u8]),
    Fixed32(u32),
}

fn read_field<'a>(data: &'a [u8], pos: &mut usize) -> Result<(u32, FieldValue<'a>), String> {
    let key = read_varint(data, pos).ok_or("truncated field key")?;
    let field = (key >> 3) as u32;
    let value = match key & 0x7 {
        0 => FieldValue::Varint(read_varint(data, pos).ok_or("truncated varint")?),
        1 => {
            let end = *pos + 8;
            let b = data.get(*pos..end).ok_or("truncated fixed64")?;
            *pos = end;
            FieldValue::Fixed64(u64::from_le_bytes(b.try_into().unwrap()))
        }
        2 => {
            let len = read_varint(data, pos).ok_or("truncated length")? as usize;
            // len is untrusted: checked, or a huge declared length would
            // overflow the add (debug-build panic) instead of erroring
            let end = pos.checked_add(len).ok_or("bytes field length overflow")?;
            let b = data.get(*pos..end).ok_or("truncated bytes field")?;
            *pos = end;
            FieldValue::Bytes(b)
        }
        5 => {
            let end = *pos + 4;
            let b = data.get(*pos..end).ok_or("truncated fixed32")?;
            *pos = end;
            FieldValue::Fixed32(u32::from_le_bytes(b.try_into().unwrap()))
        }
        w => return Err(format!("unsupported wire type {w}")),
    };
    Ok((field, value))
}

fn read_packed_varints(data: &[u8]) -> Result<Vec<u64>, String> {
    let mut out = Vec::new();
    let mut pos = 0;
    while pos < data.len() {
        out.push(read_varint(data, &mut pos).ok_or("truncated packed varint")?);
    }
    Ok(out)
}

/// Decode a full MVT tile.
pub fn decode_tile(data: &[u8]) -> Result<DecodedTile, String> {
    let mut layers = Vec::new();
    let mut pos = 0;
    while pos < data.len() {
        // unknown fields are skipped by read_field's advancing
        if let (3, FieldValue::Bytes(b)) = read_field(data, &mut pos)? {
            layers.push(decode_layer(b)?);
        }
    }
    Ok(DecodedTile { layers })
}

fn decode_value(data: &[u8]) -> Result<TagValue, String> {
    let mut pos = 0;
    let (field, value) = read_field(data, &mut pos)?;
    Ok(match (field, value) {
        (1, FieldValue::Bytes(b)) => {
            TagValue::Str(String::from_utf8(b.to_vec()).map_err(|e| e.to_string())?)
        }
        (2, FieldValue::Fixed32(v)) => TagValue::Double(f32::from_bits(v) as f64),
        (3, FieldValue::Fixed64(v)) => TagValue::Double(f64::from_bits(v)),
        (4, FieldValue::Varint(v)) => TagValue::Int(v as i64),
        (5, FieldValue::Varint(v)) => TagValue::Int(v as i64),
        (6, FieldValue::Varint(v)) => TagValue::Int(zigzag_decode64(v)),
        (7, FieldValue::Varint(v)) => TagValue::Bool(v != 0),
        (f, _) => return Err(format!("unsupported Value field {f}")),
    })
}

fn decode_layer(data: &[u8]) -> Result<DecodedLayer, String> {
    let mut name = String::new();
    let mut version = 1u32;
    let mut extent = 4096u32;
    let mut keys: Vec<String> = Vec::new();
    let mut values: Vec<TagValue> = Vec::new();
    let mut raw_features: Vec<&[u8]> = Vec::new();

    let mut pos = 0;
    while pos < data.len() {
        match read_field(data, &mut pos)? {
            (1, FieldValue::Bytes(b)) => {
                name = String::from_utf8(b.to_vec()).map_err(|e| e.to_string())?
            }
            (2, FieldValue::Bytes(b)) => raw_features.push(b),
            (3, FieldValue::Bytes(b)) => {
                keys.push(String::from_utf8(b.to_vec()).map_err(|e| e.to_string())?)
            }
            (4, FieldValue::Bytes(b)) => values.push(decode_value(b)?),
            (5, FieldValue::Varint(v)) => extent = v as u32,
            (15, FieldValue::Varint(v)) => version = v as u32,
            _ => {}
        }
    }

    let mut features = Vec::with_capacity(raw_features.len());
    for raw in raw_features {
        features.push(decode_feature(raw, &keys, &values)?);
    }
    Ok(DecodedLayer {
        name,
        version,
        extent,
        features,
    })
}

fn decode_feature(
    data: &[u8],
    keys: &[String],
    values: &[TagValue],
) -> Result<DecodedFeature, String> {
    let mut id = None;
    let mut tags = BTreeMap::new();
    let mut geom_type = GeomType::Unknown;
    // packed repeated fields: multiple occurrences concatenate, and
    // wire-type-0 (unpacked) encoding is equally valid per protobuf
    let mut tag_ints: Vec<u64> = Vec::new();
    let mut geom_cmds: Vec<u64> = Vec::new();

    let mut pos = 0;
    while pos < data.len() {
        match read_field(data, &mut pos)? {
            (1, FieldValue::Varint(v)) => id = Some(v),
            (2, FieldValue::Bytes(b)) => tag_ints.extend(read_packed_varints(b)?),
            (2, FieldValue::Varint(v)) => tag_ints.push(v),
            (3, FieldValue::Varint(v)) => {
                geom_type = match v {
                    1 => GeomType::Point,
                    2 => GeomType::Line,
                    3 => GeomType::Polygon,
                    _ => GeomType::Unknown,
                }
            }
            (4, FieldValue::Bytes(b)) => geom_cmds.extend(read_packed_varints(b)?),
            (4, FieldValue::Varint(v)) => geom_cmds.push(v),
            _ => {}
        }
    }
    for pair in tag_ints.chunks(2) {
        let [k, v] = pair else {
            return Err("odd tag count".into());
        };
        let key = keys.get(*k as usize).ok_or("key index out of range")?;
        let value = values.get(*v as usize).ok_or("value index out of range")?;
        tags.insert(key.clone(), value.clone());
    }
    let parts = decode_geometry(&geom_cmds)?;
    Ok(DecodedFeature {
        id,
        tags,
        geom_type,
        parts,
    })
}

fn zigzag_decode32(v: u32) -> i32 {
    ((v >> 1) as i32) ^ -((v & 1) as i32)
}

fn decode_geometry(cmds: &[u64]) -> Result<Vec<Vec<(i32, i32)>>, String> {
    let mut parts: Vec<Vec<(i32, i32)>> = Vec::new();
    let mut cur: Vec<(i32, i32)> = Vec::new();
    let mut cx = 0i32;
    let mut cy = 0i32;
    let mut i = 0;
    while i < cmds.len() {
        let cmd = cmds[i] as u32;
        i += 1;
        let (op, count) = (cmd & 0x7, cmd >> 3);
        match op {
            1 | 2 => {
                if op == 1 && !cur.is_empty() {
                    parts.push(std::mem::take(&mut cur));
                }
                for _ in 0..count {
                    let dx = *cmds.get(i).ok_or("truncated geometry")? as u32;
                    let dy = *cmds.get(i + 1).ok_or("truncated geometry")? as u32;
                    i += 2;
                    cx += zigzag_decode32(dx);
                    cy += zigzag_decode32(dy);
                    cur.push((cx, cy));
                }
            }
            7 => {
                // ClosePath: ring ends; closing vertex stays implicit
                if !cur.is_empty() {
                    parts.push(std::mem::take(&mut cur));
                }
            }
            op => return Err(format!("unknown geometry command {op}")),
        }
    }
    if !cur.is_empty() {
        parts.push(cur);
    }
    Ok(parts)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::mvt::{encode_tile, MvtFeature, MvtGeometry};

    #[test]
    fn encode_decode_round_trip() {
        let mut layers: BTreeMap<String, Vec<MvtFeature>> = BTreeMap::new();
        layers.insert(
            "DEPARE".to_string(),
            vec![MvtFeature {
                id: Some(7),
                tags: vec![
                    ("DRVAL1".into(), TagValue::Double(2.5)),
                    ("OBJL".into(), TagValue::Int(-42)),
                    ("COLOUR".into(), TagValue::Str("3,4".into())),
                    ("FLAG".into(), TagValue::Bool(true)),
                ],
                geom: MvtGeometry::Polygons(vec![
                    vec![(0, 0), (100, 0), (100, 100), (0, 100)],
                    vec![(20, 20), (20, 40), (40, 40), (40, 20)],
                ]),
            }],
        );
        layers.insert(
            "LIGHTS".to_string(),
            vec![MvtFeature {
                id: None,
                tags: vec![],
                geom: MvtGeometry::Points(vec![(2048, 2048)]),
            }],
        );

        let bytes = encode_tile(&layers);
        let tile = decode_tile(&bytes).unwrap();

        assert_eq!(tile.layers.len(), 2);
        assert_eq!(tile.layers[0].name, "DEPARE");
        assert_eq!(tile.layers[1].name, "LIGHTS");

        let dep = tile.layer("DEPARE").unwrap();
        assert_eq!(dep.version, 2);
        assert_eq!(dep.extent, 4096);
        let f = &dep.features[0];
        assert_eq!(f.id, Some(7));
        assert_eq!(f.geom_type, GeomType::Polygon);
        assert_eq!(f.tags["DRVAL1"], TagValue::Double(2.5));
        assert_eq!(f.tags["OBJL"], TagValue::Int(-42));
        assert_eq!(f.tags["COLOUR"], TagValue::Str("3,4".into()));
        assert_eq!(f.tags["FLAG"], TagValue::Bool(true));
        assert_eq!(f.parts.len(), 2);
        assert_eq!(f.parts[0], vec![(0, 0), (100, 0), (100, 100), (0, 100)]);
        assert_eq!(f.parts[1], vec![(20, 20), (20, 40), (40, 40), (40, 20)]);

        let light = &tile.layer("LIGHTS").unwrap().features[0];
        assert_eq!(light.id, None);
        assert_eq!(light.geom_type, GeomType::Point);
        assert_eq!(light.parts, vec![vec![(2048, 2048)]]);
    }

    #[test]
    fn garbage_is_an_error_not_a_panic() {
        assert!(decode_tile(&[0x1a, 0xff]).is_err());
        assert!(decode_tile(&[0x0c]).is_err()); // wire type 4
    }

    /// Regression (finding #6): a length-delimited field whose declared
    /// length is near u64::MAX used to overflow `pos + len` and panic in
    /// debug builds instead of erroring.
    #[test]
    fn oversized_length_is_an_error_not_a_panic() {
        // field 3 (layers), wire type 2, length = u64::MAX
        let mut bytes = vec![0x1a];
        bytes.extend_from_slice(&[0xff; 9]);
        bytes.push(0x01);
        assert!(decode_tile(&bytes).is_err());
    }

    /// Plausible finding #8: repeated occurrences of packed fields must
    /// concatenate (per protobuf semantics), and packed fields are also
    /// valid unpacked as repeated wire-type-0 fields.
    #[test]
    fn packed_fields_concatenate_across_occurrences() {
        // layer: version=2, name="L", one feature
        let layer = |feature: &[u8]| -> Vec<u8> {
            let mut l = vec![0x78, 0x02]; // version = 2
            l.extend_from_slice(&[0x0a, 0x01, b'L']); // name = "L"
            l.push(0x12); // field 2: feature
            l.push(feature.len() as u8);
            l.extend_from_slice(feature);
            let mut tile = vec![0x1a, l.len() as u8];
            tile.extend_from_slice(&l);
            tile
        };
        // geometry (field 4) for a point at (5, 3): MoveTo cmd 9, dx 10, dy 6
        // -- split across two packed occurrences
        let split = layer(&[0x18, 0x01, 0x22, 0x01, 0x09, 0x22, 0x02, 0x0a, 0x06]);
        let tile = decode_tile(&split).unwrap();
        assert_eq!(tile.layers[0].features[0].parts, vec![vec![(5, 3)]]);
        // -- encoded unpacked, one varint field per value
        let unpacked = layer(&[0x18, 0x01, 0x20, 0x09, 0x20, 0x0a, 0x20, 0x06]);
        let tile = decode_tile(&unpacked).unwrap();
        assert_eq!(tile.layers[0].features[0].parts, vec![vec![(5, 3)]]);
    }
}
