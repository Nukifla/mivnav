// The track overlay's data push: a MultiLineString of where the boat has been
// (one line per unbroken stretch of record), and the cases with nothing to draw.
//
// The interesting one is a ONE-POINT track. A boat that has reported a single
// fix has no track yet, and a one-coordinate LineString is a geometry MapLibre
// accepts and renders as nothing — so a bug that produced them would look
// exactly like a working feature on a boat that had just been switched on.
// This pins the explicit empty-collection branch instead.
//
// NB: needs `--conditions=browser` (`bun run test`) — see measure/overlay.test.ts.

import { describe, expect, test } from "bun:test";
import type { Map as MLMap } from "maplibre-gl";
import {
  createTrackOverlay,
  ensureTrackLayers,
  TRACK_LAYER_IDS,
  TRACK_STYLE,
  updateTrackData,
} from "./overlay";
import { Z } from "../../core/layers/overlay";
import type { TrackCoordinate } from "./client";

function fakeMap() {
  const setDataCalls: GeoJSON.FeatureCollection[] = [];
  const source = { setData: (d: GeoJSON.FeatureCollection) => setDataCalls.push(d) };
  const map = { getSource: (id: string) => (id === "track" ? source : undefined) };
  return { map: map as unknown as MLMap, setDataCalls };
}

const LINE: TrackCoordinate[] = [
  [12.0, 55.0],
  [12.01, 55.01],
  [12.02, 55.02],
];
const LATER: TrackCoordinate[] = [
  [12.5, 55.3],
  [12.51, 55.31],
];

describe("updateTrackData", () => {
  test("a track is ONE MultiLineString, coordinates passed through unchanged", () => {
    const f = fakeMap();
    updateTrackData(f.map, [LINE, LATER]);
    const fc = f.setDataCalls.at(-1)!;
    expect(fc.features.length).toBe(1);
    const geometry = fc.features[0]!.geometry as GeoJSON.MultiLineString;
    expect(geometry.type).toBe("MultiLineString");
    // [lon, lat] straight from the backend, and the break between the two
    // lines kept — nothing drawn across the gap in the record.
    expect(geometry.coordinates).toEqual([LINE, LATER]);
  });

  test("one fix is NOT a line — dropped, and alone it is an empty collection", () => {
    const f = fakeMap();
    updateTrackData(f.map, [[[12.0, 55.0]]]);
    expect(f.setDataCalls.at(-1)!.features).toEqual([]);
    updateTrackData(f.map, [[[12.0, 55.0]], LINE]);
    const geometry = f.setDataCalls.at(-1)!.features[0]!.geometry as GeoJSON.MultiLineString;
    expect(geometry.coordinates).toEqual([LINE]);
  });

  test("no fixes draws nothing", () => {
    const f = fakeMap();
    updateTrackData(f.map, []);
    expect(f.setDataCalls.at(-1)!.features).toEqual([]);
  });

  test("a missing source is a no-op, not a throw", () => {
    const map = { getSource: () => undefined } as unknown as MLMap;
    expect(() => updateTrackData(map, [LINE])).not.toThrow();
  });
});

describe("the last 24 h stands out, older track recedes", () => {
  test("older and recent are two features, recent LAST so it draws on top", () => {
    const f = fakeMap();
    updateTrackData(f.map, [LINE], [LATER]);
    const features = f.setDataCalls.at(-1)!.features;
    expect(features.map((x) => x.properties?.recent)).toEqual([false, true]);
    expect((features[1]!.geometry as GeoJSON.MultiLineString).coordinates).toEqual([LATER]);
  });

  test("only recent track (a short window) is one recent feature", () => {
    const f = fakeMap();
    updateTrackData(f.map, [], [LINE]);
    expect(f.setDataCalls.at(-1)!.features.map((x) => x.properties?.recent)).toEqual([true]);
  });

  test("paint is keyed on the feature's age: recent bolder, older faint", () => {
    const added: { id: string; paint: Record<string, unknown> }[] = [];
    const map = {
      getSource: () => undefined,
      addSource: () => {},
      getLayer: () => undefined,
      addLayer: (spec: { id: string; paint: Record<string, unknown> }) => added.push(spec),
    } as unknown as MLMap;
    ensureTrackLayers(map, "day");
    const line = added.find((l) => l.id === "track-line")!;
    expect(line.paint["line-opacity"]).toEqual([
      "case",
      ["==", ["get", "recent"], true],
      TRACK_STYLE.recent.opacity,
      TRACK_STYLE.older.opacity,
    ]);
    expect(TRACK_STYLE.recent.opacity).toBeGreaterThan(TRACK_STYLE.older.opacity);
    expect(TRACK_STYLE.recent.width).toBeGreaterThan(TRACK_STYLE.older.width);
  });
});

describe("the overlay descriptor", () => {
  test("sits below the planned route and the AIS targets", () => {
    // Where the boat HAS BEEN must never obscure where it is going, or what
    // else is out there.
    const overlay = createTrackOverlay({ lines: () => [LINE] });
    expect(overlay.z).toBe(Z.track);
    expect(overlay.z).toBeLessThan(Z.route);
    expect(overlay.z).toBeLessThan(Z.ais);
    // And at or above sectorLights, so it never becomes MapView's fixed-stack
    // anchor and drags the whole reorderable band underneath it.
    expect(overlay.z).toBeGreaterThanOrEqual(Z.sectorLights);
  });

  test("declares both its layers, bottom to top", () => {
    const overlay = createTrackOverlay({ lines: () => [LINE] });
    expect(overlay.layerIds).toEqual(TRACK_LAYER_IDS);
    expect(overlay.layerIds[0]).toBe("track-casing");
  });
});
