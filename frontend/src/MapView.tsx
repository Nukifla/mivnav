import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
  type Accessor,
  type Component,
  type JSX,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import maplibregl from "maplibre-gl";
import LocateFixed from "lucide-solid/icons/locate-fixed";
import Layers from "lucide-solid/icons/layers";
import SearchIcon from "lucide-solid/icons/search";
import Maximize from "lucide-solid/icons/maximize";
import Minimize from "lucide-solid/icons/minimize";
import type { LucideIcon } from "lucide-solid";
import { createFullscreen } from "./core/fullscreen";
import { modeIcon } from "./core/chrome/modeIcons";
import { createHoldToFire } from "./core/autopilot";
import type { ChartSet } from "./core/catalog";
import { drawingStatus, tileFault, tilesStalled, type TileTally } from "./core/splash";
import { chartEpoch, registerChartProtocol } from "./core/chartProtocol";
import { scaminBias } from "./core/serverConfig";
import type { GotoTarget } from "./core/chrome/commands";
import type { CursorModel } from "./core/chrome/cursor";
import type { MeasureModel } from "./features/measure";
import type { RegionDrawModel } from "./features/region-draw";
import type { ModeState } from "./core/chrome/modes";
import { attachInfoPanel } from "./core/info/attach";
import type { InfoState } from "./core/info/state";
import { warpToReveal } from "./core/info/marker";
import { measureObscured } from "./core/chrome/Sheet";
import { MapMarker } from "./core/map/MapMarker";
import { scopedQuery } from "./core/info/queryGuard";
import type { InfoAction, InfoHit, InfoPoint, InfoProvider } from "./core/info/types";
import type { AisVessel } from "./core/info/vessel";
import { createInitialView, DEFAULT_ZOOM } from "./core/initialView";
import { isCompact, prefersReducedMotion } from "./core/media";
import { ScaleBadgeControl } from "./core/map/scaleBadge";
import { FpsCounter } from "./core/map/FpsCounter"; // TEMPORARY dev perf tool — remove me
import { attachRouteDragging } from "./features/route/overlay";
import type { RouteOverlay } from "./features/route";
import { HELM, isModeHidden, type Density, type Registry } from "./core/chrome/registry";
import {
  SectorLightLayer,
  SECTOR_LIGHTS_LAYER_ID,
  createSectorLightsOverlay,
} from "./features/sector-lights";
import { sectorOverlayBeforeId } from "./core/style/sectorGate";
import {
  aisOverlay,
  ownShipOverlay,
  ensureOverlays as ensureOverlayLayers,
  wireOverlays,
  type Overlay,
  type OverlayCtx,
} from "./core/layers/overlay";
import { applyMapLayerOrder, encGroupLayerIds } from "./core/layers/mapLayerOrder";
import type { EncGroupId } from "./core/style/encGroups";
import type { SignalKState } from "./core/signalk";
import { buildStyle } from "./core/style/chartStyle";
import { installAtonIconLoader } from "./core/style/atonIcons";
import { ensureNodataPattern, NODATA_PATTERN_ID } from "./core/style/nodataPattern";
import { TEXT_FONT } from "./core/style/expr";
import {
  boundsContain,
  graticuleLabels,
  graticuleLines,
  gridStep,
  gridValues,
  padBounds,
  type GridBounds,
} from "./core/graticule";
import {
  DEBUG_CELL,
  DEBUG_CELL_HALO,
  GRID_HALO,
  GRID_LABEL,
  GRID_LINE,
  iconRoleColors,
  markerMagenta,
  overlayColors,
  paletteColors,
} from "./core/style/colors";
import type { ChartSettings } from "./core/style/settings";
import { CrosshairMarker } from "./core/map/CrosshairMarker";
import { createFollowMoveGate, followMayRecentre, type FollowMoveEvent } from "./core/followGate";
import { trackUserGestures, userGestureActive } from "./core/map/userGesture";
import type { ChartKeyNav } from "./core/map/keyNav";
import { pluginBandOverlayIds, type PluginMapAttachment } from "./plugins";

const METERS_PER_NM = 1852;
const SCALE_MAX_WIDTH = 100; // px, matching MapLibre's ScaleControl default

/** Largest "pretty" value <= num (1/2/3/5/10 × 10^n), as MapLibre rounds scales. */
function roundScale(num: number): number {
  const pow10 = Math.pow(10, `${Math.floor(num)}`.length - 1);
  const d = num / pow10;
  if (d >= 10) return pow10 * 10;
  if (d >= 5) return pow10 * 5;
  if (d >= 3) return pow10 * 3;
  if (d >= 2) return pow10 * 2;
  if (d >= 1) return pow10;
  const decimals = Math.pow(10, Math.ceil(-Math.log(d) / Math.LN10));
  return (pow10 * Math.round(d * decimals)) / decimals;
}

/**
 * Scale bar reading nautical miles, or metres below 1 nm — MapLibre's
 * ScaleControl can't, its metric mode reads km above 1000m (would show "1 km"
 * in the 1000-1852m band). Reuses ScaleControl's CSS classes to look native.
 */
class NauticalScaleControl implements maplibregl.IControl {
  private map!: maplibregl.Map;
  private container!: HTMLElement;

  getDefaultPosition(): maplibregl.ControlPosition {
    return "bottom-left";
  }

  onAdd(map: maplibregl.Map) {
    this.map = map;
    this.container = document.createElement("div");
    this.container.className = "maplibregl-ctrl maplibregl-ctrl-scale";
    map.on("move", this.update);
    this.update();
    return this.container;
  }

  onRemove() {
    this.map.off("move", this.update);
    this.container.remove();
  }

  private readonly update = () => {
    const el = this.map.getContainer();
    const y = el.clientHeight / 2;
    const x = el.clientWidth / 2;
    const meters = this.map
      .unproject([x - SCALE_MAX_WIDTH / 2, y])
      .distanceTo(this.map.unproject([x + SCALE_MAX_WIDTH / 2, y]));
    const nm = meters / METERS_PER_NM;
    const [span, unit] = nm >= 1 ? [nm, "nm"] : [meters, "m"];
    const value = roundScale(span);
    // The bar shows a rounded distance, so it shrinks to keep px ∝ distance.
    this.container.style.width = `${SCALE_MAX_WIDTH * (value / span)}px`;
    this.container.textContent = `${value} ${unit}`;
  };
}

interface MapViewProps {
  /** Every chart set the catalog knows about — no longer pre-filtered to
   * enabled-only (#snyzntrn); see `disabledSets`. */
  sets: Accessor<ChartSet[]>;
  /** Set ids the mariner turned off. An "ocharts" set has no source of its
   * own (server composites all subscriptions into one `chart-all` tile), so
   * it stays IN `sets` and is excluded via a client-side layer filter instead. */
  disabledSets: Accessor<string[]>;
  /** Live zoom range for the OSM basemap (`/api/osm_world/catalog`), fed to
   * `buildStyle` so minzoom/maxzoom track what was actually baked (jt
   * xqoyqxou) instead of a static guess. */
  osmWorldMinZoom: Accessor<number>;
  osmWorldMaxZoom: Accessor<number>;
  /** `free` while this screen may not show licensed o-charts sets — see
   * core/ochartsDevice.ts. Absent means `all`. */
  ochartsUnion?: Accessor<"all" | "free">;
  settings: Accessor<ChartSettings>;
  signalk: SignalKState;
  debugLayers: Accessor<boolean>;
  /** "Tile boundaries" device toggle — the maplibre tile-boundary grid. */
  debugTiles: Accessor<boolean>;
  /** "Cell coverage" device toggle — outlines each o-charts cell (GET
   * /api/debug/cells) so a detail seam reads as a cell boundary. */
  debugCells: Accessor<boolean>;
  /** "FPS counter" device toggle. See FpsCounter.tsx. */
  fpsDebug: Accessor<boolean>;
  /** "Lat/long grid" overlay toggle (core/graticule.ts). */
  showGrid: Accessor<boolean>;
  /** Chart modes (`chrome/modes.ts`). With one set, a click hits the active
   * mode before the info probe — invariant #9. Omitted, every click probes. */
  modes?: ModeState;
  /** Measure overlay's data. Layers install regardless — an empty source is
   * free, and a conditional layer would go missing on the load that needs it. */
  measure?: MeasureModel;
  /** Region-draw overlay's data (kolmnrsk) — the "Draw on map" box preview.
   * Same posture as `measure`: layers install regardless, hover feeds only
   * while its mode is active. */
  regionDraw?: RegionDrawModel;
  /** Where the pointer is. This file is the only thing that knows. */
  cursor?: CursorModel;
  /** Route overlay's data — line, stop handles, bends. Layers install
   * regardless; drag wiring attaches only when a model is given. */
  route?: RouteOverlay;
  /** Tap tolerance in screen px, live. `chrome/modes.ts` `tapRadius(pointerCoarse)`. */
  tapRadius?: Accessor<number>;
  /** Display density (a SETTING, not a breakpoint) — sizes drawn route
   * handles. Defaults to `HELM`. */
  density?: Accessor<Density>;
  /** Programmatic go-to (command palette). A signal, not a raw map handle:
   * the move reuses `createInitialView`'s camera path, and each non-null
   * value is a FRESH object so re-selecting the same coordinate still fires. */
  goto?: Accessor<GotoTarget | null>;
  /** Programmatic "select this" for the info panel (search results). Each
   * non-null, freshly-built `InfoHit[]` opens the panel via the same `show()`
   * a map tap uses (captured below). `null` is idle; no self-clear, unlike `goto`. */
  showInfoHits?: Accessor<InfoHit[] | null>;
  /** Programmatic "centre on boat". A counter (not boolean) App bumps, so a
   * repeat command re-centres after a manual pan; drives the SAME
   * `centreBoat()` the on-screen button uses. Initial bump skipped (`defer`). */
  centre?: Accessor<number>;
  /** True once the chart catalog has settled: it arrived, or the server said
   * there is none. A failed fetch is NOT settled — App holds the splash on it
   * and readiness waits for the retry. Gates `onReady`; absent = settled. */
  chartsSettled?: Accessor<boolean>;
  /** Fired ONCE when the map is ready to navigate by: loaded, catalog
   * settled, and the first `idle` after that — style applied, every visible
   * tile fetched and drawn. App takes the boot splash down on it. */
  onReady?: () => void;
  /** What boot is waiting on, for the splash while `onReady` hasn't fired:
   * the map starting up, which tiled sources are still drawing, tile
   * failures. App passes core/splash.ts `setSplashStatus`. */
  onBootStatus?: (text: string, detail?: string) => void;
  /** Boot failed rather than slowed: tiles came back failed, or none came.
   * Fired instead of `onReady`, which can still follow if tiles turn up. */
  onBootFault?: (text: string, detail: string) => void;
  /** "Go here": route the boat to a point and follow it — the route
   * planner's `goTo` when one is registered (core/routePlanner.ts), else the
   * straight-line `goStraight`; `canGoHere` gates it on a fix. */
  goHere?: (to: InfoPoint, label?: string) => void;
  canGoHere?: Accessor<boolean>;
  /** Is a route currently FOLLOWED? So "Go here" confirms (two-tap) before
   * replacing the followed passage. */
  isFollowing?: Accessor<boolean>;
  /** Keyboard chart navigation (arrows pan, +/- zoom): App owns the key
   * routing, this component binds the map to it. core/map/keyNav.ts. */
  keyNav?: ChartKeyNav;
  /** Enter the measure tool anchored at a pressed point. Needs no fix — it
   * measures point→point, not from the boat. */
  measureFrom?: (from: InfoPoint) => void;
  /** Drop a new mark at a pressed point (it opens its own panel). */
  addMark?: (at: InfoPoint) => void;
  /** Start the manual route editor with a pressed (open-water) point as point 1. */
  newRouteFrom?: (at: InfoPoint) => void;
  /** Plugins' map wiring (`PluginInstance.attachMap`, src/plugins.ts), run
   * once the map exists. */
  pluginMaps?: readonly ((map: maplibregl.Map) => PluginMapAttachment | void)[];
  /** FEATURE overlays (C4, `chrome/feature.ts`). Merged after `baseOverlays`;
   * z-order comes from each overlay's own `z` (layers/overlay.ts), not array
   * position. */
  overlays?: readonly Overlay[];
  /** Persisted MAP-LAYER STACK ORDER (`layers/mapLayerOrder.ts`) — reorderable
   * band ids bottom→top, or `null` for default. Applied below the safety
   * z-hoist so AIS/route/measure/own-ship stay on top — a reorder can never bury a vessel. */
  bandOrder?: Accessor<string[] | null>;
  /** FEATURE info-at-point providers (C4, `chrome/feature.ts`). Passed to
   * `attachInfoPanel` as `opts.providers`, slotting between the built-in
   * chart/point sources (which stay inside `info/attach.tsx`). */
  providers?: readonly InfoProvider[];
  /** Extra buttons on a vessel's info panel. */
  vesselActions?: (v: AisVessel) => readonly InfoAction[];
  /** Swap the global wind unit (m/s ⇄ kn). Wired to the wind readouts, which
   * are tap-to-swap. */
  onToggleWindUnit?: () => void;
  /** Chrome registry, used ONLY to enumerate chart-mode tools (`reg.modes`)
   * for the PHONE tool stack. Absent → no tool stack. Toggling routes through
   * `props.modes`, so this is read-only enumeration. */
  reg?: Registry;
  /** Open the Layers quick-panel. App owns the open state; this only asks. */
  onLayers?: () => void;
  /** Whether the Layers quick-panel is open — lights its tool-stack button. */
  layersOpen?: Accessor<boolean>;
  /** Open the search overlay — same path Ctrl/Cmd-F and the command palette
   * use. Absent → no Search button. */
  onSearch?: () => void;
  /** Chart's current view centre, reported on every move — App forwards it to
   * the search overlay so a query sorts nearest-first server-side
   * (backend/mivnav/api/search.py). */
  onCenterChange?: (c: InfoPoint) => void;
}

/** How long the go-to marker lingers before it clears itself. */
const GOTO_MARKER_MS = 6000;

/** How long essential tiles may all be missing before boot calls it a fault.
 * Well under SPLASH_MAX_MS, or the cap would dismiss onto the empty map first. */
const TILE_STALL_MS = 10_000;

/** Source types whose tiles gate boot readiness (MapView's `onReady`). */
const TILED_SOURCE_TYPES = new Set(["vector", "raster", "raster-dem"]);

/** Follow-boat recentre timing: a LINEAR ease so maplibre coalesces the fix
 * stream (~1-5 Hz) into one continuous glide instead of pulsing speed on
 * every restart. Reduced motion skips the ease (`setCenter`). Centre only. */
const FOLLOW_EASE_MS = 800;
const FOLLOW_EASING = (t: number) => t;

// A usable coastal-navigation zoom for the one-shot centre action; it zooms in
// to at least this but never out. The continuous follow-hold never touches zoom.
const CENTRE_ZOOM = 14;

/** How far inside the viewport edge the boat must stay for follow to survive
 * a pan — a boat within this margin of any edge is treated as let go, since a
 * lock with no room to move reads as clinging, not following. */
const FOLLOW_EDGE_MARGIN = 24; // px

/** Upper bound on the map's render resolution; see the `pixelRatio` option. */
const MAX_PIXEL_RATIO = 2;
const cappedPixelRatio = () => Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);

/** Follow-boat pan geometry, pure so it's unit-testable without a live map:
 * given the boat's projected screen point and container size, whether it's
 * still in frame and its pixel offset from centre (`[0,0]` = centred). */
export function followFrame(
  point: { x: number; y: number },
  size: { width: number; height: number },
  margin = 0,
): { inFrame: boolean; offset: [number, number] } {
  const inFrame =
    point.x >= margin &&
    point.x <= size.width - margin &&
    point.y >= margin &&
    point.y <= size.height - margin;
  return { inFrame, offset: [point.x - size.width / 2, point.y - size.height / 2] };
}

/** The chart style for the current props. Reactive (reads every input), so
 * `wireMap`'s effect re-applies it on change; also the map's CONSTRUCTOR
 * style, so the first load already has the charts (see MapView's onMount). */
function mapStyle(props: MapViewProps): maplibregl.StyleSpecification {
  return buildStyle(props.sets(), props.settings(), {
    debug: props.debugLayers(),
    // A serving-detail config change bumps this epoch, forcing a new ENC
    // source URL so setStyle(diff) reloads past the URL-keyed cache.
    chartEpoch: chartEpoch(),
    // Boat-wide SCAMIN bias: tracked so the "Chart detail" sliders' save
    // regenerates the style against the server's effective-scamin boundary.
    chartDetail: scaminBias(),
    // #snyzntrn: a disabled o-charts set stays IN `props.sets()` (needed for
    // the union) and is excluded here instead — see `disabledSets`'s prop doc.
    disabledSets: props.disabledSets(),
    osmWorldMinZoom: props.osmWorldMinZoom(),
    osmWorldMaxZoom: props.osmWorldMaxZoom(),
    ochartsUnion: props.ochartsUnion?.(),
  });
}

/**
 * Bind `props` to a live map: every effect and map hook MapView owns.
 *
 * Split out from the component so it can be driven against a Map-shaped test
 * double. Must be called under a reactive owner; the caller owns the map's
 * construction and disposal.
 */
export function wireMap(
  map: maplibregl.Map,
  props: MapViewProps,
  /** JSON of the style the map was CONSTRUCTED with, if it was built with
   * `mapStyle(props)`: the first post-`load` apply then skips an identical
   * re-apply, which is not free (maplibre serialises + validates + diffs). */
  constructedStyle?: string,
): PluginMapAttachment[] {
  const [loaded, setLoaded] = createSignal(false);
  // Filled once the base wiring below is in place (see the end of this
  // function); `resolveLayerIds` reads it lazily.
  const pluginAttachments: PluginMapAttachment[] = [];

  // Permanently north-up: a rotated chart misreads bearings, so rotation is
  // disabled everywhere. Pinch-zoom survives — only its rotation half drops.
  map.dragRotate.disable();
  map.touchZoomRotate.disableRotation();
  // MapLibre's keyboard handler is OFF altogether, which takes its
  // Shift-arrow rotate/pitch with it. Arrow-key pan and +/- zoom are ours
  // (core/map/keyNav.ts): MapLibre's only hears a focused canvas, and
  // follow-boat undid its pans.
  map.keyboard.disable();

  // Point symbols are fetched/registered on demand; the style declares no
  // `sprite:` at all, making this loader authoritative rather than a fallback
  // (core/style/atonIcons.ts). Installed before any style loads.
  const atonIcons = installAtonIconLoader(map, { iconColors: iconRoleColors(props.settings().palette) });
  // Icon ids are palette-neutral, so a theme switch changes no `icon-image` and
  // `setStyle(diff)` keeps stale-coloured images unless this re-pushes them.
  createEffect(() => {
    void atonIcons.refresh(iconRoleColors(props.settings().palette));
  });

  // The style's one fill pattern (AP(NODATA03) over UNSARE) — the other half of
  // dropping `sprite:`. Registered on `style.load` (not `styleimagemissing`) so
  // it's always there before the UNSARE fill asks for it.
  const nodataInk = () => paletteColors(props.settings().palette).CHGRD;
  map.on("style.load", () => ensureNodataPattern(map, nodataInk()));
  createEffect(() => {
    if (map.hasImage(NODATA_PATTERN_ID)) ensureNodataPattern(map, nodataInk());
  });

  // Dynamic overlays live outside the generated style: the sector-arc custom
  // layer can't be JSON, and live GeoJSON must not be diffed away on setStyle.
  const sectorLayer = new SectorLightLayer();

  const overlayCtx: OverlayCtx = {
    settings: props.settings,
    signalk: props.signalk,
    density: () => props.density?.() ?? HELM,
  };
  // measure/route stay off the ctx (those overlays close over their own
  // model) but stay as props for the map-coupled hooks below (hover, stop-pin
  // drag).

  // FEATURE overlays (route, measure, `props.overlays`, C4) merge after BASE
  // overlays here, but final stacking is each overlay's own `z`
  // (layers/overlay.ts) — SAFETY-CRITICAL z invariants live there, untouched.
  const baseOverlays: readonly Overlay[] = [
    createSectorLightsOverlay(sectorLayer),
    aisOverlay,
    ownShipOverlay,
  ];
  const overlays: readonly Overlay[] = [...baseOverlays, ...(props.overlays ?? [])];

  // untrack is load-bearing (boat/AIS flash bug) and "sector-lights"/"track"
  // band membership is deliberate (#sonqwmry) — see
  // docs/architecture/mapview-layer-reorder.md.
  const BAND_OVERLAY_IDS = new Set([
    "satellite",
    "poi",
    ...pluginBandOverlayIds(),
    "sector-lights",
    "notices",
    "track",
  ]);
  const fixedOverlays = () => {
    const band = new Set([...BAND_OVERLAY_IDS, ...(props.bandOrder?.() ?? [])]);
    return overlays.filter((o) => !band.has(o.id));
  };
  // A band id → its live maplibre layer ids. "enc:aids" also carries the
  // sector-lights custom layer, and a plugin's overlay whatever extra layers
  // it names (`bandLayerIds`) — appended last so a drag moves them together.
  const resolveLayerIds = (id: string): string[] => {
    if (id.startsWith("enc:")) {
      const ids = encGroupLayerIds(map, id.slice(4) as EncGroupId);
      if (id === "enc:aids" && map.getLayer?.(SECTOR_LIGHTS_LAYER_ID)) {
        ids.push(SECTOR_LIGHTS_LAYER_ID);
      }
      return ids;
    }
    if (id === "openseamap") return map.getLayer?.("openseamap") ? ["openseamap"] : [];
    const ov = overlays.find((o) => o.id === id);
    const ids = ov ? [...ov.layerIds] : [];
    for (const a of pluginAttachments) {
      for (const lid of a.bandLayerIds?.(id) ?? []) if (map.getLayer?.(lid)) ids.push(lid);
    }
    return ids;
  };
  // The anchor: the lowest fixed overlay layer present — the band is placed
  // just beneath it, keeping the fixed safety overlays on top.
  const anchorId = (): string | undefined => {
    const ids = [...fixedOverlays()]
      .sort((a, b) => a.z - b.z)
      .flatMap((o) => [...o.layerIds]);
    return ids.find((lid) => !!map.getLayer?.(lid));
  };
  const applyBandOrder = () =>
    untrack(() => {
      const order = props.bandOrder?.();
      if (!order || !loaded()) return;
      applyMapLayerOrder(map, order, resolveLayerIds, anchorId());
    });
  const seatSectorLights = () =>
    untrack(() => {
      if (!map.getLayer?.(SECTOR_LIGHTS_LAYER_ID)) return;
      const before = sectorOverlayBeforeId(
        (map.getStyle?.()?.layers ?? []).map((l) => l.id),
        encGroupLayerIds(map, "aids"),
        [SECTOR_LIGHTS_LAYER_ID],
      );
      if (before) map.moveLayer(SECTOR_LIGHTS_LAYER_ID, before);
      else map.moveLayer(SECTOR_LIGHTS_LAYER_ID);
    });

  const ensureOverlays = () =>
    untrack(() => {
      ensureOverlayLayers(map, overlays, overlayCtx);
      // Re-apply the band order below the re-seated fixed overlays (a no-op in
      // default order), then drop the sector arcs back onto their ENC group.
      applyBandOrder();
      seatSectorLights();
    });
  map.on("style.load", () => {
    if (loaded()) ensureOverlays();
  });

  map.on("load", () => {
    setLoaded(true);
    ensureOverlays();
  });

  // Re-apply when the persisted order changes (the panel's drag).
  createEffect(() => {
    props.bandOrder?.();
    if (loaded()) {
      applyBandOrder();
      seatSectorLights();
    }
  });

  // Opening view: the boat if it has a fix, the catalog otherwise (initialView.ts).
  // A memo, not a bare accessor: a plain accessor would hand `createInitialView`
  // a fresh array identity on every tick even when filtered contents are unchanged.
  const visibleSets = createMemo(() =>
    props.sets().filter((s) => !props.disabledSets().includes(s.id)),
  );
  createInitialView(map, { loaded, sets: visibleSets, self: props.signalk.self });

  // Imperative overlays (a plugin's wash) are NOT part of this style. Skip
  // when content-equal to the last-applied style: a byte-identical re-emit
  // used to remove+re-add the imperative sources, aborting fetches.
  let lastStyleJson: string | undefined = constructedStyle;
  createEffect(() => {
    const style = mapStyle(props);
    if (!loaded()) return;
    const json = JSON.stringify(style);
    if (json === lastStyleJson) return; // content-equal: an upstream re-emit, not a real change
    lastStyleJson = json;
    map.setStyle(style, { diff: true });
  });

  // maplibre's native `showTileBoundaries`; guarded because the test FakeMap
  // has no such field.
  createEffect(() => {
    const on = props.debugTiles();
    if ("showTileBoundaries" in map) map.showTileBoundaries = on;
  });

  // Outlines every o-charts cell's coverage (GET /api/debug/cells) so a detail
  // seam reads as a cell boundary rather than a tile edge. Added imperatively
  // and re-added on `style.load` so a settings-driven setStyle doesn't drop it.
  // The licensed sets' outlines are o-charts data too (plan W12): the server
  // only sends them to a screen that may see them, and the overlay follows the
  // o-charts union — dropped and re-fetched when it changes, `?free=true` on
  // the free union — so a lost device slot or a lost server
  // (core/ochartsDevice.ts) clears them along with the licensed tiles.
  const CELL_SRC = "debug-cells";
  const CELL_LINE = `${CELL_SRC}-line`;
  const CELL_LABEL = `${CELL_SRC}-label`;
  /** Bumped on every removal: a fetch begun before it must not add its answer. */
  let cellGen = 0;
  const removeCellOverlay = (): void => {
    cellGen++;
    if (typeof map.getLayer !== "function") return;
    for (const id of [CELL_LABEL, CELL_LINE]) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(CELL_SRC)) map.removeSource(CELL_SRC);
  };
  const addCellOverlay = async (): Promise<void> => {
    if (typeof map.addSource !== "function" || map.getSource(CELL_SRC)) return;
    const gen = cellGen;
    const free = props.ochartsUnion?.() === "free";
    let data: unknown;
    try {
      const res = await fetch(`/api/debug/cells${free ? "?free=true" : ""}`, { cache: "no-store" });
      if (!res.ok) return;
      data = await res.json();
    } catch {
      return; // debug aid — a fetch failure just leaves the overlay off
    }
    // Toggled off, or the union changed, mid-fetch.
    if (gen !== cellGen || !props.debugCells() || !loaded() || map.getSource(CELL_SRC)) return;
    map.addSource(CELL_SRC, { type: "geojson", data } as maplibregl.GeoJSONSourceSpecification);
    map.addLayer({
      id: CELL_LINE,
      type: "line",
      source: CELL_SRC,
      paint: { "line-color": DEBUG_CELL, "line-width": 1.5, "line-opacity": 0.9, "line-dasharray": [2, 2] },
    });
    map.addLayer({
      id: CELL_LABEL,
      type: "symbol",
      source: CELL_SRC,
      layout: {
        "symbol-placement": "line-center",
        "text-field": ["get", "label"],
        "text-font": TEXT_FONT,
        "text-size": 11,
        "text-max-angle": 90,
      },
      paint: { "text-color": DEBUG_CELL, "text-halo-color": DEBUG_CELL_HALO, "text-halo-width": 1.5 },
    });
  };
  createEffect(() => {
    props.ochartsUnion?.(); // tracked: a union change re-fetches (see above)
    removeCellOverlay();
    if (props.debugCells() && loaded()) void addCellOverlay();
  });
  map.on("style.load", () => {
    // setStyle drops non-style layers; re-add if the overlay is on.
    if (loaded() && props.debugCells()) void addCellOverlay();
  });

  // Lat/long graticule (core/graticule.ts). TWO SOURCES ON TWO CLOCKS: LINES
  // are built for a PADDED envelope, refreshed on every `move` (cheap guard,
  // no leading-edge gap); LABELS ride the view's edges, refreshed on `moveend`.
  const GRID_SRC = "graticule";
  const GRID_LABEL_SRC = "graticule-labels";
  const GRID_LINE_LAYER = `${GRID_SRC}-line`;
  const GRID_LABEL_LAYER = `${GRID_SRC}-label`;
  /** View-spans of slack around the built line set. Bigger = rarer rebuilds,
   * more off-screen lines. */
  const GRID_PAD = 1;
  /** What the line source currently holds, for the change-detection guard. */
  let gridBuilt: { step: number; envelope: GridBounds } | undefined;
  const removeGrid = (): void => {
    if (typeof map.getLayer !== "function") return;
    for (const id of [GRID_LABEL_LAYER, GRID_LINE_LAYER]) if (map.getLayer(id)) map.removeLayer(id);
    for (const id of [GRID_LABEL_SRC, GRID_SRC]) if (map.getSource(id)) map.removeSource(id);
    gridBuilt = undefined;
  };
  const gridView = (): GridBounds => {
    const b = map.getBounds();
    return { west: b.getWest(), east: b.getEast(), south: b.getSouth(), north: b.getNorth() };
  };
  /** The line geometry for a view, and the envelope it stays valid over. */
  const gridLineData = (view: GridBounds, step: number) => {
    const envelope = padBounds(view, GRID_PAD);
    gridBuilt = { step, envelope };
    return graticuleLines(gridValues(envelope, step));
  };
  const gridLabelData = (view: GridBounds, step: number) => graticuleLabels(view, step);
  /** `move`: push new lines only when the view has left the envelope they were
   * built for, or the zoom has crossed into a different step. */
  const refreshGridLines = (): void => {
    if (!props.showGrid() || !loaded()) return;
    const src = map.getSource(GRID_SRC) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    const view = gridView();
    const step = gridStep(Math.abs(view.east - view.west));
    if (gridBuilt && gridBuilt.step === step && boundsContain(gridBuilt.envelope, view)) return;
    src.setData(gridLineData(view, step) as GeoJSON.FeatureCollection);
  };
  /** `moveend`: the labels ride the view's edges, so they follow the bounds. */
  const refreshGridLabels = (): void => {
    if (!props.showGrid() || !loaded()) return;
    const src = map.getSource(GRID_LABEL_SRC) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    const view = gridView();
    src.setData(gridLabelData(view, gridStep(Math.abs(view.east - view.west))) as GeoJSON.FeatureCollection);
  };
  const addGrid = (): void => {
    if (typeof map.getBounds !== "function" || typeof map.addSource !== "function") return;
    if (map.getSource(GRID_SRC)) return;
    const view = gridView();
    const step = gridStep(Math.abs(view.east - view.west));
    map.addSource(GRID_SRC, {
      type: "geojson",
      data: gridLineData(view, step),
    } as maplibregl.GeoJSONSourceSpecification);
    map.addSource(GRID_LABEL_SRC, {
      type: "geojson",
      data: gridLabelData(view, step),
    } as maplibregl.GeoJSONSourceSpecification);
    map.addLayer({
      id: GRID_LINE_LAYER,
      type: "line",
      source: GRID_SRC,
      paint: { "line-color": GRID_LINE, "line-width": 0.75 },
    });
    map.addLayer({
      id: GRID_LABEL_LAYER,
      type: "symbol",
      source: GRID_LABEL_SRC,
      layout: {
        "text-field": ["get", "label"],
        "text-font": TEXT_FONT,
        "text-size": 10,
        // Meridian labels hang below the north edge; parallel labels sit inboard
        // of the west edge — so each rides its own line without stacking.
        "text-anchor": ["match", ["get", "kind"], "meridian", "top", "left"],
        "text-offset": ["match", ["get", "kind"], "meridian", ["literal", [0, 0.3]], ["literal", [0.3, 0]]],
        "text-allow-overlap": false,
        "text-ignore-placement": false,
      },
      paint: { "text-color": GRID_LABEL, "text-halo-color": GRID_HALO, "text-halo-width": 1.5 },
    });
  };
  createEffect(() => {
    if (props.showGrid() && loaded()) addGrid();
    else removeGrid();
  });
  const onGridMove = () => refreshGridLines();
  const onGridMoveEnd = () => {
    refreshGridLines();
    refreshGridLabels();
  };
  map.on("move", onGridMove);
  map.on("moveend", onGridMoveEnd);
  map.on("style.load", () => {
    if (loaded() && props.showGrid()) addGrid();
  });
  onCleanup(() => {
    map.off("move", onGridMove);
    map.off("moveend", onGridMoveEnd);
  });

  // Every overlay's live upkeep: one `update` effect per overlay, scoped to
  // its own tracked reads (layers/overlay.ts). Always data through setData,
  // never a style rebuild — the rule the flash bug this file exists for depends on.
  wireOverlays(map, overlays, overlayCtx, loaded);

  // Hover: unconditional, not gated on the readout being configured on — a
  // signal write per mousemove is nothing, and gating it here would mean
  // reimplementing the kernel's `desktopOnly` filter. A touch device never fires it.
  const measureActive = () => props.modes?.active() === "measure";
  const regionDrawActive = () => props.modes?.active() === "region-draw";

  if (props.cursor || props.measure || props.regionDraw) {
    const onMove = (e: maplibregl.MapMouseEvent) => {
      const at = { lng: e.lngLat.lng, lat: e.lngLat.lat };
      props.cursor?.set(at);
      // Only in-mode: outside it, feeding the far end would draw a line from
      // the (always-present) boat anchor to the cursor across the whole app.
      if (measureActive()) props.measure?.hover(at);
      if (regionDrawActive()) props.regionDraw?.hover(at);
    };
    const onOut = () => {
      props.cursor?.set(null);
      props.measure?.hover(null);
      props.regionDraw?.hover(null);
    };
    map.on("mousemove", onMove);
    map.on("mouseout", onOut);
    onCleanup(() => {
      map.off("mousemove", onMove);
      map.off("mouseout", onOut);
    });
  }

  // Touch: tap-to-place, scroll-if-hidden. A phone cannot hover, so a tap
  // PLACES the point (mode's `onClick`), and the view SCROLLS only if it's
  // hidden behind the sheet/nav band (`warpToReveal`, gated on `isCompact`).
  if (props.measure) {
    const measure = props.measure;
    // Clear the rubber-band far end when the mode closes: a desktop
    // `mouseout` may never fire, leaving a stale line to nowhere.
    createEffect(() => {
      if (!measureActive()) measure.hover(null);
    });
    createEffect(
      on(
        () => measure.b(),
        (p) => {
          if (!p || !isCompact()) return;
          warpToReveal(map, p, measureObscured(map.getContainer()));
        },
      ),
    );
  }

  if (props.regionDraw) {
    const regionDraw = props.regionDraw;
    // Same reasoning as measure's reset above: a stale hover would leave a
    // phantom preview rectangle for the NEXT time this mode opens.
    createEffect(() => {
      if (!regionDrawActive()) regionDraw.hover(null);
    });
  }

  // In a mode the chart is an input surface. Set on the canvas directly
  // because MapLibre only writes cursor during a drag/hover — there's no API
  // for "the resting cursor".
  createEffect(() => {
    const active = !!props.modes?.active();
    const canvas = map.getCanvas?.();
    if (canvas) canvas.style.cursor = active ? "crosshair" : "";
  });

  // Plugins' own map wiring (src/plugins.ts), under this same owner.
  for (const attach of props.pluginMaps ?? []) {
    const attachment = attach(map);
    if (attachment) pluginAttachments.push(attachment);
  }
  // A plugin's custom layer may have been added after the band order was
  // applied on `load`; re-seat once now.
  if (loaded() && pluginAttachments.length) applyBandOrder();
  return pluginAttachments;
}

// Transparent map-control treatment (no solid FAB fill): a chrome-coloured
// halo keeps the icon legible over any chart (chrome is white by day, near-
// black at night, so the halo is always the icon's opposite tone).
const MAP_CTRL_BASE =
  "focus-ring pointer-events-auto grid size-10 place-items-center rounded-full bg-transparent transition-colors disabled:opacity-50 pointer-coarse:size-11";
const MAP_CTRL_HALO =
  "drop-shadow(0 0 1.5px var(--color-chrome)) drop-shadow(0 0 3px var(--color-chrome))";

/** One phone map-control tool button — a chart-mode tool, or Layers. Circular,
 * FAB-sized, transparent with the shared halo; accent-tinted when active. */
const MapToolButton: Component<{
  icon: LucideIcon;
  label: string;
  active: boolean;
  onClick: () => void;
}> = (props) => (
  <button
    type="button"
    aria-label={props.label}
    aria-pressed={props.active}
    title={props.label}
    onClick={props.onClick}
    class={`${MAP_CTRL_BASE} ${props.active ? "text-accent" : "text-fg hover:text-accent"}`}
    style={{ filter: MAP_CTRL_HALO }}
  >
    <Dynamic component={props.icon} size={20} aria-hidden="true" />
  </button>
);

const MapView: Component<MapViewProps> = (props) => {
  let container!: HTMLDivElement;

  // `attachInfoPanel`'s return, captured in onMount, so `showInfoHits` can
  // drive the SAME `InfoState.show()` a map tap does rather than re-querying
  // the map for a feature that may not even be rendered yet.
  const [infoState, setInfoState] = createSignal<InfoState | undefined>();
  // Dev build, or the "FPS counter" device setting. Remove alongside FpsCounter.tsx.
  const fpsDebugEnabled = () => import.meta.env.DEV || props.fpsDebug();
  // Chart-mode tools for the PHONE stack, enumerated from the registry (never
  // hardcoded) so a feature's mode gets a button for free. `hidden` modes
  // (region-draw, reachable only from Settings, kolmnrsk) are excluded here
  // but still enter/leave/pill through `modes` normally.
  const modeList = () => (props.reg ? [...props.reg.modes.values()].filter((m) => !isModeHidden(m)) : []);
  const overlay = () => overlayColors(props.settings().palette);
  // Follow/centre controls stay mounted-but-disabled without a fix (mirroring
  // HitCarousel's "Go here") rather than vanishing with no explanation.
  const hasFix = () => !!props.signalk.self();

  // Transient go-to pin's live point. Set by the goto effect (onMount, which
  // also drives the camera and self-remove timer).
  const [gotoShown, setGotoShown] = createSignal<{ lng: number; lat: number } | null>(null);

  // Follow-boat: PERSISTENT active state; off-screen it PAUSES and
  // AUTO-RESUMES on re-entry, a pan never disengages it. Default ON (user
  // request): the boat is what you want on screen at open. A fresh open with
  // the boat off-screen just starts paused, so it still can't yank the view.
  const [followActive, setFollowActive] = createSignal(true);
  // `buttonVisible()` hides it on iOS (no Fullscreen API) and an installed
  // Android PWA (manifest already forces fullscreen).
  const fullscreen = createFullscreen();
  // Boat's target pixel offset from container centre while following,
  // `[dx, dy]`; `[0,0]` = centred. Down is +y (MapLibre screen coordinates).
  const [followOffset, setFollowOffset] = createSignal<[number, number]>([0, 0]);
  // Set in onMount — the follow handlers need the real map; `wireMap`'s
  // FakeMap has none of this.
  let mapRef: maplibregl.Map | undefined;
  // The follow gate's `cancel`, also set in onMount (`centreBoat` is defined
  // before the gate exists).
  let cancelCrewMove = () => {};
  // The same map as a SIGNAL, so JSX pinned markers can render the moment the
  // map exists. Kept apart from `mapRef` because reading that from JSX isn't reactive.
  const [readyMap, setReadyMap] = createSignal<maplibregl.Map>();
  // Plugins' map chrome, from `wireMap`'s attachments.
  const [pluginViews, setPluginViews] = createSignal<(() => JSX.Element)[]>([]);

  // Follow geometry against the LIVE map: where the boat projects on screen
  // and whether it's inside the margin-inset frame. ONE definition shared by
  // the pause gate, pan-end re-snap and desktop activate, so "on-screen"
  // means the same thing everywhere.
  const projectBoat = (): { inFrame: boolean; offset: [number, number] } | null => {
    const boat = props.signalk.self();
    const m = mapRef;
    if (!boat || !m) return null;
    const el = m.getContainer();
    return followFrame(
      m.project([boat.lng, boat.lat]),
      { width: el.clientWidth, height: el.clientHeight },
      FOLLOW_EDGE_MARGIN,
    );
  };

  // One-shot ease to centre with the offset reset, tagged AUTO so the pan-end
  // handler never reads it as the crew panning. Desktop Centre button and the
  // phone tap's centre half; if follow IS active, the reset offset makes it
  // hold the boat centred from here on.
  const centreBoat = () => {
    const boat = props.signalk.self();
    const m = mapRef;
    if (!boat || !m) return;
    cancelCrewMove();
    setFollowOffset([0, 0]);
    m.easeTo(
      {
        center: [boat.lng, boat.lat],
        // Zoom IN to a usable level, never out — unlike the continuous
        // follow-hold recentre, this one-shot centre adjusts zoom.
        zoom: Math.max(m.getZoom(), CENTRE_ZOOM),
        offset: [0, 0],
        duration: prefersReducedMotion() ? 0 : FOLLOW_EASE_MS,
        easing: FOLLOW_EASING,
      },
      { mivnavAuto: true },
    );
  };

  // Follow button gesture split (phone AND desktop): TAP activates+centres, HOLD past the threshold
  // DEACTIVATES — friction so a thumb-brush can't drop the lock. Reused from
  // the autopilot's hold-to-engage, same abort/fire shape.
  const releaseHold = createHoldToFire({
    durationMs: 500,
    onFire: () => setFollowActive(false),
  });
  onCleanup(() => releaseHold.dispose());
  const followTap = () => {
    setFollowActive(true);
    centreBoat();
  };

  onMount(() => {
    registerChartProtocol();
    // MapLibre defaults to ONE worker outside Safari, so a desktop viewport
    // (~20 z7 tiles per source, up to 3.3 MB unpacked each) decodes in series
    // and starves the main thread. Measured on the real sets at 1924x1354,
    // z7: 32 s with 1 worker, 13.5 s with 3, 14.8 s with 6 — 3 is the knee.
    // Must run before the first Map: the pool sizes itself on first use.
    maplibregl.setWorkerCount(3);

    const initialStyle = untrack(() => mapStyle(props));
    // Stringified BEFORE maplibre gets the object (it may normalise it).
    const initialStyleJson = JSON.stringify(initialStyle);
    const map = new maplibregl.Map({
      container,
      // The FULL style, charts included (the catalog is prefetched before
      // first render — core/catalog.ts `prefetchCatalog`). Constructing bare
      // and letting `wireMap` diff the charts in after `load` froze the main
      // thread ~3 s: maplibre's diff adds each layer via `addLayer`, which
      // re-serialises the whole style per layer to validate it (O(n²)).
      // Loaded here it's one pass, and that first diff finds nothing to add.
      style: initialStyle,
      // Only ever seen with no fix AND no charts: the boat or the catalog
      // takes the camera as soon as either can (createInitialView). Øresund
      // because the boat lives there.
      center: [12.6, 55.9],
      zoom: DEFAULT_ZOOM,
      // North-up, always (`wireMap` disables every rotation gesture). Pitch
      // is off for the same reason — a tilted chart misreads bearings.
      bearing: 0,
      attributionControl: false,
      touchPitch: false,
      pitchWithRotate: false,
      // 0 (#ZOOMFPS): a real-device trace showed each tile load restarts a
      // 300ms symbol crossfade, keeping overdrawn parent tiles alive through
      // a continuous zoom.
      fadeDuration: 0,
      // Keep far more decoded tiles around per source. MapLibre sizes its
      // out-of-view tile cache as (tiles across + 1) × (tiles down + 1) ×
      // maxTileCacheZoomLevels (default 5), and with 512px vector tiles a
      // phone screen is only ~2×3 of them — a ~30-tile cache, so a single
      // zoom out-and-back evicts what you just looked at and it is fetched
      // and re-parsed all over again (and the zoomed-out union tiles are
      // the expensive ones: ~400 KB gzipped each at z7). There is no option
      // to raise the count directly — maxTileCacheSize only ever *lowers*
      // the view-derived size (min of the two) — so the multiplier is what
      // grows it, and maxTileCacheSize is the ceiling that keeps a large
      // helm/desktop viewport from holding thousands.
      maxTileCacheZoomLevels: 30,
      maxTileCacheSize: 250,
      // Phones report a device pixel ratio of ~3, so MapLibre drew 9 device
      // pixels per CSS pixel through every chart layer on every frame, on a
      // much weaker GPU than a laptop's — the likely reason panning was
      // slower on a phone. 2 looks the same on a phone screen at under half
      // the fill.
      pixelRatio: cappedPixelRatio(),
    });
    // A fixed pixelRatio no longer follows devicePixelRatio by itself, and
    // that changes at runtime (browser zoom, moving to another monitor) —
    // both fire `resize` on the window.
    const syncPixelRatio = () => {
      const want = cappedPixelRatio();
      if (map.getPixelRatio() !== want) map.setPixelRatio(want);
    };
    window.addEventListener("resize", syncPixelRatio);
    onCleanup(() => window.removeEventListener("resize", syncPixelRatio));
    // No compass control: the chart is permanently north-up. OSM/OpenSeaMap
    // attribution deliberately NOT shown on-map (private on-board deployment;
    // credit lives in Settings > Overlays instead).
    map.addControl(new NauticalScaleControl(), "bottom-left");
    // Overscale — a line of text stacked above the
    // scale bar (core/map/scaleBadge.ts); nothing drawn over the chart.
    const scaleBadge = new ScaleBadgeControl({
      disabledSets: () => props.disabledSets(),
      union: () => props.ochartsUnion?.() ?? "all",
    });
    map.addControl(scaleBadge, "bottom-left");
    createEffect(
      on(
        () => [props.disabledSets(), props.ochartsUnion?.(), props.sets()],
        () => scaleBadge.refresh(),
        { defer: true },
      ),
    );

    // Zoom buttons gated on `isCompact` not `density`: a helm tablet is
    // coarse but wide and keeps them (gloves pinch badly). `showCompass:
    // false` — nothing to reset, the chart is permanently north-up.
    const zoom = new maplibregl.NavigationControl({ showCompass: false });
    createEffect(() => {
      const want = !isCompact();
      if (want && !map.hasControl(zoom)) map.addControl(zoom, "bottom-right");
      else if (!want && map.hasControl(zoom)) map.removeControl(zoom);
    });

    // Follow-boat mode: here (not `wireMap`) because it drives the REAL
    // camera. See docs/architecture/mapview-follow-boat.md for the pause/
    // resume semantics below.
    mapRef = map;
    setReadyMap(map);
    // Who owns the chart while a person touches it (follow recentre and the
    // reveal-warp stand down) — core/map/userGesture.ts.
    onCleanup(trackUserGestures(map));
    // The crew's camera moves — EVERY move that is not our own recentre:
    // pan, any zoom by any input, key, deliberate go-to — from start to end.
    // Each one re-bases the held offset on where it left the boat, so the
    // chart is never glided back to an older spot; only the follow button
    // (`centreBoat`) centres. ("it should not move the map to center the
    // boat if i did not press the button".)
    const crewMove = createFollowMoveGate(() => {
      if (!followActive()) return;
      const frame = projectBoat();
      if (!frame) return;
      if (frame.inFrame) setFollowOffset(frame.offset);
      // else: off-screen — leave paused (do NOT disengage).
    });
    cancelCrewMove = crewMove.cancel;
    const recentre = () => {
      const boat = props.signalk.self();
      const offset = followOffset();
      if (!boat) return;
      const center: [number, number] = [boat.lng, boat.lat];
      // Tagged AUTO so it's never read as the crew panning; centre only, so
      // the crew's zoom is untouched (initialView/goto/info-marker's rule).
      map.easeTo(
        {
          center,
          offset,
          duration: prefersReducedMotion() ? 0 : FOLLOW_EASE_MS,
          easing: FOLLOW_EASING,
        },
        { mivnavAuto: true },
      );
    };
    createEffect(() => {
      if (!followActive()) return;
      followOffset(); // a crew move's re-based offset wakes the follow
      const frame = projectBoat(); // reads self() → re-runs on every fix
      // Stands down for a crew move in flight (pan / zoom / go-to), for
      // fingers on the glass or a held mouse button (an easeTo would CANCEL
      // that gesture — core/map/userGesture.ts), and PAUSES with the boat
      // off-screen (stay active, no move).
      if (
        !followMayRecentre({
          crewMoving: crewMove.moving(),
          userGesture: userGestureActive(map),
          inFrame: frame?.inFrame,
        })
      )
        return;
      recentre();
    });
    const onDragStart = () => crewMove.dragstart();
    const onMoveStart = (e?: FollowMoveEvent) => crewMove.movestart(e);
    const onMoveEnd = (e?: FollowMoveEvent) => crewMove.moveend(e);
    map.on("dragstart", onDragStart);
    map.on("movestart", onMoveStart);
    map.on("moveend", onMoveEnd);
    // Arrow keys pan, +/- zoom (core/map/keyNav.ts). Both are the crew
    // moving the chart, exactly like a drag or a wheel zoom: untagged camera
    // moves, which the follow gate above reads as crew moves — the boat
    // keeps the screen spot the move left it at, or follow pauses if it
    // leaves the frame. The pan yields to a hand already on the chart (a
    // jump would cancel that drag/pinch). The zoom carries `originalEvent`
    // like the zoom buttons, so the gesture tracker holds background moves
    // off for the length of its ease.
    if (props.keyNav)
      onCleanup(
        props.keyNav.bind({
          panBy: (dx, dy) => {
            if (userGestureActive(map)) return;
            map.panBy([dx, dy], { duration: 0 });
          },
          zoomBy: (delta, e) => {
            const eventData = { originalEvent: e };
            if (delta > 0) map.zoomIn({}, eventData);
            else map.zoomOut({}, eventData);
          },
        }),
      );
    // Search overlay's proximity sort (App.tsx): view centre reported on every
    // move, not just `moveend`, so a search fired mid-pan gets a fresh point.
    const onCenterMove = () => props.onCenterChange?.(map.getCenter());
    onCenterMove();
    map.on("move", onCenterMove);
    onCleanup(() => {
      map.off("dragstart", onDragStart);
      map.off("movestart", onMoveStart);
      map.off("moveend", onMoveEnd);
      map.off("move", onCenterMove);
      mapRef = undefined;
      setReadyMap(undefined);
    });

    if (import.meta.env.DEV) (window as { __mivnav?: object }).__mivnav = { map };

    const attachments = wireMap(map, props, initialStyleJson);
    setPluginViews(attachments.flatMap((a) => (a.view ? [a.view] : [])));

    // Boot readiness (see `onReady`). Registered after `wireMap` so its own
    // `load` handler has already applied the catalog's style when this runs.
    const [mapLoaded, setMapLoaded] = createSignal(false);
    map.once("load", () => setMapLoaded(true));
    let readyArmed = false;
    // Tiles that failed during boot (a chart whose decode 503s, a basemap
    // the server can't serve): counted so the splash can say so rather
    // than sit on "Drawing…". MapLibre reports a source done once its
    // tiles are in OR errored, so these never hold the splash up.
    let bootTileErrors = 0;
    let bootTileStatus = "";
    const tally: Record<string, TileTally> = {};
    const tallyOf = (id: string) => (tally[id] ??= { loaded: 0, failed: 0 });
    const onBootError = (e: { sourceId?: string; tile?: unknown; error?: { status?: number } }) => {
      if (!e.sourceId || !e.tile) return;
      bootTileErrors++;
      const status = e.error?.status;
      bootTileStatus = status ? ` (HTTP ${status})` : "";
      const t = tallyOf(e.sourceId);
      t.failed++;
      if (status) t.status = status;
    };
    // Successes, because "N failed" alone can't tell a gap from a dead source.
    const onBootTile = (e: { sourceId?: string; tile?: unknown }) => {
      if (e.sourceId && e.tile) tallyOf(e.sourceId).loaded++;
    };
    map.on("error", onBootError);
    map.on("sourcedata", onBootTile);
    const reportBoot = (text: string, detail = "") => props.onBootStatus?.(text, detail);
    // The tiled-source ids, read only on `styledata`: `getStyle()` deep-clones
    // the whole style, and calling it per render cost ~1.9 s of main thread
    // over a boot.
    let tiled: string[] = [];
    const readSources = () => {
      const sources = map.getStyle()?.sources ?? {};
      tiled = Object.keys(sources).filter((id) => TILED_SOURCE_TYPES.has(sources[id].type));
    };
    map.on("styledata", readSources);
    const pendingSources = () => tiled.filter((id) => !(map.getSource(id) && map.isSourceLoaded(id)));
    const check = () => {
      const pending = pendingSources();
      if (pending.length > 0) {
        const failed = bootTileErrors
          ? `${bootTileErrors} tile${bootTileErrors === 1 ? "" : "s"} failed${bootTileStatus}`
          : "";
        reportBoot(drawingStatus(pending), failed);
        return;
      }
      const fault = tileFault(tally);
      if (fault) props.onBootFault?.(fault.text, fault.detail);
      else {
        stop();
        props.onReady?.();
      }
    };
    // Not on `load` or `render`: `load` itself waits for tiles, and a map
    // whose tiles failed or never came renders nothing to hang a check on.
    // Either would sit on "Starting map…" until the cap showed a blank map.
    let settledAt: number | undefined;
    const watchdog = setInterval(() => {
      if (!(props.chartsSettled?.() ?? true)) {
        settledAt = undefined;
        return;
      }
      settledAt ??= Date.now();
      if (tiled.length === 0) readSources();
      const pending = pendingSources();
      const fault = pending.length === 0 ? tileFault(tally) : undefined;
      if (fault) props.onBootFault?.(fault.text, fault.detail);
      else if (Date.now() - settledAt >= TILE_STALL_MS && tilesStalled(tally, pending)) {
        props.onBootFault?.("The map isn't loading", "No tiles have arrived — the server may be overloaded.");
      }
    }, 1000);
    const stop = () => {
      clearInterval(watchdog);
      map.off("render", check);
      map.off("styledata", readSources);
      map.off("error", onBootError);
      map.off("sourcedata", onBootTile);
    };
    onCleanup(stop);
    createEffect(() => {
      if (readyArmed) return;
      if (!mapLoaded()) {
        // chartsSettled pending is App's line (catalog retries); only claim
        // the splash for the map's own start-up once that's settled.
        if (props.chartsSettled?.() ?? true) reportBoot("Starting map…");
        return;
      }
      if (!(props.chartsSettled?.() ?? true)) return;
      readyArmed = true;
      // NOT maplibre's `idle`: on a live boat it never fires — SignalK
      // re-sets the own-ship/AIS/track GeoJSON several times a second and
      // follow-boat keeps the camera easing (measured: 0 idles in 12 s).
      // Ready = every TILED source (the charts, OSM, any raster) has its
      // visible tiles in; live GeoJSON and camera motion don't count.
      // Checked per render, after a frame's grace so a just-applied
      // setStyle(sets) has queued its tiles.
      requestAnimationFrame(() => {
        readSources();
        map.on("render", check);
        map.triggerRepaint();
      });
    });
    // Not inside wireMap: that runs against a FakeMap in tests with no
    // container to render into. The panel is DOM.
    setInfoState(attachInfoPanel(map, {
      vesselActions: props.vesselActions,
      settings: props.settings,
      signalk: props.signalk,
      tapRadius: props.tapRadius,
      // FEATURE providers (C4), projected from App's `features` list; slot
      // between the built-in chart/point sources (info/attach.tsx).
      providers: props.providers ?? [],
      // Invariant #9: the mode is asked first, the probe runs only if
      // declined. `pick` hit-tests the mode's OWN overlay layers so a mode
      // never imports maplibre; absent layers are skipped, not thrown.
      onClick: (query) => {
        const pick = (layers: readonly string[]): readonly string[] => {
          const r = query.radius;
          const box: [[number, number], [number, number]] = [
            [query.point.x - r, query.point.y - r],
            [query.point.x + r, query.point.y + r],
          ];
          return scopedQuery(map, { layerIds: layers })(box)
            .map((f) => f.properties?.id)
            .filter((id): id is string => typeof id === "string");
        };
        return props.modes?.handleClick({ ...query, pick }) ?? false;
      },
      // Cardinality 1: an open panel yields when a mode is entered.
      modeActive: () => !!props.modes?.active(),
      // Getter: read live, never captured.
      get goHere() {
        return props.goHere;
      },
      canGoHere: props.canGoHere,
      isFollowing: props.isFollowing,
      measureFrom: props.measureFrom,
      addMark: props.addMark,
      newRouteFrom: props.newRouteFrom,
    }));
    // Stop-pin dragging is map-native pointer work (§2.2), so it lives here
    // with the real map, not in `wireMap` (container-less test double).
    if (props.route) {
      const detach = attachRouteDragging(map, props.route, props.tapRadius);
      onCleanup(detach);
    }

    // Programmatic go-to. The camera move is DELIBERATELY not tagged AUTO:
    // `initialView.ts`'s `onMoveEnd` then reads it as the crew claiming the
    // camera, so a later GPS fix won't snatch the chart back — and follow-boat
    // reads it as a crew move (`createFollowMoveGate`): no recentre fights it,
    // and at its end the boat keeps its new screen spot or follow pauses.
    let gotoTimer: ReturnType<typeof setTimeout> | undefined;
    const clearGotoTimer = () => {
      if (gotoTimer) clearTimeout(gotoTimer);
      gotoTimer = undefined;
    };
    createEffect(() => {
      const target = props.goto?.();
      if (!target) return;
      const center: [number, number] = [target.lng, target.lat];
      // Keep the crew's working zoom (same rule as initialView.ts/info/marker.ts).
      map.easeTo({ center, duration: prefersReducedMotion() ? 0 : 500 });
      clearGotoTimer();
      setGotoShown({ lng: target.lng, lat: target.lat });
      gotoTimer = setTimeout(() => {
        clearGotoTimer();
        setGotoShown(null);
      }, GOTO_MARKER_MS);
    });
    onCleanup(() => {
      clearGotoTimer();
      setGotoShown(null);
    });

    // Each non-null value opens the SAME `InfoState` a map tap does — `show`,
    // not `probe`, since a search result is always a fresh subject.
    createEffect(() => {
      const hits = props.showInfoHits?.();
      if (!hits) return;
      infoState()?.show(hits);
    });

    // A REQUEST counter, so it fires the SAME `centreBoat()` on every bump;
    // `defer` skips the initial value so mount never hijacks the opening view.
    createEffect(on(() => props.centre?.(), () => centreBoat(), { defer: true }));

    onCleanup(() => map.remove());
  });

  // The single follow-boat button, shared by the phone and desktop stacks.
  const followButton = () => (
    <button
      type="button"
      aria-label="Follow boat"
      aria-pressed={followActive()}
      disabled={!hasFix()}
      title={
        !hasFix()
          ? "No position fix — nothing to follow"
          : followActive()
            ? "Following — tap to recentre, hold to stop"
            : "Follow boat"
      }
      // Tap vs hold on release: still-holding on pointerup is a TAP
      // (activate+centre); already-fired needs nothing; leaving/
      // cancelling aborts the hold entirely.
      onPointerDown={() => releaseHold.start()}
      onPointerUp={() => {
        if (releaseHold.holding()) {
          releaseHold.cancel();
          followTap();
        }
      }}
      onPointerLeave={() => releaseHold.cancel()}
      onPointerCancel={() => releaseHold.cancel()}
      // Keyboard (Enter/Space) fires no pointer events: a click with
      // `detail === 0` is that path — treat it as a tap.
      onClick={(e) => {
        if (e.detail === 0) followTap();
      }}
      class={`focus-ring pointer-events-auto grid size-10 select-none touch-none place-items-center overflow-hidden rounded-full bg-transparent transition-colors disabled:opacity-50 pointer-coarse:size-11 ${
        followActive() ? "text-accent" : "text-fg hover:text-accent"
      }`}
      style={{ filter: MAP_CTRL_HALO }}
    >
      {/* Hold-to-stop: a ring fills clockwise over the hold duration
          (createHoldToFire's `progress`) so the exit — which otherwise
          only lived in an unreachable-on-touch `title` — is visible. */}
      <Show when={releaseHold.holding()}>
        <span
          aria-hidden="true"
          class="pointer-events-none absolute inset-0 rounded-full"
          style={{
            background: `conic-gradient(currentColor ${Math.round(
              releaseHold.progress() * 360,
            )}deg, transparent 0deg)`,
            // `black` (not a hex) keeps the theming ratchet happy; the mask
            // only needs an opaque stop — its colour is never shown.
            "-webkit-mask":
              "radial-gradient(farthest-side, transparent calc(100% - 3px), black calc(100% - 3px))",
            mask: "radial-gradient(farthest-side, transparent calc(100% - 3px), black calc(100% - 3px))",
            opacity: "0.85",
          }}
        />
      </Show>
      <Show when={releaseHold.holding()}>
        <span class="pointer-events-none absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-black/75 px-1.5 py-0.5 text-[10px] font-medium text-on-scrim">
          Hold to stop
        </span>
      </Show>
      <LocateFixed size={20} aria-hidden="true" class="relative" />
    </button>
  );

  return (
    <div class="relative h-full w-full">
      <div ref={container} class="h-full w-full" />
      {/* Plugins' own map chrome (markers, badges) — `attachMap`'s views. */}
      <For each={pluginViews()}>{(view) => view()}</For>
      {/* TEMPORARY: FPS/frame-time readout, dev/flag-gated. Remove with FpsCounter.tsx. */}
      <Show when={fpsDebugEnabled() && readyMap()}>
        {(map) => <FpsCounter map={map()} />}
      </Show>
      {/* Transient go-to pin: the magenta "this one, here" ring S-52 reserves
          (ported from info/InfoMarker.tsx). Clears after a few seconds. */}
      <Show when={readyMap()}>
        {(map) => (
          <MapMarker
            map={map()}
            lngLat={() => gotoShown() ?? undefined}
            class="pointer-events-none z-10"
          >
            <CrosshairMarker px={34} r={9.5} inner={13} outer={16.5} color={markerMagenta(props.settings().palette)} halo={overlay().markerHalo} haloWidth={5} innerWidth={2.5} pop />
          </MapMarker>
        )}
      </Show>
      {/* Follow-boat controls, on BOTH surfaces (unlike zoom, you can't
          hand-pan to chase a moving boat). MOUNTED-but-DISABLED with no fix
          (HitCarousel's "Go here" idiom), not hidden. ONE button on both
          (`followButton`): tap=follow+centre, hold=deactivate. */}
      <Show
        when={!isCompact()}
        fallback={
          // PHONE: bottom-aligned vertical stack, `flex-col-reverse` puts the
          // FAB at the bottom with tools ascending above it. Container is
          // pointer-transparent; only the buttons take taps.
          <div class="pointer-events-none absolute bottom-4 right-2.5 z-10 flex flex-col-reverse items-center gap-2">
          {followButton()}
          {/* Chart-mode tools + Layers, registry-driven so a feature's mode
              gets a button for free — same wiring the rail used. */}
          <For each={modeList()}>
            {(mode) => (
              <MapToolButton
                icon={modeIcon(mode.id)}
                label={mode.label}
                active={props.modes?.active() === mode.id}
                onClick={() => props.modes?.toggle(mode.id)}
              />
            )}
          </For>
          <Show when={props.onLayers}>
            <MapToolButton
              icon={Layers}
              label="Layers"
              active={!!props.layersOpen?.()}
              onClick={() => props.onLayers?.()}
            />
          </Show>
          {/* Same overlay Ctrl/Cmd-F and the command palette's Search entry open. */}
          <Show when={props.onSearch}>
            <MapToolButton
              icon={SearchIcon}
              label="Search"
              active={false}
              onClick={() => props.onSearch?.()}
            />
          </Show>
          {/* Hidden on iOS (no Fullscreen API) and installed Android PWA
              (manifest already forces fullscreen). */}
          <Show when={fullscreen.buttonVisible()}>
            <MapToolButton
              icon={fullscreen.isFullscreen() ? Minimize : Maximize}
              label={fullscreen.isFullscreen() ? "Exit fullscreen" : "Enter fullscreen"}
              active={fullscreen.isFullscreen()}
              onClick={() => fullscreen.toggle()}
            />
          </Show>
          </div>
        }
      >
        {/* DESKTOP: same transparent ghost stack as phone. Anchored
            `bottom-[84px]` to clear the maplibre zoom control in this corner. */}
        <div class="pointer-events-none absolute bottom-[84px] right-2.5 z-10 flex flex-col-reverse items-center gap-2">
          {followButton()}
          <For each={modeList()}>
            {(mode) => (
              <MapToolButton
                icon={modeIcon(mode.id)}
                label={mode.label}
                active={props.modes?.active() === mode.id}
                onClick={() => props.modes?.toggle(mode.id)}
              />
            )}
          </For>
          <Show when={props.onLayers}>
            <MapToolButton
              icon={Layers}
              label="Layers"
              active={!!props.layersOpen?.()}
              onClick={() => props.onLayers?.()}
            />
          </Show>
          <Show when={props.onSearch}>
            <MapToolButton
              icon={SearchIcon}
              label="Search"
              active={false}
              onClick={() => props.onSearch?.()}
            />
          </Show>
          <Show when={fullscreen.buttonVisible()}>
            <MapToolButton
              icon={fullscreen.isFullscreen() ? Minimize : Maximize}
              label={fullscreen.isFullscreen() ? "Exit fullscreen" : "Enter fullscreen"}
              active={fullscreen.isFullscreen()}
              onClick={() => fullscreen.toggle()}
            />
          </Show>
        </div>
      </Show>

    </div>
  );
};

export default MapView;
