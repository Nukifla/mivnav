// The one sheet (D5): declarative modal/non-modal + desktop-presentation
// config replacing three separate bottom-sheet implementations. See
// docs/architecture/sheet-component.md. Gesture physics: ../gesture.ts;
// enter/exit stage machine: ./useEnterExit.ts (shared with CommandPalette).

import { Dialog } from "@kobalte/core/dialog";
import { Show, createSignal, onCleanup, type Component, type JSX } from "solid-js";
import { isCompact, prefersReducedMotion } from "../media";
import { createSheetDrag, SheetDragContext, snapOffsets } from "../gesture";
import { createEnterExit } from "./useEnterExit";

/** The edge a sheet hangs off. `bottom` is the phone presentation. */
export type SheetSide = "bottom" | "left" | "right";

/**
 * The fraction of the viewport the bottom sheet may cover — the `85dvh` in
 * {@link sheetLayout}. Stated twice (Tailwind needs the literal); test-pinned.
 */
export const SHEET_MAX_FRACTION = 0.85;

/** The phone-sheet stacking scale (#DRAWER-ZORDER, user decision) — see
 * docs/architecture/sheet-component.md for the modal-vs-non-modal rule. */
export const SHEET_Z = {
  /** Route-edit mode sheet — the lowest sheet; still clears the rail (z-10). */
  routeEdit: 20,
  /** Work-with-the-chart mode sheets (weather, and any future mode). */
  mode: 30,
  /** The feature-info peek — above the mode it can co-exist with. */
  info: 40,
  /** Modal read-and-dismiss overlays: Layers, Settings, Routes, Dashboard.
   *  Above every mode; below the command palette. */
  modal: 45,
  /** Popovers/menus (z-50, the literal Tailwind class they carry — test-pinned
   *  to this value). Above the modal sheet, because a popover opened FROM the
   *  dashboard/settings sheet must not paint behind it (#BOARD-PHONE). */
  popover: 50,
  /** The fullscreen photo viewer (./Lightbox.tsx) — opened FROM a sheet or a
   *  modal, so above them all, and above the palette/popovers (z-50…60) and
   *  the colour picker (z-70) it can never co-exist with anyway. */
  lightbox: 80,
} as const;

/**
 * Where an overlay (popover, confirm bar) opened from `el` must mount: the
 * enclosing MODAL phone sheet's panel, else `undefined` (= document.body).
 *
 * Why not the body: a modal Kobalte Dialog sets `pointer-events: none` on the
 * body and cancels every `touchmove` outside its own content (its scroll
 * lock), so a body-portaled popover opened from inside the sheet can't be
 * tapped (it also paints under the z-45 panel) and its list can't be
 * touch-scrolled — raising its z alone fixes neither. Inside the panel it is
 * part of the dialog: tappable, scrollable, no outside-dismiss. The panel's
 * `transform` re-anchors `position: fixed` to the panel, which for a
 * full-width bottom-pinned sheet is the same place; Kobalte's popper
 * positions `absolute` against its offset parent, so it is unaffected.
 */
export function modalSheetMount(el: Element | null | undefined): HTMLElement | undefined {
  return el?.closest<HTMLElement>("[data-sheet-modal]") ?? undefined;
}

/** How much chart a surface hides, in container px per edge — shaped like
 * MapLibre's padding for fitting a geometry into what's left (../info/marker.ts).
 * `top` is the nav-readout band (chrome/TopBand.tsx), present only on a
 * phone following a leg; {@link measureObscured} reads it off `[data-nav-band]`. */
export interface ObscuredEdges {
  bottom: number;
  top?: number;
}

/**
 * The pure arithmetic behind {@link measureObscured} (no DOM in the test
 * harness). `bottom`/`top` are ACTUAL measured coverage, not a guessed
 * fraction of the viewport, so a peeking or dragged sheet reports correctly.
 */
export function obscuredFromRects(args: {
  compact: boolean;
  container: { top: number; bottom: number; clientHeight: number };
  navBand?: { bottom: number };
  sheet?: { top: number };
}): ObscuredEdges {
  if (!args.compact) return { bottom: 0 };
  const { container } = args;
  const top = args.navBand ? Math.max(0, args.navBand.bottom - container.top) : 0;
  const bottom = args.sheet
    ? Math.min(container.clientHeight, Math.max(0, container.bottom - args.sheet.top))
    : 0;
  return { bottom, top };
}

/**
 * How much of the chart the info surface actually covers, measured off the
 * live DOM — the one coverage figure the three chart cursors share (info
 * marker, weather/measure crosshairs). See docs/architecture/sheet-component.md.
 */
export function measureObscured(container: HTMLElement): ObscuredEdges {
  if (typeof document === "undefined") return { bottom: 0 };
  const c = container.getBoundingClientRect();
  const navBand = document.querySelector<HTMLElement>("[data-nav-band]");
  const sheet = document.querySelector<HTMLElement>("[data-sheet-panel]");
  return obscuredFromRects({
    compact: isCompact(),
    container: { top: c.top, bottom: c.bottom, clientHeight: container.clientHeight },
    navBand: navBand?.getBoundingClientRect(),
    sheet: sheet?.getBoundingClientRect(),
  });
}

/** Px from the viewport's bottom to just above the highest shown
 * `[data-keep-clear]` element — the mode pill, the MOB button — or 0 if none:
 * the `bottomInset` a non-modal phone sheet takes so it never covers them. */
export function measureKeepClearInset(gap = 6): number {
  if (typeof document === "undefined") return 0;
  let inset = 0;
  for (const el of document.querySelectorAll<HTMLElement>("[data-keep-clear]")) {
    const r = el.getBoundingClientRect();
    if (r.height === 0 || r.width === 0) continue;
    inset = Math.max(inset, Math.round(window.innerHeight - r.top + gap));
  }
  return inset;
}

export interface SheetLayout {
  /** Overlay + focus trap + scroll lock + dismiss-on-outside, all four. */
  modal: boolean;
  /** Anchor, size and corners — everything the edge decides. */
  contentClass: string;
}

/**
 * The phone MODAL sheet's container shape. `fixedHeight` swaps the
 * content-driven `max-h-[85dvh]` cap for a hard `h-[85dvh]`: a modal sheet
 * with explicit `detents` (dashboard only) needs a stable height for those.
 */
export function phoneModalShape(fullscreen: boolean, fixedHeight = false): string {
  if (fullscreen) return "inset-0 pt-[env(safe-area-inset-top)]";
  // Literal 85dvh (not the constant) so Tailwind's scanner emits it; the test
  // pins it to SHEET_MAX_FRACTION.
  if (fixedHeight) return "inset-x-0 bottom-0 h-[85dvh] rounded-t-2xl";
  return sheetLayout("bottom").contentClass;
}

/** A sheet's shape *and* modality, from the edge it hangs off: a bottom sheet
 * covers the chart to the ankles so it must be modal; an edge drawer leaves
 * the chart visible, so it must not block dragging behind it. */
export function sheetLayout(side: SheetSide): SheetLayout {
  switch (side) {
    case "bottom":
      // dvh, not vh: mobile browser chrome must not push the sheet's bottom
      // (and its scroll container) off-screen.
      return { modal: true, contentClass: "inset-x-0 bottom-0 max-h-[85dvh] rounded-t-2xl" };
    case "left":
      return {
        modal: false,
        contentClass: "inset-y-0 left-0 w-[22rem] max-w-[85vw] pl-[env(safe-area-inset-left)]",
      };
    case "right":
      return {
        modal: false,
        contentClass: "inset-y-0 right-0 w-[22rem] max-w-[85vw] pr-[env(safe-area-inset-right)]",
      };
  }
}

/**
 * The detent OFFSETS (px, ascending) for a phone sheet, pure. Priority:
 * explicit `detents` → measured height; else `peek` → [full, peek]; else `[0]`.
 */
export function sheetSnaps(args: {
  detents?: number[];
  sheetHeight: number;
  peekHeight: number;
  hasPeek: boolean;
}): number[] {
  if (args.detents) return snapOffsets(args.detents, args.sheetHeight);
  if (args.hasPeek) {
    const p = Math.max(0, args.sheetHeight - args.peekHeight);
    return p > 0 ? [0, p] : [0];
  }
  return [0];
}

/** The sheet's lowest detent (largest offset) — where it OPENS and where a
 * floor-at-peek drag-down settles. Empty pins to 0 (fully open). */
export function lowestSnap(snaps: number[]): number {
  return snaps.length ? snaps[snaps.length - 1]! : 0;
}

/**
 * Is a peek slot present? A REFERENCE check on the render thunk, never an
 * invocation (#RT-PEEK) — see docs/architecture/sheet-component.md.
 */
export function hasPeek(peek?: () => JSX.Element): boolean {
  return peek != null;
}

/**
 * The overscroll-detach cover: an upward overdrag lifts the sheet off its
 * docked floor, opening a strip that would show whatever's behind — this
 * `::after` continues `bg-chrome` past `bottom-0` so it always reads as sheet.
 */
const OVERSCROLL_BG =
  "after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-[50vh] after:bg-chrome after:content-['']";

/** The shadow token, not `shadow-2xl` — `--color-shadow` is a shadow COLOUR
 * (index.css) that goes the OTHER way from black: ~0.18 alpha by day, ~0.7 at
 * night, so the drawer's edge survives the night palette that most needs it. */
const SHEET_SHADOW = "0 10px 40px var(--color-shadow)";

/** The title bar shared by the modal phone sheet and the edge drawer. */
const SheetHeader: Component<{ title: string }> = (props) => (
  <div class="flex items-center justify-between gap-2 border-b border-line-2 py-1 pl-4 pr-1">
    <Dialog.Title class="font-semibold">{props.title}</Dialog.Title>
    <Dialog.CloseButton
      // The floor is a drag surface (below); data-no-drag stops a jittery
      // close-button tap from dragging the sheet instead (../gesture.ts).
      data-no-drag
      class="flex size-11 items-center justify-center rounded-full text-2xl leading-none text-fg-2 hover:bg-chrome-2"
      aria-label="Close"
    >
      ×
    </Dialog.CloseButton>
  </div>
);

/** The grab pill — the same handle every sheet wears. */
const GrabPill: Component = () => (
  <div aria-hidden="true" class="mx-auto h-1 w-10 rounded-full bg-fg-3/40" />
);

/** `edge-drawer` — a non-modal Kobalte side sheet beside a chart the mariner
 * is still reading. Mouse-first; deliberately no finger-tracking drag. */
const EdgeDrawer: Component<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  side: "left" | "right";
  children: JSX.Element;
}> = (props) => {
  const reduce = prefersReducedMotion;
  const layout = () => sheetLayout(props.side);
  const requestClose = (): void => props.onOpenChange(false);
  // rendered keeps the Dialog mounted through the exit slide (./useEnterExit.ts).
  const ee = createEnterExit({ open: () => props.open, closeProperty: "transform" });
  const offscreen = (): string => (props.side === "left" ? "-100%" : "100%");
  const drawerStyle = (): JSX.CSSProperties => ({
    "box-shadow": SHEET_SHADOW,
    transform: `translateX(${ee.stage() === "open" ? "0" : offscreen()})`,
    opacity: ee.stage() === "open" ? 1 : 0,
    transition: reduce()
      ? "none"
      : "transform var(--duration-sheet) var(--ease-sheet), opacity var(--duration-sheet) ease-out",
  });
  return (
    <Dialog
      open={ee.rendered()}
      onOpenChange={(isOpen) => {
        if (!isOpen) requestClose();
      }}
      modal={false}
    >
      <Dialog.Portal>
        <Dialog.Content
          class={`fixed z-20 flex flex-col bg-chrome text-sm text-fg ${layout().contentClass}`}
          style={drawerStyle()}
          onTransitionEnd={ee.handleTransitionEnd}
          // A non-modal drawer has to survive the gesture it exists for: panning
          // the chart to see what a setting did is an interaction outside it, and
          // Kobalte would otherwise read that as a dismiss.
          onInteractOutside={(e) => e.preventDefault()}
          // Escape restored: Kobalte's Accordion preventDefault()s it via its
          // own selection manager, so Dialog would otherwise decline to
          // dismiss. This hook fires first.
          onEscapeKeyDown={() => requestClose()}
        >
          <SheetHeader title={props.title} />
          <div class="overflow-y-auto overscroll-contain p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {props.children}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  );
};

interface PhoneSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  detents?: number[];
  modal: boolean;
  fullscreen: boolean;
  dismissable: boolean;
  overdragAbove: boolean;
  peek?: () => JSX.Element;
  position: "fixed" | "absolute";
  fill: boolean;
  bottomInset: number;
  z: number;
  bodyClass: string;
  children: JSX.Element;
}

/**
 * The phone bottom sheet — a drawer that follows the thumb. Modal or not; one,
 * two or three detents; dismissable or floor-at-peek, all from props. Transform
 * is owned here (../gesture.ts); mount/animate lifecycle is ./useEnterExit.ts.
 */
const PhoneSheet: Component<PhoneSheetProps> = (props) => {
  const reduce = prefersReducedMotion;
  // Where the sheet rests when not dragged (px, 0 = fully open, larger = lower).
  const [resting, setResting] = createSignal(0);
  // Measured peek height, a signal so a late layout (a slider) re-derives the
  // detents. Only meaningful for the measured-peek (no-detents) case.
  const [peekH, setPeekH] = createSignal(0);

  let contentEl: HTMLElement | undefined;
  let peekEl: HTMLElement | undefined;
  let bodyEl: HTMLElement | undefined;

  const measuredPeek = (): boolean => props.detents == null && hasPeek(props.peek);
  const sheetHeight = (): number => contentEl?.offsetHeight ?? 0;
  const measure = (): void => {
    if (peekEl) setPeekH(peekEl.offsetHeight);
  };
  const snaps = (): number[] =>
    sheetSnaps({
      detents: props.detents,
      sheetHeight: sheetHeight(),
      peekHeight: peekH(),
      hasPeek: hasPeek(props.peek),
    });
  const lowestOffset = (): number => lowestSnap(snaps());

  const ee = createEnterExit({
    open: () => props.open,
    closeProperty: "transform",
    onEnter: () => {
      if (measuredPeek()) measure();
      setResting(lowestOffset());
    },
    onFinishClose: () => setResting(0),
  });

  // Re-measure a measured-peek sheet on any content resize (the slider laying
  // out, a field toggle growing the body). If it is resting at peek, follow the
  // new peek so the control stays fully shown.
  const observe = (el: HTMLElement | undefined): void => {
    if (!el || !measuredPeek() || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const wasPeek = resting() === lowestOffset();
      measure();
      if (wasPeek || resting() > lowestOffset()) setResting(lowestOffset());
    });
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  };

  const requestClose = (): void => props.onOpenChange(false);

  const drag = createSheetDrag({
    scrollEl: () => bodyEl,
    restingOffset: resting,
    snapOffsets: snaps,
    onSnap: setResting,
    onDismiss: () => {
      if (props.dismissable) {
        // beginClose sets `closing` so `translate` reads 100% this same tick —
        // no jump back.
        ee.beginClose();
        requestClose();
      } else {
        // Floor at peek: a task sheet never dismisses on a drag.
        setResting(lowestOffset());
      }
    },
    overdragAbove: props.overdragAbove,
  });

  const translate = (): string => {
    if (ee.stage() === "closing") return "100%";
    if (drag.dragging()) return `${drag.offset()}px`;
    if (ee.stage() === "pre") return "100%";
    return `${resting()}px`;
  };

  // The chart dims as a MODAL sheet covers it, and un-dims 1:1 as it is dragged
  // down — a live tie between the surface and what it hides.
  const overlayOpacity = (): number => {
    if (ee.stage() !== "open") return 0;
    const h = sheetHeight();
    if (h <= 0) return 1;
    const hidden = drag.dragging() ? Math.max(0, drag.offset()) : resting();
    return Math.max(0, 1 - hidden / h);
  };

  /** How much of the sheet's foot is lowered below its resting line. */
  const clipBelow = (): string => {
    const t = translate();
    return t.endsWith("%") ? t : `${Math.max(0, parseFloat(t))}px`;
  };

  const settling = (): boolean => drag.dragging() || reduce();

  const containerClass = (): string => {
    if (props.modal) {
      // Explicit detents (dashboard only) get a fixed height so the board
      // stops resizing to its widget count (see phoneModalShape).
      const fixedHeight = props.detents != null && !props.fullscreen;
      return `fixed flex flex-col bg-chrome text-sm text-fg ${OVERSCROLL_BG} ${phoneModalShape(props.fullscreen, fixedHeight)}`;
    }
    // Inset off the floor: height comes from contentStyle (calc), and no
    // overscroll cover — it would paint over whatever the inset keeps clear.
    if (props.bottomInset > 0)
      return `${props.position} inset-x-0 flex flex-col rounded-t-2xl border-t border-line-2 bg-chrome text-sm text-fg`;
    const height = props.fill ? "h-[88dvh]" : "max-h-[85dvh]";
    return `${props.position} inset-x-0 bottom-0 flex ${height} flex-col rounded-t-2xl border-t border-line-2 bg-chrome text-sm text-fg ${OVERSCROLL_BG}`;
  };

  const contentStyle = (): JSX.CSSProperties => ({
    "box-shadow": props.modal ? SHEET_SHADOW : "0 -10px 40px var(--color-shadow)",
    // Modal panel rides above its own scrim (both SHEET_Z.modal, panel later
    // in DOM); non-modal uses its declared `z`.
    "z-index": props.modal ? SHEET_Z.modal : props.z,
    ...(!props.modal && props.bottomInset > 0
      ? {
          bottom: `${props.bottomInset}px`,
          [props.fill ? "height" : "max-height"]: `calc(${props.fill ? 88 : 85}dvh - ${props.bottomInset}px)`,
        }
      : {}),
    transform: `translateY(${translate()})`,
    // Inset off the floor, the part a detent lowers below the inset line is
    // clipped — it would otherwise cover what the inset keeps clear.
    ...(!props.modal && props.bottomInset > 0 ? { "clip-path": `inset(0 0 ${clipBelow()} 0)` } : {}),
    transition: settling()
      ? "none"
      : `transform var(--duration-sheet) var(--ease-sheet)${!props.modal && props.bottomInset > 0 ? ", clip-path var(--duration-sheet) var(--ease-sheet)" : ""}`,
  });

  // The whole floor (grab pill + header/peek) owns the drag outright, not just
  // the pill, so a thumb anywhere on it drags (#NO-PULL-REFRESH). Interactive
  // controls inside tag `data-no-drag` to tap instead (../gesture.ts `begin`).
  const Body: Component = () => (
    <>
      <div
        ref={(el) => (peekEl = el)}
        class="shrink-0 touch-none"
        onTouchStart={drag.handle.onTouchStart}
        onTouchMove={drag.handle.onTouchMove}
        onTouchEnd={drag.handle.onTouchEnd}
        onTouchCancel={drag.handle.onTouchCancel}
      >
        <div class="py-2.5">
          <GrabPill />
        </div>
        <Show when={props.modal}>
          <SheetHeader title={props.title} />
        </Show>
        {props.peek?.()}
      </div>
      {/* Scroll body is the drag-vs-scroll handoff surface (../gesture.ts). */}
      <div
        ref={(el) => {
          bodyEl = el;
          drag.bindBody(el);
        }}
        class={props.bodyClass}
      >
        {/* Shares this drag so a nested pager can forward its vertical axis
            (../gesture.ts createPagerDrag); inert for every other body. */}
        <SheetDragContext.Provider value={drag}>{props.children}</SheetDragContext.Provider>
      </div>
    </>
  );

  return (
    <Show
      when={props.modal}
      fallback={
        <Show when={ee.rendered()}>
          <div
            // Tagged so the chart can MEASURE coverage (measureObscured,
            // shared by the info marker and weather/measure crosshairs) —
            // queryable exactly like `[data-nav-band]`.
            data-sheet-panel
            ref={(el) => {
              contentEl = el;
              observe(el);
            }}
            class={containerClass()}
            style={contentStyle()}
            onTransitionEnd={ee.handleTransitionEnd}
          >
            <Body />
          </div>
        </Show>
      }
    >
      <Dialog
        open={ee.rendered()}
        onOpenChange={(isOpen) => {
          // Backdrop/outside dismissal → the animated close; `rendered` stays
          // true so Kobalte never unmounts mid-slide.
          if (!isOpen) requestClose();
        }}
        modal
      >
        <Dialog.Portal>
          <Dialog.Overlay
            class="fixed inset-0 bg-black/40"
            // Inline opacity: Kobalte mounts via its own presence, so a
            // class-driven fade can miss the first frame.
            style={{
              "z-index": SHEET_Z.modal,
              opacity: overlayOpacity(),
              transition: settling() ? "none" : "opacity var(--duration-sheet) ease-out",
            }}
          />
          <Dialog.Content
            // Same tag as the non-modal branch: whichever renders is the sheet
            // the chart must measure (measureObscured).
            data-sheet-panel
            // The mount point for overlays opened from INSIDE this sheet
            // (see `modalSheetMount`).
            data-sheet-modal
            ref={(el) => (contentEl = el)}
            class={containerClass()}
            style={contentStyle()}
            onEscapeKeyDown={() => requestClose()}
            onTransitionEnd={ee.handleTransitionEnd}
          >
            <Body />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </Show>
  );
};

/** `floating-card` — a corner annotation. Fades and scales up from ~0.97 to 1
 * on the way in and back on the way out, the SAME feel as the command palette
 * (chrome/CommandPalette.tsx), so a summoned desktop surface never just pops. */
const FloatingCard: Component<{ open: boolean; class?: string; children: JSX.Element }> = (
  props,
) => {
  const reduce = prefersReducedMotion;
  const ee = createEnterExit({ open: () => props.open });
  return (
    <Show when={ee.rendered()}>
      <div
        class={`absolute z-10 rounded-lg bg-chrome p-3 text-sm text-fg ${props.class ?? ""}`}
        style={{
          "box-shadow": "0 4px 18px var(--color-shadow)",
          opacity: ee.stage() === "open" ? 1 : 0,
          transform: `scale(${ee.stage() === "open" ? 1 : 0.97})`,
          "transform-origin": "top center",
          transition: reduce()
            ? "none"
            : "opacity var(--duration-fast) ease-out, transform var(--duration-fast) ease-out",
        }}
        onTransitionEnd={ee.handleTransitionEnd}
      >
        {props.children}
      </div>
    </Show>
  );
};

/** `bottom-bar` — a glanceable readout row inset over the chart. The wrapper
 * owns the fixed positioning so the transform lives on the fixed element
 * itself — a transform on an ancestor of a fixed child would re-anchor it. */
const BottomBar: Component<{ open: boolean; content: JSX.Element }> = (props) => {
  const reduce = prefersReducedMotion;
  const ee = createEnterExit({ open: () => props.open, closeProperty: "transform" });
  return (
    <Show when={ee.rendered()}>
      <div
        class="pointer-events-none fixed bottom-3 left-3 right-3 z-40"
        style={{
          transform: `translateY(${ee.stage() === "open" ? "0" : "100%"})`,
          opacity: ee.stage() === "open" ? 1 : 0,
          transition: reduce()
            ? "none"
            : "transform var(--duration-sheet) var(--ease-sheet), opacity var(--duration-sheet) ease-out",
        }}
        onTransitionEnd={ee.handleTransitionEnd}
      >
        {props.content}
      </div>
    </Show>
  );
};

/** Desktop presentation — declared, one of three blessed idioms (fork 1). */
export type SheetDesktop =
  | { kind: "edge-drawer"; side: "left" | "right" }
  | { kind: "floating-card"; class?: string }
  | { kind: "bottom-bar"; content: JSX.Element }
  | { kind: "none" };

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Sheet header text; also the dialog's accessible name. Rendered as a title
   *  bar only by the modal phone sheet and the edge drawer; a non-modal task
   *  sheet carries its own header inside `peek`. */
  title: string;
  /**
   * Snap fractions (1 = fully open), ascending or not — {@link snapOffsets}
   * sorts. Omit to derive a measured [full, peek] from the `peek` slot, or (with
   * no peek) a single fully-open detent.
   */
  detents?: number[];
  /** Modal phone sheet: Kobalte Dialog + overlay dim + focus trap + scroll lock
   *  (read-and-dismiss). Non-modal (default): a plain positioned surface the
   *  chart stays live under. Governs the phone sheet only. */
  modal?: boolean;
  /** Phone modal only: fill the whole viewport instead of an 85dvh bottom
   *  drawer, for whole-view surfaces (charts & settings, layers). No effect
   *  on desktop or a non-modal task sheet. Default false. */
  fullscreen?: boolean;
  /** May a drag-down dismiss the sheet? Defaults to `modal` — read surfaces
   *  swipe away; task sheets floor at peek and exit only via their own control,
   *  so a stray flick never eats a draft. */
  dismissable?: boolean;
  /** May the sheet rubber-band ABOVE fully-open? Defaults to `dismissable`. A
   *  floor-at-peek task sheet passes `false` so an upward flick cannot lift a
   *  `bottom-0` sheet off the floor and expose the rail beneath it. */
  overdragAbove?: boolean;
  /** Always-visible content below the grab strip, as a render THUNK so
   *  testing its presence ({@link hasPeek}) never instantiates it (#RT-PEEK).
   *  When `detents` is omitted its measured height derives the peek detent. */
  peek?: () => JSX.Element;
  /** Desktop presentation. Defaults to `none` (phone-only). */
  desktop?: SheetDesktop;
  /** Phone container positioning: `fixed` (default) or `absolute` — the route
   *  sheet is `absolute` so it sits inside the map pane, above the rail bar. */
  position?: "fixed" | "absolute";
  /** Fill a tall fixed height (route's three detents need a stable height to be
   *  fractions of) rather than sizing to content (default). */
  fill?: boolean;
  /** Non-modal phone sheet only: rest this many px above the viewport's
   *  foot instead of on it (e.g. above a mode pill that must stay reachable).
   *  The height shrinks by the same amount. Default 0. */
  bottomInset?: number;
  /** Stacking for the non-modal phone sheet. One of the {@link SHEET_Z} scale;
   *  defaults to `SHEET_Z.mode`. Modal sheets ignore this and use
   *  `SHEET_Z.modal` (they sit above every mode). */
  z?: number;
  /** Scroll-body class override — a couple of surfaces pad differently. */
  bodyClass?: string;
  children: JSX.Element;
}

const DEFAULT_BODY_CLASS =
  "min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]";

/**
 * The one summoned surface. Picks phone-vs-desktop by `isCompact()`; on the
 * phone it is {@link PhoneSheet} configured by the modality props; on the
 * desktop it is the declared {@link SheetDesktop} idiom.
 */
const Sheet: Component<SheetProps> = (props) => {
  const modal = () => props.modal ?? false;
  const dismissable = () => props.dismissable ?? modal();
  const desktop = (): SheetDesktop => props.desktop ?? { kind: "none" };

  const Desktop: Component = () => (
    <Show when={desktop()} keyed>
      {(d) => {
        switch (d.kind) {
          case "edge-drawer":
            return (
              <EdgeDrawer
                open={props.open}
                onOpenChange={props.onOpenChange}
                title={props.title}
                side={d.side}
              >
                {props.peek?.()}
                {props.children}
              </EdgeDrawer>
            );
          case "floating-card":
            return (
              <FloatingCard open={props.open} class={d.class}>
                {props.children}
              </FloatingCard>
            );
          case "bottom-bar":
            return <BottomBar open={props.open} content={d.content} />;
          case "none":
            return null;
        }
      }}
    </Show>
  );

  return (
    <Show when={isCompact()} fallback={<Desktop />}>
      <PhoneSheet
        open={props.open}
        onOpenChange={props.onOpenChange}
        title={props.title}
        detents={props.detents}
        modal={modal()}
        fullscreen={props.fullscreen ?? false}
        dismissable={dismissable()}
        overdragAbove={props.overdragAbove ?? dismissable()}
        peek={props.peek}
        position={props.position ?? "fixed"}
        fill={props.fill ?? false}
        bottomInset={props.bottomInset ?? 0}
        z={props.z ?? SHEET_Z.mode}
        bodyClass={props.bodyClass ?? DEFAULT_BODY_CLASS}
      >
        {props.children}
      </PhoneSheet>
    </Show>
  );
};

export default Sheet;
