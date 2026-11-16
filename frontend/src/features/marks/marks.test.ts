import { describe, expect, test } from "bun:test";
import { createEffect, createRoot, createSignal } from "solid-js";
import type { Map as MLMap } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import type { OverlayCtx } from "../../core/layers/overlay";
import type { InfoHit } from "../../core/info/types";
import type { SignalKState } from "../../core/signalk";
import { DEFAULT_SETTINGS } from "../../core/style/settings";
import type { MarksApi } from "./client";
import { createMarks, MARK_MOVE_MODE_ID } from "./index";
import { createLongPress } from "./longPress";
import {
  filterMarks,
  iconOf,
  markFeatures,
  markIconId,
  nextMarkName,
  sortMarks,
  type Mark,
  type MarkBody,
} from "./model";
import { createMarksOverlay } from "./overlay";
import { createMarkProvider, MARK_PROVIDER_ID } from "./provider";

const mark = (id: string, over: Partial<Mark> = {}): Mark => ({
  id,
  name: id,
  note: "",
  icon: "pin",
  lat: 56,
  lon: 10,
  updated: 0,
  ...over,
});

describe("model", () => {
  test("next name fills the lowest free number", () => {
    expect(nextMarkName([])).toBe("Mark 1");
    expect(nextMarkName([{ name: "Mark 1" }, { name: "Mark 3" }, { name: "Rock" }])).toBe("Mark 2");
  });

  test("an icon this build doesn't know draws as a pin", () => {
    expect(iconOf({ icon: "unicorn" as Mark["icon"] })).toBe("pin");
    expect(iconOf({ icon: "danger" })).toBe("danger");
  });

  test("search matches name, note and icon label; every word must match", () => {
    const all = [mark("a", { name: "Rock", note: "dries" }), mark("b", { name: "Cove", icon: "anchor" })];
    expect(filterMarks(all, "rock dries").map((m) => m.id)).toEqual(["a"]);
    expect(filterMarks(all, "anchorage").map((m) => m.id)).toEqual(["b"]);
    expect(filterMarks(all, "").length).toBe(2);
  });

  test("sort by distance when there is one, else by name", () => {
    const all = [mark("b", { name: "B" }), mark("a", { name: "A" })];
    expect(sortMarks(all).map((m) => m.id)).toEqual(["a", "b"]);
    expect(sortMarks(all, (m) => (m.id === "b" ? 1 : 2)).map((m) => m.id)).toEqual(["b", "a"]);
  });

  test("the chart scene is points only — never an area that could wash the chart", () => {
    const fc = markFeatures([mark("a", { icon: "star" }), mark("b")], "day");
    expect(fc.features.every((f) => f.geometry.type === "Point")).toBe(true);
    expect(fc.features[0].properties?.icon).toBe(markIconId("star", "day"));
    expect(fc.features[0].geometry).toEqual({ type: "Point", coordinates: [10, 56] });
  });
});

describe("overlay", () => {
  test("a new mark draws even when the first update ran before the source existed", () => {
    // wireOverlays' effect runs on `loaded` BEFORE ensure adds the source; it
    // must still subscribe to the marks, or a new one waits for a reload.
    const [list, setList] = createSignal<Mark[]>([]);
    let source: { setData: (d: FeatureCollection) => void } | undefined;
    const sent: FeatureCollection[] = [];
    const map = { getSource: () => source, hasImage: () => true, addImage() {} } as unknown as MLMap;
    const ctx = { settings: () => DEFAULT_SETTINGS } as unknown as OverlayCtx;
    const ov = createMarksOverlay((palette) => markFeatures(list(), palette), () => {});
    const dispose = createRoot((d) => {
      createEffect(() => ov.update(map, ctx));
      return d;
    });
    source = { setData: (d) => sent.push(d) };
    setList([mark("a")]);
    expect(sent.at(-1)?.features.length).toBe(1);
    setList([]);
    expect(sent.at(-1)?.features.length).toBe(0);
    dispose();
  });
});

describe("long-press", () => {
  const harness = () => {
    let pending: (() => void) | undefined;
    const pressed: { x: number; y: number }[] = [];
    const lp = createLongPress({
      onPress: (at) => pressed.push(at),
      setTimer: (fn) => {
        pending = fn;
        return 1;
      },
      clearTimer: () => {
        pending = undefined;
      },
    });
    return { lp, pressed, fire: () => pending?.() };
  };

  test("a still finger fires once at where it went down", () => {
    const h = harness();
    h.lp.start([{ x: 10, y: 10 }]);
    h.lp.move([{ x: 13, y: 12 }]);
    h.fire();
    expect(h.pressed).toEqual([{ x: 10, y: 10 }]);
  });

  test("a pan, a pinch or an early lift is not a press", () => {
    const h = harness();
    h.lp.start([{ x: 10, y: 10 }]);
    h.lp.move([{ x: 30, y: 10 }]);
    h.fire();
    h.lp.start([{ x: 0, y: 0 }, { x: 50, y: 50 }]);
    h.fire();
    h.lp.start([{ x: 0, y: 0 }]);
    h.lp.end();
    h.fire();
    expect(h.pressed).toEqual([]);
  });
});

describe("provider", () => {
  test("a tap near a mark answers it, placed, so the panel offers Go here", () => {
    const m = mark("a", { name: "Rock" });
    const p = createMarkProvider({
      marks: () => [m],
      own: () => undefined,
      project: (pt) => ({ x: (pt.lng - 10) * 1000, y: (pt.lat - 56) * 1000 }),
    });
    const hits = p.queryAt({ point: { x: 5, y: 5 }, lngLat: { lng: 10, lat: 56 }, radius: 8 });
    expect(hits.map((h) => [h.providerId, h.id, h.title])).toEqual([[MARK_PROVIDER_ID, "a", "Rock"]]);
    expect(hits[0].lngLat).toEqual({ lng: 10, lat: 56 });
    expect(p.queryAt({ point: { x: 100, y: 100 }, lngLat: { lng: 0, lat: 0 }, radius: 8 })).toEqual([]);
  });
});

function fakeApi(initial: Mark[] = []) {
  const store = new Map(initial.map((m) => [m.id, m]));
  const saves: [string, MarkBody][] = [];
  const api: MarksApi = {
    list: async () => ({ marks: [...store.values()], icons: [], stale: false }),
    save: async (id, body, existing) => {
      if (existing && !store.has(id)) throw new Error(`mark '${id}' was deleted`);
      saves.push([id, body]);
      const m = { ...body, id, updated: 1 };
      store.set(id, m);
      return m;
    },
    remove: async (id) => {
      store.delete(id);
    },
  };
  return { api, store, saves };
}

function build(init: Mark[] = [], self: { lng: number; lat: number } | null = { lng: 11, lat: 55 }) {
  const fake = fakeApi(init);
  const shown: InfoHit[][] = [];
  const [mode, setMode] = createSignal<string | null>(null);
  let n = 0;
  const marks = createRoot(() =>
    createMarks({
      signalk: { self: () => self } as unknown as SignalKState,
      settings: () => DEFAULT_SETTINGS,
      api: fake.api,
      mintId: () => `id${++n}`,
      showHits: (hits) => shown.push(hits),
      setInterval: () => 0,
      clearInterval: () => {},
    }),
  );
  marks.bindMode({ enter: setMode, leave: () => setMode(null), active: mode });
  return { ...fake, marks, shown, mode };
}

describe("createMarks", () => {
  test("drop at the boat stores a named pin on the server and opens it", async () => {
    const t = build([mark("x", { name: "Mark 1" })]);
    await t.marks.reload();
    const m = await t.marks.dropAtBoat();
    expect(m?.name).toBe("Mark 2");
    expect(t.saves).toEqual([["id1", { name: "Mark 2", note: "", icon: "pin", lat: 55, lon: 11 }]]);
    expect(t.shown.at(-1)?.[0]).toMatchObject({ providerId: MARK_PROVIDER_ID, id: "id1" });
    expect(t.marks.marks().map((x) => x.id).sort()).toEqual(["id1", "x"]);
  });

  test("a dropped mark's panel opens on Edit, once; Edit sits above the record", async () => {
    const t = build([mark("x")]);
    await t.marks.reload();
    const m = await t.marks.dropAtBoat();
    const detail = await t.marks.feature.provider!.detail(t.shown.at(-1)![0]);
    const edit = detail.actions?.find((a) => a.label === "Edit");
    expect(edit?.form?.autoOpen?.()).toBe(true);
    expect(edit?.form?.autoOpen?.()).toBe(false);
    expect(detail.footerActions?.some((a) => a.label === "Edit")).toBe(false);
    // An existing mark's panel shows Edit too, but closed.
    const other = await t.marks.feature.provider!.detail({ ...t.shown.at(-1)![0], id: "x" });
    expect(other.actions?.[0].form?.autoOpen?.()).toBe(false);
    expect(m?.id).toBe("id1");
  });

  test("no fix, no mark", async () => {
    const t = build([], null);
    expect(await t.marks.dropAtBoat()).toBeUndefined();
    expect(t.saves).toEqual([]);
  });

  test("edit, then delete", async () => {
    const t = build([mark("a")]);
    await t.marks.reload();
    await t.marks.update(t.marks.marks()[0], { name: "Rock", icon: "danger", note: "dries" });
    expect(t.store.get("a")).toMatchObject({ name: "Rock", icon: "danger", note: "dries" });
    await t.marks.remove(t.marks.marks()[0]);
    expect(t.store.size).toBe(0);
    expect(t.marks.marks()).toEqual([]);
  });

  test("move: the mode's next chart tap is the new position", async () => {
    const t = build([mark("a")]);
    await t.marks.reload();
    const provider = t.marks.feature.provider!;
    const detail = await provider.detail({
      providerId: MARK_PROVIDER_ID,
      id: "a",
      priority: "traffic",
      precision: "point",
      title: "a",
    });
    detail.footerActions?.find((a) => a.label === "Move")!.run();
    expect(t.mode()).toBe(MARK_MOVE_MODE_ID);
    const mode = t.marks.feature.core.modes.find((m) => m.id === MARK_MOVE_MODE_ID)!;
    expect(
      mode.onClick?.({ point: { x: 0, y: 0 }, lngLat: { lng: 12, lat: 57 }, radius: 8 }),
    ).toBe(true);
    expect(t.mode()).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(t.store.get("a")).toMatchObject({ lat: 57, lon: 12 });
  });

  test("editing a mark another screen deleted does not bring it back", async () => {
    const notes: string[] = [];
    const fake = fakeApi([mark("a")]);
    const marks = createRoot(() =>
      createMarks({
        signalk: { self: () => null } as unknown as SignalKState,
        settings: () => DEFAULT_SETTINGS,
        api: fake.api,
        notify: (s) => notes.push(s),
        setInterval: () => 0,
        clearInterval: () => {},
      }),
    );
    await marks.reload();
    const stale = marks.marks()[0];
    fake.store.delete("a"); // deleted on another screen; this one hasn't polled yet
    await marks.update(stale, { name: "Moved" });
    expect(fake.store.has("a")).toBe(false);
    expect(marks.marks()).toEqual([]);
    expect(notes).toEqual(["mark 'a' was deleted"]);
  });

  test("a refused save says why and puts the server's copy back", async () => {
    const t = build([mark("a")]);
    const notes: string[] = [];
    const marks = createRoot(() =>
      createMarks({
        signalk: { self: () => null } as unknown as SignalKState,
        settings: () => DEFAULT_SETTINGS,
        api: { ...t.api, save: async () => Promise.reject(new Error("SignalK down")) },
        notify: (s) => notes.push(s),
        setInterval: () => 0,
        clearInterval: () => {},
      }),
    );
    await marks.reload();
    await marks.update(marks.marks()[0], { name: "Nope" });
    expect(notes).toEqual(["SignalK down"]);
    expect(marks.marks()[0].name).toBe("a");
  });
});
