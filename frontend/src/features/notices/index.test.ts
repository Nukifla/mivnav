// The feature's own surfaces beyond the overlay: the info provider is
// contributed, the palette command opens the list (closing the other
// left-docked panels first), and `openNotice` resolves the record before
// handing the info panel ONE hit placed at the notice.

import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import type { InfoHit } from "../../core/info/types";
import { DEFAULT_SETTINGS } from "../../core/style/settings";
import { createFollowMoveGate } from "../../core/followGate";
import { createNoticesToMariners } from "./index";
import { NOTICES_PROVIDER_ID } from "./provider";
import type { FeatureCollection } from "geojson";
import type { Map as MLMap } from "maplibre-gl";
import { NOTICES_HIGHLIGHT_LAYER_IDS, NOTICES_HIGHLIGHT_SOURCE_ID, NOTICES_SOURCE_ID } from "./overlay";
import type { NoticeDetail, NoticesList, NoticesMap } from "./types";
import MAP_JSON from "./fixtures/map.json";
import DETAIL_JSON from "./fixtures/detail.json";
import LIST_JSON from "./fixtures/list.json";

const DETAIL = DETAIL_JSON as unknown as NoticeDetail;
const LIST = LIST_JSON as unknown as NoticesList;

function setup(loadDetail: (id: string) => Promise<NoticeDetail | undefined> = async () => DETAIL) {
  const shown: InfoHit[][] = [];
  let closedOthers = 0;
  const { n, dispose } = createRoot((d) => {
    const [settings] = createSignal({ ...DEFAULT_SETTINGS, showNotices: false });
    return {
      dispose: d,
      n: createNoticesToMariners({
        settings,
        showHits: (h) => shown.push(h),
        beforeOpenList: () => closedOthers++,
        loadDetail,
      }),
    };
  });
  return { n, dispose, shown, closedOthers: () => closedOthers };
}

describe("notices feature", () => {
  test("contributes the info provider and an 'open list' command", () => {
    const { n, dispose, closedOthers } = setup();
    expect(n.feature.provider?.id).toBe(NOTICES_PROVIDER_ID);
    const cmds = n.feature.commands?.({} as never) ?? [];
    const open = cmds.find((c) => c.id === "open-notices")!;
    expect(open.label).toBe("Notices to Mariners");
    let closed = false;
    void open.run({ close: () => (closed = true), prompt: () => {} });
    expect(n.list.open()).toBe(true);
    expect(closed).toBe(true);
    expect(closedOthers()).toBe(1);
    dispose();
  });

  test("openNotice: fetches the record, then shows ONE hit at the notice (no map: no fit)", async () => {
    const { n, dispose, shown } = setup();
    await n.openNotice(DETAIL.id);
    expect(shown).toHaveLength(1);
    const [hit] = shown[0];
    expect(hit).toMatchObject({ providerId: NOTICES_PROVIDER_ID, id: DETAIL.id, title: "NM-053" });
    // bbox centre
    expect(hit.lngLat!.lng).toBeCloseTo((11.233883 + 11.369717) / 2, 5);
    dispose();
  });

  test("openNotice from a list row uses the row's position; a no-geometry row has none", async () => {
    const { n, dispose, shown } = setup(async () => undefined);
    const row = LIST.items.find((i) => i.sid === "NW-375-26")!;
    await n.openNotice(row.id, row);
    expect(shown[0][0].lngLat).toEqual({ lng: row.lon!, lat: row.lat! });
    expect(shown[0][0].priority).toBe("hazard");
    const efs = LIST.items.find((i) => i.fam === "efs-a")!;
    await n.openNotice(efs.id, efs);
    expect(shown[1][0].lngLat).toBeUndefined();
    expect(shown[1][0].title).toBe(efs.sid ? efs.sid.replace(/-\d{2}$/, "") : "EfS A");
    dispose();
  });

  test("openNotice's fit is a crew move to follow-boat, so following the boat can't undo it", async () => {
    const { n, dispose, shown } = createRoot((d) => {
      const shown: InfoHit[][] = [];
      const [settings] = createSignal({ ...DEFAULT_SETTINGS, showNotices: false });
      return {
        dispose: d,
        shown,
        n: createNoticesToMariners({ settings, showHits: (h) => shown.push(h), loadDetail: async () => DETAIL }),
      };
    });
    // The real MapView gate, listening to the camera events the fit fires.
    let reanchored = 0;
    const follow = createFollowMoveGate(() => reanchored++);
    const listeners: Array<(e?: unknown) => void> = [];
    const container = { clientWidth: 800, clientHeight: 600, getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }) };
    const map = {
      getSource: () => undefined,
      addSource: () => {},
      getLayer: () => undefined,
      addLayer: () => {},
      getStyle: () => ({ layers: [] }),
      setPaintProperty: () => {},
      setLayoutProperty: () => {},
      getContainer: () => container,
      getZoom: () => 10,
      on: (_t: string, f: (e?: unknown) => void) => listeners.push(f),
      off: (_t: string, f: (e?: unknown) => void) => listeners.splice(listeners.indexOf(f), 1),
      fitBounds: (_b: unknown, _o: unknown, eventData?: { mivnavAuto?: boolean }) => {
        follow.movestart(eventData);
        expect(follow.moving()).toBe(true); // the recentre stands down mid-fit
        follow.moveend(eventData);
        for (const f of [...listeners]) f(eventData);
      },
    } as unknown as MLMap;
    const ctx = { settings: () => DEFAULT_SETTINGS } as never;
    n.feature.overlay!.ensure(map, ctx);
    await n.openNotice(DETAIL.id);
    expect(reanchored).toBe(1); // and re-anchors (or pauses) where the fit landed
    expect(shown).toHaveLength(1);
    dispose();
  });

  test("a reference id that can't be resolved still opens (the panel says it couldn't load)", async () => {
    const { n, dispose, shown } = setup(async () => undefined);
    await n.openNotice("NM-270-22");
    expect(shown[0][0]).toMatchObject({ id: "NM-270-22", title: "NM-270" });
    dispose();
  });
});

describe("selected-notice highlight", () => {
  test("with the overlay OFF, selecting a notice fetches the snapshot once and highlights only it", async () => {
    let statusCalls = 0;
    const { n, dispose } = createRoot((d) => {
      const [settings] = createSignal({ ...DEFAULT_SETTINGS, showNotices: false });
      return {
        dispose: d,
        n: createNoticesToMariners({
          settings,
          fetchStatus: async () => {
            statusCalls++;
            return { state: "ready", version: "v1" } as never;
          },
          fetchMap: async () => MAP_JSON as unknown as NoticesMap,
          schedule: () => () => {},
        }),
      };
    });
    const sources = new Map<string, { data: unknown; setData: (d: unknown) => void }>();
    const layers: string[] = [];
    const map = {
      getSource: (id: string) => sources.get(id),
      addSource: (id: string, s: { data: unknown }) => {
        const src = { data: s.data, setData: (x: unknown) => (src.data = x) };
        sources.set(id, src);
      },
      removeSource: (id: string) => sources.delete(id),
      getLayer: (id: string) => (layers.includes(id) ? { id } : undefined),
      addLayer: (spec: { id: string }) => layers.push(spec.id),
      removeLayer: (id: string) => layers.splice(layers.indexOf(id), 1),
      getStyle: () => ({ layers: layers.map((id) => ({ id, type: "line" })) }),
      setPaintProperty: () => {},
      setLayoutProperty: () => {},
    } as unknown as MLMap;
    const ctx = { settings: () => DEFAULT_SETTINGS } as never;
    const ov = n.feature.overlay!;
    ov.ensure(map, ctx);
    ov.update(map, ctx);
    expect(layers).toEqual([]);

    n.provider.selected!({ providerId: NOTICES_PROVIDER_ID, id: "2d3e-nm-842" } as InfoHit);
    await new Promise((r) => setTimeout(r, 0));
    ov.update(map, ctx);
    expect(statusCalls).toBe(1);
    expect(layers).toEqual([...NOTICES_HIGHLIGHT_LAYER_IDS]);
    const fc = sources.get(NOTICES_HIGHLIGHT_SOURCE_ID)!.data as FeatureCollection;
    expect(fc.features.length).toBeGreaterThan(0);
    expect(fc.features.every((f) => f.properties!.msg === "2d3e-nm-842" && f.properties!.role !== "vertex")).toBe(true);
    // The overlay itself stays off.
    expect(sources.has(NOTICES_SOURCE_ID)).toBe(false);

    // Panel closed → highlight gone.
    n.provider.selected!(undefined);
    ov.update(map, ctx);
    expect(layers).toEqual([]);
    dispose();
  });

  test("with the overlay OFF, a notice newer than the snapshot held refetches it (once per selection)", async () => {
    // The on-demand snapshot used to be fetched once per page load, so a
    // notice published after it (opened from the list or search, which read
    // the live backend) was never highlighted.
    const full = MAP_JSON as unknown as NoticesMap;
    const old = { ...full, features: full.features.filter((f) => f.properties!.msg !== "2d3e-nm-842") } as NoticesMap;
    let version = "v1";
    const mapCalls: string[] = [];
    let statusCalls = 0;
    const { n, dispose } = createRoot((d) => {
      const [settings] = createSignal({ ...DEFAULT_SETTINGS, showNotices: false });
      return {
        dispose: d,
        n: createNoticesToMariners({
          settings,
          fetchStatus: async () => {
            statusCalls++;
            return { state: "ready", version } as never;
          },
          fetchMap: async (v) => {
            mapCalls.push(v);
            return v === "v1" ? old : full;
          },
          schedule: () => () => {},
        }),
      };
    });
    const sources = new Map<string, { data: unknown; setData: (d: unknown) => void }>();
    const layers: string[] = [];
    const map = {
      getSource: (id: string) => sources.get(id),
      addSource: (id: string, s: { data: unknown }) => {
        const src = { data: s.data, setData: (x: unknown) => (src.data = x) };
        sources.set(id, src);
      },
      removeSource: (id: string) => sources.delete(id),
      getLayer: (id: string) => (layers.includes(id) ? { id } : undefined),
      addLayer: (spec: { id: string }) => layers.push(spec.id),
      removeLayer: (id: string) => layers.splice(layers.indexOf(id), 1),
      getStyle: () => ({ layers: layers.map((id) => ({ id, type: "line" })) }),
      setPaintProperty: () => {},
      setLayoutProperty: () => {},
    } as unknown as MLMap;
    const ctx = { settings: () => DEFAULT_SETTINGS } as never;
    const ov = n.feature.overlay!;
    ov.ensure(map, ctx);
    const select = async (id: string | undefined) => {
      n.provider.selected!(id ? ({ providerId: NOTICES_PROVIDER_ID, id } as InfoHit) : undefined);
      await new Promise((r) => setTimeout(r, 0));
      ov.update(map, ctx);
    };

    await select("a5b6-fe-1");
    expect(mapCalls).toEqual(["v1"]);
    expect(layers).toEqual([...NOTICES_HIGHLIGHT_LAYER_IDS]);

    // A notice the held snapshot has: no request at all.
    await select("4f50-nm-900");
    expect(statusCalls).toBe(1);

    // Published since: the snapshot moved to v2 and has it.
    version = "v2";
    await select("2d3e-nm-842");
    expect(mapCalls).toEqual(["v1", "v2"]);
    const fc = sources.get(NOTICES_HIGHLIGHT_SOURCE_ID)!.data as FeatureCollection;
    expect(fc.features.length).toBeGreaterThan(0);
    expect(fc.features.every((f) => f.properties!.msg === "2d3e-nm-842")).toBe(true);

    // A notice with no geometry is in no snapshot: one status look, and the
    // unchanged version is not downloaded again.
    const before = statusCalls;
    await select("no-geometry");
    expect(statusCalls).toBe(before + 1);
    expect(mapCalls).toEqual(["v1", "v2"]);
    expect(layers).toEqual([]);
    dispose();
  });
});
