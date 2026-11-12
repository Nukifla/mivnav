// MARCUL/FERYRT ride the same restricted-group Line schema (sym/lc/bcol/bwid/
// dpri) chartcore's derive::restricted bakes for RESARE etc (see aidsHazards.ts
// loop sites, restricted.rs module doc). No sym/txt here, unlike cablesPipelines.ts.

import { line, PRIO, type AddLayer } from "./expr";
import { paletteColors } from "./colors";
import type { ChartSettings } from "./settings";

const LINE_CLASSES = ["MARCUL", "FERYRT"] as const;

export function waterwaysLineLayers(
  add: AddLayer,
  source: string,
  settings: ChartSettings,
): void {
  const C = paletteColors(settings.palette);
  for (const cls of LINE_CLASSES) {
    add(PRIO.WATERWAY_LINE, cls, {
      id: `${source}-${cls.toLowerCase()}-line`,
      type: "line",
      filter: line,
      paint: {
        "line-color": [
          "match", ["get", "bcol"],
          "CHGRF", C.CHGRF,
          "CHBLK", C.CHBLK,
          C.CHMGD, // FERYRT's CATFRY=1 case
        ],
        "line-width": ["coalesce", ["get", "bwid"], 1],
        "line-dasharray": [3, 1], // both classes are DASH, no SOLD case
      },
    });
  }
}
