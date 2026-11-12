// The Open-Meteo weather overlay: the raster field wash, managed
// IMPERATIVELY, never through the generated style (a `setStyle` used to
// FLASH every weather change; see docs/architecture/weather-overlay.md).

import type { Map as MLMap, RasterSourceSpecification } from "maplibre-gl";
import type { Accessor } from "solid-js";
import type { ResolvedWeatherRaster } from "./sources";
import { WEATHER_WASH_LAYER_ID } from "./sources";
import { Z, type Overlay, type OverlayCtx } from "../../core/layers/overlay";
import { addLayer } from "../../core/layers/addLayer";

/** Every layer id the "weather" overlay owns. NOT re-hoisted with the other
 * overlays — must stay below seamarks/vessels/route/measure, never above. */
export const WEATHER_LAYER_IDS = [WEATHER_WASH_LAYER_ID] as const;

/** The wash reconcile's private swap-detection record — the currently-
 * installed source's `key`. Empty when nothing is installed. Mirrors
 * `features/satellite/overlay.ts`'s `SatelliteState` exactly. */
export interface WeatherRasterState {
  key: string;
}

/** Mirrors `applySatelliteSource` exactly (features/satellite/overlay.ts),
 * but weather sits BELOW the seamarks: inserted `beforeId: 'openseamap'`. */
export function applyWeatherRaster(
  map: MLMap,
  resolved: ResolvedWeatherRaster | null,
  opacity: number,
  state: WeatherRasterState,
): void {
  const id = WEATHER_WASH_LAYER_ID;

  if (!resolved) {
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
    state.key = "";
    return;
  }

  const present = !!map.getSource(id);
  if (present && state.key === resolved.key) {
    if (map.getLayer(id)) map.setPaintProperty(id, "raster-opacity", opacity);
    return;
  }
  if (present) {
    if (map.getLayer(id)) map.removeLayer(id);
    map.removeSource(id);
  }

  const beforeId = map.getLayer("openseamap") ? "openseamap" : undefined;
  const source: RasterSourceSpecification = {
    type: "raster",
    tiles: [resolved.tiles],
    // Must equal the backend's `render_wash_tile` pixel size or MapLibre
    // requests the wrong zoom level. See docs/architecture/weather-overlay.md.
    tileSize: 256,
    attribution: resolved.attribution,
    ...(resolved.minzoom !== undefined ? { minzoom: resolved.minzoom } : {}),
    ...(resolved.maxzoom !== undefined ? { maxzoom: resolved.maxzoom } : {}),
  };
  map.addSource(id, source);
  addLayer(
    map,
    {
      id,
      type: "raster",
      source: id,
      // No fade-duration:0 (MapLibre's default fade smooths the swap) and no
      // rasterPaint dim — USER DECISION (2026-07-27): "don't dim the weather
      // wash," the colour IS the data. See docs/architecture/weather-overlay.md.
      paint: {
        "raster-opacity": opacity,
        "raster-resampling": "linear",
      },
    },
    beforeId,
  );
  state.key = resolved.key;
}

/** What `createWeatherOverlay` needs from MapView. */
export interface WeatherOverlayDeps {
  /** The wash's fully-resolved source, or `null` while unresolved/nothing
   * selected. `resolveWeatherRaster` (sources.ts) resolves the URL in one
   * read — routes are id-addressed, no stale manifest-path straddle. */
  raster: Accessor<ResolvedWeatherRaster | null>;
}

/** weather — the raster wash (satellite-style reconcile), BELOW the seamarks
 * (negative `z`, excluded from the top-hoist). */
export function createWeatherOverlay(deps: WeatherOverlayDeps): Overlay {
  const rasterState: WeatherRasterState = { key: "" };
  const reconcileRaster = (map: MLMap, ctx: OverlayCtx) => {
    const w = ctx.settings().weather;
    applyWeatherRaster(map, deps.raster(), w.opacity, rasterState);
  };
  return {
    id: "weather",
    layerIds: WEATHER_LAYER_IDS,
    z: Z.weather,
    ensure: reconcileRaster,
    update: reconcileRaster,
  };
}
