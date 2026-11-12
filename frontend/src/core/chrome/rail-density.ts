// The rail/launcher density table — a leaf so `Rail.tsx` and `Launcher.tsx`
// can both read it without importing each other. Density is a SETTING, not a
// breakpoint (invariant #10), continuous via `lerpDensity` over PLAIN NUMBERS
// (px) — Tailwind's arbitrary-value scanner can't see a runtime `n`.
//
// Rail width ADDS `env(safe-area-inset-right)` rather than subtracting it, so
// the inset pushes tiles clear of a landscape notch instead of shaving them.

import { lerpDensity, type Density } from "./registry";

interface DensityMetrics {
  railWidth: number;
  tilePadX: number;
  tilePadTop: number;
  tilePadBottom: number;
  label: number;
  value: number;
  unit: number;
  sub: number;
  button: number;
  icon: number;
  grip: number;
}

// Two endpoints `lerpDensity` interpolates between.
const DESK: DensityMetrics = {
  railWidth: 54,
  tilePadX: 2,
  tilePadTop: 3,
  tilePadBottom: 4,
  label: 8,
  value: 16,
  unit: 8,
  sub: 7.5,
  button: 30,
  icon: 14,
  grip: 22,
};
const HELM: DensityMetrics = {
  railWidth: 84,
  tilePadX: 3,
  tilePadTop: 7,
  tilePadBottom: 8,
  label: 9.5,
  value: 26,
  unit: 10,
  sub: 9,
  button: 46,
  icon: 20,
  grip: 34,
};

export interface RailDensity {
  /** Rail width in px, without the edge inset. */
  railWidthPx: number;
  /** Rail width as a `calc()` CSS value, WITH the edge inset — the rail's own
   * outer-edge width. */
  railWidthCss: string;
  tilePadding: { x: number; top: number; bottom: number };
  label: number;
  value: number;
  unit: number;
  sub: number;
  button: number;
  /** Already a plain number — a lucide `size` prop, never a Tailwind class. */
  icon: number;
  grip: number;
}

export function railDensity(density: Density): RailDensity {
  const t = (field: keyof DensityMetrics) => lerpDensity(DESK[field], HELM[field], density);
  const railWidthPx = t("railWidth");
  return {
    railWidthPx,
    railWidthCss: `calc(${railWidthPx}px + env(safe-area-inset-right))`,
    tilePadding: { x: t("tilePadX"), top: t("tilePadTop"), bottom: t("tilePadBottom") },
    label: t("label"),
    value: t("value"),
    unit: t("unit"),
    sub: t("sub"),
    button: t("button"),
    icon: t("icon"),
    grip: t("grip"),
  };
}
