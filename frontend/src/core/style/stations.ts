// Pilot, signal, rescue and radio-station point facilities — PILBOP,
// RSCSTA, SISTAT, SISTAW, RDOCAL, RDOSTA. None calls a CS procedure.
// See docs/architecture/stations-layer.md for per-class reasoning and the
// RDOCAL VHF-circle pivot math / double-label bug history.

import type { ExpressionSpecification } from "maplibre-gl";
import { line, point, PRIO, TEXT_FONT, type AddLayer } from "./expr";
import { noIcon } from "./aidsHazards";
import { haloPaint, paletteColors } from "./colors";
import type { ChartSettings } from "./settings";

/** Point-only classes with a constant symbol and no text. RDOSTA is
 * deliberately not here — see docs/architecture/stations-layer.md — because
 * its DGPS variant needs a text label to stay distinguishable. */
const SIMPLE_POINT_CLASSES = ["RSCSTA", "SISTAT", "SISTAW"] as const;

// RDOCAL VHF channel: no icon offset needed, symbol pivot (8,20) is the
// circle centre. See docs/architecture/stations-layer.md for the math.

/** `s57-style.json`'s own text size, kept verbatim — fits with room to
 * spare inside the circle at up to {@link CHANNEL_MAX_CHARS} glyphs. */
const CHANNEL_TEXT_SIZE = 13;

/** Longest COMCHA that still fits inside the ring (see
 * {@link CHANNEL_TEXT_SIZE}); longer values draw no number, but remain
 * visible on the info panel (`core/info/s57.ts`). */
const CHANNEL_MAX_CHARS = 3;

/**
 * The channel string to draw. Bracket-stripping is `s57-style.json`'s own
 * hedge for a COMCHA that arrives as a list (`"[16]"`); see
 * docs/architecture/stations-layer.md for the double-label bug this guards.
 */
const channelText: ExpressionSpecification = [
  "let",
  "ch",
  [
    "case",
    ["in", "[", ["to-string", ["get", "COMCHA"]]],
    ["slice", ["to-string", ["get", "COMCHA"]], 1, -1],
    ["to-string", ["get", "COMCHA"]],
  ],
  ["case", ["<=", ["length", ["var", "ch"]], CHANNEL_MAX_CHARS], ["var", "ch"], ""],
];

export function stationsLineLayers(add: AddLayer, source: string, settings: ChartSettings): void {
  const C = paletteColors(settings.palette);
  // LS(DASH,1,TRFCD) never varies by attribute, so bcol/lsty come straight
  // off the palette, same as tss.rs's TSSBND.
  add(PRIO.STATION_LINE, "RDOCAL", {
    id: `${source}-rdocal-line`,
    type: "line",
    filter: line,
    paint: {
      "line-color": C.TRFCD,
      "line-width": ["coalesce", ["get", "bwid"], 1],
      "line-dasharray": [3, 1], // LS(DASH,w,·) = 3w/w, S57Object.cpp:389-393
    },
  });
}

export function stationsSymbolLayers(
  add: AddLayer,
  source: string,
  settings: ChartSettings,
): void {
  const C = paletteColors(settings.palette);

  for (const cls of SIMPLE_POINT_CLASSES) {
    add(PRIO.SYM_STATIONS, cls, {
      id: `${source}-${cls.toLowerCase()}-sym`,
      type: "symbol",
      filter: ["all", point, ["has", "sym"]],
      layout: { "icon-image": ["get", "sym"], ...noIcon },
    });
  }

  // RDOSTA: `radio-mast` always, plus the `DGPS` label chartcore bakes into
  // `txt` for CATROS=10.
  add(PRIO.SYM_STATIONS, "RDOSTA", {
    id: `${source}-rdosta-sym`,
    type: "symbol",
    filter: ["all", point, ["has", "sym"]],
    layout: {
      "icon-image": ["get", "sym"],
      "text-field": ["coalesce", ["get", "txt"], ""],
      "text-size": 11,
      "text-font": TEXT_FONT,
      "text-offset": [1, 0.6],
      "text-optional": true,
      ...noIcon,
    },
    paint: { "text-color": C.CHBLK, ...haloPaint(settings.palette) },
  });

  // PILBOP: the symbol alone. The S-52 row's `TE('Plt %s','OBJNAM',…)` label
  // is deliberately not drawn (jt qqmoqkul), so chartcore bakes no `txt` for
  // this class and there is nothing here for a text-field to coalesce.
  add(PRIO.SYM_STATIONS, "PILBOP", {
    id: `${source}-pilbop-pt-sym`,
    type: "symbol",
    filter: ["all", point, ["has", "sym"]],
    layout: { "icon-image": ["get", "sym"], ...noIcon },
  });

  add(PRIO.SYM_STATIONS, "RDOCAL", {
    id: `${source}-rdocal-pt-sym`,
    type: "symbol",
    filter: ["all", point, ["has", "sym"]],
    layout: {
      "icon-image": ["get", "sym"],
      "icon-rotate": ["coalesce", ["get", "ORIENT"], 0],
      "icon-rotation-alignment": "map",
      "text-field": ["coalesce", ["get", "txt"], ""],
      "text-size": 11,
      "text-font": TEXT_FONT,
      "text-offset": [1, 0.6],
      "text-optional": true,
      ...noIcon,
    },
    paint: { "text-color": C.CHBLK, ...haloPaint(settings.palette) },
  });
  // Second layer, emitted after so it draws over the OBJNAM label; `VHF` is
  // the only branch with a circle to put a number in.
  add(PRIO.SYM_STATIONS, "RDOCAL", {
    id: `${source}-rdocal-pt-channel`,
    type: "symbol",
    filter: ["all", point, ["==", ["get", "sym"], "VHF"]],
    layout: {
      "text-field": channelText,
      "text-size": CHANNEL_TEXT_SIZE,
      "text-font": TEXT_FONT,
      // Must never be dropped for colliding with its own icon; `s57-style.json`'s flags.
      "text-allow-overlap": true,
      "text-ignore-placement": false,
    },
    paint: { "text-color": C.CHMGD }, // matches the open magenta ring it sits in
  });
  // Same icon+txt facts as the Point layer, placed at the line midpoint —
  // cablesPipelines.ts's `symbol-placement: "line-center"` technique.
  add(PRIO.SYM_STATIONS, "RDOCAL", {
    id: `${source}-rdocal-line-sym`,
    type: "symbol",
    filter: ["all", line, ["has", "sym"]],
    layout: {
      "symbol-placement": "line-center",
      "icon-image": ["get", "sym"],
      "icon-rotate": ["coalesce", ["get", "ORIENT"], 0],
      "icon-rotation-alignment": "map",
      "text-field": ["coalesce", ["get", "txt"], ""],
      "text-size": 11,
      "text-font": TEXT_FONT,
      "text-offset": [1, 0.6],
      "text-optional": true,
      ...noIcon,
    },
    paint: { "text-color": C.CHBLK, ...haloPaint(settings.palette) },
  });
  // `text-rotation-alignment` must be explicit `"viewport"`: on a Line
  // placement `"auto"` resolves to `"map"`, flipping the digits upside-down.
  add(PRIO.SYM_STATIONS, "RDOCAL", {
    id: `${source}-rdocal-line-channel`,
    type: "symbol",
    filter: ["all", line, ["==", ["get", "sym"], "VHF"]],
    layout: {
      "symbol-placement": "line-center",
      "text-field": channelText,
      "text-size": CHANNEL_TEXT_SIZE,
      "text-font": TEXT_FONT,
      "text-rotation-alignment": "viewport",
      "text-allow-overlap": true,
      "text-ignore-placement": false,
    },
    paint: { "text-color": C.CHMGD },
  });
}
