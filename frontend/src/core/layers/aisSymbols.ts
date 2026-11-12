/**
 * How a vessel looks: symbol, colour, and the two vectors coming out of it.
 * Pure — GeoJSON in, GeoJSON out; `signalkShips.ts` is the glue to layers.
 *
 * Status (not ship type) decides the day-shape overlay, type is only
 * promoted where status is missing, and the sailing glyph + heading
 * stick/predictor split are deliberate departures from OpenCPN — see
 * docs/architecture/ais-symbol-composition.md for the full rationale.
 */

import type { Feature, FeatureCollection, Position } from "geojson";
import { withNickname } from "../format";
import { computeCpa, knotsFromMs, type Risk } from "../cpa";
import { riskThresholds, type CollisionSettings } from "../collisionSettings";
import { parseMmsi } from "../mmsi";
import type { Vessel } from "../signalk";
import { haloPaint, paletteColors, type Palette } from "../style/colors";
import { THEME_BY_ID, type VesselColors } from "../style/themes";
import type { ChartSettings } from "../style/settings";

/** What the AIS scene draws by: this device's display settings plus the
 * boat's collision settings (thresholds, off/show/tell) — the latter the
 * server's, so a target's colour and CPA line match the alarm. */
export type AisSettings = ChartSettings & { collision: CollisionSettings };

/**
 * The AIS palette, every entry traceable to a reference implementation.
 *
 * A risk ladder, not chart symbology — these four do NOT track the palette
 * (unlike everything else, which dims toward near-black at night and would
 * delete the targets). See docs/architecture/ais-symbol-composition.md.
 */
export const AIS_COLORS = {
  /** S-52 UINFG (DAY_BRIGHT r104 g228 b86) — OpenCPN's default target brush. */
  green: "rgb(104, 228, 86)",
  /** S-52 CHYLW (DAY_BRIGHT r244 g218 b72). */
  yellow: "rgb(244, 218, 72)",
  /** OpenCPN URED (user_colors.cpp:31, day scheme): "Own vessel color, AIS
   *  targets, predictor lines". The alarm colour. */
  red: "rgb(255, 0, 0)",
  /** S-52 UINFF — what OpenCPN paints a target whose data it does not trust
   *  (`b_positionDoubtful`, ais.cpp:1060); "cannot assess" is the same claim. */
  unknown: "rgb(125, 137, 140)",
  /** Own ship. Not an AIS target; deliberately neither green nor a risk colour. */
  own: "rgb(204, 45, 45)",
  /** A buddy. Violet because nothing else on the plotter uses it: the risk
   *  ladder takes green/yellow/red/grey and the chart's blues mean water.
   *  Never replaces red or yellow on a live target: see `targetFeatures`. */
  buddy: "rgb(150, 80, 235)",
} as const;

/**
 * The foreground/halo pair a symbol is drawn against the chart with: S-52's
 * UINFD/UIBCK, the only tokens that invert across palettes. Fixes the old
 * hard-coded white halo + black label, invisible at night — see
 * docs/architecture/ais-symbol-composition.md.
 */
export interface SymbolColors {
  /** UINFD — outlines, day-shape glyphs, target labels, the own-ship predictor. */
  ui: string;
  /** UIBCK — the halo under all of the above. */
  uiHalo: string;
}

/** The foreground/halo pair for a palette. */
export function symbolColors(palette: Palette): SymbolColors {
  const C = paletteColors(palette);
  return { ui: C.UINFD, uiHalo: C.UIBCK };
}

/** Colour of a target at each risk level. */
export const RISK_COLORS: Record<Risk, string> = {
  green: AIS_COLORS.green,
  yellow: AIS_COLORS.yellow,
  red: AIS_COLORS.red,
  // Never green. See `Risk` in cpa.ts: the fourth value exists so that a target
  // we cannot assess cannot render as safe, and this is the line that honours it.
  unknown: AIS_COLORS.unknown,
};

/** Target colour when `showAisRisk` is off — a green target with the risk
 *  engine switched off would be a claim we are not making. */
export const RISK_OFF_COLOR = AIS_COLORS.unknown;

/**
 * The vessel colours for a palette: the theme's own `vessels` table where it
 * has one (a night theme's DIMMED copy of the same hues), else `AIS_COLORS`.
 * Every map/info-panel drawing of a target or own ship goes through this —
 * `AIS_COLORS`/`RISK_COLORS` themselves stay the day ladder, for the few
 * palette-free readers (settings swatches, the CPA alarm line).
 */
export function vesselColors(palette: Palette): VesselColors {
  return THEME_BY_ID[palette]?.vessels ?? AIS_COLORS;
}

/** What a hull's colour says: a risk, the risk engine being off, or a buddy.
 * `buddy-old` is the same colour drawn hollow: a position gone quiet. */
export type HullTone = Risk | "off" | "buddy" | "buddy-old";

/** A target's fill for `tone` in `palette` — `"off"` is the risk-engine-off grey. */
export function riskColor(palette: Palette, tone: HullTone): string {
  const V = vesselColors(palette);
  if (tone === "off") return V.unknown;
  return tone === "buddy" || tone === "buddy-old" ? V.buddy : V[tone];
}

/**
 * The hull tone of a live target. A buddy wears its own colour unless it is a
 * danger: red and yellow keep their meaning on every vessel (the buddy ring
 * says whose boat it is), so a friend on a collision course still looks like one.
 */
export function targetTone(risk: Risk, showRisk: boolean, buddy: boolean): HullTone {
  if (buddy && !(showRisk && (risk === "red" || risk === "yellow"))) return "buddy";
  return showRisk ? risk : "off";
}

/** A station's fixed fill in `palette` — `STATION_COLORS`' rule, palette-aware. */
export function stationColor(palette: Palette, symbol: StationSymbol): string {
  const V = vesselColors(palette);
  return STATION_COLORS[symbol] === AIS_COLORS.red ? V.red : V.unknown;
}

/**
 * The COLREGS day shape a vessel is showing, as an overlay on the triangle.
 * `"none"` covers both "under way using engine" (which hoists nothing) and
 * "we were not told" — an ambiguity inherited from reality, not introduced here:
 * NavStatus 0 and an absent NavStatus are genuinely the same picture on the water.
 */
export type DayShape =
  | "none"
  /** One ball — at anchor / moored (COLREGS Rule 30). */
  | "anchor"
  /** Two balls — not under command (Rule 27a). */
  | "nuc"
  /** Ball-diamond-ball — restricted in ability to manoeuvre (Rule 27b). */
  | "ram"
  /** Cylinder — constrained by her draught (Rule 28). */
  | "draught"
  /** Three balls — aground (Rule 30d). */
  | "aground"
  /** Two cones apex to apex — engaged in fishing (Rule 26). */
  | "fishing"
  /** A mainsail. Ours; see the module header. */
  | "sailing"
  /** Chevrons — high-speed craft / WIG. OpenCPN ais.cpp:1661. */
  | "hsc";

/** Every day shape that has a glyph, for image generation and tests. */
export const DAY_SHAPES = [
  "anchor",
  "nuc",
  "ram",
  "draught",
  "aground",
  "fishing",
  "sailing",
  "hsc",
] as const satisfies readonly Exclude<DayShape, "none">[];

/**
 * SignalK `navigation.state` → day shape.
 *
 * Keys are SignalK's enum, plus the spellings that reach it from the various
 * NMEA/AIS converters. Generous on purpose: an unrecognised status falls through
 * to `undefined`, which lets ship type be promoted — and a status string we
 * failed to spell is exactly a case where the type is better than nothing.
 * Matching is done lower-cased and trimmed.
 */
const STATE_SHAPES: Record<string, DayShape> = {
  // Rule 30 — the two states that are the same picture: a ball forward.
  anchored: "anchor",
  "at anchor": "anchor",
  moored: "anchor",
  mooring: "anchor",
  "not under command": "nuc",
  "restricted manouverability": "ram", // SignalK's spelling, sic
  "restricted manoeuvrability": "ram",
  "restricted maneuverability": "ram",
  "constrained by draft": "draught",
  "constrained by draught": "draught",
  aground: "aground",
  fishing: "fishing",
  "engaged in fishing": "fishing",
  sailing: "sailing",
  "under way sailing": "sailing",
  // AIS status 9/10 (reserved for HSC / WIG) as SignalK renders them.
  "hazardous material high speed": "hsc",
  "hazardous material wing in ground": "hsc",
  // Positive claims that she is hoisting nothing. Distinct from an *absent*
  // status: these must block ship-type promotion, or a sailing yacht motoring
  // into harbour would fly a sail glyph off her static ship type.
  motoring: "none",
  "under way using engine": "none",
  "under way": "none",
  drifting: "none",
  hovering: "none",
};

/**
 * ITU-R M.1371 ship type → the status it implies, when no status was reported.
 *
 * Only the types whose *type* is a claim about *activity*. A cargo ship's type
 * says nothing about what she is doing right now, so 70-79 is absent here and
 * draws a bare triangle — which is correct, and is what OpenCPN draws for her.
 */
function shapeFromShipType(id: number): DayShape | undefined {
  if (!Number.isInteger(id)) return undefined;
  if (id === 30) return "fishing";
  if (id === 36) return "sailing";
  // OpenCPN's own type→status promotion, ais.cpp:1599-1603.
  if (id >= 40 && id <= 49) return "hsc";
  return undefined;
}

/**
 * The one symbol, from the two orthogonal inputs. Status wins; type is promoted
 * only into a status that is missing or uninformative. See the module header.
 */
export function dayShape(v: Pick<Vessel, "navStatus" | "shipTypeId">): DayShape {
  const state = v.navStatus?.trim().toLowerCase();
  if (state !== undefined && state !== "") {
    const known = STATE_SHAPES[state];
    // A recognised status is the answer, including when the answer is "none" —
    // that is a report of an empty signal mast, not a gap to fill in.
    if (known !== undefined) return known;
    // Unrecognised ("not defined", "unknown", a spelling we missed): fall
    // through to the ship type rather than assert an empty mast.
  }
  return (v.shipTypeId !== undefined ? shapeFromShipType(v.shipTypeId) : undefined) ?? "none";
}

const EARTH_R = 6_371_000;
const METERS_PER_NM = 1852;
const SEC_PER_MIN = 60;

/** Below this SOG a vessel has no meaningful course, so no predictor is
 *  drawn — OpenCPN's `g_SOGminCOG_kts` (default 0.2, ocpn_platform.cpp). */
const SOG_MIN_KN = 0.2;
const SOG_MIN_MS = (SOG_MIN_KN * METERS_PER_NM) / 3600;

/** Destination point, flat-earth — fine for a *forecast* from reported
 *  COG/SOG, where the vessel's own intentions dominate projection error
 *  before the geometry does. `cpa.ts` does the arithmetic that has to be exact. */
export function destination(
  lng: number,
  lat: number,
  bearingDeg: number,
  meters: number,
): Position {
  const rad = (bearingDeg * Math.PI) / 180;
  const dLat = (meters * Math.cos(rad)) / EARTH_R;
  const dLng = (meters * Math.sin(rad)) / (EARTH_R * Math.cos((lat * Math.PI) / 180));
  return [lng + (dLng * 180) / Math.PI, lat + (dLat * 180) / Math.PI];
}

/**
 * Where the vessel will be in `minutes`, held on its reported COG at its
 * reported SOG — the far end of the predictor. `undefined` when it has no
 * course worth projecting.
 */
export function predictorEnd(v: Vessel, minutes: number): Position | undefined {
  if (v.cogDeg === undefined) return undefined;
  const sog = v.sogMs ?? 0;
  if (!(sog > SOG_MIN_MS) || !(minutes > 0)) return undefined;
  return destination(v.lng, v.lat, v.cogDeg, sog * minutes * SEC_PER_MIN);
}

/** A target as the overlay hands it in: the wire `Vessel` plus the
 *  browser-clock receive stamp (`AisVessel.receivedAtMs`, `signalk.ts`) the
 *  ghost needs. Optional, so a plain `Vessel` grows no ghost. */
export type TargetVessel = Vessel & {
  receivedAtMs?: number;
  buddy?: boolean;
  buddyNickname?: string;
};

/** Age window for the dead-reckoned ghost: below MIN it's sub-symbol
 *  clutter, above MAX dead-reckoning error makes it a guess, not a position.
 *  House-chosen, tunable — #AIS-GHOST. */
export const GHOST_MIN_AGE_MS = 3_000;
export const GHOST_MAX_AGE_MS = 600_000;

/**
 * The dead-reckoned GHOST position: last-reported COG/SOG run forward from
 * `receivedAtMs` (browser-clock, never the fix's own GPS timestamp — no NTP
 * at sea) to `nowMs`. `undefined` outside `GHOST_MIN_AGE_MS`..`GHOST_MAX_AGE_MS`
 * or below the predictor's SOG floor. Flat-earth, same reasoning as `destination`.
 */
export function ghostPosition(
  v: Pick<TargetVessel, "lng" | "lat" | "cogDeg" | "sogMs" | "receivedAtMs">,
  nowMs: number,
): Position | undefined {
  if (v.receivedAtMs === undefined || v.cogDeg === undefined) return undefined;
  const sog = v.sogMs ?? 0;
  if (!(sog > SOG_MIN_MS)) return undefined;
  const ageMs = nowMs - v.receivedAtMs;
  if (!(ageMs >= GHOST_MIN_AGE_MS) || ageMs > GHOST_MAX_AGE_MS) return undefined;
  return destination(v.lng, v.lat, v.cogDeg, (sog * ageMs) / 1000);
}

/** Feature `kind`s, so the layer filters and the builders cannot drift apart. */
export const KIND = {
  vessel: "vessel",
  predictor: "predictor",
  /** The dead-reckoned GHOST — a faded second hull (`ghostPosition`, gated on
   *  `showAisGhost`). Own `kind` so it never flows through the solid-vessel
   *  filter (no day shape, heading stick, or CPA). */
  ghost: "ghost",
  /** The line joining the two vessels at the moment of closest approach. */
  cpa: "cpa",
  /** The two ends of that line. */
  cpaPoint: "cpa-point",
  /** A non-vessel station — AtoN, base station or SART. Own `kind`/layer so it
   *  draws viewport-aligned and never flows through the risk/CPA vessel filter. */
  station: "station",
  /** The autopilot's committed target line, own-ship only, drawn ONLY while
   *  engaged AND live — a status gate the caller (`MapView`) owns. */
  apTarget: "ap-target",
} as const;

// Icon ids below are keyed by palette (every one is drawn with `symbolColors`
// somewhere): all three palettes' canvases are registered up front in
// `signalkShips.ts` so a palette switch is a `setData` like any other, never
// a settings-driven layer rebuild (keeps `ensureSignalkLayers` settings-free).

/** A point in the hull glyph's own frame: the mockup's SVG px, origin at the
 *  vessel, **y down** (forward is −y). Traced onto canvas by `signalkShips.ts`. */
export type GlyphXY = readonly [number, number];

/**
 * The AIS target body: the notched **dart**, ported verbatim from the merged
 * UI mockup (`docs/ui-chrome/merged/mockup.html:1596`, `TARGETS.forEach`:
 * `<path d="M0,-10 L5.5,7 L0,4 L-5.5,7 Z">`) — vertices kept as the mockup's
 * literal numbers so a `git diff` against upstream is a one-line read. Nose
 * at −y (dead ahead, pre-rotation). The mockup's separate COG-stick `line` is
 * deliberately NOT ported — redundant with the predictor/heading-stick pair
 * this renderer already draws (see docs/architecture/ais-symbol-composition.md).
 */
export const HULL_DART: readonly GlyphXY[] = [
  [0, -10], // nose — dead ahead (−y), on the centreline
  [5.5, 7], // starboard base corner
  [0, 4], // the notch: bottom-centre pulled UP into the base (y 4 < 7)
  [-5.5, 7], // port base corner
];

/** A glyph's furthest reach from the origin, in its own px — the extreme vertex,
 * which is what sets the scale that fits it into a square box. Shared by every
 * body, so all three fill the same box to the same margin and read at one size. */
const reachOf = (subpaths: readonly (readonly GlyphXY[])[]): number =>
  Math.max(...subpaths.flat().flatMap(([x, y]) => [Math.abs(x), Math.abs(y)]));

/** The dart's reach. The nose (|y| = 10) wins. */
const DART_REACH = reachOf([HULL_DART]);

/** Clearance left around a glyph's extreme vertex, px, so the 1.5px outline
 * stays inside the canvas rather than being clipped at the edge. */
const HULL_MARGIN = 1.5;

/**
 * Glyph box sizes, px — shared by the map canvas (`signalkShips.ts`) and the
 * info panel's SVG icon (`../info/BoatGlyph.tsx`) so the day-shape overlay
 * overhangs the hull identically in both places rather than via a second copy.
 */
export const HULL_PX = 26;
/** Day-shape glyph box, px — sized to sit inside the hull and overhang it. */
export const SHAPE_PX = 16;
/** Station-symbol box, px — its own primary marker, about the hull's footprint. */
export const STATION_PX = 22;

/** The dart traced into an `s`×`s` canvas box, origin at box centre: 10px
 *  forward of the fix, 7 aft, matching the AIS convention that the reference
 *  point is at the transom, not the centroid. */
export function hullDartPoints(s: number): [number, number][] {
  const c = s / 2;
  const scale = (c - HULL_MARGIN) / DART_REACH;
  return HULL_DART.map(([x, y]) => [c + x * scale, c + y * scale]);
}

/**
 * The FOUR type-bodies — vessels drawn as something other than the dart —
 * plus `dart` (every other vessel). Closed set on purpose; see
 * docs/architecture/ais-symbol-composition.md "The four type-bodies".
 */
export type HullBody = "dart" | "leaf" | "hsc-notch" | "sar-heli" | "house";
export const HULL_BODIES = ["dart", "leaf", "hsc-notch", "sar-heli", "house"] as const satisfies readonly HullBody[];

/**
 * HIGH-SPEED CRAFT — the cargo `HOUSE_SHAPE` pentagon with a V-slot notched
 * into the stern (transom centre pulled to `[0, 5]`); the notch is the whole
 * signal telling an express/HSC hull apart from the plain cargo house. Bow
 * apex at −y like the dart's nose; winding bow → starboard shoulder →
 * starboard quarter → V-slot → port quarter → port shoulder.
 */
const HSC_SHAPE: readonly GlyphXY[] = [
  [0, -10], // bow apex — furthest forward, centreline
  [6, -3], // starboard shoulder
  [6, 8], // starboard quarter (stern corner)
  [0, 5], // V-slot: stern centre pulled forward into the transom
  [-6, 8], // port quarter
  [-6, -3], // port shoulder
];
/** One outline, list-of-subpaths (length 1), so the tracer and `reachOf` treat
 * it exactly like the other bodies. */
export const HSC_NOTCH: readonly (readonly GlyphXY[])[] = [HSC_SHAPE];

/**
 * COMMERCIAL / CARGO-TANKER — a "house": a rectangular hull under a pointed
 * bow (pentagon), broad and boxy the whole length where the dart tapers to a
 * notch and the leaf to a point — how a laden cargo ship/tanker reads against
 * yachts. Bow apex at −y like the other bodies.
 */
const HOUSE_SHAPE: readonly GlyphXY[] = [
  [0, -10], // bow apex — furthest forward, on the centreline
  [6, -3], // starboard shoulder — where the pointed bow meets the parallel side
  [6, 8], // starboard quarter (square transom corner)
  [-6, 8], // port quarter
  [-6, -3], // port shoulder
];
/** One outline, list-of-subpaths (length 1), so the tracer and `reachOf` treat
 * it exactly like the dart and HSC. */
export const HOUSE: readonly (readonly GlyphXY[])[] = [HOUSE_SHAPE];

/** SAR AIRCRAFT — a helicopter seen from above: fuselage + tail boom under a
 *  main rotor of two crossed blades. Nose at −y; the crossed rotor ("+/×"
 *  over a small body) is the whole signal, the non-vessel departure IEC
 *  62288 allows here. */
const SAR_FUSELAGE: readonly GlyphXY[] = [
  [0, -8], // nose
  [2.3, -3.5], // starboard shoulder
  [1.5, 2.5], // starboard waist
  [0.9, 3], // tail boom root, starboard
  [0.9, 9], // tail, starboard
  [-0.9, 9], // tail, port
  [-0.9, 3], // tail boom root, port
  [-1.5, 2.5], // port waist
  [-2.3, -3.5], // port shoulder
];
/** Rotor hub, forward of centre so the disc sits over the cabin, not the tail. */
const SAR_ROTOR_HUB: GlyphXY = [0, -2];
/** A rotor blade: a thin rounded bar of half-length `len`, half-width `w`, at
 * `deg` from the +x axis, centred on the hub. Pure geometry, so the "×" — and
 * its spin — is data a test can pin rather than a canvas flourish. */
function bladeQuad(deg: number, len = 8.5, w = 0.9): GlyphXY[] {
  const a = (deg * Math.PI) / 180;
  const [dx, dy] = [Math.cos(a), Math.sin(a)];
  const [px, py] = [-dy * w, dx * w];
  const [hx, hy] = SAR_ROTOR_HUB;
  return [
    [hx + dx * len + px, hy + dy * len + py],
    [hx + dx * len - px, hy + dy * len - py],
    [hx - dx * len - px, hy - dy * len - py],
    [hx - dx * len + px, hy - dy * len + py],
  ];
}

/**
 * The helicopter's subpaths with the main rotor at `rotorDeg`: the fuselage
 * (which never moves) under two blades that sit at 45°/135° at rest and spin
 * together. This is the seam the animation turns — `signalkShips.ts` re-rasters
 * the sar-heli icons at an advancing `rotorDeg` while a SAR aircraft is on the
 * chart, so only the blades sweep and the airframe holds its heading.
 */
export function sarHeliSubpaths(rotorDeg = 0): readonly (readonly GlyphXY[])[] {
  return [SAR_FUSELAGE, bladeQuad(45 + rotorDeg), bladeQuad(135 + rotorDeg)];
}
/** The rest pose (rotor at rest), which the geometry tests pin. */
export const SAR_HELI = sarHeliSubpaths(0);

/** A cubic-Bézier segment in the glyph frame: `[control1, control2, end]`. */
type LeafSeg = readonly [GlyphXY, GlyphXY, GlyphXY];

/**
 * SAILING — a **LEAF / slender teardrop**, ported verbatim from the reference
 * AIS sailing-vessel glyph: a closed loop of four cubic Béziers, port and
 * starboard mirrored about the centreline. **Orientation: the point is the
 * bow, forward (−y before render rotation); the rounded end is the stern
 * (+y)** — same convention as `HULL_DART`'s nose. Coordinates are the source
 * SVG's 16-unit viewBox recentred on its middle. Still risk-coloured/haloed
 * like the dart it replaces; `traceLeaf` in `signalkShips.ts` traces it with
 * one `bezierCurveTo` per segment.
 */
export const LEAF: { bow: GlyphXY; segments: readonly LeafSeg[] } = {
  bow: [0, -7],
  segments: [
    [[-1, -5.2], [-2.9, -2.7], [-2.9, 3]], // port side: bow → port beam
    [[-2.9, 5.2], [-1.8, 6.2], [0, 6.2]], // stern: port beam → aft tip
    [[1.8, 6.2], [2.9, 5.2], [2.9, 3]], // stern: aft tip → starboard beam
    [[2.9, -2.7], [1, -5.2], [0, -7]], // starboard side: starboard beam → bow
  ],
};

const LEAF_REACH = reachOf([[LEAF.bow, ...LEAF.segments.flat()]]);
const HSC_REACH = reachOf(HSC_NOTCH);
const HOUSE_REACH = reachOf(HOUSE);
// Reach over a full rotor revolution (half-turn, the two-blade period), not
// just the rest pose: scaling off rest would let the spinning rotor clip the box.
const SAR_REACH = Math.max(...Array.from({ length: 180 }, (_, d) => reachOf(sarHeliSubpaths(d))));

/** Map a glyph-frame point into the `s`×`s` box at the given scale. */
const place = (s: number, scale: number) => ([x, y]: GlyphXY): [number, number] =>
  [s / 2 + x * scale, s / 2 + y * scale];

/** A polygon body traced into the `s`×`s` box. The dart defers to
 *  `hullDartPoints` (its origin placement is pinned by tests); the leaf is
 *  NOT here — it's a curved-bow teardrop, traced from `leafPoints` instead. */
export function bodyPoints(
  body: Exclude<HullBody, "leaf">,
  s: number,
  rotorDeg = 0,
): [number, number][][] {
  if (body === "dart") return [hullDartPoints(s)];
  // `rotorDeg` only means anything for the heli; every other body ignores it.
  const [subpaths, reach]: [readonly (readonly GlyphXY[])[], number] =
    body === "hsc-notch"
      ? [HSC_NOTCH, HSC_REACH]
      : body === "house"
        ? [HOUSE, HOUSE_REACH]
        : [sarHeliSubpaths(rotorDeg), SAR_REACH];
  const p = place(s, (s / 2 - HULL_MARGIN) / reach);
  return subpaths.map((sp) => sp.map(p));
}

/** The leaf's points scaled into the `s`×`s` box; `signalkShips.ts` traces it
 *  with one `bezierCurveTo` per segment. */
export function leafPoints(s: number): {
  bow: [number, number];
  segments: [number, number][][];
} {
  const p = place(s, (s / 2 - HULL_MARGIN) / LEAF_REACH);
  return {
    bow: p(LEAF.bow),
    segments: LEAF.segments.map(([c1, c2, end]) => [p(c1), p(c2), p(end)]),
  };
}

/**
 * The hull body as one SVG `d` string, centred on the origin. Built from the
 * SAME point functions the canvas traces, so the panel's SVG hull and the
 * chart's rasterised hull cannot diverge — only the medium differs.
 */
export function hullPathD(body: HullBody, s: number): string {
  const c = s / 2;
  const n = (v: number): string => `${Number((v - c).toFixed(3))}`;
  if (body === "leaf") {
    const { bow, segments } = leafPoints(s);
    let d = `M${n(bow[0])},${n(bow[1])}`;
    for (const [c1, c2, end] of segments) {
      d += `C${n(c1[0])},${n(c1[1])} ${n(c2[0])},${n(c2[1])} ${n(end[0])},${n(end[1])}`;
    }
    return `${d}Z`;
  }
  return bodyPoints(body, s)
    .map((sp) => `M${sp.map(([x, y]) => `${n(x)},${n(y)}`).join("L")}Z`)
    .join("");
}

/**
 * Which body a target draws. The type-bodies are the closed exception set
 * (`HullBody`); everything else is the dart.
 *
 * SAR detection reads `mmsi`: a SAR aircraft is the 111 MMSI production (AIS
 * message 9; `mmsi.ts` parses it), and that is the *only* reliable signal for it
 * — it carries no ship type, and `sensors.ais.class` has no SAR value. `mmsi` is
 * now declared on `Vessel` (`signalk.ts`), so this is typed rather than
 * best-effort; a target with no `mmsi` simply falls through to its ship type.
 *
 * This is the VESSEL path only. The non-vessel stations (AtoN, base, SART) are
 * peeled off earlier by `stationSymbol` in `targetFeatures`, so they never reach
 * here — an AtoN MMSI would return `dart` from this function, which is exactly
 * why it must not be the thing that decides an AtoN's symbol.
 */
export function bodyShape(v: Pick<Vessel, "shipTypeId" | "mmsi">): HullBody {
  if (v.mmsi !== undefined && parseMmsi(v.mmsi)?.kind === "sar-aircraft") return "sar-heli";
  const id = v.shipTypeId;
  if (id === undefined || !Number.isInteger(id)) return "dart";
  if (id === 36) return "leaf";
  if (id >= 40 && id <= 49) return "hsc-notch";
  if (id >= 70 && id <= 89) return "house"; // cargo (70-79) + tanker (80-89)
  return "dart";
}

/**
 * The day-shape overlay to draw OVER a given body — `dayShape`, minus the one
 * shape a type-body would merely repeat. See docs/architecture/ais-symbol-composition.md
 * "overlayShape".
 */
export function overlayShape(
  v: Pick<Vessel, "navStatus" | "shipTypeId">,
  body: HullBody,
): DayShape {
  if (body === "sar-heli") return "none";
  const shape = dayShape(v);
  if (body === "leaf" && shape === "sailing") return "none";
  if (body === "hsc-notch" && shape === "hsc") return "none";
  return shape;
}

/**
 * A COLREGS day-shape as medium-neutral primitives, in an `s`×`s` box — the
 * ONE source of the geometry, consumed by both the map canvas (`Path2D` per
 * primitive) and the info panel's SVG icon. Structured (not path strings) so
 * canvas keeps drawing `ball` with `arc()` while SVG gets a crisp `<circle>`.
 */
export type ShapePrim =
  | { readonly circle: readonly [number, number, number] } // cx, cy, r
  | { readonly poly: readonly (readonly [number, number])[] } // a closed polygon
  | { readonly rect: readonly [number, number, number, number] } // x, y, w, h
  | { readonly path: string }; // an SVG `d`, in box coords

const primBall = (cx: number, cy: number, r: number): ShapePrim => ({ circle: [cx, cy, r] });
const primDiamond = (cx: number, cy: number, r: number): ShapePrim => ({
  poly: [[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]],
});
/** A cone: apex at (cx, apexY), base of half-width `r` at `baseY`. */
const primCone = (cx: number, baseY: number, apexY: number, r: number): ShapePrim => ({
  poly: [[cx, apexY], [cx - r, baseY], [cx + r, baseY]],
});
/** A filled arrowhead pointing up — toward the bow. */
const primChevron = (cx: number, cy: number, r: number): ShapePrim => ({
  poly: [[cx, cy - r * 0.7], [cx + r, cy + r * 0.5], [cx, cy + r * 0.1], [cx - r, cy + r * 0.5]],
});

/**
 * The COLREGS day shapes, as the vessel is actually hoisting them — ported
 * from OpenCPN's NavStatus overlay switch (ais.cpp:1597-1678). Drawn UPRIGHT
 * (viewport space): a real day shape hangs from a stay under gravity, so it
 * must not rotate with the hull's heading.
 */
export function dayShapePrims(shape: Exclude<DayShape, "none">, s: number): ShapePrim[] {
  switch (shape) {
    // Rule 30: one ball.
    case "anchor":
      return [primBall(s / 2, s / 2, s * 0.19)];
    // Rule 27(a): two balls in a vertical line.
    case "nuc":
      return [primBall(s / 2, s * 0.28, s * 0.15), primBall(s / 2, s * 0.72, s * 0.15)];
    // Rule 27(b): ball, diamond, ball — diamond deliberately larger and balls
    // smaller, so the stack can't misread as `aground`'s three even dots.
    case "ram":
      return [
        primBall(s / 2, s * 0.12, s * 0.1),
        primDiamond(s / 2, s / 2, s * 0.28),
        primBall(s / 2, s * 0.88, s * 0.1),
      ];
    // Rule 28: a cylinder.
    case "draught":
      return [{ rect: [s * 0.36, s * 0.22, s * 0.28, s * 0.56] }];
    // Rule 30(d): three balls in a vertical line.
    case "aground":
      return [
        primBall(s / 2, s * 0.16, s * 0.115),
        primBall(s / 2, s * 0.5, s * 0.115),
        primBall(s / 2, s * 0.84, s * 0.115),
      ];
    // Rule 26: two cones, apexes together.
    case "fishing":
      return [primCone(s / 2, s * 0.14, s * 0.5, s * 0.19), primCone(s / 2, s * 0.86, s * 0.5, s * 0.19)];
    // Ours — a mainsail: luff up the mast, roached leech falling away aft. See
    // the module header for why this glyph exists when COLREGS gives a vessel
    // under sail no day shape, and why it is deliberately *not* the point-down
    // cone (which means motor-sailing, and would be a lie). The control point
    // sits *outside* the clew-to-masthead chord so the curve bellies away from
    // the mast: that roach is what makes it read as a sail, not a triangle.
    case "sailing":
      return [
        {
          path:
            `M${s * 0.32},${s * 0.06}` +
            `L${s * 0.32},${s * 0.9}` +
            `L${s * 0.88},${s * 0.9}` +
            `Q${s * 0.84},${s * 0.36} ${s * 0.32},${s * 0.06}Z`,
        },
      ];
    // OpenCPN ais.cpp:1661 — chevrons ahead of the bow.
    case "hsc":
      return [primChevron(s / 2, s * 0.38, s * 0.28), primChevron(s / 2, s * 0.74, s * 0.28)];
  }
}

// ── NON-VESSEL STATIONS — fixed symbols, outside the risk/CPA machinery ──────
// AtoN, base station, SART: no course to run, not things you manoeuvre to
// avoid, so `StationSymbol`s draw a FIXED shape/colour — no risk, predictor,
// CPA line or alarm. (The SAR *aircraft* is a moving `sar-heli` hull and stays
// out of this set — but it gets the same fixed grey and no CPA, in
// `targetFeatures`, because a helicopter is not a collision risk.) Rendering one green/red would be the exact lie the
// risk ladder exists to avoid: "safe to pass" said of a charted buoy.

/** A fixed-symbol station class, detected from the MMSI grammar (`mmsi.ts`)
 *  — these carry no ship type. SART/MOB/EPIRB collapse onto one `sart`
 *  circle-X: one thing to a mariner, one alarm colour. */
export type StationSymbol = "aton" | "coast" | "sart";
export const STATION_SYMBOLS = ["aton", "coast", "sart"] as const satisfies readonly StationSymbol[];

/** AToN — a diamond (reference AToN). Filled in the fixed chart colour with
 *  a `+` over it. Not risk-coloured: a charted object, not a collision target. */
export const ATON_DIAMOND: readonly GlyphXY[] = [
  [0, -9], // top
  [9, 0], // right
  [0, 9], // bottom
  [-9, 0], // left
];
/** The `+` inside the AToN diamond, as endpoint pairs so the cross's
 *  symmetry is testable. Drawn over the body in the foreground colour. */
export const ATON_PLUS: readonly (readonly [GlyphXY, GlyphXY])[] = [
  [[-4.5, 0], [4.5, 0]],
  [[0, -4.5], [0, 4.5]],
];

/** BASE / COAST STATION — an antenna: mast forking into a "Y" on a ground
 *  bar. Stroked, not filled — line-art like the heading stick. Not risk-coloured. */
export const ANTENNA: readonly (readonly [GlyphXY, GlyphXY])[] = [
  [[0, 9], [0, -3]], // mast — base up to the fork
  [[0, -3], [6, -9]], // starboard arm of the Y
  [[0, -3], [-6, -9]], // port arm of the Y
  [[-5.5, 9], [5.5, 9]], // ground bar
];

/** AIS-SART — the radius of the alarm-coloured disc (reference SAR Transponder). */
export const SART_RADIUS = 8;
/** The `X` across the SART disc. An EMERGENCY marker (alarm red,
 *  `STATION_COLORS`) — not the CPA alarm, a SART never joins the CPA figure. */
export const SART_CROSS: readonly (readonly [GlyphXY, GlyphXY])[] = [
  [[-5.5, -5.5], [5.5, 5.5]],
  [[-5.5, 5.5], [5.5, -5.5]],
];

/** Each station's furthest reach from the origin, so it scales into its box like
 * the hull bodies do. `reachOf` treats the endpoint-pair lists as subpaths. */
const STATION_REACH: Record<StationSymbol, number> = {
  aton: reachOf([ATON_DIAMOND]),
  coast: reachOf(ANTENNA),
  sart: Math.max(SART_RADIUS, reachOf(SART_CROSS)),
};

/**
 * The fixed colour of each station class — NEVER risk-coloured, because none of
 * these is a collision target.
 *
 * AtoN and base stations take the neutral `unknown` grey: it is our "this is not
 * a target to assess" colour (see `AIS_COLORS.unknown`), which is exactly what an
 * aid or a shore station is. The SART/MOB/EPIRB takes the alarm `red` — an
 * emergency, and read as one at a glance — which is the colour and not the CPA
 * alarm the risk engine raises.
 */
export const STATION_COLORS: Record<StationSymbol, string> = {
  aton: AIS_COLORS.unknown,
  coast: AIS_COLORS.unknown,
  sart: AIS_COLORS.red,
};

/**
 * A station glyph's geometry, scaled into the `s`×`s` box: the filled body,
 * the foreground marks over it (`+`, `X`), and the fixed-colour strokes that
 * ARE the body where there is no fill (the antenna). `signalkShips.ts` traces
 * these; shape and scaling are pinned by tests here.
 */
export function stationGlyph(
  symbol: StationSymbol,
  s: number,
): {
  polygon?: [number, number][];
  disc?: { cx: number; cy: number; r: number };
  /** Marks over the body, in the ui foreground colour (`+`, `X`). */
  fgMarks: [[number, number], [number, number]][];
  /** Strokes that ARE the body, in the fixed station colour (antenna). */
  fixedMarks: [[number, number], [number, number]][];
} {
  const c = s / 2;
  const scale = (c - HULL_MARGIN) / STATION_REACH[symbol];
  const pt = ([x, y]: GlyphXY): [number, number] => [c + x * scale, c + y * scale];
  const seg = (sg: readonly [GlyphXY, GlyphXY]): [[number, number], [number, number]] => [pt(sg[0]), pt(sg[1])];
  switch (symbol) {
    case "aton":
      return { polygon: ATON_DIAMOND.map(pt), fgMarks: ATON_PLUS.map(seg), fixedMarks: [] };
    case "coast":
      return { fgMarks: [], fixedMarks: ANTENNA.map(seg) };
    case "sart":
      return { disc: { cx: c, cy: c, r: SART_RADIUS * scale }, fgMarks: SART_CROSS.map(seg), fixedMarks: [] };
  }
}

/**
 * The station symbol a target draws, or `undefined` when it is a vessel (and
 * flows through `bodyShape`/risk/CPA instead). Keyed on the MMSI grammar
 * (`mmsi.ts`); a SAR aircraft deliberately returns `undefined` — it stays a
 * moving `HullBody` (`sar-heli`), not a station.
 */
export function stationSymbol(v: Pick<Vessel, "mmsi">): StationSymbol | undefined {
  if (v.mmsi === undefined) return undefined;
  switch (parseMmsi(v.mmsi)?.kind) {
    case "aton":
      return "aton";
    case "coast":
      return "coast";
    case "sart":
    case "mob":
    case "epirb":
      return "sart";
    default:
      return undefined;
  }
}

export const hullIcon = (risk: HullTone, palette: Palette, body: HullBody = "dart"): string =>
  body === "dart" ? `ais-hull-${risk}-${palette}` : `ais-hull-${body}-${risk}-${palette}`;
export const shapeIcon = (shape: Exclude<DayShape, "none">, palette: Palette): string =>
  `ais-shape-${shape}-${palette}`;
/** Station-symbol icon id. Keyed by palette only (like the day shapes) — a
 * station's fill is fixed (`STATION_COLORS`), so there is no risk dimension. */
export const stationIcon = (symbol: StationSymbol, palette: Palette): string =>
  `ais-station-${symbol}-${palette}`;
export const headingStickIcon = (palette: Palette): string => `ais-heading-stick-${palette}`;
/** Own-ship icon id. `stale` is the link-lost variant: the same hull in
 * `AIS_COLORS.unknown` grey, so a position frozen behind a dropped SignalK /
 * mivnav link never reads as a live red boat. */
export const ownShipIcon = (palette: Palette, stale = false): string =>
  stale ? `signalk-ownship-stale-${palette}` : `signalk-ownship-${palette}`;
/** The AP target line icon, built LAZILY (in `updateSignalkData`, not
 *  `ensureSignalkLayers`) because its colour is the `--color-ap` CSS token
 *  read off the DOM — the one icon here whose colour isn't an S-52 value. */
export const apTargetIcon = (palette: Palette): string => `signalk-ap-target-${palette}`;

export interface AisScene {
  own: FeatureCollection;
  targets: FeatureCollection;
  /**
   * The CPA collision figure, drawn ONLY for red targets — kept as its OWN
   * collection/source (not in `targets`) because it redraws at own-ship (GPS)
   * rate, not AIS rate: this is what lets `scenePush`'s dedup skip re-parsing
   * the ~73-feature target source on an own-ship-only move. See
   * docs/architecture/scene-push-throttle.md.
   */
  cpa: FeatureCollection;
}

/**
 * A position we can actually draw at. Defence in depth (no fixless vessel
 * reaches the wire today): `computeCpa` already guards the RISK score, but an
 * unguarded `[NaN, NaN]` serialises to corrupt GeoJSON through `setData` and
 * can fail the WHOLE source update — taking every other target down with the
 * one bad ghost. Dropping it here limits the damage to one missing target.
 */
export function hasFix(v: Pick<Vessel, "lat" | "lng">): boolean {
  return Number.isFinite(v.lat) && Number.isFinite(v.lng);
}

const collection = (features: Feature[]): FeatureCollection => ({
  type: "FeatureCollection",
  features,
});

/**
 * Every vessel's symbol and vectors, ready for `setData`. Settings are a
 * required argument, not a module-level read, so a test can bind "are the
 * thresholds actually the user's?" rather than a silently buried default.
 */
export function buildAisScene(
  self: Vessel | null,
  targets: TargetVessel[],
  settings: AisSettings,
  // Threaded in (not read here) so this stays a pure "no clock" function; the
  // impure caller supplies `Date.now()`. Default 0 means no real clock, so
  // `ghostPosition` skips every ghost — every existing test draws none.
  nowMs = 0,
  // The link is down (`signalk.status() !== "connected"`), so own ship's
  // position is the last one heard, not the current one — drawn grey.
  ownStale = false,
): AisScene {
  // Unplaceable own ship makes every target unassessable; `null` reaches
  // `targetFeatures`'s `unknown` path without asking the engine a question
  // about a boat with no location.
  const own = self && hasFix(self) ? self : null;
  const targetFeats: Feature[] = [];
  const cpaFeats: Feature[] = [];
  for (const t of targets.filter(hasFix)) {
    const { target, cpa } = targetFeatures(t, own, settings, nowMs);
    for (const f of target) targetFeats.push(f);
    for (const f of cpa) cpaFeats.push(f);
  }
  return {
    own: collection(own ? ownFeatures(own, settings, ownStale) : []),
    targets: collection(targetFeats),
    cpa: collection(cpaFeats),
  };
}

/** Own ship's symbol, heading stick and predictor. Never risk-coloured — the
 * boat is not a target, and a green own ship would be a promise. */
function ownFeatures(self: Vessel, settings: ChartSettings, stale: boolean): Feature[] {
  const pos: Position = [self.lng, self.lat];
  const out: Feature[] = [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: pos },
      properties: {
        kind: KIND.vessel,
        icon: ownShipIcon(settings.palette, stale),
        // Rotate to heading; fall back to COG. IEC 62288 and OpenCPN
        // (ais.cpp:866-902) both orient the body to HDG when it is valid.
        rotation: self.headingDeg ?? self.cogDeg ?? 0,
        // Scales the hull AND the heading stick (both layers read it), so the
        // stick keeps clearing the bow at any size.
        size: settings.ownShipScale,
        ...headingProps(self, settings),
      },
    },
  ];
  const end = predictorEnd(self, settings.predictorMinutes);
  if (end) {
    out.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: [pos, end] },
      // The one predictor that carries no risk, so it wears the foreground
      // colour rather than a risk colour — and therefore inverts with the
      // palette like the outlines do.
      properties: { kind: KIND.predictor, color: symbolColors(settings.palette).ui },
    });
  }
  return out;
}

/**
 * The heading stick's rotation and icon, or nothing — absent `heading` is the
 * layer filter, so a vessel that never reported one grows no stick.
 *
 * Both together, so they cannot drift: the stick's halo inverts with the
 * palette, so the icon is per-palette, and a feature with a `heading` but no
 * `stick` would draw nothing at all.
 */
function headingProps(
  v: Vessel,
  settings: ChartSettings,
): { heading?: number; stick?: string } {
  return settings.showHeadingLine && v.headingDeg !== undefined
    ? { heading: v.headingDeg, stick: headingStickIcon(settings.palette) }
    : {};
}

/**
 * A non-vessel station as a single fixed symbol — deliberately NOTHING from
 * the vessel path (no CPA, risk colour, predictor, heading stick): an AtoN
 * must never render green/red or grow a collision line.
 */
function stationFeatures(v: Vessel, symbol: StationSymbol, settings: ChartSettings): Feature[] {
  const { ui, uiHalo } = symbolColors(settings.palette);
  const glow = haloPaint(settings.palette);
  return [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [v.lng, v.lat] },
      properties: {
        kind: KIND.station,
        icon: stationIcon(symbol, settings.palette),
        ...(v.name
          ? {
              name: v.name,
              textColor: ui,
              haloColor: uiHalo,
              // Colour stays per-feature (a selection/risk signal); the
              // WIDTH is the theme's own `textHalo` — a theme with none
              // (paper2) gets 0 here regardless of `haloColor`, i.e. no
              // visible glow.
              haloWidth: glow["text-halo-width"] ?? 0,
              haloBlur: glow["text-halo-blur"] ?? 0,
            }
          : {}),
      },
    },
  ];
}

/**
 * One AIS target, partitioned by update rate: `target` (AIS rate) vs `cpa`
 * (own-ship/GPS rate) — see `AisScene.cpa`. A non-vessel station peels off
 * first to its own fixed symbol and never reaches the risk/CPA code below.
 */
function targetFeatures(
  v: TargetVessel,
  self: Vessel | null,
  settings: AisSettings,
  nowMs: number,
): { target: Feature[]; cpa: Feature[] } {
  const station = stationSymbol(v);
  if (station) return { target: stationFeatures(v, station, settings), cpa: [] };
  const pos: Position = [v.lng, v.lat];
  const body = bodyShape(v);
  // A SAR aircraft is drawn as a moving hull but never assessed: fixed grey,
  // no CPA line — matching the backend, which never alarms on one.
  const assessed = body !== "sar-heli";
  const cpa = self && assessed
    ? computeCpa(cpaVessel(self), cpaVessel(v), {
        thresholds: riskThresholds(settings.collision),
        atRestKn: settings.collision.at_rest_kn,
      })
    : undefined;
  // No own position is unassessable, not safe — must look grey, not green.
  const risk: Risk = cpa?.risk ?? "unknown";
  const buddy = v.buddy === true && assessed;
  const tone = assessed ? targetTone(risk, settings.showAisRisk, buddy) : "off";
  const color = riskColor(settings.palette, tone);
  const shape = overlayShape(v, body);
  const { ui, uiHalo } = symbolColors(settings.palette);
  const glow = haloPaint(settings.palette);

  const label = withNickname(v.name, v.buddyNickname);

  const out: Feature[] = [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: pos },
      properties: {
        kind: KIND.vessel,
        icon: hullIcon(tone, settings.palette, body),
        rotation: v.headingDeg ?? v.cogDeg ?? 0,
        ...(shape === "none" ? {} : { shape: shapeIcon(shape, settings.palette) }),
        ...headingProps(v, settings),
        // A buddy in danger colours: the ring keeps it recognisable.
        ...(buddy && tone !== "buddy"
          ? { buddyRing: riskColor(settings.palette, "buddy") }
          : {}),
        // Feature properties, not paint constants — see `symbolColors`'s note
        // on why this matters (night labels used to be invisible).
        ...(label
          ? {
              name: label,
              textColor: ui,
              haloColor: uiHalo,
              haloWidth: glow["text-halo-width"] ?? 0,
              haloBlur: glow["text-halo-blur"] ?? 0,
            }
          : {}),
      },
    },
  ];

  const end = predictorEnd(v, settings.predictorMinutes);
  if (end) {
    out.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: [pos, end] },
      properties: { kind: KIND.predictor, color },
    });
  }

  // The dead-reckoned GHOST reuses the SAME hull icon as the solid target
  // (only the layer's `icon-opacity` fades it) so it reads as that ship,
  // translucent, further along its course line — no separate connector needed.
  if (settings.showAisGhost) {
    const ghost = ghostPosition(v, nowMs);
    if (ghost) {
      out.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: ghost },
        properties: {
          kind: KIND.ghost,
          icon: hullIcon(tone, settings.palette, body),
          rotation: v.headingDeg ?? v.cogDeg ?? 0,
        },
      });
    }
  }

  // Gated on the boat's off/show/tell, NOT `showAisRisk` — colour is a
  // separate switch. Goes into its own collection, never `out` — see `AisScene.cpa`.
  const cpaOut =
    settings.collision.mode !== "off" && self && cpa?.kind === "computed" && risk === "red"
      ? cpaFeatures(self, v, cpa.tcpaMin, uiHalo)
      : [];
  return { target: out, cpa: cpaOut };
}

const cpaVessel = (v: Vessel) => ({
  lat: v.lat,
  lng: v.lng,
  cogDeg: v.cogDeg,
  sogKn: v.sogMs === undefined ? undefined : knotsFromMs(v.sogMs),
});

/**
 * The collision, drawn: both vessels run forward to the moment of closest
 * approach, and the line between those two future positions *is* the CPA —
 * ported from OpenCPN (ais.cpp:1073-1140), red targets only (a yellow-band
 * web of lines would cost the figure its usefulness, which is rarity). Only
 * reached with a computed, red result, so this never draws a "collision"
 * that already didn't happen.
 */
function cpaFeatures(self: Vessel, target: Vessel, tcpaMin: number, haloColor: string): Feature[] {
  const ownAt = futurePosition(self, tcpaMin);
  const targetAt = futurePosition(target, tcpaMin);
  return [
    {
      type: "Feature",
      geometry: { type: "LineString", coordinates: [ownAt, targetAt] },
      properties: { kind: KIND.cpa },
    },
    // Line and balls stay AIS_COLORS.red in every palette — this is the
    // alarm. Only the ring around each ball tracks the palette (no white dot at night).
    ...[ownAt, targetAt].map(
      (coordinates): Feature => ({
        type: "Feature",
        geometry: { type: "Point", coordinates },
        properties: { kind: KIND.cpaPoint, haloColor },
      }),
    ),
  ];
}

/**
 * Dead reckoning `minutes` ahead. Unlike `predictorEnd` this has no SOG floor
 * and no bail-out: a stationary vessel's future position is where it is now,
 * which is the correct end of a CPA line to a moored ship. Returning nothing
 * here would drop the line for the one target you most want it for.
 */
function futurePosition(v: Vessel, minutes: number): Position {
  const sog = v.sogMs ?? 0;
  if (v.cogDeg === undefined || sog <= 0) return [v.lng, v.lat];
  return destination(v.lng, v.lat, v.cogDeg, sog * minutes * SEC_PER_MIN);
}
