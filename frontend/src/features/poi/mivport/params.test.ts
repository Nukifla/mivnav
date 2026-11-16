// The mivport dataset params as the host's POI form handles them: source <->
// implementation, the default, and the mivport-only key being cleared on a
// switch to overpass.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  implementationFor,
  paramsForSource,
  poiSourceOf,
} from "../datasetParamsModel";
import { poiSource, poiSources } from "../sources";
import { MIVPORT_DESCRIPTION, MIVPORT_PARAM_KEYS, MivportParams, downloadPhotosOf, setMivportParam } from "./params";
import { registerMivport, unregisterMivport } from "./testing";

beforeAll(registerMivport);
afterAll(unregisterMivport);

describe("the source", () => {
  test("registered with its label, description, form and keys", () => {
    const s = poiSource("mivport")!;
    expect(s.label).toBe("mivport");
    expect(s.description).toBe(MIVPORT_DESCRIPTION);
    expect(s.ParamsForm).toBe(MivportParams);
    expect(s.paramKeys).toEqual(["download_photos"]);
  });

  test("'mivport' is its own implementation, stored as is", () => {
    expect(poiSourceOf("mivport")).toBe("mivport");
    expect(implementationFor("mivport")).toBe("mivport");
  });
});

describe("paramsForSource", () => {
  const draft = { download_photos: false, other: 1 };

  test("switching to overpass clears the mivport key, keeps the rest", () => {
    const out = paramsForSource(draft, "overpass");
    for (const key of MIVPORT_PARAM_KEYS) expect(key in out).toBe(false);
    expect(out).toEqual({ other: 1 });
  });

  test("switching to mivport keeps its own key (unless another source shares the name); never mutates", () => {
    // A key another registered source also owns (a plugin's
    // download_photos) is dropped by the host on any switch — harmless: an
    // absent key is the backend default, on.
    const shared = poiSources().some((s) => s.id !== "mivport" && s.paramKeys?.includes("download_photos"));
    expect(paramsForSource(draft, "mivport")).toEqual(shared ? { other: 1 } : draft);
    expect(paramsForSource({}, "mivport")).toEqual({});
    expect(draft).toEqual({ download_photos: false, other: 1 });
  });
});

describe("download_photos", () => {
  test("defaults on; only a boolean counts", () => {
    expect(downloadPhotosOf({})).toBe(true);
    expect(downloadPhotosOf({ download_photos: false })).toBe(false);
    expect(downloadPhotosOf({ download_photos: "no" })).toBe(true);
  });

  test("setMivportParam sets the key, keeps the rest, leaves the input alone", () => {
    const saved = { other: 1 };
    expect(setMivportParam(saved, "download_photos", false)).toEqual({ other: 1, download_photos: false });
    expect(saved).toEqual({ other: 1 });
  });
});
