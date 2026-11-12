// What an MMSI says about who a station is and where it is from — the
// country (MID) sits at a different offset per production, NOT always "the
// first three digits". See docs/architecture/mmsi-grammar.md.

import { MID_TO_COUNTRY } from "./midTable.generated";

/** Closed union, not a string: unlike SignalK's open vocabularies (which we
 * must not reject values from), this is our own classification of a number
 * we parsed ourselves, so `unknown` covers the rest. */
export type MmsiKind =
  | "ship"
  | "group-ship"
  | "coast"
  | "sar-aircraft"
  | "aton"
  | "craft"
  | "handheld"
  | "sart"
  | "mob"
  | "epirb"
  | "amrd-b"
  | "unknown";

/** What an MMSI resolved to. */
export interface MmsiIdentity {
  kind: MmsiKind;
  /** The three MID digits, when the format carries one — present even if the
   * MID is unassigned, because "claims MID 299" and "has no MID" differ. */
  mid?: string;
  /** The ITU's name for the administration, when `mid` is one the ITU has
   * assigned. Absent for a freeform device, an unassigned MID, or a number
   * that did not parse — never a guess. */
  country?: string;
}

/** The non-ship productions. Order is load-bearing at one place — `00`
 * (coast) must be tried before `0` (group of ships) — so sorted longest-
 * prefix-first below to enforce it rather than rely on it. */
const PREFIXES: readonly { prefix: string; kind: MmsiKind; midAt?: number }[] = [
  { prefix: "970", kind: "sart" },
  { prefix: "972", kind: "mob" },
  { prefix: "974", kind: "epirb" },
  { prefix: "979", kind: "amrd-b" },
  { prefix: "111", kind: "sar-aircraft", midAt: 3 },
  { prefix: "00", kind: "coast", midAt: 2 },
  { prefix: "98", kind: "craft", midAt: 2 },
  { prefix: "99", kind: "aton", midAt: 2 },
  { prefix: "0", kind: "group-ship", midAt: 1 },
  { prefix: "8", kind: "handheld", midAt: 1 },
];

const ORDERED = [...PREFIXES].sort((a, b) => b.prefix.length - a.prefix.length);

/** Exactly nine digits. See `parseMmsi`. */
const MMSI_RE = /^\d{9}$/;

/** An MMSI, parsed — or `undefined` if it is not one. Strictly nine digits;
 * a shorter string is a number something has already damaged (e.g. a coast
 * station's leading zeroes stripped). See docs/architecture/mmsi-grammar.md. */
export function parseMmsi(mmsi: string): MmsiIdentity | undefined {
  if (!MMSI_RE.test(mmsi)) return undefined;

  for (const { prefix, kind, midAt } of ORDERED) {
    if (!mmsi.startsWith(prefix)) continue;
    // A freeform device (no `midAt`): the digits after the prefix are a
    // manufacturer id, and reading them as a MID would caption a distress
    // beacon with a country.
    if (midAt === undefined) return { kind };
    return identity(kind, mmsi.slice(midAt, midAt + 3));
  }

  // No special prefix matched, so the first digit is 2-7 and this is the plain
  // ship-station production — the common case, and the only one the folk rule
  // gets right.
  return identity("ship", mmsi.slice(0, 3));
}

function identity(kind: MmsiKind, mid: string): MmsiIdentity {
  const country = MID_TO_COUNTRY[mid];
  return country === undefined ? { kind, mid } : { kind, mid, country };
}

/** NOT collision targets: a fixed/charted object, so a CPA against it is
 * meaningless (an AtoN painted risk-red would be a lie). `sar-aircraft` is
 * deliberately absent — it moves, so it draws as a moving hull — but it is no
 * collision target either: see `isSarAircraft`. */
const NON_VESSEL_KINDS: ReadonlySet<MmsiKind> = new Set([
  "aton",
  "coast",
  "sart",
  "mob",
  "epirb",
]);

/** `false` for an absent/unparseable MMSI and every ship/aircraft kind. The
 * collision path uses this to keep AtoNs/beacons out of CPA. */
export function isNonVesselStation(mmsi: string | undefined): boolean {
  if (mmsi === undefined) return false;
  const kind = parseMmsi(mmsi)?.kind;
  return kind !== undefined && NON_VESSEL_KINDS.has(kind);
}

/** A SAR aircraft (`111MIDXXX`, AIS message 9). Moving, so not a station —
 * but airborne, so a CPA against it says nothing about collision: no risk
 * colour, CPA line or alarm (the backend's `is_sar_aircraft` mirrors this). */
export function isSarAircraft(mmsi: string | undefined): boolean {
  return mmsi !== undefined && parseMmsi(mmsi)?.kind === "sar-aircraft";
}

/** The ITU's name, verbatim and deliberately UNPRETTIFIED — DO NOT trim the
 * parentheticals: `440 Korea (Republic of)` vs `445 Democratic People's
 * Republic of Korea` would collapse to the same name if stripped. */
export function mmsiCountry(mmsi: string | undefined): string | undefined {
  return mmsi === undefined ? undefined : parseMmsi(mmsi)?.country;
}
