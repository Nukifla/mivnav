// Info-panel icon for a LIGHT (sectored or not) — a miniature of what the
// chart's own sector-lights overlay draws, built from the same data.
// See docs/architecture/sector-light-glyph.md.

import { For, type Component } from "solid-js";
import type { InfoIconProps } from "./types";

/** One LIGHTS object's contribution to the glyph — mirrors overlay.ts's
 * `Sector`. `a1`/`a2` are seaward-flipped, 0/360-wrapped compass degrees;
 * `hasSector` false means no charted SECTR1/SECTR2 (drawn as a full circle). */
export interface LightSegment {
  a1: number;
  a2: number;
  hasSector: boolean;
  color: string;
  outline?: string;
}

const CX = 12;
const CY = 12;
/** Fixed miniature radius — no room for overlay.ts's range-scaled screen radius. */
const R = 8;

/** Mirrors overlay.ts's `dir`: 0deg = up, clockwise; SVG's y-down axis needs no flip. */
function dir(deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [Math.sin(rad), -Math.cos(rad)];
}

function point(deg: number, r: number): string {
  const [x, y] = dir(deg);
  return `${CX + x * r},${CY + y * r}`;
}

/** Arc path from a1 to a2 at radius r, or undefined for a >= 360 span — SVG's
 * `A` command can't draw a full circle, so it falls back to `<circle>`. */
function arcPath(a1: number, a2: number, r: number): string | undefined {
  if (a2 - a1 >= 360) return undefined;
  const large = a2 - a1 > 180 ? 1 : 0;
  return `M ${point(a1, r)} A ${r} ${r} 0 ${large} 1 ${point(a2, r)}`;
}

/** Outline drawn under colour, echoing overlay.ts `pushArc`'s draw order. */
const SegmentGlyph: Component<{ seg: LightSegment }> = (props) => {
  const seg = props.seg;
  const d = () => (seg.hasSector ? arcPath(seg.a1, seg.a2, R) : undefined);
  return (
    <>
      {!seg.hasSector || !d() ? (
        <circle
          cx={CX}
          cy={CY}
          r={seg.hasSector ? R : 4}
          fill={seg.hasSector ? "none" : seg.color}
          stroke={seg.hasSector ? seg.color : seg.outline}
          stroke-width={seg.hasSector ? 3 : 1}
        />
      ) : (
        <>
          {seg.outline && (
            <path d={d()} stroke={seg.outline} stroke-width={5} stroke-linecap="butt" fill="none" />
          )}
          <path d={d()} stroke={seg.color} stroke-width={3} stroke-linecap="butt" fill="none" />
        </>
      )}
    </>
  );
};

/** Factory like `createChartIconStack`: segments are baked in once per hit
 * by the provider, nothing here is reactive. */
export function createSectorLightGlyph(
  segments: readonly LightSegment[],
): Component<InfoIconProps> {
  return (props) => (
    <svg viewBox="0 0 24 24" fill="none" class={props.class} aria-hidden="true">
      <For each={segments}>{(seg) => <SegmentGlyph seg={seg} />}</For>
      <circle cx={CX} cy={CY} r={1.3} fill="currentColor" stroke="none" />
    </svg>
  );
}

export default createSectorLightGlyph;
