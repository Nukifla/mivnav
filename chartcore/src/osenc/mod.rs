// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only
//
// Ported from ochartsng's OESUChart.cpp / Osenc.h record schema
// (GPLv2, Andreas Vogel; in turn derived from OpenCPN's Osenc).

//! OSENC decoder: the o-charts SENC record stream → the normalized
//! [`crate::model`] feature model. Format notes, reference-bug fixups, and
//! the `CELL_COVR` reverse-engineering: see
//! docs/architecture/osenc-record-format.md.

mod assemble;
mod catalog;
mod records;
pub mod write;

use std::collections::BTreeMap;
use std::fmt;
use std::io::{self, Read};

use crate::coords::{lat_lon_to_world, Extent, LLBox, WorldXy};
use crate::coverage::Coverage;
use crate::model::{AttrValue, Cell, CellMeta, Feature, Geometry, PointZ};
use assemble::{LineIndex, VectorTables};
use catalog::AttrType;
use records::{rt, Payload, Record, RecordReader};

/// The license verdict record (type 200) as delivered by `oexserverd`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ServerStatus {
    pub server_status: u16,
    /// 0 → invalid key / fingerprint not registered.
    pub decrypt_status: u16,
    /// 0 → chart expired.
    pub expire_status: u16,
    pub expire_days_remaining: u16,
    pub grace_days_allowed: u16,
    pub grace_days_remaining: u16,
}

/// Errors from decoding an OSENC stream.
#[derive(Debug)]
pub enum OsencError {
    Io(io::Error),
    /// Structurally invalid stream.
    Format(String),
    /// SENC version outside 200-299 (1024 is the E3 on-disk format).
    Version(u16),
    /// Daemon license verdict: invalid key or unregistered fingerprint.
    Decrypt(ServerStatus),
    /// Daemon license verdict: chart expired.
    Expired(ServerStatus),
    /// A required header record never appeared (header-only reads).
    MissingRecord(&'static str),
}

impl fmt::Display for OsencError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OsencError::Io(e) => write!(f, "I/O error: {e}"),
            OsencError::Format(m) => write!(f, "invalid OSENC stream: {m}"),
            OsencError::Version(v) => write!(f, "unsupported SENC version {v}"),
            OsencError::Decrypt(_) => {
                write!(
                    f,
                    "decrypt refused: invalid key or unregistered system fingerprint"
                )
            }
            OsencError::Expired(s) => {
                write!(
                    f,
                    "chart expired (grace {}/{} days)",
                    s.grace_days_remaining, s.grace_days_allowed
                )
            }
            OsencError::MissingRecord(m) => write!(f, "missing required record: {m}"),
        }
    }
}

impl std::error::Error for OsencError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            OsencError::Io(e) => Some(e),
            _ => None,
        }
    }
}

impl From<io::Error> for OsencError {
    fn from(e: io::Error) -> Self {
        OsencError::Io(e)
    }
}

/// Cell identification from a header-only read.
#[derive(Debug, Clone, PartialEq)]
pub struct CellHeader {
    pub meta: CellMeta,
    /// Declared cell extent (CELL_EXTENT record), in degrees.
    pub extent: LLBox,
    /// True data coverage from the `CELL_COVR`/`CELL_NOCOVR` records — same
    /// fact as [`crate::coverage::cell_coverage`], without decoding the
    /// cell. `None` falls back to [`extent`](Self::extent), as for a cell
    /// with no usable M_COVR.
    pub coverage: Option<Coverage>,
}

/// Read a full OSENC stream into the normalized feature model.
pub fn read_cell<R: Read>(input: R) -> Result<Cell, OsencError> {
    let mut d = Decoder::default();
    d.run(input, false)?;
    d.into_cell()
}

/// Stops as soon as the required header records have been seen; errors
/// with [`OsencError::MissingRecord`] if the stream ends first. Non-header
/// payloads are skipped but still consumed, so this works on a daemon
/// stream as well as a file.
pub fn read_header<R: Read>(input: R) -> Result<CellHeader, OsencError> {
    let mut d = Decoder::default();
    d.run(input, true)?;
    let extent = d.extent.ok_or(OsencError::MissingRecord("cell extent"))?;
    if d.version.is_none() {
        return Err(OsencError::MissingRecord("SENC version"));
    }
    if !d.name_seen {
        return Err(OsencError::MissingRecord("cell name"));
    }
    if d.meta.compilation_scale == 0 {
        return Err(OsencError::MissingRecord("native scale"));
    }
    if !d.edition_seen {
        return Err(OsencError::MissingRecord("cell edition"));
    }
    Ok(CellHeader {
        meta: d.meta,
        extent,
        coverage: Coverage::from_rings(d.covr, d.nocovr),
    })
}

/// Feature geometry while records are still streaming in — line/area
/// topology can only be resolved once the vector tables are complete.
enum PendingGeom {
    None,
    Point(WorldXy),
    Soundings(Vec<PointZ>),
    Line(Vec<LineIndex>),
    Area(Vec<LineIndex>),
}

struct PendingFeature {
    type_code: u16,
    feature_id: u16,
    attributes: BTreeMap<String, AttrValue>,
    geom: PendingGeom,
}

#[derive(Default)]
struct Decoder {
    meta: CellMeta,
    /// Real `oexserverd` streams carry an *empty* CELL_NAME record —
    /// completeness tracks the record's presence, not its content.
    name_seen: bool,
    edition_seen: bool,
    version: Option<u16>,
    /// Declared cell extent; its nw/se midpoint is the SM reference point.
    extent: Option<LLBox>,
    ref_point: Option<WorldXy>,
    tables: VectorTables,
    features: Vec<PendingFeature>,
    current: Option<PendingFeature>,
    /// CELL_COVR (98) rings — areas the cell charts.
    covr: Vec<Vec<WorldXy>>,
    /// CELL_NOCOVR (99) rings — areas it declares uncharted.
    nocovr: Vec<Vec<WorldXy>>,
    /// Set once a FEATURE_ID record is seen: the coverage block precedes
    /// every feature, so this is where a header-only read may stop.
    feature_seen: bool,
}

impl Decoder {
    fn above_v200(&self) -> bool {
        self.version.is_some_and(|v| v > 200)
    }

    fn stride(&self) -> usize {
        if self.above_v200() {
            4
        } else {
            3
        }
    }

    fn ref_point(&self) -> Result<WorldXy, OsencError> {
        self.ref_point
            .ok_or_else(|| OsencError::Format("geometry record before cell extent record".into()))
    }

    fn run<R: Read>(&mut self, input: R, header_only: bool) -> Result<(), OsencError> {
        let mut reader = RecordReader::new(input);
        while let Some(record) = reader.next_record()? {
            self.record(&record, header_only)?;
            if header_only && self.header_complete() {
                return Ok(());
            }
        }
        Ok(())
    }

    /// Done once the identification records are in **and** the coverage
    /// block (which sits between CELL_EXTENT and the first FEATURE_ID) has
    /// been passed — see docs/architecture/osenc-record-format.md.
    fn header_complete(&self) -> bool {
        self.version.is_some()
            && self.name_seen
            && self.edition_seen
            && self.meta.compilation_scale != 0
            && self.extent.is_some()
            && self.feature_seen
    }

    fn record(&mut self, record: &Record, header_only: bool) -> Result<(), OsencError> {
        let mut p = Payload::new(record);
        // header-only mode: only header records, the coverage block, and
        // the license verdict are parsed; everything else is skipped.
        if header_only
            && !matches!(
                record.rtype,
                rt::HEADER_SENC_VERSION
                    | rt::HEADER_CELL_NAME
                    | rt::HEADER_CELL_EDITION
                    | rt::HEADER_CELL_NATIVESCALE
                    | rt::CELL_EXTENT
                    | rt::CELL_COVR
                    | rt::CELL_NOCOVR
                    | rt::FEATURE_ID
                    | rt::SERVER_STATUS
            )
        {
            return Ok(());
        }
        match record.rtype {
            rt::SERVER_STATUS => {
                let status = ServerStatus {
                    server_status: p.u16("server status")?,
                    decrypt_status: p.u16("decrypt status")?,
                    expire_status: p.u16("expire status")?,
                    expire_days_remaining: p.u16("expire days")?,
                    grace_days_allowed: p.u16("grace allowed")?,
                    grace_days_remaining: p.u16("grace remaining")?,
                };
                if status.decrypt_status == 0 {
                    return Err(OsencError::Decrypt(status));
                }
                if status.expire_status == 0 {
                    return Err(OsencError::Expired(status));
                }
            }
            rt::HEADER_SENC_VERSION => {
                let v = p.u16("version")?;
                if !(200..=299).contains(&v) {
                    return Err(OsencError::Version(v));
                }
                self.version = Some(v);
            }
            rt::HEADER_CELL_NAME => {
                self.meta.name = p.rest_str();
                self.name_seen = true;
            }
            rt::HEADER_CELL_EDITION => {
                self.meta.edition = p.u16("edition")?.into();
                self.edition_seen = true;
            }
            rt::HEADER_CELL_UPDATE => self.meta.update = p.u16("update")?.into(),
            rt::HEADER_CELL_NATIVESCALE => {
                let scale = p.u32("native scale")?;
                if scale == 0 {
                    return Err(OsencError::Format("invalid native scale 0".into()));
                }
                self.meta.compilation_scale = scale;
            }
            // informational strings the model has no fields for
            rt::HEADER_CELL_PUBLISHDATE
            | rt::HEADER_CELL_UPDATEDATE
            | rt::HEADER_CELL_SENCCREATEDATE
            | rt::HEADER_CELL_SOUNDINGDATUM => {}
            rt::CELL_EXTENT => {
                // sw, nw, ne, se lat/lon doubles; only nw and se are used
                p.skip(16, "sw corner")?;
                let nw_lat = p.f64("nw lat")?;
                let nw_lon = p.f64("nw lon")?;
                p.skip(16, "ne corner")?;
                let se_lat = p.f64("se lat")?;
                let se_lon = p.f64("se lon")?;
                let ll = LLBox {
                    n_lat: nw_lat,
                    s_lat: se_lat,
                    w_lon: nw_lon,
                    e_lon: se_lon,
                };
                let mid = ll.midpoint();
                self.ref_point = Some(lat_lon_to_world(mid.y, mid.x));
                self.extent = Some(ll);
            }
            rt::FEATURE_ID => {
                // the coverage block is behind us; a header-only read is done
                self.feature_seen = true;
                if header_only {
                    return Ok(());
                }
                let type_code = p.u16("feature type code")?;
                let feature_id = p.u16("feature id")?;
                let _primitive = p.u8("feature primitive")?;
                self.finish_feature();
                self.current = Some(PendingFeature {
                    type_code,
                    feature_id,
                    attributes: BTreeMap::new(),
                    geom: PendingGeom::None,
                });
            }
            rt::FEATURE_ATTRIBUTE => {
                let code = p.u16("attribute code")?;
                let value_type = p.u8("attribute value type")?;
                let Some(current) = self.current.as_mut() else {
                    return Ok(());
                };
                // outside the catalogue: dropped, like the reference
                let Some(info) = catalog::attribute(code) else {
                    return Ok(());
                };
                let value = match value_type {
                    0 => AttrValue::Int(p.u32("int attribute")?.into()),
                    2 => AttrValue::Float(p.f64("float attribute")?),
                    4 => {
                        let s = p.rest_str();
                        if info.ty == AttrType::List {
                            // matches the GDAL S-57 path's string lists
                            AttrValue::StrList(
                                s.split(',')
                                    .map(str::trim)
                                    .filter(|v| !v.is_empty())
                                    .map(String::from)
                                    .collect(),
                            )
                        } else {
                            AttrValue::Str(s)
                        }
                    }
                    _ => return Ok(()), // unknown value type: skip, like the reference
                };
                current.attributes.insert(info.acronym.to_string(), value);
            }
            rt::GEOMETRY_POINT => {
                let lat = p.f64("point lat")?;
                let lon = p.f64("point lon")?;
                if let Some(current) = self.current.as_mut() {
                    current.geom = PendingGeom::Point(lat_lon_to_world(lat, lon));
                }
            }
            rt::GEOMETRY_MULTIPOINT => {
                if self.current.is_none() {
                    return Ok(());
                }
                let rp = self.ref_point()?;
                p.skip(32, "multipoint extent")?;
                let count = p.u32("point count")?;
                let mut points = Vec::with_capacity(count.min(1 << 20) as usize);
                for _ in 0..count {
                    let e = p.f32("sounding east")?;
                    let n = p.f32("sounding north")?;
                    let depth = p.f32("sounding depth")?;
                    points.push(PointZ {
                        pos: crate::coords::world_from_sm(e as f64, n as f64, rp),
                        z: depth as f64,
                    });
                }
                if !points.is_empty() {
                    self.current.as_mut().unwrap().geom = PendingGeom::Soundings(points);
                }
            }
            rt::GEOMETRY_LINE => {
                if self.current.is_none() {
                    return Ok(());
                }
                self.ref_point()?;
                p.skip(32, "line extent")?;
                let tuples = self.line_tuples(&mut p)?;
                self.current.as_mut().unwrap().geom = PendingGeom::Line(tuples);
            }
            rt::GEOMETRY_AREA | rt::GEOMETRY_AREA_EXT => {
                if self.current.is_none() {
                    return Ok(());
                }
                self.ref_point()?;
                p.skip(32, "area extent")?;
                let contour_count = p.u32("contour count")?;
                let triprim_count = p.u32("triprim count")?;
                let edge_vector_count = p.u32("edge vector count")?;
                if record.rtype == rt::GEOMETRY_AREA_EXT {
                    // applies to the (dropped) triangle vertices only
                    p.f64("area scale factor")?;
                }
                // pre-tessellated triangles: dropped — MapLibre tessellates
                // client-side; the boundary tuples carry the real rings
                p.skip(4 * contour_count as usize, "contour counts")?;
                for _ in 0..triprim_count {
                    let _tri_type = p.u8("triprim type")?;
                    let n = p.u32("triprim vertex count")?;
                    p.skip(32, "triprim extent")?;
                    p.skip(8 * n as usize, "triprim vertices")?;
                }
                let mut tuples = Vec::with_capacity(edge_vector_count.min(1 << 20) as usize);
                for _ in 0..edge_vector_count {
                    tuples.push(self.one_tuple(&mut p)?);
                }
                if let PendingGeom::Area(existing) = &mut self.current.as_mut().unwrap().geom {
                    existing.extend(tuples);
                } else {
                    self.current.as_mut().unwrap().geom = PendingGeom::Area(tuples);
                }
            }
            rt::EDGE_NODE_TABLE | rt::EDGE_NODE_TABLE_EXT => {
                let rp = self.ref_point()?;
                let scale = if record.rtype == rt::EDGE_NODE_TABLE_EXT {
                    // reference bug (OESUChart.cpp:575): computed but never
                    // applied there; applied here
                    scale_factor(p.f64("edge table scale factor")?)
                } else {
                    1.0
                };
                let entries = p.i32("edge table entry count")?;
                for _ in 0..entries.max(0) {
                    let index = p.i32("edge index")?;
                    let count = p.i32("edge point count")?;
                    let mut pts = Vec::with_capacity(count.clamp(0, 1 << 20) as usize);
                    for _ in 0..count.max(0) {
                        let e = p.f32("edge east")?;
                        let n = p.f32("edge north")?;
                        pts.push(crate::coords::world_from_sm(
                            e as f64 / scale,
                            n as f64 / scale,
                            rp,
                        ));
                    }
                    if index >= 0 {
                        self.tables.edges.insert(index, pts);
                    }
                }
            }
            rt::CONNECTED_NODE_TABLE | rt::CONNECTED_NODE_TABLE_EXT => {
                let rp = self.ref_point()?;
                let scale = if record.rtype == rt::CONNECTED_NODE_TABLE_EXT {
                    scale_factor(p.f64("node table scale factor")?)
                } else {
                    1.0
                };
                let entries = p.i32("node table entry count")?;
                for _ in 0..entries.max(0) {
                    let index = p.i32("node index")?;
                    let e = p.f32("node east")?;
                    let n = p.f32("node north")?;
                    if index >= 0 {
                        self.tables.nodes.insert(
                            index,
                            crate::coords::world_from_sm(e as f64 / scale, n as f64 / scale, rp),
                        );
                    }
                }
            }
            rt::CELL_COVR | rt::CELL_NOCOVR => {
                let ring = self.covr_ring(&mut p)?;
                if record.rtype == rt::CELL_COVR {
                    self.covr.push(ring);
                } else {
                    self.nocovr.push(ring);
                }
            }
            rt::CELL_TXTDSC_INFO_FILE => {}
            _ => {}
        }
        Ok(())
    }

    /// One `CELL_COVR`/`CELL_NOCOVR` ring: `u32 count`, then that many
    /// absolute `(f32 lat, f32 lon)` pairs, already closed. Layout is
    /// reverse-engineered, not ported — see
    /// docs/architecture/osenc-record-format.md.
    fn covr_ring(&self, p: &mut Payload) -> Result<Vec<WorldXy>, OsencError> {
        let n = p.u32("coverage point count")? as usize;
        // a length mismatch means the layout assumption is wrong for this
        // producer — error instead of silently truncating a ring
        let expect = 8 * n;
        if p.remaining() != expect {
            return Err(OsencError::Format(format!(
                "coverage ring: {n} points implies {expect} bytes of vertices, got {}",
                p.remaining()
            )));
        }
        let mut ring = Vec::with_capacity(n.min(1 << 20));
        for _ in 0..n {
            let lat = p.f32("coverage lat")? as f64;
            let lon = p.f32("coverage lon")? as f64;
            ring.push(lat_lon_to_world(lat, lon));
        }
        Ok(ring)
    }

    fn one_tuple(&self, p: &mut Payload) -> Result<LineIndex, OsencError> {
        let mut vals = [0i32; 4];
        for v in vals.iter_mut().take(self.stride()) {
            *v = p.i32("line index tuple")?;
        }
        Ok(LineIndex::parse(&vals[..self.stride()], self.above_v200()))
    }

    fn line_tuples(&self, p: &mut Payload) -> Result<Vec<LineIndex>, OsencError> {
        let count = p.u32("edge vector count")?;
        let mut tuples = Vec::with_capacity(count.min(1 << 20) as usize);
        for _ in 0..count {
            tuples.push(self.one_tuple(p)?);
        }
        Ok(tuples)
    }

    fn finish_feature(&mut self) {
        if let Some(f) = self.current.take() {
            self.features.push(f);
        }
    }

    fn into_cell(mut self) -> Result<Cell, OsencError> {
        self.finish_feature();
        let mut features = Vec::with_capacity(self.features.len());
        let mut extent = Extent::invalid();
        for pf in &self.features {
            let geometry = match &pf.geom {
                PendingGeom::None => None,
                PendingGeom::Point(p) => Some(Geometry::Point(*p)),
                PendingGeom::Soundings(pts) => Some(Geometry::MultiPoint(pts.clone())),
                PendingGeom::Line(tuples) => {
                    let lines = self.tables.assemble_lines(tuples);
                    (!lines.is_empty()).then_some(Geometry::Lines(lines))
                }
                PendingGeom::Area(tuples) => {
                    let polys = self.tables.assemble_areas(tuples);
                    (!polys.is_empty()).then_some(Geometry::Areas(polys))
                }
            };
            let acronym = catalog::class_acronym(pf.type_code)
                .map(String::from)
                // keep unknown classes visible instead of silently dropping
                // features; "OBJL<code>" stays outside the acronym namespace
                .unwrap_or_else(|| format!("OBJL{}", pf.type_code));
            let mut feature = Feature::new(pf.type_code, acronym, pf.attributes.clone(), geometry);
            feature.rcid = Some(pf.feature_id.into());
            extent.extend(&feature.extent);
            features.push(feature);
        }
        Ok(Cell {
            meta: self.meta,
            features,
            extent,
        })
    }
}

/// EXT-record scale factor: values below 1e-5 in magnitude mean "no scale".
fn scale_factor(s: f64) -> f64 {
    if s.abs() < 1e-5 {
        1.0
    } else {
        s
    }
}

#[cfg(test)]
mod tests;
