// The marks on the chart: one symbol layer, glyph + name. Nothing here fills
// an area, so the chart under a mark stays readable at every zoom; the info
// panel's own marker shows which one is selected.

import type { GeoJSONSource, Map as MLMap } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import { addLayer } from "../../core/layers/addLayer";
import { Z, type Overlay } from "../../core/layers/overlay";
import { TEXT_FONT } from "../../core/style/expr";
import type { Palette } from "../../core/style/colors";
import { ensureMarkIcons } from "./icons";

const SOURCE = "marks";
export const MARK_LAYER_ID = "marks-symbol";
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

export function createMarksOverlay(
  scene: (palette: Palette) => FeatureCollection,
  onMap: (map: MLMap) => void,
): Overlay {
  return {
    id: "marks",
    layerIds: [MARK_LAYER_ID],
    z: Z.marks,
    ensure(map) {
      onMap(map);
      if (!map.getSource(SOURCE)) map.addSource(SOURCE, { type: "geojson", data: EMPTY });
      if (map.getLayer(MARK_LAYER_ID)) return;
      addLayer(map, {
        id: MARK_LAYER_ID,
        type: "symbol",
        source: SOURCE,
        layout: {
          "icon-image": ["get", "icon"],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "text-field": ["get", "label"],
          "text-font": TEXT_FONT,
          "text-size": 12,
          "text-anchor": "top",
          "text-offset": [0, 1.1],
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
      const palette = ctx.settings().palette;
      // Before the data that names them, and again on a palette switch.
      ensureMarkIcons(map, palette);
      // Build the scene BEFORE the `?.`: as the argument of an optional call
      // it is skipped while the source is missing (this effect's first run
      // beats `ensure`), the marks signal is never read, and the effect never
      // re-runs on a new/deleted mark — they only showed after a reload.
      const data = scene(palette);
      (map.getSource(SOURCE) as GeoJSONSource | undefined)?.setData(data);
    },
  };
}
