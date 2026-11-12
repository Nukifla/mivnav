// A pinned DOM marker: centred on a geographic point (or the viewport
// centre), re-projected as the chart moves. See docs/architecture/map-marker.md
// for the safety-relevant positioning bug this primitive exists to prevent.

import {
  createMemo,
  createRenderEffect,
  createSignal,
  onCleanup,
  Show,
  type Accessor,
  type JSX,
} from "solid-js";

/**
 * The slice of MapLibre a marker needs, and nothing more: project a point to
 * container pixels, and tell us when the camera moved. `maplibregl.Map`
 * satisfies this structurally, and so does a plain test double.
 */
export interface MapMarkerMap {
  project(lngLat: { lng: number; lat: number }): { x: number; y: number };
  on(type: "move" | "zoom", listener: () => void): void;
  off(type: "move" | "zoom", listener: () => void): void;
}

/** Which point of the marker's box sits on the coordinate — MapLibre's
 * `maplibregl.Marker` anchor names, same meaning. */
export type MarkerAnchor =
  | "center"
  | "top"
  | "bottom"
  | "left"
  | "right"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

/** anchor -> the %-translate that puts THAT corner/edge of the box on the point.
 * `center` is the default and by far the common case (a symmetric ring/crosshair
 * drawn around its point). */
const ANCHOR_TRANSLATE: Record<MarkerAnchor, [number, number]> = {
  center: [-50, -50],
  top: [-50, 0],
  bottom: [-50, -100],
  left: [0, -50],
  right: [-100, -50],
  "top-left": [0, 0],
  "top-right": [-100, 0],
  "bottom-left": [0, -100],
  "bottom-right": [-100, -100],
};

/** The CSS `transform` that centres (per `anchor`) and then applies a pixel
 * `offset`. Pure, so a test can read it without a DOM. */
export function markerTransform(anchor?: MarkerAnchor, offset?: [number, number]): string {
  const [ax, ay] = ANCHOR_TRANSLATE[anchor ?? "center"];
  const base = `translate(${ax}%, ${ay}%)`;
  return offset ? `${base} translate(${offset[0]}px, ${offset[1]}px)` : base;
}

/** `position: "absolute"` is INLINE on purpose (beats any class a caller
 * passes) — see docs/architecture/map-marker.md. No `width`/`height`/
 * `display`, so the root shrink-wraps and `-50%` centring lands on point. */
export function markerRootStyle(
  place: { left: string; top: string },
  transform: string,
): JSX.CSSProperties {
  return {
    position: "absolute",
    left: place.left,
    top: place.top,
    transform,
  };
}

export interface MapMarkerPositionProps {
  /** The map to project against. Required unless `screenAnchored`. */
  map?: MapMarkerMap;
  /** The point to pin to, read live so a marker can follow a moving subject.
   * `undefined` places nothing (the marker renders no element). */
  lngLat?: Accessor<{ lng: number; lat: number } | undefined>;
  /** Nail to the viewport centre instead of a geographic point — the compact
   * "pan to aim" crosshairs. No projection, no move subscription. */
  screenAnchored?: boolean;
  /** A reactive pixel offset from the viewport centre, `screenAnchored`
   * only — see docs/architecture/map-marker.md for what non-zero callers
   * pass and why it must be read live. */
  screenOffset?: Accessor<[number, number]>;
}

/** Headless placement: container-pixel `left`/`top` for the marker,
 * recomputed as the camera moves. Must be called under a reactive owner;
 * separated from the component so it's unit-testable against a map double. */
export function createMarkerPosition(
  props: MapMarkerPositionProps,
): Accessor<{ left: string; top: string } | undefined> {
  // `equals: false` so every "camera moved" fires a recompute regardless of
  // value. Subscribe to `zoom` too (not just `move`) so the map double need
  // not model MapLibre firing `move` during a zoom.
  const [moved, bump] = createSignal(undefined, { equals: false });
  const map = props.map;
  if (!props.screenAnchored && map) {
    const onMove = () => bump(undefined);
    // Subscribe ONLY while there is a point: idle permanently-mounted markers
    // (../MapView.tsx) were reprojecting every pan/zoom frame for nothing.
    // See docs/architecture/map-marker.md for the memo/render-effect reasons.
    const hasPoint = createMemo(() => !!props.lngLat?.());
    createRenderEffect(() => {
      if (!hasPoint()) return;
      map.on("move", onMove);
      map.on("zoom", onMove);
      onCleanup(() => {
        map.off("move", onMove);
        map.off("zoom", onMove);
      });
    });
  }

  return createMemo(() => {
    if (props.screenAnchored) {
      // `calc` keeps the 50% base (so left/top track a resizing container)
      // and adds the pixel offset per axis — a zero axis stays plain "50%",
      // never `calc(50% + 0px)`, matching what existing callers relied on.
      const [dx, dy] = props.screenOffset?.() ?? [0, 0];
      const axis = (d: number): string => (d === 0 ? "50%" : `calc(50% + ${d}px)`);
      return { left: axis(dx), top: axis(dy) };
    }
    const p = props.lngLat?.();
    if (!p || !map) return undefined;
    moved(); // subscribe: reproject on every camera move
    const { x, y } = map.project(p);
    return { left: `${x}px`, top: `${y}px` };
  });
}

export interface MapMarkerProps extends MapMarkerPositionProps {
  /** Centre this point of the box on the coordinate. Default `center`. */
  anchor?: MarkerAnchor;
  /** Pixel nudge applied after anchoring — MapLibre `Marker` offset semantics
   * (e.g. `[20, -20]` to sit a badge up-and-right of a handle). */
  offset?: [number, number];
  /** Classes for the root — pointer-events, z-index, etc. Positioning is NOT a
   * caller concern and cannot be overridden (see `markerRootStyle`). */
  class?: string;
  children?: JSX.Element;
}

/**
 * A DOM marker pinned to `lngLat` (or the viewport centre, `screenAnchored`),
 * with `children` as its content. The root is always absolutely positioned and
 * shrink-wrapped; it re-projects as the chart moves.
 */
export function MapMarker(props: MapMarkerProps): JSX.Element {
  const place = createMarkerPosition(props);
  return (
    <Show when={place()}>
      {(p) => (
        <div class={props.class} style={markerRootStyle(p(), markerTransform(props.anchor, props.offset))}>
          {props.children}
        </div>
      )}
    </Show>
  );
}
