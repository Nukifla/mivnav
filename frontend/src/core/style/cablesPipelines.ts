// Submarine cables and pipelines — the *line* half of the IHO Cables-and-
// Pipelines group. Area half is in ./aidsHazards.ts. See
// docs/architecture/cables-pipelines.md for the chartcore contract.

import type { ExpressionSpecification as Expr } from "maplibre-gl";
import { line, PRIO, TEXT_FONT, type AddLayer } from "./expr";
import { noIcon } from "./aidsHazards";
import { haloPaint, paletteColors, s52ColourToHex, type S52Table } from "./colors";
import type { ChartSettings } from "./settings";

// `lsty` is fixed per class, never per-feature, so it's a plain constant
// here rather than a `["get","lsty"]` expression — `line-dasharray` isn't a
// data-drivable paint property anyway. See docs/architecture/cables-pipelines.md.
const LINE_CLASSES = ["CBLSUB", "CBLOHD", "PIPSOL", "PIPOHD"] as const;
const DASHARRAY: Record<(typeof LINE_CLASSES)[number], [number, number] | undefined> = {
  CBLSUB: [3, 1], // S57Object.cpp:389-393
  CBLOHD: [3, 1],
  PIPSOL: [3, 1],
  PIPOHD: undefined, // SOLD, matching aidsHazards.ts's `-edge-sold` layers
};

/** The CBLSUB `LC(CBLSUB06)` pattern asset — a submarine cable. */
export const CABLE_PATTERN_ASSET = "cable";

/** The vendored line-pattern asset name per class with an `LC(...)` row —
 * CBLOHD/PIPOHD never have one. */
const LINE_PATTERN_ASSET: Partial<Record<(typeof LINE_CLASSES)[number], string>> = {
  CBLSUB: CABLE_PATTERN_ASSET,
  PIPSOL: "pipeline",
};

/** `line-width` sets the pattern's BAND HEIGHT, not a pen width — NOT `bwid`
 * (see docs/architecture/cables-pipelines.md). 6 is quantenschaum's value. */
export const PATTERN_BAND_PX = 6;

/**
 * The `line-pattern` image id of a cable/pipeline `LC(...)` row in this
 * palette: `<asset>,<hex>` (loaded on demand through the same
 * `styleimagemissing` path as the ATON icons), CHGRD when `bcol` says so,
 * else CHMGD. Exported so an overlay drawing a cable (features/notices)
 * gets the chart's own pattern, palette included. `bcol` defaults to the
 * baked chart fact.
 */
export function linePatternImage(
  asset: string,
  C: S52Table,
  bcol: Expr = ["get", "bcol"],
): Expr {
  return [
    "case",
    ["==", bcol, "CHGRD"],
    `${asset},${s52ColourToHex(C.CHGRD)}`,
    `${asset},${s52ColourToHex(C.CHMGD)}`,
  ];
}

export function cablesPipelinesLineLayers(
  add: AddLayer,
  source: string,
  settings: ChartSettings,
): void {
  const C = paletteColors(settings.palette);
  const lineColor: Expr = ["match", ["get", "bcol"], "CHGRD", C.CHGRD, C.CHMGD];
  for (const cls of LINE_CLASSES) {
    const dasharray = DASHARRAY[cls];
    const patternAsset = LINE_PATTERN_ASSET[cls];
    if (patternAsset) {
      // `,<hex>` suffix matches the same `bcol` test `line-color` uses below,
      // so the pattern is never a colour the line wouldn't otherwise draw.
      const patternId = linePatternImage(patternAsset, C);
      add(PRIO.CABLE_PIPELINE_LINE, cls, {
        id: `${source}-${cls.toLowerCase()}-line-pattern`,
        type: "line",
        filter: ["all", line, ["has", "lc"]],
        paint: {
          // `line-color` still rides along: it paints nothing under an
          // opaque pattern, but is what shows before the lazily-loaded
          // pattern image arrives (or forever, if the fetch fails).
          "line-color": lineColor,
          "line-width": PATTERN_BAND_PX,
          "line-pattern": patternId,
        },
      });
      // No-op for PIPSOL (its `lc` is unconditional); kept for symmetry
      // rather than special-cased away. CBLSUB's CATCBL=6 power-line row
      // has no `lc` and falls through to this dash layer.
      add(PRIO.CABLE_PIPELINE_LINE, cls, {
        id: `${source}-${cls.toLowerCase()}-line-dash`,
        type: "line",
        filter: ["all", line, ["!", ["has", "lc"]]],
        paint: {
          "line-color": lineColor,
          "line-width": ["coalesce", ["get", "bwid"], 1],
          ...(dasharray ? { "line-dasharray": dasharray } : {}),
        },
      });
      continue;
    }
    add(PRIO.CABLE_PIPELINE_LINE, cls, {
      id: `${source}-${cls.toLowerCase()}-line`,
      type: "line",
      filter: line,
      paint: {
        "line-color": lineColor,
        "line-width": ["coalesce", ["get", "bwid"], 1],
        ...(dasharray ? { "line-dasharray": dasharray } : {}),
      },
    });
  }
}

export function cablesPipelinesSymbolLayers(
  add: AddLayer,
  source: string,
  settings: ChartSettings,
): void {
  const C = paletteColors(settings.palette);
  for (const cls of ["CBLOHD", "PIPOHD"] as const) {
    add(PRIO.SYM_CABLE_PIPELINE, cls, {
      id: `${source}-${cls.toLowerCase()}-sym`,
      type: "symbol",
      filter: ["all", line, ["has", "sym"]],
      layout: {
        "symbol-placement": "line-center",
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
    // clearance text alone, for a feature with no radar-conspicuous marker
    add(PRIO.SYM_CABLE_PIPELINE, cls, {
      id: `${source}-${cls.toLowerCase()}-txt`,
      type: "symbol",
      filter: ["all", line, ["!", ["has", "sym"]], ["has", "txt"]],
      layout: {
        "symbol-placement": "line-center",
        "text-field": ["get", "txt"],
        "text-size": 11,
        "text-font": TEXT_FONT,
        "text-optional": true,
      },
      paint: { "text-color": C.CHBLK, ...haloPaint(settings.palette) },
    });
  }
}
