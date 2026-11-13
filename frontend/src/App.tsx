import { createEffect, createMemo, createSignal, For, onCleanup, onMount, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { createCatalog } from "./core/catalog";
import { createScreenWakeLock } from "./core/wakeLock";
import { drawableSets, ochartsDevice } from "./core/ochartsDevice";
import DeviceRegistration from "./core/chrome/DeviceRegistration";
import {
  describeFetchError,
  dismissSplash,
  faultHint,
  setSplashFault,
  setSplashStatus,
  splashGone,
  splashShowing,
} from "./core/splash";
import CatalogAlert from "./core/settings/CatalogAlert";
import { isTypingTarget } from "./core/chrome/accelerators";
import { clearChartTileCache } from "./core/chartProtocol";
import { patchServerConfig, seedChartDetail } from "./core/serverConfig";
import { routePlanner } from "./core/routePlanner";
import { bootChrome, coarsePointer, seedDefaults } from "./core/chrome/boot";
import CommandPalette from "./core/chrome/CommandPalette";
import SearchPanel from "./core/search/SearchPanel";
import type { SearchResult } from "./core/search/client";
import { buildCommands, type GotoTarget } from "./core/chrome/commands";
import type { InfoHit } from "./core/info/types";
import type { GeoPoint } from "./core/chrome/geo";
import { createVesselInfoProvider, vesselInfoHit } from "./core/info/vesselProvider";
import { createCpaModeControl, riskThresholds } from "./core/collisionSettings";
import { POI_PROVIDER_ID } from "./features/poi/provider";
import { createCommandRegistry, dispatchKey, paletteCommands } from "./core/chrome/command";
import { applyArrangement, owningTab, type ChromeConfig } from "./core/chrome/config";
import AlarmStrip from "./core/chrome/AlarmStrip";
import NoticeStrip from "./core/chrome/NoticeStrip";
import { createNotices } from "./core/chrome/notices";
import { createAutopilot } from "./features/autopilot";
import { ANCHOR_MODE_ID, createAnchor } from "./features/anchor";
import { createCoreFeature, createGpsStatus } from "./core/chrome/core";
import { createInstruments } from "./features/instruments";
import { createCursor } from "./core/chrome/cursor";
import Dashboard from "./core/chrome/Dashboard";
import type { DashboardDrag } from "./core/chrome/dashboardDnd";
import { createMeasure } from "./features/measure";
import { createRegionDraw } from "./features/region-draw";
import { createTrack } from "./features/track";
import { createNoticesToMariners, noticeSearchHit } from "./features/notices";
import NoticesList from "./features/notices/NoticesList";
import { createBuddies } from "./features/buddies";
import BuddyList from "./features/buddies/BuddyList";
import { createMarks } from "./features/marks";
import MarkList from "./features/marks/MarkList";
import type { BBox } from "./core/settings/regions";
import ModePill from "./core/chrome/ModePill";
import { createModeState, tapRadius } from "./core/chrome/modes";
import { dismissTopBackLayer, startBackStack, useBackDismiss } from "./core/chrome/backStack";
import { dismissOnEscape, isFreeEscape } from "./core/chrome/escape";
import { createChartKeyNav, domScrolls } from "./core/map/keyNav";
import Rail from "./core/chrome/Rail";
import LayersPanel from "./core/chrome/LayersPanel";
import { createRegistry } from "./core/chrome/registry";
import {
  type AppFeature,
  type MapLayer,
  coreFeatures,
  featureCommands,
  featureDatasetParams,
  featureOverlayControls,
  featureOverlays,
  featureProviders,
  featureSettings,
  featureSettingsCategories,
  featureSettingsSections,
  featureWidgets,
} from "./core/chrome/feature";
import { createWidgetRegistry, withWidgets } from "./core/chrome/widget";
import { WIDGETS } from "./core/chrome/widgets";
import { createRoutes } from "./features/route";
import { routeHit } from "./features/route/provider";
import RouteList from "./features/route/RouteList";
import { createRouteDraw, ROUTE_DRAW_MODE_ID } from "./features/routeDraw";
import RouteDrawCard from "./features/routeDraw/RouteDrawCard";
import { createLegTable } from "./features/legTable";
import LegTableSheet from "./features/legTable/LegTableSheet";
import TopBand from "./core/chrome/TopBand";
import { createRoutesClient } from "./core/routes";
import AnchorSheet from "./features/anchor/sheet";
import { createMob } from "./features/mob";
import MobControl from "./features/mob/MobControl";
import { createPoi } from "./features/poi";
import { pluginFeatures, setupPlugins, type SearchPick } from "./plugins";
import { createSatellite } from "./features/satellite";
import { createOsmWorld } from "./features/osm_world";
import { DEVICE_CATEGORIES, DEVICE_SECTIONS, DEVICE_SETTINGS } from "./core/settings/device";
import { BOAT_CATEGORIES, BOAT_SECTIONS } from "./core/settings/ServerSettings";
import { BOAT_SETTINGS } from "./core/settings/boat";
import { COLLISION_SETTINGS } from "./core/settings/collision";
import { GNSS_SETTINGS } from "./core/settings/gnss";
import { createLinkAlarmsFeature } from "./core/linkAlarms";
import { createSettingsRegistry } from "./core/settings/registry";
import MapView from "./MapView";
import { isCompact } from "./core/media";
import { coerceBoolean, coerceStringArray, deviceSetting, hasStored } from "./core/persist";
import { adoptDefaultProfile, settingsFromProfile, takeBootDefaultProfile } from "./core/profiles";
import Sidebar from "./core/settings/Sidebar";
import { createSignalK } from "./core/signalk";
import { applyPalette } from "./core/style/palette";
import { ENC_GROUPS, encGroupLayerId, type EncGroupId } from "./core/style/encGroups";
import { orderMapLayers } from "./core/layers/mapLayerOrder";
import type { ChartSettings } from "./core/style/settings";

/**
 * A shared-search result → the `InfoHit` selecting it opens on the info
 * panel (SearchPanel itself never branches on `source`). `undefined` for a
 * source with no info provider yet — the result still pans via `onGoto`.
 */
function searchResultToHit(r: SearchResult): InfoHit | undefined {
  if (r.source === "ais") {
    // Backend prefixes AIS search rows `ais:<vessel id>` (backend/mivnav/
    // api/search.py) — strip it back to the id the live vessel list keys on.
    return vesselInfoHit(r.id.replace(/^ais:/, ""), r.title ?? "Vessel");
  }
  // Notices to Mariners rows (the backend index's `notices` slice) open the
  // notice like a tap on it.
  const notice = noticeSearchHit(r);
  if (notice) return notice;
  if (r.source === "poi") {
    return {
      providerId: POI_PROVIDER_ID,
      id: r.id,
      priority: "regulated",
      precision: "point",
      title: r.title ?? "POI",
      subtitle: r.category ?? undefined,
      lngLat: r.lat !== null && r.lon !== null ? { lng: r.lon, lat: r.lat } : undefined,
      // POI provider's `detail` reads {name, kind, kind_detail} — the exact
      // shape mivnav.ingest.poi's `_search_records` already produces as `data`.
      payload: r.data,
    };
  }
  return undefined;
}

const App: Component = () => {
  // Captured BEFORE deviceSetting writes its default back: a fresh device has
  // nothing stored, and that (not the value) decides whether it adopts the
  // boat-wide default profile below.
  const hadLocalSettings = hasStored("settings");
  // settingsFromProfile is the coercer: a stored settings blob and a profile
  // blob are the same opaque document, so the field-by-field robustness the
  // profile path always had now guards the device key too. See profiles.ts.
  const [settings, setSettings] = deviceSetting<ChartSettings>("settings", {
    coerce: settingsFromProfile,
  });
  // First boot, once: a device that has run before never re-asks, so an admin
  // changing the default later can't stomp a device that has sailed with its
  // own settings. Resolves even offline — see adoptDefaultProfile. Normally
  // already adopted by index.tsx's boot gate and applied HERE, before MapView
  // builds the map (see prefetchDefaultProfile); onMount is the fallback when
  // the gate timed out.
  // Keep the screen awake while the chart is visible (no-op over plain http).
  createScreenWakeLock(() => settings().keepScreenOn);
  const bootDefault = hadLocalSettings ? undefined : takeBootDefaultProfile();
  if (bootDefault) setSettings(bootDefault);
  onMount(() => {
    if (!bootDefault) void adoptDefaultProfile({ hasLocalChoice: hadLocalSettings, apply: setSettings });
    // Prime the chart-detail bias before Settings is ever opened, so SCAMIN
    // gate/fade track the server's boundary from the first paint.
    void seedChartDetail();
    // Re-check every 5 min and on focus-regain: this tab can stay open for
    // days as a kiosk display (visibilitychange may never fire), so a
    // one-shot boot read alone would miss every later deploy. Also re-observes
    // /api/config's boot_id (serverConfig.ts noteBootId), busting the tile
    // cache on a backend restart even if Settings is never opened.
    const recheckServerBoot = () => void seedChartDetail();
    const timer = setInterval(recheckServerBoot, 5 * 60 * 1000);
    const onVisible = () => {
      if (document.visibilityState === "visible") recheckServerBoot();
    };
    document.addEventListener("visibilitychange", onVisible);
    onCleanup(() => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    });
  });
  // MapView rebuilds the chart style from settings.palette; this reflects the
  // same field onto :root for the chrome's CSS tokens. See style/palette.ts.
  applyPalette(() => settings().palette);
  const [disabledSets, setDisabledSets] = deviceSetting<string[]>("disabledSets", {
    coerce: coerceStringArray,
  });
  const [debugLayers, setDebugLayers] = deviceSetting<boolean>("debugLayers", {
    coerce: (raw) => coerceBoolean(raw, false),
  });
  // Tile-boundary debug overlay (maplibre showTileBoundaries): grid + z/x/y,
  // for diagnosing chart seams / missing (503) tiles.
  const [debugTiles, setDebugTiles] = deviceSetting<boolean>("debugTiles", {
    coerce: (raw) => coerceBoolean(raw, false),
  });
  // Cell-coverage debug overlay (/api/debug/cells): a detail seam reads as
  // one cell's coverage boundary.
  const [debugCells, setDebugCells] = deviceSetting<boolean>("debugCells", {
    coerce: (raw) => coerceBoolean(raw, false),
  });
  const [fpsDebug, setFpsDebug] = deviceSetting<boolean>("fpsDebug", {
    coerce: (raw) => coerceBoolean(raw, false),
  });
  // Lat/long graticule — a navigation aid, not debug; spacing adapts to zoom
  // (core/graticule.ts). Off by default.
  const [showGrid, setShowGrid] = deviceSetting<boolean>("showGrid", {
    coerce: (raw) => coerceBoolean(raw, false),
  });
  // Closed on every load — a permanent sidebar ate too much chart for what's
  // worth one tap. Immersion itself comes from the PWA manifest display mode,
  // not a Fullscreen-API toggle here.
  const [sidebarOpen, setSidebarOpen] = createSignal(false);

  // Retries with backoff and reports its own failure — a fetch-once resource
  // that just logged and returned [] left the plotter chartless until reload.
  const catalog = createCatalog();
  const allSets = () => catalog.sets();
  // This screen's o-charts registration (core/ochartsDevice.ts): an
  // unregistered screen draws the free sets only, through `/tiles/free` —
  // and so does any screen that has lost the server for over 20 s (started
  // below, once the backend websocket exists).
  const drawnSets = createMemo(() => drawableSets(allSets(), ochartsDevice.union()));
  // The boot splash (core/splash.ts) holds until MapView's `onReady`, which
  // waits for this: a catalog in hand, or the server's word that there isn't
  // one. NOT a failure: that's the splash's fault state below, and readiness
  // must stay unclaimed through it so boot resumes when the server comes back.
  const chartsSettled = () => catalog.sets().length > 0 || (catalog.error() === "" && !catalog.loading());
  // While the splash is up it says where boot stands on the catalog: still
  // asking, or why it failed and when it asks again (a 1 s tick drives the
  // countdown). A failure holds the splash as a fault; reaching the app
  // without a catalog is the crew's call ("Open anyway"), then CatalogAlert's.
  // Recovery reloads: a hung boot also missed the themes, config and profile,
  // and MapLibre never re-asks for a tile that failed, so a map patched up in
  // place stays part dead. Nothing is on screen to lose behind the splash.
  // Once the catalog settles MapView takes over the line with what it is
  // still drawing (`onBootStatus`).
  const [now, setNow] = createSignal(Date.now());
  const tick = setInterval(() => (splashShowing() ? setNow(Date.now()) : clearInterval(tick)), 1000);
  onCleanup(() => clearInterval(tick));
  const catalogFailed = () => catalog.error() !== "" && catalog.sets().length === 0;
  let catalogFaultShown = false;
  createEffect(() => {
    const err = catalog.error();
    if (catalog.sets().length > 0 || err === "") {
      if (catalogFaultShown && catalog.sets().length > 0 && splashShowing()) {
        location.reload();
        return;
      }
      if (catalog.sets().length === 0 && catalog.loading()) {
        setSplashStatus("Connecting to server…", "Still waiting for an answer.");
      }
      return;
    }
    const at = catalog.nextRetryAt();
    now(); // re-run each tick; the count itself reads the real clock, since
    // the tick's last value can be up to a second old when a retry is scheduled.
    const secs = at === undefined ? 0 : Math.max(0, Math.ceil((at - Date.now()) / 1000));
    const retry = secs > 0 ? `Retrying in ${secs} s…` : "Retrying…";
    catalogFaultShown = true;
    setSplashFault(describeFetchError(err), `${faultHint(err, navigator.onLine)} ${retry}`, catalog.refresh);
  });

  // A re-ingested set keeps its tile URLs and only moves its `sequence`
  // (mirrors the backend's per-set ETag) — the URL-keyed RAM tile cache can't
  // see that, so it'd serve stale bytes. Drop the whole cache on ANY sequence
  // change surfaced by a catalog refresh. First arrival is not a change.
  let prevSeq = "";
  createEffect(() => {
    const sig = allSets()
      .map((set) => `${set.id}:${set.sequence}`)
      .join(";");
    if (prevSeq !== "" && sig !== prevSeq) clearChartTileCache();
    prevSeq = sig;
  });

  // No URL: the boat's server holds the connection and every device
  // subscribes to it. See signalk.ts.
  const signalk = createSignalK();
  onCleanup(ochartsDevice.start(signalk.linkDownSince));
  // The collision alarm's off/show/tell is the boat's (server config), set
  // from the rail or the palette for every screen and SignalK at once.
  const cpaMode = createCpaModeControl(
    () => signalk.collisionSettings().mode,
    (mode) => patchServerConfig({ collision: { mode } }),
  );

  // The chrome, assembled once, here, and prop-drilled — the same shape as
  // `attachInfoPanel(map, { providers: [...] })`. Deliberately not a module
  // singleton: that would leak between tests and would put import order in
  // charge of the rail's order, which belongs to the feature list on this line
  // and to nothing else.
  // Measure and the cursor readout are just features — one line each, no shell
  // edit and no menu to update. They are the two halves of README #6: hover
  // gives a desktop bearing and range for free, a phone cannot hover, so it taps
  // for the same answer. Each factory hands back the feature AND the model the
  // map needs, because a mode owns its state and the kernel does not.
  const cursor = createCursor(signalk);
  const measure = createMeasure(signalk);
  // Region-draw mode: draws a bounding box for the Regions settings section.
  // No launcher of its own — reached via `startRegionDraw` below. Needs a
  // THIRD bind (`bindLeft`, beyond enter/exit) because Settings is a true
  // modal and must reopen on every exit, not just a completed box (see
  // features/region-draw/index.ts).
  const regionDraw = createRegionDraw();
  // Routes are BOAT data on the server; the client is the live view, the
  // feature takes it so GO/insert/append logic is testable without a network.
  const routesClient = createRoutesClient({
    onPublishFailed: (detail) =>
      notices.push({ id: "route-publish-failed", title: "Autopilot course not updated", detail: detail || undefined }),
  });
  // Transient arrival notices (waypoint reached / route complete) — a quiet
  // NOTICE, not the alarm band's collision red. See chrome/notices.ts.
  const notices = createNotices();
  // The MANUAL route editor: straight legs placed by hand, saved on Done.
  // Separate from the autorouting plugin's editor; shares only the store.
  const routeDraw = createRouteDraw({
    client: routesClient,
    notify: (notice) => notices.push(notice),
    tapRadius: () => tapRadius(chrome().pointerCoarse),
    // Both read lazily (only while the editor is open), so closing over
    // signals declared further down is safe.
    center: () => mapCenter(),
    marks: () => marks.marks(),
    // Done = save AND start the route (user, 2026-11-13), from the next
    // waypoint ahead of the boat (`followStartIndex`). Another route being
    // followed → Follow asks "Switch to …?" first. If it doesn't start, the
    // route still stays on the chart rather than vanishing.
    onClosedSaved: (r) => {
      void (async () => {
        const res = await routes.model.follow(r);
        if (res !== "started" && res !== "already") routes.model.showRoute(r);
      })();
    },
  });
  // The leg table: the editor's draft, or a saved route from its card/list.
  const legTable = createLegTable({ client: routesClient, routeDraw: routeDraw.model, self: signalk.self });
  const routes = createRoutes({
    signalk,
    client: routesClient,
    onArrival: (notice) => notices.push(notice),
    notify: (notice) => notices.push(notice),
    hiddenRouteId: routeDraw.model.editingRouteId,
    editPoints: routeDraw.model.edit,
    showLegs: legTable.model.openRoute,
  });
  // Anchor watch: a front-end to SignalK's anchoralarm plugin (anchor.md) —
  // the plugin watches, this shows, alarms and commands it.
  const anchor = createAnchor({ signalk });
  // Man overboard: the button (reserved chrome, below), the O key, the
  // alarm and the mark. Raised on the server, so every screen and the MFD agree.
  const mob = createMob({ signalk });
  const toggleWindUnit = () =>
    setSettings((s) => ({ ...s, windUnit: s.windUnit === "ms" ? "kn" : "ms" }));
  // Plugins (src/plugins.ts), set up once against the app. `modes` is built
  // further down (it needs the registry, which needs these features), so
  // the host reaches it lazily — a plugin only calls it after mount.
  const pluginInstances = setupPlugins({
    settings,
    setSettings,
    toggleWindUnit,
    modes: {
      active: () => modes.active(),
      enter: (id) => modes.enter(id),
      leave: () => void modes.leave(),
    },
    signalk,
    notify: (notice) => notices.push(notice),
    density: () => chrome().density,
    routes: { model: routes.model, client: routesClient, openList: () => openRoutes() },
    openSearch: (pick) => {
      setSearchPick(pick);
      setSearchOpen(true);
    },
  });
  // Built out-of-line like satellite; `onCatalogChanged` below is the
  // only thing that still deletes a POI set (the old ingest UI is retired).
  const poi = createPoi();
  // Overlay is a negative-z underlay, born inert (no source when off), so it
  // never perturbs the top overlay z-stack or costs anything disabled.
  const satellite = createSatellite();
  // Contributes no overlay/mode here — only the dataset-params sub-form and
  // live min/max zoom threaded to MapView so buildStyle's osm-world source
  // tracks what was actually baked, not a static guess.
  const osmWorld = createOsmWorld();
  // Ship track, from SignalK's History API (nothing recorded locally). Takes
  // `settings` because both gates (poll at all, and the window) are settings;
  // off by default so a boat with no history plugin never requests. `self`
  // draws the newest stretch on live, between polls.
  const track = createTrack({
    settings,
    self: signalk.self,
    routes: { client: routesClient, notify: (n) => notices.push(n), edit: routeDraw.model.edit },
  });
  // Notices to Mariners (Danish EfS/NW from the backend's Niord snapshot):
  // overlay + Layers row + per-family filters. Inert while `showNotices` is
  // off (no poll, no source). `noticesToMariners.client` is the shared store the info
  // provider / list panel read. Not `notices`: that is the arrival strip.
  // `showHits`/`beforeOpenList` close over signals declared further down —
  // only ever called after mount, by which time they exist.
  const noticesToMariners = createNoticesToMariners({
    settings,
    showHits: (hits) => setInfoHitRequest(hits),
    beforeOpenList: () => {
      setSidebarOpen(false);
      setRoutesOpen(false);
      buddies.list.setOpen(false);
      marks.list.setOpen(false);
    },
  });
  const buddies = createBuddies({
    signalk,
    settings,
    showHits: (hits) => setInfoHitRequest(hits),
    beforeOpenList: () => {
      setSidebarOpen(false);
      setRoutesOpen(false);
      noticesToMariners.list.setOpen(false);
      marks.list.setOpen(false);
    },
    notify: (title) => notices.push({ id: "buddy-add", title }),
  });
  // Standalone marks (Signal K waypoints). Long-press/right-click drops one;
  // "Go here" on its panel is the route feature's course publish.
  const marks = createMarks({
    signalk,
    settings,
    showHits: (hits) => setInfoHitRequest(hits),
    beforeOpenList: () => {
      setSidebarOpen(false);
      setRoutesOpen(false);
      noticesToMariners.list.setOpen(false);
      buddies.list.setOpen(false);
    },
    notify: (title) => notices.push({ id: "mark-save", title }),
  });
  // THE ONE LIST: every registry below is a projection of this array (the
  // `feature*` collectors in chrome/feature.ts). Adding a feature is one
  // entry here — it then appears in the rail/board, map overlays, info
  // panel, command palette, dashboard widgets and settings drawer, no
  // other edit. Maplibre overlay/provider values live in this app-layer
  // file, never the pure kernel registry.
  const features: AppFeature[] = [
    createCoreFeature({
      signalk,
      // Boat-wide server config (`collision.*`, Settings → Alarms),
      // read off the snapshot — the same on every screen.
      collision: signalk.collisionSettings,
    }),
    // GNSS lost (raised on the server) and this screen's / the server's
    // links (raised only here) — Server settings → Alarms.
    createLinkAlarmsFeature({ signalk }),
    // Depth & wind, and the shallow-water alarm's face — right after core so
    // the rail reads SOG COG … DPT AW TW and the board tab follows Nav.
    createInstruments({ signalk }),
    cursor.feature,
    measure.feature,
    regionDraw.feature,
    routes.feature,
    routeDraw.feature,
    legTable.feature,
    // AFTER routes so the dashboard page order comes out Nav, Route, Pilot.
    createAutopilot({ signalk }),
    anchor.feature,
    poi.feature,
    // Plugins' own features, right after POI so a plugin's POI layer row
    // sits next to the POI toggle.
    ...pluginFeatures(pluginInstances),
    satellite.feature,
    osmWorld.feature,
    // Past track sits at the end: only contributes an overlay/Layers row/one
    // setting, so its position affects nothing but the order of those two.
    noticesToMariners.feature,
    buddies.feature,
    marks.feature,
    track.feature,
    mob.feature,
  ];
  const reg = createRegistry(coreFeatures(features));
  const infoProviders = featureProviders(features);
  // The live vessel provider that draws a real AIS icon lives in
  // core/info/attach.tsx and is never exposed back out (InfoState stays
  // JSX/wiring-free) — search needs its own copy for a result row's icon,
  // built the same way. `project` is never called here: SearchPanel/HitIcon
  // only resolve `icon`, never `queryAt`.
  const searchVesselProvider = createVesselInfoProvider({
    vessels: signalk.vessels,
    thresholds: () => riskThresholds(signalk.collisionSettings()),
    atRestKn: () => signalk.collisionSettings().at_rest_kn,
    settings,
    project: () => ({ x: 0, y: 0 }),
  });
  const searchProviders = [...infoProviders, searchVesselProvider];
  // Distinct from the SignalK link status: the link can be up while the fix
  // is dead.
  const gpsStatus = createGpsStatus({ signalk });
  // The chart-mode seam (invariant #9): a click means "what is here?" until a
  // mode says otherwise.
  const modes = createModeState(reg);
  // The mode is built before the state machine that owns it (registry needs
  // the feature first), so bind leave/enter here once both exist.
  routeDraw.model.bindMode({ enter: () => modes.enter(ROUTE_DRAW_MODE_ID), leave: () => modes.leave() });
  // Third bind (`bindLeft`, beyond enter/exit) — Settings is a true modal and
  // must reopen on every exit, not just a completed box.
  anchor.bindMode({ enter: modes.enter, leave: () => modes.leave() });
  marks.bindMode({ enter: modes.enter, leave: () => modes.leave(), active: modes.active });
  regionDraw.model.bindEnter(() => modes.enter("region-draw"));
  regionDraw.model.bindExit(() => modes.leave());
  regionDraw.model.bindLeft(() => setSidebarOpen(true));
  // Close Settings (a true modal) before entering the mode — the chart
  // underneath isn't tappable while it's up. `bindLeft` above reopens it.
  const startRegionDraw = (existing: readonly BBox[], onDone: (boxes: BBox[]) => void) => {
    setSidebarOpen(false);
    regionDraw.model.start({ existing, onDone });
  };
  // Lives here, not in RegionListSection: drawing closes (unmounts) Settings
  // first, so that component's own state can't carry the drawn boxes across
  // the round trip — this App-level signal survives it. `takeDrawnRegion`
  // clears on read so a later Settings open never resurrects a stale draft.
  const [pendingRegionDraft, setPendingRegionDraft] = createSignal<BBox[] | null>(null);
  const takeDrawnRegion = () => {
    const boxes = pendingRegionDraft();
    setPendingRegionDraft(null);
    return boxes;
  };
  // Android/gesture Back peels the active chart mode instead of leaving the
  // app. `leave()` can veto in principle (`requestLeave`), but no mode does
  // today. See core/chrome/backStack.ts. Back-only (`escape: false`): the
  // mode's Escape is the `exit-mode` command, which is suppressed while
  // typing — the generic Escape peel must not leave the mode from inside one
  // of its own text fields (a route name), nor reach under it.
  useBackDismiss(
    () => modes.active() !== null,
    () => void modes.leave(),
    { escape: false },
  );
  // Saved-route manager, opened from the rail's Tools menu.
  const [routesOpen, setRoutesOpen] = createSignal(false);
  const [layersOpen, setLayersOpen] = createSignal(false);
  // Settings, Routes and the Notices list all dock left on desktop (shrink
  // the map) — two at once would eat the chart, so opening one closes the
  // others (the notices list's own opener does the same via
  // `beforeOpenList`). The dashboard board (right) is independent. Moot on a
  // phone (bottom sheets).
  const openSettings = () => {
    setRoutesOpen(false);
    noticesToMariners.list.setOpen(false);
    buddies.list.setOpen(false);
    marks.list.setOpen(false);
    setSidebarOpen(true);
  };
  const openRoutes = () => {
    setSidebarOpen(false);
    noticesToMariners.list.setOpen(false);
    buddies.list.setOpen(false);
    marks.list.setOpen(false);
    setRoutesOpen(true);
  };
  // A plugin's route editor reaches the saved-routes list through this too
  // (`PluginHost.routes.openList`).
  // (#RT-GONAV).
  // Follow from the leg table or the manual editor's card: always the SAVED
  // route (an open draft is offered Follow only while clean, i.e. equal to
  // it). From the editor, a started follow closes it, like its Go.
  const followSaved = async (route: { id: string }) => {
    const saved = routesClient.routes().find((r) => r.id === route.id);
    if (!saved) return;
    const res = await routes.model.follow(saved);
    if (res === "started" && routeDraw.model.draft()?.id === saved.id && !routeDraw.model.dirty()) void routeDraw.model.done();
  };
  const draftSaved = () => {
    const id = routeDraw.model.draft()?.id;
    return !!id && routesClient.routes().some((r) => r.id === id);
  };
  const legTableFollow = {
    following: (r: { id: string }) => routes.model.activeRouteId() === r.id,
    blocked: () =>
      legTable.model.editable() && (routeDraw.model.dirty() || !draftSaved())
        ? "Save first (Done), then Follow"
        : null,
    run: (r: { id: string }) => void followSaved(r),
  };

  // THE GENERIC MAP-LAYER REGISTRY — one `MapLayer` per controllable layer,
  // default bottom→top: ENC groups, wash overlays, own-ship pinned topmost.
  // Own-ship is never reordered and never in persisted `layerOrder` — never
  // lose your own boat (layers/overlay.ts).
  const overlayControlDeps = {
    settings,
    setSettings: (patch: Partial<ChartSettings>) => setSettings((s) => ({ ...s, ...patch })),
    activeMode: modes.active,
  };
  const patchGroup = (group: EncGroupId, patch: { visible?: boolean; opacity?: number }) =>
    setSettings((s) => ({
      ...s,
      encGroups: { ...s.encGroups, [group]: { ...s.encGroups[group], ...patch } },
    }));
  const encGroupLayers: MapLayer[] = ENC_GROUPS.map((g) => ({
    id: encGroupLayerId(g.id),
    label: g.label,
    visible: () => settings().encGroups[g.id].visible,
    setVisible: (v) => patchGroup(g.id, { visible: v }),
    opacity: () => settings().encGroups[g.id].opacity,
    setOpacity: (v) => patchGroup(g.id, { opacity: v }),
  }));
  // Base OSM layer: a themed vector basemap baked server-side and served
  // from /api/osm_world/tiles — needs no boat internet, only a prior bake
  // (CLAUDE.md: no cellular link). `id` stays "osm" — a stable layer-list
  // identity saved orderings key on, not a MapLibre layer id.
  const osmBaseLayer: MapLayer = {
    id: "osm",
    label: "OpenStreetMap basemap",
    visible: () => settings().showOsmBase,
    setVisible: (v) => setSettings((s) => ({ ...s, showOsmBase: v })),
  };
  const openSeaMapLayer: MapLayer = {
    id: "openseamap",
    label: "OpenSeaMap seamarks",
    visible: () => settings().showOpenSeaMap,
    setVisible: (v) => setSettings((s) => ({ ...s, showOpenSeaMap: v })),
  };
  const ownShipLayer: MapLayer = {
    id: "own-ship",
    label: "Own ship",
    pinned: true,
    visible: () => true,
    setVisible: () => {},
  };
  const mapLayers: MapLayer[] = [
    osmBaseLayer,
    ...encGroupLayers,
    openSeaMapLayer,
    ...featureOverlayControls(features, overlayControlDeps),
    ownShipLayer,
  ];
  const orderedLayers = createMemo(() => orderMapLayers(mapLayers, settings().layerOrder));
  const setLayerOrder = (ids: string[]) => setSettings((s) => ({ ...s, layerOrder: ids }));
  // null while layerOrder is empty (default), so the reorder pass is skipped
  // and the stack stays byte-identical to today.
  const bandOrder = createMemo<string[] | null>(() =>
    settings().layerOrder.length === 0
      ? null
      : orderedLayers()
          .filter((l) => !l.pinned)
          .map((l) => l.id),
  );

  // Coercer runs every boot; seedDefaults is only a first-run guess (density
  // is a setting, not a breakpoint — invariant #10). bootChrome then repairs
  // a stale stored config and seats new widgets — not optional, a shallow
  // merge used to silently drop any widget added since (see boot.ts).
  const [chrome, setChrome] = deviceSetting<ChromeConfig>("chrome", {
    coerce: (raw) =>
      bootChrome(
        raw !== null && typeof raw === "object" && !Array.isArray(raw)
          ? ({ ...seedDefaults(coarsePointer()), ...(raw as object) } as ChromeConfig)
          : seedDefaults(coarsePointer()),
        reg,
      ),
  });

  const applyLayout = (blob: unknown) => setChrome((c) => applyArrangement(c, blob, reg));

  // Merged registry for the BOARD only — rail/sidebar deal in registry
  // instruments only, and `alerts()` must never see a user widget, so
  // `withWidgets` overrides `byId` alone and leaves `reg.instruments` be.
  const widgetReg = createWidgetRegistry([...WIDGETS, ...featureWidgets(features)]);
  const dashboardReg = withWidgets(reg, widgetReg, chrome, { paths: signalk.paths });

  // ONE settings registry for the whole surface — used to be two (this one
  // plus a module-local `boatReg` nothing else could see), which is why the
  // boat group used to bypass the registry for four of its sections.
  const settingsReg = createSettingsRegistry(
    [...DEVICE_SETTINGS, ...BOAT_SETTINGS, ...COLLISION_SETTINGS, ...GNSS_SETTINGS, ...featureSettings(features)],
    [...DEVICE_SECTIONS, ...BOAT_SECTIONS, ...featureSettingsSections(features)],
    [...DEVICE_CATEGORIES, ...BOAT_CATEGORIES, ...featureSettingsCategories(features)],
  );

  const datasetParamsReg = featureDatasetParams(features);

  // Rebuilt in a memo so a reopened palette reflects live settings.
  // `gotoTarget` is the seam MapView subscribes to for camera moves; each
  // go-to writes a fresh object so the same coordinate twice still moves.
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const [searchOpen, setSearchOpen] = createSignal(false);
  // A plugin's pick in progress (`PluginHost.openSearch` — the route editor
  // resolving a From/Stop/To slot): its pinned rows go ahead of the real
  // results and a pick goes to its `onSelect` instead of the ordinary
  // goto/info-panel select. Reset whenever the panel closes for any reason
  // (picked or dismissed) so a later plain Ctrl/Cmd-F search never inherits it.
  const [searchPick, setSearchPick] = createSignal<SearchPick | null>(null);
  // `{tab, n}` — `n` is a nonce so a repeat request for the same tab still
  // fires. Raised alongside the open-board request, so a tile tap lands on
  // the owning tab, not just the board.
  const [tabRequest, setTabRequest] = createSignal<{ tab: string; n: number } | undefined>();
  // A counter (not a boolean) so re-running the command re-centres after a
  // manual pan.
  const [centreRequest, setCentreRequest] = createSignal(0);
  const [openBoardRequest, setOpenBoardRequest] = createSignal(0);
  // Lifted here so it's shared between the Dashboard (creates/drives it) and
  // the Rail (an ANCESTOR of the board, can't see a board-provided context).
  const [boardDrag, setBoardDrag] = createSignal<DashboardDrag | undefined>();
  // Lifted for the same ancestor reason: the Rail strip needs to know when to
  // render itself as an editable drop zone.
  const [boardEditing, setBoardEditing] = createSignal(false);
  const [gotoTarget, setGotoTarget] = createSignal<GotoTarget | null>(null);
  // Each non-null value is a freshly-built InfoHit[], so selecting the same
  // result twice still opens the panel (never `===` the last one).
  const [infoHitRequest, setInfoHitRequest] = createSignal<InfoHit[] | null>(null);

  // Forwarded to the search overlay so it can ask the backend to sort
  // nearest-first. `undefined` until the map's first frame reports one.
  const [mapCenter, setMapCenter] = createSignal<GeoPoint>();

  // Owning tab = first config tab whose `order` includes the id. Found →
  // open the board AND request that tab; not found → just open the board.
  const openInstrumentTab = (instrumentId: string): void => {
    setOpenBoardRequest((n) => n + 1);
    const owning = owningTab(chrome(), instrumentId);
    if (owning) setTabRequest((prev) => ({ tab: owning.id, n: (prev?.n ?? 0) + 1 }));
  };
  // Arrow-key pan / +/- zoom: fed by the keydown listener below, bound to the
  // map by MapView.
  const chartKeys = createChartKeyNav();
  // The ONE registry the palette and keyboard accelerators derive from.
  // Rebuilt in a memo so labels/enabled/live settings refresh together.
  const commands = createMemo(() => {
    const deps = {
      onGoto: setGotoTarget,
      settings,
      setSettings: (patch: Partial<ChartSettings>) => setSettings((s) => ({ ...s, ...patch })),
      toggleWindUnit,
      openSettings,
      openSearch: () => setSearchOpen(true),
      openRoutes,
      centreBoat: () => setCentreRequest((n) => n + 1),
      hasFix: routes.model.hasFix,
      openDashboard: () => setOpenBoardRequest((n) => n + 1),
      // Same path a tile tap takes: opens the board on the Pilot tab.
      openAutopilot: () => openInstrumentTab("ap.status"),
      openInstrument: openInstrumentTab,
      hasAutopilot: () => !!signalk.autopilot(),
      toggleMode: modes.toggle,
      leaveMode: modes.leave,
      activeMode: modes.active,
      togglePalette: () => setPaletteOpen((o) => !o),
      debugLayers,
      setDebugLayers,
      setCpaMode: cpaMode.setMode,
    };
    return createCommandRegistry([...buildCommands(deps), ...featureCommands(features, deps)]);
  });

  // ONE listener, dispatched through the command registry (dispatchKey): every
  // keystroke is a command's `keybinding`, no key→action map here. A bare key
  // is suppressed while typing or the palette is open; a modifier chord fires
  // regardless. `preventDefault` lets Ctrl/Cmd-K win over the browser's own
  // history/search shortcut.
  //
  // Escape ("make the escape button close any windows, like the poi pop up"),
  // in precedence order:
  //  1. Already claimed (a Kobalte dialog/popover/menu closed itself and
  //     `preventDefault`ed, an inline edit cancelled, an IME is composing…) →
  //     nothing here acts, so one press never closes two things.
  //  2. A chart mode is active → `exit-mode` (a command, so it is first).
  //  3. Otherwise the TOPMOST open window closes — the back-stack's top
  //     layer, through the same dismisser Back and its own X use.
  //
  // Chart keys ("the arrow keys should move us around the map"), last: a
  // keydown that is no command and closed nothing goes to `chartKeys`
  // (core/map/keyNav.ts) — arrows pan, +/- zoom, wherever focus is, unless
  // the key is not free: already claimed, typed into a field, owned by the
  // focused control (slider, list, menu, tabs, a scrolling panel) or a modal
  // surface is open. Its keyup/blur listeners only ever RELEASE a held arrow.
  onMount(() => {
    const ctx = { close: () => setPaletteOpen(false), prompt: () => {} };
    // A modal surface owns the keyboard wherever focus happens to sit: the
    // palette and search, the lightbox (`aria-modal`), and any Kobalte modal
    // dialog/menu — those mark everything outside themselves `aria-hidden`,
    // the chart included, which is what the `closest` reads.
    const modalOpen = () =>
      paletteOpen() ||
      searchOpen() ||
      document.querySelector('[aria-modal="true"]') !== null ||
      (document.querySelector(".maplibregl-map")?.closest('[aria-hidden="true"], [inert]') ?? null) !== null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isFreeEscape(e)) return;
      const ran = dispatchKey(commands().commands, e, {
        typing: isTypingTarget(e.target),
        paletteOpen: paletteOpen(),
      }, ctx);
      if (ran) return;
      if (dismissOnEscape(e, dismissTopBackLayer)) return;
      chartKeys.keydown(e, { modalOpen: modalOpen(), scrolls: domScrolls });
    };
    const onKeyUp = (e: KeyboardEvent) => chartKeys.keyup(e);
    const onBlur = () => chartKeys.release();
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    });
  });

  // ONE popstate listener for the back-stack; each surface opts in via
  // useBackDismiss. See core/chrome/backStack.ts.
  onMount(() => onCleanup(startBackStack()));

  const toggleSet = (id: string, enabled: boolean) =>
    setDisabledSets((prev) =>
      enabled ? prev.filter((d) => d !== id) : prev.includes(id) ? prev : [...prev, id],
    );

  // The rail is a flex SIBLING of the map, never an overlay: the chart RESIZES
  // rather than being covered when the rail widens into the board (MapLibre's
  // ResizeObserver does the rest). Column on a phone, row on a wide screen —
  // density (told, not measured) decides how big, not the viewport query.
  return (
    <div class="flex h-full w-full" classList={{ "flex-col": isCompact() }}>
      {/* Route list is a LEFT DOCKED flex sibling (shrinks the map, chart stays
          visible); Settings is a true modal, contributes no width. Only one
          open at a time (openSettings/openRoutes close the sibling). */}
      <Sidebar
        open={sidebarOpen()}
        onOpenChange={setSidebarOpen}
        settings={settings()}
        onSettings={(patch) => setSettings((s) => ({ ...s, ...patch }))}
        signalkStatus={signalk.status()}
        debugLayers={debugLayers()}
        onDebugLayers={setDebugLayers}
        debugTiles={debugTiles()}
        onDebugTiles={setDebugTiles}
        debugCells={debugCells()}
        onDebugCells={setDebugCells}
        fpsDebug={fpsDebug()}
        onFpsDebug={setFpsDebug}
        showGrid={showGrid()}
        onShowGrid={setShowGrid}
        sets={allSets()}
        disabledSets={disabledSets()}
        onToggleSet={toggleSet}
        catalogError={catalog.error()}
        onRetryCatalog={catalog.refresh}
        settingsReg={settingsReg}
        chrome={chrome}
        onChrome={setChrome}
        applyLayout={applyLayout}
        datasetParams={datasetParamsReg}
        onStartRegionDraw={startRegionDraw}
        onStageDrawnRegion={setPendingRegionDraft}
        onTakeDrawnRegion={takeDrawnRegion}
        onCatalogChanged={() => {
          clearChartTileCache();
          catalog.refresh();
          // The generic Datasets list is the one place that deletes a
          // poi/satellite set now, so a delete there must refresh every
          // provider's overlay through this shared callback, not a per-
          // provider one.
          poi.onCatalogChanged();
          satellite.onCatalogChanged();
        }}
      />
      <RouteList
        open={routesOpen()}
        onOpenChange={setRoutesOpen}
        routes={routes.model}
        editPoints={routeDraw.model.edit}
        newManual={routeDraw.model.newRoute}
        showLegs={legTable.model.openRoute}
        fromTrack={track.supported() && track.makeRoute ? () => void track.makeRoute!() : undefined}
      />
      <LegTableSheet model={legTable.model} follow={legTableFollow} />
      <NoticesList
        open={noticesToMariners.list.open()}
        onOpenChange={noticesToMariners.list.setOpen}
        client={noticesToMariners.client}
        palette={() => settings().palette}
        self={() => signalk.self() ?? undefined}
        center={mapCenter}
        onPick={(item) => void noticesToMariners.openNotice(item.id, item)}
      />
      <BuddyList
        open={buddies.list.open()}
        onOpenChange={buddies.list.setOpen}
        data={buddies.data()}
        api={buddies.api}
        reload={buddies.reload}
        palette={() => settings().palette}
        self={() => signalk.self() ?? undefined}
        onPick={buddies.focus}
      />
      <MarkList
        open={marks.list.open()}
        onOpenChange={marks.list.setOpen}
        marks={marks.marks()}
        stale={marks.stale()}
        palette={() => settings().palette}
        self={() => signalk.self() ?? undefined}
        onPick={marks.focus}
        onDropAtBoat={() => void marks.dropAtBoat()}
        onUpdate={(m, patch) => void marks.update(m, patch)}
        onRemove={(m) => void marks.remove(m)}
      />
      <div class="relative min-h-0 min-w-0 flex-1">
        <MapView
          sets={drawnSets}
          ochartsUnion={ochartsDevice.union}
          disabledSets={disabledSets}
          settings={settings}
          signalk={signalk}
          debugLayers={debugLayers}
          debugTiles={debugTiles}
          debugCells={debugCells}
          fpsDebug={fpsDebug}
          showGrid={showGrid}
          modes={modes}
          measure={measure.model}
          regionDraw={regionDraw.model}
          cursor={cursor.model}
          route={routes.model}
          pluginMaps={pluginInstances.flatMap((i) => (i.attachMap ? [i.attachMap] : []))}
          osmWorldMinZoom={osmWorld.catalog.minZoom}
          osmWorldMaxZoom={osmWorld.catalog.maxZoom}
          overlays={featureOverlays(features)}
          bandOrder={bandOrder}
          providers={infoProviders}
          vesselActions={buddies.vesselActions}
          onToggleWindUnit={toggleWindUnit}
          reg={reg}
          onLayers={() => setLayersOpen(true)}
          layersOpen={layersOpen}
          onSearch={() => setSearchOpen(true)}
          onCenterChange={setMapCenter}
          tapRadius={() => tapRadius(chrome().pointerCoarse)}
          density={() => chrome().density}
          goto={gotoTarget}
          showInfoHits={infoHitRequest}
          centre={centreRequest}
          chartsSettled={chartsSettled}
          onReady={dismissSplash}
          // A server that can't be reached outranks what the map is drawing
          // without it (the basemap from cache): the catalog line above keeps it.
          onBootStatus={(text, detail) => {
            if (!catalogFailed()) setSplashStatus(text, detail);
          }}
          onBootFault={(text, detail) => setSplashFault(text, detail, () => location.reload())}
          // "Go here" is the route planner's (the autorouting plugin); with no
          // planner it is "Go to": a straight line from the boat, no router,
          // no hazard check.
          goHere={(to, label) => {
            const planner = routePlanner();
            void (planner ? planner.goTo(to, label) : routes.model.goStraight(to, label));
          }}
          canGoHere={routes.model.hasFix}
          isFollowing={routes.model.following}
          keyNav={chartKeys}
          // Enter the mode FIRST — its `enter` clears state, so seeding the
          // pressed point after is what survives (chrome/measure.ts).
          measureFrom={(from) => {
            modes.enter("measure");
            measure.model.seed(from);
          }}
          addMark={(at) => void marks.dropAt(at)}
          newRouteFrom={routeDraw.model.newRouteFrom}
        />
        <DeviceRegistration device={ochartsDevice} ready={splashGone} />
        <CatalogAlert
          loading={catalog.loading()}
          error={catalog.error()}
          setCount={allSets().length}
          onRetry={catalog.refresh}
        />
        {/* band.top: the one exception to "chrome never covers the chart" —
            transparent, alive only while following a leg, earns it with a
            halo and no slab. */}
        <TopBand
          reg={dashboardReg}
          chrome={chrome}
          editing={boardEditing}
          drag={boardDrag}
          onChrome={setChrome}
          widgetReg={widgetReg}
          // A tap on the followed strip opens the route's card: Next /
          // Previous / Start at / Stop, without opening any editor.
          onOpen={() => {
            const r = routes.model.followLeg()?.route;
            if (r) setInfoHitRequest([routeHit(r)]);
          }}
        />
        <ModePill
          modes={modes}
          density={() => chrome().density}
          pointerCoarse={() => chrome().pointerCoarse}
        />
        <RouteDrawCard
          model={routeDraw.model}
          density={() => chrome().density}
          pointerCoarse={() => chrome().pointerCoarse}
          palette={() => settings().palette}
          onLegs={legTable.model.openDraft}
          onFollow={async () => {
            // Save first (a no-op when clean): the boat follows the SAVED copy.
            const saved = await routeDraw.model.save();
            if (saved) void followSaved(saved);
          }}
          isFollowed={() => routes.model.activeRouteId() === routeDraw.model.draft()?.id}
          isSaved={draftSaved}
        />
        {/* Plugins' own chrome (a mode's bottom sheet). */}
        <For each={pluginInstances.filter((i) => i.Chrome)}>{(i) => <Dynamic component={i.Chrome} />}</For>
        <AnchorSheet
          control={anchor.control}
          active={() => modes.active() === ANCHOR_MODE_ID}
          onClose={() => modes.leave()}
        />
        {/* See docs/architecture/alarm-strip-placement.md — reserved chrome
            (invariant #1), must render last so it wins any overlap. */}
        <NoticeStrip notices={notices} />
        {/* MOB: reserved like the alarm strip — every mode, every layout. */}
        <MobControl model={mob.model} />
        <AlarmStrip reg={reg} />
      </div>
      {/* Plugins' rail-side chrome (the route editor's sheet): a COLUMN
          SIBLING of the Rail (#RT-BARLAYOUT), not inside the map pane — a
          phone bottom bar must occupy the SAME 72px slot the Rail widget bar
          does (mutually exclusive, `Mode.ownsBottomBar`), so the map pane
          height never jumps. */}
      <For each={pluginInstances.filter((i) => i.RailChrome)}>{(i) => <Dynamic component={i.RailChrome} />}</For>
      <Rail
        // withWidgets overrides byId only, leaving reg.instruments (what
        // alerts() scans) alone — no user widget can reach the alarm band.
        reg={dashboardReg}
        chrome={chrome}
        signalkStatus={signalk.status}
        gpsStatus={gpsStatus}
        openBoard={openBoardRequest}
        // The ANC tile opens the anchor sheet — it has no dashboard tab.
        onInstrument={(id) => (id.startsWith("anchor.") ? modes.enter(ANCHOR_MODE_ID) : openInstrumentTab(id))}
        drag={boardDrag}
        editing={boardEditing}
        onChrome={setChrome}
        widgetReg={widgetReg}
        dashboard={
          <Dashboard
            reg={dashboardReg}
            chrome={chrome}
            onChrome={setChrome}
            widgetReg={widgetReg}
            openTab={tabRequest}
            onDnd={setBoardDrag}
            onEditing={setBoardEditing}
          />
        }
        onSettings={openSettings}
        onCommandPalette={() => setPaletteOpen(true)}
        onRoutes={openRoutes}
        onNotices={noticesToMariners.list.show}
        onBuddies={buddies.list.show}
        onMarks={marks.list.show}
        activeMode={modes.active}
        onMode={modes.toggle}
        onLayers={() => setLayersOpen(true)}
        layersOpen={layersOpen}
        cpaMode={cpaMode.mode}
        onCpaMode={cpaMode.setMode}
        palette={() => settings().palette}
        onPalette={(palette) => setSettings((s) => ({ ...s, palette }))}
      />

      <LayersPanel
        open={layersOpen()}
        onOpenChange={setLayersOpen}
        reg={settingsReg}
        settings={settings}
        onSettings={(patch) => setSettings((s) => ({ ...s, ...patch }))}
        layers={orderedLayers()}
        onReorder={setLayerOrder}
        onMoreSettings={openSettings}
        showGrid={showGrid()}
        onShowGrid={setShowGrid}
      />

      {/* The command palette — over everything, its own dimmed overlay. Ctrl/Cmd-K
          (above) and the rail-foot launcher both open it. */}
      <CommandPalette
        open={paletteOpen()}
        onOpenChange={setPaletteOpen}
        commands={paletteCommands(commands().commands)}
        onCoordinate={setGotoTarget}
      />

      {/* The search overlay — Ctrl/Cmd-F (above) and the palette's "Search"
          entry both open it. */}
      <SearchPanel
        open={searchOpen()}
        onOpenChange={(o) => {
          setSearchOpen(o);
          // Closed without a pick (Escape/backdrop) — a later plain search
          // must not inherit a plugin's pick. A pick itself already resets
          // this in `onSelect` below, before this fires.
          if (!o) setSearchPick(null);
        }}
        providers={searchProviders}
        toInfoHit={searchResultToHit}
        center={mapCenter()}
        pinned={searchPick()?.pinned?.() ?? []}
        onSelect={(r) => {
          const pick = searchPick();
          if (pick) {
            setSearchPick(null);
            pick.onSelect(r);
            return;
          }
          const hit = searchResultToHit(r);
          if (hit) {
            // Selecting into the info panel already moves the camera to
            // reveal the hit (core/info/marker.ts `createInfoMarker`'s warp
            // effect fires on every selection, search included) — a second
            // `gotoTarget` move here would race it and drop a redundant pin
            // on top of the info marker.
            setInfoHitRequest([hit]);
          } else if (r.lat !== null && r.lon !== null) {
            // No info provider for this source yet — the plain go-to pin is
            // the only thing that can show where it is.
            setGotoTarget({ lng: r.lon, lat: r.lat });
          }
        }}
      />
    </div>
  );
};

export default App;
