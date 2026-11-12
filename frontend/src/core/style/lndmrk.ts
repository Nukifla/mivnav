// Two-slice port of `CS(LNDMRK01)` (see derive/lndmrk.rs's module doc for the
// RCID reasoning). Area/Line share one boundary colour pick, unlike
// aidsHazards.ts's MARCUL/FERYRT split; OBJNAM label only on Point/Area, never Line.

import type { ExpressionSpecification } from "maplibre-gl";
import { LAND_FEATURE_WASH_OPACITY, point, poly, PRIO, TEXT_FONT, type AddLayer } from "./expr";
import { noIcon } from "./aidsHazards";
import { haloPaint, paletteColors, themeFonts } from "./colors";
import type { ChartSettings } from "./settings";

const notPoint: ExpressionSpecification = ["!=", ["geometry-type"], "Point"];

export function lndmrkAreaLayers(add: AddLayer, source: string, settings: ChartSettings): void {
  const C = paletteColors(settings.palette);
  add(PRIO.LNDMRK_FILL, "LNDMRK", {
    id: `${source}-lndmrk-fill`,
    type: "fill",
    filter: poly,
    // A wash under `showOsmOnLand` (expr.ts's LAND_FEATURE_WASH_OPACITY,
    // lighter than LNDARE's): opaque, a cemetery or park-sized landmark
    // buries the basemap the setting exists to reveal.
    paint: { "fill-color": C.CHBRN, "fill-opacity": settings.showOsmOnLand ? LAND_FEATURE_WASH_OPACITY : 1 },
  });
  add(PRIO.LNDMRK_BOUNDARY, "LNDMRK", {
    id: `${source}-lndmrk-bdy`,
    type: "line",
    filter: notPoint,
    paint: {
      "line-color": ["match", ["get", "bcol"], "CHBLK", C.CHBLK, C.LANDF],
      "line-width": ["coalesce", ["get", "bwid"], 1],
    },
  });
}

export function lndmrkSymbolLayers(add: AddLayer, source: string, settings: ChartSettings): void {
  const C = paletteColors(settings.palette);
  add(PRIO.SYM_LNDMRK, "LNDMRK", {
    id: `${source}-lndmrk-sym`,
    type: "symbol",
    filter: ["all", point, ["has", "sym"]],
    layout: { "icon-image": ["get", "sym"], ...noIcon },
  });
  // Point row (has `sym`, hence the offset) and the Area row's synthetic
  // label point (no `sym`, offset unused) share this one layer.
  add(PRIO.SYM_LNDMRK, "LNDMRK", {
    id: `${source}-lndmrk-txt`,
    type: "symbol",
    filter: ["all", point, ["has", "txt"]],
    layout: {
      "text-field": ["get", "txt"],
      "text-size": 11,
      // Upright, deliberately, unlike SEAARE/ATON's italic: land features read
      // upright, water/hydrographic names italic (s57-style.json agrees).
      "text-font": themeFonts(settings.palette).upright ?? TEXT_FONT,
      "text-offset": [1, 0.6],
      "text-optional": true,
    },
    paint: { "text-color": C.CHBLK, ...haloPaint(settings.palette) },
  });
}
