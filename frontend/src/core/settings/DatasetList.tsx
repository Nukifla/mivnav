import {
  createEffect,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
  type Component,
  type JSX,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import Database from "lucide-solid/icons/database";
import type { components } from "../../api.generated";
import { AccordionSection } from "../ui/Accordion";
import { Button } from "../ui/Button";
import type { DatasetParamsRegistry } from "./datasetParams";
import type { ConfigRegionsResponse, Region } from "./regions";
import { dedupeId, slugify } from "./slug";
import { fetchJsonDefault } from "./apiFetch";
import { DatasetGroupCard, DatasetGroupEditForm, type DatasetActions } from "./DatasetGroupCard";
import { groupDatasets, isGroupedProvider, type DatasetGroup } from "./datasetGroups";

// The generic, provider-agnostic dataset list + create/edit form — the
// frontend half of `mivnav.api.datasets`. Supersedes the RETIRED
// PoiData.tsx/SatelliteData.tsx, including their orphan-set list/delete and
// an "adopt" path via Edit for a pre-DatasetConfig set. See
// docs/architecture/dataset-list.md for the full provenance and the
// onCatalogChanged/params-prefill contracts.

/** The live progress blob a bakeable dataset's `IngestRunner` reports
 * (`mivnav.ingest.runner.BaseJobStatus`). `total === 0` means indeterminate —
 * render a pulsing bar, not a divide-by-zero percentage. `log` is oldest-first. */
export interface DatasetProgress {
  state: string;
  task: string;
  current: number;
  total: number;
  log: string[];
  /** "cancelled" when a sailor hit Cancel; a real failure's message
   * otherwise; "" while unerrored. Both report `state === "error"` — this
   * is the one field that tells them apart. */
  error: string;
}

export interface DatasetEntry {
  id: string;
  provider: string;
  name: string;
  region_id: string | null;
  /** What this declaration IS, orthogonal to when it bakes: a `"bake"` with
   * its own directory, or `"live-cache"` naming a provider's ONE ongoing
   * fetch-through cache (weather's proxy, osm_world's live tile fallback).
   * A live-cache dataset is never automatically due and never
   * bake-triggerable (`POST .../ingest` 409s it) — see `hasGenericBakePath`. */
  mode: "bake" | "live-cache";
  /** WHICH backing produces this dataset, for a provider with more than one
   * behind its single id (weather: "om" | "grib"); `null` otherwise. */
  implementation: string | null;
  /** WHEN we bake, and nothing else. */
  schedule: "manual" | "ttl";
  /** Seconds between automatic re-bakes when `schedule === "ttl"`; `null`
   * means "ttl" has no actionable cadence yet. */
  ttl_s: number | null;
  params: Record<string, unknown>;
  /** `false` pauses a dataset without deleting it (jt lvpkxtsr): kept out of
   * serving and periodic rebake, but config entry AND baked files survive —
   * toggled via `POST /datasets/{id}/enable`/`disable`, never this `PUT`. */
  enabled: boolean;
  size: number;
  last_bake_at: string | null;
  status: "unbaked" | "baking" | "error" | "baked";
  progress?: DatasetProgress | null;
  /** `false` for an ORPHAN poi/satellite set — real baked data with no
   * `DatasetConfig` entry (predates declared datasets, or lost its entry).
   * Gates Bake but not Edit/Delete — Edit doubles as "adopt" for these
   * (see docs/architecture/dataset-list.md). */
  declared: boolean;
}

/** One entry of `GET /datasets`'s `providers` catalog — every provider this
 * form can show, with the live registry's own `label`/`creatable`. Replaces
 * this module's former hand-copied `PROVIDER_LABEL`/`CREATABLE_PROVIDERS`
 * literals (#pxxukylq), which could silently go stale against the backend. */
export interface ProviderCatalogEntry {
  id: string;
  label: string;
  /** Per-implementation labels for a provider whose datasets can be backed
   * by different sources (poi: `{overpass: "POI (OSM)", <plugin source>: "POI (…)"}`);
   * `{}` for a single-source provider. Resolved by `datasetLabel`. Optional
   * so a catalog without it (older backend, test fixture) still labels. */
  implementation_labels?: Record<string, string>;
  /** The implementation a dataset with `implementation: null` means. */
  default_implementation?: string | null;
  creatable: boolean;
  /** "none" for a provider with no region concept at all. Read by
   * `DatasetEditForm` to hide its Region <select> for such a provider. */
  region_kind: "bbox" | "country" | "chart-set" | "none";
  /** The schedule a NEW dataset of this provider starts with (its
   * `IngestSpec`'s): "manual" for most, notices "ttl" every 30 min. A fresh
   * draft pre-fills Schedule/interval from these. Optional for an older
   * backend or a test fixture (→ manual). */
  schedule?: "manual" | "ttl";
  ttl_s?: number | null;
  /** Whether the provider has a live fetch-through cache a "live-cache"
   * dataset can name (osm_world's tile fallback, a plugin's). Optional for
   * an older backend or a test fixture (→ no). */
  live_cache?: boolean;
}

interface DatasetsResponse {
  datasets: DatasetEntry[];
  providers: ProviderCatalogEntry[];
}

/** What `PUT /datasets/{id}` takes as a body (`mivnav.api.datasets
 * .DatasetPutBody`) — off the OpenAPI schema rather than hand-mirrored.
 * `provider` is consequently the backend's closed `DatasetProvider` literal,
 * not `string`: the draft's own `provider` signal stays a plain string on
 * purpose (#pxxukylq — the frontend doesn't hardcode the provider list, it's
 * read off `GET /datasets`'s own catalog), so `DatasetEditForm.save` below
 * casts across that seam and leaves validation to the backend, same as
 * `regions.tsx`'s "let the backend say it" posture. */
export type DatasetPutBody = components["schemas"]["DatasetPutBody"];

/** Providers a sailor can DECLARE a NEW dataset for — every `creatable`
 * entry. o-charts (own install UI) and the pre-baked chart store (no bake
 * path) 409 on both `PUT`/`POST .../ingest`, so neither is offered here,
 * though both still LIST and can be DELETED normally. */
function creatableProviders(providers: readonly ProviderCatalogEntry[]): ProviderCatalogEntry[] {
  return providers.filter((p) => p.creatable);
}

/** Whether `PUT`/`POST .../ingest` would accept an action on this dataset —
 * never offer an action that can only ever 409. Gates Edit always, and Bake
 * for a DECLARED dataset; an orphan additionally needs `canBakeDataset`. */
function hasGenericBakePath(providers: readonly ProviderCatalogEntry[], provider: string): boolean {
  return providers.find((p) => p.id === provider)?.creatable ?? false;
}

/** Whether `provider` has a region concept at all — "bbox" assumed if the
 * catalog hasn't loaded yet, since every provider has one today. */
function hasRegion(providers: readonly ProviderCatalogEntry[], provider: string): boolean {
  return (providers.find((p) => p.id === provider)?.region_kind ?? "bbox") !== "none";
}

/** Gates the Kind select, and clears a stale "live-cache" selection if a
 * fresh draft's provider changes away. */
function supportsLiveCache(providers: readonly ProviderCatalogEntry[], provider: string): boolean {
  return providers.find((p) => p.id === provider)?.live_cache === true;
}
/** Whether to offer Bake/Re-bake: a generic bake path AND the dataset must
 * be DECLARED — an orphan has no region/schedule to bake from, and
 * `POST .../ingest` 404s for an id `Config.datasets` doesn't have. */
function canBakeDataset(providers: readonly ProviderCatalogEntry[], ds: DatasetEntry): boolean {
  return ds.declared && hasGenericBakePath(providers, ds.provider);
}

/** A provider's display label off the fetched catalog, `id` as fallback.
 * Exported so `Storage.tsx`'s breakdown reads the SAME server-reported
 * labels rather than a second hand-copied literal drifting out of sync. */
export function providerLabel(providers: readonly ProviderCatalogEntry[], id: string): string {
  return providers.find((p) => p.id === id)?.label ?? id;
}

/** A DATASET's display label: its provider's per-implementation label when
 * the provider declares one for `implementation` (null → the provider's
 * default implementation), else the plain provider label. So a POI row reads
 * "POI (OSM)" or a plugin source's label rather than one "POI (points of interest)" for
 * both — the mapping itself is the backend provider's, not hardcoded here. */
export function datasetLabel(
  providers: readonly ProviderCatalogEntry[],
  id: string,
  implementation: string | null,
): string {
  const p = providers.find((entry) => entry.id === id);
  if (!p) return id;
  const key = implementation || p.default_implementation;
  return (key && p.implementation_labels?.[key]) || p.label;
}

/** A compact human size (`1536` → `1.5 KB`). Up to TB: the Storage
 * section also shows the whole disk's size. */
export function formatBytes(n: number): string {
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i > 0 && v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** A compact relative-time label for an ISO-8601 timestamp: "just now",
 * "5 min ago", "3 hours ago", "2 days ago"; falls back to the locale date
 * past a week. `now` is injectable so the buckets are testable. */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const sec = Math.max(0, Math.round((now - then) / 1000));
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} ${hr === 1 ? "hour" : "hours"} ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day} ${day === 1 ? "day" : "days"} ago`;
  return new Date(then).toLocaleDateString();
}

/** A dataset id candidate from a typed Name, matching the backend's id regex
 * (`config/model.py`'s `_SAFE_ID_RE`) so the derived id is never rejected. */
export function slugifyDatasetName(name: string): string {
  return slugify(name, "dataset");
}

/** Dedupe a candidate id against ids already in use, appending `-2`, `-3`,
 * … — the only thing standing between two datasets landing on the same
 * on-disk directory now that the id is never typed by hand. */
export function dedupeDatasetId(base: string, taken: readonly string[]): string {
  return dedupeId(base, taken);
}

export const STATUS_LABEL: Record<DatasetEntry["status"], string> = {
  unbaked: "Not baked",
  baking: "Baking…",
  error: "Bake failed",
  baked: "Baked",
};

export const STATUS_TONE: Record<DatasetEntry["status"], string> = {
  unbaked: "text-fg-3",
  baking: "text-fg-2",
  error: "text-alarm",
  baked: "text-ok",
};

/** A live-cache dataset's backend `status` is still the generic disk-derived
 * "baked"/"unbaked" pair (#xkpmrvxw), but "Baked" reads as a lie on a row
 * that never bakes anything. Row-display-only label override, not a backend
 * vocabulary change. */
function statusLabel(ds: DatasetEntry): string {
  if (ds.mode === "live-cache") return ds.size > 0 ? "Live cache" : "Not cached yet";
  return STATUS_LABEL[ds.status];
}

function statusTone(ds: DatasetEntry): string {
  if (ds.mode === "live-cache") return ds.size > 0 ? "text-ok" : "text-fg-3";
  return STATUS_TONE[ds.status];
}

/** `current`/`total` as a 0–100 percent, clamped — `null` when `total` is 0
 * (indeterminate: the runner hasn't learned the stage's size yet), so the
 * caller renders a plain/pulsing bar instead of dividing by zero. */
export function progressPercent(current: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.max(0, Math.min(100, (current / total) * 100));
}

/** A job log, newest line first (`log` arrives oldest-first). */
export const BakeLog: Component<{ log: readonly string[] }> = (props) => (
  <pre class="max-h-24 overflow-y-auto rounded bg-chrome p-1 text-[10px] leading-snug whitespace-pre-wrap break-all text-fg-3">
    {[...props.log].reverse().join("\n")}
  </pre>
);

/** How a row shows its last job's `progress`:
 * - `live` — a bake is running: the full panel, bar and log.
 * - `failed` — the last bake failed or was cancelled: the panel without a
 *   bar, so the log saying WHY stays in view until the next bake.
 * - `done` — the last bake succeeded: only a collapsed "Last bake log"
 *   toggle. An open panel on a finished row reads as still running (user,
 *   2026-11-05: "looks like it is not done and adds clutter") — worse when
 *   the final stage had nothing to do and its 0/0 bar sat there pulsing.
 * - `none` — no progress blob (nothing ran since the server started). */
export type ProgressView = "live" | "failed" | "done" | "none";

export function progressView(
  status: DatasetEntry["status"],
  progress: DatasetProgress | null | undefined,
): ProgressView {
  if (!progress) return "none";
  if (status === "baking") return "live";
  if (status === "error" || progress.error) return "failed";
  return "done";
}

/** A dataset row's bake progress: task label + numerator/total, a bar while
 * `live` (indeterminate/pulsing while `total` is unknown), and a scrollable
 * log. See {@link progressView} for when it is shown at all. */
export const DatasetProgressPanel: Component<{ progress: DatasetProgress; live: boolean }> = (
  props,
) => {
  const percent = () => progressPercent(props.progress.current, props.progress.total);
  return (
    <div class="space-y-1 rounded border border-line-2 bg-chrome-2/60 p-1.5">
      <div class="flex items-center justify-between gap-2 text-[11px] text-fg-2">
        {/* "cancelled" (jt lvpkxtsr) reads as a deliberate stop, not a
            failure — worth its own label rather than the raw last task
            (e.g. a stale "extracting z8-12") or the bare state "error". */}
        <span class="truncate">
          {props.progress.error === "cancelled"
            ? "Cancelled"
            : props.progress.task || props.progress.state}
        </span>
        <Show when={props.live && props.progress.total > 0}>
          <span class="shrink-0 tabular-nums">
            {props.progress.current}/{props.progress.total}
          </span>
        </Show>
      </div>
      <Show when={props.live}>
        <div class="h-1.5 w-full overflow-hidden rounded-full bg-line">
          <Show
            when={percent() !== null}
            fallback={<div class="h-full w-1/3 animate-pulse rounded-full bg-accent" />}
          >
            <div
              class="h-full rounded-full bg-accent transition-[width]"
              style={{ width: `${percent()}%` }}
            />
          </Show>
        </div>
      </Show>
      <Show when={props.progress.log.length > 0}>
        {/* Newest first: `log` (BaseJobStatus's ring buffer) is oldest-first,
            but a fixed-height, no-scroll-management box showing the log in
            that order would pin a live bake's OLDEST lines in view and bury
            the current activity below the fold — the opposite of what a
            sailor watching a long bake needs to see. */}
        <BakeLog log={props.progress.log} />
      </Show>
    </div>
  );
};

interface DatasetEditFormProps {
  /** Present when editing an existing dataset (id/provider fixed, rest
   * prefilled); absent for a fresh "+ Add dataset" draft. */
  dataset?: DatasetEntry;
  regions: readonly Region[];
  /** `DatasetListSection` only mounts a fresh draft once this has loaded —
   * a `creatable` entry must exist before the provider `<select>` has a
   * valid default. */
  providers: readonly ProviderCatalogEntry[];
  /** Every id already in use, so a fresh draft's derived id can dedupe on
   * save. Unused when editing (id never changes). */
  existingIds: readonly string[];
  paramsComponents: DatasetParamsRegistry;
  busy: boolean;
  onCancel: () => void;
  onSave: (id: string, body: DatasetPutBody) => Promise<void>;
  /** For a fresh draft: the existing cards and their actions. Picking a
   * grouped provider (POI, satellite) hands the draft to that provider's
   * card editor — its existing card if there is one, else a new one — so
   * regions/sources are picked several at a time. */
  groups?: readonly DatasetGroup[];
  actions?: DatasetActions;
}

/**
 * Create-or-edit one dataset. Provider is fixed once a dataset exists — a PUT
 * changing it would orphan whatever baked under the OLD provider's directory.
 * A fresh draft's id is derived from Name on Save, deduped against `existingIds`.
 */
const DatasetEditForm: Component<DatasetEditFormProps> = (props) => {
  const isNew = () => props.dataset === undefined;
  const [provider, setProvider] = createSignal(
    props.dataset?.provider ?? creatableProviders(props.providers)[0]?.id ?? "",
  );
  const [name, setName] = createSignal(props.dataset?.name ?? "");
  const [nameDirty, setNameDirty] = createSignal(false);
  const [regionId, setRegionId] = createSignal(props.dataset?.region_id ?? "");
  const [mode, setMode] = createSignal<"bake" | "live-cache">(props.dataset?.mode ?? "bake");
  // Edited by the provider's own params sub-form (weather's om/grib picker),
  // not a generic control here: WHICH backings exist is feature knowledge,
  // but the VALUE is core's (jt rsmpwtmw), so the signal lives here.
  const [implementation, setImplementation] = createSignal<string | null>(
    props.dataset?.implementation ?? null,
  );
  const [schedule, setSchedule] = createSignal<"manual" | "ttl">(
    props.dataset?.schedule ?? "manual",
  );
  // Hours, not seconds — the unit a sailor actually thinks in; converted to
  // `ttl_s` on submit. Empty string (not 0) while unset so the TTL input can
  // show a placeholder rather than a misleading "0".
  const [ttlHours, setTtlHours] = createSignal(
    props.dataset?.ttl_s ? String(props.dataset.ttl_s / 3600) : "",
  );
  const [params, setParams] = createSignal<Record<string, unknown>>(props.dataset?.params ?? {});
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");

  const busy = () => props.busy || saving();
  const ParamsForm = () => props.paramsComponents[provider()];
  /** The provider id when a fresh draft hands off to a card editor. */
  const groupedDraft = (): string | false =>
    isNew() &&
    props.actions !== undefined &&
    isGroupedProvider(props.providers.find((p) => p.id === provider()))
      ? provider()
      : false;

  // If a fresh draft's provider changes away from a live-cache provider
  // while "live-cache" is selected, the Kind control disappears but the
  // signal would otherwise keep an undisplayable value.
  createEffect(() => {
    if (!supportsLiveCache(props.providers, provider()) && mode() === "live-cache") setMode("bake");
  });
  createEffect(() => {
    const id = provider();
    if (!isNew()) return;
    setImplementation(null);
    // A fresh draft starts on its provider's own default schedule (notices:
    // automatic, every 30 min — safety data), not always "manual".
    const p = props.providers.find((entry) => entry.id === id);
    setSchedule(p?.schedule ?? "manual");
    setTtlHours(p?.ttl_s ? String(p.ttl_s / 3600) : "");
  });

  createEffect(() => {
    if (!isNew() || nameDirty()) return;
    const label = datasetLabel(props.providers, provider(), implementation());
    const region = props.regions.find((r) => r.id === regionId());
    setName(region ? `${label} - ${region.name}` : `${label} dataset`);
  });

  const submit = async () => {
    setError("");
    const trimmedName = name().trim();
    if (!trimmedName) {
      setError("Name the dataset before saving.");
      return;
    }
    let ttlSeconds: number | null = null;
    if (mode() === "bake" && schedule() === "ttl") {
      const hours = Number(ttlHours());
      if (!(hours > 0)) {
        setError("Give a re-bake interval (in hours) for an automatic schedule.");
        return;
      }
      ttlSeconds = hours * 3600;
    }
    const targetId = isNew()
      ? dedupeDatasetId(slugifyDatasetName(trimmedName), props.existingIds)
      : (props.dataset?.id ?? "");
    setSaving(true);
    try {
      await props.onSave(targetId, {
        // Cast: `provider()` is a plain string (see `DatasetPutBody`'s own
        // docstring above) — the backend's `DatasetProvider` literal
        // validates it, and an unknown value 422s there rather than here.
        provider: provider() as DatasetPutBody["provider"],
        name: trimmedName,
        region_id: regionId() || null,
        mode: mode(),
        implementation: implementation(),
        schedule: schedule(),
        ttl_s: ttlSeconds,
        params: params(),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="space-y-2 rounded border border-line bg-chrome-2/40 p-2">
      <Show
        when={!isNew()}
        fallback={
          <label class="block space-y-1">
            <span class="text-xs text-fg-2">Provider</span>
            <select
              class="w-full rounded border border-line px-2 py-1 focus:border-accent focus:outline-none"
              value={provider()}
              disabled={busy()}
              onChange={(e) => {
                setProvider(e.currentTarget.value);
                setParams({}); // a different provider's params start fresh
              }}
            >
              <For each={creatableProviders(props.providers)}>
                {(p) => <option value={p.id}>{p.label}</option>}
              </For>
            </select>
          </label>
        }
      >
        <p class="text-xs text-fg-2">
          {datasetLabel(props.providers, provider(), implementation())} ·{" "}
          <span class="font-mono">{props.dataset?.id}</span>
        </p>
        <Show when={props.dataset?.declared === false}>
          <p class="text-xs text-fg-2">
            Not declared yet — Save gives it the region/schedule below and turns it into a normal
            dataset, so it can be re-baked. Its already-baked data is untouched either way.
          </p>
        </Show>
      </Show>

      {/* Keyed on the provider id: switching provider remounts the card
          editor with that provider's own card state. */}
      <Show when={groupedDraft()} keyed>
        <DatasetGroupEditForm
          regions={props.regions}
          providers={props.providers}
          existingIds={props.existingIds}
          paramsComponents={props.paramsComponents}
          actions={props.actions!}
          provider={provider()}
          group={props.groups?.find((g) => g.provider === provider())}
          onDone={props.onCancel}
        />
      </Show>
      <Show when={!groupedDraft()}>
        <label class="block space-y-1">
          <span class="text-xs text-fg-2">Name</span>
          <input
            class="w-full rounded border border-line px-2 py-1 focus:border-accent focus:outline-none"
            value={name()}
            disabled={busy()}
            onInput={(e) => {
              setName(e.currentTarget.value);
              if (isNew()) setNameDirty(true);
            }}
          />
        </label>

        {/* Hidden entirely (not shown-but-inert) for a provider with no region
            concept at all. */}
        <Show when={hasRegion(props.providers, provider())}>
          <label class="block space-y-1">
            <span class="text-xs text-fg-2">Region</span>
            <select
              class="w-full rounded border border-line px-2 py-1 focus:border-accent focus:outline-none"
              value={regionId()}
              disabled={busy()}
              onChange={(e) => setRegionId(e.currentTarget.value)}
            >
              <option value="">None</option>
              <For each={props.regions}>{(r) => <option value={r.id}>{r.name}</option>}</For>
            </select>
          </label>
        </Show>

        {/* Kind is its OWN control, not a third Schedule option (jt rsmpwtmw):
            a live cache has no cadence, so putting it in Schedule conflated
            "when do we re-bake" with "does this bake at all". */}
        <Show when={supportsLiveCache(props.providers, provider())}>
          <label class="block space-y-1">
            <span class="text-xs text-fg-2">Kind</span>
            <select
              class="w-full rounded border border-line px-2 py-1 focus:border-accent focus:outline-none"
              value={mode()}
              disabled={busy()}
              onChange={(e) => setMode(e.currentTarget.value as "bake" | "live-cache")}
            >
              <option value="bake">Baked — downloaded to this boat</option>
              <option value="live-cache">Live cache — fetched as you use it</option>
            </select>
          </label>
        </Show>
        {/* Schedule is about a BAKE, so it is hidden entirely when there is no
            bake to schedule — an offered-but-inert control reads as a bug. */}
        <Show when={mode() === "bake"}>
          <label class="block space-y-1">
            <span class="text-xs text-fg-2">Schedule</span>
            <select
              class="w-full rounded border border-line px-2 py-1 focus:border-accent focus:outline-none"
              value={schedule()}
              disabled={busy()}
              onChange={(e) => setSchedule(e.currentTarget.value as "manual" | "ttl")}
            >
              <option value="manual">Manual — bake only when you press Bake</option>
              <option value="ttl">Automatic (TTL)</option>
            </select>
          </label>
        </Show>
        <Show when={mode() === "live-cache"}>
          <p class="text-[11px] leading-snug text-fg-3">
            <Show
              when={provider() === "osm_world"}
              fallback={
                <>
                  Not a bake: this names the provider's one shared, always-on cache — it fills
                  lazily as views request data, and is never triggered by a schedule or a Bake
                  button.
                </>
              }
            >
              Not a bake: this names the boat's one shared live-tile fallback for zoom levels past
              whatever the baked world basemap covers — it fetches (and caches) an individual tile the
              first time a view pans there, never triggered by a schedule or a Bake button.
            </Show>
          </p>
        </Show>
        <Show when={mode() === "bake" && schedule() === "ttl"}>
          <label class="block space-y-1">
            <span class="text-xs text-fg-2">Re-bake every (hours)</span>
            {/* Fractions allowed: notices default to 0.5 h (30 min). */}
            <input
              type="number"
              min="0"
              step="any"
              class="w-full rounded border border-line px-2 py-1 focus:border-accent focus:outline-none"
              value={ttlHours()}
              disabled={busy()}
              onInput={(e) => setTtlHours(e.currentTarget.value)}
            />
          </label>
          <p class="text-[11px] leading-snug text-fg-3">
            The boat's server checks every few minutes and re-bakes once this many hours have passed
            since the last bake (`mivnav.data.scheduler`).
          </p>
        </Show>

        <Show
          when={ParamsForm()}
          fallback={<p class="text-xs text-fg-3">No additional options for this provider.</p>}
        >
          {(Comp) => (
            <Dynamic
              component={Comp()}
              provider={provider()}
              mode={mode()}
              implementation={implementation()}
              onImplementationChange={setImplementation}
              region={props.regions.find((r) => r.id === regionId())}
              value={params()}
              onChange={setParams}
              disabled={busy()}
            />
          )}
        </Show>

        <Show when={error()}>
          <p class="text-xs text-alarm">{error()}</p>
        </Show>

        <div class="flex gap-1">
          <Button variant="primary" disabled={busy()} onClick={() => void submit()}>
            {saving() ? "Saving…" : "Save"}
          </Button>
          <Button disabled={busy()} onClick={props.onCancel}>
            Cancel
          </Button>
        </div>
      </Show>
    </div>
  );
};

interface DatasetListProps {
  /** Per-provider params sub-form registry, assembled by
   * `featureDatasetParams` and threaded down via Sidebar.tsx. */
  paramsComponents: DatasetParamsRegistry;
  /** Fired after a successful Delete, the SAME callback `ChartLibrarySection`
   * drives. Not fired after Bake: that's async, and this list's own poll
   * shows it finish. */
  onCatalogChanged: () => void;
}

const POLL_MS = 1000;

/** Rows are keyed `provider:id`, not id alone — see
 * docs/architecture/dataset-list.md for why an orphan set's id can collide. */
function rowKey(ds: DatasetEntry): string {
  return `${ds.provider}:${ds.id}`;
}

/**
 * Every declared dataset (any provider), with create/edit/bake/delete —
 * mounted with the sidebar, like `ChartLibrarySection`: the list fetch and
 * the baking-poll start when a sailor opens this surface and stop when they
 * leave it. A bake outlives that — it runs on the server, and its status
 * comes back in the next `GET /datasets`.
 */
const DatasetListSection: Component<DatasetListProps> = (props) => {
  const [datasets, setDatasets] = createSignal<DatasetEntry[]>([]);
  // Empty until the first `refresh()` settles; `+ Add dataset` stays hidden
  // until then so the form never mounts with no valid provider default.
  const [providers, setProviders] = createSignal<ProviderCatalogEntry[]>([]);
  const [regions, setRegions] = createSignal<Region[]>([]);
  const [listError, setListError] = createSignal("");
  const [loading, setLoading] = createSignal(true);
  const [busyId, setBusyId] = createSignal("");
  const [confirmDelete, setConfirmDelete] = createSignal("");
  // `""` for a fresh draft, `null` for none — `""` never collides with a
  // real `rowKey` (always has a `:`).
  const [editing, setEditing] = createSignal<string | null>(null);
  const [actionError, setActionError] = createSignal("");

  const refresh = async () => {
    setListError("");
    try {
      const body = await fetchJsonDefault<DatasetsResponse>("/api/datasets");
      setDatasets(body.datasets);
      setProviders(body.providers);
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };
  // Fetched once — regions are owned by the "Regions" section now, so a
  // rename elsewhere in the sidebar does not live-refresh this.
  const refreshRegions = async () => {
    try {
      const body = await fetchJsonDefault<ConfigRegionsResponse>("/api/config");
      setRegions(body.config.regions);
    } catch {
      /* regions stay empty; the form's select just shows none */
    }
  };
  const regionName = (id: string | null): string | null =>
    id === null ? null : (regions().find((r) => r.id === id)?.name ?? id);
  void refresh();
  void refreshRegions();

  // Poll while anything is baking (ChartLibrarySection's install-poll idiom,
  // generalised to any row).
  const timer = setInterval(() => {
    if (datasets().some((d) => d.status === "baking")) void refresh();
  }, POLL_MS);
  onCleanup(() => clearInterval(timer));

  const ingest = async (ds: DatasetEntry) => {
    const key = rowKey(ds);
    setBusyId(key);
    setActionError("");
    try {
      await fetchJsonDefault(`/api/datasets/${encodeURIComponent(ds.id)}/ingest`, {
        method: "POST",
      });
      await refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId("");
    }
  };

  /** Stops a running bake rather than killing the whole service (which can
   * wedge on a held-open subprocess). Status settles to "error" on the next poll. */
  const cancel = async (id: string) => {
    setBusyId(id);
    setActionError("");
    try {
      await fetchJsonDefault(`/api/datasets/${encodeURIComponent(id)}/ingest/cancel`, {
        method: "POST",
      });
      await refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId("");
    }
  };

  /** `POST /datasets/{id}/enable`/`/disable` (jt lvpkxtsr) — pause a
   * dataset without deleting it: the config entry and baked files both
   * survive, only serving/scheduled rebakes stop. Re-enabling never bakes
   * anything on its own. */
  const toggleEnabled = async (ds: DatasetEntry) => {
    setBusyId(ds.id);
    setActionError("");
    try {
      await fetchJsonDefault(
        `/api/datasets/${encodeURIComponent(ds.id)}/${ds.enabled ? "disable" : "enable"}`,
        { method: "POST" },
      );
      await refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId("");
    }
  };

  const remove = async (ds: DatasetEntry) => {
    const key = rowKey(ds);
    setBusyId(key);
    setActionError("");
    try {
      // `provider` disambiguates an id an orphan set shares with a declared
      // dataset under a different provider — always sent, harmless otherwise.
      await fetchJsonDefault(
        `/api/datasets/${encodeURIComponent(ds.id)}?provider=${encodeURIComponent(ds.provider)}`,
        { method: "DELETE" },
      );
      setConfirmDelete("");
      await refresh();
      props.onCatalogChanged();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId("");
    }
  };

  const save = async (id: string, body: DatasetPutBody) => {
    await fetchJsonDefault(`/api/datasets/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setEditing(null);
    await refresh();
  };

  /** The raw calls behind a grouped card — they throw rather than set
   * `actionError`, so the card reports errors on itself and refreshes once
   * after a batch instead of after every dataset. */
  const groupActions: DatasetActions = {
    bake: async (id) => {
      await fetchJsonDefault(`/api/datasets/${encodeURIComponent(id)}/ingest`, { method: "POST" });
    },
    cancel: async (id) => {
      await fetchJsonDefault(`/api/datasets/${encodeURIComponent(id)}/ingest/cancel`, {
        method: "POST",
      });
    },
    setEnabled: async (id, enabled) => {
      await fetchJsonDefault(
        `/api/datasets/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`,
        { method: "POST" },
      );
    },
    remove: async (ds) => {
      await fetchJsonDefault(
        `/api/datasets/${encodeURIComponent(ds.id)}?provider=${encodeURIComponent(ds.provider)}`,
        { method: "DELETE" },
      );
      props.onCatalogChanged();
    },
    put: async (id, body) => {
      await fetchJsonDefault(`/api/datasets/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    refresh,
  };
  const grouped = () => groupDatasets(datasets(), providers());

  const rowActions = (ds: DatasetEntry): JSX.Element => {
    const key = rowKey(ds);
    return (
      <Show
        when={confirmDelete() === key}
        fallback={
          <span class="flex flex-wrap gap-1">
            <Show when={canBakeDataset(providers(), ds)}>
              {/* A "live-cache" or DISABLED dataset has no bake step
                  (backend 409s) — hide Bake for either, keep Edit. */}
              <Show when={ds.mode === "bake" && ds.enabled}>
                <Show
                  when={ds.status === "baking"}
                  fallback={
                    <Button
                      variant="secondary"
                      class="font-medium"
                      disabled={busyId() === key}
                      onClick={() => void ingest(ds)}
                    >
                      {ds.status === "baked" ? "Re-bake" : "Bake"}
                    </Button>
                  }
                >
                  <Button variant="secondary" class="font-medium" disabled>
                    Baking…
                  </Button>
                  <Button
                    variant="tinted"
                    tone="alarm"
                    disabled={busyId() === key}
                    onClick={() => void cancel(ds.id)}
                  >
                    Cancel
                  </Button>
                </Show>
              </Show>
            </Show>
            <Show when={hasGenericBakePath(providers(), ds.provider)}>
              <Button disabled={busyId() === key} onClick={() => setEditing(key)}>
                {ds.declared ? "Edit" : "Adopt…"}
              </Button>
            </Show>
            {/* Gated on `declared` like Bake: an orphan has no Config.datasets
                entry for `POST .../enable` to resolve, so it would 404. */}
            <Show when={ds.declared}>
              <Button disabled={busyId() === key} onClick={() => void toggleEnabled(ds)}>
                {ds.enabled ? "Disable" : "Enable"}
              </Button>
            </Show>
            <Button
              variant="tinted"
              tone="alarm"
              class="font-medium"
              disabled={busyId() === key}
              onClick={() => setConfirmDelete(key)}
            >
              Delete
            </Button>
          </span>
        }
      >
        <span class="flex shrink-0 items-center gap-1">
          <span class="text-xs text-fg-2">Delete {ds.name}?</span>
          <Button variant="danger" disabled={busyId() === key} onClick={() => void remove(ds)}>
            Really delete
          </Button>
          <Button disabled={busyId() === key} onClick={() => setConfirmDelete("")}>
            Keep
          </Button>
        </span>
      </Show>
    );
  };

  return (
    <AccordionSection value="datasets" title="Datasets" icon={Database}>
      <Show
        when={!listError()}
        fallback={
          <div class="space-y-1 pb-2">
            <p class="text-xs text-notice">
              The boat's server did not answer for the dataset list. Datasets cannot be shown right
              now.
            </p>
            <p class="break-all text-xs text-fg-2">{listError()}</p>
            <Button disabled={loading()} onClick={() => void refresh()}>
              Retry
            </Button>
          </div>
        }
      >
        <section class="space-y-2">
          <p class="text-xs text-fg-2">
            Everything the boat keeps for offline use — POI, satellite imagery, notices to mariners,
            the world basemap and more. Chart sets are listed too but managed under Charts. Older sets
            marked "not declared" can still be deleted, or adopted to re-bake them.
          </p>

          <Show
            when={datasets().length > 0}
            fallback={
              <p class="text-fg-2">{loading() ? "Loading…" : "No datasets declared yet."}</p>
            }
          >
            <ul class="space-y-1">
              {/* One card per region-based provider (POI, satellite): its
                  datasets as a regions × sources grid — see
                  ./datasetGroups.ts. Everything else keeps a plain row. */}
              <For each={grouped().groups}>
                {(group) => (
                  <DatasetGroupCard
                    group={group}
                    regions={regions()}
                    providers={providers()}
                    existingIds={datasets().map((d) => d.id)}
                    paramsComponents={props.paramsComponents}
                    actions={groupActions}
                  />
                )}
              </For>
              <For each={grouped().rest}>
                {(ds) => (
                  <li class="space-y-1 rounded border border-line-2 p-2">
                    <Show
                      when={editing() !== rowKey(ds)}
                      fallback={
                        <DatasetEditForm
                          dataset={ds}
                          regions={regions()}
                          providers={providers()}
                          existingIds={datasets().map((d) => d.id)}
                          paramsComponents={props.paramsComponents}
                          busy={busyId() === rowKey(ds)}
                          onCancel={() => setEditing(null)}
                          onSave={save}
                        />
                      }
                    >
                      <div class="flex items-center justify-between gap-2">
                        <div class="min-w-0">
                          <div class="flex items-center gap-1.5">
                            <span class="truncate font-medium">{ds.name}</span>
                            {/* A disabled dataset keeps its config entry and
                                baked files — this badge is the only visual
                                difference; status below stays real. */}
                            <Show when={!ds.enabled}>
                              <span class="shrink-0 rounded bg-chrome-2 px-1 py-0.5 text-[10px] leading-none text-fg-3">
                                Disabled
                              </span>
                            </Show>
                          </div>
                          <div class="text-xs text-fg-2">
                            {datasetLabel(providers(), ds.provider, ds.implementation)}
                            {ds.region_id && ` · ${regionName(ds.region_id)}`} · {formatBytes(ds.size)}
                            <Show when={ds.last_bake_at}>
                              {(iso) => ` · Updated ${timeAgo(iso())}`}
                            </Show>
                          </div>
                          <Show when={!ds.declared}>
                            <p class="text-xs text-notice">
                              Not declared — baked before this list existed. Adopt to give it a
                              region/schedule and re-bake it, or Delete to remove it.
                            </p>
                          </Show>
                        </div>
                        <span class={`shrink-0 text-xs ${statusTone(ds)}`}>
                          {statusLabel(ds)}
                        </span>
                      </div>
                      <Show when={ds.progress}>
                        {(progress) => (
                          <Switch>
                            <Match when={progressView(ds.status, progress()) === "done"}>
                              <Show when={progress().log.length > 0}>
                                <details class="text-[11px] text-fg-3">
                                  <summary class="cursor-pointer select-none">
                                    Last bake log
                                  </summary>
                                  <div class="mt-1">
                                    <BakeLog log={progress().log} />
                                  </div>
                                </details>
                              </Show>
                            </Match>
                            <Match when={true}>
                              <DatasetProgressPanel
                                progress={progress()}
                                live={progressView(ds.status, progress()) === "live"}
                              />
                            </Match>
                          </Switch>
                        )}
                      </Show>
                      {rowActions(ds)}
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>

          {/* Gated on the provider catalog (not just `datasets`) having
              loaded — before then a fresh draft would default to an empty provider. */}
          <Show when={creatableProviders(providers()).length > 0}>
            <Show
              when={editing() === ""}
              fallback={
                <Button variant="primary" class="font-medium" onClick={() => setEditing("")}>
                  + Add dataset
                </Button>
              }
            >
              <DatasetEditForm
                regions={regions()}
                providers={providers()}
                existingIds={datasets().map((d) => d.id)}
                paramsComponents={props.paramsComponents}
                busy={false}
                onCancel={() => setEditing(null)}
                onSave={save}
                groups={grouped().groups}
                actions={groupActions}
              />
            </Show>
          </Show>

          <Show when={actionError()}>
            <p class="text-xs text-alarm">{actionError()}</p>
          </Show>
        </section>
      </Show>
    </AccordionSection>
  );
};

export default DatasetListSection;
