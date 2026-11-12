/**
 * Tests for the CPA/TCPA engine.
 *
 * This module can contribute to a collision, so these tests are the proof that
 * it works, not decoration. Three things are done deliberately here:
 *
 * 1. **The arithmetic is shown.** Every known-answer case carries the vectors
 *    and the division that produce the expected number, so a reviewer can check
 *    the claim with a pencil instead of trusting the implementation that is
 *    being tested.
 *
 * 2. **Geometry is set up in plane coordinates via `targetAt`**, which inverts
 *    `cpa.ts`'s projection. That is intentionally circular *for the projection*
 *    and not circular for anything else: it lets the CPA/TCPA/aspect tests
 *    state a clean geometry ("10 nm east, 5 nm north") instead of obscuring the
 *    math behind hand-computed decimal degrees. The projection itself is then
 *    checked independently against a haversine reference in "projection".
 *
 * 3. **The aspect rule is cross-checked against an independent definition.**
 *    `crossingAspect` classifies by bearing at CPA; `trackIntersectionAspect`
 *    below implements the literal mariner meaning ("who reaches the crossing
 *    point first") from scratch. They must agree on every clear crossing. If
 *    the ahead/astern sense were inverted, that test fails.
 *
 * NB: run via `bun run test`, not bare `bun test`.
 */

import { describe, expect, test } from "bun:test";
import {
  classifyRisk,
  computeCpa,
  knotsFromMs,
  rangeNm,
  wrapLonDeltaDeg,
  type CpaOptions,
  type CpaVessel,
  type RiskThresholds,
} from "./cpa";

const DEG = Math.PI / 180;

/** Thresholds used throughout unless a test is specifically about thresholds. */
const THRESHOLDS: RiskThresholds = {
  redCpaNm: 0.5,
  redTcpaMin: 10,
  yellowCpaNm: 1.0,
  yellowTcpaMin: 20,
};
const OPTS: CpaOptions = { thresholds: THRESHOLDS };

/** Own ship, in the Øresund at ~56°N — the latitude the boat actually sails. */
const OWN = { lat: 56.0, lng: 12.0 };

/**
 * A target `eastNm`/`northNm` from `own` in the plane. Exact inverse of the
 * mid-latitude projection in cpa.ts: north is 1 nm per arcmin, east is scaled
 * by cos of the mean latitude (which depends only on the two latitudes, so
 * this is not circular in the unknown).
 */
function targetAt(
  own: { lat: number; lng: number },
  eastNm: number,
  northNm: number,
  cogDeg?: number,
  sogKn?: number,
): CpaVessel {
  const lat = own.lat + northNm / 60;
  const midLat = (own.lat + lat) / 2;
  const lng = own.lng + eastNm / (60 * Math.cos(midLat * DEG));
  return { lat, lng, cogDeg, sogKn };
}

function vessel(cogDeg: number, sogKn: number): CpaVessel {
  return { ...OWN, cogDeg, sogKn };
}

/** Great-circle distance, nm, on the sphere where 1 arcmin == 1 nm exactly. */
function haversineNm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 21600 / (2 * Math.PI);
  const dLat = (b.lat - a.lat) * DEG;
  const dLng = (b.lng - a.lng) * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The *literal* mariner definition of ahead/astern, implemented independently:
 * intersect the two ground tracks and see who gets to the crossing point first.
 * "I'll pass astern of him" means he reaches it first.
 *
 * Returns null when there is no usable crossing (parallel tracks, or an
 * intersection behind one of the vessels) — those are exactly the cases this
 * definition cannot handle and `crossingAspect` can.
 */
function trackIntersectionAspect(
  ownCog: number,
  ownSog: number,
  r: { e: number; n: number },
  tgtCog: number,
  tgtSog: number,
): "ahead" | "astern" | null {
  const uOwn = { e: Math.sin(ownCog * DEG), n: Math.cos(ownCog * DEG) };
  const uTgt = { e: Math.sin(tgtCog * DEG), n: Math.cos(tgtCog * DEG) };
  // Solve uOwn*a - uTgt*b = r for distances a (own) and b (target) along track.
  const det = -uOwn.e * uTgt.n + uTgt.e * uOwn.n;
  if (Math.abs(det) < 1e-9) return null; // parallel
  const a = (-r.e * uTgt.n + uTgt.e * r.n) / det;
  const b = (uOwn.e * r.n - r.e * uOwn.n) / det;
  if (a < 0 || b < 0) return null; // crossing point is behind someone
  const tOwn = a / ownSog;
  const tTgt = b / tgtSog;
  if (Math.abs(tOwn - tTgt) < 1e-9) return null; // simultaneous = collision
  return tOwn < tTgt ? "ahead" : "astern";
}

describe("known answers (checkable by hand)", () => {
  test("head-on: 10 nm apart, closing 10 kn each → CPA 0, TCPA 30 min", () => {
    // own at origin making 10 kn north; target 10 nm due north making 10 kn south.
    //   r = (0, 10) nm          v = (0,-10) - (0,10) = (0,-20) kn
    //   |v|² = 400              r·v = -200
    //   TCPA = -(r·v)/|v|² = 200/400 = 0.5 h = 30 min
    //   CPA  = |r + v·0.5| = |(0, 10-10)| = 0
    // Closing speed 20 kn over 10 nm = 0.5 h. Confirms by a second route.
    const own = vessel(0, 10);
    const target = targetAt(OWN, 0, 10, 180, 10);
    const res = computeCpa(own, target, OPTS);

    expect(res.kind).toBe("computed");
    if (res.kind !== "computed") throw new Error("unreachable");
    expect(res.cpaNm).toBeCloseTo(0, 9);
    expect(res.tcpaMin).toBeCloseTo(30, 9);
    expect(res.rangeNm).toBeCloseTo(10, 9);
    // A dead-on collision is neither ahead nor astern of anything.
    expect(res.aspect).toBe("unknown");

    // Risk is GREEN here, and that is the thresholds talking, not the engine:
    // a certain collision 30 minutes out is outside a 20-minute yellow window.
    // Whoever owns the threshold defaults owns this call — see the note in the
    // task report. The engine's job is to report CPA 0 / TCPA 30, which it does.
    expect(res.risk).toBe("green");
    // Widen the window past 30 min and the same geometry is red. Proof that
    // thresholds are genuinely parameters and nothing is baked in.
    const wide: RiskThresholds = { ...THRESHOLDS, redCpaNm: 2, redTcpaMin: 45 };
    expect(computeCpa(own, target, { thresholds: wide }).risk).toBe("red");
  });

  test("crossing, we pass AHEAD: CPA √12.5 = 3.5355 nm, TCPA 45 min", () => {
    // own at origin, 10 kn north. Target 10 nm east / 5 nm north, 10 kn west.
    //   r = (10, 5)             v = (-10,0) - (0,10) = (-10,-10)
    //   |v|² = 200              r·v = -100 - 50 = -150
    //   TCPA = 150/200 = 0.75 h = 45 min
    //   r + v·0.75 = (10-7.5, 5-7.5) = (2.5, -2.5)  →  CPA = √12.5 ≈ 3.5355
    // Target ends up 2.5 nm ABAFT our beam → we crossed in front of it → ahead.
    // Independent check: tracks cross at (0,5). We run 5 nm @10 kn = 0.5 h;
    // it runs 10 nm @10 kn = 1.0 h. We get there first → we pass ahead. ✔
    const own = vessel(0, 10);
    const target = targetAt(OWN, 10, 5, 270, 10);
    const res = computeCpa(own, target, OPTS);

    if (res.kind !== "computed") throw new Error("expected computed");
    expect(res.tcpaMin).toBeCloseTo(45, 9);
    expect(res.cpaNm).toBeCloseTo(Math.sqrt(12.5), 9);
    expect(res.aspect).toBe("ahead");
    expect(trackIntersectionAspect(0, 10, { e: 10, n: 5 }, 270, 10)).toBe("ahead");
  });

  test("crossing, we pass ASTERN: mirror geometry, same CPA/TCPA", () => {
    // own at origin, 10 kn north. Target 5 nm east / 10 nm north, 10 kn west.
    //   r = (5, 10)             v = (-10,-10)
    //   |v|² = 200              r·v = -50 - 100 = -150
    //   TCPA = 150/200 = 0.75 h = 45 min
    //   r + v·0.75 = (5-7.5, 10-7.5) = (-2.5, 2.5)  →  CPA = √12.5 ≈ 3.5355
    // Target is still 2.5 nm FORWARD of our beam at CPA → it crossed first →
    // we pass astern. This is the sign that is easy to get backwards.
    // Independent check: tracks cross at (0,10). We run 10 nm = 1.0 h; it runs
    // 5 nm = 0.5 h. It gets there first → we pass astern. ✔
    const own = vessel(0, 10);
    const target = targetAt(OWN, 5, 10, 270, 10);
    const res = computeCpa(own, target, OPTS);

    if (res.kind !== "computed") throw new Error("expected computed");
    expect(res.tcpaMin).toBeCloseTo(45, 9);
    expect(res.cpaNm).toBeCloseTo(Math.sqrt(12.5), 9);
    expect(res.aspect).toBe("astern");
    expect(trackIntersectionAspect(0, 10, { e: 5, n: 10 }, 270, 10)).toBe("astern");
  });

  test("overtaking on parallel courses → abeam, CPA = track separation", () => {
    // own 5 kn north; target 0.5 nm east / 2 nm astern, 10 kn north.
    //   r = (0.5, -2)           v = (0,10) - (0,5) = (0, 5)
    //   |v|² = 25               r·v = -10
    //   TCPA = 10/25 = 0.4 h = 24 min
    //   r + v·0.4 = (0.5, -2+2) = (0.5, 0)  →  CPA = 0.5 nm, exactly abeam.
    // Parallel courses put CPA exactly on the beam — the third category the
    // user asked for ("pass side/side") falls out of the geometry for free.
    const own = vessel(0, 5);
    const target = targetAt(OWN, 0.5, -2, 0, 10);
    const res = computeCpa(own, target, OPTS);

    if (res.kind !== "computed") throw new Error("expected computed");
    expect(res.tcpaMin).toBeCloseTo(24, 9);
    expect(res.cpaNm).toBeCloseTo(0.5, 9);
    expect(res.aspect).toBe("abeam");
  });
});

describe("crossing side (port/starboard)", () => {
  test("target passing on our east side while heading north → starboard", () => {
    // Same geometry as "overtaking on parallel courses" above: own heads due
    // north, target passes 0.5 nm to the east at CPA. East of a north-heading
    // bow is starboard.
    const own = vessel(0, 5);
    const target = targetAt(OWN, 0.5, -2, 0, 10);
    const res = computeCpa(own, target, OPTS);

    if (res.kind !== "computed") throw new Error("expected computed");
    expect(res.aspect).toBe("abeam");
    expect(res.side).toBe("starboard");
  });

  test("target passing on our west side while heading north → port", () => {
    // Mirror of the above: target 0.5 nm to the WEST at CPA.
    const own = vessel(0, 5);
    const target = targetAt(OWN, -0.5, -2, 0, 10);
    const res = computeCpa(own, target, OPTS);

    if (res.kind !== "computed") throw new Error("expected computed");
    expect(res.aspect).toBe("abeam");
    expect(res.side).toBe("port");
  });

  test("own ship stationary → side is unknown, not a guess", () => {
    const own = vessel(0, 0); // below MOORED_SPEED_KN
    const target = targetAt(OWN, 0.5, -2, 0, 10);
    const res = computeCpa(own, target, OPTS);

    if (res.kind !== "computed") throw new Error("expected computed");
    expect(res.side).toBe("unknown");
  });
});

describe("edge cases", () => {
  test("|v| = 0 (identical course and speed): no relative motion, not a number", () => {
    // Sailing in company 0.05 nm (~93 m) apart, same course, same speed. The
    // separation never changes: there is no closest approach in time and TCPA
    // is undefined. Dividing by |v|² here would be a divide-by-zero.
    const own = vessel(90, 6);
    const target = targetAt(OWN, 0, 0.05, 90, 6);
    const res = computeCpa(own, target, OPTS);

    expect(res.kind).toBe("unknown");
    if (res.kind !== "unknown") throw new Error("unreachable");
    expect(res.reason).toBe("no-relative-motion");
    // Close aboard, but not converging — and crucially not reported as safe.
    expect(res.risk).toBe("unknown");
    expect(res.risk).not.toBe("green");
    expect(res.rangeNm).toBeCloseTo(0.05, 9);
    expect(Number.isFinite(res.rangeNm)).toBe(true);
  });

  test("TCPA < 0: a receding target is GREEN even at a tiny CPA", () => {
    // The classic bug. Own 10 kn north; target 5 nm astern making 10 kn south
    // — it passed 0.1 nm away a quarter hour ago and is opening at 20 kn.
    //   r = (0.1, -5)           v = (0,-10) - (0,10) = (0,-20)
    //   |v|² = 400              r·v = 100
    //   TCPA = -100/400 = -0.25 h = -15 min   (in the PAST)
    //   r + v·(-0.25) = (0.1, -5+5) = (0.1, 0)  →  CPA = 0.1 nm
    // 0.1 nm is well inside redCpaNm (0.5), so a naive `cpa < red → red` would
    // scream at a ship that is already gone. It must be green.
    const own = vessel(0, 10);
    const target = targetAt(OWN, 0.1, -5, 180, 10);
    const res = computeCpa(own, target, OPTS);

    if (res.kind !== "computed") throw new Error("expected computed");
    expect(res.tcpaMin).toBeCloseTo(-15, 9);
    expect(res.cpaNm).toBeCloseTo(0.1, 9);
    expect(res.risk).toBe("green");
  });

  test("no receding geometry can ever read red or yellow, at any threshold", () => {
    // Proof by exhaustion over the sign of TCPA rather than by one example:
    // sweep CPA and TCPA across the whole negative-TCPA half-plane, including
    // absurdly permissive thresholds, and assert green every time.
    const wild: RiskThresholds = {
      redCpaNm: 1e6,
      redTcpaMin: 1e6,
      yellowCpaNm: 1e6,
      yellowTcpaMin: 1e6,
    };
    for (const cpaNm of [0, 1e-9, 0.01, 0.5, 5, 100]) {
      for (const tcpaMin of [-1e-9, -0.5, -15, -600, -1e6]) {
        expect(classifyRisk(cpaNm, tcpaMin, THRESHOLDS)).toBe("green");
        expect(classifyRisk(cpaNm, tcpaMin, wild)).toBe("green");
      }
    }
  });

  test("stationary target (moored/anchored): CPA computed, aspect abeam", () => {
    // Own 10 kn north; a moored vessel 0.3 nm east / 5 nm ahead, SOG 0 and —
    // as is normal for a moored AIS target — no COG at all.
    //   r = (0.3, 5)            v = (0,0) - (0,10) = (0,-10)
    //   |v|² = 100              r·v = -50
    //   TCPA = 50/100 = 0.5 h = 30 min
    //   r + v·0.5 = (0.3, 0)  →  CPA = 0.3 nm, exactly abeam.
    // Passing a moored vessel, CPA falls exactly when it is abeam. "abeam" is
    // the physically right answer and the rule produces it without a special
    // case. The missing COG is harmless: a zero velocity vector has no
    // direction to get wrong (OpenCPN makes the same substitution).
    const own = vessel(0, 10);
    const target: CpaVessel = { ...targetAt(OWN, 0.3, 5), sogKn: 0 };
    const res = computeCpa(own, target, OPTS);

    if (res.kind !== "computed") throw new Error("expected computed");
    expect(res.tcpaMin).toBeCloseTo(30, 9);
    expect(res.cpaNm).toBeCloseTo(0.3, 9);
    expect(res.aspect).toBe("abeam");
    // 0.3 nm inside 0.5, but 30 min is outside redTcpaMin (10) — so not red.
    expect(res.risk).toBe("green");
  });

  test("target with no COG/SOG (Class B minimal): unknown, never green", () => {
    const own = vessel(0, 10);
    for (const target of [
      targetAt(OWN, 1, 5), // neither COG nor SOG
      targetAt(OWN, 1, 5, 270, undefined), // COG but no SOG
      targetAt(OWN, 1, 5, undefined, 12), // moving, but no COG: cannot guess
    ]) {
      const res = computeCpa(own, target, OPTS);
      expect(res.kind).toBe("unknown");
      if (res.kind !== "unknown") throw new Error("unreachable");
      expect(res.reason).toBe("target-velocity-unknown");
      expect(res.risk).toBe("unknown");
      expect(res.risk).not.toBe("green");
      // Range is still known — it needs positions only.
      expect(res.rangeNm).toBeCloseTo(Math.hypot(1, 5), 9);
    }
  });

  test("implausible/garbage target velocity is rejected, not believed", () => {
    // AIS encodes "speed unavailable" as 102.3 kn. If that sentinel ever leaks
    // through as a number, computing a confident CPA from it would be worse
    // than admitting ignorance.
    const own = vessel(0, 10);
    for (const bad of [102.3, 500, -1, NaN, Infinity]) {
      const res = computeCpa(own, targetAt(OWN, 1, 5, 270, bad), OPTS);
      expect(res.kind).toBe("unknown");
      expect(res.risk).toBe("unknown");
    }
    // A NaN COG on a moving target is equally unusable.
    const res = computeCpa(own, targetAt(OWN, 1, 5, NaN, 10), OPTS);
    expect(res.kind).toBe("unknown");
  });

  test("NaN/absent position: unknown, and above all NOT green", () => {
    // Regression test for a real hole found by probing this module rather than
    // by reading it. signalk.ts creates every vessel record as
    // `{ lat: NaN, lng: NaN, lastSeen: 0 }` and populates it when the first
    // position delta lands, so a NaN-position target genuinely reaches here.
    //
    // Before the guard, this returned
    //   { kind: "computed", cpaNm: NaN, tcpaMin: NaN, aspect: "ahead",
    //     risk: "green" }
    // — a confident "safe, and we'll cross ahead of it" for a vessel of wholly
    // unknown location. NaN defeats a discriminated union: every field was
    // present, so nothing forced the caller to notice. Every comparison with
    // NaN is false, so the risk ladder fell through to its `green` default.
    // A mariner would see a green target, or none, and never know it was there.
    const own = vessel(0, 10);
    const ghost: CpaVessel = { lat: NaN, lng: NaN, cogDeg: 180, sogKn: 10 };

    for (const [a, b] of [
      [own, ghost],
      [ghost, own],
    ] as const) {
      const res = computeCpa(a, b, OPTS);
      expect(res.kind).toBe("unknown");
      if (res.kind !== "unknown") throw new Error("unreachable");
      expect(res.reason).toBe("position-unknown");
      expect(res.risk).toBe("unknown");
      expect(res.risk).not.toBe("green");
      // No range either — and undefined, not NaN, so it cannot poison the
      // caller's arithmetic the way a NaN silently would.
      expect(res.rangeNm).toBeUndefined();
    }
  });

  test("out-of-range or absent coordinates are rejected too", () => {
    const own = vessel(0, 10);
    for (const bad of [
      { lat: 91, lng: 12 },
      { lat: 56, lng: 181 },
      { lat: Infinity, lng: 12 },
      {} as CpaVessel,
    ]) {
      const res = computeCpa(own, { ...bad, cogDeg: 180, sogKn: 10 }, OPTS);
      expect(res.kind).toBe("unknown");
      expect(res.risk).toBe("unknown");
    }
  });

  test("classifyRisk cannot be talked into green by NaN", () => {
    // classifyRisk is exported, so it must defend itself: NaN sails through
    // every comparison and would otherwise reach the `green` default.
    expect(classifyRisk(NaN, NaN, THRESHOLDS)).toBe("unknown");
    expect(classifyRisk(NaN, 5, THRESHOLDS)).toBe("unknown");
    expect(classifyRisk(0.2, NaN, THRESHOLDS)).toBe("unknown");
    expect(classifyRisk(Infinity, 5, THRESHOLDS)).toBe("unknown");
  });

  test("own vessel stationary: CPA/TCPA still computed, aspect is unknown", () => {
    // At anchor. The target passes US; we are not passing anyone, so "we pass
    // ahead/astern" has no referent — there is no bow to be relative to. The
    // CPA is still perfectly well defined and still worth alarming on.
    //   r = (0.5, 5)            v = (0,-10) - (0,0) = (0,-10)
    //   TCPA = 50/100 = 0.5 h = 30 min;  r + v·0.5 = (0.5, 0) → CPA = 0.5
    const own: CpaVessel = { ...OWN, sogKn: 0 };
    const target = targetAt(OWN, 0.5, 5, 180, 10);
    const res = computeCpa(own, target, OPTS);

    if (res.kind !== "computed") throw new Error("expected computed");
    expect(res.tcpaMin).toBeCloseTo(30, 9);
    expect(res.cpaNm).toBeCloseTo(0.5, 9);
    expect(res.aspect).toBe("unknown");
  });

  test("own vessel moving but no COG: unknown (we never guess a course)", () => {
    const own: CpaVessel = { ...OWN, sogKn: 6 };
    const res = computeCpa(own, targetAt(OWN, 1, 5, 270, 10), OPTS);
    expect(res.kind).toBe("unknown");
    if (res.kind !== "unknown") throw new Error("unreachable");
    expect(res.reason).toBe("own-velocity-unknown");
  });

  test("own vessel with no SOG at all: unknown", () => {
    const res = computeCpa({ ...OWN }, targetAt(OWN, 1, 5, 270, 10), OPTS);
    expect(res.kind).toBe("unknown");
    if (res.kind !== "unknown") throw new Error("unreachable");
    expect(res.reason).toBe("own-velocity-unknown");
  });

  test("both vessels stationary WITH a fix: CPA is the current range, not grey", () => {
    // #AIS-GRAY. Own ship at anchor (valid fix, SOG 0); a moored target 0.2 nm
    // east / 0.2 nm north, also at rest. Our own velocity is a known (0,0), the
    // target's is (0,0), so the separation is constant and the closest approach
    // is simply the current range √(0.2² + 0.2²) = 0.2828 nm, for all time.
    // That is a computed fact about a fixed geometry, not "unknown for lack of
    // our own velocity" — being at anchor must not grey the target out.
    const own: CpaVessel = { ...OWN, sogKn: 0 };
    const target: CpaVessel = { ...targetAt(OWN, 0.2, 0.2), sogKn: 0 };
    const res = computeCpa(own, target, OPTS);

    if (res.kind !== "computed") throw new Error("expected computed");
    expect(res.rangeNm).toBeCloseTo(Math.hypot(0.2, 0.2), 9);
    // CPA is exactly the current range; nothing is moving, so it never changes.
    expect(res.cpaNm).toBeCloseTo(res.rangeNm, 12);
    // TCPA = 0: closest approach is now (and always).
    expect(res.tcpaMin).toBe(0);
    // At rest we pass no one — no bow to be relative to.
    expect(res.aspect).toBe("unknown");
    // 0.2828 nm is inside redCpaNm (0.5), but BOTH vessels are at rest, so there
    // is no closing motion and no threat: risk is GREEN, never red. Two boats
    // moored a cable apart are not converging. (#CPA-MOORED-REST — the geometry
    // is still reported; only the risk is suppressed.)
    expect(res.risk).toBe("green");
    expect(res.risk).not.toBe("red");
  });
});

describe("#AIS-GRAY: a stationary own ship that HAS a fix computes, not greys", () => {
  // USER DECISION: "grey is fine for NO FIX, but with a FIX but 0 SOG you can
  // calculate CPA fine." CPA depends on *relative* motion, and a stopped own
  // ship simply has velocity (0,0) — a known velocity, not a missing one. So a
  // valid fix with SOG 0 must compute; only a missing fix (position unknown)
  // greys on the own-ship axis. These four tests pin exactly that boundary.

  // 1. Own has a fix, SOG 0, target moving straight at us. The stopped own ship
  //    has velocity (0,0); the target's motion alone defines a real CPA/TCPA.
  //    This must be a classified risk, never "unknown"/grey.
  test("own fix + SOG 0 + target closing → computed and classified (here: red)", () => {
    // Own at anchor at OWN. Target 1 nm due north making 10 kn south, i.e.
    // bearing down on us.
    //   r = (0, 1)    ownV = (0,0)    tgtV = (0,-10)    v = (0,-10)
    //   |v|² = 100    r·v = -10    TCPA = 10/100 = 0.1 h = 6 min
    //   r + v·0.1 = (0, 1-1) = (0,0)  →  CPA = 0
    // CPA 0 inside redCpaNm (0.5) and TCPA 6 inside redTcpaMin (10): a ship
    // bearing down on an anchored boat is a red alarm, not a grey question mark.
    const own: CpaVessel = { ...OWN, sogKn: 0 };
    const target = targetAt(OWN, 0, 1, 180, 10);
    const res = computeCpa(own, target, OPTS);

    if (res.kind !== "computed") throw new Error("expected computed, not grey");
    expect(res.cpaNm).toBeCloseTo(0, 9);
    expect(res.tcpaMin).toBeCloseTo(6, 9);
    expect(res.risk).toBe("red");
    expect(res.risk).not.toBe("unknown");
  });

  // 2. Own has a fix, SOG 0, target also at rest. Relative speed is 0, so TCPA
  //    is 0 and CPA is the current range — computed, never grey-for-lack-of-own-
  //    vel. But with BOTH at rest there is no closing motion, so the geometry is
  //    reported while risk is forced GREEN whether near or far (#CPA-MOORED-REST).
  test("own fix + SOG 0 + target stationary → computed geometry, risk green (both at rest)", () => {
    const own: CpaVessel = { ...OWN, sogKn: 0 };

    // Near: 0.1 nm off → computed range, TCPA 0, but green (nothing is moving).
    const near = computeCpa(own, { ...targetAt(OWN, 0.1, 0), sogKn: 0 }, OPTS);
    if (near.kind !== "computed") throw new Error("expected computed");
    expect(near.cpaNm).toBeCloseTo(0.1, 9);
    expect(near.cpaNm).toBeCloseTo(near.rangeNm, 12);
    expect(near.tcpaMin).toBe(0);
    expect(near.risk).toBe("green");
    expect(near.risk).not.toBe("red");

    // Far: 5 nm off → also green, and legitimately so: two fixed vessels 5 nm
    // apart are not a collision risk.
    const far = computeCpa(own, { ...targetAt(OWN, 5, 0), sogKn: 0 }, OPTS);
    if (far.kind !== "computed") throw new Error("expected computed");
    expect(far.cpaNm).toBeCloseTo(5, 9);
    expect(far.tcpaMin).toBe(0);
    expect(far.risk).toBe("green");
  });

  // 3. No own fix → still unknown. The user wants grey here, and does too the
  //    module: with no own position there is no geometry to compute at all.
  test("NO own fix → still unknown/grey (position-unknown), never green", () => {
    const noFix: CpaVessel = { lat: NaN, lng: NaN, sogKn: 0 };
    const target = targetAt(OWN, 0, 1, 180, 10);
    const res = computeCpa(noFix, target, OPTS);

    expect(res.kind).toBe("unknown");
    if (res.kind !== "unknown") throw new Error("unreachable");
    expect(res.reason).toBe("position-unknown");
    expect(res.risk).toBe("unknown");
    expect(res.risk).not.toBe("green");
    expect(res.rangeNm).toBeUndefined();
  });

  // 4. Own moving is unchanged (regression guard for the branch split). A
  //    genuinely missing own velocity still greys, and an under-way ship that
  //    the target merely matches (sailing in company) still greys — the fix
  //    keys on *our own* velocity being a known zero, nothing else.
  test("own moving is unchanged: no-COG greys, sailing-in-company greys", () => {
    // Own under way (10 kn N) but reports no COG: we never guess a course.
    const noCog = computeCpa({ ...OWN, sogKn: 10 }, targetAt(OWN, 1, 5, 270, 10), OPTS);
    expect(noCog.kind).toBe("unknown");
    if (noCog.kind !== "unknown") throw new Error("unreachable");
    expect(noCog.reason).toBe("own-velocity-unknown");

    // Own under way and the target matches us exactly (sailing in company):
    // relative motion is zero, but because WE are moving there is no closest
    // approach in time — this stays "no-relative-motion", not computed.
    const company = computeCpa(
      { ...OWN, cogDeg: 0, sogKn: 6 },
      targetAt(OWN, 0.05, 0, 0, 6),
      OPTS,
    );
    expect(company.kind).toBe("unknown");
    if (company.kind !== "unknown") throw new Error("unreachable");
    expect(company.reason).toBe("no-relative-motion");
    expect(company.risk).toBe("unknown");

    // And an ordinary moving-ship crossing still computes as it always did.
    const crossing = computeCpa({ ...OWN, cogDeg: 0, sogKn: 10 }, targetAt(OWN, 10, 5, 270, 10), OPTS);
    expect(crossing.kind).toBe("computed");
  });
});

describe("#CPA-MOORED: an at-rest ship (GPS-noise SOG, no COG) is treated as stopped", () => {
  // LIVE BUG: own ship anchored reports sogMs 0.0189 (≈ 0.037 kn of GPS jitter,
  // navStatus "anchored") and NO cogDeg — only a heading. The old code treated
  // any SOG above a 1e-6 numerical epsilon as "under way", then demanded a COG
  // to build a velocity; own had none, so every target came back
  // "own-velocity-unknown" → grey. A real moored-speed threshold fixes it: at
  // or below MOORED_SPEED_KN (0.2 kn) a vessel is at rest, so an anchored own
  // ship computes CPA by range instead of greying the whole plot.
  //
  // 0.037 kn expressed the way it actually arrives: metres/second off SignalK.
  const OWN_ANCHORED_SOG_KN = knotsFromMs(0.0189); // ≈ 0.0367 kn

  test("THE REPRO: anchored own (0.037 kn, no COG) computes risk, not grey", () => {
    // Own has a valid fix but a jittering near-zero SOG and no COG at all.
    // Sanity-check the input is really below threshold but above the old eps,
    // so this is exactly the case the old code mishandled.
    expect(OWN_ANCHORED_SOG_KN).toBeLessThan(0.2);
    expect(OWN_ANCHORED_SOG_KN).toBeGreaterThan(1e-6);
    const own: CpaVessel = { ...OWN, sogKn: OWN_ANCHORED_SOG_KN, cogDeg: undefined };

    // Near stationary target (0.1 nm off) → constant range 0.1 nm, TCPA 0. Both
    // at rest, so computed (not grey) but GREEN (not red): no closing motion.
    const near = computeCpa(own, { ...targetAt(OWN, 0.1, 0), sogKn: 0 }, OPTS);
    if (near.kind !== "computed") throw new Error("expected computed, not grey");
    expect(near.risk).not.toBe("unknown");
    expect(near.cpaNm).toBeCloseTo(0.1, 9);
    expect(near.cpaNm).toBeCloseTo(near.rangeNm, 12);
    expect(near.tcpaMin).toBe(0);
    expect(near.risk).toBe("green");
    expect(near.risk).not.toBe("red");
    // At rest we pass no one — no bow to be relative to.
    expect(near.aspect).toBe("unknown");

    // Far stationary target (5 nm off) → computed and legitimately green.
    const far = computeCpa(own, { ...targetAt(OWN, 5, 0), sogKn: 0 }, OPTS);
    if (far.kind !== "computed") throw new Error("expected computed, not grey");
    expect(far.risk).not.toBe("unknown");
    expect(far.cpaNm).toBeCloseTo(5, 9);
    expect(far.risk).toBe("green");
  });

  test("regression: own with NO SOG data at all is still unknown/grey", () => {
    // The threshold treats a *known* near-zero speed as at rest. It must not
    // treat *absent* speed as at rest — we know nothing, so we grey. Distinct.
    const res = computeCpa({ ...OWN, sogKn: undefined }, { ...targetAt(OWN, 0.1, 0), sogKn: 0 }, OPTS);
    expect(res.kind).toBe("unknown");
    if (res.kind !== "unknown") throw new Error("unreachable");
    expect(res.reason).toBe("own-velocity-unknown");
    expect(res.risk).toBe("unknown");
    expect(res.risk).not.toBe("green");
  });

  test("regression: own genuinely under way (6 kn + COG) still computes normally", () => {
    // Above the threshold, nothing changes: a real crossing is a real CPA.
    //   own 6 kn north; target 10 nm east / 5 nm north, 10 kn west.
    const own: CpaVessel = { ...OWN, cogDeg: 0, sogKn: 6 };
    const res = computeCpa(own, targetAt(OWN, 10, 5, 270, 10), OPTS);
    expect(res.kind).toBe("computed");
    if (res.kind !== "computed") throw new Error("unreachable");
    // Not forced stationary: it has a real crossing aspect, not "unknown".
    expect(res.aspect).not.toBe("unknown");
  });

  test("a moored TARGET (0.037 kn, no COG) against a moving own ship computes", () => {
    // Symmetric case: the target is the anchored one. It resolves as at rest
    // (0,0), so its missing COG is harmless and its noisy SOG is not believed.
    //   own 10 kn north; target 0.3 nm east / 5 nm ahead, at rest → abeam pass.
    const own = vessel(0, 10);
    const target: CpaVessel = { ...targetAt(OWN, 0.3, 5), sogKn: OWN_ANCHORED_SOG_KN, cogDeg: undefined };
    const res = computeCpa(own, target, OPTS);

    if (res.kind !== "computed") throw new Error("expected computed, not grey");
    expect(res.risk).not.toBe("unknown");
    expect(res.tcpaMin).toBeCloseTo(30, 9);
    expect(res.cpaNm).toBeCloseTo(0.3, 9);
    expect(res.aspect).toBe("abeam");
  });
});

describe("#CPA-MOORED-REST: both-at-rest suppression and the configurable threshold", () => {
  // USER DECISION: two boats both sitting still are not a collision threat,
  // however close — there is no closing motion. So a both-at-rest pair must NOT
  // redden (no CPA line, no alarm). The suppression is gated strictly on BOTH
  // being at rest: if EITHER vessel is moving it is a real encounter and still
  // reddens. The rest threshold is user-configurable via `CpaOptions.atRestKn`
  // (default `MOORED_SPEED_KN` = 0.2 kn).

  test("(1) both at rest and close → NOT red (no line, no alarm)", () => {
    // Own anchored (SOG 0), target moored 0.1 nm off (SOG 0). Inside redCpaNm.
    const own: CpaVessel = { ...OWN, sogKn: 0 };
    const target: CpaVessel = { ...targetAt(OWN, 0.1, 0), sogKn: 0 };
    const res = computeCpa(own, target, OPTS);
    if (res.kind !== "computed") throw new Error("expected computed");
    // Geometry is still reported (constant range) — only the risk is suppressed.
    expect(res.cpaNm).toBeCloseTo(0.1, 9);
    expect(res.tcpaMin).toBe(0);
    // The load-bearing assertion: no red means no line (aisSymbols gates on
    // risk === "red") and no alarm.
    expect(res.risk).not.toBe("red");
    expect(res.risk).toBe("green");
  });

  test("(2) own MOVING toward a stopped target and close → STILL red", () => {
    // The safety guard: suppression must never hide a genuine threat. Own makes
    // 10 kn due north straight at a moored target 0.3 nm ahead. CPA 0, TCPA ~1.8
    // min — a red alarm, unchanged by the both-at-rest logic (only own is at
    // rest there, and here own is moving).
    const own = vessel(0, 10);
    const target: CpaVessel = { ...targetAt(OWN, 0, 0.3), sogKn: 0 };
    const res = computeCpa(own, target, OPTS);
    if (res.kind !== "computed") throw new Error("expected computed");
    expect(res.cpaNm).toBeCloseTo(0, 9);
    expect(res.risk).toBe("red");

    // And the mirror: a moving target bearing down on an anchored own ship is
    // equally a red threat, not suppressed.
    const anchored: CpaVessel = { ...OWN, sogKn: 0 };
    const closing = computeCpa(anchored, targetAt(OWN, 0, 0.3, 180, 10), OPTS);
    if (closing.kind !== "computed") throw new Error("expected computed");
    expect(closing.risk).toBe("red");
  });

  test("(3) the configurable threshold moves the at-rest boundary", () => {
    // A target creeping at 0.3 kn straight at an anchored own ship, 0.04 nm off
    // (close enough that even at 0.3 kn the TCPA is ~8 min, inside the 10-min red
    // horizon). At the DEFAULT threshold (0.2 kn) 0.3 kn counts as MOVING, so
    // this is a real closing encounter → red. Raise atRestKn to 0.5 kn and the
    // same target is now AT REST → both-at-rest → green. Same geometry, the
    // threshold alone flips the verdict.
    const own: CpaVessel = { ...OWN, sogKn: 0 };
    const creeping = targetAt(OWN, 0, 0.04, 180, 0.3); // 0.3 kn south, closing

    const atDefault = computeCpa(own, creeping, OPTS); // atRestKn defaults to 0.2
    if (atDefault.kind !== "computed") throw new Error("expected computed");
    expect(atDefault.tcpaMin).toBeCloseTo(8, 6); // 0.04 nm / 0.3 kn = 8 min
    expect(atDefault.risk).toBe("red");

    const raised = computeCpa(own, creeping, { ...OPTS, atRestKn: 0.5 });
    if (raised.kind !== "computed") throw new Error("expected computed");
    expect(raised.tcpaMin).toBe(0); // both at rest → constant range
    expect(raised.risk).toBe("green");
    expect(raised.risk).not.toBe("red");
  });

  test("atRestKn is a knob, not a floor: below default still counts as at rest", () => {
    // A very low threshold makes a 0.1 kn drift count as moving. Confirms the
    // parameter genuinely replaces the constant rather than clamping to it.
    const own: CpaVessel = { ...OWN, sogKn: 0.1, cogDeg: undefined };
    // With atRestKn 0.05, own's 0.1 kn is "moving" but has no COG → grey.
    const strict = computeCpa(own, { ...targetAt(OWN, 0.1, 0), sogKn: 0 }, { ...OPTS, atRestKn: 0.05 });
    expect(strict.kind).toBe("unknown");
    if (strict.kind !== "unknown") throw new Error("unreachable");
    expect(strict.reason).toBe("own-velocity-unknown");
    // With the default 0.2, own's 0.1 kn is at rest → both at rest → green.
    const lax = computeCpa(own, { ...targetAt(OWN, 0.1, 0), sogKn: 0 }, OPTS);
    if (lax.kind !== "computed") throw new Error("expected computed");
    expect(lax.risk).toBe("green");
  });
});

describe("antimeridian", () => {
  test("wrapLonDeltaDeg wraps to [-180, 180]", () => {
    expect(wrapLonDeltaDeg(0)).toBeCloseTo(0, 12);
    expect(wrapLonDeltaDeg(10)).toBeCloseTo(10, 12);
    expect(wrapLonDeltaDeg(-10)).toBeCloseTo(-10, 12);
    expect(wrapLonDeltaDeg(-359.9)).toBeCloseTo(0.1, 12);
    expect(wrapLonDeltaDeg(359.9)).toBeCloseTo(-0.1, 12);
    expect(wrapLonDeltaDeg(180)).toBeCloseTo(-180, 12);
    expect(wrapLonDeltaDeg(-180)).toBeCloseTo(-180, 12);
  });

  test("a collision across the dateline is RED, not green", () => {
    // The failure this guards is silent and lethal: an unwrapped Δlon of
    // -359.9° would put a ship 3.35 nm away at ~12000 nm, whose CPA is enormous
    // and therefore *green*. Wrong-and-safe is the worst answer available.
    //   Δlon wraps -359.92 → 0.08°;  east = 0.08 × 60 × cos 56° = 2.6841 nm
    //   r = (2.6841, 0)         v = (-10,0) - (10,0) = (-20, 0)
    //   TCPA = 2.6841/20 h = 0.1342 h = 8.05 min;  CPA = 0  →  red
    const own: CpaVessel = { lat: 56.0, lng: 179.96, cogDeg: 90, sogKn: 10 };
    const target: CpaVessel = { lat: 56.0, lng: -179.96, cogDeg: 270, sogKn: 10 };
    const res = computeCpa(own, target, OPTS);

    const expectedEast = 0.08 * 60 * Math.cos(56 * DEG);
    if (res.kind !== "computed") throw new Error("expected computed");
    expect(res.rangeNm).toBeCloseTo(expectedEast, 6);
    expect(res.rangeNm).toBeLessThan(4);
    expect(res.cpaNm).toBeCloseTo(0, 6);
    expect(res.tcpaMin).toBeCloseTo((expectedEast / 20) * 60, 6);
    expect(res.risk).toBe("red");
  });

  test("range across the dateline is symmetric with the same span mid-ocean", () => {
    const across = rangeNm({ lat: 56, lng: 179.95 }, { lat: 56, lng: -179.95 });
    const mid = rangeNm({ lat: 56, lng: 11.95 }, { lat: 56, lng: 12.05 });
    expect(across).toBeCloseTo(mid, 9);
  });
});

describe("projection", () => {
  test("mid-latitude plane matches haversine within the documented bound", () => {
    // The doc comment claims < 0.15 m at 20 nm at 56°N and < 8 m at 50 nm at
    // 70°N. Assert it rather than assert-by-comment: if someone swaps the
    // mid-latitude scaling for cos(own lat), this fails (that variant is 62 m
    // at 20 nm).
    const R = 21600 / (2 * Math.PI);
    const dest = (lat: number, lng: number, brgDeg: number, distNm: number) => {
      const d = distNm / R;
      const b = brgDeg * DEG;
      const l1 = lat * DEG;
      const lat2 = Math.asin(Math.sin(l1) * Math.cos(d) + Math.cos(l1) * Math.sin(d) * Math.cos(b));
      const lng2 =
        lng * DEG +
        Math.atan2(
          Math.sin(b) * Math.sin(d) * Math.cos(l1),
          Math.cos(d) - Math.sin(l1) * Math.sin(lat2),
        );
      return { lat: (lat2 * 180) / Math.PI, lng: (lng2 * 180) / Math.PI };
    };

    const NM_TO_M = 1852;
    const bounds: [number, number, number][] = [
      // lat, range nm, max error metres
      [56, 1, 0.01],
      [56, 10, 0.05],
      [56, 20, 0.15],
      [70, 20, 0.5],
      [70, 50, 8],
    ];
    for (const [lat, range, maxErrM] of bounds) {
      let worst = 0;
      for (let brg = 0; brg < 360; brg += 1) {
        const origin = { lat, lng: 12 };
        const p = dest(lat, 12, brg, range);
        worst = Math.max(worst, Math.abs(rangeNm(origin, p) - haversineNm(origin, p)) * NM_TO_M);
      }
      expect(worst).toBeLessThan(maxErrM);
    }
  });

  test("1 arcmin of latitude is 1 nm, by definition", () => {
    expect(rangeNm({ lat: 56, lng: 12 }, { lat: 56 + 1 / 60, lng: 12 })).toBeCloseTo(1, 12);
    // East-west is shorter by cos(lat) — this is the whole reason a naive
    // lat/lon-as-cartesian engine would be wrong by 1.79x at 56°N.
    expect(rangeNm({ lat: 56, lng: 12 }, { lat: 56, lng: 12 + 1 / 60 })).toBeCloseTo(
      Math.cos(56 * DEG),
      6,
    );
  });
});

describe("units", () => {
  test("knotsFromMs", () => {
    expect(knotsFromMs(1)).toBeCloseTo(1.9438444924406, 9);
    expect(knotsFromMs(0)).toBe(0);
    // 1 kn is 1852 m/h by definition.
    expect(knotsFromMs(1852 / 3600)).toBeCloseTo(1, 12);
  });

  test("TCPA is minutes, not hours — a 30 nm closing at 60 kn is 30 min", () => {
    // Guards the MIN_PER_HOUR factor: an hours/minutes mixup is a 60x error
    // and would be invisible in a test that only checked a 60-minute case.
    const own = vessel(0, 30);
    const target = targetAt(OWN, 0, 30, 180, 30);
    const res = computeCpa(own, target, OPTS);
    if (res.kind !== "computed") throw new Error("expected computed");
    expect(res.tcpaMin).toBeCloseTo(30, 9);
  });
});

describe("classifyRisk", () => {
  test("red needs BOTH a close CPA and a soon TCPA", () => {
    expect(classifyRisk(0.2, 5, THRESHOLDS)).toBe("red");
    // Close, but hours away: both vessels will have manoeuvred long before.
    expect(classifyRisk(0.2, 45, THRESHOLDS)).toBe("green");
    // Soon, but a mile and a half off: not a threat.
    expect(classifyRisk(1.5, 5, THRESHOLDS)).toBe("green");
  });

  test("the yellow band sits between red and green", () => {
    expect(classifyRisk(0.8, 15, THRESHOLDS)).toBe("yellow");
    expect(classifyRisk(0.8, 5, THRESHOLDS)).toBe("yellow"); // CPA too big for red
    expect(classifyRisk(0.2, 15, THRESHOLDS)).toBe("yellow"); // TCPA too far for red
    expect(classifyRisk(1.2, 15, THRESHOLDS)).toBe("green");
  });

  test("boundaries: CPA is exclusive, TCPA inclusive", () => {
    expect(classifyRisk(0.5, 10, THRESHOLDS)).toBe("yellow"); // CPA exactly red limit
    expect(classifyRisk(0.499, 10, THRESHOLDS)).toBe("red");
    expect(classifyRisk(0.2, 10, THRESHOLDS)).toBe("red"); // TCPA exactly red limit
    expect(classifyRisk(0.2, 10.001, THRESHOLDS)).toBe("yellow");
  });

  test("TCPA exactly 0 (closest approach is NOW) can still be red", () => {
    // Divergence from OpenCPN, which requires TCPA > 0 strictly and so goes
    // quiet at the exact moment of closest approach. At CPA 0.05 nm right now,
    // silence is the wrong output.
    expect(classifyRisk(0.05, 0, THRESHOLDS)).toBe("red");
  });

  test("red wins over yellow even if a caller inverts the bands", () => {
    const inverted: RiskThresholds = {
      redCpaNm: 1.0,
      redTcpaMin: 20,
      yellowCpaNm: 0.5,
      yellowTcpaMin: 10,
    };
    expect(classifyRisk(0.8, 15, inverted)).toBe("red");
  });
});

describe("properties", () => {
  /** Deterministic PRNG — reproducible failures beat random ones. */
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  /** A spread of random but plausible two-vessel encounters at 56°N. */
  function* encounters(n: number) {
    const rand = rng(12345);
    for (let i = 0; i < n; i++) {
      const ownCog = rand() * 360;
      const ownSog = 1 + rand() * 15;
      const tgtCog = rand() * 360;
      const tgtSog = 1 + rand() * 15;
      const e = (rand() - 0.5) * 20;
      const n2 = (rand() - 0.5) * 20;
      const own: CpaVessel = { ...OWN, cogDeg: ownCog, sogKn: ownSog };
      const target = targetAt(OWN, e, n2, tgtCog, tgtSog);
      yield { own, target, ownCog, ownSog, tgtCog, tgtSog, r: { e, n: n2 } };
    }
  }

  test("CPA and TCPA are symmetric between the two vessels", () => {
    // Physics does not care whose bridge you stand on. (Aspect does — see the
    // next test.)
    for (const { own, target } of encounters(400)) {
      const a = computeCpa(own, target, OPTS);
      const b = computeCpa(target, own, OPTS);
      expect(b.kind).toBe(a.kind);
      if (a.kind !== "computed" || b.kind !== "computed") continue;
      expect(b.cpaNm).toBeCloseTo(a.cpaNm, 6);
      expect(b.tcpaMin).toBeCloseTo(a.tcpaMin, 6);
      expect(b.rangeNm).toBeCloseTo(a.rangeNm, 6);
    }
  });

  /**
   * Aspect duality, stated exactly — this is subtler than it first looks, and
   * the naive version of this test is wrong.
   *
   * The offset at CPA, d, is perpendicular to the relative velocity (that is
   * what makes it the closest approach), so d·(vB - vA) = 0, i.e.
   *
   *     d·vA = d·vB = k
   *
   * A's "along" component is d·uA = k/|vA|; B's is (-d)·uB = -k/|vB|. So A
   * reports astern exactly when k > 0, and B reports ahead exactly when
   * -k/|vB| < 0, i.e. also exactly when k > 0. **The ahead/astern sense is
   * perfectly dual**, and it falls out of the same perpendicularity that
   * defines CPA.
   *
   * The *abeam band* is not dual, and correctly so: A is abeam-banded when
   * |k|/(|vA|·cpa) <= sin(band) and B when |k|/(|vB|·cpa) <= sin(band). The
   * denominators differ whenever the two vessels' speeds differ. That is real:
   * relative bearing at CPA is measured at *your own* bow, so a 3 kn yacht and
   * a 15 kn ferry in one encounter genuinely see different bearings, and one
   * may call the pass abeam while the other calls it a crossing. Asserting
   * strict duality with a band on would be asserting a falsehood.
   */
  test("aspect sense is exactly dual with no abeam band", () => {
    const noBand: CpaOptions = { thresholds: THRESHOLDS, abeamBandDeg: 0 };
    let ahead = 0;
    let astern = 0;
    for (const { own, target } of encounters(400)) {
      const a = computeCpa(own, target, noBand);
      const b = computeCpa(target, own, noBand);
      if (a.kind !== "computed" || b.kind !== "computed") continue;
      if (a.aspect === "ahead") {
        expect(b.aspect).toBe("astern");
        ahead++;
      }
      if (a.aspect === "astern") {
        expect(b.aspect).toBe("ahead");
        astern++;
      }
    }
    // Guard against the assertions above passing vacuously.
    expect(ahead).toBeGreaterThan(20);
    expect(astern).toBeGreaterThan(20);
  });

  test("with a band, two vessels never both claim to cross in front", () => {
    // The weaker invariant that must hold with the band on: the band can only
    // soften a crossing to "abeam", never flip its sense. Both vessels claiming
    // "ahead" would be a contradiction — they cannot each cross the other's bow.
    let contested = 0;
    for (const { own, target } of encounters(400)) {
      const a = computeCpa(own, target, OPTS);
      const b = computeCpa(target, own, OPTS);
      if (a.kind !== "computed" || b.kind !== "computed") continue;
      expect(a.aspect === "ahead" && b.aspect === "ahead").toBe(false);
      expect(a.aspect === "astern" && b.aspect === "astern").toBe(false);
      if (a.aspect !== "abeam" && b.aspect !== "abeam" && a.aspect !== "unknown") contested++;
    }
    expect(contested).toBeGreaterThan(20);
  });

  test("aspect agrees with the independent track-intersection definition", () => {
    // The real proof that ahead/astern is not inverted: `crossingAspect` uses
    // bearing-at-CPA, `trackIntersectionAspect` races the two vessels to the
    // crossing point. Different math, same answer, on every clear crossing.
    let checked = 0;
    for (const { own, target, ownCog, ownSog, tgtCog, tgtSog, r } of encounters(600)) {
      const res = computeCpa(own, target, OPTS);
      if (res.kind !== "computed") continue;
      // Only where the literal definition applies: a real crossing ahead of
      // both, and not inside the abeam band where it is unstable by design.
      if (res.aspect === "abeam" || res.aspect === "unknown") continue;
      const ref = trackIntersectionAspect(ownCog, ownSog, r, tgtCog, tgtSog);
      if (ref === null) continue;
      expect(res.aspect).toBe(ref);
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
  });

  test("safety invariants hold across 50k adversarial inputs", () => {
    // The strongest statement this suite makes. The cases above prove specific
    // geometries; this one hunts for a path that produces a *confident wrong
    // answer* from any input at all — including NaN, ±Infinity, the AIS
    // "unavailable" sentinels (COG 360, SOG 102.3), negative speeds and absent
    // fields, mixed in at random with plausible ones. It is how the NaN-position
    // hole was found; it stays so it cannot come back.
    const rand = rng(99);
    const weird = [undefined, NaN, Infinity, -Infinity, 0, -0, 360, 102.3, -1, 1e9];
    const pick = <T,>(a: T[]): T => a[Math.floor(rand() * a.length)]!;
    const mk = (): CpaVessel =>
      rand() < 0.25
        ? {
            lat: pick(weird) as number,
            lng: pick(weird) as number,
            cogDeg: pick(weird),
            sogKn: pick(weird),
          }
        : {
            lat: 56 + (rand() - 0.5) * 0.5,
            lng: 12 + (rand() - 0.5) * 0.5,
            cogDeg: rand() < 0.15 ? pick(weird) : rand() * 360,
            sogKn: rand() < 0.15 ? pick(weird) : rand() * 25,
          };

    let computed = 0;
    let receding = 0;
    for (let i = 0; i < 50_000; i++) {
      const res = computeCpa(mk(), mk(), OPTS);
      if (res.kind === "computed") {
        computed++;
        // A computed result is a claim of knowledge: it must be all-finite.
        expect(Number.isFinite(res.cpaNm)).toBe(true);
        expect(Number.isFinite(res.tcpaMin)).toBe(true);
        expect(Number.isFinite(res.rangeNm)).toBe(true);
        expect(res.cpaNm).toBeGreaterThanOrEqual(0);
        // The one that matters: a receding target is green, always.
        if (res.tcpaMin < 0) {
          receding++;
          expect(res.risk).toBe("green");
        }
        // Red is never reachable except by genuinely meeting both thresholds
        // while approaching.
        if (res.risk === "red") {
          expect(res.cpaNm < THRESHOLDS.redCpaNm).toBe(true);
          expect(res.tcpaMin >= 0 && res.tcpaMin <= THRESHOLDS.redTcpaMin).toBe(true);
        }
      } else {
        // And "unknown" never leaks out as anything a caller could read as safe.
        expect(res.risk).toBe("unknown");
      }
    }
    // Not vacuous: the space really does contain both kinds of case.
    expect(computed).toBeGreaterThan(10_000);
    expect(receding).toBeGreaterThan(5_000);
  });

  test("CPA never exceeds current range when the target is closing", () => {
    // If TCPA > 0 the vessels are converging, so the closest they get cannot be
    // further than where they are now.
    for (const { own, target } of encounters(400)) {
      const res = computeCpa(own, target, OPTS);
      if (res.kind !== "computed") continue;
      if (res.tcpaMin > 0) expect(res.cpaNm).toBeLessThanOrEqual(res.rangeNm + 1e-9);
    }
  });

  test("CPA is never negative and every output is finite", () => {
    for (const { own, target } of encounters(400)) {
      const res = computeCpa(own, target, OPTS);
      if (res.kind !== "computed") continue;
      expect(res.cpaNm).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(res.cpaNm)).toBe(true);
      expect(Number.isFinite(res.tcpaMin)).toBe(true);
      expect(Number.isFinite(res.rangeNm)).toBe(true);
    }
  });

  test("closed-form TCPA really is the argmin of separation (brute force)", () => {
    // Validates the derivation itself: f'(t) = 0 at t = -(r·v)/|v|², and
    // f'' = 2|v|² > 0 makes it the unique *minimum* rather than a maximum. If
    // the sign of TCPA were flipped, this would find a closer time and fail.
    //
    // The brute force runs in the plane, straight from the encounter's own
    // r/COG/SOG — no projection involved on either side, so this compares
    // closed-form against numerical minimisation and nothing else. (Moving the
    // vessels over the sphere and re-projecting would measure projection drift
    // over a 2-hour extrapolation, which is the "projection" suite's job.)
    for (const { own, target, ownCog, ownSog, tgtCog, tgtSog, r } of encounters(200)) {
      const res = computeCpa(own, target, OPTS);
      if (res.kind !== "computed") continue;
      const v = {
        e: tgtSog * Math.sin(tgtCog * DEG) - ownSog * Math.sin(ownCog * DEG),
        n: tgtSog * Math.cos(tgtCog * DEG) - ownSog * Math.cos(ownCog * DEG),
      };
      const sepAt = (t: number) => Math.hypot(r.e + v.e * t, r.n + v.n * t);
      // The closed-form answer must match the plane geometry it claims to solve.
      expect(sepAt(res.tcpaMin / 60)).toBeCloseTo(res.cpaNm, 9);
      // ...and nothing within a wide window may beat it.
      for (let dt = -2; dt <= 2; dt += 0.05) {
        expect(sepAt(res.tcpaMin / 60 + dt)).toBeGreaterThanOrEqual(res.cpaNm - 1e-9);
      }
    }
  });
});
