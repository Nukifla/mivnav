// Wind as a slow, faint PARTICLE FLOW (Windy/earth.nullschool streaklines) —
// a GPU sim inside the map's own WebGL context (windGpu.ts). See
// docs/architecture/wind-flow-gpu-model.md for why, and the coordinate model.
//
// `WindFlowOverlay` here is the thin MapLibre + fetch binding around the pure,
// unit-tested pieces in windGpu.ts; it needs a real device (WebGL, fetch,
// OffscreenCanvas) so it is NOT exercised by the headless unit suite.

import type { Map as MLMap } from "maplibre-gl";
import { fieldTileUrl } from "./sources";
import {
  overscanViewport,
  resampleWindToEquirect,
  tileIndex,
  tileWindSampler,
  viewportParticleBounds,
  windGpuCaps,
  WindGpuLayer,
  WIND_TEX_RESOLUTION,
  type WindTile,
} from "./windGpu";

export type { WindVector } from "./windGpu";

// ── Tunable defaults (meant to be iterated on live, on-device) ────────────────

/** How many particles ride the field — a screen budget over the VISIBLE
 *  viewport, not the whole grid. BAKED from a live on-device WindTuner pass
 *  against the geo-anchored model, 2026-07-27. */
export const FLOW_PARTICLE_COUNT = 2000;
/** Pad the viewport by this fraction of its own span on EACH side before
 *  intersecting with the grid, so particles live off-screen and continuously
 *  flow into the visible upwind edge. Zoom-independent, since advection is a
 *  fixed fraction of the viewport. BAKED 2026-07-27. */
export const FLOW_OVERSCAN = 0.1;
/** Advection magnitude cap, m/s (mirrors `capWindVector`): below it motion is
 *  proportional to wind speed, at/above it every particle drifts the same
 *  ground distance. 15 m/s keeps ordinary wind in the proportional regime.
 *  BAKED 2026-07-27. */
export const FLOW_SPEED_CAP = 15;
/** Screen-pace gain: fraction of viewport HEIGHT a particle advances per m/s
 *  of wind per second — ZOOM-INDEPENDENT on screen, unlike the old ground
 *  model (`FLOW_ADVECT_GAIN`, deg/frame) which scaled pace with zoom. BAKED
 *  2026-07-27. */
export const FLOW_ADVECT_SCREEN_GAIN = 0.004;
/** Trail persistence per frame (screen-framebuffer fade). 0.95 gives
 *  directional streaks without smearing into a wash; tuned for ~60fps. BAKED
 *  2026-07-27. */
export const FLOW_FADE = 0.95;
/** Point size (px) of a particle — the streak width. BAKED 2026-07-27. */
export const FLOW_LINE_WIDTH = 5;
/** Streak opacity — fully opaque. */
export const FLOW_ALPHA = 1;
/** Per-frame respawn probability (age-out), so the field never bunches in the
 *  lee of a strong cell. */
export const FLOW_DROP_RATE = 0.003;
/** Extra drop rate scaled by relative speed, so fast-cell particles recycle sooner. */
export const FLOW_DROP_RATE_BUMP = 0.01;
/** Gain on the zoom-out density correction: an extra respawn probability
 *  proportional to each frame's area growth, so the field redistributes
 *  smoothly across a zoom-out gesture instead of clumping. */
export const FLOW_ZOOM_BUMP_GAIN = 1.0;
/** Fade rate, life units/second: a respawning particle fades out (still
 *  advecting), teleports to its new point at zero alpha, fades back in. Only
 *  on FLOAT_STATE devices; the RGBA8 fallback teleports instantly. */
export const FLOW_FADE_RATE = 5;

/** Mercator-valid lat/lng range — the resample domain's outer clamp now that
 *  there's no model-coverage bbox to intersect with; an uncovered viewport
 *  area just reads as tile-mosaic no-data holes. */
const MERCATOR_LAT_LIMIT = 85.051129;
const WORLD_BOUNDS: [number, number, number, number] = [-180, -MERCATOR_LAT_LIMIT, 180, MERCATOR_LAT_LIMIT];

let layerSeq = 0;

// ── Wind tile fetch (impure — device only) ────────────────────────────────────

/** Zoom level wind tiles are fetched at — fixed, not viewport-dependent, since
 *  model grids are km-scale. ASSUMPTION, unverified against a live backend
 *  (backend's `wind_tex_max_zoom` cap is z0-6 per the plan). */
export const WIND_TILE_ZOOM = 4;

/** Fetch and decode one field tile into a plain RGBA8 pixel buffer. `404`
 * (the padded domain spilling past coverage) is a normal miss → `null`, not
 * an error. `WindFlowOptions.fetchTileFn` seams this for tests (needs a real browser). */
async function fetchWindTile(
  sourceId: string,
  variable: string,
  time: string,
  z: number,
  x: number,
  y: number,
): Promise<WindTile | null> {
  const res = await fetch(fieldTileUrl(sourceId, variable, time, z, x, y));
  if (!res.ok) return null;
  const bitmap = await createImageBitmap(await res.blob());
  const size = bitmap.width;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, size, size);
  bitmap.close();
  return { size, data };
}

// ── The MapLibre binding ──────────────────────────────────────────────────────

/** Where the overlay reads its wind from: an opaque weather-source id, a
 * canonical variable and an explicit valid time. The descriptor IS the
 * address — nothing left to resolve here. */
export interface WindSourceDesc {
  sourceId: string;
  variable: string;
  /** ISO-8601 valid instant. */
  time: string;
}

function sourceEquals(a: WindSourceDesc | null, b: WindSourceDesc | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.sourceId === b.sourceId && a.variable === b.variable && a.time === b.time;
}

export interface WindFlowOptions {
  particleCount?: number;
  speedCap?: number;
  advectScreenGain?: number;
  fade?: number;
  lineWidth?: number;
  alpha?: number;
  /** Predicate, not a value, so the class stays free of any framework signal;
   *  the caller re-evaluates via `sync()` when it flips. */
  reducedMotion?: () => boolean;
  /** Seam: defaults to the real fetch/createImageBitmap/OffscreenCanvas path;
   *  a test injects a synthetic tile instead. */
  fetchTileFn?: (
    sourceId: string,
    variable: string,
    time: string,
    z: number,
    x: number,
    y: number,
  ) => Promise<WindTile | null>;
}

/** The wind-flow overlay bound to one MapLibre map: a `WindGpuLayer` custom
 * layer plus the plumbing that feeds it (added on enable, GL-torn-down on
 * disable). `setSource` fetches/resamples wind tiles into an equirect texture, re-run every `moveend`. */
export class WindFlowOverlay {
  private readonly map: MLMap;
  private readonly layer: WindGpuLayer;
  private readonly reducedMotion: () => boolean;
  private readonly fetchTileFn: (
    sourceId: string,
    variable: string,
    time: string,
    z: number,
    x: number,
    y: number,
  ) => Promise<WindTile | null>;

  /** `core/layers/mapLayerOrder.ts` resolves this to move the particle layer
   *  alongside the weather wash under the "weather" band id, so a panel
   *  reorder repositions both together. */
  get layerId(): string {
    return this.layer.id;
  }

  private source: WindSourceDesc | null = null;
  /** Decoded tiles for the CURRENT source, keyed `"x,y"` at `WIND_TILE_ZOOM`.
   *  Cleared on source change — small and cheap to refetch. */
  private tiles = new Map<string, WindTile>();
  /** Mirrors the layer's own screen overscan (u_pad_scale); this copy feeds
   *  `computeDomain`. */
  private readonly overscan = FLOW_OVERSCAN;
  private enabled = false;
  private layerAdded = false;
  private idleWaiting = false;
  private destroyed = false;
  /** One-shot latch for `reportPaused` — reset on every enable. */
  private pausedReported = false;
  /** Set when the layer's `onAdd` threw for good (GL/shader/capability
   *  failure, not "style not ready yet") — stops an infinite retry-on-idle loop. */
  private addFailure: unknown = null;
  /** Count of field tiles that failed since the last source change, and
   *  whether the first error was already logged. */
  private tileFailures = 0;
  private tileErrorReported = false;
  /** Guards a slow resample against a source/enable change that landed while
   *  it was in flight. */
  private resampleToken = 0;

  private readonly onVisibility = () => this.sync();
  private readonly onStyleData = () => {
    // A style reload (e.g. palette switch) drops custom layers and clears the
    // layer's uploaded wind texture. Re-add and re-resample if we owned one.
    if (!this.enabled) return;
    const missing = !this.map.getLayer(this.layer.id);
    this.placeLayer();
    if (missing) void this.resampleDomain();
  };
  // Once per gesture settle, not per frame — particles are geo-anchored and
  // track the camera on the GPU every frame regardless.
  private readonly onMoveEnd = () => {
    if (this.enabled) void this.resampleDomain();
  };
  // The guaranteed catch-all beat: re-assert layer presence/slot in case the
  // wash re-added its own layer above us.
  private readonly onIdle = () => {
    if (this.enabled) this.placeLayer();
  };

  constructor(map: MLMap, opts: WindFlowOptions = {}) {
    this.map = map;
    this.reducedMotion = opts.reducedMotion ?? (() => false);
    this.fetchTileFn = opts.fetchTileFn ?? fetchWindTile;
    this.layer = new WindGpuLayer({
      id: `wind-flow-${layerSeq++}`,
      particleCount: opts.particleCount ?? FLOW_PARTICLE_COUNT,
      alpha: opts.alpha ?? FLOW_ALPHA,
      fade: opts.fade ?? FLOW_FADE,
      pointSize: opts.lineWidth ?? FLOW_LINE_WIDTH,
      speedCap: opts.speedCap ?? FLOW_SPEED_CAP,
      advectScreenGain: opts.advectScreenGain ?? FLOW_ADVECT_SCREEN_GAIN,
      overscan: this.overscan,
      dropRate: FLOW_DROP_RATE,
      dropRateBump: FLOW_DROP_RATE_BUMP,
      zoomBumpGain: FLOW_ZOOM_BUMP_GAIN,
      fadeRate: FLOW_FADE_RATE,
      paused: () => this.paused(),
    });
    map.on("styledata", this.onStyleData);
    map.on("moveend", this.onMoveEnd);
    map.on("idle", this.onIdle);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibility);
    }
  }

  private paused(): boolean {
    return (
      this.destroyed ||
      !this.enabled ||
      this.reducedMotion() ||
      (typeof document !== "undefined" && document.hidden)
    );
  }

  /** Say once per enable why a PAUSED overlay draws nothing: Android sets
   * `prefers-reduced-motion` from Battery Saver / Accessibility → "Remove
   * animations", so a phone can pause silently where dev desktop never does. */
  private reportPaused(): void {
    if (this.pausedReported || !this.enabled || this.destroyed) return;
    const reduced = this.reducedMotion();
    const hidden = typeof document !== "undefined" && document.hidden;
    if (!reduced && !hidden) return;
    this.pausedReported = true;
    console.warn(
      "windFlow: the wind flow is enabled but PAUSED, so no particles are drawn — " +
        `prefers-reduced-motion=${reduced}, document.hidden=${hidden}. ` +
        "On Android, prefers-reduced-motion is set by Battery Saver and by " +
        'Settings → Accessibility → "Remove animations".',
    );
  }

  /** Master on/off — the weather `arrows` (wind flow) toggle. */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (enabled) {
      this.pausedReported = false;
      this.placeLayer();
      void this.resampleDomain();
      this.layer.wake();
      this.reportPaused();
    } else {
      this.resampleToken++; // drop any in-flight resample
      this.removeLayer();
    }
  }

  /** Point the overlay at a forecast run's wind field (or `null` to clear).
   * Fetches this overlay's OWN wind tiles for the viewport; nothing draws
   * until the first tile fetch lands. */
  setSource(desc: WindSourceDesc | null): void {
    if (sourceEquals(this.source, desc)) return;
    this.resampleToken++; // supersede any resample still running for the old source
    this.source = desc;
    this.tiles.clear();
    this.tileFailures = 0;
    this.tileErrorReported = false;
    if (!desc) {
      this.layer.setWind(null);
      return;
    }
    if (this.enabled) void this.resampleDomain();
  }

  /** Re-evaluate the pause verdict — call after any input that can change it (a
   *  reduced-motion flip is driven from the caller, a visibility change from our
   *  own listener). Waking is a no-op cost when the layer is absent/paused. */
  sync(): void {
    if (!this.paused()) this.layer.wake();
    else this.reportPaused();
  }

  /** Recompute bounds, fetch covering wind tiles, resample into the equirect
   * texture, hand it to the layer — once per gesture settle, never per frame.
   * `resampleToken` drops a slow call superseded by a newer source/enable change. */
  private async resampleDomain(): Promise<void> {
    const token = this.resampleToken;
    if (!this.enabled || !this.source) {
      this.layer.setWind(null);
      return;
    }
    const domain = this.computeDomain();
    if (!domain) {
      // Viewport entirely off the mercator-valid range (a degenerate test
      // double, never a real map) — clear the field.
      this.layer.setWind(null);
      return;
    }
    const mosaic = await this.ensureTiles(domain);
    if (this.destroyed || this.resampleToken !== token) return; // superseded
    if (mosaic.size === 0) {
      // Distinguishes "off the source's coverage" (every tile 404s) from
      // "every fetch/decode threw" — both look identical on screen otherwise.
      console.warn(
        `windFlow: no wind tiles for the current viewport (${this.tileFailures} tile ` +
          "fetch/decode failures) — no particles will be drawn. Zero failures means the " +
          "source simply has no data here; nonzero means the fetch or PNG decode is broken.",
      );
      this.layer.setWind(null);
      return;
    }
    const tex = resampleWindToEquirect(
      tileWindSampler(mosaic, WIND_TILE_ZOOM),
      domain,
      WIND_TEX_RESOLUTION,
      WIND_TEX_RESOLUTION,
    );
    this.layer.setWind(tex);
  }

  /** Fetch (cache-first) every tile covering `domain` at `WIND_TILE_ZOOM`,
   *  returning the full mosaic (cached + freshly-fetched, keyed `"x,y"`) a
   *  sampler can read. A tile that fails to fetch is simply absent from the
   *  mosaic (`tileWindSampler` reads that as a no-data hole) — no retry here;
   *  the next `moveend`/enable naturally tries again. */
  private async ensureTiles(
    domain: [number, number, number, number],
  ): Promise<Map<string, WindTile>> {
    const { sourceId, variable, time } = this.source!;
    const nw = tileIndex(domain[0], domain[3], WIND_TILE_ZOOM); // west, north
    const se = tileIndex(domain[2], domain[1], WIND_TILE_ZOOM); // east, south
    const fetches: Promise<void>[] = [];
    for (let x = nw.x; x <= se.x; x++) {
      for (let y = nw.y; y <= se.y; y++) {
        const key = `${x},${y}`;
        if (this.tiles.has(key)) continue;
        fetches.push(
          this.fetchTileFn(sourceId, variable, time, WIND_TILE_ZOOM, x, y)
            .then((tile) => {
              if (tile) this.tiles.set(key, tile);
            })
            .catch((err: unknown) => {
              // A throw here is NOT a 404 (that returns null) — a real network
              // or decode failure. Report the FIRST one in full; count the rest.
              this.tileFailures++;
              if (!this.tileErrorReported) {
                this.tileErrorReported = true;
                console.error(
                  `windFlow: wind tile ${WIND_TILE_ZOOM}/${x}/${y} failed to fetch or decode ` +
                    "(further failures for this source are counted, not logged)",
                  err,
                );
              }
            }),
        );
      }
    }
    if (fetches.length) await Promise.all(fetches);
    return this.tiles;
  }

  /** The wind-resample bounds: the overscanned viewport, clamped to the
   *  mercator-valid latitude range. Falls back to the whole valid range when
   *  the map exposes no `getBounds` (a test fake). */
  private computeDomain(): [number, number, number, number] | null {
    if (typeof this.map.getBounds !== "function") return WORLD_BOUNDS;
    const b = this.map.getBounds();
    const viewport: [number, number, number, number] = [
      b.getWest(),
      b.getSouth(),
      b.getEast(),
      b.getNorth(),
    ];
    // Same margin as the layer's own screen overscan (u_pad_scale); keep in sync.
    const padded = overscanViewport(viewport, this.overscan);
    return viewportParticleBounds(padded, WORLD_BOUNDS);
  }

  /** Add the wind-flow layer if absent, directly ABOVE the weather wash. A
   * custom layer renders in its OWN GL context, so it does NOT need
   * `isStyleLoaded()` — gating on it was the original blank-particles bug. */
  private placeLayer(): void {
    const map = this.map;
    if (this.destroyed) return;
    // A GL/capability failure in onAdd is PERMANENT — retrying on every idle
    // beat re-throws forever and buries the one message that matters.
    if (this.addFailure) return;
    const beforeId = this.weatherBeforeId();
    const before = beforeId && typeof map.getLayer === "function" && map.getLayer(beforeId)
      ? beforeId
      : undefined;
    if (map.getLayer(this.layer.id)) {
      this.layerAdded = true;
      // Reposition only when the slot is wrong, to stay cheap/idempotent.
      if (typeof map.moveLayer === "function" && this.slotWrong(before)) {
        map.moveLayer(this.layer.id, before);
      }
      return;
    }
    try {
      map.addLayer(this.layer, before);
      this.layerAdded = true;
    } catch (err) {
      // A `windGpu:`-prefixed error comes from the layer's own onAdd (a
      // shader failure or missing capability) and is PERMANENT — latch and
      // stop, so it's reported once instead of drowning in retries.
      if (err instanceof Error && err.message.startsWith("windGpu:")) {
        this.addFailure = err;
        console.error(
          "windFlow: the wind-flow layer could not be created on this device — no " +
            "particles will be drawn. This is permanent; not retrying.",
          err,
          windGpuCaps(),
        );
        return;
      }
      console.error("windFlow: addLayer failed, will retry on idle", err);
      if (!this.idleWaiting && typeof map.once === "function") {
        this.idleWaiting = true;
        map.once("idle", () => {
          this.idleWaiting = false;
          if (this.enabled) this.placeLayer();
        });
      }
    }
  }

  /** All layer ids bottom → top, INCLUDING custom layers — unlike
   *  `getStyle().layers` (MapLibre's `_serializeByIds` skips custom layers, so
   *  `slotWrong()` used to always get -1 and its reposition branch was dead
   *  code, letting a wash re-add land above the particles — the "particles
   *  under the wash" bug). Prefer `getLayersOrder()`; fall back for test doubles. */
  private mapLayerIds(): string[] | undefined {
    if (typeof this.map.getLayersOrder === "function") return this.map.getLayersOrder();
    const layers = typeof this.map.getStyle === "function" ? this.map.getStyle()?.layers : undefined;
    return layers?.map((l) => l.id);
  }

  /** The layer id to sit BEFORE, to land just above the weather wash.
   *  `undefined` ⇒ add on top. Derived from the live order so it stays right
   *  when openseamap/poi are toggled. */
  private weatherBeforeId(): string | undefined {
    const ids = this.mapLayerIds();
    if (!ids) return undefined;
    let lastWeather = -1;
    for (let i = 0; i < ids.length; i++) {
      if (ids[i]!.startsWith("weather-raster")) lastWeather = i;
    }
    if (lastWeather < 0) return undefined; // wash not present yet → top for now
    for (let i = lastWeather + 1; i < ids.length; i++) {
      // Skip THIS layer's own id: if the particles already sit directly above
      // the wash, returning their own id as "before" would be a no-op.
      if (ids[i] !== this.layer.id) return ids[i];
    }
    return undefined; // wash is the topmost group → top
  }

  /** True when the wind-flow layer is NOT already sitting immediately before
   *  `before` (or not already on top when `before` is undefined). */
  private slotWrong(before: string | undefined): boolean {
    const ids = this.mapLayerIds();
    if (!ids) return false;
    const cur = ids.indexOf(this.layer.id);
    if (cur < 0) return false;
    if (before === undefined) return cur !== ids.length - 1;
    return ids[cur + 1] !== before;
  }

  private removeLayer(): void {
    if (!this.layerAdded) return;
    this.layerAdded = false;
    if (this.map.getLayer(this.layer.id)) this.map.removeLayer(this.layer.id);
  }

  /** Cancel everything, drop listeners, remove the layer. Idempotent. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.map.off("styledata", this.onStyleData);
    this.map.off("moveend", this.onMoveEnd);
    this.map.off("idle", this.onIdle);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibility);
    }
    this.removeLayer();
  }
}
