// DISCRETE colour blocks, each drawn at the wash's actual rendered opacity,
// so legend == wash by construction, not an abstract full-opacity ramp.
// See docs/architecture/weather-legend.md for the scale-key mirroring.

import { For, Show, createMemo, type Accessor, type Component } from "solid-js";
import { prefersReducedMotion } from "../../core/media";
import { createEnterExit } from "../../core/chrome/useEnterExit";
import type { WeatherModeModel } from "./mode";
import { legendModel } from "./legend";
import { isDarkPalette } from "./sources";

export const Legend: Component<{ model: WeatherModeModel; active: Accessor<boolean> }> = (props) => {
  const reduce = prefersReducedMotion;
  // Keys the same dark/light scale the wash paints — see weather-legend.md.
  const legend = createMemo(() =>
    legendModel(props.model.weather(), props.model.windUnit(), isDarkPalette(props.model.palette())),
  );

  const shown = () => props.active() && !!legend();
  const ee = createEnterExit({ open: shown, closeProperty: "opacity" });

  // The m/s ⇄ kn toggle only applies to wind-like fields; for others (hPa, °C, m)
  // the unit is just a label.
  const unitToggles = () => {
    const u = legend()?.unit;
    return u === "m/s" || u === "kn";
  };

  return (
    <Show when={ee.rendered() && legend()}>
      {(lg) => (
        <div
          class="pointer-events-none fixed left-2.5 top-1/2 z-30 flex max-h-[calc(100dvh-5.5rem)] -translate-y-1/2 select-none flex-col overflow-hidden rounded-lg shadow-md"
          style={{
            opacity: ee.stage() === "open" ? 1 : 0,
            transition: reduce() ? "none" : "opacity var(--duration-fast) ease-out",
          }}
          onTransitionEnd={ee.handleTransitionEnd}
        >
          <button
            type="button"
            disabled={!unitToggles()}
            onClick={() => unitToggles() && props.model.toggleWindUnit()}
            class="pointer-events-auto h-6 shrink-0 bg-chrome/80 text-center text-xs font-semibold text-fg enabled:cursor-pointer enabled:hover:bg-chrome pointer-coarse:grid pointer-coarse:h-11 pointer-coarse:place-items-center"
            title={unitToggles() ? "Change unit (m/s ⇄ kn)" : undefined}
          >
            {lg().unit}
          </button>
          <div class="flex flex-col-reverse overflow-y-auto bg-chrome/25">
            <For each={lg().bands}>
              {(b) => (
                <div
                  class="flex h-5 w-9 flex-none items-center justify-center"
                  style={{ background: b.css }}
                >
                  <span
                    class="text-[11px] font-medium leading-none tabular-nums text-fg"
                    style={{ "text-shadow": "0 0 2px var(--color-chrome), 0 0 2px var(--color-chrome)" }}
                  >
                    {b.label}
                  </span>
                </div>
              )}
            </For>
          </div>
        </div>
      )}
    </Show>
  );
};

export default Legend;
