// Region-draw overlay: existing boxes for context, boxes committed this
// session, the live preview, and the first corner of an in-progress box.
// See docs/architecture/region-draw.md for the overlay-layering rationale
// and the `MapView.wireMap` re-hoist requirement on `REGION_DRAW_LAYER_IDS`.

import type { FeatureCollection } from "geojson";
import type { ExpressionSpecification, GeoJSONSource, Map as MLMap } from "maplibre-gl";
import type { Accessor } from "solid-js";
import type { GeoPoint } from "../../core/chrome/geo";
import { overlayColors, type Palette } from "../../core/style/colors";
import { Z, type Overlay } from "../../core/layers/overlay";
import type { BBox } from "../../core/settings/regions";
import type { RegionDrawRect } from "./index";
import { addLayer } from "../../core/layers/addLayer";

const SOURCE = "region-draw";
const EXISTING_FILL_LAYER_ID = "region-draw-existing-fill";
const EXISTING_OUTLINE_LAYER_ID = "region-draw-existing-outline";
const COMMITTED_FILL_LAYER_ID = "region-draw-committed-fill";
const COMMITTED_OUTLINE_LAYER_ID = "region-draw-committed-outline";
const PREVIEW_FILL_LAYER_ID = "region-draw-preview-fill";
const PREVIEW_OUTLINE_LAYER_ID = "region-draw-preview-outline";
const CORNER_LAYER_ID = "region-draw-corner";

// Bottom to top; MapView re-hoists in this order.
export const REGION_DRAW_LAYER_IDS = [
  EXISTING_FILL_LAYER_ID,
  EXISTING_OUTLINE_LAYER_ID,
  COMMITTED_FILL_LAYER_ID,
  COMMITTED_OUTLINE_LAYER_ID,
  PREVIEW_FILL_LAYER_ID,
  PREVIEW_OUTLINE_LAYER_ID,
  CORNER_LAYER_ID,
] as const;

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

const KIND = { corner: "corner", existing: "existing", committed: "committed", preview: "preview" } as const;

const boxFeature = (b: BBox | RegionDrawRect, kind: string): FeatureCollection["features"][number] => {
  const minLon = "min_lon" in b ? b.min_lon : b.minLon;
  const minLat = "min_lat" in b ? b.min_lat : b.minLat;
  const maxLon = "max_lon" in b ? b.max_lon : b.maxLon;
  const maxLat = "max_lat" in b ? b.max_lat : b.maxLat;
  return {
    type: "Feature",
    properties: { kind },
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [minLon, minLat],
          [maxLon, minLat],
          [maxLon, maxLat],
          [minLon, maxLat],
          [minLon, minLat],
        ],
      ],
    },
  };
};

/** Idempotent: (re-)create the source and layers after any style application;
 * recolour later via `applyRegionDrawPaint`. */
export function ensureRegionDrawLayers(map: MLMap, palette: Palette): void {
  if (!map.getSource(SOURCE)) map.addSource(SOURCE, { type: "geojson", data: EMPTY });
  const c = overlayColors(palette);

  const layer = (spec: Parameters<MLMap["addLayer"]>[0]) => {
    if (!map.getLayer(spec.id)) addLayer(map, spec);
  };
  const isKind = (kind: string): ExpressionSpecification => ["==", ["get", "kind"], kind];

  // Existing boxes: quiet — thin outline, faint fill — so a box being drawn
  // now reads clearly above the context rather than competing with it.
  layer({
    id: EXISTING_FILL_LAYER_ID,
    type: "fill",
    source: SOURCE,
    filter: isKind(KIND.existing),
    paint: { "fill-color": c.accent, "fill-opacity": 0.06 },
  });
  layer({
    id: EXISTING_OUTLINE_LAYER_ID,
    type: "line",
    source: SOURCE,
    filter: isKind(KIND.existing),
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": c.accent, "line-width": 1, "line-opacity": 0.6 },
  });

  // Committed: solid, not dashed — the second tap already answered "is this
  // real".
  layer({
    id: COMMITTED_FILL_LAYER_ID,
    type: "fill",
    source: SOURCE,
    filter: isKind(KIND.committed),
    paint: { "fill-color": c.accent, "fill-opacity": 0.15 },
  });
  layer({
    id: COMMITTED_OUTLINE_LAYER_ID,
    type: "line",
    source: SOURCE,
    filter: isKind(KIND.committed),
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": c.accent, "line-width": 2 },
  });

  // Live rubber-band, dashed like measure's line: a box being drawn is a
  // question, not yet a thing in the world.
  layer({
    id: PREVIEW_FILL_LAYER_ID,
    type: "fill",
    source: SOURCE,
    filter: isKind(KIND.preview),
    paint: { "fill-color": c.accent, "fill-opacity": 0.15 },
  });
  layer({
    id: PREVIEW_OUTLINE_LAYER_ID,
    type: "line",
    source: SOURCE,
    filter: isKind(KIND.preview),
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": c.accent, "line-width": 2, "line-dasharray": [3, 2] },
  });

  layer({
    id: CORNER_LAYER_ID,
    type: "circle",
    source: SOURCE,
    filter: isKind(KIND.corner),
    paint: {
      "circle-radius": 5,
      "circle-color": "rgba(0,0,0,0)",
      "circle-stroke-width": 2,
      "circle-stroke-color": c.accent,
    },
  });
}

/** Recolour for the current palette. Guarded per layer so it is a no-op on a
 * style-reload beat where a layer is momentarily absent. */
export function applyRegionDrawPaint(map: MLMap, palette: Palette): void {
  const c = overlayColors(palette);
  const set = (id: string, prop: string, value: unknown) => {
    if (map.getLayer(id)) map.setPaintProperty(id, prop, value);
  };
  set(EXISTING_FILL_LAYER_ID, "fill-color", c.accent);
  set(EXISTING_OUTLINE_LAYER_ID, "line-color", c.accent);
  set(COMMITTED_FILL_LAYER_ID, "fill-color", c.accent);
  set(COMMITTED_OUTLINE_LAYER_ID, "line-color", c.accent);
  set(PREVIEW_FILL_LAYER_ID, "fill-color", c.accent);
  set(PREVIEW_OUTLINE_LAYER_ID, "line-color", c.accent);
  set(CORNER_LAYER_ID, "circle-stroke-color", c.accent);
}

/** Slice of `RegionDrawModel` the overlay reads — kept narrow so this file's
 * only coupling to `./index` is the accessors it actually draws. */
export interface RegionDrawOverlayModel {
  corner: Accessor<GeoPoint | null>;
  preview: Accessor<RegionDrawRect | null>;
  committed: Accessor<readonly BBox[]>;
  existing: Accessor<readonly BBox[]>;
}

export function updateRegionDrawData(map: MLMap, model: RegionDrawOverlayModel | undefined): void {
  const source = map.getSource(SOURCE) as GeoJSONSource | undefined;
  if (!source) return;

  const features: FeatureCollection["features"] = [];
  for (const b of model?.existing() ?? []) features.push(boxFeature(b, KIND.existing));
  for (const b of model?.committed() ?? []) features.push(boxFeature(b, KIND.committed));

  const rect = model?.preview();
  if (rect) {
    features.push(boxFeature(rect, KIND.preview));
  } else {
    const c = model?.corner();
    if (c) {
      features.push({
        type: "Feature",
        properties: { kind: KIND.corner },
        geometry: { type: "Point", coordinates: [c.lng, c.lat] },
      });
    }
  }

  source.setData({ type: "FeatureCollection", features });
}

export function createRegionDrawOverlay(model: RegionDrawOverlayModel | undefined): Overlay {
  return {
    id: "region-draw",
    layerIds: REGION_DRAW_LAYER_IDS,
    z: Z.regionDraw,
    ensure(map, ctx) {
      ensureRegionDrawLayers(map, ctx.settings().palette);
    },
    update(map) {
      updateRegionDrawData(map, model);
    },
    paint(map, ctx) {
      applyRegionDrawPaint(map, ctx.settings().palette);
    },
  };
}
