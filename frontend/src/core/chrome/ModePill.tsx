import X from "lucide-solid/icons/x";
import { createEffect, createSignal, For, Show, type Accessor, type Component } from "solid-js";
import { prefersReducedMotion } from "../media";
import { createEnterExit } from "./useEnterExit";
import type { ModeState } from "./modes";
import { lerpDensity, type Density, type Mode } from "./registry";

// The mode pill — a mode's whole UI, not a panel: carries only what the
// chart cannot show (name, options, the way out) plus one status line.
// See docs/architecture/mode-pill.md for the rationale and layout history.

/** Density is a SETTING (invariant #10), computed off config, never a media
 * query — see docs/architecture/mode-pill.md for the sizing math. */
interface PillSizing {
  pillBottom: number;
  pillPad: number;
  pillText: number;
  buttonPadX: number;
  buttonPadY: number;
  closePadX: number;
  closePadY: number;
  minTarget: number | undefined;
  statusText: number;
  hintBottom: number;
  hintText: number;
  icon: number;
}

const pillSizing = (density: Density, pointerCoarse: boolean): PillSizing => ({
  pillBottom: lerpDensity(12, 14, density),
  pillPad: lerpDensity(3, 4, density),
  pillText: lerpDensity(11.5, 13, density),
  buttonPadX: lerpDensity(11, 16, density),
  buttonPadY: lerpDensity(6, 12, density),
  closePadX: lerpDensity(9, 14, density),
  closePadY: lerpDensity(6, 12, density),
  minTarget: pointerCoarse ? 44 : undefined,
  statusText: lerpDensity(10.5, 11.5, density),
  hintBottom: pointerCoarse ? 80 : lerpDensity(58, 80, density),
  hintText: lerpDensity(10.5, 11.5, density),
  icon: lerpDensity(13, 16, density),
});

export interface ModePillProps {
  modes: ModeState;
  density: Accessor<Density>;
  /** A SEPARATE device fact from `density` since #DENS-SLIDER — see
   * `registry.ts`'s `Density` doc and `ChromeConfig.pointerCoarse`. */
  pointerCoarse: Accessor<boolean>;
}

const ModePill: Component<ModePillProps> = (props) => {
  const d = () => pillSizing(props.density(), props.pointerCoarse());
  const view = () => props.modes.current()?.pill?.({ density: props.density() });
  const button =
    "flex-none whitespace-nowrap rounded-full border border-line bg-chrome-2 font-semibold text-fg transition-colors enabled:hover:border-accent enabled:hover:text-accent enabled:active:brightness-90 disabled:opacity-40 focus-ring";

  // A SOLO mode (the route tool) draws no pill — its own surface (the plan
  // sheet) already carries status/actions/exit; the pill would duplicate it.
  const shownMode = () => {
    const mode = props.modes.current();
    return mode && !mode.solo ? mode : null;
  };

  // Fade + rise on enter/exit; `useEnterExit` keeps the pill in the tree
  // through exit so the leaving frame can play. Content is LATCHED: since
  // `shownMode()` goes null on leave, `held` keeps the last mode rendered.
  const reduce = prefersReducedMotion;
  const ee = createEnterExit({ open: () => !!shownMode(), closeProperty: "opacity" });
  const [held, setHeld] = createSignal<Mode | null>(shownMode());
  createEffect(() => {
    const m = shownMode();
    if (m) setHeld(m);
  });
  const pillMotion = (open: boolean) => ({
    opacity: open ? 1 : 0,
    transition: reduce()
      ? "none"
      : "opacity var(--duration-fast) ease-out, transform var(--duration-fast) var(--ease-sheet)",
  });

  return (
    <Show when={ee.rendered() && held()}>
      {(mode) => (
        <>
          {/* Halo, no background slab (same trick as `band.top`); over the
              chart, so `pointer-events-none`. */}
          <Show when={mode().hint?.()}>
            {(hint) => (
              <div
                class="pointer-events-none absolute left-1/2 z-20 -translate-x-1/2 text-center font-semibold whitespace-nowrap text-fg-2"
                style={{
                  bottom: `${d().hintBottom}px`,
                  "font-size": `${d().hintText}px`,
                  "text-shadow":
                    "0 0 4px var(--color-chrome), 0 0 8px var(--color-chrome), 0 0 12px var(--color-chrome)",
                }}
              >
                {hint()}
              </div>
            )}
          </Show>

          <div
            // 96%, not the mockup's 92%: on a 390px phone, 92% (359px) is one
            // pixel short of 360px of unshrinkable 44px touch-target buttons.
            // Tagged so a sheet that co-exists with a mode can sit ABOVE the
            // pill, keeping the mode's actions and its way out reachable
            // (Sheet.tsx measureKeepClearInset).
            data-keep-clear
            class="absolute left-1/2 z-20 flex max-w-[96%] items-center gap-1 rounded-full border border-accent bg-chrome"
            style={{
              bottom: `${d().pillBottom}px`,
              padding: `${d().pillPad}px`,
              "font-size": `${d().pillText}px`,
              "box-shadow": "0 6px 22px var(--color-shadow)",
              transform: `translate(-50%, ${ee.stage() === "open" ? "0" : "8px"})`,
              ...pillMotion(ee.stage() === "open"),
            }}
            onTransitionEnd={ee.handleTransitionEnd}
          >
            <span class="flex-none px-2.5 font-semibold whitespace-nowrap text-accent">
              {mode().label}
            </span>
            <Show when={view()?.status}>
              {(status) => (
                <span
                  class="overflow-hidden border-l border-line pr-1.5 pl-2.5 font-mono tabular-nums text-ellipsis whitespace-nowrap text-fg-2"
                  style={{ "font-size": `${d().statusText}px` }}
                >
                  {status()}
                </span>
              )}
            </Show>
            <For each={view()?.actions ?? []}>
              {(action) => (
                <button
                  type="button"
                  class={button}
                  style={{
                    "min-height": d().minTarget ? `${d().minTarget}px` : undefined,
                    "padding-left": `${d().buttonPadX}px`,
                    "padding-right": `${d().buttonPadX}px`,
                    "padding-top": `${d().buttonPadY}px`,
                    "padding-bottom": `${d().buttonPadY}px`,
                  }}
                  classList={{
                    "bg-accent! border-accent! text-accent-fg!":
                      action.kind === "primary" || (action.kind === "toggle" && action.on),
                  }}
                  aria-pressed={action.kind === "toggle" ? !!action.on : undefined}
                  disabled={action.disabled}
                  onClick={() => action.run()}
                >
                  {action.label}
                </button>
              )}
            </For>
            {/* The way out is always last and never a mode's to omit — same
                invariant (#1) that bars `defineFeature` from seating a widget
                over the alarm band; a mode may not take the chart hostage. */}
            <button
              type="button"
              aria-label={`Leave ${mode().label}`}
              title={`Leave ${mode().label}`}
              class="flex-none rounded-full border-0 bg-transparent text-fg-2 transition-colors hover:bg-line-2 hover:text-fg active:brightness-90 focus-ring"
              style={{
                "min-height": d().minTarget ? `${d().minTarget}px` : undefined,
                "padding-left": `${d().closePadX}px`,
                "padding-right": `${d().closePadX}px`,
                "padding-top": `${d().closePadY}px`,
                "padding-bottom": `${d().closePadY}px`,
              }}
              onClick={() => props.modes.leave()}
            >
              <X size={d().icon} aria-hidden="true" />
            </button>
          </div>
        </>
      )}
    </Show>
  );
};

export default ModePill;
