// CPA / TCPA collision assessment, ported in spirit from OpenCPN's
// `AisDecoder::UpdateOneCPA` (ais_decoder.cpp, GPLv2). Real safety aid — full
// derivation and unit rationale: docs/architecture/cpa-math.md.

/** Nautical miles per arcmin of latitude — 1, by the definition of the nm. */
const NM_PER_ARCMIN = 1;
const ARCMIN_PER_DEG = 60;
const DEG_TO_RAD = Math.PI / 180;
const MIN_PER_HOUR = 60;

// Pure numerical epsilon (exact ties/float dust) for the divide-by-zero
// guard on *relative* velocity — not a judgement about "stopped". The
// practical at-rest threshold is `MOORED_SPEED_KN`.
const SPEED_EPS_KN = 1e-6;

// At/below this SOG a vessel is at rest (velocity (0,0)) even with a
// reported COG — a stopped ship isn't numerically stopped (GPS jitter).
// Full rationale: docs/architecture/cpa-math.md.
const MOORED_SPEED_KN = 0.2;

// Below this CPA the direction to the target is float dust — a numerical
// guard, not a safety threshold: at 1e-9 nm you're colliding, not passing.
const CPA_EPS_NM = 1e-9;

// AIS encodes "speed not available" as 102.3 kn; reject rather than believe
// it if the sentinel leaks through as a number. Mirrors OpenCPN's `gSog >
// 102.2` guard.
const MAX_PLAUSIBLE_SOG_KN = 102.2;

/** Half-width of the "abeam" sector, degrees of relative bearing at CPA.
 * See `crossingAspect` for why it needs a band at all. */
const DEFAULT_ABEAM_BAND_DEG = 15;

const KNOTS_PER_MS = 3600 / 1852;

/** SignalK reports SOG in m/s; this module speaks knots. Convert explicitly. */
export function knotsFromMs(sogMs: number): number {
  return sogMs * KNOTS_PER_MS;
}

/** A vessel as this module needs it. `cogDeg`/`sogKn` are optional because
 * real AIS targets genuinely lack them (a Class B target may report position
 * only). Their absence is a first-class input, not a caller error. */
export interface CpaVessel {
  /** Degrees, positive north. */
  lat: number;
  /** Degrees, positive east. */
  lng: number;
  /** Course over ground, degrees true. Ground track, not heading. */
  cogDeg?: number;
  /** Speed over ground, knots. See `knotsFromMs`. */
  sogKn?: number;
}

/** Where the target is when we are closest, relative to *our own bow* — i.e.
 * these describe what **we** do. See `crossingAspect` for the derivation
 * and the sign trap. */
export type CrossingAspect =
  /** We cross ahead of the target: we pass through its bow sector first. */
  | "ahead"
  /** We pass behind the target: it crosses our track first. */
  | "astern"
  /** Neither crosses the other's track — a beam/parallel/overtaking pass. */
  | "abeam"
  /** Our own course is unknown or we are stationary; "we pass" has no meaning. */
  | "unknown";

/** Which side of our own bow the target sits on at CPA — the dual of
 * `CrossingAspect`'s ahead/astern (same triangle), sharing its guards:
 * no side without a bow, none at a dead-on (zero-separation) CPA. */
export type CrossingSide = "port" | "starboard" | "unknown";

/** Note the fourth value: a target whose CPA can't be computed is `"unknown"`,
 * not green — "unknown" reading as "safe" is the failure mode this type
 * exists to prevent. */
export type Risk = "green" | "yellow" | "red" | "unknown";

export type CpaUnknownReason =
  // Not hypothetical: `signalk.ts` creates each vessel as `{lat: NaN, lng:
  // NaN}` until the first position delta arrives, and an unguarded NaN
  // silently reports **green** — a confident "safe" for an unknown location.
  | "position-unknown"
  /** Own ship has no usable SOG, or has speed but no COG. */
  | "own-velocity-unknown"
  /** Target has no usable SOG, or has speed but no COG (Class B minimal, AtoN). */
  | "target-velocity-unknown"
  /** Under way and matching the target's course/speed: separation never
   * changes, "closest approach" has no moment. Own ship *stopped* + target
   * at rest is different — see the `|v| = 0` branch in `computeCpa`. */
  | "no-relative-motion";

// No `cpaNm` field on the unknown branch, so a caller physically cannot read
// a CPA that doesn't exist (tsc rejects it) — unlike OpenCPN's `CPA=0,
// TCPA=0` + separate `bCPA_Valid` flag, where forgetting the flag reads a collision.
export type CpaResult =
  | {
      kind: "unknown";
      reason: CpaUnknownReason;
      risk: "unknown";
      /** Current distance to target — positions-only, so it survives every
       * *velocity* failure. `undefined` only for `"position-unknown"`; typed
       * rather than NaN so the absence must be handled explicitly. */
      rangeNm: number | undefined;
    }
  | {
      kind: "computed";
      /** Distance at closest approach, nautical miles. Never negative. */
      cpaNm: number;
      /** Minutes to closest approach. **Negative means it already happened**
       * and the target is receding — a past fact, not a threat.
       * `classifyRisk` returns green for any negative TCPA. */
      tcpaMin: number;
      /** Current distance to the target. */
      rangeNm: number;
      aspect: CrossingAspect;
      /** Which side we pass the target on — see `CrossingSide`. */
      side: CrossingSide;
      risk: Risk;
    };

/** Thresholds are parameters, not config. Red requires `redCpaNm` *and*
 * `redTcpaMin` — the same conjunction OpenCPN alarms on. Distance alone
 * isn't danger: a 0.1nm CPA four hours out isn't an emergency yet. */
export interface RiskThresholds {
  redCpaNm: number;
  redTcpaMin: number;
  yellowCpaNm: number;
  yellowTcpaMin: number;
}

export interface CpaOptions {
  thresholds: RiskThresholds;
  /** Half-width of the abeam sector, degrees. Defaults to `DEFAULT_ABEAM_BAND_DEG`. */
  abeamBandDeg?: number;
  /** SOG at/below which a vessel is at rest. Defaults to `MOORED_SPEED_KN`;
   * the app threads the boat's `collision.at_rest_kn` through here so a
   * mariner can tune it against their own GPS's jitter. */
  atRestKn?: number;
}

interface Vec {
  /** Nautical miles east, or knots eastward. */
  e: number;
  /** Nautical miles north, or knots northward. */
  n: number;
}

/** A usable, in-range position. Rejects NaN, Infinity, and out-of-range values. */
function hasPosition(v: CpaVessel): boolean {
  return (
    Number.isFinite(v.lat) &&
    Number.isFinite(v.lng) &&
    Math.abs(v.lat) <= 90 &&
    Math.abs(v.lng) <= 180
  );
}

/** Wrap a longitude difference to [-180, 180]. Handles the antimeridian. */
export function wrapLonDeltaDeg(deltaDeg: number): number {
  return ((((deltaDeg + 180) % 360) + 360) % 360) - 180;
}

/** Velocity in the local plane. COG is degrees true (clockwise from north);
 * plane is (east, north), so north = cos and east = sin — kept this way
 * rather than a "unit circle" conversion first, to avoid a hidden sign. */
function velocity(cogDeg: number, sogKn: number): Vec {
  const rad = cogDeg * DEG_TO_RAD;
  return { e: sogKn * Math.sin(rad), n: sogKn * Math.cos(rad) };
}

type Resolved = { ok: true; v: Vec; moving: boolean } | { ok: false };

/** Turn a vessel's optional COG/SOG into a velocity, or fail. At rest (SOG <=
 * `atRestKn`) a reported COG is GPS jitter and is discarded for (0,0); any
 * other missing/implausible value fails rather than guessing a course. */
function resolve(v: CpaVessel, atRestKn: number): Resolved {
  const { cogDeg, sogKn } = v;
  // Guard stays ABOVE the at-rest check: "no data" must never read as "at rest".
  if (sogKn === undefined || !Number.isFinite(sogKn)) return { ok: false };
  if (sogKn < 0 || sogKn > MAX_PLAUSIBLE_SOG_KN) return { ok: false };

  if (sogKn <= atRestKn) return { ok: true, v: { e: 0, n: 0 }, moving: false };

  if (cogDeg === undefined || !Number.isFinite(cogDeg)) return { ok: false };
  return { ok: true, v: velocity(cogDeg, sogKn), moving: true };
}

// Do we pass ahead of the target, or astern — own ship's action relative to
// the target's bow. NOT a typo: target FORWARD of our beam at CPA -> we
// pass ASTERN; ABAFT -> AHEAD. See docs/architecture/cpa-math.md.
function crossingAspect(
  dCpa: Vec,
  ownCourse: Vec,
  cpaNm: number,
  abeamBandDeg: number,
  atRestKn: number,
): CrossingAspect {
  const ownSpeed = Math.hypot(ownCourse.e, ownCourse.n);
  // No bow to be relative to: a vessel at anchor doesn't "pass" anyone, the
  // target passes *us*. Same at-rest threshold as `resolve`.
  if (ownSpeed <= atRestKn) return "unknown";
  // Direction is float dust at zero separation — a dead-on collision is
  // neither ahead nor astern.
  if (cpaNm <= CPA_EPS_NM) return "unknown";

  // Component of the at-CPA offset along our own course: > 0 means the target
  // is still forward of our beam when we are closest.
  const along = (dCpa.e * ownCourse.e + dCpa.n * ownCourse.n) / ownSpeed;
  // = cos(relative bearing of the target at CPA).
  const cosTheta = along / cpaNm;

  // |cos θ| <= sin(band)  ⟺  θ within `band` degrees of 90°.
  if (Math.abs(cosTheta) <= Math.sin(abeamBandDeg * DEG_TO_RAD)) return "abeam";
  return along > 0 ? "astern" : "ahead";
}

/** Which side of our own bow the target sits on at CPA — the dual of
 * `crossingAspect`'s ahead/astern, most useful for an `"abeam"` pass. The
 * cross product's sign: positive means dCpa is CCW from our course (port). */
function crossingSide(dCpa: Vec, ownCourse: Vec, cpaNm: number, atRestKn: number): CrossingSide {
  const ownSpeed = Math.hypot(ownCourse.e, ownCourse.n);
  if (ownSpeed <= atRestKn) return "unknown";
  if (cpaNm <= CPA_EPS_NM) return "unknown";
  const cross = ownCourse.e * dCpa.n - ownCourse.n * dCpa.e;
  return cross > 0 ? "port" : "starboard";
}

// Risk from CPA/TCPA. Full rationale (incl. the classic CPA "receding
// target" bug): docs/architecture/cpa-math.md.
export function classifyRisk(cpaNm: number, tcpaMin: number, t: RiskThresholds): Risk {
  // NaN would otherwise sail through every comparison to the default green.
  if (!Number.isFinite(cpaNm) || !Number.isFinite(tcpaMin)) return "unknown";
  // Negative TCPA = closest approach already happened, target is leaving:
  // always green, unconditionally, so no threshold below can colour it.
  // Diverges from OpenCPN's strict `TCPA > 0`: we allow TCPA = 0 to be red.
  if (tcpaMin < 0) return "green";
  if (cpaNm < t.redCpaNm && tcpaMin <= t.redTcpaMin) return "red";
  if (cpaNm < t.yellowCpaNm && tcpaMin <= t.yellowTcpaMin) return "yellow";
  return "green";
}

/** Current range, nautical miles. Needs positions only — always available. */
export function rangeNm(own: CpaVessel, target: CpaVessel): number {
  const { r } = plane(own, target);
  return Math.hypot(r.e, r.n);
}

/** Offset from own ship to target in the mid-latitude plane, nautical miles. */
function plane(own: CpaVessel, target: CpaVessel): { r: Vec } {
  const midLatRad = ((own.lat + target.lat) / 2) * DEG_TO_RAD;
  const dLonDeg = wrapLonDeltaDeg(target.lng - own.lng);
  return {
    r: {
      e: dLonDeg * ARCMIN_PER_DEG * Math.cos(midLatRad) * NM_PER_ARCMIN,
      n: (target.lat - own.lat) * ARCMIN_PER_DEG * NM_PER_ARCMIN,
    },
  };
}

/** Assess one target against own ship. Pure: same inputs, same output, no
 * clock, no globals. */
export function computeCpa(own: CpaVessel, target: CpaVessel, opts: CpaOptions): CpaResult {
  // NaN here would otherwise propagate through every number below and land
  // on "green". See `CpaUnknownReason["position-unknown"]`.
  if (!hasPosition(own) || !hasPosition(target)) {
    return { kind: "unknown", reason: "position-unknown", risk: "unknown", rangeNm: undefined };
  }

  const { r } = plane(own, target);
  const range = Math.hypot(r.e, r.n);

  const atRestKn = opts.atRestKn ?? MOORED_SPEED_KN;
  const ownV = resolve(own, atRestKn);
  if (!ownV.ok) {
    return { kind: "unknown", reason: "own-velocity-unknown", risk: "unknown", rangeNm: range };
  }
  const tgtV = resolve(target, atRestKn);
  if (!tgtV.ok) {
    return { kind: "unknown", reason: "target-velocity-unknown", risk: "unknown", rangeNm: range };
  }

  // Relative velocity: how the target moves as seen from own ship.
  const v: Vec = { e: tgtV.v.e - ownV.v.e, n: tgtV.v.n - ownV.v.n };
  const vSq = v.e * v.e + v.n * v.n;

  // |v| = 0: splits on *our own* velocity. Both-at-rest computes (CPA=range,
  // TCPA=0, risk forced GREEN, #CPA-MOORED-REST); under-way-matching stays
  // unknown (#AIS-GRAY). Full case split: docs/architecture/cpa-math.md.
  if (vSq <= SPEED_EPS_KN * SPEED_EPS_KN) {
    if (!ownV.moving) {
      return {
        kind: "computed",
        cpaNm: range,
        tcpaMin: 0,
        rangeNm: range,
        // At rest there is no bow, so "we pass ahead/astern" has no referent —
        // the same reasoning `crossingAspect` applies to a stationary own ship.
        aspect: "unknown",
        side: "unknown",
        // Both at rest → no closing motion → not a threat. Green, never red:
        // this is the one place a close constant-range pair is deliberately not
        // alarmed. Threats require a moving vessel, which never reaches here.
        risk: "green",
      };
    }
    return { kind: "unknown", reason: "no-relative-motion", risk: "unknown", rangeNm: range };
  }

  const tcpaHours = -(r.e * v.e + r.n * v.n) / vSq;
  const tcpaMin = tcpaHours * MIN_PER_HOUR;

  const dCpa: Vec = { e: r.e + v.e * tcpaHours, n: r.n + v.n * tcpaHours };
  const cpaNm = Math.hypot(dCpa.e, dCpa.n);

  return {
    kind: "computed",
    cpaNm,
    tcpaMin,
    rangeNm: range,
    aspect: crossingAspect(dCpa, ownV.v, cpaNm, opts.abeamBandDeg ?? DEFAULT_ABEAM_BAND_DEG, atRestKn),
    side: crossingSide(dCpa, ownV.v, cpaNm, atRestKn),
    risk: classifyRisk(cpaNm, tcpaMin, opts.thresholds),
  };
}
