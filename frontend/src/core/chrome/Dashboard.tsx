import { Tabs } from "@kobalte/core/tabs";
import Check from "lucide-solid/icons/check";
import GripVertical from "lucide-solid/icons/grip-vertical";
import Pencil from "lucide-solid/icons/pencil";
import Plus from "lucide-solid/icons/plus";
import Trash2 from "lucide-solid/icons/trash-2";
import X from "lucide-solid/icons/x";
import {
  createEffect,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  type Accessor,
  type Component,
} from "solid-js";
import { Portal } from "solid-js/web";
import { slideIndexFromScroll } from "../gesture";
import { useBackDismiss } from "./backStack";
import { isCompact, prefersReducedMotion } from "../media";
import { boardTab, targetCards } from "./bands";
import {
  addTab,
  isBandTarget,
  mintTabId,
  moveWidgetInTarget,
  moveWidgetToTarget,
  RAIL_TARGET,
  TOP_TARGET,
  removeWidget,
  removeWidgetFromTarget,
  renameTab,
  type ChromeConfig,
  type ChromeUpdater,
  type DashboardTab,
} from "./config";
import {
  createDashboardDrag,
  dropTargetIndex,
  planDrop,
  reorderSwaps,
  type DashboardDrag,
  type DragStartOpts,
  type DropPlan,
} from "./dashboardDnd";
import { LayoutsBar, TabEditBar } from "./DashboardEditor";
import { modalSheetMount } from "./Sheet";
import { WidgetDropZone } from "./WidgetDropZone";
import { type Instrument, type Registry } from "./registry";
import { WidgetCell } from "./WidgetCell";
import type { WidgetRegistry } from "./widget";

// Card/WidgetCell moved to ./WidgetCell.tsx (a leaf) so DashboardEditor can
// render a cell without importing this file back — breaks the former
// Dashboard↔DashboardEditor cycle. Consumers import them from that leaf.
export type { ChromeUpdater } from "./config";

// The board: `band.rail`, widened (see docs/architecture/chrome-bands.md for
// invariants #4/#7). Renders the SAME LIST as the rail strip, so a tile
// turned off is off in both — except the alarm band: `AlarmStrip` reads
// `alerts(reg)` directly and never consults this config.

export interface DashboardProps {
  reg: Registry;
  chrome: Accessor<ChromeConfig>;
  /** The full widget-KIND registry (built-ins + feature widgets), so a feature
   * widget's own cell `render` is resolved by `WidgetCell`. Absent → the
   * built-in-only fallback. */
  widgetReg?: WidgetRegistry;
  /** Select a specific tab: `{ tab, n }`, `n` a nonce so a repeat request
   * still fires. `defer`red so mount never forces a tab. */
  openTab?: Accessor<{ tab: string; n: number } | undefined>;
  /** Chrome updater (App.tsx `setChrome`); its presence gates the board's
   * EDIT mode — no persist path, no Edit toggle. */
  onChrome?: ChromeUpdater;
  /** Publish this board's drag controller upward so an ancestor (Rail.tsx)
   * can become a direct drop target. Still created/driven here. */
  onDnd?: (dnd: DashboardDrag | undefined) => void;
  /** Publish EDIT state upward so the rail strip renders as an editable
   * drop zone while the board is being edited. */
  onEditing?: (v: boolean) => void;
}

const EmptyNote: Component<{ children: string }> = (props) => (
  <p class="col-span-2 border-l-2 border-accent pl-[7px] font-mono text-[9.5px] leading-[1.5] text-fg-2">
    {props.children}
  </p>
);

/**
 * The board is tabbed (Kobalte `Tabs`, not a hand-rolled tablist — roving
 * focus/arrow-nav/`aria-selected` are the primitive's). Tabs are the
 * registry's pages, contributed one at a time via `defineFeature({ dashboard })`.
 * Each page renders instruments in config order, same registry/config/data
 * as the rail strip — the board is the rail widened, not a second system.
 */
const Dashboard: Component<DashboardProps> = (props) => {
  // EDIT mode: gated on a persist path (`onChrome`) — nothing to save without one.
  const [editing, setEditing] = createSignal(false);
  const canEdit = () => !!props.onChrome;
  // Android/gesture Back exits EDIT mode rather than leaving the app.
  useBackDismiss(editing, () => setEditing(false));

  // In EDIT mode, the RAIL appends as one more synthetic TARGET (backed by
  // `bands.rail.order`) — not a config tab (unrenamable, unremovable), absent
  // in view mode, so the read-only board is unchanged.
  const configTabs = () => props.chrome().dashboard.tabs;
  const railTab = (): DashboardTab => ({
    id: RAIL_TARGET,
    label: "Rail",
    order: [...props.chrome().bands.rail.order],
  });
  // The TOP (route) band, same synthetic-target treatment.
  const topTab = (): DashboardTab => ({
    id: TOP_TARGET,
    label: "Route band",
    order: [...props.chrome().bands.top.order],
  });
  // Synthetic band tabs appear in edit mode only on phone: on a wide screen
  // the rail strip and top band are editable in place (Rail.tsx/TopBand.tsx);
  // on phone the board sheet covers both, so these tabs are the only way in.
  const tabs = (): DashboardTab[] =>
    editing() && isCompact() ? [...configTabs(), railTab(), topTab()] : configTabs();
  const [tab, setTab] = createSignal(tabs()[0]?.id ?? "");

  createEffect(
    on(
      () => props.openTab?.(),
      (req) => {
        if (req && tabs().some((t) => t.id === req.tab)) setTab(req.tab);
      },
      { defer: true },
    ),
  );

  const activeTab = (): DashboardTab | undefined => tabs().find((t) => t.id === tab());
  // Counts config tabs only — the synthetic rail tab must not prop up the
  // count that guards the last real tab from removal.
  const canRemoveActive = () => configTabs().length > 1;

  // A selected synthetic band tab that vanishes from `tabs()` (leaving edit
  // mode, or widening to desktop) falls back to the first config tab.
  createEffect(
    on([editing, isCompact], () => {
      if (isBandTarget(tab()) && !tabs().some((t) => t.id === tab())) {
        setTab(configTabs()[0]?.id ?? "");
      }
    }),
  );

  // Inline tab rename: draft lives in a LOCAL buffer, not config — writing
  // config per keystroke used to remount the controlled input mid-type
  // (focus/cursor lost) and feed keystrokes to Kobalte's typeahead/arrow-nav.
  const [editTabId, setEditTabId] = createSignal<string | null>(null);
  const [draft, setDraft] = createSignal("");
  const startRename = (t: DashboardTab): void => {
    setDraft(t.label);
    setEditTabId(t.id);
  };
  const commitRename = (): void => {
    const id = editTabId();
    if (id) {
      const label = draft().trim();
      // An empty draft just cancels, keeping the old label rather than blanking the tab.
      if (label !== "") props.onChrome?.((c) => renameTab(c, id, label));
    }
    setEditTabId(null);
  };
  const cancelRename = (): void => {
    setEditTabId(null);
  };
  const addBoardTab = (): void => {
    const chrome = props.chrome();
    const id = mintTabId(chrome);
    props.onChrome?.((c) => addTab(c));
    setTab(id); // jump to the tab just minted, so it can be named/filled at once
  };

  // The list the pager scrolls through, mapped both ways to the scroll-snap
  // position (below). Tap, arrow keys and swipe all move the same `tab` state.
  const tabValues = (): string[] => tabs().map((t) => t.id);
  const index = (): number => Math.max(0, tabValues().indexOf(tab()));

  // A card spans both grid columns when its widget descriptor says so (`wide`).
  const isWide = (inst: Instrument): boolean => {
    const reg = props.widgetReg;
    if (!reg) return false;
    const stored = props.chrome().dashboard.widgets[inst.id];
    return !!(stored ? reg.byKind(stored.kind) : reg.staticById(inst.id))?.wide;
  };

  // Drag-and-drop layout editing: drag a card's handle to reorder, onto a
  // tab header to move it, or onto the remove bar. Drag state lives in
  // `createDashboardDrag`; every commit is a pure config writer from `planDrop`.
  // Ghost label is derived from the dragged id via the registry, not a signal
  // set at drag start, so a drag begun from the rail strip (which shares this
  // controller but has no board-local signal) still labels it.
  const draggedLabel = (): string => {
    const id = dnd.draggingId();
    return id ? props.reg.byId(id)?.label ?? "" : "";
  };
  // A dropped deletable widget arms the repo's two-step confirm rather than
  // being deleted by the gesture.
  const [pendingDelete, setPendingDelete] = createSignal<string | null>(null);
  // An armed delete never outlives edit mode (Done, Back, closing the sheet).
  createEffect(on(editing, (v) => !v && setPendingDelete(null), { defer: true }));

  const visibleIdsIn = (cfg: ChromeConfig, target: string): string[] =>
    targetCards(props.reg, cfg, target).map((i) => i.id);
  const isDeletable = (id: string): boolean => {
    const reg = props.widgetReg;
    if (!reg) return false;
    const stored = props.chrome().dashboard.widgets[id];
    return !!(stored ? reg.byKind(stored.kind) : reg.staticById(id))?.deletable;
  };

  // `originTarget` keeps the move writer origin-aware so a tab→tab move
  // never disturbs the rail (and vice versa).
  const execPlan = (plan: DropPlan, originTarget: string): void => {
    const onChrome = props.onChrome;
    if (!onChrome) return;
    switch (plan.kind) {
      case "none":
        return;
      case "reorder":
        onChrome((c) => plan.swaps.reduce((cfg, [a, b]) => moveWidgetInTarget(cfg, plan.tabId, a, b), c));
        return;
      case "toTab":
        onChrome((c) => moveWidgetToTarget(c, plan.id, originTarget, plan.toTabId));
        return;
      case "toTabAt":
        // Move it onto the target (appended), then bubble it to the drop gap —
        // the same swap sequence a same-target reorder uses, on the post-move order.
        onChrome((c) => {
          const moved = moveWidgetToTarget(c, plan.id, originTarget, plan.toTabId);
          const ids = visibleIdsIn(moved, plan.toTabId);
          const from = ids.indexOf(plan.id);
          const swaps = reorderSwaps(ids, from, dropTargetIndex(from, plan.gap));
          return swaps.reduce((cfg, [a, b]) => moveWidgetInTarget(cfg, plan.toTabId, a, b), moved);
        });
        return;
      case "removeFromTab":
        onChrome((c) => removeWidgetFromTarget(c, plan.tabId, plan.id));
        return;
      case "confirmDelete":
        setPendingDelete(plan.id);
        return;
    }
  };

  const dnd = createDashboardDrag({
    activeTab: tab,
    setActiveTab: setTab,
    onEnd: (f) =>
      execPlan(
        planDrop({
          id: f.id,
          originTab: f.originTab,
          overRemove: f.overRemove,
          overTab: f.overTab,
          overGrid: f.overGrid,
          deletable: isDeletable(f.id),
          gap: f.gap,
          // Reorder is by drawn index in the zone UNDER THE POINTER, not the
          // shown tab; falls back to origin when over no grid.
          visibleIds: visibleIdsIn(props.chrome(), f.overGrid ?? f.originTab),
        }),
        f.originTab,
      ),
  });
  const startCardDrag = (
    inst: Instrument,
    target: string,
    e: PointerEvent,
    opts?: DragStartOpts,
  ): void => {
    dnd.start(inst.id, target, e, opts);
  };
  onMount(() => props.onDnd?.(dnd));
  onCleanup(() => props.onDnd?.(undefined));
  createEffect(on(editing, (v) => props.onEditing?.(v)));
  onCleanup(() => props.onEditing?.(false));

  // Tab swipe on phone: native CSS scroll-snap pager (../info/HitCarousel.tsx),
  // so the browser arbitrates the axis — no preventDefault/velocity math racing it.
  let viewportEl: HTMLElement | undefined;
  // The board's root, to find the modal phone sheet it lives in (if any).
  let rootEl: HTMLElement | undefined;
  // The sideways-scrolling tab strip: keep the selected tab in view.
  createEffect(() => {
    const id = tab();
    editing();
    queueMicrotask(() => {
      const strip = rootEl?.querySelector<HTMLElement>("[role=tablist]");
      if (!strip) return;
      const el = strip.querySelector<HTMLElement>(`[data-tab-drop="${CSS.escape(id)}"]`);
      if (!el) return;
      const sr = strip.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      if (er.left < sr.left) strip.scrollLeft -= sr.left - er.left + 8;
      else if (er.right > sr.right) strip.scrollLeft += er.right - sr.right + 8;
    });
  });
  const pager = (): boolean => isCompact() && !editing();

  // Slide pitch, measured off two rendered slides so the scroll math tracks
  // the CSS gap without repeating its value.
  const step = (): number => {
    const slides = viewportEl?.children;
    if (!slides || slides.length < 2) return viewportEl?.clientWidth ?? 0;
    return (slides[1] as HTMLElement).offsetLeft - (slides[0] as HTMLElement).offsetLeft;
  };

  // Scroll → index, debounced to the resting slide. Early-out on unchanged
  // value also stops the index→scroll effect below from bouncing back here.
  let settle: ReturnType<typeof setTimeout> | undefined;
  const onScroll = (): void => {
    if (!pager()) return;
    if (settle) clearTimeout(settle);
    settle = setTimeout(() => {
      if (!viewportEl) return;
      const i = slideIndexFromScroll(viewportEl.scrollLeft, step(), tabValues().length);
      const value = tabValues()[i];
      if (value && value !== tab()) setTab(value);
    }, 80);
  };

  // Index → scroll: an external selection change scrolls the slide in.
  // Skipped when already resting there, so a swipe isn't re-scrolled against
  // the finger that just landed it.
  createEffect(() => {
    const i = index();
    const el = viewportEl;
    if (!el || !pager()) return;
    const target = i * step();
    if (Math.abs(el.scrollLeft - target) < 1) return;
    el.scrollTo({ left: target, behavior: "smooth" });
  });

  // The wrapping sheet is content-sized (Panel.tsx), so track the active
  // slide's height and transition to it, or paging snaps the drawer.
  const [contentH, setContentH] = createSignal(0);
  const slideEls = new Map<string, HTMLElement>();
  // In the fixed-height phone sheet the pager must ALSO fill the space below
  // the widgets: a swipe only pages where the scroll-snap viewport is, so a
  // content-tall viewport left everything under a short tab dead to swipes.
  const [fillH, setFillH] = createSignal(0);
  let scrollBody: HTMLElement | undefined;
  const measureActive = (): void => {
    const el = slideEls.get(tab());
    if (el) setContentH(el.offsetHeight);
    const body = scrollBody;
    if (!body || !viewportEl) {
      setFillH(0);
      return;
    }
    const top = viewportEl.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
    const padBottom = parseFloat(getComputedStyle(body).paddingBottom) || 0;
    setFillH(Math.max(0, body.clientHeight - padBottom - top));
  };
  const ro =
    typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => measureActive()) : undefined;
  // Re-measure on tab change; the RO handles in-place content changes.
  createEffect(() => {
    tab();
    measureActive();
  });

  onMount(() => {
    // Only a modal (fixed-height) sheet has room to fill; a content-sized
    // host would just grow to whatever we ask for.
    const sheet = modalSheetMount(rootEl);
    for (let p = viewportEl?.parentElement; sheet && p && p !== sheet; p = p.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) {
        scrollBody = p;
        ro?.observe(p);
        measureActive();
        break;
      }
    }
    // A resize changes the slide pitch, so realign the current slide instantly.
    const onResize = (): void => {
      if (!viewportEl || !pager()) return;
      viewportEl.scrollTo({ left: index() * step() });
    };
    window.addEventListener("resize", onResize);
    onCleanup(() => {
      window.removeEventListener("resize", onResize);
      ro?.disconnect();
      if (settle) clearTimeout(settle);
    });
  });

  return (
    <Show
      when={tabs().length > 0}
      fallback={
        <div class="grid grid-cols-2 p-2">
          <EmptyNote>No dashboard pages in this build.</EmptyNote>
        </div>
      }
    >
      <Tabs ref={(el: HTMLElement) => (rootEl = el)} value={tab()} onChange={setTab}>
        {/* The tab row: the tabs (+ Tab) SCROLL sideways in their own strip,
            and Edit/Done sits OUTSIDE it, always on screen. Five tabs plus
            the edit-mode band tabs used to be 374px in a 328px phone row —
            Done was pushed off-screen and the sheet panned sideways. */}
        <div class="sticky top-0 z-[2] flex items-end border-b border-line bg-chrome">
        <Tabs.List
          class="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overscroll-x-contain px-2 pt-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {/* Keyed by tab ID, not the tab object: a reorder returns a fresh
              `{...t, order}` and an object-keyed For would lose the selection. */}
          <For each={tabValues()}>
            {(id) => {
              const t = () => tabs().find((x) => x.id === id);
              // `armed` snapshots on pointerdown (before Kobalte's click moves
              // `tab()`), so a tap on an inactive tab selects without renaming.
              let armed = false;
              return (
              <Show
                when={editing() && editTabId() === id}
                fallback={
                  <Tabs.Trigger
                    value={id}
                    onPointerDown={() => {
                      // A synthetic band tab (rail, top) is not renamable.
                      armed = editing() && tab() === id && !isBandTarget(id);
                    }}
                    onClick={() => {
                      if (armed && t()) startRename(t()!);
                      armed = false;
                    }}
                    // A drop target while a card is being dragged: dropping here
                    // moves the card onto this tab; a hover-hold switches into it.
                    data-tab-drop={id}
                    class="shrink-0 cursor-pointer whitespace-nowrap rounded-t border-b-2 border-transparent px-2.5 py-1.5 font-mono text-[11px] font-medium text-fg-2 focus-ring hover:text-fg data-[selected]:border-accent data-[selected]:text-accent"
                    classList={{
                      // A tab is a touch target while editing (rename, drop-on).
                      "pointer-coarse:min-h-11 pointer-coarse:min-w-11": editing(),
                      "bg-accent/15 text-accent": !!dnd.draggingId() && dnd.overTab() === id,
                    }}
                  >
                    {t()?.label}
                  </Tabs.Trigger>
                }
              >
                {/* NOT a Tabs.Trigger while editing (<input> in <button> is
                    invalid HTML). `stopPropagation` keeps typing off tab nav. */}
                <input
                  ref={(el) => queueMicrotask(() => (el.focus(), el.select()))}
                  type="text"
                  value={draft()}
                  aria-label="Tab name"
                  onInput={(e) => setDraft(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitRename();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      cancelRename();
                    }
                  }}
                  onKeyUp={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={commitRename}
                  class="w-32 shrink-0 border-b-2 border-accent bg-chrome px-2.5 py-1.5 font-mono text-[11px] font-medium text-fg outline-none pointer-coarse:min-h-11"
                />
              </Show>
              );
            }}
          </For>
        </Tabs.List>
          {/* ＋ Tab: not a Tabs.Trigger, it is an action, not a group — and
              OUTSIDE the tablist: inside it, focusing it made Kobalte's
              roving focus jump to the selected tab, which scrolled the strip
              under the finger so the tap's click landed elsewhere. */}
          <Show when={editing()}>
            <button
              type="button"
              title="Add tab"
              aria-label="Add tab"
              onClick={addBoardTab}
              class="flex shrink-0 items-center gap-0.5 whitespace-nowrap border-b-2 border-transparent px-2 py-1.5 font-mono text-[11px] font-medium text-fg-2 hover:text-accent pointer-coarse:min-h-11"
            >
              <Plus size={13} aria-hidden="true" /> Tab
            </button>
          </Show>
          {/* EDIT toggle, present only when there is a persist path (`onChrome`).
              Outside the scrolling strip, so it can never scroll away. */}
          <Show when={canEdit()}>
            <button
              type="button"
              title={editing() ? "Done editing" : "Edit dashboard"}
              aria-label={editing() ? "Done editing" : "Edit dashboard"}
              aria-pressed={editing()}
              onClick={() => setEditing((e) => !e)}
              class="mx-2 mb-1 flex shrink-0 items-center gap-1 rounded border px-2 py-1 font-mono text-[10px] font-medium transition-colors pointer-coarse:min-h-11 pointer-coarse:px-3"
              classList={{
                "border-accent bg-accent text-accent-fg": editing(),
                "border-line bg-chrome-2 text-fg-2 hover:border-accent hover:text-accent": !editing(),
              }}
            >
              <Show when={editing()} fallback={<Pencil size={12} aria-hidden="true" />}>
                <Check size={12} aria-hidden="true" />
              </Show>
              {editing() ? "Done" : "Edit"}
            </button>
          </Show>
        </div>
        {/* Board-wide: a layout is the whole arrangement, not scoped to one tab. */}
        <Show when={editing() && canEdit()}>
          <LayoutsBar reg={props.reg} chrome={props.chrome} onChrome={props.onChrome!} />
        </Show>
        {/* KEYED on the tab ID (a string, so a config write that only
            reshapes the tab object keeps the bar — and an open Add-widget
            picker — mounted): switching tab must drop the bar's armed
            "delete tab?" confirm, or its ✓ would delete the tab you moved to. */}
        <Show when={editing() && activeTab() ? tab() : undefined} keyed>
          {(_id) => (
            <TabEditBar
              tab={activeTab() ?? { id: _id, label: "", order: [] }}
              reg={props.reg}
              pointerCoarse={props.chrome().pointerCoarse}
              chrome={props.chrome}
              canRemove={canRemoveActive()}
              onChrome={props.onChrome!}
              onRemoved={() => setTab(configTabs()[0]?.id ?? "")}
              band={isBandTarget(_id)}
            />
          )}
        </Show>
        {/* `overflow-y: clip` (not hidden) lets the drawer animate its height
            without becoming a vertical scroll container. */}
        <div
          ref={(el) => (viewportEl = el)}
          onScroll={onScroll}
          class="items-start"
          classList={{
            "flex snap-x snap-mandatory overflow-x-auto overflow-y-clip scroll-smooth touch-pan-x gap-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden":
              pager(),
            "overflow-clip": !pager(),
          }}
          style={{
            // Animate the drawer's height to the active tab's as the swipe
            // settles; snap under reduced motion, as the sheet does (../media.ts).
            height: contentH() > 0 ? `${pager() ? Math.max(contentH(), fillH()) : contentH()}px` : undefined,
            transition: prefersReducedMotion()
              ? "none"
              : "height var(--duration-sheet) var(--ease-sheet)",
          }}
        >
          {/* Keyed by tab ID, same reason as the tablist above. */}
          <For each={tabValues()}>
            {(id) => {
              // `targetCards` resolves a tab OR synthetic band target uniformly;
              // a band target ignores `when`, so the top band's route widgets
              // stay editable with no route followed.
              // EDIT shows every CONFIGURED widget (`targetCards` ignores
              // `when`, so a route reading with no route followed is still
              // there to move/remove); the read-only board hides what is
              // conditionally absent (`boardTab`).
              const cards = () => {
                if (editing()) return targetCards(props.reg, props.chrome(), id);
                const t = configTabs().find((x) => x.id === id);
                return t ? boardTab(props.reg, props.chrome(), t) : [];
              };
              onCleanup(() => slideEls.delete(id));
              return (
                // `forceMount` in pager mode lays out every slide side by side
                // so a swipe can peek its neighbour.
                <Tabs.Content
                  value={id}
                  forceMount={pager() || undefined}
                  ref={(el) => {
                    slideEls.set(id, el);
                    ro?.observe(el);
                  }}
                  class="outline-none"
                  classList={{ "w-full shrink-0 snap-center": pager() }}
                >
                  <Show
                    when={editing()}
                    fallback={
                      <div class="grid grid-cols-2 gap-2 p-2">
                        <For each={cards()}>
                          {(inst) => (
                            // `isolate`: a cell's own stacking (the autopilot
                            // rudder's z-[3]/z-[4]) must not paint over the
                            // sticky z-[2] tab bar as the board scrolls.
                            <div class="isolate" classList={{ "col-span-2": isWide(inst) }}>
                              <WidgetCell
                                inst={inst}
                                density={props.chrome().density}
                                chrome={props.chrome}
                                widgetReg={props.widgetReg}
                              />
                            </div>
                          )}
                        </For>
                        <Show when={cards().length === 0}>
                          <EmptyNote>Every instrument on this tab is turned off for this device.</EmptyNote>
                        </Show>
                      </div>
                    }
                  >
                    {/* Shared drop zone, same component the rail strip renders. */}
                    <WidgetDropZone
                      target={id}
                      items={cards()}
                      dnd={dnd}
                      chrome={props.chrome}
                      onChrome={props.onChrome!}
                      density={props.chrome().density}
                      widgetReg={props.widgetReg}
                      layoutClass="grid grid-cols-2 gap-2 p-2"
                      axis="x"
                      wide={isWide}
                      onDragStart={startCardDrag}
                      empty={
                        <EmptyNote>
                          No widgets on this tab yet — add some with the Add widget button above, or drag one here by its handle from another tab.
                        </EmptyNote>
                      }
                    />
                  </Show>
                </Tabs.Content>
              );
            }}
          </For>
        </div>
        {/* Drag ghost, portaled past the board's `overflow-clip`. Solid bg +
            drop-shadow halo (never blur — project UI rule); pointer-events-none
            so it doesn't block `elementFromPoint`'s hit test underneath. */}
        <Show when={dnd.draggingId() ? dnd.pointer() : null}>
          {(p) => (
            <Portal>
              <div
                class="pointer-events-none fixed z-[60] flex items-center gap-1.5 rounded-md border border-accent bg-chrome-2 px-2.5 py-1.5 font-mono text-[11px] font-medium text-fg"
                style={{
                  left: `${p().x}px`,
                  top: `${p().y}px`,
                  transform: "translate(-50%, -140%) scale(1.02)",
                  "box-shadow": "0 8px 26px var(--color-shadow)",
                }}
              >
                <GripVertical size={13} aria-hidden="true" class="text-accent" />
                <span class="max-w-[180px] truncate">{draggedLabel()}</span>
              </div>
            </Portal>
          )}
        </Show>
        {/* Dropping a re-addable instrument here removes it immediately;
            a deletable widget arms the two-step confirm below instead.
            Body-portaled (fixed to the VIEWPORT, not the transformed sheet),
            so it needs `pointer-events-auto`: a modal sheet sets the body to
            `pointer-events: none`, and `elementFromPoint` (the drag's hit
            test) skips such elements — the drop would never register. On a
            phone it sits at the TOP, over the strip of chart the sheet
            leaves, clear of the board's bottom auto-scroll edge. */}
        <Show when={dnd.draggingId()}>
          <Portal>
            <div
              data-remove-zone
              class="pointer-events-auto fixed inset-x-0 z-[55] mx-auto flex w-max max-w-[90vw] items-center gap-2 rounded-full border px-4 py-2.5 font-mono text-[11px] font-medium transition-colors pointer-coarse:py-3.5"
              classList={{
                "border-alarm bg-alarm/15 text-alarm": dnd.overRemove(),
                "border-line bg-chrome-2 text-fg-2": !dnd.overRemove(),
                "top-[calc(env(safe-area-inset-top)+1rem)]": isCompact(),
                "bottom-4": !isCompact(),
              }}
              style={{ "box-shadow": "0 8px 26px var(--color-shadow)" }}
            >
              <Trash2 size={15} aria-hidden="true" />
              Drop here to remove
            </div>
          </Portal>
        </Show>
        {/* Two-step delete confirm — the repo's destructive-action pattern.
            Mounted INSIDE the modal phone sheet when there is one (a body
            portal is untappable under the dialog, and a tap on it would
            count as outside the dialog) — see `modalSheetMount`. */}
        <Show when={pendingDelete()}>
          {(id) => (
            <Portal mount={modalSheetMount(rootEl)}>
              <div
                class="pointer-events-auto fixed inset-x-0 bottom-4 z-[60] mx-auto flex w-max max-w-[calc(100%-24px)] flex-wrap items-center justify-center gap-2.5 rounded-lg border border-alarm bg-chrome px-4 py-2.5"
                style={{ "box-shadow": "0 8px 26px var(--color-shadow)" }}
              >
                <span class="font-mono text-[11px] text-alarm">Delete this widget? This can’t be undone.</span>
                <button
                  type="button"
                  onClick={() => {
                    props.onChrome?.((c) => removeWidget(c, id()));
                    setPendingDelete(null);
                  }}
                  class="flex items-center gap-1 rounded border border-alarm bg-alarm px-2.5 py-1.5 font-mono text-[11px] font-medium text-accent-fg transition-colors hover:brightness-110 pointer-coarse:min-h-11 pointer-coarse:px-4"
                >
                  <Check size={13} aria-hidden="true" /> Delete
                </button>
                <button
                  type="button"
                  onClick={() => setPendingDelete(null)}
                  class="flex items-center gap-1 rounded border border-line bg-chrome-2 px-2.5 py-1.5 font-mono text-[11px] font-medium text-fg-2 transition-colors hover:border-accent hover:text-accent pointer-coarse:min-h-11 pointer-coarse:px-4"
                >
                  <X size={13} aria-hidden="true" /> Cancel
                </button>
              </div>
            </Portal>
          )}
        </Show>
      </Tabs>
    </Show>
  );
};

export default Dashboard;
