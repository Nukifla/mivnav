// Where the chart is looking when you open it, and the rule for when we are
// allowed to decide that. DOM-free, so the state machine is pinnable against
// a Map double (initialView.test.ts); MapView.tsx wires it up.

import { createEffect, onCleanup, untrack, type Accessor } from "solid-js";
import type maplibregl from "maplibre-gl";
import type { ChartSet } from "./catalog";
import { hasFix } from "./layers/aisSymbols";
import { coerceFiniteNumber, deviceSetting } from "./persist";
import type { Vessel } from "./signalk";

/** Zoom for a device's first-ever fix: ~21 m/px at 56°N, roughly the next 1-2
 * hours of sailing — deep enough to navigate by, shallow enough to still be
 * a chart. Only the FIRST answer; the crew's own zoom is remembered after. */
export const DEFAULT_ZOOM = 12;

const AUTO = { mivnavAuto: true };

interface CameraEvent {
  mivnavAuto?: boolean;
  originalEvent?: unknown;
}

interface Camera {
  lng: number;
  lat: number;
  zoom: number;
}

/** Union of the sets' [w, s, e, n] bounds, if any. */
export function catalogBounds(sets: ChartSet[]): maplibregl.LngLatBoundsLike | undefined {
  if (sets.length === 0) return undefined;
  const [w, s, e, n] = sets[0].bounds;
  const union: [number, number, number, number] = [w, s, e, n];
  for (const { bounds: b } of sets.slice(1)) {
    union[0] = Math.min(union[0], b[0]);
    union[1] = Math.min(union[1], b[1]);
    union[2] = Math.max(union[2], b[2]);
    union[3] = Math.max(union[3], b[3]);
  }
  return union;
}

export interface InitialViewOptions {
  /** True once the map has fired 'load' — nothing may move the camera before. */
  loaded: Accessor<boolean>;
  /** Enabled chart sets; their union is the no-fix fallback view. */
  sets: Accessor<ChartSet[]>;
  /** Own vessel, or null until the boat has a fix. */
  self: Accessor<Vessel | null>;
}

/**
 * Open centred on the boat at the remembered zoom; fall back to the catalog
 * bounds when there's no fix yet, and never move the camera again once it
 * has been placed deliberately. Full rationale (the arrival-order state
 * machine, the "deliberate" test): docs/architecture/initial-view.md.
 *
 * Must be called under a reactive owner; the caller owns the map.
 */
export function createInitialView(map: maplibregl.Map, opts: InitialViewOptions): void {
  // jumpTo({zoom: null}) is a black screen, so corrupt storage is coerced here.
  const [zoom, setZoom] = deviceSetting<number>("zoom", {
    coerce: (raw) => coerceFiniteNumber(raw, DEFAULT_ZOOM),
  });

  const sample = (): Camera => {
    const { lng, lat } = map.getCenter();
    return { lng, lat, zoom: map.getZoom() };
  };
  const same = (a: Camera, b: Camera) => a.lng === b.lng && a.lat === b.lat && a.zoom === b.zoom;

  let placed = sample();
  let claimed = false;

  // MapLibre also fires moveend from resize() with no originalEvent and no
  // camera change, hence comparing the sampled camera, not a bare tag.
  const onMoveEnd = (event: CameraEvent) => {
    const now = sample();
    if (!claimed && !event.mivnavAuto && (event.originalEvent !== undefined || !same(now, placed))) {
      claimed = true;
    }
    placed = now;
    if (claimed) setZoom(now.zoom);
  };
  map.on("moveend", onMoveEnd);
  onCleanup(() => map.off("moveend", onMoveEnd));

  type Source = "none" | "catalog" | "boat";
  let source: Source = "none";

  // One effect, not two: Solid re-subscribes deps every run, so two effects
  // sharing `loaded` could race and let the catalog win over the boat.
  createEffect(() => {
    const boat = opts.self();
    if (!opts.loaded() || claimed || source === "boat") return;
    if (boat && hasFix(boat)) {
      source = "boat";
      // untrack: zoom is an input to placement, not a reason to re-place on
      // every mouse-wheel change.
      map.jumpTo({ center: [boat.lng, boat.lat], zoom: untrack(zoom) }, AUTO);
      return;
    }
    // Reached on every delta until a fix arrives, so must stay idempotent.
    if (source !== "none") return;
    const bounds = catalogBounds(opts.sets());
    if (!bounds) return;
    source = "catalog";
    map.fitBounds(bounds, { padding: 32, animate: false }, AUTO);
  });
}
