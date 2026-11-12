// The MOB button and, while a MOB is up, its card — reserved chrome in the
// map pane (App.tsx), on screen in every mode, never suppressed by a solo
// mode or a dashboard layout.
//
// Raising: tap arms (the button turns solid red and asks again), a second
// tap within `ARM_MS` raises. Clearing: the same two taps on Clear — ending
// a MOB is as deliberate as starting one.

import LifeBuoy from "lucide-solid/icons/life-buoy";
import { createSignal, onCleanup, Show, type Component } from "solid-js";
import { formatRange, padDeg } from "../../core/format";
import { ARM_MS, elapsedS, formatElapsed, markPoint } from "./model";
import type { MobModel } from "./index";

const BTN =
  "flex items-center justify-center rounded border font-mono text-[11px] font-bold tracking-[0.06em] " +
  "px-2.5 py-1.5 pointer-coarse:min-h-11 pointer-coarse:px-4";

// MapView's MAP_CTRL_BASE / MAP_CTRL_HALO, mirrored (features can't import
// MapView): the map tool buttons' look, so MOB reads as part of the chart chrome.
const MOB_BTN =
  "focus-ring pointer-events-auto grid size-10 place-items-center rounded-full bg-transparent transition-colors pointer-coarse:size-11";
const HALO = "drop-shadow(0 0 1.5px var(--color-chrome)) drop-shadow(0 0 3px var(--color-chrome))";

/** How far above the map pane's foot a bottom-centred card must sit to clear
 * the MOB button — `bottom-16` (64px) + its size (`size-11` coarse / `size-10`
 * fine) + 8px air. A safety control is never covered; keep in step with the
 * classes below. */
export const mobClearBottom = (pointerCoarse: boolean): number => 64 + (pointerCoarse ? 44 : 40) + 8;

const MobControl: Component<{ model: MobModel }> = (props) => {
  const m = props.model;

  // Clear's own two-tap confirm, local to this screen.
  const [confirmClear, setConfirmClear] = createSignal(false);
  let clearTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(clearTimer));
  const onClear = () => {
    if (!confirmClear()) {
      setConfirmClear(true);
      clearTimeout(clearTimer);
      clearTimer = setTimeout(() => setConfirmClear(false), ARM_MS);
      return;
    }
    clearTimeout(clearTimer);
    setConfirmClear(false);
    void m.clear();
  };

  return (
    // Bottom-left, just above the scale bar and overscale badge: the top is
    // the alarm strip's (nothing may cover it), the right edge the map tools'.
    // A corner keeps it out of the chart on a phone; the card grows upward.
    // `data-keep-clear`: a sheet that rests off the floor rests above this too
    // (Sheet.tsx measureKeepClearInset).
    <div
      data-keep-clear
      class="pointer-events-none absolute bottom-16 left-2.5 z-30 flex flex-col items-start gap-1.5 pl-[env(safe-area-inset-left)]"
    >
      <Show
        when={m.mark()}
        fallback={
          // Styled like the map tool buttons (MapView's MapToolButton):
          // round, transparent, chrome halo — only tinted alarm red. Armed,
          // it fills red and a pill asks for the second tap.
          <div class="flex items-center gap-1.5">
            <button
              type="button"
              class={MOB_BTN}
              classList={{
                "text-alarm hover:bg-alarm/15": !m.armed(),
                "bg-alarm text-alarm-fg animate-pulse": m.armed(),
              }}
              style={m.armed() ? undefined : { filter: HALO }}
              aria-label={m.armed() ? "Confirm man overboard" : "Man overboard (tap twice, or press O twice)"}
              title="Man overboard — tap twice (or press O twice)"
              onClick={() => m.press()}
            >
              <LifeBuoy size={20} aria-hidden="true" />
            </button>
            <Show when={m.armed()}>
              <span class="rounded bg-alarm px-1.5 py-0.5 font-mono text-[11px] font-bold tracking-[0.06em] text-alarm-fg">
                TAP AGAIN · MOB
              </span>
            </Show>
          </div>
        }
      >
        {(mark) => {
          const elapsed = () => formatElapsed(elapsedS(mark().at, m.now()));
          const range = () => {
            const f = m.fix();
            return f ? formatRange(f.rangeNm) : null;
          };
          return (
            <div
              class="pointer-events-auto flex min-w-[220px] max-w-[min(320px,calc(100vw-1rem))] flex-col gap-1.5 rounded-md border-2 border-alarm bg-alarm px-3 py-2 font-mono text-alarm-fg"
              style={{ "box-shadow": "0 6px 22px var(--color-shadow)" }}
              role="status"
              aria-live="polite"
            >
              <div class="flex items-center gap-2 text-[12px] font-bold tracking-[0.06em]">
                <LifeBuoy size={18} aria-hidden="true" />
                <span>MAN OVERBOARD</span>
                <span class="ml-auto tabular-nums">{elapsed()}</span>
              </div>
              <Show
                when={range()}
                fallback={
                  <div class="text-[12px] opacity-90">
                    {markPoint(mark()) ? "No own fix — bearing unknown" : "Raised without a position"}
                  </div>
                }
              >
                {(r) => (
                  <div class="flex items-baseline gap-3 tabular-nums">
                    <span class="text-[26px] font-bold leading-none">
                      {r().value}
                      <span class="ml-1 text-[13px] font-semibold">{r().unit}</span>
                    </span>
                    <span class="text-[22px] font-bold leading-none">
                      {padDeg(m.fix()!.bearingDeg)}
                      <span class="ml-0.5 text-[13px] font-semibold">°T</span>
                    </span>
                  </div>
                )}
              </Show>
              <Show when={m.unsent()}>
                <div class="text-[11px] font-semibold">Not on the server yet — retrying. This screen only.</div>
              </Show>
              <Show when={m.feedback()}>
                {(f) => <div class="text-[11px] opacity-90">{f()}</div>}
              </Show>
              <div class="flex gap-2">
                <Show when={markPoint(mark()) && !m.unsent()}>
                  <button
                    type="button"
                    class={`${BTN} border-alarm-fg bg-alarm-fg text-alarm hover:opacity-90`}
                    onClick={() => void m.navigate()}
                  >
                    STEER TO MOB
                  </button>
                </Show>
                <button
                  type="button"
                  class={`${BTN} ml-auto border-alarm-fg/60 text-alarm-fg hover:bg-alarm-fg/20`}
                  classList={{ "bg-alarm-fg/25": confirmClear() }}
                  onClick={onClear}
                >
                  {confirmClear() ? "TAP AGAIN TO CLEAR" : "CLEAR MOB"}
                </button>
              </div>
            </div>
          );
        }}
      </Show>
    </div>
  );
};

export default MobControl;
