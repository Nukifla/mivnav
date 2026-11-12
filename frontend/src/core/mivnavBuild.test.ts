/**
 * `mivnavBuild.ts` — the pure status helpers, and the build controller's
 * poll loop.
 *
 * The controller is driven directly (no DOM) with injected seams so the
 * poll loop is deterministic and instant, the same way `signalkAccess` /
 * `serverConfig` are tested. The build panel component itself
 * (`routing.tsx`'s `MivnavBuild`) is a thin fetch-driven renderer,
 * exercised through the app like its `DatasetList` / `PoiData` siblings.
 *
 * NB: needs `--conditions=browser` (the `test` script passes it) so
 * solid-js's reactive build runs — a bare `bun test` would resolve the
 * SSR build and pass vacuously.
 */

import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import {
  artifactStatusLabel,
  createMivnavBuild,
  jobIsRunning,
  type MivnavArtifactEntry,
  type MivnavJobStatus,
} from "./mivnavBuild";

function entry(over: Partial<MivnavArtifactEntry> = {}): MivnavArtifactEntry {
  return {
    chart_set_id: "de6ostim",
    catzoc_allowance_mode: "full",
    present: false,
    usable: false,
    kind: "missing",
    reason: null,
    ...over,
  };
}

function job(over: Partial<MivnavJobStatus> = {}): MivnavJobStatus {
  return {
    state: "idle",
    detail: "",
    error: "",
    task: "",
    current: 0,
    total: 0,
    log: [],
    chart_set_id: "",
    bytes: 0,
    tile_count: 0,
    vector_required_tiles: 0,
    total_cells: 0,
    bands: 0,
    portals: 0,
    tiles_per_rung: [],
    ...over,
  };
}

describe("artifactStatusLabel", () => {
  test("a usable artifact is 'current'/ok", () => {
    expect(artifactStatusLabel(entry({ present: true, usable: true, kind: null }))).toEqual({
      text: "current",
      tone: "ok",
    });
  });

  test("missing / absent reads as 'not built', muted — no alarm", () => {
    expect(artifactStatusLabel(entry({ kind: "missing" })).text).toBe("not built");
    expect(artifactStatusLabel(entry({ kind: "missing" })).tone).toBe("muted");
    expect(artifactStatusLabel(entry({ present: false, kind: null })).text).toBe("not built");
  });

  test("a charts-moved staleness is a notice, worded as such", () => {
    expect(artifactStatusLabel(entry({ present: true, kind: "sequence" }))).toEqual({
      text: "stale — charts changed since it was built",
      tone: "notice",
    });
    expect(artifactStatusLabel(entry({ present: true, kind: "chart_set" })).tone).toBe("notice");
  });

  test("an older-mivnav staleness names the version, not the charts", () => {
    expect(artifactStatusLabel(entry({ present: true, kind: "versions" })).text).toBe(
      "stale — built by an older mivnav",
    );
  });

  test("an unknown kind falls back to the backend's own reason text", () => {
    const e = entry({ present: true, kind: null, usable: false, reason: "something odd" });
    expect(artifactStatusLabel(e)).toEqual({ text: "something odd", tone: "notice" });
  });
});

describe("jobIsRunning", () => {
  test("fetch and bake are running; idle/done/error/null are not", () => {
    expect(jobIsRunning(job({ state: "fetch" }))).toBe(true);
    expect(jobIsRunning(job({ state: "bake" }))).toBe(true);
    expect(jobIsRunning(job({ state: "idle" }))).toBe(false);
    expect(jobIsRunning(job({ state: "done" }))).toBe(false);
    expect(jobIsRunning(job({ state: "error" }))).toBe(false);
    expect(jobIsRunning(null)).toBe(false);
  });
});

describe("createMivnavBuild", () => {
  test("loads the artifact listing and the current job on mount", async () => {
    await createRoot(async (dispose) => {
      const ctl = createMivnavBuild({
        getArtifacts: async () => [entry({ present: true, usable: true, kind: null })],
        getJob: async () => job({ state: "done", tile_count: 52, bands: 10 }),
        startBuild: async () => job(),
        cancelBuild: async () => job(),
        wait: async () => {},
      });
      // let the mount refresh() settle
      await Promise.resolve();
      await Promise.resolve();
      expect(ctl.loaded()).toBe(true);
      expect(ctl.artifacts()).toHaveLength(1);
      expect(ctl.job()?.state).toBe("done");
      expect(ctl.running()).toBe(false);
      dispose();
    });
  });

  test("build() starts a job, then polls until it settles", async () => {
    await createRoot(async (dispose) => {
      // job goes fetch -> bake -> done over successive polls
      const states: MivnavJobStatus["state"][] = ["bake", "bake", "done"];
      let polls = 0;
      let artifactCalls = 0;
      const ctl = createMivnavBuild({
        getArtifacts: async () => {
          artifactCalls++;
          return [entry()];
        },
        getJob: async () => job({ state: states[Math.min(polls++, states.length - 1)] }),
        startBuild: async () => job({ state: "fetch", task: "decoding cells" }),
        cancelBuild: async () => job({ state: "error", error: "cancelled" }),
        wait: async () => {},
      });
      await Promise.resolve();

      await ctl.build();
      expect(ctl.job()?.state).toBe("fetch");

      // the poll loop is async; give it micro-turns to run to completion
      for (let i = 0; i < 20 && ctl.running(); i++) await Promise.resolve();

      expect(ctl.job()?.state).toBe("done");
      expect(ctl.running()).toBe(false);
      expect(polls).toBeGreaterThan(1);
      expect(artifactCalls).toBeGreaterThan(1); // refreshed alongside the job
      dispose();
    });
  });

  test("a failed build surfaces the backend's message and stops polling", async () => {
    await createRoot(async (dispose) => {
      const ctl = createMivnavBuild({
        getArtifacts: async () => [entry()],
        getJob: async () => job(),
        startBuild: async () => {
          throw new Error("no installed chart set 'nope'");
        },
        cancelBuild: async () => job(),
        wait: async () => {},
      });
      await Promise.resolve();
      await ctl.build("nope");
      expect(ctl.error()).toBe("no installed chart set 'nope'");
      expect(ctl.running()).toBe(false);
      dispose();
    });
  });

  test("cancel() reflects the cancelled job", async () => {
    await createRoot(async (dispose) => {
      const ctl = createMivnavBuild({
        getArtifacts: async () => [entry()],
        getJob: async () => job({ state: "bake" }),
        startBuild: async () => job({ state: "bake" }),
        cancelBuild: async () => job({ state: "error", error: "cancelled" }),
        wait: async () => {},
      });
      await Promise.resolve();
      await ctl.cancel();
      expect(ctl.job()?.error).toBe("cancelled");
      dispose();
    });
  });
});
