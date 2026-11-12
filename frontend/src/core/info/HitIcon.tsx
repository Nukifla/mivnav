// The leading glyph on a hit, in a ranked-list row and the detail header.
// `iconForHit` (./registry.ts) asks the owning provider to draw it; the panel
// falls back to the coloured chip and never learns what kind of icon exists.

import { createMemo, Show, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { iconForHit } from "./registry";
import type { InfoHit, InfoPriority, InfoProvider } from "./types";

/** `.hit .ic` — the 15×15 chip coloured by `InfoPriority` (./rank.ts made
 * visible), carrying the provider's initial when it has no icon of its own. */
const CHIP: Record<InfoPriority, string> = {
  danger: "bg-alarm",
  hazard: "bg-alarm",
  traffic: "bg-ok",
  aid: "bg-ok",
  regulated: "bg-notice",
  depth: "bg-fg-3",
  land: "bg-fg-3",
  area: "bg-fg-3",
  context: "bg-fg-3",
};

/** A passed size class MUST carry both `size-*` and `text-*` together — the
 * bug this fixes: the carousel strip once grew the box and left the letter
 * at 9px. */
const CHIP_DEFAULT_SIZE = "mt-px size-[15px] text-[9px]";

export function chipClasses(priority: InfoPriority, size?: string): string {
  return `flex shrink-0 items-center justify-center rounded-[3px] font-bold text-accent-fg ${CHIP[priority]} ${size ?? CHIP_DEFAULT_SIZE}`;
}

export const HitChip: Component<{ hit: InfoHit; class?: string }> = (props) => (
  <div class={chipClasses(props.hit.priority, props.class)}>
    {props.hit.providerId.charAt(0).toUpperCase()}
  </div>
);

/** Memoised per hit so the resolved component keeps its own reactive state
 * (e.g. a vessel glyph tracking live heading) rather than being torn down and
 * rebuilt every render. */
export const HitIcon: Component<{
  hit: InfoHit;
  providers: readonly InfoProvider[];
  class?: string;
  chipClass?: string;
}> = (props) => {
  const icon = createMemo(() => iconForHit(props.providers, props.hit));
  return (
    <Show when={icon()} fallback={<HitChip hit={props.hit} class={props.chipClass} />}>
      {(resolved) => <Dynamic component={resolved()} class={props.class} />}
    </Show>
  );
};
