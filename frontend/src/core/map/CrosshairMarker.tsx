// The map crosshair ring, shared by MapView's markers (weather pin, go-to
// pin) and the manual route editor's centre crosshair (features/routeDraw).

import type { Component } from "solid-js";
import { MARKER_HALO } from "../style/colors";

/** The four arm ticks of a crosshair, as one path — `inner` is the gap from
 * centre, `outer` the tip. Pure so the crosshair geometry lives in ONE place
 * instead of being re-typed at every marker. */
const crossArms = (inner: number, outer: number): string => {
  const span = outer - inner;
  return `M0 -${outer}V-${inner}M0 ${inner}v${span}M-${outer} 0h${span}M${inner} 0h${span}`;
};

/** The map crosshair ring — one component for what was copy-pasted ~4x
 * (weather pin, go-to pin, measure reticle). Haloed ring + arm ticks; `pop`
 * gives it scale+fade-in on mount (index.css, reduced-motion aware). */
export const CrosshairMarker: Component<{
  /** svg width/height in px (viewBox is centred on 0). */
  px: number;
  r: number;
  /** arm inner gap and outer tip. */
  inner: number;
  outer: number;
  /** inner-stroke colour — accent or magenta. */
  color: string;
  /** halo colour behind the ring, per palette — day white would dazzle at
   * the near-black night chart. Defaults to day white. */
  halo?: string;
  haloWidth: number;
  innerWidth: number;
  pop?: boolean;
}> = (props) => {
  const ext = () => props.px / 2;
  const arms = () => crossArms(props.inner, props.outer);
  return (
    <svg
      class={props.pop ? "mivnav-pop-in" : undefined}
      width={props.px}
      height={props.px}
      viewBox={`-${ext()} -${ext()} ${props.px} ${props.px}`}
      style={{ display: "block" }}
      aria-hidden="true"
    >
      <g fill="none" stroke={props.halo ?? MARKER_HALO} stroke-width={props.haloWidth} stroke-linecap="round">
        <circle r={props.r} />
        <path d={arms()} />
      </g>
      <g fill="none" stroke={props.color} stroke-width={props.innerWidth} stroke-linecap="round">
        <circle r={props.r} />
        <path d={arms()} />
      </g>
    </svg>
  );
};
