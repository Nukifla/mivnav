// `desktopOnly` tracks `pointerCoarse`, not screen width: gloves mean no
// hover regardless of screen size (invariant #10 — no media query can see a
// glove). ./measure.ts is the touch-device answer: same bearing/range, by tapping.

import { createSignal, type Accessor } from "solid-js";
import type { SignalKState } from "../signalk";
import { bearingDeg, rangeNm, type GeoPoint } from "./geo";
import { formatRange, padDeg } from "../format";
import { defineFeature, type AppFeature } from "./feature";

export interface CursorModel {
  /** Where the pointer is on the chart, or null when it is not over it. */
  at: Accessor<GeoPoint | null>;
  set(at: GeoPoint | null): void;
}

/** The cursor's two instruments, plus the state MapView pushes into. */
export function createCursor(signalk: SignalKState): { feature: AppFeature; model: CursorModel } {
  const [at, set] = createSignal<GeoPoint | null>(null);

  /** Both readings, or null when there is nothing to measure from or to. A boat
   * with no fix has no bearing to anything; that is a state, not an error. */
  const fix = (): { brgDeg: number; rangeNm: number } | null => {
    const to = at();
    const self = signalk.self();
    if (!to || !self) return null;
    const from: GeoPoint = { lng: self.lng, lat: self.lat };
    return { brgDeg: bearingDeg(from, to), rangeNm: rangeNm(from, to) };
  };

  const feature = defineFeature({
    id: "cursor",
    instruments: [
      {
        id: "cursor.brg",
        short: "BRG",
        label: "Cursor bearing",
        // A pointer is not a hazard; this grant is the ceiling `urgencyOf` clamps to (invariant #2).
        maxUrgency: "none",
        desktopOnly: true,
        read: () => {
          const f = fix();
          return f
            ? { value: padDeg(f.brgDeg), unit: "°T", sub: "fr. ship" }
            : { value: "– – –", unit: "°T", sub: "hover", state: "null" };
        },
      },
      {
        id: "cursor.rng",
        short: "RNG",
        label: "Cursor range",
        maxUrgency: "none",
        desktopOnly: true,
        read: () => {
          const f = fix();
          if (!f) return { value: "– –", unit: "nm", sub: "hover", state: "null" };
          const r = formatRange(f.rangeNm);
          return { value: r.value, unit: r.unit, sub: "fr. ship" };
        },
      },
    ],
  });

  return { feature, model: { at, set } };
}
