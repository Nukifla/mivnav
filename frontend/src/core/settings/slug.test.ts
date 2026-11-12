/**
 * The shared id-derivation rule dataset ids and region ids both use — see
 * the module docstring in `slug.ts` for why one rule serves both. Fuller
 * coverage of the fold/case/collapse behaviour lives here; `DatasetList.
 * test.ts`'s `slugifyDatasetName`/`dedupeDatasetId` describes are thin
 * wrappers over these and are left in place for their existing call sites.
 */

import { describe, expect, test } from "bun:test";
import { dedupeId, slugify } from "./slug";

describe("slugify", () => {
  test("lowercases and joins words with hyphens", () => {
    expect(slugify("Solent POI", "x")).toBe("solent-poi");
  });

  test("collapses punctuation to a single hyphen", () => {
    expect(slugify("Bay of Biscay: charts!", "x")).toBe("bay-of-biscay-charts");
  });

  test("ASCII-folds accents", () => {
    expect(slugify("Île de Ré", "x")).toBe("ile-de-re");
  });

  test("keeps already-safe characters untouched", () => {
    expect(slugify("v1.2_final-set", "x")).toBe("v1.2_final-set");
  });

  test("trims and collapses runs of separators", () => {
    expect(slugify("  --weird!!  name--  ", "x")).toBe("weird-name");
  });

  test("falls back when nothing usable remains", () => {
    expect(slugify("🚢🚢🚢", "region")).toBe("region");
  });
});

describe("dedupeId", () => {
  test("an id not in use is returned as-is", () => {
    expect(dedupeId("solent", [])).toBe("solent");
    expect(dedupeId("solent", ["other-id"])).toBe("solent");
  });

  test("a collision appends -2, then -3, …", () => {
    expect(dedupeId("solent", ["solent"])).toBe("solent-2");
    expect(dedupeId("solent", ["solent", "solent-2", "solent-3"])).toBe("solent-4");
  });
});
