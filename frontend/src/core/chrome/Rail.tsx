import ChevronLeft from "lucide-solid/icons/chevron-left";
import ChevronRight from "lucide-solid/icons/chevron-right";
import { createEffect, createSignal, For, on, Show, type Accessor, type Component, type JSX } from "solid-js";
import { isCompact, prefersReducedMotion } from "../media";
import { createSwipeUp } from "./swipeUp";
import { useBackDismiss } from "./backStack";
import Sheet from "./Sheet";
import type { Palette } from "../style/colors";
import type { CpaMode } from "../collisionSettings";
import { bandList, targetCards } from "./bands";
import { RAIL_TARGET, type ChromeConfig, type ChromeUpdater } from "./config";
import type { DashboardDrag } from "./dashboardDnd";
import { WidgetDropZone } from "./WidgetDropZone";
import type { WidgetRegistry } from "./widget";
import type { GpsFix } from "./core";
import { railDensity } from "./rail-density";
import { Launcher } from "./Launcher";
import {
  alerts,
  DESK,
  readInstrument,
  readingValueClasses,
  type Density,
  type Instrument,
  type Registry,
} from "./registry";

// band.rail — a flex sibling of the map (App.tsx), not an overlay, so
// opening the board RESIZES the chart rather than covering it. This file is
// a thin renderer; band decisions live in chrome/{registry,bands,config}.ts.

/** A bare width — the edge inset is carried by the region container, not here. */
const BOARD_WIDTH = "w-[408px]";

// The mode→icon map lives in ./modeIcons.ts (a leaf) so MapView's phone tool
// stack shares it with the desktop rail strip below.

export interface RailProps {
  reg: Registry;
  chrome: Accessor<ChromeConfig>;
  /** The board's content (the dashboard). Absent → no chevron and no board
   * panel — a toggle that opens 408px of nothing is worse than none. */
  dashboard?: JSX.Element;
  /** Tap an instrument tile → open its dashboard tab (App's
   * `openInstrumentTab`). Absent → tiles are display-only readouts. */
  onInstrument?: (id: string) => void;
  /** A REQUEST to open the board — a counter, not a boolean, since the rail
   * OWNS open/closed state: each bump opens it, a manual close still closes. */
  openBoard?: Accessor<number>;
  onSettings: () => void;
  onCommandPalette?: () => void;
  onRoutes?: () => void;
  /** Opens the Notices to Mariners list (a feature-owned panel; the rail
   * only forwards the callback to the launcher). */
  onNotices?: () => void;
  onBuddies?: () => void;
  onMarks?: () => void;
  signalkStatus?: Accessor<"off" | "connecting" | "connected">;
  /** A live SignalK link and a live GPS fail independently, so this is a
   * separate dot fed by a separate signal (`createGpsStatus`). */
  gpsStatus?: Accessor<GpsFix>;
  activeMode?: Accessor<string | null>;
  onMode?: (id: string) => void;
  onLayers?: () => void;
  layersOpen?: Accessor<boolean>;
  cpaMode?: Accessor<CpaMode>;
  onCpaMode?: (mode: CpaMode) => void;
  palette?: Accessor<Palette>;
  onPalette?: (palette: Palette) => void;
  /** In EDIT mode the strip renders its widgets through the SAME
   * {@link WidgetDropZone} the board's tab grids use, so reorder/drop-in/
   * drag-out/remove all flow through one unified drag path. */
  drag?: Accessor<DashboardDrag | undefined>;
  editing?: Accessor<boolean>;
  onChrome?: ChromeUpdater;
  widgetReg?: WidgetRegistry;
}

/** Invariant #10: no screen-width query here. Invariant #4: urgency
 * recolours a tile IN PLACE, never moves it. Invariant #6 (enforced in
 * `urgencyOf`, not here): a stale tile never carries an alarm background. */
const Tile: Component<{
  inst: Instrument;
  density: Density;
  band: "rail" | "top";
  class: string;
  onHover?: (e: MouseEvent) => void;
  onLeave?: () => void;
  onClick?: () => void;
}> = (props) => {
  const d = () => railDensity(props.density);
  const view = () =>
    readInstrument(props.inst, { density: props.density, band: props.band, room: "strip" });
  const interactive = () => !!props.onClick;
  return (
    <div
      role={interactive() ? "button" : undefined}
      tabindex={interactive() ? 0 : undefined}
      onClick={() => props.onClick?.()}
      onKeyDown={(e) => {
        if (interactive() && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          props.onClick?.();
        }
      }}
      // `overflow-hidden`: an unusually wide reading used to bleed off the
      // desktop rail's right-edge viewport and force horizontal page scroll
      // (same failure as band.top's, sideways instead of centred).
      class={`relative select-none overflow-hidden text-center font-mono ${props.class}`}
      classList={{
        "bg-alarm/15": view().urgency === "alarm" && !view().stale,
        "cursor-pointer active:bg-chrome-2 focus-ring": interactive(),
      }}
      style={{
        "padding-left": `${d().tilePadding.x}px`,
        "padding-right": `${d().tilePadding.x}px`,
        "padding-top": `${d().tilePadding.top}px`,
        "padding-bottom": `${d().tilePadding.bottom}px`,
      }}
      title={props.inst.label}
      onMouseEnter={props.onHover}
      onMouseLeave={props.onLeave}
    >
      <Show when={view().staleSeconds}>
        {(age) => (
          <span class="absolute right-[3px] top-[2px] text-[7.5px] font-bold text-notice">
            {Math.round(age())}s
          </span>
        )}
      </Show>
      <div
        class="font-bold leading-[1.25] tracking-[0.06em]"
        style={{ "font-size": `${d().label}px` }}
        classList={{
          "text-fg-3": view().urgency !== "alarm" || view().stale,
          "text-alarm": view().urgency === "alarm" && !view().stale,
        }}
      >
        {props.inst.short}
      </div>
      <div
        class="whitespace-nowrap font-semibold leading-[1.2] tracking-[-0.04em] tabular-nums"
        style={{ "font-size": `${d().value}px` }}
        classList={readingValueClasses(view())}
      >
        {view().reading.value}
        <Show when={view().reading.unit}>
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
      <Show when={view().reading.sub}>
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

/**
 * The GPS-fix dot, shared by the desktop header and phone bar so the two
 * presentations of link health never disagree. "Cannot tell" (`acquiring`,
 * `unknown`) is never painted green; a dead fix (`stale`) is alarm-red.
 */
const GpsDot: Component<{ gps: Accessor<GpsFix> }> = (props) => (
  <span
    class="size-1.5 shrink-0 rounded-full"
    classList={{
      "bg-ok": props.gps() === "fix",
      "bg-notice": props.gps() === "acquiring",
      "bg-alarm": props.gps() === "stale",
      "bg-fg-3": props.gps() === "unknown",
    }}
  />
);

/** The SignalK-link dot — a live link and a live GPS fail independently, so
 * it's its own dot. Same component on the desktop header and the phone bar. */
const SkDot: Component<{ status: Accessor<"off" | "connecting" | "connected"> }> = (props) => (
  <span
    class="size-1.5 shrink-0 rounded-full"
    classList={{
      "bg-ok": props.status() === "connected",
      "bg-notice": props.status() === "connecting",
      "bg-fg-3": props.status() === "off",
    }}
  />
);

/**
 * `band.rail`. On a wide screen the board is a distinct panel, a flex
 * sibling, so opening it resizes the chart rather than covering it. On a
 * phone it's the bottom sheet `Sheet` already builds.
 */
const Rail: Component<RailProps> = (props) => {
  const [board, setBoard] = createSignal(false);
  // `defer` so mount does not force the board open; every later bump opens it.
  createEffect(on(() => props.openBoard?.(), () => setBoard(true), { defer: true }));
  // The desktop board is a docked panel with no dialog behind it, so nothing
  // closed it from the keyboard: registering it here is what lets Escape (and
  // Back) peel it. The phone board is a modal `Sheet` — Kobalte closes that.
  useBackDismiss(
    () => board() && !isCompact(),
    () => setBoard(false),
  );

  // A WIDTH animation (0 ⇄ 408px), not a transform slide, so the chart RESIZES
  // smoothly beside it and is never covered — the hard layout rule. `mounted`
  // keeps the board content built while open or closing; `expanded` drives
  // the animated width.
  const [mounted, setMounted] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);
  createEffect(
    on(board, (open) => {
      if (open) {
        setMounted(true);
        if (prefersReducedMotion()) {
          setExpanded(true);
          return;
        }
        // Guard the deferred frame against a close that lands within it (a
        // double-click faster than one frame), so we never expand a shut board.
        requestAnimationFrame(() => board() && setExpanded(true));
      } else {
        setExpanded(false);
        // Reduced motion has no width transition, so `transitionend` never
        // fires — drop the content now.
        if (prefersReducedMotion()) setMounted(false);
      }
    }),
  );

  const density = (): Density => props.chrome().density;
  // A SEPARATE device fact from `density` since #DENS-SLIDER — see
  // `registry.ts`'s `Density` doc and `ChromeConfig.pointerCoarse`.
  const pointerCoarse = (): boolean => props.chrome().pointerCoarse;
  const railEditing = (): boolean => !!props.editing?.() && !!props.drag?.() && !!props.onChrome;
  // `targetCards` (board room) so the strip's editable list AGREES with the
  // drag's `visibleIds` and with the board's Rail tab.
  const railCards = (): Instrument[] => targetCards(props.reg, props.chrome(), RAIL_TARGET);
  // Light the whole strip while a card FROM ELSEWHERE is dragged over it — not
  // during a within-rail reorder, where the insertion line already reads.
  const railDropActive = (): boolean => {
    const dnd = props.drag?.();
    const id = dnd?.draggingId();
    if (!id || dnd!.overGrid() !== RAIL_TARGET) return false;
    return !railCards().some((i) => i.id === id);
  };
  // A SOLO chart mode (the route tool) suppresses the helm widgets — the one
  // authority a mode has over `band.rail`, read here rather than pushed from
  // the mode (the kernel filters, the mode only declares `solo`).
  const soloActive = () => {
    const id = props.activeMode?.();
    return !!(id && props.reg.modes.get(id)?.solo);
  };
  const tiles = () => (soloActive() ? [] : bandList(props.reg, props.chrome(), "rail"));
  // PHONE ONLY, gated on the mode's `ownsBottomBar`, NOT `soloActive()`: a
  // mode with its own bottom bar (the route editor's `RouteBar`) suppresses
  // the widget strip entirely rather than doubling up with it underneath.
  // Weather is also solo but has no replacement bar, so it keeps this strip.
  const routeBarActive = () => {
    const id = props.activeMode?.();
    return !!(id && props.reg.modes.get(id)?.ownsBottomBar);
  };
  // Driven by the registry, NOT the config: the alarm band is reserved chrome,
  // so a depth alarm counts whether or not you kept its tile on the rail.
  const alarms = () => alerts(props.reg).length;

  // Presence test WITHOUT reading the prop: `dashboard={<Dashboard/>}` compiles
  // to a getter that CONSTRUCTS a new Dashboard on every read, so a
  // `<Show when={props.dashboard}>` built a hidden extra board per read —
  // each one running its effects (registering a Back handler, publishing its
  // drag controller upward via `onDnd`). Only the slot that renders it reads it.
  const hasBoard = (): boolean => "dashboard" in props;
  const gripLabel = () => (board() ? "Close the dashboard" : "Open the dashboard");

  const barSwipe = createSwipeUp({ enabled: () => !board(), onOpen: () => setBoard(true) });

  /**
   * The hover card: desktop-only by the POINTER (invariant #10), not a media
   * query — `pointerCoarse` means gloves, and gloves don't hover. Never the
   * ONLY path to anything: everything it shows is one grip away on the board.
   */
  let asideEl: HTMLElement | undefined;
  const [hover, setHover] = createSignal<{ inst: Instrument; top: number } | null>(null);
  const raise = (inst: Instrument) => (e: MouseEvent) => {
    if (pointerCoarse() || !asideEl) return;
    const t = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const a = asideEl.getBoundingClientRect();
    // Clamp so a tile near the foot does not push the card off the bottom.
    setHover({ inst, top: Math.max(0, Math.min(t.top - a.top, a.height - 96)) });
  };

  return (
    <Show
      when={!isCompact()}
      fallback={
        <>
          {/* The phone bar is the dashboard's swipe surface — an upward pull
              opens the drawer, which is why the phone has no dashboard button. */}
          <Show when={!routeBarActive()}>
          <aside
            class="relative z-10 flex h-[calc(72px+env(safe-area-inset-bottom))] shrink-0 border-t border-line bg-chrome pb-[env(safe-area-inset-bottom)]"
            onTouchStart={barSwipe.onTouchStart}
            onTouchMove={barSwipe.onTouchMove}
            onTouchEnd={barSwipe.onTouchEnd}
            onTouchCancel={barSwipe.onTouchCancel}
          >
            {/* The grab pill: only for a coarse pointer (a mouse gets the
                desktop chevron), inert so it never eats a tile tap. */}
            <Show when={hasBoard()}>
              <div
                aria-hidden="true"
                class="pointer-events-none absolute inset-x-0 top-0 hidden justify-center pointer-coarse:flex"
              >
                <div class="h-1 w-9 -translate-y-1/2 rounded-full bg-fg-3/40" />
              </div>
            </Show>
            {/* Alarms are surfaced separately by the reserved AlarmStrip, so
                this is fix + link health only — no alarm dot here. */}
            <Show when={props.gpsStatus || props.signalkStatus}>
              <div class="flex w-9 shrink-0 flex-col items-center justify-center gap-1 border-r border-line-2 font-mono text-[7.5px] leading-none tracking-[0.04em] text-fg-2">
                <Show when={props.gpsStatus}>
                  {(gps) => (
                    <span class="flex items-center gap-0.5">
                      <GpsDot gps={gps()} />
                      GPS
                    </span>
                  )}
                </Show>
                <Show when={props.signalkStatus}>
                  {(status) => (
                    <span class="flex items-center gap-0.5">
                      <SkDot status={status()} />
                      SK
                    </span>
                  )}
                </Show>
              </div>
            </Show>
            <For each={tiles()}>
              {(inst) => (
                <Tile
                  inst={inst}
                  density={density()}
                  band="rail"
                  class="flex min-w-0 flex-1 flex-col items-center justify-center border-r border-line-2"
                  onClick={props.onInstrument && (() => props.onInstrument!(inst.id))}
                />
              )}
            </For>
            <Launcher
              density={density()}
              onSettings={props.onSettings}
              onCommandPalette={props.onCommandPalette}
              onRoutes={props.onRoutes}
              onNotices={props.onNotices}
              onBuddies={props.onBuddies}
              onMarks={props.onMarks}
              cpaMode={props.cpaMode}
              onCpaMode={props.onCpaMode}
              palette={props.palette}
              onPalette={props.onPalette}
              class="w-[52px] shrink-0 border-l border-line"
            />
          </aside>
          </Show>
          {/* Fixed height (85dvh), not content-sized, so it doesn't grow/shrink
              with widget count; `[1]` (fully open) since the board has no
              purpose-built compact peek to rest at, unlike route/weather. */}
          <Sheet open={board()} onOpenChange={setBoard} title="Dashboard" modal detents={[1]}>
            {props.dashboard}
          </Sheet>
        </>
      }
    >
      {/* The edge inset lives here, on the rightmost boundary, rather than on
          the strip: with the board open, the board is the screen-edge element. */}
      <div class="z-10 flex shrink-0 pr-[env(safe-area-inset-right)]">
        <aside
          ref={asideEl}
          class="relative flex shrink-0 flex-col border-l"
          style={{ width: `${railDensity(density()).railWidthPx}px` }}
          classList={{
            // Solid accent tint + border, never a blur (project UI rule).
            "border-line bg-chrome": !railDropActive(),
            "border-accent bg-accent/15": railDropActive(),
          }}
        >
          <Show when={hasBoard()}>
            <button
              type="button"
              aria-label={gripLabel()}
              aria-expanded={board()}
              title={gripLabel()}
              class="flex w-full shrink-0 items-center justify-center border-b border-line-2 bg-chrome-2 text-fg-3 hover:text-accent"
              style={{ height: `${railDensity(density()).grip}px` }}
              onClick={() => setBoard(!board())}
            >
              <Show when={board()} fallback={<ChevronLeft size={16} aria-hidden="true" />}>
                <ChevronRight size={16} aria-hidden="true" />
              </Show>
            </button>
          </Show>

          <div
            class="flex h-[26px] shrink-0 items-center justify-center gap-1 border-b border-line-2 font-mono text-[9.5px] text-fg-2"
            title="GPS fix · SignalK link · alarms"
          >
            <Show when={props.gpsStatus}>
              {(gps) => (
                <>
                  <GpsDot gps={gps()} />
                  GPS
                </>
              )}
            </Show>
            <Show when={props.signalkStatus}>
              {(status) => (
                <>
                  <SkDot status={status()} />
                  SK
                </>
              )}
            </Show>
            <span class="size-1.5 shrink-0 rounded-full" classList={{ "bg-ok": !alarms(), "bg-alarm": !!alarms() }} />
            {alarms()}
          </div>

          {/* Overflow is TOLD, not solved (invariant #5): enable more than fits
              and this scrolls; nothing is demoted or dropped, since order is
              the user's. Scrollbar hidden — a gloved thumb doesn't use one. */}
          <div class="min-h-0 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <Show
              when={railEditing() ? props.drag?.() : undefined}
              fallback={
                <For each={tiles()}>
                  {(inst) => (
                    <Tile
                      inst={inst}
                      density={density()}
                      band="rail"
                      class="border-b border-line-2"
                      onHover={raise(inst)}
                      onLeave={() => setHover(null)}
                      onClick={props.onInstrument && (() => props.onInstrument!(inst.id))}
                    />
                  )}
                </For>
              }
            >
              {(dnd) => (
                <WidgetDropZone
                  target={RAIL_TARGET}
                  items={railCards()}
                  dnd={dnd()}
                  chrome={props.chrome}
                  onChrome={props.onChrome!}
                  density={density()}
                  widgetReg={props.widgetReg}
                  layoutClass="flex flex-col"
                  axis="y"
                  renderCell={(inst) => (
                    <Tile inst={inst} density={density()} band="rail" class="border-b border-line-2" />
                  )}
                  onDragStart={(inst, target, e, opts) => dnd().start(inst.id, target, e, opts)}
                />
              )}
            </Show>
          </div>

          <Show when={!board() && !pointerCoarse() && hover()}>
            {(h) => {
              const view = () =>
                readInstrument(h().inst, { density: DESK, band: "rail", room: "board" });
              return (
                <div
                  class="pointer-events-none absolute right-full z-30 mr-2 w-[176px] rounded-md border border-line bg-chrome p-2.5"
                  style={{ top: `${h().top}px`, "box-shadow": "0 8px 26px var(--color-shadow)" }}
                >
                  <h5 class="mb-1 font-mono text-[8.5px] tracking-[0.06em] text-fg-3">
                    {h().inst.label.toUpperCase()}
                  </h5>
                  <div
                    class="font-mono text-[19px] font-semibold tracking-[-0.03em] tabular-nums"
                    classList={readingValueClasses(view())}
                  >
                    {view().reading.value}
                    <Show when={view().reading.unit}>
                      {(unit) => <span class="ml-[3px] text-[10px] font-normal text-fg-2">{unit()}</span>}
                    </Show>
                  </div>
                  <Show when={view().reading.sub}>
                    {(sub) => (
                      <div class="mt-0.5 font-mono text-[10px] leading-[1.5] text-fg-2">{sub()}</div>
                    )}
                  </Show>
                </div>
              );
            }}
          </Show>

          <div class="flex shrink-0 flex-col border-t border-line">
            <Launcher
              density={density()}
              onSettings={props.onSettings}
              onCommandPalette={props.onCommandPalette}
              onRoutes={props.onRoutes}
              onNotices={props.onNotices}
              onBuddies={props.onBuddies}
              onMarks={props.onMarks}
              cpaMode={props.cpaMode}
              onCpaMode={props.onCpaMode}
              palette={props.palette}
              onPalette={props.onPalette}
              class="w-full"
              style={{ height: `${railDensity(density()).button}px` }}
            />
          </div>
        </aside>

        {/* The inner content is held at a fixed 408px and clipped so it doesn't
            reflow while the outer box's width animates. */}
        <Show when={hasBoard()}>
          <div
            class="flex shrink-0 flex-col overflow-hidden"
            style={{
              width: expanded() ? "408px" : "0px",
              transition: prefersReducedMotion()
                ? "none"
                : "width var(--duration-sheet) var(--ease-sheet)",
            }}
            onTransitionEnd={(e) => {
              // Only the collapse (width → 0) tears the content down; the width
              // property guards against unrelated transitions bubbling up.
              if (e.propertyName === "width" && !board()) setMounted(false);
            }}
          >
            <Show when={mounted()}>
              <div class={`flex h-full flex-col border-l border-line bg-chrome ${BOARD_WIDTH}`}>
                <div class="min-h-0 flex-1 overflow-y-auto">{props.dashboard}</div>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  );
};

export default Rail;
