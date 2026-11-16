/**
 * The mivport glyphs (./icons.ts) as the host's POI icons see them once the
 * source is registered: every mivport kind is a type with mivport's label,
 * every mivport-only POI kind resolves to a registered image, and the type
 * rule beats the kind rule. Written to hold whether or not another source
 * registering some of the same kind names is in the registry too.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PALETTES } from "../../../core/style/colors";
import {
  allPoiGlyphs,
  POI_GLYPHS,
  POI_KINDS,
  poiGlyphFor,
  poiIcon,
  poiIconExpr,
  poiImageIds,
  poiTypeIcon,
} from "../icons";
import { MIVPORT_SRC } from "./index";
import {
  MIVPORT_ALL_KINDS,
  MIVPORT_HOST_KIND,
  MIVPORT_KIND_GLYPHS,
  MIVPORT_KINDS,
  MIVPORT_TYPES,
} from "./icons";
import { registerMivport, unregisterMivport } from "./testing";

beforeAll(registerMivport);
afterAll(unregisterMivport);

// `GET /v1/kinds` (mivport, 2026-11-17): name → label. Pinned so a kind
// silently losing its type is a failing test.
const V1_KINDS: Record<string, string> = {
  marina: "Marina", harbour: "Harbour", anchorage: "Anchorage", mooring: "Mooring",
  fuel: "Fuel", harbour_office: "Harbour office", customs: "Customs", pump_out: "Pump-out",
  waste_disposal: "Waste disposal", slipway: "Slipway", boat_hoist: "Boat hoist / crane",
  boatyard: "Boatyard", sailmaker: "Sailmaker", chandlery: "Chandlery", boat_shop: "Boat shop",
  club: "Sailing club", water: "Drinking water", electricity: "Shore power", toilets: "Toilets",
  showers: "Showers", laundry: "Laundry", supermarket: "Supermarket",
  convenience: "Convenience store", bakery: "Bakery", hardware: "Hardware store",
  pharmacy: "Pharmacy", hospital: "Hospital / clinic", post_office: "Post office", bank: "Bank",
  atm: "ATM", restaurant: "Restaurant", cafe: "Café", pub: "Pub / bar", other: "Other",
};

describe("MIVPORT_TYPES", () => {
  test("one type per mivport kind, with mivport's own label", () => {
    expect([...MIVPORT_ALL_KINDS].sort()).toEqual(Object.keys(V1_KINDS).sort());
    for (const [kind, label] of Object.entries(V1_KINDS)) {
      expect(MIVPORT_TYPES[kind as keyof typeof MIVPORT_TYPES].label, kind).toBe(label);
    }
  });

  test("every type has a glyph, and no two types share one", () => {
    const seen = new Map<string, string>();
    for (const [kind, t] of Object.entries(MIVPORT_TYPES)) {
      expect(t.glyph.length, kind).toBeGreaterThan(0);
      const shape = JSON.stringify(t.glyph);
      expect(seen.get(shape), `${kind} duplicates ${seen.get(shape)}`).toBeUndefined();
      seen.set(shape, kind);
    }
  });

  test("a kind that maps to a host kind draws the host kind's glyph (a mivport and an OSM marina match)", () => {
    for (const [kind, host] of Object.entries(MIVPORT_HOST_KIND)) {
      expect(MIVPORT_TYPES[kind as keyof typeof MIVPORT_TYPES].glyph, kind).toBe(POI_GLYPHS[host!]);
    }
    expect(MIVPORT_TYPES.harbour_office.glyph).toBe(POI_GLYPHS.harbourmaster);
    expect(MIVPORT_TYPES.boat_shop.glyph).toBe(POI_GLYPHS.boat_dealer);
  });

  test("a mivport-only kind's type glyph IS its kind glyph (same shape on the map whichever source won the kind)", () => {
    for (const kind of MIVPORT_KINDS) expect(MIVPORT_TYPES[kind].glyph, kind).toBe(MIVPORT_KIND_GLYPHS[kind]);
  });

  test("the mivport-only kinds are exactly the kinds with no host kind (bar `other`)", () => {
    const unmapped = MIVPORT_ALL_KINDS.filter((k) => !MIVPORT_HOST_KIND[k] && k !== "other");
    expect([...MIVPORT_KINDS].sort()).toEqual([...unmapped].sort());
    for (const host of Object.values(MIVPORT_HOST_KIND)) expect(POI_KINDS as readonly string[]).toContain(host!);
  });

  test("accents: the marina family and fuel", () => {
    expect(MIVPORT_TYPES.marina.accent).toBe("marina");
    expect(MIVPORT_TYPES.harbour_office.accent).toBe("marina");
    expect(MIVPORT_TYPES.fuel.accent).toBe("fuel");
    expect(MIVPORT_TYPES.anchorage.accent).toBeUndefined();
  });
});

describe("registered with the host", () => {
  test("every mivport-only kind has a glyph and an image; every type an image", () => {
    const glyphs = allPoiGlyphs();
    for (const kind of MIVPORT_KINDS) expect(glyphs.has(kind), kind).toBe(true);
    // `other` is not claimed as a kind — it would restyle other sources' points.
    expect(MIVPORT_KINDS as readonly string[]).not.toContain("other");
    for (const palette of PALETTES) {
      const ids = poiImageIds(palette);
      for (const kind of MIVPORT_KINDS) expect(ids).toContain(poiIcon(kind, palette));
      for (const detail of MIVPORT_ALL_KINDS) expect(ids).toContain(poiTypeIcon(MIVPORT_SRC, detail, palette));
    }
  });

  test("poiIconExpr: a mivport case matching kind_detail over every type, falling back to the kind match", () => {
    for (const palette of PALETTES) {
      const expr = poiIconExpr(palette) as unknown[];
      expect(expr[0]).toBe("case");
      const at = expr.findIndex((e) => JSON.stringify(e) === JSON.stringify(["==", ["get", "src"], MIVPORT_SRC]));
      expect(at).toBeGreaterThan(0);
      const byType = expr[at + 1] as unknown[];
      const byKind = expr[expr.length - 1];
      expect(byType[0]).toBe("match");
      expect(byType[1]).toEqual(["get", "kind_detail"]);
      expect(byType[byType.length - 1]).toEqual(byKind);
      const registered = new Set(poiImageIds(palette));
      const pairs = byType.slice(2, -1);
      const covered: string[] = [];
      for (let i = 0; i < pairs.length; i += 2) {
        covered.push(pairs[i] as string);
        expect(pairs[i + 1]).toBe(poiTypeIcon(MIVPORT_SRC, pairs[i] as string, palette));
        expect(registered.has(pairs[i + 1] as string)).toBe(true);
      }
      expect(covered.sort()).toEqual([...MIVPORT_ALL_KINDS].sort());
    }
  });

  test("poiGlyphFor: a mivport point draws its type — `other` included, which has no kind glyph", () => {
    expect(poiGlyphFor({ src: MIVPORT_SRC, kind: "harbourmaster", kind_detail: "harbour_office" })).toBe(
      POI_GLYPHS.harbourmaster,
    );
    expect(poiGlyphFor({ src: MIVPORT_SRC, kind: "pump_out", kind_detail: "pump_out" })).toBe(
      MIVPORT_KIND_GLYPHS.pump_out,
    );
    expect(poiGlyphFor({ src: MIVPORT_SRC, kind: "other", kind_detail: "other" })).toBe(MIVPORT_TYPES.other.glyph);
    // A kind mivport adds later: the kind's glyph, else none (the default ring).
    expect(poiGlyphFor({ src: MIVPORT_SRC, kind: "fuel", kind_detail: "lpg" })).toBe(POI_GLYPHS.fuel);
    expect(poiGlyphFor({ src: MIVPORT_SRC, kind: "lpg", kind_detail: "lpg" })).toBeUndefined();
  });

  test("an OSM point never reads kind_detail as a mivport type", () => {
    expect(poiGlyphFor({ kind: "marina", kind_detail: "boat_hoist" })).toBe(POI_GLYPHS.marina);
  });
});
