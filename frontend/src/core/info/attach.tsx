// The one line MapView needs: bind info-at-point to a live map. Glue only —
// see docs/architecture/info-attach.md for why it lives outside `wireMap`
// and how it hosts its own DOM subtree.

import { createEffect, onCleanup, type Accessor } from "solid-js";
import { render } from "solid-js/web";
import type maplibregl from "maplibre-gl";
import { riskThresholds } from "../collisionSettings";
import { isCompact } from "../media";
import { measureObscured } from "../chrome/Sheet";
import { createClock } from "../chrome/core";
import { useBackDismiss } from "../chrome/backStack";
import type { SignalKState } from "../signalk";
import type { ChartSettings } from "../style/settings";
import { createChartInfoProvider } from "./chartProvider";
import { createInfoHighlight } from "./highlight";
import InfoMarker from "./InfoMarker";
import InfoPanel from "./InfoPanel";
import { createInfoMarker } from "./marker";
import { createPointInfoProvider, pointHit } from "./pointProvider";
import { queryInfoAt } from "./registry";
import { createInfoState, isSameSpot, type InfoState } from "./state";
import type { AisVessel } from "./vessel";
import type { InfoAction, InfoPoint, InfoProvider, InfoQuery } from "./types";
import { createVesselInfoProvider } from "./vesselProvider";

/**
 * Default tap tolerance, screen pixels — a depth contour is a 1px line and a
 * bare point object a 3px circle, so a finger needs slack a mouse won't
 * notice. `opts.tapRadius` overrides it as a plain number — this module
 * deliberately does not learn what a "density" is, only a radius.
 */
const TAP_RADIUS = 8;

export interface InfoAttachOptions {
  settings: Accessor<ChartSettings>;
  /** Live vessels. Given one, AIS targets and own ship answer taps alongside
   * the chart; omitted, they simply are not a source. */
  signalk?: SignalKState;
  /** Sources beyond the chart and the vessels, in ask order (e.g. POIs). */
  providers?: readonly InfoProvider[];
  /** Tap tolerance in screen pixels, read live. Defaults to `TAP_RADIUS`; the
   * growth at `helm` is `chrome/modes.ts`'s decision, not this module's. */
  tapRadius?: Accessor<number>;
  /**
   * **A mode owns the chart click** (invariant #9). Called first; returning
   * true consumes the click and skips the probe. Absent → always a probe.
   * App.tsx passes `modes.handleClick` (`ModeClick` is structurally this).
   */
  onClick?: (query: InfoQuery) => boolean;
  /**
   * Is a chart mode active? (invariant #9: the subject surface and a mode
   * share one place.) A mode entered from the rail skips `onClick`, so an
   * already-open panel is dismissed here instead. Does not reopen on exit.
   */
  modeActive?: Accessor<boolean>;
  /** "Go here" — route straight to a point and follow it. Given one, the panel
   * shows a primary button on any placed hit. `chrome/route.ts`'s `goTo` is
   * exactly this shape. */
  goHere?: (to: InfoPoint, label?: string) => void;
  /** Is there a boat fix to route FROM? Gates the Go here button — a route
   * from an unknown start is a lie. */
  canGoHere?: Accessor<boolean>;
  /** Is a route currently FOLLOWED? When true, Go here arms a two-tap confirm
   * before replacing the followed passage. */
  isFollowing?: Accessor<boolean>;
  /** "Measure" — enter the measure tool anchored at a point. Given one, the
   * panel shows a Measure button beside Go here on any placed hit. */
  measureFrom?: (from: InfoPoint) => void;
  /** "Add mark" — drop a new mark at a point. Given one, the panel shows an
   * Add mark button on any placed hit except a mark itself. */
  addMark?: (at: InfoPoint) => void;
  /** "New route from here" — start the manual route editor at a point. Given
   * one, the panel shows the button on an open-water hit. */
  newRouteFrom?: (at: InfoPoint) => void;
  /** Extra buttons on a vessel's panel: `VesselProviderOptions.actions`. */
  vesselActions?: (v: AisVessel) => readonly InfoAction[];
}

/**
 * Run `run` once the phone info sheet has SETTLED its open slide (the info
 * marker's warp decision defers to this — ./marker.ts `afterSettle`).
 * See docs/architecture/info-attach.md for the rationale.
 */
function afterSheetSettled(run: () => void): void {
  if (typeof document === "undefined" || typeof requestAnimationFrame === "undefined" || !isCompact()) {
    run();
    return;
  }
  const MAX_FRAMES = 40; // ~0.66 s — comfortably past --duration-sheet
  let last = Number.NaN;
  let stable = 0;
  let frames = 0;
  const tick = (): void => {
    const sheet = document.querySelector<HTMLElement>("[data-sheet-panel]");
    const top = sheet ? sheet.getBoundingClientRect().top : Number.NaN;
    if (top === last) stable += 1;
    else {
      stable = 0;
      last = top;
    }
    frames += 1;
    // Settled: a present sheet whose top held for two frames, or we have waited
    // long enough that a still-absent sheet is not coming.
    if ((sheet && stable >= 2) || frames >= MAX_FRAMES) {
      run();
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/**
 * Wire tap-for-info to `map` and mount the panel. Returns the state, so a
 * future caller can open the panel on a hit it built itself — `InfoState.show`
 * takes hits, not clicks. Must be called under a reactive owner.
 */
export function attachInfoPanel(map: maplibregl.Map, opts: InfoAttachOptions): InfoState {
  const signalk = opts.signalk;
  // Read from `SignalKState.vessels` rather than re-derived, so the panel
  // provably describes the same vessels the chart overlay draws (same memo).
  const vessels = signalk?.vessels;
  const providers: InfoProvider[] = [
    // Vessels before the chart only as a tiebreak: `queryInfoAt` ranks by
    // priority, so a vessel outranks a wreck only when it IS a danger.
    ...(vessels
      ? [
          createVesselInfoProvider({
            vessels,
            // The boat's thresholds, as the chart colours by and the alarm fires on.
            thresholds: () => riskThresholds(signalk!.collisionSettings()),
            atRestKn: () => signalk!.collisionSettings().at_rest_kn,
            settings: opts.settings,
            project: (p) => map.project(p),
            // 1 Hz tick so "Last received" counts up while the panel is open.
            now: createClock(),
            actions: opts.vesselActions,
          }),
        ]
      : []),
    createChartInfoProvider({ map, settings: opts.settings }),
    ...(opts.providers ?? []),
    // Last; never volunteers a hit, only resolves the fallback synthesized below.
    createPointInfoProvider(),
  ];
  const state = createInfoState();

  // Android/gesture Back closes the whole panel (not a carousel step) rather
  // than leaving the app. See ../chrome/backStack.ts.
  useBackDismiss(state.open, () => state.close());

  // Cardinality 1: entering a mode from the rail doesn't pass through
  // `onClick`, so an open panel is dismissed here instead.
  if (opts.modeActive) {
    const modeActive = opts.modeActive;
    createEffect(() => {
      if (modeActive()) state.close();
    });
  }

  // Where the last probe landed, to tell a repeat tap from a tap elsewhere.
  let lastTap: InfoPoint | undefined;
  const onClick = (e: maplibregl.MapMouseEvent) => {
    const query: InfoQuery = {
      point: { x: e.point.x, y: e.point.y },
      lngLat: { lng: e.lngLat.lng, lat: e.lngLat.lat },
      radius: opts.tapRadius?.() ?? TAP_RADIUS,
    };
    // THE SEAM: a mode is asked before the probe runs, so measuring a leg
    // never also throws up a card about a depth contour under the line.
    if (opts.onClick?.(query)) return;
    // An unanswered tap still has one true subject — the point itself — so
    // open water always opens the panel (coordinates, measure, Go here if on).
    const hits = queryInfoAt(providers, query);
    // `probe`, not `show`: a repeat click on the same spot advances the
    // selection instead of snapping back to the top hit. See ./state.ts.
    // "Same spot" is re-projected (the chart may have moved since) and allows
    // both taps their own tolerance.
    const sameSpot = !!lastTap && isSameSpot(map.project(lastTap), query.point, query.radius);
    lastTap = query.lngLat;
    state.probe(hits.length > 0 ? hits : [pointHit(query.lngLat)], sameSpot);
  };
  // 'click' not 'touchend': MapLibre already suppresses it after a pan/pinch.
  map.on("click", onClick);

  // See docs/architecture/info-attach.md for why the marker lives here (not a
  // maplibregl.Marker) and how `obscured`/`afterSettle` work.
  const marker = createInfoMarker({
    state,
    providers,
    map,
    obscured: () => measureObscured(map.getContainer()),
    afterSettle: afterSheetSettled,
  });

  // Tell each provider which of ITS hits the panel shows (or none), so a
  // feature can draw its own selection without knowing about this state.
  createEffect(() => {
    const hit = state.current();
    for (const p of providers) p.selected?.(hit && hit.providerId === p.id ? hit : undefined);
  });

  // ./highlight.ts draws the selected chart object's own geometry — style
  // layers over the chart source, not DOM — for objects a point doesn't answer.
  createInfoHighlight({ state, map, palette: () => opts.settings().palette });

  const host = document.createElement("div");
  map.getContainer().appendChild(host);
  const dispose = render(
    () => (
      <>
        <InfoMarker map={map} model={marker} palette={() => opts.settings().palette} />
        <InfoPanel
          state={state}
          providers={providers}
          goHere={opts.goHere}
          canGoHere={opts.canGoHere}
          isFollowing={opts.isFollowing}
          measureFrom={opts.measureFrom}
          addMark={opts.addMark}
          newRouteFrom={opts.newRouteFrom}
        />
      </>
    ),
    host,
  );

  onCleanup(() => {
    map.off("click", onClick);
    dispose();
    host.remove();
  });

  return state;
}
