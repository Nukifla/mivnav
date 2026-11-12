// Phase 5 layers: ATON, non-sectored lights, wrecks/obstructions/underwater
// rocks, and the restricted/cautionary area group (specs-12.md §3). See
// docs/architecture/aids-hazards-style.md for class-membership reasoning.
//
// Two builders because draw order interleaves with the Phase 3 stack:
// areaLayers goes in the DPRI-4 fill/boundary/line bands, symbolLayers sits
// on top; both name their bands via `PRIO` (./expr.ts), not splice order.

import { createPropertyExpression } from "@maplibre/maplibre-gl-style-spec";
import type { ExpressionSpecification as Expr } from "maplibre-gl";
import { haloPaint, paletteColors, themeFonts, type S52Table } from "./colors";
import { line, point, poly, PRIO, soundingText, TEXT_FONT, type AddLayer } from "./expr";
import { isolatedDangerExpr } from "./isolatedDanger";
import { SECTOR_GATE_SOURCE_LAYER, SECTOR_GATE_SUFFIX } from "./sectorGate";
import type { ChartSettings } from "./settings";

export const noIcon = { "icon-allow-overlap": true, "icon-ignore-placement": true } as const;

/** Restricted-group classes whose LUP writes `SY(<sym>,ORIENT)`. FAIRWY is the
 * only one (jt mnvsttro fixed a dropped bearing); see
 * docs/architecture/aids-hazards-style.md for the rotation derivation. */
const ORIENTED_SYM: ReadonlySet<string> = new Set(["FAIRWY"]);

/** ORIENT as a map-aligned `icon-rotate` (true bearing, must follow the map).
 * `coalesce` because a fairway with no ORIENT gets no `sym` baked at all, but
 * the expression still has to evaluate. */
const ORIENT_ROTATE = {
  "icon-rotate": ["coalesce", ["get", "ORIENT"], 0] as Expr,
  "icon-rotation-alignment": "map",
} as const;

/**
 * `icon-rotate` for the light flare/QUESMRK1 icon, ported from s57-style.json
 * with its `xSECTR1` typo fixed (user decision 2026-07-28; vendored file left
 * untouched). See docs/architecture/aids-hazards-style.md for the full trail.
 */
export const LIGHT_ICON_ROTATE: Expr = [
  "case",
  ["has", "ORIENT"],
  ["get", "ORIENT"],
  ["all", ["has", "SECTR1"], ["has", "SECTR2"]],
  [
    "let",
    "angle",
    [
      "case",
      [">=", ["get", "SECTR2"], ["get", "SECTR1"]],
      ["-", ["get", "SECTR2"], ["get", "SECTR1"]],
      ["+", ["-", ["get", "SECTR2"], ["get", "SECTR1"]], 360],
    ],
    ["+", ["get", "SECTR1"], ["/", ["var", "angle"], 2]],
  ],
  [
    "case",
    ["==", 3, ["get", "COLOUR"]],
    60,
    ["==", "3", ["get", "COLOUR"]],
    60,
    ["==", 4, ["get", "COLOUR"]],
    30,
    ["==", "4", ["get", "COLOUR"]],
    30,
    45,
  ],
];

const LIGHT_ROTATE_PROP_SPEC = {
  type: "number",
  "property-type": "data-driven",
  expression: { interpolated: false, parameters: ["zoom", "feature"] },
} as const;

const compiledLightIconRotate = (() => {
  const r = createPropertyExpression(LIGHT_ICON_ROTATE as never, LIGHT_ROTATE_PROP_SPEC as never);
  if (r.result === "error") throw new Error(r.value.map((e) => e.message).join("; "));
  return r.value;
})();

/** `LIGHT_ICON_ROTATE` evaluated directly so the info-panel light icon
 * (`../info/ChartSpriteIcon.tsx`) rotates off the SAME expression the map
 * uses, never a hand-written copy that could drift. `zoom` is a dummy. */
export function lightFlareRotationDeg(props: Record<string, unknown>): number {
  return compiledLightIconRotate.evaluate({ zoom: 12 } as never, {
    properties: props,
  } as never) as unknown as number;
}

// Symbol names are palette-neutral: chartcore serves one SVG per symbol, the
// client substitutes theme hexes before rasterising (../style/atonIcons.ts)
// — see docs/architecture/aids-hazards-style.md for why that IS the night fix.

// The isolated-danger predicate lives once in ./isolatedDanger.ts, shared
// with the info panel (../info/chartProvider.ts) so the two never disagree.
// WRECKS' variant adds the QUASOU=7 gate (S52CondRules.cpp:591).
function isDanger(safety: number): Expr {
  return isolatedDangerExpr("OBSTRN", safety);
}

function wreckDanger(safety: number): Expr {
  return isolatedDangerExpr("WRECKS", safety);
}

/** LS(DASH,w,·) = 3w/w, S57Object.cpp:389-393. */
export const RESTRICTED_BOUNDARY_DASH: [number, number] = [3, 1];

/**
 * The restricted/cautionary area boundary (RESARE, CTNARE, MIPARE, …): the
 * LUP's `LC`/`LS` degraded to a `bcol`/`bwid` dash. Exported so an overlay
 * portraying a comparable area (features/notices — a firing area IS a
 * MIPARE) draws EXACTLY the chart's line, palette tokens included. `bcol`
 * defaults to the baked chart fact; a caller with no baked `bcol` passes an
 * expression yielding the S-52 colour token its class would bake.
 */
export function restrictedBoundaryPaint(
  C: S52Table,
  bcol: Expr = ["get", "bcol"],
  bwid: Expr = ["coalesce", ["get", "bwid"], 2],
) {
  return {
    "line-color": [
      "match", bcol,
      "CHMGF", C.CHMGF,
      "TRFCD", C.TRFCD,
      // CHGRD/CHBLK were missing until this slice — PIPARE's grey pick
      // silently fell through to CHMGD, unnoticed for lack of test
      // coverage on a benign PIPARE feature.
      "CHGRD", C.CHGRD,
      "CHBLK", C.CHBLK,
      // TRFCF: PILBOP's Plain-row dash colour (`LS(DASH,2,TRFCF)`), a
      // distinct token from TRFCD — generated as TSEZNE's AREA FILL
      // colour, reused as a LINE colour because PILBOP's LUP says so.
      "TRFCF", C.TRFCF,
      C.CHMGD,
    ] as Expr,
    "line-width": bwid,
    "line-dasharray": RESTRICTED_BOUNDARY_DASH,
  };
}

export function aidsHazardsAreaLayers(
  add: AddLayer,
  source: string,
  settings: ChartSettings,
): void {
  const C = paletteColors(settings.palette);
  const safety = settings.safetyContour;

  // Hazard area fills: chart-fact fill token, danger forces DEPVS.
  for (const [cls, id, danger] of [
    ["OBSTRN", "obstrn", isDanger(safety)],
    ["WRECKS", "wrecks", wreckDanger(safety)],
  ] as const) {
    add(PRIO.HAZARD_FILL, cls, {
      id: `${source}-${id}-fill`,
      type: "fill",
      filter: poly,
      paint: {
        "fill-color": [
          "case",
          danger, C.DEPVS,
          ["match", ["get", "fill"], "chbrn", C.CHBRN, "depit", C.DEPIT, C.DEPVS],
        ],
        "fill-opacity": ["case", ["any", danger, ["has", "fill"]], 1, 0],
      },
    }, danger);
  }

  // Restricted-group boundaries: LC/LS degraded to a bcol/bwid dash.
  // TSSCRS/TSSRON/TSSLPT are deliberately excluded (no LC/LS in their LUP).
  // `filter: poly` (not `!= Point`) matters: MARCUL/FERYRT also have a real
  // Line row (./waterways.ts) that a looser filter would double-draw here.
  for (const cls of [
    "RESARE", "ACHARE", "CTNARE", "MIPARE", "DMPGRD", "CBLARE", "PIPARE", "ISTZNE", "PRCARE",
    "FAIRWY", "MARCUL", "CTSARE", "FERYRT", "PILBOP",
  ] as const) {
    add(PRIO.RESTRICTED_BOUNDARY, cls, {
      id: `${source}-${cls.toLowerCase()}-bdy`,
      type: "line",
      filter: poly,
      paint: restrictedBoundaryPaint(C),
    });
  }

  // OBSTRN line hazards: dott/dash pair cross-faded by opacity so the
  // safety-contour change stays paint-only (danger forces dott).
  const obsDanger = isDanger(safety);
  const obsLineDott: Expr = ["any", obsDanger, ["==", ["get", "lsty"], "dott"]];
  add(PRIO.HAZARD_LINE, "OBSTRN", {
    id: `${source}-obstrn-line-dott`,
    type: "line",
    filter: line,
    paint: {
      "line-color": C.CHBLK,
      "line-width": 2,
      "line-dasharray": [1, 2], // DOTT, S57Object.cpp:394-400
      "line-opacity": ["case", obsLineDott, 1, 0],
    },
  }, obsDanger);
  add(PRIO.HAZARD_LINE, "OBSTRN", {
    id: `${source}-obstrn-line-dash`,
    type: "line",
    filter: line,
    paint: {
      "line-color": C.CHBLK,
      "line-width": 2,
      "line-dasharray": [3, 1],
      "line-opacity": ["case", obsLineDott, 0, 1],
    },
  }, obsDanger);

  // Hazard area boundaries: dott/dash/sold triple per class, danger forces
  // dotted CHBLK (official ISODGR treatment suppresses the styled edge).
  for (const [cls, id, danger] of [
    ["OBSTRN", "obstrn", obsDanger],
    ["WRECKS", "wrecks", wreckDanger(safety)],
  ] as const) {
    const is = (style: string): Expr => ["==", ["get", "lsty"], style];
    add(PRIO.HAZARD_LINE, cls, {
      id: `${source}-${id}-edge-dott`,
      type: "line",
      filter: poly,
      paint: {
        "line-color": ["case", danger, C.CHBLK, cls === "WRECKS" ? C.CSTLN : C.CHBLK],
        "line-width": 2,
        "line-dasharray": [1, 2],
        "line-opacity": ["case", ["any", danger, is("dott")], 1, 0],
      },
    }, danger);
    add(PRIO.HAZARD_LINE, cls, {
      id: `${source}-${id}-edge-dash`,
      type: "line",
      filter: poly,
      paint: {
        "line-color": C.CSTLN,
        "line-width": 2,
        "line-dasharray": [3, 1],
        "line-opacity": ["case", ["all", ["!", danger], is("dash")], 1, 0],
      },
    }, danger);
    add(PRIO.HAZARD_LINE, cls, {
      id: `${source}-${id}-edge-sold`,
      type: "line",
      filter: poly,
      paint: {
        "line-color": C.CSTLN,
        "line-width": 2,
        "line-opacity": ["case", ["all", ["!", danger], is("sold")], 1, 0],
      },
    }, danger);
  }
}

export function aidsHazardsSymbolLayers(
  add: AddLayer,
  source: string,
  settings: ChartSettings,
): void {
  const C = paletteColors(settings.palette);
  const safety = settings.safetyContour;
  const obsDanger = isDanger(safety);
  const wrkDanger = wreckDanger(safety);
  // ATON OBJNAM label italic (user: "named waters, names of beacons"), a
  // KNOWING DIVERGENCE from s57-style.json (whose label-buoy/beacon layers
  // are plain Noto Sans) — that file has no theme-font concept to follow.
  const nameItalic = themeFonts(settings.palette).italic ?? TEXT_FONT;
  const halo = haloPaint(settings.palette);

  // Restricted-group centred symbols (genuine points + §1.5 label points).
  // TSSLPT rides its own layer below (needs a conditional icon-rotate wrong
  // for every other class here). MARCUL/PILBOP's `-sym`/`-sym-cs` simply
  // never match (their `sym`/`sym_cs` are always absent); harmless no-ops.
  for (const cls of [
    "RESARE", "ACHARE", "CTNARE", "MIPARE", "DMPGRD", "CBLARE", "PIPARE",
    "TSSCRS", "TSSRON", "ISTZNE", "PRCARE",
    "FAIRWY", "MARCUL", "CTSARE", "FERYRT", "PILBOP",
  ] as const) {
    add(PRIO.SYM_RESTRICTED, cls, {
      id: `${source}-${cls.toLowerCase()}-sym`,
      type: "symbol",
      filter: ["all", point, ["has", "sym"]],
      layout: {
        "icon-image": ["get", "sym"],
        ...(ORIENTED_SYM.has(cls) ? ORIENT_ROTATE : {}),
        ...noIcon,
      },
    });
    add(PRIO.SYM_RESTRICTED, cls, {
      id: `${source}-${cls.toLowerCase()}-sym-cs`,
      type: "symbol",
      filter: ["all", point, ["has", "sym_cs"]],
      // A NUDGE, not a separation — the class symbol and stacked RESTRN01
      // symbol are meant to overlap. See docs/architecture/aids-hazards-style.md
      // for the 16->8 halving and the rejected per-class-offset alternative.
      layout: { "icon-image": ["get", "sym_cs"], "icon-offset": [8, 0], ...noIcon },
    });
  }

  // OBSTRN and UWTROC share the layer shape.
  for (const cls of ["OBSTRN", "UWTROC"] as const) {
    const id = cls.toLowerCase();
    add(PRIO.SYM_HAZARD, cls, {
      id: `${source}-${id}-sym`,
      type: "symbol",
      filter: point,
      layout: {
        // Danger promotion replaces the chart-fact symbol (official S-52;
        // the reference's ISODGR51 is dead code — divergence D2). `has`
        // guard, not coalesce: concat over a missing attribute would error.
        "icon-image": [
          "case",
          obsDanger, "ISODGR51",
          ["has", "sym"], ["get", "sym"],
          "",
        ],
        ...noIcon,
      },
    }, obsDanger);
  }

  // WRECKS points: danger, then baked symbol, then depth-based DANGER51/52,
  // keyed on `sym`'s absence not `VALSOU`'s presence — keying on VALSOU left
  // one combination invisible (docs/architecture/aids-hazards-style.md).
  add(PRIO.SYM_HAZARD, "WRECKS", {
    id: `${source}-wrecks-sym`,
    type: "symbol",
    filter: point,
    layout: {
      "icon-image": [
        "case",
        wrkDanger, "ISODGR51",
        // QUASOU=7 ("depth unknown") wears the full dangerous-wreck symbol.
        // Replaces the old detached WRECKS07 raster overbar (user decision
        // lppokvtq) — see docs/architecture/aids-hazards-style.md.
        ["to-boolean", ["get", "quasou7"]], "wreck-dangerous",
        ["has", "sym"], ["get", "sym"],
        ["<", ["get", "depth_value"], safety],
        "DANGER51",
        "DANGER52",
      ],
      // TX('Wk',…) group 21, S52CondRules.cpp:616 — plain sans (chart
      // shorthand, not a proper name), sized to match the reference's tiny
      // adjunct rather than MapLibre's 16px default.
      "text-field": [
        "case",
        ["all", ["!", ["has", "sym"]], ["!", wrkDanger]],
        "Wk",
        "",
      ],
      "text-font": TEXT_FONT,
      "text-size": 10,
      "text-offset": [1.2, 0.6],
      "text-optional": true,
      ...noIcon,
    },
    // No halo: chart shorthand draws unglowed (haloPaint's docstring).
    paint: { "text-color": C.CHBLK },
  }, wrkDanger);

  // CSQUAPNT01 positional-accuracy markers.
  for (const [cls, danger] of [
    ["OBSTRN", obsDanger],
    ["UWTROC", obsDanger],
    ["WRECKS", wrkDanger],
  ] as const) {
    add(PRIO.SYM_HAZARD, cls, {
      id: `${source}-${cls.toLowerCase()}-sym-pos`,
      type: "symbol",
      filter: ["has", "sym_pos"],
      layout: { "icon-image": ["get", "sym_pos"], ...noIcon },
    }, danger);
  }

  // Hazard VALSOU soundings; colour vs safetyDepth like SOUNDG (S3),
  // suppressed under danger.
  for (const [cls, danger] of [
    ["OBSTRN", obsDanger],
    ["UWTROC", obsDanger],
    ["WRECKS", wrkDanger],
  ] as const) {
    add(PRIO.SYM_HAZARD, cls, {
      id: `${source}-${cls.toLowerCase()}-snd`,
      type: "symbol",
      filter: ["==", ["get", "snd"], true],
      layout: {
        "text-field": soundingText(["get", "VALSOU"]),
        "text-size": 12,
        "text-font": TEXT_FONT,
        "text-allow-overlap": true,
        "text-ignore-placement": true,
        "text-padding": 0,
        // Visibility rides the "soundings" ENC layer group (groupForLayer).
      },
      paint: {
        "text-color": [
          "case",
          [">=", ["get", "VALSOU"], settings.safetyDepth],
          C.SNDG1,
          C.SNDG2,
        ],
        "text-opacity": ["case", danger, 0, 1],
        // No halo: chart shorthand draws unglowed (haloPaint's docstring).
      },
    }, danger);
  }

  // ATON: topmarks under daymarks under buoys/beacons (DPRI 4 < 7 < 8). The
  // `sym_p`/`lbl_p` Paper twins are gone (qpznkrtr — vendored s57.json has no
  // Paper/Simplified split, so they could never differ from these).
  const sym = "sym_s";
  const lbl = "lbl_s";
  // User-facing scale on top of atonIcons.ts's baked ATON_ICON_SCALE — kept
  // on the layer so a slider drag is a style diff, not an icon-atlas
  // re-decode. Not applied to hazard/restricted symbols or light annotations.
  const iconSize = settings.atonIconScale;
  for (const [prio, layer, id, withText] of [
    [PRIO.SYM_TOPMAR, "TOPMAR", "topmar", false],
    [PRIO.SYM_DAYMAR, "DAYMAR", "daymar", false],
    [PRIO.SYM_ATON, "ATON", "aton", true],
    // chartcore::mvt::layer_name only folds BOY*/BCN* into shared "ATON";
    // these four keep their own acronym as source-layer and need their own
    // `add` calls (yxrmtltk: LITVES/LITFLT never rendered without this).
    [PRIO.SYM_ATON, "LITVES", "litves", true],
    [PRIO.SYM_ATON, "LITFLT", "litflt", true],
    [PRIO.SYM_ATON, "MORFAC", "morfac", true],
    [PRIO.SYM_ATON, "M_NSYS", "m_nsys", true],
  ] as const) {
    add(prio, layer, {
      id: `${source}-${id}`,
      type: "symbol",
      // TOPMAR simplified: sym_s absent -> hidden (faithful to the reference,
      // which draws no topmarks in simplified mode).
      filter: ["has", sym],
      layout: {
        "icon-image": ["get", sym],
        "icon-size": iconSize,
        "icon-rotate": ["coalesce", ["get", "ORIENT"], 0],
        "icon-rotation-alignment": "map",
        ...noIcon,
        ...(withText
          ? {
              "text-field":
                settings.showText && settings.showAtonText
                  ? ["coalesce", ["get", lbl], ""]
                  : "",
              // TE(…,2,1,2,…,-1,-1,…): right-justified, bottom, offset
              // (-1,-1) chars (S52TextParser.cpp:99-122)
              "text-anchor": "bottom-right" as const,
              "text-offset": [-0.7, -0.5],
              "text-size": 15,
              "text-font": nameItalic,
              "text-optional": true,
            }
          : {}),
      },
      paint: { "text-color": C.CHBLK, ...halo },
    });
  }

  // LIGHTS (topmost; visibility overrides display category).
  const litVis = settings.showLights ? "visible" : ("none" as const);

  // Gate for the custom overlay layer (SectorLightLayer, ./sectorGate.ts):
  // queries every light so one with no adjunct symbol is still tappable.
  // Invisible by opacity, not `visibility: none` — the latter would make
  // queryRenderedFeatures skip it (MapLibre hit-tests geometry, not alpha).
  add(PRIO.SYM_LIGHTS, SECTOR_GATE_SOURCE_LAYER, {
    id: `${source}${SECTOR_GATE_SUFFIX}`,
    type: "circle",
    filter: point,
    layout: { visibility: litVis },
    paint: { "circle-radius": 8, "circle-opacity": 0 },
  });

  // Major-light all-round ring is retired as a JSON layer (slsynkln), now
  // drawn by the sector-lights overlay. `-lights-sym` draws the flare icon
  // for lights with no sector/ring — see docs/architecture/aids-hazards-style.md.
  add(PRIO.SYM_LIGHTS, "LIGHTS", {
    id: `${source}-lights-sym`,
    type: "symbol",
    filter: ["has", "sym"],
    layout: {
      "icon-image": ["get", "sym"],
      "icon-size": iconSize,
      "icon-rotate": LIGHT_ICON_ROTATE,
      "icon-rotation-alignment": "map",
      "icon-offset": [0, 2],
      ...noIcon,
      visibility: litVis,
    },
    // s57-style.json's `light` layer has no paint block (fully opaque) — the
    // 0.75 here is a mivnav-only choice, not a port.
    paint: { "icon-opacity": 0.75 },
  });
  // -lights-star: position star for lights unmarked otherwise. The rule was
  // reversed three times chartcore-side before landing in
  // `derive::lights::marked_positions` — see docs/architecture/aids-hazards-style.md.
  add(PRIO.SYM_LIGHTS, "LIGHTS", {
    id: `${source}-lights-star`,
    type: "symbol",
    filter: ["has", "sym_star"],
    layout: {
      "icon-image": ["get", "sym_star"],
      "icon-size": iconSize,
      ...noIcon,
      visibility: litVis,
    },
  });
  // flood/strip/spot adjunct — all lights, even sectored. `sym_extra` values
  // miss MapLibre's image registry, resolving via the same
  // styleimagemissing -> installAtonIconLoader path the ATON symbols use.
  add(PRIO.SYM_LIGHTS, "LIGHTS", {
    id: `${source}-lights-extra`,
    type: "symbol",
    filter: ["has", "sym_extra"],
    layout: {
      "icon-image": ["get", "sym_extra"],
      "icon-size": iconSize,
      ...noIcon,
      visibility: litVis,
    },
  });
  // Light descriptions (LITDSN01, baked at ingest). Plain TEXT_FONT, never a
  // theme's italic — chart shorthand like "Fl(2)G.6s" is not a proper name,
  // same reasoning as WRECKS' "Wk" adjunct above.
  add(PRIO.SYM_LIGHTS, "LIGHTS", {
    id: `${source}-lights-text`,
    type: "symbol",
    filter: ["has", "litdsn"],
    layout: {
      "text-field": ["get", "litdsn"],
      "text-size": 13,
      "text-font": TEXT_FONT,
      "text-anchor": "left",
      "text-offset": [1.2, 0],
      "text-optional": true, // ~ bDeClutterText
      visibility:
        settings.showText && settings.showLightDescriptions && settings.showLights
          ? "visible"
          : "none",
    },
    paint: { "text-color": C.CHBLK, ...halo },
  });
}
