// Region-draw mode: two-tap bounding boxes for the Regions settings section.
// Second chart-mode seam after Measure (`core/chrome/modes.ts`); see
// docs/architecture/region-draw.md for the two-taps-not-drag rationale.

import { createMemo, createSignal, type Accessor } from "solid-js";
import type { GeoPoint } from "../../core/chrome/geo";
import { defineFeature, type AppFeature } from "../../core/chrome/feature";
import type { BBox } from "../../core/settings/regions";
import { createRegionDrawOverlay } from "./overlay";

/** The rectangle two corners define, always normalised (min < max on both
 * axes regardless of which corner was tapped first). */
export interface RegionDrawRect {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

/** Pure — no map, no DOM. Exported so it is asserted on its own. */
export function rectFromCorners(a: GeoPoint, b: GeoPoint): RegionDrawRect {
  return {
    minLon: Math.min(a.lng, b.lng),
    minLat: Math.min(a.lat, b.lat),
    maxLon: Math.max(a.lng, b.lng),
    maxLat: Math.max(a.lat, b.lat),
  };
}

const bboxFromRect = (r: RegionDrawRect): BBox => ({
  min_lon: r.minLon,
  min_lat: r.minLat,
  max_lon: r.maxLon,
  max_lat: r.maxLat,
});

const isDegenerate = (r: RegionDrawRect): boolean => !(r.minLon < r.maxLon) || !(r.minLat < r.maxLat);

export interface RegionDrawStartOptions {
  /** Already-saved boxes for context; never mutated by this feature. */
  existing: readonly BBox[];
  /** Fires exactly once, when "Done" ends the session with at least one
   * committed box — never on Cancel, and never with zero boxes. */
  onDone: (boxes: BBox[]) => void;
}

export interface RegionDrawModel {
  /** First tapped corner of the box in progress, null before/after it. */
  corner: Accessor<GeoPoint | null>;
  /** Live rubber-band rectangle — `corner` to the pointer — same posture as
   * Measure's `leg`. */
  preview: Accessor<RegionDrawRect | null>;
  /** Boxes THIS session has already committed, not yet handed to `onDone`. */
  committed: Accessor<readonly BBox[]>;
  /** Context boxes passed to the current `start` call. */
  existing: Accessor<readonly BBox[]>;
  /** Live pointer, pushed by the wiring (`MapView`), exactly like Measure's
   * `hover` — only fed while this mode is active. */
  hover: (at: GeoPoint | null) => void;
  /** Enter the mode, arm a ONE-SHOT completion callback (`regions.tsx`'s
   * "Draw on map" actions are the only callers). */
  start: (opts: RegionDrawStartOptions) => void;
  /** App.tsx wires this to `modes.enter("region-draw")`. */
  bindEnter(fn: () => void): void;
  /** App.tsx wires this to `modes.leave()` — Cancel/Done both go through it,
   * so there is exactly one exit path. */
  bindExit(fn: () => void): void;
  /** App.tsx wires this to reopen Settings, fired on every exit (not just
   * the happy path). */
  bindLeft(fn: () => void): void;
}

export function createRegionDraw(): { feature: AppFeature; model: RegionDrawModel } {
  const [corner, setCorner] = createSignal<GeoPoint | null>(null);
  const [hovered, setHovered] = createSignal<GeoPoint | null>(null);
  const [committed, setCommitted] = createSignal<readonly BBox[]>([]);
  const [existing, setExisting] = createSignal<readonly BBox[]>([]);
  let onDone: ((boxes: BBox[]) => void) | null = null;
  let enterFn: (() => void) | null = null;
  let exitFn: (() => void) | null = null;
  let leftFn: (() => void) | null = null;

  const preview = createMemo<RegionDrawRect | null>(() => {
    const c = corner();
    const h = hovered();
    return c && h ? rectFromCorners(c, h) : null;
  });

  // Clears corner/hover/committed only — NOT `existing`, which `start` seeds
  // just before this runs and must survive it.
  const clear = () => {
    setCorner(null);
    setHovered(null);
    setCommitted([]);
  };

  const start = (opts: RegionDrawStartOptions) => {
    onDone = opts.onDone;
    setExisting(opts.existing);
    enterFn?.();
  };

  const model: RegionDrawModel = {
    corner,
    preview,
    committed,
    existing,
    hover: setHovered,
    start,
    bindEnter: (fn) => (enterFn = fn),
    bindExit: (fn) => (exitFn = fn),
    bindLeft: (fn) => (leftFn = fn),
  };

  const feature = defineFeature({
    id: "region-draw",
    overlay: createRegionDrawOverlay(model),
    modes: [
      {
        id: "region-draw",
        label: "Draw region box",
        // `hidden` (registry.ts): enterable/pill-bearing but excluded from
        // `modeList()`'s button row — reachable only via `start`, above.
        hidden: true,
        enter: clear,
        // Runs on EVERY exit, not only a confirmed "Done" — a cancelled
        // session must not leak into a later, unrelated entry.
        leave: () => {
          clear();
          setExisting([]);
          onDone = null;
          leftFn?.();
        },
        hint: () =>
          corner()
            ? "Tap the opposite corner"
            : committed().length > 0
              ? "Tap a corner to draw another box · Done to finish"
              : "Tap a corner of the box",
        onClick: (click) => {
          const pt = { lng: click.lngLat.lng, lat: click.lngLat.lat };
          const first = corner();
          if (!first) {
            setCorner(pt);
            return true;
          }
          const rect = rectFromCorners(first, pt);
          // A degenerate tap (the same point twice) stays waiting for a real
          // opposite corner rather than committing a zero-area box.
          if (isDegenerate(rect)) return true;
          setCommitted((bs) => [...bs, bboxFromRect(rect)]);
          setCorner(null);
          return true;
        },
        pill: () => ({
          status:
            committed().length > 0
              ? `${committed().length} box${committed().length === 1 ? "" : "es"} drawn`
              : corner()
                ? "Tap the opposite corner"
                : "Tap a corner of the box",
          actions: [
            {
              id: "done",
              label: "Done",
              // Zero boxes: acts like Cancel rather than firing a vacuous
              // `onDone([])` a caller would have to special-case.
              run: () => {
                const boxes = committed();
                if (boxes.length > 0) onDone?.([...boxes]);
                exitFn?.();
              },
            },
            { id: "cancel", label: "Cancel", run: () => exitFn?.() },
          ],
        }),
      },
    ],
  });

  return { feature, model };
}
