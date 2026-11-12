// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! `.mivnav` file layout — §15's routing artifact, and §19's versioning.
//!
//! One file per chart set: a fixed 64-byte [`FileHeader`], then section
//! payloads, then a [`SectionEntry`] table. The header names the chart set
//! and carries the five independent version numbers of §19; the table says
//! where every section lives. Everything else in this module tree writes
//! and reads *sections* — this file is the only place that knows what a
//! `.mivnav` looks like as bytes.
//!
//! ```text
//! offset  size  contents
//! 0       64    FileHeader (magic, chart-set identity, versions, TOC ptr)
//! 64      ...   section payloads, in write order, each 8-byte aligned
//! ...     24*n  section table: n * (kind, reserved, offset, len)
//! ```
//!
//! The section table is written **last** (its size is only known once the
//! payloads are, and the payloads are gigabytes — §5.3 — so they stream)
//! and the header is patched by seeking back to offset 0 at `finish`.
//!
//! # Why the table is at the end but pointed at from the front
//!
//! A reader mmaps the file, reads 64 bytes, and jumps straight to the
//! table. It never scans. Sections it does not recognise are skipped by
//! `offset + len` alone — that is the entire schema-evolution story
//! (see [`SectionKind::Unknown`]), and it is what lets a Pi running an
//! older chartcore keep serving from an artifact built by a newer one
//! instead of failing to open it.
//!
//! # Conventions borrowed from the rest of the crate
//!
//! - Hand-rolled little-endian encode/decode (`u32::from_le_bytes` &c.),
//!   no serialization dependency: same posture as [`crate::pmtiles`],
//!   whose 127-byte header this module's reader is modelled on, and same
//!   minimal-dependency reasoning CLAUDE.md documents for `gdal`.
//! - All offsets/lengths out of the file are **untrusted**: checked
//!   arithmetic and slice `get`, never indexing that can panic — copied
//!   straight from `pmtiles::Archive::section`.
//! - Atomic publish via temp-file-in-the-same-directory + `sync_all` +
//!   `rename` ([`write_artifact_atomically`]), the same skeleton as
//!   `pmtiles::write_archive_to_path`. A rebuild must never truncate a
//!   file the backend has mmapped: a page access past the new EOF is a
//!   SIGBUS, not an error return.
//! - Payloads are 8-byte aligned so a future zero-copy read of a `u16`/
//!   `u64` SoA column out of an mmap (page-aligned base) is correctly
//!   aligned without a copy.

use std::borrow::Cow;
use std::fmt;
use std::io::{self, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

/// File magic. ASCII on purpose: `file`/`strings`/a hex dump identify a
/// `.mivnav` at a glance, same debuggability `pmtiles`' `b"PMTiles"` has.
///
/// The trailing `01` is a *container generation*, not a schema version —
/// bumping it declares "this is a different file format, do not even try",
/// and is expected to stay `01` indefinitely. Everything that actually
/// changes about the content is one of [`ArtifactVersions`]' five fields,
/// which a reader can inspect and *report on* rather than bounce.
pub const MAGIC: &[u8; 8] = b"MIVNAV01";

/// Fixed header size. Never changes without a magic bump: the spare bytes
/// at the end are the growth room (a reader must ignore them, see
/// [`FileHeader::parse`]).
pub const HEADER_LEN: usize = 64;

/// One section-table entry: kind, reserved, offset, len — 24 bytes, so the
/// table itself stays 8-byte aligned and entry `i` is at `table + 24*i`.
pub const SECTION_ENTRY_LEN: usize = 24;

/// Size of a [`BandTag`], the self-describing prefix every PER-BAND
/// section payload carries.
pub const BAND_TAG_LEN: usize = 8;

/// Payload alignment (see module docs).
const SECTION_ALIGN: u64 = 8;

// ---------------------------------------------------------------------------
// §5.1 cell payload constants
// ---------------------------------------------------------------------------
//
// These live here, not in the (Phase 2) field module, because they are part
// of the *file* contract: they define how to interpret the bytes of the
// DepthMin/DepthMax/Flags sections. A build that changes their meaning is a
// `derivation_version` bump; a build that changes their *layout* (widths,
// bit positions) is a `schema_version` bump.

/// `depth_min`/`depth_max` unit: decimetres to chart datum, saturating,
/// stored `u16` (§5.1).
pub const DEPTH_UNIT_DM_PER_M: u16 = 10;

/// `depth_min` sentinel for "no coverage" (§5.1). Distinguished from a
/// real `0` (drying height / land) by [`FLAG_NO_COVERAGE`], never by the
/// depth alone.
pub const DEPTH_NO_COVERAGE: u16 = 0xFFFF;

/// `flags` bit 0 — land.
pub const FLAG_LAND: u8 = 1 << 0;
/// `flags` bit 1 — hard hazard.
pub const FLAG_HARD_HAZARD: u8 = 1 << 1;
/// `flags` bit 2 — no coverage: the cell is OUTSIDE every `M_COVR`
/// coverage polygon. NOT set for `UNSARE` (unsurveyed area) — see
/// `mivnav::field::rasterize_tile`. Since the 2 → 3 `derivation_version`
/// bump this bit does NOT on its own keep a cell out of the band
/// topology: `bands::BAND_BLOCKING_FLAGS` no longer includes it, so a
/// no-coverage cell with a real charted `depth_max >= band` is navigable
/// (governed by depth, not the coverage declaration — matching
/// `routing::artifact`'s fine search, which grace-walks the same cells).
/// What still blocks is `depth_max == DEPTH_NO_COVERAGE` (genuine
/// uncharted void), via the sentinel check in `bands::navigable_dm`.
pub const FLAG_NO_COVERAGE: u8 = 1 << 2;
/// `flags` bit 3 — overhead constraint present; `VERCLR` lookup required
/// (a *presence* bit: the value is in the semantics store, not the raster).
pub const FLAG_OVERHEAD: u8 = 1 << 3;
/// `flags` bit 4 — fairway / recommended track.
pub const FLAG_FAIRWAY: u8 = 1 << 4;
/// `flags` bit 5 — TSS present; direction comes from the topology, not here.
pub const FLAG_TSS: u8 = 1 << 5;
/// `flags` bit 6 — restricted; `RESTRN` lookup required (presence bit).
pub const FLAG_RESTRICTED: u8 = 1 << 6;
/// `flags` bit 7 — vector-required (§4.4): this cell's neighbourhood must
/// be re-solved against chart truth, the raster is not authoritative here.
pub const FLAG_VECTOR_REQUIRED: u8 = 1 << 7;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Errors from reading a `.mivnav` artifact. Mirrors
/// [`crate::pmtiles::PmtilesError`]'s shape deliberately.
///
/// Note what is *not* here: a version mismatch. Parsing succeeds on any
/// structurally valid file regardless of its versions, so a caller can open
/// a stale artifact and *report which component is stale*
/// ([`ArtifactReader::staleness`]) instead of getting an opaque "cannot
/// read". Diagnosing "the boat serves yesterday's routes" (§19) needs the
/// file to be readable.
#[derive(Debug)]
pub enum FormatError {
    Io(io::Error),
    /// Structurally invalid artifact: bad magic, truncated, or a section
    /// entry that points outside the file.
    Format(String),
}

impl fmt::Display for FormatError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FormatError::Io(e) => write!(f, "I/O error: {e}"),
            FormatError::Format(m) => write!(f, "invalid .mivnav artifact: {m}"),
        }
    }
}

impl std::error::Error for FormatError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            FormatError::Io(e) => Some(e),
            _ => None,
        }
    }
}

impl From<io::Error> for FormatError {
    fn from(e: io::Error) -> Self {
        FormatError::Io(e)
    }
}

fn format_err(m: impl Into<String>) -> FormatError {
    FormatError::Format(m.into())
}

// ---------------------------------------------------------------------------
// §19 versioning
// ---------------------------------------------------------------------------

/// §19's composite cache identity, minus the chart set itself (that is
/// [`ChartSetIdentity`]): five **independent** `u32`s, each owned by a
/// different part of the pipeline.
///
/// This is deliberately not one flat integer like the backend's
/// `TILE_SCHEMA_VERSION`. That one number works because there is one
/// producer; here five different changes invalidate five different amounts
/// of work, and collapsing them would mean a band-ladder tweak forces a
/// full re-rasterization of the country. They are *all* compared on open,
/// so nothing is silently accepted — but a future incremental rebuild can
/// look at *which* one moved and redo only that stage.
///
/// The failure this exists to prevent is CLAUDE.md's own documented one,
/// one layer down: change a derivation, forget the bump, and the boat keeps
/// serving the cached artifact forever while the fix's own tests pass. It
/// looks exactly like the fix did nothing. If you change anything below and
/// are unsure which field it is, bump [`ArtifactVersions::SCHEMA`] — an
/// unnecessary rebuild costs CPU on the dev box; a missed one costs a wrong
/// route on the water.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArtifactVersions {
    /// Bump when the **bytes** change meaning: header/TOC layout, a new or
    /// resized field in a section payload, a changed flag bit position, a
    /// changed sentinel, a section split in two. Anything where an old
    /// reader would misread a new file (or vice versa) rather than merely
    /// disagree with it. This is the only one that is a *format* version.
    pub schema_version: u32,
    /// Bump when the same chart input now produces different **values**:
    /// hazard classification, effective-depth computation, the CATZOC
    /// allowance (§3.4), supercover rasterization of thin features (§4.4),
    /// how `depth_min`/`depth_max` are derived from DEPARE/SOUNDG. The
    /// layout is untouched; the numbers in it are not. This is the field a
    /// "fix the depth gate" commit bumps.
    pub derivation_version: u32,
    /// Bump when **which chart wins where** changes: the region-wide
    /// finest-cell-wins resolution (§3.2), its tier ordering, or the
    /// geometry of the differencing that clips a coarser cell against a
    /// finer one's extent. Same derivation rules, different source
    /// polygons feeding them — so every cell near a chart boundary can
    /// move without a single derivation rule changing.
    pub authority_version: u32,
    /// Bump when the **band ladder** changes (§7.1): the set of draft/air-
    /// draft thresholds, their values, or their order. Every per-band
    /// product downstream — components, portals, shortcuts, landmarks — is
    /// indexed by band, so an inserted band silently renumbers all of them.
    /// The spatial field itself survives a bump here; the topology does not.
    pub band_ladder_version: u32,
    /// Bump when the **resolution policy** changes (§4): ladder levels,
    /// tile granularity, the §4.3 refinement triggers or their thresholds,
    /// the §4.4 thin-feature escalation, or the boundary-stitch rule
    /// (§4.2). The cell *values* are derived the same way; the grid they
    /// are derived onto is different, so offsets, tile extents and every
    /// cell index change.
    pub resolution_policy_version: u32,
}

impl ArtifactVersions {
    /// The versions this build of chartcore writes, and expects to read.
    ///
    /// `derivation_version` history — every bump reports pre-existing
    /// `.mivnav` files stale so the boat rebuilds (§19 `staleness()`):
    /// * 1 → 2: `mivnav::field::rasterize_tile` stopped folding S-57
    ///   `UNSARE` into `FLAG_NO_COVERAGE`.
    /// * 2 → 3: `FLAG_NO_COVERAGE` (outside every `M_COVR`) left
    ///   `bands::BAND_BLOCKING_FLAGS` — a no-coverage cell with a real
    ///   charted `depth_max >= band` now labels navigable in the topology
    ///   (governed by depth, not the coverage declaration; the sentinel
    ///   still blocks genuinely-uncharted void).
    ///
    /// The other three stay at 1 — no `.mivnav` predates them.
    pub const CURRENT: ArtifactVersions = ArtifactVersions {
        schema_version: Self::SCHEMA,
        derivation_version: 3,
        authority_version: 1,
        band_ladder_version: 1,
        resolution_policy_version: 1,
    };

    /// See [`ArtifactVersions::schema_version`].
    pub const SCHEMA: u32 = 1;

    /// Which components of `self` (a file's versions) differ from
    /// `expected` (a reader's compiled-in ones), in a fixed order.
    ///
    /// Empty means compatible. Non-empty is a *diagnosis*, not just a
    /// rejection: it names the stage whose output is stale.
    pub fn mismatches(&self, expected: &ArtifactVersions) -> Vec<VersionMismatch> {
        use VersionComponent::*;
        [
            (Schema, self.schema_version, expected.schema_version),
            (
                Derivation,
                self.derivation_version,
                expected.derivation_version,
            ),
            (
                Authority,
                self.authority_version,
                expected.authority_version,
            ),
            (
                BandLadder,
                self.band_ladder_version,
                expected.band_ladder_version,
            ),
            (
                ResolutionPolicy,
                self.resolution_policy_version,
                expected.resolution_policy_version,
            ),
        ]
        .into_iter()
        .filter(|(_, found, want)| found != want)
        .map(|(component, found, expected)| VersionMismatch {
            component,
            expected,
            found,
        })
        .collect()
    }
}

/// One field of [`ArtifactVersions`], for reporting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VersionComponent {
    Schema,
    Derivation,
    Authority,
    BandLadder,
    ResolutionPolicy,
}

impl VersionComponent {
    /// Stable name for logs and API responses.
    pub const fn name(self) -> &'static str {
        match self {
            VersionComponent::Schema => "schema",
            VersionComponent::Derivation => "derivation",
            VersionComponent::Authority => "authority",
            VersionComponent::BandLadder => "band_ladder",
            VersionComponent::ResolutionPolicy => "resolution_policy",
        }
    }
}

impl fmt::Display for VersionComponent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

/// A single version component that differs between file and reader.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VersionMismatch {
    pub component: VersionComponent,
    /// What this build of chartcore expects.
    pub expected: u32,
    /// What the file on disk says.
    pub found: u32,
}

impl fmt::Display for VersionMismatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} version {} in artifact, {} expected",
            self.component, self.found, self.expected
        )
    }
}

/// Why an on-disk artifact must not be used as-is. Ordered by how much
/// work a rebuild implies, most fundamental first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Staleness {
    /// Built for a different chart set entirely.
    ChartSet { expected: u64, found: u64 },
    /// Right chart set, but the charts have changed underneath it.
    Sequence { expected: u64, found: u64 },
    /// Right chart set and sequence, but the pipeline that produced it has
    /// moved — one entry per differing component.
    Versions(Vec<VersionMismatch>),
}

impl fmt::Display for Staleness {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Staleness::ChartSet { expected, found } => write!(
                f,
                "artifact belongs to chart set {found:#018x}, expected {expected:#018x}"
            ),
            Staleness::Sequence { expected, found } => write!(
                f,
                "artifact built at chart-set sequence {found}, current sequence is {expected}"
            ),
            Staleness::Versions(v) => {
                write!(f, "stale artifact: ")?;
                for (i, m) in v.iter().enumerate() {
                    if i > 0 {
                        f.write_str("; ")?;
                    }
                    write!(f, "{m}")?;
                }
                Ok(())
            }
        }
    }
}

/// Which chart set an artifact was built from, and how current it was.
///
/// `sequence` mirrors the backend's own `cs.sequence` (the max mtime over
/// the set's files): the cheap "did anything change" number that already
/// invalidates the tile cache, reused verbatim so the two caches can never
/// disagree about what "current" means.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChartSetIdentity {
    /// [`chart_set_id_hash`] of the chart set's stable string id.
    pub id_hash: u64,
    /// Backend `cs.sequence` (max mtime), monotonic per chart set.
    pub sequence: u64,
}

impl ChartSetIdentity {
    /// From the backend's own chart-set id string and sequence.
    pub fn new(chart_set_id: &str, sequence: u64) -> ChartSetIdentity {
        ChartSetIdentity {
            id_hash: chart_set_id_hash(chart_set_id),
            sequence,
        }
    }
}

/// 64-bit FNV-1a of a chart-set id string.
///
/// Non-cryptographic and dependency-free, which is the whole point: the
/// crate has no hash dependency and this does not warrant adding one.
/// `pmtiles::content_hash` already established FNV-1a here for the same
/// reason. What a collision would cost is bounded: two *different* chart
/// sets would have to hash equal **and** share a `sequence` before a stale
/// artifact could be accepted, and set ids are short ASCII strings of which
/// a boat has a handful. This is a cache key, not an integrity check —
/// nothing about safety rests on it, because §16's verifier re-checks every
/// returned route against chart truth regardless of where the route came
/// from.
pub fn chart_set_id_hash(chart_set_id: &str) -> u64 {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut h = OFFSET;
    for &b in chart_set_id.as_bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(PRIME);
    }
    h
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

/// The fixed 64-byte file header.
///
/// ```text
/// off  len  field
///   0    8  magic                      b"MIVNAV01"
///   8    8  chart_set.id_hash          u64  (FNV-1a of the set id)
///  16    8  chart_set.sequence         u64  (backend cs.sequence)
///  24    8  section_table_offset       u64
///  32    4  schema_version             u32
///  36    4  derivation_version         u32
///  40    4  authority_version          u32
///  44    4  band_ladder_version        u32
///  48    4  resolution_policy_version  u32
///  52    4  section_count              u32
///  56    8  reserved                   zero, ignored on read
/// ```
///
/// Every multi-byte field is little-endian and naturally aligned within the
/// header, so a future zero-copy read is possible; the code decodes with
/// `from_le_bytes` regardless, so alignment is a nicety and not a
/// correctness dependency.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileHeader {
    pub chart_set: ChartSetIdentity,
    pub versions: ArtifactVersions,
    /// Byte offset of the section table.
    pub section_table_offset: u64,
    /// Number of [`SectionEntry`]s at `section_table_offset`.
    pub section_count: u32,
}

impl FileHeader {
    /// Encode to the on-disk 64 bytes.
    pub fn to_bytes(&self) -> [u8; HEADER_LEN] {
        let mut b = [0u8; HEADER_LEN];
        b[0..8].copy_from_slice(MAGIC);
        b[8..16].copy_from_slice(&self.chart_set.id_hash.to_le_bytes());
        b[16..24].copy_from_slice(&self.chart_set.sequence.to_le_bytes());
        b[24..32].copy_from_slice(&self.section_table_offset.to_le_bytes());
        b[32..36].copy_from_slice(&self.versions.schema_version.to_le_bytes());
        b[36..40].copy_from_slice(&self.versions.derivation_version.to_le_bytes());
        b[40..44].copy_from_slice(&self.versions.authority_version.to_le_bytes());
        b[44..48].copy_from_slice(&self.versions.band_ladder_version.to_le_bytes());
        b[48..52].copy_from_slice(&self.versions.resolution_policy_version.to_le_bytes());
        b[52..56].copy_from_slice(&self.section_count.to_le_bytes());
        // 56..64 reserved, left zero
        b
    }

    /// Decode the header from the start of `data`.
    ///
    /// Rejects a wrong magic and a short buffer; accepts any version (see
    /// [`FormatError`]) and ignores the reserved tail, so a file written by
    /// a newer chartcore that puts something there still opens.
    pub fn parse(data: &[u8]) -> Result<FileHeader, FormatError> {
        if data.len() < HEADER_LEN {
            return Err(format_err(format!(
                "truncated header: {} bytes, {HEADER_LEN} required",
                data.len()
            )));
        }
        if &data[..8] != MAGIC {
            return Err(format_err("bad magic (not a .mivnav artifact)"));
        }
        let u64_at = |o: usize| u64::from_le_bytes(data[o..o + 8].try_into().unwrap());
        let u32_at = |o: usize| u32::from_le_bytes(data[o..o + 4].try_into().unwrap());
        Ok(FileHeader {
            chart_set: ChartSetIdentity {
                id_hash: u64_at(8),
                sequence: u64_at(16),
            },
            section_table_offset: u64_at(24),
            versions: ArtifactVersions {
                schema_version: u32_at(32),
                derivation_version: u32_at(36),
                authority_version: u32_at(40),
                band_ladder_version: u32_at(44),
                resolution_policy_version: u32_at(48),
            },
            section_count: u32_at(52),
        })
    }
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/// What a section contains. The `u32` tag is the on-disk value; the enum is
/// just a name for it.
///
/// Discriminants are **explicit and permanent** — a tag is never reused for
/// a different meaning, and a removed section's tag stays burnt. The one
/// kind with no encoder yet ([`SectionKind::SourceRefs`]) is declared
/// anyway so the numbering is fixed before anything ships, and lands with
/// the phase that fills it — [`SectionKind::Semantics`] did, in Phase 7
/// (§11's directional / buoyage store; see
/// [`super::persist::encode_semantics`]), and
/// [`SectionKind::Landmarks`] in Phase 8 (§14's ALT lower-bound tables;
/// see [`super::landmarks::encode_landmarks`]).
///
/// # One section per kind, EXCEPT the per-band ones
///
/// [`SectionKind::Components`], [`SectionKind::Portals`],
/// [`SectionKind::Topology`] and [`SectionKind::Landmarks`] are **per
/// band** (§7.1's ten-rung ladder), so a real artifact carries ten
/// sections of each of those kinds and exactly one of everything else.
/// Each per-band payload names its own band in a
/// [`BandTag`] prefix; address them with
/// [`ArtifactReader::find_band_section`], never
/// [`ArtifactReader::find_section`] (which is first-wins and would silently
/// hand back whichever band happens to sit earliest in the table).
///
/// [`SectionKind::Unknown`] is the growth room: any tag this build does not
/// know decodes to `Unknown(tag)` and round-trips unchanged, and its bytes
/// are still located by `offset`/`len`. A reader must be able to *skip*
/// what it cannot interpret — that is what lets a newer builder's artifact
/// stay readable on an older boat, and it is proved by a test in this file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SectionKind {
    /// Tile index: ladder level, origin, extent and payload offsets per
    /// tile (§15). The entry point to the whole spatial field.
    TileIndex,
    /// `depth_min[]`, `u16` SoA (§5.1).
    DepthMin,
    /// `depth_max[]`, `u16` SoA (§5.1).
    DepthMax,
    /// `flags[]`, `u8` SoA (§5.1) — see the `FLAG_*` constants.
    Flags,
    /// Boundary-cell stitching between adjacent differing-resolution tiles
    /// (§4.2).
    BoundaryStitch,
    /// Attributed semantics store (§5.1, §11). Phase 7 writes the §11
    /// directional / buoyage half: charted traffic-flow polygons
    /// (`TSSLPT`/`DWRTPT`/one-way `RECTRC` with `ORIENT`) and classified
    /// lateral marks, region-level, one section per artifact. See
    /// [`super::persist::encode_semantics`]. An artifact built before
    /// this was written carries none and a caller re-derives — its
    /// absence is not staleness.
    Semantics,
    /// Per-band connected components (§8.1) — one section per band, each
    /// [`BandTag`]-prefixed. See [`super::topology::encode_components`].
    Components,
    /// Per-band portals with capacity (§8.2) — one section per band, each
    /// [`BandTag`]-prefixed. See [`super::portals::encode_portals`].
    Portals,
    /// Per-band contracted topology: corridors and shortcuts (§8.4) — one
    /// section per band, each [`BandTag`]-prefixed. See
    /// [`super::shortcuts::encode_shortcuts`].
    Topology,
    /// Landmark / lower-bound tables for the optimality gap (§14).
    Landmarks,
    /// Source and authority references per region (§15, §18's authority
    /// overlay).
    SourceRefs,
    /// §12.4 — pre-clipped hazard-ring geometry for local vector
    /// refinement: the exact charted rings [`super::refine`] routes a
    /// demoted crossing against, so the query path never has to hold
    /// decoded cells resident just to refine one. Region-level (NOT
    /// per-band — a hard hazard is hard at every draft), one section per
    /// artifact. See [`super::persist::encode_hazard_rings`]. An artifact
    /// built before this section existed simply carries none, and a
    /// caller re-derives the rings from
    /// `routing::artifact::constraints::build` — so it is a resident-set
    /// optimisation, not a correctness dependency, and its absence is not
    /// staleness.
    HazardRings,
    /// A tag this build does not know. Skippable by `offset`/`len`.
    Unknown(u32),
}

impl SectionKind {
    /// On-disk tag.
    pub const fn tag(self) -> u32 {
        match self {
            SectionKind::TileIndex => 1,
            SectionKind::DepthMin => 2,
            SectionKind::DepthMax => 3,
            SectionKind::Flags => 4,
            SectionKind::BoundaryStitch => 5,
            SectionKind::Semantics => 6,
            SectionKind::Components => 7,
            SectionKind::Portals => 8,
            SectionKind::Topology => 9,
            SectionKind::Landmarks => 10,
            SectionKind::SourceRefs => 11,
            SectionKind::HazardRings => 12,
            SectionKind::Unknown(tag) => tag,
        }
    }

    /// Decode an on-disk tag. Unrecognised tags become
    /// [`SectionKind::Unknown`] rather than an error — see the type docs.
    pub const fn from_tag(tag: u32) -> SectionKind {
        match tag {
            1 => SectionKind::TileIndex,
            2 => SectionKind::DepthMin,
            3 => SectionKind::DepthMax,
            4 => SectionKind::Flags,
            5 => SectionKind::BoundaryStitch,
            6 => SectionKind::Semantics,
            7 => SectionKind::Components,
            8 => SectionKind::Portals,
            9 => SectionKind::Topology,
            10 => SectionKind::Landmarks,
            11 => SectionKind::SourceRefs,
            12 => SectionKind::HazardRings,
            other => SectionKind::Unknown(other),
        }
    }

    /// Whether this build knows how to interpret the section's bytes.
    pub const fn is_known(self) -> bool {
        !matches!(self, SectionKind::Unknown(_))
    }
}

/// One row of the section table: where a section's bytes are.
///
/// ```text
/// off  len  field
///   0    4  kind      u32 tag
///   4    4  reserved  zero (keeps offset/len 8-aligned; growth room for
///                     e.g. a per-section compression byte)
///   8    8  offset    u64, from the start of the file
///  16    8  len       u64
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SectionEntry {
    pub kind: SectionKind,
    pub offset: u64,
    pub len: u64,
}

impl SectionEntry {
    fn to_bytes(self) -> [u8; SECTION_ENTRY_LEN] {
        let mut b = [0u8; SECTION_ENTRY_LEN];
        b[0..4].copy_from_slice(&self.kind.tag().to_le_bytes());
        // 4..8 reserved, left zero
        b[8..16].copy_from_slice(&self.offset.to_le_bytes());
        b[16..24].copy_from_slice(&self.len.to_le_bytes());
        b
    }

    fn parse(b: &[u8]) -> SectionEntry {
        debug_assert!(b.len() >= SECTION_ENTRY_LEN);
        SectionEntry {
            kind: SectionKind::from_tag(u32::from_le_bytes(b[0..4].try_into().unwrap())),
            offset: u64::from_le_bytes(b[8..16].try_into().unwrap()),
            len: u64::from_le_bytes(b[16..24].try_into().unwrap()),
        }
    }
}

// ---------------------------------------------------------------------------
// Per-band section addressing
// ---------------------------------------------------------------------------

/// Which band a per-band section belongs to, written as the first
/// [`BAND_TAG_LEN`] bytes of that section's own payload.
///
/// ```text
/// off  len  field
///   0    1  band_index  u8   index into super::field::BAND_LADDER_M
///   1    1  reserved         zero
///   2    2  band_dm     u16  bands::band_to_dm of that ladder entry
///   4    4  reserved         zero, ignored on read
/// ```
///
/// # Why the tag is in the payload and not in the section table
///
/// [`SectionKind::Components`]/[`SectionKind::Portals`]/
/// [`SectionKind::Topology`] are all **per band** (§7.1's ten-rung
/// ladder), so an artifact carries ten sections of each kind, not one.
/// The section table has no room to say which is which — its `reserved`
/// `u32` is growth room for a per-section property like compression, not
/// a place to smuggle a semantic key — and [`ArtifactReader::find_section`]
/// is deliberately first-wins on a duplicated kind.
///
/// So each per-band payload names its own band, and
/// [`ArtifactReader::band_sections`] scans the table by kind and matches
/// the embedded tag. That keeps every existing rule intact: the table
/// stays a pure `(kind, offset, len)` locator, an unknown-kind section is
/// still skippable by `offset + len` alone, and a build that grows an
/// eleventh band adds an eleventh section instead of changing any layout.
///
/// # Why `band_dm` is stored as well as `band_index`
///
/// `band_index` alone is only meaningful against the ladder the file was
/// built with. A ladder change is an
/// [`ArtifactVersions::band_ladder_version`] bump, and §19's whole point
/// is that a stale artifact still *opens* so the staleness can be
/// reported — which means a reader can legitimately be looking at a
/// payload whose rung 4 was 3.0 m when a rung 4 today is 3.5 m. Storing
/// the band's own decimetre value makes that detectable at the section
/// level, by the code actually about to use the data, rather than only
/// inferable from a version number several layers away.
/// [`super::persist::load_band`] is where that check is enforced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BandTag {
    /// Index into `super::field::BAND_LADDER_M`.
    pub band_index: u8,
    /// The band itself, in the same decimetre unit `depth_max` uses —
    /// `super::bands::band_to_dm(BAND_LADDER_M[band_index])`.
    pub band_dm: u16,
}

impl BandTag {
    /// Encode to the on-disk 8 bytes.
    pub fn to_bytes(self) -> [u8; BAND_TAG_LEN] {
        let mut b = [0u8; BAND_TAG_LEN];
        b[0] = self.band_index;
        // 1 reserved
        b[2..4].copy_from_slice(&self.band_dm.to_le_bytes());
        // 4..8 reserved
        b
    }

    /// Decode from the start of `bytes`. `None` on a payload too short to
    /// carry a tag at all — never a panic, per this module's own rule for
    /// untrusted bytes.
    pub fn parse(bytes: &[u8]) -> Option<BandTag> {
        let b = bytes.get(..BAND_TAG_LEN)?;
        Some(BandTag {
            band_index: b[0],
            band_dm: u16::from_le_bytes(b[2..4].try_into().unwrap()),
        })
    }
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/// Counts bytes written through to an inner writer, so a streaming section
/// body does not have to be buffered just to learn its length.
struct Counting<'a, W: Write> {
    inner: &'a mut W,
    written: u64,
}

impl<W: Write> Write for Counting<'_, W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.written += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// Streaming `.mivnav` writer: header placeholder, then sections, then the
/// table, then the real header.
///
/// Sections are written in call order and never buffered whole (§5.3's
/// estimate is gigabytes), which is why the section table goes at the end
/// and the header is patched by seeking back — hence `Write + Seek`.
///
/// Use [`write_artifact_atomically`] rather than driving this against a
/// file you opened yourself: publishing is the part that has to be right.
pub struct ArtifactWriter<W: Write + Seek> {
    w: W,
    pos: u64,
    sections: Vec<SectionEntry>,
}

impl<W: Write + Seek> ArtifactWriter<W> {
    /// Start an artifact, reserving the header.
    pub fn new(mut w: W) -> io::Result<ArtifactWriter<W>> {
        w.write_all(&[0u8; HEADER_LEN])?;
        Ok(ArtifactWriter {
            w,
            pos: HEADER_LEN as u64,
            sections: Vec::new(),
        })
    }

    /// Sections already written.
    pub fn sections(&self) -> &[SectionEntry] {
        &self.sections
    }

    fn pad_to_align(&mut self) -> io::Result<()> {
        let pad = (SECTION_ALIGN - self.pos % SECTION_ALIGN) % SECTION_ALIGN;
        if pad > 0 {
            self.w
                .write_all(&[0u8; SECTION_ALIGN as usize][..pad as usize])?;
            self.pos += pad;
        }
        Ok(())
    }

    /// Append a section whose bytes are already in memory.
    pub fn write_section(&mut self, kind: SectionKind, payload: &[u8]) -> io::Result<()> {
        self.write_section_with(kind, |w| w.write_all(payload))
    }

    /// Append a section written by `body`, counting its bytes as it goes.
    ///
    /// The closure takes `&mut dyn Write` on purpose: a section body is
    /// written once, by a builder that does not care what it is writing to,
    /// and the dynamic dispatch is per `write` call on an already-buffered
    /// writer.
    pub fn write_section_with<F>(&mut self, kind: SectionKind, body: F) -> io::Result<()>
    where
        F: FnOnce(&mut dyn Write) -> io::Result<()>,
    {
        self.pad_to_align()?;
        let offset = self.pos;
        let mut counting = Counting {
            inner: &mut self.w,
            written: 0,
        };
        body(&mut counting)?;
        let len = counting.written;
        self.pos += len;
        self.sections.push(SectionEntry { kind, offset, len });
        Ok(())
    }

    /// Write the section table and the real header, and hand back the inner
    /// writer (so the caller can `sync_all` before publishing).
    pub fn finish(
        mut self,
        chart_set: ChartSetIdentity,
        versions: ArtifactVersions,
    ) -> io::Result<W> {
        let section_count = u32::try_from(self.sections.len()).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "too many sections for a u32 count",
            )
        })?;
        self.pad_to_align()?;
        let section_table_offset = self.pos;
        for entry in &self.sections {
            self.w.write_all(&entry.to_bytes())?;
        }
        self.pos += u64::from(section_count) * SECTION_ENTRY_LEN as u64;

        let header = FileHeader {
            chart_set,
            versions,
            section_table_offset,
            section_count,
        };
        self.w.seek(SeekFrom::Start(0))?;
        self.w.write_all(&header.to_bytes())?;
        self.w.flush()?;
        Ok(self.w)
    }
}

/// Write a `.mivnav` artifact to `path` atomically.
///
/// The artifact is written to a temporary file **in the target directory**
/// (so the rename stays within one filesystem), `sync_all`'d, and renamed
/// over `path`. A concurrent reader holding the old file open — the backend
/// keeps the artifact mmapped — keeps the old inode and never sees a
/// truncated or half-written file. Writing in place would yank pages out
/// from under it: a page access past the new EOF is a SIGBUS, which no
/// error handling in the reader can catch.
///
/// Same skeleton as [`crate::pmtiles::write_archive_to_path`], which is the
/// repo's one settled convention for publishing a large derived artifact;
/// only the inner writing differs.
pub fn write_artifact_atomically<F>(
    path: &Path,
    chart_set: ChartSetIdentity,
    versions: ArtifactVersions,
    write_body: F,
) -> io::Result<()>
where
    F: FnOnce(&mut ArtifactWriter<io::BufWriter<std::fs::File>>) -> io::Result<()>,
{
    let file_name = path.file_name().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "output path has no file name")
    })?;
    let mut tmp = PathBuf::from(path);
    // same directory, so the rename stays within one filesystem
    tmp.set_file_name(format!(
        ".{}.tmp.{}",
        file_name.to_string_lossy(),
        std::process::id()
    ));
    let result = (|| {
        let mut writer = ArtifactWriter::new(io::BufWriter::new(std::fs::File::create(&tmp)?))?;
        write_body(&mut writer)?;
        let buffered = writer.finish(chart_set, versions)?;
        // flush and sync before the rename makes it visible: a reader must
        // never be able to open a complete-looking but unwritten file
        buffered
            .into_inner()
            .map_err(io::IntoInnerError::into_error)?
            .sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/// A parsed `.mivnav` artifact: the header and section table, plus the
/// bytes the sections point into.
///
/// Byte ownership follows [`crate::pmtiles::Archive`] — [`from_file`] reads
/// the file and owns the buffer, [`from_bytes`] takes an owned one — with
/// one addition it does not need: [`from_slice`] borrows bytes the caller
/// already has mapped. §15 mandates the artifact be memory-mapped, and
/// chartcore has no mmap dependency (the backend maps files today), so the
/// borrowed constructor is the seam that costs nothing now and needs no
/// second reader type later. `Cow` keeps both in one type.
///
/// [`from_file`]: ArtifactReader::from_file
/// [`from_bytes`]: ArtifactReader::from_bytes
/// [`from_slice`]: ArtifactReader::from_slice
pub struct ArtifactReader<'a> {
    data: Cow<'a, [u8]>,
    header: FileHeader,
    sections: Vec<SectionEntry>,
}

impl fmt::Debug for ArtifactReader<'_> {
    /// Never prints the payload — an artifact is gigabytes (§5.3).
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ArtifactReader")
            .field("bytes", &self.data.len())
            .field("header", &self.header)
            .field("sections", &self.sections)
            .finish()
    }
}

impl ArtifactReader<'static> {
    /// Read and parse a whole artifact file.
    pub fn from_file(path: &Path) -> Result<ArtifactReader<'static>, FormatError> {
        ArtifactReader::from_bytes(std::fs::read(path)?)
    }

    /// Parse an owned buffer.
    pub fn from_bytes(data: Vec<u8>) -> Result<ArtifactReader<'static>, FormatError> {
        ArtifactReader::new(Cow::Owned(data))
    }
}

impl<'a> ArtifactReader<'a> {
    /// Parse bytes the caller already holds — an mmap, a test fixture, a
    /// slice of a larger buffer. No copy.
    pub fn from_slice(data: &'a [u8]) -> Result<ArtifactReader<'a>, FormatError> {
        ArtifactReader::new(Cow::Borrowed(data))
    }

    fn new(data: Cow<'a, [u8]>) -> Result<ArtifactReader<'a>, FormatError> {
        let header = FileHeader::parse(&data)?;
        let total = data.len() as u64;
        let count = u64::from(header.section_count);
        let table_len = count
            .checked_mul(SECTION_ENTRY_LEN as u64)
            .ok_or_else(|| format_err("section table length overflows"))?;
        let table_end = header
            .section_table_offset
            .checked_add(table_len)
            .ok_or_else(|| format_err("section table end overflows"))?;
        if header.section_table_offset < HEADER_LEN as u64 || table_end > total {
            return Err(format_err(format!(
                "section table [{}, {}) outside file of {} bytes",
                header.section_table_offset, table_end, total
            )));
        }
        let table_start = header.section_table_offset as usize;
        let mut sections = Vec::with_capacity(header.section_count as usize);
        for i in 0..header.section_count as usize {
            let at = table_start + i * SECTION_ENTRY_LEN;
            let entry = SectionEntry::parse(&data[at..at + SECTION_ENTRY_LEN]);
            // Bounds are checked for EVERY entry, including kinds this
            // build does not know: skipping an unknown section means
            // trusting its offset/len, so they must be sane even though
            // nothing here will ever look inside it.
            let end = entry
                .offset
                .checked_add(entry.len)
                .ok_or_else(|| format_err("section extent overflows"))?;
            if entry.offset < HEADER_LEN as u64 || end > total {
                return Err(format_err(format!(
                    "section {:?} [{}, {}) outside file of {} bytes",
                    entry.kind, entry.offset, end, total
                )));
            }
            sections.push(entry);
        }
        Ok(ArtifactReader {
            data,
            header,
            sections,
        })
    }

    pub fn header(&self) -> &FileHeader {
        &self.header
    }

    /// Every section in the table, in file order, including kinds this
    /// build does not recognise.
    pub fn sections(&self) -> impl Iterator<Item = SectionEntry> + '_ {
        self.sections.iter().copied()
    }

    /// The bytes of the first section of `kind`, or `None`.
    ///
    /// First-wins on a duplicated kind: a reader treating a repeat as a
    /// hard error would break the forward compatibility the rest of this
    /// file is built around.
    ///
    /// **Not for the per-band kinds.** [`SectionKind::Components`],
    /// [`SectionKind::Portals`] and [`SectionKind::Topology`] are written
    /// once per band, so this would hand back whichever band happens to sit
    /// earliest in the table — a 15 m band's connectivity answering a 1 m
    /// question, silently. Use [`find_band_section`](Self::find_band_section).
    pub fn find_section(&self, kind: SectionKind) -> Option<&[u8]> {
        self.sections
            .iter()
            .find(|e| e.kind == kind)
            .map(|e| self.section_bytes(*e))
    }

    /// Every per-band section of `kind`, in file order, paired with the
    /// [`BandTag`] read off its own payload.
    ///
    /// A section of `kind` whose payload is too short to carry a tag is
    /// SKIPPED, not an error: a truncated or foreign payload is exactly
    /// the case this module refuses to panic on, and a caller asking for
    /// "the 3 m band" wants the answer "not present", not an unopenable
    /// file. The payload handed back INCLUDES its tag — the per-kind
    /// decoders ([`super::portals::decode_portals`] &c.) parse the whole
    /// payload, so no caller ever holds a half-stripped slice that would
    /// silently misparse if passed to the wrong function.
    pub fn band_sections(&self, kind: SectionKind) -> impl Iterator<Item = (BandTag, &[u8])> + '_ {
        self.sections
            .iter()
            .filter(move |e| e.kind == kind)
            .filter_map(|e| {
                let bytes = self.section_bytes(*e);
                Some((BandTag::parse(bytes)?, bytes))
            })
    }

    /// The payload of the per-band section of `kind` tagged `band_index`,
    /// or `None`.
    ///
    /// First-wins on a duplicate, matching [`find_section`](Self::find_section).
    /// Only `band_index` is matched here; the tag's `band_dm` is checked
    /// against this build's own ladder one layer up, in
    /// [`super::persist::load_band`], which is where an error can name both
    /// values.
    pub fn find_band_section(&self, kind: SectionKind, band_index: u8) -> Option<&[u8]> {
        self.band_sections(kind)
            .find(|(tag, _)| tag.band_index == band_index)
            .map(|(_, bytes)| bytes)
    }

    /// The bytes of an entry from [`sections`](Self::sections). Infallible:
    /// every entry's extent was validated at parse time.
    pub fn section_bytes(&self, entry: SectionEntry) -> &[u8] {
        &self.data[entry.offset as usize..(entry.offset + entry.len) as usize]
    }

    /// Which version components differ from this build's
    /// [`ArtifactVersions::CURRENT`]. Empty means compatible.
    pub fn version_mismatches(&self) -> Vec<VersionMismatch> {
        self.header.versions.mismatches(&ArtifactVersions::CURRENT)
    }

    /// Whether this artifact may be used for `chart_set` at `versions`, and
    /// if not, precisely why (§19). `None` means usable.
    pub fn staleness(
        &self,
        chart_set: ChartSetIdentity,
        versions: &ArtifactVersions,
    ) -> Option<Staleness> {
        if self.header.chart_set.id_hash != chart_set.id_hash {
            return Some(Staleness::ChartSet {
                expected: chart_set.id_hash,
                found: self.header.chart_set.id_hash,
            });
        }
        if self.header.chart_set.sequence != chart_set.sequence {
            return Some(Staleness::Sequence {
                expected: chart_set.sequence,
                found: self.header.chart_set.sequence,
            });
        }
        let mismatches = self.header.versions.mismatches(versions);
        if mismatches.is_empty() {
            None
        } else {
            Some(Staleness::Versions(mismatches))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    /// Temporary directory that cleans up on drop (no tempfile dependency),
    /// same helper shape as `pmtiles`' tests.
    struct TestDir(PathBuf);
    impl TestDir {
        fn new(tag: &str) -> TestDir {
            let dir =
                std::env::temp_dir().join(format!("chartcore-mivnav-{tag}-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            TestDir(dir)
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A tag no current build knows — stands in for a section kind added by
    /// a FUTURE chartcore, read by this one.
    const FUTURE_TAG: u32 = 0x7f00_0001;

    fn identity() -> ChartSetIdentity {
        ChartSetIdentity::new("oc-de-2026", 1_755_000_000)
    }

    /// Build an in-memory artifact with a known section, a future-tagged
    /// one, and another known one after it.
    fn sample_bytes() -> Vec<u8> {
        let mut buf = io::Cursor::new(Vec::new());
        let mut w = ArtifactWriter::new(&mut buf).unwrap();
        w.write_section(SectionKind::TileIndex, b"tile index bytes")
            .unwrap();
        w.write_section(SectionKind::Unknown(FUTURE_TAG), b"from a newer build")
            .unwrap();
        w.write_section_with(SectionKind::Flags, |out| {
            out.write_all(&[FLAG_LAND, FLAG_HARD_HAZARD, FLAG_VECTOR_REQUIRED])
        })
        .unwrap();
        w.finish(identity(), ArtifactVersions::CURRENT).unwrap();
        buf.into_inner()
    }

    #[test]
    fn header_round_trips_through_bytes() {
        let header = FileHeader {
            chart_set: identity(),
            versions: ArtifactVersions {
                schema_version: 1,
                derivation_version: 2,
                authority_version: 3,
                band_ladder_version: 4,
                resolution_policy_version: 5,
            },
            section_table_offset: 4096,
            section_count: 7,
        };
        let bytes = header.to_bytes();
        assert_eq!(bytes.len(), HEADER_LEN);
        assert_eq!(&bytes[..8], MAGIC);
        assert_eq!(FileHeader::parse(&bytes).unwrap(), header);
    }

    #[test]
    fn sections_round_trip_and_unknown_kinds_are_skippable() {
        let bytes = sample_bytes();
        let a = ArtifactReader::from_slice(&bytes).unwrap();

        assert_eq!(a.header().chart_set, identity());
        assert_eq!(a.header().versions, ArtifactVersions::CURRENT);
        assert_eq!(a.header().section_count, 3);

        // The known sections read back byte-for-byte...
        assert_eq!(
            a.find_section(SectionKind::TileIndex).unwrap(),
            b"tile index bytes"
        );
        assert_eq!(
            a.find_section(SectionKind::Flags).unwrap(),
            &[FLAG_LAND, FLAG_HARD_HAZARD, FLAG_VECTOR_REQUIRED]
        );
        // ...a kind this build never writes is simply absent...
        assert!(a.find_section(SectionKind::Portals).is_none());
        // ...and the unrecognised one is enumerable, skippable by
        // offset/len, and does not stop the sections after it being read.
        let kinds: Vec<SectionKind> = a.sections().map(|e| e.kind).collect();
        assert_eq!(
            kinds,
            vec![
                SectionKind::TileIndex,
                SectionKind::Unknown(FUTURE_TAG),
                SectionKind::Flags
            ]
        );
        let unknown: Vec<SectionEntry> = a.sections().filter(|e| !e.kind.is_known()).collect();
        assert_eq!(unknown.len(), 1);
        assert_eq!(unknown[0].len, "from a newer build".len() as u64);
        assert_eq!(a.section_bytes(unknown[0]), b"from a newer build");
    }

    #[test]
    fn band_tag_round_trips_and_addresses_one_kind_per_band() {
        let mut buf = io::Cursor::new(Vec::new());
        let mut w = ArtifactWriter::new(&mut buf).unwrap();
        // Three bands of one kind, out of ladder order on purpose: the
        // lookup must match on the TAG, never on table position.
        for (band_index, band_dm) in [(4u8, 30u16), (0, 10), (9, 150)] {
            let mut payload = BandTag {
                band_index,
                band_dm,
            }
            .to_bytes()
            .to_vec();
            payload.push(band_index);
            w.write_section(SectionKind::Portals, &payload).unwrap();
        }
        // ...and one section of the same kind too short to carry a tag,
        // which must be skipped rather than break the enumeration.
        w.write_section(SectionKind::Portals, b"tiny").unwrap();
        w.finish(identity(), ArtifactVersions::CURRENT).unwrap();
        let bytes = buf.into_inner();
        let a = ArtifactReader::from_slice(&bytes).unwrap();

        let tags: Vec<BandTag> = a
            .band_sections(SectionKind::Portals)
            .map(|(t, _)| t)
            .collect();
        assert_eq!(
            tags,
            vec![
                BandTag {
                    band_index: 4,
                    band_dm: 30
                },
                BandTag {
                    band_index: 0,
                    band_dm: 10
                },
                BandTag {
                    band_index: 9,
                    band_dm: 150
                },
            ],
            "the untagged short section must be skipped, the rest kept in file order"
        );

        for band_index in [0u8, 4, 9] {
            let payload = a
                .find_band_section(SectionKind::Portals, band_index)
                .unwrap();
            assert_eq!(
                BandTag::parse(payload).unwrap().band_index,
                band_index,
                "find_band_section must return the payload it was asked for"
            );
            assert_eq!(
                payload.last(),
                Some(&band_index),
                "payload must be handed back WHOLE, tag included"
            );
        }
        // `find_section` is the WRONG tool here and this pins why: it
        // hands back band 4 no matter which band you wanted.
        assert_eq!(
            BandTag::parse(a.find_section(SectionKind::Portals).unwrap())
                .unwrap()
                .band_index,
            4
        );
        // A band nobody wrote, and a kind nobody wrote, are both absent
        // rather than a wrong answer.
        assert!(a.find_band_section(SectionKind::Portals, 7).is_none());
        assert!(a.find_band_section(SectionKind::Components, 4).is_none());
        assert_eq!(a.band_sections(SectionKind::Components).count(), 0);
    }

    #[test]
    fn a_band_tag_never_panics_on_a_short_or_garbage_payload() {
        for len in 0..BAND_TAG_LEN {
            assert_eq!(BandTag::parse(&vec![0xAB; len]), None);
        }
        // Reserved bytes are ignored, not rejected — a newer build may
        // put something there.
        let mut b = BandTag {
            band_index: 3,
            band_dm: 25,
        }
        .to_bytes();
        b[1] = 0xFF;
        b[4..8].copy_from_slice(&0xDEAD_BEEFu32.to_le_bytes());
        assert_eq!(
            BandTag::parse(&b).unwrap(),
            BandTag {
                band_index: 3,
                band_dm: 25
            }
        );
    }

    #[test]
    fn section_payloads_are_eight_byte_aligned() {
        let bytes = sample_bytes();
        let a = ArtifactReader::from_slice(&bytes).unwrap();
        for e in a.sections() {
            assert_eq!(e.offset % 8, 0, "section {:?} misaligned", e.kind);
            assert!(e.offset >= HEADER_LEN as u64);
        }
        assert_eq!(a.header().section_table_offset % 8, 0);
    }

    #[test]
    fn section_kind_tags_round_trip() {
        let all = [
            SectionKind::TileIndex,
            SectionKind::DepthMin,
            SectionKind::DepthMax,
            SectionKind::Flags,
            SectionKind::BoundaryStitch,
            SectionKind::Semantics,
            SectionKind::Components,
            SectionKind::Portals,
            SectionKind::Topology,
            SectionKind::Landmarks,
            SectionKind::SourceRefs,
            SectionKind::HazardRings,
            SectionKind::Unknown(FUTURE_TAG),
        ];
        for k in all {
            assert_eq!(SectionKind::from_tag(k.tag()), k);
        }
        // tags are distinct
        let mut tags: Vec<u32> = all.iter().map(|k| k.tag()).collect();
        tags.sort_unstable();
        tags.dedup();
        assert_eq!(tags.len(), all.len());
        // an unknown tag never impersonates a known kind
        assert!(!SectionKind::from_tag(FUTURE_TAG).is_known());
        assert!(SectionKind::from_tag(1).is_known());
    }

    #[test]
    fn garbage_is_rejected_by_magic() {
        let mut bad = vec![0u8; 512];
        bad[..8].copy_from_slice(b"PMTiles\0");
        let err = ArtifactReader::from_slice(&bad).unwrap_err();
        assert!(
            matches!(err, FormatError::Format(ref m) if m.contains("magic")),
            "{err}"
        );

        // a truncated file is a format error, not a panic
        let bytes = sample_bytes();
        let err = ArtifactReader::from_slice(&bytes[..HEADER_LEN - 1]).unwrap_err();
        assert!(
            matches!(err, FormatError::Format(ref m) if m.contains("truncated")),
            "{err}"
        );
    }

    #[test]
    fn out_of_bounds_section_extents_are_rejected() {
        // Point the last section entry past EOF: the reader must refuse the
        // file rather than hand out a slice it cannot back.
        let mut bytes = sample_bytes();
        let table = FileHeader::parse(&bytes).unwrap().section_table_offset as usize;
        let len_at = table + 2 * SECTION_ENTRY_LEN + 16;
        bytes[len_at..len_at + 8].copy_from_slice(&u64::MAX.to_le_bytes());
        assert!(ArtifactReader::from_slice(&bytes).is_err());

        // ...and so is a section table that does not fit.
        let mut bytes = sample_bytes();
        bytes[52..56].copy_from_slice(&1000u32.to_le_bytes());
        assert!(ArtifactReader::from_slice(&bytes).is_err());
    }

    #[test]
    fn version_mismatch_names_the_component_that_differs() {
        let file = ArtifactVersions {
            derivation_version: ArtifactVersions::CURRENT.derivation_version + 1,
            ..ArtifactVersions::CURRENT
        };
        let m = file.mismatches(&ArtifactVersions::CURRENT);
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].component, VersionComponent::Derivation);
        assert_eq!(m[0].found, ArtifactVersions::CURRENT.derivation_version + 1);
        assert_eq!(m[0].expected, ArtifactVersions::CURRENT.derivation_version);
        assert!(m[0].to_string().contains("derivation"));

        // several at once, in a stable order
        let file = ArtifactVersions {
            schema_version: 9,
            band_ladder_version: 9,
            ..ArtifactVersions::CURRENT
        };
        let names: Vec<&str> = file
            .mismatches(&ArtifactVersions::CURRENT)
            .iter()
            .map(|m| m.component.name())
            .collect();
        assert_eq!(names, vec!["schema", "band_ladder"]);

        // identical versions are compatible
        assert!(ArtifactVersions::CURRENT
            .mismatches(&ArtifactVersions::CURRENT)
            .is_empty());
    }

    #[test]
    fn staleness_reports_chart_set_sequence_and_versions_separately() {
        let bytes = sample_bytes();
        let a = ArtifactReader::from_slice(&bytes).unwrap();
        let cs = identity();

        assert_eq!(a.staleness(cs, &ArtifactVersions::CURRENT), None);
        assert!(a.version_mismatches().is_empty());

        // a different chart set
        let other = ChartSetIdentity::new("oc-dk-2026", cs.sequence);
        assert!(matches!(
            a.staleness(other, &ArtifactVersions::CURRENT),
            Some(Staleness::ChartSet { .. })
        ));

        // same set, charts changed underneath (backend cs.sequence moved)
        let bumped = ChartSetIdentity {
            sequence: cs.sequence + 1,
            ..cs
        };
        assert!(matches!(
            a.staleness(bumped, &ArtifactVersions::CURRENT),
            Some(Staleness::Sequence {
                expected,
                found,
            }) if expected == cs.sequence + 1 && found == cs.sequence
        ));

        // same set and sequence, but the pipeline moved: THIS is the
        // "boat serves yesterday's routes forever" case (§19), and the
        // report has to name the stage, not just say "stale".
        let newer = ArtifactVersions {
            authority_version: ArtifactVersions::CURRENT.authority_version + 1,
            ..ArtifactVersions::CURRENT
        };
        let Some(Staleness::Versions(v)) = a.staleness(cs, &newer) else {
            panic!("expected a version staleness");
        };
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].component, VersionComponent::Authority);
        assert!(Staleness::Versions(v).to_string().contains("authority"));
    }

    #[test]
    fn chart_set_id_hash_is_stable_and_distinguishes_sets() {
        // pinned so a future refactor cannot silently change the hash and
        // invalidate every artifact on the boat without a version bump
        assert_eq!(chart_set_id_hash(""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(chart_set_id_hash("a"), 0xaf63_dc4c_8601_ec8c);
        assert_ne!(
            chart_set_id_hash("oc-de-2026"),
            chart_set_id_hash("oc-dk-2026")
        );
    }

    #[test]
    fn empty_artifact_round_trips() {
        let mut buf = io::Cursor::new(Vec::new());
        let w = ArtifactWriter::new(&mut buf).unwrap();
        assert!(w.sections().is_empty());
        w.finish(identity(), ArtifactVersions::CURRENT).unwrap();
        let bytes = buf.into_inner();
        let a = ArtifactReader::from_slice(&bytes).unwrap();
        assert_eq!(a.header().section_count, 0);
        assert_eq!(a.sections().count(), 0);
        assert!(a.find_section(SectionKind::TileIndex).is_none());
    }

    /// The publish contract: a rebuild must replace the file without
    /// touching a reader that already has the old one open/mmapped —
    /// same regression `pmtiles::write_archive_to_path` exists for
    /// (an in-place rewrite is a SIGBUS in the backend, not an error).
    #[test]
    fn atomic_publish_leaves_open_readers_on_the_old_inode() {
        let dir = TestDir::new("atomic-publish");
        let path = dir.0.join("charts.mivnav");

        write_artifact_atomically(&path, identity(), ArtifactVersions::CURRENT, |w| {
            w.write_section(SectionKind::TileIndex, b"v1")
        })
        .unwrap();
        let v1 = std::fs::read(&path).unwrap();
        assert_eq!(&v1[..8], MAGIC);

        // a reader holds the artifact open (the backend holds a long-lived mmap)
        let mut open_reader = std::fs::File::open(&path).unwrap();

        let v2_identity = ChartSetIdentity {
            sequence: identity().sequence + 1,
            ..identity()
        };
        write_artifact_atomically(&path, v2_identity, ArtifactVersions::CURRENT, |w| {
            w.write_section(SectionKind::TileIndex, b"version two, rather longer")
        })
        .unwrap();

        // the open reader still sees the complete old artifact...
        let mut seen = Vec::new();
        open_reader.read_to_end(&mut seen).unwrap();
        assert_eq!(seen, v1, "open reader must keep the old inode");
        assert_eq!(
            ArtifactReader::from_bytes(seen)
                .unwrap()
                .find_section(SectionKind::TileIndex)
                .unwrap(),
            b"v1"
        );

        // ...while a fresh open sees the new one, with no temp file left behind
        let fresh = ArtifactReader::from_file(&path).unwrap();
        assert_eq!(fresh.header().chart_set, v2_identity);
        assert_eq!(
            fresh.find_section(SectionKind::TileIndex).unwrap(),
            b"version two, rather longer"
        );
        let leftovers: Vec<_> = std::fs::read_dir(&dir.0)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .filter(|n| n.to_string_lossy().starts_with('.'))
            .collect();
        assert!(
            leftovers.is_empty(),
            "temp files left behind: {leftovers:?}"
        );
    }

    /// A failing body must not publish a half-built artifact, and must not
    /// leave its temp file behind either.
    #[test]
    fn failed_write_publishes_nothing() {
        let dir = TestDir::new("failed-publish");
        let path = dir.0.join("charts.mivnav");
        let err = write_artifact_atomically(&path, identity(), ArtifactVersions::CURRENT, |w| {
            w.write_section(SectionKind::TileIndex, b"partial")?;
            Err(io::Error::other("build blew up"))
        })
        .unwrap_err();
        assert_eq!(err.to_string(), "build blew up");
        assert!(!path.exists());
        assert_eq!(std::fs::read_dir(&dir.0).unwrap().count(), 0);
    }

    #[test]
    fn cell_payload_flag_bits_are_distinct_and_cover_one_byte() {
        let all = [
            FLAG_LAND,
            FLAG_HARD_HAZARD,
            FLAG_NO_COVERAGE,
            FLAG_OVERHEAD,
            FLAG_FAIRWAY,
            FLAG_TSS,
            FLAG_RESTRICTED,
            FLAG_VECTOR_REQUIRED,
        ];
        let mut union = 0u8;
        for f in all {
            assert_eq!(f.count_ones(), 1);
            assert_eq!(union & f, 0, "duplicate flag bit {f:#04x}");
            union |= f;
        }
        assert_eq!(union, 0xFF);
        // the no-coverage sentinel is not a plausible real depth
        assert_eq!(DEPTH_NO_COVERAGE, u16::MAX);
    }
}
