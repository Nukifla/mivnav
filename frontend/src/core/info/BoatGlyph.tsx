// The info surface's vessel glyph — the SAME picture the chart draws, in SVG,
// reusing layers/aisSymbols.ts + layers/signalkShips.ts's pure geometry rather
// than re-deriving any symbology. See docs/architecture/boat-glyph.md for why
// (this replaced a bare currentColor dart) and the exact composition rules.

import { createMemo, For, Show, type Component, type JSX } from "solid-js";
import { prefersReducedMotion } from "../media";
import {
  bodyShape,
  dayShapePrims,
  hullPathD,
  HULL_PX,
  overlayShape,
  riskColor,
  targetTone,
  SHAPE_PX,
  STATION_COLORS,
  STATION_PX,
  stationGlyph,
  stationSymbol,
  symbolColors,
  vesselColors,
  type DayShape,
  type HullBody,
  type ShapePrim,
  type StationSymbol,
} from "../layers/aisSymbols";
import type { Risk } from "../cpa";
import type { ChartSettings } from "../style/settings";
import type { AisVessel } from "./vessel";
import type { InfoIconProps } from "./types";

const HALF = HULL_PX / 2; // origin-centred viewBox: −13 … 13

/**
 * Everything the icon needs to draw one vessel — exactly one of `hull` /
 * `station` is set. Built by `vesselIconModel`, a pure function a test can pin.
 */
export interface VesselIconModel {
  /** UINFD — hull outline, day-shape glyphs, station marks. */
  ui: string;
  /** UIBCK — the halo under the day-shape / station marks. */
  uiHalo: string;
  /** Where the bow points (heading, else COG); `undefined` leaves it upright.
   * Ignored for a station, which is viewport-aligned on the chart. */
  rotation?: number;
  /** A moving vessel: a risk-coloured hull with an optional day-shape overlay. */
  hull?: { body: HullBody; fill: string; shape: Exclude<DayShape, "none"> | null };
  /** A fixed non-vessel station, drawn as its own symbol outside the risk path. */
  station?: StationSymbol;
}

/**
 * The vessel → icon model, mirroring the map's `targetFeatures` exactly.
 * `risk` is passed in from the provider's own CPA result, never recomputed
 * here, so the icon's colour and the hit's danger ranking can never disagree.
 */
export function vesselIconModel(
  v: AisVessel,
  settings: ChartSettings,
  risk: Risk,
): VesselIconModel {
  const { ui, uiHalo } = symbolColors(settings.palette);
  const rotation = v.headingDeg ?? v.cogDeg;
  // Own ship: never risk-coloured. A dart in `AIS_COLORS.own` is a deliberate
  // simplification vs. the chart's bespoke own-ship hull outline.
  if (v.self) {
    return { ui, uiHalo, rotation, hull: { body: "dart", fill: vesselColors(settings.palette).own, shape: null } };
  }
  // Peeled off before the risk/body path, as the scene builder does — must
  // never render as a risk-coloured hull.
  const station = stationSymbol(v);
  if (station) return { ui, uiHalo, station };
  const body = bodyShape(v);
  const shape = overlayShape(v, body);
  // A SAR aircraft is never risk-coloured, as on the chart (`targetFeatures`).
  const fill = riskColor(
    settings.palette,
    body === "sar-heli" ? "off" : targetTone(risk, settings.showAisRisk, v.buddy === true),
  );
  return { ui, uiHalo, rotation, hull: { body, fill, shape: shape === "none" ? null : shape } };
}

/** One day-shape / station primitive as an SVG element; fill and stroke are
 * inherited from the enclosing pass group, so the same primitive serves both the
 * halo pass and the fill pass. */
const PrimEl: Component<{ prim: ShapePrim }> = (props) => {
  const p = props.prim;
  if ("circle" in p) return <circle cx={p.circle[0]} cy={p.circle[1]} r={p.circle[2]} />;
  if ("rect" in p) return <rect x={p.rect[0]} y={p.rect[1]} width={p.rect[2]} height={p.rect[3]} />;
  if ("poly" in p) return <polygon points={p.poly.map(([x, y]) => `${x},${y}`).join(" ")} />;
  return <path d={p.path} />;
};

/** The day-shape overlay: a halo pass under a fill pass (as `shapeImage` strokes
 * then fills), UPRIGHT and centred on the fix. Two passes rather than per-glyph
 * so one ball's halo never paints over the ball above it. */
const DayShapeOverlay: Component<{ shape: Exclude<DayShape, "none">; ui: string; uiHalo: string }> = (
  props,
) => {
  const prims = createMemo(() => dayShapePrims(props.shape, SHAPE_PX));
  return (
    <g transform={`translate(${-SHAPE_PX / 2}, ${-SHAPE_PX / 2})`}>
      <g fill="none" stroke={props.uiHalo} stroke-opacity="0.9" stroke-width="2.5" stroke-linejoin="round">
        <For each={prims()}>{(p) => <PrimEl prim={p} />}</For>
      </g>
      <g fill={props.ui}>
        <For each={prims()}>{(p) => <PrimEl prim={p} />}</For>
      </g>
    </g>
  );
};

/** A stroked segment pass — the antenna's fixed strokes and the `+`/`X` marks,
 * each drawn halo-first exactly as `stationImage` does. */
const SegPass: Component<{
  segs: [[number, number], [number, number]][];
  color: string;
  width: number;
}> = (props) => (
  <For each={props.segs}>
    {(s) => (
      <line
        x1={s[0][0]}
        y1={s[0][1]}
        x2={s[1][0]}
        y2={s[1][1]}
        stroke={props.color}
        stroke-width={props.width}
        stroke-linecap="round"
      />
    )}
  </For>
);

/** A fixed non-vessel station, centred in the hull's box: a filled body (diamond
 * / disc) or the antenna's strokes, with its `+`/`X` marks over it. Reuses
 * `stationGlyph`, so it is the same geometry the chart traces. */
const StationGlyph: Component<{ symbol: StationSymbol; ui: string; uiHalo: string }> = (props) => {
  const g = createMemo(() => stationGlyph(props.symbol, STATION_PX));
  const fill = () => STATION_COLORS[props.symbol];
  return (
    <g transform={`translate(${-STATION_PX / 2}, ${-STATION_PX / 2})`} stroke-linejoin="round">
      <Show when={g().polygon}>
        {(poly) => (
          <polygon
            points={poly()
              .map(([x, y]) => `${x},${y}`)
              .join(" ")}
            fill={fill()}
            stroke={props.ui}
            stroke-width="1.5"
          />
        )}
      </Show>
      <Show when={g().disc}>
        {(d) => (
          <circle cx={d().cx} cy={d().cy} r={d().r} fill={fill()} stroke={props.ui} stroke-width="1.5" />
        )}
      </Show>
      {/* The antenna IS the body — fixed colour, halo first. */}
      <SegPass segs={g().fixedMarks} color={props.uiHalo} width={3} />
      <SegPass segs={g().fixedMarks} color={fill()} width={1.6} />
      {/* The `+` / `X` over the body — halo first, then the ui token. */}
      <SegPass segs={g().fgMarks} color={props.uiHalo} width={3} />
      <SegPass segs={g().fgMarks} color={props.ui} width={1.8} />
    </g>
  );
};

/**
 * `model` is read live in the render, so a target under an open panel turns
 * and recolours as it updates. `undefined` (stopped resolving) draws a plain
 * upright dart in `currentColor` — "we no longer know what this is".
 */
export const VesselIcon: Component<{
  model: () => VesselIconModel | undefined;
  class?: string;
  title?: string;
}> = (props) => {
  const model = createMemo(() => props.model());
  const rotation = () => model()?.rotation ?? 0;
  return (
    <svg
      viewBox={`${-HALF} ${-HALF} ${HULL_PX} ${HULL_PX}`}
      class={props.class}
      aria-hidden={props.title ? undefined : "true"}
      role={props.title ? "img" : undefined}
      aria-label={props.title}
    >
      <Show
        when={model()}
        fallback={<path d={hullPathD("dart", HULL_PX)} fill="currentColor" />}
      >
        {(m) => (
          <>
            <Show when={m().station}>
              {(symbol) => <StationGlyph symbol={symbol()} ui={m().ui} uiHalo={m().uiHalo} />}
            </Show>
            <Show when={m().hull}>
              {(hull) => (
                <>
                  <g
                    transform={`rotate(${rotation()})`}
                    style={{
                      transition: prefersReducedMotion()
                        ? "none"
                        : "transform var(--duration-fast) var(--ease-sheet)",
                    }}
                  >
                    <path
                      d={hullPathD(hull().body, HULL_PX)}
                      fill={hull().fill}
                      stroke={m().ui}
                      stroke-width="1.5"
                      stroke-linejoin="round"
                    />
                  </g>
                  <Show when={hull().shape}>
                    {(shape) => <DayShapeOverlay shape={shape()} ui={m().ui} uiHalo={m().uiHalo} />}
                  </Show>
                </>
              )}
            </Show>
          </>
        )}
      </Show>
    </svg>
  );
};

/** The vessel provider's per-hit icon, bound to a live model accessor so a
 * boat under an open panel turns and recolours as it updates. */
export function createVesselIcon(
  model: () => VesselIconModel | undefined,
): Component<InfoIconProps> {
  return (props): JSX.Element => <VesselIcon model={model} class={props.class} title="Vessel" />;
}
