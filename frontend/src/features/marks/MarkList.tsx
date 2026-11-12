// The mark list: drop one at the boat, search, edit (name, icon, note),
// delete, and tap to go there. Docked on desktop and a sheet on a phone, like
// the buddy list.

import Pencil from "lucide-solid/icons/pencil";
import Trash2 from "lucide-solid/icons/trash-2";
import { createMemo, createSignal, Index, Show, type Accessor, type Component } from "solid-js";
import { useBackDismiss } from "../../core/chrome/backStack";
import DockPanel from "../../core/chrome/DockPanel";
import { bearingDeg, rangeNm, type GeoPoint } from "../../core/chrome/geo";
import Sheet from "../../core/chrome/Sheet";
import { formatBearingDeg, formatDistanceNm } from "../../core/info/vesselProvider";
import { isCompact } from "../../core/media";
import type { Palette } from "../../core/style/colors";
import { markColor } from "./icons";
import MarkGlyph from "./MarkGlyph";
import {
  displayName,
  filterMarks,
  iconOf,
  isMarkIcon,
  MARK_ICON_LABELS,
  MARK_ICONS,
  sortMarks,
  type Mark,
  type MarkBody,
  type MarkIcon,
} from "./model";

export interface MarkListProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  marks: Mark[];
  stale: boolean;
  palette: () => Palette;
  self: () => GeoPoint | undefined;
  onPick: (m: Mark) => void;
  onDropAtBoat: () => void;
  onUpdate: (m: Mark, patch: Partial<MarkBody>) => void;
  onRemove: (m: Mark) => void;
}

const fieldCls =
  "w-full rounded-md border border-line bg-chrome-2 px-2.5 py-1.5 text-xs text-fg placeholder:text-fg-3 focus-ring";
const iconCls =
  "flex size-8 shrink-0 items-center justify-center rounded-md text-fg-3 hover:text-accent focus-ring";
const smallBtn = "rounded-md px-2.5 py-1 text-xs font-semibold pointer-coarse:min-h-9 focus-ring";

const MarkListPanel: Component<MarkListProps> = (props) => {
  useBackDismiss(
    () => props.open,
    () => props.onOpenChange(false),
  );
  // Here, not in the row: rows are by position (`Index`), and a re-sort while
  // typing must not hand the draft to another mark. One editor at a time.
  const [editing, setEditing] = createSignal<string>();
  const [draftName, setDraftName] = createSignal("");
  const [draftNote, setDraftNote] = createSignal("");
  const [draftIcon, setDraftIcon] = createSignal<MarkIcon>("pin");
  const [armed, setArmed] = createSignal<string>();
  const [query, setQuery] = createSignal("");
  const all = createMemo(() => {
    const own = props.self();
    return sortMarks(props.marks, own ? (m) => rangeNm(own, { lng: m.lon, lat: m.lat }) : undefined);
  });
  const shown = createMemo(() => filterMarks(all(), query()));

  // An accessor over `Index`, not `For`: the poll brings new objects, and
  // rebuilding the row would lose a press or close an edit being typed.
  const Row: Component<{ mark: Accessor<Mark> }> = (p) => {
    const where = () => {
      const own = props.self();
      if (!own) return undefined;
      const to = { lng: p.mark().lon, lat: p.mark().lat };
      return `${formatDistanceNm(rangeNm(own, to))} · ${formatBearingDeg(bearingDeg(own, to))}`;
    };
    return (
      <li class="rounded-md border border-line-2 bg-chrome-2">
        <div class="flex items-center gap-1">
          <Show
            when={editing() === p.mark().id}
            fallback={
              <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left focus-ring"
                onClick={() => props.onPick(p.mark())}
              >
                <span style={{ color: markColor(props.palette()) }} class="shrink-0">
                  <MarkGlyph icon={iconOf(p.mark())} class="size-4" />
                </span>
                <span class="min-w-0">
                  <span class="block truncate text-xs font-semibold text-fg">{displayName(p.mark())}</span>
                  <span class="block text-[11px] text-fg-2">
                    {MARK_ICON_LABELS[iconOf(p.mark())]}
                    {where() ? ` · ${where()}` : ""}
                  </span>
                  <Show when={p.mark().note}>
                    <span class="mt-0.5 block whitespace-pre-wrap break-words text-[11px] text-fg-2">
                      {p.mark().note}
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
                setEditing(undefined);
                props.onUpdate(p.mark(), {
                  name: draftName().trim(),
                  note: draftNote().trim(),
                  icon: draftIcon(),
                });
              }}
            >
              <input
                class={fieldCls}
                aria-label="Name"
                maxLength={64}
                placeholder="Name"
                value={draftName()}
                ref={(el) => queueMicrotask(() => el.focus())}
                onInput={(e) => setDraftName(e.currentTarget.value)}
              />
              <div class="flex flex-wrap gap-1" role="radiogroup" aria-label="Icon">
                <Index each={MARK_ICONS}>
                  {(icon) => (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={draftIcon() === icon()}
                      aria-label={MARK_ICON_LABELS[icon()]}
                      title={MARK_ICON_LABELS[icon()]}
                      class="flex size-8 items-center justify-center rounded-md ring-1 focus-ring pointer-coarse:size-10"
                      classList={{
                        "ring-accent text-accent": draftIcon() === icon(),
                        "ring-line text-fg-2": draftIcon() !== icon(),
                      }}
                      onClick={() => setDraftIcon(icon())}
                    >
                      <MarkGlyph icon={icon()} class="size-4" />
                    </button>
                  )}
                </Index>
              </div>
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
                  class={`${smallBtn} text-fg-2 ring-1 ring-line`}
                  onClick={() => setEditing(undefined)}
                >
                  Cancel
                </button>
                <button type="submit" class={`${smallBtn} text-accent ring-1 ring-accent/40`}>
                  Save
                </button>
              </div>
            </form>
          </Show>
          <button
            type="button"
            class={iconCls}
            aria-label={`Edit ${displayName(p.mark())}`}
            onClick={() => {
              setDraftName(p.mark().name);
              setDraftNote(p.mark().note);
              setDraftIcon(isMarkIcon(p.mark().icon) ? p.mark().icon : "pin");
              setEditing(p.mark().id);
            }}
          >
            <Pencil size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            class={iconCls}
            aria-label={`Delete ${displayName(p.mark())}`}
            onClick={() => setArmed(p.mark().id)}
          >
            <Trash2 size={14} aria-hidden="true" />
          </button>
        </div>
        <Show when={armed() === p.mark().id}>
          <div class="flex items-center gap-2 border-t border-line-2 px-2 py-1.5">
            <span class="min-w-0 flex-1 truncate text-xs font-semibold text-fg">
              Delete {displayName(p.mark())}?
            </span>
            <button
              type="button"
              class={`${smallBtn} text-alarm ring-1 ring-alarm/40`}
              onClick={() => {
                const m = p.mark();
                setArmed(undefined);
                props.onRemove(m);
              }}
            >
              Delete
            </button>
            <button
              type="button"
              class={`${smallBtn} text-fg-2 ring-1 ring-line`}
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
      <button
        type="button"
        class="rounded-md border border-line px-3 py-1.5 text-xs font-semibold text-fg-2 enabled:hover:border-accent enabled:hover:text-accent disabled:opacity-40 pointer-coarse:min-h-10 focus-ring"
        disabled={!props.self()}
        onClick={() => props.onDropAtBoat()}
      >
        Drop a mark at the boat
      </button>
      <p class="text-[11px] text-fg-3">Or long-press (right-click) the chart to drop one there.</p>
      <Show when={props.stale}>
        <p class="text-[11px] text-fg-3">Signal K isn’t answering: showing the last copy.</p>
      </Show>
      <Show when={all().length > 0}>
        <input
          type="search"
          class={fieldCls}
          placeholder="Search name or note"
          aria-label="Search marks"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
      </Show>
      <Show
        when={shown().length > 0}
        fallback={
          <p class="px-1 py-4 text-center text-sm text-fg-3">
            {all().length > 0 ? "No marks match this search." : "No marks yet."}
          </p>
        }
      >
        <ul class="flex flex-col gap-1.5">
          <Index each={shown()}>{(m) => <Row mark={m} />}</Index>
        </ul>
      </Show>
    </div>
  );

  return (
    <Show
      when={isCompact()}
      fallback={
        <DockPanel open={props.open} onClose={() => props.onOpenChange(false)} title="Marks" side="left">
          <Body />
        </DockPanel>
      }
    >
      <Sheet open={props.open} onOpenChange={props.onOpenChange} title="Marks" modal>
        <Body />
      </Sheet>
    </Show>
  );
};

export default MarkListPanel;
