// TSEZNE/TSSBND/TSSLPT: the "traffic routes" IHO classes that don't fit
// aidsHazards.ts's restricted-group loops, so they get their own layers here.
// See docs/architecture/traffic-routes-style.md.

import { noIcon } from "./aidsHazards";
import { haloPaint, paletteColors, s52ColourToHex } from "./colors";
import { line, point, poly, PRIO, TEXT_FONT, type AddLayer } from "./expr";
import type { ChartSettings } from "./settings";

/** The vendored TSS-arrow icon's literal name — the one `sym` value here
 * needing a per-palette colour override (see docs/architecture/traffic-routes-style.md). */
const TSS_ARROW_SYM = "TSS-arrow";

export function trafficRoutesAreaLayers(
  add: AddLayer,
  source: string,
  settings: ChartSettings,
): void {
  const C = paletteColors(settings.palette);
  add(PRIO.TSS_FILL, "TSEZNE", {
    id: `${source}-tsezne-fill`,
    type: "fill",
    filter: poly,
    paint: { "fill-color": C.TRFCF },
  });
}

export function trafficRoutesLineLayers(
  add: AddLayer,
  source: string,
  settings: ChartSettings,
): void {
  const C = paletteColors(settings.palette);
  add(PRIO.TSS_LINE, "TSSBND", {
    id: `${source}-tssbnd-line`,
    type: "line",
    filter: line,
    paint: {
      // bcol is always "TRFCD" (chartcore bakes one constant fact, no branching).
      "line-color": C.TRFCD,
      "line-width": ["coalesce", ["get", "bwid"], 2],
      "line-dasharray": [3, 1], // LS(DASH,w,·) = 3w/w, S57Object.cpp:389-393
    },
  });
}

export function trafficRoutesSymbolLayers(
  add: AddLayer,
  source: string,
  settings: ChartSettings,
): void {
  const C = paletteColors(settings.palette);
  // Per-palette CHMGD override for TSS-arrow.svg's fixed vendored colour;
  // wins over role substitution. See docs/architecture/traffic-routes-style.md.
  const tssArrowKey = `${TSS_ARROW_SYM},${s52ColourToHex(C.CHMGD)}`;
  add(PRIO.SYM_RESTRICTED, "TSSLPT", {
    id: `${source}-tsslpt-sym`,
    type: "symbol",
    filter: ["all", point, ["has", "sym"]],
    layout: {
      "icon-image": [
        "case",
        ["==", ["get", "sym"], TSS_ARROW_SYM],
        tssArrowKey,
        ["get", "sym"],
      ],
      // Only the ORIENT branch (sym=TSS-arrow, the vendored icon) wants a
      // rotation; the no-ORIENT fallback (sym=caution) reads ORIENT as
      // absent and coalesces to 0, a no-op rotate on a symmetric icon.
      "icon-rotate": ["coalesce", ["get", "ORIENT"], 0],
      "icon-rotation-alignment": "map",
      // INFORM caption, no-ORIENT branch only (chartcore only bakes `txt`
      // there — module doc, derive/restricted.rs).
      "text-field": ["coalesce", ["get", "txt"], ""],
      "text-size": 11,
      "text-font": TEXT_FONT,
      "text-offset": [1, 0.6],
      "text-optional": true,
      ...noIcon,
    },
    paint: { "text-color": C.CHBLK, ...haloPaint(settings.palette) },
  });
  // stacked RESTRN01 symbol, offset like the restricted-group loop's own
  // `-sym-cs` layer (aidsHazards.ts)
  add(PRIO.SYM_RESTRICTED, "TSSLPT", {
    id: `${source}-tsslpt-sym-cs`,
    type: "symbol",
    filter: ["all", point, ["has", "sym_cs"]],
    layout: { "icon-image": ["get", "sym_cs"], "icon-offset": [16, 0], ...noIcon },
  });
}
