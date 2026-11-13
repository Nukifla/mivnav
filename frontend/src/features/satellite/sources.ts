// Satellite imagery sources — ONE list from `GET /api/satellite/sources`
// (jt zsukvvxq unified the old baked/online tiers). Ids are opaque: nothing
// here parses one or infers locality; `requires_network` is the machine fact.

/** The MapLibre source AND layer id for the single imagery underlay. One layer,
 * whatever the active source — a swap tears it down and re-adds it (see
 * overlay.ts). */
export const SATELLITE_LAYER_ID = "satellite";

/**
 * One selectable imagery source (backend `routes.list_sources`). `tiles` is
 * `{z}/{x}/{y}`, resolved via {@link tileTemplate}. `sequence` changes on a
 * re-bake so MapLibre swaps a stale raster for a new `key`.
 */
export interface SatelliteSourceInfo {
  id: string;
  label: string;
  /** Human-readable state ("Offline · EOX Sentinel-2 cloudless", "Online").
   * Display only — never parsed, never branched on. */
  badge: string;
  requires_network: boolean;
  tiles: string;
  min_zoom: number;
  max_zoom: number;
  bounds: [number, number, number, number] | null;
  attribution: string;
  sequence: number;
}

/** CONFIGURED imagery upstream (`GET /api/ingest/satellite/sources`) — the
 * bake-FROM configuration surface, not consumption (decision D1,
 * the weather plugin's `docs/weather-sources-design.md`). The map/overlay never reads this. */
export interface SatelliteSource {
  id: string;
  name: string;
  attribution: string;
  max_zoom: number;
  tile_format: string;
  bakeable: boolean;
  url_template: string;
}

/** The active source flattened to what a raster source+layer needs. `key`
 * detects a source swap: when it changes the overlay tears the layer down
 * and re-adds it, because a raster source's `tiles` cannot change in place. */
export interface ResolvedSatellite {
  key: string;
  /** Full tile-URL template for MapLibre's raster `tiles`. */
  tiles: string;
  attribution: string;
  minzoom: number;
  maxzoom: number;
  /** `[w, s, e, n]` for a baked set (so MapLibre requests no tiles outside it);
   * omitted for a global online source. */
  bounds?: [number, number, number, number];
}

/**
 * Resolve `tiles` to a fetchable URL: a leading `/` gets the `/api` base
 * (server routes are relative), anything else is already absolute. No
 * `location.origin` prefix needed — raster tiles fetch on the main thread.
 */
export function tileTemplate(tiles: string): string {
  return tiles.startsWith("/") ? `/api${tiles}` : tiles;
}

function resolve(src: SatelliteSourceInfo): ResolvedSatellite {
  return {
    key: `${src.id}:${src.sequence}`,
    tiles: tileTemplate(src.tiles),
    attribution: src.attribution,
    minzoom: src.min_zoom,
    maxzoom: src.max_zoom,
    ...(src.bounds ? { bounds: src.bounds } : {}),
  };
}

/**
 * Flatten pick + live list to the active source. An explicit id that matches
 * wins; anything else (empty, or a deleted set's stale id) falls back to
 * AUTO (index 0) rather than wedging the overlay blank.
 */
export function resolveSatelliteSource(
  selected: string,
  sources: readonly SatelliteSourceInfo[],
): ResolvedSatellite | null {
  if (sources.length === 0) return null;
  const hit = selected ? sources.find((s) => s.id === selected) : undefined;
  return resolve(hit ?? sources[0]);
}
