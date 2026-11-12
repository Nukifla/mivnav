// The leg table's chart preview: a SAVED route listed in the table may not be
// drawn at all (the route display shows only the followed route or a draft),
// so while the table is open on one, this draws its line and points, and the
// leg tapped in the table as a wide translucent band — the editor's selected-
// leg look. Nothing for the editor's draft: the editor draws that itself.

import type { FeatureCollection } from "geojson";
import type { GeoJSONSource, Map as MLMap } from "maplibre-gl";
import { lerpDensity } from "../../core/chrome/registry";
import { routeOverlayColors } from "../../core/style/colors";
import { Z, type Overlay } from "../../core/layers/overlay";
import { addLayer } from "../../core/layers/addLayer";
import type { Route } from "../../core/routes";

const SOURCE = "leg-table";
const LEG_LAYER = "leg-table-leg";
const LINE_LAYER = "leg-table-line";
const POINT_LAYER = "leg-table-points";
export const LEG_TABLE_LAYER_IDS = [LEG_LAYER, LINE_LAYER, POINT_LAYER] as const;

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

export interface LegTablePreview {
  route: Route;
  /** Draw the line and points too — false when the route display already does. */
  line: boolean;
  /** The leg to band, or null. */
  leg: number | null;
}

/** The preview as GeoJSON — pure, so it is testable without a map. */
export function previewData(p: LegTablePreview | null): FeatureCollection {
  if (!p) return EMPTY;
  const wps = p.route.waypoints;
  const features: FeatureCollection["features"] = [];
  if (p.line && wps.length >= 2) {
    features.push({
      type: "Feature",
      properties: { kind: "line" },
      geometry: { type: "LineString", coordinates: wps.map((w) => [w.lon, w.lat]) },
    });
  }
  if (p.line) {
    for (const w of wps) {
      features.push({ type: "Feature", properties: { kind: "point" }, geometry: { type: "Point", coordinates: [w.lon, w.lat] } });
    }
  }
  const a = p.leg === null ? undefined : wps[p.leg];
  const b = p.leg === null ? undefined : wps[p.leg + 1];
  if (a && b) {
    features.push({
      type: "Feature",
      properties: { kind: "leg" },
      geometry: { type: "LineString", coordinates: [[a.lon, a.lat], [b.lon, b.lat]] },
    });
  }
  return { type: "FeatureCollection", features };
}

export function createLegTableOverlay(
  preview: () => LegTablePreview | null,
  onMap: (map: MLMap) => void,
): Overlay {
  return {
    id: "legTable",
    layerIds: LEG_TABLE_LAYER_IDS,
    z: Z.legTable,
    ensure(map) {
      onMap(map);
      if (!map.getSource(SOURCE)) map.addSource(SOURCE, { type: "geojson", data: EMPTY });
      const kind = (k: string) => ["==", ["get", "kind"], k] as ["==", ["get", "kind"], string];
      if (!map.getLayer(LEG_LAYER))
        addLayer(map, { id: LEG_LAYER, type: "line", source: SOURCE, filter: kind("leg"), layout: { "line-cap": "round" } });
      if (!map.getLayer(LINE_LAYER))
        addLayer(map, { id: LINE_LAYER, type: "line", source: SOURCE, filter: kind("line"), layout: { "line-cap": "round" } });
      if (!map.getLayer(POINT_LAYER))
        addLayer(map, { id: POINT_LAYER, type: "circle", source: SOURCE, filter: kind("point") });
    },
    update(map) {
      const data = previewData(preview());
      (map.getSource(SOURCE) as GeoJSONSource | undefined)?.setData(data);
    },
    paint(map, ctx) {
      const c = routeOverlayColors(ctx.settings().palette);
      const d = ctx.density();
      const set = (id: string, prop: string, value: unknown) => {
        if (map.getLayer(id)) map.setPaintProperty(id, prop, value);
      };
      set(LEG_LAYER, "line-color", c.route);
      set(LEG_LAYER, "line-width", lerpDensity(8, 10, d));
      set(LEG_LAYER, "line-opacity", 0.45);
      set(LINE_LAYER, "line-color", c.route);
      set(LINE_LAYER, "line-width", lerpDensity(2, 2.5, d));
      set(POINT_LAYER, "circle-radius", lerpDensity(3.5, 4.5, d));
      set(POINT_LAYER, "circle-color", c.halo);
      set(POINT_LAYER, "circle-stroke-width", 2);
      set(POINT_LAYER, "circle-stroke-color", c.route);
    },
  };
}
