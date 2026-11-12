// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only
//
// Ported from ochartsng's tools/senc/senc.py (GPLv2, Andreas Vogel):
// the plain-OSENC v201 record writer.

//! Synthetic OSENC writer: emits minimal valid plain-SENC streams as a test
//! fixture, so decoder/daemon/tiling paths are testable without o-charts
//! credentials — including shapes `senc.py` itself never emits, to cover
//! failure paths too.

use crate::coords::{lat_lon_to_world, sm_from_world, LLBox, WorldXy};

use super::records::rt;
use super::ServerStatus;

/// Builder for one OSENC byte stream.
#[derive(Default)]
pub struct SencWriter {
    buf: Vec<u8>,
}

/// One boundary tuple as written into line/area records.
#[derive(Debug, Clone, Copy)]
pub struct RawTuple {
    pub start_node: i32,
    pub edge: i32,
    pub end_node: i32,
    /// 0 = forward (stride 4); at stride 3 direction is the edge sign.
    pub direction: i32,
}

impl RawTuple {
    pub fn forward(edge: i32) -> RawTuple {
        RawTuple {
            start_node: -1,
            edge,
            end_node: -1,
            direction: 0,
        }
    }
    pub fn with_nodes(start_node: i32, edge: i32, end_node: i32) -> RawTuple {
        RawTuple {
            start_node,
            edge,
            end_node,
            direction: 0,
        }
    }
}

impl SencWriter {
    pub fn new() -> SencWriter {
        SencWriter::default()
    }

    /// Append one record: type, length (payload + 6-byte header), payload.
    pub fn record(&mut self, rtype: u16, payload: &[u8]) -> &mut Self {
        self.buf.extend_from_slice(&rtype.to_le_bytes());
        self.buf
            .extend_from_slice(&(payload.len() as u32 + 6).to_le_bytes());
        self.buf.extend_from_slice(payload);
        self
    }

    pub fn version(&mut self, v: u16) -> &mut Self {
        self.record(rt::HEADER_SENC_VERSION, &v.to_le_bytes())
    }

    pub fn cell_name(&mut self, name: &str) -> &mut Self {
        let mut p = name.as_bytes().to_vec();
        p.push(0);
        self.record(rt::HEADER_CELL_NAME, &p)
    }

    pub fn cell_edition(&mut self, e: u16) -> &mut Self {
        self.record(rt::HEADER_CELL_EDITION, &e.to_le_bytes())
    }

    pub fn cell_update(&mut self, u: u16) -> &mut Self {
        self.record(rt::HEADER_CELL_UPDATE, &u.to_le_bytes())
    }

    pub fn native_scale(&mut self, s: u32) -> &mut Self {
        self.record(rt::HEADER_CELL_NATIVESCALE, &s.to_le_bytes())
    }

    /// Cell extent record: sw, nw, ne, se corners from a lat/lon box.
    pub fn extent(&mut self, ll: &LLBox) -> &mut Self {
        let mut p = Vec::with_capacity(64);
        for (lat, lon) in [
            (ll.s_lat, ll.w_lon), // sw
            (ll.n_lat, ll.w_lon), // nw
            (ll.n_lat, ll.e_lon), // ne
            (ll.s_lat, ll.e_lon), // se
        ] {
            p.extend_from_slice(&lat.to_le_bytes());
            p.extend_from_slice(&lon.to_le_bytes());
        }
        self.record(rt::CELL_EXTENT, &p)
    }

    /// A `CELL_COVR` (charted) or `CELL_NOCOVR` (declared uncharted) ring:
    /// `u32 point_count` then `(f32 lat, f32 lon)` pairs. Callers pass a
    /// closed ring (first point repeated last), as real cells do.
    pub fn coverage_ring(&mut self, rtype: u16, ring: &[(f32, f32)]) -> &mut Self {
        let mut p = Vec::with_capacity(4 + 8 * ring.len());
        p.extend_from_slice(&(ring.len() as u32).to_le_bytes());
        for (lat, lon) in ring {
            p.extend_from_slice(&lat.to_le_bytes());
            p.extend_from_slice(&lon.to_le_bytes());
        }
        self.record(rtype, &p)
    }

    pub fn server_status(&mut self, s: ServerStatus) -> &mut Self {
        let mut p = Vec::with_capacity(12);
        for v in [
            s.server_status,
            s.decrypt_status,
            s.expire_status,
            s.expire_days_remaining,
            s.grace_days_allowed,
            s.grace_days_remaining,
        ] {
            p.extend_from_slice(&v.to_le_bytes());
        }
        self.record(rt::SERVER_STATUS, &p)
    }

    pub fn feature(&mut self, type_code: u16, id: u16, primitive: u8) -> &mut Self {
        let mut p = Vec::with_capacity(5);
        p.extend_from_slice(&type_code.to_le_bytes());
        p.extend_from_slice(&id.to_le_bytes());
        p.push(primitive);
        self.record(rt::FEATURE_ID, &p)
    }

    pub fn attr_int(&mut self, code: u16, v: u32) -> &mut Self {
        let mut p = attr_head(code, 0);
        p.extend_from_slice(&v.to_le_bytes());
        self.record(rt::FEATURE_ATTRIBUTE, &p)
    }

    pub fn attr_double(&mut self, code: u16, v: f64) -> &mut Self {
        let mut p = attr_head(code, 2);
        p.extend_from_slice(&v.to_le_bytes());
        self.record(rt::FEATURE_ATTRIBUTE, &p)
    }

    pub fn attr_str(&mut self, code: u16, v: &str) -> &mut Self {
        let mut p = attr_head(code, 4);
        p.extend_from_slice(v.as_bytes());
        p.push(0);
        self.record(rt::FEATURE_ATTRIBUTE, &p)
    }

    pub fn point_geometry(&mut self, lat: f64, lon: f64) -> &mut Self {
        let mut p = Vec::with_capacity(16);
        p.extend_from_slice(&lat.to_le_bytes());
        p.extend_from_slice(&lon.to_le_bytes());
        self.record(rt::GEOMETRY_POINT, &p)
    }

    /// Sounding multipoint: (east, north, depth) triples in SM meters.
    pub fn multipoint(&mut self, ext: &LLBox, soundings: &[(f32, f32, f32)]) -> &mut Self {
        let mut p = geo_extent(ext);
        p.extend_from_slice(&(soundings.len() as u32).to_le_bytes());
        for &(e, n, d) in soundings {
            p.extend_from_slice(&e.to_le_bytes());
            p.extend_from_slice(&n.to_le_bytes());
            p.extend_from_slice(&d.to_le_bytes());
        }
        self.record(rt::GEOMETRY_MULTIPOINT, &p)
    }

    /// Line geometry record from boundary tuples.
    pub fn line_geometry(&mut self, ext: &LLBox, tuples: &[RawTuple], stride: usize) -> &mut Self {
        let mut p = geo_extent(ext);
        p.extend_from_slice(&(tuples.len() as u32).to_le_bytes());
        put_tuples(&mut p, tuples, stride);
        self.record(rt::GEOMETRY_LINE, &p)
    }

    /// Area geometry record (82, or 84 with a scale factor). `triangles`
    /// are (tri_type, vertices) groups — the decoder skips them, but real
    /// streams carry them, so fixtures can too.
    pub fn area_geometry(
        &mut self,
        ext: &LLBox,
        triangles: &[(u8, Vec<(f32, f32)>)],
        tuples: &[RawTuple],
        stride: usize,
        scale: Option<f64>,
    ) -> &mut Self {
        let mut p = geo_extent(ext);
        p.extend_from_slice(&0u32.to_le_bytes()); // contour count (skipped)
        p.extend_from_slice(&(triangles.len() as u32).to_le_bytes());
        p.extend_from_slice(&(tuples.len() as u32).to_le_bytes());
        let rtype = match scale {
            Some(s) => {
                p.extend_from_slice(&s.to_le_bytes());
                rt::GEOMETRY_AREA_EXT
            }
            None => rt::GEOMETRY_AREA,
        };
        for (tri_type, verts) in triangles {
            p.push(*tri_type);
            p.extend_from_slice(&(verts.len() as u32).to_le_bytes());
            p.extend_from_slice(&[0u8; 32]); // per-group extent (skipped)
            for &(e, n) in verts {
                p.extend_from_slice(&e.to_le_bytes());
                p.extend_from_slice(&n.to_le_bytes());
            }
        }
        put_tuples(&mut p, tuples, stride);
        self.record(rtype, &p)
    }

    /// Edge-node table record (96, or 85 with a scale factor).
    pub fn edge_table(
        &mut self,
        entries: &[(i32, Vec<(f32, f32)>)],
        scale: Option<f64>,
    ) -> &mut Self {
        let mut p = Vec::new();
        let rtype = match scale {
            Some(s) => {
                p.extend_from_slice(&s.to_le_bytes());
                rt::EDGE_NODE_TABLE_EXT
            }
            None => rt::EDGE_NODE_TABLE,
        };
        p.extend_from_slice(&(entries.len() as i32).to_le_bytes());
        for (index, pts) in entries {
            p.extend_from_slice(&index.to_le_bytes());
            p.extend_from_slice(&(pts.len() as i32).to_le_bytes());
            for &(e, n) in pts {
                p.extend_from_slice(&e.to_le_bytes());
                p.extend_from_slice(&n.to_le_bytes());
            }
        }
        self.record(rtype, &p)
    }

    /// Connected-node table record (97, or 86 with a scale factor).
    pub fn node_table(&mut self, entries: &[(i32, (f32, f32))], scale: Option<f64>) -> &mut Self {
        let mut p = Vec::new();
        let rtype = match scale {
            Some(s) => {
                p.extend_from_slice(&s.to_le_bytes());
                rt::CONNECTED_NODE_TABLE_EXT
            }
            None => rt::CONNECTED_NODE_TABLE,
        };
        p.extend_from_slice(&(entries.len() as i32).to_le_bytes());
        for &(index, (e, n)) in entries {
            p.extend_from_slice(&index.to_le_bytes());
            p.extend_from_slice(&e.to_le_bytes());
            p.extend_from_slice(&n.to_le_bytes());
        }
        self.record(rtype, &p)
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.buf
    }
}

fn attr_head(code: u16, value_type: u8) -> Vec<u8> {
    let mut p = Vec::with_capacity(11);
    p.extend_from_slice(&code.to_le_bytes());
    p.push(value_type);
    p
}

/// Geometry-record extent block: s_lat, n_lat, w_lon, e_lon doubles.
fn geo_extent(ll: &LLBox) -> Vec<u8> {
    let mut p = Vec::with_capacity(32);
    for v in [ll.s_lat, ll.n_lat, ll.w_lon, ll.e_lon] {
        p.extend_from_slice(&v.to_le_bytes());
    }
    p
}

fn put_tuples(p: &mut Vec<u8>, tuples: &[RawTuple], stride: usize) {
    assert!(stride == 3 || stride == 4, "tuple stride is 3 or 4");
    for t in tuples {
        p.extend_from_slice(&t.start_node.to_le_bytes());
        // at stride 3 the direction rides on the edge index sign
        let edge = if stride == 3 && t.direction != 0 {
            -t.edge
        } else {
            t.edge
        };
        p.extend_from_slice(&edge.to_le_bytes());
        p.extend_from_slice(&t.end_node.to_le_bytes());
        if stride == 4 {
            p.extend_from_slice(&t.direction.to_le_bytes());
        }
    }
}

/// The SM reference point the decoder will derive from a cell extent
/// record: the world point of the nw/se midpoint.
pub fn reference_point(ll: &LLBox) -> WorldXy {
    let mid = ll.midpoint();
    lat_lon_to_world(mid.y, mid.x)
}

/// lat/lon → float32 SM easting/northing relative to the cell reference
/// point, optionally pre-multiplied by an EXT scale factor (the decoder
/// divides it back out).
pub fn sm(lat: f64, lon: f64, ref_point: WorldXy, scale: f64) -> (f32, f32) {
    let (e, n) = sm_from_world(lat_lon_to_world(lat, lon), ref_point);
    ((e * scale) as f32, (n * scale) as f32)
}
