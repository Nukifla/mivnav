// mivport glyphs: the POI kinds only mivport produces (OpenStreetMap's POI
// table has no such kind — the bake keeps the mivport kind as the POI kind
// for these) and one type per mivport kind (`MIVPORT_TYPES`, keyed by the
// baked `kind_detail`, which is always the mivport kind). Registered with the
// host's POI icons through the mivport POI source (./index.ts).
//
// GLYPH SOURCE: path data inlined from Lucide (`lucide-solid` 1.24.0, ISC,
// https://lucide.dev) as 24x24 `iconNode`s, like the host's POI_GLYPHS. The
// kind → icon choices follow the poi-testclient's KIND_GLYPHS (icons.js); the
// two composed glyphs (mooring, pump_out) are Lucide-weight drawings of
// our own.

import { POI_GLYPHS, type Prim } from "../icons";
import type { PoiSourceType } from "../sources";

/** Every mivport kind (`GET /v1/kinds`), in its own order. */
export const MIVPORT_ALL_KINDS = [
  "marina",
  "harbour",
  "anchorage",
  "mooring",
  "fuel",
  "harbour_office",
  "customs",
  "pump_out",
  "waste_disposal",
  "slipway",
  "boat_hoist",
  "boatyard",
  "sailmaker",
  "chandlery",
  "boat_shop",
  "club",
  "water",
  "electricity",
  "toilets",
  "showers",
  "laundry",
  "supermarket",
  "convenience",
  "bakery",
  "hardware",
  "pharmacy",
  "hospital",
  "post_office",
  "bank",
  "atm",
  "restaurant",
  "cafe",
  "pub",
  "other",
] as const;
export type MivportKind = (typeof MIVPORT_ALL_KINDS)[number];

/** mivport kind → the host POI kind the bake gives the point, where the host
 * has one (same mapping as the backend's). A kind absent here keeps its own
 * name as the POI kind. */
export const MIVPORT_HOST_KIND: Readonly<Partial<Record<MivportKind, keyof typeof POI_GLYPHS>>> = {
  marina: "marina",
  harbour: "harbour",
  anchorage: "anchorage",
  fuel: "fuel",
  harbour_office: "harbourmaster",
  slipway: "slipway",
  chandlery: "chandlery",
  boat_shop: "boat_dealer",
  toilets: "toilets",
  laundry: "laundry",
  supermarket: "supermarket",
  convenience: "convenience",
  bakery: "bakery",
  hardware: "hardware",
  pharmacy: "pharmacy",
  hospital: "hospital",
  post_office: "post_office",
  bank: "bank",
  atm: "atm",
  restaurant: "restaurant",
  cafe: "cafe",
  pub: "pub",
};

/** The POI kinds only mivport produces, in display order — each needs a
 * glyph of its own. `other` is deliberately NOT one: registering a kind
 * `other` glyph would also draw every other source's unknown-type point
 * (a plugin source's kind `other`) with it; a mivport `other` point draws its
 * TYPE glyph instead (`MIVPORT_TYPES.other`). */
export const MIVPORT_KINDS = [
  "mooring",
  "customs",
  "pump_out",
  "waste_disposal",
  "boat_hoist",
  "boatyard",
  "sailmaker",
  "club",
  "water",
  "electricity",
  "showers",
] as const;
export type MivportOnlyKind = (typeof MIVPORT_KINDS)[number];

/** mivport-only kind → glyph. The host's kind registry is first-wins on a
 * name another source also registers (water, pump_out, boatyard are
 * common), so a mivport point always draws its TYPE glyph (same shapes as
 * these) and never depends on which source won. */
export const MIVPORT_KIND_GLYPHS: Record<MivportOnlyKind, readonly Prim[]> = {
  // composed: a mooring ball, pick-up ring on top,
  // afloat on a wave
  mooring: [
    ["circle", 12, 4, 2],
    ["path", "M12 6v3"],
    ["path", "M5 16a7 7 0 0 1 14 0"],
    ["path", "M2 20c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"],
  ],
  // stamp
  customs: [
    ["path", "M14 13V8.5C14 7 15 7 15 5a3 3 0 0 0-6 0c0 2 1 2 1 3.5V13"],
    ["path", "M20 15.5a2.5 2.5 0 0 0-2.5-2.5h-11A2.5 2.5 0 0 0 4 15.5V17a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1z"],
    ["path", "M5 22h14"],
  ],
  // composed: a hull afloat with a hose rising from its
  // deck — the holding tank pumped out. Not the toilet, bin or droplet.
  pump_out: [
    ["path", "M3 14h18l-2 4H5z"],
    ["path", "M2 22c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"],
    ["path", "M8 14V9a5 5 0 0 1 5-5h7"],
    ["path", "m17 1 3 3-3 3"],
  ],
  // trash-2
  waste_disposal: [
    ["path", "M10 11v6"],
    ["path", "M14 11v6"],
    ["path", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"],
    ["path", "M3 6h18"],
    ["path", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"],
  ],
  // waves-arrow-up — lifted out of the water
  boat_hoist: [
    ["path", "M12 2v8"],
    ["path", "M2 15c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"],
    ["path", "M2 21c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"],
    ["path", "m8 6 4-4 4 4"],
  ],
  // hammer — distinct from hardware's wrench
  boatyard: [
    ["path", "m15 12-9.373 9.373a1 1 0 0 1-3.001-3L12 9"],
    ["path", "m18 15 4-4"],
    ["path", "m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172v-.344a2 2 0 0 0-.586-1.414l-1.657-1.657A6 6 0 0 0 12.516 3H9l1.243 1.243A6 6 0 0 1 12 8.485V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5"],
  ],
  // scissors
  sailmaker: [
    ["circle", 6, 6, 3],
    ["path", "M8.12 8.12 12 12"],
    ["path", "M20 4 8.12 15.88"],
    ["circle", 6, 18, 3],
    ["path", "M14.8 14.8 20 20"],
  ],
  // flag-triangle-right — a burgee
  club: [["path", "M6 22V2.8a.8.8 0 0 1 1.17-.71l11.38 5.69a.8.8 0 0 1 0 1.44L6 15.5"]],
  // droplet
  water: [
    ["path", "M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"],
  ],
  // plug-zap — shore power
  electricity: [
    ["path", "M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z"],
    ["path", "m2 22 3-3"],
    ["path", "M7.5 13.5 10 11"],
    ["path", "M10.5 16.5 13 14"],
    ["path", "m18 3-4 4h6l-4 4"],
  ],
  // shower-head
  showers: [
    ["path", "m4 4 2.5 2.5"],
    ["path", "M13.5 6.5a4.95 4.95 0 0 0-7 7"],
    ["path", "M15 5 5 15"],
    ["path", "M14 17v.01"],
    ["path", "M10 16v.01"],
    ["path", "M13 13v.01"],
    ["path", "M16 10v.01"],
    ["path", "M11 20v.01"],
    ["path", "M17 14v.01"],
    ["path", "M20 11v.01"],
  ],
};

/** map-pin — a mivport `other` place (no kind of its own). */
const OTHER_GLYPH: readonly Prim[] = [
  ["path", "M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"],
  ["circle", 12, 10, 3],
];

/** The labels `GET /v1/kinds` gives (mivport's own wording). */
const LABELS: Record<MivportKind, string> = {
  marina: "Marina",
  harbour: "Harbour",
  anchorage: "Anchorage",
  mooring: "Mooring",
  fuel: "Fuel",
  harbour_office: "Harbour office",
  customs: "Customs",
  pump_out: "Pump-out",
  waste_disposal: "Waste disposal",
  slipway: "Slipway",
  boat_hoist: "Boat hoist / crane",
  boatyard: "Boatyard",
  sailmaker: "Sailmaker",
  chandlery: "Chandlery",
  boat_shop: "Boat shop",
  club: "Sailing club",
  water: "Drinking water",
  electricity: "Shore power",
  toilets: "Toilets",
  showers: "Showers",
  laundry: "Laundry",
  supermarket: "Supermarket",
  convenience: "Convenience store",
  bakery: "Bakery",
  hardware: "Hardware store",
  pharmacy: "Pharmacy",
  hospital: "Hospital / clinic",
  post_office: "Post office",
  bank: "Bank",
  atm: "ATM",
  restaurant: "Restaurant",
  cafe: "Café",
  pub: "Pub / bar",
  other: "Other",
};

/** Accents like the host's: the marina blue for the marina family (the
 * harbour office too), the fuel colour for fuel. */
const ACCENT: Partial<Record<MivportKind, PoiSourceType["accent"]>> = {
  marina: "marina",
  harbour_office: "marina",
  fuel: "fuel",
};

function glyphFor(kind: MivportKind): readonly Prim[] {
  const host = MIVPORT_HOST_KIND[kind];
  if (host) return POI_GLYPHS[host];
  if (kind === "other") return OTHER_GLYPH;
  return MIVPORT_KIND_GLYPHS[kind as MivportOnlyKind];
}

/**
 * Every mivport kind as a place type, keyed by the baked `kind_detail`: the
 * info panel's subtitle is mivport's label, and the map draws `glyph` — the
 * host kind's own glyph where the kind maps to one (a mivport and an OSM
 * marina read the same), else the mivport-only glyph above.
 */
export const MIVPORT_TYPES: Readonly<Record<MivportKind, PoiSourceType>> = Object.fromEntries(
  MIVPORT_ALL_KINDS.map((kind) => {
    const accent = ACCENT[kind];
    const t: PoiSourceType = { label: LABELS[kind], glyph: glyphFor(kind) };
    return [kind, accent ? { ...t, accent } : t];
  }),
) as Record<MivportKind, PoiSourceType>;
