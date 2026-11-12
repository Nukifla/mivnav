// Buddies that aren't live targets, at their last known position. A symbol
// layer of its own, under the AIS targets, reusing their hull icons
// (registered by `ensureSignalkLayers`). No predictor, heading stick or CPA:
// see `remembered` in ./model.ts.

import type { GeoJSONSource, Map as MLMap } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import { addLayer } from "../../core/layers/addLayer";
import { Z, type Overlay } from "../../core/layers/overlay";
import { TEXT_FONT } from "../../core/style/expr";
import type { Palette } from "../../core/style/colors";

const SOURCE = "buddies";
export const BUDDY_LAYER_ID = "buddies-hull";
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

export function createBuddiesOverlay(
  scene: (palette: Palette) => FeatureCollection,
  onMap: (map: MLMap) => void,
): Overlay {
  return {
    id: "buddies",
    layerIds: [BUDDY_LAYER_ID],
    z: Z.buddies,
    ensure(map) {
      onMap(map);
      if (!map.getSource(SOURCE)) map.addSource(SOURCE, { type: "geojson", data: EMPTY });
      if (map.getLayer(BUDDY_LAYER_ID)) return;
      addLayer(map, {
        id: BUDDY_LAYER_ID,
        type: "symbol",
        source: SOURCE,
        layout: {
          "icon-image": ["get", "icon"],
          "icon-rotate": ["get", "rotation"],
          "icon-rotation-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "text-field": ["get", "label"],
          "text-font": TEXT_FONT,
          "text-size": 12,
          "text-anchor": "top",
          "text-offset": [0, 1.2],
          "text-optional": true,
        },
        paint: {
          "text-color": ["get", "textColor"],
          "text-halo-color": ["get", "haloColor"],
          "text-halo-width": ["coalesce", ["get", "haloWidth"], 0],
          "text-halo-blur": ["coalesce", ["get", "haloBlur"], 0],
        },
      });
    },
    update(map, ctx) {
      const data = scene(ctx.settings().palette);
      (map.getSource(SOURCE) as GeoJSONSource | undefined)?.setData(data);
    },
  };
}
