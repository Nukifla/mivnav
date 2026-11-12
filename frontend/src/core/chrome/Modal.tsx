// The centred modal: third desktop presentation, beside `DockPanel` and
// `Sheet`'s edge drawer. Phone always uses `Sheet` instead (`!isCompact()`
// gates this). See docs/architecture/settings-modal.md and sheet-component.md.

import { Dialog } from "@kobalte/core/dialog";
import type { Component, JSX } from "solid-js";
import { prefersReducedMotion } from "../media";
import { useBackDismiss } from "./backStack";
import { SHEET_Z } from "./Sheet";
import { createEnterExit } from "./useEnterExit";

/** The shadow token, not `shadow-2xl` — `--color-shadow` is a shadow COLOUR
 * (index.css) that goes the OTHER way from black: ~0.18 alpha by day, ~0.7 at
 * night, so the card's edge survives the night palette that most needs it. */
const MODAL_SHADOW = "0 10px 40px var(--color-shadow)";

export interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Header text + the dialog's accessible name. */
  title: string;
  /** The card's size classes. Defaults to the settings-sized card: as wide and
   * tall as the viewport comfortably allows, capped so it stays a card. */
  sizeClass?: string;
  children: JSX.Element;
}

const Modal: Component<ModalProps> = (props) => {
  // The Android/gesture Back button dismisses this rather than leaving the app.
  useBackDismiss(() => props.open, () => props.onOpenChange(false));
  const reduce = prefersReducedMotion;
  // `rendered` keeps the Dialog mounted through the exit so Kobalte cannot
  // unmount it mid-animation; `stage` drives the scale/fade.
  const ee = createEnterExit({ open: () => props.open, closeProperty: "opacity" });
  const shown = () => ee.stage() === "open";
  const cardStyle = (): JSX.CSSProperties => ({
    "box-shadow": MODAL_SHADOW,
    opacity: shown() ? 1 : 0,
    // A small rise-and-settle, not a zoom: the card arrives, it does not pounce.
    transform: shown() ? "translateY(0) scale(1)" : "translateY(0.5rem) scale(0.98)",
    transition: reduce()
      ? "none"
      : "opacity var(--duration-sheet) ease-out, transform var(--duration-sheet) var(--ease-sheet)",
  });

  return (
    <Dialog
      open={ee.rendered()}
      onOpenChange={(isOpen) => {
        if (!isOpen) props.onOpenChange(false);
      }}
      modal
    >
      <Dialog.Portal>
        <Dialog.Overlay
          class="fixed inset-0 bg-black/50"
          style={{
            "z-index": SHEET_Z.modal,
            opacity: shown() ? 1 : 0,
            transition: reduce() ? "none" : "opacity var(--duration-sheet) ease-out",
          }}
        />
        {/* SHEET_Z.modal — the stacking ladder (#DRAWER-ZORDER), see
            docs/architecture/sheet-component.md. */}
        <div
          class="pointer-events-none fixed inset-0 flex items-center justify-center p-4"
          style={{ "z-index": SHEET_Z.modal }}
        >
          <Dialog.Content
            class={`pointer-events-auto flex flex-col overflow-hidden rounded-xl border border-line bg-chrome text-sm text-fg ${
              props.sizeClass ?? "h-[min(48rem,88dvh)] w-[min(60rem,94vw)]"
            }`}
            style={cardStyle()}
            onTransitionEnd={ee.handleTransitionEnd}
            // Restores Escape past Kobalte's Accordion swallowing it — see
            // sheet-component.md's "Non-modal drawer survives its own gesture".
            onEscapeKeyDown={() => props.onOpenChange(false)}
          >
            <div class="flex shrink-0 items-center justify-between gap-2 border-b border-line-2 py-1 pl-4 pr-1">
              <Dialog.Title class="font-semibold">{props.title}</Dialog.Title>
              <Dialog.CloseButton
                class="flex size-11 items-center justify-center rounded-full text-2xl leading-none text-fg-2 hover:bg-chrome-2"
                aria-label="Close"
              >
                ×
              </Dialog.CloseButton>
            </div>
            <div class="flex min-h-0 flex-1 flex-col">{props.children}</div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  );
};

export default Modal;
