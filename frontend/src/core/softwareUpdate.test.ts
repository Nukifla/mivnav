/**
 * `softwareUpdate.ts` — the pure decisions (`isNewRun`, `watchStep`) and the
 * controller's watch loop across a server restart.
 *
 * Driven with injected seams (no DOM, no network, no real time), the same way
 * `mivnavBuild.test.ts` drives its build loop. The Software section itself
 * (`settings/Software.tsx`) is a thin renderer over this controller.
 *
 * NB: needs `--conditions=browser` (the `test` script passes it).
 */

import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import {
  createSoftwareUpdate,
  displayVersion,
  isNewRun,
  START_TIMEOUT_MS,
  UNREACHABLE_TIMEOUT_MS,
  updateTarget,
  watchStep,
  type Phase,
  type SoftwareUpdateSeams,
  type SystemVersion,
  type UpdateInfo,
  type UpdateStatus,
  type WatchCtx,
} from "./softwareUpdate";

function status(over: Partial<UpdateStatus> = {}): UpdateStatus {
  return { state: "idle", ...over };
}

function info(current: string, st: UpdateStatus = status(), over: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    current,
    latest: {
      version: "0.3.0",
      published_at: "2026-11-02T10:00:00Z",
      notes_url: "https://github.com/nukifla/mivnav/releases/tag/v0.3.0",
      notes: "fixes",
    },
    available: current !== "0.3.0",
    status: st,
    checked_at: "2026-11-05T09:00:00+00:00",
    error: null,
    ...over,
  };
}

function version(v: string, over: Partial<SystemVersion> = {}): SystemVersion {
  return { version: v, install: "release", can_update: true, commit: null, ...over };
}

function ctx(over: Partial<WatchCtx> = {}): WatchCtx {
  return {
    fromVersion: "0.2.0",
    baselineStartedAt: "2026-11-01T00:00:00+00:00",
    startedAt: 0,
    unreachableSince: null,
    begun: false,
    ...over,
  };
}

/** Let every queued promise chain (and the loop's next turn) run. */
async function settle(turns = 20): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("version formatting", () => {
  test("release versions get their v, dev does not", () => {
    expect(displayVersion("0.2.0")).toBe("v0.2.0");
    expect(displayVersion("0.3.0-rc.1")).toBe("v0.3.0-rc.1");
    expect(displayVersion("dev")).toBe("dev");
  });

  test("the update target is the tag", () => {
    expect(updateTarget("0.3.0")).toBe("v0.3.0");
    expect(updateTarget("v0.3.0")).toBe("v0.3.0");
  });
});

describe("isNewRun", () => {
  const base = "2026-11-01T00:00:00+00:00";
  test("idle never counts — the updater has not written yet", () => {
    expect(isNewRun(status(), base)).toBe(false);
    expect(isNewRun(status(), null)).toBe(false);
  });
  test("an in-progress state counts", () => {
    expect(isNewRun(status({ state: "downloading", started_at: base }), base)).toBe(true);
  });
  test("the previous run's settled outcome does not count", () => {
    expect(isNewRun(status({ state: "done", started_at: base }), base)).toBe(false);
  });
  test("a settled outcome of a NEW run counts (a fast failure)", () => {
    expect(isNewRun(status({ state: "failed", started_at: "2026-11-05T10:00:00Z" }), base)).toBe(
      true,
    );
    expect(isNewRun(status({ state: "failed", started_at: "2026-11-05T10:00:00Z" }), null)).toBe(
      true,
    );
  });
});

describe("watchStep", () => {
  test("no answer is 'restarting', not an error, until the timeout", () => {
    const c = ctx({ begun: true });
    expect(watchStep(c, null, 1000)).toEqual({ kind: "continue", phase: "restarting" });
    expect(c.unreachableSince).toBe(1000);
    expect(watchStep(c, null, 1000 + UNREACHABLE_TIMEOUT_MS - 1).kind).toBe("continue");
    expect(watchStep(c, null, 1000 + UNREACHABLE_TIMEOUT_MS + 1).kind).toBe("gave-up");
  });

  test("an answer clears the unreachable clock", () => {
    const c = ctx({ begun: true, unreachableSince: 5 });
    watchStep(c, { info: info("0.2.0", status({ state: "installing" })) }, 10);
    expect(c.unreachableSince).toBeNull();
  });

  test("a different version answering means reload", () => {
    const c = ctx({ begun: true });
    expect(watchStep(c, { info: info("0.3.0", status({ state: "restarting" })) }, 10)).toEqual({
      kind: "reload",
      version: "0.3.0",
    });
  });

  test("the old outcome still in the file is 'starting', until the start timeout", () => {
    const c = ctx();
    const old = { info: info("0.2.0", status({ state: "done", started_at: c.baselineStartedAt })) };
    expect(watchStep(c, old, 10)).toEqual({ kind: "continue", phase: "starting" });
    expect(c.begun).toBe(false);
    const verdict = watchStep(c, old, START_TIMEOUT_MS + 1);
    expect(verdict.kind).toBe("gave-up");
  });

  test("running, then settled on the same version", () => {
    const c = ctx();
    const run = status({ state: "downloading", started_at: "2026-11-05T10:00:00Z" });
    expect(watchStep(c, { info: info("0.2.0", run) }, 10)).toEqual({
      kind: "continue",
      phase: "running",
    });
    expect(c.begun).toBe(true);
    const failed = status({ state: "failed", started_at: "2026-11-05T10:00:00Z" });
    expect(watchStep(c, { info: info("0.2.0", failed) }, 20)).toEqual({ kind: "settled" });
  });
});

/** A scripted server: each poll takes the next answer (an `Error` = the
 * server did not answer); the last one repeats. */
function scripted(answers: (UpdateInfo | Error)[]) {
  let i = 0;
  return async (): Promise<UpdateInfo> => {
    const next = answers[Math.min(i++, answers.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  };
}

function harness(over: Partial<SoftwareUpdateSeams> & { initial: UpdateInfo; polls: (UpdateInfo | Error)[] }) {
  let t = 0;
  const phases: Phase[] = [];
  const started: string[] = [];
  let reloads = 0;
  let loads = 0;
  const poll = scripted(over.polls);
  let initialServed = false;
  const seams: Partial<SoftwareUpdateSeams> = {
    getVersion: async () => {
      loads++;
      return version(over.initial.current);
    },
    getUpdate: async (refresh) => {
      if (!initialServed || refresh) {
        initialServed = true;
        return over.initial;
      }
      return poll();
    },
    startUpdate: async (target) => {
      started.push(target);
      return { unit: `mivnav-update@${target}.service` };
    },
    startRollback: async () => {
      started.push("rollback");
      return { unit: "mivnav-update@rollback.service" };
    },
    wait: async () => {
      t += 2000;
    },
    now: () => t,
    reload: () => {
      reloads++;
    },
    ...over,
  };
  return {
    seams,
    phases,
    started,
    get reloads() {
      return reloads;
    },
    get loads() {
      return loads;
    },
  };
}

describe("createSoftwareUpdate", () => {
  test("loads the version and the release check on mount", async () => {
    await createRoot(async (dispose) => {
      const h = harness({ initial: info("0.2.0"), polls: [] });
      const ctl = createSoftwareUpdate(h.seams);
      await settle();
      expect(ctl.loaded()).toBe(true);
      expect(ctl.version()?.version).toBe("0.2.0");
      expect(ctl.info()?.available).toBe(true);
      expect(ctl.phase()).toBe("idle");
      expect(ctl.busy()).toBe(false);
      dispose();
    });
  });

  test("update: pinned target, watched through the restart, then reload", async () => {
    await createRoot(async (dispose) => {
      const before = status({ state: "done", started_at: "2026-11-01T00:00:00+00:00" });
      const run = { started_at: "2026-11-05T10:00:00Z", from: "0.2.0", to: "0.3.0" };
      const down = new Error("Failed to fetch");
      const phases: Phase[] = [];
      let ctlRef: ReturnType<typeof createSoftwareUpdate> | undefined;
      const h = harness({
        initial: info("0.2.0", before),
        polls: [
          info("0.2.0", before), // systemd has not started it yet
          info("0.2.0", status({ state: "downloading", ...run })),
          info("0.2.0", status({ state: "restarting", ...run })),
          down,
          down,
          info("0.3.0", status({ state: "restarting", ...run })),
        ],
        wait: async () => {
          if (ctlRef) phases.push(ctlRef.phase());
        },
      });
      const ctl = createSoftwareUpdate(h.seams);
      ctlRef = ctl;
      await settle();
      await ctl.update();
      await settle(40);
      expect(h.started).toEqual(["v0.3.0"]);
      expect(h.reloads).toBe(1);
      expect(ctl.phase()).toBe("reloading");
      // What the panel showed between polls, in order.
      expect(phases).toEqual(["starting", "starting", "running", "running", "restarting", "restarting"]);
      dispose();
    });
  });

  test("rollback that fails settles without a reload and re-reads the version", async () => {
    await createRoot(async (dispose) => {
      const run = { started_at: "2026-11-05T10:00:00Z" };
      const h = harness({
        initial: info("0.2.0"),
        polls: [
          info("0.2.0", status({ state: "installing", ...run })),
          info("0.2.0", status({ state: "failed", message: "no previous release", ...run })),
        ],
      });
      const ctl = createSoftwareUpdate(h.seams);
      await settle();
      const loadsBefore = h.loads;
      await ctl.rollback();
      await settle(40);
      expect(h.started).toEqual(["rollback"]);
      expect(h.reloads).toBe(0);
      expect(ctl.phase()).toBe("idle");
      expect(ctl.info()?.status.state).toBe("failed");
      expect(ctl.error()).toBe("");
      expect(h.loads).toBeGreaterThan(loadsBefore);
      dispose();
    });
  });

  test("a refused start (409) is an error and starts no watch", async () => {
    await createRoot(async (dispose) => {
      let polls = 0;
      const h = harness({
        initial: info("0.2.0"),
        polls: [],
        startUpdate: async () => {
          throw new Error("An update is already running (downloading).");
        },
      });
      const base = h.seams.getUpdate!;
      h.seams.getUpdate = async (refresh) => {
        polls++;
        return base(refresh);
      };
      const ctl = createSoftwareUpdate(h.seams);
      await settle();
      const after = polls;
      await ctl.update();
      await settle();
      expect(ctl.error()).toContain("already running");
      expect(ctl.phase()).toBe("idle");
      expect(polls).toBe(after);
      dispose();
    });
  });

  test("an updater that never writes a status gives up after the start timeout", async () => {
    await createRoot(async (dispose) => {
      let t = 0;
      const h = harness({
        initial: info("0.2.0"),
        polls: [info("0.2.0")],
        wait: async () => {
          t += 10_000;
        },
        now: () => t,
      });
      const ctl = createSoftwareUpdate(h.seams);
      await settle();
      await ctl.update();
      await settle(80);
      expect(ctl.phase()).toBe("idle");
      expect(ctl.error()).toContain("did not start");
      dispose();
    });
  });

  test("opening the panel mid-update resumes the watch", async () => {
    await createRoot(async (dispose) => {
      const run = { started_at: "2026-11-05T10:00:00Z", to: "0.3.0" };
      const h = harness({
        initial: info("0.2.0", status({ state: "installing", ...run })),
        polls: [new Error("down"), info("0.3.0", status({ state: "done", ...run }))],
      });
      const ctl = createSoftwareUpdate(h.seams);
      await settle(40);
      expect(h.started).toEqual([]);
      expect(h.reloads).toBe(1);
      dispose();
    });
  });

  test("Check now asks the server to refresh", async () => {
    await createRoot(async (dispose) => {
      const refreshes: boolean[] = [];
      const h = harness({ initial: info("0.2.0"), polls: [] });
      const base = h.seams.getUpdate!;
      h.seams.getUpdate = async (refresh) => {
        refreshes.push(refresh);
        return base(refresh);
      };
      const ctl = createSoftwareUpdate(h.seams);
      await settle();
      await ctl.checkNow();
      expect(refreshes).toEqual([false, true]);
      expect(ctl.checking()).toBe(false);
      dispose();
    });
  });
});
