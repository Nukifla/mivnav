// The shared board display cells — pulled out of Dashboard.tsx so it and its
// edit surface (DashboardEditor.tsx) can BOTH render a widget cell without
// importing each other (they used to import each other's cell, a runtime
// import cycle of the same TDZ class the route index↔overlay crash was).

import { Show, type Accessor, type Component } from "solid-js";
import {
  readInstrument,
  readingValueClasses,
  type Density,
  type Instrument,
} from "./registry";
import type { ChromeConfig } from "./config";
import { createWidgetRegistry, type WidgetRegistry } from "./widget";
import { WIDGETS } from "./widgets";

/** Built-in-only widget-KIND registry, for callers with no `widgetReg` prop.
 * The FULL registry (+ feature widgets like the autopilot's `ap.control`) is
 * threaded from App as `widgetReg` and takes priority when present. */
const WIDGET_REG = createWidgetRegistry(WIDGETS);

/** Board reads at the device's density, same as the rail — deliberate:
 * density is a fact about the READER (gloves, motion), not the card's size.
 * `room: "board"` carries the actual space (docs/architecture/chrome-registry.md). */
export const Card: Component<{ inst: Instrument; density: Density }> = (props) => {
  const view = () =>
    readInstrument(props.inst, { density: props.density, band: "rail", room: "board" });
  return (
    <div
      class="rounded-md border border-line-2 bg-chrome-2 px-[9px] py-2"
      classList={{
        "border-alarm bg-alarm/15": view().urgency === "alarm" && !view().stale,
        "border-notice/60": view().urgency === "notice" && !view().stale,
      }}
    >
      <div class="mb-[5px] flex items-baseline gap-1.5">
        <h3 class="truncate font-mono text-[8.5px] font-bold tracking-[0.07em] text-fg-3">
          {props.inst.label.toUpperCase()}
        </h3>
        {/* A dead sensor is silent (invariant #6, `urgencyOf`), but must still
            LOOK dead — this is the visible half of that. */}
        <Show when={view().staleSeconds}>
          {(age) => (
            <span class="ml-auto shrink-0 font-mono text-[8px] font-bold text-notice">
              {Math.round(age())}s ago
            </span>
          )}
        </Show>
      </div>
      <div
        class="overflow-hidden font-mono text-[25px] font-semibold leading-[1.05] tracking-[-0.03em] tabular-nums"
        // The value-colour rule is shared with the rail tile — see
        // `readingValueClasses` (registry.ts).
        classList={readingValueClasses(view())}
      >
        {view().reading.value}
        <Show when={view().reading.unit}>
          {(unit) => <span class="ml-[3px] text-[11px] font-normal text-fg-2">{unit()}</span>}
        </Show>
      </div>
      <Show when={view().reading.sub}>
        {(sub) => (
          <div class="mt-[3px] truncate font-mono text-[9.5px] text-fg-3">{sub()}</div>
        )}
      </Show>
    </div>
  );
};

/**
 * One board cell: the widget KIND's own `render` when it declares one, else
 * the shell {@link Card}. RESERVED chrome (autopilot cards, alarm band) is
 * NOT a registry widget and never reaches this.
 */
export const WidgetCell: Component<{
  inst: Instrument;
  density: Density;
  chrome: Accessor<ChromeConfig>;
  /** The full widget-KIND registry (built-ins + feature widgets). Absent → the
   * built-in-only fallback, which resolves no feature widget's `render`. */
  widgetReg?: WidgetRegistry;
}> = (props) => {
  const render = () => {
    const reg = props.widgetReg ?? WIDGET_REG;
    const stored = props.chrome().dashboard.widgets[props.inst.id];
    const w = stored ? reg.byKind(stored.kind) : reg.staticById(props.inst.id);
    return w?.render;
  };
  return (
    <Show when={render()} fallback={<Card inst={props.inst} density={props.density} />}>
      {(r) => r()(props.inst, props.density)}
    </Show>
  );
};
