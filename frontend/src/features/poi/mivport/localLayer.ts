// The places changed on the boat, drawn from their own small GeoJSON layer
// (`GET /api/poi/mivport/local`) with THE POI marker spec, so they look like
// every other POI and the POI info provider answers taps on them
// (`registerPoiQueryLayers`, src/index.tsx). The baked layers hide the same
// refs (`PoiSourcePlugin.hiddenRefs`), so a changed place is drawn once, here.
//
// Also the editor's pin: where a new or moved place will go, drawn while the
// editor or its pin mode is up, and draggable in that mode.

import type { ExpressionSpecification, GeoJSONSource, Map as MLMap, MapLayerMouseEvent, MapLayerTouchEvent } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import { addLayer } from "../../../core/layers/addLayer";
import { Z, type Overlay } from "../../../core/layers/overlay";
import { markerMagenta, type Palette } from "../../../core/style/colors";
import { ensurePoiImages } from "../icons";
import { applyPoiPaint, markerKinds, poiMarkerLayer } from "../overlay";
import type { MivportGeom, MivportLocalFeature } from "./types";

export const MIVPORT_LOCAL_SOURCE_ID = "mivport-local";
export const MIVPORT_LOCAL_LAYER_ID = "mivport-local-marker";
export const MIVPORT_PIN_SOURCE_ID = "mivport-pin";
export const MIVPORT_PIN_LAYER_ID = "mivport-pin";

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

/** The local layer's filter: the POI markers' own (legacy kinds out, harbour
 * offices only zoomed in), plus each place's `min_zoom` — a baked tile
 * leaves a point out below it; a GeoJSON source has to be told. */
export function localLayerFilter(): ExpressionSpecification {
  return ["all", markerKinds(), [">=", ["zoom"], ["coalesce", ["get", "min_zoom"], 0]]];
}

/** The features to draw: not the deleted ones (they are hidden, not drawn). */
export function localCollection(features: readonly MivportLocalFeature[]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: features
      .filter((f) => f?.geometry?.type === "Point" && f.properties && !f.properties.deleted)
      .map((f) => ({ ...f, properties: { ...f.properties } })) as FeatureCollection["features"],
  };
}

export function pinCollection(at: MivportGeom | undefined): FeatureCollection {
  if (!at) return EMPTY;
  return {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [at.lon, at.lat] } }],
  };
}

export interface LocalLayerDeps {
  features: () => readonly MivportLocalFeature[];
  /** The editor's pin, while there is one to show. */
  pin: () => MivportGeom | undefined;
  /** The pin can be dragged (its mode is up). */
  pinDraggable: () => boolean;
  onPinDrag: (at: MivportGeom) => void;
  onMap: (map: MLMap) => void;
}

export function createMivportLocalOverlay(deps: LocalLayerDeps): Overlay {
  let wired: MLMap | undefined;

  /** Drag the pin: MapLibre's "drag a point" pattern — a press on the pin
   * stops the chart panning and follows the pointer until release. */
  const wireDrag = (map: MLMap) => {
    if (wired === map || typeof map.on !== "function") return;
    wired = map;
    const move = (e: { lngLat: { lng: number; lat: number } }) =>
      deps.onPinDrag({ lat: e.lngLat.lat, lon: e.lngLat.lng });
    map.on("mousedown", MIVPORT_PIN_LAYER_ID, (e: MapLayerMouseEvent) => {
      if (!deps.pinDraggable()) return;
      e.preventDefault();
      map.getCanvas().style.cursor = "grabbing";
      map.on("mousemove", move);
      map.once("mouseup", () => {
        map.off("mousemove", move);
        map.getCanvas().style.cursor = "";
      });
    });
    map.on("touchstart", MIVPORT_PIN_LAYER_ID, (e: MapLayerTouchEvent) => {
      if (!deps.pinDraggable() || e.points.length !== 1) return;
      e.preventDefault();
      map.on("touchmove", move);
      map.once("touchend", () => map.off("touchmove", move));
    });
  };

  const pinPaint = (palette: Palette) => ({
    "circle-radius": 9,
    "circle-color": markerMagenta(palette),
    "circle-opacity": 0.35,
    "circle-stroke-width": 3,
    "circle-stroke-color": markerMagenta(palette),
  });

  return {
    id: "mivport-local",
    layerIds: [MIVPORT_LOCAL_LAYER_ID, MIVPORT_PIN_LAYER_ID],
    // The POI band, after the baked union (stable order): a local copy of a
    // place replaces the baked one, which is hidden anyway.
    z: Z.poi,
    ensure(map, ctx) {
      deps.onMap(map);
      const palette = ctx.settings().palette;
      if (!map.getSource(MIVPORT_LOCAL_SOURCE_ID)) {
        map.addSource(MIVPORT_LOCAL_SOURCE_ID, { type: "geojson", data: EMPTY });
      }
      if (!map.getSource(MIVPORT_PIN_SOURCE_ID)) {
        map.addSource(MIVPORT_PIN_SOURCE_ID, { type: "geojson", data: EMPTY });
      }
      ensurePoiImages(map);
      if (!map.getLayer(MIVPORT_LOCAL_LAYER_ID)) {
        // The vector spec's `source-layer` means nothing to a GeoJSON source.
        const { "source-layer": _unused, ...layer } = poiMarkerLayer(
          MIVPORT_LOCAL_LAYER_ID,
          MIVPORT_LOCAL_SOURCE_ID,
          localLayerFilter(),
          palette,
        );
        addLayer(map, layer);
      }
      if (!map.getLayer(MIVPORT_PIN_LAYER_ID)) {
        addLayer(map, {
          id: MIVPORT_PIN_LAYER_ID,
          type: "circle",
          source: MIVPORT_PIN_SOURCE_ID,
          paint: pinPaint(palette),
        });
      }
      wireDrag(map);
    },
    update(map, ctx) {
      // Read BEFORE the `?.` (see marks/overlay.ts): the signals must be
      // subscribed even on the beat the source is still missing.
      const show = ctx.settings().showPois;
      const data = show ? localCollection(deps.features()) : EMPTY;
      const pin = pinCollection(deps.pin());
      (map.getSource(MIVPORT_LOCAL_SOURCE_ID) as GeoJSONSource | undefined)?.setData(data);
      (map.getSource(MIVPORT_PIN_SOURCE_ID) as GeoJSONSource | undefined)?.setData(pin);
    },
    paint(map, ctx) {
      const palette = ctx.settings().palette;
      applyPoiPaint(map, palette, MIVPORT_LOCAL_LAYER_ID);
      if (map.getLayer(MIVPORT_PIN_LAYER_ID)) {
        for (const [k, v] of Object.entries(pinPaint(palette))) {
          map.setPaintProperty(MIVPORT_PIN_LAYER_ID, k, v);
        }
      }
    },
  };
}
