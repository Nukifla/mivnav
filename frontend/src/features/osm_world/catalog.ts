// Tracks what was actually BAKED rather than mirroring OsmWorldConfig's
// defaults (jt xqoyqxou): MapLibre never requests a tile past a source's
// declared `maxzoom`, so without this, raising the config and re-baking had
// no visible client-side effect.

import { createSignal, onCleanup, type Accessor } from "solid-js";

export interface OsmWorldCatalogSet {
  id: string;
  min_zoom: number;
  max_zoom: number;
}

export async function fetchOsmWorldCatalog(): Promise<OsmWorldCatalogSet[]> {
  const res = await fetch("/api/osm_world/catalog");
  if (!res.ok) throw new Error(`osm_world catalog: HTTP ${res.status}`);
  const body = (await res.json()) as { sets: OsmWorldCatalogSet[] };
  return body.sets;
}

/** The boot prefetch's answer, until `createOsmWorldCatalog` adopts it. */
let prefetched: OsmWorldCatalogSet[] | undefined;

/** Boot: fetch before first render (index.tsx's gate), so the map is built
 * with the baked `maxzoom`. Arriving after `load` instead changed the
 * `osm-world` source, which maplibre can only apply by removing and re-adding
 * the source and all its layers — a refetch plus ~1.7 s of main thread.
 * Failure is swallowed; `createOsmWorldCatalog` fetches again as before. */
export async function prefetchOsmWorldCatalog(): Promise<void> {
  try {
    prefetched = await fetchOsmWorldCatalog();
  } catch {
    // createOsmWorldCatalog retries; the style keeps the FALLBACK hint meanwhile.
  }
}

/** Mirrors backend `osm_world.config`'s `DEFAULT_OSM_WORLD_MIN_ZOOM`/`MAX_ZOOM`,
 * the range a fresh install bakes with. */
export const FALLBACK_MIN_ZOOM = 0;
export const FALLBACK_MAX_ZOOM = 8;

export interface OsmWorldCatalogOptions {
  /** The fetcher — the seam a test drives. */
  fetch?: () => Promise<OsmWorldCatalogSet[]>;
}

export interface OsmWorldCatalog {
  /** Union (min/max) across every baked set. See docs/architecture/osm-world-basemap.md
   * for the region-scoped-set caveat (why maxZoom can outrun what's baked
   * outside that region, and the unverified 404-blanking risk). */
  minZoom: Accessor<number>;
  maxZoom: Accessor<number>;
  /** Re-read the catalog. No caller wires this yet: DatasetListSection has no
   * per-provider post-bake hook to call it from; kept for when one lands. */
  refetch: () => void;
}

export function createOsmWorldCatalog(options: OsmWorldCatalogOptions = {}): OsmWorldCatalog {
  const load = options.fetch ?? fetchOsmWorldCatalog;
  // Adopt the boot prefetch once (real fetcher only — never a test's).
  const initial = options.fetch ? undefined : prefetched;
  prefetched = undefined;
  const seeded = initial !== undefined && initial.length > 0;
  const [minZoom, setMinZoom] = createSignal(seeded ? Math.min(...initial.map((s) => s.min_zoom)) : FALLBACK_MIN_ZOOM);
  const [maxZoom, setMaxZoom] = createSignal(seeded ? Math.max(...initial.map((s) => s.max_zoom)) : FALLBACK_MAX_ZOOM);
  let live = true;

  const run = () => {
    void load()
      .then((sets) => {
        if (!live || sets.length === 0) return;
        setMinZoom(Math.min(...sets.map((s) => s.min_zoom)));
        setMaxZoom(Math.max(...sets.map((s) => s.max_zoom)));
      })
      .catch(() => {
        // Non-critical: the style keeps the static FALLBACK hint.
      });
  };

  if (initial === undefined) run();
  onCleanup(() => {
    live = false;
  });
  return { minZoom, maxZoom, refetch: run };
}
