// Which point the panel is talking about, and when to move the chart to show
// it. DOM-free/map-free: behaviour here, pixels in InfoMarker.tsx, wiring in
// ../info/attach.tsx — see docs/architecture/info-marker-warp.md.

import {
  createMemo,
  createSignal,
  createRenderEffect,
  on,
  createEffect,
  onCleanup,
  untrack,
  type Accessor,
} from "solid-js";
// Type-only: keeps this file free of the DOM/Kobalte/panel rendering.
import type { ObscuredEdges } from "../chrome/Sheet";
import { userGestureActive } from "../map/userGesture";
import { locateHit } from "./registry";
import type { InfoState } from "./state";
import type { InfoPoint, InfoProvider } from "./types";

/** What the marker needs from the map, and nothing more. */
export interface InfoMarkerMap {
  project(p: InfoPoint): { x: number; y: number };
  /** Container pixels. The marker is placed inside it (../info/attach.tsx). */
  getContainer(): { clientWidth: number; clientHeight: number };
  easeTo(opts: { center: InfoPoint; offset: [number, number]; duration: number }): void;
  on(type: "move", listener: () => void): void;
  off(type: "move", listener: () => void): void;
}

/** How close to the container edge a point may be and still count as shown —
 * the marker is a ~28px symbol drawn *around* its point, so 2px from the
 * edge is a sliver, not an answer to "which one?". */
export const EDGE_MARGIN_PX = 36;

/** Long enough to read as a move rather than a cut; short enough not to make
 * anyone wait. */
const WARP_MS = 300;

export interface Size {
  clientWidth: number;
  clientHeight: number;
}

/** A box in container pixels. */
export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Where a point may sit and still count as shown: container, less info
 * surface, less edge margin. `isPointShown`/`warpOffset` read this ONE rect
 * so they cannot disagree — see docs/architecture/info-marker-warp.md. */
export function visibleRect(size: Size, obscured: ObscuredEdges): Rect {
  const top = Math.max(0, obscured.top ?? 0);
  const bottom = Math.max(top, size.clientHeight - obscured.bottom);
  const midX = size.clientWidth / 2;
  const midY = (top + bottom) / 2;
  return {
    minX: Math.min(EDGE_MARGIN_PX, midX),
    maxX: Math.max(size.clientWidth - EDGE_MARGIN_PX, midX),
    minY: Math.min(top + EDGE_MARGIN_PX, midY),
    maxY: Math.max(bottom - EDGE_MARGIN_PX, midY),
  };
}

/** Is the point somewhere the user can actually see it — given the panel
 * about to talk about it? (Not just the bare viewport.) */
export function isPointShown(
  screen: { x: number; y: number },
  size: Size,
  obscured: ObscuredEdges,
): boolean {
  const rect = visibleRect(size, obscured);
  return (
    Number.isFinite(screen.x) &&
    Number.isFinite(screen.y) &&
    screen.x >= rect.minX &&
    screen.x <= rect.maxX &&
    screen.y >= rect.minY &&
    screen.y <= rect.maxY
  );
}

/** Centre of `visibleRect`. Exported so the info marker and MapView's weather
 * crosshair share ONE definition of "visible middle" (info-marker-warp.md).
 * Exact/unrounded: rounding could nudge it outside a collapsed rect. */
export function visibleCentre(size: Size, obscured: ObscuredEdges): { x: number; y: number } {
  const rect = visibleRect(size, obscured);
  return { x: (rect.minX + rect.maxX) / 2, y: (rect.minY + rect.maxY) / 2 };
}

/** Target for MapLibre's `easeTo` offset. Centres `visibleRect` so a warp
 * always lands somewhere `isPointShown` agrees is shown (see
 * docs/architecture/info-marker-warp.md); a no-op on a clear viewport. */
export function warpOffset(size: Size, obscured: ObscuredEdges): [number, number] {
  const c = visibleCentre(size, obscured);
  return [c.x - size.clientWidth / 2, c.y - size.clientHeight / 2];
}

/** Warp the camera to REVEAL `p` above the obscuring chrome, only if hidden.
 * The one "scroll-if-hidden" rule the three chart cursors share (info
 * marker, weather cursor, measure far end) — see info-marker-warp.md. */
export function warpToReveal(
  map: Pick<InfoMarkerMap, "project" | "getContainer" | "easeTo">,
  p: InfoPoint,
  obscured: ObscuredEdges,
): void {
  // The crew is touching/gesturing the chart: an easeTo would cancel that
  // gesture (core/map/userGesture.ts), and they are already moving the view.
  if (userGestureActive(map)) return;
  const size = map.getContainer();
  if (isPointShown(map.project(p), size, obscured)) return;
  map.easeTo({ center: p, offset: warpOffset(size, obscured), duration: WARP_MS });
}

export interface InfoMarkerOptions {
  state: InfoState;
  providers: readonly InfoProvider[];
  map: InfoMarkerMap;
  /** How much chart the info surface covers right now — the MEASURED coverage
   * (../chrome/Sheet.ts's `measureObscured`), wired in ../info/attach.tsx.
   * A parameter (not an import) so the rule is drivable from a DOM-free test. */
  obscured: Accessor<ObscuredEdges>;
  /** Defer the warp decision until the info surface has SETTLED (default:
   * synchronous) — the sheet ANIMATES open, so an `obscured` read mid-slide
   * would warp against coverage about to change (../info/attach.tsx). */
  afterSettle?: (run: () => void) => void;
}

export interface InfoMarkerModel {
  /** Container pixels for the selected hit's marker, or `undefined` when
   * there's nothing to mark (no panel, or an unplaceable hit). */
  screen: Accessor<{ x: number; y: number } | undefined>;
  /** The selected hit's live position — exported so a test can see the marker
   * follow a ship without a projection in the way. */
  lngLat: Accessor<InfoPoint | undefined>;
}

/** Track the selected hit on the chart; must run under a reactive owner.
 * WARP RULE: only when the point won't be shown once the panel opens, and
 * only on selection change, never because the subject moved (info-marker-warp.md). */
export function createInfoMarker(opts: InfoMarkerOptions): InfoMarkerModel {
  const { state, providers, map } = opts;

  const lngLat = createMemo(() => {
    const hit = state.current();
    if (!hit) return undefined; // closing the panel clears the marker
    // Reads the provider's live source (`locate`), so a vessel's marker
    // follows the vessel with no tick handling here.
    return locateHit(providers, hit);
  });

  // Camera is imperative (MapLibre has no signal for it), so re-project on
  // every move (`equals: false`: "the map moved" carries no value). Only
  // subscribed while there IS a marker, else every frame computes a wasted point.
  const [camera, moved] = createSignal(undefined, { equals: false });
  const onMove = () => moved(undefined);
  const hasPoint = createMemo(() => !!lngLat());
  createRenderEffect(() => {
    if (!hasPoint()) return;
    map.on("move", onMove);
    onCleanup(() => map.off("move", onMove));
  });

  const screen = createMemo(() => {
    const p = lngLat();
    if (!p) return undefined;
    camera();
    return map.project(p);
  });

  createEffect(
    on(
      // The *selection*, not the position. See "The warp rule".
      () => state.current(),
      (hit) => {
        if (!hit) return;
        // Deferred to the settled sheet, since its measured coverage is only
        // true once the open slide has landed (see "The warp rule").
        const settle = opts.afterSettle ?? ((run: () => void) => run());
        settle(() => {
          const p = untrack(lngLat);
          if (!p) return;
          // untrack(opts.obscured): this effect keys on the *selection* — a
          // sheet the user drags taller must not re-warp a chart they're holding.
          warpToReveal(map, p, untrack(opts.obscured));
        });
      },
    ),
  );

  return { screen, lngLat };
}
