// SPDX-License-Identifier: GPL-2.0-only
import { describe, expect, test } from "bun:test";
import { nearestPlace, type SearchResult } from "./client";

const POINT = { lng: 10.2219, lat: 56.1653 };

function fakeResult(over: Partial<SearchResult>): SearchResult {
  return {
    id: "poi:1",
    source: "poi",
    region: "dk",
    category: "harbour",
    title: null,
    text: null,
    lat: null,
    lon: null,
    data: {},
    updated_at: 0,
    ...over,
  };
}

const fetchWith = (results: SearchResult[], ok = true): typeof fetch =>
  (async (url: string) => {
    // The bbox/lat/lon/limit shape `nearestPlace` builds — assert it once
    // here rather than in every test, since a wrong query shape would
    // silently return the wrong rows in the real app.
    expect(url).toContain("/api/search?");
    expect(url).toContain("bbox=");
    expect(url).toContain("limit=1");
    return new Response(JSON.stringify({ results }), { status: ok ? 200 : 500 });
  }) as unknown as typeof fetch;

describe("nearestPlace", () => {
  test("names a point close to a charted record", async () => {
    const got = await nearestPlace(
      POINT,
      fetchWith([fakeResult({ title: "Aarhus Harbour", lat: POINT.lat + 0.002, lon: POINT.lng })]),
    );
    expect(got?.title).toBe("Aarhus Harbour");
    expect(got?.distanceM).toBeGreaterThan(0);
  });

  test("does not name a point far from the nearest charted record", async () => {
    // ~0.5° of latitude, ~55 km — well past the "honest to name" radius.
    const got = await nearestPlace(
      POINT,
      fetchWith([fakeResult({ title: "Somewhere Else", lat: POINT.lat + 0.5, lon: POINT.lng })]),
    );
    expect(got).toBeNull();
  });

  test("no charted record at all → null, not a throw", async () => {
    expect(await nearestPlace(POINT, fetchWith([]))).toBeNull();
  });

  test("a record missing a point or title is skipped, not crashed on", async () => {
    expect(await nearestPlace(POINT, fetchWith([fakeResult({ title: null, lat: POINT.lat, lon: POINT.lng })]))).toBeNull();
    expect(await nearestPlace(POINT, fetchWith([fakeResult({ title: "X", lat: null, lon: null })]))).toBeNull();
  });

  test("a failed request resolves null rather than rejecting", async () => {
    expect(await nearestPlace(POINT, fetchWith([], false))).toBeNull();
    expect(
      await nearestPlace(POINT, (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch),
    ).toBeNull();
  });
});
