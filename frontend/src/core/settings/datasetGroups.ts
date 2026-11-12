// Pure half of the grouped dataset cards (DatasetGroupCard.tsx).
//
// The backend stays one-dataset-per-(region, source): a dataset has ONE
// `region_id` and one `implementation`/`params`, and bakes into its own
// directory, so deleting one deletes exactly that region's data. Grouping is
// a UI concern only (user, 2026-11-05: "keep it like it is now in the
// backend and just change the ui … behind the scene it can be a lot of
// different datasets"). One card per region-based provider (POI, satellite)
// shows its datasets as a regions × sources grid; editing the card plans
// the PUTs/DELETEs that turn the old grid into the new one.

import type { DatasetEntry, DatasetPutBody, ProviderCatalogEntry } from "./DatasetList";
import type { Region } from "./regions";

/** One source column of a group: an implementation + its params (POI: OSM,
 * or a plugin source with its own toggles; satellite: one imagery source).
 * `ids` are the datasets that already exist for it (one per region), so an
 * edited variant updates them in place rather than re-creating them. */
export interface GroupVariant {
  implementation: string | null;
  params: Record<string, unknown>;
  ids: string[];
}

export interface DatasetGroup {
  provider: string;
  datasets: DatasetEntry[];
  /** Region ids in first-seen order. */
  regionIds: string[];
  variants: GroupVariant[];
}

/** Which providers get a grouped card: creatable, baked per region. Notices
 * (its own region list in params), weather/osm_world (no region) and
 * o-charts (own UI) keep their plain rows. */
export function isGroupedProvider(p: ProviderCatalogEntry | undefined): boolean {
  return !!p && p.creatable && (p.region_kind === "bbox" || p.region_kind === "country");
}

/** Whether a dataset joins its provider's card: a declared bake with a
 * region. An orphan set (no config entry) or a region-less one keeps its own
 * row with the Adopt/Edit flow it needs. */
function groupable(ds: DatasetEntry): boolean {
  return ds.declared && ds.mode === "bake" && ds.region_id !== null;
}

/** JSON with sorted keys, so `{a,b}` and `{b,a}` are one variant. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export function resolvedImplementation(
  provider: ProviderCatalogEntry | undefined,
  implementation: string | null,
): string | null {
  return implementation || provider?.default_implementation || null;
}

export function variantKey(
  provider: ProviderCatalogEntry | undefined,
  implementation: string | null,
  params: Record<string, unknown>,
): string {
  return `${resolvedImplementation(provider, implementation) ?? ""}|${stableJson(params)}`;
}

/** Split the list into one group per grouped provider (in first-seen order)
 * and the rows that stay plain. */
export function groupDatasets(
  datasets: readonly DatasetEntry[],
  providers: readonly ProviderCatalogEntry[],
): { groups: DatasetGroup[]; rest: DatasetEntry[] } {
  const groups = new Map<string, DatasetGroup>();
  const rest: DatasetEntry[] = [];
  for (const ds of datasets) {
    const p = providers.find((e) => e.id === ds.provider);
    if (!isGroupedProvider(p) || !groupable(ds)) {
      rest.push(ds);
      continue;
    }
    let g = groups.get(ds.provider);
    if (!g) {
      g = { provider: ds.provider, datasets: [], regionIds: [], variants: [] };
      groups.set(ds.provider, g);
    }
    g.datasets.push(ds);
    if (ds.region_id && !g.regionIds.includes(ds.region_id)) g.regionIds.push(ds.region_id);
    const key = variantKey(p, ds.implementation, ds.params);
    let v = g.variants.find((x) => variantKey(p, x.implementation, x.params) === key);
    if (!v) {
      v = { implementation: ds.implementation, params: ds.params, ids: [] };
      g.variants.push(v);
    }
    v.ids.push(ds.id);
  }
  return { groups: [...groups.values()], rest };
}

/** The dataset at one grid cell, if any. */
export function cellDataset(
  group: DatasetGroup,
  variant: GroupVariant,
  regionId: string,
): DatasetEntry | undefined {
  return group.datasets.find((d) => variant.ids.includes(d.id) && d.region_id === regionId);
}

/** A variant's short column label: the per-implementation label ("POI
 * (Acme)"), plus its string params when two columns would otherwise read the
 * same (two satellite imagery sources). */
export function variantLabel(
  providers: readonly ProviderCatalogEntry[],
  provider: string,
  variant: Pick<GroupVariant, "implementation" | "params">,
  siblings: readonly Pick<GroupVariant, "implementation" | "params">[] = [],
): string {
  const p = providers.find((e) => e.id === provider);
  const impl = resolvedImplementation(p, variant.implementation);
  const base = (impl && p?.implementation_labels?.[impl]) || p?.label || provider;
  const sameBase = siblings.filter(
    (s) => resolvedImplementation(p, s.implementation) === impl,
  ).length;
  const always = provider === "satellite";
  if (sameBase <= 1 && !always) return base;
  const extra = Object.values(variant.params).filter((v) => typeof v === "string" && v);
  if (!extra.length) return base;
  // The card's title already names the provider; a column of a provider
  // with no per-implementation label is just its distinguishing params.
  return base === p?.label ? extra.join(", ") : `${base} · ${extra.join(", ")}`;
}

/** The overall state a card's header shows: any bake running wins, then any
 * failure, then "baked" only when every cell is. */
export function groupStatus(group: DatasetGroup): DatasetEntry["status"] {
  const s = group.datasets.map((d) => d.status);
  if (s.includes("baking")) return "baking";
  if (s.includes("error")) return "error";
  if (s.length > 0 && s.every((x) => x === "baked")) return "baked";
  return "unbaked";
}

export interface GroupDraft {
  provider: string;
  regionIds: string[];
  variants: GroupVariant[];
  /** `"keep"`: each existing dataset keeps its own schedule (the card's
   * datasets disagree and the sailor didn't pick one for all); a new cell
   * copies a sibling of the same source, else any dataset of the card. */
  schedule: "manual" | "ttl" | "keep";
  ttl_s: number | null;
}

/** The one schedule every dataset of a card shares, or `null` if they
 * differ (the editor then offers "keep each" rather than flattening them). */
export function sharedSchedule(
  group: DatasetGroup,
): { schedule: "manual" | "ttl"; ttl_s: number | null } | null {
  const [first, ...rest] = group.datasets;
  if (!first) return null;
  const same = rest.every(
    (d) => d.schedule === first.schedule && (d.ttl_s ?? null) === (first.ttl_s ?? null),
  );
  return same ? { schedule: first.schedule, ttl_s: first.ttl_s ?? null } : null;
}

export interface GroupSavePlan {
  /** Every dataset to `PUT`: an existing cell whose declaration changed, or
   * a new one (`isNew` — baked right after saving). */
  puts: { id: string; body: DatasetPutBody; isNew: boolean }[];
  /** Existing datasets the new grid no longer has a cell for — their region
   * or source was removed. Deleting one removes only its own data. */
  deletes: DatasetEntry[];
}

/**
 * Turn a group (or nothing, for a new card) plus the edited draft into the
 * calls that realise it. A cell that already exists keeps its id and baked
 * data (updated in place: same region, same variant); a new cell gets a
 * fresh id derived from `name`; a cell no longer wanted is deleted.
 */
export function planGroupSave(
  group: DatasetGroup | undefined,
  draft: GroupDraft,
  regions: readonly Region[],
  providers: readonly ProviderCatalogEntry[],
  existingIds: readonly string[],
  makeId: (name: string, taken: readonly string[]) => string,
): GroupSavePlan {
  const datasets = group?.datasets ?? [];
  const taken = [...existingIds];
  const kept = new Set<string>();
  const puts: GroupSavePlan["puts"] = [];
  for (const variant of draft.variants) {
    const label = variantLabel(providers, draft.provider, variant, draft.variants);
    for (const regionId of draft.regionIds) {
      const regionName = regions.find((r) => r.id === regionId)?.name ?? regionId;
      const existing = datasets.find(
        (d) => variant.ids.includes(d.id) && d.region_id === regionId,
      );
      let schedule: "manual" | "ttl";
      let ttl: number | null;
      if (draft.schedule === "keep") {
        const from =
          existing ??
          datasets.find((d) => variant.ids.includes(d.id)) ??
          datasets[0];
        schedule = from?.schedule ?? "manual";
        ttl = from?.ttl_s ?? null;
      } else {
        schedule = draft.schedule;
        ttl = draft.ttl_s;
      }
      const body: DatasetPutBody = {
        provider: draft.provider as DatasetPutBody["provider"],
        name: existing?.name ?? `${label} - ${regionName}`,
        region_id: regionId,
        mode: "bake",
        implementation: variant.implementation,
        schedule,
        ttl_s: schedule === "ttl" ? ttl : null,
        params: variant.params,
      };
      if (existing) {
        kept.add(existing.id);
        // Each PUT rewrites the whole config's dataset list — skip a cell
        // the edit didn't touch.
        const same =
          existing.implementation === body.implementation &&
          existing.schedule === body.schedule &&
          (existing.ttl_s ?? null) === (body.ttl_s ?? null) &&
          stableJson(existing.params) === stableJson(body.params);
        if (!same) puts.push({ id: existing.id, body, isNew: false });
      } else {
        const id = makeId(body.name, taken);
        taken.push(id);
        puts.push({ id, body, isNew: true });
      }
    }
  }
  const deletes = datasets.filter((d) => !kept.has(d.id));
  return { puts, deletes };
}
