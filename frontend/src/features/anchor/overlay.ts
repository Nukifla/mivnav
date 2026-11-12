// The anchor watch on the chart: the swing track, the watch circle, the rode
// line and the anchor itself — one GeoJSON source, layers filtered by `kind`
// (measure/overlay.ts's pattern). See anchor.md §3.3.
//
// The circle is an OUTLINE plus an inner edge band, never a wash — an area
// overlay must stay subordinate to the chart (the notices lesson: "it takes
// over everything"). The one exception is the alarm: a dragging anchor is
// small and urgent, so the circle fills faintly red while it alarms.
//
// Colour is the WATCH STATE, not decoration: accent while all is well,
// orange on a plugin warning, alarm-red while it alarms. The reds are fixed
// across palettes (same family as every alarm token — colors.ts' reasoning
// for ROUTE_WARNING); the calm state follows the palette's overlay accent.

import type { Feature, FeatureCollection } from "geojson";
import type { ExpressionSpecification, GeoJSONSource, Map as MLMap } from "maplibre-gl";
import type { Accessor } from "solid-js";
import type { Anchor } from "../../core/signalk";
import type { GeoPoint } from "../../core/chrome/geo";
import { ANCHOR_ALARM, overlayColors, ROUTE_WARNING, type Palette } from "../../core/style/colors";
import { Z, type Overlay } from "../../core/layers/overlay";
import { addLayer } from "../../core/layers/addLayer";
import { anchorPoint, anchorUrgency, circleRing } from "./model";
import type { TrackFix } from "./client";

const SOURCE = "anchor";
const TRACK_LAYER_ID = "anchor-track";
const FILL_LAYER_ID = "anchor-watch-fill";
const BAND_LAYER_ID = "anchor-watch-band";
const RING_LAYER_ID = "anchor-watch-ring";
const RODE_LAYER_ID = "anchor-rode";
const ICON_LAYER_ID = "anchor-icon";

/** Bottom to top — the order here IS the stacking (MapView re-hoists it). */
export const ANCHOR_LAYER_IDS = [
  TRACK_LAYER_ID,
  FILL_LAYER_ID,
  BAND_LAYER_ID,
  RING_LAYER_ID,
  RODE_LAYER_ID,
  ICON_LAYER_ID,
] as const;

export type WatchTone = "ok" | "warn" | "alarm";

export function watchTone(a: Anchor | null): WatchTone {
  const u = anchorUrgency(a);
  // An ACKed alarm is `notice` to the chrome but still a dragging anchor on
  // the chart — the circle stays red until the plugin says it is over.
  if (a?.alarm && (a.alarm.state === "alarm" || a.alarm.state === "emergency")) return "alarm";
  return u === "notice" ? "warn" : "ok";
}

function toneColor(tone: WatchTone, palette: Palette): string {
  if (tone === "alarm") return ANCHOR_ALARM;
  if (tone === "warn") return ROUTE_WARNING;
  return overlayColors(palette).accent;
}

const KIND = { track: "track", circle: "circle", rode: "rode", anchor: "anchor" } as const;
const isKind = (kind: string): ExpressionSpecification => ["==", ["get", "kind"], kind];

export interface AnchorScene {
  anchor: Anchor | null;
  boat: GeoPoint | null;
  /** The swing track since the drop, oldest first — the plugin's minute
   * fixes plus this screen's live tail. */
  track: readonly TrackFix[];
}

/**
 * The whole scene as one FeatureCollection. Pure, so the geometry is tested
 * without a map. Nothing at all while the anchor is up: the past swing is
 * not a thing to keep drawing once you have left.
 */
export function anchorFeatures(scene: AnchorScene): FeatureCollection {
  const at = anchorPoint(scene.anchor);
  if (!at) return { type: "FeatureCollection", features: [] };
  const features: Feature[] = [];

  // One segment per pair, each carrying `f` = 0 (oldest) … 1 (newest), so
  // the line can fade with age — "am I swinging or dragging" at a glance.
  const fixes = scene.track;
  for (let i = 1; i < fixes.length; i++) {
    const a = fixes[i - 1]!;
    const b = fixes[i]!;
    features.push({
      type: "Feature",
      properties: { kind: KIND.track, f: fixes.length > 2 ? (i - 1) / (fixes.length - 2) : 1 },
      geometry: { type: "LineString", coordinates: [[a[0], a[1]], [b[0], b[1]]] },
    });
  }

  const radius = scene.anchor?.maxRadiusM;
  if (radius !== undefined && radius > 0) {
    const ring = circleRing(at, radius);
    features.push({
      type: "Feature",
      properties: { kind: KIND.circle },
      geometry: { type: "Polygon", coordinates: [ring] },
    });
  }

  if (scene.boat) {
    features.push({
      type: "Feature",
      properties: { kind: KIND.rode },
      geometry: { type: "LineString", coordinates: [[scene.boat.lng, scene.boat.lat], [at.lng, at.lat]] },
    });
  }

  features.push({
    type: "Feature",
    properties: { kind: KIND.anchor },
    geometry: { type: "Point", coordinates: [at.lng, at.lat] },
  });
  return { type: "FeatureCollection", features };
}

// -- the anchor glyph -------------------------------------------------------

const RATIO = 2;
const ICON_PX = 22;
const PAD = 2;
/** Lucide's `anchor` (ISC), the same glyph the Layers panel and POI
 * anchorage use, so an anchor reads as one thing across the app. */
const ANCHOR_PATHS = ["M12 6v16", "m19 13 2-1a9 9 0 0 1-18 0l2 1", "M9 11h6"];

const iconId = (tone: WatchTone) => `anchor-glyph-${tone}`;

function glyph(color: string, halo: string): ImageData {
  const el = document.createElement("canvas");
  el.width = ICON_PX * RATIO;
  el.height = ICON_PX * RATIO;
  const ctx = el.getContext("2d")!;
  ctx.scale(RATIO, RATIO);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const k = (ICON_PX - PAD * 2) / 24;
  ctx.translate(PAD, PAD);
  ctx.scale(k, k);
  const p = new Path2D();
  for (const d of ANCHOR_PATHS) p.addPath(new Path2D(d));
  p.moveTo(14, 4);
  p.arc(12, 4, 2, 0, Math.PI * 2);
  ctx.strokeStyle = halo;
  ctx.lineWidth = 4.2 / k;
  ctx.stroke(p);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.2 / k;
  ctx.stroke(p);
  return ctx.getImageData(0, 0, el.width, el.height);
}

function putGlyphs(map: MLMap, palette: Palette): void {
  const halo = overlayColors(palette).markerHalo;
  for (const tone of ["ok", "warn", "alarm"] as const) {
    const id = iconId(tone);
    if (map.hasImage(id)) map.removeImage(id);
    map.addImage(id, glyph(toneColor(tone, palette), halo), { pixelRatio: RATIO });
  }
}

// -- layers -------------------------------------------------------------------

function ensureAnchorLayers(map: MLMap, palette: Palette): void {
  if (!map.getSource(SOURCE)) {
    map.addSource(SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  }
  if (!map.hasImage(iconId("ok"))) putGlyphs(map, palette);
  const layer = (spec: Parameters<MLMap["addLayer"]>[0]) => {
    if (!map.getLayer(spec.id)) addLayer(map, spec);
  };
  const c = overlayColors(palette);

  layer({
    id: TRACK_LAYER_ID,
    type: "line",
    source: SOURCE,
    filter: isKind(KIND.track),
    // Butt, not round: the track is one segment per pair at partial
    // opacity, and round caps overlap at every joint into a dotted line.
    layout: { "line-cap": "butt", "line-join": "round" },
    paint: {
      "line-color": c.accent,
      "line-width": 1.5,
      "line-opacity": ["interpolate", ["linear"], ["get", "f"], 0, 0.15, 1, 0.85],
    },
  });
  layer({
    id: FILL_LAYER_ID,
    type: "fill",
    source: SOURCE,
    filter: isKind(KIND.circle),
    paint: { "fill-color": ANCHOR_ALARM, "fill-opacity": 0 },
  });
  // The inner edge band: a wide, faint stroke offset INTO the circle (the
  // ring runs clockwise, so positive offset is inward). ECDIS style — the
  // circle reads as an area without painting over the soundings in it.
  layer({
    id: BAND_LAYER_ID,
    type: "line",
    source: SOURCE,
    filter: isKind(KIND.circle),
    paint: { "line-color": c.accent, "line-width": 6, "line-offset": 3, "line-opacity": 0.22 },
  });
  layer({
    id: RING_LAYER_ID,
    type: "line",
    source: SOURCE,
    filter: isKind(KIND.circle),
    paint: { "line-color": c.accent, "line-width": 2 },
  });
  // Dashed and thin: the rode is an estimate of where the chain lies, not
  // a thing on the chart (measure's "a question, not a thing" dash).
  layer({
    id: RODE_LAYER_ID,
    type: "line",
    source: SOURCE,
    filter: isKind(KIND.rode),
    layout: { "line-cap": "round" },
    paint: { "line-color": c.accent, "line-width": 1.5, "line-dasharray": [2, 2], "line-opacity": 0.8 },
  });
  layer({
    id: ICON_LAYER_ID,
    type: "symbol",
    source: SOURCE,
    filter: isKind(KIND.anchor),
    layout: {
      "icon-image": iconId("ok"),
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
  });
}

/** Colour every layer for the watch's tone. A paint swap, never a rebuild —
 * guarded per layer for a style-reload beat where one is momentarily gone. */
function applyAnchorPaint(map: MLMap, palette: Palette, tone: WatchTone): void {
  const color = toneColor(tone, palette);
  const set = (id: string, prop: string, value: unknown) => {
    if (map.getLayer(id)) map.setPaintProperty(id, prop, value);
  };
  set(RING_LAYER_ID, "line-color", color);
  set(BAND_LAYER_ID, "line-color", color);
  set(RODE_LAYER_ID, "line-color", color);
  set(TRACK_LAYER_ID, "line-color", overlayColors(palette).accent);
  set(FILL_LAYER_ID, "fill-opacity", tone === "alarm" ? 0.12 : 0);
  if (map.getLayer(ICON_LAYER_ID)) map.setLayoutProperty(ICON_LAYER_ID, "icon-image", iconId(tone));
}

export function createAnchorOverlay(scene: Accessor<AnchorScene>): Overlay {
  let lastPalette: Palette | undefined;
  return {
    id: "anchor",
    layerIds: ANCHOR_LAYER_IDS,
    z: Z.anchor,
    ensure(map, ctx) {
      // A style reload rebuilds the layers in the calm colour; re-apply the
      // live tone here, since the paint effect only re-runs on its own deps.
      const palette = ctx.settings().palette;
      ensureAnchorLayers(map, palette);
      applyAnchorPaint(map, palette, watchTone(scene().anchor));
    },
    update(map) {
      // Read BEFORE the source guard (measure-overlay.md): a guard that
      // short-circuits the read leaves this effect with no dependencies.
      const data = anchorFeatures(scene());
      const source = map.getSource(SOURCE) as GeoJSONSource | undefined;
      source?.setData(data);
    },
    paint(map, ctx) {
      const palette = ctx.settings().palette;
      const tone = watchTone(scene().anchor);
      if (palette !== lastPalette) {
        lastPalette = palette;
        putGlyphs(map, palette);
      }
      applyAnchorPaint(map, palette, tone);
    },
  };
}
