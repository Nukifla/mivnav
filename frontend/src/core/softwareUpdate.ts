// The server's own software: its version, the newest release, and the
// one-button update — client side of `/api/system/*`
// (`backend/mivnav/api/system.py`).
//
// The update itself runs on the server as `mivnav-update@<arg>.service`
// (deploy/update.sh). It restarts the backend midway, so the watch loop here
// has to outlive the very server it is polling: a failed poll during an
// update is "restarting", not an error, and the page reloads once the server
// answers with a different version than the one the update started from.
//
// Shape mirrors `mivnavBuild.ts`: fetch functions, then an injectable-seam
// controller (`createSoftwareUpdate`) so the loop is deterministic in a test,
// with the decisions themselves in pure functions (`isNewRun`, `watchStep`).

import { createSignal, onCleanup } from "solid-js";
import type { components } from "../api.generated";
import { fetchJsonDefault, type FetchJson } from "./settings/apiFetch";

export type SystemVersion = components["schemas"]["SystemVersion"];
export type UpdateInfo = components["schemas"]["UpdateInfo"];
export type UpdateStatus = components["schemas"]["UpdateStatus"];
export type UpdateState = UpdateStatus["state"];
export type UpdateStarted = components["schemas"]["UpdateStarted"];

const VERSION_URL = "/api/system/version";
const UPDATE_URL = "/api/system/update";
const ROLLBACK_URL = "/api/system/update/rollback";

/** Poll period while an update runs (contract: every 2 s). */
export const POLL_MS = 2000;
/** How long after "Update" the updater may take to write its first status
 * before the panel says it never started. */
export const START_TIMEOUT_MS = 60_000;
/** How long the server may stay away (unpack + venv + restart + its own
 * 90 s health wait + a possible rollback restart) before the panel stops
 * saying "Restarting…" and says it lost the server instead. */
export const UNREACHABLE_TIMEOUT_MS = 10 * 60_000;

const IN_PROGRESS: ReadonlySet<UpdateState> = new Set([
  "checking",
  "downloading",
  "installing",
  "restarting",
]);

export function isInProgress(status: UpdateStatus | null | undefined): boolean {
  return status != null && IN_PROGRESS.has(status.state);
}

/** The words for an updater state, as the panel's progress line shows them. */
export const STATE_LABEL: Record<UpdateState, string> = {
  idle: "Idle",
  checking: "Checking…",
  downloading: "Downloading…",
  installing: "Installing…",
  restarting: "Restarting…",
  done: "Updated",
  failed: "Update failed",
  rolled_back: "Rolled back",
};

/** `"0.2.0"` → `"v0.2.0"`; `"dev"` stays `"dev"`. */
export function displayVersion(version: string): string {
  return /^\d/.test(version) ? `v${version}` : version;
}

/** `"0.2.0"` → the `POST /system/update` target `"v0.2.0"`. */
export function updateTarget(version: string): string {
  return `v${version.replace(/^v/, "")}`;
}

// --- the raw fetch functions -------------------------------------------

export function fetchVersion(getJson: FetchJson = fetchJsonDefault): Promise<SystemVersion> {
  return getJson<SystemVersion>(VERSION_URL);
}

export function fetchUpdate(
  refresh = false,
  getJson: FetchJson = fetchJsonDefault,
): Promise<UpdateInfo> {
  return getJson<UpdateInfo>(refresh ? `${UPDATE_URL}?refresh=1` : UPDATE_URL);
}

/** 400 = not a release install, 409 = already running, 503 = systemd said no. */
export function postUpdate(
  target: string,
  getJson: FetchJson = fetchJsonDefault,
): Promise<UpdateStarted> {
  return getJson<UpdateStarted>(UPDATE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: target }),
  });
}

export function postRollback(getJson: FetchJson = fetchJsonDefault): Promise<UpdateStarted> {
  return getJson<UpdateStarted>(ROLLBACK_URL, { method: "POST" });
}

// --- the decisions (pure) ----------------------------------------------------

/** Has the updater begun the run we asked for? The status file still holds
 * the PREVIOUS run's outcome right after the POST (systemd queues the unit
 * asynchronously), so a settled state only counts once its `started_at`
 * differs from the one seen before the POST. */
export function isNewRun(status: UpdateStatus, baselineStartedAt: string | null): boolean {
  if (isInProgress(status)) return true;
  if (status.state === "idle") return false;
  return (status.started_at ?? null) !== baselineStartedAt;
}

/** What the watch loop knows between polls. */
export interface WatchCtx {
  /** The version the server ran when the update was asked for. */
  fromVersion: string;
  /** `status.started_at` before the POST (`null` if none). */
  baselineStartedAt: string | null;
  /** When the watch began, and since when the server has been unreachable. */
  startedAt: number;
  unreachableSince: number | null;
  /** The updater was seen running this run. */
  begun: boolean;
}

/** One poll's outcome: the server's answer, or `null` if it did not answer. */
export type Poll = { info: UpdateInfo } | null;

export type WatchVerdict =
  | { kind: "continue"; phase: "starting" | "running" | "restarting" }
  | { kind: "reload"; version: string }
  | { kind: "settled" }
  | { kind: "gave-up"; message: string };

/**
 * The watch loop's one decision per poll — what to show and whether to go
 * on. Mutates `ctx` (`begun`, `unreachableSince`).
 *
 * - no answer → "Restarting…" (the updater restarts the server), until
 *   `UNREACHABLE_TIMEOUT_MS`;
 * - a different version answering → reload the page onto the new frontend;
 * - the run not yet begun → keep waiting up to `START_TIMEOUT_MS`;
 * - in progress → keep polling; settled → stop and show the outcome.
 */
export function watchStep(ctx: WatchCtx, poll: Poll, now: number): WatchVerdict {
  if (poll === null) {
    ctx.unreachableSince ??= now;
    if (now - ctx.unreachableSince > UNREACHABLE_TIMEOUT_MS) {
      return {
        kind: "gave-up",
        message:
          "The server has not come back. Check it on the boat's computer (journalctl -u mivnav).",
      };
    }
    return { kind: "continue", phase: "restarting" };
  }
  ctx.unreachableSince = null;
  const { info } = poll;
  if (info.current !== ctx.fromVersion) return { kind: "reload", version: info.current };
  if (!ctx.begun) ctx.begun = isNewRun(info.status, ctx.baselineStartedAt);
  if (!ctx.begun) {
    if (now - ctx.startedAt > START_TIMEOUT_MS) {
      return { kind: "gave-up", message: "The updater did not start. Is it installed?" };
    }
    return { kind: "continue", phase: "starting" };
  }
  if (isInProgress(info.status)) return { kind: "continue", phase: "running" };
  return { kind: "settled" };
}

// --- the controller -------------------------------------------------------

export interface SoftwareUpdateSeams {
  getVersion: () => Promise<SystemVersion>;
  getUpdate: (refresh: boolean) => Promise<UpdateInfo>;
  startUpdate: (target: string) => Promise<UpdateStarted>;
  startRollback: () => Promise<UpdateStarted>;
  /** Sleep between polls; defaults to `POLL_MS`. */
  wait: () => Promise<void>;
  now: () => number;
  /** Load the new frontend the updated server serves. */
  reload: () => void;
}

/** Ask the Service Worker to fetch the new build first, so the reload lands
 * on the new frontend rather than the precached old one. */
async function reloadOntoNewBuild(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    await registration?.update();
  } catch {
    // No SW (dev server, http on a LAN IP): a plain reload is all there is.
  }
  location.reload();
}

const defaultSeams: SoftwareUpdateSeams = {
  getVersion: () => fetchVersion(),
  getUpdate: (refresh) => fetchUpdate(refresh),
  startUpdate: (target) => postUpdate(target),
  startRollback: () => postRollback(),
  wait: () => new Promise<void>((r) => setTimeout(r, POLL_MS)),
  now: () => Date.now(),
  reload: () => void reloadOntoNewBuild(),
};

/** What the panel shows about the update flow, beyond the raw status. */
export type Phase = "idle" | "starting" | "running" | "restarting" | "reloading";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Settings → Software's state: the running version, the release check, and
 * the update/rollback actions with their live watch.
 *
 * Opening the panel while an update is already running (started from
 * another screen, or this page was reloaded mid-update) picks the watch up
 * from the running version.
 */
export function createSoftwareUpdate(seams: Partial<SoftwareUpdateSeams> = {}) {
  const s: SoftwareUpdateSeams = { ...defaultSeams, ...seams };

  const [version, setVersion] = createSignal<SystemVersion | null>(null);
  const [info, setInfo] = createSignal<UpdateInfo | null>(null);
  const [phase, setPhase] = createSignal<Phase>("idle");
  const [error, setError] = createSignal("");
  const [checking, setChecking] = createSignal(false);
  const [loaded, setLoaded] = createSignal(false);

  let alive = true;
  let watching = false;
  onCleanup(() => {
    alive = false;
  });

  /** Version + release check; `refresh` = "Check now" (asks GitHub). */
  const load = async (refresh = false) => {
    setError("");
    try {
      const [v, u] = await Promise.all([s.getVersion(), s.getUpdate(refresh)]);
      setVersion(v);
      setInfo(u);
    } catch (e) {
      setError(message(e));
    } finally {
      setLoaded(true);
    }
  };

  const checkNow = async () => {
    setChecking(true);
    try {
      await load(true);
    } finally {
      setChecking(false);
    }
  };

  const watch = async (ctx: WatchCtx) => {
    if (watching) return;
    watching = true;
    try {
      while (alive) {
        await s.wait();
        if (!alive) break;
        let poll: Poll;
        try {
          poll = { info: await s.getUpdate(false) };
          setInfo(poll.info);
        } catch {
          poll = null;
        }
        const verdict = watchStep(ctx, poll, s.now());
        if (verdict.kind === "continue") {
          setPhase(verdict.phase);
          continue;
        }
        if (verdict.kind === "reload") {
          setPhase("reloading");
          s.reload();
          return;
        }
        setPhase("idle");
        if (verdict.kind === "gave-up") setError(verdict.message);
        // Settled: refresh the version line (a rollback changes nothing to
        // reload for, but the panel should still say what is running).
        else void load(false);
        return;
      }
    } finally {
      watching = false;
    }
  };

  const begin = async (start: () => Promise<UpdateStarted>) => {
    const from = version()?.version ?? info()?.current;
    if (from === undefined || watching) return;
    setError("");
    const baselineStartedAt = info()?.status.started_at ?? null;
    setPhase("starting");
    try {
      await start();
    } catch (e) {
      setPhase("idle");
      setError(message(e));
      return;
    }
    void watch({
      fromVersion: from,
      baselineStartedAt,
      startedAt: s.now(),
      unreachableSince: null,
      begun: false,
    });
  };

  /** Update to `latest.version` (pinned, so the server installs exactly the
   * release the button named — not whatever is newest by the time it runs). */
  const update = () => {
    const latest = info()?.latest;
    return begin(() => s.startUpdate(latest ? updateTarget(latest.version) : "latest"));
  };
  const rollback = () => begin(() => s.startRollback());

  /** The panel shows its own flow's phase, else the server's (a run another
   * screen started). */
  const busy = () => phase() !== "idle" || isInProgress(info()?.status);

  void load(false).then(() => {
    const current = info();
    if (current && isInProgress(current.status)) {
      setPhase("running");
      void watch({
        fromVersion: current.current,
        baselineStartedAt: current.status.started_at ?? null,
        startedAt: s.now(),
        unreachableSince: null,
        begun: true,
      });
    }
  });

  return {
    version,
    info,
    phase,
    error,
    checking,
    loaded,
    busy,
    checkNow,
    update,
    rollback,
    refresh: () => load(false),
  };
}

export type SoftwareUpdateController = ReturnType<typeof createSoftwareUpdate>;
