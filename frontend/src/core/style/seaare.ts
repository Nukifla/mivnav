// SEAARE (bay/sound/channel/river names): text-only, nothing baked in tiles
// (CHBLK/lup_tables resolution: docs/architecture/style-draw-order-bands.md).
// Point-only label geometry avoids repeating a name per crossed tile.

import { point, PRIO, TEXT_FONT, type AddLayer } from "./expr";
import { haloPaint, paletteColors, themeFonts } from "./colors";
import type { ChartSettings } from "./settings";

/** `NOBJNM` (national name) preferred over `OBJNAM`, as s57-style.json's
 * `label-sea` layer does. */
const SEA_NAME: ["coalesce", ["get", "NOBJNM"], ["get", "OBJNAM"]] = [
  "coalesce",
  ["get", "NOBJNM"],
  ["get", "OBJNAM"],
];

export function seaareSymbolLayers(add: AddLayer, source: string, settings: ChartSettings): void {
  const C = paletteColors(settings.palette);
  add(PRIO.SYM_SEAARE, "SEAARE", {
    id: `${source}-seaare-name`,
    type: "symbol",
    filter: ["all", point, ["any", ["has", "NOBJNM"], ["has", "OBJNAM"]]],
    layout: {
      "text-field": SEA_NAME,
      "text-size": 13,
      "text-font": themeFonts(settings.palette).italic ?? TEXT_FONT,
      "text-optional": true,
    },
    paint: { "text-color": C.CHBLK, ...haloPaint(settings.palette) },
  });
}
