import { createEffect, createSignal, For, Show, type Accessor, type Component } from "solid-js";
import { isCompact, prefersReducedMotion } from "../media";
import { bandList, bandLive, targetCards } from "./bands";
import { createEnterExit } from "./useEnterExit";
import { TOP_TARGET, type ChromeConfig, type ChromeUpdater } from "./config";
import type { DashboardDrag } from "./dashboardDnd";
import { WidgetDropZone } from "./WidgetDropZone";
import { lerpDensity, readInstrument, type Density, type Instrument, type Registry } from "./registry";
import type { WidgetRegistry } from "./widget";

// band.top — the ONE piece of chrome that lives transparently OVER the chart,
// only while a route is being followed (IMPLEMENTATION §1, invariant #3).
// Numbers survive with no background via a text-shadow HALO, same trick as
// ModePill's hint. See docs/architecture/top-band.md.

// #DENS-SLIDER: continuous `lerpDensity` sizing, not a Tailwind class lookup —
// the scanner can't see a class built from a runtime number (see
// `rail-density.ts`'s header, the same trick).
const DESK_SIZE: TopSizing = { value: 15, label: 8.5, unit: 9, sub: 8.5, gapX: 16, gapY: 4 };
const HELM_SIZE: TopSizing = { value: 22, label: 10, unit: 12, sub: 10, gapX: 24, gapY: 6 };

const topDensity = (density: Density): TopSizing => ({
  value: lerpDensity(DESK_SIZE.value, HELM_SIZE.value, density),
  label: lerpDensity(DESK_SIZE.label, HELM_SIZE.label, density),
  unit: lerpDensity(DESK_SIZE.unit, HELM_SIZE.unit, density),
  sub: lerpDensity(DESK_SIZE.sub, HELM_SIZE.sub, density),
  gapX: lerpDensity(DESK_SIZE.gapX, HELM_SIZE.gapX, density),
  gapY: lerpDensity(DESK_SIZE.gapY, HELM_SIZE.gapY, density),
});

// Phone-width override on top of density (a SETTING, not a breakpoint,
// invariant #10): a phone at HELM density overflowed the screen. `isCompact()`
// IS a breakpoint since layout is the one thing a viewport query may answer.
const COMPACT: TopSizing = { value: 13, label: 8, unit: 8, sub: 8, gapX: 8, gapY: 2 };

// Text-shadow HALO (never a blur — project UI rule), shared by the read-only
// render and the in-place editor so both stay legible with no background slab.
const HALO =
  "0 0 3px var(--color-chrome), 0 0 6px var(--color-chrome), 0 0 9px var(--color-chrome)";

interface TopSizing {
  value: number;
  label: number;
  unit: number;
  sub: number;
  gapX: number;
  gapY: number;
}

/** One top-band cell, halo'd. Shared by the read-only strip and the in-place
 * editor's `WidgetDropZone` (as `renderCell`), so the look is identical. */
const TopCell: Component<{ inst: Instrument; density: Density; d: TopSizing }> = (props) => {
  const view = () => readInstrument(props.inst, { density: props.density, band: "top", room: "strip" });
  return (
    <div class="text-center font-mono select-none" title={props.inst.label}>
      <div
        class="font-bold tracking-[0.06em] leading-none"
        style={{ "font-size": `${props.d.label}px` }}
        classList={{
          "text-fg-2": view().urgency !== "notice" || view().stale,
          "text-notice": view().urgency === "notice" && !view().stale,
        }}
      >
        {props.inst.short}
      </div>
      <div
        class="whitespace-nowrap font-semibold tracking-[-0.04em] tabular-nums leading-tight"
        style={{ "font-size": `${props.d.value}px` }}
        classList={{
          "text-fg": view().urgency === "none" && !view().stale && view().reading.state !== "null",
          "text-notice": view().urgency === "notice" && !view().stale,
          "text-fg-3": view().stale || view().reading.state === "null",
          "line-through decoration-2 opacity-80": view().stale,
        }}
      >
        {view().reading.value}
        <Show when={view().reading.unit}>
          {(unit) => (
            <span
              class="ml-px font-normal tracking-normal text-fg-2"
              style={{ "font-size": `${props.d.unit}px` }}
            >
              {unit()}
            </span>
          )}
        </Show>
      </div>
      <Show when={view().reading.sub}>
        {(sub) => (
          <div
            class="whitespace-nowrap text-fg-3 leading-none"
            style={{ "font-size": `${props.d.sub}px` }}
          >
            {sub()}
          </div>
        )}
      </Show>
    </div>
  );
};

export interface TopBandProps {
  reg: Registry;
  chrome: Accessor<ChromeConfig>;
  /** The board's EDIT state. With `drag` + `onChrome`, the band renders IN
   * PLACE as an editable {@link WidgetDropZone}, shown even with no route
   * followed (so there is something to edit). */
  editing?: Accessor<boolean>;
  /** The shared drag controller — the in-place editor drives it, and a card
   * dragged from the board onto the band lands here. */
  drag?: Accessor<DashboardDrag | undefined>;
  /** The config updater — the editor's EditCards write through it. */
  onChrome?: ChromeUpdater;
  /** The full widget-KIND registry, threaded to the editable cells. */
  widgetReg?: WidgetRegistry;
  /** Tapping the band opens what it reads from (the followed route's card,
   * with its Next/Previous/Stop controls). Absent → the band stays
   * click-through, like the rest of the chart overlay. */
  onOpen?: () => void;
}

const TopBand: Component<TopBandProps> = (props) => {
  const density = () => props.chrome().density;
  // Sizing is compact on a phone; instrument *content* still keys off density.
  const d = () => (isCompact() ? COMPACT : topDensity(density()));
  const insts = () => bandList(props.reg, props.chrome(), "top");

  // Fades in/out with liveness rather than blinking; the instrument list is
  // LATCHED so the leaving frame still has numbers to fade (./useEnterExit.ts).
  const reduce = prefersReducedMotion;
  const live = () => bandLive(props.reg, props.chrome(), "top");
  const ee = createEnterExit({ open: live, closeProperty: "opacity" });
  const [held, setHeld] = createSignal<Instrument[]>(insts());
  createEffect(() => {
    if (live()) setHeld(insts());
  });

  // See docs/architecture/top-band.md for the in-place edit-mode rationale.
  // Wide screens only: on a phone the board sheet covers the band, which is
  // edited through the board's synthetic "Route band" tab instead
  // (Dashboard.tsx `tabs`) — editing it in place there only left dead
  // "Remove from here" cells over the strip of chart above the sheet.
  const editingActive = (): boolean =>
    !isCompact() && !!props.editing?.() && !!props.drag?.() && !!props.onChrome;

  return (
    <Show when={editingActive() ? props.drag?.() : undefined} fallback={
    <Show when={ee.rendered()}>
      <div
        // The info marker measures this box (../info/attach.tsx
        // `topBandObscured`) to keep a warped point clear of the band.
        data-nav-band
        style={{
          opacity: ee.stage() === "open" ? 1 : 0,
          transition: reduce() ? "none" : "opacity var(--duration-fast) ease-out",
          "text-shadow": HALO,
          "column-gap": `${d().gapX}px`,
          "row-gap": `${d().gapY}px`,
        }}
        onTransitionEnd={ee.handleTransitionEnd}
        role={props.onOpen ? "button" : undefined}
        tabindex={props.onOpen ? 0 : undefined}
        aria-label={props.onOpen ? "Route controls" : undefined}
        onClick={() => props.onOpen?.()}
        onKeyDown={(e) => {
          if (props.onOpen && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            props.onOpen();
          }
        }}
        // max-w + flex-wrap: caps the row like ModePill's max-w-[96%], and
        // wraps to a second row rather than clipping. See top-band.md.
        // pt-safe-area: PWA draws edge-to-edge under the notch; 0 in-browser.
        class="absolute top-2 left-1/2 z-10 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 flex-wrap items-start justify-center pt-[env(safe-area-inset-top)]"
        classList={{
          "pointer-events-none": !props.onOpen || ee.stage() !== "open",
          "cursor-pointer focus-ring rounded": !!props.onOpen,
        }}
      >
        <For each={held()}>
          {(inst) => <TopCell inst={inst} density={density()} d={d()} />}
        </For>
      </div>
    </Show>
    }>
      {/* EDIT mode: same drop zone, interactive (no pointer-events-none),
          shown regardless of liveness. */}
      {(dnd) => (
        <div
          data-nav-band
          style={{ "text-shadow": HALO }}
          class="absolute top-2 left-1/2 z-10 max-w-[calc(100%-1.5rem)] -translate-x-1/2 pt-[env(safe-area-inset-top)]"
        >
          <WidgetDropZone
            target={TOP_TARGET}
            items={targetCards(props.reg, props.chrome(), TOP_TARGET)}
            dnd={dnd()}
            chrome={props.chrome}
            onChrome={props.onChrome!}
            density={density()}
            widgetReg={props.widgetReg}
            layoutClass="flex flex-wrap items-start justify-center"
            layoutStyle={{ "column-gap": `${d().gapX}px`, "row-gap": `${d().gapY}px` }}
            axis="x"
            renderCell={(inst) => <TopCell inst={inst} density={density()} d={d()} />}
            onDragStart={(inst, target, e, opts) => dnd().start(inst.id, target, e, opts)}
            empty={
              <span class="font-mono text-[10px] text-fg-2">
                Empty — drag a widget here, or use Add widget on the Route band tab.
              </span>
            }
          />
        </div>
      )}
    </Show>
  );
};

export default TopBand;
