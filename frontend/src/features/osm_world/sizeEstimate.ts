// Rough size-vs-max_zoom estimates for an osm_world extract, anchored on
// MEASURED `pmtiles extract --dry-run` runs (see `mivnav.features.osm_world.config`
// for the backend's matching numbers). TWO tables (world vs. region-scoped)
// because they're orders of magnitude apart; log-linear interpolation between anchors.

const WORLD_ANCHORS: readonly (readonly [zoom: number, bytes: number])[] = [
  [6, 45 * 1024 * 1024],
  [8, 550 * 1024 * 1024],
  [10, 3.7 * 1024 * 1024 * 1024],
  [12, 17 * 1024 * 1024 * 1024],
];

const REGION_ANCHORS: readonly (readonly [zoom: number, bytes: number])[] = [
  [10, 22 * 1024 * 1024],
  [12, 92 * 1024 * 1024],
  [14, 356 * 1024 * 1024],
];

/** The box REGION_ANCHORS was measured over: Denmark, `[w, s, e, n]`. A
 * region's estimate scales those measured bytes by its own area against this
 * one. */
const REFERENCE_BOX: readonly [number, number, number, number] = [8.0, 54.5, 13.0, 57.8];

/** A latitude's normalised Web-Mercator y (0 at the north edge, 1 at the
 * south) — what makes "area" mean *tile* area rather than degrees, which is
 * the thing an extract's size actually tracks. */
function mercatorY(lat: number): number {
  const clamped = Math.max(-85.05, Math.min(85.05, lat));
  const rad = (clamped * Math.PI) / 180;
  return (1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2;
}

/** A box's share of the whole world in normalised Web-Mercator area. */
function mercatorArea(box: readonly [number, number, number, number]): number {
  const [w, s, e, n] = box;
  return (Math.abs(e - w) / 360) * Math.abs(mercatorY(s) - mercatorY(n));
}

function interpolate(
  anchors: readonly (readonly [number, number])[],
  zoom: number,
): number {
  let lo = anchors[0];
  let hi = anchors[anchors.length - 1];
  if (zoom <= anchors[0][0]) {
    [lo, hi] = [anchors[0], anchors[1]];
  } else if (zoom >= anchors[anchors.length - 1][0]) {
    [lo, hi] = [anchors[anchors.length - 2], anchors[anchors.length - 1]];
  } else {
    for (let i = 0; i < anchors.length - 1; i++) {
      if (zoom >= anchors[i][0] && zoom <= anchors[i + 1][0]) {
        lo = anchors[i];
        hi = anchors[i + 1];
        break;
      }
    }
  }
  const [z0, b0] = lo;
  const [z1, b1] = hi;
  if (z1 === z0) return b0;
  const t = (zoom - z0) / (z1 - z0);
  return Math.exp(Math.log(b0) + t * (Math.log(b1) - Math.log(b0)));
}

/** Estimated WHOLE-WORLD extract size at `maxZoom`, in bytes. Zoom outside
 * [6, 12] extrapolates off the nearest pair's slope rather than clamping. */
export function estimateOsmWorldExtractBytes(maxZoom: number): number {
  return interpolate(WORLD_ANCHORS, maxZoom);
}

/** Estimated REGION-SCOPED extract size at `maxZoom` for `boxes`, in bytes —
 * Denmark's measured curve scaled by area (NOT the world table: mostly ocean,
 * undershoots by an order of magnitude, see osm-world-dataset-params.md).
 * `null` when `boxes` is empty (country regions resolve boundary server-side). */
export function estimateOsmWorldRegionBytes(
  maxZoom: number,
  boxes: readonly { min_lon: number; min_lat: number; max_lon: number; max_lat: number }[],
): number | null {
  if (boxes.length === 0) return null;
  const area = boxes.reduce(
    (sum, b) => sum + mercatorArea([b.min_lon, b.min_lat, b.max_lon, b.max_lat]),
    0,
  );
  return interpolate(REGION_ANCHORS, maxZoom) * (area / mercatorArea(REFERENCE_BOX));
}
