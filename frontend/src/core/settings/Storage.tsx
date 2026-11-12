import { createSignal, For, Show, type Component } from "solid-js";
import HardDrive from "lucide-solid/icons/hard-drive";
import { AccordionSection } from "../ui/Accordion";
import { Button } from "../ui/Button";
import { formatBytes } from "./DatasetList";

// Whole-disk storage view over `GET /storage`: every place mivnav writes
// (datasets split by source — "POI (OSM)" apart from a plugin source's — plus
// chart sets, routing graphs, track history, caches and logs), and how full
// the disk holding the data folder is.

export interface StorageItem {
  name: string;
  bytes: number;
}

export interface StorageGroup {
  id: string;
  label: string;
  kind: "dataset" | "data" | "cache";
  bytes: number;
  items: StorageItem[];
}

export interface DiskUsage {
  path: string;
  total: number;
  used: number;
  free: number;
}

interface StorageResponse {
  disk: DiskUsage | null;
  groups: StorageGroup[];
  total: number;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = body && typeof body.detail === "string" ? body.detail : `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return body as T;
}

/** The disk bar's three segments as percentages of the whole disk:
 * mivnav's own bytes, everything else that is used, and free. mivnav is
 * clamped into `used` (its walk and `statvfs` are separate reads, and caches
 * outside the data folder may sit on another filesystem). Pure so it is
 * unit-testable without a DOM. */
export function diskSegments(
  disk: DiskUsage,
  mivnavBytes: number,
): { mivnav: number; other: number; free: number } {
  if (disk.total <= 0) return { mivnav: 0, other: 0, free: 0 };
  const own = Math.min(Math.max(mivnavBytes, 0), disk.used);
  const pct = (n: number) => (n / disk.total) * 100;
  return { mivnav: pct(own), other: pct(disk.used - own), free: pct(disk.free) };
}

/**
 * Fetches on mount, like the chart library and dataset list. No poll — a
 * bake finishing elsewhere only updates this on the next open (or Refresh).
 */
const StorageSection: Component = () => {
  const [data, setData] = createSignal<StorageResponse | null>(null);
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(true);
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set());

  const refresh = async () => {
    setError("");
    setLoading(true);
    try {
      setData(await getJson<StorageResponse>("/api/storage"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };
  void refresh();

  const toggle = (id: string) => {
    const next = new Set(open());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpen(next);
  };

  const groups = () => data()?.groups ?? [];
  const total = () => data()?.total ?? 0;

  return (
    <AccordionSection value="storage" title="Storage" icon={HardDrive}>
      <Show
        when={!error()}
        fallback={
          <div class="space-y-1 pb-2">
            <p class="text-xs text-notice">The boat's server did not answer for storage use.</p>
            <p class="break-all text-xs text-fg-2">{error()}</p>
            <Button disabled={loading()} onClick={() => void refresh()}>
              Retry
            </Button>
          </div>
        }
      >
        <section class="space-y-3">
          <Show when={data()?.disk}>
            {(disk) => {
              const seg = () => diskSegments(disk(), total());
              return (
                <div class="space-y-1">
                  <div class="flex items-center justify-between gap-2 text-xs">
                    <span class="font-medium text-fg">Disk</span>
                    <span class="text-fg-2">
                      <span class="font-medium text-fg">{formatBytes(disk().free)}</span> free of{" "}
                      {formatBytes(disk().total)}
                    </span>
                  </div>
                  <div class="flex h-2 w-full overflow-hidden rounded bg-chrome-2">
                    <div class="h-full bg-accent" style={{ width: `${seg().mivnav}%` }} />
                    <div class="h-full bg-fg-2 opacity-50" style={{ width: `${seg().other}%` }} />
                  </div>
                  <div class="flex flex-wrap gap-x-3 text-xs text-fg-2">
                    <span>
                      <span class="mr-1 inline-block h-2 w-2 rounded-sm bg-accent" />
                      mivnav {formatBytes(total())}
                    </span>
                    <span>
                      <span class="mr-1 inline-block h-2 w-2 rounded-sm bg-fg-2 opacity-50" />
                      other {formatBytes(Math.max(disk().used - total(), 0))}
                    </span>
                    <span>
                      <span class="mr-1 inline-block h-2 w-2 rounded-sm bg-chrome-2" />
                      free {formatBytes(disk().free)}
                    </span>
                  </div>
                </div>
              );
            }}
          </Show>
          <Show
            when={groups().length > 0}
            fallback={<p class="text-fg-2">{loading() ? "Loading…" : "Nothing stored yet."}</p>}
          >
            <ul class="space-y-2">
              <For each={groups()}>
                {(g) => {
                  const pct = () => (total() > 0 ? (g.bytes / total()) * 100 : 0);
                  return (
                    <li class="space-y-1">
                      <button
                        type="button"
                        class="flex w-full items-center justify-between gap-2 text-left text-xs"
                        aria-expanded={open().has(g.id)}
                        onClick={() => toggle(g.id)}
                      >
                        <span class="font-medium text-fg">
                          {open().has(g.id) ? "▾" : "▸"} {g.label}
                          <Show when={g.kind === "cache"}>
                            <span class="ml-1 font-normal text-fg-2">(rebuilt on demand)</span>
                          </Show>
                        </span>
                        <span class="shrink-0 text-fg-2">{formatBytes(g.bytes)}</span>
                      </button>
                      <div class="h-1.5 w-full overflow-hidden rounded bg-chrome-2">
                        <div class="h-full rounded bg-accent" style={{ width: `${pct()}%` }} />
                      </div>
                      <Show when={open().has(g.id)}>
                        <ul class="space-y-0.5 pl-3">
                          <For each={g.items}>
                            {(item) => (
                              <li class="flex items-center justify-between gap-2 text-xs text-fg-2">
                                <span class="min-w-0 break-all">{item.name}</span>
                                <span class="shrink-0">{formatBytes(item.bytes)}</span>
                              </li>
                            )}
                          </For>
                        </ul>
                      </Show>
                    </li>
                  );
                }}
              </For>
            </ul>
            <div class="flex items-center justify-between gap-2">
              <p class="text-xs text-fg-2">
                Total used by mivnav: <span class="font-medium">{formatBytes(total())}</span>
              </p>
              <Button disabled={loading()} onClick={() => void refresh()}>
                Refresh
              </Button>
            </div>
          </Show>
        </section>
      </Show>
    </AccordionSection>
  );
};

export default StorageSection;
