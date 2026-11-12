// Ship-track overlay: one GeoJSON MultiLineString of where the boat has been —
// several lines, because the server breaks the track at holes in the record.
// `TRACK_LAYER_IDS` must be in the overlay's `layerIds` for MapView's
// re-hoist. See docs/architecture/track-overlay.md.

import type { Feature, FeatureCollection, MultiLineString } from "geojson";
import type { ExpressionSpecification, GeoJSONSource, Map as MLMap } from "maplibre-gl";
import type { Accessor } from "solid-js";
import { Z, type Overlay } from "../../core/layers/overlay";
import { overlayColors, type Palette } from "../../core/style/colors";
import type { TrackCoordinate } from "./client";
import { addLayer } from "../../core/layers/addLayer";

const SOURCE = "track";
const CASING_LAYER_ID = "track-casing";
const LINE_LAYER_ID = "track-line";

/** Bottom to top: the casing under the line it outlines. */
export const TRACK_LAYER_IDS = [CASING_LAYER_ID, LINE_LAYER_ID] as const;

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

/** The last 24 h stands out; older track recedes to a faint record of where
 * the boat has been — present, not competing with the chart. Opacity rather
 * than a second colour, so it follows every palette and theme override. */
export const TRACK_STYLE = {
  recent: { width: 3, opacity: 1, casingWidth: 6, casingOpacity: 0.85 },
  older: { width: 2, opacity: 0.4, casingWidth: 4, casingOpacity: 0.15 },
} as const;

/** A paint value chosen by the feature's `recent` property. */
function byAge(recent: number, older: number): ExpressionSpecification {
  return ["case", ["==", ["get", "recent"], true], recent, older];
}

/** Idempotent: (re-)create the source and both layers after any style
 * application, seeded with this palette's colours (recolour via
 * `applyTrackPaint`). */
export function ensureTrackLayers(map: MLMap, palette: Palette): void {
  if (!map.getSource(SOURCE)) map.addSource(SOURCE, { type: "geojson", data: EMPTY });
  const c = overlayColors(palette);
  const layer = (spec: Parameters<MLMap["addLayer"]>[0]) => {
    if (!map.getLayer(spec.id)) addLayer(map, spec);
  };
  layer({
    id: CASING_LAYER_ID,
    type: "line",
    source: SOURCE,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": c.halo,
      "line-width": byAge(TRACK_STYLE.recent.casingWidth, TRACK_STYLE.older.casingWidth),
      "line-opacity": byAge(TRACK_STYLE.recent.casingOpacity, TRACK_STYLE.older.casingOpacity),
    },
  });
  layer({
    id: LINE_LAYER_ID,
    type: "line",
    source: SOURCE,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": c.accent,
      "line-width": byAge(TRACK_STYLE.recent.width, TRACK_STYLE.older.width),
      "line-opacity": byAge(TRACK_STYLE.recent.opacity, TRACK_STYLE.older.opacity),
    },
  });
}

/** Recolour for the current palette — a paint-property swap, no style reload.
 * Guarded per layer so it is a no-op on a style-reload beat where a layer is
 * momentarily absent. */
export function applyTrackPaint(map: MLMap, palette: Palette): void {
  const c = overlayColors(palette);
  const set = (id: string, prop: string, value: unknown) => {
    if (map.getLayer(id)) map.setPaintProperty(id, prop, value);
  };
  set(CASING_LAYER_ID, "line-color", c.halo);
  set(LINE_LAYER_ID, "line-color", c.accent);
}

/** Lines of fewer than two points are dropped, and no lines is an empty
 * collection rather than a degenerate geometry: "nothing to draw" stays one
 * readable branch. Older track and the recent stretch are two features, the
 * recent one LAST so it draws on top where they meet. */
export function updateTrackData(
  map: MLMap,
  lines: readonly (readonly TrackCoordinate[])[],
  recent: readonly (readonly TrackCoordinate[])[] = [],
): void {
  const source = map.getSource(SOURCE) as GeoJSONSource | undefined;
  if (!source) return;
  const features = [
    feature(lines, false),
    feature(recent, true),
  ].filter((f): f is Feature<MultiLineString> => f !== null);
  source.setData(features.length === 0 ? EMPTY : { type: "FeatureCollection", features });
}

function feature(
  lines: readonly (readonly TrackCoordinate[])[],
  recent: boolean,
): Feature<MultiLineString> | null {
  const drawn = lines.filter((line) => line.length >= 2);
  if (drawn.length === 0) return null;
  return {
    type: "Feature",
    properties: { recent },
    // Copied, not aliased: GeoJSON's `coordinates` is mutable and these
    // arrays belong to the client's signal. One shallow copy per poll is
    // nothing next to the tessellation that follows.
    geometry: {
      type: "MultiLineString",
      coordinates: drawn.map((line) => line.map((c) => [c[0], c[1]])),
    },
  };
}

/** The slice of the feature this overlay reads — kept narrow, like
 * region-draw's own `RegionDrawOverlayModel`. */
export interface TrackOverlayModel {
  lines: Accessor<readonly (readonly TrackCoordinate[])[]>;
  recent?: Accessor<readonly (readonly TrackCoordinate[])[]>;
}

/** The past-track overlay. Its layers are installed regardless (an empty
 * source draws nothing) — the *fetching* is what the `showTrack` toggle gates,
 * in `./client`, which is where the cost actually is. */
export function createTrackOverlay(model: TrackOverlayModel): Overlay {
  return {
    id: "track",
    layerIds: TRACK_LAYER_IDS,
    z: Z.track,
    ensure(map, ctx) {
      ensureTrackLayers(map, ctx.settings().palette);
    },
    update(map) {
      updateTrackData(map, model.lines(), model.recent?.() ?? []);
    },
    paint(map, ctx) {
      applyTrackPaint(map, ctx.settings().palette);
    },
  };
}
