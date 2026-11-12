// Vessels (AIS/own ship) as an InfoProvider — the first non-chart one; see
// docs/architecture/vessel-info-provider.md for the design rationale.

import { bearingDeg } from "../chrome/geo";
import { formatAgo, formatRangeStr, padDeg, withNickname } from "../format";
import {
  computeCpa,
  knotsFromMs,
  type CpaResult,
  type CrossingAspect,
  type CrossingSide,
  type CpaUnknownReason,
  type Risk,
  type RiskThresholds,
} from "../cpa";
import { degreesDecimalMinutes } from "../coordinate";
import { isNonVesselStation, isSarAircraft, mmsiCountry } from "../mmsi";
import { createVesselIcon, vesselIconModel } from "./BoatGlyph";
import { DEFAULT_SETTINGS, type ChartSettings } from "../style/settings";
import type { VesselOrigin } from "../signalk";
import { cpaVessel, type AisVessel } from "./vessel";
import type {
  InfoAction,
  InfoDetail,
  InfoHit,
  InfoIconProps,
  InfoPoint,
  InfoQuery,
  InfoProvider,
  InfoRow,
} from "./types";
import type { Component } from "solid-js";

export const VESSEL_PROVIDER_ID = "vessels";

// Tap tolerance for a vessel, floors (never caps) the caller's radius — the
// seam's 8px default (../info/attach.tsx) suits a depth contour, not a
// ~22px vessel symbol a finger can land 11px off.
const VESSEL_TAP_RADIUS_PX = 14;

// Fallback CPA thresholds (OpenCPN's units/defaults). Not a config surface —
// real thresholds come from settings; this is just a sane number for a
// caller wiring the provider before those settings exist.
export const DEFAULT_CPA_THRESHOLDS: RiskThresholds = {
  redCpaNm: 0.5,
  redTcpaMin: 20,
  yellowCpaNm: 1,
  yellowTcpaMin: 30,
};

// Nautical miles, metres under one — shares `chrome/geo.ts`'s `formatRange`
// rather than re-rounding (this file/AisSection/cursor readout used to
// disagree on precision). `—` here is this file's own non-finite fallback.
export function formatDistanceNm(nm: number): string {
  if (!Number.isFinite(nm)) return "—";
  return formatRangeStr(nm);
}

/** Three digits and a degree sign, using `chrome/geo.ts`'s `padDeg`. The `—`
 * fallback and the [0, 360) normalisation (bearing can arrive negative) are
 * this file's own. */
export function formatBearingDeg(deg: number): string {
  if (!Number.isFinite(deg)) return "—";
  return `${padDeg(((deg % 360) + 360) % 360)}°`;
}

/** SignalK's m/s to the knots a mariner reads. */
function formatSpeedMs(ms: number): string {
  return `${knotsFromMs(ms).toFixed(1)} kn`;
}

/** Minutes to closest approach, as a phrase. The sign matters: negative TCPA
 * means closest approach already happened and the target is opening, so it's
 * phrased "X ago" rather than a bare "-4 min" that reads as imminent. */
export function formatTcpaMin(min: number): string {
  if (!Number.isFinite(min)) return "—";
  const abs = Math.abs(min);
  let span: string;
  if (abs < 1) {
    const secs = Math.round(abs * 60);
    // Rounds to 0s: "now", not "in 0s" (never-ticking countdown) or "0s ago" (receding).
    if (secs === 0) return "now";
    span = `${secs} s`;
  } else if (abs < 60) span = `${abs < 10 ? abs.toFixed(1) : Math.round(abs)} min`;
  else span = `${Math.floor(abs / 60)} h ${Math.round(abs % 60)} min`;
  return min < 0 ? `${span} ago` : `in ${span}`;
}

/** Metres, without trailing zeroes: 120 m, 4.5 m. */
function formatMetres(m: number): string {
  return `${Number(m.toFixed(1))} m`;
}

/** Degrees and decimal minutes — how a position is written on a chart and
 * read over the radio, not the decimal degrees a computer would print. */
export function formatLatLng(lat: number, lng: number): string {
  return `${dm(lat, "N", "S")}  ${dm(lng, "E", "W", 3)}`;
}

/** Arithmetic is `../coordinate.ts`'s `degreesDecimalMinutes` (shared with
 * `info/pointProvider.ts`'s `dm`); this wrapper only owns the
 * space-and-straight-quote spacing, not `coordinate.ts`'s `′N`-no-space form. */
function dm(value: number, pos: string, neg: string, degWidth = 2): string {
  const hemi = value < 0 ? neg : pos;
  const { deg, min } = degreesDecimalMinutes(value, 3);
  return `${String(deg).padStart(degWidth, "0")}° ${min.padStart(6, "0")}' ${hemi}`;
}

/** An RFC 3339 instant, in UTC and said so — deliberately not the viewer's
 * locale, since an unlabelled local time is a navigation error waiting for a
 * border crossing. Unparseable input is shown verbatim rather than swallowed. */
export function formatInstant(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** SignalK's status strings are lowercase prose; only the first letter is ours. */
function sentence(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const ORIGIN_TEXT: Record<VesselOrigin, string> = {
  local: "Own receiver",
  online: "Online — not heard on own receiver",
  both: "Own receiver and online",
};

const RISK_LABEL: Record<Risk, string> = {
  red: "high",
  yellow: "moderate",
  green: "low",
  unknown: "unknown",
};

const ASPECT_TEXT: Record<CrossingAspect, string> = {
  // Describes what *we* do, relative to the target's bow (see `crossingAspect`
  // in ../cpa.ts for the sign trap). Do not paraphrase to "it passes ahead" —
  // that is the opposite claim.
  ahead: "we pass ahead of it",
  astern: "we pass astern of it",
  abeam: "abeam — side by side",
  unknown: "unknown",
};

/** `"abeam"` alone doesn't say which side the target is on; `side` (see
 * `crossingSide` in ../cpa.ts) fills that in. Other aspects don't need it. */
function aspectText(aspect: CrossingAspect, side: CrossingSide): string {
  if (aspect === "abeam" && side !== "unknown") return `abeam — passing to ${side}`;
  return ASPECT_TEXT[aspect];
}

const UNKNOWN_REASON_TEXT: Record<CpaUnknownReason, string> = {
  "position-unknown": "position not known",
  "own-velocity-unknown": "own course or speed not known",
  "target-velocity-unknown": "target reports no course or speed",
  "no-relative-motion": "no relative motion — the separation does not change",
};

// The collision rows. Always present when own ship is known, even when CPA
// can't be computed — an absent section reads as "nothing to say", which
// reads as safe, undoing `cpa.ts`'s work to keep unknown != green.
function collisionRows(result: CpaResult, bearingDeg: number | undefined): InfoRow[] {
  const rows: InfoRow[] = [];
  if (result.rangeNm !== undefined) {
    rows.push({ label: "Range", value: formatDistanceNm(result.rangeNm) });
  }
  // Range and bearing travel together, and both survive an unknown velocity
  // (need only the two positions) — "1.2 nm away" alone is half an answer.
  if (bearingDeg !== undefined) rows.push({ label: "Bearing", value: formatBearingDeg(bearingDeg) });
  if (result.kind === "computed") {
    rows.push({ label: "CPA", value: formatDistanceNm(result.cpaNm), emphasis: result.risk === "red" });
    rows.push({ label: "TCPA", value: formatTcpaMin(result.tcpaMin), emphasis: result.risk === "red" });
    rows.push({ label: "Aspect", value: aspectText(result.aspect, result.side) });
    rows.push({
      label: "Collision risk",
      value: RISK_LABEL[result.risk],
      emphasis: result.risk !== "green", // green is the only one not called out
    });
  } else {
    rows.push({
      label: "Collision risk",
      value: `unknown — ${UNKNOWN_REASON_TEXT[result.reason]}`,
      emphasis: true,
    });
  }
  return rows;
}

/** The one-line verdict that rides in the hit's subtitle. */
function collisionSummary(result: CpaResult): string {
  if (result.kind === "computed") {
    return `CPA ${formatDistanceNm(result.cpaNm)} ${formatTcpaMin(result.tcpaMin)}`;
  }
  if (result.rangeNm !== undefined) {
    return `${formatDistanceNm(result.rangeNm)} away · CPA unknown`;
  }
  return "CPA unknown";
}

// What to call a vessel that told us almost nothing. Every rung is
// actionable (radio name, call sign, MMSI for DSC); "AIS target" is the
// honest floor for a normal position-only report, not an error.
function titleOf(v: AisVessel): string {
  if (v.self) return v.name ?? "Own ship";
  return (
    withNickname(v.name, v.buddyNickname) ??
    v.callsign ??
    (v.mmsi ? `MMSI ${v.mmsi}` : "AIS target")
  );
}

/** The identifying fact, when there is no collision verdict to show instead. */
function descriptorOf(v: AisVessel): string | undefined {
  if (v.shipType) return v.shipType;
  if (v.mmsi) return `MMSI ${v.mmsi}`;
  if (v.aisClass) return `AIS class ${v.aisClass}`;
  return undefined;
}

// Add a row, or — for own ship only — a blank one. A target's missing field
// is noise; own ship's missing field tells the skipper their AIS static
// data isn't configured, which is why this view exists.
function push(rows: InfoRow[], label: string, value: string | undefined, blank: boolean): void {
  if (value !== undefined) rows.push({ label, value });
  else if (blank) rows.push({ label, value: "—" });
}

/** What it is. */
function vesselRows(v: AisVessel): InfoRow[] {
  const rows: InfoRow[] = [];
  const own = v.self === true;
  if (v.buddy) rows.push({ label: "Buddy", value: "On your buddy list" });
  if (v.buddyNote) rows.push({ label: "Buddy note", value: v.buddyNote });
  push(rows, "MMSI", v.mmsi, own);
  push(rows, "Country", mmsiCountry(v.mmsi), own);
  push(rows, "Call sign", v.callsign, own);
  push(rows, "IMO", v.imo, false);
  push(rows, "Ship type", shipTypeText(v), own);
  push(rows, "AIS class", v.aisClass, own);
  // "Flag" (SignalK's reported flag) vs "Country" (MMSI registration) are kept
  // separate deliberately: a mismatch (re-registration static data hasn't
  // caught up with) is information a mariner may want, not ours to resolve.
  push(rows, "Flag", v.flag, false);
  push(rows, "Home port", v.port, false);
  push(rows, "Length", v.lengthM === undefined ? undefined : formatMetres(v.lengthM), own);
  push(rows, "Beam", v.beamM === undefined ? undefined : formatMetres(v.beamM), own);
  push(rows, "Draft", v.draftM === undefined ? undefined : formatMetres(v.draftM), own);
  push(rows, "Air draft", v.airHeightM === undefined ? undefined : formatMetres(v.airHeightM), false);
  return rows;
}

function shipTypeText(v: AisVessel): string | undefined {
  if (v.shipType) return v.shipTypeId === undefined ? v.shipType : `${v.shipType} (${v.shipTypeId})`;
  return v.shipTypeId === undefined ? undefined : `AIS type ${v.shipTypeId}`;
}

/** Where it is going. */
function voyageRows(v: AisVessel): InfoRow[] {
  const rows: InfoRow[] = [];
  const own = v.self === true;
  push(rows, "Status", v.navStatus === undefined ? undefined : sentence(v.navStatus), own);
  push(rows, "Destination", v.destination, own);
  push(rows, "ETA", v.etaIso === undefined ? undefined : formatInstant(v.etaIso), own);
  push(rows, "Manoeuvre", v.specialManeuver === undefined ? undefined : sentence(v.specialManeuver), false);
  return rows;
}

/** Where it is and how it is moving. Position is unconditional — a vessel
 * without one is never published (`VesselTracker.snapshot`) — so this row
 * guarantees the panel is never empty. */
function motionRows(v: AisVessel, nowMs: number): InfoRow[] {
  const rows: InfoRow[] = [];
  push(rows, "COG", v.cogDeg === undefined ? undefined : formatBearingDeg(v.cogDeg), false);
  push(rows, "SOG", v.sogMs === undefined ? undefined : formatSpeedMs(v.sogMs), false);
  push(rows, "Heading", v.headingDeg === undefined ? undefined : formatBearingDeg(v.headingDeg), false);
  push(
    rows,
    "Rate of turn",
    v.rotDegPerMin === undefined ? undefined : `${v.rotDegPerMin.toFixed(0)}°/min`,
    false,
  );
  push(rows, "Speed through water", v.stwMs === undefined ? undefined : formatSpeedMs(v.stwMs), false);
  rows.push({ label: "Position", value: formatLatLng(v.lat, v.lng) });
  if (!v.self && v.origin) rows.push({ label: "Source", value: ORIGIN_TEXT[v.origin] });
  push(rows, "Fix time", v.positionAtIso === undefined ? undefined : formatInstant(v.positionAtIso), false);
  // Local receive age (tablet clock), not `positionAtIso` (the fix's GPS
  // clock) — comparable only against itself. Own ship omits this: "last
  // received" is a fact about a remote station.
  if (!v.self && v.receivedAtMs !== undefined) {
    rows.push({ label: "Last received", value: formatAgo((nowMs - v.receivedAtMs) / 1000) });
  }
  return rows;
}

export interface VesselProviderOptions {
  /** The whole live picture, own ship included — see `vesselsFromSignalK`.
   * Read on every query, never cached: the answer to "is that ship going to
   * hit me" is only true for the instant it was asked. */
  vessels: () => readonly AisVessel[];
  /** The boat's (`collisionSettings.ts` `riskThresholds`), passed in, so the
   * panel's verdict matches the chart's colour and the alarm. */
  thresholds: () => RiskThresholds;
  /** The boat's at-rest SOG (`collision.at_rest_kn`). Absent → `cpa.ts`'s default. */
  atRestKn?: () => number;
  /** Live chart settings, for the per-hit icon (`palette`, `showAisRisk`) —
   * matches what the map's `targetFeatures` uses to draw the same hull.
   * Optional/defaults to `DEFAULT_SETTINGS`: cosmetic only, unlike `thresholds`. */
  settings?: () => ChartSettings;
  /** Geographic to screen — a function rather than the map so this is
   * drivable in tests with no WebGL and no DOM. */
  project: (p: InfoPoint) => { x: number; y: number };
  /** `Date.now()` ms, for the "Last received" row. A ticking signal
   * (attach.tsx's 1Hz `createClock`) so it counts up while open — `watch`
   * reads it to subscribe. Defaults to a static, non-ticking `Date.now`. */
  now?: () => number;
  /** Extra buttons on a vessel's panel, offered by a feature: core must not
   * know about buddies. */
  actions?: (v: AisVessel) => readonly InfoAction[];
}

// A hit for a vessel from an id alone — the non-map entry point: a list,
// search result or alarm calls `state.show([vesselInfoHit(id)])` and
// `detail` resolves it. Title/priority are placeholders `detail` overrides.
export function vesselInfoHit(id: string, title = "Vessel"): InfoHit {
  return { providerId: VESSEL_PROVIDER_ID, id, priority: "traffic", precision: "point", title };
}

export function createVesselInfoProvider(opts: VesselProviderOptions): InfoProvider {
  const settings = opts.settings ?? (() => DEFAULT_SETTINGS);
  const now = opts.now ?? (() => Date.now());
  /** Own ship is the vessel that says it is. */
  const own = (): AisVessel | undefined => opts.vessels().find((v) => v.self);

  /** A target's collision assessment, or `undefined` when there is no own
   * ship to assess against — distinct from an unknown CPA; must not render
   * as one. Own ship has no CPA against itself. */
  const assess = (v: AisVessel): CpaResult | undefined => {
    if (v.self) return undefined;
    // AtoN/base/SART stations aren't collision targets — no CPA/priority/
    // Collision section, matching the exclusion aisSymbols.ts's
    // `stationSymbol` makes so the panel agrees with the chart.
    // Nor is a SAR aircraft: it flies, so a CPA against it is meaningless.
    if (isNonVesselStation(v.mmsi) || isSarAircraft(v.mmsi)) return undefined;
    const me = own();
    if (!me) return undefined;
    return computeCpa(cpaVessel(me), cpaVessel(v), {
      thresholds: opts.thresholds(),
      atRestKn: opts.atRestKn?.(),
    });
  };

  /** Bearing from own ship, when there is an own ship to take one from. */
  const bearingTo = (v: AisVessel): number | undefined => {
    const me = own();
    if (!me || v.self) return undefined;
    const b = bearingDeg(me, v);
    return Number.isFinite(b) ? b : undefined;
  };

  const priorityOf = (result: CpaResult | undefined) => {
    // Why ../rank.ts takes priority from the provider: red outranks a
    // charted wreck, but *unknown* stays `traffic` — treating it as danger
    // would train the mariner to ignore the top of the list.
    if (result?.risk === "red") return "danger" as const;
    if (result?.risk === "yellow") return "hazard" as const;
    return "traffic" as const;
  };

  const subtitleOf = (v: AisVessel, result: CpaResult | undefined) => {
    if (v.self) return v.mmsi ? `Own ship · MMSI ${v.mmsi}` : "Own ship";
    return result ? collisionSummary(result) : descriptorOf(v);
  };

  return {
    id: VESSEL_PROVIDER_ID,
    label: "AIS",

    queryAt(query: InfoQuery): InfoHit[] {
      const r = Math.max(query.radius, VESSEL_TAP_RADIUS_PX);
      const hits: { hit: InfoHit; d: number }[] = [];
      for (const v of opts.vessels()) {
        const { x, y } = opts.project({ lng: v.lng, lat: v.lat });
        const d = Math.hypot(x - query.point.x, y - query.point.y);
        if (!(d <= r)) continue; // negated: a NaN distance is not a hit
        const result = assess(v);
        hits.push({
          d,
          hit: {
            providerId: VESSEL_PROVIDER_ID,
            id: v.id,
            priority: priorityOf(result),
            precision: "point", // always: a vessel is a position
            title: titleOf(v),
            subtitle: subtitleOf(v, result),
            lngLat: { lng: v.lng, lat: v.lat },
            payload: v, // lets a tap resolve without a second lookup; `detail` never requires it
          },
        });
      }
      // Nearest first — the tiebreak between two vessels in the same priority band.
      return hits.sort((a, b) => a.d - b.d).map((h) => h.hit);
    },

    // The live position, never the possibly-stale `hit.lngLat`. `undefined`
    // takes the marker off the chart (`locateHit`, ./registry.ts) rather
    // than showing it where the ship provably isn't.
    locate(hit: InfoHit): InfoPoint | undefined {
      const v = opts.vessels().find((x) => x.id === hit.id);
      return v && { lng: v.lng, lat: v.lat };
    },

    // The vessel glyph, built from the LIVE record/settings so it turns and
    // recolours as the target moves while the panel is open. Risk comes
    // from this provider's own `assess`, so colour and rank cannot diverge.
    icon(hit: InfoHit): Component<InfoIconProps> {
      return createVesselIcon(() => {
        const v =
          opts.vessels().find((x) => x.id === hit.id) ?? (hit.payload as AisVessel | undefined);
        if (!v) return undefined;
        return vesselIconModel(v, settings(), assess(v)?.risk ?? "unknown");
      });
    },

    // Not the target's own record: half of what `detail` shows is a CPA
    // against own ship, which changes as we move even while the target
    // sends nothing. No `hit` param — nothing here is narrower than this.
    watch(): void {
      void opts.vessels();
      void opts.thresholds();
      void now(); // "Last received" counts up on its own; this re-resolves it each tick
    },

    detail(hit: InfoHit): InfoDetail {
      // Resolved from `hit.id` against the LIVE list, ignoring the payload
      // when the id still resolves — the payload is a stale snapshot from
      // the moment of the tap.
      const live = opts.vessels().find((v) => v.id === hit.id);
      const stale = live === undefined;
      const v = live ?? (hit.payload as AisVessel | undefined);
      if (!v) {
        return {
          sections: [{ rows: [{ label: "Vessel", value: "no longer being received" }] }],
        };
      }
      const result = assess(v);
      // Not on a stale record: acting on a boat that has gone is a surprise.
      const actions = stale ? [] : (opts.actions?.(v) ?? []);
      return {
        title: titleOf(v),
        subtitle: subtitleOf(v, result),
        ...(actions.length > 0 ? { footerActions: actions } : {}),
        sections: [
          // Whether it will hit us, how it is moving, where it is going, and
          // last what it is: what matters at the helm first, and size and
          // registration only for someone who scrolls.
          ...(result ? [{ label: "Collision", rows: collisionRows(result, bearingTo(v)) }] : []),
          { label: "Position", rows: motionRows(v, now()) },
          { label: "Voyage", rows: voyageRows(v) },
          { label: "Vessel", rows: vesselRows(v) },
          ...(stale
            ? [
                {
                  rows: [
                    {
                      label: "Note",
                      value: "no longer being received — shown as last heard",
                      emphasis: true,
                    },
                  ],
                },
              ]
            : []),
        ],
      };
    },
  };
}
