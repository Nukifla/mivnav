// The pure half of the POI dataset params form: source <-> implementation,
// and a plugin source's own keys being cleared on a switch to another
// source (the backend 422s a dataset carrying another source's params).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { implementationFor, paramsForSource, poiSourceOf } from "./datasetParamsModel";
import { registerPoiSource, resetPoiSources } from "./sources";

beforeAll(() => registerPoiSource({ id: "fake", label: "Fake", paramKeys: ["a", "b"] }));
afterAll(resetPoiSources);

describe("source <-> implementation", () => {
  test("null and 'overpass' are OSM; a plugin id is itself", () => {
    expect(poiSourceOf(null)).toBe("overpass");
    expect(poiSourceOf("overpass")).toBe("overpass");
    expect(poiSourceOf("fake")).toBe("fake");
  });

  test("overpass is stored as null so OSM datasets round-trip unchanged", () => {
    expect(implementationFor("overpass")).toBeNull();
    expect(implementationFor("fake")).toBe("fake");
  });
});

describe("paramsForSource", () => {
  const draft = { a: 1, b: true, other: 1 };

  test("switching to overpass clears every key a plugin source owns, keeps the rest", () => {
    expect(paramsForSource(draft, "overpass")).toEqual({ other: 1 });
  });

  test("switching to the source keeps the draft as is", () => {
    expect(paramsForSource(draft, "fake")).toEqual(draft);
  });

  test("never mutates the input", () => {
    const input = { ...draft };
    paramsForSource(input, "overpass");
    expect(input).toEqual(draft);
  });
});
