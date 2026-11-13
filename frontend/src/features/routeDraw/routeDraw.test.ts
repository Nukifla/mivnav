// The manual route editor: the pure draft/history (./draft.ts), the pure
// gesture decisions (./gesture.ts), the model + mode (./index.ts) against a
// fake routes client, and the MapLibre host (./overlay.ts) against a fake map.
//
// NB: run with `--conditions=browser` (`bun run test`) — see CLAUDE.md.

import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import type { Map as MLMap } from "maplibre-gl";
import { RouteSaveError, type ActiveLeg, type Route, type RoutesClient } from "../../core/routes";
import { createRegistry } from "../../core/chrome/registry";
import { createModeState } from "../../core/chrome/modes";
import { createSignal } from "solid-js";
import {
  blankRoute,
  canRedo,
  canUndo,
  commit,
  commitFrom,
  historyOf,
  insertPoint,
  movePoint,
  newWaypoint,
  redo,
  removePoint,
  renamePoint,
  renameRoute,
  replacePresent,
  sameContent,
  setDepartAt,
  setPlanSpeed,
  undo,
  wrapLng,
  MAX_NAME_LENGTH,
} from "./draft";
import {
  addsAtStart,
  createGestureMachine,
  hitTest,
  resolveTap,
  TAP_SLOP_PX,
  type Effect,
  type Hit,
  type ScreenPoint,
} from "./gesture";
import { findSnap, snapPoint, snapWaypoint, type SnapMark } from "./snap";
import { aimAnchor, aimLeg } from "./crosshair";
import { createRouteDraw, ROUTE_DRAW_MODE_ID } from "./index";
import { attachRouteDrawGestures, updateRouteDrawData } from "./overlay";

const route = (wps: [string, number, number][], rev = 3): Route => ({
  id: "r1",
  name: "Passage",
  plan_speed_kn: 5,
  rev,
  updated: 0,
  waypoints: wps.map(([id, lat, lon]) => ({ id, name: "", lat, lon, stop: true })),
});

// ── draft.ts ────────────────────────────────────────────────────────────────

describe("draft — pure edits", () => {
  test("wrapLng folds world copies back into [-180, 180]", () => {
    expect(wrapLng(190)).toBe(-170);
    expect(wrapLng(-190)).toBe(170);
    expect(wrapLng(10)).toBe(10);
    expect(wrapLng(180)).toBe(180);
    expect(wrapLng(540)).toBe(180);
  });

  test("a new waypoint is a STOP, unnamed, never approximate", () => {
    const w = newWaypoint("a", { lng: 370, lat: 95 });
    expect(w).toEqual({ id: "a", name: "", lat: 90, lon: 10, stop: true });
    expect("approximate" in w).toBe(false);
  });

  test("insert / move / remove / rename return new routes and leave the input alone", () => {
    const r = route([["a", 56, 10], ["b", 56, 11]]);
    const ins = insertPoint(r, 1, newWaypoint("m", { lng: 10.5, lat: 56 }));
    expect(ins.waypoints.map((w) => w.id)).toEqual(["a", "m", "b"]);
    expect(r.waypoints.map((w) => w.id)).toEqual(["a", "b"]);
    expect(insertPoint(r, 99, newWaypoint("z", { lng: 0, lat: 0 })).waypoints.at(-1)!.id).toBe("z");

    const mv = movePoint(ins, "m", { lng: 10.6, lat: 56.1 });
    expect(mv.waypoints[1]).toMatchObject({ id: "m", lat: 56.1, lon: 10.6 });
    expect(movePoint(mv, "m", { lng: 10.6, lat: 56.1 })).toBe(mv);
    expect(movePoint(mv, "nope", { lng: 0, lat: 0 })).toBe(mv);

    expect(removePoint(mv, "m").waypoints.map((w) => w.id)).toEqual(["a", "b"]);
    expect(removePoint(mv, "nope")).toBe(mv);

    expect(renamePoint(mv, "a", "  Skagen  ").waypoints[0]!.name).toBe("Skagen");
    expect(renameRoute(mv, "x".repeat(100)).name.length).toBe(MAX_NAME_LENGTH);
    expect(renameRoute(mv, "Passage")).toBe(mv);
  });

  test("sameContent ignores rev/updated, sees every edit", () => {
    const r = route([["a", 56, 10]]);
    expect(sameContent(r, { ...r, rev: 9, updated: 5 })).toBe(true);
    expect(sameContent(r, movePoint(r, "a", { lng: 10, lat: 57 }))).toBe(false);
    expect(sameContent(r, renamePoint(r, "a", "x"))).toBe(false);
    expect(sameContent(r, setPlanSpeed(r, 6))).toBe(false);
    expect(sameContent(r, setDepartAt(r, "2026-11-06T09:30:00Z"))).toBe(false);
    // Absent and null are the same "leave now".
    expect(sameContent(r, { ...r, depart_at: null })).toBe(true);
  });

  test("planning speed and departure: no-ops return the same route, bad speeds are refused", () => {
    const r = route([["a", 56, 10]]);
    expect(setPlanSpeed(r, 5)).toBe(r);
    expect(setPlanSpeed(r, 0)).toBe(r);
    expect(setPlanSpeed(r, -2)).toBe(r);
    expect(setPlanSpeed(r, Number.NaN)).toBe(r);
    expect(setPlanSpeed(r, 6.5).plan_speed_kn).toBe(6.5);
    expect(setDepartAt(r, null)).toBe(r);
    const d = setDepartAt(r, "2026-11-06T09:30:00Z");
    expect(d.depart_at).toBe("2026-11-06T09:30:00Z");
    expect(setDepartAt(d, "2026-11-06T09:30:00Z")).toBe(d);
    expect(setDepartAt(d, null).depart_at).toBeNull();
  });
});

describe("draft — undo history", () => {
  test("commit / undo / redo walk snapshots; a new edit drops the redo branch", () => {
    const r0 = route([["a", 56, 10]]);
    let h = historyOf(r0);
    expect(canUndo(h)).toBe(false);
    const r1 = insertPoint(r0, 1, newWaypoint("b", { lng: 11, lat: 56 }));
    h = commit(h, r1);
    const r2 = removePoint(r1, "a");
    h = commit(h, r2);
    h = undo(h);
    expect(h.present).toBe(r1);
    expect(canRedo(h)).toBe(true);
    h = redo(h);
    expect(h.present).toBe(r2);
    h = undo(undo(h));
    expect(h.present).toBe(r0);
    expect(undo(h)).toBe(h);
    h = commit(h, renameRoute(r0, "New"));
    expect(canRedo(h)).toBe(false);
  });

  test("a no-op edit records nothing", () => {
    const h = historyOf(route([["a", 56, 10]]));
    expect(commit(h, h.present)).toBe(h);
  });

  test("a drag is ONE step: replacePresent live, commitFrom the base at the end", () => {
    const base = route([["a", 56, 10]]);
    let h = historyOf(base);
    for (const lat of [56.1, 56.2, 56.3]) h = replacePresent(h, movePoint(h.present, "a", { lng: 10, lat }));
    expect(h.past.length).toBe(0);
    h = commitFrom(h, base);
    expect(h.past).toEqual([base]);
    expect(undo(h).present).toBe(base);
  });

  test("a drag that ends where it started records nothing", () => {
    const base = route([["a", 56, 10]]);
    let h = replacePresent(historyOf(base), movePoint(base, "a", { lng: 10, lat: 57 }));
    h = replacePresent(h, movePoint(h.present, "a", { lng: 10, lat: 56 }));
    expect(commitFrom(h, base).past.length).toBe(0);
  });
});

// ── gesture.ts ──────────────────────────────────────────────────────────────

/** Three points in a row on screen, 200px apart. */
const PTS: ScreenPoint[] = [
  { id: "a", x: 100, y: 300 },
  { id: "b", x: 300, y: 300 },
  { id: "c", x: 500, y: 300 },
];
const opts = (selectedId: string | null = null) => ({ radius: 8, selectedId });

describe("gesture — hit test", () => {
  test("point, then leg (anywhere along it), then water", () => {
    expect(hitTest(PTS, { x: 305, y: 304 }, opts())).toMatchObject({ kind: "point", id: "b", selected: false });
    expect(hitTest(PTS, { x: 200, y: 302 }, opts())).toEqual({ kind: "leg", leg: 0, anchor: { x: 200, y: 300 } });
    expect(hitTest(PTS, { x: 400, y: 300 }, opts())).toMatchObject({ kind: "leg", leg: 1 });
    const leg = hitTest(PTS, { x: 150, y: 306 }, opts());
    expect(leg).toEqual({ kind: "leg", leg: 0, anchor: { x: 150, y: 300 } });
    expect(hitTest(PTS, { x: 150, y: 340 }, opts())).toEqual({ kind: "water" });
  });

  test("a selected point has no separate handle — the spot off it is water", () => {
    expect(hitTest(PTS, { x: 260, y: 340 }, opts("b"))).toEqual({ kind: "water" });
  });

  test("short legs still take taps along them", () => {
    expect(hitTest([{ id: "a", x: 0, y: 0 }, { id: "b", x: 60, y: 0 }], { x: 30, y: 2 }, opts())).toMatchObject({
      kind: "leg",
    });
  });
});

const press = (touch = true, time = 0) => ({ touch, time });
const types = (es: Effect[]) => es.map((e) => e.type);

describe("gesture — the machine", () => {
  test("a tap resolves on finger-up within the slop; nothing captured on water", () => {
    const g = createGestureMachine();
    expect(g.down({ x: 10, y: 10 }, { kind: "water" }, press())).toEqual([]);
    expect(g.move({ x: 10 + TAP_SLOP_PX - 1, y: 10 })).toEqual([]);
    const up = g.up({ x: 15, y: 10 }, press(true, 100));
    expect(up).toEqual([{ type: "tap", hit: { kind: "water" }, at: { x: 15, y: 10 } }]);
  });

  test("past the slop it is a pan: no tap, nothing captured", () => {
    const g = createGestureMachine();
    g.down({ x: 10, y: 10 }, { kind: "water" }, press());
    expect(g.move({ x: 40, y: 10 })).toEqual([]);
    expect(g.move({ x: 12, y: 10 })).toEqual([]);
    expect(g.up({ x: 12, y: 10 }, press())).toEqual([]);
  });

  test("a pan whose moves never arrived (MapLibre's own pan swallows them) is still no tap", () => {
    const g = createGestureMachine();
    g.down({ x: 10, y: 10 }, { kind: "water" }, press());
    expect(g.up({ x: 110, y: 10 }, press())).toEqual([]);
  });

  test("an UNSELECTED point pans — a brushing finger can't move it", () => {
    const g = createGestureMachine();
    const hit: Hit = { kind: "point", id: "b", selected: false, anchor: { x: 300, y: 300 } };
    expect(g.down({ x: 300, y: 300 }, hit, press())).toEqual([]);
    expect(g.move({ x: 360, y: 300 })).toEqual([]);
    expect(g.up({ x: 360, y: 300 }, press())).toEqual([]);
  });

  test("the SELECTED point drags; the point follows the finger's travel", () => {
    const g = createGestureMachine();
    const hit: Hit = { kind: "point", id: "b", selected: true, anchor: { x: 300, y: 300 } };
    expect(types(g.down({ x: 304, y: 302 }, hit, press()))).toEqual(["capture"]);
    expect(g.move({ x: 306, y: 302 })).toEqual([]);
    expect(g.move({ x: 334, y: 322 })).toEqual([
      { type: "dragStart", hit },
      { type: "dragMove", to: { x: 330, y: 320 } },
    ]);
    expect(types(g.up({ x: 334, y: 322 }, press()))).toEqual(["dragEnd", "release"]);
  });

  test("a tap on the selected point releases and taps (no drag)", () => {
    const g = createGestureMachine();
    const hit: Hit = { kind: "point", id: "b", selected: true, anchor: { x: 300, y: 300 } };
    g.down({ x: 300, y: 300 }, hit, press());
    expect(types(g.up({ x: 302, y: 300 }, press()))).toEqual(["release", "tap"]);
  });

  test("a selected point drags, keeping the finger-to-point offset", () => {
    const g = createGestureMachine();
    const hit: Hit = { kind: "point", id: "b", selected: true, anchor: { x: 300, y: 300 } };
    g.down({ x: 305, y: 305 }, hit, press());
    const out = g.move({ x: 325, y: 325 });
    expect(out.at(-1)).toEqual({ type: "dragMove", to: { x: 320, y: 320 } });
  });

  test("a press anywhere on a leg drags out a new point", () => {
    const g = createGestureMachine();
    const hit: Hit = { kind: "leg", leg: 0, anchor: { x: 150, y: 300 } };
    expect(types(g.down({ x: 200, y: 300 }, hit, press()))).toEqual(["capture"]);
    expect(types(g.move({ x: 200, y: 330 }))).toEqual(["dragStart", "dragMove"]);
  });

  test("a second finger cancels the drag and the press stays dead until lifted", () => {
    const g = createGestureMachine();
    const hit: Hit = { kind: "point", id: "b", selected: true, anchor: { x: 300, y: 300 } };
    g.down({ x: 300, y: 300 }, hit, press());
    g.move({ x: 340, y: 300 });
    expect(types(g.cancel())).toEqual(["dragCancel", "release"]);
    expect(g.move({ x: 360, y: 300 })).toEqual([]);
    expect(g.up({ x: 360, y: 300 }, press())).toEqual([]);
    expect(g.busy()).toBe(false);
  });

  test("a second finger before the slop just gives the pan back — no tap later", () => {
    const g = createGestureMachine();
    g.down({ x: 300, y: 300 }, { kind: "water" }, press());
    expect(g.cancel()).toEqual([]);
    expect(g.up({ x: 300, y: 300 }, press())).toEqual([]);
  });

  test("MapLibre's tap-then-drag zoom is never captured", () => {
    const g = createGestureMachine();
    g.down({ x: 300, y: 300 }, { kind: "water" }, press(true, 0));
    g.up({ x: 300, y: 300 }, press(true, 50));
    const hit: Hit = { kind: "point", id: "b", selected: true, anchor: { x: 300, y: 300 } };
    expect(g.down({ x: 305, y: 300 }, hit, press(true, 200))).toEqual([]);
    expect(g.move({ x: 305, y: 360 })).toEqual([]); // a zoom, not a drag
    // …but the same press much later is a real drag.
    g.up({ x: 305, y: 360 }, press(true, 300));
    expect(types(g.down({ x: 305, y: 300 }, hit, press(true, 2000)))).toEqual(["capture"]);
  });

  test("the mouse has no tap-zoom window", () => {
    const g = createGestureMachine();
    g.down({ x: 300, y: 300 }, { kind: "water" }, press(false, 0));
    g.up({ x: 300, y: 300 }, press(false, 10));
    const hit: Hit = { kind: "point", id: "b", selected: true, anchor: { x: 300, y: 300 } };
    expect(types(g.down({ x: 300, y: 300 }, hit, press(false, 20)))).toEqual(["capture"]);
  });
});

describe("gesture — what a tap does", () => {
  const draft = (selectedId: string | null, count = 3) => ({ firstId: "a", count, selectedId });
  test("water appends — or prepends when the FIRST point is selected", () => {
    expect(resolveTap({ kind: "water" }, draft(null))).toEqual({ op: "append" });
    expect(resolveTap({ kind: "water" }, draft("b"))).toEqual({ op: "append" });
    expect(resolveTap({ kind: "water" }, draft("a"))).toEqual({ op: "prepend" });
    // One point: first IS last, so it extends forward.
    expect(resolveTap({ kind: "water" }, draft("a", 1))).toEqual({ op: "append" });
  });
  test("a point tap selects; a leg tap inserts a point at the spot", () => {
    expect(resolveTap({ kind: "point", id: "b", selected: false, anchor: { x: 0, y: 0 } }, draft(null))).toEqual({
      op: "selectPoint",
      id: "b",
    });
    expect(resolveTap({ kind: "leg", leg: 1, anchor: { x: 4, y: 5 } }, draft(null))).toEqual({
      op: "insertOnLeg",
      leg: 1,
      at: { x: 4, y: 5 },
    });
  });
});

describe("gesture — crosshair mode taps", () => {
  const draft = (selectedId: string | null, crosshair: boolean) => ({ firstId: "a", count: 3, selectedId, crosshair });
  test("open water places nothing with the crosshair on — it only deselects", () => {
    expect(resolveTap({ kind: "water" }, draft(null, true))).toEqual({ op: "deselect" });
    expect(resolveTap({ kind: "water" }, draft("a", true))).toEqual({ op: "deselect" });
    expect(resolveTap({ kind: "water" }, draft(null, false))).toEqual({ op: "append" });
  });
  test("points select and legs insert with the crosshair on", () => {
    expect(resolveTap({ kind: "point", id: "b", selected: false, anchor: { x: 0, y: 0 } }, draft(null, true))).toEqual({
      op: "selectPoint",
      id: "b",
    });
    expect(resolveTap({ kind: "leg", leg: 1, anchor: { x: 1, y: 2 } }, draft(null, true)).op).toBe("insertOnLeg");
  });
  test("addsAtStart: only with point 1 selected on a route of 2+", () => {
    expect(addsAtStart({ firstId: "a", count: 2, selectedId: "a" })).toBe(true);
    expect(addsAtStart({ firstId: "a", count: 1, selectedId: "a" })).toBe(false);
    expect(addsAtStart({ firstId: "a", count: 2, selectedId: "b" })).toBe(false);
    expect(addsAtStart({ firstId: "a", count: 2, selectedId: null })).toBe(false);
  });
});

// ── snap.ts / crosshair.ts ──────────────────────────────────────────────────

describe("snap — pure", () => {
  const marks: SnapMark[] = [
    { id: "m1", name: "Buoy", lat: 56, lon: 10 },
    { id: "m2", name: "  Pier  ", lat: 56, lon: 10.1 },
  ];
  test("the nearest mark within the radius, else none", () => {
    expect(findSnap(at(10.02, 56), marks, project100, 16)?.id).toBe("m1");
    expect(findSnap(at(10.08, 56.0), marks, project100, 16)?.id).toBe("m2");
    expect(findSnap(at(10.5, 56), marks, project100, 16)).toBeNull();
    expect(findSnap(at(10, 56), [], project100, 16)).toBeNull();
  });
  test("a snapped point lands on the mark and takes its name only if unnamed", () => {
    const unnamed = newWaypoint("p", at(10.01, 56.01));
    expect(snapWaypoint(unnamed, marks[1]!)).toEqual({ id: "p", name: "Pier", lat: 56, lon: 10.1, stop: true });
    const named = { ...unnamed, name: "Mine" };
    expect(snapWaypoint(named, marks[0]!)).toMatchObject({ name: "Mine", lat: 56, lon: 10 });
    const long = { ...marks[0]!, name: "x".repeat(MAX_NAME_LENGTH + 10) };
    expect(snapWaypoint(unnamed, long).name.length).toBe(MAX_NAME_LENGTH);
  });
  test("snapPoint is a route op: same object back when nothing changes", () => {
    const r = route([["a", 56, 10]]);
    const once = snapPoint(r, "a", marks[0]!);
    expect(once.waypoints[0]).toMatchObject({ name: "Buoy", lat: 56, lon: 10 });
    expect(snapPoint(once, "a", marks[0]!)).toBe(once);
    expect(snapPoint(r, "nope", marks[0]!)).toBe(r);
  });
});

describe("crosshair — pure", () => {
  const r = route([["a", 56, 10], ["b", 56, 11]]);
  test("the band runs from the selected point, else the last, else nowhere", () => {
    expect(aimAnchor(r.waypoints, "a")!.id).toBe("a");
    expect(aimAnchor(r.waypoints, null)!.id).toBe("b");
    expect(aimAnchor(r.waypoints, "gone")!.id).toBe("b");
    expect(aimAnchor([], null)).toBeNull();
  });
  test("bearing and distance to the aim", () => {
    const l = aimLeg(r.waypoints[0]!, at(10, 57))!;
    expect(l.brgDeg).toBeCloseTo(0, 5);
    expect(l.distNm).toBeCloseTo(60, 0);
    expect(aimLeg(null, at(10, 57))).toBeNull();
    expect(aimLeg(r.waypoints[0]!, null)).toBeNull();
    // On the anchor (just placed there): no band, no "0 m" readout.
    expect(aimLeg(r.waypoints[0]!, at(10, 56))).toBeNull();
    // A few metres off (a nudge after "+ Here") would still READ "0 m"
    // (the readout rounds to 10 m): hidden too. ~3 m north:
    expect(aimLeg(r.waypoints[0]!, at(10, 56.000027))).toBeNull();
    // ~6 m reads "10 m": shown.
    expect(aimLeg(r.waypoints[0]!, at(10, 56.000054))).not.toBeNull();
  });
});

// ── index.ts — model + mode against a fake client ───────────────────────────

function fakeClient(initial: Route[] = []) {
  const [routes, setRoutes] = createSignal<Route[]>(initial);
  const [active, setActiveSig] = createSignal<ActiveLeg | null>(null);
  const saves: Route[] = [];
  let failWith: number | null = null;
  const client: RoutesClient = {
    routes,
    active,
    refresh: async () => {},
    save: async (r) => {
      saves.push(r);
      if (failWith !== null) {
        const s = failWith;
        failWith = null;
        throw new RouteSaveError(s, `PUT → ${s}`);
      }
      const saved = { ...r, rev: r.rev + 1, updated: 1 };
      setRoutes((rs) => [saved, ...rs.filter((x) => x.id !== saved.id)]);
      return saved;
    },
    remove: async () => {},
    setActive: async (leg) => void setActiveSig(leg),
  };
  return { client, saves, setRoutes, failNext: (status: number) => (failWith = status) };
}

function harness(initial: Route[] = [], opts: { marks?: SnapMark[] } = {}) {
  return createRoot((dispose) => {
    const fake = fakeClient(initial);
    let n = 0;
    const notices: string[] = [];
    const titles: string[] = [];
    const buzzes: number[] = [];
    const closedSaved: string[] = [];
    const [center, setCenter] = createSignal<{ lng: number; lat: number } | null>(null);
    const [marks, setMarks] = createSignal<SnapMark[]>(opts.marks ?? []);
    const { feature, model } = createRouteDraw({
      client: fake.client,
      mintId: () => `id${++n}`,
      notify: (x) => {
        notices.push(x.id);
        titles.push(x.title);
      },
      tapRadius: () => 8,
      center,
      marks,
      vibrate: (ms) => void buzzes.push(ms),
      // Never the real per-device store: tests must not see each other's toggle.
      crosshairSetting: createSignal(false),
      onClosedSaved: (r) => void closedSaved.push(r.id),
    });
    const modes = createModeState(createRegistry([feature.core]));
    model.bindMode({ enter: () => modes.enter(ROUTE_DRAW_MODE_ID), leave: () => modes.leave() });
    const mode = feature.core.modes![0]!;
    return { ...fake, model, modes, mode, notices, titles, buzzes, closedSaved, setCenter, setMarks, dispose };
  });
}

/** The fake map's projection (1° = 100px) — for model tests that snap without a host. */
const project100 = (p: { lng: number; lat: number }) => ({ x: p.lng * 100, y: p.lat * 100 });

const at = (lng: number, lat: number) => ({ lng, lat });
const ids = (r: Route | null) => r?.waypoints.map((w) => w.id) ?? [];
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("routeDraw model", () => {
  test("the mode is visible regardless of the route planner and is not solo", () => {
    const h = harness();
    expect(h.mode.hidden).toBeUndefined();
    expect(h.mode.solo).toBeFalsy();
    expect(h.mode.label).toBe("New route");
    h.dispose();
  });

  test("New route: taps append, each new point selected; first selected → prepend", () => {
    const h = harness();
    h.model.newRoute();
    expect(h.modes.active()).toBe(ROUTE_DRAW_MODE_ID);
    expect(h.model.draft()!.rev).toBe(0);
    h.model.tap({ op: "append" }, at(10, 56));
    h.model.tap({ op: "append" }, at(11, 56));
    expect(h.model.selection()).toEqual({ kind: "point", id: "id3" });
    h.model.tap({ op: "selectPoint", id: "id2" }, at(10, 56));
    h.model.tap({ op: "prepend" }, at(9, 56));
    expect(ids(h.model.draft())).toEqual(["id4", "id2", "id3"]);
    expect(h.model.draft()!.waypoints.every((w) => w.stop === true)).toBe(true);
    // Each tap was one step.
    h.model.undo();
    h.model.undo();
    expect(ids(h.model.draft())).toEqual(["id2"]);
    h.model.redo();
    expect(ids(h.model.draft())).toEqual(["id2", "id3"]);
    h.dispose();
  });

  test("planning speed and departure are draft edits: one undo step each, saved on Done", async () => {
    const h = harness([route([["a", 56, 10], ["b", 56, 12]])]);
    h.model.edit(route([["a", 56, 10], ["b", 56, 12]]));
    h.model.setPlanSpeed(6.5);
    h.model.setDepartAt("2026-11-06T09:30:00Z");
    expect(h.model.dirty()).toBe(true);
    expect(h.model.plan().totalSec).toBeCloseTo((h.model.plan().totalNm / 6.5) * 3600, 3);
    h.model.undo();
    expect(h.model.draft()!.depart_at ?? null).toBeNull();
    expect(h.model.draft()!.plan_speed_kn).toBe(6.5);
    h.model.undo();
    expect(h.model.draft()!.plan_speed_kn).toBe(5);
    expect(h.model.dirty()).toBe(false);
    h.model.redo();
    h.model.redo();
    await h.model.done();
    expect(h.saves.at(-1)).toMatchObject({ plan_speed_kn: 6.5, depart_at: "2026-11-06T09:30:00Z" });
    h.dispose();
  });

  test("undo keeps a leg selection while that leg is unchanged; drops it when an end moved", () => {
    const h = harness([route([["a", 56, 10], ["b", 56, 12], ["c", 57, 12]])]);
    h.model.edit(route([["a", 56, 10], ["b", 56, 12], ["c", 57, 12]]));
    h.model.select({ kind: "leg", leg: 1, at: at(12, 56.5) });
    h.model.setPlanSpeed(7); // the leg table's speed stepper
    h.model.undo();
    expect(h.model.selection()).toMatchObject({ kind: "leg", leg: 1 });
    h.model.redo();
    expect(h.model.selection()).toMatchObject({ kind: "leg", leg: 1 });
    // A moved end: the leg's spot is stale — dropped.
    h.model.beginMove("c");
    h.model.dragTo(at(13, 57));
    h.model.endDrag();
    h.model.select({ kind: "leg", leg: 1, at: at(12.5, 56.5) });
    h.model.undo();
    expect(h.model.selection()).toBeNull();
    h.dispose();
  });

  test("a leg tap inserts a point there; delete; rename — all undoable", () => {
    const h = harness();
    h.model.newRoute();
    h.model.tap({ op: "append" }, at(10, 56));
    h.model.tap({ op: "append" }, at(12, 56));
    h.model.tap({ op: "insertOnLeg", leg: 0, at: { x: 0, y: 0 } }, at(11, 56));
    expect(h.model.draft()!.waypoints[1]).toMatchObject({ lon: 11, lat: 56 });
    expect(h.model.selection()).toEqual({ kind: "point", id: h.model.draft()!.waypoints[1]!.id });
    const mid = h.model.draft()!.waypoints[1]!.id;
    h.model.renamePoint(mid, "Mid");
    expect(h.model.draft()!.waypoints[1]!.name).toBe("Mid");
    h.model.deleteSelected();
    expect(h.model.draft()!.waypoints.length).toBe(2);
    expect(h.model.selection()).toBeNull();
    h.model.undo();
    h.model.undo();
    expect(h.model.draft()!.waypoints[1]!.name).toBe("");
    h.dispose();
  });

  test("a drag is one undo step; cancel restores; a + drag inserts", () => {
    const h = harness([route([["a", 56, 10], ["b", 56, 12]])]);
    h.model.edit(route([["a", 56, 10], ["b", 56, 12]]));
    h.model.beginMove("a");
    h.model.dragTo(at(10, 56.1));
    h.model.dragTo(at(10, 56.2));
    h.model.endDrag();
    expect(h.model.draft()!.waypoints[0]!.lat).toBe(56.2);
    h.model.undo();
    expect(h.model.draft()!.waypoints[0]!.lat).toBe(56);

    h.model.beginMove("b");
    h.model.dragTo(at(13, 57));
    h.model.cancelDrag();
    expect(h.model.draft()!.waypoints[1]).toMatchObject({ lat: 56, lon: 12 });
    expect(h.model.canUndo()).toBe(false);

    h.model.beginInsert(0, at(11, 56));
    expect(h.model.draft()!.waypoints.length).toBe(3);
    h.model.dragTo(at(11, 55.5));
    h.model.endDrag();
    expect(h.model.draft()!.waypoints[1]).toMatchObject({ lat: 55.5, lon: 11 });
    h.model.undo();
    expect(ids(h.model.draft())).toEqual(["a", "b"]);

    h.model.beginInsert(0, at(11, 56));
    h.model.cancelDrag();
    expect(ids(h.model.draft())).toEqual(["a", "b"]);
    expect(h.model.selection()).toBeNull();
    h.dispose();
  });

  test("editing works on a COPY; nothing saves until Done; Done saves once with the rev", async () => {
    const saved = route([["a", 56, 10], ["b", 56, 12]]);
    const h = harness([saved]);
    h.model.edit(saved);
    expect(h.mode.label).toBe("Edit route");
    expect(h.model.editingRouteId()).toBe("r1");
    h.model.tap({ op: "append" }, at(13, 56));
    expect(saved.waypoints.length).toBe(2);
    expect(h.saves.length).toBe(0);
    await h.model.done();
    expect(h.saves.length).toBe(1);
    expect(h.saves[0]!.rev).toBe(3);
    expect(h.saves[0]!.waypoints.length).toBe(3);
    expect(h.modes.active()).toBeNull();
    expect(h.model.draft()).toBeNull();
    expect(h.model.editingRouteId()).toBeNull();
    h.dispose();
  });

  test("Done on a clean draft saves nothing; Cancel on a clean draft just leaves", async () => {
    const saved = route([["a", 56, 10]]);
    const h = harness([saved]);
    h.model.edit(saved);
    await h.model.done();
    expect(h.saves.length).toBe(0);
    expect(h.modes.active()).toBeNull();
    h.model.newRoute();
    h.model.cancel();
    expect(h.modes.active()).toBeNull();
    h.dispose();
  });

  test("Cancel when dirty asks first; a second Cancel (or Discard) discards", () => {
    const h = harness();
    h.model.newRoute();
    h.model.tap({ op: "append" }, at(10, 56));
    expect(h.modes.leave()).toBe(false);
    expect(h.model.confirmingDiscard()).toBe(true);
    expect(h.modes.active()).toBe(ROUTE_DRAW_MODE_ID);
    h.model.keepEditing();
    expect(h.model.confirmingDiscard()).toBe(false);
    h.model.cancel();
    expect(h.model.confirmingDiscard()).toBe(true);
    // Editing on answers the confirm.
    h.model.tap({ op: "append" }, at(11, 56));
    expect(h.model.confirmingDiscard()).toBe(false);
    h.model.cancel();
    h.model.discard();
    expect(h.modes.active()).toBeNull();
    expect(h.saves.length).toBe(0);
    h.model.newRoute();
    h.model.tap({ op: "append" }, at(10, 56));
    h.modes.leave();
    expect(h.modes.leave()).toBe(true);
    h.dispose();
  });

  test("undoing back to the original is clean again", () => {
    const saved = route([["a", 56, 10]]);
    const h = harness([saved]);
    h.model.edit(saved);
    h.model.tap({ op: "append" }, at(11, 56));
    expect(h.model.dirty()).toBe(true);
    h.model.undo();
    expect(h.model.dirty()).toBe(false);
    h.dispose();
  });

  test("409: the draft is kept and the user is told; Overwrite saves at the server's rev", async () => {
    const saved = route([["a", 56, 10]]);
    const h = harness([saved]);
    h.model.edit(saved);
    h.model.tap({ op: "append" }, at(11, 56));
    h.failNext(409);
    await h.model.done();
    expect(h.model.conflict()).toBe(true);
    expect(h.notices).toContain("route-draw-conflict");
    expect(h.modes.active()).toBe(ROUTE_DRAW_MODE_ID);
    expect(h.model.draft()!.waypoints.length).toBe(2);
    h.setRoutes([{ ...saved, rev: 7 }]);
    await h.model.overwrite();
    expect(h.saves.at(-1)!.rev).toBe(7);
    expect(h.modes.active()).toBeNull();
    h.dispose();
  });

  test("409 on a route deleted on another screen says so; Overwrite recreates it", async () => {
    const saved = route([["a", 56, 10]]);
    const h = harness([saved]);
    h.model.edit(saved);
    h.model.tap({ op: "append" }, at(11, 56));
    h.setRoutes([]); // deleted elsewhere
    h.failNext(409);
    await h.model.done();
    expect(h.model.conflict()).toBe(true);
    expect(h.model.conflictDeleted()).toBe(true);
    expect(h.notices.at(-1)).toBe("route-draw-conflict");
    expect(h.titles.at(-1)).toBe("Route deleted on another screen");
    expect(h.modes.active()).toBe(ROUTE_DRAW_MODE_ID);
    await h.model.overwrite();
    expect(h.saves.at(-1)!.rev).toBe(0);
    expect(h.model.conflict()).toBe(false);
    expect(h.modes.active()).toBeNull();
    h.dispose();
  });

  test("409 → Save as copy creates a new route", async () => {
    const saved = route([["a", 56, 10]]);
    const h = harness([saved]);
    h.model.edit(saved);
    h.model.tap({ op: "append" }, at(11, 56));
    h.failNext(409);
    await h.model.done();
    await h.model.saveCopy();
    const copy = h.saves.at(-1)!;
    expect(copy.id).not.toBe("r1");
    expect(copy.rev).toBe(0);
    expect(copy.name).toBe("Passage (copy)");
    h.dispose();
  });

  test("a network failure keeps the draft open", async () => {
    const h = harness();
    h.model.newRoute();
    h.model.tap({ op: "append" }, at(10, 56));
    h.failNext(503);
    await h.model.done();
    expect(h.model.conflict()).toBe(false);
    expect(h.notices).toContain("route-draw-failed");
    expect(h.modes.active()).toBe(ROUTE_DRAW_MODE_ID);
    h.dispose();
  });

  test("Go needs a selected point; a dirty or new draft is saved first, then followed", async () => {
    const saved = route([["a", 56, 10], ["b", 56, 12]]);
    const h = harness([saved]);
    h.model.edit(saved);
    expect(h.model.canGo()).toBe(false);
    h.model.tap({ op: "selectPoint", id: "b" }, at(12, 56));
    expect(h.model.canGo()).toBe(true);
    // Clean: no save, straight to following.
    await h.model.go();
    expect(h.saves.length).toBe(0);
    expect(h.client.active()).toEqual({ route_id: "r1", waypoint_id: "b" });
    expect(h.modes.active()).toBeNull();

    // Dirty: one quiet save (no "Route saved" notice), then follow.
    h.model.edit(h.client.routes()[0]!);
    h.model.tap({ op: "selectPoint", id: "a" }, at(10, 56));
    h.model.renamePoint("a", "x");
    expect(h.model.canGo()).toBe(true);
    await h.model.go();
    expect(h.saves.length).toBe(1);
    expect(h.saves[0]!.waypoints[0]!.name).toBe("x");
    expect(h.notices).not.toContain("route-draw-saved");
    expect(h.client.active()).toEqual({ route_id: "r1", waypoint_id: "a" });
    expect(h.modes.active()).toBeNull();

    // A brand-new route: created, then followed.
    h.model.newRoute();
    h.model.tap({ op: "append" }, at(10, 56));
    expect(h.model.canGo()).toBe(true);
    await h.model.go();
    expect(h.saves.length).toBe(2);
    expect(h.client.active()?.route_id).toBe(h.saves[1]!.id);
    h.dispose();
  });

  test("Go that cannot save stays in the editor and follows nothing", async () => {
    const h = harness();
    h.model.newRoute();
    h.model.tap({ op: "append" }, at(10, 56));
    h.failNext(500);
    await h.model.go();
    expect(h.client.active()).toBeNull();
    expect(h.modes.active()).toBe(ROUTE_DRAW_MODE_ID);
    expect(h.model.dirty()).toBe(true);
    h.dispose();
  });

  test("closing on a saved route hands it over to stay on the chart; Cancel and empty routes don't", async () => {
    const h = harness();
    h.model.newRoute();
    await h.model.done(); // blank, never placed
    expect(h.closedSaved).toEqual([]);
    h.model.newRoute();
    h.model.tap({ op: "append" }, at(10, 56));
    h.model.tap({ op: "append" }, at(11, 56));
    await h.model.done();
    expect(h.closedSaved).toEqual([h.saves[0]!.id]);
    // Reopened and closed clean: still handed over (it was showing before).
    h.model.edit(h.client.routes()[0]!);
    await h.model.done();
    expect(h.closedSaved.length).toBe(2);
    // Cancel: not.
    h.model.edit(h.client.routes()[0]!);
    h.model.cancel();
    expect(h.closedSaved.length).toBe(2);
    h.dispose();
  });

  test("switching routes while dirty asks Discard / Keep editing", async () => {
    const h = harness();
    h.model.newRoute();
    h.model.tap({ op: "append" }, at(10, 56));
    const other = route([["a", 56, 10]]);
    h.model.edit(other);
    // Asked, not switched, nothing said in a notice.
    expect(h.model.confirmingDiscard()).toBe(true);
    expect(h.model.draft()!.rev).toBe(0);
    expect(h.notices).toEqual([]);
    // Keep editing: the draft stays; a later Discard is a plain Cancel again.
    h.model.keepEditing();
    expect(h.model.confirmingDiscard()).toBe(false);
    expect(ids(h.model.draft())).toEqual(["id2"]);
    // Ask again, and Discard: the other route opens, the editor stays open.
    h.model.edit(other);
    h.model.discard();
    expect(h.modes.active()).toBe(ROUTE_DRAW_MODE_ID);
    expect(h.model.draft()!.id).toBe("r1");
    expect(h.model.dirty()).toBe(false);
    expect(h.model.confirmingDiscard()).toBe(false);
    expect(h.saves).toEqual([]);
    await flush();
    h.dispose();
  });

  test("an edit while the switch is asked answers 'keep editing'", () => {
    const h = harness();
    h.model.newRoute();
    h.model.tap({ op: "append" }, at(10, 56));
    h.model.newRoute();
    expect(h.model.confirmingDiscard()).toBe(true);
    h.model.tap({ op: "append" }, at(11, 56));
    expect(h.model.confirmingDiscard()).toBe(false);
    // The armed switch is gone: Discard now closes, it doesn't open a blank.
    h.model.cancel();
    h.model.discard();
    expect(h.modes.active()).toBeNull();
    h.dispose();
  });

  test("New route from here: point 1 is the pressed spot, one undo step", () => {
    const h = harness();
    h.model.newRouteFrom(at(10.5, 56.2));
    expect(h.modes.active()).toBe(ROUTE_DRAW_MODE_ID);
    expect(h.model.draft()!.waypoints.map((w) => [w.lon, w.lat])).toEqual([[10.5, 56.2]]);
    expect(h.model.selection()).toEqual({ kind: "point", id: "id2" });
    h.model.undo();
    expect(h.model.draft()!.waypoints).toEqual([]);
    h.dispose();
  });

  test("every click is consumed while the editor is open (no info panel under it)", () => {
    const h = harness();
    const click = { point: { x: 0, y: 0 }, lngLat: { lng: 0, lat: 0 }, radius: 8, pick: () => [] };
    expect(h.modes.handleClick(click)).toBe(false);
    h.model.newRoute();
    expect(h.modes.handleClick(click)).toBe(true);
    h.dispose();
  });
});

describe("routeDraw model — crosshair and snapping", () => {
  test("off by default; + Here appends at the centre, one undo step each", () => {
    const h = harness();
    h.model.newRoute();
    expect(h.model.crosshair()).toBe(false);
    expect(h.model.aim()).toBeNull();
    h.model.setCrosshair(true);
    h.setCenter(at(10, 56));
    expect(h.model.aim()).toEqual(at(10, 56));
    h.model.addHere();
    h.setCenter(at(11, 56));
    h.model.addHere();
    expect(h.model.draft()!.waypoints.map((w) => [w.lon, w.lat])).toEqual([[10, 56], [11, 56]]);
    h.model.undo();
    expect(h.model.draft()!.waypoints.length).toBe(1);
    h.dispose();
  });

  test("+ Here prepends with point 1 selected; Move here moves the selected point", () => {
    const saved = route([["a", 56, 10], ["b", 56, 11]]);
    const h = harness([saved]);
    h.model.edit(saved);
    h.model.setCrosshair(true);
    h.model.select({ kind: "point", id: "a" });
    h.setCenter(at(9, 56));
    h.model.addHere();
    expect(h.model.draft()!.waypoints[0]!.lon).toBe(9);
    h.model.select({ kind: "point", id: "b" });
    h.setCenter(at(12, 57));
    h.model.moveHere();
    expect(h.model.draft()!.waypoints.at(-1)).toMatchObject({ id: "b", lon: 12, lat: 57 });
    h.model.undo();
    expect(h.model.draft()!.waypoints.at(-1)).toMatchObject({ id: "b", lon: 11, lat: 56 });
    h.dispose();
  });

  test("the rubber band runs from the selected point, else the last", () => {
    const saved = route([["a", 56, 10], ["b", 56, 11]]);
    const h = harness([saved]);
    h.model.edit(saved);
    h.setCenter(at(11, 57));
    expect(h.model.aimLeg()).toBeNull(); // crosshair off
    h.model.setCrosshair(true);
    expect(h.model.aimLeg()!.from).toEqual(at(11, 56));
    h.model.select({ kind: "point", id: "a" });
    expect(h.model.aimLeg()!.from).toEqual(at(10, 56));
    h.dispose();
  });

  test("a crosshair-mode tap on water adds nothing and deselects", () => {
    const saved = route([["a", 56, 10]]);
    const h = harness([saved]);
    h.model.edit(saved);
    h.model.setCrosshair(true);
    h.model.select({ kind: "point", id: "a" });
    h.model.tap({ op: "deselect" }, at(12, 56));
    expect(h.model.selection()).toBeNull();
    expect(h.model.draft()!.waypoints.length).toBe(1);
    h.dispose();
  });

  test("adding near a mark snaps onto it, takes its name, and buzzes", () => {
    const h = harness([], { marks: [{ id: "m", name: "Buoy", lat: 56, lon: 10 }] });
    h.model.bindProjector(project100);
    h.model.newRoute();
    h.model.tap({ op: "append" }, at(10.1, 56.05)); // 11px off: snaps (radius 8+8)
    expect(h.model.draft()!.waypoints[0]).toMatchObject({ lat: 56, lon: 10, name: "Buoy" });
    expect(h.buzzes.length).toBe(1);
    h.model.tap({ op: "append" }, at(10.5, 56)); // 50px off: doesn't
    expect(h.model.draft()!.waypoints[1]).toMatchObject({ lat: 56, lon: 10.5, name: "" });
    expect(h.buzzes.length).toBe(1);
    h.dispose();
  });

  test("the aim snaps too: the crosshair shows the mark, + Here lands on it", () => {
    const h = harness([], { marks: [{ id: "m", name: "Buoy", lat: 56, lon: 10 }] });
    h.model.bindProjector(project100);
    h.model.newRoute();
    h.model.setCrosshair(true);
    h.setCenter(at(10.05, 56.05));
    expect(h.model.snapTarget()?.id).toBe("m");
    expect(h.model.aim()).toEqual(at(10, 56));
    expect(h.buzzes.length).toBe(1);
    h.model.addHere();
    expect(h.model.draft()!.waypoints[0]).toMatchObject({ lat: 56, lon: 10, name: "Buoy" });
    h.dispose();
  });

  test("the point is a COPY: moving the mark afterwards leaves it alone", () => {
    const h = harness([], { marks: [{ id: "m", name: "Buoy", lat: 56, lon: 10 }] });
    h.model.bindProjector(project100);
    h.model.newRoute();
    h.model.tap({ op: "append" }, at(10, 56));
    h.setMarks([{ id: "m", name: "Buoy", lat: 57, lon: 11 }]);
    expect(h.model.draft()!.waypoints[0]).toMatchObject({ lat: 56, lon: 10 });
    h.dispose();
  });

  test("a drag lights up the mark it will snap to, and lands on it — one undo step", () => {
    const saved = route([["a", 56, 10], ["b", 56, 11]]);
    saved.waypoints[0]!.name = "Start";
    const h = harness([saved], { marks: [{ id: "m", name: "Buoy", lat: 57, lon: 10 }] });
    h.model.bindProjector(project100);
    h.model.edit(saved);
    h.model.beginMove("a");
    h.model.dragTo(at(10, 56.5));
    expect(h.model.snapTarget()).toBeNull();
    h.model.dragTo(at(10.05, 56.95));
    expect(h.model.snapTarget()?.id).toBe("m");
    expect(h.buzzes.length).toBe(1);
    h.model.dragTo(at(10.06, 56.95)); // same mark: no second buzz
    expect(h.buzzes.length).toBe(1);
    h.model.endDrag();
    // On the mark; its own name kept.
    expect(h.model.draft()!.waypoints[0]).toMatchObject({ lat: 57, lon: 10, name: "Start" });
    expect(h.model.snapTarget()).toBeNull();
    h.model.undo();
    expect(h.model.draft()!.waypoints[0]).toMatchObject({ lat: 56, lon: 10 });
    h.dispose();
  });

  test("a + drag dropped near a mark inserts onto it; a cancelled drag never snaps", () => {
    const saved = route([["a", 56, 10], ["b", 56, 12]]);
    const h = harness([saved], { marks: [{ id: "m", name: "Buoy", lat: 57, lon: 11 }] });
    h.model.bindProjector(project100);
    h.model.edit(saved);
    h.model.beginInsert(0, at(11, 56));
    h.model.dragTo(at(11.03, 57));
    h.model.endDrag();
    expect(h.model.draft()!.waypoints[1]).toMatchObject({ lat: 57, lon: 11, name: "Buoy" });
    h.model.select({ kind: "point", id: "a" });
    h.model.beginMove("a");
    h.model.dragTo(at(11.03, 57));
    h.model.cancelDrag();
    expect(h.model.draft()!.waypoints[0]).toMatchObject({ lat: 56, lon: 10 });
    expect(h.model.snapTarget()).toBeNull();
    h.dispose();
  });
});

// ── overlay.ts — the MapLibre host against a fake map ───────────────────────

/** A fake map: 1° = 100px, origin at (0,0). */
function fakeMap() {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const calls: string[] = [];
  const canvas = { style: { cursor: "" } };
  let data: unknown = null;
  const map = {
    on(type: string, fn: (e: unknown) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    off(type: string, fn: (e: unknown) => void) {
      listeners.get(type)?.delete(fn);
    },
    project: ([lng, lat]: [number, number]) => ({ x: lng * 100, y: lat * 100 }),
    unproject: ([x, y]: [number, number]) => ({ lng: x / 100, lat: y / 100 }),
    dragPan: {
      enable: () => void calls.push("dragPan.enable"),
      disable: () => void calls.push("dragPan.disable"),
    },
    getCanvas: () => canvas,
    getSource: () => ({ setData: (d: unknown) => (data = d) }),
  };
  const fire = (type: string, x: number, y: number, fingers = 1) => {
    const e = {
      point: { x, y },
      originalEvent: { touches: { length: type === "touchend" ? 0 : fingers }, button: 0 },
    };
    for (const fn of listeners.get(type) ?? []) fn(e);
  };
  const touchTap = (x: number, y: number) => {
    fire("touchstart", x, y);
    fire("touchend", x, y);
  };
  return { map: map as unknown as MLMap, calls, fire, touchTap, data: () => data };
}

describe("routeDraw host", () => {
  test("inert outside the editor", () => {
    const h = harness();
    const f = fakeMap();
    attachRouteDrawGestures(f.map, h.model, () => 8);
    f.touchTap(1000, 5600);
    expect(h.model.draft()).toBeNull();
    expect(f.calls).toEqual([]);
    h.dispose();
  });

  test("taps on water append; a tap on a point selects it; a pan places nothing", () => {
    const h = harness();
    const f = fakeMap();
    attachRouteDrawGestures(f.map, h.model, () => 8);
    h.model.newRoute();
    f.touchTap(1000, 5600);
    f.touchTap(1200, 5600);
    expect(h.model.draft()!.waypoints.map((w) => [w.lon, w.lat])).toEqual([
      [10, 56],
      [12, 56],
    ]);
    // A pan over water: no point.
    f.fire("touchstart", 1500, 5600);
    f.fire("touchmove", 1560, 5600);
    f.fire("touchend", 1560, 5600);
    expect(h.model.draft()!.waypoints.length).toBe(2);
    // Select the first point → the next water tap prepends.
    f.touchTap(1001, 5601);
    expect(h.model.selection()).toEqual({ kind: "point", id: "id2" });
    f.touchTap(800, 5600);
    expect(h.model.draft()!.waypoints[0]!.lon).toBe(8);
    expect(f.calls).toEqual([]); // nothing ever captured the pan
    h.dispose();
  });

  test("an unselected point pans; the selected one drags with the pan disabled", () => {
    const saved = route([["a", 56, 10], ["b", 56, 12]]);
    const h = harness([saved]);
    const f = fakeMap();
    attachRouteDrawGestures(f.map, h.model, () => 8);
    h.model.edit(saved);
    f.fire("touchstart", 1000, 5600);
    f.fire("touchmove", 1050, 5650);
    f.fire("touchend", 1050, 5650);
    expect(h.model.draft()!.waypoints[0]).toMatchObject({ lon: 10, lat: 56 });
    expect(f.calls).toEqual([]);

    h.model.select({ kind: "point", id: "a" });
    f.fire("touchstart", 1000, 5600);
    f.fire("touchmove", 1050, 5650);
    f.fire("touchend", 1050, 5650);
    expect(h.model.draft()!.waypoints[0]).toMatchObject({ lon: 10.5, lat: 56.5 });
    expect(f.calls).toEqual(["dragPan.disable", "dragPan.enable"]);
    h.model.undo();
    expect(h.model.draft()!.waypoints[0]).toMatchObject({ lon: 10, lat: 56 });
    h.dispose();
  });

  test("a second finger mid-drag restores the point and gives the map back", () => {
    const saved = route([["a", 56, 10], ["b", 56, 12]]);
    const h = harness([saved]);
    const f = fakeMap();
    attachRouteDrawGestures(f.map, h.model, () => 8);
    h.model.edit(saved);
    h.model.select({ kind: "point", id: "a" });
    f.fire("touchstart", 1000, 5600);
    f.fire("touchmove", 1030, 5600);
    expect(h.model.draft()!.waypoints[0]!.lon).toBeCloseTo(10.3);
    f.fire("touchstart", 1030, 5600, 2);
    expect(h.model.draft()!.waypoints[0]).toMatchObject({ lon: 10, lat: 56 });
    expect(h.model.draggingId()).toBeNull();
    expect(f.calls).toEqual(["dragPan.disable", "dragPan.enable"]);
    f.fire("touchend", 1030, 5600);
    expect(h.model.draft()!.waypoints.length).toBe(2);
    h.dispose();
  });

  test("a tap anywhere on a line inserts a point there (not just the middle)", () => {
    const saved = route([["a", 56, 10], ["b", 56, 12]]);
    const h = harness([saved]);
    const f = fakeMap();
    attachRouteDrawGestures(f.map, h.model, () => 8);
    h.model.edit(saved);
    f.touchTap(1040, 5603); // 20% along the leg, 3px off the line
    const wps = h.model.draft()!.waypoints;
    expect(wps.length).toBe(3);
    expect(wps[1]).toMatchObject({ lon: 10.4, lat: 56 });
    expect(h.model.selection()).toEqual({ kind: "point", id: wps[1]!.id });
    h.dispose();
  });

  test("crosshair on: a water tap adds nothing; a point tap still selects", () => {
    const saved = route([["a", 56, 10]]);
    const h = harness([saved]);
    const f = fakeMap();
    attachRouteDrawGestures(f.map, h.model, () => 8);
    h.model.edit(saved);
    h.model.setCrosshair(true);
    f.touchTap(1200, 5600);
    expect(h.model.draft()!.waypoints.length).toBe(1);
    f.touchTap(1000, 5600);
    expect(h.model.selection()).toEqual({ kind: "point", id: "a" });
    h.dispose();
  });

  test("the host lends its projection for snapping, and takes it back", () => {
    const h = harness([], { marks: [{ id: "m", name: "Buoy", lat: 56, lon: 10 }] });
    const f = fakeMap();
    const detach = attachRouteDrawGestures(f.map, h.model, () => 8);
    h.model.newRoute();
    f.touchTap(1005, 5605);
    expect(h.model.draft()!.waypoints[0]).toMatchObject({ lat: 56, lon: 10, name: "Buoy" });
    detach();
    h.model.tap({ op: "append" }, at(10.05, 56.05));
    expect(h.model.draft()!.waypoints[1]).toMatchObject({ lat: 56.05, lon: 10.05 });
    h.dispose();
  });

  test("the overlay draws the rubber band and the snap ring", () => {
    const saved = route([["a", 56, 10], ["b", 56, 11]]);
    const h = harness([saved], { marks: [{ id: "m", name: "Buoy", lat: 57, lon: 11 }] });
    const f = fakeMap();
    h.model.bindProjector(project100);
    h.model.edit(saved);
    h.model.setCrosshair(true);
    h.setCenter(at(11.02, 57.02));
    updateRouteDrawData(f.map, h.model);
    const feats = (f.data() as { features: { properties: Record<string, unknown>; geometry: { coordinates: unknown } }[] })
      .features;
    const band = feats.find((x) => x.properties.kind === "band")!;
    expect(band.geometry.coordinates).toEqual([
      [11, 56],
      [11, 57],
    ]);
    expect(feats.filter((x) => x.properties.kind === "snap").map((x) => x.properties.id)).toEqual(["m"]);
    h.dispose();
  });

  test("the overlay draws numbered points and no extra handles", () => {
    const saved = route([["a", 56, 10], ["b", 56, 12], ["c", 56, 12.3]]);
    const h = harness([saved]);
    const f = fakeMap();
    h.model.edit(saved);
    h.model.select({ kind: "point", id: "b" });
    updateRouteDrawData(f.map, h.model);
    const feats = (f.data() as { features: { properties: Record<string, unknown> }[] }).features;
    const kinds = feats.map((x) => x.properties.kind);
    expect(kinds.filter((k) => k === "point").length).toBe(3);
    expect(feats.filter((x) => x.properties.kind === "point").map((x) => x.properties.n)).toEqual(["1", "2", "3"]);
    expect(kinds.filter((k) => k !== "point" && k !== "line")).toEqual([]);
    h.dispose();
  });
});
