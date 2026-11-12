import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import {
  createOsmWorldCatalog,
  FALLBACK_MAX_ZOOM,
  FALLBACK_MIN_ZOOM,
  type OsmWorldCatalogSet,
} from "./catalog";

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe("createOsmWorldCatalog", () => {
  test("stays at the static fallback until the fetch resolves", () => {
    createRoot((dispose) => {
      const catalog = createOsmWorldCatalog({ fetch: () => new Promise(() => {}) });
      expect(catalog.minZoom()).toBe(FALLBACK_MIN_ZOOM);
      expect(catalog.maxZoom()).toBe(FALLBACK_MAX_ZOOM);
      dispose();
    });
  });

  test("unions min/max across every baked set, like ochartsUnionSet does for o-charts", async () => {
    const sets: OsmWorldCatalogSet[] = [
      { id: "world", min_zoom: 0, max_zoom: 10 },
      { id: "world-2", min_zoom: 2, max_zoom: 6 },
    ];
    await createRoot(async (dispose) => {
      const catalog = createOsmWorldCatalog({ fetch: () => Promise.resolve(sets) });
      await flush();
      expect(catalog.minZoom()).toBe(0);
      expect(catalog.maxZoom()).toBe(10);
      dispose();
    });
  });

  test("a failed fetch leaves the fallback in place rather than throwing", async () => {
    await createRoot(async (dispose) => {
      const catalog = createOsmWorldCatalog({ fetch: () => Promise.reject(new Error("offline")) });
      await flush();
      expect(catalog.minZoom()).toBe(FALLBACK_MIN_ZOOM);
      expect(catalog.maxZoom()).toBe(FALLBACK_MAX_ZOOM);
      dispose();
    });
  });

  test("an empty set list (nothing baked yet) also keeps the fallback", async () => {
    await createRoot(async (dispose) => {
      const catalog = createOsmWorldCatalog({ fetch: () => Promise.resolve([]) });
      await flush();
      expect(catalog.minZoom()).toBe(FALLBACK_MIN_ZOOM);
      expect(catalog.maxZoom()).toBe(FALLBACK_MAX_ZOOM);
      dispose();
    });
  });

  test("refetch re-reads and updates the accessors", async () => {
    let sets: OsmWorldCatalogSet[] = [];
    await createRoot(async (dispose) => {
      const catalog = createOsmWorldCatalog({ fetch: () => Promise.resolve(sets) });
      await flush();
      expect(catalog.maxZoom()).toBe(FALLBACK_MAX_ZOOM);

      sets = [{ id: "world", min_zoom: 0, max_zoom: 12 }];
      catalog.refetch();
      await flush();
      expect(catalog.maxZoom()).toBe(12);
      dispose();
    });
  });
});
