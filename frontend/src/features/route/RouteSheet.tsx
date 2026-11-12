import Anchor from "lucide-solid/icons/anchor";
import ArrowLeftRight from "lucide-solid/icons/arrow-left-right";
import ChevronRight from "lucide-solid/icons/chevron-right";
import GripVertical from "lucide-solid/icons/grip-vertical";
import List from "lucide-solid/icons/list";
import LoaderCircle from "lucide-solid/icons/loader-circle";
import MapPin from "lucide-solid/icons/map-pin";
import Navigation from "lucide-solid/icons/navigation";
import Plus from "lucide-solid/icons/plus";
import X from "lucide-solid/icons/x";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  type Accessor,
  type Component,
  type JSX,
} from "solid-js";
import Sheet from "../../core/chrome/Sheet";
import { railDensity } from "../../core/chrome/rail-density";
import { createSwipeUp } from "../../core/chrome/swipeUp";
import type { Density } from "../../core/chrome/registry";
import { DEFAULT_PLAN_SPEED_KN } from "../../core/routes";
import { isCompact } from "../../core/media";
import type { RoutesModel } from "./index";
import {
  legRows,
  type LegRow,
  parseDatetimeLocal,
  parsePlanSpeed,
  routeSummary,
  stepPlanSpeed,
  toDatetimeLocal,
} from "./planSheet";

// THE PLAN SHEET — the route tool's whole UI: autorouting only, Google-Maps-
// style. A From/Stop/To LIST is the one way to build a route — each slot is
// set by search, "use boat position" (From only), or tapping the chart while
// that slot is explicitly armed ("choose on map"); the segments between slots
// are always the router's own answer (`index.ts`'s `rebuildFromStops`), never
// a hand-drawn line. There is no freeform manual editing left: a plain chart
// tap does nothing route-related unless a slot is armed, and a stop's own
// pin can still be DRAGGED (a real re-plan of its leg(s) on drop, not "move
// the dot, leave a straight line").
//
// It is the SAME `route-edit` mode: the sheet's controls call the model's own
// operations (`features/route/index.ts`), never a parallel routing
// implementation. The mode declares `solo`, which is what hides the helm
// widgets and the pill while this is up (Rail.tsx / ModePill.tsx) — so the
// surface really is just the map, this sheet, and the reserved alarm band.
//
// Persistence is AUTO-SAVE: every edit debounce-persists in the model, so the
// sheet has no Save or Discard. The way out is GO (follow the already-saved
// route) or a plain close (the route is already on the boat); no dirty/discard
// confirm.
//
// Two presentations, the tree's usual split — but they DIFFER in shape:
//
//   * PHONE (#RT-REDRAWER): the resting surface is a fixed bottom BAR styled
//     like the Rail's phone widget panel ({@link RouteBar}) — the route name,
//     the glance metrics as instrument tiles, and GO / Start route. SWIPE UP
//     on it (the SAME {@link createSwipeUp} the dashboard uses) opens the
//     full drawer — {@link SheetSections} — as a MODAL single-detent Sheet,
//     exactly the pattern the dashboard uses.
//
//   * DESKTOP: the existing non-modal `Panel` left edge-drawer (chart still
//     beside it), rendering the peek {@link SheetSummary} above the sections —
//     unchanged.

// ── Shared styles (chrome tokens only) ────────────────────────────────────
const BTN =
  "flex items-center justify-center gap-2 rounded-xl border border-line-2 px-3 py-3 text-[13px] font-semibold text-fg enabled:hover:bg-chrome-2 disabled:opacity-40";
// Solid accent fill (no blur/frosted glass, per UI rule) for "Start route".
const BTN_PRIMARY =
  "flex items-center justify-center gap-2 rounded-xl border border-accent bg-accent px-3 py-3 text-[13px] font-semibold text-accent-fg shadow-sm enabled:hover:brightness-110 disabled:opacity-40";
// Peek top-bar actions: GO closes via saveAndFollow; phone-only X closes via
// exitEditor (desktop uses the Panel's own close X).
const TOPBAR_BTN =
  "shrink-0 rounded-full border px-3.5 py-1.5 text-xs font-semibold pointer-coarse:py-2 disabled:opacity-40";

const SectionLabel: Component<{ children: JSX.Element; trailing?: JSX.Element }> = (props) => (
  <div class="flex items-center gap-2 pt-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-fg-3">
    {props.children}
    <span aria-hidden="true" class="h-px flex-1 bg-line" />
    {props.trailing}
  </div>
);

// ── The From/Stop/To row ──────────────────────────────────────────────────
//
// One tappable row: an icon circle, a small uppercase label over the value,
// a trailing chevron. Used for From, every Stop and To alike — the SAME row
// shape whether it is empty ("Where to?") or set (a real place name), on the
// phone bar and the drawer's full list both.
const FromToRow: Component<{
  icon: JSX.Element;
  label: string;
  value: string;
  placeholder?: boolean;
  onClick: () => void;
}> = (props) => (
  <button
    type="button"
    onClick={props.onClick}
    class="flex flex-1 items-center gap-2.5 py-1.5 pr-2 pl-4 text-left enabled:hover:bg-chrome-2"
  >
    <span class="grid size-7 shrink-0 place-items-center rounded-full bg-chrome-2 text-fg-2">
      {props.icon}
    </span>
    <span class="min-w-0 flex-1">
      <span class="block text-[8.5px] font-bold tracking-[0.08em] text-fg-3 uppercase">{props.label}</span>
      <span
        class="block truncate text-[13px]"
        classList={{ "text-fg": !props.placeholder, "text-fg-3": props.placeholder }}
      >
        {props.value}
      </span>
    </span>
    <ChevronRight size={13} class="shrink-0 text-fg-3" aria-hidden="true" />
  </button>
);

// The armed "Choose on map" sub-state a `FromToRow` swaps for — same slot,
// same height, so the two-row stack never reflows when a pick arms/resolves.
const PickOnMapRow: Component<{ text: string; onCancel: () => void }> = (props) => (
  <div class="flex flex-1 items-center gap-2 py-1.5 pr-2 pl-4 text-[12px] text-fg-3">
    <span class="min-w-0 flex-1 truncate">{props.text}</span>
    <button
      type="button"
      aria-label="Cancel choosing on map"
      class="shrink-0 text-fg-3 hover:text-fg"
      onClick={props.onCancel}
    >
      <X size={14} aria-hidden="true" />
    </button>
  </div>
);

// ── The peek: name + GO, nothing else (#RT-SHEET-SLIM) ────────────────────────
//
// Deliberately THIN: a small, secondary name field (routes don't need a name
// to be useful — Google Maps doesn't ask you to name a trip either) and the
// one persistent way out/forward, GO. Everything a mariner actually comes to
// this tool TO DO — set From/Stop/To, see the route — is the FIRST thing in
// the sections below ({@link RouteFields}), not squeezed in here fighting the
// name field and a close button for space. That squeeze (name chip, From/To
// chips, a hint sentence, and GO all in one row) was the #1 reported
// complaint: nothing read as "the main thing to do here." `depart` is the
// departure instant the ETA counts from (RT-R6-C), threaded from the sheet.
const SheetSummary: Component<{ route: RoutesModel; depart: Accessor<number> }> = (props) => {
  const m = props.route;
  const stops = () => m.draftStops();

  return (
    <div class="px-4 pb-2">
      <div class="flex items-center gap-2">
        <input
          type="text"
          // Peek is a sheet-drag surface; data-no-drag stops a caret-positioning
          // press from dragging the sheet.
          data-no-drag
          value={m.draft()?.name ?? ""}
          maxlength={64}
          aria-label="Route name"
          placeholder="Untitled route"
          onInput={(e) => m.renameDraft(e.currentTarget.value)}
          class="min-w-0 flex-1 border-b border-transparent bg-transparent py-0.5 text-[13px] text-fg-2 placeholder:text-fg-3 focus:border-accent focus:outline-none"
        />
        {/* LIVE ROUTE (#RT-GEST): the route being edited IS the one currently
            being followed, so every drag/edit here publishes to the autopilot
            (flushed on drag-end). A steady accent pill — not an alarm — that says
            "your edits are going to the boat". */}
        <Show when={m.followingDraft()}>
          <span
            class="shrink-0 rounded-full bg-accent px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] text-accent-fg"
            title="Editing the route you are following — changes go to the autopilot"
          >
            Live route
          </span>
        </Show>
        {/* Phone only: desktop's Panel carries its own title-bar close X. */}
        <Show when={isCompact()}>
          <button
            type="button"
            aria-label="Close route editor"
            class={`${TOPBAR_BTN} grid place-items-center border-line text-fg enabled:hover:bg-chrome-2`}
            onClick={() => m.exitEditor()}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </Show>
        <button
          type="button"
          class={`${TOPBAR_BTN} border-accent bg-accent text-accent-fg`}
          disabled={stops().length === 0}
          onClick={() => void m.saveAndFollow()}
        >
          Go
        </button>
      </div>
    </div>
  );
};

// ── RouteFields: the ONE focal element — From → Via → To ──────────────────
//
// This is the whole point of the tool, so it is the biggest, plainest thing
// on the sheet: a vertical list of big tappable rows, a connecting line
// threading their dots (the Google-Maps "route thread" read), a swap button
// that spans it. No boxed border, no tiny uppercase captions competing with
// the values — the icon SHAPE (anchor / dot / pin) carries what each row is,
// the placeholder COPY carries what to do ("Choose destination"), and that is
// the whole instruction set. Nothing else on the sheet outranks this visually.
//
// Two shapes of the SAME list: before any stop is chosen, `draftStops()` is
// empty, so this renders two SEEDED rows (From defaulting to the boat, To a
// placeholder) wired straight to `setStop` via `openSearchForSlot` — the same
// entry point real rows use, just called on an empty draft (see `setStop`'s
// own seeding branch, `index.ts`). Once a route exists (`stops().length>=2`)
// the real list renders instead, with per-stop delete (×) and a pointer-based
// drag-reorder grip (works for touch and mouse, no library) on every stop
// between From and To — From/To themselves are fixed positions; moving the
// start/end is "search a different place there," not a reorder.
const DOT_FROM = "grid size-8 shrink-0 place-items-center rounded-full bg-accent text-accent-fg";
const DOT_STOP = "grid size-8 shrink-0 place-items-center rounded-full border-2 border-line-2 bg-chrome text-fg-3";
const DOT_TO = "grid size-8 shrink-0 place-items-center rounded-full bg-fg text-chrome";
const FIELD_VALUE =
  "min-w-0 flex-1 truncate rounded-lg py-2.5 text-left text-[15px] font-medium enabled:hover:bg-chrome-2";

/** One dot-and-field grid row (two grid children — callers spread this into a
 * `grid-cols-[32px_1fr]` container so consecutive rows share one connected
 * line down the dot column). `first`/`last` gate the connector segments so
 * the line never pokes out above From or below To. */
const RouteRow: Component<{
  dotClass: string;
  icon: JSX.Element;
  first?: boolean;
  last?: boolean;
  refRow?: (el: HTMLElement) => void;
  armed: boolean;
  armedText: string;
  onCancel: () => void;
  value: string;
  placeholder: boolean;
  onClick: () => void;
  trailing?: JSX.Element;
}> = (props) => (
  <>
    <div ref={props.refRow} class="relative flex items-center justify-center">
      <Show when={!props.first}>
        <span class="absolute inset-x-0 top-0 bottom-1/2 mx-auto w-px bg-line-2" aria-hidden="true" />
      </Show>
      <Show when={!props.last}>
        <span class="absolute inset-x-0 top-1/2 bottom-0 mx-auto w-px bg-line-2" aria-hidden="true" />
      </Show>
      <span class={props.dotClass}>{props.icon}</span>
    </div>
    <div class="flex min-w-0 items-center gap-1">
      <Show
        when={!props.armed}
        fallback={
          <div class="flex min-w-0 flex-1 items-center gap-2 py-2.5 text-[13px] text-fg-3">
            <span class="min-w-0 flex-1 truncate">{props.armedText}</span>
            <button
              type="button"
              data-no-drag
              aria-label="Cancel choosing on map"
              class="shrink-0 text-fg-3 hover:text-fg"
              onClick={props.onCancel}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        }
      >
        <button
          type="button"
          data-no-drag
          onClick={props.onClick}
          class={FIELD_VALUE}
          classList={{ "text-fg": !props.placeholder, "text-fg-3": props.placeholder }}
        >
          {props.value}
        </button>
        {props.trailing}
      </Show>
    </div>
  </>
);

const RouteFields: Component<{ route: RoutesModel }> = (props) => {
  const m = props.route;
  const stops = createMemo(() => m.draftStops());
  const hasRoute = () => stops().length >= 2;

  const [dragId, setDragId] = createSignal<string | null>(null);
  const [overIndex, setOverIndex] = createSignal<number | null>(null);
  const rowEls = new Map<string, HTMLElement>();

  const startDrag = (id: string, fromIndex: number, e: PointerEvent) => {
    e.preventDefault();
    setDragId(id);
    setOverIndex(fromIndex);
    const onMove = (ev: PointerEvent) => {
      let best = Infinity;
      let idx = fromIndex;
      const list = stops();
      // Only ever reorder AMONG the middle stops (indices 1..length-2) — a
      // middle row is the only thing with a grip to begin with, and From/To
      // are fixed positions, so the nearest-row search must not let a drag
      // land on index 0 or the last index and silently reassign which stop
      // is treated as From/To on the next render.
      for (let i = 1; i < list.length - 1; i++) {
        const el = rowEls.get(list[i]!.id);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const mid = r.top + r.height / 2;
        const d = Math.abs(ev.clientY - mid);
        if (d < best) {
          best = d;
          idx = i;
        }
      }
      setOverIndex(idx);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const to = overIndex();
      setDragId(null);
      setOverIndex(null);
      if (to !== null && to !== fromIndex) void m.reorderStops(fromIndex, to);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <section class="relative mt-1 pr-11">
      {/* The swap button spans the whole list, not tucked into a section
          label — vertically centered so it visibly connects the top row to
          the bottom one, exactly the "swap the two ends" affordance. */}
      <button
        type="button"
        data-no-drag
        aria-label="Flip route (swap From and To)"
        title="Flip route"
        disabled={!hasRoute()}
        onClick={() => m.reverseDraft()}
        class="absolute top-1/2 right-0 grid size-9 -translate-y-1/2 place-items-center rounded-full border border-line-2 text-fg-2 enabled:hover:border-accent enabled:hover:text-accent disabled:opacity-30"
      >
        <ArrowLeftRight size={15} aria-hidden="true" />
      </button>

      {/* `gap-y-0`: the connector line is two half-segments (this row's own
          bottom half + the next row's top half, see `RouteRow`) that must
          touch exactly at the row boundary — any row gap here would leave a
          visible break in the line at every dot. */}
      <div class="grid grid-cols-[32px_1fr] items-stretch gap-x-3 gap-y-0">
        <Show
          when={hasRoute()}
          fallback={
            <>
              <RouteRow
                dotClass={DOT_FROM}
                icon={<Anchor size={14} aria-hidden="true" />}
                first
                armed={m.pickingOnMap()?.kind === "from"}
                armedText="Tap the chart to set the start point"
                onCancel={() => m.cancelPickOnMap()}
                value={m.fromLabel()}
                placeholder={false}
                onClick={() => m.openSearchForSlot({ kind: "from" })}
              />
              <RouteRow
                dotClass={DOT_TO}
                icon={<MapPin size={14} aria-hidden="true" />}
                last
                armed={m.pickingOnMap()?.kind === "to"}
                armedText="Tap the chart to set the destination"
                onCancel={() => m.cancelPickOnMap()}
                value={m.toLabel() ?? "Choose destination"}
                placeholder={!m.toLabel()}
                onClick={() => m.openSearchForSlot({ kind: "to" })}
              />
            </>
          }
        >
          <For each={stops()}>
            {(stop, i) => {
              const isFrom = () => i() === 0;
              const isTo = () => i() === stops().length - 1;
              const isMiddle = () => !isFrom() && !isTo();
              const slot = () =>
                isFrom() ? { kind: "from" as const } : isTo() ? { kind: "to" as const } : { kind: "stop" as const, id: stop.id };
              const armed = () => {
                const p = m.pickingOnMap();
                if (!p) return false;
                if (isFrom()) return p.kind === "from";
                if (isTo()) return p.kind === "to";
                return p.kind === "stop" && p.id === stop.id;
              };
              return (
                <RouteRow
                  dotClass={isFrom() ? DOT_FROM : isTo() ? DOT_TO : DOT_STOP}
                  icon={isFrom() ? <Anchor size={14} aria-hidden="true" /> : isTo() ? <MapPin size={14} aria-hidden="true" /> : undefined}
                  first={isFrom()}
                  last={isTo()}
                  refRow={(el) => rowEls.set(stop.id, el)}
                  armed={armed()}
                  armedText={isFrom() ? "Tap the chart to set the start point" : "Tap the chart to set this point"}
                  onCancel={() => m.cancelPickOnMap()}
                  value={stop.name.trim() || "Unnamed stop"}
                  placeholder={false}
                  onClick={() => m.openSearchForSlot(slot())}
                  trailing={
                    isMiddle() ? (
                      <div
                        data-no-drag
                        class="flex shrink-0 items-center gap-0.5"
                        classList={{
                          "opacity-40": dragId() === stop.id,
                          "text-accent": overIndex() === i() && dragId() !== null && dragId() !== stop.id,
                        }}
                      >
                        <button
                          type="button"
                          aria-label={`Remove ${stop.name.trim() || "this stop"}`}
                          onClick={() => void m.removeStop(stop.id)}
                          class="grid size-8 place-items-center rounded-full text-fg-3 hover:bg-chrome-2 hover:text-fg"
                        >
                          <X size={15} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Reorder ${stop.name.trim() || "this stop"}`}
                          onPointerDown={(e) => startDrag(stop.id, i(), e)}
                          class="grid size-8 shrink-0 touch-none place-items-center rounded-full text-fg-3 hover:bg-chrome-2 hover:text-fg"
                        >
                          <GripVertical size={15} aria-hidden="true" />
                        </button>
                      </div>
                    ) : undefined
                  }
                />
              );
            }}
          </For>
        </Show>
      </div>

      <Show when={hasRoute()}>
        <button
          type="button"
          data-no-drag
          onClick={() => {
            const to = stops()[stops().length - 1];
            if (to) m.openSearchForSlot({ kind: "insert", beforeId: to.id });
          }}
          class="mt-2 ml-11 flex items-center gap-2 py-1.5 text-[13px] font-semibold text-accent enabled:hover:underline"
        >
          <Plus size={15} aria-hidden="true" />
          Add a stop
        </button>
      </Show>
    </section>
  );
};

// ── The half/full sections (the list · speed · departure · legs · actions) ────
const SheetSections: Component<{
  route: RoutesModel;
  /** The departure instant the ETA and per-leg arrivals count from (RT-R6-C). */
  depart: Accessor<number>;
  /** The raw departure signal: `null` = "leave now" (live), a number = chosen. */
  departure: Accessor<number | null>;
  setDeparture: (ms: number | null) => void;
}> = (props) => {
  const m = props.route;
  const wps = () => m.draft()?.waypoints ?? [];
  const speed = () => m.draft()?.plan_speed_kn ?? DEFAULT_PLAN_SPEED_KN;
  const rows = () => legRows(wps(), m.plan(), props.depart());
  const stops = () => m.draftStops();
  const summary = () => routeSummary(wps(), speed(), props.depart());

  // Two-tap delete (arm, then confirm) — deleting the draft route is not
  // undoable, and a fat-finger must not drop a passage.
  const [confirmDeleteRoute, setConfirmDeleteRoute] = createSignal(false);

  // speedText tracks the model EXCEPT while the field has focus, so a keystroke
  // is never clobbered mid-edit by a stepper press or external speed change.
  let speedInput: HTMLInputElement | undefined;
  const [speedText, setSpeedText] = createSignal(speed().toFixed(1));
  createEffect(() => {
    const s = speed();
    if (document.activeElement !== speedInput) setSpeedText(s.toFixed(1));
  });
  const commitSpeed = () => {
    const kn = parsePlanSpeed(speedText(), speed());
    m.setPlanSpeed(kn);
    setSpeedText(kn.toFixed(1));
  };

  // Tapping a leg row flashes it on the chart — a plan reading onto the map,
  // transiently (`flashLegAt`). No selection any more: the list above is the
  // one place a leg's own endpoints get edited.
  const tapLeg = (row: LegRow) => m.flashLegAt(row.seg);

  return (
    <>
      {/* Phone-only name field (#RT-BAR2) — desktop edits the name in the peek's
          title field (SheetSummary), which sits above this drawer. */}
      <Show when={isCompact()}>
        <section class="mt-1">
          <SectionLabel>Name</SectionLabel>
          <input
            type="text"
            data-no-drag
            value={m.draft()?.name ?? ""}
            maxlength={64}
            aria-label="Route name"
            placeholder="Name this route"
            onInput={(e) => m.renameDraft(e.currentTarget.value)}
            class="mt-2.5 w-full rounded-lg border border-line-2 bg-chrome-2 px-3 py-2 text-[15px] font-semibold text-fg placeholder:font-normal placeholder:text-fg-3 focus:border-accent focus:outline-none"
          />
        </section>
      </Show>

      <RouteFields route={m} />

      {/* The result: distance/time/ETA once there is a real route to measure,
          right under the fields that produced it — the fastest confirmation
          that setting From/To actually did something. The map-drag hint
          (`editorHint`) moves down here too: it only applies once a route
          exists (there is nothing to drag before then). */}
      <Show when={stops().length >= 2}>
        <p class="mt-3 flex items-center gap-2 whitespace-nowrap font-mono text-[13px] tabular-nums text-fg-2">
          {summary().distValue}
          <span class="text-fg-3">{summary().distUnit}</span> · {summary().time} ·{" "}
          <span class="text-accent">{summary().eta}</span>
          {/* The ONE "something is happening" signal, right next to the number
              it affects: a stop edit shows up on the map/list INSTANTLY (a
              straight-line provisional shape — `index.ts`'s `provisionalRebuild`),
              so this spinner is never the only feedback, just confirmation the
              real (hazard-avoiding) route is still being worked out. */}
          <Show when={m.planning()}>
            <LoaderCircle size={13} class="animate-spin text-fg-3" aria-label="Planning route" />
          </Show>
        </p>
        <Show when={m.editorHint()}>
          <p class="mt-1 text-[11px] leading-snug text-fg-3">{m.editorHint()}</p>
        </Show>
      </Show>

      <section class="mt-4">
        <SectionLabel>Planning speed</SectionLabel>
        <div class="mt-2.5 flex items-center gap-3">
          {/* RT-R5: touch-none kills residual scroll jitter data-no-drag alone
              doesn't stop; w-[52px] stops a value change reflowing the row. */}
          <div
            data-no-drag
            class="flex touch-none items-center overflow-hidden rounded-lg border border-line-2"
          >
            <button
              type="button"
              aria-label="Slower"
              class="h-[38px] w-[38px] shrink-0 bg-chrome-2 text-lg text-fg hover:bg-line-2 pointer-coarse:h-11 pointer-coarse:w-11"
              onClick={() => m.setPlanSpeed(stepPlanSpeed(speed(), -1))}
            >
              –
            </button>
            <input
              ref={(el) => (speedInput = el)}
              type="text"
              inputmode="decimal"
              aria-label="Planning speed (knots)"
              value={speedText()}
              onFocus={(e) => e.currentTarget.select()}
              onInput={(e) => setSpeedText(e.currentTarget.value)}
              onChange={commitSpeed}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              class="w-[52px] bg-transparent text-center font-mono text-[17px] tabular-nums text-fg focus:outline-none"
            />
            <small class="pr-1 text-[11px] text-fg-3">kn</small>
            <button
              type="button"
              aria-label="Faster"
              class="h-[38px] w-[38px] shrink-0 bg-chrome-2 text-lg text-fg hover:bg-line-2 pointer-coarse:h-11 pointer-coarse:w-11"
              onClick={() => m.setPlanSpeed(stepPlanSpeed(speed(), 1))}
            >
              +
            </button>
          </div>
          <p class="max-w-[16ch] text-[11.5px] leading-tight text-fg-2">
            Drives ETA &amp; time for the whole route.
          </p>
        </div>
      </section>

      {/* RT-R6-C: ETA and every per-leg arrival below count from this instant,
          not from now. See docs/architecture/route-sheet.md. */}
      <section class="mt-4">
        <SectionLabel>Departure</SectionLabel>
        <div data-no-drag class="mt-2.5 flex items-center gap-2">
          <input
            type="datetime-local"
            aria-label="Departure time"
            value={toDatetimeLocal(props.depart())}
            onChange={(e) => props.setDeparture(parseDatetimeLocal(e.currentTarget.value))}
            class="min-w-0 flex-1 touch-none rounded-lg border border-line-2 bg-chrome-2 px-3 py-2 font-mono text-[13px] text-fg focus:border-accent focus:outline-none"
          />
          <button
            type="button"
            class={`${BTN} shrink-0`}
            disabled={props.departure() === null}
            onClick={() => props.setDeparture(null)}
          >
            Now
          </button>
        </div>
      </section>

      <section class="mt-4">
        <SectionLabel>Legs</SectionLabel>
        <Show
          when={rows().length > 0}
          fallback={
            <p class="mt-2 text-[12px] text-fg-3">
              Set a start and destination above to see the legs.
            </p>
          }
        >
          <div class="mt-2 flex flex-col gap-px">
            <For each={rows()}>
              {(row) => (
                <button
                  type="button"
                  data-no-drag
                  onClick={() => tapLeg(row)}
                  class="grid grid-cols-[20px_1fr_auto_auto] items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-chrome-2"
                >
                  <span class="grid size-5 place-items-center rounded-full border border-line-2 font-mono text-[10px] text-fg-2">
                    {row.n}
                  </span>
                  <span class="min-w-0">
                    <span class="block truncate text-[13px]">{row.toName}</span>
                    <span class="text-[11px] text-fg-3">{row.brg}°T</span>
                  </span>
                  {/* Leg duration here; wall-clock ETA (labelled) in the next
                      column, so "10h 00" is never confused with "14:30". */}
                  <span class="text-right leading-tight">
                    <span class="block font-mono text-[12.5px] tabular-nums">
                      {row.distValue} {row.distUnit}
                    </span>
                    <span class="block font-mono text-[10.5px] tabular-nums text-fg-3">
                      {row.legTime}
                    </span>
                  </span>
                  <span class="min-w-[46px] text-right leading-tight">
                    <span class="block font-mono text-[12.5px] tabular-nums text-fg-2">
                      {row.arrival}
                    </span>
                    <span class="block text-[8.5px] font-semibold uppercase tracking-[0.1em] text-fg-3">
                      ETA
                    </span>
                  </span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </section>

      {/* ── Navigate (#RT-GONAV) ────────────────────────────────────────────
          "Start route" joins at the closest-next leg (nearest to the boat, or
          the first waypoint with no fix) — a real route-follow (save + active
          leg + leave), not the direct single-leg "Go here". */}
      <section class="mt-4">
        <SectionLabel>Navigate</SectionLabel>
        <div data-no-drag class="mt-2.5 flex flex-col gap-2">
          <button
            type="button"
            class={BTN_PRIMARY}
            disabled={stops().length === 0}
            onClick={() => void m.startRoute()}
          >
            <Navigation size={15} aria-hidden="true" />
            Start route
          </button>
        </div>
      </section>

      {/* The secondary actions. GO lives in the top bar (SheetSummary), and
          there is no Save — every edit auto-saves — so this is just the
          operations with no top-bar home: the follow-stop and the manager
          link, plus route delete. Reverse/Undo/Redo/Delete-waypoint are gone
          with the redesign — Flip lives in the From/Stop/To list header now,
          and a mistaken edit is corrected with the obvious opposite list
          action (delete a stop, drag it back) rather than a history pop. */}
      <section class="mt-4">
        <SectionLabel>Actions</SectionLabel>
        <div data-no-drag class="mt-2.5 grid grid-cols-2 gap-2">
          <Show when={m.followingDraft()}>
            <button type="button" class={BTN} onClick={() => void m.stopFollowing()}>
              Stop following
            </button>
          </Show>
          <button type="button" class={BTN} onClick={() => m.openManager()}>
            <List size={15} aria-hidden="true" />
            Saved routes
          </button>
          <Show
            when={confirmDeleteRoute()}
            fallback={
              <button
                type="button"
                class={`${BTN} border-alarm! text-alarm! enabled:hover:bg-alarm/10`}
                onClick={() => setConfirmDeleteRoute(true)}
              >
                Delete route
              </button>
            }
          >
            <div class="col-span-2 flex gap-2">
              <button
                type="button"
                class={`${BTN} flex-1`}
                onClick={() => setConfirmDeleteRoute(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                class={`${BTN} flex-1 border-alarm! text-alarm! enabled:hover:bg-alarm/10`}
                onClick={() => {
                  setConfirmDeleteRoute(false);
                  void m.deleteDraftRoute();
                }}
              >
                Delete route?
              </button>
            </div>
          </Show>
        </div>
      </section>
    </>
  );
};

// Mirrors the Rail's Tile look (chrome tokens + rail-density.ts sizing) but
// takes an arbitrary label/value pair instead of a registry Instrument.
const MetricTile: Component<{
  label: string;
  value: string;
  unit?: string;
  sub?: string;
  density: Density;
  accent?: boolean;
}> = (props) => {
  const d = () => railDensity(props.density);
  return (
    <div class="flex min-w-0 flex-1 flex-col items-center justify-center overflow-hidden border-l border-line-2 px-2.5 text-center font-mono first:border-l-0">
      <div
        class="font-bold leading-[1.25] tracking-[0.06em] text-fg-3"
        style={{ "font-size": `${d().label}px` }}
      >
        {props.label}
      </div>
      <div
        class="whitespace-nowrap font-semibold leading-[1.2] tracking-[-0.04em] tabular-nums"
        classList={{ "text-accent": props.accent, "text-fg": !props.accent }}
        style={{ "font-size": `${d().value}px` }}
      >
        {props.value}
        <Show when={props.unit}>
          {(unit) => (
            <span
              class="ml-px font-normal tracking-normal text-fg-2"
              style={{ "font-size": `${d().unit}px` }}
            >
              {unit()}
            </span>
          )}
        </Show>
      </div>
      <Show when={props.sub}>
        {(sub) => (
          <div
            class="overflow-hidden whitespace-nowrap leading-[1.25] text-fg-3"
            style={{ "font-size": `${d().sub}px` }}
          >
            {sub()}
          </div>
        )}
      </Show>
    </div>
  );
};

const BAR_START_BTN =
  "flex size-9 shrink-0 items-center justify-center rounded-full border border-accent bg-accent text-accent-fg active:brightness-110 disabled:opacity-40 pointer-coarse:size-11";

/**
 * The PHONE resting surface: a bottom BAR styled like the Rail's phone widget
 * panel — same height, `bg-chrome`, top border, drop-shadow halo, safe-area
 * inset and grab pill. It leads with the glance METRICS as instrument tiles
 * (distance + ETA/total time, or the From/To search before a route exists) and
 * the primary "Start route" action. The route NAME is NOT here — renaming
 * lives in the full drawer (#RT-BAR2) — so the bar spends its whole width on
 * metrics-then-action with no empty tile (#RT-BARLAYOUT). A swipe UP (shared
 * {@link createSwipeUp}) opens the full drawer — the dashboard's gesture.
 *
 * It is a FLEX SIBLING in the phone bottom slot (#RT-BARLAYOUT), NOT an absolute
 * overlay in the map pane: it occupies the SAME constant-height slot the Rail
 * widget bar does, the two being mutually-exclusive occupants (Rail hides its
 * aside exactly while route-edit is active — Rail.tsx `routeBarActive`). Because
 * exactly one 72px bar ever fills that slot, the map pane is the same height with
 * or without the editor open, so the map's side FABs never jump. It swaps in
 * instantly (no summon slide — it REPLACES the widget bar in place, the way the
 * widget bar itself just appears/disappears). Mounted as a column sibling of the
 * Rail (App.tsx), below the map pane rather than over it. It tags
 * `[data-sheet-panel]` for the chart's obscured-coverage measure (Sheet.ts
 * `measureObscured`) — now 0, as the bar sits below the chart, not over it.
 */
const RouteBar: Component<{
  route: RoutesModel;
  depart: Accessor<number>;
  density: Accessor<Density>;
  fullOpen: Accessor<boolean>;
  onOpenFull: () => void;
}> = (props) => {
  const m = props.route;
  const stops = () => m.draftStops();
  const wps = () => m.draft()?.waypoints ?? [];
  const summary = () =>
    routeSummary(wps(), m.draft()?.plan_speed_kn ?? DEFAULT_PLAN_SPEED_KN, props.depart());

  const swipe = createSwipeUp({ enabled: () => !props.fullOpen(), onOpen: props.onOpenFull });

  return (
    <Show when={m.editing()}>
      <aside
        data-sheet-panel
        class="relative z-10 flex shrink-0 flex-col border-t border-line bg-chrome pb-[env(safe-area-inset-bottom)]"
        style={{
          // Normally a CONSTANT 72px — see the doc above on why (the map
          // pane's side FABs must never jump). The one deliberate exception:
          // an empty draft's From/To rows genuinely need two full rows, so
          // this state alone grows the bar; it shrinks straight back to 72px
          // the moment a real route exists, the same instant the FABs would
          // otherwise have jumped anyway (the chart, not just this bar,
          // changes the moment a route appears).
          height: `calc(${stops().length === 0 ? 112 : 72}px + env(safe-area-inset-bottom))`,
          "box-shadow": "0 -10px 40px var(--color-shadow)",
        }}
        onTouchStart={swipe.onTouchStart}
        onTouchMove={swipe.onTouchMove}
        onTouchEnd={swipe.onTouchEnd}
        onTouchCancel={swipe.onTouchCancel}
      >
        <div
          aria-hidden="true"
          class="pointer-events-none absolute inset-x-0 top-0 hidden justify-center pointer-coarse:flex"
        >
          <div class="h-1 w-9 -translate-y-1/2 rounded-full bg-fg-3/40" />
        </div>
        <div class="flex min-h-0 flex-1 items-stretch">
          {/* The bar LEADS with the glance metrics (#RT-BARLAYOUT): the ROUTE
              caption + read-only name cluster that used to sit here is gone — with
              a short/blank name it read as an empty tile — and renaming lives in
              the full drawer (#RT-BAR2). The metric tiles GROW to fill the lead
              (each `flex-1`), so there is no dead space between them and the
              action; before a route exists the two-chip From/To stack fills the
              lead instead of a bordered tile. */}
          <Show
            when={stops().length >= 2}
            fallback={
              <div class="flex min-w-0 flex-1 flex-col divide-y divide-line-2 overflow-hidden">
                <Show
                  when={m.pickingOnMap()?.kind !== "from"}
                  fallback={
                    <PickOnMapRow
                      text="Tap the chart to set the start point"
                      onCancel={() => m.cancelPickOnMap()}
                    />
                  }
                >
                  <FromToRow
                    icon={<Anchor size={13} aria-hidden="true" />}
                    label="From"
                    value={m.fromLabel()}
                    onClick={() => m.openSearchForSlot({ kind: "from" })}
                  />
                </Show>
                <Show
                  when={m.pickingOnMap()?.kind !== "to"}
                  fallback={
                    <PickOnMapRow
                      text="Tap the chart to set the destination"
                      onCancel={() => m.cancelPickOnMap()}
                    />
                  }
                >
                  <FromToRow
                    icon={<MapPin size={13} aria-hidden="true" />}
                    label="To"
                    value={m.toLabel() ?? "Choose destination"}
                    placeholder={!m.toLabel()}
                    onClick={() => m.openSearchForSlot({ kind: "to" })}
                  />
                </Show>
              </div>
            }
          >
            <div class="relative flex min-w-0 flex-1 items-stretch">
              <MetricTile
                label="DIST"
                value={summary().distValue}
                unit={summary().distUnit}
                density={props.density()}
              />
              <MetricTile
                label="ETA"
                value={summary().eta}
                sub={summary().time}
                density={props.density()}
                accent
              />
              <Show when={m.planning()}>
                <LoaderCircle
                  size={12}
                  class="absolute top-1 right-1 animate-spin text-fg-3"
                  aria-label="Planning route"
                />
              </Show>
            </div>
          </Show>
          {/* The primary action: Start route (closest-next smart-start), the
              bar's one filled control. Disabled with no route yet. */}
          <div
            class="flex shrink-0 items-center gap-1.5 border-l border-line px-2"
            classList={{ "flex-col justify-center": stops().length === 0 }}
          >
            <button
              type="button"
              aria-label="Start route"
              title="Start route"
              class={BAR_START_BTN}
              disabled={stops().length === 0}
              onClick={() => void m.startRoute()}
            >
              <Navigation size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
      </aside>
    </Show>
  );
};

/**
 * The route tool's surface. Two shapes, chosen by `isCompact()` (#RT-REDRAWER):
 *
 *   * PHONE — a fixed bottom {@link RouteBar} (the widget panel) at rest, with a
 *     swipe UP opening {@link SheetSections} as a MODAL single-detent Sheet (the
 *     dashboard pattern).
 *   * DESKTOP — the SAME content as the existing non-modal left edge-drawer (the
 *     peek {@link SheetSummary} above the sections), unchanged.
 *
 * Mounted once as a column sibling of the Rail (App.tsx), so the phone {@link
 * RouteBar} occupies the SAME bottom slot the Rail widget bar does — the two are
 * mutually-exclusive, which is what keeps the map pane height (and its FABs)
 * constant across the mode toggle (#RT-BARLAYOUT). It is the SAME `route-edit`
 * mode throughout: bar/summary/sections call the model's own operations;
 * auto-save means the exit just closes (no discard confirm), routing back
 * through `modes.leave`.
 */
const RouteSheet: Component<{ route: RoutesModel; density: Accessor<Density> }> = (props) => {
  const m = props.route;
  // Ephemeral departure (RT-R6-C) — see docs/architecture/route-sheet.md.
  const [departure, setDeparture] = createSignal<number | null>(null);
  const routeId = createMemo(() => m.draft()?.id ?? null);
  createEffect(() => {
    routeId();
    setDeparture(null);
  });
  const depart = (): number => departure() ?? Date.now();

  // Whether the full drawer is pulled up; drops shut when editing ends so a
  // reopen rests on the bar.
  const [full, setFull] = createSignal(false);
  createEffect(() => {
    if (!m.editing()) setFull(false);
  });

  return (
    <Show
      when={isCompact()}
      fallback={
        <Sheet
          open={m.editing()}
          onOpenChange={(o) => {
            if (!o) m.exitEditor();
          }}
          title="Plan route"
          desktop={{ kind: "edge-drawer", side: "left" }}
          peek={() => <SheetSummary route={m} depart={depart} />}
        >
          <SheetSections
            route={m}
            depart={depart}
            departure={departure}
            setDeparture={setDeparture}
          />
        </Sheet>
      }
    >
      <RouteBar
        route={m}
        depart={depart}
        density={props.density}
        fullOpen={full}
        onOpenFull={() => setFull(true)}
      />
      <Sheet open={full()} onOpenChange={setFull} title="Plan route" modal detents={[1]}>
        <SheetSections route={m} depart={depart} departure={departure} setDeparture={setDeparture} />
      </Sheet>
    </Show>
  );
};

export default RouteSheet;
