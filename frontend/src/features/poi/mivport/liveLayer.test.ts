// The mivport live layer: inert unless POIs are on AND the boat-wide switch
// (Config.mivport.live, read through the status route) is on; built from the
// baked marker spec; re-requests its tiles when mivport comes back online;
// its tiles bypass the Service Worker cache.

import { describe, expect, test } from "bun:test";
import type { Map as MLMap } from "maplibre-gl";
import type { OverlayCtx } from "../../../core/layers/overlay";
import { Z } from "../../../core/layers/overlay";
import { DEFAULT_SETTINGS, type ChartSettings } from "../../../core/style/settings";
import { isTileRequest } from "../../../core/tileCache";
import {
  createMivportLiveOverlay,
  MIVPORT_LIVE_LAYER_ID,
  MIVPORT_LIVE_SOURCE_ID,
  nextPollMs,
  type MivportLiveStatus,
} from "./liveLayer";

function fakeMap() {
  const sources = new Map<string, Record<string, unknown>>();
  const layers = new Map<string, Record<string, unknown>>();
  const map = {
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, s: Record<string, unknown>) => sources.set(id, s),
    removeSource: (id: string) => sources.delete(id),
    getLayer: (id: string) => layers.get(id),
    addLayer: (spec: Record<string, unknown>) => layers.set(spec.id as string, spec),
    removeLayer: (id: string) => layers.delete(id),
    setLayoutProperty: () => {},
    setFilter: () => {},
    hasImage: () => true,
    addImage: () => {},
  };
  return { map: map as unknown as MLMap, sources, layers };
}

const ctxWith = (patch: Partial<ChartSettings>): OverlayCtx =>
  ({ settings: () => ({ ...DEFAULT_SETTINGS, ...patch }) }) as unknown as OverlayCtx;

const status = (patch: Partial<MivportLiveStatus> = {}): MivportLiveStatus => ({
  enabled: true,
  state: "ready",
  min_zoom: 7,
  max_zoom: 14,
  tiles: "/poi/live/mivport/tiles/{z}/{x}/{y}",
  ...patch,
});

const flush = () => new Promise((r) => setTimeout(r, 0));

function rig(answers: (MivportLiveStatus | undefined)[]) {
  let calls = 0;
  const timers: (() => void)[] = [];
  const overlay = createMivportLiveOverlay({
    fetchStatus: async () => {
      calls++;
      return answers[Math.min(calls - 1, answers.length - 1)];
    },
    schedule: (fn) => {
      timers.push(fn);
      return () => {
        const i = timers.indexOf(fn);
        if (i >= 0) timers.splice(i, 1);
      };
    },
  });
  return { overlay, calls: () => calls, timers };
}

describe("mivport live layer", () => {
  test("POIs off: no poll, no source", async () => {
    const { overlay, calls } = rig([status()]);
    const { map, sources } = fakeMap();
    overlay.ensure(map, ctxWith({ showPois: false }));
    await flush();
    expect(calls()).toBe(0);
    expect(sources.size).toBe(0);
  });

  test("switch off: polled, but nothing drawn", async () => {
    const { overlay } = rig([status({ enabled: false, state: "off" })]);
    const { map, sources } = fakeMap();
    const ctx = ctxWith({ showPois: true });
    overlay.ensure(map, ctx);
    await flush();
    overlay.update(map, ctx);
    expect(sources.size).toBe(0);
  });

  test("on: a vector source + the POI marker layer, below the baked POIs", async () => {
    const { overlay } = rig([status()]);
    const { map, sources, layers } = fakeMap();
    const ctx = ctxWith({ showPois: true });
    overlay.ensure(map, ctx);
    await flush();
    overlay.update(map, ctx);
    const src = sources.get(MIVPORT_LIVE_SOURCE_ID)!;
    expect(src.type).toBe("vector");
    expect(src.minzoom).toBe(7);
    expect((src.tiles as string[])[0]).toContain("/api/poi/live/mivport/tiles/{z}/{x}/{y}?e=0");
    expect(layers.get(MIVPORT_LIVE_LAYER_ID)?.source).toBe(MIVPORT_LIVE_SOURCE_ID);
    expect(overlay.z).toBeLessThan(Z.poi);
  });

  test("back online: the tile URL changes so empty tiles are asked again", async () => {
    const { overlay, timers } = rig([status({ state: "offline" }), status()]);
    const { map, sources } = fakeMap();
    const ctx = ctxWith({ showPois: true });
    overlay.ensure(map, ctx);
    await flush();
    overlay.update(map, ctx);
    const before = (sources.get(MIVPORT_LIVE_SOURCE_ID)!.tiles as string[])[0];
    timers.shift()!();
    await flush();
    overlay.update(map, ctx);
    const after = (sources.get(MIVPORT_LIVE_SOURCE_ID)!.tiles as string[])[0];
    expect(after).not.toBe(before);
    expect(after).toContain("?e=1");
  });

  test("refresh asks at once and leaves one timer", async () => {
    const { overlay, calls, timers } = rig([status()]);
    const { map } = fakeMap();
    overlay.ensure(map, ctxWith({ showPois: true }));
    await flush();
    overlay.refresh();
    await flush();
    expect(calls()).toBe(2);
    expect(timers.length).toBe(1);
  });

  test("polls sooner while offline", () => {
    expect(nextPollMs(status({ state: "offline" }))).toBeLessThan(nextPollMs(status()));
  });

  test("live tiles are never cached by the Service Worker", () => {
    expect(isTileRequest(new URL("http://boat/api/poi/live/mivport/tiles/8/1/2?e=0"))).toBe(false);
  });
});
