// The v3 `.mivnav` precomputed-artifact build trigger, client side —
// `POST /api/routing/mivnav/build` and friends
// (`backend/mivnav/features/routing/routes.py`).
//
// The artifact is a per-chart-set precompute (depth bands, connected
// components, portals, contracted shortcuts, landmark tables) that the
// `"mivnav"` algorithm reads instead of rebuilding the topology per
// request. It is MINUTES of Pi CPU over the whole chart set, so the build
// is a background job with a polled status — never part of a route
// request, and (repeated project decision, see `artifact_build.py`'s own
// module docstring) NEVER auto-triggered by installing or deleting a
// chart set. This module only ever starts a build on an explicit call
// from the "Build" button in Settings → Routes.
//
// Shape mirrors `routeiqAccess.ts` + `signalkAccess.ts`: the fetch
// functions here, an injectable-seam controller (`createMivnavBuild`)
// below, so the poll loop is deterministic in a test.

import { createSignal, onCleanup } from "solid-js";
import { fetchJsonDefault, type FetchJson } from "./settings/apiFetch";

const BUILD_URL = "/api/routing/mivnav/build";
const CANCEL_URL = "/api/routing/mivnav/build/cancel";
const ARTIFACTS_URL = "/api/routing/mivnav/artifacts";

/** `GET /routing/mivnav/build`'s status blob —
 * `mivnav.features.routing.artifact_build.JobStatus` on top of
 * `mivnav.ingest.runner.BaseJobStatus`. `state` is `idle` before this
 * process's first build, `fetch`/`bake` while running, then `done` or
 * `error` (`error` text `"cancelled"` for a cancelled one). `total === 0`
 * means the stage's size is not known yet — render an indeterminate bar,
 * not a divide-by-zero. The `report` fields are all `0`/empty until a
 * build finishes; a `done` build with everything `0` is the "the build
 * saw no charts" symptom the report exists to expose. */
export interface MivnavJobStatus {
  state: "idle" | "fetch" | "bake" | "done" | "error";
  detail: string;
  error: string;
  /** The current sub-stage: `"decoding cells"`, `"refining tiles"`,
   * `"band topology"`, `"writing artifact"` — the label above the bar.
   * The bake used to be one opaque `"building all bands"` for its whole
   * (minutes-long) run; `chartcore.mivnav_build_artifact`'s progress
   * callback now advances this per quadtree refine pass and per band. */
  task: string;
  current: number;
  total: number;
  log: string[];
  chart_set_id: string;
  bytes: number;
  tile_count: number;
  vector_required_tiles: number;
  total_cells: number;
  bands: number;
  portals: number;
  tiles_per_rung: number[];
  /** Wall-clock seconds of the decode stage and of the
   * `mivnav_build_artifact` call, split — the two numbers that say
   * whether a national build is viable on the Pi and which half is
   * slow. Optional: absent until a build finishes. */
  decode_seconds?: number;
  build_seconds?: number;
}

/** One entry of `GET /routing/mivnav/artifacts` — whether this installed
 * chart set has a `.mivnav` the route path could use RIGHT NOW under the
 * current CATZOC allowance mode, and if not, `reason` is
 * `chartcore::mivnav::Staleness`'s own text and `kind` the same fact
 * machine-readable. */
export interface MivnavArtifactEntry {
  chart_set_id: string;
  catzoc_allowance_mode: string;
  present: boolean;
  usable: boolean;
  kind: "missing" | "unreadable" | "chart_set" | "sequence" | "versions" | null;
  reason: string | null;
  built_sequence?: number | null;
  current_sequence?: number | null;
  bytes?: number;
  cells?: number;
}

export interface MivnavArtifactsResponse {
  catzoc_allowance_mode: string;
  artifacts: MivnavArtifactEntry[];
}

/** `fetch`/`bake` — a build is in flight and the panel should poll. */
export function jobIsRunning(job: MivnavJobStatus | null): boolean {
  return job?.state === "fetch" || job?.state === "bake";
}

/** A one-line, machine-classified summary of an artifact entry for the
 * status pill — the text a sailor reads to decide whether to build, and
 * a tone the UI maps to a colour. Pure; unit-tested. */
export function artifactStatusLabel(entry: MivnavArtifactEntry): {
  text: string;
  tone: "ok" | "notice" | "muted";
} {
  if (entry.usable) return { text: "current", tone: "ok" };
  if (!entry.present || entry.kind === "missing") {
    return { text: "not built", tone: "muted" };
  }
  if (entry.kind === "sequence" || entry.kind === "chart_set") {
    return { text: "stale — charts changed since it was built", tone: "notice" };
  }
  if (entry.kind === "versions") {
    return { text: "stale — built by an older mivnav", tone: "notice" };
  }
  if (entry.kind === "unreadable") return { text: "unreadable", tone: "notice" };
  return { text: entry.reason ?? "not usable", tone: "notice" };
}

// --- the raw fetch functions -------------------------------------------

export async function fetchMivnavArtifacts(
  getJson: FetchJson = fetchJsonDefault,
): Promise<MivnavArtifactEntry[]> {
  const body = await getJson<MivnavArtifactsResponse>(ARTIFACTS_URL);
  return body.artifacts;
}

export async function fetchMivnavJob(
  getJson: FetchJson = fetchJsonDefault,
): Promise<MivnavJobStatus> {
  return getJson<MivnavJobStatus>(BUILD_URL);
}

/** `POST /routing/mivnav/build`. `chartSetId` is required only when more
 * than one set is installed — the backend 409s an ambiguous request and
 * that message is surfaced verbatim. 422 for an id that is not a path
 * token. */
export async function startMivnavBuild(
  chartSetId: string | undefined,
  getJson: FetchJson = fetchJsonDefault,
): Promise<MivnavJobStatus> {
  return getJson<MivnavJobStatus>(BUILD_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(chartSetId ? { chart_set_id: chartSetId } : {}),
  });
}

/** `POST /routing/mivnav/build/cancel`. 409 when nothing is running. */
export async function cancelMivnavBuild(
  getJson: FetchJson = fetchJsonDefault,
): Promise<MivnavJobStatus> {
  return getJson<MivnavJobStatus>(CANCEL_URL, { method: "POST" });
}

// --- the controller -------------------------------------------------------

export interface MivnavBuildSeams {
  getArtifacts: () => Promise<MivnavArtifactEntry[]>;
  getJob: () => Promise<MivnavJobStatus>;
  startBuild: (chartSetId: string | undefined) => Promise<MivnavJobStatus>;
  cancelBuild: () => Promise<MivnavJobStatus>;
  /** Sleep between polls while a build runs. Injected so a test drives
   * the loop without real time; defaults to a 1s timer. */
  wait?: () => Promise<void>;
}

const defaultSeams: MivnavBuildSeams = {
  getArtifacts: () => fetchMivnavArtifacts(),
  getJob: () => fetchMivnavJob(),
  startBuild: (id) => startMivnavBuild(id),
  cancelBuild: () => cancelMivnavBuild(),
};

/**
 * The Settings → Routes build panel's state: the artifact listing,
 * the live job status, and `build`/`cancel`/`refresh` actions. While a
 * build is `fetch`/`bake` it re-polls both the job and the listing on
 * `wait()` intervals; the loop stops when the job settles or the
 * component unmounts.
 */
export function createMivnavBuild(seams: Partial<MivnavBuildSeams> = {}) {
  const s: MivnavBuildSeams = { ...defaultSeams, ...seams };
  const wait = s.wait ?? (() => new Promise<void>((r) => setTimeout(r, 1000)));

  const [artifacts, setArtifacts] = createSignal<MivnavArtifactEntry[]>([]);
  const [job, setJob] = createSignal<MivnavJobStatus | null>(null);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [loaded, setLoaded] = createSignal(false);

  let alive = true;
  let looping = false;
  onCleanup(() => {
    alive = false;
  });

  const running = () => jobIsRunning(job());

  const refreshArtifacts = async () => {
    try {
      setArtifacts(await s.getArtifacts());
      setLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const refreshJob = async () => {
    try {
      setJob(await s.getJob());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const refresh = async () => {
    await Promise.all([refreshArtifacts(), refreshJob()]);
  };

  /** Poll job + listing while a build is in flight. One loop at a time. */
  const pollWhileRunning = async () => {
    if (looping) return;
    looping = true;
    try {
      while (alive && running()) {
        await wait();
        if (!alive) break;
        await refresh();
      }
    } finally {
      looping = false;
    }
  };

  const build = async (chartSetId?: string) => {
    setBusy(true);
    setError("");
    try {
      setJob(await s.startBuild(chartSetId));
      void refreshArtifacts();
      void pollWhileRunning();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    setError("");
    try {
      setJob(await s.cancelBuild());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Initial load, and pick up a build already running (started on another
  // device, or before this panel was opened).
  void refresh().then(() => {
    if (running()) void pollWhileRunning();
  });

  return { artifacts, job, error, busy, loaded, running, refresh, build, cancel };
}
