// The dashboard's EDIT surface, split out of Dashboard.tsx (which keeps the
// read-only board/tablist/carousel). Prop-drilled with no shared mutable
// state: every writer is a pure `ChromeConfig → ChromeConfig` via `onChrome`.

import { Popover } from "@kobalte/core/popover";
import Check from "lucide-solid/icons/check";
import ChevronLeft from "lucide-solid/icons/chevron-left";
import ChevronRight from "lucide-solid/icons/chevron-right";
import Copy from "lucide-solid/icons/copy";
import GripVertical from "lucide-solid/icons/grip-vertical";
import LayoutIcon from "lucide-solid/icons/layout-panel-left";
import Pencil from "lucide-solid/icons/pencil";
import Plus from "lucide-solid/icons/plus";
import Trash2 from "lucide-solid/icons/trash-2";
import X from "lucide-solid/icons/x";
import {
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
  type Accessor,
  type Component,
  type JSX,
} from "solid-js";
import { isCompact } from "../media";
import { modalSheetMount } from "./Sheet";
import { fitsRoom, hiddenNow, targetRoom } from "./bands";
import { fetchSignalKPaths, type SkPath } from "../signalk";
import {
  addWidgetToTarget,
  applyArrangement,
  arrangementFromChrome,
  mintWidgetToTarget,
  moveTab,
  RAIL_TARGET,
  removeWidget,
  removeTab,
  removeWidgetFromTarget,
  TOP_TARGET,
  updateWidget,
  type ChromeConfig,
  type ChromeUpdater,
  type DashboardTab,
  type WidgetSpec,
} from "./config";
import { createLayouts, layoutNameError, type Layout } from "../profiles";
import { WidgetCell } from "./WidgetCell";
import { Button, IconButton } from "../ui/Button";
import { readablePath } from "./skWidget";
import { UnitPicker } from "./UnitPicker";
import { guardDragScroll, type DragStartOpts } from "./dashboardDnd";
import { createWidgetRegistry, type SpecField, type Widget, type WidgetRegistry } from "./widget";
import { SK_WIDGET, WIDGETS } from "./widgets";
import type { Density, Instrument, Registry } from "./registry";

/** The widget-KIND registry, indexed once from the module-const descriptor
 * list — picker sources and `EditCard` capabilities derive from it. */
const WIDGET_REG = createWidgetRegistry(WIDGETS);

/** A strip cell's corner-badge control: overrides `iconButtonClass`'s size
 * (hence `!`) — small and round, hung on the cell's corner. */
/** Editor controls are touch targets on a coarse pointer: 44px, not
 * `IconButton`'s 36 (left alone app-wide — other surfaces size their own). */
const TOUCH = "pointer-coarse:size-11";

const BADGE = "size-5! pointer-coarse:size-6! rounded-full! bg-chrome!";

/**
 * Clean a form draft into a stored `WidgetSpec`: optional blank fields are
 * omitted (so the widget derives its default), numbers parse to non-negative
 * ints. Shared by the add and edit forms so they can't diverge.
 */
function cleanSpec(fields: readonly SpecField[], draft: Record<string, string>): WidgetSpec {
  const spec: WidgetSpec = {};
  for (const f of fields) {
    const raw = (draft[f.key] ?? "").trim();
    if (f.type === "number") {
      if (raw === "") continue;
      const n = Number(raw);
      if (Number.isFinite(n)) spec[f.key] = Math.max(0, Math.trunc(n));
    } else if (raw !== "") {
      spec[f.key] = raw;
    } else if (f.required) {
      // Only reached with a never-blank value — caller guards submit.
      continue;
    }
  }
  return spec;
}

/**
 * Generated spec form: renders a widget descriptor's fields and hands back a
 * cleaned `WidgetSpec` on submit. Used for both add-confirm and per-card edit.
 */
const SpecForm: Component<{
  fields: Widget["spec"];
  initial?: WidgetSpec;
  submitLabel: string;
  onSubmit: (spec: WidgetSpec) => void;
  onCancel: () => void;
}> = (props) => {
  const seed: Record<string, string> = {};
  for (const f of props.fields) {
    const v = props.initial?.[f.key] ?? f.default;
    seed[f.key] = v === undefined ? "" : String(v);
  }
  const [draft, setDraft] = createSignal<Record<string, string>>(seed);
  const set = (key: string, value: string): void => {
    setDraft((d) => ({ ...d, [key]: value }));
  };
  const canSubmit = (): boolean => props.fields.every((f) => !f.required || (draft()[f.key] ?? "").trim() !== "");
  const field =
    "rounded border border-line bg-chrome px-2 py-1 font-mono text-[12px] font-normal tracking-normal text-fg outline-none placeholder:text-fg-3 focus:border-accent pointer-coarse:py-2 pointer-coarse:min-h-11 pointer-coarse:min-h-11";
  const lbl = "flex flex-col gap-0.5 font-mono text-[8px] font-bold tracking-[0.08em] text-fg-3";
  return (
    <div class="flex flex-col gap-1.5 px-1.5 py-1">
      <For each={props.fields}>
        {(f) => (
          <label class={lbl}>
            {f.label}
            <Show
              when={f.type === "unit"}
              fallback={
                <input
                  type={f.type === "number" ? "number" : "text"}
                  inputmode={f.type === "number" ? "numeric" : undefined}
                  min={f.type === "number" ? "0" : undefined}
                  value={draft()[f.key] ?? ""}
                  placeholder={f.placeholder}
                  onInput={(e) => set(f.key, e.currentTarget.value)}
                  class={field}
                />
              }
            >
              <UnitPicker
                path={draft()[f.pathKey ?? "path"] ?? ""}
                value={draft()[f.key] ?? ""}
                placeholder={f.placeholder}
                onChange={(v) => set(f.key, v)}
                class={field}
              />
            </Show>
          </label>
        )}
      </For>
      <div class="flex items-center gap-1.5 pt-0.5">
        <button
          type="button"
          disabled={!canSubmit()}
          onClick={() => props.onSubmit(cleanSpec(props.fields, draft()))}
          class="flex flex-1 items-center justify-center gap-1 rounded border border-accent bg-accent px-2 py-1 font-mono text-[11px] font-medium text-accent-fg transition-colors hover:brightness-110 disabled:cursor-default disabled:opacity-40 pointer-coarse:py-2 pointer-coarse:min-h-11 pointer-coarse:min-h-11"
        >
          <Check size={12} aria-hidden="true" /> {props.submitLabel}
        </button>
        <button
          type="button"
          onClick={() => props.onCancel()}
          class="rounded border border-line bg-chrome-2 px-2 py-1 font-mono text-[11px] font-medium text-fg-2 transition-colors hover:border-accent hover:text-accent pointer-coarse:py-2 pointer-coarse:min-h-11 pointer-coarse:min-h-11"
        >
          Cancel
        </button>
      </div>
    </div>
  );
};

/**
 * Per-card edit pencil: opens {@link SpecForm} in a popover. Save writes the
 * cleaned spec and re-runs the kind's `onCommit` (idempotent — a SignalK
 * widget just re-subscribes its path).
 */
const WidgetEditMenu: Component<{
  id: string;
  widget: Widget;
  spec: WidgetSpec;
  onChrome: ChromeUpdater;
  /** Render the trigger as a strip cell's small corner badge. */
  badge?: boolean;
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  let triggerEl: HTMLButtonElement | undefined;
  return (
    <Popover open={open()} onOpenChange={setOpen} placement="bottom-end" gutter={4}>
      <Popover.Trigger
        ref={triggerEl}
        title="Edit this widget"
        aria-label="Edit this widget"
        class={`flex shrink-0 items-center justify-center rounded border border-line bg-chrome-2 text-fg-2 transition-colors hover:border-accent hover:text-accent data-[expanded]:border-accent data-[expanded]:text-accent ${
          props.badge ? "size-5 rounded-full bg-chrome pointer-coarse:size-6" : "size-7 pointer-coarse:size-11"
        }`}
      >
        <Pencil size={props.badge ? 11 : 14} aria-hidden="true" />
      </Popover.Trigger>
      {/* Inside the modal phone sheet when there is one — see `modalSheetMount`. */}
      <Popover.Portal mount={modalSheetMount(triggerEl)}>
        <Popover.Content
          class={`z-50 max-h-[min(70vh,420px)] overscroll-contain overflow-y-auto rounded-[7px] border border-line bg-chrome p-1 ${
            isCompact() ? "w-[calc(100vw-24px)] max-w-[420px]" : "w-[240px]"
          }`}
          style={{ "box-shadow": "0 8px 26px var(--color-shadow)" }}
        >
          <SpecForm
            fields={props.widget.spec}
            initial={props.spec}
            submitLabel="Save"
            onCancel={() => setOpen(false)}
            onSubmit={(spec) => {
              props.onChrome((c) => updateWidget(c, props.id, spec));
              props.widget.onCommit?.(spec);
              setOpen(false);
            }}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  );
};

/**
 * One card in EDIT mode: reorder/move via the board's touch-first drag
 * ({@link createDashboardDrag} — `onDragStart` only starts it, Dashboard.tsx
 * owns the drag state), plus an edit pencil and a remove.
 *
 * Descriptor-driven: a `deletable` widget (a user SignalK path) is fully
 * DELETED (`removeWidget` — no other home for it), everything else is only
 * taken off THIS TAB (`removeWidgetFromTarget`, still exists, re-addable).
 */
export const EditCard: Component<{
  inst: Instrument;
  density: Density;
  /** The TARGET this card belongs to — a dashboard tab id or `RAIL_TARGET`. The
   * remove control and the drag both act on this target uniformly. */
  target: string;
  chrome: Accessor<ChromeConfig>;
  onChrome: ChromeUpdater;
  /** The full widget registry — passed through to the DEFAULT cell so a feature
   * widget's own `render` (the autopilot control set) shows in edit mode too.
   * Unused when `renderCell` overrides the visual. */
  widgetReg?: WidgetRegistry;
  /** Start a drag from this card — the board wires it to its drag. `press`
   * marks a touch on the scrollable card body (long-press to lift). */
  onDragStart: (inst: Instrument, target: string, e: PointerEvent, opts?: DragStartOpts) => void;
  /** Per-widget visual override for the default board `WidgetCell` — the rail
   * strip passes a compact `Tile` renderer. Absent → the board card. */
  renderCell?: () => JSX.Element;
}> = (props) => {
  const stored = () => props.chrome().dashboard.widgets[props.inst.id];
  const widget = (): Widget | undefined => {
    const s = stored();
    // The SAME registry the board's drag-remove consults (Dashboard.tsx
    // `isDeletable`), so the card's controls and the gesture agree on a
    // feature widget; the built-in index only as the no-registry fallback.
    return s ? (props.widgetReg ?? WIDGET_REG).byKind(s.kind) : undefined;
  };
  const editable = () => !!widget()?.editable;
  const deletable = () => !!widget()?.deletable;
  // Two-step confirm only for the permanent, no-undo delete (like
  // ProfilesSection) — a reversible move/remove-from-tab stays single action.
  const [confirmRemove, setConfirmRemove] = createSignal(false);
  // Drag sources (docs/architecture/dashboard-drag.md): a board card has a
  // dedicated GRIP HANDLE (`touch-none`) that lifts on move; the rest of the
  // card stays `pan-y`, so a swipe scrolls the board, and a still long-press
  // anywhere on it lifts too. A mouse drags from anywhere. The compact strip
  // cells (`renderCell`: rail tile, route-band cell) have no room for a grip
  // and rely on the mouse/long-press path alone.
  // `guardDragScroll` cancels the scroll once a long-press has lifted.
  const bindSource = (el: HTMLElement): void => {
    onCleanup(guardDragScroll(el));
  };
  const hasGrip = () => !props.renderCell;
  // Card controls. A BOARD card puts them in a toolbar ROW above the cell
  // (44px on a coarse pointer), so they never cover the widget's label or the
  // body you long-press. A strip cell (rail tile, route-band cell — 36px) has
  // no room: it gets small corner badges hung half OUTSIDE the cell, so they
  // never cover the whole grab area (a full-size × once did, exactly).
  const btn = (): string | undefined => (hasGrip() ? "pointer-coarse:size-11" : BADGE);
  const controls = (): JSX.Element => (
    <>
      <Show when={editable() && stored()}>
        {(s) => (
          <WidgetEditMenu
            id={props.inst.id}
            widget={widget()!}
            spec={s().spec}
            onChrome={props.onChrome}
            badge={!hasGrip()}
          />
        )}
      </Show>
      <Show
        when={deletable()}
        fallback={
          // Instrument/static widget: remove from this target only, not deleted.
          <IconButton
            title="Remove from here"
            class={btn()}
            onClick={() => props.onChrome((c) => removeWidgetFromTarget(c, props.target, props.inst.id))}
          >
            <X size={hasGrip() ? 16 : 12} aria-hidden="true" />
          </IconButton>
        }
      >
        <Show
          when={confirmRemove()}
          fallback={
            <IconButton title="Delete this widget" class={btn()} onClick={() => setConfirmRemove(true)}>
              <Trash2 size={hasGrip() ? 15 : 11} aria-hidden="true" />
            </IconButton>
          }
        >
          <IconButton
            title="Confirm delete this widget"
            class={`border-alarm! text-alarm! ${btn() ?? ""}`}
            onClick={() => props.onChrome((c) => removeWidget(c, props.inst.id))}
          >
            <Check size={hasGrip() ? 15 : 11} aria-hidden="true" />
          </IconButton>
          <IconButton title="Keep widget" class={btn()} onClick={() => setConfirmRemove(false)}>
            <X size={hasGrip() ? 15 : 11} aria-hidden="true" />
          </IconButton>
        </Show>
      </Show>
    </>
  );
  // Outline not border, so it marks "editable" without changing the footprint.
  return (
    <div
      ref={bindSource}
      // Latches the SHEET's touch machine out (../gesture.ts `begin`), so a
      // press here never drags the board sheet itself.
      data-no-drag
      title="Drag to reorder — or onto another tab, the rail, or the remove bar to take it off"
      onPointerDown={(e) => props.onDragStart(props.inst, props.target, e, { press: true })}
      // A long-press would otherwise raise the browser's context menu/callout.
      onContextMenu={(e) => e.preventDefault()}
      class="relative isolate cursor-grab touch-pan-y select-none rounded outline-dashed outline-1 outline-offset-2 outline-line [-webkit-touch-callout:none] active:cursor-grabbing"
    >
      <Show when={hasGrip()}>
        <div
          class="flex items-center gap-1 pb-1"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            aria-label="Drag to move"
            title="Drag to move"
            onPointerDown={(e) => {
              e.stopPropagation();
              props.onDragStart(props.inst, props.target, e);
            }}
            class="flex size-7 shrink-0 touch-none items-center justify-center rounded border border-line bg-chrome-2 text-fg-2 cursor-grab active:cursor-grabbing hover:border-accent hover:text-accent pointer-coarse:size-11"
          >
            <GripVertical size={15} aria-hidden="true" />
          </button>
          {/* Fills the row between grip and buttons — part of the card
              body, so a long-press here lifts too. */}
          <span
            class="min-w-0 flex-1 truncate font-mono text-[8px] font-bold tracking-[0.08em] text-fg-3"
            onPointerDown={(e) => {
              e.stopPropagation();
              props.onDragStart(props.inst, props.target, e, { press: true });
            }}
          >
            <Show when={hiddenNow(props.inst)}>
              <span title="Hidden on the board right now — it shows only while its feature is active (e.g. following a route)">
                HIDDEN NOW
              </span>
            </Show>
          </span>
          {controls()}
        </div>
      </Show>
      {/* The live cell is DISPLAY ONLY while editing: `inert` + no pointer
          events, so grabbing a card can never press a control inside it (the
          autopilot widget's buttons send real commands). */}
      <div inert class="pointer-events-none" classList={{ "opacity-45": hiddenNow(props.inst) }}>
        <Show
          when={props.renderCell}
          fallback={
            <WidgetCell
              inst={props.inst}
              density={props.density}
              chrome={props.chrome}
              widgetReg={props.widgetReg}
            />
          }
        >
          {(rc) => rc()()}
        </Show>
      </div>
      <Show when={!hasGrip()}>
        <div
          class="absolute -right-1.5 -top-1.5 z-[1] flex items-center gap-0.5"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {controls()}
        </div>
      </Show>
    </div>
  );
};

/**
 * The add-widget picker. `PICK_SOURCES` today has just `INSTRUMENT_SOURCE`;
 * DE-E's seam ("add a SignalK path as a widget") appends a second
 * {@link PickSource} whose `body` is a combo over {@link PickCtx} — the
 * popover frame, section headers and added/addable affordance need no change.
 */
interface PickCtx {
  reg: Registry;
  /** The tab being edited. Read lazily so a source re-renders as cards land. */
  tab: DashboardTab;
  chrome: Accessor<ChromeConfig>;
  /** Device fact, not the size slider (#DENS-SLIDER, see registry.ts's
   * Density doc) — hides a `desktopOnly` reading a gloved device can't reach. */
  pointerCoarse: boolean;
  isAdded: (widgetId: string) => boolean;
  /** ROOM guard: a strip-only band (`top`) refuses a `needsRoom:"board"`
   * widget, so the picker never offers a placement that would never render. */
  fits: (inst: Instrument) => boolean;
  /** Place an existing id (instrument or static widget) on the current tab;
   * the picker stays open. */
  add: (widgetId: string) => void;
  /** Mint a parameterized instance from `spec`, seat it, and run `onCommit`
   * (e.g. subscribe a SignalK path) — one capability for any future kind. */
  addInstance: (w: Widget, spec: WidgetSpec) => void;
  enumeratePaths: () => Promise<SkPath[]>;
}

interface PickSource {
  id: string;
  label: string;
  body: (ctx: PickCtx) => JSX.Element;
}

/** A widget KIND's custom picker body, keyed by `Widget.id`. Default is the
 * generated {@link SpecForm}; a kind without an entry here gets that for free. */
const CUSTOM_PICK_BODIES: Record<string, (ctx: PickCtx, widget: Widget) => JSX.Element> = {
  sk: (ctx) => <SkPickBody ctx={ctx} />,
};

/** One pickable row. Label is never truncated (`whitespace-nowrap`, no
 * `min-w-0`) — the popover (`w-max`, capped) widens to fit the longest path
 * instead of clipping it. */
const PickRow: Component<{
  label: string;
  added: boolean;
  onAdd: () => void;
}> = (props) => (
  <button
    type="button"
    disabled={props.added}
    onClick={props.onAdd}
    class="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[13px] text-fg-2 transition-colors hover:bg-chrome-2 hover:text-fg disabled:cursor-default disabled:text-fg-3 disabled:hover:bg-transparent pointer-coarse:py-2.5 pointer-coarse:min-h-11"
  >
    <span class="flex-1 whitespace-nowrap">{props.label}</span>
    <Show
      when={props.added}
      fallback={<Plus size={13} aria-hidden="true" class="shrink-0 text-fg-3" />}
    >
      <Check size={13} aria-hidden="true" class="shrink-0 text-accent" />
    </Show>
  </button>
);

/** Every registry instrument, grouped by contributing feature (same order the
 * rail seeds). Drops `desktopOnly` readings when `pointerCoarse` — offering
 * one would be offering a lie (`bands.configurable`'s reasoning). */
const INSTRUMENT_SOURCE: PickSource = {
  id: "instruments",
  label: "Instruments",
  body: (ctx) => (
    <>
      <For each={ctx.reg.features}>
        {(f) => {
          const items = () =>
            (f.instruments ?? [])
              .filter((i) => !(i.desktopOnly && ctx.pointerCoarse))
              .filter((i) => ctx.fits(i));
          return (
            <Show when={items().length > 0}>
              <div class="px-2 pb-0.5 pt-1 font-mono text-[8px] font-bold tracking-[0.08em] text-fg-3">
                {f.id.toUpperCase()}
              </div>
              <For each={items()}>
                {(inst) => (
                  <PickRow
                    label={inst.label}
                    added={ctx.isAdded(inst.id)}
                    onAdd={() => ctx.add(inst.id)}
                  />
                )}
              </For>
            </Show>
          );
        }}
      </For>
      {/* Static widget kinds — placed by id like an instrument, no minting. */}
      <For each={WIDGET_REG.statics}>
        {(w) => (
          <PickRow label={w.label} added={ctx.isAdded(w.id)} onAdd={() => ctx.add(w.id)} />
        )}
      </For>
    </>
  ),
};

/**
 * DE-E's SignalK-path source body: a searchable combo, resolving to `[]` when
 * SignalK is unreachable (degrades to pure freeform, never errors). The
 * search box doubles as the freeform field, so an unreported path still gets
 * a widget. Selecting opens a label/unit confirm, then `ctx.addInstance`.
 */
const SkPickBody: Component<{ ctx: PickCtx }> = (props) => {
  const [query, setQuery] = createSignal("");
  const [paths] = createResource(() => props.ctx.enumeratePaths());
  const [pending, setPending] = createSignal<{ path: string; label: string; unit: string; si?: string } | null>(
    null,
  );

  const hasPath = (path: string): boolean =>
    props.ctx.tab.order.some((id) => {
      const w = props.ctx.chrome().dashboard.widgets[id];
      return w?.kind === "sk" && w.spec.path === path;
    });

  const matches = (): SkPath[] => {
    const q = query().trim().toLowerCase();
    const all = paths() ?? [];
    const list = q === "" ? all : all.filter((p) => p.path.toLowerCase().includes(q));
    return list.slice(0, 50); // bound the drawn list; refine by typing
  };
  const freeform = (): string | null => {
    const q = query().trim();
    if (q === "" || (paths() ?? []).some((p) => p.path === q)) return null;
    return q;
  };

  const choose = (path: string, units?: string): void => {
    // Unit starts blank = the quantity's default display unit (kn, °C...);
    // `si` only tells the picker which units are valid.
    setPending({ path, label: readablePath(path), unit: "", si: units });
  };

  const confirm = (): void => {
    const p = pending();
    if (!p) return;
    const spec: WidgetSpec = { path: p.path };
    if (p.label.trim() !== "") spec.label = p.label.trim();
    if (p.unit.trim() !== "") spec.unit = p.unit.trim();
    props.ctx.addInstance(SK_WIDGET, spec);
    setPending(null);
    setQuery("");
  };

  return (
    <Show
      when={!pending()}
      fallback={
        <div class="flex flex-col gap-1.5 px-1.5 py-1">
          <div
            class="overflow-x-auto overscroll-x-contain whitespace-nowrap font-mono text-[9px] text-fg-3"
            title={pending()!.path}
          >
            {pending()!.path}
          </div>
          <label class="flex flex-col gap-0.5 font-mono text-[8px] font-bold tracking-[0.08em] text-fg-3">
            LABEL
            <input
              type="text"
              value={pending()!.label}
              onInput={(e) => setPending((s) => s && { ...s, label: e.currentTarget.value })}
              class="rounded border border-line bg-chrome px-2 py-1 font-mono text-[12px] font-normal tracking-normal text-fg outline-none focus:border-accent pointer-coarse:py-2 pointer-coarse:min-h-11 pointer-coarse:min-h-11"
            />
          </label>
          <label class="flex flex-col gap-0.5 font-mono text-[8px] font-bold tracking-[0.08em] text-fg-3">
            UNIT
            <UnitPicker
              path={pending()!.path}
              siUnits={pending()!.si}
              value={pending()!.unit}
              placeholder="(from SignalK)"
              onChange={(v) => setPending((s) => s && { ...s, unit: v })}
              class="rounded border border-line bg-chrome px-2 py-1 font-mono text-[12px] font-normal tracking-normal text-fg outline-none placeholder:text-fg-3 focus:border-accent pointer-coarse:py-2 pointer-coarse:min-h-11 pointer-coarse:min-h-11"
            />
          </label>
          <div class="flex items-center gap-1.5 pt-0.5">
            <button
              type="button"
              onClick={confirm}
              class="flex flex-1 items-center justify-center gap-1 rounded border border-accent bg-accent px-2 py-1 font-mono text-[11px] font-medium text-accent-fg transition-colors hover:brightness-110 pointer-coarse:py-2 pointer-coarse:min-h-11 pointer-coarse:min-h-11"
            >
              <Plus size={12} aria-hidden="true" /> Add
            </button>
            <button
              type="button"
              onClick={() => setPending(null)}
              class="rounded border border-line bg-chrome-2 px-2 py-1 font-mono text-[11px] font-medium text-fg-2 transition-colors hover:border-accent hover:text-accent pointer-coarse:py-2 pointer-coarse:min-h-11 pointer-coarse:min-h-11"
            >
              Back
            </button>
          </div>
        </div>
      }
    >
      <div class="px-1.5 pb-1 pt-0.5">
        <input
          type="text"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          placeholder="Search or type a path…"
          class="w-full rounded border border-line bg-chrome px-2 py-1 font-mono text-[12px] text-fg outline-none placeholder:text-fg-3 focus:border-accent pointer-coarse:py-2 pointer-coarse:min-h-11 pointer-coarse:min-h-11"
        />
      </div>
      <Show when={paths.loading}>
        <div class="px-2.5 py-1.5 font-mono text-[10px] text-fg-3">Loading paths…</div>
      </Show>
      <For each={matches()}>
        {(p) => (
          <PickRow
            label={p.units ? `${p.path}  ·  ${p.units}` : p.path}
            added={hasPath(p.path)}
            onAdd={() => choose(p.path, p.units)}
          />
        )}
      </For>
      <Show when={freeform()}>
        {(q) => (
          <button
            type="button"
            onClick={() => choose(q())}
            class="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[13px] text-accent transition-colors hover:bg-chrome-2 pointer-coarse:py-2.5 pointer-coarse:min-h-11"
          >
            <Plus size={13} aria-hidden="true" class="shrink-0" />
            <span class="min-w-0 flex-1 truncate">
              Use “{q()}”
            </span>
          </button>
        )}
      </Show>
      <Show when={!paths.loading && matches().length === 0 && !freeform()}>
        <div class="px-2.5 py-1.5 font-mono text-[10px] text-fg-3">
          No SignalK paths — type one above to add it anyway.
        </div>
      </Show>
    </Show>
  );
};

/** Generated add body for a parameterized widget without a custom picker —
 * mints the instance on Add via `ctx.addInstance`. */
const GeneratedAddBody: Component<{ widget: Widget; ctx: PickCtx }> = (props) => (
  <SpecForm
    fields={props.widget.spec}
    submitLabel="Add"
    onCancel={() => {}}
    onSubmit={(spec) => props.ctx.addInstance(props.widget, spec)}
  />
);

/**
 * A picker source for one parameterized widget KIND — its custom body when it
 * has registered one ({@link CUSTOM_PICK_BODIES}), else the generated form.
 */
const paramSource = (w: Widget): PickSource => ({
  id: w.id,
  label: w.label,
  body: (ctx) => CUSTOM_PICK_BODIES[w.id]?.(ctx, w) ?? <GeneratedAddBody widget={w} ctx={ctx} />,
});

/** The picker's sources: instruments, then one per registered parameterized
 * widget kind. Static kinds are offered inside the instrument source. */
const PICK_SOURCES: readonly PickSource[] = [
  INSTRUMENT_SOURCE,
  ...WIDGET_REG.parameterized.map(paramSource),
];

/** The add-widget picker — a portaled Popover (escapes the board's
 * `overflow-clip`) listing every {@link PickSource} as its own section;
 * the section label only shows when there's more than one source. */
const AddWidgetMenu: Component<{
  reg: Registry;
  tab: DashboardTab;
  pointerCoarse: boolean;
  chrome: Accessor<ChromeConfig>;
  onChrome: ChromeUpdater;
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  const ctx = (): PickCtx => ({
    reg: props.reg,
    get tab() {
      return props.tab;
    },
    chrome: props.chrome,
    pointerCoarse: props.pointerCoarse,
    isAdded: (id) => props.tab.order.includes(id),
    fits: (inst) => fitsRoom(inst, targetRoom(props.tab.id)),
    add: (id) => props.onChrome((c) => addWidgetToTarget(c, props.tab.id, id)),
    // Fire-and-forget: a boat that won't take the path just shows a dash.
    addInstance: (w, spec) => {
      props.onChrome((c) => mintWidgetToTarget(c, props.tab.id, w.id, w.idPrefix!, spec).cfg);
      w.onCommit?.(spec);
    },
    enumeratePaths: fetchSignalKPaths,
  });
  let triggerEl: HTMLButtonElement | undefined;
  return (
    <Popover open={open()} onOpenChange={setOpen} placement="bottom-end" gutter={4}>
      <Popover.Trigger
        ref={triggerEl}
        title="Add a widget to this tab"
        class="flex shrink-0 items-center gap-1 rounded border border-line bg-chrome px-2 py-1 font-mono text-[11px] font-medium text-fg-2 transition-colors hover:border-accent hover:text-accent data-[expanded]:border-accent data-[expanded]:text-accent pointer-coarse:py-2 pointer-coarse:min-h-11 pointer-coarse:min-h-11"
      >
        <Plus size={13} aria-hidden="true" /> Add widget
      </Popover.Trigger>
      {/* Inside the modal phone sheet when there is one — see `modalSheetMount`. */}
      <Popover.Portal mount={modalSheetMount(triggerEl)}>
        <Popover.Content
          // w-max sizes to the widest row, min/max keep it a menu, not runoff.
          class={`z-50 max-h-[min(60vh,380px)] overscroll-contain w-max min-w-[220px] overflow-y-auto rounded-[7px] border border-line bg-chrome p-1 ${
            isCompact() ? "max-w-[calc(100vw-24px)]" : "max-w-[min(90vw,560px)]"
          }`}
          style={{ "box-shadow": "0 8px 26px var(--color-shadow)" }}
        >
          <For each={PICK_SOURCES}>
            {(src, i) => (
              <div classList={{ "mt-1 border-t border-line pt-1": i() > 0 }}>
                <Show when={PICK_SOURCES.length > 1}>
                  <div class="px-2 pb-0.5 pt-0.5 font-mono text-[9px] font-bold tracking-[0.08em] text-fg-2">
                    {src.label.toUpperCase()}
                  </div>
                </Show>
                {src.body(ctx())}
              </div>
            )}
          </For>
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  );
};

/**
 * Tab-management bar for a CONFIG tab: add-widget and remove-tab. Rename
 * moved onto the tab itself (tap its name in edit mode). The reserved Pilot
 * tab never gets this bar, so it can be neither renamed nor removed
 * (invariant #1) — the caller gates on it.
 */
export const TabEditBar: Component<{
  tab: DashboardTab;
  reg: Registry;
  pointerCoarse: boolean;
  chrome: Accessor<ChromeConfig>;
  canRemove: boolean;
  onChrome: ChromeUpdater;
  onRemoved: () => void;
  /** A BAND target's bar (rail or top): only the add-widget control, since a
   * band is not a config tab and can't be renamed/removed/reordered. */
  band?: boolean;
}> = (props) => {
  const list = () => props.chrome().dashboard.tabs;
  const idx = () => list().findIndex((t) => t.id === props.tab.id);
  // No undo — deletes the tab AND every widget on it — so it arms first.
  const [confirmRemove, setConfirmRemove] = createSignal(false);
  const hint = (): string =>
    props.tab.id === RAIL_TARGET
      ? "The rail strip beside the chart"
      : props.tab.id === TOP_TARGET
        ? "The route band over the chart, while following"
        : "Tap the tab name to rename";
  return (
  <div class="flex items-center gap-2 border-b border-line bg-chrome-2 px-2 py-1.5">
    <Show when={!props.band}>
      <IconButton
        class={TOUCH}
        title="Move tab left"
        disabled={idx() <= 0}
        onClick={() => props.onChrome((c) => moveTab(c, props.tab.id, -1))}
      >
        <ChevronLeft size={16} aria-hidden="true" />
      </IconButton>
      <IconButton
        class={TOUCH}
        title="Move tab right"
        disabled={idx() < 0 || idx() >= list().length - 1}
        onClick={() => props.onChrome((c) => moveTab(c, props.tab.id, 1))}
      >
        <ChevronRight size={16} aria-hidden="true" />
      </IconButton>
    </Show>
    <span class="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-[10px] text-fg-3">
      <Pencil size={12} aria-hidden="true" class="shrink-0" />
      <span class="truncate">{hint()}</span>
    </span>
    <AddWidgetMenu
      reg={props.reg}
      tab={props.tab}
      pointerCoarse={props.pointerCoarse}
      chrome={props.chrome}
      onChrome={props.onChrome}
    />
    <Show when={!props.band && confirmRemove()}
      fallback={
        <Show when={!props.band}>
          <IconButton
            class={TOUCH}
            title={props.canRemove ? "Remove tab" : "The last tab cannot be removed"}
            disabled={!props.canRemove}
            onClick={() => setConfirmRemove(true)}
          >
            <Trash2 size={15} aria-hidden="true" />
          </IconButton>
        </Show>
      }
    >
      <span class="flex shrink-0 items-center gap-1.5">
        <span class="font-mono text-[10px] text-alarm">Delete tab &amp; its widgets?</span>
        <IconButton
          title="Confirm remove tab"
          class={`border-alarm! text-alarm! ${TOUCH}`}
          onClick={() => {
            props.onChrome((c) => removeTab(c, props.tab.id));
            props.onRemoved();
          }}
        >
          <Check size={15} aria-hidden="true" />
        </IconButton>
        <IconButton class={TOUCH} title="Keep tab" onClick={() => setConfirmRemove(false)}>
          <X size={15} aria-hidden="true" />
        </IconButton>
      </span>
    </Show>
  </div>
  );
};

/**
 * The board-wide Layouts bar: save/switch/manage named arrangements. Shown
 * once per board, above the per-tab `TabEditBar` — a layout is the WHOLE
 * `{enabled, bands, dashboard}` slice (`arrangementFromChrome`), not scoped
 * to a tab. Server-stored counterpart of a visual Profile (`../profiles.ts`);
 * a Profile may reference one by name, but this is where one is authored.
 * Two-step confirm on delete/overwrite, same idiom as `ProfilesSection.tsx`.
 */
export const LayoutsBar: Component<{
  reg: Registry;
  chrome: Accessor<ChromeConfig>;
  onChrome: ChromeUpdater;
}> = (props) => {
  const layouts = createLayouts();
  const [name, setName] = createSignal("");
  /** Armed action: name-to-overwrite, `delete:<name>`, or `rename:<name>`. */
  const [confirm, setConfirm] = createSignal("");
  const [renameDraft, setRenameDraft] = createSignal("");

  const trimmed = () => name().trim();
  const exists = () => layouts.layouts().some((l) => l.name === trimmed());
  const nameErr = () => (trimmed() ? layoutNameError(trimmed()) : null);
  const canSave = () => !layouts.busy() && !!trimmed() && !nameErr();

  const saveCurrent = async () => {
    await layouts.save(name(), arrangementFromChrome(props.chrome()));
    setConfirm("");
  };

  // Naming the input after the loaded layout mirrors ProfilesSection's
  // "load, tweak, save back into it" convenience.
  const load = (layout: Layout): void => {
    props.onChrome((c) => applyArrangement(c, layout.arrangement, props.reg));
    setName(layout.name);
  };

  const startRename = (layout: Layout): void => {
    setRenameDraft(layout.name);
    setConfirm(`rename:${layout.name}`);
  };
  const commitRename = async (layout: Layout) => {
    await layouts.rename(layout, renameDraft());
    setConfirm("");
  };

  // First untaken "<name> copy [n]" — no typing needed for the common case.
  const duplicateName = (of: string): string => {
    const taken = new Set(layouts.layouts().map((l) => l.name));
    if (!taken.has(`${of} copy`)) return `${of} copy`;
    for (let n = 2; ; n++) {
      const candidate = `${of} copy ${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  };
  const duplicate = (layout: Layout) => void layouts.duplicate(layout, duplicateName(layout.name));

  const remove = async (layout: Layout) => {
    await layouts.remove(layout);
    setConfirm("");
  };

  return (
    <div class="flex flex-col gap-1.5 border-b border-line bg-chrome-2 px-2 py-1.5">
      <div class="flex items-center gap-1.5">
        <LayoutIcon size={13} aria-hidden="true" class="shrink-0 text-fg-3" />
        <input
          class="w-full rounded border border-line bg-chrome px-2 py-1 font-mono text-[11px] text-fg outline-none focus:border-accent pointer-coarse:py-2 pointer-coarse:min-h-11 pointer-coarse:min-h-11"
          placeholder="Layout name"
          value={name()}
          onInput={(e) => {
            setName(e.currentTarget.value);
            setConfirm("");
          }}
        />
        <Show
          when={exists() && confirm() !== trimmed()}
          fallback={
            <Button
              variant="primary"
              size="sm"
              class="shrink-0 pointer-coarse:min-h-11"
              disabled={!canSave()}
              onClick={() => void saveCurrent()}
            >
              {exists() ? "Replace" : "Save as layout"}
            </Button>
          }
        >
          <Button
            variant="tinted"
            tone="notice"
            size="sm"
            class="shrink-0 pointer-coarse:min-h-11"
            onClick={() => setConfirm(trimmed())}
          >
            Overwrite…
          </Button>
        </Show>
      </div>
      <Show when={nameErr()}>
        <p class="font-mono text-[10px] text-notice">{nameErr()}</p>
      </Show>
      <Show when={layouts.offline()}>
        <p class="font-mono text-[10px] text-notice">
          Layouts live on the boat's server, which is not reachable.
        </p>
      </Show>
      <Show when={layouts.layouts().length > 0}>
        <ul class="flex flex-col gap-1">
          <For each={layouts.layouts()}>
            {(layout) => (
              <li class="flex items-center gap-1.5 rounded border border-line-2 px-1.5 py-1">
                <Show
                  when={confirm() === `rename:${layout.name}`}
                  fallback={
                    <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-fg">
                      {layout.name}
                    </span>
                  }
                >
                  <input
                    ref={(el) => queueMicrotask(() => (el.focus(), el.select()))}
                    class="w-full min-w-0 flex-1 rounded border border-accent bg-chrome px-1.5 py-0.5 font-mono text-[11px] text-fg outline-none pointer-coarse:min-h-11"
                    value={renameDraft()}
                    onInput={(e) => setRenameDraft(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitRename(layout);
                      else if (e.key === "Escape") setConfirm("");
                    }}
                  />
                </Show>
                <Show
                  when={confirm() === `rename:${layout.name}`}
                  fallback={
                    <>
                      <IconButton class={TOUCH} title="Load this layout" onClick={() => load(layout)}>
                        <LayoutIcon size={14} aria-hidden="true" />
                      </IconButton>
                      <IconButton class={TOUCH} title="Rename" onClick={() => startRename(layout)}>
                        <Pencil size={14} aria-hidden="true" />
                      </IconButton>
                      <IconButton class={TOUCH} title="Duplicate" onClick={() => duplicate(layout)}>
                        <Copy size={14} aria-hidden="true" />
                      </IconButton>
                      <Show
                        when={confirm() === `delete:${layout.name}`}
                        fallback={
                          <IconButton class={TOUCH} title="Delete" onClick={() => setConfirm(`delete:${layout.name}`)}>
                            <Trash2 size={14} aria-hidden="true" />
                          </IconButton>
                        }
                      >
                        <IconButton
                          title="Confirm delete"
                          class={`border-alarm! text-alarm! ${TOUCH}`}
                          onClick={() => void remove(layout)}
                        >
                          <Check size={14} aria-hidden="true" />
                        </IconButton>
                        <IconButton class={TOUCH} title="Cancel" onClick={() => setConfirm("")}>
                          <X size={14} aria-hidden="true" />
                        </IconButton>
                      </Show>
                    </>
                  }
                >
                  <IconButton class={TOUCH} title="Save name" onClick={() => void commitRename(layout)}>
                    <Check size={14} aria-hidden="true" />
                  </IconButton>
                  <IconButton class={TOUCH} title="Cancel" onClick={() => setConfirm("")}>
                    <X size={14} aria-hidden="true" />
                  </IconButton>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={layouts.error()}>
        <p class="font-mono text-[10px] text-alarm">{layouts.error()}</p>
      </Show>
      <Show when={layouts.status()}>
        <p class="font-mono text-[10px] text-ok">{layouts.status()}</p>
      </Show>
    </div>
  );
};
