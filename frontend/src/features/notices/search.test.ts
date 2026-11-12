// Search rows from the backend's `notices` index slice → a notices hit.

import { describe, expect, test } from "bun:test";
import type { SearchResult } from "../../core/search/client";
import { NOTICES_PROVIDER_ID } from "./provider";
import { noticeSearchHit } from "./search";

const row = (over: Partial<SearchResult> = {}): SearchResult => ({
  id: "notices:dk:7242e03c",
  source: "notices",
  region: "dk",
  category: "works",
  title: "NM-053-26: Denmark. Femern Belt.",
  text: null,
  lat: 54.57,
  lon: 11.3,
  data: { kind: "notice", id: "7242e03c", sid: "NM-053-26", fam: "nm-t", cls: "works" },
  updated_at: 0,
  ...over,
});

describe("noticeSearchHit", () => {
  test("a notices row opens that notice by its own id, at its position", () => {
    const hit = noticeSearchHit(row())!;
    expect(hit.providerId).toBe(NOTICES_PROVIDER_ID);
    expect(hit.id).toBe("7242e03c");
    expect(hit.title).toBe("NM-053");
    expect(hit.priority).toBe("regulated");
    expect(hit.lngLat).toEqual({ lng: 11.3, lat: 54.57 });
    expect(hit.payload).toMatchObject({ fam: "nm-t", cls: "works" });
  });

  test("a warning is a hazard; no position (EfS) means no lngLat", () => {
    const hit = noticeSearchHit(
      row({ lat: null, lon: null, data: { kind: "notice", id: "w", sid: "NW-1-26", fam: "nw", cls: "buoy" } }),
    )!;
    expect(hit.priority).toBe("hazard");
    expect(hit.lngLat).toBeUndefined();
  });

  test("a row without a shortId is titled from the index title", () => {
    const hit = noticeSearchHit(
      row({ title: "Firing exercises", data: { kind: "notice", id: "f", sid: null, fam: "fe", cls: "firing" } }),
    )!;
    expect(hit.title).toBe("Firing exercises");
  });

  test("falls back to the prefixed row id's tail when data has no id", () => {
    expect(noticeSearchHit(row({ data: {} }))?.id).toBe("7242e03c");
  });

  test("other sources are not ours", () => {
    expect(noticeSearchHit(row({ source: "poi" }))).toBeUndefined();
  });
});
