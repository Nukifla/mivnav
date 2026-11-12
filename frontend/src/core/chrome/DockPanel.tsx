// The docked desktop panel (route list, etc): a flex SIBLING of the map, not
// an overlay, so opening it shrinks the map pane instead of covering it. See
// docs/architecture/dock-panel.md for the width-animation mechanism and why.
// Desktop-only — compact screens keep rendering the bottom `Sheet` instead.

import { Show, createEffect, createSignal, on, type Component, type JSX } from "solid-js";
import { prefersReducedMotion } from "../media";
import { isFreeEscape } from "./escape";

/** The docked column's width — the `22rem` the floating edge-drawer used, so the
 * change is purely overlay→docked and nothing about the surface's size moves. */
export const PANEL_WIDTH = "22rem";

export interface DockPanelProps {
  open: boolean;
  onClose: () => void;
  /** Header text + the panel's accessible name. */
  title: string;
  /** Which edge the panel docks to — decides which side carries the seam border
   *  against the map. `left` for the settings/routes panels. */
  side: "left" | "right";
  children: JSX.Element;
}

const DockPanel: Component<DockPanelProps> = (props) => {
  // `mounted` keeps the content built through the close slide; `expanded` drives
  // the animated width. Opening: mount, then next frame expand from 0. Closing:
  // collapse to 0 and drop the content on the width `transitionend`.
  const [mounted, setMounted] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (open) {
          setMounted(true);
          if (prefersReducedMotion()) {
            setExpanded(true);
            return;
          }
          // Guard the deferred frame against a close landing within it, so we
          // never expand a shut panel.
          requestAnimationFrame(() => props.open && setExpanded(true));
        } else {
          setExpanded(false);
          // Reduced motion has no width transition, so `transitionend` never
          // fires — drop the content now; otherwise the collapse's does.
          if (prefersReducedMotion()) setMounted(false);
        }
      },
    ),
  );

  const borderSide = () => (props.side === "left" ? "border-r" : "border-l");

  return (
    <div
      class="z-10 flex shrink-0 flex-col overflow-hidden"
      style={{
        width: expanded() ? PANEL_WIDTH : "0px",
        transition: prefersReducedMotion()
          ? "none"
          : "width var(--duration-sheet) var(--ease-sheet)",
      }}
      onTransitionEnd={(e) => {
        // Only the collapse (width → 0) tears the content down; the width guard
        // stops an unrelated transition bubbling up from dropping it.
        if (e.propertyName === "width" && !props.open) setMounted(false);
      }}
    >
      <Show when={mounted()}>
        <div
          class={`flex h-full flex-col ${borderSide()} border-line bg-chrome text-sm text-fg`}
          style={{ width: PANEL_WIDTH }}
          // Escape with focus INSIDE closes this panel, as the edge-drawer it
          // replaces did (with focus elsewhere it closes as the topmost layer,
          // via ./escape.ts). Claimed with `preventDefault` so the app-level
          // Escape does not close a second window on the same press; and only a
          // free Escape — a non-empty filter field clears first. No focus trap
          // and no scroll lock — a docked panel is non-modal by nature (the chart
          // beside it stays live), matching the board.
          onKeyDown={(e) => {
            if (!isFreeEscape(e)) return;
            e.preventDefault();
            props.onClose();
          }}
        >
          <div class="flex items-center justify-between gap-2 border-b border-line-2 py-1 pl-4 pr-1">
            <h2 class="font-semibold">{props.title}</h2>
            <button
              type="button"
              onClick={() => props.onClose()}
              aria-label="Close"
              class="flex size-11 items-center justify-center rounded-full text-2xl leading-none text-fg-2 hover:bg-chrome-2"
            >
              ×
            </button>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {props.children}
          </div>
        </div>
      </Show>
    </div>
  );
};

export default DockPanel;
