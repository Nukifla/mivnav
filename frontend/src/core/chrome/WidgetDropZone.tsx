// Shared drop zone: board tab grids and the rail strip both render this, each
// for its own target. `createDashboardDrag` (dashboardDnd.ts) keys
// reorder/remove/drop off the `data-grid`/`data-slot` markers laid down here.

import { For, Show, type Accessor, type Component, type JSX } from "solid-js";
import type { ChromeConfig, ChromeUpdater } from "./config";
import type { DashboardDrag, DragStartOpts } from "./dashboardDnd";
import { EditCard } from "./DashboardEditor";
import type { Density, Instrument } from "./registry";
import type { WidgetRegistry } from "./widget";

/** Full-width accent bar so it reads as "here" in both the grid and the
 * rail column. `col-span-2` is inert outside a grid (rail ignores it). */
const InsertionLine: Component = () => (
  <div class="col-span-2 -my-1 flex items-center" aria-hidden="true">
    <div
      class="h-[3px] w-full rounded-full bg-accent"
      style={{ "box-shadow": "0 0 8px var(--color-accent)" }}
    />
  </div>
);

export const WidgetDropZone: Component<{
  target: string;
  /** MUST be the same list the drag's `visibleIds` is computed from (the
   * reorder is by drawn index) — the `targetCards` of this target. */
  items: Instrument[];
  dnd: DashboardDrag;
  chrome: Accessor<ChromeConfig>;
  onChrome: ChromeUpdater;
  density: Density;
  /** The full widget-KIND registry — threaded to the DEFAULT cell so a feature
   * widget's own `render` resolves. Unused when `renderCell` overrides. */
  widgetReg?: WidgetRegistry;
  /** The container's layout class — board: `grid grid-cols-2 gap-2 p-2`; rail:
   * `flex flex-col`. */
  layoutClass: string;
  /** Layout properties a fixed Tailwind class cannot hold — `TopBand`'s
   * density-scaled `column-gap`/`row-gap` (#DENS-SLIDER; a continuous value
   * the scanner never sees written down, same reason as `rail-density.ts`). */
  layoutStyle?: JSX.CSSProperties;
  /** Which axis the reading-order drop gap is measured along — `"x"` for the
   * board grid (default), `"y"` for the rail's vertical column. */
  axis?: "x" | "y";
  /** Whether an item spans both grid columns (the board's wide widgets). The rail
   * omits it. */
  wide?: (inst: Instrument) => boolean;
  /** The per-widget visual, overriding the default board card — the rail passes a
   * compact `Tile`. */
  renderCell?: (inst: Instrument) => JSX.Element;
  /** Start a drag from a card's handle — the board wires it to the shared drag. */
  onDragStart: (inst: Instrument, target: string, e: PointerEvent, opts?: DragStartOpts) => void;
  /** What to show when the zone is empty (the board's "drag one here" note). */
  empty?: JSX.Element;
}> = (props) => {
  // The insertion line shows on THIS zone at gap `n` exactly when the pointer is
  // over this zone's grid — keyed off `overGrid`, not the shown tab, so the strip
  // and each tab light independently.
  const gapAt = (n: number): boolean =>
    !!props.dnd.draggingId() && props.dnd.overGrid() === props.target && props.dnd.dropGap() === n;
  return (
    <div
      class={props.layoutClass}
      style={props.layoutStyle}
      data-grid={props.target}
      data-grid-count={props.items.length}
    >
      <For each={props.items}>
        {(inst, n) => (
          <>
            <Show when={gapAt(n())}>
              <InsertionLine />
            </Show>
            <div
              data-slot
              data-slot-tab={props.target}
              data-slot-index={n()}
              data-slot-axis={props.axis ?? "x"}
              classList={{
                "col-span-2": !!props.wide?.(inst),
                "opacity-30": props.dnd.draggingId() === inst.id,
              }}
            >
              <EditCard
                inst={inst}
                density={props.density}
                target={props.target}
                chrome={props.chrome}
                onChrome={props.onChrome}
                widgetReg={props.widgetReg}
                onDragStart={props.onDragStart}
                renderCell={props.renderCell ? () => props.renderCell!(inst) : undefined}
              />
            </div>
          </>
        )}
      </For>
      {/* A line after the last item — the append gap (n === items.length), also
          the only gap on an empty zone (n === 0). */}
      <Show when={gapAt(props.items.length)}>
        <InsertionLine />
      </Show>
      <Show when={props.items.length === 0}>{props.empty}</Show>
    </div>
  );
};
