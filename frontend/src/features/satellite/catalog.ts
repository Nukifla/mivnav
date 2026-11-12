// `fetchSatelliteSourceList` is CONSUMPTION (unified baked+online, see
// docs/architecture/satellite-routes.md); `fetchSatelliteSources` is
// CONFIGURATION, read only by the dataset-declare form.

import { createSignal, onCleanup, type Accessor } from "solid-js";
import type { SatelliteSource, SatelliteSourceInfo } from "./sources";

export async function fetchSatelliteSourceList(): Promise<SatelliteSourceInfo[]> {
  const res = await fetch("/api/satellite/sources");
  if (!res.ok) throw new Error(`satellite sources: HTTP ${res.status}`);
  const body = (await res.json()) as { sources: SatelliteSourceInfo[] };
  return body.sources;
}

export async function fetchSatelliteSources(): Promise<SatelliteSource[]> {
  const res = await fetch("/api/ingest/satellite/sources");
  if (!res.ok) throw new Error(`satellite config sources: HTTP ${res.status}`);
  const body = (await res.json()) as { sources: SatelliteSource[] };
  return body.sources;
}

export interface SatelliteCatalogOptions {
  /** The unified source-list fetcher — the seam a test drives. */
  fetchSources?: () => Promise<SatelliteSourceInfo[]>;
}

export interface SatelliteCatalog {
  /** Every selectable imagery source, empty until the one fetch resolves. */
  sources: Accessor<SatelliteSourceInfo[]>;
  /** Re-read the list — driven after a bake or a delete so the new (or gone)
   * set flows into the overlay without a reload. Silent on failure. */
  refetch: () => void;
}

/** A late-arriving source (or a post-bake `refetch`) is picked up by the
 * overlay's `update` effect, which reads this accessor. */
export function createSatelliteCatalog(options: SatelliteCatalogOptions = {}): SatelliteCatalog {
  const load = options.fetchSources ?? fetchSatelliteSourceList;
  const [sources, setSources] = createSignal<SatelliteSourceInfo[]>([]);
  let live = true;

  const run = () => {
    void load()
      .then((s) => {
        if (live) setSources(s);
      })
      .catch(() => {
        // Non-critical: a failed list leaves the overlay with no source, and
        // the picker empty with its "nothing yet" note. Silently.
      });
  };

  run();
  onCleanup(() => {
    live = false;
  });
  return { sources, refetch: run };
}
