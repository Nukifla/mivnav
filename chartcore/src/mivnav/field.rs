// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! §4 and §5.1 — the persisted spatial field: the tile lattice, the
//! per-tile resolution choice, and the SoA cell payload rasterized onto
//! it.
//!
//! Three things live here, in the order the build pipeline
//! ([`super::build`]) uses them:
//!
//! 1. **The lattice.** [`RegionLattice`] fixes one integer world-unit
//!    cell size per §4.2 ladder rung for a whole region, and
//!    [`TileEntry`] is one tile on it: a world-space origin, a rung, and
//!    `cols`/`rows` (always [`TILE_CELLS`] square, see below).
//! 2. **[`choose_tile_resolution`]** — §4.1's `finest_allowed_cell` as
//!    the floor, escalated by the §4.3 refinement triggers actually found
//!    inside the tile, and recording WHICH trigger fired (§18's
//!    resolution overlay needs that, not just the rung).
//! 3. **[`rasterize_tile`]** — §5.1's `depth_min`/`depth_max`/`flags`
//!    payload, with §4.4's supercover rasterization of thin blocking
//!    features and its `VECTOR_REQUIRED` escalation.
//!
//! # The §5.1 constants are `format`'s, not this module's
//!
//! [`DEPTH_NO_COVERAGE`], [`DEPTH_UNIT_DM_PER_M`] and every `FLAG_*` bit
//! are defined in [`super::format`] and used verbatim here. They are part
//! of the *file* contract — a reader that disagrees with this writer
//! about bit 5 does not fail, it silently routes through a traffic
//! separation scheme. There is exactly one definition of each.
//!
//! # Judgment calls (stated, per this tree's convention)
//!
//! * **Tile size is a fixed CELL COUNT, not a fixed ground extent**
//!   ([`TILE_CELLS`] = 256, a build-time decision already taken in the
//!   plan). Per-tile byte cost is then roughly uniform across the ladder
//!   — 256×256×5 B ≈ 327 KB whether the tile covers 512 m or 262 km of
//!   ground — which is what makes an mmap'd artifact's page behaviour
//!   predictable. The cost is that tile EXTENT depends on the resolution
//!   choice, which depends on what is inside the extent; [`super::build`]
//!   resolves that circularity and documents how.
//!
//! * **Every rung's cell size is a power-of-two multiple of the finest
//!   one, fixed for the whole region.** [`RegionLattice`] derives ONE
//!   base cell size in world units from the region's own centre latitude
//!   and doubles it up the ladder, rather than converting each rung's
//!   metres to world units at each tile's own latitude. Two consequences
//!   the artifact depends on: a coarse tile's cell boundaries always fall
//!   on a fine tile's cell boundaries (so §4.2's stitch table is exact
//!   power-of-two runs, see [`super::stitch`]), and a coarse tile's
//!   origin is always on every finer lattice (so the tiling is a true
//!   quadtree partition with no overlaps and no gaps). Deriving cell size
//!   per tile would break both for a few world units of latitude
//!   accuracy that §4.1's own ladder does not claim.
//!
//! * **Open water outside every §4.3 trigger stays at 1024 m**
//!   ([`OPEN_WATER_CELL_M`]), the coarsest rung. §4.3 says "256 m or
//!   coarser" and licenses either; 1024 m is chosen because a tile that
//!   reaches this branch has been *proven* to contain none of the eight
//!   triggers over its whole extent, so there is nothing in it for a
//!   finer grid to resolve, and every tile saved here is one fewer node
//!   in Phase 3's per-band component sweep and one fewer row in the tile
//!   index. The floor still applies: a tile never goes coarser than
//!   §4.1's answer only because §4.1's answer is itself never coarser
//!   than 1024 m (`snap_up_to_ladder` caps there).
//!
//! * **Depth VALUES are extracted here, separately from the hazard
//!   CLASSIFICATION.** `routing::artifact::constraints::build` answers
//!   "is this blocked at `required_depth_m`" — a *vessel* question. §6
//!   forbids the artifact from knowing the vessel, so the build calls it
//!   at `required_depth_m = 0.0` (which yields exactly the
//!   boat-independent geometry: land, constructions, foul ground, hazards
//!   of unknown depth — all of which block regardless of draft) and this
//!   module separately reads `DEPARE`/`DRGARE`/`SOUNDG` for the raw
//!   charted numbers that go in `depth_min`/`depth_max`. §10.4: "the
//!   artifact stores the physical facts (`depth_min`, `depth_max`) needed
//!   to evaluate an arbitrary curve cheaply".
//!
//! * **The scanline fill and the supercover walk are `routing::artifact`'s
//!   own**, reached through `pub(crate)` rather than copied:
//!   [`scanline_spans`](crate::routing::artifact::search::scanline_spans)
//!   for area fill and
//!   [`Supercover`](crate::routing::artifact::search::Supercover) for
//!   §4.4. A second, subtly different copy of either is the specific
//!   failure §4.4 warns about — the two would disagree about one diagonal
//!   barrier and nothing would say so.

use crate::coords::{Extent, WorldXy};
use crate::coverage::signed_area2_world;
use crate::model::{AttrValue, Cell, Feature, Geometry};
use crate::routing::artifact::constraints::{
    self, slcons_blocks, AIR_DRAFT_CLASSES, DEPTH_AREA_CLASSES, DEPTH_HAZARD_CLASSES,
    ENTRY_RESTRICTABLE_CLASSES, PREFERRED_ROUTE_CLASSES, RESTRICTED_ENTRY_CLASSES,
    STRUCTURE_BLOCK_CLASSES, TSS_AVOID_CLASSES,
};
use crate::routing::artifact::ladder::finest_allowed_cell_m;
use crate::routing::artifact::ladder::{snap_up_to_ladder, RESOLUTION_LADDER_M};
use crate::routing::artifact::search::{scanline_spans, Supercover, SupercoverEnd};
use crate::routing::artifact::{ArtifactConstraints, ConstraintParams};
use crate::routing::hazards::{radius_world_units, world_distance_m};

use super::format::{
    DEPTH_NO_COVERAGE, DEPTH_UNIT_DM_PER_M, FLAG_FAIRWAY, FLAG_HARD_HAZARD, FLAG_LAND,
    FLAG_NO_COVERAGE, FLAG_OVERHEAD, FLAG_RESTRICTED, FLAG_TSS, FLAG_VECTOR_REQUIRED,
};

// ---------------------------------------------------------------------------
// Build-time constants
// ---------------------------------------------------------------------------

/// Cells per tile edge. Fixed for every ladder rung — see the module
/// docs' first judgment call. A change here is a
/// `resolution_policy_version` bump (`ArtifactVersions`).
pub const TILE_CELLS: u32 = 256;

/// §7.1's band ladder, metres. Phase 2 reads it only for §4.3's
/// depth-band refinement trigger; Phase 3 builds a connected-component
/// product per entry, in this order, and the artifact's
/// `band_ladder_version` covers both uses.
pub const BAND_LADDER_M: [f64; 10] = [1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 7.0, 10.0, 15.0];

/// §4.3's "SOUNDG cluster" threshold: strictly MORE than this many
/// soundings inside one tile counts as a cluster and refines it.
///
/// A Phase-0-style tuning knob with no evidence behind it yet — §4.3
/// says "a SOUNDG cluster" and names no number, and §20 lists "area per
/// ladder level" among the figures a real build run is supposed to
/// produce precisely so thresholds like this stop being guesses. Five is
/// low enough that any surveyed channel trips it and high enough that a
/// stray offshore sounding does not.
pub const SOUNDG_CLUSTER_MIN: usize = 5;

/// The rung a tile with no §4.3 trigger at all settles on — the ladder's
/// coarsest. See the module docs' third judgment call.
pub const OPEN_WATER_CELL_M: f64 = RESOLUTION_LADDER_M[RESOLUTION_LADDER_M.len() - 1];

// ---------------------------------------------------------------------------
// §4.3 refinement triggers
// ---------------------------------------------------------------------------

/// Coastline, `SLCONS`, or any §3.3 blocking LINE feature.
pub const TRIGGER_BLOCKING_LINE: u32 = 1 << 0;
/// A depth transition crossing any §7.1 band threshold.
pub const TRIGGER_DEPTH_BAND: u32 = 1 << 1;
/// `FAIRWY`, `RECTRC`, `NAVLNE`, `DWRTPT`.
pub const TRIGGER_PREFERRED_ROUTE: u32 = 1 << 2;
/// `WRECKS`, `OBSTRN`, `UWTROC`, or a `SOUNDG` cluster.
pub const TRIGGER_HAZARD: u32 = 1 << 3;
/// `BRIDGE`, `CBLOHD`, `PIPOHD`, `CONVYR`.
pub const TRIGGER_OVERHEAD: u32 = 1 << 4;
/// A TSS boundary crossing this tile's own edge — not mere presence
/// inside it, which would refine the whole interior of a scheme for no
/// gain (the direction rule lives on transitions, §11, not on cells).
pub const TRIGGER_TSS_BOUNDARY: u32 = 1 << 5;
/// §4.3's "free-water width below 200 m". **Not implemented in Phase 2**
/// — reserved so the bit position is fixed before anything ships.
///
// TODO Phase 3/5: §4.3's "free-water width below 200 m" needs a distance
// transform over already-classified free water, which does not exist
// until the raster is built (this pass) and, to be useful across tile
// seams, until §4.2's stitch table is consumed by the component sweep.
// The natural home is the same targeted second pass the topology
// bottleneck trigger below needs, reusing
// `routing::raster::distance_field::DistanceField` rather than a second
// Felzenszwalb–Huttenlocher implementation.
pub const TRIGGER_NARROW_WATER: u32 = 1 << 6;
/// §4.3's "a topology bottleneck identified in §8". **Not implemented in
/// Phase 2** — reserved so the bit position is fixed before anything
/// ships.
///
// Phase 3 will add a second, targeted pass here — see the plan's Phase 2
// bullet on the two-pass build: coarse components first, then
// re-rasterize only the tiles whose components meet at a bottleneck.
// §20's pipeline lists the build as one linear pass and it is not; that
// discrepancy is deliberate and recorded rather than papered over with a
// stub that silently does nothing.
pub const TRIGGER_TOPOLOGY_BOTTLENECK: u32 = 1 << 7;

/// Not a §4.3 trigger at all — [`super::build`]'s own bookkeeping bit,
/// living in this same bitmask because it answers the identical §18
/// question ("why is this tile as fine as it is") for the one case none
/// of the eight real triggers can: a leaf whose OWN extent contains no
/// trigger, but which still landed at a fine rung because a SIBLING
/// inside the same parent split needed it (the "no re-coarsening"
/// judgment call in [`super::build`]'s module docs). Without this bit
/// such a leaf's `triggers` reads `0` — indistinguishable from ordinary
/// open water — which is exactly the misleading "no reason" a resolution
/// overlay must not show.
pub const TRIGGER_INHERITED_FROM_SPLIT: u32 = 1 << 8;

/// The triggers Phase 2 actually evaluates.
pub const TRIGGERS_IMPLEMENTED: u32 = TRIGGER_BLOCKING_LINE
    | TRIGGER_DEPTH_BAND
    | TRIGGER_PREFERRED_ROUTE
    | TRIGGER_HAZARD
    | TRIGGER_OVERHEAD
    | TRIGGER_TSS_BOUNDARY;

/// Stable names for §18's resolution overlay ("which §4.3 trigger caused
/// it"), lowest bit first.
pub fn trigger_names(mask: u32) -> Vec<&'static str> {
    [
        (TRIGGER_BLOCKING_LINE, "blocking_line"),
        (TRIGGER_DEPTH_BAND, "depth_band"),
        (TRIGGER_PREFERRED_ROUTE, "preferred_route"),
        (TRIGGER_HAZARD, "hazard"),
        (TRIGGER_OVERHEAD, "overhead"),
        (TRIGGER_TSS_BOUNDARY, "tss_boundary"),
        (TRIGGER_NARROW_WATER, "narrow_water"),
        (TRIGGER_TOPOLOGY_BOTTLENECK, "topology_bottleneck"),
        (TRIGGER_INHERITED_FROM_SPLIT, "inherited_from_split"),
    ]
    .into_iter()
    .filter(|&(bit, _)| mask & bit != 0)
    .map(|(_, name)| name)
    .collect()
}

// ---------------------------------------------------------------------------
// The lattice
// ---------------------------------------------------------------------------

/// One region's world-unit cell size per ladder rung.
///
/// Built once per region from its centre latitude; see the module docs'
/// second judgment call for why it is NOT per tile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RegionLattice {
    /// World units per cell at [`RESOLUTION_LADDER_M`]`[0]` (2 m).
    base_cell_world: i32,
}

impl RegionLattice {
    /// The lattice for `extent`, derived at its centre latitude.
    pub fn for_region(extent: Extent) -> RegionLattice {
        let mid = extent.midpoint();
        let centre = WorldXy::new(mid.x, mid.y);
        let base = radius_world_units(centre, RESOLUTION_LADDER_M[0])
            .round()
            .max(1.0) as i32;
        RegionLattice {
            base_cell_world: base,
        }
    }

    /// World units per cell at ladder `rung` (`0..=8`).
    ///
    /// `RESOLUTION_LADDER_M[rung] / 2` is an exact power of two for every
    /// rung — including the 256 m → 1024 m step, which is a factor of
    /// FOUR rather than two. That is why every ratio in this module is
    /// computed from cell sizes and never from a rung-index difference.
    pub fn cell_world(&self, rung: u8) -> i32 {
        let factor = RESOLUTION_LADDER_M[rung as usize] as i32 / 2;
        self.base_cell_world.saturating_mul(factor)
    }

    /// World units per tile edge at `rung`.
    pub fn tile_world(&self, rung: u8) -> i64 {
        i64::from(self.cell_world(rung)) * i64::from(TILE_CELLS)
    }

    /// A tile of `rung` anchored to the global lattice, containing the
    /// world point `(x, y)`.
    ///
    /// The origin is a multiple of the tile's OWN edge in world units,
    /// which makes the tiling a quadtree partition: a coarse tile's
    /// bounds always coincide with some finer tile's bounds, never cut
    /// across them.
    pub fn tile_at(&self, rung: u8, x: i32, y: i32) -> TileEntry {
        let tw = self.tile_world(rung);
        let ox = i64::from(x).div_euclid(tw) * tw;
        let oy = i64::from(y).div_euclid(tw) * tw;
        TileEntry {
            origin_x: ox as i32,
            origin_y: oy as i32,
            cell_world: self.cell_world(rung),
            rung,
            tile_flags: 0,
            cols: TILE_CELLS as u16,
            rows: TILE_CELLS as u16,
            triggers: 0,
            payload_offset: 0,
        }
    }
}

// ---------------------------------------------------------------------------
// TileEntry
// ---------------------------------------------------------------------------

/// [`TileEntry::tile_flags`] bit 0 — §4.4: some blocking line inside this
/// tile could not be resolved two cells thick even at
/// `finest_allowed_cell`, so §12.4 vector refinement is mandatory for any
/// route entering it.
pub const TILE_FLAG_VECTOR_REQUIRED: u8 = 1 << 0;

/// Serialized size of one [`TileEntry`], bytes.
pub const TILE_ENTRY_LEN: usize = 32;

/// One tile of the spatial field: where it is, how fine it is, and where
/// its cells live in the `DepthMin`/`DepthMax`/`Flags` SoA columns.
///
/// ```text
/// off  len  field
///   0    4  origin_x        i32  world x, a multiple of cols*cell_world
///   4    4  origin_y        i32  world y, likewise
///   8    4  cell_world      i32  world units per cell
///  12    1  rung            u8   index into RESOLUTION_LADDER_M
///  13    1  tile_flags      u8   TILE_FLAG_*
///  14    2  cols            u16
///  16    2  rows            u16
///  18    2  reserved             zero
///  20    4  triggers        u32  §4.3 bitmask that chose `rung`
///  24    8  payload_offset  u64  index of cell (0,0) in the SoA columns
/// ```
///
/// `payload_offset` is a CELL index, not a byte offset: the same number
/// indexes `depth_min[]` (u16), `depth_max[]` (u16) and `flags[]` (u8),
/// which is the whole point of the SoA layout (§15: "a search touching
/// only `depth_min` and `flags` should not pull `depth_max` into cache").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TileEntry {
    pub origin_x: i32,
    pub origin_y: i32,
    pub cell_world: i32,
    pub rung: u8,
    pub tile_flags: u8,
    pub cols: u16,
    pub rows: u16,
    pub triggers: u32,
    pub payload_offset: u64,
}

impl TileEntry {
    /// This tile's cell size in ground metres — the ladder rung itself.
    ///
    /// # Panics
    ///
    /// If `rung` is outside [`RESOLUTION_LADDER_M`]. Never true of a
    /// `TileEntry` this crate's own build pipeline produced, and equally
    /// never CHECKED by [`TileEntry::parse`], which reads `rung` straight
    /// off the file — so any caller walking a DECODED tile index must use
    /// [`Self::cell_size_m_checked`] instead, per this module tree's
    /// standing rule that a corrupted or version-skewed file must not
    /// panic (see [`super::stitch::resolve_run_pair`]'s own docs for the
    /// same rule stated for edge-cell indices).
    pub fn cell_size_m(&self) -> f64 {
        RESOLUTION_LADDER_M[self.rung as usize]
    }

    /// [`Self::cell_size_m`], `None` rather than a panic for a `rung` no
    /// ladder entry exists for. Added for
    /// [`super::portals::detect_portals`], the first consumer to read a
    /// ladder rung off a decoded tile index rather than off one it just
    /// built (§8.2's `min_horizontal_width` needs a real metre-per-cell
    /// figure for its own raster window).
    pub fn cell_size_m_checked(&self) -> Option<f64> {
        RESOLUTION_LADDER_M.get(self.rung as usize).copied()
    }

    pub fn cell_count(&self) -> usize {
        self.cols as usize * self.rows as usize
    }

    /// The tile's world-coordinate bounds. `xmax`/`ymax` are the far
    /// EDGE, i.e. one past the last cell.
    pub fn extent(&self) -> Extent {
        Extent::new(
            self.origin_x,
            self.origin_x
                .saturating_add(i32::from(self.cols).saturating_mul(self.cell_world)),
            self.origin_y,
            self.origin_y
                .saturating_add(i32::from(self.rows).saturating_mul(self.cell_world)),
        )
    }

    /// Row-major index of `(col, row)` within this tile.
    #[inline]
    pub fn index(&self, col: u32, row: u32) -> usize {
        row as usize * self.cols as usize + col as usize
    }

    #[inline]
    pub fn in_range(&self, col: i64, row: i64) -> bool {
        col >= 0 && row >= 0 && col < i64::from(self.cols) && row < i64::from(self.rows)
    }

    /// The cell containing world point `p`, unclamped — `None` when `p`
    /// is outside the tile.
    pub fn cell_of(&self, p: WorldXy) -> Option<(u32, u32)> {
        let cw = i64::from(self.cell_world);
        if cw <= 0 {
            return None;
        }
        let col = (i64::from(p.x) - i64::from(self.origin_x)).div_euclid(cw);
        let row = (i64::from(p.y) - i64::from(self.origin_y)).div_euclid(cw);
        self.in_range(col, row).then_some((col as u32, row as u32))
    }

    /// The CENTRE of `(col, row)` in world coordinates — the artifact's
    /// own persisted canonical point for that cell (§13.1's "snap start
    /// and destination to the centre of the finest cell containing
    /// them", now a stored lattice rather than a per-query one).
    pub fn centre_of(&self, col: u32, row: u32) -> WorldXy {
        WorldXy::new(
            self.origin_x + col as i32 * self.cell_world + self.cell_world / 2,
            self.origin_y + row as i32 * self.cell_world + self.cell_world / 2,
        )
    }

    /// Straight-line distance to another tile's own extent MIDPOINT, in
    /// REAL metres — the topology layer's shared, deliberately coarse
    /// tile-graph distance model (not the exact crossing-cell geometry
    /// [`super::stitch`] could in principle give). Used by
    /// [`super::shortcuts`] for a physical edge's length and by
    /// [`super::query`] for its admissible search heuristic — both need
    /// the identical number, so it is computed here once rather than
    /// twice, matching this crate's own "one rule, defined once"
    /// convention.
    ///
    /// Raw World-unit deltas are NOT metres — `COORD_FACTOR` is units
    /// per 360° of longitude, not units per metre — the exact gotcha a
    /// comment elsewhere in this file already warns about
    /// (`"World units, not metres"`, `rasterize_tile`'s own tests). An
    /// EARLIER version of this function hypot'd the raw World-unit delta
    /// directly and called the result metres — every consumer
    /// (`shortcuts.rs`'s `lower_bound_mm`/`upper_bound_mm`, `query.rs`'s
    /// entire A* cost model) inherited a real ~13x scale error at
    /// coastal latitudes as a result (found by code review; the search
    /// ALGORITHMS themselves stayed correct throughout, since every
    /// distance in a given search used the identical wrong scale
    /// consistently — but the reported mm VALUES were wrong). Fixed by
    /// converting through [`radius_world_units`] — the same
    /// secant(latitude) reference-point conversion `RegionLattice`
    /// itself already uses to turn `RESOLUTION_LADDER_M` into
    /// `cell_world` in the first place, evaluated at `self`'s own
    /// midpoint (the same "one reference latitude is accurate enough at
    /// coastal scale" call that function's own docs make). Now a thin
    /// wrapper over [`world_distance_m`], extracted (code review on a
    /// later commit) so `query.rs`'s own graced snapping can measure a
    /// raw query point's distance to a tile centre with the identical
    /// conversion rather than a fourth hand-rolled copy of it.
    pub fn centre_distance_m(&self, other: &TileEntry) -> f64 {
        world_distance_m(self.extent().midpoint(), other.extent().midpoint())
    }

    /// Encode to the on-disk 32 bytes.
    pub fn to_bytes(&self) -> [u8; TILE_ENTRY_LEN] {
        let mut b = [0u8; TILE_ENTRY_LEN];
        b[0..4].copy_from_slice(&self.origin_x.to_le_bytes());
        b[4..8].copy_from_slice(&self.origin_y.to_le_bytes());
        b[8..12].copy_from_slice(&self.cell_world.to_le_bytes());
        b[12] = self.rung;
        b[13] = self.tile_flags;
        b[14..16].copy_from_slice(&self.cols.to_le_bytes());
        b[16..18].copy_from_slice(&self.rows.to_le_bytes());
        // 18..20 reserved
        b[20..24].copy_from_slice(&self.triggers.to_le_bytes());
        b[24..32].copy_from_slice(&self.payload_offset.to_le_bytes());
        b
    }

    /// Decode from at least [`TILE_ENTRY_LEN`] bytes. A LONGER slice is
    /// accepted and its tail ignored, which is what lets a future
    /// chartcore grow the entry without this reader bouncing the file
    /// (the section header carries the real stride — see
    /// [`decode_tile_index`]).
    pub fn parse(b: &[u8]) -> Option<TileEntry> {
        if b.len() < TILE_ENTRY_LEN {
            return None;
        }
        let i32_at = |o: usize| i32::from_le_bytes(b[o..o + 4].try_into().unwrap());
        Some(TileEntry {
            origin_x: i32_at(0),
            origin_y: i32_at(4),
            cell_world: i32_at(8),
            rung: b[12],
            tile_flags: b[13],
            cols: u16::from_le_bytes(b[14..16].try_into().unwrap()),
            rows: u16::from_le_bytes(b[16..18].try_into().unwrap()),
            triggers: u32::from_le_bytes(b[20..24].try_into().unwrap()),
            payload_offset: u64::from_le_bytes(b[24..32].try_into().unwrap()),
        })
    }
}

/// Header length of a [`crate::mivnav::SectionKind::TileIndex`] payload.
const TILE_INDEX_HEADER_LEN: usize = 8;

/// Serialize a tile index: `count`, entry stride, then the entries, in
/// `(origin_y, origin_x)` order.
///
/// The stride is written out so a reader built against an older
/// [`TILE_ENTRY_LEN`] can still walk a newer file's index — the same
/// skip-what-you-do-not-know discipline
/// [`crate::mivnav::SectionKind::Unknown`] gives whole sections, one
/// level down.
pub fn encode_tile_index(tiles: &[TileEntry]) -> Vec<u8> {
    let mut out = Vec::with_capacity(TILE_INDEX_HEADER_LEN + tiles.len() * TILE_ENTRY_LEN);
    out.extend_from_slice(&(tiles.len() as u32).to_le_bytes());
    out.extend_from_slice(&(TILE_ENTRY_LEN as u32).to_le_bytes());
    for t in tiles {
        out.extend_from_slice(&t.to_bytes());
    }
    out
}

/// Parse a tile index. `None` on a structurally impossible payload
/// (short header, stride below [`TILE_ENTRY_LEN`], truncated table).
pub fn decode_tile_index(bytes: &[u8]) -> Option<Vec<TileEntry>> {
    if bytes.len() < TILE_INDEX_HEADER_LEN {
        return None;
    }
    let count = u32::from_le_bytes(bytes[0..4].try_into().unwrap()) as usize;
    let stride = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    if stride < TILE_ENTRY_LEN {
        return None;
    }
    let need = count
        .checked_mul(stride)?
        .checked_add(TILE_INDEX_HEADER_LEN)?;
    if bytes.len() < need {
        return None;
    }
    let mut tiles = Vec::with_capacity(count);
    for i in 0..count {
        let at = TILE_INDEX_HEADER_LEN + i * stride;
        tiles.push(TileEntry::parse(&bytes[at..at + stride])?);
    }
    Some(tiles)
}

// ---------------------------------------------------------------------------
// §4.1 + §4.3 — the resolution choice
// ---------------------------------------------------------------------------

/// What [`choose_tile_resolution`] decided, and why.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TileResolution {
    /// Index into [`RESOLUTION_LADDER_M`].
    pub rung: u8,
    /// `RESOLUTION_LADDER_M[rung]`.
    pub cell_m: f64,
    /// §4.1's own answer for this tile's charts — the FLOOR. The chosen
    /// rung is never finer than this and never claims precision the
    /// source does not support (§24: "do not out-resolve the survey").
    pub finest_allowed_cell_m: f64,
    /// Which §4.3 triggers fired. `0` means open water. §18's resolution
    /// overlay wants this, not just the rung: "the first thing to open
    /// when a channel is inexplicably closed".
    pub triggers: u32,
}

/// §4.1's cap, escalated by §4.3's triggers — building the constraint set
/// itself.
///
/// Prefer [`choose_tile_resolution_with`] when the caller already has an
/// [`ArtifactConstraints`] for the same cells: `constraints::build` runs
/// real polygon buffering over every hard feature and is by far the most
/// expensive thing in the per-tile pipeline.
pub fn choose_tile_resolution(
    cells: &[&Cell],
    extent: Extent,
    params: &ConstraintParams,
) -> TileResolution {
    let constraints = constraints::build(cells, params);
    choose_tile_resolution_with(cells, extent, &constraints)
}

/// [`choose_tile_resolution`] against an already-built constraint set.
///
/// Only two numbers are taken from `constraints` — the finest
/// compilation scale and the coarsest applied CATZOC horizontal figure,
/// i.e. exactly §4.1's own two inputs. Everything else comes from the
/// cells' own features, because §4.3's triggers are about what is
/// CHARTED in the tile, not about what happens to block at some depth.
pub fn choose_tile_resolution_with(
    cells: &[&Cell],
    extent: Extent,
    constraints: &ArtifactConstraints,
) -> TileResolution {
    let finest = finest_allowed_cell_m(
        constraints.compilation_scale,
        constraints.catzoc_horizontal_m,
    );
    let triggers = tile_triggers(cells, extent);
    // §4.3: a trigger refines the tile TO `finest_allowed_cell`; with no
    // trigger it stays at the coarsest rung. Either way `finest` is a
    // floor that is never crossed — escalation only ever goes finer, and
    // only ever as far as the source supports.
    let cell_m = if triggers != 0 {
        finest
    } else {
        snap_up_to_ladder(OPEN_WATER_CELL_M.max(finest))
    };
    TileResolution {
        rung: rung_of(cell_m),
        cell_m,
        finest_allowed_cell_m: finest,
        triggers,
    }
}

/// The ladder index of an exact rung value. Every producer of a cell size
/// in this module runs it through `snap_up_to_ladder` first, so the
/// lookup cannot miss; a value off the ladder resolves to the coarsest
/// rung rather than panicking.
pub fn rung_of(cell_m: f64) -> u8 {
    RESOLUTION_LADDER_M
        .iter()
        .position(|&r| r >= cell_m)
        .unwrap_or(RESOLUTION_LADDER_M.len() - 1) as u8
}

/// Which §4.3 triggers `cells` fire inside `extent`.
fn tile_triggers(cells: &[&Cell], extent: Extent) -> u32 {
    let mut mask = 0u32;
    // Depth evidence, accumulated across every depth statement that
    // reaches the tile — a "transition crossing a band threshold" is a
    // property of the tile's own depth RANGE, not of one feature.
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    let mut soundings = 0usize;

    for cell in cells {
        for f in &cell.features {
            if !f.extent.intersects(&extent) {
                continue;
            }
            let acronym = f.acronym.as_str();
            if is_blocking_line_feature(f) || (acronym == "COALNE" && is_line(f)) {
                mask |= TRIGGER_BLOCKING_LINE;
            }
            if PREFERRED_ROUTE_CLASSES.contains(&acronym) {
                mask |= TRIGGER_PREFERRED_ROUTE;
            }
            if AIR_DRAFT_CLASSES.contains(&acronym) {
                mask |= TRIGGER_OVERHEAD;
            }
            if DEPTH_HAZARD_CLASSES.contains(&acronym) {
                mask |= TRIGGER_HAZARD;
            }
            if DEPTH_AREA_CLASSES.contains(&acronym) {
                if let Some(v) = depth_attr(f, "drval1") {
                    lo = lo.min(v);
                    hi = hi.max(v);
                }
                if let Some(v) = depth_attr(f, "drval2") {
                    lo = lo.min(v);
                    hi = hi.max(v);
                }
            }
            if acronym == "SOUNDG" {
                if let Some(Geometry::MultiPoint(points)) = &f.geometry {
                    for pz in points {
                        if extent.contains(pz.pos.x, pz.pos.y) {
                            soundings += 1;
                            lo = lo.min(pz.z);
                            hi = hi.max(pz.z);
                        }
                    }
                }
            }
            if TSS_AVOID_CLASSES.contains(&acronym) && crosses_extent_boundary(f, &extent) {
                mask |= TRIGGER_TSS_BOUNDARY;
            }
        }
    }

    if soundings > SOUNDG_CLUSTER_MIN {
        mask |= TRIGGER_HAZARD;
    }
    if lo.is_finite() && hi.is_finite() && BAND_LADDER_M.iter().any(|&b| lo < b && b < hi) {
        mask |= TRIGGER_DEPTH_BAND;
    }
    mask
}

/// `DRVAL1`/`DRVAL2` under either case. Real OSENC producers write both
/// the upper-case S-57 acronym and a lower-case derived copy (see the
/// fixture's own attribute dump); reading only one silently loses depth
/// evidence on half the producers.
fn depth_attr(f: &Feature, lower: &str) -> Option<f64> {
    f.attr(lower)
        .or_else(|| f.attr(&lower.to_uppercase()))
        .and_then(AttrValue::as_float)
}

fn is_line(f: &Feature) -> bool {
    matches!(f.geometry, Some(Geometry::Lines(_)))
}

/// §4.4's "blocking line feature": a §3.3 hard-constraint class carrying
/// LINE geometry.
///
/// `COALNE` is deliberately NOT here even though §4.3 names it as a
/// refinement trigger (and [`tile_triggers`] treats it as one): a
/// coastline is the *edge* of an `LNDARE`, not an independent obstruction
/// — blocking it would double-stamp the land boundary and, where a chart
/// digitises `COALNE` without a matching `LNDARE`, would block the
/// seaward side as readily as the landward one.
///
/// # A synthetic test fixture gotcha, worth knowing before writing one
///
/// This function's own `is_line(f)` gate means a bare AREA-shaped
/// `LNDARE` (the ordinary S-57 encoding) is NOT itself a "blocking line
/// feature", and `tile_triggers` fires `TRIGGER_BLOCKING_LINE` only
/// through THIS function — so a hand-built `Cell` carrying only an area
/// `LNDARE`, with no companion `COALNE` line the way a real producer
/// almost always includes one, triggers no refinement at all and stays
/// at the coarsest rung. The land still rasterizes and blocks correctly
/// (`rasterize_tile_with` reads `LNDARE` directly, not through this
/// function) — only the RESOLUTION near it suffers, silently, in a
/// fixture that forgot the coastline. Real chart fixtures (DE6OSTIM)
/// never hit this; synthetic ones building land from scratch have —
/// pair a bare `LNDARE` area with a `COALNE` line tracing the same
/// boundary if a test needs refinement to actually happen near it.
fn is_blocking_line_feature(f: &Feature) -> bool {
    if !is_line(f) {
        return false;
    }
    let acronym = f.acronym.as_str();
    acronym == "LNDARE"
        || STRUCTURE_BLOCK_CLASSES.contains(&acronym)
        || (acronym == "SLCONS" && slcons_blocks(f))
}

/// Does any of `f`'s geometry cross `extent`'s own boundary?
///
/// "Crossing" and not "present": a feature wholly inside the tile, or
/// wholly containing it, does not fire §4.3's TSS trigger. What the
/// trigger is for is the seam where a scheme's edge falls, which is where
/// a coarse cell would straddle both sides of a directional rule.
fn crosses_extent_boundary(f: &Feature, extent: &Extent) -> bool {
    match &f.geometry {
        Some(Geometry::Areas(polys)) => polys.iter().any(|p| {
            path_crosses_boundary(&p.outer, true, extent)
                || p.holes
                    .iter()
                    .any(|h| path_crosses_boundary(h, true, extent))
        }),
        Some(Geometry::Lines(lines)) => lines
            .iter()
            .any(|l| path_crosses_boundary(l, false, extent)),
        _ => false,
    }
}

fn path_crosses_boundary(pts: &[WorldXy], closed: bool, e: &Extent) -> bool {
    if pts.len() < 2 {
        return false;
    }
    let mut any_in = false;
    let mut any_out = false;
    for p in pts {
        if e.contains(p.x, p.y) {
            any_in = true;
        } else {
            any_out = true;
        }
        if any_in && any_out {
            return true;
        }
    }
    if any_in {
        return false; // wholly inside: no crossing
    }
    // Wholly outside — an edge may still slice across a corner.
    let n = pts.len();
    let last = if closed { n } else { n - 1 };
    (0..last).any(|i| segment_crosses_rect(pts[i], pts[(i + 1) % n], e))
}

/// Does the segment `a`→`b` cross any side of `e`? Exact integer
/// orientation arithmetic (world coordinates are 30-bit, products fit
/// `i64` with room to spare), so a shared vertex or a collinear edge
/// cannot be decided by float noise.
fn segment_crosses_rect(a: WorldXy, b: WorldXy, e: &Extent) -> bool {
    if a.x.max(b.x) < e.xmin
        || a.x.min(b.x) > e.xmax
        || a.y.max(b.y) < e.ymin
        || a.y.min(b.y) > e.ymax
    {
        return false;
    }
    let c = [
        WorldXy::new(e.xmin, e.ymin),
        WorldXy::new(e.xmax, e.ymin),
        WorldXy::new(e.xmax, e.ymax),
        WorldXy::new(e.xmin, e.ymax),
    ];
    (0..4).any(|i| segments_intersect(a, b, c[i], c[(i + 1) % 4]))
}

fn cross(o: WorldXy, a: WorldXy, b: WorldXy) -> i64 {
    (i64::from(a.x) - i64::from(o.x)) * (i64::from(b.y) - i64::from(o.y))
        - (i64::from(a.y) - i64::from(o.y)) * (i64::from(b.x) - i64::from(o.x))
}

fn segments_intersect(p1: WorldXy, p2: WorldXy, p3: WorldXy, p4: WorldXy) -> bool {
    let d1 = cross(p3, p4, p1).signum();
    let d2 = cross(p3, p4, p2).signum();
    let d3 = cross(p1, p2, p3).signum();
    let d4 = cross(p1, p2, p4).signum();
    if d1 * d2 < 0 && d3 * d4 < 0 {
        return true;
    }
    // Collinear touching counts: a segment running exactly along a tile
    // edge is a crossing for this purpose.
    let on = |o: WorldXy, a: WorldXy, p: WorldXy| {
        cross(o, a, p) == 0
            && p.x >= o.x.min(a.x)
            && p.x <= o.x.max(a.x)
            && p.y >= o.y.min(a.y)
            && p.y <= o.y.max(a.y)
    };
    on(p3, p4, p1) || on(p3, p4, p2) || on(p1, p2, p3) || on(p1, p2, p4)
}

// ---------------------------------------------------------------------------
// §5.1 — the raster
// ---------------------------------------------------------------------------

/// One tile's §5.1 SoA payload, plus what the build run needs to know
/// about it (§20's per-run record).
#[derive(Debug, Clone, PartialEq)]
pub struct TileRaster {
    /// `u16` decimetres to chart datum, [`DEPTH_NO_COVERAGE`] where no
    /// chart states a depth. Length is `tile.cell_count()`.
    pub depth_min: Vec<u16>,
    /// Likewise. A cell with no depth statement carries the sentinel in
    /// BOTH columns — check `depth_min == DEPTH_NO_COVERAGE` before
    /// applying §5.2's interval rules, or "no information" reads as
    /// "definitely navigable".
    pub depth_max: Vec<u16>,
    /// `FLAG_*` bits from [`super::format`].
    pub flags: Vec<u8>,
    pub report: TileReport,
}

/// What one tile's rasterization observed — §20's "record per run"
/// (tiles marked `VECTOR_REQUIRED`, area per ladder level), and Phase 6's
/// refinement trigger list.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TileReport {
    /// §4.4: at least one blocking line could not be resolved two cells
    /// thick, and the ladder had nothing finer to offer.
    pub vector_required: bool,
    /// How many such lines.
    pub thin_features: u32,
    /// Cells carrying [`FLAG_HARD_HAZARD`].
    pub blocked_cells: u32,
    /// Cells carrying [`FLAG_NO_COVERAGE`].
    pub no_coverage_cells: u32,
    /// Cells with a real charted depth (i.e. not the sentinel).
    pub charted_depth_cells: u32,
    /// Cells carrying [`FLAG_VECTOR_REQUIRED`].
    pub vector_required_cells: u32,
}

/// Rasterize `cells` onto `tile`, building the constraint set itself.
///
/// `cells` must already be AUTHORITY-FILTERED — the `kept` half of
/// [`super::region_authority`], resolved back to real cells. Handing this
/// every overlapping chart instead would union a coarse cell's
/// generalized coastline over a harbour cell's real one, which is the
/// defect §3.2 exists to prevent.
///
/// Prefer [`rasterize_tile_with`] when the constraint set is already
/// built (see [`choose_tile_resolution`]).
pub fn rasterize_tile(tile: &TileEntry, cells: &[&Cell], params: &ConstraintParams) -> TileRaster {
    let constraints = constraints::build(cells, params);
    rasterize_tile_with(tile, cells, &constraints)
}

/// [`rasterize_tile`] against an already-built constraint set.
pub fn rasterize_tile_with(
    tile: &TileEntry,
    cells: &[&Cell],
    constraints: &ArtifactConstraints,
) -> TileRaster {
    let n = tile.cell_count();
    let mut flags = vec![0u8; n];

    // ── flags, in §5.1's own bit order ────────────────────────────────
    //
    // Every area set is scanline-filled AND has its boundary stamped
    // (§4.4): a hazard can poke into a cell without covering its centre,
    // and a centre-sample fill alone would leave that cell reading clear.

    // bit 0 — land. Taken from LNDARE directly rather than from the hard
    // union, which is one merged ring set with no per-class provenance
    // left in it. A land cell therefore carries BOTH bit 0 and bit 1.
    for f in features_of(cells, |f| f.acronym == "LNDARE") {
        mark_feature(tile, &mut flags, FLAG_LAND, f);
    }
    // bit 1 — hard hazard: everything §3.3 blocks at chart datum.
    stamp_rings(tile, &mut flags, FLAG_HARD_HAZARD, &constraints.hard);
    // bit 2 — no coverage: OUTSIDE all M_COVR only.
    //
    // `constraints.unsurveyed` (S-57 `UNSARE`) is deliberately NOT
    // stamped here. `bands::navigable_dm` hard-blocks `FLAG_NO_COVERAGE`
    // (`BAND_BLOCKING_FLAGS`), but `routing::artifact` — the fine search
    // this topology accelerates — treats `UNSARE` as `F_UNKNOWN`:
    // grace-eligible, walkable at a cost (`routing::artifact::search`,
    // "Absent coverage is unknown water, exactly like UNSARE"), the same
    // "used to be a hard block, now just flag it" call
    // `routing::preference`'s own `UNSARE` docs record making after a
    // real UNSARE patch near Skagen refused an otherwise fine route. A
    // topology that is STRICTER than its own fine search walls off water
    // the search would use — and on an all-of-Denmark set, whose inner
    // waters are blanketed with `UNSARE`, that is most of where a boat
    // sails (measured: ~80% of the DK region read blocked). A `UNSARE`
    // cell with a real charted `depth_max >= band` now labels navigable
    // (like the fine search); one with no charted depth stays blocked by
    // `navigable_dm`'s `DEPTH_NO_COVERAGE` sentinel. The per-request fine
    // search still applies `UNSARE`'s own `F_UNKNOWN` cost + §9.3 grace,
    // still flags those legs `check_manually`, and `refine.rs` still
    // keeps `UNSARE` in its splice re-verification set.
    mark_uncovered(tile, &mut flags, cells, constraints);
    // bit 3 — overhead present (a PRESENCE bit: VERCLR lives in the
    // semantics store, and the artifact never knows the boat's mast).
    for f in features_of(cells, |f| AIR_DRAFT_CLASSES.contains(&f.acronym.as_str())) {
        mark_feature(tile, &mut flags, FLAG_OVERHEAD, f);
    }
    // bit 4 — fairway / recommended track.
    stamp_rings(tile, &mut flags, FLAG_FAIRWAY, &constraints.preferred);
    // bit 5 — TSS present (direction via the topology, §11).
    stamp_rings(tile, &mut flags, FLAG_TSS, &constraints.tss);
    // bit 6 — restricted (a PRESENCE bit: the RESTRN codes themselves go
    // to the semantics store, since §3.3 reads three of them differently
    // and one of those is query-overridable).
    for f in features_of(cells, |f| {
        let a = f.acronym.as_str();
        ENTRY_RESTRICTABLE_CLASSES.contains(&a) || RESTRICTED_ENTRY_CLASSES.contains(&a)
    }) {
        mark_feature(tile, &mut flags, FLAG_RESTRICTED, f);
    }
    stamp_rings(tile, &mut flags, FLAG_RESTRICTED, &constraints.atba);

    // ── §4.4 thin blocking features ───────────────────────────────────
    let (thin_features, vector_required_cells) = thin_feature_pass(tile, cells, &mut flags);

    // ── depth values ──────────────────────────────────────────────────
    let (depth_min, depth_max, charted) = depth_columns(tile, cells, &flags);

    let mut report = TileReport {
        thin_features,
        vector_required: thin_features > 0,
        charted_depth_cells: charted,
        vector_required_cells,
        ..TileReport::default()
    };
    for &f in &flags {
        if f & FLAG_HARD_HAZARD != 0 {
            report.blocked_cells += 1;
        }
        if f & FLAG_NO_COVERAGE != 0 {
            report.no_coverage_cells += 1;
        }
    }

    TileRaster {
        depth_min,
        depth_max,
        flags,
        report,
    }
}

fn features_of<'a>(
    cells: &'a [&'a Cell],
    pred: impl Fn(&Feature) -> bool + 'a,
) -> impl Iterator<Item = &'a Feature> + 'a {
    cells
        .iter()
        .flat_map(|c| c.features.iter())
        .filter(move |f| pred(f))
}

/// Fill `rings` into `bit` and stamp their boundaries (§4.4).
fn stamp_rings(tile: &TileEntry, flags: &mut [u8], bit: u8, rings: &[Vec<WorldXy>]) {
    if rings.is_empty() {
        return;
    }
    let cols = u32::from(tile.cols);
    scanline_spans(
        rings,
        tile.origin_x,
        tile.origin_y,
        tile.cell_world,
        cols,
        u32::from(tile.rows),
        |row, col_start, col_end| {
            let base = (row * cols) as usize;
            for c in col_start..col_end {
                flags[base + c as usize] |= bit;
            }
        },
    );
    for ring in rings {
        let n = ring.len();
        for i in 0..n {
            walk_supercover(tile, ring[i], ring[(i + 1) % n], |col, row| {
                flags[tile.index(col, row)] |= bit;
            });
        }
    }
}

/// Mark a feature's own geometry — point, multipoint, line or area — into
/// `bit`. Lines go through §4.4's supercover walk; areas are filled and
/// boundary-stamped.
fn mark_feature(tile: &TileEntry, flags: &mut [u8], bit: u8, f: &Feature) {
    match &f.geometry {
        Some(Geometry::Point(p)) => {
            if let Some((c, r)) = tile.cell_of(*p) {
                flags[tile.index(c, r)] |= bit;
            }
        }
        Some(Geometry::MultiPoint(points)) => {
            for pz in points {
                if let Some((c, r)) = tile.cell_of(pz.pos) {
                    flags[tile.index(c, r)] |= bit;
                }
            }
        }
        Some(Geometry::Lines(lines)) => {
            for line in lines {
                for w in line.windows(2) {
                    walk_supercover(tile, w[0], w[1], |col, row| {
                        flags[tile.index(col, row)] |= bit;
                    });
                }
            }
        }
        Some(Geometry::Areas(_)) => stamp_rings(tile, flags, bit, &area_rings(f)),
        None => {}
    }
}

/// Anything the charts do not positively cover is no-coverage water,
/// which §3.3 BLOCKS (§24: "No coverage is not free water. The renderer
/// leaves it unpainted; the router blocks it. Same bug, opposite
/// consequence.").
///
/// With no chart cell over the tile at all there is nothing to fill, and
/// the whole tile is no-coverage — the honest answer, and the opposite
/// call from `routing::artifact::search`'s corridor field, which skips
/// the rule when no cell made a coverage statement because a corridor is
/// always chosen to sit *inside* the charts. An artifact region is not:
/// it is a rectangle the caller picked, and its unbuilt corners are
/// genuinely uncharted.
fn mark_uncovered(
    tile: &TileEntry,
    flags: &mut [u8],
    cells: &[&Cell],
    constraints: &ArtifactConstraints,
) {
    if cells.is_empty() || constraints.coverage.is_empty() {
        for f in flags.iter_mut() {
            *f |= FLAG_NO_COVERAGE;
        }
        return;
    }
    let mut covered = vec![0u8; tile.cell_count()];
    stamp_rings(tile, &mut covered, 1, &constraints.coverage);
    for (f, c) in flags.iter_mut().zip(covered) {
        if c == 0 {
            *f |= FLAG_NO_COVERAGE;
        }
    }
}

/// §4.4: rasterize every blocking LINE feature with supercover coverage,
/// then check the result is at least two cells thick perpendicular to the
/// line. Where it is not, flag every cell the line touches
/// [`FLAG_VECTOR_REQUIRED`].
///
/// Returns `(thin features, cells flagged)`.
///
/// # Why this can only ever escalate to VECTOR_REQUIRED here
///
/// §4.4's rule is "refine until the feature is at least two cells thick;
/// if the ladder cannot achieve that within `finest_allowed_cell`, mark
/// the tile `VECTOR_REQUIRED`". By the time this runs the tile is already
/// AT `finest_allowed_cell`, because the presence of a blocking line is
/// itself [`TRIGGER_BLOCKING_LINE`] and [`choose_tile_resolution_with`]
/// refines on any trigger. So there is no finer rung left to try and the
/// escalation is the only remaining move — the refinement half of the
/// rule is implemented by the trigger, not by a second loop here.
///
/// # Granularity: per FEATURE, not per thin cell
///
/// One cell along a feature failing the perpendicular-neighbour check
/// flags every cell THAT FEATURE touches, not only the failing cell —
/// coarser than "only the genuinely thin cell" but finer than §4.4's own
/// literal wording ("mark the TILE `VECTOR_REQUIRED`"). This over-flags a
/// feature that is thin only at one corner, which inflates §20's
/// VECTOR_REQUIRED-area metric but never under-flags — the safe direction
/// for a hard-constraint bit. Narrowing this to per-cell precision is a
/// legitimate later refinement, not a correctness fix.
fn thin_feature_pass(tile: &TileEntry, cells: &[&Cell], flags: &mut [u8]) -> (u32, u32) {
    let mut thin_features = 0u32;
    let mut thin_cells: Vec<usize> = Vec::new();

    for f in features_of(cells, is_blocking_line_feature) {
        let Some(Geometry::Lines(lines)) = &f.geometry else {
            continue;
        };
        let mut touched: Vec<usize> = Vec::new();
        let mut thin = false;
        for line in lines {
            for w in line.windows(2) {
                // Perpendicular to the segment's DOMINANT axis: a
                // one-cell-wide line is always "thick" along its own
                // direction, so measuring there would pass everything.
                let dx = (i64::from(w[1].x) - i64::from(w[0].x)).abs();
                let dy = (i64::from(w[1].y) - i64::from(w[0].y)).abs();
                let (px, py) = if dx >= dy { (0i32, 1i32) } else { (1i32, 0i32) };
                walk_supercover(tile, w[0], w[1], |col, row| {
                    let i = tile.index(col, row);
                    flags[i] |= FLAG_HARD_HAZARD;
                    touched.push(i);
                    if !thin
                        && !neighbour_hard(tile, flags, col, row, px, py)
                        && !neighbour_hard(tile, flags, col, row, -px, -py)
                    {
                        thin = true;
                    }
                });
            }
        }
        if thin && !touched.is_empty() {
            thin_features += 1;
            thin_cells.extend(touched);
        }
    }

    thin_cells.sort_unstable();
    thin_cells.dedup();
    for &i in &thin_cells {
        flags[i] |= FLAG_VECTOR_REQUIRED;
    }
    (thin_features, thin_cells.len() as u32)
}

/// Is the neighbour of `(col, row)` at offset `(dx, dy)` hard-blocked? A
/// neighbour outside the tile answers `false`: it may well be blocked in
/// the tile next door, but this tile cannot see that and must not assume
/// it — the conservative direction is to call the feature thin and let
/// §12.4 look at the real geometry.
fn neighbour_hard(tile: &TileEntry, flags: &[u8], col: u32, row: u32, dx: i32, dy: i32) -> bool {
    let (c, r) = (
        i64::from(col) + i64::from(dx),
        i64::from(row) + i64::from(dy),
    );
    tile.in_range(c, r) && flags[tile.index(c as u32, r as u32)] & FLAG_HARD_HAZARD != 0
}

/// §5.1's `depth_min`/`depth_max` columns, plus the count of cells with a
/// real charted depth.
///
/// Sources, in §3.3's own terms: `DEPARE`/`DRGARE` contribute their
/// `DRVAL1`(shallow)/`DRVAL2`(deep) band to every cell their INTERIOR
/// covers, and `SOUNDG` contributes each sounding to the one cell holding
/// it ("often the only depth data between contours inside a channel").
///
/// Deliberately interior-only, unlike the hazard bits above: a depth is a
/// VALUE, not an obstruction, and stamping an area's boundary would make
/// a cell claim a depth from a band it is not inside. Conservatism for
/// depth lives in the interval itself — a cell straddling two bands ends
/// up with the shallower `depth_min` and the deeper `depth_max`, i.e.
/// §5.2's `mixed → refine`, which is exactly right.
fn depth_columns(tile: &TileEntry, cells: &[&Cell], flags: &[u8]) -> (Vec<u16>, Vec<u16>, u32) {
    let n = tile.cell_count();
    let mut lo = vec![DEPTH_NO_COVERAGE; n];
    let mut hi = vec![DEPTH_NO_COVERAGE; n];
    let mut charted = vec![false; n];
    let cols = u32::from(tile.cols);
    let extent = tile.extent();

    let note = |charted: &mut [bool],
                lo: &mut [u16],
                hi: &mut [u16],
                i: usize,
                shallow: f64,
                deep: f64| {
        let (s, d) = (depth_dm(shallow), depth_dm(deep.max(shallow)));
        if charted[i] {
            lo[i] = lo[i].min(s);
            hi[i] = hi[i].max(d);
        } else {
            charted[i] = true;
            lo[i] = s;
            hi[i] = d;
        }
    };

    for cell in cells {
        for f in &cell.features {
            if !f.extent.intersects(&extent) {
                continue;
            }
            let acronym = f.acronym.as_str();
            if DEPTH_AREA_CLASSES.contains(&acronym) {
                let d1 = depth_attr(f, "drval1");
                let d2 = depth_attr(f, "drval2");
                let (shallow, deep) = match (d1, d2) {
                    (None, None) => continue,
                    (Some(a), None) => (a, a),
                    (None, Some(b)) => (b, b),
                    (Some(a), Some(b)) => (a.min(b), a.max(b)),
                };
                let rings = area_rings(f);
                if rings.is_empty() {
                    continue;
                }
                scanline_spans(
                    &rings,
                    tile.origin_x,
                    tile.origin_y,
                    tile.cell_world,
                    cols,
                    u32::from(tile.rows),
                    |row, col_start, col_end| {
                        let base = (row * cols) as usize;
                        for c in col_start..col_end {
                            note(
                                &mut charted,
                                &mut lo,
                                &mut hi,
                                base + c as usize,
                                shallow,
                                deep,
                            );
                        }
                    },
                );
            } else if acronym == "SOUNDG" {
                if let Some(Geometry::MultiPoint(points)) = &f.geometry {
                    for pz in points {
                        if let Some((c, r)) = tile.cell_of(pz.pos) {
                            note(&mut charted, &mut lo, &mut hi, tile.index(c, r), pz.z, pz.z);
                        }
                    }
                }
            }
        }
    }

    // §5.1's sentinel note: `0` (drying height / land) must be
    // distinguishable from "no coverage", and it is the FLAGS that do
    // that, not the number. A land cell no chart states a depth for is
    // charted at 0, not sentinelled — the land is a fact, its depth is 0
    // by definition of being land.
    let mut count = 0u32;
    for i in 0..n {
        if charted[i] {
            count += 1;
        } else if flags[i] & FLAG_LAND != 0 {
            lo[i] = 0;
            hi[i] = 0;
        }
    }
    (lo, hi, count)
}

/// Metres to §5.1's saturating `u16` decimetres. Never produces
/// [`DEPTH_NO_COVERAGE`] for a real depth: a charted 6553.5 m would
/// otherwise read as "no coverage", so the top of the range is one below
/// the sentinel. Drying heights (negative charted depths) clamp to 0,
/// which §5.1 gives its own meaning.
fn depth_dm(m: f64) -> u16 {
    if !m.is_finite() {
        return 0;
    }
    (m * f64::from(DEPTH_UNIT_DM_PER_M))
        .round()
        .clamp(0.0, f64::from(DEPTH_NO_COVERAGE - 1)) as u16
}

/// A feature's area rings, wound for the nonzero-winding fill: outer
/// rings positive, holes negative.
///
/// The model does not promise an orientation, and
/// [`scanline_spans`](crate::routing::artifact::search::scanline_spans)
/// decides insideness by winding number — a hole wound the same way as
/// its outer ring would fill solid instead of leaving the hole open.
fn area_rings(f: &Feature) -> Vec<Vec<WorldXy>> {
    let mut out = Vec::new();
    let Some(Geometry::Areas(polys)) = &f.geometry else {
        return out;
    };
    for poly in polys {
        if poly.outer.len() >= 3 {
            out.push(oriented(&poly.outer, true));
        }
        for hole in &poly.holes {
            if hole.len() >= 3 {
                out.push(oriented(hole, false));
            }
        }
    }
    out
}

fn oriented(ring: &[WorldXy], positive: bool) -> Vec<WorldXy> {
    let mut r = ring.to_vec();
    if (signed_area2_world(&r) > 0) != positive {
        r.reverse();
    }
    r
}

// ---------------------------------------------------------------------------
// §4.4 — the supercover primitive, on the artifact's own grid
// ---------------------------------------------------------------------------

/// Every in-range cell of `tile` that the segment `a`→`b` touches — §4.4:
/// "every cell the line touches is blocked, not only cells whose centre
/// it crosses".
///
/// A thin wrapper over
/// [`Supercover`](crate::routing::artifact::search::Supercover), the ONE
/// Amanatides–Woo corner-doubling walk in this crate, shared with the
/// corridor search's own cost-integrating line of sight. Two copies of
/// this walk would disagree about exactly one diagonal barrier and
/// nothing would say so.
///
/// The segment is clipped to the tile (plus a one-cell margin) BEFORE the
/// walk, so a ring edge running for kilometres past the tile costs
/// nothing and — more importantly — cannot exhaust the walk's step budget
/// before it arrives, which would silently drop the cells it really does
/// touch.
pub fn supercover_cells(tile: &TileEntry, a: WorldXy, b: WorldXy) -> Vec<(u32, u32)> {
    let mut out = Vec::new();
    walk_supercover(tile, a, b, |x, y| out.push((x, y)));
    out
}

/// [`supercover_cells`]'s own walk, without the `Vec` every caller inside
/// this module immediately allocates and drops — `stamp_rings`,
/// `mark_feature` and `thin_feature_pass` run this on every edge of every
/// ring of every hard-constraint feature in a tile, on the CPU-constrained
/// Pi this artifact is built on (CLAUDE.md: "Constrained = Pi CPU / decode
/// throughput, not bandwidth"), so `f` is called in place instead.
/// [`supercover_cells`] itself stays `pub` for callers that genuinely want
/// the list — tests, and a future §18 debug overlay walking one segment at
/// a time.
fn walk_supercover(tile: &TileEntry, a: WorldXy, b: WorldXy, mut f: impl FnMut(u32, u32)) {
    if tile.cell_world <= 0 || tile.cols == 0 || tile.rows == 0 {
        return;
    }
    let cw = f64::from(tile.cell_world);
    let to_cell = |p: WorldXy| {
        (
            (i64::from(p.x) - i64::from(tile.origin_x)) as f64 / cw,
            (i64::from(p.y) - i64::from(tile.origin_y)) as f64 / cw,
        )
    };
    let (ax, ay) = to_cell(a);
    let (bx, by) = to_cell(b);
    let Some((ax, ay, bx, by)) = clip_to_tile(ax, ay, bx, by, tile.cols, tile.rows) else {
        return;
    };
    let limit = 4 * (tile.cols as usize + tile.rows as usize) + 8;
    let mut walk = Supercover::new(ax, ay, bx, by, limit);
    let mut push = |x: i32, y: i32| {
        if tile.in_range(i64::from(x), i64::from(y)) {
            f(x as u32, y as u32);
        }
    };
    for c in &mut walk {
        push(c.x, c.y);
    }
    if walk.end() == SupercoverEnd::Overshot {
        let (ex, ey) = walk.end_cell();
        push(ex, ey);
    }
}

/// Liang–Barsky clip of a cell-unit segment to the tile plus a one-cell
/// margin. `None` when the segment misses the tile entirely.
fn clip_to_tile(
    ax: f64,
    ay: f64,
    bx: f64,
    by: f64,
    cols: u16,
    rows: u16,
) -> Option<(f64, f64, f64, f64)> {
    let (xmin, xmax) = (-1.0, f64::from(cols) + 1.0);
    let (ymin, ymax) = (-1.0, f64::from(rows) + 1.0);
    let (dx, dy) = (bx - ax, by - ay);
    let (mut t0, mut t1) = (0.0f64, 1.0f64);
    for (p, q) in [
        (-dx, ax - xmin),
        (dx, xmax - ax),
        (-dy, ay - ymin),
        (dy, ymax - ay),
    ] {
        if p == 0.0 {
            if q < 0.0 {
                return None; // parallel and outside
            }
            continue;
        }
        let r = q / p;
        if p < 0.0 {
            if r > t1 {
                return None;
            }
            t0 = t0.max(r);
        } else {
            if r < t0 {
                return None;
            }
            t1 = t1.min(r);
        }
    }
    if t0 > t1 {
        return None;
    }
    Some((ax + t0 * dx, ay + t0 * dy, ax + t1 * dx, ay + t1 * dy))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::lat_lon_to_world;
    use crate::model::{CellMeta, Polygon};
    use std::collections::BTreeMap;

    const LAT: f64 = 54.0;
    const LON: f64 = 11.0;

    fn lattice() -> RegionLattice {
        RegionLattice::for_region(Extent::new(
            lat_lon_to_world(LAT, LON - 0.05).x,
            lat_lon_to_world(LAT, LON + 0.05).x,
            lat_lon_to_world(LAT + 0.05, LON).y,
            lat_lon_to_world(LAT - 0.05, LON).y,
        ))
    }

    fn tile_at(rung: u8) -> TileEntry {
        let l = lattice();
        let p = lat_lon_to_world(LAT, LON);
        l.tile_at(rung, p.x, p.y)
    }

    // ── centre_distance_m ───────────────────────────────────────────────

    #[test]
    fn centre_distance_m_returns_real_metres_not_raw_world_units() {
        // Regression: an earlier version hypot'd raw World-unit deltas
        // and called the result metres, off by ~13x at this latitude
        // (COORD_FACTOR is units per 360° of longitude, not units per
        // metre — see this function's own doc comment). Two same-shape
        // tiles a known number of CELLS apart at rung 0 give an exact
        // expected real-metre answer to check against, via the identical
        // `RESOLUTION_LADDER_M[0]` value `RegionLattice::for_region`
        // itself used to derive `cell_world` in the first place.
        let a = tile_at(0);
        let cells_apart = 500i32;
        let b = TileEntry {
            origin_x: a.origin_x + cells_apart * a.cell_world,
            ..a
        };
        let expected_m = f64::from(cells_apart) * RESOLUTION_LADDER_M[0];
        let got_m = a.centre_distance_m(&b);
        let relative_error = (got_m - expected_m).abs() / expected_m;
        assert!(
            relative_error < 0.01,
            "expected ~{expected_m} m, got {got_m} m — a raw-world-unit bug would report \
             roughly {}x too small",
            expected_m / got_m.max(1e-9)
        );
    }

    #[test]
    fn centre_distance_m_is_symmetric_and_zero_for_the_same_tile() {
        let a = tile_at(0);
        let b = TileEntry {
            origin_x: a.origin_x + 10 * a.cell_world,
            ..a
        };
        assert_eq!(a.centre_distance_m(&a), 0.0);
        assert!((a.centre_distance_m(&b) - b.centre_distance_m(&a)).abs() < 1e-6);
    }

    fn square(lat: f64, lon: f64, half_side_m: f64) -> Vec<WorldXy> {
        let dlat = half_side_m / 111_320.0;
        let dlon = half_side_m / (111_320.0 * lat.to_radians().cos());
        vec![
            lat_lon_to_world(lat - dlat, lon - dlon),
            lat_lon_to_world(lat - dlat, lon + dlon),
            lat_lon_to_world(lat + dlat, lon + dlon),
            lat_lon_to_world(lat + dlat, lon - dlon),
        ]
    }

    fn feature(class: &str, attrs: &[(&str, AttrValue)], geom: Geometry) -> Feature {
        let mut map = BTreeMap::new();
        for (k, v) in attrs {
            map.insert((*k).to_string(), v.clone());
        }
        Feature::new(1, class.into(), map, Some(geom))
    }

    fn area(class: &str, lat: f64, lon: f64, half: f64, attrs: &[(&str, AttrValue)]) -> Feature {
        feature(
            class,
            attrs,
            Geometry::Areas(vec![Polygon {
                outer: square(lat, lon, half),
                holes: vec![],
            }]),
        )
    }

    fn cell_of(features: Vec<Feature>, scale: u32) -> Cell {
        let mut extent = Extent::invalid();
        for f in &features {
            extent.extend(&f.extent);
        }
        Cell {
            meta: CellMeta {
                compilation_scale: scale,
                ..CellMeta::default()
            },
            features,
            extent,
        }
    }

    fn params() -> ConstraintParams {
        ConstraintParams {
            required_depth_m: 0.0,
            avoid_depth_m: 0.0,
            soft_prefer_depth_m: 0.0,
            required_air_draft_m: 0.0,
            lateral_margin_m: 0.0,
            catzoc_mode: crate::routing::artifact::CatzocMode::Off,
            allow_restricted_entry: false,
            build_charted_depth: false,
        }
    }

    // ── the lattice ───────────────────────────────────────────────────

    #[test]
    fn every_rung_is_a_power_of_two_multiple_of_the_finest() {
        let l = lattice();
        let base = l.cell_world(0);
        assert!(base >= 1);
        for rung in 0..RESOLUTION_LADDER_M.len() as u8 {
            let cw = l.cell_world(rung);
            assert_eq!(
                cw % base,
                0,
                "rung {rung} ({cw}) is not a multiple of the base {base}"
            );
            let ratio = (cw / base) as u32;
            assert!(ratio.is_power_of_two(), "rung {rung} ratio {ratio}");
        }
        // …including the 256 m -> 1024 m step, which is a factor of FOUR
        // and is exactly why nothing here derives a ratio from a
        // rung-INDEX difference.
        assert_eq!(l.cell_world(8) / l.cell_world(7), 4);
        assert_eq!(l.cell_world(5) / l.cell_world(4), 2);
    }

    #[test]
    fn tiles_are_anchored_to_their_own_global_lattice() {
        let l = lattice();
        let p = lat_lon_to_world(LAT, LON);
        for rung in 0..RESOLUTION_LADDER_M.len() as u8 {
            let t = l.tile_at(rung, p.x, p.y);
            let tw = l.tile_world(rung);
            assert_eq!(i64::from(t.origin_x).rem_euclid(tw), 0);
            assert_eq!(i64::from(t.origin_y).rem_euclid(tw), 0);
            assert!(t.extent().contains(p.x, p.y));
            assert_eq!(t.cols, TILE_CELLS as u16);
        }
        // A coarse tile's bounds fall ON the fine lattice, which is what
        // makes the tiling a quadtree partition rather than an overlap.
        let coarse = l.tile_at(5, p.x, p.y);
        let fine = l.tile_at(1, p.x, p.y);
        assert_eq!(
            i64::from(coarse.origin_x).rem_euclid(i64::from(fine.cell_world)),
            0
        );
    }

    #[test]
    fn a_tile_entry_round_trips_through_bytes() {
        let mut t = tile_at(3);
        t.tile_flags = TILE_FLAG_VECTOR_REQUIRED;
        t.triggers = TRIGGER_BLOCKING_LINE | TRIGGER_DEPTH_BAND;
        t.payload_offset = 1_234_567;
        assert_eq!(TileEntry::parse(&t.to_bytes()), Some(t));

        let tiles = vec![t, tile_at(8)];
        let bytes = encode_tile_index(&tiles);
        assert_eq!(decode_tile_index(&bytes), Some(tiles));
        // a truncated index is an error, not a panic
        assert!(decode_tile_index(&bytes[..bytes.len() - 1]).is_none());
        assert!(decode_tile_index(&[]).is_none());
    }

    #[test]
    fn a_cell_centre_round_trips_and_the_lattice_is_the_persisted_one() {
        let t = tile_at(2);
        for (c, r) in [(0u32, 0u32), (7, 31), (255, 255)] {
            assert_eq!(t.cell_of(t.centre_of(c, r)), Some((c, r)));
        }
        assert!(t
            .cell_of(WorldXy::new(t.origin_x - 1, t.origin_y))
            .is_none());
    }

    // ── §4.3 triggers ─────────────────────────────────────────────────

    #[test]
    fn open_water_with_no_trigger_stays_at_the_coarsest_rung() {
        let c = cell_of(vec![], 10_000);
        let t = tile_at(8);
        let r = choose_tile_resolution(&[&c], t.extent(), &params());
        assert_eq!(r.triggers, 0);
        assert_eq!(r.cell_m, OPEN_WATER_CELL_M);
        assert_eq!(r.rung, 8);
    }

    #[test]
    fn a_blocking_line_refines_the_tile_to_the_finest_the_source_allows() {
        let t = tile_at(8);
        let mid = t.extent().midpoint();
        let a = WorldXy::new(mid.x - 500, mid.y);
        let b = WorldXy::new(mid.x + 500, mid.y);
        let c = cell_of(
            vec![feature(
                "SLCONS",
                &[("CATSLC", AttrValue::Int(1))],
                Geometry::Lines(vec![vec![a, b]]),
            )],
            10_000, // -> 8 m
        );
        let r = choose_tile_resolution(&[&c], t.extent(), &params());
        assert_eq!(r.triggers & TRIGGER_BLOCKING_LINE, TRIGGER_BLOCKING_LINE);
        assert_eq!(r.finest_allowed_cell_m, 8.0);
        assert_eq!(r.cell_m, 8.0);
        assert_eq!(trigger_names(r.triggers), vec!["blocking_line"]);

        // A ramp is not a blocking SLCONS (§3.3), so it is not a trigger
        // either — the two rules share `slcons_blocks`, not a guess.
        let ramp = cell_of(
            vec![feature(
                "SLCONS",
                &[("CATSLC", AttrValue::Int(12))],
                Geometry::Lines(vec![vec![a, b]]),
            )],
            10_000,
        );
        assert_eq!(
            choose_tile_resolution(&[&ramp], t.extent(), &params()).triggers,
            0
        );
    }

    #[test]
    fn a_depth_band_crossing_refines_but_a_band_inside_one_step_does_not() {
        let t = tile_at(8);
        let mid = t.extent().midpoint();
        let (lat, lon) = (
            crate::coords::worldy_to_lat(mid.y),
            crate::coords::worldx_to_lon(mid.x),
        );
        let straddle = cell_of(
            vec![area(
                "DEPARE",
                lat,
                lon,
                5_000.0,
                &[
                    ("drval1", AttrValue::Float(2.0)),
                    ("drval2", AttrValue::Float(5.0)),
                ],
            )],
            25_000,
        );
        let r = choose_tile_resolution(&[&straddle], t.extent(), &params());
        assert_eq!(r.triggers & TRIGGER_DEPTH_BAND, TRIGGER_DEPTH_BAND);
        assert_eq!(r.cell_m, 16.0, "1:25 000 -> 12.5 m -> the 16 m rung");

        // 10.0..15.0 are both band EDGES, and nothing lies strictly
        // between them, so no threshold is crossed.
        let between = cell_of(
            vec![area(
                "DEPARE",
                lat,
                lon,
                5_000.0,
                &[
                    ("drval1", AttrValue::Float(10.0)),
                    ("drval2", AttrValue::Float(15.0)),
                ],
            )],
            25_000,
        );
        assert_eq!(
            choose_tile_resolution(&[&between], t.extent(), &params()).triggers
                & TRIGGER_DEPTH_BAND,
            0
        );
    }

    #[test]
    fn a_sounding_cluster_refines_but_a_lone_sounding_does_not() {
        let t = tile_at(8);
        let mid = t.extent().midpoint();
        let sounder = |n: usize| {
            cell_of(
                vec![feature(
                    "SOUNDG",
                    &[],
                    Geometry::MultiPoint(
                        (0..n)
                            .map(|i| crate::model::PointZ {
                                pos: WorldXy::new(mid.x + i as i32 * 50, mid.y),
                                z: 3.0,
                            })
                            .collect(),
                    ),
                )],
                10_000,
            )
        };
        let few = sounder(SOUNDG_CLUSTER_MIN);
        assert_eq!(
            choose_tile_resolution(&[&few], t.extent(), &params()).triggers & TRIGGER_HAZARD,
            0
        );
        let many = sounder(SOUNDG_CLUSTER_MIN + 1);
        assert_eq!(
            choose_tile_resolution(&[&many], t.extent(), &params()).triggers & TRIGGER_HAZARD,
            TRIGGER_HAZARD
        );
    }

    #[test]
    fn a_tss_boundary_triggers_only_when_it_crosses_the_tiles_own_edge() {
        let t = tile_at(4);
        let e = t.extent();
        let mid = e.midpoint();
        // Wholly inside: presence, not a boundary crossing.
        let inside = cell_of(
            vec![feature(
                "TSSLPT",
                &[],
                Geometry::Areas(vec![Polygon {
                    outer: vec![
                        WorldXy::new(mid.x - 100, mid.y - 100),
                        WorldXy::new(mid.x + 100, mid.y - 100),
                        WorldXy::new(mid.x + 100, mid.y + 100),
                        WorldXy::new(mid.x - 100, mid.y + 100),
                    ],
                    holes: vec![],
                }]),
            )],
            10_000,
        );
        assert_eq!(
            choose_tile_resolution(&[&inside], e, &params()).triggers & TRIGGER_TSS_BOUNDARY,
            0
        );
        // Straddling the tile's western edge.
        let straddling = cell_of(
            vec![feature(
                "TSSLPT",
                &[],
                Geometry::Areas(vec![Polygon {
                    outer: vec![
                        WorldXy::new(e.xmin - 1000, mid.y - 100),
                        WorldXy::new(mid.x, mid.y - 100),
                        WorldXy::new(mid.x, mid.y + 100),
                        WorldXy::new(e.xmin - 1000, mid.y + 100),
                    ],
                    holes: vec![],
                }]),
            )],
            10_000,
        );
        assert_eq!(
            choose_tile_resolution(&[&straddling], e, &params()).triggers & TRIGGER_TSS_BOUNDARY,
            TRIGGER_TSS_BOUNDARY
        );
    }

    #[test]
    fn the_source_cap_is_a_floor_that_a_trigger_cannot_break() {
        // A very coarse chart with a trigger: §4.1 caps at 64 m and the
        // trigger cannot refine past it (§24: "do not out-resolve the
        // survey").
        let t = tile_at(8);
        let mid = t.extent().midpoint();
        let c = cell_of(
            vec![feature(
                "LNDARE",
                &[],
                Geometry::Lines(vec![vec![
                    WorldXy::new(mid.x - 500, mid.y),
                    WorldXy::new(mid.x + 500, mid.y),
                ]]),
            )],
            90_000, // -> 45 m -> the 64 m rung
        );
        let r = choose_tile_resolution(&[&c], t.extent(), &params());
        assert!(r.triggers != 0);
        assert_eq!(r.cell_m, 64.0);
        assert_eq!(r.rung, 5);
    }

    // ── §4.4 supercover and thin features ─────────────────────────────

    #[test]
    fn supercover_marks_every_cell_a_diagonal_line_touches() {
        let t = tile_at(0);
        let a = t.centre_of(2, 2);
        let b = t.centre_of(6, 6);
        let hit = supercover_cells(&t, a, b);
        // A pure diagonal crosses cell CORNERS, and supercover must
        // visit both cells at each one — a centre-sampling DDA would
        // return 5 cells and hop every barrier between them (§4.4).
        assert!(
            hit.len() > 5,
            "a corner-crossing diagonal must touch more than the 5 centre cells: {hit:?}"
        );
        for step in 2..=6u32 {
            assert!(hit.contains(&(step, step)), "missing ({step},{step})");
        }
        assert!(hit.contains(&(3, 2)) || hit.contains(&(2, 3)));
    }

    #[test]
    fn a_segment_far_outside_the_tile_costs_nothing_and_a_long_one_still_arrives() {
        let t = tile_at(0);
        let e = t.extent();
        // Entirely elsewhere.
        assert!(supercover_cells(
            &t,
            WorldXy::new(e.xmin - 100_000, e.ymin - 100_000),
            WorldXy::new(e.xmin - 90_000, e.ymin - 90_000),
        )
        .is_empty());
        // A segment starting far away and crossing the tile completely
        // must still mark a full row — the clip is what keeps the walk's
        // step budget from being spent before it arrives.
        let mid = e.midpoint();
        let hit = supercover_cells(
            &t,
            WorldXy::new(e.xmin - 5_000_000, mid.y),
            WorldXy::new(e.xmax + 5_000_000, mid.y),
        );
        let cols: std::collections::HashSet<u32> = hit.iter().map(|&(c, _)| c).collect();
        assert_eq!(cols.len(), TILE_CELLS as usize, "the whole row must be hit");
    }

    #[test]
    fn a_hairline_breakwater_is_blocked_and_flagged_vector_required() {
        // A bare SLCONS LINE: after §3.4 buffering at CatzocMode::Off it
        // is a polygon a fraction of a world unit wide, so a centre-
        // sampling fill produces NOTHING and §4.4 calls its
        // disappearance the specific silent failure to avoid.
        let t = tile_at(0);
        let mid = t.extent().midpoint();
        // Offset off the tile's own centre row: `t.extent().midpoint()`
        // sits EXACTLY on a cell-row boundary (256 is even), and a line
        // placed there gets straddled into two rows by even the tiny
        // §3.4 buffer below — genuinely two cells thick, so "thin" would
        // never fire, for a reason that has nothing to do with the rule
        // under test. Mid-cell keeps this a clean one-row case.
        let line_y = mid.y + t.cell_world / 2;
        let a = WorldXy::new(mid.x - 2_000, line_y);
        let b = WorldXy::new(mid.x + 2_000, line_y);
        let c = cell_of(
            vec![
                area(
                    "M_COVR",
                    crate::coords::worldy_to_lat(mid.y),
                    crate::coords::worldx_to_lon(mid.x),
                    20_000.0,
                    &[("CATCOV", AttrValue::Int(1))],
                ),
                feature(
                    "SLCONS",
                    &[("CATSLC", AttrValue::Int(1))],
                    Geometry::Lines(vec![vec![a, b]]),
                ),
            ],
            4_000,
        );
        let r = rasterize_tile(&t, &[&c], &params());
        assert!(r.report.blocked_cells > 0, "the breakwater must exist");
        assert_eq!(r.report.thin_features, 1);
        assert!(r.report.vector_required);
        assert!(r.report.vector_required_cells > 0);
        // Every cell along the line is both blocked and flagged.
        let touched = supercover_cells(&t, a, b);
        assert!(!touched.is_empty());
        for &(col, row) in &touched {
            let f = r.flags[t.index(col, row)];
            assert!(f & FLAG_HARD_HAZARD != 0, "({col},{row}) must block");
            assert!(f & FLAG_VECTOR_REQUIRED != 0, "({col},{row}) must flag");
        }
    }

    #[test]
    fn a_breakwater_wide_enough_to_resolve_is_not_vector_required() {
        // The same structure digitised as an AREA two cells wide or more:
        // the fill gives it a real interior, so every cell the boundary
        // touches has a hard-blocked perpendicular neighbour.
        let t = tile_at(0);
        let mid = t.extent().midpoint();
        let (lat, lon) = (
            crate::coords::worldy_to_lat(mid.y),
            crate::coords::worldx_to_lon(mid.x),
        );
        let c = cell_of(
            vec![
                area(
                    "M_COVR",
                    lat,
                    lon,
                    20_000.0,
                    &[("CATCOV", AttrValue::Int(1))],
                ),
                area("SLCONS", lat, lon, 200.0, &[("CATSLC", AttrValue::Int(1))]),
            ],
            4_000,
        );
        let r = rasterize_tile(&t, &[&c], &params());
        assert!(r.report.blocked_cells > 0);
        assert_eq!(r.report.thin_features, 0, "an area feature is not thin");
        assert!(!r.report.vector_required);
    }

    // ── §5.1 payload ──────────────────────────────────────────────────

    #[test]
    fn depth_values_are_decimetres_and_no_coverage_is_the_sentinel() {
        let t = tile_at(0);
        let mid = t.extent().midpoint();
        let (lat, lon) = (
            crate::coords::worldy_to_lat(mid.y),
            crate::coords::worldx_to_lon(mid.x),
        );
        let c = cell_of(
            vec![
                area(
                    "M_COVR",
                    lat,
                    lon,
                    20_000.0,
                    &[("CATCOV", AttrValue::Int(1))],
                ),
                area(
                    "DEPARE",
                    lat,
                    lon,
                    150.0,
                    &[
                        ("drval1", AttrValue::Float(2.3)),
                        ("drval2", AttrValue::Float(5.0)),
                    ],
                ),
            ],
            4_000,
        );
        let r = rasterize_tile(&t, &[&c], &params());
        let (col, row) = t.cell_of(WorldXy::new(mid.x, mid.y)).expect("in the tile");
        let i = t.index(col, row);
        assert_eq!(r.depth_min[i], 23, "2.3 m is 23 dm");
        assert_eq!(r.depth_max[i], 50);
        assert_eq!(r.flags[i] & FLAG_NO_COVERAGE, 0);

        // Well outside the DEPARE (half-side 150 m, i.e. well under half
        // the tile's own ~256 m radius) but still inside both the chart's
        // coverage and the tile itself: covered, but nothing states a
        // depth. World units, not metres — `t.cell_world` gives the
        // conversion (2 m per [`RESOLUTION_LADDER_M`]`[0]` cell).
        let offset = t.cell_world * 100; // ~200 m, inside the tile's ~256 m half-width
        let far = t.cell_of(WorldXy::new(mid.x + offset, mid.y)).unwrap();
        let j = t.index(far.0, far.1);
        assert_eq!(r.depth_min[j], DEPTH_NO_COVERAGE);
        assert_eq!(r.depth_max[j], DEPTH_NO_COVERAGE);
        assert_eq!(r.report.charted_depth_cells as usize, {
            r.depth_min
                .iter()
                .filter(|&&d| d != DEPTH_NO_COVERAGE)
                .count()
        });
    }

    #[test]
    fn unsurveyed_water_with_a_charted_depth_stays_navigable_not_no_coverage() {
        // A UNSARE polygon over DEPARE-charted deep water inside M_COVR.
        // `rasterize_tile` must NOT flag those cells `FLAG_NO_COVERAGE`
        // (the band topology would hard-block them), even though the
        // fine search classes UNSARE as grace-eligible unknown water. A
        // cell with a real `depth_max` deeper than the band is navigable.
        let t = tile_at(0);
        let mid = t.extent().midpoint();
        let (lat, lon) = (
            crate::coords::worldy_to_lat(mid.y),
            crate::coords::worldx_to_lon(mid.x),
        );
        let c = cell_of(
            vec![
                area(
                    "M_COVR",
                    lat,
                    lon,
                    20_000.0,
                    &[("CATCOV", AttrValue::Int(1))],
                ),
                area(
                    "DEPARE",
                    lat,
                    lon,
                    300.0,
                    &[
                        ("drval1", AttrValue::Float(8.0)),
                        ("drval2", AttrValue::Float(15.0)),
                    ],
                ),
                area("UNSARE", lat, lon, 300.0, &[]),
            ],
            4_000,
        );
        let r = rasterize_tile(&t, &[&c], &params());
        let (col, row) = t.cell_of(WorldXy::new(mid.x, mid.y)).expect("in the tile");
        let i = t.index(col, row);

        assert_eq!(
            r.flags[i] & FLAG_NO_COVERAGE,
            0,
            "UNSARE must not mark no-coverage"
        );
        assert_eq!(r.depth_max[i], 150, "8–15 m DEPARE → depth_max 150 dm");
        assert!(
            super::super::bands::navigable(r.flags[i], r.depth_max[i], 1.5),
            "unsurveyed water 8 m+ deep must be navigable at the 1.5 m band"
        );
        assert_eq!(
            r.report.no_coverage_cells, 0,
            "the tile is wholly inside M_COVR; only outside-coverage cells count here"
        );
    }

    #[test]
    fn unsurveyed_water_with_no_charted_depth_stays_blocked() {
        // The safety-critical negative of the test above, and the reason
        // `bands.rs`'s `no_coverage_sentinel_blocks_even_without_the_flag_
        // set` is now load-bearing: a UNSARE polygon inside M_COVR with
        // NO DEPARE / DRGARE / SOUNDG under it. `rasterize_tile` no
        // longer flags it (`FLAG_NO_COVERAGE` unset), so the ONLY thing
        // keeping it out of the band topology is `depth_max` staying the
        // `DEPTH_NO_COVERAGE` sentinel.
        let t = tile_at(0);
        let mid = t.extent().midpoint();
        let (lat, lon) = (
            crate::coords::worldy_to_lat(mid.y),
            crate::coords::worldx_to_lon(mid.x),
        );
        let c = cell_of(
            vec![
                area(
                    "M_COVR",
                    lat,
                    lon,
                    20_000.0,
                    &[("CATCOV", AttrValue::Int(1))],
                ),
                area("UNSARE", lat, lon, 300.0, &[]),
            ],
            4_000,
        );
        let r = rasterize_tile(&t, &[&c], &params());
        let (col, row) = t.cell_of(WorldXy::new(mid.x, mid.y)).expect("in the tile");
        let i = t.index(col, row);

        assert_eq!(
            r.flags[i] & FLAG_NO_COVERAGE,
            0,
            "UNSARE no longer flags no-coverage"
        );
        assert_eq!(
            r.depth_max[i], DEPTH_NO_COVERAGE,
            "nothing charts a depth here"
        );
        assert!(
            !super::super::bands::navigable(r.flags[i], r.depth_max[i], 1.5),
            "unsurveyed water with no charted depth must NOT be navigable"
        );
    }

    #[test]
    fn a_shallow_sounding_lowers_its_own_cells_depth_min_only() {
        let t = tile_at(0);
        let mid = t.extent().midpoint();
        let (lat, lon) = (
            crate::coords::worldy_to_lat(mid.y),
            crate::coords::worldx_to_lon(mid.x),
        );
        let c = cell_of(
            vec![
                area(
                    "M_COVR",
                    lat,
                    lon,
                    20_000.0,
                    &[("CATCOV", AttrValue::Int(1))],
                ),
                area(
                    "DEPARE",
                    lat,
                    lon,
                    500.0,
                    &[
                        ("drval1", AttrValue::Float(5.0)),
                        ("drval2", AttrValue::Float(10.0)),
                    ],
                ),
                feature(
                    "SOUNDG",
                    &[],
                    Geometry::MultiPoint(vec![crate::model::PointZ {
                        pos: WorldXy::new(mid.x, mid.y),
                        z: 1.4,
                    }]),
                ),
            ],
            4_000,
        );
        let r = rasterize_tile(&t, &[&c], &params());
        let (col, row) = t.cell_of(WorldXy::new(mid.x, mid.y)).unwrap();
        let i = t.index(col, row);
        assert_eq!(r.depth_min[i], 14, "the sounding is the shallow bound");
        assert_eq!(r.depth_max[i], 100, "the band still gives the deep bound");
        // A neighbouring cell with no sounding keeps the band alone.
        let j = t.index(col + 3, row);
        assert_eq!(r.depth_min[j], 50);
    }

    #[test]
    fn land_carries_both_bits_and_a_zero_depth_not_the_sentinel() {
        let t = tile_at(0);
        let mid = t.extent().midpoint();
        let (lat, lon) = (
            crate::coords::worldy_to_lat(mid.y),
            crate::coords::worldx_to_lon(mid.x),
        );
        let c = cell_of(
            vec![
                area(
                    "M_COVR",
                    lat,
                    lon,
                    20_000.0,
                    &[("CATCOV", AttrValue::Int(1))],
                ),
                area("LNDARE", lat, lon, 200.0, &[]),
            ],
            4_000,
        );
        let r = rasterize_tile(&t, &[&c], &params());
        let (col, row) = t.cell_of(WorldXy::new(mid.x, mid.y)).unwrap();
        let i = t.index(col, row);
        assert_eq!(r.flags[i] & FLAG_LAND, FLAG_LAND);
        assert_eq!(
            r.flags[i] & FLAG_HARD_HAZARD,
            FLAG_HARD_HAZARD,
            "land is also a hard block"
        );
        assert_eq!(r.depth_min[i], 0, "§5.1: 0 is land/drying, not a sentinel");
        assert_eq!(r.depth_max[i], 0);
    }

    #[test]
    fn a_tile_no_chart_reaches_is_entirely_no_coverage() {
        // §24: "No coverage is not free water." The renderer leaves it
        // unpainted; the router must block it.
        let t = tile_at(8);
        let r = rasterize_tile(&t, &[], &params());
        assert_eq!(r.report.no_coverage_cells as usize, t.cell_count());
        assert!(r.depth_min.iter().all(|&d| d == DEPTH_NO_COVERAGE));
        assert_eq!(r.report.charted_depth_cells, 0);
    }

    #[test]
    fn presence_bits_land_on_their_own_features() {
        let t = tile_at(0);
        let mid = t.extent().midpoint();
        let (lat, lon) = (
            crate::coords::worldy_to_lat(mid.y),
            crate::coords::worldx_to_lon(mid.x),
        );
        // The tile is only ~512 m square (rung 0), so these anchors sit
        // well inside its ~256 m half-width — `0.004` degrees of
        // longitude (~260 m at this latitude) does not, and `t.cell_of`
        // below would see the query point fall outside the tile
        // entirely.
        const OFFSET_DEG: f64 = 0.0015; // ~98 m at LAT
        let c = cell_of(
            vec![
                area(
                    "M_COVR",
                    lat,
                    lon,
                    20_000.0,
                    &[("CATCOV", AttrValue::Int(1))],
                ),
                area("FAIRWY", lat, lon, 40.0, &[]),
                area("TSSLPT", lat, lon + OFFSET_DEG, 40.0, &[]),
                area(
                    "RESARE",
                    lat,
                    lon - OFFSET_DEG,
                    40.0,
                    &[("RESTRN", AttrValue::IntList(vec![14]))],
                ),
                feature(
                    "BRIDGE",
                    &[("VERCLR", AttrValue::Float(4.0))],
                    Geometry::Point(WorldXy::new(mid.x, mid.y + 400)),
                ),
            ],
            4_000,
        );
        let r = rasterize_tile(&t, &[&c], &params());
        let at = |p: WorldXy| {
            let (col, row) = t.cell_of(p).expect("inside the tile");
            r.flags[t.index(col, row)]
        };
        assert_eq!(at(WorldXy::new(mid.x, mid.y)) & FLAG_FAIRWAY, FLAG_FAIRWAY);
        assert_eq!(
            at(lat_lon_to_world(lat, lon + OFFSET_DEG)) & FLAG_TSS,
            FLAG_TSS
        );
        assert_eq!(
            at(lat_lon_to_world(lat, lon - OFFSET_DEG)) & FLAG_RESTRICTED,
            FLAG_RESTRICTED
        );
        assert_eq!(
            at(WorldXy::new(mid.x, mid.y + 400)) & FLAG_OVERHEAD,
            FLAG_OVERHEAD,
            "overhead is a PRESENCE bit — set even though the artifact \
             never knows the boat's mast height (§6)"
        );
        // …and the overhead feature is NOT a hard block: §3.3's air-draft
        // rule is a query-time threshold, not a build-time one.
        assert_eq!(at(WorldXy::new(mid.x, mid.y + 400)) & FLAG_HARD_HAZARD, 0);
    }

    #[test]
    fn rasterization_is_deterministic() {
        let t = tile_at(0);
        let mid = t.extent().midpoint();
        let (lat, lon) = (
            crate::coords::worldy_to_lat(mid.y),
            crate::coords::worldx_to_lon(mid.x),
        );
        let c = cell_of(
            vec![
                area(
                    "M_COVR",
                    lat,
                    lon,
                    20_000.0,
                    &[("CATCOV", AttrValue::Int(1))],
                ),
                area("LNDARE", lat, lon, 300.0, &[]),
                area(
                    "DEPARE",
                    lat,
                    lon + 0.01,
                    300.0,
                    &[("drval1", AttrValue::Float(3.0))],
                ),
            ],
            4_000,
        );
        let first = rasterize_tile(&t, &[&c], &params());
        for _ in 0..2 {
            assert_eq!(rasterize_tile(&t, &[&c], &params()), first);
        }
    }
}
