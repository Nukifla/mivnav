// The MOB mark on the chart: a red ring with a dot, labelled "MOB", and a
// dashed line from the boat to it — the course back. Circles and a text
// label only (no sprite to load), so it draws on the first frame after the
// press. Fixed alarm red on every palette, as every alarm colour is.

import type { FeatureCollection } from "geojson";
import type { GeoJSONSource, Map as MLMap } from "maplibre-gl";
import type { Accessor } from "solid-js";
import type { GeoPoint } from "../../core/chrome/geo";
import { addLayer } from "../../core/layers/addLayer";
import { Z, type Overlay } from "../../core/layers/overlay";
import { ANCHOR_ALARM, overlayColors, type Palette } from "../../core/style/colors";
import { TEXT_FONT } from "../../core/style/expr";

const SOURCE = "mob";
const LINE_LAYER_ID = "mob-line";
const RING_LAYER_ID = "mob-ring";
const DOT_LAYER_ID = "mob-dot";
const LABEL_LAYER_ID = "mob-label";

/** Bottom to top. */
export const MOB_LAYER_IDS = [LINE_LAYER_ID, RING_LAYER_ID, DOT_LAYER_ID, LABEL_LAYER_ID] as const;

const RED = ANCHOR_ALARM;

export interface MobScene {
  mark: GeoPoint | null;
  boat: GeoPoint | null;
  /** Under the "MOB" label: the time it went in, e.g. "14:32". */
  label: string;
}

/** Pure, so the geometry is tested without a map. Nothing without a mark. */
export function mobFeatures(scene: MobScene): FeatureCollection {
  const { mark, boat } = scene;
  if (!mark) return { type: "FeatureCollection", features: [] };
  return {
    type: "FeatureCollection",
    features: [
      ...(boat
        ? [
            {
              type: "Feature" as const,
              properties: { kind: "line" },
              geometry: {
                type: "LineString" as const,
                coordinates: [
                  [boat.lng, boat.lat],
                  [mark.lng, mark.lat],
                ],
              },
            },
          ]
        : []),
      {
        type: "Feature",
        properties: { kind: "mark", label: scene.label ? `MOB\n${scene.label}` : "MOB" },
        geometry: { type: "Point", coordinates: [mark.lng, mark.lat] },
      },
    ],
  };
}

function ensureMobLayers(map: MLMap): void {
  if (!map.getSource(SOURCE)) {
    map.addSource(SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  }
  const layer = (spec: Parameters<MLMap["addLayer"]>[0]) => {
    if (!map.getLayer(spec.id)) addLayer(map, spec);
  };
  layer({
    id: LINE_LAYER_ID,
    type: "line",
    source: SOURCE,
    filter: ["==", ["get", "kind"], "line"],
    layout: { "line-cap": "round" },
    paint: { "line-color": RED, "line-width": 2.5, "line-dasharray": [2, 1.5] },
  });
  layer({
    id: RING_LAYER_ID,
    type: "circle",
    source: SOURCE,
    filter: ["==", ["get", "kind"], "mark"],
    paint: {
      "circle-radius": 16,
      "circle-color": RED,
      "circle-opacity": 0,
      "circle-stroke-color": RED,
      "circle-stroke-width": 4,
    },
  });
  layer({
    id: DOT_LAYER_ID,
    type: "circle",
    source: SOURCE,
    filter: ["==", ["get", "kind"], "mark"],
    paint: {
      "circle-radius": 6,
      "circle-color": RED,
      "circle-stroke-color": overlayColors("day").markerHalo,
      "circle-stroke-width": 2,
    },
  });
  layer({
    id: LABEL_LAYER_ID,
    type: "symbol",
    source: SOURCE,
    filter: ["==", ["get", "kind"], "mark"],
    layout: {
      "text-field": ["get", "label"],
      "text-font": TEXT_FONT,
      "text-size": 13,
      "text-anchor": "top",
      "text-offset": [0, 1.6],
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    },
    paint: { "text-color": RED, "text-halo-color": overlayColors("day").markerHalo, "text-halo-width": 2 },
  });
}

/** The halo follows the palette (dim at night); the red does not. */
function applyHalo(map: MLMap, palette: Palette): void {
  const halo = overlayColors(palette).markerHalo;
  if (map.getLayer(DOT_LAYER_ID)) map.setPaintProperty(DOT_LAYER_ID, "circle-stroke-color", halo);
  if (map.getLayer(LABEL_LAYER_ID)) map.setPaintProperty(LABEL_LAYER_ID, "text-halo-color", halo);
}

export function createMobOverlay(scene: Accessor<MobScene>): Overlay {
  return {
    id: "mob",
    layerIds: MOB_LAYER_IDS,
    z: Z.mob,
    ensure(map, ctx) {
      ensureMobLayers(map);
      applyHalo(map, ctx.settings().palette);
    },
    update(map) {
      // Read BEFORE the source guard, so the effect keeps its dependency.
      const data = mobFeatures(scene());
      (map.getSource(SOURCE) as GeoJSONSource | undefined)?.setData(data);
    },
    paint(map, ctx) {
      applyHalo(map, ctx.settings().palette);
    },
  };
}
