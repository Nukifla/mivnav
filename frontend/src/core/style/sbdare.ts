// SBDARE reads `txt` alone, NOT an OBJNAM-first coalesce: that would
// silently hide the letters on the one case most worth showing them on
// (convention from derive/lndmrk.rs's module doc).

import { line, point, poly, PRIO, TEXT_FONT, type AddLayer } from "./expr";
import { paletteColors, themeFonts } from "./colors";
import type { ChartSettings } from "./settings";

export function sbdareLineLayers(add: AddLayer, source: string, settings: ChartSettings): void {
  const C = paletteColors(settings.palette);
  add(PRIO.SBDARE_LINE, "SBDARE", {
    id: `${source}-sbdare-area-bdy`,
    type: "line",
    filter: poly,
    paint: {
      "line-color": C.CHGRD,
      "line-width": 1,
      "line-dasharray": [3, 1],
    },
  });
  // No dasharray, matching aidsHazards.ts's `-edge-sold` layers.
  add(PRIO.SBDARE_LINE, "SBDARE", {
    id: `${source}-sbdare-line-bdy`,
    type: "line",
    filter: line,
    paint: {
      "line-color": C.CHGRD,
      "line-width": 1,
    },
  });
}

export function sbdareSymbolLayers(add: AddLayer, source: string, settings: ChartSettings): void {
  const C = paletteColors(settings.palette);
  // Italic like seaare.ts, but no halo like plain shorthand (soundings) —
  // deliberate straddle between the two groups, user's call (2026-07-29).
  const face = themeFonts(settings.palette).italic ?? TEXT_FONT;
  add(PRIO.SYM_SBDARE, "SBDARE", {
    id: `${source}-sbdare-pt-txt`,
    type: "symbol",
    filter: ["all", point, ["has", "txt"]],
    layout: {
      "text-field": ["get", "txt"],
      "text-size": 11,
      "text-font": face,
      "text-optional": true,
    },
    // No halo: chart shorthand draws unglowed (haloPaint's docstring).
    paint: { "text-color": C.CHBLK },
  });
  // Line-center placement, same technique as cablesPipelines.ts's txt-only layer.
  add(PRIO.SYM_SBDARE, "SBDARE", {
    id: `${source}-sbdare-line-txt`,
    type: "symbol",
    filter: ["all", line, ["has", "txt"]],
    layout: {
      "symbol-placement": "line-center",
      "text-field": ["get", "txt"],
      "text-size": 11,
      "text-font": face,
      "text-optional": true,
    },
    // No halo: chart shorthand draws unglowed (haloPaint's docstring).
    paint: { "text-color": C.CHBLK },
  });
}
