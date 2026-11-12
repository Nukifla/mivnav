// `POI_GLYPHS` (./icons.ts) is the single source of truth: the same `Prim`
// list `ensurePoiImages` strokes onto the map canvas is stroked here into an
// SVG, so the two surfaces stay byte-for-byte in sync.

import { For, Switch, Match, type Component } from "solid-js";
import type { InfoIconProps } from "../../core/info/types";
import type { Prim } from "./icons";

/** Mirrors `glyphPath`'s switch in ./icons.ts one-to-one. */
const PrimEl: Component<{ prim: Prim }> = (props) => (
  <Switch>
    <Match when={props.prim[0] === "path"}>
      <path d={props.prim[1] as string} />
    </Match>
    <Match when={props.prim[0] === "circle"}>
      <circle cx={props.prim[1] as number} cy={props.prim[2] as number} r={props.prim[3] as number} />
    </Match>
    <Match when={props.prim[0] === "line"}>
      <line
        x1={props.prim[1] as number}
        y1={props.prim[2] as number}
        x2={props.prim[3] as number}
        y2={props.prim[4] as number}
      />
    </Match>
    <Match when={props.prim[0] === "rect"}>
      <rect
        x={props.prim[1] as number}
        y={props.prim[2] as number}
        width={props.prim[3] as number}
        height={props.prim[4] as number}
      />
    </Match>
  </Switch>
);

/** Pure and static — the geometry never changes, unlike the sprite icon whose
 * pixels are read from the live sheet. */
export function poiGlyphIcon(prims: readonly Prim[]): Component<InfoIconProps> {
  return (props) => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={2}
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
      aria-hidden="true"
    >
      <For each={prims}>{(prim) => <PrimEl prim={prim} />}</For>
    </svg>
  );
}
