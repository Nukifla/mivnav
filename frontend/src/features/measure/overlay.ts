// The measure overlay: the line, its two ends, and the reading — a GeoJSON
// source and three layers, following signalkShips.ts's ensure*/update*
// pattern. See docs/architecture/measure-overlay.md, and note:
// ⚠️ MEASURE_LAYER_IDS MUST stay in MapView.wireMap's ensureOverlays()
// re-hoist list, or a palette/settings restyle makes this overlay vanish.

import type { FeatureCollection } from "geojson";
import type { ExpressionSpecification, GeoJSONSource, Map as MLMap } from "maplibre-gl";
import type { MeasureModel } from "./index";
import { wrapLonDeltaDeg } from "../../core/cpa";
import { formatRange, padDeg } from "../../core/format";
import { TEXT_FONT } from "../../core/style/expr";
import { haloPaint, overlayColors, type Palette } from "../../core/style/colors";
import { Z, type Overlay } from "../../core/layers/overlay";
import { addLayer } from "../../core/layers/addLayer";

const SOURCE = "measure";
const LINE_LAYER_ID = "measure-line";
const POINTS_LAYER_ID = "measure-points";
const LABEL_LAYER_ID = "measure-label";

/** Bottom to top. MapView re-hoists in this order, so the order here IS the
 * stacking: the line under its ends, the reading over both. */
export const MEASURE_LAYER_IDS = [LINE_LAYER_ID, POINTS_LAYER_ID, LABEL_LAYER_ID] as const;

// Paint properties are fed to WebGL, not the cascade, so `--color-accent`
// can't resolve there — the hex lives in `style/colors.ts`'s `OVERLAY_COLORS`
// instead, same pattern as `layers/route.ts`'s `ROUTE_OVERLAY_COLORS`.

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

/** Filtered by `kind` and never by geometry type, so an end point can never be
 * mistaken for the label's anchor. `signalkShips.ts` makes the same rule. */
const KIND = { end: "end", leg: "leg", label: "label" } as const;
const isKind = (kind: string): ExpressionSpecification => ["==", ["get", "kind"], kind];

/** Idempotent: (re-)create the source and layers after any style application,
 * seeded with the given palette's colours (recolour later via `applyMeasurePaint`). */
export function ensureMeasureLayers(map: MLMap, palette: Palette): void {
  if (!map.getSource(SOURCE)) map.addSource(SOURCE, { type: "geojson", data: EMPTY });
  const c = overlayColors(palette);

  const layer = (spec: Parameters<MLMap["addLayer"]>[0]) => {
    if (!map.getLayer(spec.id)) addLayer(map, spec);
  };

  // Dashed, because a measurement is a question and not a thing in the world.
  // The chart is full of solid lines that mean something is there.
  layer({
    id: LINE_LAYER_ID,
    type: "line",
    source: SOURCE,
    filter: isKind(KIND.leg),
    layout: { "line-cap": "round" },
    paint: {
      "line-color": c.accent,
      "line-width": 2,
      "line-dasharray": [3, 2],
    },
  });

  // Hollow rings: an end is a place you pointed at, and a filled dot would hide
  // the very thing you pointed at.
  layer({
    id: POINTS_LAYER_ID,
    type: "circle",
    source: SOURCE,
    filter: isKind(KIND.end),
    paint: {
      "circle-radius": 5,
      "circle-color": "rgba(0,0,0,0)",
      "circle-stroke-width": 2,
      "circle-stroke-color": c.accent,
    },
  });

  layer({
    id: LABEL_LAYER_ID,
    type: "symbol",
    source: SOURCE,
    filter: isKind(KIND.label),
    layout: {
      "text-field": ["get", "text"],
      "text-font": TEXT_FONT,
      "text-size": 12,
      "text-offset": [0, -0.9],
      // The reading must be readable over a wreck symbol and over open water
      // alike, and it must never be dropped for colliding with a buoy's name:
      // it is the answer to the question the user is asking right now.
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    },
    paint: {
      "text-color": c.accent,
      ...haloPaint(palette, c.halo),
    },
  });
}

/** Recolour for a palette switch — a paint-property swap needing no style
 * reload, mirrors `applyRoutePaint`. Guarded per layer for a style-reload
 * beat where a layer is momentarily absent. */
export function applyMeasurePaint(map: MLMap, palette: Palette): void {
  const c = overlayColors(palette);
  const set = (id: string, prop: string, value: unknown) => {
    if (map.getLayer(id)) map.setPaintProperty(id, prop, value);
  };
  set(LINE_LAYER_ID, "line-color", c.accent);
  set(POINTS_LAYER_ID, "circle-stroke-color", c.accent);
  set(LABEL_LAYER_ID, "text-color", c.accent);
  // A palette switch changes WHETHER there is a halo, not just its colour, so
  // every key needs an explicit fallback or a stale width/blur survives.
  const glow = haloPaint(palette, c.halo);
  set(LABEL_LAYER_ID, "text-halo-color", glow["text-halo-color"] ?? c.halo);
  set(LABEL_LAYER_ID, "text-halo-width", glow["text-halo-width"] ?? 0);
  set(LABEL_LAYER_ID, "text-halo-blur", glow["text-halo-blur"] ?? 0);
}

/**
 * Push the current measurement into the (ensured) source.
 *
 * ⚠️ Model accessors are read BEFORE the `getSource` guard, unconditionally —
 * not `source && model?.a()`. Reordering this reintroduces a real bug where
 * the effect's dependency set goes stale after the first `loaded` flip and
 * the map source stops updating. See docs/architecture/measure-overlay.md.
 */
export function updateMeasureData(map: MLMap, model: MeasureModel | undefined): void {
  const a = model?.a();
  const b = model?.b();
  const leg = model?.leg();

  const source = map.getSource(SOURCE) as GeoJSONSource | undefined;
  if (!source) return;

  const features: FeatureCollection["features"] = [];

  // The first end is drawn as soon as it exists, before there is anything to
  // measure to: the ring is the feedback that the tap landed.
  for (const end of [a, b]) {
    if (!end) continue;
    features.push({
      type: "Feature",
      properties: { kind: KIND.end },
      geometry: { type: "Point", coordinates: [end.lng, end.lat] },
    });
  }

  if (leg) {
    const range = formatRange(leg.rangeNm);
    features.push({
      type: "Feature",
      properties: { kind: KIND.leg },
      geometry: {
        type: "LineString",
        coordinates: [
          [leg.from.lng, leg.from.lat],
          [leg.to.lng, leg.to.lat],
        ],
      },
    });
    features.push({
      type: "Feature",
      properties: { kind: KIND.label, text: `${range.value} ${range.unit} · ${padDeg(leg.brgDeg)}°` },
      // Midpoint of the *drawn* (Mercator-straight) line, not a great-circle
      // midpoint which would sit off it. `wrapLonDeltaDeg`: a plain longitude
      // mean puts a 179°E-to-179°W leg's label on the Greenwich meridian.
      geometry: {
        type: "Point",
        coordinates: [
          leg.from.lng + wrapLonDeltaDeg(leg.to.lng - leg.from.lng) / 2,
          (leg.from.lat + leg.to.lat) / 2,
        ],
      },
    });
  }

  source.setData({ type: "FeatureCollection", features });
}

/** A factory closing over the feature's `model` (weather/POI pattern), so
 * `layers/overlay.ts` no longer imports this feature directly. */
export function createMeasureOverlay(model: MeasureModel | undefined): Overlay {
  return {
    id: "measure",
    layerIds: MEASURE_LAYER_IDS,
    z: Z.measure,
    ensure(map, ctx) {
      ensureMeasureLayers(map, ctx.settings().palette);
    },
    update(map) {
      updateMeasureData(map, model);
    },
    paint(map, ctx) {
      applyMeasurePaint(map, ctx.settings().palette);
    },
  };
}
