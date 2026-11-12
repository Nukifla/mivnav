// Pure model of the notices dataset's params form (backend
// `NoticesDatasetParams`): which source a dataset names (its
// `implementation`) and which of that source's regions it shows
// (`params.regions`). The source catalog comes from `GET /notices/sources`,
// so a new country's source needs no change here.

export interface NoticeRegion {
  id: string;
  label: string;
  description: string;
}

export interface NoticeSource {
  id: string;
  label: string;
  publisher: string;
  regions: NoticeRegion[];
}

export interface NoticeSourcesResponse {
  default: string;
  sources: NoticeSource[];
}

/** The source a dataset names: its `implementation`, else the catalog's
 * default; `undefined` until the catalog has loaded (or names none). */
export function sourceOf(
  catalog: NoticeSourcesResponse | undefined,
  implementation: string | null,
): NoticeSource | undefined {
  if (!catalog) return undefined;
  const id = implementation || catalog.default;
  return catalog.sources.find((s) => s.id === id);
}

/** The region ids the dataset shows. An absent `params.regions` means every
 * region of the source (the backend reads it the same way); unknown ids
 * (a region since dropped from the catalog) are left out. */
export function regionsOf(value: Record<string, unknown>, source: NoticeSource | undefined): string[] {
  const all = source?.regions.map((r) => r.id) ?? [];
  if (!Array.isArray(value.regions)) return all;
  const picked = new Set(value.regions.filter((r): r is string => typeof r === "string"));
  return all.filter((id) => picked.has(id));
}

/** `value` with region `id` switched `on`/off — in the catalog's order,
 * never down to zero regions (the backend 422s an empty list: a dataset
 * showing nothing would be a silent no-op), so the last one stays on. */
export function withRegion(
  value: Record<string, unknown>,
  source: NoticeSource,
  id: string,
  on: boolean,
): Record<string, unknown> {
  const current = new Set(regionsOf(value, source));
  if (on) current.add(id);
  else if (current.size > 1) current.delete(id);
  return { ...value, regions: source.regions.map((r) => r.id).filter((r) => current.has(r)) };
}
