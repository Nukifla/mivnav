// The satellite/aerial imagery wash — a raster layer managed IMPERATIVELY,
// drawn OVER the base ENC chart at a low positive `Z.satellite`. Inert when
// off. See docs/architecture/satellite-overlay.md for the design.

import type { Accessor } from "solid-js";
import type { Map as MLMap, RasterSourceSpecification } from "maplibre-gl";
import type { Overlay, OverlayCtx } from "../../core/layers/overlay";
import { Z } from "../../core/layers/overlay";
import { basemapTintPaint, rasterPaint } from "../../core/style/chartStyle";
import type { Palette } from "../../core/style/colors";
import {
  resolveSatelliteSource,
  SATELLITE_LAYER_ID,
  type ResolvedSatellite,
  type SatelliteSourceInfo,
} from "./sources";
import { addLayer } from "../../core/layers/addLayer";

/** The overlay's private swap-detection record — the currently-installed
 * source's `key`. Passed to {@link applySatelliteSource} so the reconcile
 * is a free function, testable without the overlay closure. */
export interface SatelliteState {
  key: string;
}

/** The layer id to insert the imagery BEFORE, so a runtime toggle-on (no
 * re-hoist) lands correctly on its own. Topmost chart layer's id + 1
 * (`undefined` ⇒ top, incl. a bare style). */
function insertBeforeId(map: MLMap): string | undefined {
  const layers = map.getStyle?.()?.layers ?? [];
  let topChart = -1;
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    const src = (l as { source?: unknown }).source;
    if ((typeof src === "string" && src.startsWith("chart-")) || l.id === "openseamap") topChart = i;
  }
  // The layer immediately above the chart/seamarks band (undefined ⇒ top).
  return topChart >= 0 ? layers[topChart + 1]?.id : undefined;
}

/** Reconcile the map's single imagery layer against the resolved source.
 * `null` removes it; same key is opacity-only. See docs/architecture/satellite-overlay.md. */
export function applySatelliteSource(
  map: MLMap,
  resolved: ResolvedSatellite | null,
  opacity: number,
  palette: Palette,
  state: SatelliteState,
): void {
  const id = SATELLITE_LAYER_ID;

  if (!resolved) {
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
    state.key = "";
    return;
  }

  const present = !!map.getSource(id);
  // Same source already on the map: an opacity nudge in place — a GPU uniform,
  // never a refetch. (After a style.load wipe `present` is false, so this is
  // skipped and the add branch re-installs the layer even with a matching key.)
  if (present && state.key === resolved.key) {
    if (map.getLayer(id)) map.setPaintProperty(id, "raster-opacity", opacity);
    return;
  }
  // A swap (or a re-baked set): drop the old layer+source, layer first.
  if (present) {
    if (map.getLayer(id)) map.removeLayer(id);
    map.removeSource(id);
  }

  const source: RasterSourceSpecification = {
    type: "raster",
    tiles: [resolved.tiles],
    tileSize: 256,
    minzoom: resolved.minzoom,
    maxzoom: resolved.maxzoom,
    attribution: resolved.attribution,
    // A baked set carries its coverage so MapLibre requests no tiles outside it;
    // an online source is global and omits it.
    ...(resolved.bounds ? { bounds: resolved.bounds } : {}),
  };
  map.addSource(id, source);
  addLayer(
    map,
    {
      id,
      type: "raster",
      source: id,
      paint: {
        "raster-opacity": opacity,
        "raster-fade-duration": 0,
        // Dim at dusk/night with the basemap's ramp (rasterPaint → {} on day)
        // plus the same per-theme tint the OSM base layer gets.
        ...rasterPaint(palette),
        ...basemapTintPaint(palette),
      },
    },
    insertBeforeId(map),
  );
  state.key = resolved.key;
}

export interface SatelliteOverlayDeps {
  /** Every selectable imagery source, baked or online, in one list
   * (features/satellite/catalog.ts → `GET /api/satellite/sources`). The
   * overlay does not know which tier a row belongs to, and does not need to. */
  sources: Accessor<SatelliteSourceInfo[]>;
}

/** The active resolved source, or `null` when OFF. Short-circuiting on
 * `showSatellite` first is what makes the overlay inert. */
function desiredSource(deps: SatelliteOverlayDeps, ctx: OverlayCtx): ResolvedSatellite | null {
  const s = ctx.settings();
  if (!s.showSatellite) return null;
  return resolveSatelliteSource(s.satelliteSource, deps.sources());
}

/** The satellite overlay — one `Overlay` for App's feature list. `ensure` and
 * `update` both reconcile (the same idempotent path) so it re-installs after
 * a `style.load` and reacts to a toggle / opacity / source change. */
export function createSatelliteOverlay(deps: SatelliteOverlayDeps): Overlay {
  const state: SatelliteState = { key: "" };
  const reconcile = (map: MLMap, ctx: OverlayCtx) =>
    applySatelliteSource(
      map,
      desiredSource(deps, ctx),
      ctx.settings().satelliteOpacity,
      ctx.settings().palette,
      state,
    );
  return {
    id: "satellite",
    layerIds: [SATELLITE_LAYER_ID],
    z: Z.satellite,
    ensure: reconcile,
    update: reconcile,
  };
}
