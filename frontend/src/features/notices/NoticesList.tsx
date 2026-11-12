// The Notices to Mariners list (efs.md §2.5): every current notice — the
// only home of the ones with no geometry (general NMs, EfS A/B) — sorted by
// distance from the boat (map centre without a fix), filterable by family and
// text, with a "new since you last looked" badge and, in the header, how old
// the data is: stale warnings are dangerous and the boat is often offline.
// Same shell as RouteList: DockPanel (left) on desktop, modal Sheet on phone.
//
// Reads the feature's ONE client for status/version (no second poller). The
// list itself is `GET /notices/list`, refetched when the snapshot version
// moves. With the overlay off the client is inert, so opening the list asks
// `/notices/status` once itself (which is also what kicks the backend's lazy
// pull) and, after a manual refresh, re-asks while the pull runs.

import RefreshCw from "lucide-solid/icons/refresh-cw";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
  type Component,
} from "solid-js";
import Sheet from "../../core/chrome/Sheet";
import DockPanel from "../../core/chrome/DockPanel";
import { useBackDismiss } from "../../core/chrome/backStack";
import { isCompact } from "../../core/media";
import type { Palette } from "../../core/style/colors";
import { fetchNoticesList, fetchNoticesStatus, postNoticesRefresh, type NoticesClient } from "./client";
import { NOTICE_LANG } from "./detailModel";
import { familyLabel, stateText, statusLine } from "./labels";
import {
  buildList,
  FAMILY_CHIPS,
  rowText,
  formatDistanceNm,
  readLastOpened,
  writeLastOpened,
  type GeoPoint,
  type KeyValueStore,
  type ListRow,
} from "./listModel";
import { noticeIconComponent } from "./NoticeIcon";
import { colourKey, overlapsToday, timeState } from "./time";
import type { NoticeListItem, NoticesList as NoticesListData, NoticesStatus } from "./types";

export interface NoticesListProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client: NoticesClient;
  palette: () => Palette;
  /** Own ship's position, when there is a fix. */
  self: () => GeoPoint | undefined;
  /** The map centre — the reference point without a fix. */
  center: () => GeoPoint | undefined;
  /** A row was tapped: fly there and open its detail. */
  onPick: (item: NoticeListItem) => void;
  /** Seams (tests). */
  fetchList?: () => Promise<NoticesListData | undefined>;
  fetchStatus?: () => Promise<NoticesStatus | undefined>;
  refresh?: () => Promise<NoticesStatus | undefined>;
  store?: KeyValueStore;
}

const chipCls =
  "rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors pointer-coarse:min-h-9 focus-ring";

const NoticesList: Component<NoticesListProps> = (props) => {
  useBackDismiss(
    () => props.open,
    () => props.onOpenChange(false),
  );
  const fetchList = props.fetchList ?? (() => fetchNoticesList());
  const fetchStatus = props.fetchStatus ?? (() => fetchNoticesStatus());
  const refresh = props.refresh ?? (() => postNoticesRefresh());

  const [localStatus, setLocalStatus] = createSignal<NoticesStatus>();
  const status = () => props.client.status() ?? localStatus();
  const [chips, setChips] = createSignal<ReadonlySet<string>>(new Set());
  const [query, setQuery] = createSignal("");
  const [now, setNow] = createSignal(Date.now());
  // The "new" baseline is the PREVIOUS open, captured when the panel opens
  // and then overwritten with this open's time — so badges stay put while
  // the panel is open and are gone next time.
  const [lastOpened, setLastOpened] = createSignal<number | null>(null);

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        setLastOpened(readLastOpened(props.store));
        writeLastOpened(Date.now(), props.store);
        setNow(Date.now());
        if (!props.client.status()) void fetchStatus().then((st) => st && setLocalStatus(st));
        const t = setInterval(() => setNow(Date.now()), 30_000);
        onCleanup(() => clearInterval(t));
      },
    ),
  );

  // While a pull runs and nobody else is polling (overlay off), ask again.
  createEffect(() => {
    if (!props.open || props.client.status() || localStatus()?.state !== "loading") return;
    const t = setTimeout(() => void fetchStatus().then((st) => st && setLocalStatus(st)), 2_000);
    onCleanup(() => clearTimeout(t));
  });

  const version = () => props.client.version() ?? status()?.version ?? null;
  const [list, { refetch }] = createResource(
    // A string key, so a status poll that didn't move the version is no refetch.
    () => (props.open ? `v:${version()}` : false),
    () => fetchList(),
  );
  // Keep the last good list visible across a refetch (no "Loading…" flash).
  const items = createMemo<NoticeListItem[] | undefined>((prev) => list.latest?.items ?? prev);

  const [refreshing, setRefreshing] = createSignal(false);
  const doRefresh = async () => {
    setRefreshing(true);
    const st = await refresh();
    setRefreshing(false);
    if (st) setLocalStatus(st);
    props.client.poll();
    if (!st) void refetch();
  };

  // Re-sorted only when the reference point moves ~half a mile, not on
  // every SignalK tick or pan frame (the rows rebuild on each sort).
  const from = createMemo(() => props.self() ?? props.center(), undefined, {
    equals: (a, b) => a === b || (!!a && !!b && Math.abs(a.lat - b.lat) < 0.008 && Math.abs(a.lng - b.lng) < 0.015),
  });
  const groups = createMemo(() =>
    buildList(items() ?? [], { chips: chips(), query: query(), from: from(), lastOpened: lastOpened() }),
  );
  const toggleChip = (id: string) =>
    setChips((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const pick = (item: NoticeListItem) => {
    props.onPick(item);
    // The phone sheet is modal: get it out of the way of the info panel.
    if (isCompact()) props.onOpenChange(false);
  };

  const Row: Component<{ row: ListRow }> = (rp) => {
    const item = rp.row.item;
    const text = rowText(item);
    const ft = item.fam === "fa" && overlapsToday(item.win, now());
    const Icon = noticeIconComponent(item.cls, colourKey(item.fam, ft), props.palette);
    const st = () => (item.fam === "fa" ? (ft ? "a" : "e") : timeState(item.win, now()));
    return (
      <li>
        <button
          type="button"
          class="flex w-full cursor-pointer items-start gap-2 rounded-lg border border-line bg-chrome-2 p-2 text-left transition-colors hover:border-line-2 hover:bg-chrome active:bg-chrome focus-ring"
          onClick={() => pick(item)}
        >
          <Icon class="mt-0.5 size-5 shrink-0" />
          <div class="min-w-0 flex-1">
            <div class="flex items-baseline gap-1.5">
              <span class="shrink-0 font-mono text-[11px] font-semibold text-fg-2">
                {item.sid ?? familyLabel(item.fam)}
              </span>
              <Show when={rp.row.isNew}>
                <span class="shrink-0 rounded-full bg-accent px-1.5 text-[9px] font-bold uppercase tracking-wide text-accent-fg">
                  New
                </span>
              </Show>
              <span class="ml-auto shrink-0 font-mono text-[11px] text-fg-3">
                {rp.row.distanceNm !== undefined ? formatDistanceNm(rp.row.distanceNm) : ""}
              </span>
            </div>
            <p class="line-clamp-2 text-xs font-semibold text-fg" lang={NOTICE_LANG}>
              {text.headline}
            </p>
            <Show when={text.title}>
              <p class="line-clamp-2 text-[11px] text-fg-2" lang={NOTICE_LANG}>
                {text.title}
              </p>
            </Show>
            <p
              class="text-[10px] font-semibold uppercase tracking-wide"
              classList={{
                "text-alarm": st() === "a" && (item.fam === "nw" || item.fam === "fe" || ft),
                "text-fg-2": st() === "a" && !(item.fam === "nw" || item.fam === "fe" || ft),
                "text-accent": st() === "u",
                "text-fg-3": st() === "e",
              }}
            >
              {familyLabel(item.fam)} · {stateText(item.fam, item.win, now())}
            </p>
          </div>
        </button>
      </li>
    );
  };

  const Body: Component = () => (
    <div class="flex flex-col gap-2.5">
      <div class="flex items-center gap-2">
        <p class="min-w-0 flex-1 text-[11px] text-fg-2" aria-live="polite">
          {statusLine(status(), list.latest?.fetched_at, now())}
        </p>
        <button
          type="button"
          class="flex shrink-0 items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs font-semibold text-fg-2 enabled:hover:border-accent enabled:hover:text-accent disabled:opacity-40 focus-ring"
          disabled={refreshing() || status()?.state === "loading"}
          title="Fetch the latest notices from the Danish Maritime Authority now"
          onClick={() => void doRefresh()}
        >
          <RefreshCw
            size={13}
            aria-hidden="true"
            classList={{ "animate-spin": refreshing() || status()?.state === "loading" }}
          />
          Refresh
        </button>
      </div>
      <Show when={status()?.error && status()?.state === "offline"}>
        <p class="text-[11px] text-fg-3">{status()?.error}</p>
      </Show>
      <input
        type="search"
        placeholder="Filter (number, place, text)"
        aria-label="Filter notices"
        class="w-full rounded-md border border-line bg-chrome-2 px-2.5 py-1.5 text-xs text-fg placeholder:text-fg-3 focus-ring"
        value={query()}
        onInput={(e) => setQuery(e.currentTarget.value)}
      />
      <div class="flex flex-wrap gap-1.5" role="group" aria-label="Families">
        <For each={FAMILY_CHIPS}>
          {(c) => (
            <button
              type="button"
              class={chipCls}
              classList={{
                "border-accent bg-accent text-accent-fg": chips().has(c.id),
                "border-line text-fg-2 hover:border-accent hover:text-accent": !chips().has(c.id),
              }}
              aria-pressed={chips().has(c.id)}
              onClick={() => toggleChip(c.id)}
            >
              {c.label}
            </button>
          )}
        </For>
      </div>
      <Show
        when={items()}
        fallback={
          <p class="px-1 py-4 text-center text-sm text-fg-3">
            {list.loading ? "Loading notices…" : "Couldn’t load the notices from the boat’s server."}
          </p>
        }
      >
        <Show
          when={groups().located.length + groups().unlocated.length > 0}
          fallback={
            <p class="px-1 py-4 text-center text-sm text-fg-3">
              {(items() ?? []).length === 0
                ? "No notices yet — the boat’s server hasn’t fetched any. Tap Refresh when online."
                : "No notices match this filter."}
            </p>
          }
        >
          <Show when={groups().located.length > 0}>
            <p class="text-[10px] font-semibold uppercase tracking-wide text-fg-3">
              {props.self() ? "Nearest the boat" : "Nearest the map centre"}
            </p>
            <ul class="flex flex-col gap-1.5">
              <For each={groups().located}>{(row) => <Row row={row} />}</For>
            </ul>
          </Show>
          <Show when={groups().unlocated.length > 0}>
            <p class="text-[10px] font-semibold uppercase tracking-wide text-fg-3">No position</p>
            <ul class="flex flex-col gap-1.5">
              <For each={groups().unlocated}>{(row) => <Row row={row} />}</For>
            </ul>
          </Show>
        </Show>
      </Show>
    </div>
  );

  return (
    <Show
      when={isCompact()}
      fallback={
        <DockPanel open={props.open} onClose={() => props.onOpenChange(false)} title="Notices to Mariners" side="left">
          <Body />
        </DockPanel>
      }
    >
      <Sheet open={props.open} onOpenChange={props.onOpenChange} title="Notices to Mariners" modal>
        <Body />
      </Sheet>
    </Show>
  );
};

export default NoticesList;
