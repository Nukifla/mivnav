import { describe, expect, test } from "bun:test";
import type { Notice } from "../../core/chrome/notices";
import type { Route, RoutesClient } from "../../core/routes";
import { TrackUnsupported, type Track, type TrackCoordinate } from "./client";
import { latestStretch, makeRouteFromTrack, trackRouteName } from "./toRoute";

const EMPTY: Track = { lines: [], recent: [], from: null, to: null, last: null, complete: true };

/** A run north along 10°E, `n` fixes ~11 m apart with a dog-leg east halfway. */
const passage = (n: number): TrackCoordinate[] =>
  Array.from({ length: n }, (_, i) => [10 + (i > n / 2 ? (i - n / 2) * 0.0001 : 0), 55 + i * 0.0001]);

function fakeClient(fail = false): RoutesClient & { saved: Route[] } {
  const saved: Route[] = [];
  return {
    routes: () => saved,
    active: () => null,
    refresh: async () => {},
    save: async (r) => {
      if (fail) throw new Error("nope");
      const s = { ...r, rev: 1 };
      saved.push(s);
      return s;
    },
    remove: async () => {},
    setActive: async () => {},
    saved,
  };
}

const mint = () => {
  let i = 0;
  return () => `id${i++}`;
};

describe("latestStretch", () => {
  test("newest recent line, skipping one-point stubs; else newest older line", () => {
    const a: TrackCoordinate[] = [
      [1, 1],
      [1, 2],
    ];
    const b: TrackCoordinate[] = [
      [2, 1],
      [2, 2],
    ];
    expect(latestStretch({ lines: [a], recent: [b, [[3, 3]]] })).toBe(b);
    expect(latestStretch({ lines: [b, a], recent: [] })).toBe(a);
    expect(latestStretch({ lines: [], recent: [] })).toBeNull();
  });
});

describe("trackRouteName", () => {
  test("dated from the newest fix, else now", () => {
    expect(trackRouteName("2026-11-05T21:10:00Z", 0)).toBe("Track 2026-11-05");
    expect(trackRouteName(null, Date.parse("2026-11-06T08:00:00Z"))).toBe("Track 2026-11-06");
  });
});

describe("makeRouteFromTrack", () => {
  test("saves a simplified route from the drawn track and offers Edit", async () => {
    const client = fakeClient();
    const notices: Notice[] = [];
    const edited: Route[] = [];
    const saved = await makeRouteFromTrack({
      shown: () => ({ lines: [], recent: [passage(1000)], last: "2026-11-06T10:00:00Z" }),
      fetch: async () => {
        throw new Error("must not fetch when a track is drawn");
      },
      client,
      mintId: mint(),
      notify: (n) => notices.push(n),
      edit: (r) => edited.push(r),
    });
    expect(saved).not.toBeNull();
    expect(saved!.name).toBe("Track 2026-11-06");
    expect(saved!.waypoints.length).toBeGreaterThanOrEqual(3); // start, dog-leg, end
    expect(saved!.waypoints.length).toBeLessThan(10);
    expect(saved!.waypoints[0]).toMatchObject({ lat: 55, lon: 10 });
    expect(client.saved).toHaveLength(1);
    expect(notices.at(-1)!.title).toBe("Route made from track");
    notices.at(-1)!.action!.run();
    expect(edited).toEqual([saved!]);
  });

  test("fetches the last 24 h when nothing is drawn", async () => {
    const asked: number[] = [];
    const saved = await makeRouteFromTrack({
      shown: () => EMPTY,
      fetch: async (h) => {
        asked.push(h);
        return { ...EMPTY, recent: [passage(50)] };
      },
      client: fakeClient(),
      mintId: mint(),
      now: () => Date.parse("2026-11-06T08:00:00Z"),
    });
    expect(asked).toEqual([24]);
    expect(saved!.name).toBe("Track 2026-11-06");
  });

  test("no history on this boat / no movement / save failure → a notice, no route", async () => {
    const notices: Notice[] = [];
    const base = { client: fakeClient(), mintId: mint(), notify: (n: Notice) => notices.push(n) };
    expect(
      await makeRouteFromTrack({
        ...base,
        shown: () => EMPTY,
        fetch: async () => {
          throw new TrackUnsupported("x");
        },
      }),
    ).toBeNull();
    expect(notices.at(-1)!.title).toBe("No ship track on this boat");
    expect(await makeRouteFromTrack({ ...base, shown: () => EMPTY, fetch: async () => EMPTY })).toBeNull();
    expect(notices.at(-1)!.title).toBe("No track to make a route from");
    // A boat that sat still: every fix the same → nothing to route.
    const still: TrackCoordinate[] = [
      [10, 55],
      [10, 55],
    ];
    expect(
      await makeRouteFromTrack({ ...base, shown: () => ({ lines: [], recent: [still], last: null }), fetch: async () => EMPTY }),
    ).toBeNull();
    expect(
      await makeRouteFromTrack({
        ...base,
        client: fakeClient(true),
        shown: () => ({ lines: [], recent: [passage(20)], last: null }),
        fetch: async () => EMPTY,
      }),
    ).toBeNull();
    expect(notices.at(-1)!.title).toBe("Couldn’t save the route from the track");
  });
});
