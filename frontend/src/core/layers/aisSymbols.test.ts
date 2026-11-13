/**
 * The AIS presentation rules — the half of the rendering that can be wrong
 * without looking wrong.
 *
 * No mocks and no DOM: `aisSymbols.ts` is pure by construction, which is what
 * lets this file exist. (bun shares one module registry per run, so a
 * `mock.module` here would leak into every other test file.)
 */

import { describe, expect, test } from "bun:test";
import type { Feature, LineString, Point, Position } from "geojson";
import type { Vessel } from "../signalk";
import { DEFAULT_SETTINGS, type ChartSettings } from "../style/settings";
import { s52ColourToRgb } from "../style/colors";
import {
  AIS_COLORS,
  riskColor,
  stationColor,
  vesselColors,
  ANTENNA,
  ATON_DIAMOND,
  ATON_PLUS,
  bodyPoints,
  bodyShape,
  buildAisScene,
  dayShape,
  dayShapePrims,
  DAY_SHAPES,
  GHOST_MAX_AGE_MS,
  GHOST_MIN_AGE_MS,
  ghostPosition,
  headingStickIcon,
  HULL_BODIES,
  hullPathD,
  HULL_PX,
  SHAPE_PX,
  HOUSE,
  HSC_NOTCH,
  HULL_DART,
  hullDartPoints,
  hullIcon,
  KIND,
  LEAF,
  leafPoints,
  overlayShape,
  ownShipIcon,
  predictorEnd,
  RISK_COLORS,
  SAR_HELI,
  sarHeliSubpaths,
  SART_CROSS,
  SART_RADIUS,
  shapeIcon,
  STATION_COLORS,
  STATION_SYMBOLS,
  stationGlyph,
  stationIcon,
  stationSymbol,
  symbolColors,
  type AisSettings,
} from "./aisSymbols";
import {
  DEFAULT_COLLISION_SETTINGS,
  riskThresholds,
  type CollisionSettings,
} from "../collisionSettings";

const settings = (patch: Partial<AisSettings> = {}): AisSettings => ({
  ...DEFAULT_SETTINGS,
  collision: DEFAULT_COLLISION_SETTINGS,
  ...patch,
});
/** Default device settings, with the boat's collision settings patched. */
const boat = (patch: Partial<CollisionSettings>): AisSettings =>
  settings({ collision: { ...DEFAULT_COLLISION_SETTINGS, ...patch } });

// The palette every `settings()`-built scene paints in. Icon ids carry the
// palette as a suffix, and the default palette is `paper2` since uqolozkr —
// spelling "day" here would compare the default scene against a theme it is
// not painted in. Tests that mean a SPECIFIC palette still name it.
const PAL = DEFAULT_SETTINGS.palette;

const KN_TO_MS = 1852 / 3600;
/** One arcmin of latitude = 1 nm, by definition. */
const NM_TO_LAT = 1 / 60;

/** Great-circle distance in nm, independent of the flat-earth code under test. */
function distanceNm(a: Position, b: Position): number {
  const toRad = Math.PI / 180;
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  // Radius in nm on the sphere where 1 arcmin == 1 nm — the navigator's
  // convention, so this measures the code against how a chart is read.
  return 2 * Math.asin(Math.sqrt(h)) * ((180 * 60) / Math.PI);
}

/**
 * Assert a distance in nm, within 0.1%.
 *
 * Not slop. `destination()` converts metres on a 6371 km sphere, while a nm is
 * defined as one arcmin of latitude — two spheres that differ by ~0.07%, which
 * is the same convention bias `cpa.ts` names in its `## Projection` section and
 * accepts. It is 12 m in 10 nm, against AIS position noise of 5-10 m and a
 * predictor built from a *reported* course. The tolerance is still three orders
 * of magnitude tighter than any unit or factor error it exists to catch.
 */
function expectNm(actual: number, expected: number): void {
  expect(Math.abs(actual - expected) / expected).toBeLessThan(0.001);
}

const vesselFeatures = (features: Feature[]) => features.filter((f) => f.properties?.kind === KIND.vessel);
const only = (features: Feature[], kind: string) => features.filter((f) => f.properties?.kind === kind);

/** The single target's symbol properties. */
function symbolOf(scene: { targets: { features: Feature[] } }): Record<string, unknown> {
  const [f] = vesselFeatures(scene.targets.features);
  expect(f).toBeDefined();
  return f.properties as Record<string, unknown>;
}

describe("dayShape — type and status are orthogonal", () => {
  test("a fishing vessel AT ANCHOR shows the anchor ball, not the fishing shape", () => {
    // The case the whole rule exists for. Ship type says fishing; status says
    // at anchor. She is not fishing — she is anchored — so she hoists a ball.
    expect(dayShape({ shipTypeId: 30, navStatus: "anchored" })).toBe("anchor");
  });

  test("status wins even when it says the mast is empty", () => {
    // A sailing yacht (type 36) motoring in reports "motoring". Promoting her
    // static type over that would fly a sail she has just dropped.
    expect(dayShape({ shipTypeId: 36, navStatus: "motoring" })).toBe("none");
  });

  test("ship type is promoted only when the status is missing", () => {
    // Class B (message 18) carries no navigational status at all, which is
    // most yachts — without promotion, "an icon for sailing" would never draw.
    expect(dayShape({ shipTypeId: 36 })).toBe("sailing");
    expect(dayShape({ shipTypeId: 30 })).toBe("fishing");
    expect(dayShape({ shipTypeId: 45 })).toBe("hsc"); // 40-49, OpenCPN's own promotion
  });

  test("an unrecognised status falls through to the ship type", () => {
    expect(dayShape({ shipTypeId: 36, navStatus: "not defined" })).toBe("sailing");
    expect(dayShape({ shipTypeId: 30, navStatus: "" })).toBe("fishing");
  });

  test("status alone is enough — no ship type needed", () => {
    expect(dayShape({ navStatus: "sailing" })).toBe("sailing");
    expect(dayShape({ navStatus: "fishing" })).toBe("fishing");
    expect(dayShape({ navStatus: "aground" })).toBe("aground");
    expect(dayShape({ navStatus: "not under command" })).toBe("nuc");
    expect(dayShape({ navStatus: "restricted manouverability" })).toBe("ram");
    expect(dayShape({ navStatus: "constrained by draft" })).toBe("draught");
    expect(dayShape({ navStatus: "moored" })).toBe("anchor");
  });

  test("status matching is case- and whitespace-insensitive", () => {
    expect(dayShape({ navStatus: "  At Anchor " })).toBe("anchor");
  });

  test("a type that says nothing about activity draws a bare triangle", () => {
    // A cargo ship's hull does not tell you what she is doing. OpenCPN draws
    // her a plain triangle too; there is no cargo glyph anywhere in the lineage.
    expect(dayShape({ shipTypeId: 70 })).toBe("none");
    expect(dayShape({ shipTypeId: 80 })).toBe("none"); // tanker
    expect(dayShape({})).toBe("none");
  });
});

describe("the dart body shape — ported from the UI mockup", () => {
  // The port is pinned to the mockup's literal path so this test IS the diff
  // against docs/ui-chrome/merged/mockup.html:1596 — `M0,-10 L5.5,7 L0,4 L-5.5,7`.
  // If someone re-tunes the glyph, they change the mockup and this together, on
  // purpose; a silent drift from the agreed design fails here.
  test("is the mockup's four vertices, verbatim", () => {
    expect(HULL_DART).toEqual([
      [0, -10],
      [5.5, 7],
      [0, 4],
      [-5.5, 7],
    ]);
  });

  test("the nose points forward — COG-up before the render rotation", () => {
    // Forward is −y in the glyph's own frame (MapLibre rotates the whole icon by
    // heading/COG afterwards). So the nose must be the single most-forward vertex
    // and must sit on the centreline, or the dart would render off-axis.
    const minY = Math.min(...HULL_DART.map(([, y]) => y));
    const forward = HULL_DART.filter(([, y]) => y === minY);
    expect(forward).toEqual([[0, -10]]); // unique, and on x = 0
  });

  test("it is NOTCHED — a dart, not a plain triangle", () => {
    // The bottom-centre vertex is pulled UP into the base: its y is above (less
    // than) the two base corners' y. Remove that inequality and you have an
    // ordinary isosceles triangle, which is the shape this port exists to change.
    const [, starboard, notch, port] = HULL_DART;
    expect(notch[0]).toBe(0); // on the centreline
    expect(starboard[1]).toBe(port[1]); // the two base corners share a y
    expect(notch[1]).toBeLessThan(starboard[1]); // and the notch rides above them
  });

  test("port and starboard mirror across the centreline", () => {
    const [, starboard, , port] = HULL_DART;
    expect(port[0]).toBe(-starboard[0]);
    expect(port[1]).toBe(starboard[1]);
  });

  test("hullDartPoints places it nose-high and wholly inside the box", () => {
    const s = 26;
    const pts = hullDartPoints(s);
    // Nothing may spill outside the canvas, or the outline clips.
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(s);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(s);
    }
    const [nose, starboard, , port] = pts;
    // The nose is the topmost pixel (smallest canvas y) and on the box centre.
    expect(nose[0]).toBeCloseTo(s / 2, 6);
    expect(nose[1]).toBe(Math.min(...pts.map(([, y]) => y)));
    // The transom sits AFT of the fix (below box centre): the reference point is
    // at the stern, the AIS convention the mockup follows.
    expect(starboard[1]).toBeGreaterThan(s / 2);
    // Symmetry survives the mapping.
    expect(port[0]).toBeCloseTo(s - starboard[0], 6);
  });
});

describe("bodyShape — the three sanctioned type-bodies, and the dart for everything else", () => {
  test("a sailing vessel (ship type 36) gets the leaf", () => {
    expect(bodyShape({ shipTypeId: 36 })).toBe("leaf");
  });

  test("high-speed craft (ship type 40-49) get the notched house", () => {
    // The whole 40-49 band OpenCPN already promotes to NavStatus HSC.
    expect(bodyShape({ shipTypeId: 40 })).toBe("hsc-notch");
    expect(bodyShape({ shipTypeId: 45 })).toBe("hsc-notch");
    expect(bodyShape({ shipTypeId: 49 })).toBe("hsc-notch");
  });

  test("a SAR aircraft (MMSI 111 production) gets the helicopter", () => {
    // AIS message 9 — the only reliable signal for a SAR aircraft (it carries no
    // ship type). 111MIDXXX; see mmsi.ts.
    expect(bodyShape({ mmsi: "111219123" })).toBe("sar-heli");
  });

  test("the SAR aircraft signal wins over any ship type", () => {
    expect(bodyShape({ mmsi: "111219123", shipTypeId: 36 })).toBe("sar-heli");
  });

  test("a commercial / cargo-tanker vessel (ship type 70-89) gets the house", () => {
    // The user's second named type-body: a boxy hull that reads as commercial
    // traffic. Cargo (70-79) and tanker (80-89) share it.
    expect(bodyShape({ shipTypeId: 70 })).toBe("house");
    expect(bodyShape({ shipTypeId: 79 })).toBe("house");
    expect(bodyShape({ shipTypeId: 80 })).toBe("house");
    expect(bodyShape({ shipTypeId: 89 })).toBe("house");
  });

  test("every other vessel keeps the dart", () => {
    expect(bodyShape({ shipTypeId: 30 })).toBe("dart"); // fishing
    expect(bodyShape({ shipTypeId: 39 })).toBe("dart"); // just below HSC
    expect(bodyShape({ shipTypeId: 50 })).toBe("dart"); // just above HSC
    expect(bodyShape({ shipTypeId: 69 })).toBe("dart"); // just below the house band
    expect(bodyShape({ shipTypeId: 90 })).toBe("dart"); // just above the house band
    expect(bodyShape({})).toBe("dart");
    expect(bodyShape({ shipTypeId: 36.5 })).toBe("dart"); // not an integer code
  });

  test("a non-SAR MMSI does not summon the helicopter", () => {
    // A plain Danish ship station starts with its MID, not 111.
    expect(bodyShape({ mmsi: "219000001" })).toBe("dart");
  });
});

describe("overlayShape — a body suppresses only the day shape it would repeat", () => {
  test("a leaf under sail shows NO overlay — the leaf is the sail", () => {
    // Type 36 with no status promotes to the sailing mainsail; on a leaf that
    // would be the sail drawn twice, so it is dropped.
    expect(dayShape({ shipTypeId: 36 })).toBe("sailing");
    expect(overlayShape({ shipTypeId: 36 }, "leaf")).toBe("none");
  });

  test("a leaf AT ANCHOR still shows the anchor ball — the safety shape survives", () => {
    // She is a sailing vessel AND she is anchored; the second fact is the one a
    // mariner acts on, so it is kept over the leaf.
    expect(overlayShape({ shipTypeId: 36, navStatus: "anchored" }, "leaf")).toBe("anchor");
  });

  test("the notched-house HSC body drops only the redundant HSC chevrons", () => {
    expect(dayShape({ shipTypeId: 45 })).toBe("hsc");
    expect(overlayShape({ shipTypeId: 45 }, "hsc-notch")).toBe("none");
    // ...but keeps a COLREGS shape she actually flies.
    expect(overlayShape({ shipTypeId: 45, navStatus: "aground" }, "hsc-notch")).toBe("aground");
  });

  test("a helicopter hoists no day shape at all", () => {
    // An aircraft carries none; any promoted or reported shape here is noise.
    expect(overlayShape({ navStatus: "anchored" }, "sar-heli")).toBe("none");
    expect(overlayShape({ shipTypeId: 36 }, "sar-heli")).toBe("none");
  });

  test("the dart is unchanged — every day shape passes through", () => {
    expect(overlayShape({ navStatus: "aground" }, "dart")).toBe("aground");
    expect(overlayShape({ shipTypeId: 36 }, "dart")).toBe("sailing");
    expect(overlayShape({ shipTypeId: 45 }, "dart")).toBe("hsc");
  });
});

describe("dayShapePrims — the shared day-shape geometry", () => {
  // The single source both the map canvas and the info-panel SVG icon consume.
  const nums = (d: string): number[] => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);

  test("each shape yields the expected primitive count and kind", () => {
    // anchor is one ball; ram is ball-diamond-ball; draught a single cylinder.
    expect(dayShapePrims("anchor", SHAPE_PX)).toHaveLength(1);
    expect(dayShapePrims("anchor", SHAPE_PX)[0]).toHaveProperty("circle");
    expect(dayShapePrims("nuc", SHAPE_PX)).toHaveLength(2);
    expect(dayShapePrims("aground", SHAPE_PX)).toHaveLength(3);
    const ram = dayShapePrims("ram", SHAPE_PX);
    expect(ram).toHaveLength(3);
    expect(ram[0]).toHaveProperty("circle");
    expect(ram[1]).toHaveProperty("poly"); // the diamond
    expect(ram[2]).toHaveProperty("circle");
    expect(dayShapePrims("draught", SHAPE_PX)[0]).toHaveProperty("rect");
    expect(dayShapePrims("fishing", SHAPE_PX).every((p) => "poly" in p)).toBe(true);
    expect(dayShapePrims("hsc", SHAPE_PX).every((p) => "poly" in p)).toBe(true);
    // The sail is the one non-primitive glyph — a quadratic path.
    expect(dayShapePrims("sailing", SHAPE_PX)[0]).toHaveProperty("path");
  });

  test("the anchor ball is centred on the fix", () => {
    const [prim] = dayShapePrims("anchor", SHAPE_PX);
    expect("circle" in prim && prim.circle).toEqual([SHAPE_PX / 2, SHAPE_PX / 2, SHAPE_PX * 0.19]);
  });

  test("every shape stays wholly inside its box, at every size", () => {
    for (const s of [SHAPE_PX, 26, 40]) {
      for (const shape of DAY_SHAPES) {
        for (const prim of dayShapePrims(shape, s)) {
          const pts: [number, number][] =
            "circle" in prim
              ? [
                  [prim.circle[0] - prim.circle[2], prim.circle[1] - prim.circle[2]],
                  [prim.circle[0] + prim.circle[2], prim.circle[1] + prim.circle[2]],
                ]
              : "rect" in prim
                ? [
                    [prim.rect[0], prim.rect[1]],
                    [prim.rect[0] + prim.rect[2], prim.rect[1] + prim.rect[3]],
                  ]
                : "poly" in prim
                  ? prim.poly.map(([x, y]) => [x, y])
                  : chunk2(nums(prim.path));
          for (const [x, y] of pts) {
            expect(x).toBeGreaterThanOrEqual(0);
            expect(x).toBeLessThanOrEqual(s);
            expect(y).toBeGreaterThanOrEqual(0);
            expect(y).toBeLessThanOrEqual(s);
          }
        }
      }
    }
  });
});

function chunk2(ns: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < ns.length; i += 2) out.push([ns[i], ns[i + 1]]);
  return out;
}

describe("hullPathD — the SVG hull, from the same points the canvas traces", () => {
  const nums = (d: string): number[] => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);

  test("every body is a closed path centred on the origin, inside the box", () => {
    for (const body of HULL_BODIES) {
      const d = hullPathD(body, HULL_PX);
      expect(d.startsWith("M")).toBe(true);
      expect(d.endsWith("Z")).toBe(true);
      // Centred: no coordinate escapes the half-box either side of the origin.
      for (const n of nums(d)) {
        expect(n).toBeGreaterThanOrEqual(-HULL_PX / 2 - 1e-6);
        expect(n).toBeLessThanOrEqual(HULL_PX / 2 + 1e-6);
      }
    }
  });

  test("the leaf is bezier, the polygon bodies are not", () => {
    expect(hullPathD("leaf", HULL_PX)).toContain("C");
    expect(hullPathD("dart", HULL_PX)).not.toContain("C");
  });

  test("each body draws a distinct path", () => {
    const ds = new Set(HULL_BODIES.map((b) => hullPathD(b, HULL_PX)));
    expect(ds.size).toBe(HULL_BODIES.length);
  });
});

describe("the type-body glyphs — geometry", () => {
  test("every polygon type-body differs from the dart", () => {
    const s = 26;
    const dart = JSON.stringify(bodyPoints("dart", s));
    for (const body of ["hsc-notch", "sar-heli", "house"] as const) {
      expect(JSON.stringify(bodyPoints(body, s))).not.toBe(dart);
    }
    // The leaf is a curved LEAF/teardrop, described by cubic Béziers rather than
    // a polygon: its starboard beam (segment 2's end) sits at a different point
    // than the dart's starboard base corner, so the two are a genuinely
    // different shape, not just a relabelling.
    expect(leafPoints(s).segments[2][2]).not.toEqual(hullDartPoints(s)[1]);
  });

  test("the leaf is a slender drop: pointed bow forward, a rounded stern aft", () => {
    // A pointed-bow water-drop: tapering to a POINT at the bow (forward, −y),
    // ROUNDED/bulbous at the stern (aft, +y) — fore-aft ASYMMETRIC, and that
    // asymmetry IS the heading cue this glyph carries. The sharp tip leads.

    // The bow is the forward point, on the centreline at −y — the sharp tip.
    expect(LEAF.bow[0]).toBe(0);
    expect(LEAF.bow[1]).toBeLessThan(0);

    // Four cubic segments forming a closed loop; the last returns to the bow.
    expect(LEAF.segments).toHaveLength(4);
    expect(LEAF.segments[3][2]).toEqual(LEAF.bow);

    // The aft tip (segment 1's end) is on the centreline, aft (+y).
    const aftTip = LEAF.segments[1][2];
    expect(aftTip[0]).toBe(0);
    expect(aftTip[1]).toBeGreaterThan(0);

    // Port/starboard symmetry: the port beam (segment 0's end) mirrors the
    // starboard beam (segment 2's end) about the centreline.
    const portBeam = LEAF.segments[0][2];
    const stbdBeam = LEAF.segments[2][2];
    expect(stbdBeam[0]).toBeGreaterThan(0);
    expect(portBeam[0]).toBe(-stbdBeam[0]);
    expect(portBeam[1]).toBe(stbdBeam[1]);

    // Slender: taller than wide — the bow reach (|y|) exceeds the beam (|x|).
    expect(Math.abs(LEAF.bow[1])).toBeGreaterThan(stbdBeam[0]);

    const s = 26;
    const { bow, segments } = leafPoints(s);
    // The bow tip is the topmost pixel (smallest canvas y) and the aft tip the
    // bottommost — the point leads, the rounded end trails.
    const aft = segments[1][2];
    expect(bow[1]).toBeLessThan(aft[1]);
    expect(aft[0]).toBeCloseTo(s / 2, 6); // aft tip on the box centre
    expect(bow[0]).toBeCloseTo(s / 2, 6); // bow on the box centre
    // The beam is AFT of amidships — down at the bulb, not at mid-length — which
    // is what makes the drop bulge aft and taper forward. Port mirrors starboard.
    const beamStbd = segments[2][2];
    const beamPort = segments[0][2];
    expect(beamStbd[1]).toBeGreaterThan((bow[1] + aft[1]) / 2);
    expect(beamStbd[0]).toBeGreaterThan(s / 2);
    expect(beamPort[0]).toBeCloseTo(s - beamStbd[0], 6);
    expect(beamPort[1]).toBeCloseTo(beamStbd[1], 6);
  });

  test("the leaf stays wholly inside its box", () => {
    // No control point or endpoint may push the traced outline past the canvas
    // edge, or it clips.
    const s = 26;
    const { bow, segments } = leafPoints(s);
    const pts: [number, number][] = [bow, ...segments.flat()];
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(s);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(s);
    }
  });

  test("the HSC body is the tanker house pentagon with a V-slot notched into the stern", () => {
    // One outline, six vertices — the cargo house (a pointed bow over a boxy
    // hull) plus one extra vertex where the transom is cut forward.
    expect(HSC_NOTCH).toHaveLength(1);
    const outline = HSC_NOTCH[0];
    expect(outline).toHaveLength(6);
    // Bow apex is the single most-forward vertex, on the centreline, at |y| = 10
    // like the dart's, house's and leaf's nose so all bodies share one scale.
    const minY = Math.min(...outline.map(([, y]) => y));
    expect(outline.filter(([, y]) => y === minY)).toEqual([[0, -10]]);
    expect(minY).toBe(Math.min(...HULL_DART.map(([, y]) => y)));
    // Boxy like the house: two vertices share the max x (a straight starboard
    // side) and their mirror shares the min x — parallel sides, not a taper.
    const maxX = Math.max(...outline.map(([x]) => x));
    const starboard = outline.filter(([x]) => x === maxX);
    expect(starboard.length).toBeGreaterThanOrEqual(2);
    // The SIGNATURE: a V-slot in the stern. The two quarters sit at the aftmost y
    // (max y) and mirror across the centreline; BETWEEN them on the centreline is
    // the notch vertex, pulled FORWARD (smaller y). This `[0, 5]` vertex is what
    // tells the express hull apart from the plain cargo house's flat transom.
    expect(outline).toContainEqual([0, 5]);
    const maxY = Math.max(...outline.map(([, y]) => y));
    const quarters = outline.filter(([, y]) => y === maxY);
    expect(quarters).toHaveLength(2); // the two stern corners
    expect(quarters.map(([x]) => x).sort((a, b) => a - b)).toEqual([-maxX, maxX]); // mirrored
    // The stern-centreline vertex sits FORWARD of the quarters — a V cut INTO the
    // transom, not a point hanging off the back.
    const sternCentre = outline.find(([x, y]) => x === 0 && y > 0) as [number, number];
    expect(sternCentre[1]).toBeLessThan(maxY);
  });

  test("the house is a pentagon: a pointed bow over a square, boxy hull", () => {
    // One outline, five vertices — a rectangle with a pointed top.
    expect(HOUSE).toHaveLength(1);
    const outline = HOUSE[0];
    expect(outline).toHaveLength(5);
    // The bow apex is the single most-forward vertex, on the centreline, and at
    // |y| = 10 like the dart's and leaf's nose so all bodies share a scale.
    const minY = Math.min(...outline.map(([, y]) => y));
    expect(outline.filter(([, y]) => y === minY)).toEqual([[0, -10]]);
    expect(minY).toBe(Math.min(...HULL_DART.map(([, y]) => y)));
    // The hull is BOXY: two vertices share the max x (a straight starboard side)
    // and their mirror shares the min x — parallel sides, not a taper. And the
    // transom is SQUARE: the two aftmost corners share a y and mirror across the
    // centreline, unlike the dart's single notch vertex.
    const maxX = Math.max(...outline.map(([x]) => x));
    const starboard = outline.filter(([x]) => x === maxX);
    expect(starboard.length).toBeGreaterThanOrEqual(2); // a parallel side, not a point
    const maxY = Math.max(...outline.map(([, y]) => y));
    const transom = outline.filter(([, y]) => y === maxY);
    expect(transom).toHaveLength(2);
    expect(transom.map(([x]) => x).sort((a, b) => a - b)).toEqual([-maxX, maxX]); // square, mirrored
  });

  test("the SAR helicopter is a nose-forward fuselage under a crossed rotor", () => {
    // Fuselage first, then two rotor blades — the crossed "×" that reads as a
    // helicopter from above.
    expect(SAR_HELI).toHaveLength(3);
    const [fuselage, blade1, blade2] = SAR_HELI;
    expect(fuselage[0]).toEqual([0, -8]); // nose on the centreline, forward
    expect(blade1).toHaveLength(4); // a thin quad
    expect(blade2).toHaveLength(4);
    // The blades cross: one leans right-forward, the other left-forward.
    expect(JSON.stringify(blade1)).not.toBe(JSON.stringify(blade2));
  });

  test("bodyPoints keeps every body wholly inside its box", () => {
    const s = 26;
    for (const body of ["dart", "hsc-notch", "sar-heli", "house"] as const) {
      for (const sp of bodyPoints(body, s)) {
        for (const [x, y] of sp) {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThanOrEqual(s);
          expect(y).toBeGreaterThanOrEqual(0);
          expect(y).toBeLessThanOrEqual(s);
        }
      }
    }
  });
});

describe("the helicopter rotor spins — the airframe does not", () => {
  test("the rotor angle moves the blades but never the fuselage", () => {
    const rest = sarHeliSubpaths(0);
    const turned = sarHeliSubpaths(37);
    // Fuselage (subpath 0) is byte-for-byte identical: only the blades turn.
    expect(turned[0]).toEqual(rest[0]);
    // Both blades have moved.
    expect(turned[1]).not.toEqual(rest[1]);
    expect(turned[2]).not.toEqual(rest[2]);
  });

  test("a half turn brings the two-blade rotor back onto itself", () => {
    // The rotor has 180° symmetry (two blades), so a 180° turn draws the same
    // pair of blades — which is why the size is taken over just a half-turn. The
    // vertices come back reordered, so compare the two blades as a point set.
    const bladeSet = (deg: number): string[] =>
      [...sarHeliSubpaths(deg)[1], ...sarHeliSubpaths(deg)[2]]
        .map(([x, y]) => `${x.toFixed(6)},${y.toFixed(6)}`)
        .sort();
    expect(bladeSet(180)).toEqual(bladeSet(0));
  });

  test("the spinning rotor never leaves the box, at any angle", () => {
    // The reason the reach is taken over a whole revolution: a blade swung
    // vertical reaches farther than the rest pose, and must still fit.
    const s = 26;
    for (let deg = 0; deg < 180; deg += 5) {
      for (const sp of bodyPoints("sar-heli", s, deg)) {
        for (const [x, y] of sp) {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThanOrEqual(s);
          expect(y).toBeGreaterThanOrEqual(0);
          expect(y).toBeLessThanOrEqual(s);
        }
      }
    }
  });

  test("SAR_HELI is the rest pose", () => {
    expect(SAR_HELI).toEqual(sarHeliSubpaths(0));
  });
});

describe("the type-body reaches the scene's icon", () => {
  const own: Vessel = { lng: 0, lat: 0, cogDeg: 0, sogMs: 0 };
  /** A target with no course, so its risk is a deterministic `unknown`. */
  const target = (patch: Partial<Vessel> & { mmsi?: string }): Vessel =>
    ({ lng: 0.01, lat: 0.01, ...patch }) as Vessel;

  test("a sailing vessel draws the leaf body, not the dart", () => {
    const scene = buildAisScene(own, [target({ shipTypeId: 36 })], settings());
    const props = symbolOf(scene);
    expect(props.icon).toBe(hullIcon("unknown", PAL, "leaf"));
    expect(props.icon).not.toBe(hullIcon("unknown", PAL));
    // Under sail with no status: the redundant mainsail overlay is dropped.
    expect(props.shape).toBeUndefined();
  });

  test("an anchored sailing vessel keeps its leaf body AND its anchor overlay", () => {
    const scene = buildAisScene(own, [target({ shipTypeId: 36, navStatus: "anchored" })], settings());
    const props = symbolOf(scene);
    expect(props.icon).toBe(hullIcon("unknown", PAL, "leaf"));
    expect(props.shape).toBe(shapeIcon("anchor", PAL));
  });

  test("a high-speed craft draws the notched-house body", () => {
    const scene = buildAisScene(own, [target({ shipTypeId: 45 })], settings());
    const props = symbolOf(scene);
    expect(props.icon).toBe(hullIcon("unknown", PAL, "hsc-notch"));
    // The express hull already reads as high-speed craft, so no chevron overlay.
    expect(props.shape).toBeUndefined();
  });

  test("a SAR aircraft draws the helicopter body, keyed by palette", () => {
    const scene = buildAisScene(own, [target({ mmsi: "111219123" })], settings({ palette: "night" }));
    const props = symbolOf(scene);
    expect(props.icon).toBe(hullIcon("off", "night", "sar-heli"));
    expect(props.shape).toBeUndefined();
  });

  test("a cargo/tanker draws the house body — and is still risk-coloured", () => {
    // The house is a VESSEL body: it stays in the risk/CPA path, unlike the
    // fixed-colour stations. Here, unassessable, so grey — but a grey HOUSE, not
    // a grey dart.
    const scene = buildAisScene(own, [target({ shipTypeId: 74 })], settings());
    const props = symbolOf(scene);
    expect(props.icon).toBe(hullIcon("unknown", PAL, "house"));
    expect(props.icon).not.toBe(hullIcon("unknown", PAL));
    expect(props.shape).toBeUndefined(); // no promoted day shape for a cargo hull
  });

  test("an ordinary vessel still gets the plain dart", () => {
    const scene = buildAisScene(own, [target({ shipTypeId: 60 })], settings());
    expect(symbolOf(scene).icon).toBe(hullIcon("unknown", PAL));
    expect(symbolOf(scene).icon).toBe(hullIcon("unknown", PAL, "dart"));
  });

  test("every type-body icon is distinct from the others and the dart", () => {
    const ids = new Set(
      (["dart", "leaf", "hsc-notch", "sar-heli", "house"] as const).map((b) => hullIcon("red", PAL, b)),
    );
    expect(ids.size).toBe(5);
  });
});

describe("stationSymbol — the non-vessel classes, from the MMSI grammar", () => {
  test("an AtoN MMSI (99…) is the diamond class", () => {
    expect(stationSymbol({ mmsi: "992191234" })).toBe("aton");
  });

  test("a coast / base station (00…) is the antenna class", () => {
    expect(stationSymbol({ mmsi: "002191000" })).toBe("coast");
  });

  test("SART, MOB and EPIRB all collapse onto the one emergency class", () => {
    expect(stationSymbol({ mmsi: "970315123" })).toBe("sart"); // AIS-SART
    expect(stationSymbol({ mmsi: "972315123" })).toBe("sart"); // MOB
    expect(stationSymbol({ mmsi: "974315123" })).toBe("sart"); // EPIRB-AIS
  });

  test("a ship, a SAR aircraft, and an absent MMSI are NOT stations", () => {
    // A plain ship flows through bodyShape; the SAR aircraft is a MOVING target
    // (the sar-heli body) and deliberately stays a vessel, not a fixed station.
    expect(stationSymbol({ mmsi: "219000001" })).toBeUndefined();
    expect(stationSymbol({ mmsi: "111219123" })).toBeUndefined();
    expect(stationSymbol({})).toBeUndefined();
  });
});

describe("the station glyphs — geometry", () => {
  test("the AtoN is a symmetric diamond with a centred +", () => {
    expect(ATON_DIAMOND).toHaveLength(4);
    const [top, right, bottom, left] = ATON_DIAMOND;
    // Diamond: top/bottom on the centreline and mirrored; left/right on the
    // waterline and mirrored.
    expect(top[0]).toBe(0);
    expect(bottom[0]).toBe(0);
    expect(top[1]).toBe(-bottom[1]);
    expect(right[1]).toBe(0);
    expect(left[1]).toBe(0);
    expect(right[0]).toBe(-left[0]);
    // The +: a horizontal and a vertical bar, each crossing and symmetric about
    // the origin.
    expect(ATON_PLUS).toHaveLength(2);
    const [horiz, vert] = ATON_PLUS;
    expect(horiz[0][1]).toBe(0);
    expect(horiz[1][1]).toBe(0);
    expect(horiz[0][0]).toBe(-horiz[1][0]);
    expect(vert[0][0]).toBe(0);
    expect(vert[1][0]).toBe(0);
    expect(vert[0][1]).toBe(-vert[1][1]);
  });

  test("the base station is an antenna: a mast, a Y fork, and a ground bar", () => {
    expect(ANTENNA).toHaveLength(4);
    const [mast, rightArm, leftArm, ground] = ANTENNA;
    // Mast vertical on the centreline.
    expect(mast[0][0]).toBe(0);
    expect(mast[1][0]).toBe(0);
    // The two arms fork from the SAME point and mirror across the centreline.
    expect(rightArm[0]).toEqual(leftArm[0]);
    expect(rightArm[1][0]).toBe(-leftArm[1][0]);
    expect(rightArm[1][1]).toBe(leftArm[1][1]);
    // Ground bar horizontal and centred.
    expect(ground[0][1]).toBe(ground[1][1]);
    expect(ground[0][0]).toBe(-ground[1][0]);
  });

  test("the SART is a disc crossed by a symmetric X", () => {
    expect(SART_RADIUS).toBeGreaterThan(0);
    expect(SART_CROSS).toHaveLength(2);
    const [a, b] = SART_CROSS;
    // Each diagonal passes through the origin (its endpoints are negatives).
    expect(a[0]).toEqual([-a[1][0], -a[1][1]]);
    expect(b[0]).toEqual([-b[1][0], -b[1][1]]);
    // Two different diagonals — a real X, not one line drawn twice.
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  test("every station glyph scales wholly inside its box", () => {
    const s = 22;
    for (const symbol of STATION_SYMBOLS) {
      const g = stationGlyph(symbol, s);
      const pts: [number, number][] = [...(g.polygon ?? []), ...g.fgMarks.flat(), ...g.fixedMarks.flat()];
      if (g.disc) {
        pts.push(
          [g.disc.cx - g.disc.r, g.disc.cy],
          [g.disc.cx + g.disc.r, g.disc.cy],
          [g.disc.cx, g.disc.cy - g.disc.r],
          [g.disc.cx, g.disc.cy + g.disc.r],
        );
      }
      for (const [x, y] of pts) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(s);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(s);
      }
    }
  });

  test("the station icons are all distinct, and distinct from a hull icon", () => {
    const ids = STATION_SYMBOLS.map((sym) => stationIcon(sym, PAL));
    expect(new Set(ids).size).toBe(STATION_SYMBOLS.length);
    for (const id of ids) expect(id).not.toBe(hullIcon("unknown", PAL));
  });

  test("the fixed colours: AtoN/coast neutral, SART the alarm red — never a risk verdict", () => {
    expect(STATION_COLORS.aton).toBe(AIS_COLORS.unknown);
    expect(STATION_COLORS.coast).toBe(AIS_COLORS.unknown);
    expect(STATION_COLORS.sart).toBe(AIS_COLORS.red);
    // None reads as a green "safe to pass" verdict.
    expect(STATION_COLORS.aton).not.toBe(AIS_COLORS.green);
    expect(STATION_COLORS.coast).not.toBe(AIS_COLORS.green);
  });
});

describe("stations render outside the risk/CPA machinery", () => {
  const own: Vessel = { lng: 0, lat: 0, cogDeg: 0, sogMs: 0 };
  const stationsOf = (scene: { targets: { features: Feature[] } }) => only(scene.targets.features, KIND.station);

  test("an AtoN draws one fixed diamond symbol, not a vessel hull", () => {
    const scene = buildAisScene(own, [{ lng: 0.01, lat: 0.01, mmsi: "992191234", name: "SafeWater" }], settings());
    expect(vesselFeatures(scene.targets.features)).toHaveLength(0);
    const [st] = stationsOf(scene);
    expect(st).toBeDefined();
    expect(st.properties?.icon).toBe(stationIcon("aton", PAL));
    expect(st.properties?.name).toBe("SafeWater");
  });

  test("a base station draws the antenna symbol, keyed by palette", () => {
    const scene = buildAisScene(own, [{ lng: 0.01, lat: 0.01, mmsi: "002191000" }], settings({ palette: "night" }));
    expect(stationsOf(scene)[0].properties?.icon).toBe(stationIcon("coast", "night"));
  });

  test("a SART draws the emergency circle-X symbol", () => {
    const scene = buildAisScene(own, [{ lng: 0.01, lat: 0.01, mmsi: "970315123" }], settings());
    expect(stationsOf(scene)[0].properties?.icon).toBe(stationIcon("sart", PAL));
  });

  test("an AtoN on a dangerous geometry is STILL never risk-coloured and never in the CPA figure", () => {
    // The heart of it. Give the AtoN a closing course — if it flowed through the
    // vessel path it would go red and hang a CPA line. It must do neither.
    const danger: Vessel = {
      lng: 0.2 * NM_TO_LAT,
      lat: 2 * NM_TO_LAT,
      cogDeg: 180,
      sogMs: 12 * KN_TO_MS,
      mmsi: "992191234",
    };
    const scene = buildAisScene(own, [danger], settings());
    expect(vesselFeatures(scene.targets.features)).toHaveLength(0);
    expect(stationsOf(scene)).toHaveLength(1);
    expect(only(scene.cpa.features, KIND.cpa)).toHaveLength(0);
    expect(only(scene.cpa.features, KIND.cpaPoint)).toHaveLength(0);
    expect(only(scene.targets.features, KIND.predictor)).toHaveLength(0);
    // And it wears no risk-hull icon under any name.
    for (const risk of ["green", "yellow", "red", "unknown", "off"] as const) {
      expect(stationsOf(scene)[0].properties?.icon).not.toBe(hullIcon(risk, PAL));
    }
  });

  test("a station grows no heading stick even when it reports a heading", () => {
    const scene = buildAisScene(own, [{ lng: 0.01, lat: 0.01, mmsi: "992191234", headingDeg: 90 }], settings());
    expect(stationsOf(scene)[0].properties).not.toHaveProperty("heading");
  });
});

describe("predictor — length is SOG x time", () => {
  test("a 6 kn boat at the 30 min default draws a 3 nm vector", () => {
    const v: Vessel = { lng: 12.6, lat: 55.9, cogDeg: 90, sogMs: 6 * KN_TO_MS };
    const end = predictorEnd(v, DEFAULT_SETTINGS.predictorMinutes);
    expect(end).toBeDefined();
    expectNm(distanceNm([v.lng, v.lat], end!), 3);
  });

  test("the default is half an hour, as the boat runs it", () => {
    expect(DEFAULT_SETTINGS.predictorMinutes).toBe(30);
  });

  test("length scales with the setting, not with anything hard-coded", () => {
    const v: Vessel = { lng: 12.6, lat: 55.9, cogDeg: 0, sogMs: 10 * KN_TO_MS };
    expectNm(distanceNm([v.lng, v.lat], predictorEnd(v, 60)!), 10);
    expectNm(distanceNm([v.lng, v.lat], predictorEnd(v, 30)!), 5);
    expectNm(distanceNm([v.lng, v.lat], predictorEnd(v, 6)!), 1);
  });

  test("it runs along COG, not heading — they are different lines", () => {
    // 6 kn due east over the ground while pointing north: the predictor goes
    // east. This is the whole reason both lines are drawn.
    const v: Vessel = { lng: 0, lat: 0, cogDeg: 90, headingDeg: 0, sogMs: 6 * KN_TO_MS };
    const end = predictorEnd(v, 60)!;
    expect(end[0]).toBeGreaterThan(0); // east
    expect(end[1]).toBeCloseTo(0, 4); // not north
  });

  test("no vector for a vessel with no course, or drifting below the SOG floor", () => {
    expect(predictorEnd({ lng: 0, lat: 0, sogMs: 5 }, 60)).toBeUndefined();
    expect(predictorEnd({ lng: 0, lat: 0, cogDeg: 90 }, 60)).toBeUndefined();
    expect(predictorEnd({ lng: 0, lat: 0, cogDeg: 90, sogMs: 0.05 }, 60)).toBeUndefined();
  });

  test("predictor 0 turns the vectors off", () => {
    const v: Vessel = { lng: 0, lat: 0, cogDeg: 90, sogMs: 6 * KN_TO_MS };
    expect(predictorEnd(v, 0)).toBeUndefined();
  });
});

describe("dead-reckoned ghost — where the target should be now", () => {
  // 10 kn due east, data received 60 s ago on the browser clock.
  const base = { lng: 12.6, lat: 55.9, cogDeg: 90, sogMs: 10 * KN_TO_MS };
  const RECEIVED = 1_000_000;
  const now = (ageMs: number) => RECEIVED + ageMs;

  test("runs forward along COG at SOG by the elapsed time — 10 kn x 60 s", () => {
    const g = ghostPosition({ ...base, receivedAtMs: RECEIVED }, now(60_000));
    expect(g).toBeDefined();
    // 10 kn for 60 s = 1/6 nm, and it must be to the EAST (cog 90), not north.
    expectNm(distanceNm([base.lng, base.lat], g!), 10 / 60);
    expect(g![0]).toBeGreaterThan(base.lng); // east
    expect(g![1]).toBeCloseTo(base.lat, 4); // not north
  });

  test("the ghost distance is the predictor's, per unit time (same geodesy)", () => {
    // 5 min of ghost age must reach exactly where a 5-min predictor points —
    // both are last-posn + COG*SOG*t, so they cannot disagree.
    const g = ghostPosition({ ...base, receivedAtMs: RECEIVED }, now(5 * 60_000))!;
    const p = predictorEnd(base as Vessel, 5)!;
    expect(g[0]).toBeCloseTo(p[0], 9);
    expect(g[1]).toBeCloseTo(p[1], 9);
  });

  test("no ghost without a receive stamp, a course, or any motion", () => {
    expect(ghostPosition({ ...base }, now(60_000))).toBeUndefined(); // no receivedAtMs
    expect(
      ghostPosition({ lng: 0, lat: 0, sogMs: 5, receivedAtMs: RECEIVED }, now(60_000)),
    ).toBeUndefined(); // no cog
    expect(
      ghostPosition({ lng: 0, lat: 0, cogDeg: 90, receivedAtMs: RECEIVED }, now(60_000)),
    ).toBeUndefined(); // no sog
    expect(
      ghostPosition({ lng: 0, lat: 0, cogDeg: 90, sogMs: 0.05, receivedAtMs: RECEIVED }, now(60_000)),
    ).toBeUndefined(); // below the at-rest floor
  });

  test("no ghost outside the age window — too fresh, or too stale to trust", () => {
    // Just-received data: the ghost would sit under the solid triangle.
    expect(
      ghostPosition({ ...base, receivedAtMs: RECEIVED }, now(GHOST_MIN_AGE_MS - 1)),
    ).toBeUndefined();
    // At the floor it appears; past the ceiling dead-reckoning error dominates.
    expect(ghostPosition({ ...base, receivedAtMs: RECEIVED }, now(GHOST_MIN_AGE_MS))).toBeDefined();
    expect(ghostPosition({ ...base, receivedAtMs: RECEIVED }, now(GHOST_MAX_AGE_MS))).toBeDefined();
    expect(
      ghostPosition({ ...base, receivedAtMs: RECEIVED }, now(GHOST_MAX_AGE_MS + 1)),
    ).toBeUndefined();
  });

  test("the setting gates the ghost feature, and it reuses the target's hull icon", () => {
    const own: Vessel = { lng: 12.6, lat: 55.9, cogDeg: 0, sogMs: 0 };
    const target = { ...base, receivedAtMs: RECEIVED };
    const nowMs = now(60_000);

    const off = buildAisScene(own, [target], settings({ showAisGhost: false }), nowMs);
    expect(only(off.targets.features, KIND.ghost)).toHaveLength(0);

    const on = buildAisScene(own, [target], settings({ showAisGhost: true }), nowMs);
    const ghosts = only(on.targets.features, KIND.ghost);
    expect(ghosts).toHaveLength(1);
    // Same hull icon as the solid target (body + risk colour + palette), faded
    // only by the layer's opacity — so a ghost is that same ship, translucent.
    const solid = symbolOf(on);
    expect(ghosts[0].properties?.icon).toBe(solid.icon);
    expect(ghosts[0].properties?.rotation).toBe(solid.rotation);
  });

  test("no clock (nowMs default 0) means no ghosts — the pure-function guard", () => {
    const own: Vessel = { lng: 12.6, lat: 55.9, cogDeg: 0, sogMs: 0 };
    const scene = buildAisScene(own, [{ ...base, receivedAtMs: RECEIVED }], settings({ showAisGhost: true }));
    expect(only(scene.targets.features, KIND.ghost)).toHaveLength(0);
  });
});

describe("heading stick — a direction, not a length", () => {
  const self: Vessel = { lng: 0, lat: 0, headingDeg: 42, cogDeg: 90, sogMs: 3 };

  test("carries the true heading, separately from the COG predictor", () => {
    const scene = buildAisScene(self, [], settings());
    const [ship] = vesselFeatures(scene.own.features);
    expect(ship.properties?.heading).toBe(42);
    // The predictor is a *different* line, along COG.
    expect(only(scene.own.features, KIND.predictor)).toHaveLength(1);
  });

  test("omitted — not zeroed — when off, or when the vessel never reported one", () => {
    // Absence is the layer filter: a `heading: 0` would grow a stick pointing north.
    const off = buildAisScene(self, [], settings({ showHeadingLine: false }));
    expect(vesselFeatures(off.own.features)[0].properties).not.toHaveProperty("heading");

    const noHdg = buildAisScene({ lng: 0, lat: 0, cogDeg: 90, sogMs: 3 }, [], settings());
    expect(vesselFeatures(noHdg.own.features)[0].properties).not.toHaveProperty("heading");
  });

  test("the hull is rotated to heading, falling back to COG", () => {
    expect(vesselFeatures(buildAisScene(self, [], settings()).own.features)[0].properties?.rotation).toBe(42);
    const noHdg: Vessel = { lng: 0, lat: 0, cogDeg: 137, sogMs: 3 };
    expect(vesselFeatures(buildAisScene(noHdg, [], settings()).own.features)[0].properties?.rotation).toBe(137);
  });

  test("own ship carries `ownShipScale` as its icon size; targets carry none", () => {
    const scene = buildAisScene(self, [{ lng: 0.01, lat: 0.01, cogDeg: 180, sogMs: 6 }], settings({ ownShipScale: 1.8 }));
    expect(vesselFeatures(scene.own.features)[0].properties?.size).toBe(1.8);
    // The layers coalesce a missing `size` to 1, so a target must not have one.
    for (const f of scene.targets.features) expect(f.properties).not.toHaveProperty("size");
  });
});

describe("risk colouring", () => {
  const own: Vessel = { lng: 0, lat: 0, cogDeg: 0, sogMs: 0 };
  /** A target `nm` north and `offsetNm` east, steaming due south at 12 kn — so
   * it passes `offsetNm` away from us, `nm / 12` hours from now. */
  const closing = (nm: number, offsetNm: number): Vessel => ({
    lng: offsetNm * NM_TO_LAT,
    lat: nm * NM_TO_LAT,
    cogDeg: 180,
    sogMs: 12 * KN_TO_MS,
  });

  test("a target that will pass close, soon, is red", () => {
    const scene = buildAisScene(own, [closing(2, 0.2)], settings());
    expect(symbolOf(scene).icon).toBe(hullIcon("red", PAL));
  });

  test("a SAR aircraft on a collision course stays fixed grey, with no CPA line", () => {
    const heli = { ...closing(2, 0.2), mmsi: "111219123" } as Vessel;
    const scene = buildAisScene(own, [heli], settings());
    expect(symbolOf(scene).icon).toBe(hullIcon("off", PAL, "sar-heli"));
    expect(only(scene.cpa.features, KIND.cpa)).toHaveLength(0);
    expect(only(scene.cpa.features, KIND.cpaPoint)).toHaveLength(0);
  });

  test("a target that will pass within the warning ring is yellow", () => {
    // CPA 0.9 nm at TCPA 10 min: outside the 0.8 nm danger ring, inside 1 nm.
    const scene = buildAisScene(own, [closing(2, 0.9)], settings());
    expect(symbolOf(scene).icon).toBe(hullIcon("yellow", PAL));
  });

  test("a target that will pass wide is green", () => {
    const scene = buildAisScene(own, [closing(2, 5)], settings());
    expect(symbolOf(scene).icon).toBe(hullIcon("green", PAL));
  });

  test("a RECEDING target is never red, whatever the thresholds say", () => {
    // Steaming away, having passed 0.2 nm off. Its CPA is a past fact.
    const receding: Vessel = {
      lng: 0.2 * NM_TO_LAT,
      lat: 2 * NM_TO_LAT,
      cogDeg: 0,
      sogMs: 12 * KN_TO_MS,
    };
    const scene = buildAisScene(own, [receding], settings());
    expect(symbolOf(scene).icon).toBe(hullIcon("green", PAL));
    // and no collision figure to go with it
    expect(only(scene.cpa.features, KIND.cpa)).toHaveLength(0);

    // Even with the rings opened wide enough to swallow it.
    const greedy = buildAisScene(own, [receding], boat({ danger_nm: 10, horizon_min: 60 }));
    expect(symbolOf(greedy).icon).not.toBe(hullIcon("red", PAL));
    expect(symbolOf(greedy).icon).toBe(hullIcon("green", PAL));
  });

  describe("thresholds are the boat's collision settings, not constants", () => {
    const target = closing(2, 0.9); // CPA 0.9 nm, TCPA 10 min

    test("widening the danger ring turns the same target red", () => {
      // Same boat, same geometry, same instant — only the setting differs.
      expect(symbolOf(buildAisScene(own, [target], settings())).icon).toBe(hullIcon("yellow", PAL));
      expect(symbolOf(buildAisScene(own, [target], boat({ danger_nm: 1.5 }))).icon).toBe(
        hullIcon("red", PAL),
      );
    });

    test("narrowing the warning ring turns the same target green", () => {
      expect(symbolOf(buildAisScene(own, [target], boat({ warning_nm: 0.6 }))).icon).toBe(
        hullIcon("green", PAL),
      );
    });

    test("pulling the warning horizon inside the TCPA turns the same target green", () => {
      // TCPA is 10 min; a 5 min look-ahead cannot see it yet.
      expect(symbolOf(buildAisScene(own, [target], boat({ warning_horizon_min: 5 }))).icon).toBe(
        hullIcon("green", PAL),
      );
    });

    test("the at-rest speed is the boat's too", () => {
      // A target creeping at 0.5 kn straight at us, 0.05 nm off: moving by
      // default, at rest (no course, so no closing) once the threshold is 1 kn.
      const creeping: Vessel = { lng: 0, lat: 0.05 * NM_TO_LAT, cogDeg: 180, sogMs: 0.5 * KN_TO_MS };
      const ownMoving: Vessel = { lng: 0, lat: 0, cogDeg: 90, sogMs: 0 };
      const moving = buildAisScene(ownMoving, [creeping], settings());
      const resting = buildAisScene(ownMoving, [creeping], boat({ at_rest_kn: 1 }));
      expect(symbolOf(moving).icon).toBe(hullIcon("red", PAL));
      expect(symbolOf(resting).icon).not.toBe(hullIcon("red", PAL));
    });

    test("riskThresholds maps the boat's four numbers onto the engine's four", () => {
      const t = riskThresholds({
        ...DEFAULT_COLLISION_SETTINGS,
        danger_nm: 0.4,
        horizon_min: 12,
        warning_nm: 3,
        warning_horizon_min: 25,
      });
      expect(t).toEqual({ redCpaNm: 0.4, redTcpaMin: 12, yellowCpaNm: 3, yellowTcpaMin: 25 });
    });
  });

  describe("the defaults", () => {
    test("are the server alarm's (CollisionConfig), so red on the chart is the alarm", () => {
      expect(DEFAULT_COLLISION_SETTINGS).toEqual({
        mode: "show",
        sound: true,
        publish: false,
        danger_nm: 0.8,
        horizon_min: 15,
        warning_nm: 1,
        warning_horizon_min: 30,
        at_rest_kn: 0.2,
      });
    });

    test("a dead-on collision is yellow half an hour out and red inside the alarm's 15 min", () => {
      // Closing at 12 kn straight down our track: CPA 0. 6 nm = 30 min, 2 nm = 10 min.
      expect(symbolOf(buildAisScene(own, [closing(6, 0)], settings())).icon).toBe(hullIcon("yellow", PAL));
      expect(symbolOf(buildAisScene(own, [closing(2, 0)], settings())).icon).toBe(hullIcon("red", PAL));
    });
  });

  test("switching risk colour off makes every target one neutral colour", () => {
    const scene = buildAisScene(own, [closing(2, 0.2)], settings({ showAisRisk: false }));
    expect(symbolOf(scene).icon).toBe(hullIcon("off", PAL));
    // ...but the collision figure STAYS. Colour and the CPA line are orthogonal:
    // per-device `showAisRisk` owns the hull colour, the boat's mode (default
    // "tell") owns the line. Turning colour off is not the same as going quiet
    // — that is a separate control, tested in "CPA mode gates the collision line" below.
    expect(only(scene.cpa.features, KIND.cpa).length).toBeGreaterThan(0);
  });
});

describe("CPA mode gates the collision line", () => {
  const own: Vessel = { lng: 0, lat: 0, cogDeg: 0, sogMs: 0 };
  // A target that will pass close, soon — red under the default thresholds, so
  // it is exactly the one that draws the collision figure. Same geometry as the
  // "risk colouring" red case; only the boat's mode moves.
  const red: Vessel = {
    lng: 0.2 * NM_TO_LAT,
    lat: 2 * NM_TO_LAT,
    cogDeg: 180,
    sogMs: 12 * KN_TO_MS,
  };

  test("off — no collision line, even for a red target", () => {
    const scene = buildAisScene(own, [red], boat({ mode: "off" }));
    // Still red, still drawn as a target — only the line is gone.
    expect(symbolOf(scene).icon).toBe(hullIcon("red", PAL));
    expect(only(scene.cpa.features, KIND.cpa)).toHaveLength(0);
    expect(only(scene.cpa.features, KIND.cpaPoint)).toHaveLength(0);
  });

  test("show — the collision line is drawn (the alarm is core.ts's to suppress)", () => {
    const scene = buildAisScene(own, [red], boat({ mode: "show" }));
    expect(only(scene.cpa.features, KIND.cpa)).toHaveLength(1);
  });

  test("tell — the collision line is drawn", () => {
    const scene = buildAisScene(own, [red], boat({ mode: "tell" }));
    expect(only(scene.cpa.features, KIND.cpa)).toHaveLength(1);
  });

  test("the line is orthogonal to risk colour — off colour, on line", () => {
    const scene = buildAisScene(own, [red], {
      ...boat({ mode: "show" }),
      showAisRisk: false,
    });
    expect(symbolOf(scene).icon).toBe(hullIcon("off", PAL)); // neutral hull
    expect(only(scene.cpa.features, KIND.cpa)).toHaveLength(1); // line still there
  });
});

describe("risk 'unknown' — never green, never safe-looking", () => {
  const own: Vessel = { lng: 0, lat: 0, cogDeg: 0, sogMs: 0 };

  test("a target with no course is grey, not green", () => {
    // Class B minimal / an AtoN / a target heard once: position and nothing else.
    const scene = buildAisScene(own, [{ lng: 0.01, lat: 0.01 }], settings());
    const props = symbolOf(scene);
    expect(props.icon).toBe(hullIcon("unknown", PAL));
    expect(props.icon).not.toBe(hullIcon("green", PAL));
  });

  test("the unknown colour is distinct from every risk colour", () => {
    expect(AIS_COLORS.unknown).not.toBe(AIS_COLORS.green);
    expect(AIS_COLORS.unknown).not.toBe(AIS_COLORS.yellow);
    expect(AIS_COLORS.unknown).not.toBe(AIS_COLORS.red);
  });

  test("a vessel holding station alongside is unknown, not green", () => {
    // Identical course and speed: no relative motion, so there is no closest
    // approach in time. cpa.ts refuses to answer; we must not paint it safe.
    const parallel: Vessel = { lng: 0.001, lat: 0.001, cogDeg: 90, sogMs: 5 };
    const alongside: Vessel = { lng: 0, lat: 0, cogDeg: 90, sogMs: 5 };
    const scene = buildAisScene(alongside, [parallel], settings());
    expect(symbolOf(scene).icon).toBe(hullIcon("unknown", PAL));
  });

  test("with no own position, targets are unknown rather than safe", () => {
    const scene = buildAisScene(null, [{ lng: 0.01, lat: 0.01, cogDeg: 90, sogMs: 5 }], settings());
    expect(symbolOf(scene).icon).toBe(hullIcon("unknown", PAL));
  });

  test("a ghost — non-finite position — is dropped, not drawn at null island", () => {
    // The colour was never the bug: cpa.ts validates positions, so a ghost
    // already scored `unknown`. The geometry was. [NaN, NaN] serialises to
    // [null, null] through setData — corrupt GeoJSON, and the cost is not the
    // ghost but every other target in the same collection.
    const ghost: Vessel = { lng: NaN, lat: NaN, cogDeg: 180, sogMs: 6 };
    const scene = buildAisScene(own, [ghost], settings());
    expect(scene.targets.features).toHaveLength(0);
  });

  test("a ghost never takes the red target down with it", () => {
    // The whole reason the filter exists. One unplaceable vessel in the list
    // must not cost us the one we needed to see.
    const ghost: Vessel = { lng: NaN, lat: Infinity, cogDeg: 180, sogMs: 6 };
    const danger: Vessel = { lng: 0.2 * NM_TO_LAT, lat: 2 * NM_TO_LAT, cogDeg: 180, sogMs: 12 * KN_TO_MS };
    const scene = buildAisScene(own, [ghost, danger], settings());
    expect(symbolOf(scene).icon).toBe(hullIcon("red", PAL));
    expect(only(scene.cpa.features, KIND.cpa)).toHaveLength(1);
  });

  test("every coordinate in the scene is a real number", () => {
    // The property that matters, asserted directly rather than via a shape:
    // nothing non-finite may reach setData, from any vessel, by any path.
    const scene = buildAisScene(own, [
      { lng: NaN, lat: NaN, cogDeg: 180, sogMs: 6 },
      { lng: 0.2 * NM_TO_LAT, lat: 2 * NM_TO_LAT, cogDeg: 180, sogMs: 12 * KN_TO_MS },
    ], settings());
    for (const f of [...scene.own.features, ...scene.targets.features, ...scene.cpa.features]) {
      const coords =
        f.geometry.type === "Point"
          ? [(f.geometry as Point).coordinates]
          : (f.geometry as LineString).coordinates;
      for (const [lng, lat] of coords) {
        expect(Number.isFinite(lng)).toBe(true);
        expect(Number.isFinite(lat)).toBe(true);
      }
    }
  });

  test("an own ship with no fix makes every target unknown, and draws no own ship", () => {
    // Own ship is the other half: unplaceable own ship means nothing can be
    // assessed against it. Grey, not green — and no own-ship symbol at [null,
    // null] either.
    const ghostSelf: Vessel = { lng: NaN, lat: NaN, cogDeg: 0, sogMs: 5 };
    const scene = buildAisScene(ghostSelf, [{ lng: 0.01, lat: 0.01, cogDeg: 180, sogMs: 6 }], settings());
    expect(scene.own.features).toHaveLength(0);
    expect(symbolOf(scene).icon).toBe(hullIcon("unknown", PAL));
    expect(symbolOf(scene).icon).not.toBe(hullIcon("green", PAL));
  });

  test("still shows its day shape and name — unknown risk is not unknown vessel", () => {
    const scene = buildAisScene(own, [{ lng: 0.01, lat: 0.01, navStatus: "anchored", name: "Ea" }], settings());
    const props = symbolOf(scene);
    expect(props.shape).toBe(shapeIcon("anchor", PAL));
    expect(props.name).toBe("Ea");
  });
});

describe("the collision figure", () => {
  const own: Vessel = { lng: 0, lat: 0, cogDeg: 0, sogMs: 6 * KN_TO_MS };

  test("a red target gets a CPA line between both boats' future positions", () => {
    // Crossing from the east, 2 nm off, at 12 kn: it will cross our bow.
    const target: Vessel = { lng: 2 * NM_TO_LAT, lat: 1 * NM_TO_LAT, cogDeg: 270, sogMs: 12 * KN_TO_MS };
    const scene = buildAisScene(own, [target], settings());
    expect(symbolOf(scene).icon).toBe(hullIcon("red", PAL));

    const [line] = only(scene.cpa.features, KIND.cpa);
    expect(line).toBeDefined();
    const coords = (line.geometry as LineString).coordinates;
    expect(coords).toHaveLength(2);
    // The line's length IS the miss distance — that is what makes it worth drawing.
    expect(distanceNm(coords[0], coords[1])).toBeLessThan(DEFAULT_COLLISION_SETTINGS.danger_nm);
    // Neither end is where the boats are now: both were run forward to the CPA.
    expect(distanceNm(coords[0], [own.lng, own.lat])).toBeGreaterThan(0.1);

    // A dot at each end, so the figure reads as two positions and a gap.
    const dots = only(scene.cpa.features, KIND.cpaPoint);
    expect(dots).toHaveLength(2);
    expect((dots[0].geometry as Point).coordinates).toEqual(coords[0]);
    expect((dots[1].geometry as Point).coordinates).toEqual(coords[1]);
  });

  test("yellow and green targets get none — the figure is rare on purpose", () => {
    const yellow: Vessel = { lng: 1 * NM_TO_LAT, lat: 2 * NM_TO_LAT, cogDeg: 180, sogMs: 12 * KN_TO_MS };
    const scene = buildAisScene(own, [yellow], settings());
    expect(symbolOf(scene).icon).toBe(hullIcon("yellow", PAL));
    expect(only(scene.cpa.features, KIND.cpa)).toHaveLength(0);
    expect(only(scene.cpa.features, KIND.cpaPoint)).toHaveLength(0);
  });

  test("the CPA figure lives in the `cpa` collection, NOT the target source", () => {
    // The split that stops the ~73-feature target source being re-parsed at GPS
    // rate: the collision figure is redrawn every own-ship fix, so it must not
    // ride the target source. The red target's hull still IS in `targets`.
    const target: Vessel = { lng: 2 * NM_TO_LAT, lat: 1 * NM_TO_LAT, cogDeg: 270, sogMs: 12 * KN_TO_MS };
    const scene = buildAisScene(own, [target], settings());
    expect(symbolOf(scene).icon).toBe(hullIcon("red", PAL)); // hull stays in targets
    // No CPA feature anywhere in the target collection...
    expect(only(scene.targets.features, KIND.cpa)).toHaveLength(0);
    expect(only(scene.targets.features, KIND.cpaPoint)).toHaveLength(0);
    // ...it is all in the dedicated cpa collection.
    expect(only(scene.cpa.features, KIND.cpa)).toHaveLength(1);
    expect(only(scene.cpa.features, KIND.cpaPoint)).toHaveLength(2);
  });

  test("an own-ship-only move leaves the target collection byte-identical", () => {
    // The heart of the optimisation, as a property. Own ship moves (a GPS tick)
    // while the target stays put and stays red: the target source's JSON is
    // UNCHANGED — so scenePush's dedup skips its `setData` and MapLibre reparses
    // none of the 73 — while the CPA figure (own-ship-dependent) DOES change.
    const target: Vessel = { lng: 2 * NM_TO_LAT, lat: 1 * NM_TO_LAT, cogDeg: 270, sogMs: 12 * KN_TO_MS };
    const before = buildAisScene(own, [target], settings());
    const ownMoved: Vessel = { ...own, lat: 0.001 * NM_TO_LAT }; // nudged north
    const after = buildAisScene(ownMoved, [target], settings());

    // Both still red — no risk flip to muddy the comparison.
    expect(symbolOf(before).icon).toBe(hullIcon("red", PAL));
    expect(symbolOf(after).icon).toBe(hullIcon("red", PAL));
    // The target collection did not change at all — this is what dedup skips on.
    expect(JSON.stringify(after.targets)).toBe(JSON.stringify(before.targets));
    // The CPA figure DID change — both boats ran forward from a new own position.
    expect(JSON.stringify(after.cpa)).not.toBe(JSON.stringify(before.cpa));
  });
});

describe("the scene as a whole", () => {
  test("own ship is never risk-coloured", () => {
    const scene = buildAisScene({ lng: 0, lat: 0, cogDeg: 0, sogMs: 3 }, [], settings());
    const [ship] = vesselFeatures(scene.own.features);
    expect(ship.properties?.icon).toBe(ownShipIcon(PAL));
    expect(only(scene.own.features, KIND.predictor)[0].properties?.color).toBe(
      symbolColors(PAL).ui,
    );
  });

  test("own ship turns grey when the link is lost", () => {
    const self: Vessel = { lng: 0, lat: 0, cogDeg: 0, sogMs: 3 };
    const stale = buildAisScene(self, [], settings(), 0, true);
    expect(vesselFeatures(stale.own.features)[0].properties?.icon).toBe(ownShipIcon(PAL, true));
    expect(ownShipIcon(PAL, true)).not.toBe(ownShipIcon(PAL));
  });

  test("no own ship, no own features", () => {
    expect(buildAisScene(null, [], settings()).own.features).toHaveLength(0);
  });

  test("each target's predictor is coloured by its own risk", () => {
    const own: Vessel = { lng: 0, lat: 0, cogDeg: 0, sogMs: 0 };
    const red: Vessel = { lng: 0, lat: 2 * NM_TO_LAT, cogDeg: 180, sogMs: 12 * KN_TO_MS };
    const green: Vessel = { lng: 5 * NM_TO_LAT, lat: 2 * NM_TO_LAT, cogDeg: 180, sogMs: 12 * KN_TO_MS };
    const scene = buildAisScene(own, [red, green], settings());
    const colors = only(scene.targets.features, KIND.predictor).map((f) => f.properties?.color);
    expect(colors).toEqual([AIS_COLORS.red, AIS_COLORS.green]);
  });
});

/**
 * The palette reaching the targets — the bug this half of the file exists for.
 *
 * On a night chart the AIS targets were the brightest thing on the screen by a
 * wide margin: white halos and a day-pinned label colour, both hard-coded, on
 * an otherwise properly dark chart. The fix is that the *halo* follows the
 * palette while the *risk colours* do not, and both halves are pinned here —
 * the second one at least as firmly as the first, because dimming a red target
 * into a tasteful night palette would be a safety regression, and it is exactly
 * the kind of tasteful that a future reskin would think it was fixing.
 */
describe("the palette reaches the targets", () => {
  const named = (): Vessel => ({ lng: 0, lat: 0, cogDeg: 0, sogMs: 3, name: "SÆRIMNER" });
  const own: Vessel = { lng: 0, lat: 0, cogDeg: 0, sogMs: 0 };

  /** WCAG relative luminance — "how much light does this throw at the eye".
   *  Notation via the production parser: the theme tables are `#rrggbb` since
   *  task zrtxyypv, and what is measured here is light, not format. */
  function luminance(css: string): number {
    const rgb = s52ColourToRgb(css);
    if (!rgb) throw new Error(`unparsed colour: ${css}`);
    const [r, g, b] = rgb.map((c) => {
      const v = c / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  test("the halo inverts: bright on day, dark at night", () => {
    // The bug, as a number. The day halo is nearly white and should stay that
    // way; the night halo has to be dark or it *is* the glare.
    expect(luminance(symbolColors("day").uiHalo)).toBeGreaterThan(0.5);
    expect(luminance(symbolColors("night").uiHalo)).toBeLessThan(0.01);
    expect(luminance(symbolColors("dusk").uiHalo)).toBeLessThan(0.01);
  });

  test("the foreground inverts with it, so the pair never collapses", () => {
    // Day: dark ink on a light halo. Night: light ink on a dark one. If these
    // ever moved the same way the symbol would vanish into its own halo.
    for (const palette of ["day", "dusk", "night"] as const) {
      const { ui, uiHalo } = symbolColors(palette);
      const gap = Math.abs(luminance(ui) - luminance(uiHalo));
      expect(gap, `${palette}: ui ${ui} vs halo ${uiHalo}`).toBeGreaterThan(0.02);
    }
    expect(luminance(symbolColors("day").ui)).toBeLessThan(
      luminance(symbolColors("day").uiHalo),
    );
    expect(luminance(symbolColors("night").ui)).toBeGreaterThan(
      luminance(symbolColors("night").uiHalo),
    );
  });

  test("a red target is still literally red at night — the safety rule", () => {
    // Not "reddish", not "the night table's LITRD" (which is rgb(59,17,10), a
    // dark brown). The alarm colour does not have a night column, on purpose.
    const collision: Vessel = { lng: 0, lat: 2 * NM_TO_LAT, cogDeg: 180, sogMs: 12 * KN_TO_MS };
    for (const palette of ["day", "dusk", "night"] as const) {
      const scene = buildAisScene(own, [collision], settings({ palette }));
      expect(symbolOf(scene).icon).toBe(hullIcon("red", palette));
      expect(only(scene.targets.features, KIND.predictor)[0].properties?.color).toBe(
        AIS_COLORS.red,
      );
    }
    expect(AIS_COLORS.red).toBe("rgb(255, 0, 0)");
  });

  test("the whole risk ladder is palette-independent", () => {
    // The colours a mariner acts on. If a reskin ever makes this fail, the
    // reskin is wrong.
    expect(RISK_COLORS).toEqual({
      green: AIS_COLORS.green,
      yellow: AIS_COLORS.yellow,
      red: AIS_COLORS.red,
      unknown: AIS_COLORS.unknown,
    });
    // and they stay legible rather than sinking into the night chart
    for (const risk of ["green", "yellow", "red"] as const) {
      expect(luminance(RISK_COLORS[risk]), risk).toBeGreaterThan(0.1);
    }
  });

  test("a target's label and halo come from the palette, not from the day table", () => {
    const day = symbolOf(buildAisScene(own, [named()], settings({ palette: "day" })));
    const night = symbolOf(buildAisScene(own, [named()], settings({ palette: "night" })));
    expect(day.name).toBe("SÆRIMNER");
    expect(day.textColor).toBe(symbolColors("day").ui);
    expect(day.haloColor).toBe(symbolColors("day").uiHalo);
    expect(night.textColor).toBe(symbolColors("night").ui);
    expect(night.haloColor).toBe(symbolColors("night").uiHalo);
    // the actual regression: a white halo behind the name at night
    expect(luminance(String(night.haloColor))).toBeLessThan(0.01);
  });

  test("an unnamed target carries no label colours to draw with", () => {
    const props = symbolOf(buildAisScene(own, [{ lng: 0, lat: 0 }], settings()));
    expect(props.name).toBeUndefined();
    expect(props.textColor).toBeUndefined();
    expect(props.haloColor).toBeUndefined();
  });

  test("every icon a feature asks for is keyed by palette", () => {
    // The images are registered per palette up front (signalkShips.ts), so a
    // feature naming an unkeyed icon would silently draw nothing.
    const scene = buildAisScene(named(), [{ ...named(), headingDeg: 90, navStatus: "anchored" }], settings({ palette: "night" }));
    const target = symbolOf(scene);
    expect(target.icon).toBe(hullIcon("unknown", "night"));
    expect(target.shape).toBe(shapeIcon("anchor", "night"));
    expect(target.stick).toBe(headingStickIcon("night"));
    expect(vesselFeatures(scene.own.features)[0].properties?.icon).toBe(ownShipIcon("night"));
  });

  test("the CPA balls' ring follows the palette while the balls stay red", () => {
    const collision: Vessel = { lng: 0, lat: 2 * NM_TO_LAT, cogDeg: 180, sogMs: 12 * KN_TO_MS };
    const scene = buildAisScene(own, [collision], settings({ palette: "night" }));
    const points = only(scene.cpa.features, KIND.cpaPoint);
    expect(points).not.toHaveLength(0);
    for (const p of points) {
      expect(p.properties?.haloColor).toBe(symbolColors("night").uiHalo);
    }
  });
});

describe("vesselColors: a theme may dim the vessel ladder, never reorder it", () => {
  // User: AIS targets and own boat "way too bright and not night theme at all".
  test("a theme without `vessels` keeps the fixed AIS_COLORS ladder", () => {
    expect(vesselColors("day")).toBe(AIS_COLORS);
    expect(riskColor("day", "red")).toBe(AIS_COLORS.red);
    expect(riskColor("day", "off")).toBe(AIS_COLORS.unknown);
  });

  test("the night variants use their own, darker table", () => {
    for (const p of ["modern-paper-2-night-dim", "modern-paper-2-night-red", "modern-paper-2-moonlight"] as const) {
      const V = vesselColors(p);
      expect(V).not.toBe(AIS_COLORS);
      expect(riskColor(p, "green")).toBe(V.green);
      expect(riskColor(p, "off")).toBe(V.unknown);
      expect(stationColor(p, "sart")).toBe(V.red);
      expect(stationColor(p, "aton")).toBe(V.unknown);
    }
  });
});
