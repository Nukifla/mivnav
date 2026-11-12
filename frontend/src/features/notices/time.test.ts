// Time state + visibility, derived on the device from `win` and the clock
// (efs.md §2.2) — the edges matter because the boat is often offline: a
// notice whose window opened an hour ago must read active without the server.
//
// NB: run with `--conditions=browser` (`bun run test`).

import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "../../core/style/settings";
import MAP from "./fixtures/map.json";
import {
  colourKey,
  familyShown,
  nextStart,
  noticesFilterOf,
  overlapsToday,
  prepareNotices,
  shortLabel,
  startOfLocalDay,
  timeState,
  type NoticesFilter,
} from "./time";
import type { NoticesMap } from "./types";

/** The fixture's "now": 2026-10-03T12:00Z. */
const NOW = 1791028800000;
const H = 3_600_000;
const D = 24 * H;
const FIXTURE = MAP as unknown as NoticesMap;
const DEFAULTS = noticesFilterOf(DEFAULT_SETTINGS);

describe("timeState", () => {
  test("inside a window is active; start inclusive, end exclusive", () => {
    expect(timeState([[NOW - H, NOW + H]], NOW)).toBe("a");
    expect(timeState([[NOW, NOW + H]], NOW)).toBe("a");
    expect(timeState([[NOW - H, NOW]], NOW)).toBe("e");
  });

  test("a null end is open — active from its start on, forever", () => {
    expect(timeState([[NOW - 100 * D, null]], NOW)).toBe("a");
    expect(timeState([[NOW + H, null]], NOW)).toBe("u");
  });

  test("before every window is upcoming; after every window is ended", () => {
    expect(timeState([[NOW + H, NOW + 2 * H]], NOW)).toBe("u");
    expect(timeState([[NOW - 2 * H, NOW - H]], NOW)).toBe("e");
  });

  test("several windows (firing days): between two is upcoming, inside any is active", () => {
    const days = [
      [NOW - D, NOW - D + 8 * H],
      [NOW + D, NOW + D + 8 * H],
    ] as const;
    expect(timeState(days, NOW)).toBe("u");
    expect(timeState(days, NOW - D + H)).toBe("a");
    expect(timeState(days, NOW + 3 * D)).toBe("e");
  });

  test("no windows at all is in force — never hide a notice for lack of a date", () => {
    expect(timeState([], NOW)).toBe("a");
    expect(timeState(null, NOW)).toBe("a");
  });

  test("nextStart is the earliest future start", () => {
    expect(
      nextStart(
        [
          [NOW + 5 * D, null],
          [NOW + 2 * D, NOW + 3 * D],
          [NOW - D, NOW],
        ],
        NOW,
      ),
    ).toBe(NOW + 2 * D);
    expect(nextStart([[NOW - D, null]], NOW)).toBeNull();
  });
});

describe("firing today", () => {
  test("a window anywhere in today's local day counts, not just one containing now", () => {
    const sod = startOfLocalDay(NOW);
    expect(overlapsToday([[sod + 20 * H, sod + 22 * H]], NOW)).toBe(true);
    expect(overlapsToday([[sod - 2 * H, sod + H]], NOW)).toBe(true);
    expect(overlapsToday([[sod + D, sod + D + H]], NOW)).toBe(false);
    expect(overlapsToday([[sod - 3 * H, sod]], NOW)).toBe(false);
    expect(overlapsToday([], NOW)).toBe(false);
  });

  test("a firing area switches grey → firing red on its firing day", () => {
    expect(colourKey("fa", false)).toBe("inactive");
    expect(colourKey("fa", true)).toBe("firing");
    expect(colourKey("fe", false)).toBe("firing");
  });
});

describe("colour per family (efs.md §2.1)", () => {
  test("NW red-orange, T/P magenta, permanent violet", () => {
    expect(colourKey("nw", false)).toBe("warning");
    expect(colourKey("nm-t", false)).toBe("temporary");
    expect(colourKey("nm-p", false)).toBe("preliminary");
    expect(colourKey("nm-perm", false)).toBe("permanent");
  });
});

describe("boundary edges: each shared edge drawn once", () => {
  const sq = (x0: number, x1: number) => [[[x0, 56], [x1, 56], [x1, 56.1], [x0, 56.1], [x0, 56]]];
  const area = (msg: string, fam: string, win: unknown, coordinates: unknown) => ({
    type: "Feature" as const,
    // A fresh array per feature: identity is by VALUE, not by object.
    geometry: { type: "Polygon" as const, coordinates: JSON.parse(JSON.stringify(coordinates)) },
    properties: { msg, fam, role: "area", cls: "firing", win },
  });
  const edges = (fc: ReturnType<typeof prepareNotices>, msg: string) =>
    fc.features.find((f) => f.properties.role === "edge" && f.properties.msg === msg);
  const segs = (f: ReturnType<typeof edges>) =>
    f ? (f.geometry as { coordinates: number[][][] }).coordinates.reduce((n, c) => n + c.length - 1, 0) : 0;

  test("an exercise over its own firing area: the active one keeps the whole boundary", () => {
    const data = {
      type: "FeatureCollection",
      features: [area("fe", "fe", [[NOW + D, NOW + D + H]], sq(10, 10.1)), area("fa", "fa", [[NOW - H, NOW + H]], sq(10, 10.1))],
    } as unknown as NoticesMap;
    const fc = prepareNotices(data, DEFAULTS, NOW);
    expect(segs(edges(fc, "fa"))).toBe(4);
    expect(edges(fc, "fe")).toBeUndefined();
    expect(edges(fc, "fa")!.properties.st).toBe("a");
  });

  test("two adjacent sectors share one edge: 4 + 3 segments, never 8", () => {
    const data = {
      type: "FeatureCollection",
      features: [area("w", "nm-t", [[NOW - H, null]], sq(10, 10.1)), area("e", "nm-t", [[NOW - H, null]], sq(10.1, 10.2))],
    } as unknown as NoticesMap;
    const fc = prepareNotices(data, DEFAULTS, NOW);
    expect(segs(edges(fc, "w")) + segs(edges(fc, "e"))).toBe(7);
  });

  test("the fixture: every area that is shown has its boundary somewhere", () => {
    const fc = prepareNotices(FIXTURE, DEFAULTS, NOW);
    const areas = fc.features.filter((f) => f.properties.role === "area").length;
    const edged = fc.features.filter((f) => f.properties.role === "edge").length;
    expect(areas).toBeGreaterThan(0);
    expect(edged).toBeGreaterThan(0);
    expect(edged).toBeLessThanOrEqual(areas);
  });
});

describe("prepareNotices", () => {
  const byMsg = (fc: ReturnType<typeof prepareNotices>, msg: string) =>
    fc.features.filter((f) => f.properties.msg === msg);

  test("defaults: everything but the ended notice is drawn, each stamped with st/ft/fc", () => {
    const fc = prepareNotices(FIXTURE, DEFAULTS, NOW);
    expect(byMsg(fc, "8394-nm-700")).toEqual([]); // ended → hidden by default (Q5)
    expect(byMsg(fc, "0b1c-nw-372")[0]!.properties).toMatchObject({ st: "a", fc: "warning", ft: false });
    expect(byMsg(fc, "4f50-nm-900")[0]!.properties).toMatchObject({ st: "u", fc: "preliminary" });
    expect(fc.features.every((f) => !("win" in f.properties))).toBe(true);
  });

  test("Greenland just renders — no filter on `gl`", () => {
    const fc = prepareNotices(FIXTURE, DEFAULTS, NOW);
    expect(byMsg(fc, "0a0b-gl-1").length).toBe(1);
  });

  test("Show ended brings the ended notice back, faint (st=e)", () => {
    const fc = prepareNotices(FIXTURE, { ...DEFAULTS, noticesShowEnded: true }, NOW);
    expect(byMsg(fc, "8394-nm-700")[0]!.properties.st).toBe("e");
  });

  test("the minute clock moves a notice across its edge", () => {
    const at = (t: number) => byMsg(prepareNotices(FIXTURE, DEFAULTS, t), "4f50-nm-900")[0]?.properties.st;
    expect(at(NOW)).toBe("u");
    expect(at(1791201600000)).toBe("a"); // its start
  });

  test("firing areas are ALWAYS drawn (Q4): grey when quiet, hatched when firing today", () => {
    const fc = prepareNotices(FIXTURE, DEFAULTS, NOW);
    const quiet = byMsg(fc, "c7d8-fa-18")[0]!.properties;
    const firing = byMsg(fc, "e9fa-fa-32")[0]!.properties;
    expect(quiet).toMatchObject({ st: "a", ft: false, fc: "inactive" });
    expect(firing).toMatchObject({ ft: true, fc: "firing" });
    // Even days later, a quiet area's empty/expired `win` never reads "ended".
    expect(byMsg(prepareNotices(FIXTURE, DEFAULTS, NOW + 9 * D), "e9fa-fa-32")[0]!.properties.fc).toBe("inactive");
  });

  test("a firing exercise in use today is hatched (ft) and labelled with its area name", () => {
    const fc = prepareNotices(FIXTURE, DEFAULTS, NOW);
    const [area, anchor] = byMsg(fc, "a5b6-fe-1");
    expect(area!.properties.ft).toBe(true);
    expect(anchor!.properties.lbl).toBe("EK D 396 Hullebæk");
  });

  test("labels: short id without the year; upcoming adds 'from d/m'; vertex '1) …'", () => {
    const fc = prepareNotices(FIXTURE, DEFAULTS, NOW);
    expect(byMsg(fc, "2d3e-nm-842").find((f) => f.properties.role === "anchor")!.properties.lbl).toBe("NM-842");
    expect(byMsg(fc, "4f50-nm-900").find((f) => f.properties.role === "anchor")!.properties.lbl).toBe(
      "NM-900 · from 5/10",
    );
    const vertices = byMsg(fc, "2d3e-nm-842").filter((f) => f.properties.role === "vertex");
    expect(vertices.map((f) => f.properties.vtx)).toEqual([
      "1) yellow spar buoy with cross topmark Fl.W.1,5s",
      "2) kyst", // no English: Danish
    ]);
    expect(shortLabel("Local Warning-244-26")).toBe("LW-244");
  });

  test("null data is an empty collection", () => {
    expect(prepareNotices(null, DEFAULTS, NOW).features).toEqual([]);
  });
});

describe("per-family toggles", () => {
  const msgs = (f: Partial<NoticesFilter>) =>
    new Set(prepareNotices(FIXTURE, { ...DEFAULTS, ...f }, NOW).features.map((x) => x.properties.fam));

  test.each([
    ["noticesWarnings", ["nw"]],
    ["noticesTemporary", ["nm-t"]],
    ["noticesPreliminary", ["nm-p"]],
    ["noticesPermanent", ["nm-perm"]],
    ["noticesFiring", ["fe", "fa"]],
  ] as const)("%s off hides exactly %p", (key, fams) => {
    const all = msgs({});
    const without = msgs({ [key]: false });
    for (const fam of fams) {
      expect(all.has(fam)).toBe(true);
      expect(without.has(fam)).toBe(false);
    }
    expect(without.size).toBe(all.size - fams.length);
  });

  test("EfS A/B never draw — they are list-only", () => {
    expect(familyShown("efs-a", DEFAULTS)).toBe(false);
    expect(familyShown("efs-b", DEFAULTS)).toBe(false);
  });
});
