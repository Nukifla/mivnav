// The chart "wreck showing masts" symbol — unfilled masts on a waterline, so it
// can't be mistaken for BoatGlyph's filled hull dart (AIS vessels) or other
// info-panel class icons (DEPARE waves, LNDARE mountain, POI glyphs).

import type { Component } from "solid-js";
import type { InfoIconProps } from "./types";

export const WreckGlyph: Component<InfoIconProps> = (props) => (
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
    <line x1="2.5" y1="16" x2="21.5" y2="16" />
    <path d="M9 16 L11 3.5" />
    <path d="M8 6.5 H13.5" />
    {/* second mast kept well clear of the first so both stay legible at 15px */}
    <path d="M15 16 L16.8 8.5" />
    <path d="M13.5 10.5 H18.5" />
  </svg>
);

export default WreckGlyph;
