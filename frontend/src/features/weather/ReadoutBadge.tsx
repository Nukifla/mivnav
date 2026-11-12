// Shared badge for the desktop placed-pin AND compact crosshair readouts
// (MapView.tsx) — previously two duplicated style systems, missing the
// {@link WindVane}. Tap swaps the app-wide wind unit.

import { For, Show, type Component } from "solid-js";
import { readoutParts } from "./readout";
import type { PointWeather, SampledPoint, WindUnit } from "./point";
import WindVane from "./WindVane";

export const WeatherReadoutBadge: Component<{
  point: PointWeather;
  field: string;
  unit: WindUnit;
  /** Grid-sampled value for fields the point API can't answer (waves);
   * without it a waves badge reads "— m". Wind fields ignore it. */
  sampled?: SampledPoint | null;
  /** Absent → badge is display-only (no unit toggle). */
  onToggleUnit?: () => void;
}> = (props) => {
  const parts = () => readoutParts(props.point, props.field, props.unit, props.sampled);
  return (
    <button
      type="button"
      aria-label={props.onToggleUnit ? "Swap wind unit" : undefined}
      // mivnav-pop-in: pop-in on mount (index.css). stopPropagation keeps the
      // tap off the map so it doesn't re-place the pin underneath.
      class="mivnav-pop-in pointer-events-auto flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md bg-black/75 px-2 py-1 text-center text-on-scrim"
      onClick={(e) => {
        e.stopPropagation();
        props.onToggleUnit?.();
      }}
    >
      <Show when={parts().dirDeg !== null}>
        <WindVane bearing={parts().dirDeg ?? 0} class="size-7 flex-none self-center" />
      </Show>
      <span class="leading-tight">
        <span class="text-sm font-semibold tabular-nums">{parts().value}</span>
        <span class="ml-1 border-b border-dotted border-current text-[11px] font-medium opacity-90">
          {parts().unit}
        </span>
        <Show when={parts().sub.length > 0}>
          <span class="block text-[11px] tabular-nums opacity-80">
            <For each={parts().sub}>
              {(s) => (s.strong ? <b class="font-semibold">{s.text}</b> : <>{s.text}</>)}
            </For>
          </span>
        </Show>
      </span>
    </button>
  );
};

export default WeatherReadoutBadge;
