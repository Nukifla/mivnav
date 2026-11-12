// BRIDGE — until now decoded (and consulted by the routing hazard engine
// for air-draft blocking) but never drawn: no style layer anywhere in this
// tree referenced the `BRIDGE` source-layer, so a charted bridge reached the
// tile and then drew nothing at all (reported: a real bridge at 57°00.0'N
// 009°17.6'E, present in the chart data and already known to routing,
// invisible on the map). chartcore/src/derive/bridges.rs now bakes the
// outline chart fact (`bcol`/`bwid`/`lsty`, Line/Area geometry only — S-52's
// own Point-type BRIDGE lookup is blank) and the clearance marker
// (`sym`/`txt`, any geometry — see that module's own doc for why a
// point-charted bridge still gets one). This file is the frontend half: the
// outline line and the clearance/name symbols, same split as
// cablesPipelines.ts's line/symbol builder pair.
//
// No `BRIDGE01` icon (no vendored artwork — chartcore/src/derive/bridges.rs's
// doc), so no fill either: chartsymbols.xml's own BRIDGE row has no `AC(...)`
// fill instruction, only `LS(SOLD,w,CHGRD)` — a real ENC doesn't wash the
// bridge area, just outlines it. Disp-prio "Hazards" in chartsymbols.xml
// matches OBSTRN/WRECKS, so this rides the same PRIO.HAZARD_LINE/SYM_HAZARD
// bands rather than a new one.
//
// The name label (OBJNAM/NOBJNM) needs no chartcore work: neither attribute
// is stripped for this class (`render_only_keep` has no BRIDGE entry), so it
// already rides the tile untouched — read straight off the feature here,
// same as SEAARE's own un-derived OBJNAM label (chartStyle.ts).

import { haloPaint, paletteColors, themeFonts } from "./colors";
import { line, poly, PRIO, TEXT_FONT, type AddLayer } from "./expr";
import { noIcon } from "./aidsHazards";
import type { ChartSettings } from "./settings";

export function bridgesLineLayers(add: AddLayer, source: string, settings: ChartSettings): void {
  const C = paletteColors(settings.palette);
  // One layer for both geometries: `bwid` already differs per feature (4 for
  // Area, 5 for Line — chartcore/src/derive/bridges.rs), so a `poly` filter
  // (MapLibre draws a Polygon's boundary for a `line`-type layer, same trick
  // RESTRICTED_BOUNDARY uses) unioned with `line` covers both LUP rows.
  add(PRIO.HAZARD_LINE, "BRIDGE", {
    id: `${source}-bridge-line`,
    type: "line",
    filter: ["any", line, poly],
    paint: {
      "line-color": C.CHGRD,
      "line-width": ["coalesce", ["get", "bwid"], 4],
    },
  });
}

export function bridgesSymbolLayers(add: AddLayer, source: string, settings: ChartSettings): void {
  const C = paletteColors(settings.palette);
  const halo = haloPaint(settings.palette);
  // Same font as the reference's own `label-bridge` (aidsHazards.ts's own
  // ATON-label comment already notes s57-style.json's italic layers are
  // label-sea/label-region/label-tunnel/label-bridge).
  const nameItalic = themeFonts(settings.palette).italic ?? TEXT_FONT;

  // Vertical clearance marker — vendored `clearance`/`clearance-safe` icons
  // (chartcore/assets/s52-icons/), reused rather than new artwork. Any
  // geometry: this is the ONLY thing a point-charted bridge draws, which is
  // exactly what makes it visible as a POI, matching the report.
  add(PRIO.SYM_HAZARD, "BRIDGE", {
    id: `${source}-bridge-clearance`,
    type: "symbol",
    filter: ["has", "sym"],
    layout: {
      "icon-image": ["get", "sym"],
      "text-field": ["coalesce", ["get", "txt"], ""],
      "text-size": 11,
      "text-font": TEXT_FONT,
      "text-offset": [1, 0.6],
      "text-optional": true,
      ...noIcon,
    },
    paint: { "text-color": C.CHBLK, ...halo },
  });

  // Name label — OBJNAM/NOBJNM ride the tile untouched (see this file's
  // header); NOBJNM (the national-language name) wins when both are
  // present, matching the reference's own `coalesce(NOBJNM, OBJNAM)`.
  add(PRIO.SYM_HAZARD, "BRIDGE", {
    id: `${source}-bridge-label`,
    type: "symbol",
    filter: ["any", ["has", "OBJNAM"], ["has", "NOBJNM"]],
    layout: {
      "text-field": ["coalesce", ["get", "NOBJNM"], ["get", "OBJNAM"], ""],
      "text-size": 12,
      "text-font": nameItalic,
      "text-offset": [1.2, -0.6],
      "text-optional": true,
      ...noIcon,
    },
    paint: { "text-color": C.CHBLK, ...halo },
  });
}
