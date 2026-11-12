/**
 * The per-kind POI icons: the kind→icon-id mapping, the palette-named image-id
 * naming, and the `icon-image` match expression. Pure pieces only — the canvas
 * drawing (`ensurePoiImages`) needs a DOM and is a no-op headless, exactly as
 * signalkShips' drawing is left untested; what a unit test can assert is that
 * every kind resolves to an id in the registered set (no missing image), that
 * ids are distinct per palette, and that the mapping matches the backend list.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { PALETTES } from "../../core/style/colors";
import {
  POI_DEFAULT_KIND,
  POI_GLYPHS,
  POI_KINDS,
  poiGlyphFor,
  poiIcon,
  poiIconExpr,
  poiImageIds,
  poiTypeIcon,
} from "./icons";
import { registerPoiSource, resetPoiSources } from "./sources";

afterEach(resetPoiSources);

// The authoritative kind list — `POI_CATEGORIES` in
// backend/mivnav/features/poi/tags.py (marine first, then land). Pinned here
// so a drift in either direction is a failing test rather than a
// silently-missing icon.
const BACKEND_KINDS = [
  "marina",
  "harbour",
  "anchorage",
  "harbourmaster",
  "fuel",
  "slipway",
  "chandlery",
  "boat_dealer",
  "supermarket",
  "convenience",
  "bakery",
  "hardware",
  "laundry",
  "pharmacy",
  "hospital",
  "post_office",
  "bank",
  "atm",
  "restaurant",
  "cafe",
  "pub",
  "toilets",
];

describe("POI_KINDS", () => {
  test("matches the backend POI_CATEGORIES list, in order", () => {
    expect([...POI_KINDS]).toEqual(BACKEND_KINDS);
  });
});

describe("tide stations (no longer baked)", () => {
  test("have no kind or glyph: an older archive's are filtered off the map (overlay.ts)", () => {
    expect(POI_KINDS).not.toContain("tide_station" as (typeof POI_KINDS)[number]);
    expect(Object.hasOwn(POI_GLYPHS, "tide_station")).toBe(false);
  });
});

describe("settlement kinds", () => {
  // Task nvpxzxxq: POI ingest no longer bakes city/town/village features, and
  // this module no longer carries a place-kind list. The basemap's own
  // `world-places` layer draws those names (core/style/chartStyle.ts).
  const SETTLEMENTS = ["city", "town", "village"] as const;

  test("are not POI kinds", () => {
    for (const kind of SETTLEMENTS) {
      expect(POI_KINDS).not.toContain(kind as (typeof POI_KINDS)[number]);
    }
  });

  test("reach no glyph through poiIconExpr", () => {
    for (const palette of PALETTES) {
      const { byKind } = splitExpr(palette);
      const covered = new Set(byKind.slice(2, -1).filter((_, i) => i % 2 === 0));
      for (const kind of SETTLEMENTS) expect(covered.has(kind)).toBe(false);
    }
  });
});

describe("poiIcon", () => {
  test("ids are palette-named and unique per (kind, palette)", () => {
    expect(poiIcon("marina", "day")).toBe("poi-marina-day");
    const ids = new Set<string>();
    for (const palette of PALETTES) for (const kind of POI_KINDS) ids.add(poiIcon(kind, palette));
    expect(ids.size).toBe(POI_KINDS.length * PALETTES.length);
  });
});

describe("poiImageIds", () => {
  test("registers every kind plus the default, for a palette", () => {
    for (const palette of PALETTES) {
      const ids = poiImageIds(palette);
      expect(ids.length).toBe(POI_KINDS.length + 1);
      expect(new Set(ids).size).toBe(ids.length);
      for (const kind of POI_KINDS) expect(ids).toContain(poiIcon(kind, palette));
      expect(ids).toContain(poiIcon(POI_DEFAULT_KIND, palette));
    }
  });

  test("the registered id sets differ across palettes (icons per palette)", () => {
    const [day, dusk, night] = PALETTES.map((p) => new Set(poiImageIds(p)));
    expect(day).not.toEqual(dusk);
    expect(dusk).not.toEqual(night);
  });
});

/** With no plugin source, `poiIconExpr` is the kind match itself. */
function splitExpr(palette: (typeof PALETTES)[number]) {
  return { byKind: poiIconExpr(palette) as unknown[] };
}

describe("poiIconExpr", () => {
  test("OSM/unknown: a match on kind whose every case + fallback is a registered image", () => {
    for (const palette of PALETTES) {
      const { byKind: expr } = splitExpr(palette);
      expect(expr[0]).toBe("match");
      expect(expr[1]).toEqual(["get", "kind"]);
      const registered = new Set(poiImageIds(palette));
      // Trailing element is the fallback; the middle is [label, output] pairs.
      const fallback = expr[expr.length - 1] as string;
      expect(fallback).toBe(poiIcon(POI_DEFAULT_KIND, palette));
      expect(registered.has(fallback)).toBe(true);
      const pairs = expr.slice(2, -1);
      for (let i = 0; i < pairs.length; i += 2) {
        const kind = pairs[i] as string;
        const id = pairs[i + 1] as string;
        expect(POI_KINDS).toContain(kind as (typeof POI_KINDS)[number]);
        expect(id).toBe(poiIcon(kind, palette));
        // No kind falls back to a missing image.
        expect(registered.has(id)).toBe(true);
      }
      // Every kind is covered.
      const covered = new Set(pairs.filter((_, i) => i % 2 === 0));
      expect(covered.size).toBe(POI_KINDS.length);
    }
  });

  test("a plugin source: its types match on kind_detail, its kinds join the kind match", () => {
    registerPoiSource({
      id: "fake",
      label: "Fake",
      kinds: { buoy_field: [["circle", 12, 12, 3]] },
      types: { berth: { label: "Berth", glyph: [["circle", 12, 12, 5]] } },
    });
    const expr = poiIconExpr("day") as unknown[];
    expect(expr[0]).toBe("case");
    expect(expr[1]).toEqual(["==", ["get", "src"], "fake"]);
    const byType = expr[2] as unknown[];
    expect(byType.slice(0, 4)).toEqual(["match", ["get", "kind_detail"], "berth", poiTypeIcon("fake", "berth", "day")]);
    const byKind = expr[3] as unknown[];
    expect(byType[byType.length - 1]).toEqual(byKind);
    expect(byKind).toContain("buoy_field");
    const ids = poiImageIds("day");
    expect(ids).toContain(poiTypeIcon("fake", "berth", "day"));
    expect(ids).toContain(poiIcon("buoy_field", "day"));
    expect(poiTypeIcon("fake", "marina", "day")).not.toBe(poiIcon("marina", "day"));
    expect(poiGlyphFor({ src: "fake", kind: "marina", kind_detail: "berth" })).toEqual([["circle", 12, 12, 5]]);
    expect(poiGlyphFor({ src: "fake", kind: "buoy_field" })).toEqual([["circle", 12, 12, 3]]);
    // OSM never reads kind_detail as a source type.
    expect(poiGlyphFor({ kind: "marina", kind_detail: "berth" })).toBe(POI_GLYPHS.marina);
  });
});

describe("poiGlyphFor (the info panel's icon — same rule as poiIconExpr)", () => {
  test("OSM: the kind's glyph, else none", () => {
    expect(poiGlyphFor({ kind: "marina", kind_detail: "marina_office" })).toBe(POI_GLYPHS.marina);
    expect(poiGlyphFor({ kind: "city" })).toBeUndefined();
  });
});
