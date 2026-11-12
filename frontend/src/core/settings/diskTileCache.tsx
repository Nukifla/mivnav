import { createResource, onCleanup, Show, type Component } from "solid-js";
import { Button } from "../ui/Button";
import { formatBytes } from "./DatasetList";

// How full the server's chart tile disk cache is, next to its budget field,
// so "do we need to raise it?" has an answer. Reads `disk_tile_cache` from
// GET /ocharts/status (mivnav.features.ocharts.disk_tiles `stats()`), and how
// far the idle-time pre-render into it has got (`warm.pretile`).

export interface DiskTileCacheStats {
  /** "off" (budget 0), "locked" (waiting on / failed the licence check), "ready". */
  state: "off" | "locked" | "ready";
  locked_reason: string;
  /** Null until the store has measured itself. */
  bytes: number | null;
  budget: number;
  evictions: number;
}

export interface DiskCacheFill {
  /** 0-100, null when unknown. */
  pct: number | null;
  label: string;
  /** Evicting, or near the budget: worth raising it. */
  full: boolean;
  note: string;
}

/** Above this fraction of the budget the cache is "nearly full". The store
 * evicts down to 90% when it overflows, so a cache that has ever filled
 * sits right around here. */
const NEARLY_FULL = 0.85;

/** Pure, so it is testable without a DOM. */
export function diskCacheFill(s: DiskTileCacheStats): DiskCacheFill {
  if (s.state === "off") return { pct: null, label: "Off", full: false, note: "" };
  if (s.state === "locked")
    return {
      pct: null,
      label: "Locked",
      full: false,
      note: s.locked_reason || "Waiting for the o-charts licence check.",
    };
  if (s.bytes === null)
    return { pct: null, label: `? of ${formatBytes(s.budget)}`, full: false, note: "Measuring…" };
  const ratio = s.budget > 0 ? s.bytes / s.budget : 0;
  const pct = Math.min(100, Math.max(0, ratio * 100));
  const full = s.evictions > 0 || ratio >= NEARLY_FULL;
  return {
    pct,
    label: `${formatBytes(s.bytes)} of ${formatBytes(s.budget)} (${Math.round(pct)}%)`,
    full,
    note: full
      ? s.evictions > 0
        ? `Full: ${s.evictions} tiles evicted since the server started. Raise the budget to keep them.`
        : "Nearly full. Raise the budget if the boat will see more chart area."
      : "",
  };
}

/** `warm` from GET /ocharts/status (mivnav.features.ocharts.warm
 * `CellWarmer.status()`); `{state: "disabled"}` alone when prefetch is off. */
export interface WarmStatus {
  state: string;
  pretile?: {
    /** "not started" | "disabled" | "waiting for the licence check" |
     * "carrying over" | "planning" | "rendering z/x/y" | "complete" | "error" */
    state: string;
    total: number;
    done: number;
    rendered: number;
    failed: number;
  };
}

export interface PretileProgress {
  label: string;
  /** 0-100 while walking the plan, else null. */
  pct: number | null;
  /** Still working: worth polling. */
  busy: boolean;
}

/** Pure, so it is testable without a DOM. */
export function pretileProgress(w: WarmStatus | null | undefined): PretileProgress {
  if (!w || w.state === "disabled") return { label: "Off", pct: null, busy: false };
  if (w.state === "oversized")
    return { label: "Stopped: overview cells exceed the cell cache", pct: null, busy: false };
  const p = w.pretile;
  if (!p || p.state === "disabled") return { label: "Off", pct: null, busy: false };
  if (p.state === "complete") {
    const failed = p.failed > 0 ? `, ${p.failed.toLocaleString()} failed` : "";
    return { label: `Done (${p.total.toLocaleString()} tiles${failed})`, pct: null, busy: false };
  }
  if (p.state === "error") return { label: "Error, see server log", pct: null, busy: false };
  // The walk leaves "planning" in place while it skips tiles already on
  // disk, so a planned total is what says the walk has begun.
  if ((p.state === "planning" && p.total > 0) || p.state.startsWith("rendering")) {
    const pct = p.total > 0 ? Math.min(100, (p.done / p.total) * 100) : 0;
    return {
      label: `Working ${Math.floor(pct)}% (${p.done.toLocaleString()} of ${p.total.toLocaleString()})`,
      pct,
      busy: true,
    };
  }
  const label =
    p.state === "planning"
      ? "Planning…"
      : p.state === "carrying over"
        ? "Keeping tiles from the previous charts…"
        : p.state === "waiting for the licence check"
          ? "Waiting for the licence check"
          : "Starting…";
  return { label, pct: null, busy: true };
}

interface Status {
  disk: DiskTileCacheStats | null;
  warm: WarmStatus | null;
}

async function fetchStatus(): Promise<Status | null> {
  const res = await fetch("/api/ocharts/status");
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as {
    disk_tile_cache?: DiskTileCacheStats;
    warm?: WarmStatus;
  } | null;
  return body ? { disk: body.disk_tile_cache ?? null, warm: body.warm ?? null } : null;
}

/** While pre-rendering, how often the meter re-reads the status. */
const POLL_MS = 5000;

export const DiskTileCacheMeter: Component = () => {
  const [status, { refetch }] = createResource(fetchStatus);
  // .latest, not (): a poll must not blank the labels while it is in flight.
  const fill = () => {
    const s = status.latest?.disk;
    return s ? diskCacheFill(s) : null;
  };
  const pretile = () => (status.latest ? pretileProgress(status.latest.warm) : null);
  const timer = setInterval(() => {
    if (pretile()?.busy && !status.loading) void refetch();
  }, POLL_MS);
  onCleanup(() => clearInterval(timer));
  const first = () => status.loading && status.latest === undefined;
  return (
    <div class="space-y-1 text-xs">
      <div class="flex items-center justify-between gap-2">
        <span class="text-fg-2">Disk cache in use</span>
        <span class="shrink-0 text-fg">
          {first() ? "…" : (fill()?.label ?? "unavailable")}
        </span>
      </div>
      <Show when={fill()?.pct != null}>
        <div class="h-1.5 w-full overflow-hidden rounded bg-chrome-2">
          <div
            class={`h-full rounded ${fill()!.full ? "bg-notice" : "bg-accent"}`}
            style={{ width: `${fill()!.pct}%` }}
          />
        </div>
      </Show>
      <div class="flex items-center justify-between gap-2">
        <span class="text-fg-2">Pre-rendering</span>
        <span class="shrink-0 text-fg">{first() ? "…" : (pretile()?.label ?? "unavailable")}</span>
      </div>
      <Show when={pretile()?.pct != null}>
        <div class="h-1.5 w-full overflow-hidden rounded bg-chrome-2">
          <div class="h-full rounded bg-accent" style={{ width: `${pretile()!.pct}%` }} />
        </div>
      </Show>
      <Show when={pretile()?.busy}>
        <div class="text-fg-2">Runs only while nobody is viewing charts.</div>
      </Show>
      <div class="flex items-center justify-between gap-2">
        <span class={fill()?.full ? "text-notice" : "text-fg-2"}>
          {fill()?.note ?? ""} Stored encrypted, bound to this machine.
        </span>
        <Button disabled={status.loading} onClick={() => void refetch()}>
          Refresh
        </Button>
      </div>
    </div>
  );
};
