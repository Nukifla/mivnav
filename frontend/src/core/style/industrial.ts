// `sym`/`bcol`/`bwid` come from chartcore's derive::industrial; PRDARE's `sym`
// also rides a synthetic Point MVT feature (wants_label_point, mvt/mod.rs).
// see docs/architecture/industrial-derive.md

import { LAND_FEATURE_WASH_OPACITY, point, poly, PRIO, type AddLayer } from "./expr";
import { noIcon } from "./aidsHazards";
import { paletteColors } from "./colors";
import type { ChartSettings } from "./settings";

const CLASSES = ["SILTNK", "PRDARE"] as const;
const DASHARRAY: Record<(typeof CLASSES)[number], [number, number] | undefined> = {
  SILTNK: undefined, // LS(SOLD,...), S57Object.cpp:389-393
  PRDARE: [3, 1], // LS(DASH,...), S57Object.cpp:389-393
};

export function industrialAreaLayers(
  add: AddLayer,
  source: string,
  settings: ChartSettings,
): void {
  const C = paletteColors(settings.palette);
  for (const cls of CLASSES) {
    add(PRIO.INDUSTRIAL_FILL, cls, {
      id: `${source}-${cls.toLowerCase()}-fill`,
      type: "fill",
      filter: poly,
      // Washed under `showOsmOnLand`, same as LNDMRK (LAND_FEATURE_WASH_OPACITY).
      paint: { "fill-color": C.CHBRN, "fill-opacity": settings.showOsmOnLand ? LAND_FEATURE_WASH_OPACITY : 1 },
    });
    add(PRIO.INDUSTRIAL_BOUNDARY, cls, {
      id: `${source}-${cls.toLowerCase()}-bdy`,
      type: "line",
      filter: poly,
      paint: {
        "line-color": ["match", ["get", "bcol"], "CHBLK", C.CHBLK, C.LANDF],
        "line-width": ["coalesce", ["get", "bwid"], 1],
        ...(DASHARRAY[cls] ? { "line-dasharray": DASHARRAY[cls] } : {}),
      },
    });
  }
}

/** `settings` is unused now that symbol ids are palette-neutral (there is no
 * per-palette sprite prefix left to apply), but stays in the signature so this
 * matches every other `…SymbolLayers` in `chartStyle.ts`'s one call block. */
export function industrialSymbolLayers(
  add: AddLayer,
  source: string,
  settings: ChartSettings,
): void {
  void settings;
  for (const cls of CLASSES) {
    add(PRIO.SYM_INDUSTRIAL, cls, {
      id: `${source}-${cls.toLowerCase()}-sym`,
      type: "symbol",
      filter: ["all", point, ["has", "sym"]],
      layout: { "icon-image": ["get", "sym"], ...noIcon },
    });
  }
}
