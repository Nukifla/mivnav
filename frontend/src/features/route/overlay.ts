// The route overlay: line, legs, stop handles, router bends and the active-leg
// highlight — GeoJSON sources/layers, not SVG. `ensure*` is idempotent
// (installs after any style application); `update*` pushes via `setData` only.
//
// `ROUTE_LAYER_IDS` MUST stay in MapView.wireMap's `ensureOverlays()` re-hoist
// list: these layers live outside the generated style, so a palette/settings
// `setStyle(diff)` removes them and re-adds the chart on top — an overlay not
// re-hoisted disappears UNDER the chart (same rule as the measure overlay).

import type { FeatureCollection } from "geojson";
import type { GeoJSONSource, Map as MLMap, MapMouseEvent, MapTouchEvent } from "maplibre-gl";
import { ROUTE_LINE_LAYER, ROUTE_WAYPOINTS_LAYER } from "./layers";
import type { RouteOverlay } from "./index";
import type { GeoPoint } from "../../core/chrome/geo";
import { lerpDensity, type Density } from "../../core/chrome/registry";
import { groupApproximateRuns } from "./runs";
import { isMultiTouch } from "../../core/map/userGesture";
import {
  PALETTES,
  ROUTE_OVERLAY_COLORS,
  ROUTE_WARNING,
  routeOverlayColors,
  type Palette,
  type RouteOverlayColors,
} from "../../core/style/colors";
import { Z, type Overlay } from "../../core/layers/overlay";
import { addLayer } from "../../core/layers/addLayer";

const SOURCE = "route";
const ACTIVE_LEG_LAYER = "route-active-leg";
// The APPROXIMATE run(s) of a "Go here" plan — one or more straight-line
// stretches the router couldn't actually verify (`RouteOverlay.
// approximateLegs`, the autorouting plugin's `PlanResult`), not only at the
// two ends: a run can land anywhere along the route. Dashed and
// warning-coloured, its own layer so it never inherits `ROUTE_LINE_
// LAYER`'s solid route-pink paint. Not hit-tested — it draws exactly
// where `ROUTE_LINE_LAYER` would have, so the mode's own line-layer hit
// test already covers it.
const ROUTE_WARN_LAYER = "route-warn-line";

// Boat → active waypoint, dashed/accent-coloured so it reads as steering
// intent, not part of the route. Not hit-tested, so the mode never names it.
const ROUTE_STEER_LAYER = "route-steer-line";
// #RF-NAVMODE: SOLID yellow boat → target, drawn whenever SignalK reports an
// active course (model.targetLine, backed by signalk.course / backend's
// Course), independent of mivnav's own local route state — reflects the
// boat's ACTUAL course no matter which client set it.
const ROUTE_TARGET_LAYER = "route-target-line";
const ROUTE_TARGET_WP_LAYER = "route-waypoint-target";
const DIRECTION_LAYER = "route-direction";
const ACTIVE_WP_LAYER = "route-waypoint-active";
// A router-inserted BEND: a small unlabeled dot, no handle — it is the
// planner's own choice, not a point a person set and can grab. Below
// `ROUTE_WAYPOINTS_LAYER` (the STOPS, `ROUTE_WAYPOINTS_LAYER`'s own name
// predates the redesign but stays: it is still "the layer the mode hit-tests",
// which is exactly the stops), so a bend never visually competes with a stop
// sitting near it.
const ROUTE_BENDS_LAYER = "route-bends";

/**
 * Bottom to top. MapView re-hoists in this order, so the order here IS the
 * stacking: the line under the active leg, the steer-to line over both (it is
 * the live intent, and must not hide under the route it rejoins), the router's
 * own bends under the stop handles, the active ring over both.
 */
export const ROUTE_LAYER_IDS = [
  ROUTE_LINE_LAYER,
  // Right after the real line — a stub reads as "part of this same
  // route", not a separate thing, so it belongs at the same tier.
  ROUTE_WARN_LAYER,
  ACTIVE_LEG_LAYER,
  ROUTE_STEER_LAYER,
  ROUTE_TARGET_LAYER,
  DIRECTION_LAYER,
  // Bends under the stop handles, so a stop sitting near one is never hidden.
  ROUTE_BENDS_LAYER,
  ROUTE_WAYPOINTS_LAYER,
  ACTIVE_WP_LAYER,
  ROUTE_TARGET_WP_LAYER,
] as const;

// Per-palette colours live in style/colors.ts's ROUTE_OVERLAY_COLORS; `halo`
// tracks the chrome GROUND so day white doesn't glare on a night chart.

/**
 * Handle/line sizes by density (a SETTING, not a breakpoint — #DENS-SLIDER's
 * `lerpDensity`). Keyed on `density`, not `pointerCoarse`: `tapRadius` already
 * grows the PICK tolerance, but the drawn handle needs a bigger VISUAL target
 * regardless of mouse-vs-glove.
 */
interface RouteSizes {
  line: number;
  activeLeg: number;
  /** The steer-to line — a touch thinner than the route line, so it reads as a
   * cue laid over the plan, not another route to sail. */
  steer: number;
  /** The target-mode line (#RF-NAVMODE) — the same weight as the steer line;
   * SOLID (not dashed), colour tells it apart. */
  target: number;
  /** The yellow target dot (#RF-NAVMODE) — filled, sized like the active dot so
   * "the target" reads at the same glance the line-mode active dot does. */
  targetWp: number;
  /** A STOP's handle — a bigger, grabbable ring (a person chose this point and
   * can drag it). */
  wp: number;
  wpStroke: number;
  activeWp: number;
  activeStroke: number;
  /** A router-inserted BEND — small, filled, no handle: there to show the
   * route bent around something, not to be grabbed. */
  bend: number;
  /** Direction-arrow `icon-size` (a factor of the baked image). Grows at helm
   * so a glanced arrow still reads which way the route flows from arm's length. */
  arrow: number;
}
const ROUTE_SIZES_DESK: RouteSizes = {
  line: 1.5,
  activeLeg: 3,
  steer: 1,
  target: 1.5,
  targetWp: 3.5,
  wp: 4.5,
  wpStroke: 1.5,
  activeWp: 3.5,
  activeStroke: 1.25,
  bend: 1.75,
  arrow: 0.85,
};
const ROUTE_SIZES_HELM: RouteSizes = {
  line: 2,
  activeLeg: 3.5,
  steer: 1.5,
  target: 2,
  targetWp: 5,
  wp: 6.5,
  wpStroke: 1.75,
  activeWp: 5,
  activeStroke: 1.5,
  bend: 2.5,
  arrow: 1.1,
};

const routeSizes = (density: Density): RouteSizes => {
  const t = <K extends keyof RouteSizes>(field: K) =>
    lerpDensity(ROUTE_SIZES_DESK[field], ROUTE_SIZES_HELM[field], density);
  return {
    line: t("line"),
    activeLeg: t("activeLeg"),
    steer: t("steer"),
    target: t("target"),
    targetWp: t("targetWp"),
    wp: t("wp"),
    wpStroke: t("wpStroke"),
    activeWp: t("activeWp"),
    activeStroke: t("activeStroke"),
    bend: t("bend"),
    arrow: t("arrow"),
  };
};

/** The paint inputs the overlay needs beyond its geometry: which palette to
 * colour with and which density to size for. */
export interface RoutePaint {
  palette: Palette;
  density: Density;
}

// The direction arrow: see docs/architecture/route-direction-arrow.md for why
// it's a baked `addImage` icon (not text-field) and why it's a solid,
// unhaloed triangle (a deliberate override of the old haloed-chevron design).

/** Canvas supersampling; MapLibre is told via `{ pixelRatio: RATIO }`. Mirrors
 * `signalkShips.ts` — the same idiom for the same reason (crisp on retina). */
const RATIO = 2;
const arrowCtx = (w: number, h: number): CanvasRenderingContext2D => {
  const el = document.createElement("canvas");
  el.width = w * RATIO;
  el.height = h * RATIO;
  const ctx = el.getContext("2d")!;
  ctx.scale(RATIO, RATIO);
  return ctx;
};

/** The `addImage` id for the arrow baked in a given palette's colours. */
const arrowIcon = (palette: Palette): string => `route-arrow-${palette}`;

/**
 * One direction arrow pointing +x (east); `symbol-placement:"line"` rotates
 * it to each leg's tangent. Proportions and fill-not-stroke choice: see
 * docs/architecture/route-direction-arrow.md.
 */
function directionImage(c: RouteOverlayColors): ImageData {
  const w = 16;
  const h = 14;
  const ctx = arrowCtx(w, h);
  const path = new Path2D();
  path.moveTo(3.5, 2.5);
  path.lineTo(13.5, 7);
  path.lineTo(3.5, 11.5);
  path.closePath();
  ctx.fillStyle = c.route;
  ctx.fill(path);
  return ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
}

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

const KIND = {
  line: "line",
  warn: "warn",
  activeLeg: "active-leg",
  steer: "steer",
  target: "target",
  targetWp: "wp-target",
  wp: "wp",
  activeWp: "wp-active",
  bend: "bend",
} as const;
const isKind = (k: string) => ["==", ["get", "kind"], k] as ["==", ["get", "kind"], string];

/**
 * Idempotent: (re-)create the source and layers after any style application,
 * then paint them for the given palette/density.
 *
 * Colours and sizes come from `applyRoutePaint` rather than being baked into the
 * `addLayer` specs, so there is ONE place that knows the palette table and the
 * density sizes — and a palette or density change updates the existing layers
 * through the same function (a palette switch re-runs this via `style.load`; a
 * density switch, which triggers no style reload, reaches `applyRoutePaint`
 * directly from MapView).
 */
export function ensureRouteLayers(map: MLMap, paint: RoutePaint): void {
  if (!map.getSource(SOURCE)) map.addSource(SOURCE, { type: "geojson", data: EMPTY });

  // Every palette's arrow built up front (signalkShips.ts idiom), so a
  // palette switch is a layout-property swap, not an image rebuild.
  for (const palette of PALETTES) {
    const id = arrowIcon(palette);
    if (!map.hasImage(id)) map.addImage(id, directionImage(ROUTE_OVERLAY_COLORS[palette]), { pixelRatio: RATIO });
  }

  const layer = (spec: Parameters<MLMap["addLayer"]>[0]) => {
    if (!map.getLayer(spec.id)) addLayer(map, spec);
  };

  // Solid: a route is a plan for a thing that will be there, unlike the
  // dashed measure line, which is only a question.
  layer({
    id: ROUTE_LINE_LAYER,
    type: "line",
    source: SOURCE,
    filter: isKind(KIND.line),
    layout: { "line-cap": "round", "line-join": "round" },
  });

  // The approximate stub(s) at either end of a "Go here" plan: dashed,
  // warning-coloured, same width as the real line so it still reads as
  // "this route", not a different feature — only the dash + colour say
  // "this part is a guess". Colour/width from `applyRoutePaint`.
  layer({
    id: ROUTE_WARN_LAYER,
    type: "line",
    source: SOURCE,
    filter: isKind(KIND.warn),
    layout: { "line-cap": "round", "line-join": "round" },
  });

  // The followed leg, brighter/thicker: "this is the one you're steering".
  layer({
    id: ACTIVE_LEG_LAYER,
    type: "line",
    source: SOURCE,
    filter: isKind(KIND.activeLeg),
    layout: { "line-cap": "round" },
    paint: { "line-opacity": 0.9 },
  });

  // Dashed (live intent, not a committed leg — measure overlay's rule) and
  // accent-coloured so it never blurs into the route/active-leg lines.
  layer({
    id: ROUTE_STEER_LAYER,
    type: "line",
    source: SOURCE,
    filter: isKind(KIND.steer),
    layout: { "line-cap": "round" },
    paint: { "line-opacity": 0.85 },
  });

  // #RF-NAVMODE: solid (unlike the dashed steer line) because this IS the
  // course being steered; yellow so "SignalK's real course" reads distinctly.
  layer({
    id: ROUTE_TARGET_LAYER,
    type: "line",
    source: SOURCE,
    filter: isKind(KIND.target),
    layout: { "line-cap": "round", "line-join": "round" },
  });

  // #RF-NAVMODE: replaces the route-coloured local active dot while a real
  // course is reported (both suppressed there, see updateRouteData).
  layer({ id: ROUTE_TARGET_WP_LAYER, type: "circle", source: SOURCE, filter: isKind(KIND.targetWp) });

  // Above the line/active-leg, under the handles, so a grab target is never
  // hidden behind an arrow.
  layer({
    id: DIRECTION_LAYER,
    type: "symbol",
    source: SOURCE,
    filter: isKind(KIND.line),
    layout: {
      "symbol-placement": "line",
      "symbol-spacing": 100,
      "icon-image": arrowIcon(paint.palette),
      "icon-size": routeSizes(paint.density).arrow,
      "icon-rotation-alignment": "map",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
  });

  // Every ROUTER-INSERTED BEND: a small filled dot, no handle — under the stop
  // layer so it never visually competes with a real stop sitting near it.
  layer({ id: ROUTE_BENDS_LAYER, type: "circle", source: SOURCE, filter: isKind(KIND.bend) });

  // Every STOP, as a hollow ring — a handle you can grab. This is the layer
  // the mode hit-tests (drag) and the overlay's own press-drag targets.
  layer({ id: ROUTE_WAYPOINTS_LAYER, type: "circle", source: SOURCE, filter: isKind(KIND.wp) });

  layer({ id: ACTIVE_WP_LAYER, type: "circle", source: SOURCE, filter: isKind(KIND.activeWp) });

  applyRoutePaint(map, paint);
}

/**
 * Recolour and resize the overlay for the current palette/density. Separate from
 * `ensureRouteLayers` because a DENSITY change triggers no style reload (it is a
 * chrome setting, not a chart one), so the paint has to be updatable without
 * re-adding the layers — MapView calls this from an effect on both axes. Guarded
 * per layer so it is a no-op on a style-reload beat where a layer is momentarily
 * absent, the same tolerance the rest of this file shows.
 */
export function applyRoutePaint(map: MLMap, { palette, density }: RoutePaint): void {
  // routeOverlayColors, not the raw table, so the theme editor's session
  // override (themes/override.ts) reaches the line live. The arrow ICON is a
  // cached raster and does NOT repaint from this — known v1 gap.
  const c = routeOverlayColors(palette);
  const s = routeSizes(density);
  const set = (id: string, prop: string, value: unknown) => {
    if (map.getLayer(id)) map.setPaintProperty(id, prop, value);
  };
  const setLayout = (id: string, prop: string, value: unknown) => {
    if (map.getLayer(id)) map.setLayoutProperty(id, prop, value);
  };
  set(ROUTE_LINE_LAYER, "line-color", c.route);
  set(ROUTE_LINE_LAYER, "line-width", s.line);
  // The approximate stub(s): bare, not per-palette (see `ROUTE_WARNING`'s
  // own docs) — a warning must read the same regardless of theme. Same
  // dash shape as the steer-to line below, at the route's own width.
  set(ROUTE_WARN_LAYER, "line-color", ROUTE_WARNING);
  set(ROUTE_WARN_LAYER, "line-width", s.line);
  set(ROUTE_WARN_LAYER, "line-dasharray", [3, 2.5]);
  set(ACTIVE_LEG_LAYER, "line-color", c.route);
  set(ACTIVE_LEG_LAYER, "line-width", s.activeLeg);
  // dasharray is in line-WIDTHS; a fixed [3, 2.5] keeps the same dash shape
  // as the width grows at helm.
  set(ROUTE_STEER_LAYER, "line-color", c.accent);
  set(ROUTE_STEER_LAYER, "line-width", s.steer);
  set(ROUTE_STEER_LAYER, "line-dasharray", [3, 2.5]);
  set(ROUTE_TARGET_LAYER, "line-color", c.target);
  set(ROUTE_TARGET_LAYER, "line-width", s.target);
  set(ROUTE_TARGET_WP_LAYER, "circle-radius", s.targetWp);
  set(ROUTE_TARGET_WP_LAYER, "circle-color", c.target);
  set(ROUTE_TARGET_WP_LAYER, "circle-stroke-width", s.activeStroke);
  set(ROUTE_TARGET_WP_LAYER, "circle-stroke-color", c.halo);
  // Baked-per-palette image (colour can't follow a paint property): a
  // palette switch swaps `icon-image`, both are LAYOUT properties.
  setLayout(DIRECTION_LAYER, "icon-image", arrowIcon(palette));
  setLayout(DIRECTION_LAYER, "icon-size", s.arrow);
  set(ROUTE_BENDS_LAYER, "circle-radius", s.bend);
  set(ROUTE_BENDS_LAYER, "circle-color", c.route);
  set(ROUTE_WAYPOINTS_LAYER, "circle-radius", s.wp);
  set(ROUTE_WAYPOINTS_LAYER, "circle-color", c.halo);
  set(ROUTE_WAYPOINTS_LAYER, "circle-stroke-width", s.wpStroke);
  set(ROUTE_WAYPOINTS_LAYER, "circle-stroke-color", c.route);
  set(ACTIVE_WP_LAYER, "circle-radius", s.activeWp);
  set(ACTIVE_WP_LAYER, "circle-color", c.route);
  set(ACTIVE_WP_LAYER, "circle-stroke-width", s.activeStroke);
  set(ACTIVE_WP_LAYER, "circle-stroke-color", c.halo);
}

/** Push the model's current route into the (ensured) source. */
export function updateRouteData(map: MLMap, model: RouteOverlay | undefined): void {
  if (!model) return;

  // Look up the source but do NOT bail on it being absent yet — see the
  // guard at the bottom. `model` is a closed-over reference (never itself a
  // signal), so returning on it here reads nothing reactive and is safe;
  // `source` is a LIVE map query that can genuinely be momentarily undefined
  // (a style reload removes it before `ensure()` re-adds it) — an early
  // return keyed on THAT, before the reads below, would starve this effect
  // of its subscription to `route()`/`activeWaypoint()`/etc. on exactly the
  // run where the source wasn't ready, and since nothing else here changes
  // `loaded()` (`wireOverlays`'s own only remaining tracked read at that
  // point), the effect would never fire again — frozen on whatever the map
  // last showed, with every LOCAL signal (the plan sheet included) still
  // updating normally. Real, live-caught bug, not hypothetical: confirmed a
  // route editor whose side panel updated instantly while its own map never
  // moved again until a full reload.
  const source = map.getSource(SOURCE) as GeoJSONSource | undefined;

  const features: FeatureCollection["features"] = [];
  const route = model.route();

  // #RF-NAVMODE: computed OUTSIDE `if (route)` — must draw even with no local
  // route, since SignalK's active course may come from another client. Dot
  // goes on `target.to` directly, not a local waypoint lookup by id — SignalK's
  // target may not correspond to any waypoint mivnav knows about.
  // The From/To PIN PREVIEWS: read and drawn unconditionally, same reasoning
  // as `target` below — they must show even with no real route/draft yet
  // (a brand-new draft with nothing chosen still shows a From pin ON THE
  // BOAT the moment a fix exists — `previewFrom`'s own "defaults to the
  // boat" doc). Rendered with the SAME `KIND.wp` a real stop uses (the
  // waypoints layer), so a preview pin looks exactly like the stop it is
  // about to become — no separate layer/paint needed. `previewFrom`/
  // `previewTo` already return `null` once a real route exists (their own
  // doc), so this can never double-draw alongside the real waypoint loop
  // below. `?.()`: older test fakes may not supply these.
  const previewFrom = model.previewFrom?.();
  if (previewFrom) {
    features.push({
      type: "Feature",
      properties: { kind: KIND.wp, id: "preview-from" },
      geometry: { type: "Point", coordinates: [previewFrom.point.lng, previewFrom.point.lat] },
    });
  }
  const previewTo = model.previewTo?.();
  if (previewTo) {
    features.push({
      type: "Feature",
      properties: { kind: KIND.wp, id: "preview-to" },
      geometry: { type: "Point", coordinates: [previewTo.point.lng, previewTo.point.lat] },
    });
  }

  const target = model.targetLine?.();
  // Suppresses the LOCAL steering cues below: showing "you're steering this
  // leg" next to a yellow line pointing elsewhere would contradict it.
  const targetMode = !!target;
  if (target) {
    features.push({
      type: "Feature",
      properties: { kind: KIND.target },
      geometry: {
        type: "LineString",
        coordinates: [
          [target.from.lng, target.from.lat],
          [target.to.lng, target.to.lat],
        ],
      },
    });
    features.push({
      type: "Feature",
      properties: { kind: KIND.targetWp },
      geometry: { type: "Point", coordinates: [target.to.lng, target.to.lat] },
    });
  }

  if (route) {
    const pts = route.waypoints;
    const coords = pts.map((w) => [w.lon, w.lat]);

    // Read straight off each WAYPOINT's own persisted `approximate` flag
    // (#owqqcdqe, 2026-08-10 — `routeFromPlan`, `core/routes.ts`), not
    // the old ephemeral `model.approximateLegs` signal: that one only
    // ever held the truth for the single session that planned the route
    // — reload the page, reopen a saved route, or just come back later,
    // and a genuinely-flagged "couldn't verify, straight-line guess"
    // stretch rendered as an ordinary, fully-trusted leg with nothing
    // left to say it was ever a guess. Waypoint `i`'s own flag is leg
    // `i - 1`'s (the leg ARRIVING at it); waypoint 0 has no incoming leg.
    const approxLegs = pts.slice(1).map((w) => w.approximate ?? false);
    if (pts.length >= 2) {
      for (const run of groupApproximateRuns(coords, approxLegs)) {
        if (run.points.length < 2) continue;
        features.push({
          type: "Feature",
          properties: { kind: run.approximate ? KIND.warn : KIND.line, id: route.id },
          geometry: { type: "LineString", coordinates: run.points },
        });
      }
    }

    // Is leg `i` (`coords[i]` -> `coords[i+1]`) one of the approximate
    // runs above? `ACTIVE_LEG_LAYER` renders ABOVE `ROUTE_WARN_LAYER`
    // (it needs to, to highlight a REAL followed leg over the plain
    // route line under normal circumstances) — for a "Go here" route
    // the destination IS always the active waypoint, so without this
    // check the bright, opaque "this is what you're steering" highlight
    // painted exactly over a straight-line GUESS, hiding the dashed
    // warning underneath completely. A real bug, caught live: the start
    // stub showed (nothing else ever covers leg 0), the end stub never
    // did (the active-leg highlight always covers the last leg here).
    // Generalized the same way `approximateLegs` itself was: a flagged
    // leg is not only leg 0 or the last leg any more.
    const legIsApproximate = (i: number): boolean => approxLegs[i] ?? false;

    // Suppressed under targetMode — this is planning display, not the live
    // steering claim.
    const activeId = model.activeWaypoint();
    const ai = activeId ? pts.findIndex((w) => w.id === activeId) : -1;
    if (ai > 0 && !targetMode && !legIsApproximate(ai - 1)) {
      features.push({
        type: "Feature",
        properties: { kind: KIND.activeLeg },
        geometry: { type: "LineString", coordinates: [coords[ai - 1], coords[ai]] },
      });
    }

    // Null unless following locally (model handles the editing/targetLine
    // cases). Boat end is live, so this segment redraws as the boat moves.
    const steer = model.steerLine?.();
    if (steer) {
      features.push({
        type: "Feature",
        properties: { kind: KIND.steer },
        geometry: {
          type: "LineString",
          coordinates: [
            [steer.from.lng, steer.from.lat],
            [steer.to.lng, steer.to.lat],
          ],
        },
      });
    }

    // The FLASHED leg: the plan sheet tapped a leg row, so highlight the segment
    // `seg`→`seg+1` for a moment. Reuses the active-leg highlight (same layer,
    // same bright stroke) — a plan reading onto the chart, transiently. Same
    // approximate-leg guard as the active leg above, for the same reason.
    const flash = model.flashLeg?.() ?? null;
    if (flash !== null && flash >= 0 && flash < coords.length - 1 && !legIsApproximate(flash)) {
      features.push({
        type: "Feature",
        properties: { kind: KIND.activeLeg },
        geometry: { type: "LineString", coordinates: [coords[flash], coords[flash + 1]] },
      });
    }

    // Every waypoint: a STOP gets a grabbable handle (`kind: wp`, the layer
    // the drag session hit-tests), a router-inserted BEND a small unlabeled
    // dot (`kind: bend`). `id` in properties (not the feature id) so
    // MapLibre's numeric-id rule is a non-issue and hit-testing reads it back
    // plainly.
    for (const w of pts) {
      features.push({
        type: "Feature",
        properties: { kind: w.stop ? KIND.wp : KIND.bend, id: w.id },
        geometry: { type: "Point", coordinates: [w.lon, w.lat] },
      });
    }

    if (ai >= 0 && !targetMode) {
      features.push({
        type: "Feature",
        properties: { kind: KIND.activeWp },
        geometry: { type: "Point", coordinates: coords[ai] },
      });
    }
  }

  // NOW it's safe to skip: every accessor above has already been read (and
  // so tracked), regardless of whether the source existed this run — the
  // next run, whenever ANY of them changes, will find it and catch up.
  if (!source) return;
  source.setData({ type: "FeatureCollection", features });
}

/**
 * The route editor's map-native gesture layer — now down to exactly ONE
 * mutating path: press a STOP's handle, drag it past a small slop, drop it
 * (`beginWaypointDrag`/`moveWaypoint`/`endWaypointDrag`, index.ts re-plans the
 * leg(s) touching it at drop). Everything the pre-redesign recognizer
 * (`./gestures`, deleted with it) existed for is gone along with it: there is
 * no more hold-to-enter-the-editor-from-outside (the info panel's tap → "Edit
 * route" is the one entry, `provider.ts`), no more insert-on-tap, no more
 * hold-to-reveal-delete-×, no more insertion-cursor hover — a plain tap is the
 * MapLibre `click` the mode's own `onClick` handles (index.ts): inert unless a
 * "choose on map" pick is armed.
 *
 * A pinch (2nd finger) mid-drag cancels it (`abortDrag`, restoring the
 * pre-drag position) rather than fighting MapLibre's own pinch-zoom.
 *
 * Attached ONCE by MapView; the handlers survive a style reload, unlike the
 * layers, which `ensureRouteLayers` re-installs.
 */
export function attachRouteDragging(
  map: MLMap,
  model: Pick<RouteOverlay, "editing" | "route" | "moveWaypoint" | "beginWaypointDrag" | "endWaypointDrag" | "abortDrag">,
  tapRadius?: () => number,
): () => void {
  const DEFAULT_RADIUS = 8;
  const DRAG_SLOP_PX = 8;

  // MapLibre's own one-finger zoom (`TapDragZoomHandler`) is a tap, then a
  // SECOND touchstart within MAX_TAP_INTERVAL/MAX_DIST of that tap's release,
  // then a drag on that same finger. Without this guard, pressing a stop
  // handle as that 2nd touch would arm OUR drag on the exact touch meant as a
  // zoom (#zkqlvwxr) — these constants mirror MapLibre's own.
  const MAPLIBRE_TAP_INTERVAL_MS = 500;
  const MAPLIBRE_TAP_DIST_PX = 30;
  let lastTouchUp: { time: number; x: number; y: number } | null = null;

  // In-flight drag bookkeeping.
  let dragId: string | null = null;
  let dragOrigin: GeoPoint | null = null;
  let downPoint: { x: number; y: number } | null = null;
  let dragging = false;
  // Touch/mouse de-dup: a touch device also fires emulated mouse events after
  // a tap; swallow those on the mouse handlers so a press is armed once.
  let touchActive = false;
  let touchOffTimer: ReturnType<typeof setTimeout> | undefined;
  const markTouch = () => {
    touchActive = true;
    if (touchOffTimer) clearTimeout(touchOffTimer);
  };
  const releaseTouch = () => {
    if (touchOffTimer) clearTimeout(touchOffTimer);
    touchOffTimer = setTimeout(() => (touchActive = false), 400);
  };

  /** Screen-space hit-test at the tap radius, STOPS only — a router-inserted
   * bend has no handle. The tolerance box (grown for a gloved hand,
   * §modes.ts) is what lets an imprecise grab still land on a target. */
  const hitStop = (point: { x: number; y: number }): string | null => {
    if (!map.getLayer(ROUTE_WAYPOINTS_LAYER)) return null;
    const r = tapRadius?.() ?? DEFAULT_RADIUS;
    const box: [[number, number], [number, number]] = [
      [point.x - r, point.y - r],
      [point.x + r, point.y + r],
    ];
    const f = map.queryRenderedFeatures(box, { layers: [ROUTE_WAYPOINTS_LAYER] })[0];
    const id = f?.properties?.id;
    return typeof id === "string" ? id : null;
  };

  const handlePos = (id: string): GeoPoint | null => {
    const wp = model.route()?.waypoints.find((w) => w.id === id);
    return wp ? { lng: wp.lon, lat: wp.lat } : null;
  };

  const endDrag = () => {
    // Not armed → nothing of ours to undo. Unconditionally re-enabling dragPan
    // and forcing the editor's crosshair on every pinch (the old path) touched
    // map state this handler never claimed, outside the editor too.
    if (!dragId) return;
    dragId = null;
    dragOrigin = null;
    downPoint = null;
    dragging = false;
    map.dragPan.enable();
    // A drag only ever begins in the editor (a solo mode), whose resting cursor
    // is the crosshair MapView sets on mode entry — restore it, since that
    // effect won't re-run just because we swapped to `grabbing` and back.
    map.getCanvas().style.cursor = "crosshair";
  };

  const onDown = (point: { x: number; y: number }, touch: boolean) => {
    if (!model.editing()) return;
    const withinTapZoomWindow =
      touch &&
      lastTouchUp !== null &&
      Date.now() - lastTouchUp.time < MAPLIBRE_TAP_INTERVAL_MS &&
      Math.hypot(point.x - lastTouchUp.x, point.y - lastTouchUp.y) < MAPLIBRE_TAP_DIST_PX;
    if (withinTapZoomWindow) return;
    const id = hitStop(point);
    if (!id) return;
    dragId = id;
    dragOrigin = handlePos(id);
    downPoint = point;
    dragging = false;
    // Kill MapLibre's built-in dragPan the instant we press a handle. Its
    // ~3px clickTolerance starts a pan EARLIER than our own slop, so without
    // this the map would pan (pinning the handle at the press point) before
    // we even decide drag-vs-tap (#RT-DRAG). `onUp` re-enables it on a
    // pre-slop release (a plain tap).
    map.dragPan.disable();
  };

  const onMove = (point: { x: number; y: number }, lngLat: GeoPoint) => {
    if (!dragId || !downPoint) return;
    if (!dragging) {
      if (Math.hypot(point.x - downPoint.x, point.y - downPoint.y) < DRAG_SLOP_PX) return;
      dragging = true;
      model.beginWaypointDrag(dragId);
      map.getCanvas().style.cursor = "grabbing";
    }
    model.moveWaypoint(dragId, lngLat);
  };

  const onUp = (point: { x: number; y: number }, touch: boolean) => {
    if (dragging && dragId) {
      model.endWaypointDrag();
      endDrag();
    } else if (dragId) {
      // A pre-slop release: never became a real drag, so nothing to commit —
      // just clear the arm and re-enable the pan `onDown` disabled.
      endDrag();
    }
    if (touch) lastTouchUp = { time: Date.now(), x: point.x, y: point.y };
  };

  // A second finger mid-drag (or the browser cancelling the touch): cancel it
  // cleanly — the stop snaps back to where it was, nothing is committed — and
  // hand off to MapLibre's pinch-zoom. A no-op when nothing is armed.
  const onSecondPointer = () => {
    if (dragging && dragId && dragOrigin) model.abortDrag(dragId, dragOrigin);
    endDrag();
  };

  const mdown = (e: MapMouseEvent) => {
    if (!touchActive) onDown({ x: e.point.x, y: e.point.y }, false);
  };
  const mmove = (e: MapMouseEvent) => {
    if (!touchActive) onMove({ x: e.point.x, y: e.point.y }, { lng: e.lngLat.lng, lat: e.lngLat.lat });
  };
  const mup = (e: MapMouseEvent) => {
    if (!touchActive) onUp({ x: e.point.x, y: e.point.y }, false);
  };
  const tstart = (e: MapTouchEvent) => {
    markTouch();
    // 2+ fingers is ALWAYS MapLibre's pinch (core/map/userGesture.ts).
    if (isMultiTouch(e)) return onSecondPointer();
    onDown({ x: e.point.x, y: e.point.y }, true);
  };
  const tmove = (e: MapTouchEvent) => {
    if (isMultiTouch(e)) return onSecondPointer();
    onMove({ x: e.point.x, y: e.point.y }, { lng: e.lngLat.lng, lat: e.lngLat.lat });
  };
  const tend = (e: MapTouchEvent) => {
    onUp({ x: e.point.x, y: e.point.y }, true);
    releaseTouch();
  };
  // A cancelled touch (system gesture, palm rejection…) never sends touchend:
  // without this the arm — and the dragPan it disabled — would stay stuck.
  const tcancel = () => {
    onSecondPointer();
    releaseTouch();
  };

  map.on("mousedown", mdown);
  map.on("mousemove", mmove);
  map.on("mouseup", mup);
  map.on("touchstart", tstart);
  map.on("touchmove", tmove);
  map.on("touchend", tend);
  map.on("touchcancel", tcancel);

  return () => {
    if (touchOffTimer) clearTimeout(touchOffTimer);
    map.off("mousedown", mdown);
    map.off("mousemove", mmove);
    map.off("mouseup", mup);
    map.off("touchstart", tstart);
    map.off("touchmove", tmove);
    map.off("touchend", tend);
    map.off("touchcancel", tcancel);
  };
}

/**
 * The route overlay — the line, legs, stop/bend handles, and the active/steer/
 * flash highlights. A factory closing over the feature's `model` (the
 * POI/weather pattern), so the kernel `OverlayCtx` no longer carries a `route`
 * field and `layers/overlay.ts` no longer imports this feature.
 *
 * `paint` recolours (palette) and resizes (density) — a second effect because a
 * density switch triggers no style reload — and still reads those from the ctx.
 * The waypoint DRAG gesture is NOT here: it needs the real map and is attached
 * separately (`attachRouteDragging`), like the info panel's click.
 *
 * `onMap` captures the live map for the sibling info provider (the POI pattern):
 * the overlay is the one surface handed the map (`ensure`), so it forwards it to
 * the `map` signal the route provider hit-tests `ROUTE_LINE_LAYER` through.
 */
export function createRouteOverlay(
  model: RouteOverlay | undefined,
  onMap?: (map: MLMap) => void,
): Overlay {
  return {
    id: "route",
    layerIds: ROUTE_LAYER_IDS,
    z: Z.route,
    ensure(map, ctx) {
      onMap?.(map);
      ensureRouteLayers(map, { palette: ctx.settings().palette, density: ctx.density() });
    },
    update(map) {
      // updateRouteData reads every one of the model's accessors it needs, so
      // calling it in the update effect is what subscribes that effect to
      // route/activeWaypoint/steerLine/targetLine/flashLeg — no explicit read
      // list needed.
      updateRouteData(map, model);
    },
    paint(map, ctx) {
      applyRoutePaint(map, { palette: ctx.settings().palette, density: ctx.density() });
    },
  };
}
