// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Feature model → Mapbox Vector Tiles. See docs/architecture/mvt-tiling-overview.md
//! (algorithm, antimeridian, attributes) and docs/architecture/mvt-nodata-claim.md
//! (what `_nodata` may claim; frontend stopped painting it, docs/architecture/nodata-not-painted.md).

mod clip;
pub mod decode;
mod encode;
pub(crate) mod mask;
pub mod merge;
pub mod points;
pub mod select;
mod simplify;
mod vector;

pub use encode::{encode_tile, MvtFeature, MvtGeometry, TagValue, EXTENT};
pub use points::{build_point_tileset, PointFeature};
pub use vector::{build_layer_tileset, VectorFeature, VectorGeom};

use std::collections::{BTreeMap, BTreeSet};

use crate::coords::{
    unwrap_anchor, unwrap_seam_x, unwrap_towards, World, WorldXy, COORD_ZOOM_LEVEL, SUB_PIXEL_BITS,
    TILE_SIZE_BITS, WORLD_MAX, WORLD_MIN, WORLD_SHIFT,
};
use crate::coverage::{cell_coverage, Coverage};
use crate::model::{AttrValue, Cell, Feature, Geometry, PointZ, Polygon};
use clip::{clip_polyline, clip_ring, ClipPt, ClipRect};
use mask::TileMask;
use simplify::simplify;

/// Tile buffer beyond the nominal EXTENT×EXTENT square, in MVT units.
/// 64/4096 of a tile — the conventional default; enough for line joins and
/// label anchors at tile seams.
pub const BUFFER: i64 = 64;

/// Name of the synthetic no-data layer (see module docs).
pub const NODATA_LAYER: &str = "_nodata";

/// log2 of the whole world in world units (2^29).
const WORLD_BITS: i32 = (COORD_ZOOM_LEVEL + TILE_SIZE_BITS + SUB_PIXEL_BITS) as i32;
const EXTENT_BITS: i32 = EXTENT.trailing_zeros() as i32;

/// (zoom, x, y) — key for built tiles, ordered zoom-major.
pub type TileKey = (u8, u32, u32);

/// A built tileset: encoded MVT blobs plus the metadata the archive needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tileset {
    pub tiles: BTreeMap<TileKey, Vec<u8>>,
    /// Every layer (object class acronym) that appears in some tile.
    pub layers: BTreeSet<String>,
    pub min_zoom: u8,
    pub max_zoom: u8,
}

/// OGC/OSM z0 scale denominator for a **256 px** tile — what
/// [`zoom_range_for_scale`] keys off. NOT the SCAMIN gate's denominator, see
/// [`RENDER_SCALE_DENOM_Z0`] and docs/architecture/scamin-render-gate.md.
pub const SCALE_DENOM_Z0: f64 = 559_082_264.0;

/// Z0 denominator **as actually rendered** (512 CSS px), exactly half
/// [`SCALE_DENOM_Z0`] — what the SCAMIN gate keys off (#kyxkoonq), mirrored
/// bit-for-bit by the frontend's same-named constant.
pub const RENDER_SCALE_DENOM_Z0: f64 = SCALE_DENOM_Z0 / 2.0;

/// Map scale denominator at integer zoom `z`, 256 px pyramid convention
/// ([`SCALE_DENOM_Z0`]). Cell zoom-range work only; display gate wants
/// [`display_scale_denom`].
pub fn scale_denom(z: u8) -> f64 {
    SCALE_DENOM_Z0 / 2f64.powi(z as i32)
}

/// The scale denominator a tile at integer zoom `z` is actually *displayed*
/// at ([`RENDER_SCALE_DENOM_Z0`]) — what every SCAMIN gate compares against.
pub fn display_scale_denom(z: u8) -> f64 {
    RENDER_SCALE_DENOM_Z0 / 2f64.powi(z as i32)
}

/// Sane bounds on the three SCAMIN-bias numbers. Last-line defence (mirrors
/// backend `OchartsConfig` validation) so a hand-edited `config.json` can't
/// feed an absurd or non-finite value into the drop.
pub const CHART_DETAIL_MIN: f64 = 0.1;
pub const CHART_DETAIL_MAX: f64 = 10.0;
pub const SCAMIN_SPREAD_MIN: f64 = 0.1;
pub const SCAMIN_SPREAD_MAX: f64 = 2.0;
pub const SCAMIN_ANCHOR_MIN: f64 = 1_000.0;
pub const SCAMIN_ANCHOR_MAX: f64 = 10_000_000.0;

/// Default anchor scale for [`ScaminBias`]: 1:350 000 (IHO "Coastal" coarse
/// end), unused unless `spread != 1`.
pub const DEFAULT_SCAMIN_ANCHOR: f64 = 350_000.0;

/// How a charted `scamin` is transformed before comparison against
/// [`display_scale_denom`] (#qqlzrkkn): `detail` uniformly multiplies;
/// `spread` warps around `anchor` instead (preserves ordering). `spread==1`
/// is an exact no-op. Mirrored by frontend's `scaminLimit`/`effectiveScamin` — see docs/architecture/scamin-render-gate.md.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScaminBias {
    pub detail: f64,
    pub spread: f64,
    pub anchor: f64,
}

impl Default for ScaminBias {
    fn default() -> Self {
        Self {
            detail: 1.0,
            spread: 1.0,
            anchor: DEFAULT_SCAMIN_ANCHOR,
        }
    }
}

impl ScaminBias {
    /// Clamp each number into its band, substituting the neutral default for a
    /// non-finite one — the last-line defence described on the MIN/MAX consts.
    pub fn new(detail: f64, spread: f64, anchor: f64) -> Self {
        let d = Self::default();
        Self {
            detail: if detail.is_finite() {
                detail.clamp(CHART_DETAIL_MIN, CHART_DETAIL_MAX)
            } else {
                d.detail
            },
            spread: if spread.is_finite() {
                spread.clamp(SCAMIN_SPREAD_MIN, SCAMIN_SPREAD_MAX)
            } else {
                d.spread
            },
            anchor: if anchor.is_finite() {
                anchor.clamp(SCAMIN_ANCHOR_MIN, SCAMIN_ANCHOR_MAX)
            } else {
                d.anchor
            },
        }
    }

    /// The gate a feature charted at `scamin` is actually compared against.
    /// `spread == 1` returns `scamin * detail` EXACTLY (no `powf` round-trip),
    /// which is what keeps the default byte-identical.
    pub fn effective(self, scamin: f64) -> f64 {
        if self.spread == 1.0 {
            return scamin * self.detail;
        }
        self.anchor * (scamin / self.anchor).powf(self.spread) * self.detail
    }
}

/// Zoom range for a chart's compilation scale (DSPM CSCL): max zoom is the
/// first zoom at least as detailed as the chart's native scale (capped at
/// 16), spanning 6 zooms below it. A 1:12000 harbor cell gets z10-z16.
pub fn zoom_range_for_scale(scale: u32) -> (u8, u8) {
    let scale = scale.max(1) as f64;
    let max = (SCALE_DENOM_Z0 / scale).log2().ceil().clamp(0.0, 16.0) as u8;
    (max.saturating_sub(6), max)
}

/// A feature's `scamin` gate (the derive-pass minimum-display-scale gate),
/// if it carries one. Absence means "always show" (S-57 DISPLAYBASE / group 1,
/// resolved at build time — see [`crate::derive`]).
fn feature_scamin(f: &MvtFeature) -> Option<i64> {
    f.tags
        .iter()
        .find(|(k, _)| k == "scamin")
        .and_then(|(_, v)| match v {
            TagValue::Int(i) => Some(*i),
            _ => None,
        })
}

/// Drop every feature the client would already hide by SCAMIN at integer
/// display zoom `z` (moves declutter off the wire): exactly the frontend's
/// `scaminVisible` (strict `<`, matching its `<=` show rule), except
/// `z >= max_zoom` drops nothing — see docs/architecture/scamin-render-gate.md.
fn drop_scamin_hidden(
    layers: &mut BTreeMap<String, Vec<MvtFeature>>,
    z: u8,
    max_zoom: u8,
    bias: ScaminBias,
) {
    if z >= max_zoom {
        return;
    }
    let denom = display_scale_denom(z);
    for feats in layers.values_mut() {
        feats.retain(|f| feature_scamin(f).is_none_or(|s| bias.effective(s as f64) >= denom));
    }
    layers.retain(|_, feats| !feats.is_empty());
}

/// [`drop_scamin_hidden`] on an already-encoded tile: decode, drop, re-encode.
/// Shared by the o-charts single-cell serve path and the [`build_tileset`]
/// bake so both stay byte-for-byte equal. `z >= max_zoom` returns the input
/// untouched (hot finest-tile path pays nothing).
pub fn drop_scamin_hidden_tile(
    tile: &[u8],
    z: u8,
    max_zoom: u8,
    bias: ScaminBias,
) -> Result<Vec<u8>, String> {
    if z >= max_zoom {
        return Ok(tile.to_vec());
    }
    let mut layers: BTreeMap<String, Vec<MvtFeature>> = BTreeMap::new();
    for layer in decode::decode_tile(tile)?.layers {
        let out = layers.entry(layer.name).or_default();
        out.extend(layer.features.iter().filter_map(merge::decoded_to_mvt));
    }
    drop_scamin_hidden(&mut layers, z, max_zoom, bias);
    Ok(encode_tile(&layers))
}

/// On-demand single-tile cutter for one decoded cell — the RAM-only
/// counterpart of [`build_tileset`] for the o-charts path, where nothing
/// derived from decrypted data may be persisted: never touches the
/// filesystem, no caching (the backend owns that).
pub struct CellTiler {
    cell: Cell,
    tags: Vec<Vec<(String, TagValue)>>,
    coverage: Option<Coverage>,
    /// Cell namespace for this cell's feature ids — see [`cell_namespace`].
    namespace: u32,
}

impl CellTiler {
    /// Takes ownership of the decoded cell (run [`crate::derive::apply`] on it
    /// first). Owning rather than borrowing keeps the backend's `Cell` pyclass
    /// a plain Rust value with no self-reference.
    pub fn new(cell: Cell) -> CellTiler {
        CellTiler {
            tags: cell.features.iter().map(attr_tags).collect(),
            coverage: cell_coverage(&cell),
            namespace: cell_namespace(&cell.meta.name),
            cell,
        }
    }

    /// The owned decoded cell (metadata, features) — for callers that need to
    /// read its header facts without re-decoding.
    pub fn cell(&self) -> &Cell {
        &self.cell
    }

    /// Encode the MVT tile at `zoom`/`x`/`y`. `None` when the cell
    /// contributes nothing there (out of range, outside coverage, or all
    /// geometry degenerate at this zoom).
    pub fn cut(&self, zoom: u8, x: u32, y: u32) -> Option<Vec<u8>> {
        self.cut_masked(zoom, x, y, None)
    }

    /// [`cut`](Self::cut), with the geometry that more detailed cells
    /// already chart removed ([`mask`]). `finer` is the coverage of every
    /// selected cell more detailed than this one, so exactly one cell is
    /// authoritative over each region of the tile.
    pub fn cut_with(&self, zoom: u8, x: u32, y: u32, finer: &[&Coverage]) -> Option<Vec<u8>> {
        let mask = TileMask::new(finer, zoom, x, y);
        self.cut_masked(zoom, x, y, mask.as_ref())
    }

    fn cut_masked(&self, zoom: u8, x: u32, y: u32, mask: Option<&TileMask>) -> Option<Vec<u8>> {
        if (zoom as u32) > COORD_ZOOM_LEVEL {
            return None;
        }
        let n = 1i64 << zoom;
        if (x as i64) >= n || (y as i64) >= n {
            return None;
        }
        // coverage classification for this one tile; None = no usable
        // coverage at this zoom → extent-based assignment, no gating
        let tile_cov: Option<TileCov> = self.coverage.as_ref().and_then(|cov| {
            let rings = cov_rings_at_zoom(cov, zoom)?;
            let ext = &cov.extent;
            let (txs, tys) = tile_range(
                (
                    ext.xmin as i64,
                    ext.xmax as i64,
                    ext.ymin as i64,
                    ext.ymax as i64,
                ),
                zoom,
            );
            // tiles outside the coverage extent's range behave like
            // build_tileset's "not in the map": no content, no nodata
            let outside = TileCov {
                covered: false,
                nodata: None,
            };
            if !tys.contains(&(y as i64)) {
                return Some(outside);
            }
            let Some(tx) = unwrapped_col(&txs, x, n) else {
                return Some(outside);
            };
            Some(classify_tile(&rings, tile_origin(tx, y as i64, zoom), zoom))
        });

        let tolerance = mvt_unit_world(zoom);
        let buffer_world = (BUFFER as f64 * tolerance).ceil() as i64;
        let mut layers: BTreeMap<String, Vec<MvtFeature>> = BTreeMap::new();
        if tile_cov.as_ref().is_none_or(|t| t.covered) {
            for (i, feature) in self.cell.features.iter().enumerate() {
                let Some(geometry) = &feature.geometry else {
                    continue;
                };
                // cheap pre-filter on the stored extent before the clone +
                // simplify work in prepare()
                if !extent_may_hit(&feature.extent, zoom, x, y, buffer_world) {
                    continue;
                }
                let simplifier = Simplifier::for_feature(zoom, feature);
                let Some(prepared) = prepare(geometry, &simplifier) else {
                    continue;
                };
                let Some((xmin, xmax, ymin, ymax)) = prepared_extent(&prepared) else {
                    continue;
                };
                let (txs, tys) = tile_range(
                    (
                        xmin - buffer_world,
                        xmax + buffer_world,
                        ymin - buffer_world,
                        ymax + buffer_world,
                    ),
                    zoom,
                );
                if !tys.contains(&(y as i64)) {
                    continue;
                }
                let Some(tx) = unwrapped_col(&txs, x, n) else {
                    continue;
                };
                let origin = tile_origin(tx, y as i64, zoom);
                let label_mid =
                    wants_label_point(feature).then(|| ((xmin + xmax) / 2, (ymin + ymax) / 2));
                let feats = cut_feature(
                    &prepared,
                    &self.tags[i],
                    feature.rcid.map(|r| namespaced_id(self.namespace, r)),
                    label_mid,
                    origin,
                    zoom,
                );
                // the mask's polygon branch is per-layer (fill-only classes are
                // cut for real, stroked ones stay all-or-nothing), so the
                // layer name is resolved before the cut, not after it
                let layer = layer_name(feature);
                let feats: Vec<MvtFeature> = match mask {
                    None => feats,
                    Some(m) => feats
                        .into_iter()
                        .filter_map(|f| m.subtract(layer, f))
                        .collect(),
                };
                if !feats.is_empty() {
                    layers.entry(layer.to_string()).or_default().extend(feats);
                }
            }
        }
        if let Some(rings) = tile_cov.and_then(|t| t.nodata) {
            layers
                .entry(NODATA_LAYER.to_string())
                .or_default()
                .push(MvtFeature {
                    id: None,
                    tags: Vec::new(),
                    geom: MvtGeometry::Polygons(rings),
                });
        }
        (!layers.is_empty()).then(|| encode_tile(&layers))
    }
}

/// One cell's contribution to a tile: the cell's tiler plus the coverage of
/// every *finer* kept cell that masks it. Pure Rust (no Python), so a batch
/// of these can be cut on the shared rayon pool with the GIL released.
pub struct CutTask<'a> {
    pub tiler: &'a CellTiler,
    pub finer: Vec<&'a Coverage>,
}

/// Process-global, size-keyed cache of bounded rayon thread pools, shared by
/// every in-flight tile request so concurrent requests work-steal within one
/// bounded pool instead of oversubscribing the Pi's cores. See docs/architecture/mvt-cut-pool.md.
fn cut_pool(threads: usize) -> std::sync::Arc<rayon::ThreadPool> {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex, OnceLock};
    static POOLS: OnceLock<Mutex<HashMap<usize, Arc<rayon::ThreadPool>>>> = OnceLock::new();
    let pools = POOLS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = pools.lock().expect("cut-pool cache poisoned");
    map.entry(threads)
        .or_insert_with(|| {
            Arc::new(
                rayon::ThreadPoolBuilder::new()
                    .num_threads(threads)
                    .thread_name(|i| format!("mivnav-cut-{i}"))
                    .build()
                    .expect("build rayon cut pool"),
            )
        })
        .clone()
}

/// Cut every task against tile `zoom`/`x`/`y`, preserving task order
/// (`tasks[i]` → `result[i]`) regardless of `parallelism` — see
/// docs/architecture/mvt-cut-pool.md. `parallelism <= 1` runs serial, never touches rayon.
pub fn cut_tiles(
    tasks: &[CutTask<'_>],
    zoom: u8,
    x: u32,
    y: u32,
    parallelism: usize,
) -> Vec<Option<Vec<u8>>> {
    if parallelism <= 1 {
        return tasks
            .iter()
            .map(|t| t.tiler.cut_with(zoom, x, y, &t.finer))
            .collect();
    }
    use rayon::prelude::*;
    cut_pool(parallelism).install(|| {
        tasks
            .par_iter()
            .map(|t| t.tiler.cut_with(zoom, x, y, &t.finer))
            .collect()
    })
}

/// The unwrapped tile column within `txs` that addresses on-map column `x`
/// (`tx ≡ x mod n`). At most one exists: [`tile_range`] caps ranges at one
/// world of columns.
fn unwrapped_col(txs: &std::ops::RangeInclusive<i64>, x: u32, n: i64) -> Option<i64> {
    let tx = txs.start() + (x as i64 - txs.start()).rem_euclid(n);
    (tx <= *txs.end()).then_some(tx)
}

/// Conservative test whether a feature's stored (pre-unwrap) extent, grown
/// by the tile buffer, can reach tile (x, y). Seam-unwrapping shifts by at
/// most one world in x, so all three frames are tested; false negatives are
/// impossible, false positives merely cost a `prepare` call.
fn extent_may_hit(
    ext: &crate::coords::Extent,
    zoom: u8,
    x: u32,
    y: u32,
    buffer_world: i64,
) -> bool {
    if !ext.valid {
        return false;
    }
    let wpt = world_per_tile(zoom);
    let ox = WORLD_MIN as i64 + x as i64 * wpt;
    let oy = WORLD_MIN as i64 + y as i64 * wpt;
    let (y0, y1) = (
        ext.ymin as i64 - buffer_world,
        ext.ymax as i64 + buffer_world,
    );
    if y1 < oy || y0 > oy + wpt {
        return false;
    }
    let (x0, x1) = (
        ext.xmin as i64 - buffer_world,
        ext.xmax as i64 + buffer_world,
    );
    let s = WORLD_SHIFT as i64;
    [-s, 0, s]
        .iter()
        .any(|shift| x1 + shift >= ox && x0 + shift <= ox + wpt)
}

/// Build all tiles for a cell over the given zoom range.
pub fn build_tileset(cell: &Cell, min_zoom: u8, max_zoom: u8) -> Tileset {
    assert!(min_zoom <= max_zoom, "empty zoom range");
    assert!(
        (max_zoom as u32) <= COORD_ZOOM_LEVEL,
        "zoom beyond coordinate resolution"
    );

    let tags: Vec<Vec<(String, TagValue)>> = cell.features.iter().map(attr_tags).collect();
    let coverage = cell_coverage(cell);
    // Same namespace as CellTiler, so the CLI-built fixture and live serving
    // agree on every feature id (see cell_namespace).
    let namespace = cell_namespace(&cell.meta.name);

    let mut acc: BTreeMap<TileKey, BTreeMap<String, Vec<MvtFeature>>> = BTreeMap::new();
    let mut layers = BTreeSet::new();
    for zoom in min_zoom..=max_zoom {
        let cov_tiles = coverage.as_ref().and_then(|c| zoom_coverage(c, zoom));
        for (i, feature) in cell.features.iter().enumerate() {
            let Some(geometry) = &feature.geometry else {
                continue;
            };
            emit_feature(
                zoom,
                namespace,
                feature,
                geometry,
                &Simplifier::for_feature(zoom, feature),
                &tags[i],
                cov_tiles.as_ref(),
                &mut acc,
                &mut layers,
            );
        }
        for ((tx, ty), tc) in cov_tiles.iter().flatten() {
            let Some(rings) = &tc.nodata else { continue };
            layers.insert(NODATA_LAYER.to_string());
            acc.entry((zoom, *tx, *ty))
                .or_default()
                .entry(NODATA_LAYER.to_string())
                .or_default()
                .push(MvtFeature {
                    id: None,
                    tags: Vec::new(),
                    geom: MvtGeometry::Polygons(rings.clone()),
                });
        }
    }

    // Move SCAMIN declutter off the wire at bake time too, applied to the
    // encoded bytes (not the layer map) so a baked pmtiles tile and the live
    // single-cell-serve tile go through the identical byte-level drop.
    let tiles = acc
        .into_iter()
        .filter_map(|(key, layers)| {
            // Neutral bias: the CLI bake has no runtime config, and 1.0 keeps
            // it byte-identical to a neutral live serve.
            let tile = drop_scamin_hidden_tile(
                &encode_tile(&layers),
                key.0,
                max_zoom,
                ScaminBias::default(),
            )
            .expect("re-decode of a freshly encoded tile cannot fail");
            (!tile.is_empty()).then_some((key, tile))
        })
        .collect();
    Tileset {
        tiles,
        layers,
        min_zoom,
        max_zoom,
    }
}

/// World units per MVT unit at `zoom`, as a float (for tolerances).
fn mvt_unit_world(zoom: u8) -> f64 {
    2f64.powi(WORLD_BITS - EXTENT_BITS - zoom as i32)
}

/// Project one world coordinate into tile-local MVT units, rounding to the
/// integer grid. `origin` is the tile's north-west corner — possibly of an
/// unwrapped tile column beyond ±180°, hence `i64`.
fn project_axis(w: World, origin: i64, zoom: u8) -> i64 {
    let shift = WORLD_BITS - EXTENT_BITS - zoom as i32;
    let d = w as i64 - origin;
    if shift > 0 {
        (d + (1 << (shift - 1))) >> shift
    } else {
        d << -shift
    }
}

fn project(p: WorldXy, origin: (i64, i64), zoom: u8) -> ClipPt {
    (
        project_axis(p.x, origin.0, zoom),
        project_axis(p.y, origin.1, zoom),
    )
}

/// World units per tile edge at `zoom`.
fn world_per_tile(zoom: u8) -> i64 {
    1i64 << (WORLD_BITS - zoom as i32)
}

/// Unclamped tile index of a world coordinate at `zoom`. For seam-unwrapped
/// x the index may lie outside `0..2^zoom`; wrap with `rem_euclid` when
/// addressing the tile, keep it raw for the tile origin.
fn tile_index(w: i64, zoom: u8) -> i64 {
    (w - WORLD_MIN as i64).div_euclid(world_per_tile(zoom))
}

/// North-west corner (world units) of tile column `tx`, row `ty` — indices
/// unclamped, so unwrapped columns get origins beyond the world x-range.
fn tile_origin(tx: i64, ty: i64, zoom: u8) -> (i64, i64) {
    let wpt = world_per_tile(zoom);
    (WORLD_MIN as i64 + tx * wpt, WORLD_MIN as i64 + ty * wpt)
}

/// Inclusive tile-index ranges covering a world extent at `zoom`: x
/// unclamped but capped at one full world of columns (no extent can iterate
/// more than `2^zoom` columns), y clamped to the world rows.
fn tile_range(
    (xmin, xmax, ymin, ymax): (i64, i64, i64, i64),
    zoom: u8,
) -> (std::ops::RangeInclusive<i64>, std::ops::RangeInclusive<i64>) {
    let n = 1i64 << zoom;
    let mut txa = tile_index(xmin, zoom);
    let mut txb = tile_index(xmax.max(xmin), zoom);
    if txb - txa + 1 > n {
        (txa, txb) = (0, n - 1);
    }
    let clamp_y = |w: i64| tile_index(w.clamp(WORLD_MIN as i64, WORLD_MAX as i64), zoom);
    (txa..=txb, clamp_y(ymin)..=clamp_y(ymax.max(ymin)))
}

/// The clip rectangle shared by all tiles: the nominal square grown by
/// [`BUFFER`].
const BUFFERED_RECT: ClipRect = ClipRect {
    x0: -BUFFER,
    y0: -BUFFER,
    x1: EXTENT as i64 + BUFFER,
    y1: EXTENT as i64 + BUFFER,
};

/// A tile whose only content is a whole-tile [`NODATA_LAYER`] polygon: the
/// **set-level** no-data claim, made by the backend's per-tile cell
/// selection (which has enumerated the whole set) — deliberately not
/// something a [`CellTiler`] can emit itself. See docs/architecture/mvt-nodata-claim.md.
pub fn nodata_tile() -> Vec<u8> {
    let r = &BUFFERED_RECT;
    // clockwise in y-down tile space: positive shoelace = MVT exterior
    let ring: Vec<(i32, i32)> = [
        (r.x0, r.y0),
        (r.x1, r.y0),
        (r.x1, r.y1),
        (r.x0, r.y1),
        (r.x0, r.y0),
    ]
    .into_iter()
    .map(|(x, y)| (x as i32, y as i32))
    .collect();
    let mut layers: BTreeMap<String, Vec<MvtFeature>> = BTreeMap::new();
    layers.insert(
        NODATA_LAYER.to_string(),
        vec![MvtFeature {
            id: None,
            tags: Vec::new(),
            geom: MvtGeometry::Polygons(vec![ring]),
        }],
    );
    encode_tile(&layers)
}

/// Coverage state of one tile at one zoom (see module docs).
struct TileCov {
    /// Does the tile's nominal square contain any chart data coverage?
    /// Feature content is only emitted into covered tiles.
    covered: bool,
    /// Rings of the `_nodata` polygon — the cell's declared no-coverage
    /// areas clipped to this tile — when it declares any here.
    nodata: Option<Vec<Vec<(i32, i32)>>>,
}

/// Coverage rings simplified for `zoom`. `None` below one MVT unit (callers
/// fall back to extent-based assignment). A negative (no-coverage) ring that
/// fails to simplify to >= 4 points is kept UNSIMPLIFIED — dropping it would
/// erase a declared hole and mask another cell's chart (task kkkqkumv, docs/architecture/mvt-nodata-claim.md).
fn cov_rings_at_zoom(cov: &Coverage, zoom: u8) -> Option<Vec<Vec<WorldXy>>> {
    let unit = mvt_unit_world(zoom);
    if ((cov.extent.xmax as i64 - cov.extent.xmin as i64) as f64) < unit
        || ((cov.extent.ymax as i64 - cov.extent.ymin as i64) as f64) < unit
    {
        return None;
    }
    Some(
        cov.rings
            .iter()
            .filter_map(|r| {
                let simplified = simplify(r, unit);
                if simplified.len() >= 4 {
                    return Some(simplified);
                }
                (crate::coverage::signed_area2_world(r) < 0).then(|| r.clone())
            })
            .collect(),
    )
}

/// The nominal tile square — the region a tile is classified against.
const NOMINAL_RECT: ClipRect = ClipRect {
    x0: 0,
    y0: 0,
    x1: EXTENT as i64,
    y1: EXTENT as i64,
};

/// Twice the clipped area of a coverage ring set within the nominal square:
/// `pos`/`neg` kept separate (not one signed sum) because a disjoint
/// CATCOV=2/CATCOV=1 partition can make a single winding-signed sum go
/// negative. See docs/architecture/mvt-nodata-claim.md.
struct ClippedAreas {
    pos: i64,
    neg: i64,
}

impl ClippedAreas {
    fn measure(rings: &[Vec<WorldXy>], origin: (i64, i64), zoom: u8) -> ClippedAreas {
        let mut a = ClippedAreas { pos: 0, neg: 0 };
        for ring in rings {
            let a2 = signed_area2(&ring_to_tile(ring, origin, zoom, &NOMINAL_RECT));
            if a2 > 0 {
                a.pos += a2;
            } else {
                a.neg -= a2;
            }
        }
        a
    }

    /// Whether any positively-wound area survived the clip — i.e. whether
    /// the cell charts *any* of the square. Independent of how much
    /// no-data it also declares here.
    fn charts_anything(&self) -> bool {
        self.pos > 0
    }

    /// Whether the cell charts the whole square, making it the tile's sole
    /// authority. Conservative under both ring semantics (true charted area
    /// is always >= `pos - neg`), so this can only *under*-claim fullness.
    fn charts_everything(&self) -> bool {
        ((self.pos - self.neg) as f64) >= FULL_TILE_AREA2 as f64 * FULL_COVERAGE_FRACTION
    }
}

/// Classify one tile against the (zoom-simplified) coverage ring set.
fn classify_tile(rings: &[Vec<WorldXy>], origin: (i64, i64), zoom: u8) -> TileCov {
    // Declared no-data: negative rings only, clipped and flipped to MVT
    // exteriors. No tile rectangle here for positive rings to subtract from
    // — see docs/architecture/mvt-nodata-claim.md.
    let mut declared: Vec<Vec<(i32, i32)>> = Vec::new();
    for ring in rings {
        let b = ring_to_tile(ring, origin, zoom, &BUFFERED_RECT);
        if signed_area2(&b) < 0 {
            declared.push(b.into_iter().rev().map(to_i32).collect());
        }
    }
    TileCov {
        covered: ClippedAreas::measure(rings, origin, zoom).charts_anything(),
        nodata: (!declared.is_empty()).then_some(declared),
    }
}

/// How much of one tile a [`Coverage`] charts — the question tile *serving*
/// asks before deciding to decode a cell at all (see
/// [`coverage_tile_state`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TileState {
    /// No coverage in the tile's nominal square: the cell charts nothing
    /// here, and so has nothing to say about it.
    Uncovered,
    /// Some, but not all, of the square is charted.
    Partial,
    /// The whole square is charted, so no coarser cell can add anything
    /// here: this cell is the tile's sole authority.
    Full,
}

/// Twice the area of a tile's nominal square — the [`TileState::Full`] yardstick.
const FULL_TILE_AREA2: i64 = 2 * (EXTENT as i64) * (EXTENT as i64);

/// Fraction of the nominal square that must be charted to call a tile
/// [`TileState::Full`]. Not 1.0: zoom-simplified rings can shave ~1 MVT unit
/// off an edge, which would otherwise read a blanketing cell as `Partial`
/// and drag coarser cells back into the tile (redundant-bands bug).
const FULL_COVERAGE_FRACTION: f64 = 0.999;

/// How much of tile `zoom`/`x`/`y` this coverage charts — lets serving
/// selection decide from coverage alone whether to decode a cell at all. A
/// coverage sub-unit at this zoom reads [`TileState::Partial`], not
/// `Uncovered` — dropping it would be a coverage hole.
pub fn coverage_tile_state(cov: &Coverage, zoom: u8, x: u32, y: u32) -> TileState {
    if (zoom as u32) > COORD_ZOOM_LEVEL {
        return TileState::Uncovered;
    }
    let n = 1i64 << zoom;
    if (x as i64) >= n || (y as i64) >= n {
        return TileState::Uncovered;
    }
    let Some(rings) = cov_rings_at_zoom(cov, zoom) else {
        return TileState::Partial;
    };
    let ext = &cov.extent;
    let (txs, tys) = tile_range(
        (
            ext.xmin as i64,
            ext.xmax as i64,
            ext.ymin as i64,
            ext.ymax as i64,
        ),
        zoom,
    );
    if !tys.contains(&(y as i64)) {
        return TileState::Uncovered;
    }
    let Some(tx) = unwrapped_col(&txs, x, n) else {
        return TileState::Uncovered;
    };
    let origin = tile_origin(tx, y as i64, zoom);
    let areas = ClippedAreas::measure(&rings, origin, zoom);
    if !areas.charts_anything() {
        TileState::Uncovered
    } else if areas.charts_everything() {
        TileState::Full
    } else {
        // Accepted imprecision: a tile strictly inside a no-data hole reads
        // Partial not Uncovered (wastes a decode, never hides a chart);
        // exact resolution needs polygon booleans on the hottest selection path.
        TileState::Partial
    }
}

/// Does `cov` keep any renderable ground in tile `zoom`/`x`/`y` once the
/// coverage of `finer` (strictly more detailed cells) is subtracted from it?
/// Serving selection keeps a candidate iff it has residual, so exactly one
/// cell is authoritative over each region. See [`mask::coverage_has_residual_in_tile`].
pub fn coverage_has_residual_in_tile(
    cov: &Coverage,
    finer: &[&Coverage],
    zoom: u8,
    x: u32,
    y: u32,
) -> bool {
    mask::coverage_has_residual_in_tile(cov, finer, zoom, x, y)
}

/// Classify every tile spanned by the coverage extent at `zoom`. `None`
/// per [`cov_rings_at_zoom`].
fn zoom_coverage(cov: &Coverage, zoom: u8) -> Option<BTreeMap<(u32, u32), TileCov>> {
    let rings = cov_rings_at_zoom(cov, zoom)?;
    let n = 1i64 << zoom;
    let ext = &cov.extent;
    let (txs, tys) = tile_range(
        (
            ext.xmin as i64,
            ext.xmax as i64,
            ext.ymin as i64,
            ext.ymax as i64,
        ),
        zoom,
    );
    let mut map = BTreeMap::new();
    for ty in tys {
        for tx in txs.clone() {
            // key by the wrapped (on-map) tile address so lookups from
            // feature emission agree regardless of each geometry's frame
            map.insert(
                (tx.rem_euclid(n) as u32, ty as u32),
                classify_tile(&rings, tile_origin(tx, ty, zoom), zoom),
            );
        }
    }
    Some(map)
}

/// Per-zoom simplified geometry, ready for per-tile projection. Seam-
/// unwrapped: geometry crossing ±180° is contiguous in x (possibly outside
/// the normal world range) instead of world-spanning, all parts of one
/// feature in the same seam frame.
enum Prepared {
    Point(WorldXy),
    MultiPoint(Vec<PointZ>),
    Lines(Vec<Vec<WorldXy>>),
    Areas(Vec<Polygon>),
}

/// Unwrap one part and pin it to the feature's seam frame (the first
/// part's first vertex establishes the frame).
fn unwrap_part(pts: &mut [WorldXy], anchor: &mut Option<i64>) {
    unwrap_seam_x(pts);
    match *anchor {
        Some(a) => unwrap_anchor(pts, a),
        None => *anchor = pts.first().map(|p| p.x as i64),
    }
}

/// Overview zooms where the heaviest layers take a coarser tolerance: at z7
/// one MVT unit is an eighth of a CSS pixel, finer than these zooms can show,
/// and DEPARE alone is 69% of the vertices.
const COARSE_ZOOMS: std::ops::RangeInclusive<u8> = 5..=7;
/// MVT units of tolerance at [`COARSE_ZOOMS`]: half a CSS pixel.
const COARSE_UNITS: f64 = 4.0;

/// The layers that get [`COARSE_UNITS`]: terrain and depth geometry, 92% of a
/// z7 tile's vertices. Hazards, restricted areas and routeing measures stay
/// at one unit, so their tile geometry is exactly what it was.
fn is_coarse_layer(feature: &Feature) -> bool {
    matches!(
        layer_name(feature),
        "DEPARE" | "DEPCNT" | "COALNE" | "LNDARE" | "M_QUAL"
    )
}

/// How one feature's lines and rings get simplified at one zoom.
///
/// Each feature is simplified alone, so neighbours can disagree along a shared
/// edge by up to the tolerance. Keeping them in step by pinning the cell's
/// junctions was tried and measured: they crowd the coast so densely that
/// cells kept 54-176% of today's vertices, against 44-49% for this.
struct Simplifier {
    fine: f64,
    coarse: Option<f64>,
}

impl Simplifier {
    fn for_feature(zoom: u8, feature: &Feature) -> Simplifier {
        let fine = mvt_unit_world(zoom);
        let coarse = (COARSE_ZOOMS.contains(&zoom) && is_coarse_layer(feature))
            .then_some(fine * COARSE_UNITS);
        Simplifier { fine, coarse }
    }

    fn line(&self, pts: &[WorldXy]) -> Vec<WorldXy> {
        if pts.len() >= 4 && pts.first() == pts.last() {
            return self.ring(pts); // a closed contour, or an islet's coastline
        }
        let fine = simplify(pts, self.fine);
        match self.coarse.map(|tolerance| simplify(pts, tolerance)) {
            Some(line) if path_length(&line) >= path_length(&fine) * MIN_KEPT => line,
            _ => fine,
        }
    }

    /// Thin strips are what the coarse pass flattens, and a thin shoal is the
    /// last thing an overview may lose, so a ring that gives up most of its
    /// area keeps the fine shape instead.
    fn ring(&self, pts: &[WorldXy]) -> Vec<WorldXy> {
        let fine = simplify(pts, self.fine);
        let area = |r: &[WorldXy]| crate::coverage::signed_area2_world(r).abs() as f64;
        match self.coarse.map(|tolerance| simplify(pts, tolerance)) {
            Some(ring) if ring.len() >= 4 && area(&ring) >= area(&fine) * MIN_KEPT => ring,
            _ => fine,
        }
    }
}

/// The share of a line's length or a ring's area the coarse pass must keep.
const MIN_KEPT: f64 = 0.5;

fn path_length(pts: &[WorldXy]) -> f64 {
    pts.windows(2)
        .map(|w| ((w[1].x - w[0].x) as f64).hypot((w[1].y - w[0].y) as f64))
        .sum()
}

fn prepare(geometry: &Geometry, simplifier: &Simplifier) -> Option<Prepared> {
    let mut anchor: Option<i64> = None;
    match geometry {
        Geometry::Point(p) => Some(Prepared::Point(*p)),
        Geometry::MultiPoint(pts) => {
            let first = pts.first()?;
            let a = first.pos.x as i64;
            let pts = pts
                .iter()
                .map(|pz| PointZ {
                    pos: WorldXy::new(unwrap_towards(pz.pos.x, a), pz.pos.y),
                    z: pz.z,
                })
                .collect();
            Some(Prepared::MultiPoint(pts))
        }
        Geometry::Lines(lines) => {
            let ls: Vec<Vec<WorldXy>> = lines
                .iter()
                .map(|l| {
                    let mut l = l.clone();
                    unwrap_part(&mut l, &mut anchor);
                    simplifier.line(&l)
                })
                .filter(|l| l.len() >= 2)
                .collect();
            (!ls.is_empty()).then_some(Prepared::Lines(ls))
        }
        Geometry::Areas(polys) => {
            let ps: Vec<Polygon> = polys
                .iter()
                .filter_map(|p| {
                    let mut outer = p.outer.clone();
                    unwrap_part(&mut outer, &mut anchor);
                    // holes stay pinned to their own outer ring
                    let hole_anchor = outer.first().map(|p| p.x as i64);
                    let outer = simplifier.ring(&outer);
                    if outer.len() < 4 {
                        return None; // closed ring: needs 3 distinct + repeat
                    }
                    let holes = p
                        .holes
                        .iter()
                        .map(|h| {
                            let mut h = h.clone();
                            let mut a = hole_anchor;
                            unwrap_part(&mut h, &mut a);
                            simplifier.ring(&h)
                        })
                        .filter(|h| h.len() >= 4)
                        .collect();
                    Some(Polygon { outer, holes })
                })
                .collect();
            (!ps.is_empty()).then_some(Prepared::Areas(ps))
        }
    }
}

/// Bounding extent of prepared geometry as (xmin, xmax, ymin, ymax) —
/// computed post-unwrap, so a seam-crossing feature gets a tight (possibly
/// overflowed) x-range instead of a world-spanning one.
fn prepared_extent(p: &Prepared) -> Option<(i64, i64, i64, i64)> {
    let mut ext: Option<(i64, i64, i64, i64)> = None;
    let mut add = |p: &WorldXy| {
        let (x, y) = (p.x as i64, p.y as i64);
        ext = Some(match ext {
            None => (x, x, y, y),
            Some((x0, x1, y0, y1)) => (x0.min(x), x1.max(x), y0.min(y), y1.max(y)),
        });
    };
    match p {
        Prepared::Point(p) => add(p),
        Prepared::MultiPoint(pts) => pts.iter().for_each(|pz| add(&pz.pos)),
        Prepared::Lines(lines) => lines.iter().flatten().for_each(&mut add),
        // holes lie within the outer ring; the outer rings suffice
        Prepared::Areas(polys) => polys.iter().flat_map(|p| &p.outer).for_each(&mut add),
    }
    ext
}

/// The MVT feature id is `(cell_namespace(name) << 32) | rcid`. RCID alone
/// collides across cells merged into one tile (measured ~1 in 10 on the
/// Danish set); namespace hashes the cell's stable *name* (not merge
/// position) so `frontend/src/info/highlight.ts` matches one id everywhere. See docs/architecture/mvt-feature-ids.md.
pub fn cell_namespace(name: &str) -> u32 {
    // FNV-1a over the name's bytes, folded to 21 bits.
    let mut h: u32 = 0x811c_9dc5;
    for b in name.bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    ((h >> 21) ^ h) & 0x001f_ffff
}

/// Combine a cell namespace with a per-cell RCID into a tile-unique id. See
/// [`cell_namespace`] for the bit budget (21 + 32 <= 53).
pub fn namespaced_id(namespace: u32, rcid: u32) -> u64 {
    ((namespace as u64) << 32) | rcid as u64
}

fn emit_feature(
    zoom: u8,
    namespace: u32,
    feature: &Feature,
    geometry: &Geometry,
    simplifier: &Simplifier,
    tags: &[(String, TagValue)],
    cov_tiles: Option<&BTreeMap<(u32, u32), TileCov>>,
    acc: &mut BTreeMap<TileKey, BTreeMap<String, Vec<MvtFeature>>>,
    layers: &mut BTreeSet<String>,
) {
    let Some(prepared) = prepare(geometry, simplifier) else {
        return;
    };
    let Some((xmin, xmax, ymin, ymax)) = prepared_extent(&prepared) else {
        return;
    };

    let buffer_world = (BUFFER as f64 * mvt_unit_world(zoom)).ceil() as i64;
    let n = 1i64 << zoom;
    let (txs, tys) = tile_range(
        (
            xmin - buffer_world,
            xmax + buffer_world,
            ymin - buffer_world,
            ymax + buffer_world,
        ),
        zoom,
    );
    let id = feature.rcid.map(|r| namespaced_id(namespace, r));
    let label_mid = wants_label_point(feature).then(|| ((xmin + xmax) / 2, (ymin + ymax) / 2));

    for ty in tys {
        for tx in txs.clone() {
            // wrapped (on-map) address: a seam-unwrapped column addresses
            // the tile on the other side of ±180°
            let (wx, wy) = (tx.rem_euclid(n) as u32, ty as u32);
            // the coverage partition gates feature content: no content in
            // tiles where the cell has no data coverage
            if let Some(cov) = cov_tiles {
                if !cov.get(&(wx, wy)).is_some_and(|t| t.covered) {
                    continue;
                }
            }
            let feats = cut_feature(
                &prepared,
                tags,
                id,
                label_mid,
                tile_origin(tx, ty, zoom),
                zoom,
            );
            if !feats.is_empty() {
                let layer = layer_name(feature);
                layers.insert(layer.to_string());
                acc.entry((zoom, wx, wy))
                    .or_default()
                    .entry(layer.to_string())
                    .or_default()
                    .extend(feats);
            }
        }
    }
}

/// Project, clip and encode one prepared feature into one tile (soundings
/// split per point); possibly none. `label_mid`, if in this tile's
/// half-open nominal square (exactly one tile per zoom), appends an extra
/// Point ([`wants_label_point`]) even if the polygon itself degenerates here.
fn cut_feature(
    prepared: &Prepared,
    tags: &[(String, TagValue)],
    id: Option<u64>,
    label_mid: Option<(i64, i64)>,
    origin: (i64, i64),
    zoom: u8,
) -> Vec<MvtFeature> {
    let rect = BUFFERED_RECT;
    let mut out = Vec::new();
    if let Some((mx, my)) = label_mid {
        let wpt = world_per_tile(zoom);
        if (origin.0..origin.0 + wpt).contains(&mx) && (origin.1..origin.1 + wpt).contains(&my) {
            let q = (
                project_axis(mx as World, origin.0, zoom),
                project_axis(my as World, origin.1, zoom),
            );
            out.push(MvtFeature {
                id: None,
                tags: tags.to_vec(),
                geom: MvtGeometry::Points(vec![to_i32(q)]),
            });
        }
    }
    match prepared {
        Prepared::Point(p) => {
            let q = project(*p, origin, zoom);
            if rect.contains(q) {
                out.push(MvtFeature {
                    id,
                    tags: tags.to_vec(),
                    geom: MvtGeometry::Points(vec![to_i32(q)]),
                });
            }
        }
        Prepared::MultiPoint(pts) => {
            for pz in pts {
                let q = project(pz.pos, origin, zoom);
                if rect.contains(q) {
                    let mut t = tags.to_vec();
                    t.push(("DEPTH".to_string(), TagValue::Double(pz.z)));
                    out.push(MvtFeature {
                        id: None,
                        tags: t,
                        geom: MvtGeometry::Points(vec![to_i32(q)]),
                    });
                }
            }
        }
        Prepared::Lines(lines) => {
            let mut parts = Vec::new();
            for line in lines {
                let pts: Vec<ClipPt> = line.iter().map(|p| project(*p, origin, zoom)).collect();
                for part in clip_polyline(&pts, &rect) {
                    parts.push(part.into_iter().map(to_i32).collect());
                }
            }
            if !parts.is_empty() {
                out.push(MvtFeature {
                    id,
                    tags: tags.to_vec(),
                    geom: MvtGeometry::Lines(parts),
                });
            }
        }
        Prepared::Areas(polys) => {
            let mut rings: Vec<Vec<(i32, i32)>> = Vec::new();
            for poly in polys {
                let outer = ring_to_tile(&poly.outer, origin, zoom, &rect);
                let a2 = signed_area2(&outer);
                if outer.len() < 3 || a2 == 0 {
                    continue;
                }
                rings.push(oriented(outer, a2, true));
                for hole in &poly.holes {
                    let h = ring_to_tile(hole, origin, zoom, &rect);
                    let ha2 = signed_area2(&h);
                    if h.len() < 3 || ha2 == 0 {
                        continue;
                    }
                    rings.push(oriented(h, ha2, false));
                }
            }
            if !rings.is_empty() {
                out.push(MvtFeature {
                    id,
                    tags: tags.to_vec(),
                    geom: MvtGeometry::Polygons(rings),
                });
            }
        }
    }
    out
}

fn to_i32(p: ClipPt) -> (i32, i32) {
    (p.0 as i32, p.1 as i32)
}

/// Project a closed world ring into tile space and clip it. Returns a
/// cleaned open ring (possibly empty).
fn ring_to_tile(ring: &[WorldXy], origin: (i64, i64), zoom: u8, rect: &ClipRect) -> Vec<ClipPt> {
    let mut pts: Vec<ClipPt> = ring.iter().map(|p| project(*p, origin, zoom)).collect();
    if pts.len() > 1 && pts.first() == pts.last() {
        pts.pop();
    }
    pts.dedup();
    if pts.len() < 3 {
        return Vec::new();
    }
    clip_ring(&pts, rect)
}

/// Twice the signed area of an open ring (shoelace, in MVT coordinate space
/// where y grows down). MVT wants exterior rings positive, holes negative.
fn signed_area2(ring: &[ClipPt]) -> i64 {
    let mut sum = 0i64;
    for i in 0..ring.len() {
        let a = ring[i];
        let b = ring[(i + 1) % ring.len()];
        sum += a.0 * b.1 - b.0 * a.1;
    }
    sum
}

/// Enforce MVT winding: exterior positive area, interior negative.
fn oriented(mut ring: Vec<ClipPt>, area2: i64, exterior: bool) -> Vec<(i32, i32)> {
    if (area2 > 0) != exterior {
        ring.reverse();
    }
    ring.into_iter().map(to_i32).collect()
}

/// MVT source-layer a feature lands in: its acronym, with two exceptions —
/// line-primitive DEPARE goes into `DEPCNT`, and every buoy/beacon class
/// (BOY\*, BCN\*) shares one `ATON` layer (one LUP symbol schema, specs-12.md §1.1).
fn layer_name(feature: &Feature) -> &str {
    if feature.acronym == "DEPARE" && matches!(feature.geometry, Some(Geometry::Lines(_))) {
        "DEPCNT"
    } else if feature.acronym.starts_with("BOY") || feature.acronym.starts_with("BCN") {
        "ATON"
    } else {
        &feature.acronym
    }
}

/// Classes whose *area* features get a derived label point (specs-12.md
/// §1.5), one per zoom at the bbox midpoint tile, so MapLibre doesn't repeat
/// a centred symbol/name across every clipped tile. Per-class rules: docs/architecture/mvt-label-points.md.
fn wants_label_point(feature: &Feature) -> bool {
    if !matches!(feature.geometry, Some(Geometry::Areas(_))) {
        return false;
    }
    match feature.acronym.as_str() {
        "WRECKS" | "OBSTRN" => true,
        "RESARE" | "ACHARE" | "CTNARE" | "MIPARE" | "DMPGRD" | "CBLARE" | "PIPARE" | "TSSCRS"
        | "TSSRON" | "TSSLPT" | "ISTZNE" | "PRCARE" | "FAIRWY" | "MARCUL" | "CTSARE" | "FERYRT"
        | "PRDARE" | "PILBOP" => feature.attr("sym").is_some() || feature.attr("sym_cs").is_some(),
        "SBDARE" => feature.attr("txt").is_some(),
        "LNDMRK" => feature.attr("txt").is_some(),
        "SEAARE" => feature.attr("OBJNAM").is_some() || feature.attr("NOBJNM").is_some(),
        _ => false,
    }
}

/// Render-only classes (#IAP-STRUCTURAL-STRIP): SLCONS/COALNE/LNDARE carry no
/// useful info at point, so tags are stripped to exactly what
/// `frontend/src/core/style/chartStyle.ts` filters on (plus `scamin`); the
/// frontend also excludes these layers from info-at-point (`core/info/chartProvider.ts`).
fn render_only_keep(acronym: &str) -> Option<&'static [&'static str]> {
    match acronym {
        // filter on CATCOA (dashed categories), CONRAD (radar glow), quapos
        "COALNE" => Some(&["CATCOA", "CONRAD", "quapos", "scamin"]),
        // filter on CONDTN, CATSLC (stroke weight), WATLEV (dash), quapos
        "SLCONS" => Some(&["CONDTN", "CATSLC", "WATLEV", "quapos", "scamin"]),
        // fill/point layers filter on geometry only; land-lines on quapos
        "LNDARE" => Some(&["quapos", "scamin"]),
        _ => None,
    }
}

fn attr_tags(feature: &Feature) -> Vec<(String, TagValue)> {
    let keep = render_only_keep(&feature.acronym);
    feature
        .attributes
        .iter()
        .filter(|(k, _)| keep.is_none_or(|ks| ks.contains(&k.as_str())))
        .map(|(k, v)| (k.clone(), attr_to_tag(v)))
        .collect()
}

fn join_list<T: ToString>(list: &[T]) -> String {
    list.iter().map(T::to_string).collect::<Vec<_>>().join(",")
}

fn attr_to_tag(value: &AttrValue) -> TagValue {
    match value {
        AttrValue::Int(v) => TagValue::Int(*v),
        AttrValue::Float(v) => TagValue::Double(*v),
        AttrValue::Str(v) => TagValue::Str(v.clone()),
        AttrValue::Bool(v) => TagValue::Bool(*v),
        AttrValue::IntList(v) => TagValue::Str(join_list(v)),
        AttrValue::FloatList(v) => TagValue::Str(join_list(v)),
        AttrValue::StrList(v) => TagValue::Str(v.join(",")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::lat_lon_to_world;
    use crate::model::CellMeta;

    #[test]
    fn zoom_range_from_compilation_scale() {
        assert_eq!(zoom_range_for_scale(12_000), (10, 16)); // harbor
        assert_eq!(zoom_range_for_scale(90_000), (7, 13)); // approach
        assert_eq!(zoom_range_for_scale(1_500_000), (3, 9)); // general
        assert_eq!(zoom_range_for_scale(600_000_000), (0, 0)); // clamped low
        assert_eq!(zoom_range_for_scale(1), (10, 16)); // clamped high
        assert_eq!(zoom_range_for_scale(0), zoom_range_for_scale(1));
    }

    #[test]
    fn projection_rounds_to_mvt_grid() {
        // at zoom 16 one MVT unit is 2 world units
        assert_eq!(project_axis(0, 0, 16), 0);
        assert_eq!(project_axis(1, 0, 16), 1); // rounds up at half
        assert_eq!(project_axis(2, 0, 16), 1);
        assert_eq!(project_axis(3, 0, 16), 2);
        assert_eq!(project_axis(-2, 0, 16), -1);
        // the far tile edge lands exactly on EXTENT
        let w_per_tile = 1i64 << (WORLD_BITS - 16);
        assert_eq!(project_axis(w_per_tile as World, 0, 16), EXTENT as i64);
    }

    #[test]
    fn area_and_orientation() {
        let cw = vec![(0i64, 0i64), (10, 0), (10, 10), (0, 10)]; // positive in y-down shoelace
        assert_eq!(signed_area2(&cw), 200);
        let ccw: Vec<ClipPt> = cw.iter().rev().copied().collect();
        assert_eq!(signed_area2(&ccw), -200);
        // exterior keeps positive, flips negative
        assert_eq!(oriented(cw.clone(), 200, true)[0], (0, 0));
        assert_eq!(
            oriented(ccw.clone(), -200, true),
            oriented(cw.clone(), 200, true)
        );
        // holes want negative
        assert_eq!(
            oriented(cw.clone(), 200, false),
            ccw.iter()
                .map(|p| (p.0 as i32, p.1 as i32))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn list_attributes_encode_as_joined_strings() {
        assert_eq!(
            attr_to_tag(&AttrValue::StrList(vec!["3".into(), "4".into()])),
            TagValue::Str("3,4".into())
        );
        assert_eq!(
            attr_to_tag(&AttrValue::IntList(vec![6])),
            TagValue::Str("6".into())
        );
        // set-but-empty list stays distinct from absent: empty string
        assert_eq!(
            attr_to_tag(&AttrValue::StrList(vec![])),
            TagValue::Str(String::new())
        );
        assert_eq!(attr_to_tag(&AttrValue::Int(5)), TagValue::Int(5));
        assert_eq!(attr_to_tag(&AttrValue::Float(1.5)), TagValue::Double(1.5));
    }

    /// #IAP-STRUCTURAL-STRIP: SLCONS/COALNE are render-only. Their tags keep
    /// only the attributes the chart style filters on; the info attributes
    /// (OBJNAM/INFORM/…) are dropped so a query returns nothing useful and the
    /// tiles shrink. A non-structural class keeps all of its attributes.
    #[test]
    fn render_only_classes_strip_info_attributes() {
        let make = |acronym: &str| {
            let mut attrs = std::collections::BTreeMap::new();
            attrs.insert("CATSLC".into(), AttrValue::Int(6)); // render (SLCONS)
            attrs.insert("CATCOA".into(), AttrValue::Int(6)); // render (COALNE)
            attrs.insert("quapos".into(), AttrValue::Int(4)); // render (all three)
            attrs.insert("scamin".into(), AttrValue::Int(50)); // display gate
            attrs.insert("OBJNAM".into(), AttrValue::Str("Pier 39".into())); // info
            attrs.insert("INFORM".into(), AttrValue::Str("private".into())); // info
            Feature::new(0, acronym.into(), attrs, None)
        };
        let keys = |f: &Feature| {
            let mut ks: Vec<String> = attr_tags(f).into_iter().map(|(k, _)| k).collect();
            ks.sort();
            ks
        };
        // SLCONS: keep CATSLC/quapos/scamin, drop OBJNAM/INFORM/CATCOA.
        assert_eq!(keys(&make("SLCONS")), ["CATSLC", "quapos", "scamin"]);
        // COALNE: keep CATCOA/quapos/scamin, drop OBJNAM/INFORM/CATSLC.
        assert_eq!(keys(&make("COALNE")), ["CATCOA", "quapos", "scamin"]);
        // LNDARE: fills/points filter on geometry only, land-lines on `lowacc`
        // (quapos); keep quapos/scamin, drop OBJNAM/INFORM/CATSLC/CATCOA.
        assert_eq!(keys(&make("LNDARE")), ["quapos", "scamin"]);
        // A non-render-only class is untouched — every attribute survives.
        assert_eq!(
            keys(&make("DEPARE")),
            ["CATCOA", "CATSLC", "INFORM", "OBJNAM", "quapos", "scamin"]
        );
    }

    /// A one-feature cell: a square polygon roughly 1/4 of tile (16, 10616, 25266).
    fn tiny_cell() -> Cell {
        let ring = vec![
            lat_lon_to_world(38.064, -121.688),
            lat_lon_to_world(38.064, -121.686),
            lat_lon_to_world(38.062, -121.686),
            lat_lon_to_world(38.062, -121.688),
            lat_lon_to_world(38.064, -121.688),
        ];
        let mut f = Feature::new(
            42,
            "DEPARE".into(),
            std::collections::BTreeMap::new(),
            Some(Geometry::Areas(vec![Polygon {
                outer: ring,
                holes: vec![],
            }])),
        );
        f.rcid = Some(1);
        let extent = f.extent;
        Cell {
            meta: CellMeta::default(),
            features: vec![f],
            extent,
        }
    }

    /// A DEPARE cell like [`tiny_cell`] but nudged east by `dx` world units and
    /// tagged with depth `drval1 = k`, so each cell in a batch cuts to distinct
    /// MVT bytes. Builds the offset ring *before* [`Feature::new`], so the
    /// derived extent is correct.
    fn nudged_cell(dx: i32, k: i64) -> Cell {
        let base = [
            lat_lon_to_world(38.064, -121.688),
            lat_lon_to_world(38.064, -121.686),
            lat_lon_to_world(38.062, -121.686),
            lat_lon_to_world(38.062, -121.688),
            lat_lon_to_world(38.064, -121.688),
        ];
        let ring = base
            .into_iter()
            .map(|mut p| {
                p.x += dx;
                p
            })
            .collect();
        let mut attrs = std::collections::BTreeMap::new();
        attrs.insert("drval1".to_string(), AttrValue::Float(k as f64));
        let mut f = Feature::new(
            42,
            "DEPARE".into(),
            attrs,
            Some(Geometry::Areas(vec![Polygon {
                outer: ring,
                holes: vec![],
            }])),
        );
        f.rcid = Some(1);
        let extent = f.extent;
        Cell {
            meta: CellMeta::default(),
            features: vec![f],
            extent,
        }
    }

    /// Determinism guarantee for #PERF-CHARTCORE: cutting the same batch of
    /// per-cell tasks serially (`parallelism = 1`) and across the shared bounded
    /// pool (`parallelism = N`) must produce a **byte-identical** result vector,
    /// in the same task order, so the tileset is independent of the knob. The
    /// serial branch is the current code path; the parallel branch only reorders
    /// *when* each independent cut runs, never *which* result lands at which
    /// index (`par_iter().collect()` is index-preserving).
    #[test]
    fn cut_tiles_parallel_matches_serial() {
        // The z16 tile the cell's anchor lands in (same derivation as merge.rs).
        let z = 16u8;
        let anchor = lat_lon_to_world(38.063, -121.687);
        let wpt = world_per_tile(z);
        let min = crate::coords::WORLD_MIN as i64;
        let x = ((anchor.x as i64 - min) / wpt) as u32;
        let y = ((anchor.y as i64 - min) / wpt) as u32;
        // Eight overlapping cells at the same tile, coarse→fine, each masked by
        // the coverage of every later (finer) cell — the real serve_tile shape,
        // so the parallel cuts do genuine overlay work, not just no-op passes.
        let n = 8i64;
        let tilers: Vec<CellTiler> = (0..n)
            .map(|k| CellTiler::new(nudged_cell((k * 4) as i32, k)))
            .collect();
        let covs: Vec<Coverage> = (0..n)
            .map(|k| {
                let f0 = 0.05 * k as f64;
                Coverage::from_rings(
                    vec![tile_frac_rect(z, x as i64, y as i64, f0, f0 + 0.6)],
                    vec![],
                )
                .expect("coverage rect")
            })
            .collect();
        let tasks: Vec<CutTask<'_>> = (0..n as usize)
            .map(|k| CutTask {
                tiler: &tilers[k],
                finer: covs[k + 1..].iter().collect(),
            })
            .collect();

        let serial = cut_tiles(&tasks, z, x, y, 1);
        // The test is only meaningful if some cell actually emits geometry.
        assert!(
            serial.iter().any(Option::is_some),
            "batch produced no cuts — test would be vacuous"
        );
        for p in [2usize, 3, 4, 8] {
            let parallel = cut_tiles(&tasks, z, x, y, p);
            assert_eq!(
                serial, parallel,
                "cut output differs between parallelism 1 and {p}"
            );
        }
    }

    #[test]
    fn build_tileset_emits_expected_tiles() {
        let cell = tiny_cell();
        let ts = build_tileset(&cell, 10, 12);
        assert_eq!(ts.layers.iter().collect::<Vec<_>>(), vec!["DEPARE"]);
        // present at every zoom of the range
        for z in 10..=12u8 {
            assert!(
                ts.tiles.keys().any(|(kz, _, _)| *kz == z),
                "no tile at zoom {z}"
            );
        }
        // every tile decodes to a DEPARE polygon with our id
        for (key, bytes) in &ts.tiles {
            let tile = decode::decode_tile(bytes).unwrap();
            let layer = tile.layer("DEPARE").unwrap_or_else(|| panic!("{key:?}"));
            assert_eq!(layer.features.len(), 1);
            let f = &layer.features[0];
            // the RCID, namespaced by the cell's (here empty) name — see
            // cell_namespace
            assert_eq!(f.id, Some(namespaced_id(cell_namespace(""), 1)));
            assert_eq!(f.geom_type, decode::GeomType::Polygon);
            assert!(
                signed_area2(
                    &f.parts[0]
                        .iter()
                        .map(|p| (p.0 as i64, p.1 as i64))
                        .collect::<Vec<_>>()
                ) > 0
            );
        }
        // determinism: a second build is byte-identical
        let ts2 = build_tileset(&cell, 10, 12);
        assert_eq!(ts, ts2);
    }

    #[test]
    fn line_primitive_depare_routes_into_depcnt() {
        let mut cell = tiny_cell();
        let mut attrs = std::collections::BTreeMap::new();
        attrs.insert("drval1".to_string(), AttrValue::Float(5.4));
        attrs.insert("drval2".to_string(), AttrValue::Float(9.1));
        let mut f = Feature::new(
            42,
            "DEPARE".into(),
            attrs,
            Some(Geometry::Lines(vec![vec![
                lat_lon_to_world(38.064, -121.688),
                lat_lon_to_world(38.062, -121.686),
            ]])),
        );
        f.rcid = Some(7);
        cell.extent.extend(&f.extent);
        cell.features.push(f);

        let ts = build_tileset(&cell, 12, 12);
        assert!(ts.layers.contains("DEPCNT"), "{:?}", ts.layers);
        let (_, bytes) = ts.tiles.iter().next().unwrap();
        let tile = decode::decode_tile(bytes).unwrap();
        // the line landed in DEPCNT with its contour attributes …
        let depcnt = tile.layer("DEPCNT").expect("DEPCNT layer");
        assert_eq!(depcnt.features.len(), 1);
        let lf = &depcnt.features[0];
        assert_eq!(lf.geom_type, decode::GeomType::Line);
        assert_eq!(lf.tags.get("drval1"), Some(&TagValue::Double(5.4)));
        // … and the area DEPARE still has only the polygon
        let depare = tile.layer("DEPARE").expect("DEPARE layer");
        assert_eq!(depare.features.len(), 1);
        assert_eq!(depare.features[0].geom_type, decode::GeomType::Polygon);
        // CellTiler agrees byte-for-byte
        assert_cut_matches(&cell, 12, 12);
    }

    #[test]
    fn bool_attributes_encode_as_bool_tags() {
        assert_eq!(attr_to_tag(&AttrValue::Bool(true)), TagValue::Bool(true));
    }

    #[test]
    fn buoys_and_beacons_route_into_aton() {
        let mut cell = tiny_cell();
        for (i, acronym) in ["BOYLAT", "BCNSPP"].iter().enumerate() {
            let mut f = Feature::new(
                0,
                (*acronym).into(),
                std::collections::BTreeMap::new(),
                Some(Geometry::Point(lat_lon_to_world(38.063, -121.687))),
            );
            f.rcid = Some(10 + i as u32);
            cell.extent.extend(&f.extent);
            cell.features.push(f);
        }
        let ts = build_tileset(&cell, 12, 12);
        assert!(ts.layers.contains("ATON"), "{:?}", ts.layers);
        assert!(!ts.layers.contains("BOYLAT"));
        assert!(!ts.layers.contains("BCNSPP"));
        let (_, bytes) = ts.tiles.iter().next().unwrap();
        let tile = decode::decode_tile(bytes).unwrap();
        assert_eq!(tile.layer("ATON").unwrap().features.len(), 2);
        assert_cut_matches(&cell, 12, 12);
    }

    #[test]
    fn hazard_and_restricted_areas_emit_one_label_point_per_zoom() {
        // a RESARE polygon with a centred symbol, spanning several z16 tiles
        let mut attrs = std::collections::BTreeMap::new();
        attrs.insert("sym".to_string(), AttrValue::Str("no-entry".into()));
        let mut f = Feature::new(
            112,
            "RESARE".into(),
            attrs,
            Some(Geometry::Areas(vec![Polygon {
                outer: ring(38.070, 38.055, -121.695, -121.680),
                holes: vec![],
            }])),
        );
        f.rcid = Some(9);
        let extent = f.extent;
        let cell = Cell {
            meta: CellMeta::default(),
            features: vec![f],
            extent,
        };

        let ts = build_tileset(&cell, 15, 16);
        for z in [15u8, 16] {
            let mut points = 0;
            let mut polys = 0;
            for ((kz, _, _), bytes) in &ts.tiles {
                if *kz != z {
                    continue;
                }
                let tile = decode::decode_tile(bytes).unwrap();
                if let Some(layer) = tile.layer("RESARE") {
                    for feat in &layer.features {
                        match feat.geom_type {
                            decode::GeomType::Point => {
                                points += 1;
                                // the label point carries the same attributes
                                assert_eq!(
                                    feat.tags.get("sym"),
                                    Some(&TagValue::Str("no-entry".into()))
                                );
                                assert_eq!(feat.id, None);
                            }
                            decode::GeomType::Polygon => polys += 1,
                            other => panic!("unexpected geometry {other:?}"),
                        }
                    }
                }
            }
            assert_eq!(points, 1, "exactly one label point at z{z}");
            assert!(polys >= 1, "polygon still present at z{z}");
        }
        assert_cut_matches(&cell, 15, 16);

        // a restricted area *without* sym/sym_cs gets no label point;
        // an OBSTRN area always gets one
        let plain = Feature::new(
            112,
            "RESARE".into(),
            std::collections::BTreeMap::new(),
            Some(Geometry::Areas(vec![Polygon {
                outer: ring(38.070, 38.055, -121.695, -121.680),
                holes: vec![],
            }])),
        );
        assert!(!wants_label_point(&plain));
        let obstrn = Feature::new(
            86,
            "OBSTRN".into(),
            std::collections::BTreeMap::new(),
            Some(Geometry::Areas(vec![Polygon {
                outer: ring(38.070, 38.055, -121.695, -121.680),
                holes: vec![],
            }])),
        );
        assert!(wants_label_point(&obstrn));
        // points and lines never qualify
        let pt = Feature::new(
            86,
            "OBSTRN".into(),
            std::collections::BTreeMap::new(),
            Some(Geometry::Point(lat_lon_to_world(38.06, -121.69))),
        );
        assert!(!wants_label_point(&pt));

        // SEAARE qualifies on its NAME (either spelling), and only on it:
        // the label point is what keeps a multi-tile bay/river from having
        // its name repeated once per clipped tile.
        for (attr, want) in [("OBJNAM", true), ("NOBJNM", true), ("CATSEA", false)] {
            let mut attrs = std::collections::BTreeMap::new();
            attrs.insert(attr.to_string(), AttrValue::Str("Taylor Slough".into()));
            let sea = Feature::new(
                119,
                "SEAARE".into(),
                attrs,
                Some(Geometry::Areas(vec![Polygon {
                    outer: ring(38.070, 38.055, -121.695, -121.680),
                    holes: vec![],
                }])),
            );
            assert_eq!(wants_label_point(&sea), want, "SEAARE with {attr}");
        }
    }

    #[test]
    fn feature_smaller_than_a_pixel_is_culled() {
        let cell = tiny_cell();
        // at zoom 0 the ~200 m square collapses below one MVT unit
        let ts = build_tileset(&cell, 0, 0);
        assert!(ts.tiles.is_empty());
    }

    fn ring(n: f64, s: f64, w: f64, e: f64) -> Vec<WorldXy> {
        vec![
            lat_lon_to_world(n, w),
            lat_lon_to_world(n, e),
            lat_lon_to_world(s, e),
            lat_lon_to_world(s, w),
            lat_lon_to_world(n, w),
        ]
    }

    fn m_covr(catcov: i64, polys: Vec<Polygon>) -> Feature {
        let mut attrs = std::collections::BTreeMap::new();
        attrs.insert("CATCOV".to_string(), AttrValue::Int(catcov));
        Feature::new(302, "M_COVR".into(), attrs, Some(Geometry::Areas(polys)))
    }

    fn with_coverage(mut cell: Cell, covr: Feature) -> Cell {
        cell.extent.extend(&covr.extent);
        cell.features.push(covr);
        cell
    }

    /// Signed areas of a decoded polygon's rings, in emission order.
    fn ring_signs(bytes: &[u8], layer: &str) -> Vec<bool> {
        let tile = decode::decode_tile(bytes).unwrap();
        let l = tile
            .layer(layer)
            .unwrap_or_else(|| panic!("{layer} missing"));
        assert_eq!(l.features.len(), 1);
        l.features[0]
            .parts
            .iter()
            .map(|r| {
                signed_area2(
                    &r.iter()
                        .map(|p| (p.0 as i64, p.1 as i64))
                        .collect::<Vec<_>>(),
                ) > 0
            })
            .collect()
    }

    /// The set-level claim: one whole-tile `_nodata` exterior, no cell
    /// involved, and the same bytes for every tile (see [`nodata_tile`] —
    /// which is why the backend can build it once and merge it in).
    #[test]
    fn nodata_tile_is_a_whole_tile_claim() {
        let bytes = nodata_tile();
        let tile = decode::decode_tile(&bytes).unwrap();
        assert_eq!(
            tile.layers
                .iter()
                .map(|l| l.name.as_str())
                .collect::<Vec<_>>(),
            vec![NODATA_LAYER]
        );
        // one exterior ring (positive area), spanning the buffered rect
        assert_eq!(ring_signs(&bytes, NODATA_LAYER), vec![true]);
        let f = &tile.layer(NODATA_LAYER).unwrap().features[0];
        let xs: Vec<i32> = f.parts[0].iter().map(|p| p.0).collect();
        let ys: Vec<i32> = f.parts[0].iter().map(|p| p.1).collect();
        assert_eq!(
            (
                *xs.iter().min().unwrap(),
                *xs.iter().max().unwrap(),
                *ys.iter().min().unwrap(),
                *ys.iter().max().unwrap(),
            ),
            (
                -BUFFER as i32,
                EXTENT as i32 + BUFFER as i32,
                -BUFFER as i32,
                EXTENT as i32 + BUFFER as i32,
            )
        );
    }

    /// The claim merges like any other cut, and a cell's own fills draw over
    /// it — which is what lets the set over-claim the whole tile instead of
    /// paying a polygon boolean per tile to subtract coverage back out.
    #[test]
    fn nodata_tile_merges_under_a_cell_cut() {
        let cell = tiny_cell();
        let ts = build_tileset(&cell, 16, 16);
        let (z, x, y) = *ts.tiles.keys().next().expect("a tile");
        let cut = CellTiler::new(cell.clone()).cut(z, x, y).expect("cell cut");
        let merged = merge::merge_tiles(&[nodata_tile(), cut]).unwrap();
        let tile = decode::decode_tile(&merged).unwrap();
        let names: Vec<&str> = tile.layers.iter().map(|l| l.name.as_str()).collect();
        assert!(names.contains(&NODATA_LAYER), "{names:?}");
        assert!(names.contains(&"DEPARE"), "{names:?}");
        assert_eq!(tile.layer(NODATA_LAYER).unwrap().features.len(), 1);
    }

    /// Regression: partial coverage used to emit "buffered tile rect minus
    /// coverage" as `_nodata` — asserting AC(NODTA) over every part of the
    /// tile the cell merely says nothing about. Only declared no-coverage
    /// earns the claim, and a cell that simply stops has declared nothing.
    ///
    /// Still true, and not in tension with [`nodata_tile`]: that rect is the
    /// *set's*, made where every cell of the set has been enumerated and
    /// none of them charts the tile. This one was a single cell's, made from
    /// its own coverage merely ending — which is not evidence of anything
    /// (see "Whose claim is it" in the module docs).
    #[test]
    fn partial_coverage_claims_no_nodata() {
        // coverage == the DEPARE square: a quarter of the z16 tile, so the
        // tile is partially covered
        let covr = m_covr(
            1,
            vec![Polygon {
                outer: ring(38.064, 38.062, -121.688, -121.686),
                holes: vec![],
            }],
        );
        let cell = with_coverage(tiny_cell(), covr);
        let ts = build_tileset(&cell, 16, 16);
        assert!(!ts.layers.contains(NODATA_LAYER), "{:?}", ts.layers);
        for (key, bytes) in &ts.tiles {
            let tile = decode::decode_tile(bytes).unwrap();
            assert!(tile.layer(NODATA_LAYER).is_none(), "{key:?}");
        }
        // the DEPARE feature is still emitted in its (covered) tile
        let tile = decode::decode_tile(ts.tiles.values().next().unwrap()).unwrap();
        assert!(tile.layer("DEPARE").is_some());
    }

    /// Regression (the shape the user kept seeing): a tile inside the
    /// coverage extent's bounding box but touching no coverage ring. The
    /// bbox is an artefact of coverage being non-rectangular, not evidence
    /// about the world — over a chart set bounding a country it is mostly
    /// dry land. It used to yield the tile rect with nothing subtracted:
    /// one wholly grey tile, hard tile-shaped edges and all.
    #[test]
    fn tile_inside_coverage_bbox_but_uncovered_is_not_emitted() {
        // two coverage squares on opposite corners of the bbox …
        let cell = with_coverage(
            with_coverage(
                tiny_cell(),
                m_covr(
                    1,
                    vec![Polygon {
                        outer: ring(38.0695, 38.0685, -121.6945, -121.6935),
                        holes: vec![],
                    }],
                ),
            ),
            m_covr(
                1,
                vec![Polygon {
                    outer: ring(38.0575, 38.0565, -121.6805, -121.6795),
                    holes: vec![],
                }],
            ),
        );
        let ts = build_tileset(&cell, 16, 16);
        assert!(!ts.layers.contains(NODATA_LAYER), "{:?}", ts.layers);
        // … and every emitted tile really does hold coverage: no tile
        // exists solely to assert grey
        assert!(!ts.tiles.is_empty());
        for (key, bytes) in &ts.tiles {
            let tile = decode::decode_tile(bytes).unwrap();
            assert!(
                tile.layers.iter().any(|l| l.name != NODATA_LAYER),
                "{key:?}: nodata-only tile"
            );
        }
    }

    #[test]
    fn feature_outside_coverage_is_dropped() {
        // coverage several z16 tiles west of the DEPARE square
        let covr = m_covr(
            1,
            vec![Polygon {
                outer: ring(38.064, 38.062, -121.700, -121.698),
                holes: vec![],
            }],
        );
        let cell = with_coverage(tiny_cell(), covr);
        let ts = build_tileset(&cell, 16, 16);
        assert!(!ts.layers.contains("DEPARE"), "{:?}", ts.layers);
        for bytes in ts.tiles.values() {
            let tile = decode::decode_tile(bytes).unwrap();
            assert!(tile.layer("DEPARE").is_none());
        }
    }

    #[test]
    fn catcov2_becomes_nodata_island() {
        // CATCOV=1 quarter-tile square with a CATCOV=2 area inside it
        let cov1 = m_covr(
            1,
            vec![Polygon {
                outer: ring(38.064, 38.062, -121.688, -121.686),
                holes: vec![],
            }],
        );
        let cov2 = m_covr(
            2,
            vec![Polygon {
                outer: ring(38.0635, 38.0625, -121.6875, -121.6865),
                holes: vec![],
            }],
        );
        let cell = with_coverage(with_coverage(tiny_cell(), cov1), cov2);
        let ts = build_tileset(&cell, 16, 16);
        let (_, bytes) = ts.tiles.iter().next().unwrap();
        // one solid island (+), MVT-exterior wound: the declared area and
        // nothing else. This is the claim PLAN.md's AC(NODTA) is for — the
        // producer said "no coverage here", so the mariner is told so.
        assert_eq!(ring_signs(bytes, NODATA_LAYER), vec![true]);
        let tile = decode::decode_tile(bytes).unwrap();
        let nd = &tile.layer(NODATA_LAYER).unwrap().features[0];
        assert_eq!(nd.id, None);
        assert!(nd.tags.is_empty());
        // strictly inside the tile: the island is the CATCOV=2 square
        assert!(nd.parts[0]
            .iter()
            .all(|p| p.0 > 0 && p.0 < EXTENT as i32 && p.1 > 0 && p.1 < EXTENT as i32));
    }

    /// Regression (finding #2): a feature crossing ±180° used to get a
    /// world-spanning extent (lon normalized to [-180, 180]) — ~1.4M tile
    /// iterations per feature and garbage polygon bands in mid-ocean tiles.
    #[test]
    fn antimeridian_crossing_feature_stays_at_seam() {
        // a small square straddling the antimeridian at ~38N
        let ring = vec![
            lat_lon_to_world(38.06, 179.99),
            lat_lon_to_world(38.06, -179.99),
            lat_lon_to_world(38.04, -179.99),
            lat_lon_to_world(38.04, 179.99),
            lat_lon_to_world(38.06, 179.99),
        ];
        let mut f = Feature::new(
            42,
            "DEPARE".into(),
            std::collections::BTreeMap::new(),
            Some(Geometry::Areas(vec![Polygon {
                outer: ring,
                holes: vec![],
            }])),
        );
        f.rcid = Some(1);
        let extent = f.extent;
        let cell = Cell {
            meta: CellMeta::default(),
            features: vec![f],
            extent,
        };

        let ts = build_tileset(&cell, 8, 8);
        // no tile bomb, no mid-ocean garbage: only the two seam columns
        let xs: std::collections::BTreeSet<u32> = ts.tiles.keys().map(|(_, x, _)| *x).collect();
        assert_eq!(xs, [0u32, 255].into(), "tiles: {:?}", ts.tiles.keys());
        assert!(ts.tiles.len() <= 4, "{} tiles", ts.tiles.len());
        // both sides decode to a real DEPARE polygon
        for (key, bytes) in &ts.tiles {
            let tile = decode::decode_tile(bytes).unwrap();
            let layer = tile.layer("DEPARE").unwrap_or_else(|| panic!("{key:?}"));
            let f = &layer.features[0];
            assert_eq!(f.geom_type, decode::GeomType::Polygon);
            let a2 = signed_area2(
                &f.parts[0]
                    .iter()
                    .map(|p| (p.0 as i64, p.1 as i64))
                    .collect::<Vec<_>>(),
            );
            assert!(a2 > 0, "{key:?}: degenerate polygon");
        }
    }

    /// Regression (finding #2, coverage side): M_COVR crossing the seam
    /// used to invert the coverage classification and drop real content.
    #[test]
    fn antimeridian_coverage_gates_at_seam() {
        // coverage straddles the seam; the DEPARE square sits just west of it
        let cov_ring = vec![
            lat_lon_to_world(38.06, 179.98),
            lat_lon_to_world(38.06, -179.98),
            lat_lon_to_world(38.04, -179.98),
            lat_lon_to_world(38.04, 179.98),
            lat_lon_to_world(38.06, 179.98),
        ];
        let feat_ring = vec![
            lat_lon_to_world(38.055, 179.985),
            lat_lon_to_world(38.055, 179.995),
            lat_lon_to_world(38.045, 179.995),
            lat_lon_to_world(38.045, 179.985),
            lat_lon_to_world(38.055, 179.985),
        ];
        let mut f = Feature::new(
            42,
            "DEPARE".into(),
            std::collections::BTreeMap::new(),
            Some(Geometry::Areas(vec![Polygon {
                outer: feat_ring,
                holes: vec![],
            }])),
        );
        f.rcid = Some(1);
        let covr = m_covr(
            1,
            vec![Polygon {
                outer: cov_ring,
                holes: vec![],
            }],
        );
        let mut extent = f.extent;
        extent.extend(&covr.extent);
        let cell = Cell {
            meta: CellMeta::default(),
            features: vec![f, covr],
            extent,
        };

        let ts = build_tileset(&cell, 8, 8);
        // the coverage partition must not invert: the feature survives
        assert!(ts.layers.contains("DEPARE"), "{:?}", ts.layers);
        // and only seam-column tiles exist
        let xs: std::collections::BTreeSet<u32> = ts.tiles.keys().map(|(_, x, _)| *x).collect();
        assert_eq!(xs, [0u32, 255].into(), "tiles: {:?}", ts.tiles.keys());
        // the western seam tile carries the feature
        let west = ts
            .tiles
            .iter()
            .find(|((_, x, _), _)| *x == 255)
            .map(|(_, bytes)| decode::decode_tile(bytes).unwrap())
            .expect("west seam tile");
        assert!(west.layer("DEPARE").is_some());
    }

    /// CellTiler::cut must reproduce build_tileset byte-for-byte: every
    /// tile of the tileset identical, and a window of addresses around it
    /// (plus out-of-range addresses) must cut to None.
    fn assert_cut_matches(cell: &Cell, min_zoom: u8, max_zoom: u8) {
        let ts = build_tileset(cell, min_zoom, max_zoom);
        assert!(!ts.tiles.is_empty(), "test cell produced no tiles");
        let tiler = CellTiler::new(cell.clone());
        for ((z, x, y), bytes) in &ts.tiles {
            assert_eq!(
                tiler.cut(*z, *x, *y).as_deref(),
                Some(bytes.as_slice()),
                "tile {z}/{x}/{y} differs"
            );
        }
        // absent addresses cut to None (window around each built tile)
        for (z, x, y) in ts.tiles.keys().copied().collect::<Vec<_>>() {
            let n = 1u32 << z;
            for (dx, dy) in [(-2i64, 0i64), (2, 0), (0, -2), (0, 2), (2, 2)] {
                let (qx, qy) = ((x as i64 + dx).rem_euclid(n as i64) as u32, y as i64 + dy);
                if qy < 0 || qy >= n as i64 {
                    continue;
                }
                let key = (z, qx, qy as u32);
                if !ts.tiles.contains_key(&key) {
                    assert_eq!(tiler.cut(z, qx, qy as u32), None, "{key:?} should be empty");
                }
            }
        }
        // out-of-range addresses
        assert_eq!(tiler.cut(21, 0, 0), None);
        assert_eq!(tiler.cut(min_zoom, 1 << min_zoom, 0), None);
        assert_eq!(tiler.cut(min_zoom, 0, 1 << min_zoom), None);
    }

    #[test]
    fn cell_tiler_matches_build_tileset() {
        // plain cell, multiple zooms
        assert_cut_matches(&tiny_cell(), 10, 16);
        // partial coverage (nodata complement + gating)
        let covr = m_covr(
            1,
            vec![Polygon {
                outer: ring(38.064, 38.062, -121.688, -121.686),
                holes: vec![],
            }],
        );
        assert_cut_matches(&with_coverage(tiny_cell(), covr), 12, 16);
        // feature outside coverage (fully gated away)
        let covr = m_covr(
            1,
            vec![Polygon {
                outer: ring(38.064, 38.062, -121.700, -121.698),
                holes: vec![],
            }],
        );
        assert_cut_matches(&with_coverage(tiny_cell(), covr), 16, 16);
        // CATCOV=2 island
        let cov1 = m_covr(
            1,
            vec![Polygon {
                outer: ring(38.064, 38.062, -121.688, -121.686),
                holes: vec![],
            }],
        );
        let cov2 = m_covr(
            2,
            vec![Polygon {
                outer: ring(38.0635, 38.0625, -121.6875, -121.6865),
                holes: vec![],
            }],
        );
        assert_cut_matches(
            &with_coverage(with_coverage(tiny_cell(), cov1), cov2),
            16,
            16,
        );
        // soundings (per-point split with DEPTH tags)
        let mut cell = tiny_cell();
        let sndg = Feature::new(
            129,
            "SOUNDG".into(),
            std::collections::BTreeMap::new(),
            Some(Geometry::MultiPoint(vec![
                PointZ {
                    pos: lat_lon_to_world(38.063, -121.687),
                    z: 5.5,
                },
                PointZ {
                    pos: lat_lon_to_world(38.0635, -121.6875),
                    z: 2.0,
                },
            ])),
        );
        cell.extent.extend(&sndg.extent);
        cell.features.push(sndg);
        assert_cut_matches(&cell, 14, 16);
    }

    #[test]
    fn cell_tiler_matches_at_antimeridian() {
        // seam-crossing feature and coverage (regression twins of the
        // build_tileset antimeridian tests)
        let cov_ring = vec![
            lat_lon_to_world(38.06, 179.98),
            lat_lon_to_world(38.06, -179.98),
            lat_lon_to_world(38.04, -179.98),
            lat_lon_to_world(38.04, 179.98),
            lat_lon_to_world(38.06, 179.98),
        ];
        let feat_ring = vec![
            lat_lon_to_world(38.055, 179.985),
            lat_lon_to_world(38.055, -179.995),
            lat_lon_to_world(38.045, -179.995),
            lat_lon_to_world(38.045, 179.985),
            lat_lon_to_world(38.055, 179.985),
        ];
        let mut f = Feature::new(
            42,
            "DEPARE".into(),
            std::collections::BTreeMap::new(),
            Some(Geometry::Areas(vec![Polygon {
                outer: feat_ring,
                holes: vec![],
            }])),
        );
        f.rcid = Some(1);
        let covr = m_covr(
            1,
            vec![Polygon {
                outer: cov_ring,
                holes: vec![],
            }],
        );
        let mut extent = f.extent;
        extent.extend(&covr.extent);
        let cell = Cell {
            meta: CellMeta::default(),
            features: vec![f, covr],
            extent,
        };
        assert_cut_matches(&cell, 7, 9);
    }

    #[test]
    fn fully_covered_tile_has_no_nodata() {
        // coverage much larger than the tile: the tile is fully covered
        let covr = m_covr(
            1,
            vec![Polygon {
                outer: ring(38.2, 37.9, -121.9, -121.5),
                holes: vec![],
            }],
        );
        let cell = with_coverage(tiny_cell(), covr);
        let ts = build_tileset(&cell, 16, 16);
        let bytes = ts.tiles.get(&(16, 10615, 25264)).expect("feature tile");
        let tile = decode::decode_tile(bytes).unwrap();
        assert!(tile.layer("DEPARE").is_some());
        assert!(tile.layer(NODATA_LAYER).is_none());
        // nor do the coverage-edge tiles: a coverage boundary is where the
        // cell stops speaking, not where it declares the sea uncharted
        assert!(!ts.layers.contains(NODATA_LAYER), "{:?}", ts.layers);
    }

    /// A world-coordinate rectangle spanning fractions `[fx0, fx1)` of tile
    /// `zoom`/`tx`/`ty`'s width, full height. Unwound: `from_rings`
    /// normalizes orientation.
    fn tile_frac_rect(zoom: u8, tx: i64, ty: i64, fx0: f64, fx1: f64) -> Vec<WorldXy> {
        let (ox, oy) = tile_origin(tx, ty, zoom);
        let wpt = world_per_tile(zoom) as f64;
        let x0 = (ox as f64 + fx0 * wpt) as i32;
        let x1 = (ox as f64 + fx1 * wpt) as i32;
        let (y0, y1) = (oy as i32, (oy + world_per_tile(zoom)) as i32);
        vec![
            WorldXy::new(x0, y0),
            WorldXy::new(x1, y0),
            WorldXy::new(x1, y1),
            WorldXy::new(x0, y1),
            WorldXy::new(x0, y0),
        ]
    }

    /// A cell whose declared no-coverage is *disjoint* from its coverage —
    /// the normal S-57 M_COVR partition — and whose CATCOV=2 area exceeds
    /// its CATCOV=1 area in the tile. Classifying by the scalar sum of
    /// winding-signed clipped areas computes `covered − uncovered`, which
    /// goes negative here and reads the tile as charting nothing, though
    /// 45% of it is positively charted.
    ///
    /// Measured from OC-45-C94902 at z13/4374/2540 (~55% NOCOVR, ~45%
    /// COVR): the whole Øresund chart family flipped to `Uncovered` at
    /// once, `_charting_cells` returned `[]`, and the backend served a
    /// whole-tile `_nodata` grey over charted water.
    #[test]
    fn disjoint_nocovr_larger_than_covr_is_partial_not_uncovered() {
        let (zoom, tx, ty) = (13u8, 4374i64, 2540i64);
        let cov = Coverage::from_rings(
            vec![tile_frac_rect(zoom, tx, ty, 0.0, 0.45)],
            vec![tile_frac_rect(zoom, tx, ty, 0.45, 1.0)],
        )
        .expect("positive ring present");

        assert_eq!(
            coverage_tile_state(&cov, zoom, tx as u32, ty as u32),
            TileState::Partial,
            "45% charted + 55% declared-uncharted must be Partial: the \
             nonzero winding rule is a point-membership test, it does not \
             distribute over area summation"
        );

        // and the same question asked by the cut path, which gates feature
        // emission (`cut_masked`): a false `covered` would swap the lying
        // grey for an equally lying empty tile
        let rings = cov_rings_at_zoom(&cov, zoom).expect("rings at zoom");
        let tc = classify_tile(&rings, tile_origin(tx, ty, zoom), zoom);
        assert!(tc.covered, "positively-charted area must count as covered");
    }

    /// The control the fix must not break: no positively-wound area
    /// surviving the clip really is `Uncovered`, and a blanketing cell
    /// really is `Full` — whole-tile authority must not start dropping
    /// chart.
    #[test]
    fn coverage_tile_state_endpoints_unchanged() {
        let (zoom, tx, ty) = (13u8, 4374i64, 2540i64);

        // coverage entirely in the neighbouring column: nothing positive
        // survives clipping to this tile
        let elsewhere =
            Coverage::from_rings(vec![tile_frac_rect(zoom, tx + 1, ty, 0.0, 1.0)], vec![]).unwrap();
        assert_eq!(
            coverage_tile_state(&elsewhere, zoom, tx as u32, ty as u32),
            TileState::Uncovered
        );

        // a cell blanketing the tile and well beyond it
        let blanket =
            Coverage::from_rings(vec![tile_frac_rect(zoom, tx - 1, ty, 0.0, 3.0)], vec![]).unwrap();
        assert_eq!(
            coverage_tile_state(&blanket, zoom, tx as u32, ty as u32),
            TileState::Full
        );
    }
}

/// Server-side SCAMIN drop: the kept set at a tile's integer zoom must equal
/// what the frontend `scaminVisible` filter would show there, with the finest
/// (overzoomed) tile exempt.
#[cfg(test)]
mod overview_simplify_tests {
    use super::*;
    use std::collections::BTreeMap;

    fn p(x: i32, y: i32) -> WorldXy {
        WorldXy::new(x, y)
    }

    fn feature(acronym: &str, geometry: Option<Geometry>) -> Feature {
        Feature::new(0, acronym.into(), BTreeMap::new(), geometry)
    }

    const COARSE: Simplifier = Simplifier {
        fine: 1.0,
        coarse: Some(4.0),
    };

    #[test]
    fn only_the_heavy_layers_at_overview_zooms_go_coarse() {
        let depth = feature("DEPARE", None);
        assert!(Simplifier::for_feature(5, &depth).coarse.is_some());
        assert!(Simplifier::for_feature(7, &depth).coarse.is_some());
        assert!(Simplifier::for_feature(4, &depth).coarse.is_none());
        assert!(Simplifier::for_feature(8, &depth).coarse.is_none());
        for hazard in ["OBSTRN", "WRECKS", "UWTROC", "RESARE", "TSSLPT"] {
            assert!(Simplifier::for_feature(7, &feature(hazard, None))
                .coarse
                .is_none());
        }
    }

    #[test]
    fn a_line_primitive_depare_goes_coarse_under_its_depcnt_layer() {
        let contour = feature("DEPARE", Some(Geometry::Lines(vec![])));
        assert_eq!(layer_name(&contour), "DEPCNT");
        assert!(Simplifier::for_feature(7, &contour).coarse.is_some());
    }

    #[test]
    fn a_wide_ring_loses_its_sub_tolerance_wiggles() {
        let ring = [
            p(0, 0),
            p(50, 3),
            p(100, 0),
            p(100, 100),
            p(50, 97),
            p(0, 100),
            p(0, 0),
        ];
        assert_eq!(COARSE.ring(&ring).len(), 5);
    }

    #[test]
    fn a_thin_strip_keeps_its_fine_shape() {
        // Three units wide: the coarse pass flattens it to almost no area.
        let strip = [
            p(0, 0),
            p(100, 1),
            p(200, 0),
            p(200, 3),
            p(100, 4),
            p(0, 3),
            p(0, 0),
        ];
        assert_eq!(COARSE.ring(&strip), simplify(&strip, 1.0));
    }

    #[test]
    fn a_closed_contour_is_guarded_like_a_ring() {
        let loop_ = [p(0, 0), p(100, 1), p(200, 0), p(100, 3), p(0, 0)];
        assert_eq!(COARSE.line(&loop_), simplify(&loop_, 1.0));
    }

    #[test]
    fn an_open_line_that_zigzags_within_the_tolerance_keeps_its_length() {
        let zigzag = [p(0, 0), p(3, 1), p(0, 2), p(3, 3), p(0, 4), p(3, 5)];
        assert_eq!(COARSE.line(&zigzag), simplify(&zigzag, 1.0));
    }
}

#[cfg(test)]
mod scamin_drop_tests {
    use super::*;
    use crate::mvt::decode::decode_tile;

    fn feat(scamin: Option<i64>) -> MvtFeature {
        let mut tags = vec![("OBJL".to_string(), TagValue::Int(1))];
        if let Some(s) = scamin {
            tags.push(("scamin".to_string(), TagValue::Int(s)));
        }
        MvtFeature {
            id: None,
            tags,
            geom: MvtGeometry::Points(vec![(1, 1)]),
        }
    }

    fn tile(feats: Vec<MvtFeature>) -> Vec<u8> {
        let mut layers = BTreeMap::new();
        layers.insert("ATON".to_string(), feats);
        encode_tile(&layers)
    }

    fn aton_count(bytes: &[u8]) -> usize {
        decode_tile(bytes)
            .unwrap()
            .layer("ATON")
            .map_or(0, |l| l.features.len())
    }

    /// (a) The strict-`<` boundary, pinned against the exact denominator: a
    /// feature whose scamin is JUST below `display_scale_denom(z)` (client hides
    /// it at z) is dropped, while one exactly at/above the denominator (client
    /// shows it) is kept. Getting `<` vs `<=` wrong flips this.
    #[test]
    fn drops_below_denominator_keeps_at_or_above() {
        let z = 12u8;
        let d = display_scale_denom(z); // 68247.35 — non-integer, so the boundary bites
        let below = d.floor() as i64; // < denom -> client HIDES -> drop
        let at_or_above = d.ceil() as i64; // >= denom -> client SHOWS -> keep
        let bytes = tile(vec![feat(Some(below)), feat(Some(at_or_above))]);
        let out = drop_scamin_hidden_tile(&bytes, z, 16, ScaminBias::default()).unwrap();
        assert_eq!(aton_count(&out), 1, "only the >= denom feature survives");
        assert_eq!(
            decode_tile(&out).unwrap().layer("ATON").unwrap().features[0]
                .tags
                .get("scamin"),
            Some(&TagValue::Int(at_or_above))
        );
    }

    /// (a, cont.) The SAME feature is dropped at a coarse zoom but kept at a
    /// finer one, where the smaller denominator no longer exceeds its scamin —
    /// exactly the zoom band the frontend would reveal it in.
    #[test]
    fn same_feature_kept_at_finer_zoom() {
        let scamin = display_scale_denom(11).floor() as i64; // < denom(11), >= denom(13)
        let bytes = tile(vec![feat(Some(scamin))]);
        assert_eq!(
            aton_count(&drop_scamin_hidden_tile(&bytes, 11, 16, ScaminBias::default()).unwrap()),
            0,
            "hidden at z11"
        );
        assert_eq!(
            aton_count(&drop_scamin_hidden_tile(&bytes, 13, 16, ScaminBias::default()).unwrap()),
            1,
            "shown at z13"
        );
    }

    /// (b) A feature with NO scamin (S-57 always-show) is never dropped, at any
    /// zoom below max.
    #[test]
    fn no_scamin_is_never_dropped() {
        let bytes = tile(vec![feat(None)]);
        for z in 0..16u8 {
            assert_eq!(
                aton_count(&drop_scamin_hidden_tile(&bytes, z, 16, ScaminBias::default()).unwrap()),
                1,
                "z{z}"
            );
        }
    }

    /// (c) The finest (overzoomed) tile drops nothing and its bytes are
    /// returned untouched — even a scamin the client hides at exactly this zoom
    /// must survive, because MapLibre overzooms this tile and re-shows it above.
    #[test]
    fn max_zoom_tile_drops_nothing() {
        let bytes = tile(vec![feat(Some(1)), feat(None)]);
        let out = drop_scamin_hidden_tile(&bytes, 16, 16, ScaminBias::default()).unwrap();
        assert_eq!(out, bytes, "z == max_zoom returns the input untouched");
        assert_eq!(aton_count(&out), 2);
        assert_eq!(
            drop_scamin_hidden_tile(&bytes, 17, 16, ScaminBias::default()).unwrap(),
            bytes,
            "and above max_zoom"
        );
    }

    /// A tile emptied entirely by the drop encodes to nothing, so the caller
    /// can omit it.
    #[test]
    fn fully_gated_tile_encodes_empty() {
        let scamin = display_scale_denom(11).floor() as i64;
        let bytes = tile(vec![feat(Some(scamin))]);
        assert!(
            drop_scamin_hidden_tile(&bytes, 11, 16, ScaminBias::default())
                .unwrap()
                .is_empty()
        );
    }

    fn layer(scamin: i64) -> BTreeMap<String, Vec<MvtFeature>> {
        let mut m = BTreeMap::new();
        m.insert("ATON".to_string(), vec![feat(Some(scamin))]);
        m
    }

    /// The bias with only the uniform `chart_detail` multiplier set.
    fn detail(b: f64) -> ScaminBias {
        ScaminBias {
            detail: b,
            ..ScaminBias::default()
        }
    }

    /// The chart-detail bias `B` shifts the drop boundary: a feature whose
    /// `display_scale_denom(z)` sits strictly between its `scamin S` and `S·B` is dropped
    /// at `B = 1.0` and kept at `B > 1` (more detail); symmetrically `B < 1`
    /// drops a feature that `B = 1.0` would keep. Asserted directly on
    /// [`drop_scamin_hidden`] so the boundary math is pinned, not the codec.
    #[test]
    fn chart_detail_bias_shifts_the_drop_boundary() {
        // B > 1 keeps a feature the neutral gate drops.
        let (z, s, b) = (14u8, 15_000i64, 1.5);
        let denom = display_scale_denom(z); // ~17062.08
        assert!(
            (s as f64) < denom && denom < (s as f64) * b,
            "denom between S and S·B"
        );
        let mut m = layer(s);
        drop_scamin_hidden(&mut m, z, 16, ScaminBias::default());
        assert!(m.is_empty(), "B=1.0: S below denom -> dropped");
        let mut m = layer(s);
        drop_scamin_hidden(&mut m, z, 16, detail(b));
        assert_eq!(m["ATON"].len(), 1, "B=1.5: S·B >= denom -> kept");

        // B < 1 drops a feature the neutral gate keeps.
        let (z, s, b) = (13u8, 40_000i64, 0.8);
        let denom = display_scale_denom(z); // ~34124.16
        assert!(
            (s as f64) * b < denom && denom < s as f64,
            "denom between S·B and S"
        );
        let mut m = layer(s);
        drop_scamin_hidden(&mut m, z, 16, ScaminBias::default());
        assert_eq!(m["ATON"].len(), 1, "B=1.0: S above denom -> kept");
        let mut m = layer(s);
        drop_scamin_hidden(&mut m, z, 16, detail(b));
        assert!(m.is_empty(), "B=0.8: S·B below denom -> dropped");

        // The overzoom exemption ignores the bias entirely.
        let mut m = layer(1);
        drop_scamin_hidden(&mut m, 16, 16, detail(0.01));
        assert_eq!(m["ATON"].len(), 1, "z >= max_zoom drops nothing, any bias");
    }

    /// `spread = 1` is a bit-for-bit no-op (#qqlzrkkn): the whole point of the
    /// default is that adding the knob changed no tile byte. Pinned on values
    /// where `A·(S/A)^1` would NOT round-trip exactly through `powf`.
    #[test]
    fn neutral_spread_is_exactly_the_old_multiplier() {
        let b = ScaminBias::default();
        for s in [
            1i64, 17_999, 21_999, 29_999, 44_999, 89_999, 350_000, 999_999,
        ] {
            assert_eq!(b.effective(s as f64), s as f64, "scamin {s}");
            assert_eq!(
                detail(1.7).effective(s as f64),
                s as f64 * 1.7,
                "scamin {s}"
            );
        }
    }

    /// BEHAVIOUR, not arithmetic: the turn-on zoom each measured chart value
    /// moves to under a compressing spread (#qqlzrkkn). The left column is the
    /// real fnc-de CBLSUB/WRECKS/UWTROC distribution the user's "submarine
    /// cables arrive too late" report is about; `k = 0.5` about the 1:350k
    /// anchor halves every feature's distance from it, in zoom space.
    ///
    /// What this pins, and what the frontend's mirror of it must reproduce:
    /// ordering is preserved (monotonic), the coarse end barely moves (350_000
    /// IS the anchor and does not move at all), and the late features arrive
    /// markedly earlier — which a `chart_detail` multiplier cannot do without
    /// dragging the coarse end with it.
    #[test]
    fn spread_compresses_the_turn_on_range_toward_the_anchor() {
        let k = ScaminBias {
            spread: 0.5,
            ..ScaminBias::default()
        };
        // (scamin, first zoom shown at k = 1, first zoom shown at k = 0.5)
        let cases = [
            (350_000i64, 10u8, 10u8), // the anchor itself: unmoved
            (89_999, 12, 11),         // fnc-de CBLSUB median
            (45_000, 13, 12),         // DEFAULT_POINT_SCAMIN (DE WRECKS, 2423x)
            (21_999, 14, 12),
            (11_999, 15, 13), // fnc-de CBLSUB tail (25 features)
        ];
        for (scamin, plain, spread) in cases {
            let bytes = tile(vec![feat(Some(scamin))]);
            for (z, want, label) in [
                (plain - 1, 0, "k=1 hidden"),
                (plain, 1, "k=1 shown"),
                (spread - 1, 0, "k=0.5 hidden"),
                (spread, 1, "k=0.5 shown"),
            ] {
                let bias = if label.starts_with("k=1") {
                    ScaminBias::default()
                } else {
                    k
                };
                assert_eq!(
                    aton_count(&drop_scamin_hidden_tile(&bytes, z, 17, bias).unwrap()),
                    want,
                    "scamin {scamin} at z{z} ({label})"
                );
            }
        }
    }

    /// The spread is monotonic, so it never reorders two features: whatever the
    /// spread, a coarser-gated feature still turns on no later than a
    /// finer-gated one. That is the property `kyxkoonq`'s commit message worried
    /// a non-linear warp would cost, and it is preserved.
    #[test]
    fn spread_preserves_the_cartographers_ordering() {
        for k in [0.1, 0.25, 0.5, 0.9, 1.0, 1.5, 2.0] {
            let b = ScaminBias {
                spread: k,
                ..ScaminBias::default()
            };
            let mut prev = 0.0;
            for s in [999i64, 11_999, 21_999, 45_000, 89_999, 350_000, 1_500_000] {
                let e = b.effective(s as f64);
                assert!(e > prev, "k={k}: scamin {s} -> {e} must exceed {prev}");
                prev = e;
            }
        }
    }

    /// Every number is clamped into its band, and a non-finite one falls back to
    /// neutral — the last-line defence against a hand-edited `config.json`.
    #[test]
    fn scamin_bias_clamps_out_of_band_config() {
        let b = ScaminBias::new(1e9, -3.0, 0.0);
        assert_eq!(b.detail, CHART_DETAIL_MAX);
        assert_eq!(b.spread, SCAMIN_SPREAD_MIN);
        assert_eq!(b.anchor, SCAMIN_ANCHOR_MIN);
        let b = ScaminBias::new(f64::NAN, f64::INFINITY, f64::NAN);
        assert_eq!(b, ScaminBias::default());
    }

    /// BEHAVIOUR, not arithmetic (#kyxkoonq): the integer zoom at which each
    /// SCAMIN value actually appears on a real chart. The left column is the
    /// SCAMIN distribution measured on the US5OAKIQ fixture (`ogrinfo`: 94x
    /// 17999, 85x 21999, 75x 29999, 24x 44999 — the whole cell), plus the two
    /// synthetic defaults the derive pass invents (`DEFAULT_POINT_SCAMIN`,
    /// `DEFAULT_AREA_SYMBOL_SCAMIN`).
    ///
    /// Every one of these used to turn on exactly ONE zoom later, because the
    /// gate compared against the 256 px pyramid denominator while MapLibre
    /// draws the tile at 512 CSS px: the bulk of that cell only lit at z15,
    /// where a phone viewport covers under a kilometre. If a future change
    /// re-breaks the display scale, these numbers move and this test says so —
    /// restating the formula would not.
    #[test]
    fn scamin_turn_on_zooms_on_real_chart_values() {
        // (scamin, last zoom it is HIDDEN at, first zoom it is SHOWN at)
        let cases = [
            (17_999i64, 13u8, 14u8), // US5OAKIQ, 94 features
            (21_999, 13, 14),        // US5OAKIQ, 85 features
            (29_999, 13, 14),        // US5OAKIQ, 75 features
            (44_999, 12, 13),        // US5OAKIQ, 24 features
            (45_000, 12, 13),        // derive::DEFAULT_POINT_SCAMIN (daymarks)
            (350_000, 9, 10),        // derive::DEFAULT_AREA_SYMBOL_SCAMIN (TSSLPT)
        ];
        for (scamin, hidden_at, shown_at) in cases {
            let bytes = tile(vec![feat(Some(scamin))]);
            assert_eq!(
                aton_count(
                    &drop_scamin_hidden_tile(&bytes, hidden_at, 16, ScaminBias::default()).unwrap()
                ),
                0,
                "scamin {scamin} must still be hidden at z{hidden_at}"
            );
            assert_eq!(
                aton_count(
                    &drop_scamin_hidden_tile(&bytes, shown_at, 16, ScaminBias::default()).unwrap()
                ),
                1,
                "scamin {scamin} must be visible at z{shown_at}"
            );
        }
    }

    /// The whole point of the render denominator: it is exactly half the
    /// pyramid one, i.e. a uniform one-zoom-earlier shift for EVERY gated
    /// feature — no reordering of the cartographer's relative judgement, which
    /// is what a non-linear SCAMIN warp would have cost.
    #[test]
    fn render_denominator_is_a_uniform_one_zoom_shift() {
        assert_eq!(RENDER_SCALE_DENOM_Z0, 279_541_132.0);
        for z in 0..16u8 {
            assert_eq!(display_scale_denom(z), scale_denom(z + 1), "z{z}");
        }
    }
}
