// A mark's glyph as inline SVG, for the info panel and the list (the chart
// draws the baked image from ./icons.ts — same paths).

import { For, type Component } from "solid-js";
import type { InfoIconProps } from "../../core/info/types";
import { MARK_GLYPHS } from "./icons";
import type { MarkIcon } from "./model";

const MarkGlyph: Component<InfoIconProps & { icon: MarkIcon }> = (props) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class={props.class}
  >
    <For each={MARK_GLYPHS[props.icon].paths}>{(d) => <path d={d} />}</For>
    <For each={MARK_GLYPHS[props.icon].circles ?? []}>
      {([cx, cy, r]) => <circle cx={cx} cy={cy} r={r} />}
    </For>
  </svg>
);

export default MarkGlyph;
