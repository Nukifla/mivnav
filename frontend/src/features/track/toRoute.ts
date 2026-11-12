// "Make route from track": the latest stretch of the ship track, simplified
// (core/simplify.ts — the same simplifier a GPX `<trk>` import uses) into a
// new saved route, with an offer to open it in the manual route editor.
//
// WHICH stretch: the track arrives as lines already broken wherever the
// record has a hole (backend `track/geometry.py` `split_gaps`) and split into
// `recent` (last 24 h, plus the live tail) and older `lines`. The newest line
// of `recent` is the boat's current/latest continuous passage; if nothing
// moved in the last 24 h, the newest older line. The track carries no
// per-point times, so a finer cut (by day, by time range) is not possible
// from this response.

import type { Notice } from "../../core/chrome/notices";
import type { Route, RoutesClient } from "../../core/routes";
import { routeFromTrack } from "../route/gpx";
import type { Track, TrackCoordinate } from "./client";
import { TrackUnsupported } from "./client";

/** The newest continuous line, or null when there is none with 2+ points. */
export function latestStretch(track: Pick<Track, "lines" | "recent">): TrackCoordinate[] | null {
  for (const group of [track.recent, track.lines]) {
    for (let i = group.length - 1; i >= 0; i--) {
      const line = group[i]!;
      if (line.length >= 2) return line;
    }
  }
  return null;
}

/** "Track 2026-11-06", from the newest fix's time (else now), UTC date. */
export function trackRouteName(last: string | null, now: number): string {
  const t = last ? Date.parse(last) : NaN;
  return `Track ${new Date(Number.isFinite(t) ? t : now).toISOString().slice(0, 10)}`;
}

export interface TrackToRouteDeps {
  /** What the overlay currently draws (live tail included); empty when off. */
  shown: () => Pick<Track, "lines" | "recent" | "last">;
  /** On-demand fetch when nothing is drawn (the overlay is off). */
  fetch: (hours: number) => Promise<Track>;
  client: RoutesClient;
  mintId: () => string;
  notify?: (n: Notice) => void;
  /** Open a route in the manual editor — offered as the notice's action. */
  edit?: (r: Route) => void;
  now?: () => number;
}

const NOTICE_ID = "track-route";

/** Build, save and announce the route. Resolves to it, or null (notified). */
export async function makeRouteFromTrack(deps: TrackToRouteDeps): Promise<Route | null> {
  const notify = (n: Omit<Notice, "id">) => deps.notify?.({ id: NOTICE_ID, ...n });
  let track = deps.shown();
  if (!latestStretch(track)) {
    try {
      track = await deps.fetch(24);
    } catch (e) {
      notify(
        e instanceof TrackUnsupported
          ? { title: "No ship track on this boat", detail: "SignalK keeps no position history here." }
          : { title: "Couldn’t read the ship track" },
      );
      return null;
    }
  }
  const line = latestStretch(track);
  const name = trackRouteName(track.last, (deps.now ?? Date.now)());
  const made = line ? routeFromTrack(name, line.map(([lon, lat]) => ({ lat, lon })), deps.mintId) : null;
  if (!made) {
    notify({ title: "No track to make a route from", detail: "The boat has not moved in the last 24 hours." });
    return null;
  }
  try {
    const saved = await deps.client.save(made.route);
    notify({
      title: "Route made from track",
      detail: `${saved.name}: ${saved.waypoints.length} waypoints from ${made.from} fixes (±${Math.round(made.toleranceM)} m)`,
      action: deps.edit ? { label: "Edit", run: () => deps.edit!(saved) } : undefined,
    });
    return saved;
  } catch (e) {
    console.error("track: route save failed", e);
    notify({ title: "Couldn’t save the route from the track" });
    return null;
  }
}
