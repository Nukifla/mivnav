// Ship track: NOTHING is recorded locally — it comes from SignalK's History
// API (`/api/track`, backend `mivnav/features/track/`), which exists only if
// the boat runs a history plugin. Off by default; a 501 latches it disabled.
// Between polls the recent line is drawn on from the live position (`./live`).

import { defineFeature, type AppFeature } from "../../core/chrome/feature";
import { defineCommand } from "../../core/chrome/command";
import type { Notice } from "../../core/chrome/notices";
import type { Route, RoutesClient } from "../../core/routes";
import { mintUuid } from "../route";
import { createEffect, createMemo, createSignal, on, type Accessor } from "solid-js";
import type { Vessel } from "../../core/signalk";
import type { ChartSettings } from "../../core/style/settings";
import { createTrackClient, fetchTrack, type TrackClientOptions } from "./client";
import { appendLive, coveredUntil, trimLive, withLiveTail, type LivePoint } from "./live";
import { createTrackOverlay } from "./overlay";
import { trackSection, trackSettings } from "./settings";
import { makeRouteFromTrack } from "./toRoute";

export interface TrackDeps extends TrackClientOptions {
  settings: Accessor<ChartSettings>;
  /** Own ship from the SignalK stream: extends the track as the boat moves,
   * instead of a poll period plus the history plugin's lag behind it. */
  self?: Accessor<Vessel | null>;
  /** Enables "Make route from track": where to save, how to tell, and how
   * to open the result in the manual route editor. */
  routes?: {
    client: RoutesClient;
    notify?: (n: Notice) => void;
    edit?: (r: Route) => void;
    mintId?: () => string;
  };
}

export interface TrackFeature {
  feature: AppFeature;
  /** False once this boat's SignalK server has said it keeps no history. */
  supported: Accessor<boolean>;
  /** "Make route from track" (`./toRoute.ts`); absent without `deps.routes`. */
  makeRoute?: () => Promise<Route | null>;
}

/** Build the track feature. `settings` drives both gates — the overlay's
 * on/off and the window — so the client polls only while the line is actually
 * being drawn. */
export function createTrack(deps: TrackDeps): TrackFeature {
  const client = createTrackClient({
    fetch: deps.fetch,
    pollMs: deps.pollMs,
    enabled: () => deps.settings().showTrack,
    hours: () => deps.settings().trackHours,
  });

  // The live tail: every position since the history last reached, trimmed
  // to what it does not yet hold each time an answer lands.
  const [tail, setTail] = createSignal<readonly LivePoint[]>([]);
  const [covered, setCovered] = createSignal<number | null>(null);
  createEffect(
    on(client.track, (t) => {
      const until = coveredUntil(t, Date.now());
      setCovered(until);
      setTail((prev) => trimLive(prev, until));
    }),
  );
  createEffect(() => {
    const self = deps.self?.();
    if (!deps.settings().showTrack || !client.supported()) {
      setTail([]);
      return;
    }
    if (!self || !Number.isFinite(self.lng) || !Number.isFinite(self.lat)) return;
    const p = { t: Date.now(), c: [self.lng, self.lat] as [number, number] };
    setTail((prev) => appendLive(prev, p));
  });
  const recent = createMemo(() => withLiveTail(client.track().recent, tail(), covered()));

  const routes = deps.routes;
  const makeRoute = routes
    ? () =>
        makeRouteFromTrack({
          shown: () => ({ lines: client.track().lines, recent: recent(), last: client.track().last }),
          fetch: deps.fetch ?? fetchTrack,
          client: routes.client,
          mintId: routes.mintId ?? mintUuid,
          notify: routes.notify,
          edit: routes.edit,
        })
    : undefined;

  return {
    supported: client.supported,
    makeRoute,
    feature: defineFeature({
      id: "track",
      commands: makeRoute
        ? () => [
            defineCommand({
              id: "track-make-route",
              label: "Make route from track",
              group: "App",
              hint: "A new route from the latest stretch of the ship track",
              keywords: ["track", "route", "history", "simplify", "trail", "passage"],
              enabled: () => client.supported(),
              run: (ctx) => {
                void makeRoute();
                ctx.close();
              },
            }),
          ]
        : undefined,
      overlay: createTrackOverlay({
        lines: () => client.track().lines,
        recent,
      }),
      settings: { settings: trackSettings, sections: [trackSection] },
      // Plain toggle, no opacity: a track is a thin line, not a wash — a
      // half-faded record is worse than showing it or not. `enabled` greys
      // out the row once the server says this boat keeps no history.
      overlayControls: (d) => [
        {
          id: "track",
          label: "Ship track",
          visible: () => d.settings().showTrack,
          setVisible: (v) => d.setSettings({ showTrack: v }),
          enabled: () => client.supported(),
        },
      ],
    }),
  };
}
