// Bearing rotates an inner <g> about (12, 28), not a CSS transform on the
// <svg>: callers position the vane with their own `translate(...)`, which a
// CSS rotate on the element would clobber. viewBox (`-12 4 48 48`) is sized
// to that pivot so the reach plus stroke never clips at any bearing.

import type { Component, JSX } from "solid-js";
import { prefersReducedMotion } from "../../core/media";

/** The wind FROM which the wind blows, degrees true. At 0° the head points
 * north — i.e. toward where the wind comes from (from-SW ≈ 215°). */
export const WindVane: Component<{
  bearing: number;
  class?: string;
  style?: JSX.CSSProperties;
  title?: string;
  /** Eases toward a new `bearing` by default; a caller driving it 1:1 off a
   * live scrub passes `false` so the needle tracks the finger. */
  animate?: boolean;
  /** Loading cue: spins the vane continuously. Relies on the viewBox being
   * centred on the pivot (12, 28) so a plain CSS rotate spins about the same
   * point the bearing `<g>` rotates about. */
  spin?: boolean;
}> = (props) => (
  <svg
    viewBox="-12 4 48 48"
    fill="none"
    stroke="currentColor"
    stroke-width="2.4"
    stroke-linecap="round"
    stroke-linejoin="round"
    class={props.class}
    classList={{ "mivnav-vane-spin": !!props.spin }}
    style={props.style}
    aria-hidden={props.title ? undefined : "true"}
    role={props.title ? "img" : undefined}
    aria-label={props.title}
  >
    <g
      transform={`rotate(${props.bearing} 12 28)`}
      style={{
        transition:
          props.animate === false || prefersReducedMotion()
            ? "none"
            : "transform var(--duration-fast) var(--ease-sheet)",
      }}
    >
      <path d="M7 14 L12 6 L17 14" />
      <path d="M12 6 L12 34" />
      <path d="M12 34 L16 38 L16 50 L12 46 L8 50 L8 38 Z" />
    </g>
  </svg>
);

export default WindVane;
