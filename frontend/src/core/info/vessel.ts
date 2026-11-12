// What we can know about one vessel — own ship included — and how to get it
// out of the SignalK snapshot. Split from ./vesselProvider.ts: this file is
// *the AIS vocabulary and the identity rule*, that one is *how a mariner
// reads it*. See docs/architecture/ais-vessel-vocabulary.md. Field names map
// to SignalK paths in each field's own comment.

import { knotsFromMs, type CpaVessel } from "../cpa";
import type { BuddyMark, Vessel, VesselOrigin } from "../signalk";

/** One vessel's live record, in plotter units. Units ride in the names
 * (`sogMs`, `lengthM`, `rotDegPerMin`), following `signalk.ts`/`cpa.ts` — a
 * unit mismatch has to be visible at the call site. */
export interface AisVessel {
  /** Stable identity within the vessel provider (see `vesselId`) — the key
   * `detail` resolves from, and the only thing a non-map caller needs to hold. */
  id: string;
  /** Own ship. Not "the vessel whose MMSI matches ours" — see `vesselId`. */
  self?: boolean;

  /** When this target's data was last RECEIVED (browser clock ms). LOCAL time,
   * not `positionAtIso` — compared only against the same clock (no NTP at sea). */
  receivedAtMs?: number;
  /** On the skipper's buddy list. Set by `createSignalK`, not the wire. */
  buddy?: boolean;
  /** What the skipper calls that buddy. */
  buddyNickname?: string;
  /** The skipper's note on that buddy. */
  buddyNote?: string;
  /** Own receiver, online, or both: see `Vessel.origin` in ../signalk.ts. */
  origin?: VesselOrigin;

  // -- position and motion (SignalK `navigation.*`) -------------------------
  /** `navigation.position.longitude`, degrees east. */
  lng: number;
  /** `navigation.position.latitude`, degrees north. */
  lat: number;
  /** `navigation.headingTrue`, degrees. Where the bow points. */
  headingDeg?: number;
  /** `navigation.courseOverGroundTrue`, degrees. Where it actually goes. */
  cogDeg?: number;
  /** `navigation.speedOverGround`, m/s — SignalK's unit, not the display's. */
  sogMs?: number;
  /** `navigation.speedThroughWater`, m/s. Own ship only, in practice. */
  stwMs?: number;
  /** `navigation.rateOfTurn`, converted from SignalK's rad/s to the deg/min
   * that AIS reports. Positive is to starboard. */
  rotDegPerMin?: number;
  /** `navigation.datetime`, RFC 3339. When this fix was taken. */
  positionAtIso?: string;

  // -- identity (top-level keys and `communication.*`) ----------------------
  /** Top-level `name`. */
  name?: string;
  /** Top-level `mmsi`. Nine digits; a string because leading digits matter. */
  mmsi?: string;
  /** `communication.callsignVhf`. */
  callsign?: string;
  /** `registrations.imo`, e.g. `"IMO 9074729"`. Class A only. */
  imo?: string;
  /** Top-level `flag`. */
  flag?: string;
  /** Top-level `port`. */
  port?: string;
  /** `sensors.ais.class` — `"A"`, `"B"`, `"ATON"`, `"BASE"` in practice. A
   * string, not a union: the SignalK schema's enum constraint is inert
   * (a misspelled `pattern_` key), so we must not drop an unexpected value. */
  aisClass?: string;

  // -- what kind of ship (SignalK `design.*`) -------------------------------
  /** `design.aisShipType.name`, e.g. `"Sailing"`, `"Cargo"`. */
  shipType?: string;
  /** `design.aisShipType.id`, the raw AIS ship-and-cargo code (20-99). */
  shipTypeId?: number;
  /** `design.length.overall`, metres. */
  lengthM?: number;
  /** `design.beam`, metres. */
  beamM?: number;
  /** `design.airHeight`, metres. Air draft — what fits under the bridge. */
  airHeightM?: number;
  /** `design.draft.current`, falling back to `design.draft.maximum`, metres.
   * n2k-signalk writes to `maximum`, nmea0183-signalk to `current` — a
   * normalizer must read both. */
  draftM?: number;

  // -- where it is going (SignalK `navigation.*`) ---------------------------
  /** `navigation.state`, verbatim: `"motoring"`, `"anchored"`, … Class A only.
   * Kept as SignalK's raw string: both parsers emit values outside the spec's
   * enum, and unknown-but-shown beats dropped. */
  navStatus?: string;
  /** `navigation.destination.commonName` — as typed by the crew, so trust it lightly. */
  destination?: string;
  /** `navigation.destination.eta`, RFC 3339. */
  etaIso?: string;
  /** `navigation.specialManeuver`. Off-spec (schema says `navigation.maneuver`)
   * but it's what both parsers actually emit. */
  specialManeuver?: string;
}

/** Own ship's identity. See `vesselId` for why this is a constant. */
export const OWN_SHIP_ID = "self";

/** The wire shape, plus the AIS fields the backend does not send *yet*. Extra
 * keys are typed here so their arrival is a backend deploy, not a frontend
 * change (`Vessel` in ../signalk.ts declares only what's normalized today). */
type WireVessel = Vessel &
  Partial<Omit<AisVessel, "id" | "self" | "lng" | "lat" | "name" | "headingDeg" | "cogDeg" | "sogMs">> & {
    /** SignalK's own vessel key (`VesselTracker._vessels`), dropped building
     * the snapshot — putting it back matters for `vesselId`. */
    id?: string;
  };

/**
 * A vessel's identity, best available first — what `detail` resolves from.
 * Ladder ordered by *uniqueness first, stability second*: `id`, `mmsi:<mmsi>`,
 * then `at:<lat>,<lng>` (unique but NOT stable — a held hit stops resolving
 * across a position update rather than resolving wrong). Name is deliberately
 * not used as a fallback. See docs/architecture/ais-vessel-vocabulary.md.
 */
function vesselId(v: WireVessel): string {
  if (v.id) return v.id;
  if (v.mmsi) return `mmsi:${v.mmsi}`;
  return `at:${v.lat.toFixed(5)},${v.lng.toFixed(5)}`;
}

/** One wire vessel to one record. The cast is the single point where the
 * wire's forward-compatible fields are admitted: an omitted key reads as
 * `undefined`, exactly how the panel renders "the target did not tell us". */
function record(raw: Vessel, self: boolean): AisVessel {
  const v = raw as WireVessel;
  return { ...v, id: self ? OWN_SHIP_ID : vesselId(v), ...(self ? { self: true } : {}) };
}

/** A target with what the buddy list knows about it. A live target has no
 * name until its static data arrives, which aiscast repeats only every few
 * minutes, so the list's name stands in: without it the nickname would show
 * alone. The target's own name wins once it has one. */
export function markBuddy(v: AisVessel, mark: BuddyMark): AisVessel {
  return {
    ...v,
    name: v.name ?? mark.aisName,
    buddy: true,
    buddyNickname: mark.nickname,
    buddyNote: mark.note,
  };
}

/** The whole vessel picture as one list, own ship included. One list rather
 * than `(self, targets)` because every consumer treats them the same; the
 * two that do care ask `self` instead. */
export function vesselsFromSignalK(self: Vessel | null, targets: readonly Vessel[]): AisVessel[] {
  const out: AisVessel[] = [];
  if (self) out.push(record(self, true));
  for (const t of targets) out.push(record(t, false));
  return out;
}

/** Split the one shared vessel list back into own ship and targets — the
 * inverse of `vesselsFromSignalK`, letting the chart overlay consume the SAME
 * `SignalKState.vessels` memo the info provider does. */
export function ownAndTargets(vessels: readonly AisVessel[]): {
  self: AisVessel | null;
  targets: AisVessel[];
} {
  return {
    self: vessels.find((v) => v.self) ?? null,
    targets: vessels.filter((v) => !v.self),
  };
}

/** The view of a vessel that ../cpa.ts wants. The unit conversion lives here,
 * once, at the boundary — `cpa.ts` accepts only knots (`sogKn`). */
export function cpaVessel(v: AisVessel): CpaVessel {
  return {
    lat: v.lat,
    lng: v.lng,
    cogDeg: v.cogDeg,
    sogKn: v.sogMs === undefined ? undefined : knotsFromMs(v.sogMs),
  };
}
