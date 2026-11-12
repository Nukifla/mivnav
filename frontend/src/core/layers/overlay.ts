// One interface for every imperative map overlay, and the generic wiring that
// installs, re-hoists and updates them — so `MapView.wireMap` iterates an
// `overlays[]` instead of hand-wiring each of the five (they live outside the
// generated chart style, so each needs re-install/re-hoist after every
// `style.load`).
//
// SAFETY-CRITICAL: the z-stack (own-ship topmost, AIS targets above route,
// measure above AIS targets, weather wash below the seamarks) is enforced by
// `Z` below and MUST stay in sync with it — see
// docs/architecture/overlay-z-stack.md before changing any `z` value.
//
// Modelled on `info/registry.ts`'s `InfoProvider`: a NEW overlay implements
// `ensure`/`update` (+ optional `paint`), picks a `z`, and is added to the
// array in `wireMap` — with ZERO other `wireMap` edits.

import { createEffect } from "solid-js";
import type { Accessor } from "solid-js";
import type { Map as MLMap } from "maplibre-gl";
import type { ChartSettings } from "../style/settings";
import type { SignalKState } from "../signalk";
import type { Density } from "../chrome/registry";
import { ownAndTargets } from "../info/vessel";
import {
  ensureSignalkLayers,
  OWN_SHIP_LAYER_ID,
  SIGNALK_LAYER_IDS,
  updateSignalkData,
} from "./signalkShips";

/**
 * The live inputs every overlay draws from, bundled once so `wireMap` builds
 * one and hands the same reference to every overlay. These are accessors, and an
 * overlay's `update`/`paint` reads only the ones it needs — inside its OWN
 * effect (see `wireOverlays`) — so each overlay subscribes to exactly its
 * signals and no overlay over-subscribes to another's.
 */
export interface OverlayCtx {
  settings: Accessor<ChartSettings>;
  signalk: SignalKState;
  /** Display density, already defaulted to `HELM` — overlays never see `undefined`. */
  density: Accessor<Density>;
}
// The measure/route MODELS are no longer carried on this ctx: their overlays
// (`features/measure/overlay.ts`, `features/route/overlay.ts`) are factories
// that close over the model (the POI/weather pattern), so this kernel interface
// stays feature-agnostic and `layers/overlay.ts` imports no feature. The route
// overlay's `paint` still reads `settings`/`density` from this ctx.

export interface Overlay {
  id: string;
  /** Every layer id this overlay owns, bottom → top. Used for the re-hoist and
   * (future C5) query scoping. */
  layerIds: readonly string[];
  /**
   * Explicit stacking key. Overlays sort by `z` ascending for the top-hoist, so
   * a higher `z` sits higher. A NEGATIVE `z` opts out of the hoist: that overlay
   * self-positions below the seamarks (weather) and is never lifted to the top.
   */
  z: number;
  /** Idempotent: (re-)create sources/layers (or construct+install a custom
   * class) after any style application. Runs untracked from `ensureOverlays`. */
  ensure(map: MLMap, ctx: OverlayCtx): void;
  /** Push data through `setData` (or apply visibility) — never touch the style.
   * Runs in its OWN effect so its tracked reads stay scoped to this overlay. */
  update(map: MLMap, ctx: OverlayCtx): void;
  /** Optional second effect for style-property upkeep the data effect must not
   * carry: route palette/density. Its own effect, own tracked reads. */
  paint?(map: MLMap, ctx: OverlayCtx): void;
}

/**
 * The z-keys, one place, so the safety-critical stack is legible at a glance.
 * Gaps left between them so a future overlay can slot in without renumbering.
 */
export const Z = {
  weather: -10, // NEGATIVE — below the seamarks, excluded from the top-hoist
  satellite: 2, // imagery wash — over the chart, below every annotation/safety
  // overlay. Lowest positive `z`. See docs/architecture/overlay-z-stack.md.
  poiLive: 4, // a plugin's live (online) POI layer — just BELOW the baked
  // POIs: a baked point (with offline details) must win the stack where two
  // ever overlap.
  poi: 5, // OSM POI — above chart/seamarks, below every hoisted safety overlay.
  notices: 10, // Notices to Mariners (features/notices) — above POI (a
  // navigational warning outranks a marina marker), below the past track and
  // everything safety-hoisted above it. A band member: see the doc.
  sectorLights: -5, // NEGATIVE, like weather — follows the "Aids & lights" ENC
  // group's own stack position instead (USER DECISION 2026-07-29); see the doc.
  track: 15, // past track — below route/AIS. DEFAULT only: a Layers-panel drag
  // grip makes it a reorderable-band member (#sonqwmry); see the doc.
  legTable: 19, // the leg table's preview of a saved route (features/legTable)
  // — just under the route display, which may already draw the same line.
  route: 20, // planned route — below AIS targets (traffic must never hide
  // under planning UI); hit-testing is scoped to its own layer ids.
  routeDraw: 21, // the manual route editor's draft (features/routeDraw) —
  // just above the route it may be replacing, still below AIS targets.
  marks: 22, // standalone user marks (features/marks) — small stroked glyphs,
  // no fills. Above the route, below anchor/AIS: traffic stays on top.
  anchor: 25, // anchor watch (features/anchor) — circle, rode, swing track.
  // Above the route, below AIS targets: a boat swinging into your circle
  // must stay visible ON it.
  buddies: 28, // quiet buddies (features/buddies) — just below AIS targets:
  // a remembered position must never sit on top of a live ship.
  ais: 30, // AIS targets + CPA lines — above route, below measure.
  measure: 40,
  regionDraw: 45, // region-editor box preview — above AIS, below own-ship.
  mob: 48, // man-overboard mark (features/mob) — above every other overlay
  // but own-ship: in a recovery nothing may hide where the person went in.
  ownShip: 50, // OWN-SHIP alone — topmost of EVERYTHING. Split from the AIS
  // bundle: `aisOverlay` sits at `ais`, this re-hoists just the own-ship layer.
} as const;

// Only AIS/SignalK lives here — core, safety-critical infra with many
// consumers. The measure/route overlay FACTORIES live in their feature dirs
// and arrive via `props.overlays`; sector-lights' factory lives in
// `features/sector-lights/overlay.ts` and, like weather, stays a MapView
// baseOverlay because its custom WebGL layer is map-lifecycle-coupled.

/** The AIS TARGET layer ids — every SignalK layer EXCEPT own-ship. `aisOverlay`
 * hoists these at `Z.ais` (above route, below measure); own-ship is re-hoisted
 * on top by `ownShipOverlay`. `ensure`/`update` still build and feed the WHOLE
 * bundle (own-ship included) — this split is purely about the STACK, not the
 * data. */
const AIS_TARGET_LAYER_IDS = SIGNALK_LAYER_IDS.filter((id) => id !== OWN_SHIP_LAYER_ID);

/** AIS / SignalK — own ship and targets, symbols, sticks, predictors and CPA.
 * Owns the whole SignalK source/update, but hoists only the TARGET layers at
 * `Z.ais` — above the route (traffic must never hide under planning UI) and
 * below measure. Own-ship is hoisted separately by {@link ownShipOverlay} at
 * `Z.ownShip`, so it alone stays on top — the one boat you must never lose. */
export const aisOverlay: Overlay = {
  id: "signalk",
  layerIds: AIS_TARGET_LAYER_IDS,
  z: Z.ais,
  ensure(map) {
    ensureSignalkLayers(map);
  },
  update(map, ctx) {
    const { self, targets } = ownAndTargets(ctx.signalk.vessels());
    // The boat's collision settings ride with the snapshot: every screen
    // colours and draws CPA lines by the same thresholds the alarm uses.
    const settings = { ...ctx.settings(), collision: ctx.signalk.collisionSettings() };
    // "cannot tell" is `null` — a frozen snapshot behind a dropped link must
    // not paint an engaged AP target line (link is the only liveness signal).
    const connected = ctx.signalk.status() === "connected";
    const ap = connected ? ctx.signalk.autopilot() : null;
    // `showAisTargets` off empties OTHER vessels only — self stays visible,
    // exactly as `ownShipOverlay` promises. The one gate; no separate hook.
    // The same link gate greys own ship: behind a dropped SignalK or mivnav
    // link its position is the last one heard, and must not read as live.
    updateSignalkData(map, self, settings.showAisTargets ? targets : [], settings, ap, !connected);
  },
};

/** OWN-SHIP's place in the stack — TOPMOST of everything. Hoist-only: the
 *  layer is created/fed by {@link aisOverlay} (one SignalK source/update, so
 *  scenePush's single `setData` stays intact); this only re-hoists it. */
export const ownShipOverlay: Overlay = {
  id: "signalk-own-ship",
  layerIds: [OWN_SHIP_LAYER_ID],
  z: Z.ownShip,
  ensure() {},
  update() {},
};

// The weather overlay's factory (`createWeatherOverlay`) and the sector-lights
// overlay factory (`createSectorLightsOverlay`) now live with their feature
// modules (`features/weather/overlay.ts`, `features/sector-lights/overlay.ts`)
// so this kernel overlay interface imports no feature — MapView imports both
// from there and keeps them baseOverlays because their machinery (weather's
// double-buffer/wind-flow, sector-lights' custom WebGL layer) is
// map-lifecycle-coupled. Their `z` keys (`Z.weather`, `Z.sectorLights`) stay
// above.

// ── The generic wiring ───────────────────────────────────────────────────────

/**
 * The concatenated re-hoist order, bottom → top: the layer ids of every overlay
 * with a non-negative `z`, sorted by `z`. This IS the safety-critical stack
 * above the chart — assert against it. Weather (negative `z`) is absent by
 * design; it sits below the seamarks and is never hoisted.
 */
export function hoistOrder(overlays: readonly Overlay[]): string[] {
  return overlays
    .filter((o) => o.z >= 0)
    .sort((a, b) => a.z - b.z)
    .flatMap((o) => [...o.layerIds]);
}

/**
 * Re-install every overlay and restore the stack. Call UNTRACKED (from the
 * `style.load`/`load` hook): the reads inside `ensure`/`update` must not
 * subscribe the caller's effect. `ensure` then `update` (and `paint`) refills
 * each source that the style diff just re-created empty; the final hoist lifts
 * the non-negative overlays above the diff-appended chart layers, in `z` order.
 */
export function ensureOverlays(map: MLMap, overlays: readonly Overlay[], ctx: OverlayCtx): void {
  for (const o of overlays) {
    o.ensure(map, ctx);
    o.update(map, ctx);
    o.paint?.(map, ctx);
  }
  for (const id of hoistOrder(overlays)) {
    // moveLayer without a beforeId moves to the top; iterating bottom → top
    // leaves the last id (own-ship) on top. Guarded because a custom layer may
    // report absent on a teardown beat.
    if (map.getLayer(id)) map.moveLayer(id);
  }
}

/**
 * One effect per overlay for `update`, and one more for `paint` when present, so
 * each overlay tracks exactly its own signals. Gated on `loaded` so nothing runs
 * against a style that has not loaded; when `loaded` flips, each effect re-runs
 * and subscribes to what its overlay reads. Must be called under a reactive
 * owner (wireMap is).
 */
export function wireOverlays(
  map: MLMap,
  overlays: readonly Overlay[],
  ctx: OverlayCtx,
  loaded: Accessor<boolean>,
): void {
  for (const o of overlays) {
    createEffect(() => {
      if (loaded()) o.update(map, ctx);
    });
    if (o.paint) {
      createEffect(() => {
        if (loaded()) o.paint!(map, ctx);
      });
    }
  }
}
