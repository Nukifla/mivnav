// The route-test overlay: the candidate line, its two ends, and the
// distance — same GeoJSON-source-plus-layers shape as measure/overlay.ts
// (see that file's header for why this is not SVG and not a MapView base
// overlay). Solid, not dashed, unlike Measure's ruler: this line stands in
// for an actual candidate route, not a question about distance.

import type { FeatureCollection } from "geojson";
import type {
  ExpressionSpecification,
  GeoJSONSource,
  ImageSource,
  Map as MLMap,
} from "maplibre-gl";
import type { RouteTestModel } from "./index";
import type { GeoPoint } from "../../core/chrome/geo";
import { formatRangeStr } from "../../core/format";
import { groupApproximateRuns, type DebugField, type PlanResult } from "../../core/routing";
import { TEXT_FONT } from "../../core/style/expr";
import {
  CONSTRAINT_CLASS_COLORS,
  CONSTRAINT_CLASS_FALLBACK,
  DEBUG_BBOX_LINE,
  DEBUG_HAZARD_FILL,
  DEBUG_HAZARD_LINE,
  DEBUG_MACRO_WAYPOINT,
  DEBUG_MACRO_WAYPOINT_HALO,
  FIELD_CELL_RGBA,
  FIELD_ENDPOINT_STROKE,
  FIELD_GOAL_HEX,
  FIELD_GOAL_RGB,
  FIELD_START_HEX,
  FIELD_START_RGB,
  haloPaint,
  overlayColors,
  ROUTE_WARNING,
  ROUTE_WARNING_CONTRAST,
  type Palette,
} from "../../core/style/colors";
import { Z, type Overlay } from "../../core/layers/overlay";
import { addLayer } from "../../core/layers/addLayer";

const SOURCE = "route-test";
const LINE_LAYER_ID = "route-test-line";
// The APPROXIMATE run(s) — one or more straight-line stand-ins for water
// the search couldn't actually verify (`PlanResult.approximateLegs`,
// `core/routing.ts`'s `groupApproximateRuns`). Dashed and warning-coloured,
// its own layer so it never picks up `LINE_LAYER_ID`'s solid accent paint.
const WARN_LAYER_ID = "route-test-warn-line";
const POINTS_LAYER_ID = "route-test-points";
const LABEL_LAYER_ID = "route-test-label";
// One small badge per contiguous run of `PlanResult.checkManuallyLegs` —
// "needs a human's own judgement: crosses charted UNSARE (unsurveyed)
// water, or a BRIDGE this boat can't clear closed but that can
// mechanically open" (see `chartcore::routing::hazards`' own module-doc
// notes: both are soft preferences now, never a hard hazard, so this is
// purely informational — never dashed/warning-line-styled the way an
// APPROXIMATE run is). A filled circle plus a plain text glyph, not an
// image sprite: a real icon belongs to the eventual route-editor UI this
// probe stands in for (see this file's own header), not this throwaway
// debug layer — but a bare text-only glyph read as a flat black blob with
// no theme-aware fill under it (measured live), so a coloured circle
// backing it is the minimum needed to actually stand out against the
// chart, not a cosmetic upgrade.
const CHECK_MANUALLY_CIRCLE_LAYER_ID = "route-test-check-manually-circle";
const CHECK_MANUALLY_LAYER_ID = "route-test-check-manually";

// The DEBUG layer (#owqqcdqe, 2026-08-10, `PlanResult.debugLegs`/
// `debugMacroWaypoints`) — a SEPARATE source from the route line's own
// (below LINE_LAYER_ID/WARN_LAYER_ID in the z-order list, so the real
// route always reads on top of the geometry that produced it): the exact
// hazard rings each search avoided, the exact box each search looked in,
// and — when a macro detour was used — its own raw, coarse waypoints.
const DEBUG_SOURCE = "route-test-debug";
const DEBUG_HAZARD_FILL_ID = "route-test-debug-hazard-fill";
const DEBUG_HAZARD_LINE_ID = "route-test-debug-hazard-line";
const DEBUG_BBOX_LAYER_ID = "route-test-debug-bbox";
const DEBUG_MACRO_LAYER_ID = "route-test-debug-macro";
// The `"mivnav"` fine-search failure payload (`find_artifact_route_debug`,
// backend): the constraint set a rejected coarse-stitch leg was built
// against, class by class, and a raster of its search grid — "what was
// used, and what area was considered". Constraint rings ride the shared
// `DEBUG_SOURCE`; the grid is its own `image` source (a per-plan canvas).
const DEBUG_CONSTRAINT_FILL_ID = "route-test-debug-constraint-fill";
const DEBUG_CONSTRAINT_LINE_ID = "route-test-debug-constraint-line";
// The RAW `from`/`to` of every rejected leg (`find_artifact_route_debug`'s
// own `from`/`to`) — plotted regardless of whether that end actually
// snapped, unlike the field raster's `startCell`/`goalCell` markers, which
// are absent exactly on a `start_blocked`/`goal_blocked` leg (`nearest_
// walkable` found nothing to mark). For a coarse-stitch recovery leg this
// is also the only way to tell which corridor is whose: `start`/`to` here
// can be an interior PORTAL point, not either of the two points the user
// actually tapped.
const DEBUG_LEG_ENDPOINT_LAYER_ID = "route-test-debug-leg-endpoint";
// `_stitch_mivnav_coarse_route` (backend/mivnav/features/routing/routes.py)
// allows AT MOST one recovery skip per stitch — its own docstring: "One
// recovery only... A SECOND failure fails the stitch" — so `debug_legs` can
// never carry more than 2 entries (the leg that first failed, and the one
// recovery attempt). A field-per-leg POOL of exactly that size, not one
// shared source: two failing legs are two DIFFERENT corridors (different
// goals, different extents), and picking only "the first with a grid" — the
// original single-source design — silently hid whichever leg's goal sits
// under the point the user is actually looking at. See jt for the report
// that caught this: a leg's field showed open water under the rejected
// endpoint because it was a DIFFERENT leg's field on screen.
const DEBUG_FIELD_POOL_SIZE = 2;
const DEBUG_FIELD_SOURCE = (i: number) => `route-test-debug-field-${i}`;
const DEBUG_FIELD_LAYER_ID = (i: number) => `route-test-debug-field-${i}`;

/** Bottom to top — MapView re-hoists in this order. See measure/overlay.ts's
 * header for why this list must stay in `MapView.wireMap`'s re-hoist set. */
export const ROUTE_TEST_LAYER_IDS = [
  ...Array.from({ length: DEBUG_FIELD_POOL_SIZE }, (_, i) => DEBUG_FIELD_LAYER_ID(i)),
  DEBUG_CONSTRAINT_FILL_ID,
  DEBUG_CONSTRAINT_LINE_ID,
  DEBUG_HAZARD_FILL_ID,
  DEBUG_HAZARD_LINE_ID,
  DEBUG_BBOX_LAYER_ID,
  DEBUG_LEG_ENDPOINT_LAYER_ID,
  LINE_LAYER_ID,
  WARN_LAYER_ID,
  DEBUG_MACRO_LAYER_ID,
  POINTS_LAYER_ID,
  LABEL_LAYER_ID,
  CHECK_MANUALLY_CIRCLE_LAYER_ID,
  CHECK_MANUALLY_LAYER_ID,
] as const;

// `["match", ["get","class"], "hard", <hex>, …, <fallback>]` — the fill /
// line colour for a constraint-ring feature, driven by its `class`
// property. Hues live in `style/colors.ts` (`CONSTRAINT_CLASS_COLORS`).
const constraintColorExpr = (): ExpressionSpecification =>
  [
    "match",
    ["get", "class"],
    ...Object.entries(CONSTRAINT_CLASS_COLORS).flatMap(([k, v]) => [k, v]),
    CONSTRAINT_CLASS_FALLBACK,
  ] as unknown as ExpressionSpecification;

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

const KIND = {
  end: "end",
  leg: "leg",
  warn: "warn",
  label: "label",
  checkManually: "checkManually",
} as const;
const isKind = (kind: string): ExpressionSpecification => ["==", ["get", "kind"], kind];

// The debug source's own three kinds — a separate GeoJSON source from the
// route line's (`DEBUG_SOURCE`, not `SOURCE`), so clearing/rebuilding one
// on every plan never has to touch the other's own feature list.
const DEBUG_KIND = {
  hazard: "hazard",
  bbox: "bbox",
  macro: "macro",
  constraint: "constraint",
  legEndpoint: "legEndpoint",
} as const;
const isDebugKind = (kind: string): ExpressionSpecification => ["==", ["get", "kind"], kind];

// A 1×1 transparent PNG — the placeholder image the field source is
// created with before a plan has produced a real grid. `updateImage`
// swaps in the per-plan canvas; an empty/absent grid swaps this back.
const BLANK_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
// A tiny but non-degenerate quad (≈110 m, off Null Island): MapLibre's
// ImageSource derives a centre tile zoom from the quad's extent, and a
// zero-area [0,0]×4 gives -log(0) = Infinity → "x=Infinity … outside of
// bounds" thrown on every placeholder load. The PNG is transparent, so
// where the quad sits doesn't matter.
const BLANK_COORDS: [[number, number], [number, number], [number, number], [number, number]] = [
  [0, 0.001],
  [0.001, 0.001],
  [0.001, 0],
  [0, 0],
];

export function ensureRouteTestLayers(map: MLMap, palette: Palette): void {
  if (!map.getSource(SOURCE)) map.addSource(SOURCE, { type: "geojson", data: EMPTY });
  if (!map.getSource(DEBUG_SOURCE)) map.addSource(DEBUG_SOURCE, { type: "geojson", data: EMPTY });
  for (let i = 0; i < DEBUG_FIELD_POOL_SIZE; i++) {
    if (!map.getSource(DEBUG_FIELD_SOURCE(i))) {
      map.addSource(DEBUG_FIELD_SOURCE(i), {
        type: "image",
        url: BLANK_PNG,
        coordinates: BLANK_COORDS,
      });
    }
  }
  const c = overlayColors(palette);

  const layer = (spec: Parameters<MLMap["addLayer"]>[0]) => {
    if (!map.getLayer(spec.id)) addLayer(map, spec);
  };

  // The rejected fine-search legs' own cell grids (`find_artifact_route_
  // debug`) — one canvas per pool slot, painted so open water is
  // transparent and only what blocked or penalised the search shows.
  // Bottom of the stack: the constraint rings and the route line read
  // over it.
  for (let i = 0; i < DEBUG_FIELD_POOL_SIZE; i++) {
    layer({
      id: DEBUG_FIELD_LAYER_ID(i),
      type: "raster",
      source: DEBUG_FIELD_SOURCE(i),
      paint: { "raster-opacity": 0.85, "raster-resampling": "nearest", "raster-fade-duration": 0 },
    });
  }

  // The constraint set that leg was built against, one translucent fill +
  // outline per class, colour-coded (`CONSTRAINT_COLORS`). This is the
  // "what constraints are used" half of the ask — you can see whether
  // `charted_depth` actually covers the gap, where `coverage` ends, and
  // so on.
  layer({
    id: DEBUG_CONSTRAINT_FILL_ID,
    type: "fill",
    source: DEBUG_SOURCE,
    filter: isDebugKind(DEBUG_KIND.constraint),
    paint: { "fill-color": constraintColorExpr(), "fill-opacity": 0.14 },
  });
  layer({
    id: DEBUG_CONSTRAINT_LINE_ID,
    type: "line",
    source: DEBUG_SOURCE,
    filter: isDebugKind(DEBUG_KIND.constraint),
    paint: { "line-color": constraintColorExpr(), "line-width": 1.2, "line-opacity": 0.9 },
  });

  // Translucent fill + a crisp outline for the real hazard geometry the
  // search avoided — the fill alone reads as a vague blob at a chart's
  // usual zoom, the outline is what lets a coastline-hugging edge be
  // judged precisely against the route line drawn over it.
  layer({
    id: DEBUG_HAZARD_FILL_ID,
    type: "fill",
    source: DEBUG_SOURCE,
    filter: isDebugKind(DEBUG_KIND.hazard),
    paint: { "fill-color": DEBUG_HAZARD_FILL, "fill-opacity": 0.25 },
  });
  layer({
    id: DEBUG_HAZARD_LINE_ID,
    type: "line",
    source: DEBUG_SOURCE,
    filter: isDebugKind(DEBUG_KIND.hazard),
    paint: { "line-color": DEBUG_HAZARD_LINE, "line-width": 1, "line-opacity": 0.8 },
  });

  // The box each real search actually looked in — one rectangle per leg
  // searched (several, stacked, for a macro-stitched route), dashed so it
  // never reads as a chart feature.
  layer({
    id: DEBUG_BBOX_LAYER_ID,
    type: "line",
    source: DEBUG_SOURCE,
    filter: isDebugKind(DEBUG_KIND.bbox),
    paint: { "line-color": DEBUG_BBOX_LINE, "line-width": 1, "line-dasharray": [3, 2], "line-opacity": 0.9 },
  });

  // A rejected leg's raw `from`/`to`, coloured to match the field raster's
  // own start/goal markers (`FIELD_START_HEX`/`FIELD_GOAL_HEX`) — a thin
  // white ring so a `role: "to"` marker sitting exactly on a `goal_blocked`
  // leg's own snapped-elsewhere point (or on nothing, when the whole grid
  // was too large to serialise) is still visible against the raster under
  // it.
  layer({
    id: DEBUG_LEG_ENDPOINT_LAYER_ID,
    type: "circle",
    source: DEBUG_SOURCE,
    filter: isDebugKind(DEBUG_KIND.legEndpoint),
    paint: {
      "circle-radius": 5,
      "circle-color": ["match", ["get", "role"], "to", FIELD_GOAL_HEX, FIELD_START_HEX],
      "circle-stroke-width": 1.5,
      "circle-stroke-color": FIELD_ENDPOINT_STROKE,
    },
  });

  layer({
    id: LINE_LAYER_ID,
    type: "line",
    source: SOURCE,
    filter: isKind(KIND.leg),
    layout: { "line-cap": "round" },
    paint: { "line-color": c.accent, "line-width": 3 },
  });

  // The approximate stub(s): dashed, warning-coloured, same width as the
  // real line so it reads as "still the route" rather than a different
  // feature — only the dash + colour say "this part is a guess".
  layer({
    id: WARN_LAYER_ID,
    type: "line",
    source: SOURCE,
    filter: isKind(KIND.warn),
    layout: { "line-cap": "round" },
    paint: {
      "line-color": ROUTE_WARNING,
      "line-width": 3,
      "line-dasharray": [2, 1.5],
    },
  });

  // A macro-route waypoint (only present when a macro-scale detour was
  // actually used): a distinct violet diamond-ish ring, deliberately NOT
  // `c.accent` (the route's own colour) — this is the coarse, land-only
  // guide the fine search was stitched along, not a waypoint of the
  // final route itself, and conflating the two is exactly the confusion
  // this layer exists to resolve.
  layer({
    id: DEBUG_MACRO_LAYER_ID,
    type: "circle",
    source: DEBUG_SOURCE,
    filter: isDebugKind(DEBUG_KIND.macro),
    paint: {
      "circle-radius": 6,
      "circle-color": DEBUG_MACRO_WAYPOINT,
      "circle-stroke-width": 2,
      "circle-stroke-color": DEBUG_MACRO_WAYPOINT_HALO,
    },
  });

  layer({
    id: POINTS_LAYER_ID,
    type: "circle",
    source: SOURCE,
    filter: isKind(KIND.end),
    paint: {
      "circle-radius": 5,
      "circle-color": c.accent,
      "circle-stroke-width": 2,
      "circle-stroke-color": c.halo,
    },
  });

  layer({
    id: LABEL_LAYER_ID,
    type: "symbol",
    source: SOURCE,
    filter: isKind(KIND.label),
    layout: {
      "text-field": ["get", "text"],
      "text-font": TEXT_FONT,
      "text-size": 12,
      "text-offset": [0, -0.9],
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    },
    paint: {
      "text-color": c.accent,
      ...haloPaint(palette, c.halo),
    },
  });

  // One badge per contiguous "check manually" run — see
  // `CHECK_MANUALLY_LAYER_ID`'s own docs. A solid `ROUTE_WARNING` circle
  // (not `c.accent`: this is a caution about the CHART, not the route
  // line's own colour, same fixed-amber convention `WARN_LAYER_ID`
  // already uses for an approximate run) with a fixed white stroke/glyph
  // — bare text alone read as a flat black blob with no colour under it,
  // so the filled circle IS the "pop", not a decoration on top of one.
  layer({
    id: CHECK_MANUALLY_CIRCLE_LAYER_ID,
    type: "circle",
    source: SOURCE,
    filter: isKind(KIND.checkManually),
    paint: {
      "circle-radius": 9,
      "circle-color": ROUTE_WARNING,
      "circle-stroke-width": 2,
      "circle-stroke-color": ROUTE_WARNING_CONTRAST,
    },
  });
  layer({
    id: CHECK_MANUALLY_LAYER_ID,
    type: "symbol",
    source: SOURCE,
    filter: isKind(KIND.checkManually),
    layout: {
      // A single "?" glyph, not an emoji: this renders through the SAME
      // SDF text pipeline `text-color` below actually controls — an
      // emoji glyph rendered flat black regardless of `text-color`
      // (measured live), which is the bug this whole badge redesign
      // exists to fix.
      "text-field": "?",
      "text-font": TEXT_FONT,
      "text-size": 13,
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    },
    paint: {
      "text-color": ROUTE_WARNING_CONTRAST,
    },
  });
}

export function applyRouteTestPaint(map: MLMap, palette: Palette): void {
  const c = overlayColors(palette);
  const set = (id: string, prop: string, value: unknown) => {
    if (map.getLayer(id)) map.setPaintProperty(id, prop, value);
  };
  set(LINE_LAYER_ID, "line-color", c.accent);
  set(POINTS_LAYER_ID, "circle-color", c.accent);
  set(POINTS_LAYER_ID, "circle-stroke-color", c.halo);
  set(LABEL_LAYER_ID, "text-color", c.accent);
  const glow = haloPaint(palette, c.halo);
  set(LABEL_LAYER_ID, "text-halo-color", glow["text-halo-color"] ?? c.halo);
  set(LABEL_LAYER_ID, "text-halo-width", glow["text-halo-width"] ?? 0);
  set(LABEL_LAYER_ID, "text-halo-blur", glow["text-halo-blur"] ?? 0);
}

/** Push the current probe into the (ensured) source. Reads the model
 * BEFORE the `getSource` guard — see measure/overlay.ts's
 * `updateMeasureData` for why that order, not this one, is load-bearing. */
export function updateRouteTestData(map: MLMap, model: RouteTestModel | undefined): void {
  const from = model?.from();
  const to = model?.to();
  const result = model?.result();

  const source = map.getSource(SOURCE) as GeoJSONSource | undefined;
  if (!source) return;

  const features: FeatureCollection["features"] = [];

  for (const end of [from, to]) {
    if (!end) continue;
    features.push({
      type: "Feature",
      properties: { kind: KIND.end },
      geometry: { type: "Point", coordinates: [end.lng, end.lat] },
    });
  }

  if (from && to) {
    // The real returned path once one exists — which bends around charted
    // danger, not just the two tapped points — falling back to the plain
    // two-point line while still waiting on it. See mivnav/features/
    // routing/routes.py: `result.waypoints` is a real hazard-avoiding
    // route now, not a placeholder straight line. Any run flagged
    // APPROXIMATE (the router couldn't actually verify that stretch —
    // `result.approximateLegs`, which can land anywhere along the route,
    // not only at an end) draws on its own dashed, warning-coloured
    // layer instead of the ordinary line.
    const toLine = (pts: readonly GeoPoint[]): [number, number][] => pts.map((w) => [w.lng, w.lat]);
    if (result) {
      for (const run of groupApproximateRuns(result.waypoints, result.approximateLegs)) {
        if (run.points.length < 2) continue;
        features.push({
          type: "Feature",
          properties: { kind: run.approximate ? KIND.warn : KIND.leg },
          geometry: { type: "LineString", coordinates: toLine(run.points) },
        });
      }
    } else {
      features.push({
        type: "Feature",
        properties: { kind: KIND.leg },
        geometry: {
          type: "LineString",
          coordinates: [
            [from.lng, from.lat],
            [to.lng, to.lat],
          ],
        },
      });
    }
    if (result) {
      features.push({
        type: "Feature",
        properties: { kind: KIND.label, text: formatRangeStr(result.distanceNm) },
        geometry: {
          type: "Point",
          coordinates: [(from.lng + to.lng) / 2, (from.lat + to.lat) / 2],
        },
      });
      // One badge per contiguous "check manually" run, at that run's own
      // midpoint — `groupApproximateRuns` is a generic "group by a
      // per-leg boolean" helper despite its name (see its own docs), so
      // it's reused as-is for `checkManuallyLegs` rather than duplicated.
      for (const run of groupApproximateRuns(result.waypoints, result.checkManuallyLegs)) {
        if (!run.approximate) continue;
        // The run's own first/last point averaged, not a middle VERTEX —
        // a run is as short as one leg (two points, no middle vertex to
        // pick), and this is a coarse marker position, not a geometrically
        // exact midpoint of a possibly-bent multi-leg run.
        const first = run.points[0]!;
        const last = run.points[run.points.length - 1]!;
        features.push({
          type: "Feature",
          properties: { kind: KIND.checkManually },
          geometry: {
            type: "Point",
            coordinates: [(first.lng + last.lng) / 2, (first.lat + last.lat) / 2],
          },
        });
      }
    }
  }

  source.setData({ type: "FeatureCollection", features });

  updateRouteTestDebugData(map, result);
}

/** Push `result`'s own debug geometry (`PlanResult.debugLegs`/
 * `debugMacroWaypoints` — present only when `planRoute` was called with
 * `debug: true`, which `features/routeTest`'s own `runPlan` always does)
 * into the debug source, separate from the route line's own — see
 * `DEBUG_SOURCE`'s own docs for why. A `result` with no debug fields at
 * all (the fetch hasn't landed yet, or failed) clears the source rather
 * than leaving a stale overlay from a PREVIOUS probe on screen. */
function updateRouteTestDebugData(map: MLMap, result: PlanResult | null | undefined): void {
  const source = map.getSource(DEBUG_SOURCE) as GeoJSONSource | undefined;
  if (!source) return;

  const features: FeatureCollection["features"] = [];

  // A GeoJSON linear ring must be explicitly closed (first === last);
  // chartcore's rings are implicitly closed, so close a copy here.
  const closedRing = (pts: { lng: number; lat: number }[]): [number, number][] => {
    const coords = pts.map((p) => [p.lng, p.lat] as [number, number]);
    const first = coords[0]!;
    const last = coords[coords.length - 1]!;
    if (first[0] !== last[0] || first[1] !== last[1]) coords.push(first);
    return coords;
  };

  for (const leg of result?.debugLegs ?? []) {
    if (leg.bbox) {
      const [w, s, e, n] = leg.bbox;
      features.push({
        type: "Feature",
        properties: { kind: DEBUG_KIND.bbox },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [w, s],
              [e, s],
              [e, n],
              [w, n],
              [w, s],
            ],
          ],
        },
      });
    }
    for (const ring of leg.hazardRings ?? []) {
      if (ring.length < 3) continue;
      features.push({
        type: "Feature",
        properties: { kind: DEBUG_KIND.hazard },
        geometry: { type: "Polygon", coordinates: [closedRing(ring)] },
      });
    }
    for (const [cls, rings] of Object.entries(leg.constraintRings ?? {})) {
      for (const ring of rings) {
        if (ring.length < 3) continue;
        features.push({
          type: "Feature",
          properties: { kind: DEBUG_KIND.constraint, class: cls },
          geometry: { type: "Polygon", coordinates: [closedRing(ring)] },
        });
      }
    }
    for (const [role, pt] of [
      ["from", leg.from],
      ["to", leg.to],
    ] as const) {
      if (!pt) continue;
      features.push({
        type: "Feature",
        properties: { kind: DEBUG_KIND.legEndpoint, role },
        geometry: { type: "Point", coordinates: [pt.lng, pt.lat] },
      });
    }
  }

  for (const wp of result?.debugMacroWaypoints ?? []) {
    features.push({
      type: "Feature",
      properties: { kind: DEBUG_KIND.macro },
      geometry: { type: "Point", coordinates: [wp.lng, wp.lat] },
    });
  }

  source.setData({ type: "FeatureCollection", features });
  updateRouteTestFieldImage(map, result);
}

/** Paint every debug leg that carries a search grid onto its own pool slot
 * (`DEBUG_FIELD_POOL_SIZE` sources — see that constant's docs for why more
 * than one leg can be live at once and why each needs its own image rather
 * than sharing one). An unfilled slot — no corresponding leg, or that leg's
 * grid was empty/too large — swaps the blank image back in rather than
 * leaving a previous probe's raster on screen. */
function updateRouteTestFieldImage(map: MLMap, result: PlanResult | null | undefined): void {
  const fields: DebugField[] = (result?.debugLegs ?? [])
    .map((leg) => leg.field)
    .filter((f): f is DebugField => f != null && f.codes.length > 0);

  for (let i = 0; i < DEBUG_FIELD_POOL_SIZE; i++) {
    const src = map.getSource(DEBUG_FIELD_SOURCE(i)) as ImageSource | undefined;
    if (!src) continue;

    const field = fields[i];
    if (!field) {
      src.updateImage({ url: BLANK_PNG, coordinates: BLANK_COORDS });
      continue;
    }

    const { cols, rows, codes } = field;
    const canvas = document.createElement("canvas");
    canvas.width = cols;
    canvas.height = rows;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) continue;
    const img = ctx2d.createImageData(cols, rows);
    for (let j = 0; j < cols * rows; j++) {
      const [r, g, b, a] = FIELD_CELL_RGBA[codes[j] ?? 0] ?? FIELD_CELL_RGBA[0]!;
      img.data[j * 4] = r;
      img.data[j * 4 + 1] = g;
      img.data[j * 4 + 2] = b;
      img.data[j * 4 + 3] = a;
    }
    // The snapped start/goal cells, painted opaque so they stand out in the
    // raster even where the surrounding water is transparent. A `null` cell
    // (the search's own `nearest_walkable` found nothing at all, e.g. this
    // is the `goal_blocked` leg) leaves that marker off rather than drawing
    // one at (0,0).
    for (const [cell, rgb] of [
      [field.startCell, FIELD_START_RGB],
      [field.goalCell, FIELD_GOAL_RGB],
    ] as const) {
      if (!cell) continue;
      const [cx, cy] = cell;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
          const k = (y * cols + x) * 4;
          img.data[k] = rgb[0]!;
          img.data[k + 1] = rgb[1]!;
          img.data[k + 2] = rgb[2]!;
          img.data[k + 3] = 255;
        }
      }
    }
    ctx2d.putImageData(img, 0, 0);
    src.updateImage({ url: canvas.toDataURL(), coordinates: field.corners });
  }
}

export function createRouteTestOverlay(model: RouteTestModel | undefined): Overlay {
  return {
    id: "route-test",
    layerIds: ROUTE_TEST_LAYER_IDS,
    // Same tier as Measure: an actively-held interactive test tool, above
    // AIS so a target can't eat its taps. The two are mutually exclusive in
    // practice (one chart mode at a time), so the exact order between them
    // doesn't matter beyond both being above the safety-relevant stack.
    z: Z.measure,
    ensure(map, ctx) {
      ensureRouteTestLayers(map, ctx.settings().palette);
    },
    update(map) {
      updateRouteTestData(map, model);
    },
    paint(map, ctx) {
      applyRouteTestPaint(map, ctx.settings().palette);
    },
  };
}
