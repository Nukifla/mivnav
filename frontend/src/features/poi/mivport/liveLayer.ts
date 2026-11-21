// mivport LIVE: every mivport place in the world while the boat is online,
// like the mivport web client — a vector source cut per tile by the backend
// from mivport's bbox API (`/api/poi/live/mivport/tiles/…`, RAM only, never
// cached on disk or by the Service Worker), drawn with THE POI marker spec so
// it looks like the baked sets, just below them (`Z.poiLive`): a baked point,
// with its offline details, wins. Switched on boat-wide in Settings → mivport
// (`Config.mivport.live`).
//
// Inert when off: with `showPois` off, or the switch off, there is no source
// and no layer. With `showPois` on it asks the tiny status route (which never
// itself asks mivport) every so often to learn whether the switch is on;
// Settings pokes it at once after a change (`refresh`).

import { createSignal } from "solid-js";
import type { Map as MLMap } from "maplibre-gl";
import { addLayer } from "../../../core/layers/addLayer";
import { Z, type Overlay, type OverlayCtx } from "../../../core/layers/overlay";
import { ensurePoiImages } from "../icons";
import { applyPoiPaint, markerKinds, poiMarkerLayer } from "../overlay";

export const MIVPORT_LIVE_OVERLAY_ID = "mivport-live";
export const MIVPORT_LIVE_SOURCE_ID = "mivport-live";
export const MIVPORT_LIVE_LAYER_ID = "mivport-live-marker";
export const MIVPORT_LIVE_ATTRIBUTION = "© mivport contributors, © OpenStreetMap contributors (live)";

/** `GET /api/poi/live/mivport`. `tiles` is relative to the API root. */
export interface MivportLiveStatus {
  enabled: boolean;
  state: "off" | "offline" | "ready";
  error?: string | null;
  last_ok?: number | null;
  min_zoom: number;
  max_zoom: number;
  tiles: string;
}

export async function fetchMivportLiveStatus(fetchImpl: typeof fetch = fetch): Promise<MivportLiveStatus | undefined> {
  try {
    const res = await fetchImpl("/api/poi/live/mivport");
    if (!res.ok) return undefined;
    return (await res.json()) as MivportLiveStatus;
  } catch {
    return undefined;
  }
}

/** How soon to ask again: soon while offline (to pick the layer back up when
 * the boat gets internet), slowly otherwise (a switch flipped on another
 * screen). */
export function nextPollMs(st: MivportLiveStatus | undefined): number {
  return st?.state === "offline" ? 15_000 : 60_000;
}

/** Absolute (MapLibre's tile worker runs at a `blob:` origin). `epoch`
 * changes when the layer comes back online, so the tiles in view that were
 * answered empty while offline are asked again. */
export function mivportLiveTileUrl(st: MivportLiveStatus, epoch: number): string {
  return `${globalThis.location?.origin ?? ""}/api${st.tiles}?e=${epoch}`;
}

export interface MivportLiveOverlayDeps {
  fetchStatus?: () => Promise<MivportLiveStatus | undefined>;
  schedule?: (fn: () => void, ms: number) => () => void;
}

export interface MivportLiveOverlay extends Overlay {
  /** Ask the status again now (after Settings changed the switch). */
  refresh: () => void;
  status: () => MivportLiveStatus | undefined;
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

function removeLive(map: MLMap): void {
  if (map.getLayer(MIVPORT_LIVE_LAYER_ID)) map.removeLayer(MIVPORT_LIVE_LAYER_ID);
  if (map.getSource(MIVPORT_LIVE_SOURCE_ID)) map.removeSource(MIVPORT_LIVE_SOURCE_ID);
}

export function createMivportLiveOverlay(deps: MivportLiveOverlayDeps = {}): MivportLiveOverlay {
  const fetchStatus = deps.fetchStatus ?? (() => fetchMivportLiveStatus());
  const schedule = deps.schedule ?? defaultSchedule;
  const [status, setStatus] = createSignal<MivportLiveStatus>();
  /** Bumped on each offline → ready, see {@link mivportLiveTileUrl}. */
  const [epoch, setEpoch] = createSignal(0);
  let polling = false;
  let cancel: (() => void) | undefined;
  let installed: { url: string; zooms: string } | undefined;

  const stopTimer = () => {
    cancel?.();
    cancel = undefined;
  };
  const poll = async () => {
    stopTimer();
    const st = await fetchStatus();
    if (!polling) return;
    const before = status();
    if (st) {
      if (before?.state === "offline" && st.state === "ready") setEpoch((e) => e + 1);
      setStatus(st);
    }
    stopTimer(); // a refresh may have raced this poll
    cancel = schedule(() => void poll(), nextPollMs(st));
  };
  const startPolling = () => {
    if (polling) return;
    polling = true;
    void poll();
  };
  const stopPolling = () => {
    polling = false;
    stopTimer();
    setStatus(undefined);
  };

  const reconcile = (map: MLMap, ctx: OverlayCtx) => {
    const s = ctx.settings();
    if (!s.showPois) {
      stopPolling();
      removeLive(map);
      installed = undefined;
      return;
    }
    startPolling();
    const st = status(); // tracked: a new status re-runs `update`
    const e = epoch();
    if (!st?.enabled) {
      removeLive(map);
      installed = undefined;
      return;
    }
    const url = mivportLiveTileUrl(st, e);
    const zooms = `${st.min_zoom}-${st.max_zoom}`;
    if (map.getSource(MIVPORT_LIVE_SOURCE_ID) && (!installed || installed.url !== url || installed.zooms !== zooms)) {
      removeLive(map);
    }
    if (!map.getSource(MIVPORT_LIVE_SOURCE_ID)) {
      map.addSource(MIVPORT_LIVE_SOURCE_ID, {
        type: "vector",
        tiles: [url],
        minzoom: st.min_zoom,
        maxzoom: st.max_zoom, // overzoomed past it, like the baked sets
        attribution: MIVPORT_LIVE_ATTRIBUTION,
      });
      installed = { url, zooms };
    }
    ensurePoiImages(map);
    if (!map.getLayer(MIVPORT_LIVE_LAYER_ID)) {
      addLayer(map, poiMarkerLayer(MIVPORT_LIVE_LAYER_ID, MIVPORT_LIVE_SOURCE_ID, markerKinds(), s.palette));
    }
  };

  return {
    id: MIVPORT_LIVE_OVERLAY_ID,
    layerIds: [MIVPORT_LIVE_LAYER_ID],
    z: Z.poiLive,
    ensure: reconcile,
    update: reconcile,
    paint(map, ctx) {
      applyPoiPaint(map, ctx.settings().palette, MIVPORT_LIVE_LAYER_ID);
    },
    refresh: () => {
      if (polling) void poll();
    },
    status,
  };
}
