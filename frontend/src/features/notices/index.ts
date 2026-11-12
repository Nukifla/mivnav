// Notices to Mariners (Danish EfS / NW, from the backend's Niord snapshot —
// efs.md). Named `…ToMariners` to stay distinct from the chrome's transient
// arrival notices (`core/chrome/notices.ts`, `createNotices`). One AppFeature: the map overlay, its Layers-panel row, the
// per-family filters, the info provider (tap → panel) and the palette's
// "Notices to Mariners" command, which opens the list panel this feature
// owns (`list`, rendered by App as <NoticesList>). Everything reads the SAME
// client (`NoticesToMariners.client`) — never a second poller.

import { createEffect, createMemo, createSignal, type Accessor } from "solid-js";
import type { FeatureCollection } from "geojson";
import type { Map as MLMap } from "maplibre-gl";
import TriangleAlert from "lucide-solid/icons/triangle-alert";
import { defineCommand } from "../../core/chrome/command";
import { defineFeature, type AppFeature } from "../../core/chrome/feature";
import { measureInfoFitPadding } from "../../core/info/surface";
import type { InfoHit } from "../../core/info/types";
import type { ChartSettings } from "../../core/style/settings";
import {
  createNoticesClient,
  fetchNoticesMap,
  fetchNoticesStatus,
  type NoticesClient,
  type NoticesClientDeps,
} from "./client";
import NoticesDatasetParams from "./DatasetParams";
import { bboxCentre, firingAreaName } from "./detailModel";
import { createNoticesOverlay, NOTICES_OVERLAY_ID } from "./overlay";
import { createNoticesProvider, noticeHit, type NoticesProvider } from "./provider";
import { shapeNotices, type ShapedNoticesMap } from "./shape";
import { noticesSection, noticesSettings } from "./settings";
import { noticesFilterOf, overlapsToday, prepareNotices, sameFilter, type NoticesFilter } from "./time";
import type { NoticeDetail, NoticeListItem } from "./types";

export interface NoticesDeps extends Omit<NoticesClientDeps, "enabled"> {
  settings: Accessor<ChartSettings>;
  /** Open these hits on the info panel — App's `setInfoHitRequest`, the
   * path a search pick takes. Used by list rows and tapped references. */
  showHits?: (hits: InfoHit[]) => void;
  /** Called just before the list opens — App closes the other left-docked
   * panels (Settings, Routes), the mutual exclusion they keep with each other. */
  beforeOpenList?: () => void;
  /** Detail read seam (tests). */
  loadDetail?: (id: string) => Promise<NoticeDetail | undefined>;
}

/** The list panel's open state, owned here so the palette command needs no
 * new `CommandDeps` field. */
export interface NoticesListState {
  open: Accessor<boolean>;
  setOpen: (open: boolean) => void;
  /** Open it (closing Settings/Routes first via `beforeOpenList`). */
  show: () => void;
}

export interface NoticesToMariners {
  feature: AppFeature;
  /** The shared store: `status`, `data` (raw snapshot GeoJSON), `version`,
   * the minute clock `now`, and `poll()`. */
  client: NoticesClient;
  /** The live map once the overlay has been installed — for a provider that
   * needs `queryRenderedFeatures` on `NOTICES_QUERY_LAYER_IDS`. */
  map: Accessor<MLMap | undefined>;
  provider: NoticesProvider;
  list: NoticesListState;
  /** Open a notice by uuid or shortId: fit the map to it, then show it on
   * the info panel. `hint` is what the caller already knows (a list row). */
  openNotice: (id: string, hint?: NoticeListItem) => Promise<void>;
}

/** Every family and time state: the SELECTED notice is highlighted whatever
 * the overlay's toggles hide (it was opened on purpose). */
const SHOW_ALL: NoticesFilter = {
  noticesWarnings: true,
  noticesTemporary: true,
  noticesPreliminary: true,
  noticesPermanent: true,
  noticesFiring: true,
  noticesShowEnded: true,
};

/** How far a list/reference open zooms in at most — a single buoy's bbox
 * is a point. */
export const OPEN_MAX_ZOOM = 13;
const FIT_MS = 600;
/** Gap between the fitted notice and the map edge / the chrome over it. */
const FIT_MARGIN_PX = 60;

/** Build the notices feature. Call under a reactive owner (App). */
export function createNoticesToMariners(deps: NoticesDeps): NoticesToMariners {
  const enabled = createMemo(() => deps.settings().showNotices);
  const client = createNoticesClient({ ...deps, enabled });
  // Narrowed so an unrelated settings write (palette, CPA …) never re-derives
  // and re-`setData`s the whole collection.
  const filter = createMemo(() => noticesFilterOf(deps.settings()), undefined, { equals: sameFilter });
  // Area sort keys once per snapshot (./shape.ts) — the per-minute
  // re-derive below only restamps time state.
  const shaped = createMemo(() => shapeNotices(client.data()));
  const features = createMemo(() => prepareNotices(shaped(), filter(), client.now()));
  const [map, setMap] = createSignal<MLMap>();

  // The notice open on the info panel (`InfoProvider.selected`) and its
  // features for the highlight. With the overlay off the client does not
  // poll, so the snapshot is fetched on demand for the highlight — again
  // whenever the selected notice is in none held (a notice published since:
  // the list and search read the live backend, and the client keeps its last
  // snapshot across an off/on cycle), at most once per selection.
  const [selectedId, setSelectedId] = createSignal<string>();
  const [fallback, setFallback] = createSignal<ShapedNoticesMap | null>(null);
  let fallbackVersion: string | undefined;
  let fallbackLoading = false;
  const loadFallback = async () => {
    if (fallbackLoading) return;
    fallbackLoading = true;
    try {
      const st = await (deps.fetchStatus ?? (() => fetchNoticesStatus()))();
      // Same version as held: the notice has no geometry, nothing to gain.
      if (!st?.version || st.version === fallbackVersion) return;
      const fc = await (deps.fetchMap ?? ((v: string) => fetchNoticesMap(v)))(st.version);
      if (!fc) return;
      fallbackVersion = st.version;
      setFallback(shapeNotices(fc));
    } finally {
      fallbackLoading = false;
    }
  };
  // Vertices are label anchors, not shape: the outline already passes them.
  const ownIn = (src: ShapedNoticesMap | null, id: string) =>
    src ? src.features.filter((f) => f.properties.msg === id && f.properties.role !== "vertex") : [];
  const own = createMemo(() => {
    const id = selectedId();
    if (!id) return [];
    const live = ownIn(shaped(), id);
    return live.length > 0 ? live : ownIn(fallback(), id);
  });
  let lookedFor: string | undefined;
  createEffect(() => {
    const id = selectedId();
    if (!id) {
      lookedFor = undefined;
      return;
    }
    if (own().length > 0 || lookedFor === id) return;
    // Overlay on with its snapshot in: the client's poll keeps that current.
    if (enabled() && shaped()) return;
    lookedFor = id;
    void loadFallback();
  });
  const highlight = createMemo<FeatureCollection | null>(() => {
    const features = own();
    if (features.length === 0) return null;
    return prepareNotices({ type: "FeatureCollection", features }, SHOW_ALL, client.now());
  });
  const [listOpen, setListOpen] = createSignal(false);
  const list: NoticesListState = {
    open: listOpen,
    setOpen: setListOpen,
    show: () => {
      deps.beforeOpenList?.();
      setListOpen(true);
    },
  };

  // Assigned below; the provider's references call it lazily.
  let openNotice: (id: string, hint?: NoticeListItem) => Promise<void> = async () => {};
  const provider = createNoticesProvider({
    map: () => (enabled() ? map() : undefined),
    palette: () => deps.settings().palette,
    openNotice: (id) => void openNotice(id),
    loadDetail: deps.loadDetail,
    version: client.version,
    onSelected: setSelectedId,
  });

  openNotice = async (id, hint) => {
    const d = await provider.load(id);
    const lngLat =
      hint && hint.lon !== null && hint.lat !== null ? { lng: hint.lon, lat: hint.lat } : bboxCentre(d?.bbox ?? null);
    const fam = d?.fam ?? hint?.fam;
    const win = d?.win ?? hint?.win;
    const hit = noticeHit({
      id: d?.id ?? hint?.id ?? id,
      fam,
      cls: d?.cls ?? hint?.cls,
      sid: d?.sid ?? hint?.sid ?? (d ? null : id),
      // A firing notice is titled by its area's name, like its tap hit.
      title: d ? firingAreaName(d) : undefined,
      lngLat,
      firingToday: fam === "fa" && overlapsToday(win, Date.now()),
    });
    const show = () => deps.showHits?.([hit]);
    const m = map();
    const bbox = d?.bbox;
    if (!m || !bbox) return show();
    // Fit FIRST and open the panel when the camera lands: the info marker's
    // reveal-warp (core/info/marker.ts) then sees the notice already in view
    // instead of racing this move with its own.
    // Hence the padding is what the info surface WILL cover once open (phone:
    // sheet at its peek + nav band; desktop: the card's column), plus a margin
    // — otherwise the notice lands under the panel that is describing it.
    // Fallback timer: a fit that doesn't move the camera may never end.
    let done = false;
    const land = () => {
      if (done) return;
      done = true;
      m.off("moveend", land);
      show();
    };
    m.on("moveend", land);
    setTimeout(land, FIT_MS + 400);
    m.fitBounds(
      [
        [bbox[0], bbox[1]],
        [bbox[2], bbox[3]],
      ],
      { padding: measureInfoFitPadding(m.getContainer(), FIT_MARGIN_PX), maxZoom: Math.max(OPEN_MAX_ZOOM, Math.min(m.getZoom(), 16)), duration: FIT_MS },
    );
  };

  return {
    client,
    map,
    provider,
    list,
    openNotice: (id, hint) => openNotice(id, hint),
    feature: defineFeature({
      id: NOTICES_OVERLAY_ID,
      overlay: createNoticesOverlay({ enabled, features, onMap: setMap, highlight }),
      provider,
      commands: () => [
        defineCommand({
          id: "open-notices",
          label: "Notices to Mariners",
          group: "App",
          hint: "Danish notices and navigational warnings, nearest first",
          keywords: ["notices", "mariners", "efs", "efterretninger", "warnings", "nw", "navigational", "firing", "list"],
          icon: TriangleAlert,
          run: (ctx) => {
            list.show();
            ctx.close();
          },
        }),
      ],
      // `datasetParams`: the notices dataset's source/regions picker in the
      // Datasets tab (notices are a dataset provider like POI or weather).
      settings: {
        settings: noticesSettings,
        sections: [noticesSection],
        datasetParams: { notices: NoticesDatasetParams },
      },
      // Plain toggle, no opacity: the overlay carries its own time-state
      // opacities, and a half-faded warning is worse than on or off.
      overlayControls: (d) => [
        {
          id: NOTICES_OVERLAY_ID,
          label: "Notices to Mariners",
          visible: () => d.settings().showNotices,
          setVisible: (v) => d.setSettings({ showNotices: v }),
        },
      ],
    }),
  };
}

export { NOTICES_LAYER_IDS, NOTICES_QUERY_LAYER_IDS, NOTICES_SOURCE_ID } from "./overlay";
export { NOTICES_PROVIDER_ID } from "./provider";
export { noticeSearchHit } from "./search";
export type { NoticesClient } from "./client";
