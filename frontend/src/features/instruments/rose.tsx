// The wind rose: a compact, bow-up dial with the apparent and true wind
// angles as two pointers and both speeds in the middle. A board cell of its
// own (the widget's `render`), since a `Reading` is text only.

import { Show, type Component } from "solid-js";
import type { SignalKState } from "../../core/signalk";
import { formatWindAngle, MS_TO_KN, staleOf } from "./model";

const R = 46; // the dial's radius in the 120×120 viewBox

/** A point on the dial at `deg` (0 = bow, clockwise), `r` from the centre. */
const at = (deg: number, r: number): [number, number] => {
  const a = (deg * Math.PI) / 180;
  return [r * Math.sin(a), -r * Math.cos(a)];
};

/** An arc of the ring between two angles, for the red/green close-hauled sectors. */
function arc(from: number, to: number, r: number): string {
  const [x1, y1] = at(from, r);
  const [x2, y2] = at(to, r);
  return `M ${x1} ${y1} A ${r} ${r} 0 0 ${to > from ? 1 : 0} ${x2} ${y2}`;
}

/** A pointer from the rim toward the centre, the way the wind blows in. */
const Pointer: Component<{ deg: number; class: string; hollow?: boolean; stale: boolean }> = (p) => (
  <g transform={`rotate(${p.deg})`} class={p.class} opacity={p.stale ? 0.3 : 1}>
    <path
      d={`M 0 ${-R - 4} L 6 ${-R + 10} L 0 ${-R + 6} L -6 ${-R + 10} Z`}
      fill={p.hollow ? "none" : "currentColor"}
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linejoin="round"
    />
    <line x1="0" y1={-R + 6} x2="0" y2={-R + 18} stroke="currentColor" stroke-width="2" />
  </g>
);

const kn = (ms: number | undefined) => (ms === undefined ? "—" : (ms * MS_TO_KN).toFixed(1));

export const WindRose: Component<{ signalk: SignalKState }> = (props) => {
  const self = () => props.signalk.self();
  const appStale = () => staleOf(self(), ["awsMs", "awaDeg"]) !== null;
  const trueStale = () => staleOf(self(), ["twsMs", "twaDeg"]) !== null;
  const ticks = Array.from({ length: 12 }, (_, i) => i * 30);
  return (
    <div class="rounded-md border border-line-2 bg-chrome-2 px-[9px] py-2">
      <div class="mb-[2px] flex items-baseline gap-1.5">
        <h3 class="truncate font-mono text-[8.5px] font-bold tracking-[0.07em] text-fg-3">WIND</h3>
        <span class="ml-auto font-mono text-[8px] font-bold text-accent">AW</span>
        <span class="font-mono text-[8px] font-bold text-fg-2">TW</span>
      </div>
      <svg viewBox="-60 -60 120 120" class="mx-auto block w-full max-w-[150px]" role="img" aria-label="Wind rose">
        <circle r={R} fill="none" class="text-line" stroke="currentColor" stroke-width="1.5" />
        {/* Close-hauled sectors, port red / starboard green (20°–60° off the bow). */}
        <path d={arc(-60, -20, R)} fill="none" class="text-alarm" stroke="currentColor" stroke-width="4" opacity="0.5" />
        <path d={arc(20, 60, R)} fill="none" class="text-ok" stroke="currentColor" stroke-width="4" opacity="0.5" />
        {ticks.map((t) => {
          const [x1, y1] = at(t, R - (t % 90 === 0 ? 7 : 4));
          const [x2, y2] = at(t, R);
          return <line x1={x1} y1={y1} x2={x2} y2={y2} class="text-fg-3" stroke="currentColor" stroke-width="1" />;
        })}
        {/* The boat, bow up. */}
        <path d="M 0 -16 C 6 -8 6 8 4 14 L -4 14 C -6 8 -6 -8 0 -16 Z" fill="none" class="text-fg-3" stroke="currentColor" stroke-width="1" />
        {/* `!== undefined`, not truthiness: 0° (dead ahead) is a reading. */}
        <Show when={self()?.twaDeg !== undefined}>
          <Pointer deg={self()?.twaDeg ?? 0} class="text-fg-2" hollow stale={trueStale()} />
        </Show>
        <Show when={self()?.awaDeg !== undefined}>
          <Pointer deg={self()?.awaDeg ?? 0} class="text-accent" stale={appStale()} />
        </Show>
        <text y="-27" text-anchor="middle" class="fill-current text-accent font-mono" font-size="9" font-weight="700"
          text-decoration={appStale() ? "line-through" : undefined}>
          {kn(self()?.awsMs)}
        </text>
        <text y="34" text-anchor="middle" class="fill-current text-fg-2 font-mono" font-size="9" font-weight="700"
          text-decoration={trueStale() ? "line-through" : undefined}>
          {kn(self()?.twsMs)}
        </text>
      </svg>
      <div class="mt-[2px] flex justify-between font-mono text-[9.5px] text-fg-3">
        <span>AWA {self()?.awaDeg === undefined ? "—" : formatWindAngle(self()!.awaDeg!)}</span>
        <span>TWA {self()?.twaDeg === undefined ? "—" : formatWindAngle(self()!.twaDeg!)}</span>
      </div>
    </div>
  );
};

export const windRoseCell = (signalk: SignalKState) => () => <WindRose signalk={signalk} />;
