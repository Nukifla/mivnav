// Buddies: the wire shape and everything pure about reading it. See
// docs/architecture/buddies.md.

import type { Feature, FeatureCollection } from "geojson";
import type { AisVessel } from "../../core/info/vessel";
import { withNickname } from "../../core/format";
import { bodyShape, hullIcon, symbolColors } from "../../core/layers/aisSymbols";
import { isNonVesselStation, isSarAircraft } from "../../core/mmsi";
import { haloPaint, type Palette } from "../../core/style/colors";

export interface BuddyPosition {
  lat: number;
  lng: number;
  /** The provider that delivered it: `signalk` or `aiscast` today. */
  source: string;
  /** What the source says about its route: `local`, `online`, `aishub`, … */
  via?: string;
  fixAtIso: string;
  /** Seconds old, worked out on the server. Never recompute from `fixAtIso`:
   * the tablet's clock is not comparable to it (no NTP at sea). */
  ageS: number;
  cogDeg?: number;
  sogMs?: number;
  headingDeg?: number;
}

export interface Buddy {
  id: string;
  /** What the skipper calls it. */
  nickname?: string;
  note?: string;
  /** What the boat calls itself. */
  aisName?: string;
  mmsi?: string;
  callsign?: string;
  shipTypeId?: number;
  lengthM?: number;
  position?: BuddyPosition;
}

export interface BuddyList {
  buddies: Buddy[];
  lastPoll?: { atIso: string; ok: boolean };
}

/** Past this a position is drawn hollow: it says where the boat WAS. */
export const OLD_AFTER_S = 3_600;

/** "SEABIRD (bird)": the AIS name is what's on the radio, so it comes first and
 * the nickname follows in parentheses. A boat with no AIS name goes by its nickname. */
export function displayName(b: Buddy): string {
  return withNickname(b.aisName, b.nickname) ?? (b.mmsi ? `MMSI ${b.mmsi}` : "Buddy");
}

/** "12 min", "6 h", "5 d": `formatAgo` stops at hours, and "131 h" is not how
 * anyone says "five days". */
export function shortAge(ageS: number): string {
  const s = Math.max(0, ageS);
  if (s < 60) return "now";
  if (s < 3_600) return `${Math.floor(s / 60)} min`;
  if (s < 172_800) return `${Math.floor(s / 3_600)} h`;
  return `${Math.floor(s / 86_400)} d`;
}

export const ageText = (ageS: number): string => {
  const short = shortAge(ageS);
  return short === "now" ? "just now" : `${short} ago`;
};

const VIA_TEXT: Record<string, string> = { aishub: "AISHub", aisstream: "aisstream" };

export function sourceText(p: BuddyPosition): string {
  if (p.source === "signalk") return p.via === "local" ? "Own receiver" : "Online (aiscast)";
  if (p.source === "aiscast") {
    return p.via ? `Online (aiscast, ${VIA_TEXT[p.via] ?? p.via})` : "Online (aiscast)";
  }
  return p.source;
}

/** Buddies to draw ourselves: positioned and not already on the chart as a
 * live target. A live target has real motion and a CPA, so it always wins.
 * These never join the target list: a CPA from a days-old position, or a
 * predictor from its last speed, would be a confident lie. */
export function remembered(buddies: readonly Buddy[], liveMmsis: ReadonlySet<string>): Buddy[] {
  return buddies.filter((b) => b.position && !(b.mmsi && liveMmsis.has(b.mmsi)));
}

/** Worth following: a boat with an MMSI that isn't already a buddy. A station
 * doesn't move and a SAR aircraft isn't a boat. */
export function canAddBuddy(v: AisVessel): boolean {
  return (
    !v.self &&
    !v.buddy &&
    v.mmsi !== undefined &&
    !isNonVesselStation(v.mmsi) &&
    !isSarAircraft(v.mmsi)
  );
}

/** The buddies matching `query`, in any field the skipper could remember one
 * by. Every word must match somewhere, so "bird tromsø" finds a nickname plus a note. */
export function filterBuddies(buddies: readonly Buddy[], query: string): Buddy[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...buddies];
  return buddies.filter((b) => {
    const text = [b.aisName, b.nickname, b.mmsi, b.callsign, b.note]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** Newest position first, boats with none last. */
export function sortBuddies(buddies: readonly Buddy[]): Buddy[] {
  const age = (b: Buddy) => b.position?.ageS ?? Number.POSITIVE_INFINITY;
  return [...buddies].sort((a, b) => age(a) - age(b) || displayName(a).localeCompare(displayName(b)));
}

export function buddyFeatures(buddies: readonly Buddy[], palette: Palette): FeatureCollection {
  const { ui, uiHalo } = symbolColors(palette);
  const glow = haloPaint(palette);
  const features: Feature[] = [];
  for (const b of buddies) {
    const p = b.position;
    if (!p) continue;
    const body = bodyShape({ mmsi: b.mmsi, shipTypeId: b.shipTypeId });
    const short = shortAge(p.ageS);
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p.lng, p.lat] },
      properties: {
        id: b.id,
        icon: hullIcon(p.ageS > OLD_AFTER_S ? "buddy-old" : "buddy", palette, body),
        rotation: p.headingDeg ?? p.cogDeg ?? 0,
        label: short === "now" ? displayName(b) : `${displayName(b)} · ${short}`,
        textColor: ui,
        haloColor: uiHalo,
        haloWidth: glow["text-halo-width"] ?? 0,
        haloBlur: glow["text-halo-blur"] ?? 0,
      },
    });
  }
  return { type: "FeatureCollection", features };
}
