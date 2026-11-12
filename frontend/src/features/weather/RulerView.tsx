// Multi-day forecast scrubber (replaces the old 0-48h slider), driven by
// the pure time model in ruler.ts. See docs/architecture/weather-ruler.md for
// the local/remote coverage-band design and why the ruler never fetches its own.

import {
  For,
  Show,
  createMemo,
  createSignal,
  onCleanup,
  type Component,
} from "solid-js";
import ChevronLeft from "lucide-solid/icons/chevron-left";
import ChevronRight from "lucide-solid/icons/chevron-right";
import { prefersReducedMotion } from "../../core/media";
import { WEATHER_HOUR_STEP, WEATHER_MAX_HOURS } from "../../core/weatherSettings";
import type { WeatherModeModel } from "./mode";
import { clockLabel, fracToOffset, offsetToFrac, pageHours, rulerModel } from "./ruler";
import { coverageWindow } from "./sources";

const pct = (f: number) => `${(f * 100).toFixed(3)}%`;

export const Ruler: Component<{ model: WeatherModeModel }> = (props) => {
  // Coarse refresh so labels/accent marker don't drift stale over a long session.
  const [nowMs, setNowMs] = createSignal(Date.now());
  const timer = setInterval(() => setNowMs(Date.now()), 60_000);
  onCleanup(() => clearInterval(timer));

  const m = createMemo(() => rulerModel(nowMs(), WEATHER_MAX_HOURS));
  const hours = () => props.model.weather().hours;
  const selFrac = () => offsetToFrac(m(), hours());
  const nowFrac = () => m().nowFrac;

  const coverage = () => props.model.selected()?.coverage ?? null;

  /** Span this boat holds OFFLINE for the selected source, in ruler fraction
   * coordinates. `null` (not drawn) rather than a zero-width sliver when
   * nothing is local yet. */
  const bakedFrac = createMemo<{ from: number; to: number } | null>(() => {
    const c = coverage();
    const w = c ? coverageWindow(c.local, m().nowMs) : null;
    if (w === null) return null;
    const from = offsetToFrac(m(), Math.min(w.fromHours, WEATHER_MAX_HOURS));
    const to = offsetToFrac(m(), Math.min(w.toHours, WEATHER_MAX_HOURS));
    return to > from ? { from, to } : null;
  });

  /** End of `local ∪ remote`; everything past is hatched. `null` both when the
   * source covers the whole week AND when it declared no times — an empty
   * coverage means "nothing can be promised", not "it stops HERE". */
  const horizonFrac = createMemo<number | null>(() => {
    const c = coverage();
    if (!c) return null;
    const last = Math.max(
      c.local.length > 0 ? c.local[c.local.length - 1] : -Infinity,
      c.remote.length > 0 ? c.remote[c.remote.length - 1] : -Infinity,
    );
    if (!Number.isFinite(last)) return null;
    const hrs = (last - m().nowMs) / 3_600_000;
    if (hrs >= WEATHER_MAX_HOURS) return null;
    return offsetToFrac(m(), Math.max(0, hrs));
  });

  // Markers must track the finger 1:1 while scrubbing (a transition would lag
  // them); a tap or day-page glides instead, so transition is dropped only
  // while scrubbing (and under reduced motion).
  const [scrubbing, setScrubbing] = createSignal(false);
  const settling = () => scrubbing() || prefersReducedMotion();
  const leftTransition = (): string =>
    settling() ? "none" : "left var(--duration-fast) var(--ease-sheet)";

  let body: HTMLDivElement | undefined;
  const scrubTo = (clientX: number) => {
    if (!body) return;
    const rect = body.getBoundingClientRect();
    const frac = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    props.model.setHours(fracToOffset(m(), frac, WEATHER_HOUR_STEP));
  };
  const onPointerDown = (e: PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setScrubbing(true);
    scrubTo(e.clientX);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (e.buttons === 0) return;
    scrubTo(e.clientX);
  };
  const endScrub = () => setScrubbing(false);
  const page = (dir: -1 | 1) =>
    props.model.setHours(pageHours(hours(), dir, WEATHER_MAX_HOURS, WEATHER_HOUR_STEP));

  const navBtn =
    "flex-none rounded p-1.5 text-fg-3 hover:text-fg disabled:opacity-30 disabled:hover:text-fg-3";

  // Keep a label from overflowing the body edges into the nav chevrons / off-panel.
  const clampFrac = (f: number, inset: number) => Math.max(inset, Math.min(1 - inset, f));

  return (
    <div class="flex touch-none items-center gap-0.5" data-no-drag>
      <button type="button" class={navBtn} aria-label="Previous day" onClick={() => page(-1)} disabled={hours() <= 0}>
        <ChevronLeft size={18} />
      </button>

      {/* `touch-none`: drag scrubs instead of scrolling the sheet. */}
      <div
        ref={body}
        class="relative h-[76px] flex-1 cursor-pointer select-none"
        role="slider"
        aria-label="Forecast time"
        aria-valuemin={0}
        aria-valuemax={WEATHER_MAX_HOURS}
        aria-valuenow={hours()}
        aria-valuetext={`+${hours()} h · ${clockLabel(m().nowMs, hours())}`}
        tabindex="0"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endScrub}
        onPointerCancel={endScrub}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") props.model.setHours(Math.min(WEATHER_MAX_HOURS, hours() + WEATHER_HOUR_STEP));
          else if (e.key === "ArrowLeft") props.model.setHours(Math.max(0, hours() - WEATHER_HOUR_STEP));
        }}
      >
        {/* Offline band: solid, bottom-hugging, same `ok` colour as the model
            chip's "Offline" tag (which names it) so it can't be confused with
            the hatch below. `pointer-events-none` or it'd swallow scrub drags. */}
        <Show when={bakedFrac()}>
          {(b) => (
            <div
              class="pointer-events-none absolute bottom-[3px] h-[3px] rounded-full bg-ok"
              style={{ left: pct(b().from), right: pct(1 - b().to), opacity: 0.85 }}
              aria-hidden="true"
            />
          )}
        </Show>

        {/* Hatch past where the selected model has data, so a blank
            far-forecast reads as "this model stops here", not a bug. */}
        <Show when={horizonFrac() !== null}>
          <div
            class="pointer-events-none absolute bottom-5 top-5"
            style={{
              left: pct(horizonFrac()!),
              right: "0",
              "background-image":
                "repeating-linear-gradient(45deg, var(--color-fg-3) 0 1px, transparent 1px 6px)",
              opacity: 0.3,
            }}
            aria-hidden="true"
          />
          <div
            class="pointer-events-none absolute bottom-5 top-5 w-px bg-fg-3"
            style={{ left: pct(horizonFrac()!), opacity: 0.7 }}
            aria-hidden="true"
          />
        </Show>

        <div
          class="absolute top-0 -translate-x-1/2 whitespace-nowrap rounded-md bg-fg px-2 py-0.5 text-xs font-bold text-chrome"
          style={{ left: pct(clampFrac(selFrac(), 0.05)), transition: leftTransition() }}
        >
          {clockLabel(m().nowMs, hours())}
        </div>

        <div
          class="absolute inset-x-0 bottom-6 h-3"
          style={{
            "background-image":
              "repeating-linear-gradient(90deg, var(--color-line) 0 1px, transparent 1px 13px)",
          }}
        />

        <For each={m().daylines}>
          {(f) => <div class="absolute bottom-6 h-5 w-px bg-fg-3" style={{ left: pct(f) }} />}
        </For>

        {/* At hours 0 the selected offset sits exactly on `now`; nudge the
            notice bar clear so the two markers read as distinct. */}
        <div
          class="absolute bottom-[18px] h-7 w-[3px] -translate-x-1/2 rounded-sm bg-accent"
          style={{ left: pct(nowFrac()), transition: leftTransition() }}
        />
        <div
          class="absolute bottom-[18px] h-7 w-0.5 -translate-x-1/2 rounded-sm bg-notice"
          style={{
            left: pct(selFrac()),
            "margin-left": hours() === 0 ? "4px" : "0",
            transition: leftTransition(),
          }}
        />

        {/* Centred on `centerFrac`, not the day edge — edge-anchoring used to
            mis-place the first (partial) day at 0%. */}
        <For each={m().days}>
          {(d) => (
            <div
              class="absolute bottom-0 max-w-[13%] -translate-x-1/2 text-center text-[11px] font-bold leading-tight text-fg"
              style={{ left: pct(d.centerFrac) }}
            >
              {d.weekday}
              <span class="block text-[9px] font-medium text-fg-2">{d.date}</span>
            </div>
          )}
        </For>
      </div>

      <button type="button" class={navBtn} aria-label="Next day" onClick={() => page(1)} disabled={hours() >= WEATHER_MAX_HOURS}>
        <ChevronRight size={18} />
      </button>
    </div>
  );
};

export default Ruler;
