// The buddy list: add by MMSI, rename, remove, and tap to go there. Docked on
// desktop and a sheet on a phone, like the notices list.

import Pencil from "lucide-solid/icons/pencil";
import Trash2 from "lucide-solid/icons/trash-2";
import { createMemo, createSignal, Index, Show, type Accessor, type Component } from "solid-js";
import { useBackDismiss } from "../../core/chrome/backStack";
import DockPanel from "../../core/chrome/DockPanel";
import { rangeNm, type GeoPoint } from "../../core/chrome/geo";
import Sheet from "../../core/chrome/Sheet";
import { formatDistanceNm } from "../../core/info/vesselProvider";
import { riskColor } from "../../core/layers/aisSymbols";
import { isCompact } from "../../core/media";
import type { Palette } from "../../core/style/colors";
import type { BuddiesApi } from "./client";
import {
  ageText,
  displayName,
  filterBuddies,
  OLD_AFTER_S,
  sortBuddies,
  sourceText,
  type Buddy,
  type BuddyList as BuddyListData,
} from "./model";

export interface BuddyListProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: BuddyListData | undefined;
  api: BuddiesApi;
  reload: () => Promise<void>;
  palette: () => Palette;
  self: () => GeoPoint | undefined;
  onPick: (b: Buddy) => void;
}

const fieldCls =
  "w-full rounded-md border border-line bg-chrome-2 px-2.5 py-1.5 text-xs text-fg placeholder:text-fg-3 focus-ring";
const iconCls =
  "flex size-8 shrink-0 items-center justify-center rounded-md text-fg-3 hover:text-accent focus-ring";

const BuddyListPanel: Component<BuddyListProps> = (props) => {
  useBackDismiss(
    () => props.open,
    () => props.onOpenChange(false),
  );
  const [mmsi, setMmsi] = createSignal("");
  const [nickname, setNickname] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [editing, setEditing] = createSignal<string>();
  // Here, not in the row: rows are by position (`Index`), and a re-sort while
  // typing must not hand the draft to another boat. One editor at a time.
  const [draftNickname, setDraftNickname] = createSignal("");
  const [draftNote, setDraftNote] = createSignal("");
  const [armed, setArmed] = createSignal<string>();
  const [query, setQuery] = createSignal("");
  const all = createMemo(() => sortBuddies(props.data?.buddies ?? []));
  const buddies = createMemo(() => filterBuddies(all(), query()));
  const valid = () => /^[0-9]{9}$/.test(mmsi());

  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      await props.reload();
      // The server fetches a new boat's position after answering.
      setTimeout(() => void props.reload(), 3_000);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn’t reach the boat’s server.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async (e: Event) => {
    e.preventDefault();
    if (!valid() || busy()) return;
    if (await run(() => props.api.add(mmsi(), nickname().trim() || undefined))) {
      setMmsi("");
      setNickname("");
    }
  };

  const saveEdit = async (b: Buddy, nickname: string, note: string) => {
    setEditing(undefined);
    await run(() => props.api.edit(b.id, nickname.trim() || undefined, note.trim() || undefined));
  };

  // An accessor over `Index`, not `For`: the 30 s poll brings new objects, and
  // rebuilding the row would lose a press or close a nickname being typed.
  const Row: Component<{ buddy: Accessor<Buddy> }> = (p) => {
    const position = () => p.buddy().position;
    const range = () => {
      const own = props.self();
      const at = position();
      return own && at ? formatDistanceNm(rangeNm(own, at)) : undefined;
    };
    return (
      <li class="rounded-md border border-line-2 bg-chrome-2">
        <div class="flex items-center gap-1">
        <Show
          when={editing() === p.buddy().id}
          fallback={
            <button
              type="button"
              class="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left disabled:cursor-default focus-ring"
              disabled={!position()}
              onClick={() => props.onPick(p.buddy())}
            >
              <span
                class="size-3 shrink-0 rounded-full"
                style={{ background: riskColor(props.palette(), "buddy") }}
                classList={{ "opacity-40": (position()?.ageS ?? Infinity) > OLD_AFTER_S }}
                aria-hidden="true"
              />
              <span class="min-w-0">
                <span class="block truncate text-xs font-semibold text-fg">{displayName(p.buddy())}</span>
                <Show
                  when={position()}
                  fallback={<span class="block text-[11px] text-fg-3">No position yet</span>}
                >
                  {(at) => (
                    <span class="block text-[11px] text-fg-2">
                      {ageText(at().ageS)}
                      {range() ? ` · ${range()}` : ""} · {sourceText(at())}
                    </span>
                  )}
                </Show>
                <Show when={p.buddy().mmsi}>
                  <span class="block text-[10px] text-fg-3">MMSI {p.buddy().mmsi}</span>
                </Show>
                <Show when={p.buddy().note}>
                  <span class="mt-0.5 block whitespace-pre-wrap break-words text-[11px] text-fg-2">
                    {p.buddy().note}
                  </span>
                </Show>
              </span>
            </button>
          }
        >
          <form
            class="flex min-w-0 flex-1 flex-col gap-1.5 p-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              void saveEdit(p.buddy(), draftNickname(), draftNote());
            }}
          >
            <input
              class={fieldCls}
              aria-label="Nickname"
              maxLength={64}
              placeholder="Nickname"
              value={draftNickname()}
              ref={(el) => queueMicrotask(() => el.focus())}
              onInput={(e) => setDraftNickname(e.currentTarget.value)}
            />
            <textarea
              class={`${fieldCls} resize-y`}
              aria-label="Note"
              maxLength={500}
              rows={3}
              placeholder="Note"
              value={draftNote()}
              onInput={(e) => setDraftNote(e.currentTarget.value)}
            />
            <div class="flex justify-end gap-2">
              <button
                type="button"
                class="rounded-md px-2.5 py-1 text-xs font-semibold text-fg-2 ring-1 ring-line pointer-coarse:min-h-9 focus-ring"
                onClick={() => setEditing(undefined)}
              >
                Cancel
              </button>
              <button
                type="submit"
                class="rounded-md px-2.5 py-1 text-xs font-semibold text-accent ring-1 ring-accent/40 pointer-coarse:min-h-9 focus-ring"
              >
                Save
              </button>
            </div>
          </form>
        </Show>
        <button
          type="button"
          class={iconCls}
          aria-label={`Edit ${displayName(p.buddy())}`}
          onClick={() => {
            setDraftNickname(p.buddy().nickname ?? "");
            setDraftNote(p.buddy().note ?? "");
            setEditing(p.buddy().id);
          }}
        >
          <Pencil size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          class={iconCls}
          aria-label={`Remove ${displayName(p.buddy())}`}
          onClick={() => setArmed(p.buddy().id)}
        >
          <Trash2 size={14} aria-hidden="true" />
        </button>
        </div>
        <Show when={armed() === p.buddy().id}>
          <div class="flex items-center gap-2 border-t border-line-2 px-2 py-1.5">
            <span class="min-w-0 flex-1 truncate text-xs font-semibold text-fg">
              Remove {displayName(p.buddy())}?
            </span>
            <button
              type="button"
              class="rounded-md px-2.5 py-1 text-xs font-semibold text-alarm ring-1 ring-alarm/40 pointer-coarse:min-h-9 focus-ring"
              onClick={() => {
                const id = p.buddy().id;
                setArmed(undefined);
                void run(() => props.api.remove(id));
              }}
            >
              Remove
            </button>
            <button
              type="button"
              class="rounded-md px-2.5 py-1 text-xs font-semibold text-fg-2 ring-1 ring-line pointer-coarse:min-h-9 focus-ring"
              onClick={() => setArmed(undefined)}
            >
              Cancel
            </button>
          </div>
        </Show>
      </li>
    );
  };

  const Body: Component = () => (
    <div class="flex flex-col gap-2.5">
      <form class="flex flex-col gap-1.5" onSubmit={(e) => void add(e)}>
        <input
          class={fieldCls}
          inputmode="numeric"
          maxLength={9}
          placeholder="MMSI (9 digits)"
          aria-label="MMSI"
          value={mmsi()}
          onInput={(e) => setMmsi(e.currentTarget.value.replace(/\D/g, ""))}
        />
        <div class="flex gap-1.5">
          <input
            class={fieldCls}
            maxLength={64}
            placeholder="Nickname (optional)"
            aria-label="Nickname"
            value={nickname()}
            onInput={(e) => setNickname(e.currentTarget.value)}
          />
          <button
            type="submit"
            class="shrink-0 rounded-md border border-line px-3 py-1 text-xs font-semibold text-fg-2 enabled:hover:border-accent enabled:hover:text-accent disabled:opacity-40 focus-ring"
            disabled={!valid() || busy()}
          >
            Add
          </button>
        </div>
      </form>
      <Show when={error()}>
        <p class="text-[11px] text-alarm" role="alert">
          {error()}
        </p>
      </Show>
      <Show when={props.data?.lastPoll?.ok === false}>
        <p class="text-[11px] text-fg-3">No internet: showing saved positions.</p>
      </Show>
      <Show when={all().length > 0}>
        <input
          type="search"
          class={fieldCls}
          placeholder="Search name, nickname, MMSI, note"
          aria-label="Search buddies"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
      </Show>
      <Show
        when={buddies().length > 0}
        fallback={
          <p class="px-1 py-4 text-center text-sm text-fg-3">
            {all().length > 0
              ? "No buddies match this search."
              : props.data
                ? "No buddies yet. Add one by MMSI."
                : "Couldn’t reach the boat’s server."}
          </p>
        }
      >
        <ul class="flex flex-col gap-1.5">
          <Index each={buddies()}>{(b) => <Row buddy={b} />}</Index>
        </ul>
      </Show>
    </div>
  );

  return (
    <Show
      when={isCompact()}
      fallback={
        <DockPanel open={props.open} onClose={() => props.onOpenChange(false)} title="Buddies" side="left">
          <Body />
        </DockPanel>
      }
    >
      <Sheet open={props.open} onOpenChange={props.onOpenChange} title="Buddies" modal>
        <Body />
      </Sheet>
    </Show>
  );
};

export default BuddyListPanel;
