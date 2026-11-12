// `resolveSatelliteSource` — the pure pick over the ONE unified source list
// (`GET /api/satellite/sources`), plus the AUTO / stale-id fallback and the
// server-relative-vs-absolute tile-template rule. No map, no network.
//
// Note what is NOT tested here any more, because it is not here any more: the
// baked-vs-online branch, and borrowing a baked set's credit from its origin
// source. Both moved into the backend when the two discovery endpoints became
// one (jt zsukvvxq) — see tests/test_satellite.py's unified-sources test.

import { describe, expect, test } from "bun:test";
import {
  resolveSatelliteSource,
  tileTemplate,
  type SatelliteSourceInfo,
} from "./sources";

const baked: SatelliteSourceInfo = {
  id: "oresund",
  label: "Øresund",
  badge: "Offline · EOX Sentinel-2 cloudless",
  requires_network: false,
  tiles: "/satellite/tiles/oresund/{z}/{x}/{y}",
  min_zoom: 5,
  max_zoom: 14,
  bounds: [12, 55, 13, 56],
  attribution: "EOX CC-BY-NC-SA",
  sequence: 7,
};

const esri: SatelliteSourceInfo = {
  id: "esri-world-imagery",
  label: "ESRI World Imagery",
  badge: "Online",
  requires_network: true,
  tiles: "https://example.test/esri/{z}/{y}/{x}",
  min_zoom: 0,
  max_zoom: 19,
  bounds: null,
  attribution: "Esri, Maxar",
  sequence: 0,
};

describe("tileTemplate", () => {
  test("a server-relative template gets the /api base", () => {
    expect(tileTemplate("/satellite/tiles/x/{z}/{x}/{y}")).toBe(
      "/api/satellite/tiles/x/{z}/{x}/{y}",
    );
  });

  test("an absolute upstream template is used verbatim", () => {
    expect(tileTemplate(esri.tiles)).toBe("https://example.test/esri/{z}/{y}/{x}");
  });
});

describe("resolveSatelliteSource", () => {
  test("an explicit online id → its XYZ template, global (no bounds)", () => {
    const r = resolveSatelliteSource("esri-world-imagery", [baked, esri]);
    expect(r).not.toBeNull();
    expect(r!.key).toBe("esri-world-imagery:0");
    expect(r!.tiles).toBe(esri.tiles);
    expect(r!.attribution).toBe("Esri, Maxar");
    expect(r!.maxzoom).toBe(19);
    expect(r!.bounds).toBeUndefined();
  });

  test("an explicit baked id → the /api tile route, its bounds, its sequence in the key", () => {
    const r = resolveSatelliteSource("oresund", [baked, esri]);
    expect(r!.key).toBe("oresund:7");
    expect(r!.tiles).toBe("/api/satellite/tiles/oresund/{z}/{x}/{y}");
    expect(r!.bounds).toEqual([12, 55, 13, 56]);
    expect(r!.minzoom).toBe(5);
    expect(r!.maxzoom).toBe(14);
    expect(r!.attribution).toBe("EOX CC-BY-NC-SA");
  });

  test("a re-bake (a moved sequence) is a different key, so the raster is dropped", () => {
    const before = resolveSatelliteSource("oresund", [baked]);
    const after = resolveSatelliteSource("oresund", [{ ...baked, sequence: 8 }]);
    expect(after!.key).not.toBe(before!.key);
  });

  test("AUTO ('') takes the first row — the backend orders baked first", () => {
    expect(resolveSatelliteSource("", [baked, esri])!.key).toBe("oresund:7");
    expect(resolveSatelliteSource("", [esri])!.key).toBe("esri-world-imagery:0");
  });

  test("a stale id (a deleted set) falls back to AUTO, never wedges blank", () => {
    expect(resolveSatelliteSource("gone", [esri])!.key).toBe("esri-world-imagery:0");
  });

  test("null only when there is genuinely nothing to draw", () => {
    expect(resolveSatelliteSource("", [])).toBeNull();
    expect(resolveSatelliteSource("anything", [])).toBeNull();
  });
});
