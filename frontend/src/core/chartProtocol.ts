// The chart "epoch" for busting URL-keyed tile caches, plus a DEV-ONLY
// `chart://` fallback tile cache (production uses the Service Worker
// instead). See docs/architecture/service-worker.md ("chartProtocol.ts").

import maplibregl from "maplibre-gl";
import { createSignal } from "solid-js";
import { resolveTile, type CacheLike } from "./tileCache";

export const CHART_PROTOCOL = "chart";

/** Monotonic counter folded into the ENC vector source URL as a query param.
 * A serving-detail config change alters tile geometry without changing the
 * URL, so every URL-keyed cache would otherwise miss it — bumping this
 * forces a fresh URL. See docs/architecture/service-worker.md. */
const [chartEpoch, setChartEpoch] = createSignal(0);
export { chartEpoch };

/** Bump the chart epoch after a serving-detail config change: bust the ENC
 * source URL *and* drop the tile cache, since the tile bytes on disk have
 * changed but their URL has not (a URL-keyed cache can't see that). */
export function bumpChartEpoch(): void {
  clearChartTileCache();
  setChartEpoch((e) => e + 1);
}

/** Drop every cached tile — a re-ingested catalog keeps its tile URLs and
 * only its ETag moves, invisible to a URL-keyed cache. Posts to the Service
 * Worker in production; also clears the dev in-memory cache. */
export function clearChartTileCache(): void {
  navigator.serviceWorker?.controller?.postMessage({ type: "clear-tile-cache" });
  devCache?.clear();
}

/** Dev-fallback only, so it only needs to survive the dev-server tab (unlike
 * the SW's Cache Storage, which must survive worker restarts). No LRU/byte
 * budget, matching tileCache.ts's own choice. */
function createMemoryCache(): CacheLike & { clear(): void } {
  const store = new Map<string, Response>();
  return {
    async match(request) {
      return store.get(request.url)?.clone();
    },
    async put(request, response) {
      store.set(request.url, response);
    },
    async delete(request) {
      return store.delete(request.url);
    },
    clear() {
      store.clear();
    },
  };
}

/** Both dev and production forms must be absolute — MapLibre's tile-loading
 * worker lives at an opaque `blob:` origin, where a relative path fails to
 * resolve at all. See docs/architecture/service-worker.md. */
export function tileUrl(path: string): string {
  return import.meta.env.DEV ? `${CHART_PROTOCOL}://${path}` : `${location.origin}${path}`;
}

let registered = false;
let devCache: (CacheLike & { clear(): void }) | undefined;

/** Registering this in production is harmless dead weight, not a live path:
 * chartStyle.ts / poi/overlay.ts only ever build a `chart://` URL in dev. */
export function registerChartProtocol(): void {
  if (registered) return;
  registered = true;
  devCache = createMemoryCache();
  maplibregl.addProtocol(CHART_PROTOCOL, async (params, abortController) => {
    const url = params.url.replace(`${CHART_PROTOCOL}://`, "");
    const request = new Request(url, { signal: abortController.signal });
    const res = await resolveTile(request, devCache!);
    // MapLibre reads `status` off the rejection (404 = no tile here, anything
    // else = a failed tile); an error body returned as data parses as a tile.
    if (!res.ok) throw Object.assign(new Error(`tile: HTTP ${res.status}`), { status: res.status });
    return { data: await res.arrayBuffer() };
  });
}
