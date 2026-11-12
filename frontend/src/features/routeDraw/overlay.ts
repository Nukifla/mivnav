// The manual route editor on the chart: the draft's line and numbered point
// handles, the selected leg, the leg "+" handles, the selected point's offset
// grab handle — one GeoJSON source — and the MapLibre host that turns pointer
// events into ./gesture.ts decisions and those into model calls.
//
// Drawn in the route display's colours (`routeOverlayColors`, the same magenta
// as features/route/layers), so a draft reads as the route it will become.

import { createSignal } from "solid-js";
import type { FeatureCollection } from "geojson";
import type { GeoJSONSource, Map as MLMap, MapMouseEvent, MapTouchEvent } from "maplibre-gl";
import type { GeoPoint } from "../../core/chrome/geo";
import { lerpDensity, type Density } from "../../core/chrome/registry";
import { isMultiTouch } from "../../core/map/userGesture";
import { routeOverlayColors, type Palette } from "../../core/style/colors";
import { TEXT_FONT } from "../../core/style/expr";
import { Z, type Overlay } from "../../core/layers/overlay";
import { addLayer } from "../../core/layers/addLayer";
import {
  createGestureMachine,
  footOnSegment,
  GRAB_OFFSET,
  hitTest,
  plusHandles,
  resolveTap,
  type Effect,
  type Px,
  type ScreenPoint,
} from "./gesture";
import type { RouteDrawModel } from "./index";

const SOURCE = "route-draw";
const LINE_LAYER = "route-draw-line";
const ARROW_LAYER = "route-draw-arrows";
const BAND_LAYER = "route-draw-band";
const SNAP_LAYER = "route-draw-snap";
const LEG_LAYER = "route-draw-leg";
const PLUS_LAYER = "route-draw-plus";
const PLUS_LABEL_LAYER = "route-draw-plus-label";
const AT_LAYER = "route-draw-at";
const POINT_LAYER = "route-draw-points";
const NUMBER_LAYER = "route-draw-numbers";
const GRAB_LAYER = "route-draw-grab";

/** Bottom to top — the re-hoist order: the line under everything, the
 * handles over it, the grab handle on top (it is what a finger aims for). */
export const ROUTE_DRAW_LAYER_IDS = [
  LINE_LAYER,
  ARROW_LAYER,
  BAND_LAYER,
  SNAP_LAYER,
  LEG_LAYER,
  PLUS_LAYER,
  PLUS_LABEL_LAYER,
  AT_LAYER,
  POINT_LAYER,
  NUMBER_LAYER,
  GRAB_LAYER,
] as const;

const KIND = {
  line: "line",
  band: "band",
  snap: "snap",
  leg: "leg",
  plus: "plus",
  at: "at",
  point: "point",
  grab: "grab",
} as const;
const isKind = (k: string) => ["==", ["get", "kind"], k] as ["==", ["get", "kind"], string];

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

interface Sizes {
  line: number;
  leg: number;
  point: number;
  stroke: number;
  number: number;
  plus: number;
  grab: number;
  /** Direction-arrow `icon-size` (a factor of the baked image). */
  arrow: number;
}
const DESK: Sizes = { line: 2, leg: 5, point: 9, stroke: 2, number: 10, plus: 7, grab: 12, arrow: 0.7 };
const HELM: Sizes = { line: 2.5, leg: 6, point: 11, stroke: 2, number: 11.5, plus: 8.5, grab: 15, arrow: 0.9 };
const sizes = (d: Density): Sizes => {
  const t = (k: keyof Sizes) => lerpDensity(DESK[k], HELM[k], d);
  return {
    line: t("line"),
    leg: t("leg"),
    point: t("point"),
    stroke: t("stroke"),
    number: t("number"),
    plus: t("plus"),
    grab: t("grab"),
    arrow: t("arrow"),
  };
};

// The direction arrows: a small solid triangle pointing +x, rotated to each
// leg by `symbol-placement: "line"` — the route display's arrow shape
// (features/route/overlay.ts), baked here per colour so a theme override of
// the route colour reaches it.
const ARROW_RATIO = 2;
const arrowIcon = (color: string): string => `route-draw-arrow-${color}`;
function ensureArrowImage(map: MLMap, color: string): string {
  const id = arrowIcon(color);
  if (typeof map.hasImage !== "function" || map.hasImage(id) || typeof document === "undefined") return id;
  const w = 16;
  const h = 14;
  const el = document.createElement("canvas");
  el.width = w * ARROW_RATIO;
  el.height = h * ARROW_RATIO;
  const ctx = el.getContext("2d");
  if (!ctx) return id;
  ctx.scale(ARROW_RATIO, ARROW_RATIO);
  ctx.beginPath();
  ctx.moveTo(3.5, 2.5);
  ctx.lineTo(13.5, 7);
  ctx.lineTo(3.5, 11.5);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  map.addImage(id, ctx.getImageData(0, 0, el.width, el.height), { pixelRatio: ARROW_RATIO });
  return id;
}

export interface RouteDrawPaint {
  palette: Palette;
  density: Density;
}

export function ensureRouteDrawLayers(map: MLMap, paint: RouteDrawPaint): void {
  if (!map.getSource(SOURCE)) map.addSource(SOURCE, { type: "geojson", data: EMPTY });
  const layer = (spec: Parameters<MLMap["addLayer"]>[0]) => {
    if (!map.getLayer(spec.id)) addLayer(map, spec);
  };
  // Every symbol here must show whatever it collides with: these are the
  // controls the person is working with right now.
  const always = { "text-allow-overlap": true, "text-ignore-placement": true } as const;

  layer({
    id: LINE_LAYER,
    type: "line",
    source: SOURCE,
    filter: isKind(KIND.line),
    layout: { "line-cap": "round", "line-join": "round" },
  });
  // Subtle: small, spaced, under every handle. Which way the route runs.
  layer({
    id: ARROW_LAYER,
    type: "symbol",
    source: SOURCE,
    filter: isKind(KIND.line),
    layout: {
      "symbol-placement": "line",
      "symbol-spacing": 120,
      "icon-rotation-alignment": "map",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
  });
  // Crosshair mode's rubber band: dashed, so it never reads as a placed leg.
  layer({
    id: BAND_LAYER,
    type: "line",
    source: SOURCE,
    filter: isKind(KIND.band),
    layout: { "line-cap": "butt" },
    paint: { "line-dasharray": [2, 2] },
  });
  // The mark a point will snap to: a ring around it.
  layer({ id: SNAP_LAYER, type: "circle", source: SOURCE, filter: isKind(KIND.snap) });
  layer({
    id: LEG_LAYER,
    type: "line",
    source: SOURCE,
    filter: isKind(KIND.leg),
    layout: { "line-cap": "round" },
    paint: { "line-opacity": 0.45 },
  });
  layer({ id: PLUS_LAYER, type: "circle", source: SOURCE, filter: isKind(KIND.plus) });
  layer({
    id: PLUS_LABEL_LAYER,
    type: "symbol",
    source: SOURCE,
    filter: isKind(KIND.plus),
    layout: { "text-field": "+", "text-font": TEXT_FONT, "text-size": 14, ...always },
  });
  layer({ id: AT_LAYER, type: "circle", source: SOURCE, filter: isKind(KIND.at) });
  layer({ id: POINT_LAYER, type: "circle", source: SOURCE, filter: isKind(KIND.point) });
  layer({
    id: NUMBER_LAYER,
    type: "symbol",
    source: SOURCE,
    filter: isKind(KIND.point),
    layout: { "text-field": ["get", "n"], "text-font": TEXT_FONT, "text-size": 11, ...always },
  });
  // Drawn at the point's own coordinate, shifted on screen by the same offset
  // ./gesture.ts hit-tests — one constant, so drawn and hit always agree.
  layer({
    id: GRAB_LAYER,
    type: "circle",
    source: SOURCE,
    filter: isKind(KIND.grab),
    paint: { "circle-translate": [GRAB_OFFSET.x, GRAB_OFFSET.y], "circle-translate-anchor": "viewport" },
  });
  applyRouteDrawPaint(map, paint);
}

export function applyRouteDrawPaint(map: MLMap, { palette, density }: RouteDrawPaint): void {
  const c = routeOverlayColors(palette);
  const s = sizes(density);
  const set = (id: string, prop: string, value: unknown) => {
    if (map.getLayer(id)) map.setPaintProperty(id, prop, value);
  };
  const setLayout = (id: string, prop: string, value: unknown) => {
    if (map.getLayer(id)) map.setLayoutProperty(id, prop, value);
  };
  const sel = (on: string, off: string) => ["case", ["get", "sel"], on, off];
  set(LINE_LAYER, "line-color", c.route);
  set(LINE_LAYER, "line-width", s.line);
  if (map.getLayer(ARROW_LAYER)) {
    setLayout(ARROW_LAYER, "icon-image", ensureArrowImage(map, c.route));
    setLayout(ARROW_LAYER, "icon-size", s.arrow);
  }
  set(BAND_LAYER, "line-color", c.route);
  set(BAND_LAYER, "line-width", s.line);
  set(SNAP_LAYER, "circle-radius", s.point + 7);
  set(SNAP_LAYER, "circle-color", "rgba(0,0,0,0)");
  set(SNAP_LAYER, "circle-stroke-width", s.stroke + 1);
  set(SNAP_LAYER, "circle-stroke-color", c.route);
  set(LEG_LAYER, "line-color", c.route);
  set(LEG_LAYER, "line-width", s.leg);
  set(PLUS_LAYER, "circle-radius", s.plus);
  set(PLUS_LAYER, "circle-color", c.halo);
  set(PLUS_LAYER, "circle-opacity", 0.9);
  set(PLUS_LAYER, "circle-stroke-width", 1.5);
  set(PLUS_LAYER, "circle-stroke-color", c.route);
  set(PLUS_LABEL_LAYER, "text-color", c.route);
  set(AT_LAYER, "circle-radius", s.plus);
  set(AT_LAYER, "circle-color", "rgba(0,0,0,0)");
  set(AT_LAYER, "circle-stroke-width", s.stroke);
  set(AT_LAYER, "circle-stroke-color", c.route);
  set(POINT_LAYER, "circle-radius", s.point);
  set(POINT_LAYER, "circle-color", sel(c.route, c.halo));
  set(POINT_LAYER, "circle-stroke-width", s.stroke);
  set(POINT_LAYER, "circle-stroke-color", sel(c.halo, c.route));
  set(NUMBER_LAYER, "text-color", sel(c.halo, c.route));
  setLayout(NUMBER_LAYER, "text-size", s.number);
  set(GRAB_LAYER, "circle-radius", s.grab);
  set(GRAB_LAYER, "circle-color", c.route);
  set(GRAB_LAYER, "circle-opacity", 0.25);
  set(GRAB_LAYER, "circle-stroke-width", s.stroke);
  set(GRAB_LAYER, "circle-stroke-color", c.route);
}

type Projector = Pick<MLMap, "project" | "unproject">;
const canProject = (map: unknown): map is Projector =>
  typeof (map as Projector).project === "function" && typeof (map as Projector).unproject === "function";

/**
 * Push the draft into the (ensured) source. Every model accessor (and the
 * zoom tick) is read BEFORE the source guard, so this effect's subscriptions
 * survive a run where the source is momentarily absent — the measure
 * overlay's documented race (features/measure/overlay.test.ts).
 */
export function updateRouteDrawData(map: MLMap, model: RouteDrawModel, zoomTick: () => number): void {
  const draft = model.draft();
  const selection = model.selection();
  const dragging = model.draggingId();
  const band = model.aimLeg();
  const snap = model.snapTarget();
  zoomTick();

  const source = map.getSource(SOURCE) as GeoJSONSource | undefined;
  if (!source) return;
  if (!draft) {
    source.setData(EMPTY);
    return;
  }

  const pts = draft.waypoints;
  const coords = pts.map((w) => [w.lon, w.lat]);
  const features: FeatureCollection["features"] = [];

  if (pts.length >= 2) {
    features.push({ type: "Feature", properties: { kind: KIND.line }, geometry: { type: "LineString", coordinates: coords } });
  }

  if (band) {
    features.push({
      type: "Feature",
      properties: { kind: KIND.band },
      geometry: {
        type: "LineString",
        coordinates: [
          [band.from.lng, band.from.lat],
          [band.to.lng, band.to.lat],
        ],
      },
    });
  }
  if (snap) {
    features.push({
      type: "Feature",
      properties: { kind: KIND.snap, id: snap.id },
      geometry: { type: "Point", coordinates: [snap.lon, snap.lat] },
    });
  }

  if (selection?.kind === "leg" && selection.leg < pts.length - 1) {
    features.push({
      type: "Feature",
      properties: { kind: KIND.leg },
      geometry: { type: "LineString", coordinates: [coords[selection.leg]!, coords[selection.leg + 1]!] },
    });
    features.push({
      type: "Feature",
      properties: { kind: KIND.at },
      geometry: { type: "Point", coordinates: [selection.at.lng, selection.at.lat] },
    });
  }

  // "+" handles: exactly the ones ./gesture.ts would hit-test at this zoom.
  // Not while dragging — the dragged point's neighbours' handles would chase it.
  if (!dragging && pts.length >= 2 && canProject(map)) {
    const screen = pts.map((w) => map.project([w.lon, w.lat]));
    for (const h of plusHandles(screen)) {
      const at = map.unproject([h.at.x, h.at.y]);
      features.push({
        type: "Feature",
        properties: { kind: KIND.plus, leg: h.leg },
        geometry: { type: "Point", coordinates: [at.lng, at.lat] },
      });
    }
  }

  const selectedId = selection?.kind === "point" ? selection.id : null;
  pts.forEach((w, i) => {
    features.push({
      type: "Feature",
      properties: { kind: KIND.point, id: w.id, n: String(i + 1), sel: w.id === selectedId || w.id === dragging },
      geometry: { type: "Point", coordinates: [w.lon, w.lat] },
    });
  });

  const grabbed = pts.find((w) => w.id === selectedId);
  if (grabbed) {
    features.push({
      type: "Feature",
      properties: { kind: KIND.grab, id: grabbed.id },
      geometry: { type: "Point", coordinates: [grabbed.lon, grabbed.lat] },
    });
  }

  source.setData({ type: "FeatureCollection", features });
}

/**
 * The overlay. `onMap` forwards the live map to the feature, which attaches
 * the gesture host once per map (the marks/route-provider pattern).
 */
export function createRouteDrawOverlay(model: RouteDrawModel, onMap: (map: MLMap) => void): Overlay {
  // Bumped on every `zoomend` so the "+" handles re-evaluate their on-screen
  // length. Panning never changes it, so `move` needn't.
  const [zoomTick, setZoomTick] = createSignal(0);
  let watched: MLMap | undefined;
  return {
    id: "routeDraw",
    layerIds: ROUTE_DRAW_LAYER_IDS,
    z: Z.routeDraw,
    ensure(map, ctx) {
      onMap(map);
      if (watched !== map && typeof map.on === "function") {
        watched = map;
        map.on("zoomend", () => setZoomTick((n) => n + 1));
      }
      ensureRouteDrawLayers(map, { palette: ctx.settings().palette, density: ctx.density() });
    },
    update(map) {
      updateRouteDrawData(map, model, zoomTick);
    },
    paint(map, ctx) {
      applyRouteDrawPaint(map, { palette: ctx.settings().palette, density: ctx.density() });
    },
  };
}

// ── The gesture host ─────────────────────────────────────────────────────────

/**
 * Wire the map's pointer events to the editor. Inert unless the editor is
 * open. Taps are resolved HERE, with ./gesture.ts's slop (the mode's
 * `onClick` only swallows MapLibre's own click). A press only ever takes the
 * map's pan away (`dragPan.disable`) when it lands on something draggable;
 * everything else pans as usual.
 */
export function attachRouteDrawGestures(
  map: MLMap,
  model: RouteDrawModel,
  tapRadius?: () => number,
): () => void {
  const machine = createGestureMachine();
  let captured = false;
  // Touch/mouse de-dup (features/route/overlay.ts's idiom): a touch also
  // fires emulated mouse events after it; the mouse handlers ignore those.
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

  const geo = (p: Px): GeoPoint => {
    const ll = map.unproject([p.x, p.y]);
    return { lng: ll.lng, lat: ll.lat };
  };
  const screenPoints = (): ScreenPoint[] =>
    (model.draft()?.waypoints ?? []).map((w) => {
      const p = map.project([w.lon, w.lat]);
      return { id: w.id, x: p.x, y: p.y };
    });
  const selectedId = (): string | null => {
    const s = model.selection();
    return s?.kind === "point" ? s.id : null;
  };
  const setCursor = (c: string) => {
    const canvas = map.getCanvas?.();
    if (canvas) canvas.style.cursor = c;
  };

  const run = (effects: readonly Effect[]) => {
    for (const e of effects) {
      switch (e.type) {
        case "capture":
          captured = true;
          map.dragPan.disable();
          break;
        case "release":
          if (captured) map.dragPan.enable();
          captured = false;
          break;
        case "tap": {
          const d = model.draft();
          if (!d) break;
          const action = resolveTap(e.hit, {
            firstId: d.waypoints[0]?.id ?? null,
            count: d.waypoints.length,
            selectedId: selectedId(),
            crosshair: model.crosshair(),
          });
          // A tap may have panned the chart by up to the slop, so the spot is
          // re-derived from the CURRENT projection at the finger-up point (the
          // chart moved with the finger, so that is where it meant).
          let spot = e.at;
          if (action.op === "selectLeg") {
            const p = screenPoints();
            const a = p[action.leg];
            const b = p[action.leg + 1];
            if (a && b) {
              spot = e.hit.kind === "plus" ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : footOnSegment(e.at, a, b).foot;
            }
          }
          model.tap(action, geo(spot));
          break;
        }
        case "dragStart":
          if (e.hit.kind === "plus") model.beginInsert(e.hit.leg, geo(e.hit.anchor));
          else model.beginMove(e.hit.id);
          setCursor("grabbing");
          break;
        case "dragMove":
          model.dragTo(geo(e.to));
          break;
        case "dragEnd":
          model.endDrag();
          setCursor("crosshair");
          break;
        case "dragCancel":
          model.cancelDrag();
          setCursor("crosshair");
          break;
      }
    }
  };

  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

  const onDown = (at: Px, touch: boolean) => {
    if (!model.active()) return;
    const hit = hitTest(screenPoints(), at, { radius: tapRadius?.() ?? 8, selectedId: selectedId() });
    run(machine.down(at, hit, { touch, time: now() }));
  };
  const onMove = (at: Px) => {
    if (!machine.busy()) return;
    // The editor closed mid-press (Esc, Back): give the pan back, drop the drag.
    if (!model.active()) return run(machine.cancel());
    run(machine.move(at));
  };
  const onUp = (at: Px, touch: boolean) => {
    if (!machine.busy()) return;
    if (!model.active()) return run(machine.cancel());
    run(machine.up(at, { touch, time: now() }));
  };
  const onCancel = () => run(machine.cancel());

  const pt = (e: { point: { x: number; y: number } }): Px => ({ x: e.point.x, y: e.point.y });
  const primary = (e: MapMouseEvent) => ((e.originalEvent as MouseEvent | undefined)?.button ?? 0) === 0;

  const mdown = (e: MapMouseEvent) => {
    if (!touchActive && primary(e)) onDown(pt(e), false);
  };
  const mmove = (e: MapMouseEvent) => {
    if (!touchActive) onMove(pt(e));
  };
  const mup = (e: MapMouseEvent) => {
    if (!touchActive && primary(e)) onUp(pt(e), false);
  };
  const tstart = (e: MapTouchEvent) => {
    markTouch();
    // Two fingers are always MapLibre's pinch (core/map/userGesture.ts).
    if (isMultiTouch(e)) return onCancel();
    onDown(pt(e), true);
  };
  const tmove = (e: MapTouchEvent) => {
    if (isMultiTouch(e)) return onCancel();
    onMove(pt(e));
  };
  const tend = (e: MapTouchEvent) => {
    onUp(pt(e), true);
    releaseTouch();
  };
  const tcancel = () => {
    onCancel();
    releaseTouch();
  };

  // Snapping to marks measures on screen: lend the model this map's projection.
  model.bindProjector((g) => map.project([g.lng, g.lat]));

  map.on("mousedown", mdown);
  map.on("mousemove", mmove);
  map.on("mouseup", mup);
  map.on("touchstart", tstart);
  map.on("touchmove", tmove);
  map.on("touchend", tend);
  map.on("touchcancel", tcancel);

  return () => {
    if (touchOffTimer) clearTimeout(touchOffTimer);
    if (captured) map.dragPan.enable();
    model.bindProjector(null);
    map.off("mousedown", mdown);
    map.off("mousemove", mmove);
    map.off("mouseup", mup);
    map.off("touchstart", tstart);
    map.off("touchmove", tmove);
    map.off("touchend", tend);
    map.off("touchcancel", tcancel);
  };
}
