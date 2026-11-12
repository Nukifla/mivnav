// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! PMTiles v3 archive writer and reader.
//!
//! Hand-rolled against the spec (github.com/protomaps/PMTiles, spec v3)
//! rather than depending on the `pmtiles` crate and its async/tokio feature
//! surface. The reader loads the whole archive into memory, which is fine
//! for the cell-sized archives built today.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;

use crate::coords::LLBox;
use crate::mvt::TileKey;
use crate::varint::{read_varint, write_varint};

pub const COMPRESSION_NONE: u8 = 1;
pub const COMPRESSION_GZIP: u8 = 2;
pub const TILE_TYPE_MVT: u8 = 1;
// Raster tile-type ids (spec §3's `tile_type` byte), matching the Python
// reader's `TILE_TYPE_*` constants (mivnav.charts.pmtiles); opaque to the
// writer itself.
pub const TILE_TYPE_PNG: u8 = 2;
pub const TILE_TYPE_JPEG: u8 = 3;
pub const TILE_TYPE_WEBP: u8 = 4;

const MAGIC: &[u8; 7] = b"PMTiles";
const FORMAT_VERSION: u8 = 3;
const HEADER_LEN: usize = 127;
/// Entries per directory before spilling to leaves (keeps the root under
/// the spec's 16 KiB guidance).
const MAX_DIR_ENTRIES: usize = 4096;

/// Errors from reading a PMTiles archive.
#[derive(Debug)]
pub enum PmtilesError {
    Io(io::Error),
    /// Structurally invalid archive.
    Format(String),
}

impl fmt::Display for PmtilesError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PmtilesError::Io(e) => write!(f, "I/O error: {e}"),
            PmtilesError::Format(m) => write!(f, "invalid PMTiles archive: {m}"),
        }
    }
}

impl std::error::Error for PmtilesError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            PmtilesError::Io(e) => Some(e),
            _ => None,
        }
    }
}

impl From<io::Error> for PmtilesError {
    fn from(e: io::Error) -> Self {
        PmtilesError::Io(e)
    }
}

fn format_err(m: impl Into<String>) -> PmtilesError {
    PmtilesError::Format(m.into())
}

/// Hilbert-curve tile id per the PMTiles spec (port of pmtiles python's
/// `zxy_to_tileid`). Intermediate coordinates legitimately go negative
/// during the quadrant rotation, so this must run on signed integers.
pub fn tile_id(z: u8, x: u32, y: u32) -> u64 {
    debug_assert!(z < 32 && (z == 0 || (x < (1 << z) && y < (1 << z))));
    let base = ((1u64 << (2 * z as u64)) - 1) / 3; // sum of 4^i, i < z
    let (mut tx, mut ty) = (x as i64, y as i64);
    let mut d = 0u64;
    let mut a = z as i32 - 1;
    while a >= 0 {
        let s = 1i64 << a;
        let rx = tx & s;
        let ry = ty & s;
        d += (((3 * rx) ^ ry) << a) as u64;
        if ry == 0 {
            if rx != 0 {
                tx = s - 1 - tx;
                ty = s - 1 - ty;
            }
            std::mem::swap(&mut tx, &mut ty);
        }
        a -= 1;
    }
    base + d
}

/// One directory entry. `run_length` 0 marks a leaf-directory pointer
/// (offset/length within the leaf section); otherwise offsets/lengths are
/// within the tile-data section.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Entry {
    pub tile_id: u64,
    pub offset: u64,
    pub length: u32,
    pub run_length: u32,
}

fn serialize_directory(entries: &[Entry]) -> Vec<u8> {
    let mut buf = Vec::new();
    write_varint(&mut buf, entries.len() as u64);
    let mut prev_id = 0u64;
    for e in entries {
        write_varint(&mut buf, e.tile_id - prev_id);
        prev_id = e.tile_id;
    }
    for e in entries {
        write_varint(&mut buf, e.run_length as u64);
    }
    for e in entries {
        write_varint(&mut buf, e.length as u64);
    }
    let mut prev_end = None;
    for e in entries {
        // varint 0 means "previous entry's offset + length", except at index
        // 0: reference readers decode a leading 0 as an invalid offset of -1.
        if prev_end == Some(e.offset) {
            write_varint(&mut buf, 0);
        } else {
            write_varint(&mut buf, e.offset + 1);
        }
        prev_end = Some(e.offset + e.length as u64);
    }
    buf
}

fn deserialize_directory(data: &[u8]) -> Result<Vec<Entry>, PmtilesError> {
    let mut pos = 0;
    let mut next = |what: &str| read_varint(data, &mut pos).ok_or_else(|| format_err(what));
    let count = next("directory count")? as usize;
    let mut entries = vec![
        Entry {
            tile_id: 0,
            offset: 0,
            length: 0,
            run_length: 0
        };
        count
    ];
    let mut id = 0u64;
    for e in entries.iter_mut() {
        // checked: directory bytes are untrusted, a corrupt archive must
        // error rather than panic
        id = id
            .checked_add(next("tile id delta")?)
            .ok_or_else(|| format_err("tile id overflow"))?;
        e.tile_id = id;
    }
    for e in entries.iter_mut() {
        e.run_length = next("run length")? as u32;
    }
    for e in entries.iter_mut() {
        e.length = next("length")? as u32;
    }
    let mut prev_end = None;
    for e in entries.iter_mut() {
        let v = next("offset")?;
        e.offset = match (v, prev_end) {
            (0, Some(end)) => end,
            (0, None) => return Err(format_err("varint-0 offset on first entry")),
            (v, _) => v - 1,
        };
        prev_end = Some(
            e.offset
                .checked_add(e.length as u64)
                .ok_or_else(|| format_err("entry offset overflow"))?,
        );
    }
    if pos != data.len() {
        return Err(format_err("trailing bytes after directory"));
    }
    Ok(entries)
}

fn gzip(data: &[u8]) -> Vec<u8> {
    let mut enc = GzEncoder::new(Vec::new(), Compression::new(6));
    enc.write_all(data).expect("in-memory gzip");
    enc.finish().expect("in-memory gzip")
}

fn gunzip(data: &[u8]) -> io::Result<Vec<u8>> {
    let mut out = Vec::new();
    GzDecoder::new(data).read_to_end(&mut out)?;
    Ok(out)
}

/// Archive-level metadata for the writer.
#[derive(Debug, Clone)]
pub struct ArchiveInfo {
    /// Human-readable name (goes into the JSON metadata).
    pub name: String,
    pub bounds: LLBox,
    pub min_zoom: u8,
    pub max_zoom: u8,
    /// Vector layer ids, for the `vector_layers` metadata MapLibre wants.
    pub layers: Vec<String>,
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

impl ArchiveInfo {
    fn metadata_json(&self) -> String {
        let layers = self
            .layers
            .iter()
            .map(|l| {
                format!(
                    "{{\"id\":\"{}\",\"minzoom\":{},\"maxzoom\":{},\"fields\":{{}}}}",
                    json_escape(l),
                    self.min_zoom,
                    self.max_zoom
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        format!(
            "{{\"name\":\"{}\",\"format\":\"pbf\",\"vector_layers\":[{}]}}",
            json_escape(&self.name),
            layers
        )
    }
}

/// Write a PMTiles v3 archive of raw (uncompressed) MVT tile blobs.
pub fn write_archive<W: Write>(
    mut w: W,
    tiles: &BTreeMap<TileKey, Vec<u8>>,
    info: &ArchiveInfo,
) -> io::Result<()> {
    let by_id: BTreeMap<u64, &Vec<u8>> = tiles
        .iter()
        .map(|((z, x, y), data)| (tile_id(*z, *x, *y), data))
        .collect();
    let mut data = Vec::new();
    let mut dedup: HashMap<&[u8], (u64, u32)> = HashMap::new();
    let mut entries = Vec::with_capacity(by_id.len());
    let mut contents = 0u64;
    for (id, raw) in &by_id {
        let (offset, length) = match dedup.get(raw.as_slice()) {
            Some(v) => *v,
            None => {
                let compressed = gzip(raw);
                let v = (data.len() as u64, compressed.len() as u32);
                data.extend_from_slice(&compressed);
                dedup.insert(raw.as_slice(), v);
                contents += 1;
                v
            }
        };
        entries.push(Entry {
            tile_id: *id,
            offset,
            length,
            run_length: 1,
        });
    }

    let (root, leaves) = if entries.len() <= MAX_DIR_ENTRIES {
        (gzip(&serialize_directory(&entries)), Vec::new())
    } else {
        let mut leaves = Vec::new();
        let mut root_entries = Vec::new();
        for chunk in entries.chunks(MAX_DIR_ENTRIES) {
            let leaf = gzip(&serialize_directory(chunk));
            root_entries.push(Entry {
                tile_id: chunk[0].tile_id,
                offset: leaves.len() as u64,
                length: leaf.len() as u32,
                run_length: 0,
            });
            leaves.extend_from_slice(&leaf);
        }
        (gzip(&serialize_directory(&root_entries)), leaves)
    };
    let metadata = gzip(info.metadata_json().as_bytes());

    let root_offset = HEADER_LEN as u64;
    let metadata_offset = root_offset + root.len() as u64;
    let leaf_offset = metadata_offset + metadata.len() as u64;
    let data_offset = leaf_offset + leaves.len() as u64;

    let mut header = Vec::with_capacity(HEADER_LEN);
    header.extend_from_slice(MAGIC);
    header.push(FORMAT_VERSION);
    for v in [
        root_offset,
        root.len() as u64,
        metadata_offset,
        metadata.len() as u64,
        leaf_offset,
        leaves.len() as u64,
        data_offset,
        data.len() as u64,
        by_id.len() as u64, // addressed tiles
        entries.len() as u64,
        contents,
    ] {
        header.extend_from_slice(&v.to_le_bytes());
    }
    header.push(1); // clustered
    header.push(COMPRESSION_GZIP); // internal compression
    header.push(COMPRESSION_GZIP); // tile compression
    header.push(TILE_TYPE_MVT);
    header.push(info.min_zoom);
    header.push(info.max_zoom);
    let e7 = |v: f64| ((v * 1e7).round() as i32).to_le_bytes();
    header.extend_from_slice(&e7(info.bounds.w_lon)); // min lon
    header.extend_from_slice(&e7(info.bounds.s_lat)); // min lat
    header.extend_from_slice(&e7(info.bounds.e_lon)); // max lon
    header.extend_from_slice(&e7(info.bounds.n_lat)); // max lat
    header.push(info.min_zoom + (info.max_zoom - info.min_zoom) / 2); // center zoom
    let center = info.bounds.midpoint();
    header.extend_from_slice(&e7(center.x)); // center lon
    header.extend_from_slice(&e7(center.y)); // center lat
    debug_assert_eq!(header.len(), HEADER_LEN);

    w.write_all(&header)?;
    w.write_all(&root)?;
    w.write_all(&metadata)?;
    w.write_all(&leaves)?;
    w.write_all(&data)?;
    Ok(())
}

/// Write an archive to `path` atomically (temp file + rename): a concurrent
/// reader with the old file mmapped (the backend does) keeps the old inode
/// intact. Writing in place would yank pages out from under it — a page
/// access past the new EOF is a SIGBUS.
pub fn write_archive_to_path(
    path: &Path,
    tiles: &BTreeMap<TileKey, Vec<u8>>,
    info: &ArchiveInfo,
) -> io::Result<()> {
    let file_name = path.file_name().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "output path has no file name")
    })?;
    let mut tmp = PathBuf::from(path);
    // same directory: a cross-filesystem rename would not be atomic
    tmp.set_file_name(format!(
        ".{}.tmp.{}",
        file_name.to_string_lossy(),
        std::process::id()
    ));
    let result = (|| {
        let mut w = io::BufWriter::new(std::fs::File::create(&tmp)?);
        write_archive(&mut w, tiles, info)?;
        // sync before the rename: a reader must never open a
        // complete-looking but unwritten file
        w.into_inner()
            .map_err(io::IntoInnerError::into_error)?
            .sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// One raster tile from the caller's fetch/generator: an XYZ address plus
/// its already-encoded bytes (JPEG/PNG/WEBP — opaque to this writer).
pub type RasterTile = (u8, u32, u32, Vec<u8>);

/// Archive-level metadata for a raster write. Distinct from [`ArchiveInfo`]:
/// no vector layers, JSON metadata carries `tile_type`/`format` instead.
#[derive(Debug, Clone)]
pub struct RasterArchiveInfo {
    pub name: String,
    pub bounds: LLBox,
    pub min_zoom: u8,
    pub max_zoom: u8,
    /// PMTiles `tile_type` header byte (Python reader's `TILE_TYPE_*`).
    pub tile_type: u8,
    /// `"jpg"`/`"png"` etc, recorded in metadata's `format` key so a
    /// consumer can name the format without sniffing the bytes.
    pub tile_format: String,
}

impl RasterArchiveInfo {
    fn metadata_json(&self) -> String {
        // no `vector_layers` key: its absence is how a consumer tells
        // raster from vector metadata
        format!(
            "{{\"name\":\"{}\",\"format\":\"{}\",\"tile_type\":{}}}",
            json_escape(&self.name),
            json_escape(&self.tile_format),
            self.tile_type
        )
    }
}

/// Non-cryptographic dedup bucket key — collisions are resolved by a full
/// byte compare in [`finish_raster_archive`], so hash quality affects only
/// performance. FNV-1a keeps this dependency-free (no crypto digest needed).
fn content_hash(data: &[u8]) -> u64 {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut h = OFFSET;
    for &b in data {
        h ^= b as u64;
        h = h.wrapping_mul(PRIME);
    }
    h
}

/// RAII guard that removes a path on drop, so an early `?` return still
/// cleans up ephemeral intermediate files.
struct ScopedTemp(PathBuf);

impl Drop for ScopedTemp {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Per-tile spool bookkeeping produced by [`spool_raster_tiles`]:
/// `(tile_id, spool_offset, length)`, sorted by `tile_id`. Tile content
/// stays on disk in the spool file — this is the only thing a multi-GB bake holds in RAM.
pub struct SpooledRasterTiles {
    spool_path: PathBuf,
    metas: Vec<(u64, u64, u32)>,
}

impl Drop for SpooledRasterTiles {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.spool_path);
    }
}

/// Stream `tiles` to a spool file, one tile resident in RAM at a time (a
/// regional bake can be 2-4 GB). Split from [`finish_raster_archive`] so a
/// GIL-bound caller (see `python::build_raster_pmtiles`) can release it first.
pub fn spool_raster_tiles<I>(out_path: &Path, tiles: I) -> io::Result<SpooledRasterTiles>
where
    I: Iterator<Item = io::Result<RasterTile>>,
{
    let dir = out_path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;
    let file_name = out_path.file_name().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "output path has no file name")
    })?;
    let spool_path = dir.join(format!(
        ".{}.spool.{}",
        file_name.to_string_lossy(),
        std::process::id()
    ));

    let mut metas: Vec<(u64, u64, u32)> = Vec::new();
    let mut seen_ids: HashSet<u64> = HashSet::new();
    let result = (|| -> io::Result<()> {
        let mut spool = io::BufWriter::new(std::fs::File::create(&spool_path)?);
        let mut offset = 0u64;
        for item in tiles {
            let (z, x, y, data) = item?;
            let tid = tile_id(z, x, y);
            if !seen_ids.insert(tid) {
                continue; // duplicate address: keep the first
            }
            spool.write_all(&data)?;
            metas.push((tid, offset, data.len() as u32));
            offset += data.len() as u64;
        }
        spool.flush()
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&spool_path);
        return Err(e);
    }
    metas.sort_by_key(|m| m.0); // clustered archives are tile-id ordered
    Ok(SpooledRasterTiles { spool_path, metas })
}

/// Finish a raster archive spooled by [`spool_raster_tiles`]: dedup, write
/// atomically (pure Rust I/O — safe to call GIL-released). `COMPRESSION_NONE`:
/// JPEG/PNG are already entropy-coded, gzip would only grow them.
pub fn finish_raster_archive(
    path: &Path,
    spooled: &SpooledRasterTiles,
    info: &RasterArchiveInfo,
) -> io::Result<usize> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "output path has no file name"))?
        .to_string_lossy()
        .into_owned();
    let pid = std::process::id();

    let data_path = dir.join(format!(".{file_name}.data.{pid}"));
    let _data_guard = ScopedTemp(data_path.clone());
    let mut entries: Vec<Entry> = Vec::with_capacity(spooled.metas.len());
    // content hash -> already-placed (spool_offset, data_offset, length)
    let mut dedup: HashMap<u64, Vec<(u64, u64, u32)>> = HashMap::new();
    let mut data_len = 0u64;
    let mut tile_contents = 0u64;
    {
        let mut sp = std::fs::File::open(&spooled.spool_path)?;
        let mut dataf = io::BufWriter::new(std::fs::File::create(&data_path)?);
        let mut buf: Vec<u8> = Vec::new();
        for &(tid, off, length) in &spooled.metas {
            buf.resize(length as usize, 0);
            sp.seek(SeekFrom::Start(off))?;
            sp.read_exact(&mut buf)?;
            let hash = content_hash(&buf);

            let mut placed: Option<(u64, u32)> = None;
            if let Some(bucket) = dedup.get(&hash) {
                for &(cand_spool_off, cand_data_off, cand_len) in bucket {
                    if cand_len as usize != buf.len() {
                        continue;
                    }
                    let mut cand = vec![0u8; cand_len as usize];
                    sp.seek(SeekFrom::Start(cand_spool_off))?;
                    sp.read_exact(&mut cand)?;
                    if cand == buf {
                        placed = Some((cand_data_off, cand_len));
                        break;
                    }
                }
            }
            let (data_offset, out_len) = match placed {
                Some(p) => p,
                None => {
                    dataf.write_all(&buf)?;
                    let p = (data_len, length);
                    data_len += length as u64;
                    tile_contents += 1;
                    dedup.entry(hash).or_default().push((off, p.0, p.1));
                    p
                }
            };
            entries.push(Entry {
                tile_id: tid,
                offset: data_offset,
                length: out_len,
                run_length: 1,
            });
        }
        dataf.flush()?;
    }

    let (root, leaves) = if entries.len() <= MAX_DIR_ENTRIES {
        (gzip(&serialize_directory(&entries)), Vec::new())
    } else {
        let mut leaves = Vec::new();
        let mut root_entries = Vec::new();
        for chunk in entries.chunks(MAX_DIR_ENTRIES) {
            let leaf = gzip(&serialize_directory(chunk));
            root_entries.push(Entry {
                tile_id: chunk[0].tile_id,
                offset: leaves.len() as u64,
                length: leaf.len() as u32,
                run_length: 0,
            });
            leaves.extend_from_slice(&leaf);
        }
        (gzip(&serialize_directory(&root_entries)), leaves)
    };
    let metadata = gzip(info.metadata_json().as_bytes());

    let root_offset = HEADER_LEN as u64;
    let metadata_offset = root_offset + root.len() as u64;
    let leaf_offset = metadata_offset + metadata.len() as u64;
    let data_offset = leaf_offset + leaves.len() as u64;

    let mut header = Vec::with_capacity(HEADER_LEN);
    header.extend_from_slice(MAGIC);
    header.push(FORMAT_VERSION);
    for v in [
        root_offset,
        root.len() as u64,
        metadata_offset,
        metadata.len() as u64,
        leaf_offset,
        leaves.len() as u64,
        data_offset,
        data_len,
        entries.len() as u64, // addressed tiles
        entries.len() as u64, // tile entries (no run-length merging)
        tile_contents,
    ] {
        header.extend_from_slice(&v.to_le_bytes());
    }
    header.push(1); // clustered
    header.push(COMPRESSION_GZIP); // internal (directory/metadata) compression
    header.push(COMPRESSION_NONE); // tile compression: raster stays raw
    header.push(info.tile_type);
    header.push(info.min_zoom);
    header.push(info.max_zoom);
    let e7 = |v: f64| ((v * 1e7).round() as i32).to_le_bytes();
    header.extend_from_slice(&e7(info.bounds.w_lon)); // min lon
    header.extend_from_slice(&e7(info.bounds.s_lat)); // min lat
    header.extend_from_slice(&e7(info.bounds.e_lon)); // max lon
    header.extend_from_slice(&e7(info.bounds.n_lat)); // max lat
    header.push(info.min_zoom + (info.max_zoom - info.min_zoom) / 2); // center zoom
    let center = info.bounds.midpoint();
    header.extend_from_slice(&e7(center.x)); // center lon
    header.extend_from_slice(&e7(center.y)); // center lat
    debug_assert_eq!(header.len(), HEADER_LEN);

    // data section is streamed off its temp file, never resident in RAM
    let tmp_path = dir.join(format!(".{file_name}.tmp.{pid}"));
    let result = (|| -> io::Result<()> {
        let mut w = io::BufWriter::new(std::fs::File::create(&tmp_path)?);
        w.write_all(&header)?;
        w.write_all(&root)?;
        w.write_all(&metadata)?;
        w.write_all(&leaves)?;
        let mut dsrc = std::fs::File::open(&data_path)?;
        io::copy(&mut dsrc, &mut w)?;
        w.into_inner()
            .map_err(io::IntoInnerError::into_error)?
            .sync_all()?;
        std::fs::rename(&tmp_path, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp_path);
    }
    result?;
    Ok(entries.len())
}

/// One-shot convenience combining [`spool_raster_tiles`] + [`finish_raster_archive`],
/// for a caller that doesn't need to release the GIL mid-stream (the pyo3
/// binding calls the two phases separately — see `python::build_raster_pmtiles`).
pub fn write_raster_archive_to_path<I>(
    path: &Path,
    tiles: I,
    info: &RasterArchiveInfo,
) -> io::Result<usize>
where
    I: Iterator<Item = io::Result<RasterTile>>,
{
    let spooled = spool_raster_tiles(path, tiles)?;
    finish_raster_archive(path, &spooled, info)
}

/// Parsed PMTiles header (spec section offsets and counts).
#[derive(Debug, Clone, PartialEq)]
pub struct Header {
    pub root_offset: u64,
    pub root_length: u64,
    pub metadata_offset: u64,
    pub metadata_length: u64,
    pub leaf_offset: u64,
    pub leaf_length: u64,
    pub data_offset: u64,
    pub data_length: u64,
    pub addressed_tiles: u64,
    pub tile_entries: u64,
    pub tile_contents: u64,
    pub clustered: bool,
    pub internal_compression: u8,
    pub tile_compression: u8,
    pub tile_type: u8,
    pub min_zoom: u8,
    pub max_zoom: u8,
    /// min lon, min lat, max lon, max lat — degrees.
    pub bounds: [f64; 4],
    pub center_zoom: u8,
    /// lon, lat — degrees.
    pub center: [f64; 2],
}

/// An in-memory PMTiles archive.
pub struct Archive {
    data: Vec<u8>,
    pub header: Header,
}

impl Archive {
    pub fn from_file(path: &Path) -> Result<Archive, PmtilesError> {
        Archive::from_bytes(std::fs::read(path)?)
    }

    pub fn from_bytes(data: Vec<u8>) -> Result<Archive, PmtilesError> {
        if data.len() < HEADER_LEN || &data[..7] != MAGIC {
            return Err(format_err("bad magic or truncated header"));
        }
        if data[7] != FORMAT_VERSION {
            return Err(format_err(format!("unsupported version {}", data[7])));
        }
        let u64_at = |o: usize| u64::from_le_bytes(data[o..o + 8].try_into().unwrap());
        let e7_at = |o: usize| i32::from_le_bytes(data[o..o + 4].try_into().unwrap()) as f64 / 1e7;
        let header = Header {
            root_offset: u64_at(8),
            root_length: u64_at(16),
            metadata_offset: u64_at(24),
            metadata_length: u64_at(32),
            leaf_offset: u64_at(40),
            leaf_length: u64_at(48),
            data_offset: u64_at(56),
            data_length: u64_at(64),
            addressed_tiles: u64_at(72),
            tile_entries: u64_at(80),
            tile_contents: u64_at(88),
            clustered: data[96] == 1,
            internal_compression: data[97],
            tile_compression: data[98],
            tile_type: data[99],
            min_zoom: data[100],
            max_zoom: data[101],
            bounds: [e7_at(102), e7_at(106), e7_at(110), e7_at(114)],
            center_zoom: data[118],
            center: [e7_at(119), e7_at(123)],
        };
        Ok(Archive { data, header })
    }

    fn section(&self, offset: u64, length: u64) -> Result<&[u8], PmtilesError> {
        // header/directory values are untrusted: checked math, no panics
        let oob = || format_err("section out of bounds");
        let end = offset.checked_add(length).ok_or_else(oob)?;
        let range =
            usize::try_from(offset).map_err(|_| oob())?..usize::try_from(end).map_err(|_| oob())?;
        self.data.get(range).ok_or_else(oob)
    }

    fn decompress(&self, compression: u8, data: &[u8]) -> Result<Vec<u8>, PmtilesError> {
        match compression {
            COMPRESSION_NONE => Ok(data.to_vec()),
            COMPRESSION_GZIP => Ok(gunzip(data)?),
            c => Err(format_err(format!("unsupported compression {c}"))),
        }
    }

    /// The decompressed JSON metadata.
    pub fn metadata_json(&self) -> Result<String, PmtilesError> {
        let raw = self.section(self.header.metadata_offset, self.header.metadata_length)?;
        let bytes = self.decompress(self.header.internal_compression, raw)?;
        String::from_utf8(bytes).map_err(|e| format_err(e.to_string()))
    }

    /// Look up and decompress one tile. `Ok(None)` if the archive has no
    /// tile at that address.
    pub fn tile(&self, z: u8, x: u32, y: u32) -> Result<Option<Vec<u8>>, PmtilesError> {
        // addresses outside the PMTiles id space are a plain miss (z >= 32
        // would otherwise alias into wrong ids in release builds)
        if z >= 32 || (x as u64) >= 1 << z || (y as u64) >= 1 << z {
            return Ok(None);
        }
        let target = tile_id(z, x, y);
        let checked = |a: u64, b: u64| {
            a.checked_add(b)
                .ok_or_else(|| format_err("section offset overflow"))
        };
        let root = self.section(self.header.root_offset, self.header.root_length)?;
        let mut dir =
            deserialize_directory(&self.decompress(self.header.internal_compression, root)?)?;
        // at most one level of leaf directories, per spec
        for _ in 0..2 {
            let i = dir.partition_point(|e| e.tile_id <= target);
            let Some(e) = i.checked_sub(1).map(|i| dir[i]) else {
                return Ok(None);
            };
            if e.run_length == 0 {
                let leaf =
                    self.section(checked(self.header.leaf_offset, e.offset)?, e.length as u64)?;
                dir = deserialize_directory(
                    &self.decompress(self.header.internal_compression, leaf)?,
                )?;
                continue;
            }
            if target < checked(e.tile_id, e.run_length as u64)? {
                let raw =
                    self.section(checked(self.header.data_offset, e.offset)?, e.length as u64)?;
                return Ok(Some(self.decompress(self.header.tile_compression, raw)?));
            }
            return Ok(None);
        }
        Err(format_err("leaf directory nesting too deep"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tile_ids_match_reference_implementation() {
        // expected values computed with the pmtiles python package
        // (pmtiles.tile.zxy_to_tileid), the spec's reference implementation
        for (z, x, y, id) in [
            (0u8, 0u32, 0u32, 0u64),
            (1, 0, 0, 1),
            (1, 0, 1, 2),
            (1, 1, 1, 3),
            (1, 1, 0, 4),
            (2, 0, 0, 5),
            (3, 0, 0, 21),
            (3, 5, 2, 76),
            (7, 11, 33, 9145),
            (12, 3423, 1763, 19_078_479),
            (16, 10616, 25266, 2_284_007_321),
            (20, 1_000_000, 1_000_000, 1_097_185_719_637),
        ] {
            assert_eq!(tile_id(z, x, y), id, "z{z} {x}/{y}");
        }
        // ids within a zoom are unique and cover the full range
        let mut ids: Vec<u64> = (0..8u32)
            .flat_map(|x| (0..8u32).map(move |y| tile_id(3, x, y)))
            .collect();
        ids.sort();
        assert_eq!(ids, (21..21 + 64).collect::<Vec<u64>>());
    }

    #[test]
    fn directory_round_trip() {
        let entries = vec![
            Entry {
                tile_id: 5,
                offset: 0,
                length: 100,
                run_length: 1,
            },
            Entry {
                tile_id: 6,
                offset: 100,
                length: 50,
                run_length: 1,
            },
            // dedup: points back at the first blob
            Entry {
                tile_id: 9,
                offset: 0,
                length: 100,
                run_length: 1,
            },
            Entry {
                tile_id: 10,
                offset: 150,
                length: 8,
                run_length: 3,
            },
        ];
        let ser = serialize_directory(&entries);
        assert_eq!(deserialize_directory(&ser).unwrap(), entries);
        assert!(deserialize_directory(&ser[..ser.len() - 1]).is_err());
    }

    /// A small three-tile archive (with one deduplicated blob) as bytes.
    fn small_archive_bytes() -> Vec<u8> {
        let mut tiles: BTreeMap<TileKey, Vec<u8>> = BTreeMap::new();
        tiles.insert((1, 0, 0), b"tile a".to_vec());
        tiles.insert((1, 1, 0), b"tile b".to_vec());
        tiles.insert((1, 1, 1), b"tile a".to_vec()); // dedup with (1,0,0)
        let info = ArchiveInfo {
            name: "test".into(),
            bounds: LLBox {
                w_lon: -10.0,
                e_lon: 10.0,
                n_lat: 20.0,
                s_lat: -20.0,
            },
            min_zoom: 1,
            max_zoom: 1,
            layers: vec!["DEPARE".into()],
        };
        let mut buf = Vec::new();
        write_archive(&mut buf, &tiles, &info).unwrap();
        buf
    }

    #[test]
    fn archive_round_trip() {
        let a = Archive::from_bytes(small_archive_bytes()).unwrap();
        assert_eq!(a.header.min_zoom, 1);
        assert_eq!(a.header.max_zoom, 1);
        assert_eq!(a.header.tile_type, TILE_TYPE_MVT);
        assert!(a.header.clustered);
        assert_eq!(a.header.addressed_tiles, 3);
        assert_eq!(a.header.tile_entries, 3);
        assert_eq!(a.header.tile_contents, 2);
        assert_eq!(a.header.bounds, [-10.0, -20.0, 10.0, 20.0]);

        assert_eq!(
            a.tile(1, 0, 0).unwrap().as_deref(),
            Some(b"tile a".as_ref())
        );
        assert_eq!(
            a.tile(1, 1, 0).unwrap().as_deref(),
            Some(b"tile b".as_ref())
        );
        assert_eq!(
            a.tile(1, 1, 1).unwrap().as_deref(),
            Some(b"tile a".as_ref())
        );
        assert_eq!(a.tile(1, 0, 1).unwrap(), None);
        assert_eq!(a.tile(5, 3, 3).unwrap(), None);

        let meta = a.metadata_json().unwrap();
        assert!(meta.contains("\"name\":\"test\""));
        assert!(meta.contains("\"vector_layers\":[{\"id\":\"DEPARE\""));
    }

    fn patch_u64(buf: &mut [u8], offset: usize, v: u64) {
        buf[offset..offset + 8].copy_from_slice(&v.to_le_bytes());
    }

    /// Regression (finding #7): unvalidated header offsets used to overflow
    /// `offset + length` and panic in debug builds instead of erroring.
    #[test]
    fn corrupt_header_offsets_error_not_panic() {
        let buf = small_archive_bytes();
        // root_offset = u64::MAX: root section lookup overflows
        let mut b = buf.clone();
        patch_u64(&mut b, 8, u64::MAX);
        assert!(Archive::from_bytes(b).unwrap().tile(1, 0, 0).is_err());
        // data_offset = u64::MAX: data section base + entry offset overflows
        let mut b = buf.clone();
        patch_u64(&mut b, 56, u64::MAX);
        let a = Archive::from_bytes(b).unwrap();
        assert!(a.tile(1, 0, 0).is_err()); // entry offset 0: overflow in section()
        assert!(a.tile(1, 1, 0).is_err()); // entry offset > 0: overflow in the add

        // metadata_offset = u64::MAX: metadata section lookup overflows
        let mut b = buf.clone();
        patch_u64(&mut b, 24, u64::MAX);
        assert!(Archive::from_bytes(b).unwrap().metadata_json().is_err());
    }

    /// Regression (finding #7): corrupt directory varints (id deltas or
    /// offsets near u64::MAX) used to overflow instead of erroring.
    #[test]
    fn corrupt_directory_varints_error_not_panic() {
        // tile-id delta accumulation overflows u64
        let mut buf = Vec::new();
        write_varint(&mut buf, 2); // count
        write_varint(&mut buf, u64::MAX); // id #1
        write_varint(&mut buf, 2); // id #2: u64::MAX + 2 overflows
        for _ in 0..2 {
            write_varint(&mut buf, 1); // run lengths
        }
        for _ in 0..2 {
            write_varint(&mut buf, 1); // lengths
        }
        write_varint(&mut buf, 1); // offset 0 (explicit)
        write_varint(&mut buf, 0); // offset chained
        assert!(deserialize_directory(&buf).is_err());

        // offset + length overflows u64 (prev_end bookkeeping)
        let mut buf = Vec::new();
        write_varint(&mut buf, 1); // count
        write_varint(&mut buf, 1); // id
        write_varint(&mut buf, 1); // run length
        write_varint(&mut buf, 5); // length
        write_varint(&mut buf, u64::MAX); // offset u64::MAX - 1
        assert!(deserialize_directory(&buf).is_err());
    }

    /// Plausible finding #9: tile addresses outside the PMTiles id space
    /// must be a clean miss, not a debug panic / release aliasing.
    #[test]
    fn out_of_range_tile_address_is_none() {
        let a = Archive::from_bytes(small_archive_bytes()).unwrap();
        assert_eq!(a.tile(32, 0, 0).unwrap(), None);
        assert_eq!(a.tile(255, 0, 0).unwrap(), None);
        assert_eq!(a.tile(1, 2, 0).unwrap(), None);
        assert_eq!(a.tile(1, 0, 2).unwrap(), None);
        assert_eq!(a.tile(0, 1, 0).unwrap(), None);
    }

    /// Temporary directory that cleans up on drop (no tempfile dependency).
    struct TestDir(PathBuf);
    impl TestDir {
        fn new(tag: &str) -> TestDir {
            let dir =
                std::env::temp_dir().join(format!("chartcore-test-{tag}-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            TestDir(dir)
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Regression (finding #1): re-ingest used to truncate the destination
    /// in place (`File::create`), yanking pages out from under a reader that
    /// has the old file open/mmapped (SIGBUS in the backend). The atomic
    /// temp+rename write must leave the old inode intact for open readers.
    #[test]
    fn write_to_path_replaces_without_touching_open_readers() {
        let dir = TestDir::new("atomic-write");
        let path = dir.0.join("cell.pmtiles");

        let mut tiles: BTreeMap<TileKey, Vec<u8>> = BTreeMap::new();
        tiles.insert((0, 0, 0), b"version one".to_vec());
        let info = ArchiveInfo {
            name: "v1".into(),
            bounds: LLBox {
                w_lon: -10.0,
                e_lon: 10.0,
                n_lat: 20.0,
                s_lat: -20.0,
            },
            min_zoom: 0,
            max_zoom: 0,
            layers: vec![],
        };
        write_archive_to_path(&path, &tiles, &info).unwrap();
        let v1 = std::fs::read(&path).unwrap();

        // a reader holds the archive open (the backend holds a long-lived mmap)
        let mut reader = std::fs::File::open(&path).unwrap();

        // re-ingest with different content
        tiles.insert((0, 0, 0), b"version two, longer than before".to_vec());
        let info2 = ArchiveInfo {
            name: "v2".into(),
            ..info
        };
        write_archive_to_path(&path, &tiles, &info2).unwrap();

        // the open reader still sees the complete old archive...
        let mut seen = Vec::new();
        reader.read_to_end(&mut seen).unwrap();
        assert_eq!(seen, v1, "open reader must keep the old inode");
        // ...while a fresh open sees the new one
        let v2 = std::fs::read(&path).unwrap();
        assert_ne!(v2, v1);
        assert_eq!(
            Archive::from_bytes(v2)
                .unwrap()
                .tile(0, 0, 0)
                .unwrap()
                .as_deref(),
            Some(b"version two, longer than before".as_ref())
        );
        // and no temp files are left behind
        let leftovers: Vec<_> = std::fs::read_dir(&dir.0)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .filter(|n| n != "cell.pmtiles")
            .collect();
        assert!(leftovers.is_empty(), "leftover files: {leftovers:?}");
    }

    #[test]
    fn leaf_directories_when_large() {
        // enough distinct tiles to force a leaf spill (> MAX_DIR_ENTRIES)
        let z = 7u8; // 128x128 = 16384 tiles > 4096
        let mut tiles: BTreeMap<TileKey, Vec<u8>> = BTreeMap::new();
        for x in 0..128u32 {
            for y in 0..128u32 {
                tiles.insert((z, x, y), format!("t{x},{y}").into_bytes());
            }
        }
        let info = ArchiveInfo {
            name: "big".into(),
            bounds: LLBox {
                w_lon: -180.0,
                e_lon: 180.0,
                n_lat: 85.0,
                s_lat: -85.0,
            },
            min_zoom: z,
            max_zoom: z,
            layers: vec![],
        };
        let mut buf = Vec::new();
        write_archive(&mut buf, &tiles, &info).unwrap();
        let a = Archive::from_bytes(buf).unwrap();
        assert!(a.header.leaf_length > 0);
        assert_eq!(a.tile(z, 0, 0).unwrap().as_deref(), Some(b"t0,0".as_ref()));
        assert_eq!(
            a.tile(z, 127, 3).unwrap().as_deref(),
            Some(b"t127,3".as_ref())
        );
        assert_eq!(
            a.tile(z, 64, 64).unwrap().as_deref(),
            Some(b"t64,64".as_ref())
        );
        assert_eq!(a.tile(z + 1, 0, 0).unwrap(), None);
    }

    // --- Raster writer (write_raster_archive_to_path / spool+finish) ------

    fn raster_info(
        min_zoom: u8,
        max_zoom: u8,
        tile_type: u8,
        tile_format: &str,
    ) -> RasterArchiveInfo {
        RasterArchiveInfo {
            name: "test".into(),
            bounds: LLBox {
                w_lon: -10.0,
                e_lon: 10.0,
                n_lat: 20.0,
                s_lat: -20.0,
            },
            min_zoom,
            max_zoom,
            tile_type,
            tile_format: tile_format.into(),
        }
    }

    #[test]
    fn raster_archive_round_trips_and_dedups() {
        // Mirrors the ported Python writer's own test
        // (test_writer_round_trips_and_dedups in backend/tests/test_satellite.py):
        // same three tiles, same dedup expectation, same header assertions.
        let dir = TestDir::new("raster-small");
        let path = dir.0.join("r.pmtiles");
        let tiles: Vec<RasterTile> = vec![
            (0, 0, 0, b"AAA".to_vec()),
            (1, 0, 0, b"BBB".to_vec()),
            (1, 1, 1, b"AAA".to_vec()), // dedup with (0,0,0)
        ];
        let info = raster_info(0, 1, TILE_TYPE_PNG, "png");
        let n = write_raster_archive_to_path(&path, tiles.into_iter().map(Ok), &info).unwrap();
        assert_eq!(n, 3);

        let a = Archive::from_bytes(std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(a.header.tile_type, TILE_TYPE_PNG);
        assert_eq!(a.header.tile_compression, COMPRESSION_NONE); // raster stays raw
        assert_eq!(a.header.internal_compression, COMPRESSION_GZIP);
        assert_eq!(a.header.addressed_tiles, 3);
        assert_eq!(a.header.tile_entries, 3);
        assert_eq!(a.header.tile_contents, 2); // (1,1,1) deduped onto (0,0,0)
        assert_eq!(a.tile(0, 0, 0).unwrap().as_deref(), Some(b"AAA".as_ref()));
        assert_eq!(a.tile(1, 0, 0).unwrap().as_deref(), Some(b"BBB".as_ref()));
        assert_eq!(a.tile(1, 1, 1).unwrap().as_deref(), Some(b"AAA".as_ref()));
        assert_eq!(a.tile(1, 0, 1).unwrap(), None); // a real miss

        let meta = a.metadata_json().unwrap();
        assert!(meta.contains("\"name\":\"test\""));
        assert!(meta.contains("\"format\":\"png\""));
        assert!(!meta.contains("vector_layers")); // absent, not empty — raster tell

        // no temp files left behind
        let leftovers: Vec<_> = std::fs::read_dir(&dir.0)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .filter(|n| n != "r.pmtiles")
            .collect();
        assert!(leftovers.is_empty(), "leftover files: {leftovers:?}");
    }

    #[test]
    fn raster_archive_duplicate_address_keeps_first() {
        // A re-fetched tile (same z/x/y yielded twice) must not double-count
        // or break the strictly-increasing id invariant the directory needs.
        let dir = TestDir::new("raster-dup-address");
        let path = dir.0.join("r.pmtiles");
        let tiles: Vec<RasterTile> = vec![
            (0, 0, 0, b"first".to_vec()),
            (0, 0, 0, b"second-should-be-ignored".to_vec()),
        ];
        let info = raster_info(0, 0, TILE_TYPE_JPEG, "jpg");
        let n = write_raster_archive_to_path(&path, tiles.into_iter().map(Ok), &info).unwrap();
        assert_eq!(n, 1);
        let a = Archive::from_bytes(std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(a.tile(0, 0, 0).unwrap().as_deref(), Some(b"first".as_ref()));
    }

    #[test]
    fn raster_archive_leaf_directories_when_large() {
        // Mirrors test_writer_spills_to_leaf_directories: more than
        // MAX_DIR_ENTRIES distinct tiles force a leaf-directory level, and
        // lookups still resolve via the streaming spool+dedup path (not an
        // in-RAM dict).
        let z = 7u8; // 128x128 = 16384 tiles > 4096
        let tiles = (0..128u32)
            .flat_map(|x| (0..128u32).map(move |y| (z, x, y, format!("t{x},{y}").into_bytes())));

        let dir = TestDir::new("raster-large");
        let path = dir.0.join("big.pmtiles");
        let info = RasterArchiveInfo {
            name: "big".into(),
            bounds: LLBox {
                w_lon: -180.0,
                e_lon: 180.0,
                n_lat: 85.0,
                s_lat: -85.0,
            },
            min_zoom: z,
            max_zoom: z,
            tile_type: TILE_TYPE_JPEG,
            tile_format: "jpg".into(),
        };
        write_raster_archive_to_path(&path, tiles.map(Ok), &info).unwrap();

        let a = Archive::from_bytes(std::fs::read(&path).unwrap()).unwrap();
        assert!(a.header.leaf_length > 0);
        assert_eq!(a.tile(z, 0, 0).unwrap().as_deref(), Some(b"t0,0".as_ref()));
        assert_eq!(
            a.tile(z, 127, 3).unwrap().as_deref(),
            Some(b"t127,3".as_ref())
        );
        assert_eq!(
            a.tile(z, 64, 64).unwrap().as_deref(),
            Some(b"t64,64".as_ref())
        );
        assert_eq!(a.tile(z + 1, 0, 0).unwrap(), None);
    }

    #[test]
    fn raster_archive_propagates_source_errors_and_cleans_up() {
        // A failing tile source (the pyo3 binding maps a Python exception to
        // an io::Error here) must surface as an error and leave no spool/data
        // debris or partial output behind.
        let dir = TestDir::new("raster-error");
        let path = dir.0.join("bad.pmtiles");
        let tiles: Vec<io::Result<RasterTile>> =
            vec![Ok((0, 0, 0, b"ok".to_vec())), Err(io::Error::other("boom"))];
        let info = raster_info(0, 0, TILE_TYPE_PNG, "png");
        let err = write_raster_archive_to_path(&path, tiles.into_iter(), &info).unwrap_err();
        assert_eq!(err.to_string(), "boom");
        assert!(!path.exists());
        assert!(
            std::fs::read_dir(&dir.0).unwrap().next().is_none(),
            "no leftover temp files"
        );
    }
}
