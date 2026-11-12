import { Tabs } from "@kobalte/core/tabs";
import ChevronLeft from "lucide-solid/icons/chevron-left";
import ChevronRight from "lucide-solid/icons/chevron-right";
import SlidersHorizontal from "lucide-solid/icons/sliders-horizontal";
import { createSignal, For, Show, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { useBackDismiss } from "../chrome/backStack";
import { isCompact } from "../media";
import type { SettingsCtx } from "./ctx";
import type { SettingsCategory, SettingsRegistry } from "./registry";
import { CategoryPane } from "./SettingsView";

/**
 * THE SETTINGS BROWSER — a two-level nav (This-device/Server-settings tabs,
 * then a category rail/drilled list); nothing here names a feature, every
 * list is derived from the ONE registry. See docs/architecture/settings-browser.md.
 */
// MODULE scope on purpose: the settings body is torn down on close
// (Sidebar.tsx), so a component-scoped signal would forget the open tab and
// category every time the modal shut. Not persisted across app sessions.
const [tab, setTab] = createSignal<"device" | "server">("device");
/** The last-open category per group. `null` = none chosen — on a phone that is
 * the list screen; on the desktop the rail falls back to the first category. */
const [openDevice, setOpenDevice] = createSignal<string | null>(null);
const [openBoat, setOpenBoat] = createSignal<string | null>(null);

/** Jump the open settings surface to one category — a cross-link from one
 * pane to another (e.g. Vessels → the boat's Collision alarm). */
export function openSettingsCategory(group: "device" | "server", id: string): void {
  setTab(group);
  if (group === "device") setOpenDevice(id);
  else setOpenBoat(id);
}

const SettingsBrowser: Component<{
  reg: SettingsRegistry<SettingsCtx>;
  ctx: SettingsCtx;
  /** Is the boat's server unreachable? While it is, the server rail is
   * hidden — one explanation beats nine empty panes. A BOOLEAN accessor
   * (not JSX) so the explanation component isn't remounted on every state
   * change, including the one its own Retry button causes. */
  boatBlocked?: () => boolean;
  /** What to say while blocked (`ServerSettings.tsx` `Offline`, or a loading line). */
  boatNotice?: Component;
}> = (props) => {
  const openIn = (group: "device" | "server") => (group === "device" ? openDevice() : openBoat());
  const setOpenIn = (group: "device" | "server", id: string | null) =>
    group === "device" ? setOpenDevice(id) : setOpenBoat(id);

  const categories = (group: "device" | "server") => props.reg.categoriesIn(group);
  /** The category whose pane is showing, or undefined for the phone's list. */
  const current = (group: "device" | "server"): SettingsCategory | undefined => {
    const list = categories(group);
    const id = openIn(group);
    const found = id ? list.find((c) => c.id === id) : undefined;
    if (found) return found;
    return isCompact() ? undefined : list[0];
  };

  // On a phone the drilled-into category is its own dismissible layer: Back
  // returns to the category list before closing the whole surface (LIFO —
  // the shell's own layer was registered first).
  useBackDismiss(
    () => isCompact() && current(tab()) !== undefined,
    () => setOpenIn(tab(), null),
  );

  // On a phone the Sheet's own body must STAY the scroller: its
  // swipe-to-dismiss hands off to scroll only when that body is at its top
  // (chrome/gesture.ts `bindBody`), so a nested scroll container here would
  // turn every downward drag over a scrolled pane into a dismiss. `fill`'s
  // flex-height chain is desktop-only for this reason.
  const fill = () => (isCompact() ? "flex flex-col" : "flex min-h-0 flex-1 flex-col");

  return (
    <Tabs value={tab()} onChange={(v) => setTab(v as "device" | "server")} class={fill()}>
      <Tabs.List class="sticky top-0 z-10 flex shrink-0 gap-1 border-b border-line-2 bg-chrome px-2">
        <Trigger value="device" label="This device" />
        <Trigger value="server" label="Server settings" />
      </Tabs.List>

      <Tabs.Content value="device" class={fill()}>
        <Group
          group="device"
          note="Kept in this browser. Other screens aboard keep their own."
          categories={categories("device")}
          current={current("device")}
          onOpen={(id) => setOpenIn("device", id)}
          reg={props.reg}
          ctx={props.ctx}
        />
      </Tabs.Content>

      <Tabs.Content value="server" class={fill()}>
        <Show
          when={props.boatBlocked?.()}
          fallback={
            <Group
              group="server"
              note="Shared by every device. Changes apply to the boat immediately."
              categories={categories("server")}
              current={current("server")}
              onOpen={(id) => setOpenIn("server", id)}
              reg={props.reg}
              ctx={props.ctx}
            />
          }
        >
          <div class="p-4">
            <Show when={props.boatNotice}>{(notice) => <Dynamic component={notice()} />}</Show>
          </div>
        </Show>
      </Tabs.Content>
    </Tabs>
  );
};

export default SettingsBrowser;

/** One tab — the top-level split, and the whole of what the old grey/amber group
 * rail used to say. Selected state is Kobalte's `data-[selected]`. */
const Trigger: Component<{ value: string; label: string }> = (props) => (
  <Tabs.Trigger
    value={props.value}
    class="-mb-px cursor-pointer border-b-2 border-transparent px-3 py-2 font-medium text-fg-2 focus-ring hover:text-fg data-[selected]:border-accent data-[selected]:text-accent"
  >
    {props.label}
  </Tabs.Trigger>
);

/**
 * One group's navigation: master/detail on the desktop (a rail beside a pane),
 * an iOS-Settings-style stack on a phone (a list that drills into a screen with
 * a back affordance). Both drive the same `current` category.
 */
const Group: Component<{
  group: "device" | "server";
  note: string;
  categories: readonly SettingsCategory[];
  current: SettingsCategory | undefined;
  onOpen: (id: string | null) => void;
  reg: SettingsRegistry<SettingsCtx>;
  ctx: SettingsCtx;
}> = (props) => (
  <Show
    when={isCompact()}
    fallback={
      <div class="flex min-h-0 flex-1">
        <nav
          aria-label={`${props.group === "device" ? "This device" : "Server settings"} categories`}
          class="w-56 shrink-0 overflow-y-auto border-r border-line-2 p-2"
        >
          <p class="px-2 pb-2 text-xs text-fg-3">{props.note}</p>
          <For each={props.categories}>
            {(cat) => (
              <RailItem
                cat={cat}
                selected={props.current?.id === cat.id}
                onSelect={() => props.onOpen(cat.id)}
              />
            )}
          </For>
        </nav>
        <div class="min-w-0 flex-1 overflow-y-auto p-4">
          <Show when={props.current}>
            {(cat) => <Pane cat={cat()} reg={props.reg} ctx={props.ctx} />}
          </Show>
        </div>
      </div>
    }
  >
    <Show
      when={props.current}
      fallback={
        <div class="p-2">
          <p class="px-2 pb-2 text-xs text-fg-3">{props.note}</p>
          <ul class="divide-y divide-line-2">
            <For each={props.categories}>
              {(cat) => (
                <li>
                  <button
                    type="button"
                    class="flex min-h-11 w-full cursor-pointer items-center gap-3 px-2 text-left active:bg-chrome-2"
                    onClick={() => props.onOpen(cat.id)}
                  >
                    <Dynamic
                      component={cat.icon ?? SlidersHorizontal}
                      size={18}
                      aria-hidden="true"
                      class="shrink-0 text-fg-2"
                    />
                    <span class="flex-1 font-medium">{cat.title}</span>
                    <ChevronRight size={16} aria-hidden="true" class="shrink-0 text-fg-3" />
                  </button>
                </li>
              )}
            </For>
          </ul>
        </div>
      }
    >
      {(cat) => (
        <div>
          <button
            type="button"
            // NOT sticky: the tab list above already is, and on a phone both
            // share the sheet body as their scroll container — two stickies at
            // top-0 would have the later one paint over the tabs.
            class="flex min-h-11 w-full cursor-pointer items-center gap-1 border-b border-line-2 px-2 text-left font-medium active:bg-chrome-2"
            onClick={() => props.onOpen(null)}
          >
            <ChevronLeft size={18} aria-hidden="true" class="shrink-0 text-fg-2" />
            <span>Back</span>
          </button>
          <div class="p-4">
            <Pane cat={cat()} reg={props.reg} ctx={props.ctx} />
          </div>
        </div>
      )}
    </Show>
  </Show>
);

/** One rail row — icon, label, selected state. A category with no icon of its own
 * (one SYNTHESIZED from a render-only section, which carries none) falls back to
 * the generic knobs glyph rather than leaving a hole in the rail. */
const RailItem: Component<{
  cat: SettingsCategory;
  selected: boolean;
  onSelect: () => void;
}> = (props) => (
  <button
    type="button"
    aria-current={props.selected ? "true" : undefined}
    onClick={() => props.onSelect()}
    class="flex min-h-9 w-full cursor-pointer items-center gap-2 rounded px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent pointer-coarse:min-h-11"
    classList={{
      "bg-chrome-2 font-medium text-fg": props.selected,
      "text-fg-2 hover:bg-chrome-2/60": !props.selected,
    }}
  >
    <Dynamic
      component={props.cat.icon ?? SlidersHorizontal}
      size={16}
      aria-hidden="true"
      class="shrink-0"
    />
    <span class="flex-1 truncate">{props.cat.title}</span>
  </button>
);

/** The pane heading — the category's title and its one line of what-this-is —
 * then its sections. The heading lives HERE rather than inside each section, so a
 * one-section pane does not say its own name twice. */
const Pane: Component<{
  cat: SettingsCategory;
  reg: SettingsRegistry<SettingsCtx>;
  ctx: SettingsCtx;
}> = (props) => (
  <div class="space-y-4">
    <div>
      <h2 class="flex items-center gap-2 text-base font-semibold">
        <Dynamic
          component={props.cat.icon ?? SlidersHorizontal}
          size={18}
          aria-hidden="true"
          class="shrink-0 text-fg-2"
        />
        <span>{props.cat.title}</span>
      </h2>
      <Show when={props.cat.blurb}>
        {(blurb) => <p class="mt-1 text-xs text-fg-2">{blurb()}</p>}
      </Show>
    </div>
    <CategoryPane reg={props.reg} category={props.cat} ctx={props.ctx} />
  </div>
);
