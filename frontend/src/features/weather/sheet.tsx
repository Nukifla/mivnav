// WEATHER mode's surface: draggable BottomSheet on mobile, compact bar on
// desktop. Field/source pickers are driven by the source registry (see
// offerableVariables below); shares readout.ts and windUnit with the chart marker.

import { createMemo, For, Show, type Accessor, type Component, type JSX } from "solid-js";
import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import { Popover } from "@kobalte/core/popover";
import CloudSun from "lucide-solid/icons/cloud-sun";
import LoaderCircle from "lucide-solid/icons/loader-circle";
import SlidersHorizontal from "lucide-solid/icons/sliders-horizontal";
import ChevronDown from "lucide-solid/icons/chevron-down";
import X from "lucide-solid/icons/x";
import Sheet, { SHEET_Z } from "../../core/chrome/Sheet";
import { Slider, Toggle } from "../../core/ui/Controls";
import { Segmented } from "../../core/ui/SegmentedControl";
import { WEATHER_FIELDS, type WeatherFieldId } from "../../core/weatherSettings";
import { readoutParts } from "./readout";
import WindVane from "./WindVane";
import Ruler from "./RulerView";
import Legend from "./LegendView";
import type { WeatherModeModel } from "./mode";

/** Wind | Gusts | Waves stay the segment row; everything else lives under
 * "Others ▾" — but only fields the selected source's `variables` list
 * actually offers appear (see {@link offerableVariables}). */
const PRIMARY_IDS: readonly string[] = ["wind", "gusts", "waves"];

export interface FieldOption {
  value: WeatherFieldId;
  label: string;
}

export function fieldOptions(
  variables: readonly string[],
): { primary: FieldOption[]; others: FieldOption[] } {
  const offered = WEATHER_FIELDS.filter((f) => variables.includes(f.id)).map((f) => ({
    value: f.id as WeatherFieldId,
    label: f.label,
  }));
  return {
    primary: offered.filter((f) => PRIMARY_IDS.includes(f.value)),
    // "Off" is always last and always available — it is not a variable.
    others: [
      ...offered.filter((f) => !PRIMARY_IDS.includes(f.value)),
      { value: "off" as WeatherFieldId, label: "Off" },
    ],
  };
}

/** Empty `sources()` means "haven't asked yet", not "serves nothing" — so
 * before `GET /weather/sources` answers, offer the full canonical set
 * instead of rendering an empty row. */
function offerableVariables(model: WeatherModeModel): readonly string[] {
  if (model.sources().length === 0) return WEATHER_FIELDS.map((f) => f.id);
  return model.selected()?.variables ?? [];
}

const Title: Component<{ model: WeatherModeModel; size?: number }> = (props) => (
  <span class="flex items-center gap-2 font-semibold">
    <CloudSun size={props.size ?? 18} /> Weather
    {/* Fixed-width slot so the spinner appearing/vanishing never shifts the row. */}
    <span class="grid size-[15px] shrink-0 place-items-center">
      <Show when={props.model.tilesLoading()}>
        <LoaderCircle size={15} class="animate-spin text-fg-2" aria-label="Loading forecast" />
      </Show>
    </span>
  </span>
);

const CloseButton: Component<{ onClose: () => void }> = (props) => (
  <button
    type="button"
    aria-label="Close weather"
    class="grid size-9 shrink-0 place-items-center rounded-md text-fg-2 hover:bg-chrome-2 pointer-coarse:size-11"
    onClick={() => props.onClose()}
  >
    <X size={18} />
  </button>
);

const menuContentClass =
  "z-50 max-h-[60vh] min-w-[11rem] overflow-y-auto rounded-lg border border-line bg-chrome p-1 shadow-lg";
const menuItemClass =
  "flex cursor-pointer items-center justify-between gap-3 rounded px-2.5 py-2 text-sm text-fg outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-fg";

const FieldSelector: Component<{ model: WeatherModeModel }> = (props) => {
  const field = () => props.model.weather().field as string;
  const options = createMemo(() => fieldOptions(offerableVariables(props.model)));
  const isPrimary = (f: string) => options().primary.some((p) => p.value === f);
  const othersActive = () => !isPrimary(field()) && field() !== "off";
  const otherLabel = () => options().others.find((o) => o.value === field())?.label;
  return (
    <div class="flex items-stretch gap-1">
      <Segmented
        value={isPrimary(field()) ? field() : ""}
        onChange={(id) => props.model.setField(id as WeatherFieldId)}
        label="Field"
        labelClass="sr-only"
        options={options().primary as unknown as { value: string; label: string }[]}
        class="flex-1"
        itemClass="min-w-[3.5rem]"
      />
      <DropdownMenu gutter={4}>
        <DropdownMenu.Trigger
          class="flex items-center gap-1 rounded-lg border border-line-2 bg-chrome-2 px-3 text-sm font-medium text-fg-2 data-[expanded]:bg-chrome-2 pointer-coarse:py-2.5"
          classList={{ "bg-accent! text-accent-fg! border-transparent!": othersActive() }}
        >
          {othersActive() ? otherLabel() ?? field() : "Others"}
          <ChevronDown size={13} class="opacity-70" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content class={menuContentClass}>
            <For each={options().others}>
              {(o) => (
                <DropdownMenu.Item class={menuItemClass} onSelect={() => props.model.setField(o.value)}>
                  {o.label}
                </DropdownMenu.Item>
              )}
            </For>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </div>
  );
};

/** `SourceInfo.badge` is deliberately NOT machine-readable: the backend
 * writes the whole state string, the client only prints it. A parseable
 * kind was rejected — client branching on it was what this epic removed. */
const BadgeTag: Component<{ text: string }> = (props) => (
  <span class="rounded-sm bg-ok/15 px-1 py-px text-[10px] font-semibold uppercase tracking-wide text-ok">
    {props.text}
  </span>
);

/** No hardcoded-catalog fallback here: if this boat declares no source,
 * that's genuinely nothing to show, so the UI points at Settings instead. */
const NoSourcesConfigured: Component = () => (
  <DropdownMenu.Content class={menuContentClass}>
    <div class="max-w-[16rem] px-2.5 py-2 text-sm text-fg-2">
      No weather sources configured. Add one in Settings › Datasets.
    </div>
  </DropdownMenu.Content>
);

const SourceChip: Component<{ model: WeatherModeModel }> = (props) => {
  const selectedId = () => props.model.weather().model;
  const current = () => props.model.selected();
  const sources = createMemo(() => props.model.sources());
  // Reported, not swapped to another source: the sailor should see which
  // model is missing, not another one's numbers under a stale label.
  const unavailable = () => selectedId() !== "" && current() === null;

  return (
    <div class="flex items-center gap-2 text-xs text-fg-2">
      <DropdownMenu gutter={4}>
        <DropdownMenu.Trigger
          class="inline-flex items-center gap-1.5 rounded-full border border-line-2 bg-chrome-2 px-3 py-1 font-medium text-fg data-[expanded]:border-accent"
          classList={{ "text-notice!": unavailable() }}
        >
          {current()?.label ?? (selectedId() === "" ? "No source" : selectedId())}
          <Show when={current()?.badge}>{(b) => <BadgeTag text={b()} />}</Show>
          <ChevronDown size={12} class="text-fg-3" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <Show when={sources().length > 0} fallback={<NoSourcesConfigured />}>
            <DropdownMenu.Content class={menuContentClass}>
              <For each={sources()}>
                {(s) => (
                  <DropdownMenu.Item
                    class={menuItemClass}
                    onSelect={() => props.model.setModel(s.id)}
                  >
                    <span>{s.label}</span>
                    <span class="flex items-center gap-1.5">
                      <Show when={s.badge}>{(b) => <BadgeTag text={b()} />}</Show>
                      <Show when={s.id === selectedId()}>
                        <span class="text-xs">✓</span>
                      </Show>
                    </span>
                  </DropdownMenu.Item>
                )}
              </For>
            </DropdownMenu.Content>
          </Show>
        </DropdownMenu.Portal>
      </DropdownMenu>
      <Show when={unavailable()}>
        <span class="text-notice">· not available on this boat</span>
      </Show>
    </div>
  );
};

const UnitLabel: Component<{ model: WeatherModeModel; unit: string; toggles: boolean; class?: string }> = (
  props,
) =>
  props.toggles ? (
    <button
      type="button"
      class={`cursor-pointer border-b border-dotted border-current leading-none ${props.class ?? ""}`}
      onClick={() => props.model.toggleWindUnit()}
      title="Tap to switch m/s ⇄ kn"
    >
      {props.unit}
    </button>
  ) : (
    <span class={props.class}>{props.unit}</span>
  );

const SubLine: Component<{ model: WeatherModeModel }> = (props) => {
  const r = () => {
    const rd = props.model.readout();
    return rd.point
      ? readoutParts(rd.point, props.model.weather().field, props.model.windUnit(), rd.sampled)
      : null;
  };
  return (
    <Show when={r()}>
      {(parts) => (
        <For each={parts().sub}>
          {(s) => (s.strong ? <b class="font-semibold text-fg">{s.text}</b> : <>{s.text}</>)}
        </For>
      )}
    </Show>
  );
};

const readoutPlaceholder = (model: WeatherModeModel): JSX.Element => {
  const r = model.readout();
  if (r.loading) return <span class="text-sm text-fg-3">Reading…</span>;
  if (r.error) return <span class="text-sm text-fg-3">Offline</span>;
  return <span class="text-sm text-fg-3">Tap the chart to read the forecast</span>;
};

const SheetReadout: Component<{ model: WeatherModeModel }> = (props) => {
  const parts = () => {
    const rd = props.model.readout();
    return rd.point
      ? readoutParts(rd.point, props.model.weather().field, props.model.windUnit(), rd.sampled)
      : null;
  };
  return (
    <Show when={parts()} fallback={<div class="mx-0.5 mt-2">{readoutPlaceholder(props.model)}</div>}>
      {(p) => (
        <div class="mx-0.5 mt-2 flex items-end justify-between">
          <div>
            <div class="text-[44px] font-[650] leading-none tracking-tight tabular-nums">
              {p().value}
              <UnitLabel
                model={props.model}
                unit={p().unit}
                toggles={p().unitToggles}
                class="ml-2 align-middle text-sm font-medium text-fg-2"
              />
            </div>
            <div class="mt-1.5 text-xs text-fg-2">
              <SubLine model={props.model} />
            </div>
          </div>
          <Show when={p().dirDeg !== null}>
            <div class="relative size-16 flex-none rounded-full border-2 border-line text-accent">
              <span class="absolute left-1/2 top-1 -translate-x-1/2 text-[9px] text-fg-3">N</span>
              <WindVane
                bearing={p().dirDeg ?? 0}
                class="absolute left-1/2 top-1/2 size-[54px] -translate-x-1/2 -translate-y-1/2"
              />
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
};

const BarReadout: Component<{ model: WeatherModeModel }> = (props) => {
  const parts = () => {
    const rd = props.model.readout();
    return rd.point
      ? readoutParts(rd.point, props.model.weather().field, props.model.windUnit(), rd.sampled)
      : null;
  };
  return (
    <Show when={parts()} fallback={readoutPlaceholder(props.model)}>
      {(p) => (
        <div class="flex items-baseline gap-1.5">
          <Show when={p().dirDeg !== null}>
            <WindVane bearing={p().dirDeg ?? 0} class="size-9 flex-none self-center text-accent" />
          </Show>
          <span class="text-2xl font-[650] tabular-nums tracking-tight">{p().value}</span>
          <UnitLabel model={props.model} unit={p().unit} toggles={p().unitToggles} class="text-xs text-fg-2" />
          <span class="ml-1 text-xs text-fg-2">
            <SubLine model={props.model} />
          </span>
        </div>
      )}
    </Show>
  );
};

const SecondaryControls: Component<{ model: WeatherModeModel }> = (props) => (
  <div class="flex flex-col gap-3">
    <Toggle
      label="Wind flow"
      checked={props.model.weather().arrows}
      onChange={(arrows) => props.model.setArrows(arrows)}
    />
    <Slider
      label="Opacity"
      value={props.model.weather().opacity}
      min={0}
      max={1}
      step={0.05}
      format={(v) => `${Math.round(v * 100)}%`}
      onChange={(o) => props.model.setOpacity(o)}
    />
    <Toggle
      label="Keep visible when closed"
      checked={props.model.weather().keepVisible}
      onChange={(k) => props.model.setKeepVisible(k)}
    />
  </div>
);

const SecondaryPopover: Component<{ model: WeatherModeModel }> = (props) => (
  <Popover gutter={8} placement="top-end">
    <Popover.Trigger
      aria-label="Overlay settings"
      class="grid size-8 place-items-center rounded-md text-fg-2 hover:bg-chrome-2 data-[expanded]:bg-chrome-2"
    >
      <SlidersHorizontal size={16} />
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content class="z-50 w-64 rounded-lg border border-line bg-chrome p-3 shadow-lg">
        <SecondaryControls model={props.model} />
      </Popover.Content>
    </Popover.Portal>
  </Popover>
);

const DesktopBar: Component<{ model: WeatherModeModel }> = (props) => (
  // Positioning/slide-in is owned by Sheet's `bottom-bar` wrapper (BottomBar);
  // pointer-events-auto because that wrapper passes chart clicks through
  // its transparent margins.
  <div class="pointer-events-auto mx-auto max-w-6xl rounded-2xl border border-line/60 bg-chrome shadow-lg">
    <div class="flex flex-col gap-2 px-4 py-2.5">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Title model={props.model} size={16} />
        <FieldSelector model={props.model} />
        <SourceChip model={props.model} />
        <div class="hidden h-6 w-px self-center bg-line sm:block" />
        <BarReadout model={props.model} />
        <div class="ml-auto flex items-center gap-1">
          <SecondaryPopover model={props.model} />
          <CloseButton onClose={() => props.model.exit()} />
        </div>
      </div>
      <Ruler model={props.model} />
    </div>
  </div>
);

const WeatherSheet: Component<{ model: WeatherModeModel; active: Accessor<boolean> }> = (props) => (
  <>
    {/* Legend owns its own fade so it stays mounted to animate out (LegendView.tsx). */}
    <Legend model={props.model} active={props.active} />
    <Sheet
      open={props.active()}
      onOpenChange={(o) => {
        if (!o) props.model.exit();
      }}
      title="Weather"
      // Swipe-down dismisses like the X: safe here since weather is a
      // read-only viewer with no draft to lose (unlike the route planner).
      dismissable
      z={SHEET_Z.mode}
      bodyClass="min-h-0 flex-1 overflow-y-auto overscroll-contain pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]"
      peek={() => (
        <>
          <div class="flex items-center justify-between px-4">
            <Title model={props.model} />
            <CloseButton onClose={() => props.model.exit()} />
          </div>
          <div
            class="px-4 pt-1 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
            data-no-drag
          >
            <Ruler model={props.model} />
          </div>
        </>
      )}
      desktop={{ kind: "bottom-bar", content: <DesktopBar model={props.model} /> }}
    >
      <div class="flex flex-col gap-4 px-4">
        <FieldSelector model={props.model} />
        <SourceChip model={props.model} />
        <SheetReadout model={props.model} />
        <div class="border-t border-line-2 pt-3">
          <SecondaryControls model={props.model} />
        </div>
      </div>
    </Sheet>
  </>
);

export default WeatherSheet;
