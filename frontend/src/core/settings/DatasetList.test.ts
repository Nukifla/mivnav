/**
 * The pure helpers in `DatasetList.tsx` worth asserting without a DOM (the
 * create/edit/list flow itself is a thin fetch-driven renderer, in the same
 * "self-contained boat section" shape as ChartLibrary.tsx, and is exercised
 * through the app rather than unit-tested in isolation, matching that
 * sibling). `timeAgo` moved here from the retired PoiData.tsx when this list
 * absorbed that section's list+delete capability (its own baked-sets rows
 * used the same relative-time label this list's rows now show too).
 */

import { describe, expect, test } from "bun:test";
import {
  datasetLabel,
  dedupeDatasetId,
  formatBytes,
  progressPercent,
  progressView,
  slugifyDatasetName,
  timeAgo,
  type ProviderCatalogEntry,
} from "./DatasetList";

describe("datasetLabel", () => {
  // shaped like GET /datasets's real `providers` catalog entries
  const providers: ProviderCatalogEntry[] = [
    {
      id: "poi",
      label: "POI (points of interest)",
      implementation_labels: { overpass: "POI (OSM)", acme: "POI (Acme)" },
      default_implementation: "overpass",
      creatable: true,
      region_kind: "bbox",
    },
    {
      id: "satellite",
      label: "Satellite imagery",
      implementation_labels: {},
      default_implementation: null,
      creatable: true,
      region_kind: "bbox",
    },
    { id: "weather", label: "Weather (offline forecast)", creatable: true, region_kind: "bbox" },
  ];

  test("a POI dataset is labelled by its source", () => {
    expect(datasetLabel(providers, "poi", "acme")).toBe("POI (Acme)");
    expect(datasetLabel(providers, "poi", "overpass")).toBe("POI (OSM)");
  });

  test("a POI dataset naming no implementation is OpenStreetMap (the default)", () => {
    expect(datasetLabel(providers, "poi", null)).toBe("POI (OSM)");
  });

  test("an implementation with no declared label falls back to the provider label", () => {
    expect(datasetLabel(providers, "poi", "someday")).toBe("POI (points of interest)");
  });

  test("a single-source provider keeps its one label, catalog field or not", () => {
    expect(datasetLabel(providers, "satellite", null)).toBe("Satellite imagery");
    expect(datasetLabel(providers, "weather", "om")).toBe("Weather (offline forecast)");
  });

  test("an unknown provider falls back to its id", () => {
    expect(datasetLabel(providers, "nope", null)).toBe("nope");
  });
});

describe("formatBytes", () => {
  test("zero and negative read as 0 B", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
  });

  test("stays in bytes under 1 KB", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  test("steps up through KB/MB/GB, one decimal under 10 of a unit", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(10 * 1024)).toBe("10 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2.0 GB");
    expect(formatBytes(3 * 1024 ** 4)).toBe("3.0 TB");
  });
});

describe("progressPercent", () => {
  test("total 0 is indeterminate (null), not a division by zero", () => {
    expect(progressPercent(0, 0)).toBeNull();
    expect(progressPercent(5, 0)).toBeNull();
  });

  test("maps current/total onto 0-100", () => {
    expect(progressPercent(0, 200)).toBe(0);
    expect(progressPercent(50, 200)).toBe(25);
    expect(progressPercent(200, 200)).toBe(100);
  });

  test("clamps a current past total to 100", () => {
    expect(progressPercent(250, 200)).toBe(100);
  });
});

describe("slugifyDatasetName", () => {
  test("lowercases and joins spaces/punctuation with a dash", () => {
    expect(slugifyDatasetName("Solent POI")).toBe("solent-poi");
    expect(slugifyDatasetName("Bay of Biscay: charts!")).toBe("bay-of-biscay-charts");
  });

  test("ASCII-folds accents instead of dropping the whole word", () => {
    expect(slugifyDatasetName("Île de Ré")).toBe("ile-de-re");
  });

  test("keeps dots/underscores/dashes, matching the backend id regex", () => {
    expect(slugifyDatasetName("v1.2_final-set")).toBe("v1.2_final-set");
  });

  test("collapses runs of separators and trims leading/trailing dashes", () => {
    expect(slugifyDatasetName("  --weird!!  name--  ")).toBe("weird-name");
  });

  test("collapses a hand-typed run of dashes too, not just other punctuation", () => {
    expect(slugifyDatasetName("Solent -- POI")).toBe("solent-poi");
  });

  test("falls back to a fixed slug when nothing usable remains", () => {
    expect(slugifyDatasetName("🚢🚢🚢")).toBe("dataset");
  });
});

describe("dedupeDatasetId", () => {
  test("returns the base id unchanged when it's free", () => {
    expect(dedupeDatasetId("solent-poi", [])).toBe("solent-poi");
    expect(dedupeDatasetId("solent-poi", ["other-id"])).toBe("solent-poi");
  });

  test("appends -2 on a single collision", () => {
    expect(dedupeDatasetId("solent-poi", ["solent-poi"])).toBe("solent-poi-2");
  });

  test("keeps incrementing past multiple existing collisions", () => {
    expect(dedupeDatasetId("solent-poi", ["solent-poi", "solent-poi-2", "solent-poi-3"])).toBe(
      "solent-poi-4",
    );
  });
});

describe("timeAgo", () => {
  test("returns sane buckets and falls back to a date for older", () => {
    const now = Date.parse("2026-07-20T12:00:00+00:00");
    const ago = (ms: number) => new Date(now - ms).toISOString();
    const S = 1000;
    const MIN = 60 * S;
    const HR = 60 * MIN;
    const DAY = 24 * HR;
    expect(timeAgo(ago(10 * S), now)).toBe("just now");
    expect(timeAgo(ago(5 * MIN), now)).toBe("5 min ago");
    expect(timeAgo(ago(1 * HR), now)).toBe("1 hour ago");
    expect(timeAgo(ago(3 * HR), now)).toBe("3 hours ago");
    expect(timeAgo(ago(2 * DAY), now)).toBe("2 days ago");
    // Older than a week: a date, not a bucket.
    expect(timeAgo(ago(30 * DAY), now)).not.toContain("ago");
    // Unparseable input is empty, never "NaN".
    expect(timeAgo("not-a-date", now)).toBe("");
  });
});

describe("progressView", () => {
  const prog = (error = "") => ({
    state: "done",
    task: "downloading photos",
    current: 0,
    total: 0,
    log: ["photos: downloaded 0, failed 0"],
    error,
  });

  test("no progress blob → nothing", () => {
    expect(progressView("baked", null)).toBe("none");
    expect(progressView("baked", undefined)).toBe("none");
  });

  test("a running bake shows the live panel", () => {
    expect(progressView("baking", prog())).toBe("live");
  });

  test("a finished bake collapses — an open panel reads as still running", () => {
    expect(progressView("baked", prog())).toBe("done");
  });

  test("a failed or cancelled bake keeps its log in view", () => {
    expect(progressView("error", prog("boom"))).toBe("failed");
    expect(progressView("baked", prog("cancelled"))).toBe("failed");
  });
});
