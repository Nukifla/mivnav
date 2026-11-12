// One card per region-based provider (POI, satellite) in the Datasets
// section: its datasets as a compact regions × sources grid, with one editor
// for the whole grid. Behind it every cell is still its own dataset (own
// region, own directory) — see ./datasetGroups.ts for why and for the pure
// grouping/save planning this renders.

import { createSignal, For, Index, Match, Show, Switch, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { Button } from "../ui/Button";
import {
  BakeLog,
  DatasetProgressPanel,
  dedupeDatasetId,
  formatBytes,
  progressPercent,
  progressView,
  providerLabel,
  slugifyDatasetName,
  STATUS_LABEL,
  STATUS_TONE,
  timeAgo,
  type DatasetEntry,
  type DatasetPutBody,
  type ProviderCatalogEntry,
} from "./DatasetList";
import type { DatasetParamsRegistry } from "./datasetParams";
import {
  cellDataset,
  groupStatus,
  planGroupSave,
  sharedSchedule,
  variantKey,
  variantLabel,
  type DatasetGroup,
  type GroupSavePlan,
  type GroupVariant,
} from "./datasetGroups";
import type { Region } from "./regions";

/** What the card needs from `DatasetListSection` — the same calls its plain
 * rows make, one dataset at a time. */
export interface DatasetActions {
  bake: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  remove: (ds: DatasetEntry) => Promise<void>;
  put: (id: string, body: DatasetPutBody) => Promise<void>;
  /** Re-read the list once a batch of calls is done. */
  refresh: () => Promise<void>;
}

interface CommonProps {
  regions: readonly Region[];
  providers: readonly ProviderCatalogEntry[];
  existingIds: readonly string[];
  paramsComponents: DatasetParamsRegistry;
  actions: DatasetActions;
}

/** A grid cell's short status: size when baked, percent while baking. */
function cellText(ds: DatasetEntry): string {
  if (ds.status === "baking") {
    const p = ds.progress;
    const pct = p ? progressPercent(p.current, p.total) : null;
    return pct === null ? "Baking…" : `Baking ${Math.round(pct)}%`;
  }
  if (ds.status === "baked") return formatBytes(ds.size);
  return STATUS_LABEL[ds.status];
}

export const DatasetGroupCard: Component<CommonProps & { group: DatasetGroup }> = (props) => {
  const [editing, setEditing] = createSignal(false);
  const [selected, setSelected] = createSignal<string | null>(null);
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  const datasets = () => props.group.datasets;
  const status = () => groupStatus(props.group);
  const size = () => datasets().reduce((n, d) => n + d.size, 0);
  const lastBake = () =>
    datasets()
      .map((d) => d.last_bake_at)
      .filter((x): x is string => !!x)
      .sort()
      .at(-1);
  const anyEnabled = () => datasets().some((d) => d.enabled);
  const regionName = (id: string) => props.regions.find((r) => r.id === id)?.name ?? id;
  const label = (v: GroupVariant) =>
    variantLabel(props.providers, props.group.provider, v, props.group.variants);
  const selectedDs = () => datasets().find((d) => d.id === selected());
  // Running/failed bakes keep their full panel in view (same rule as a
  // plain row, see `progressView`); finished ones stay out of the way.
  const attention = () =>
    datasets().filter((d) => {
      const v = progressView(d.status, d.progress);
      return v === "live" || v === "failed";
    });

  /** Run `fn` over each dataset, collect the first error, refresh once. */
  const each = async (list: DatasetEntry[], fn: (ds: DatasetEntry) => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      for (const ds of list) {
        try {
          await fn(ds);
        } catch (e) {
          if (!error()) setError(e instanceof Error ? e.message : String(e));
        }
      }
      await props.actions.refresh();
    } finally {
      setBusy(false);
    }
  };

  const bakeable = () => datasets().filter((d) => d.enabled && d.status !== "baking");

  return (
    <li class="space-y-1.5 rounded border border-line-2 p-2">
      <Show
        when={!editing()}
        fallback={
          <DatasetGroupEditForm
            {...props}
            onDone={() => setEditing(false)}
          />
        }
      >
        <div class="flex items-center justify-between gap-2">
          <div class="min-w-0">
            <div class="flex items-center gap-1.5">
              <span class="truncate font-medium">
                {providerLabel(props.providers, props.group.provider)}
              </span>
              <Show when={!anyEnabled()}>
                <span class="shrink-0 rounded bg-chrome-2 px-1 py-0.5 text-[10px] leading-none text-fg-3">
                  Disabled
                </span>
              </Show>
            </div>
            <div class="text-xs text-fg-2">
              {props.group.regionIds.length}{" "}
              {props.group.regionIds.length === 1 ? "region" : "regions"} ·{" "}
              {formatBytes(size())}
              <Show when={lastBake()}>{(iso) => ` · Updated ${timeAgo(iso())}`}</Show>
            </div>
          </div>
          <span class={`shrink-0 text-xs ${STATUS_TONE[status()]}`}>{STATUS_LABEL[status()]}</span>
        </div>

        {/* Regions down, sources across. A cell is one dataset; tapping it
            selects it for its own Re-bake / log below. */}
        <table class="w-full table-fixed text-xs">
          <thead>
              <tr class="text-left text-[11px] text-fg-3">
                <th class="font-normal" />
                <For each={props.group.variants}>
                  {(v) => <th class="truncate px-1 font-normal">{label(v)}</th>}
                </For>
              </tr>
            </thead>
          <tbody>
            <For each={props.group.regionIds}>
              {(regionId) => (
                <tr>
                  <td class="truncate py-0.5 pr-1 text-fg-2">{regionName(regionId)}</td>
                  <For each={props.group.variants}>
                    {(v) => {
                      const ds = () => cellDataset(props.group, v, regionId);
                      return (
                        <td class="px-0.5 py-0.5">
                          <Show when={ds()} fallback={<span class="px-1 text-fg-3">–</span>}>
                            {(d) => (
                              <button
                                type="button"
                                title={d().name}
                                class={`w-full truncate rounded px-1 py-0.5 text-left tabular-nums hover:bg-chrome-2 ${
                                  d().enabled ? STATUS_TONE[d().status] : "text-fg-3"
                                }`}
                                classList={{ "bg-chrome-2 ring-1 ring-line": selected() === d().id }}
                                onClick={() => setSelected(selected() === d().id ? null : d().id)}
                              >
                                {cellText(d())}
                              </button>
                            )}
                          </Show>
                        </td>
                      );
                    }}
                  </For>
                </tr>
              )}
            </For>
          </tbody>
        </table>

        <Show when={selectedDs()}>
          {(d) => (
            <div class="space-y-1 rounded border border-line-2 bg-chrome-2/40 p-1.5">
              <div class="flex flex-wrap items-center gap-1">
                <span class="mr-auto truncate text-xs text-fg-2">
                  {d().name} · {formatBytes(d().size)}
                  <Show when={d().last_bake_at}>{(iso) => ` · ${timeAgo(iso())}`}</Show>
                </span>
                <Show
                  when={d().status === "baking"}
                  fallback={
                    <Show when={d().enabled}>
                      <Button
                        variant="secondary"
                        disabled={busy()}
                        onClick={() => void each([d()], (x) => props.actions.bake(x.id))}
                      >
                        {d().status === "baked" ? "Re-bake" : "Bake"}
                      </Button>
                    </Show>
                  }
                >
                  <Button
                    variant="tinted"
                    tone="alarm"
                    disabled={busy()}
                    onClick={() => void each([d()], (x) => props.actions.cancel(x.id))}
                  >
                    Cancel bake
                  </Button>
                </Show>
              </div>
              <Show when={d().progress?.log.length}>
                <BakeLog log={d().progress?.log ?? []} />
              </Show>
            </div>
          )}
        </Show>

        <For each={attention().filter((d) => d.id !== selected())}>
          {(d) => (
            <div class="space-y-0.5">
              <div class="text-[11px] text-fg-3">{d.name}</div>
              <DatasetProgressPanel
                progress={d.progress!}
                live={progressView(d.status, d.progress) === "live"}
              />
            </div>
          )}
        </For>

        <Show when={error()}>
          <p class="text-xs text-alarm">{error()}</p>
        </Show>

        <Show
          when={!confirmDelete()}
          fallback={
            <span class="flex flex-wrap items-center gap-1">
              <span class="text-xs text-fg-2">
                Delete all {datasets().length} ({formatBytes(size())})?
              </span>
              <Button
                variant="danger"
                disabled={busy()}
                onClick={() =>
                  void each(datasets(), props.actions.remove).then(() => setConfirmDelete(false))
                }
              >
                Really delete
              </Button>
              <Button disabled={busy()} onClick={() => setConfirmDelete(false)}>
                Keep
              </Button>
            </span>
          }
        >
          <span class="flex flex-wrap gap-1">
            <Show when={anyEnabled()}>
              <Show
                when={status() !== "baking"}
                fallback={
                  <Button
                    variant="tinted"
                    tone="alarm"
                    disabled={busy()}
                    onClick={() =>
                      void each(
                        datasets().filter((d) => d.status === "baking"),
                        (x) => props.actions.cancel(x.id),
                      )
                    }
                  >
                    Cancel bakes
                  </Button>
                }
              >
                <Button
                  variant="secondary"
                  class="font-medium"
                  disabled={busy() || bakeable().length === 0}
                  onClick={() => void each(bakeable(), (x) => props.actions.bake(x.id))}
                >
                  {status() === "unbaked" ? "Bake all" : "Re-bake all"}
                </Button>
              </Show>
            </Show>
            <Button disabled={busy()} onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button
              disabled={busy()}
              onClick={() =>
                void each(
                  datasets().filter((d) => d.enabled === anyEnabled()),
                  (d) => props.actions.setEnabled(d.id, !anyEnabled()),
                )
              }
            >
              {anyEnabled() ? "Disable" : "Enable"}
            </Button>
            <Button
              variant="tinted"
              tone="alarm"
              class="font-medium"
              disabled={busy()}
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </Button>
          </span>
        </Show>
      </Show>
    </li>
  );
};

/**
 * Edit a whole card — or, with no `group`, create one for `provider`: which
 * regions, which sources (each with its provider's own params sub-form),
 * one schedule for all. Save plans the per-dataset PUT/DELETEs; a removed
 * region or source deletes only its own datasets, after a confirm naming
 * them. New cells are baked straight away.
 */
export const DatasetGroupEditForm: Component<
  CommonProps & { group?: DatasetGroup; provider?: string; onDone: () => void }
> = (props) => {
  const provider = () => props.group?.provider ?? props.provider ?? "";
  const catalog = () => props.providers.find((p) => p.id === provider());

  const [regionIds, setRegionIds] = createSignal<string[]>([...(props.group?.regionIds ?? [])]);
  const [variants, setVariants] = createSignal<GroupVariant[]>(
    props.group?.variants.map((v) => ({ ...v, ids: [...v.ids] })) ?? [
      { implementation: null, params: {}, ids: [] },
    ],
  );
  // A card whose datasets disagree starts on "keep each" — prefilling the
  // first one's schedule would silently overwrite the others' on Save.
  const shared = props.group ? sharedSchedule(props.group) : null;
  const [schedule, setSchedule] = createSignal<"manual" | "ttl" | "keep">(
    props.group
      ? (shared?.schedule ?? "keep")
      : (catalog()?.schedule ?? "manual"),
  );
  const initialTtl = props.group ? (shared?.ttl_s ?? null) : (catalog()?.ttl_s ?? null);
  const [ttlHours, setTtlHours] = createSignal(initialTtl ? String(initialTtl / 3600) : "");
  const [pending, setPending] = createSignal<GroupSavePlan | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");

  const ParamsForm = () => props.paramsComponents[provider()];

  const toggleRegion = (id: string, on: boolean) =>
    setRegionIds((ids) => (on ? [...ids, id] : ids.filter((x) => x !== id)));
  const updateVariant = (i: number, patch: Partial<GroupVariant>) =>
    setVariants((vs) => vs.map((v, j) => (j === i ? { ...v, ...patch } : v)));

  const plan = (): GroupSavePlan | null => {
    setError("");
    if (regionIds().length === 0) {
      setError("Pick at least one region (or Delete the whole card instead).");
      return null;
    }
    if (variants().length === 0) {
      setError("Keep at least one source (or Delete the whole card instead).");
      return null;
    }
    const keys = variants().map((v) => variantKey(catalog(), v.implementation, v.params));
    if (new Set(keys).size !== keys.length) {
      setError("Two sources are identical — remove one, or change its options.");
      return null;
    }
    let ttl: number | null = null;
    // An existing card already on "Automatic" with no interval (a state the
    // backend allows) saves as-is; only a NEW choice of Automatic needs one.
    const keepsUnsetTtl =
      shared?.schedule === "ttl" && initialTtl === null && ttlHours().trim() === "";
    if (schedule() === "ttl" && !keepsUnsetTtl) {
      const hours = Number(ttlHours());
      if (!(hours > 0)) {
        setError("Give a re-bake interval (in hours) for an automatic schedule.");
        return null;
      }
      ttl = hours * 3600;
    }
    return planGroupSave(
      props.group,
      {
        provider: provider(),
        regionIds: regionIds(),
        variants: variants(),
        schedule: schedule(),
        ttl_s: ttl,
      },
      props.regions,
      props.providers,
      props.existingIds,
      (name, taken) => dedupeDatasetId(slugifyDatasetName(name), taken),
    );
  };

  const apply = async (p: GroupSavePlan) => {
    setSaving(true);
    setError("");
    try {
      for (const put of p.puts) await props.actions.put(put.id, put.body);
      for (const ds of p.deletes) await props.actions.remove(ds);
      await props.actions.refresh();
      for (const put of p.puts.filter((x) => x.isNew)) {
        await props.actions.bake(put.id).catch(() => {
            /* shows as "Not baked" on the card; Bake from there */
          });
      }
      await props.actions.refresh();
      props.onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await props.actions.refresh();
    } finally {
      setSaving(false);
      setPending(null);
    }
  };

  const save = () => {
    const p = plan();
    if (!p) return;
    // Anything that downloads or deletes data is shown before it happens;
    // a schedule/option change on existing cells just saves.
    if (p.deletes.length > 0 || p.puts.some((x) => x.isNew)) setPending(p);
    else void apply(p);
  };

  const busy = () => saving();

  return (
    <div class="space-y-2">
      <p class="text-xs font-medium">{providerLabel(props.providers, provider())}</p>

      <div class="space-y-1">
        <span class="block text-xs text-fg-2">Regions</span>
        <Show
          when={props.regions.length > 0}
          fallback={<p class="text-xs text-fg-3">No regions yet — add one under Regions.</p>}
        >
          <div class="grid grid-cols-2 gap-x-2 gap-y-0.5">
            <For each={props.regions}>
              {(r) => (
                <label class="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={regionIds().includes(r.id)}
                    disabled={busy()}
                    onChange={(e) => toggleRegion(r.id, e.currentTarget.checked)}
                  />
                  <span class="truncate">{r.name}</span>
                </label>
              )}
            </For>
          </div>
        </Show>
      </div>

      <div class="space-y-1">
        <span class="block text-xs text-fg-2">Sources</span>
        <Index each={variants()}>
          {(v, i) => (
            <div class="space-y-1 rounded border border-line-2 p-1.5">
              <Show
                when={ParamsForm()}
                fallback={<p class="text-xs text-fg-3">No options for this provider.</p>}
              >
                {(Comp) => (
                  <Dynamic
                    component={Comp()}
                    provider={provider()}
                    mode="bake"
                    implementation={v().implementation}
                    onImplementationChange={(impl: string | null) =>
                      updateVariant(i, { implementation: impl })
                    }
                    region={props.regions.find((r) => r.id === regionIds()[0])}
                    value={v().params}
                    onChange={(params: Record<string, unknown>) => updateVariant(i, { params })}
                    disabled={busy()}
                  />
                )}
              </Show>
              <Show when={variants().length > 1}>
                <Button
                  disabled={busy()}
                  onClick={() => setVariants((vs) => vs.filter((_, j) => j !== i))}
                >
                  Remove source
                </Button>
              </Show>
            </div>
          )}
        </Index>
        <Button
          disabled={busy()}
          onClick={() =>
            setVariants((vs) => [...vs, { implementation: null, params: {}, ids: [] }])
          }
        >
          + Add source
        </Button>
      </div>

      <label class="block space-y-1">
        <span class="text-xs text-fg-2">Schedule</span>
        <select
          class="w-full rounded border border-line px-2 py-1 focus:border-accent focus:outline-none"
          value={schedule()}
          disabled={busy()}
          onChange={(e) => setSchedule(e.currentTarget.value as "manual" | "ttl" | "keep")}
        >
          <Show when={props.group && !shared}>
            <option value="keep">Mixed — keep each dataset's own</option>
          </Show>
          <option value="manual">Manual — bake only when you press Bake</option>
          <option value="ttl">Automatic (TTL)</option>
        </select>
      </label>
      <Show when={schedule() === "ttl"}>
        <label class="block space-y-1">
          <span class="text-xs text-fg-2">Re-bake every (hours)</span>
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
      </Show>

      <Show when={error()}>
        <p class="text-xs text-alarm">{error()}</p>
      </Show>

      <Switch>
        <Match when={pending()}>
          {(p) => {
            const added = () => p().puts.filter((x) => x.isNew);
            return (
              <div
                class="space-y-1 rounded border p-1.5"
                classList={{
                  "border-alarm/40": p().deletes.length > 0,
                  "border-line-2": p().deletes.length === 0,
                }}
              >
                <Show when={added().length > 0}>
                  <p class="text-xs text-fg-2">Adds and bakes now:</p>
                  <ul class="text-xs text-fg-2">
                    <For each={added()}>{(x) => <li>· {x.body.name}</li>}</For>
                  </ul>
                </Show>
                <Show when={p().deletes.length > 0}>
                  <p class="text-xs text-fg-2">
                    Deletes the baked data of (the rest is kept):
                  </p>
                  <ul class="text-xs text-fg-2">
                    <For each={p().deletes}>
                      {(d) => (
                        <li>
                          · {d.name} ({formatBytes(d.size)})
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
                <div class="flex gap-1">
                  <Button
                    variant={p().deletes.length > 0 ? "danger" : "primary"}
                    disabled={busy()}
                    onClick={() => void apply(p())}
                  >
                    {saving() ? "Saving…" : p().deletes.length > 0 ? "Delete and save" : "Save"}
                  </Button>
                  <Button disabled={busy()} onClick={() => setPending(null)}>
                    Back
                  </Button>
                </div>
              </div>
            );
          }}
        </Match>
        <Match when={true}>
          <div class="flex gap-1">
            <Button variant="primary" disabled={busy()} onClick={save}>
              {saving() ? "Saving…" : "Save"}
            </Button>
            <Button disabled={busy()} onClick={props.onDone}>
              Cancel
            </Button>
          </div>
        </Match>
      </Switch>
    </div>
  );
};
