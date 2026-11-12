// Touch answer to the cursor readout; rubber-bands from a fixed anchor and a
// tap locks the far end. See docs/architecture/measure.md (README #6, #5, #7).

import { createMemo, createSignal, type Accessor } from "solid-js";
import { knotsFromMs } from "../../core/cpa";
import type { SignalKState } from "../../core/signalk";
import { bearingDeg, type GeoPoint, rangeNm } from "../../core/chrome/geo";
import { isHelmish } from "../../core/chrome/registry";
import { formatDuration } from "../../core/format";
import { defineFeature, type AppFeature } from "../../core/chrome/feature";
import { createMeasureOverlay } from "./overlay";
import { measureCommands } from "./commands";

/** A resolved measurement. Null until there are two ends to measure between. */
export interface MeasureLeg {
  from: GeoPoint;
  to: GeoPoint;
  brgDeg: number;
  rangeNm: number;
}

export interface MeasureModel {
  /** The `from` end: the boat when `fromBoat`, else the first tap. */
  a: Accessor<GeoPoint | null>;
  /** The far end: locked point once tapped, else the live pointer (`hover`). */
  b: Accessor<GeoPoint | null>;
  fromBoat: Accessor<boolean>;
  leg: Accessor<MeasureLeg | null>;
  /** Live pointer pushed by `MapView`: mouse, or map centre under the fixed
   * touch crosshair. Null when off-chart or mode is left. */
  hover: (at: GeoPoint | null) => void;
  /**
   * Pin from InfoPanel.tsx's "Measure" action: fixed `A`, `fromBoat` off.
   * Seeds STATE not the mode, so entering "measure" after can't wipe it.
   */
  seed: (point: GeoPoint) => void;
}

/**
 * Speed floor for the time-to-go, knots. Not `cpa.ts`'s stopped-threshold —
 * this just stops the pill printing `Infinity min` at the dock.
 */
const MIN_SOG_KN = 0.2;

export function createMeasure(signalk: SignalKState): { feature: AppFeature; model: MeasureModel } {
  const [tappedA, setTappedA] = createSignal<GeoPoint | null>(null);
  const [placedB, setPlacedB] = createSignal<GeoPoint | null>(null);
  const [hovered, setHovered] = createSignal<GeoPoint | null>(null);
  const [fromBoat, setFromBoat] = createSignal(true);
  const [pinnedA, setPinnedA] = createSignal<GeoPoint | null>(null);
  // Nothing is measured outside the mode. `fromBoat` stays on between uses,
  // and without this gate the boat end — a ring — was drawn on the boat at
  // all times, following the raw fix while the own-ship icon (deadbanded at
  // rest) did not: a second boat marker drifting beside the real one.
  const [active, setActive] = createSignal(false);

  const boat = (): GeoPoint | null => {
    const self = signalk.self();
    return self ? { lng: self.lng, lat: self.lat } : null;
  };

  // `a` is DERIVED, not stored: the end tracks the boat live so range
  // shortens as you close the mark, rather than freezing at entry position.
  const a = createMemo(() =>
    !active() ? null : fromBoat() ? boat() : (pinnedA() ?? tappedA()),
  );

  // Live pointer only once there is an anchor, so a stray `hover` before the
  // first `A` is tapped doesn't paint a lone ring chasing the cursor.
  const b = createMemo(() => placedB() ?? (a() ? hovered() : null));

  const leg = createMemo<MeasureLeg | null>(() => {
    const from = a();
    const to = b();
    if (!from || !to) return null;
    return { from, to, brgDeg: bearingDeg(from, to), rangeNm: rangeNm(from, to) };
  });

  const clear = () => {
    setPinnedA(null);
    setTappedA(null);
    setPlacedB(null);
  };

  const seed = (point: GeoPoint) => {
    setFromBoat(false);
    setPinnedA(point);
    setTappedA(null);
    setPlacedB(null);
  };

  const model: MeasureModel = { a, b, fromBoat, leg, hover: setHovered, seed };

  const feature = defineFeature({
    id: "measure",
    overlay: createMeasureOverlay(model),
    commands: measureCommands,
    modes: [
      {
        id: "measure",
        label: "Measure",
        enter: () => {
          clear();
          setActive(true);
        },
        // A mode owns its state, so leaving must drop it — no stale line from
        // a measurement of somewhere you no longer are.
        leave: () => {
          clear();
          setActive(false);
        },
        hint: () =>
          fromBoat() || pinnedA()
            ? placedB()
              ? "Tap to measure elsewhere · Clear to go live"
              : fromBoat()
                ? "Aim to measure from the boat · tap to lock"
                : "Aim to measure from here · tap to lock"
            : !tappedA()
              ? "Tap the first point"
              : !placedB()
                ? "Aim the second point · tap to lock"
                : "Tap again to start a new measurement",
        onClick: (click) => {
          // Lock where the pointer IS, not the raw tap: on touch the far end
          // lives under the fixed crosshair, not the finger. Raw click is
          // only the fallback before the pointer has reported.
          const pt = hovered() ?? { lng: click.lngLat.lng, lat: click.lngLat.lat };
          if (fromBoat() || pinnedA()) setPlacedB(pt);
          // Uses `placedB`, not `b`: `b` is the live rubber-band and would
          // read "complete" the moment the pointer moved after the first tap.
          else if (!tappedA() || placedB()) {
            setTappedA(pt);
            setPlacedB(null);
          } else setPlacedB(pt);
          return true;
        },
        pill: (ctx) => {
          const l = leg();
          const sogKn = knotsFromMs(signalk.self()?.sogMs ?? 0);
          const ttg = l
            ? formatDuration((l.rangeNm / Math.max(sogKn, MIN_SOG_KN)) * 3600)
            : undefined;
          return {
            // At `helm` density, time alone: the status has ~60px there, not
            // enough for speed too without ellipsizing (see architecture doc).
            status: ttg && (isHelmish(ctx.density) ? ttg : `${ttg} at ${sogKn.toFixed(1)} kn`),
            actions: [
              {
                id: "boat",
                label: "From boat",
                kind: "toggle",
                on: fromBoat(),
                disabled: !boat(),
                run: () => {
                  setFromBoat((v) => !v);
                  clear();
                },
              },
              {
                id: "clear",
                label: "Clear",
                disabled: !pinnedA() && !tappedA() && !placedB(),
                run: clear,
              },
            ],
          };
        },
      },
    ],
  });

  return { feature, model };
}
