// Autopilot feature — no longer reserved chrome, but its safety property
// holds: `alerts()` scans instruments only (ap.status can't alarm), and only
// widgets built HERE can reach the controller. See
// docs/architecture/autopilot-ui-safety.md.

import { defineFeature, type AppFeature } from "../../core/chrome/feature";
import type { Instrument, Reading } from "../../core/chrome/registry";
import { defineWidget } from "../../core/chrome/widget";
import { createAutopilotController, type AutopilotController } from "../../core/autopilot";
import type { SignalKState } from "../../core/signalk";
import { padDeg } from "../../core/format";
import { apControlCell, apMode, apRudderCell, isWind } from "./ui";

export interface AutopilotDeps {
  /** The one SignalK state — the read half (`autopilot`/`status`/`self`). */
  signalk: SignalKState;
  /** The COMMAND half. Injected only by tests (a mock/spy); the app omits it and
   * the controller is built here, wired to `signalk`. */
  controller?: AutopilotController;
}

/**
 * Build the autopilot feature. `App.tsx` calls `createAutopilot({ signalk })`
 * once and drops the returned `AppFeature` into its `features` array (after the
 * routes feature, so the page order comes out Nav, Route, Pilot).
 */
export function createAutopilot(deps: AutopilotDeps): AppFeature {
  const { signalk } = deps;

  // Built here (not App.tsx) so only these feature-provided widgets can close
  // over the controller — a generic user-added widget never can.
  const controller =
    deps.controller ??
    createAutopilotController({
      status: signalk.status,
      // The CONFIRMED target the adjust path accumulates from and reconciles
      // against — the same `targetDeg` the readouts show. `wind` tells the
      // controller the target is a signed wind ANGLE, so it wraps correctly.
      target: () => signalk.autopilot()?.targetDeg,
      wind: () => isWind(signalk.autopilot()?.mode),
    });

  // Rail status readout. `maxUrgency:"none"` keeps it invisible to `alerts()`.
  // Listing `ap.status` FIRST on the pilot page below is what resolves a
  // tap's tile→tab mapping to the Pilot tab.
  const apStatus: Instrument = {
    id: "ap.status",
    short: "AP",
    label: "Autopilot",
    band: "rail",
    maxUrgency: "none",
    read: (): Reading => {
      const mode = apMode(signalk.status(), signalk.autopilot());
      const ap = signalk.autopilot();
      // A dropped link / unreported engaged is "cannot tell", not disengaged —
      // never painted as a live pilot. `state:"null"` greys it like a dead read.
      if (mode === "unknown") return { value: "— —", state: "null" };
      if (mode === "standby") return { value: "STBY", sub: ap?.mode?.toUpperCase() };
      const t = ap?.targetDeg;
      const target = t !== undefined && Number.isFinite(t) ? `${padDeg(t)}°` : "AUTO";
      return { value: target, sub: `AUTO${ap?.mode ? ` · ${ap.mode.toUpperCase()}` : ""}` };
    },
  };

  const cell = (id: string, label: string): Instrument => ({
    id,
    short: "AP",
    label,
    maxUrgency: "none",
    read: (): Reading => ({ value: "" }),
  });

  // The control set and the rudder bar — `deletable:false` since they ARE the
  // pilot surface (can only be taken off a tab, never deleted). `wide:true`
  // spans both columns of the board's grid, matching the old reserved card.
  const apControl = defineWidget({
    id: "ap.control",
    kind: "static",
    label: "Autopilot control",
    maxUrgency: "none",
    spec: [],
    deletable: false,
    wide: true,
    build: (id) => cell(id, "Autopilot control"),
    render: apControlCell(signalk, controller),
  });

  const apRudder = defineWidget({
    id: "ap.rudder",
    kind: "static",
    label: "Rudder angle",
    maxUrgency: "none",
    spec: [],
    deletable: false,
    wide: true,
    build: (id) => cell(id, "Rudder angle"),
    render: apRudderCell(signalk),
  });

  return defineFeature({
    id: "autopilot",
    instruments: [apStatus],
    widgets: [apControl, apRudder],
    dashboard: [
      { id: "pilot", label: "Pilot", instruments: ["ap.status", "ap.control", "ap.rudder"] },
    ],
  });
}
