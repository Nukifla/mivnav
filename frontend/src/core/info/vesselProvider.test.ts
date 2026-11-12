/**
 * The vessel provider: what a mariner is told about a ship, and the two ways
 * they can ask.
 *
 * The provider takes its vessels, its thresholds and its projection as
 * arguments, so there is no map, no WebGL, no DOM and — importantly — no
 * `mock.module`, which bun leaks across every other test file in the run.
 *
 * What is actually pinned here, beyond the arithmetic:
 *
 *  - `detail` resolves from `hit.id` **alone**, with no payload. That is the
 *    difference between a panel that opens on a tap and one that also opens
 *    from a target list, a search or a collision alarm — the entry point the
 *    seam promised and the one the user asked for next.
 *  - Own ship is a subject, not a special case.
 *  - A target that reported almost nothing degrades to what it did report,
 *    never to "undefined".
 *  - `risk: "unknown"` never reads as safe. `cpa.ts` spends a discriminated
 *    union making that unrepresentable; the last chance to give it away is
 *    here, in the rendering.
 */

import { describe, expect, test } from "bun:test";
import type { Vessel } from "../signalk";
import { rankHits } from "./rank";
import { locateHit, queryInfoAt, resolveDetail } from "./registry";
import type { InfoDetail, InfoHit, InfoPoint, InfoQuery, InfoProvider } from "./types";
import { markBuddy, OWN_SHIP_ID, vesselsFromSignalK, cpaVessel, type AisVessel } from "./vessel";
import { buildAisScene, KIND, type AisSettings } from "../layers/aisSymbols";
import { DEFAULT_COLLISION_SETTINGS, riskThresholds } from "../collisionSettings";
import { DEFAULT_SETTINGS } from "../style/settings";
import { computeCpa } from "../cpa";
import {
  createVesselInfoProvider,
  DEFAULT_CPA_THRESHOLDS,
  formatDistanceNm,
  formatLatLng,
  formatTcpaMin,
  vesselInfoHit,
  VESSEL_PROVIDER_ID,
} from "./vesselProvider";
import { bearingDeg } from "../chrome/geo";

// The Øresund, where the boat sails.
const OWN_LAT = 55.9;
const OWN_LNG = 12.6;

/** 10 knots in SignalK's m/s. Named, because `5.144` in a literal is exactly
 * the units mix-up cpa.ts's naming convention exists to prevent. */
const KN_10_MS = (10 * 1852) / 3600;

const QUERY: InfoQuery = { point: { x: 100, y: 100 }, lngLat: { lng: OWN_LNG, lat: OWN_LAT }, radius: 8 };

/** The ITU's name for MID 219/220. Verbatim; see ../mmsi.ts. */
const DENMARK_NAME = "Denmark";

/**
 * A fake projection: 1 screen pixel per 0.001° in both axes, centred on the
 * query point. Enough to place a vessel exactly N pixels from a tap, which is
 * the only thing hit-testing needs a projection for.
 */
const project = (p: InfoPoint) => ({
  x: 100 + (p.lng - OWN_LNG) * 1000,
  y: 100 - (p.lat - OWN_LAT) * 1000,
});

function providerOver(vessels: readonly AisVessel[]): InfoProvider {
  return createVesselInfoProvider({
    vessels: () => vessels,
    thresholds: () => DEFAULT_CPA_THRESHOLDS,
    project,
  });
}

/** Own ship, stationary at the query point unless told otherwise. */
function self(extra: Partial<AisVessel> = {}): AisVessel {
  return { id: OWN_SHIP_ID, self: true, lat: OWN_LAT, lng: OWN_LNG, sogMs: 0, ...extra };
}

function target(extra: Partial<AisVessel> = {}): AisVessel {
  return { id: "mmsi:265123456", lat: OWN_LAT, lng: OWN_LNG, ...extra };
}

/** All rows of a resolved detail, flattened — the panel renders sections, the
 * assertions mostly care about the label/value pairs. */
function rows(detail: InfoDetail): Record<string, string> {
  const out: Record<string, string> = {};
  for (const section of detail.sections) for (const row of section.rows) out[row.label] = row.value;
  return out;
}

function section(detail: InfoDetail, label: string) {
  return detail.sections.find((s) => s.label === label);
}

// ---- formatting ------------------------------------------------------------

describe("units", () => {
  test("nautical miles, and metres under one — chrome/geo.ts's formatRange, shared", () => {
    expect(formatDistanceNm(2.5)).toBe("2.50 nm");
    // Two decimal places throughout nm now (was 1dp above 10 nm before this
    // shared with chrome/geo.ts's formatRange — the range-precision unification).
    expect(formatDistanceNm(12.34)).toBe("12.34 nm");
    // 0.2 nm is 370.4 m — a CPA a mariner reads in metres, not in 0.20 nm.
    expect(formatDistanceNm(0.2)).toBe("370 m");
    expect(formatDistanceNm(0.999)).toBe("1850 m");
    expect(formatDistanceNm(1)).toBe("1.00 nm");
  });

  test("a past TCPA is phrased as past, not as a small number", () => {
    // The classic CPA bug's cousin: "-4 min" reads as imminent at a glance.
    expect(formatTcpaMin(-4)).toBe("4.0 min ago");
    expect(formatTcpaMin(4)).toBe("in 4.0 min");
    expect(formatTcpaMin(0.25)).toBe("in 15 s");
    expect(formatTcpaMin(95)).toBe("in 1 h 35 min");
  });

  test("a TCPA that rounds to zero seconds reads 'now', not 'in 0 s' or '0 s ago'", () => {
    // Closest approach is happening: "in 0 s" reads as a countdown that never
    // fires and "0 s ago" as already receding — both wrong. It is simply now.
    expect(formatTcpaMin(0)).toBe("now");
    // Tiny positive and tiny negative both round to 0 s → "now".
    expect(formatTcpaMin(0.005)).toBe("now"); // 0.3 s → rounds to 0
    expect(formatTcpaMin(-0.005)).toBe("now");
    // Just past the half-second rounding boundary still reads as seconds.
    expect(formatTcpaMin(0.01)).toBe("in 1 s"); // 0.6 s → rounds to 1
  });

  test("positions are degrees and decimal minutes, as written on a chart", () => {
    expect(formatLatLng(55.9, 12.6)).toBe("55° 54.000' N  012° 36.000' E");
    expect(formatLatLng(-33.5, -70.25)).toBe("33° 30.000' S  070° 15.000' W");
    // 59.9999' must roll into the next degree rather than print as 60.000'.
    expect(formatLatLng(55.99999999, 0)).toBe("56° 00.000' N  000° 00.000' E");
  });
});

describe("bearingDeg", () => {
  const from = { lat: OWN_LAT, lng: OWN_LNG };
  test("the four cardinals", () => {
    expect(Math.round(bearingDeg(from, { lat: OWN_LAT + 0.1, lng: OWN_LNG }))).toBe(0);
    expect(Math.round(bearingDeg(from, { lat: OWN_LAT, lng: OWN_LNG + 0.1 }))).toBe(90);
    expect(Math.round(bearingDeg(from, { lat: OWN_LAT - 0.1, lng: OWN_LNG }))).toBe(180);
    expect(Math.round(bearingDeg(from, { lat: OWN_LAT, lng: OWN_LNG - 0.1 }))).toBe(270);
  });

  test("the antimeridian is a short hop east, not most of the way round", () => {
    const b = bearingDeg({ lat: 0, lng: 179.9 }, { lat: 0, lng: -179.9 });
    expect(Math.round(b)).toBe(90);
  });
});

// ---- hit-testing -----------------------------------------------------------

describe("queryAt", () => {
  test("a tap on a ship finds it; a tap a long way off does not", () => {
    const p = providerOver([target({ name: "Kolga" })]);
    expect(p.queryAt(QUERY)).toHaveLength(1);
    expect(p.queryAt({ ...QUERY, point: { x: 400, y: 400 } })).toHaveLength(0);
  });

  test("the tolerance covers the symbol, not just the point under it", () => {
    // The seam's radius is 8 px, sized for a 1 px depth contour. The target
    // triangle is ~22 px, so a finger on its visible edge is ~11 px out.
    const p = providerOver([target({ lng: OWN_LNG + 0.011 })]); // 11 px east
    expect(p.queryAt(QUERY)).toHaveLength(1);
  });

  test("nearest first, so a tap between two ships answers with the nearer", () => {
    const p = providerOver([
      target({ id: "far", lng: OWN_LNG + 0.01 }),
      target({ id: "near", lng: OWN_LNG + 0.002 }),
    ]);
    expect(p.queryAt(QUERY).map((h) => h.id)).toEqual(["near", "far"]);
  });

  test("own ship is hit-tested like any other vessel", () => {
    const hits = providerOver([self({ name: "Mivnav" })]).queryAt(QUERY);
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe(OWN_SHIP_ID);
    expect(hits[0].title).toBe("Mivnav");
    expect(hits[0].subtitle).toBe("Own ship");
  });
});

// ---- priority: the ranker never hears of AIS -------------------------------

describe("priority", () => {
  /** Own ship 10 nm south, making 10 kn north; the target's own motion sets
   * the case. 0.1° of latitude is 6 nm. */
  const closing = () => [
    self({ lat: OWN_LAT - 0.1, lng: OWN_LNG, cogDeg: 0, sogMs: 5.144 }), // 10 kn north
    target({ lat: OWN_LAT - 0.05, cogDeg: 180, sogMs: 5.144 }), // 10 kn south, head-on
  ];

  test("a target on a collision course is a danger and outranks a charted wreck", () => {
    const vessels = closing();
    const wreck: InfoHit = {
      providerId: "chart",
      id: "wreck",
      priority: "hazard",
      precision: "area",
      title: "Wreck",
    };
    const chart: InfoProvider = {
      id: "chart",
      label: "Chart",
      queryAt: () => [wreck],
      detail: () => ({ sections: [] }),
    };
    // The query point is where the target is, not where own ship is.
    const q = { ...QUERY, point: project({ lat: OWN_LAT - 0.05, lng: OWN_LNG }) };
    const ranked = queryInfoAt([providerOver(vessels), chart], q);
    expect(ranked[0].id).toBe("mmsi:265123456");
    expect(ranked[0].priority).toBe("danger");
  });

  test("a receding target is traffic, not a danger, however close it just came", () => {
    // Same geometry, target already past and opening: cpa.ts returns green for
    // any negative TCPA, so this must not be a danger.
    const vessels = [
      self({ lat: OWN_LAT, lng: OWN_LNG, cogDeg: 0, sogMs: 5.144 }),
      target({ lat: OWN_LAT + 0.01, cogDeg: 0, sogMs: 10.3 }), // ahead, faster, same way
    ];
    const hits = providerOver(vessels).queryAt({ ...QUERY, point: project({ lat: OWN_LAT + 0.01, lng: OWN_LNG }) });
    expect(hits[0].priority).toBe("traffic");
  });

  test("a target with no course or speed is traffic — unknown is not evidence of danger", () => {
    const vessels = [self({ cogDeg: 0, sogMs: 5.144 }), target({ lng: OWN_LNG + 0.001 })];
    const hits = providerOver(vessels).queryAt(QUERY);
    const t = hits.find((h) => h.id === "mmsi:265123456")!;
    expect(t.priority).toBe("traffic");
  });

  test("a non-vessel station is traffic, not a danger, even on a closing course", () => {
    // An AtoN with a course put dead on a collision line. It is not a collision
    // target — no CPA, no danger priority. If this ever reads "danger" the
    // panel is calling a charted buoy a threat.
    const vessels = [
      self({ lat: OWN_LAT - 0.1, lng: OWN_LNG, cogDeg: 0, sogMs: 5.144 }),
      target({ id: "mmsi:992191234", mmsi: "992191234", lat: OWN_LAT - 0.05, cogDeg: 180, sogMs: 5.144 }),
    ];
    const hits = providerOver(vessels).queryAt({ ...QUERY, point: project({ lat: OWN_LAT - 0.05, lng: OWN_LNG }) });
    const t = hits.find((h) => h.id === "mmsi:992191234")!;
    expect(t.priority).toBe("traffic");
  });

  test("rank.ts orders the vessel hits without knowing what a vessel is", () => {
    const danger: InfoHit = { ...vesselInfoHit("a"), priority: "danger" };
    const traffic: InfoHit = vesselInfoHit("b");
    expect(rankHits([traffic, danger]).map((h) => h.id)).toEqual(["a", "b"]);
  });
});

// ---- detail from id alone: the non-map entry point --------------------------

describe("detail", () => {
  test("resolves the full record from id alone, with no payload", async () => {
    const vessels = [
      target({
        name: "Kolga",
        mmsi: "265123456",
        callsign: "SBQP",
        imo: "IMO 9074729",
        shipType: "Cargo",
        shipTypeId: 70,
        aisClass: "A",
        flag: "SE",
        lengthM: 120,
        beamM: 18.5,
        draftM: 6.2,
        navStatus: "motoring",
        destination: "COPENHAGEN",
        etaIso: "2026-07-18T14:30:00Z",
        cogDeg: 45,
        sogMs: 6.17,
        headingDeg: 47,
        rotDegPerMin: -3,
      }),
    ];
    // Exactly what a target list, a search result or an alarm builds: an id
    // and nothing else. No query, no click, no payload.
    const providers = [providerOver(vessels)];
    const hit = vesselInfoHit("mmsi:265123456");
    expect(hit.payload).toBeUndefined();

    const detail = await resolveDetail(providers, hit);
    expect(detail.title).toBe("Kolga");
    const r = rows(detail);
    expect(r["MMSI"]).toBe("265123456");
    expect(r["Call sign"]).toBe("SBQP");
    expect(r["IMO"]).toBe("IMO 9074729");
    expect(r["Ship type"]).toBe("Cargo (70)");
    expect(r["AIS class"]).toBe("A");
    // Derived from the MMSI, and shown next to the flag the vessel reports
    // rather than instead of it — see `vesselRows`.
    expect(r["Country"]).toBe("Sweden");
    expect(r["Flag"]).toBe("SE");
    expect(r["Length"]).toBe("120 m");
    expect(r["Beam"]).toBe("18.5 m");
    expect(r["Draft"]).toBe("6.2 m");
    expect(r["Status"]).toBe("Motoring");
    expect(r["Destination"]).toBe("COPENHAGEN");
    expect(r["ETA"]).toBe("2026-07-18 14:30 UTC");
    expect(r["COG"]).toBe("045°");
    expect(r["SOG"]).toBe("12.0 kn");
    expect(r["Heading"]).toBe("047°");
    expect(r["Rate of turn"]).toBe("-3°/min");
  });

  test("the registry routes a hand-built hit to this provider and no other", async () => {
    const providers = [
      { id: "chart", label: "Chart", queryAt: () => [], detail: () => ({ sections: [] }) },
      providerOver([target({ name: "Kolga" })]),
    ];
    const detail = await resolveDetail(providers, vesselInfoHit("mmsi:265123456"));
    expect(detail.title).toBe("Kolga");
  });

  test("detail reads the live record, not the tap's snapshot of it", async () => {
    // A hit carries a payload for free, but the target has moved by the time
    // the panel renders. The live list wins.
    let vessels: AisVessel[] = [target({ name: "Kolga", sogMs: 5 })];
    const p = createVesselInfoProvider({
      vessels: () => vessels,
      thresholds: () => DEFAULT_CPA_THRESHOLDS,
      project,
    });
    const hit = p.queryAt(QUERY)[0];
    expect(hit.payload).toBeDefined();
    vessels = [target({ name: "Kolga", sogMs: 10 })];
    expect(rows(await p.detail(hit))["SOG"]).toBe("19.4 kn");
  });

  test("an id that no longer resolves says so instead of showing a stale record as live", async () => {
    const detail = await resolveDetail([providerOver([])], vesselInfoHit("mmsi:1"));
    expect(rows(detail)["Vessel"]).toBe("no longer being received");
  });

  test("a tapped target that then expires is marked as last-heard, not silently frozen", async () => {
    let vessels: AisVessel[] = [target({ name: "Kolga" })];
    const p = createVesselInfoProvider({
      vessels: () => vessels,
      thresholds: () => DEFAULT_CPA_THRESHOLDS,
      project,
    });
    const hit = p.queryAt(QUERY)[0];
    vessels = [];
    const detail = await p.detail(hit);
    expect(detail.title).toBe("Kolga");
    expect(rows(detail)["Note"]).toContain("no longer being received");
  });
});

// ---- own ship is a subject --------------------------------------------------

describe("own ship", () => {
  test("is the vessel that says it is — not the one whose MMSI matches ours", async () => {
    const detail = await providerOver([self({ name: "Mivnav", mmsi: "265999999" })]).detail(
      vesselInfoHit(OWN_SHIP_ID),
    );
    expect(detail.title).toBe("Mivnav");
    expect(detail.subtitle).toBe("Own ship · MMSI 265999999");
    expect(rows(detail)["MMSI"]).toBe("265999999");
  });

  test("an unnamed own ship is still identifiable", async () => {
    const detail = await providerOver([self()]).detail(vesselInfoHit(OWN_SHIP_ID));
    expect(detail.title).toBe("Own ship");
    expect(detail.subtitle).toBe("Own ship");
  });

  test("has no collision section — a boat does not have a CPA with itself", async () => {
    const detail = await providerOver([self({ name: "Mivnav" })]).detail(vesselInfoHit(OWN_SHIP_ID));
    expect(section(detail, "Collision")).toBeUndefined();
  });

  test("shows what it is NOT transmitting: absent AIS fields are blanks, not omissions", async () => {
    // The user's actual ask — "see what ais data you send out". A missing MMSI
    // is the answer to that question, and an omitted row cannot give it.
    const detail = await providerOver([self()]).detail(vesselInfoHit(OWN_SHIP_ID));
    const r = rows(detail);
    expect(r["MMSI"]).toBe("—");
    expect(r["Call sign"]).toBe("—");
    expect(r["Ship type"]).toBe("—");
    expect(r["Destination"]).toBe("—");
  });

  test("a target's absent fields are omitted, not blanked — it simply did not say", async () => {
    const detail = await providerOver([target({ name: "Kolga" })]).detail(
      vesselInfoHit("mmsi:265123456"),
    );
    const r = rows(detail);
    expect(r["MMSI"]).toBeUndefined();
    expect(r["Call sign"]).toBeUndefined();
    expect(Object.values(r)).not.toContain("—");
  });
});

// ---- partial data ----------------------------------------------------------

describe("country of origin", () => {
  // The MMSI grammar itself is pinned in ../mmsi.test.ts. This is the panel's
  // half: that the row is derived, reaches the reader, and stays silent when
  // there is nothing true to say.
  const countryOf = async (v: AisVessel) =>
    rows(await resolveDetail([providerOver([v])], vesselInfoHit(v.id)))["Country"];

  test("a target's country comes from its MMSI, with no help from the wire", async () => {
    // `target()` sets no `flag` — the country is derived or it is nothing.
    expect(await countryOf(target({ id: "a", mmsi: "219000001" }))).toBe("Denmark");
    expect(await countryOf(target({ id: "b", mmsi: "232098765" }))).toBe(
      "United Kingdom of Great Britain and Northern Ireland",
    );
  });

  test("an AtoN is shown as the country that owns it, not as a bogus one", async () => {
    // 99MIDXXXX. A first-three-digits reader would say nothing here; the
    // buoy is Danish and saying so is the point of parsing the format.
    expect(await countryOf(target({ id: "aton", mmsi: "992191234", aisClass: "ATON" }))).toBe(DENMARK_NAME);
  });

  test("an AIS-SART gets no country row at all", async () => {
    // The row must be *absent*, not blank and not guessed. A distress beacon
    // captioned with a country invented from a manufacturer id is the worst
    // thing this feature could do.
    expect(await countryOf(target({ id: "sart", mmsi: "970265123" }))).toBeUndefined();
  });

  test("an unknown MID leaves the row off rather than guessing", async () => {
    expect(await countryOf(target({ id: "u", mmsi: "299000001" }))).toBeUndefined();
  });

  test("a target with no MMSI has no country row", async () => {
    expect(await countryOf(target({ id: "n", name: "Kolga" }))).toBeUndefined();
  });

  test("own ship's country is blank rather than missing when it cannot be derived", async () => {
    // Own ship's rows are blanked, not omitted (see `push`): "my AIS is
    // transmitting no usable MMSI" is the answer the skipper opened this for.
    const r = rows(await resolveDetail([providerOver([self({ mmsi: "265999999" })])], vesselInfoHit(OWN_SHIP_ID)));
    expect(r["Country"]).toBe("Sweden");

    const blank = rows(await resolveDetail([providerOver([self()])], vesselInfoHit(OWN_SHIP_ID)));
    expect(blank["Country"]).toBe("—");
  });
});

describe("a target that reported almost nothing", () => {
  /** A Class B minimal: a position and not one other field. */
  const minimal = [target({ id: "at:55.90000,12.60000" })];

  test("renders what it has, and no 'undefined' anywhere", async () => {
    const p = providerOver(minimal);
    const hit = p.queryAt(QUERY)[0];
    expect(hit.title).toBe("AIS target");
    const detail = await p.detail(hit);
    const all = detail.sections.flatMap((s) => s.rows.map((row) => `${row.label}: ${row.value}`));
    expect(all.join(" ")).not.toContain("undefined");
    expect(all.join(" ")).not.toContain("NaN");
    // Position is unconditional: a vessel without one is never published, so
    // the panel is never empty however little else the target said.
    expect(rows(detail)["Position"]).toBe("55° 54.000' N  012° 36.000' E");
  });

  test("surfaces how long since the target was last received, off a LOCAL clock", async () => {
    // Received 45 s before the (injected, static) clock reads.
    const receivedAtMs = 1_000_000;
    const p = createVesselInfoProvider({
      vessels: () => [target({ receivedAtMs })],
      thresholds: () => DEFAULT_CPA_THRESHOLDS,
      project,
      now: () => receivedAtMs + 45_000,
    });
    const detail = await p.detail(vesselInfoHit("mmsi:265123456"));
    expect(rows(detail)["Last received"]).toBe("45 s ago");
  });

  test("own ship gets no 'Last received' row — it is a fact about a remote station", async () => {
    const p = createVesselInfoProvider({
      vessels: () => [self({ receivedAtMs: 1_000_000 })],
      thresholds: () => DEFAULT_CPA_THRESHOLDS,
      project,
      now: () => 1_060_000,
    });
    const detail = await p.detail(vesselInfoHit(OWN_SHIP_ID));
    expect(rows(detail)["Last received"]).toBeUndefined();
  });

  test("empty sections drop out rather than rendering as headings over nothing", async () => {
    const detail = await providerOver(minimal).detail(vesselInfoHit("at:55.90000,12.60000"));
    expect(section(detail, "Vessel")?.rows ?? []).toHaveLength(0);
    expect(section(detail, "Voyage")?.rows ?? []).toHaveLength(0);
  });

  test("a nameless target with an MMSI is titled by the number you would call it on", async () => {
    const p = providerOver([target({ mmsi: "265123456" })]);
    expect(p.queryAt(QUERY)[0].title).toBe("MMSI 265123456");
  });

  test("a target with no COG/SOG still gets a range and a bearing", async () => {
    const vessels = [self({ cogDeg: 0, sogMs: 5.144 }), target({ lat: OWN_LAT + 0.05 })];
    const detail = await providerOver(vessels).detail(vesselInfoHit("mmsi:265123456"));
    const r = rows(detail);
    expect(r["Range"]).toBe("3.00 nm");
    expect(r["Bearing"]).toBe("000°");
    expect(r["CPA"]).toBeUndefined();
  });

  test("no own ship: no collision section at all, rather than an empty verdict", async () => {
    const detail = await providerOver([target({ name: "Kolga" })]).detail(
      vesselInfoHit("mmsi:265123456"),
    );
    // "We cannot assess this because we do not know where we are" and "we
    // assessed it and cannot say" are different claims; only the second is a
    // Collision row.
    expect(section(detail, "Collision")).toBeUndefined();
  });

  test("a non-vessel station gets no Collision section — it is not a collision target", async () => {
    // Own ship is known and the AtoN even has a course, so a vessel would get a
    // Collision section. An AtoN is not a vessel: no CPA is assessed, so there is
    // nothing to say and the section is absent — not an "unknown CPA" row, which
    // would imply we tried and failed to assess a threat that was never one.
    const vessels = [self({ cogDeg: 0, sogMs: 5.144 }), target({ id: "aton", mmsi: "992191234", cogDeg: 180, sogMs: 5.144 })];
    const detail = await providerOver(vessels).detail(vesselInfoHit("aton"));
    expect(section(detail, "Collision")).toBeUndefined();
  });
});

// ---- unknown is never safe --------------------------------------------------

describe("risk: unknown never presents as safe", () => {
  const cases: [string, AisVessel[], string][] = [
    [
      "target reports no course or speed",
      [self({ cogDeg: 0, sogMs: 5.144 }), target({ lat: OWN_LAT + 0.01 })],
      "target reports no course or speed",
    ],
    [
      "own ship has no course or speed",
      [self({ sogMs: undefined }), target({ lat: OWN_LAT + 0.01, cogDeg: 180, sogMs: 5 })],
      "own course or speed not known",
    ],
    [
      "identical course and speed: the separation never changes",
      [
        self({ cogDeg: 90, sogMs: 5 }),
        target({ lat: OWN_LAT + 0.001, cogDeg: 90, sogMs: 5 }),
      ],
      "no relative motion",
    ],
    [
      "a NaN position — what signalk.ts hands us before the first fix",
      [self({ cogDeg: 0, sogMs: 5 }), target({ lat: NaN, lng: NaN, cogDeg: 180, sogMs: 5 })],
      "position not known",
    ],
  ];

  for (const [name, vessels, reason] of cases) {
    test(name, async () => {
      const detail = await providerOver(vessels).detail(vesselInfoHit("mmsi:265123456"));
      const collision = section(detail, "Collision")!;
      // The section exists: an absent collision section would read as "nothing
      // to say", and nothing to say about a collision reads as safe.
      expect(collision).toBeDefined();
      const risk = collision.rows.find((r) => r.label === "Collision risk")!;
      expect(risk.value).toContain("unknown");
      expect(risk.value).toContain(reason);
      // Never the word a mariner would relax at, and never quiet.
      expect(risk.value).not.toContain("low");
      expect(risk.emphasis).toBe(true);
    });
  }

  test("a NaN-positioned target is not hit-testable either", () => {
    const p = providerOver([target({ lat: NaN, lng: NaN })]);
    // NaN distance <= radius is false — the negated comparison in queryAt.
    // Without it, a vessel of unknown position would answer a tap anywhere.
    expect(p.queryAt(QUERY)).toHaveLength(0);
  });
});

// ---- a red target ----------------------------------------------------------

describe("a closing target", () => {
  test("reads CPA, TCPA, aspect and risk, with the safety rows called out", async () => {
    // Head-on, 4 nm apart, 10 kn each — cpa.ts's known-answer geometry at a
    // range that is unambiguously an emergency: closing at 20 kn, so CPA 0 and
    // TCPA 12 min, inside the 0.5 nm / 20 min red thresholds with room to
    // spare. (The arithmetic is checkable with a pencil: 4 nm / 20 kn = 0.2 h.)
    const vessels = [
      self({ lat: OWN_LAT, lng: OWN_LNG, cogDeg: 0, sogMs: KN_10_MS }),
      target({ lat: OWN_LAT + 4 / 60, lng: OWN_LNG, cogDeg: 180, sogMs: KN_10_MS, name: "Kolga" }),
    ];
    const detail = await providerOver(vessels).detail(vesselInfoHit("mmsi:265123456"));
    const collision = section(detail, "Collision")!;
    const r = Object.fromEntries(collision.rows.map((row) => [row.label, row]));
    expect(r["Range"].value).toBe("4.00 nm");
    expect(r["Bearing"].value).toBe("000°");
    expect(r["CPA"].value).toBe("0 m");
    expect(r["TCPA"].value).toBe("in 12 min");
    expect(r["Collision risk"].value).toBe("high");
    expect(r["CPA"].emphasis).toBe(true);
    expect(r["TCPA"].emphasis).toBe(true);
    expect(r["Collision risk"].emphasis).toBe(true);
    // The verdict rides in the subtitle, so it is read before the sections.
    expect(detail.subtitle).toBe("CPA 0 m in 12 min");
  });

  test("the aspect is phrased as what WE do — the sign trap in cpa.ts", async () => {
    // Own ship north-bound at 10 kn. The target is 5 nm up our track and
    // 10 nm east of it, west-bound at 10 kn: it has 10 nm to run to the
    // crossing and we have 5, so *we* get there first and cut across its bow.
    // The literal mariner meaning of "we pass ahead", cross-checked against
    // cpa.ts's own independent track-intersection definition in its tests.
    const vessels = [
      self({ lat: OWN_LAT, lng: OWN_LNG, cogDeg: 0, sogMs: KN_10_MS }),
      target({
        lat: OWN_LAT + 5 / 60,
        lng: OWN_LNG + 10 / 60 / Math.cos((OWN_LAT * Math.PI) / 180),
        cogDeg: 270,
        sogMs: KN_10_MS,
      }),
    ];
    const detail = await providerOver(vessels).detail(vesselInfoHit("mmsi:265123456"));
    const aspect = section(detail, "Collision")!.rows.find((r) => r.label === "Aspect")!;
    // We get to the crossing first, so we pass ahead of it.
    expect(aspect.value).toBe("we pass ahead of it");
  });
});

// ---- the two live lookups ---------------------------------------------------

describe("locate", () => {
  /** A provider over a list the test can swap under it — a SignalK tick,
   * without SignalK. */
  function providerOverMutable(initial: AisVessel[]) {
    let vessels = initial;
    const provider = createVesselInfoProvider({
      vessels: () => vessels,
      thresholds: () => DEFAULT_CPA_THRESHOLDS,
      project,
    });
    return { provider, tick: (next: AisVessel[]) => (vessels = next) };
  }

  test("answers where the ship is now, not where the tap found it", () => {
    const { provider, tick } = providerOverMutable([target({ lng: OWN_LNG })]);
    const [hit] = queryInfoAt([provider], QUERY);
    expect(hit.lngLat).toEqual({ lng: OWN_LNG, lat: OWN_LAT });

    tick([target({ lng: OWN_LNG + 0.01 })]);
    // The hit still carries the old position, as a snapshot should. `locate`
    // is the live answer, and it is the one `locateHit` takes.
    expect(hit.lngLat).toEqual({ lng: OWN_LNG, lat: OWN_LAT });
    expect(locateHit([provider], hit)).toEqual({ lng: OWN_LNG + 0.01, lat: OWN_LAT });
  });

  test("a target that stops resolving is unplaceable — the snapshot is not a fallback", () => {
    const { provider, tick } = providerOverMutable([target()]);
    const [hit] = queryInfoAt([provider], QUERY);
    expect(hit.lngLat).toBeDefined();

    tick([]); // expired, or a positional id (see `vesselId`) whose ship moved
    // A marker left on `hit.lngLat` would be pointing at open water and
    // claiming a ship is in it.
    expect(locateHit([provider], hit)).toBeUndefined();
  });

  test("resolves from an id alone — the list/alarm entry point places its marker too", () => {
    const { provider } = providerOverMutable([self(), target({ lat: OWN_LAT + 0.02 })]);
    expect(locateHit([provider], vesselInfoHit("mmsi:265123456"))).toEqual({
      lng: OWN_LNG,
      lat: OWN_LAT + 0.02,
    });
    expect(locateHit([provider], vesselInfoHit(OWN_SHIP_ID))).toEqual({ lng: OWN_LNG, lat: OWN_LAT });
  });
});

describe("watch", () => {
  /** What `watch` reads is the whole of its contract, and reading is only
   * observable from inside a tracking scope — so this counts the reads. What
   * the *panel* then does with them is ./detail.test.ts. */
  function reads() {
    const seen: string[] = [];
    const provider = createVesselInfoProvider({
      vessels: () => (seen.push("vessels"), [self(), target()]),
      thresholds: () => (seen.push("thresholds"), DEFAULT_CPA_THRESHOLDS),
      project,
    });
    provider.watch?.(vesselInfoHit("mmsi:265123456"));
    return seen;
  }

  test("reads the whole picture, not just the target's own record", () => {
    // Own ship is in that list, and its delta changes a target's range,
    // bearing, CPA and TCPA while the target itself sends nothing.
    expect(reads()).toContain("vessels");
  });

  test("reads the thresholds — they are what turn a CPA into a risk", () => {
    expect(reads()).toContain("thresholds");
  });

  test("a chart provider declares none, and so is subscribed to nothing", () => {
    const chart: InfoProvider = {
      id: "chart",
      label: "Chart",
      queryAt: () => [],
      detail: () => ({ sections: [] }),
    };
    expect(chart.watch).toBeUndefined();
  });
});

// ---- the wire adapter -------------------------------------------------------

describe("vesselsFromSignalK", () => {
  const wire = (v: Partial<Vessel> = {}): Vessel => ({ lng: OWN_LNG, lat: OWN_LAT, ...v });

  test("own ship is the self slot, and its id is a constant", () => {
    const [me] = vesselsFromSignalK(wire({ name: "Mivnav" }), []);
    expect(me.id).toBe(OWN_SHIP_ID);
    expect(me.self).toBe(true);
    // Stable even on a boat whose own MMSI is never configured — which is
    // exactly the boat whose skipper wants to check what it transmits.
    expect(me.mmsi).toBeUndefined();
  });

  test("no self slot means no own ship, not a fabricated one", () => {
    expect(vesselsFromSignalK(null, [wire()])).toHaveLength(1);
    expect(vesselsFromSignalK(null, [wire()])[0].self).toBeUndefined();
  });

  test("today's wire has no vessel key, so identity falls back to position", () => {
    // Documented degradation, not an accident: unique within a snapshot (two
    // vessels cannot share a position without having collided) but stable only
    // until the target moves. The backend follow-up — put the tracker's own
    // vessel key back on the wire — is what makes it durable.
    const [t] = vesselsFromSignalK(null, [wire({ lat: 55.912345678 })]);
    expect(t.id).toBe("at:55.91235,12.60000");
  });

  test("a vessel key or an MMSI on the wire is used the moment it arrives", () => {
    // No frontend change needed: the extra keys are already the contract.
    const withKey = { ...wire(), id: "urn:mrn:imo:mmsi:265123456" } as Vessel;
    expect(vesselsFromSignalK(null, [withKey])[0].id).toBe("urn:mrn:imo:mmsi:265123456");
    const withMmsi = { ...wire(), mmsi: "265123456" } as Vessel;
    expect(vesselsFromSignalK(null, [withMmsi])[0].id).toBe("mmsi:265123456");
  });

  test("name never becomes an identity — two ships sharing one must stay two", () => {
    const two = vesselsFromSignalK(null, [
      wire({ name: "Sea Ray", lat: 55.9 }),
      wire({ name: "Sea Ray", lat: 55.91 }),
    ]);
    expect(new Set(two.map((v) => v.id)).size).toBe(2);
  });

  test("the provider id is stamped by the registry, not trusted from the hit", () => {
    const hits = queryInfoAt([providerOver([target()])], QUERY);
    expect(hits[0].providerId).toBe(VESSEL_PROVIDER_ID);
  });
});

// ---- the panel's verdict tracks the CHART's (the boat's) thresholds ---------
//
// The bug this pins: the info panel once fell back to `DEFAULT_CPA_THRESHOLDS`
// while the chart hull was coloured by other thresholds, so a tapped target
// could read a different verdict than its own hull colour. Both now read the
// boat's collision settings (`riskThresholds(signalk.collisionSettings())` in
// attach.tsx); this asserts that with those same thresholds the provider's
// verdict matches the chart, and that it would NOT have matched under the
// default it used to fall back to.

describe("collision verdict agrees with the chart hull under the settings thresholds", () => {
  // The chart draws the hull as `ais-hull-<risk>-<palette>` (aisSymbols.hullIcon,
  // dart body) — read the risk the chart actually painted, not one recomputed.
  function chartHullRisk(settings: AisSettings): string {
    const scene = buildAisScene(own, [tgt], settings);
    const hull = scene.targets.features.find((f) => f.properties?.kind === KIND.vessel);
    const icon = hull?.properties?.icon as string;
    return icon.split("-")[2]; // ["ais","hull",<risk>,<palette>]
  }

  // A moving own ship and a crossing target on a parallel track offset ~1.5 nm
  // north, catching up from behind — a real, positive-TCPA closing geometry.
  const own = self({ sogMs: KN_10_MS / 2, cogDeg: 90 });
  const tgt = target({ lat: OWN_LAT + 0.025, lng: OWN_LNG - 0.02, sogMs: KN_10_MS, cogDeg: 90 });

  // Read the actual CPA once so the thresholds straddle it, rather than pinning a
  // geometry that could drift.
  const base = computeCpa(cpaVessel(own), cpaVessel(tgt), { thresholds: DEFAULT_CPA_THRESHOLDS });

  test("the geometry gives a real, future closest approach", () => {
    expect(base.kind).toBe("computed");
    expect(base.tcpaMin).toBeGreaterThan(0);
    // And the default calls it safe — the pre-fix panel state we are correcting.
    expect(base.risk).not.toBe("red");
  });

  // Settings whose thresholds call THIS target red; the default (0.5/20) does not.
  const settings: AisSettings = {
    ...DEFAULT_SETTINGS,
    showAisRisk: true,
    collision: {
      ...DEFAULT_COLLISION_SETTINGS,
      danger_nm: (base.cpaNm ?? 0) + 0.5,
      horizon_min: Math.ceil((base.tcpaMin ?? 0) + 5),
      warning_nm: (base.cpaNm ?? 0) + 1,
      warning_horizon_min: Math.ceil((base.tcpaMin ?? 0) + 5),
    },
  };

  test("provider fed the boat's riskThresholds reports the chart's hull risk", async () => {
    const p = createVesselInfoProvider({
      vessels: () => [own, tgt],
      thresholds: () => riskThresholds(settings.collision),
      project,
    });
    const detail = await p.detail(vesselInfoHit("mmsi:265123456"));

    // Chart painted red; panel says "high" (RISK_LABEL.red) — they agree.
    expect(chartHullRisk(settings)).toBe("red");
    expect(rows(detail)["Collision risk"]).toBe("high");
  });

  test("the default fallback would have DISAGREED — the wiring is load-bearing", async () => {
    const p = createVesselInfoProvider({
      vessels: () => [own, tgt],
      thresholds: () => DEFAULT_CPA_THRESHOLDS,
      project,
    });
    const detail = await p.detail(vesselInfoHit("mmsi:265123456"));
    // Same tap, same target, same chart hull (red) — but the unwired default
    // verdict is not "high". That mismatch is exactly the bug.
    expect(rows(detail)["Collision risk"]).not.toBe("high");
  });
});

describe("feature actions on a vessel's panel", () => {
  const boat = { id: "b", lat: 56, lng: 10, mmsi: "219654321" };
  const provider = (vessels: { id: string; lat: number; lng: number; mmsi: string }[]) =>
    createVesselInfoProvider({
      vessels: () => vessels,
      thresholds: () => DEFAULT_CPA_THRESHOLDS,
      project: () => ({ x: 0, y: 0 }),
      actions: () => [{ label: "Add to buddies", run: () => {} }],
    });
  const hit = { ...vesselInfoHit("b"), payload: boat };

  test("a live boat offers them", async () => {
    const detail = await provider([boat]).detail(hit);
    expect(detail.footerActions?.map((a) => a.label)).toEqual(["Add to buddies"]);
    expect(detail.actions).toBeUndefined();
  });
  test("a boat no longer being received does not", async () => {
    expect((await provider([]).detail(hit)).footerActions).toBeUndefined();
  });
});

describe("the order a mariner reads a target in", () => {
  const me = { id: "self", self: true, lat: 56, lng: 10, cogDeg: 0, sogMs: 5 };
  const target = { id: "t", lat: 56.1, lng: 10, cogDeg: 180, sogMs: 5, mmsi: "219654321", lengthM: 12 };
  const provider = createVesselInfoProvider({
    vessels: () => [me, target],
    thresholds: () => DEFAULT_CPA_THRESHOLDS,
    project: () => ({ x: 0, y: 0 }),
  });

  test("collision first, then motion, and what the boat is last", async () => {
    const detail = await provider.detail(vesselInfoHit("t"));
    expect(detail.sections.map((s) => s.label)).toEqual(["Collision", "Position", "Voyage", "Vessel"]);
    expect(detail.sections[0]!.rows.map((r) => r.label)).toEqual([
      "Range", "Bearing", "CPA", "TCPA", "Aspect", "Collision risk",
    ]);
    expect(detail.sections[1]!.rows.slice(0, 2).map((r) => r.label)).toEqual(["COG", "SOG"]);
  });
});

describe("a live buddy whose static data hasn't arrived", () => {
  const nameless = { id: "b", lat: 56, lng: 10, mmsi: "219654321" };
  test("takes the name the buddy list knows, so the nickname never stands alone", async () => {
    const boat = markBuddy(nameless, { aisName: "PETREL", nickname: "hi" });
    const provider = createVesselInfoProvider({
      vessels: () => [boat],
      thresholds: () => DEFAULT_CPA_THRESHOLDS,
      project: () => ({ x: 0, y: 0 }),
    });
    expect((await provider.detail(vesselInfoHit("b"))).title).toBe("PETREL (hi)");
  });
  test("the target's own name wins once it has one", () => {
    const boat = markBuddy({ ...nameless, name: "PETREL II" }, { aisName: "PETREL" });
    expect(boat.name).toBe("PETREL II");
  });
});

describe("a buddy's nickname and note on its panel", () => {
  const boat = {
    id: "b", lat: 56, lng: 10, mmsi: "219123456", name: "SEABIRD",
    buddy: true, buddyNickname: "bird", buddyNote: "VHF 72",
  };
  const provider = createVesselInfoProvider({
    vessels: () => [boat],
    thresholds: () => DEFAULT_CPA_THRESHOLDS,
    project: () => ({ x: 0, y: 0 }),
  });

  test("the title carries the nickname and a row the note", async () => {
    const detail = await provider.detail(vesselInfoHit("b"));
    expect(detail.title).toBe("SEABIRD (bird)");
    const rows = detail.sections.flatMap((s) => s.rows);
    expect(rows.find((r) => r.label === "Buddy note")?.value).toBe("VHF 72");
  });
});
