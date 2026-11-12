// The POI feature's own catalog client — GET /api/poi/catalog. Deliberately
// thin vs. ../../core/catalog.ts: POIs are informational, never
// safety-critical, so no retry-with-backoff — one fetch, silent failure.
// Response shape matches the chart catalog, so it reuses `ChartSet`.

import { createSignal, onCleanup, type Accessor } from "solid-js";
import type { ChartSet } from "../../core/catalog";

export async function fetchPoiCatalog(): Promise<ChartSet[]> {
  const res = await fetch("/api/poi/catalog");
  if (!res.ok) throw new Error(`poi catalog: HTTP ${res.status}`);
  const body = (await res.json()) as { sets: ChartSet[] };
  return body.sets;
}

export interface PoiCatalogOptions {
  /** The fetcher — the seam a test drives. */
  fetch?: () => Promise<ChartSet[]>;
}

export interface PoiCatalog {
  /** The POI sets, empty until the first fetch resolves. */
  sets: Accessor<ChartSet[]>;
  /** Re-read the catalog — the seam the POI-data settings section drives after
   * a bake finishes, so a freshly baked set draws without a page reload. The
   * overlay's `update` effect reads `sets`, so a FIRST set arriving this way
   * installs the source; silent on failure, like the initial load. */
  refetch: () => void;
}

/** The POI sets, empty until the one fetch resolves. A late-arriving set is
 * picked up by the overlay's `update` effect (it reads this accessor), and so
 * is one that arrives from a post-bake `refetch`. */
export function createPoiCatalog(options: PoiCatalogOptions = {}): PoiCatalog {
  const load = options.fetch ?? fetchPoiCatalog;
  const [sets, setSets] = createSignal<ChartSet[]>([]);
  let live = true;
  const run = () => {
    void load()
      .then((s) => {
        if (live) setSets(s);
      })
      .catch(() => {
        // Non-critical: a failed POI catalog leaves the overlay empty, silently.
      });
  };
  run();
  onCleanup(() => {
    live = false;
  });
  return { sets, refetch: run };
}
