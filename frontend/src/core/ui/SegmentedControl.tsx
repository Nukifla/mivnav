import { SegmentedControl as KSegmentedControl } from "@kobalte/core/segmented-control";
import { For, type Component } from "solid-js";

// Kobalte's SegmentedControl, dressed once, shared by the density switch,
// weather field picker, and palette/enum settings.

/** Exported so a call site with an extra need (`capitalize`) can compose it. */
export const segmentedItemLabelClass =
  "block cursor-pointer select-none rounded-md px-2 py-1.5 text-center text-sm transition-colors data-[checked]:bg-chrome data-[checked]:font-medium data-[checked]:shadow-sm pointer-coarse:py-2.5";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  label: string;
  options: readonly SegmentedOption<T>[];
  /** The outer wrapper (default `flex flex-col gap-2`) — WeatherSheet uses a
   * tighter `gap-1.5`. */
  class?: string;
  /** The label's typography (default `font-medium`) — WeatherSheet adds `text-sm`. */
  labelClass?: string;
  /** Extra classes on the pill track — WeatherSheet's picker wraps (`flex-wrap`). */
  trackClass?: string;
  /** Extra classes on each `<Item>` — WeatherSheet reserves a min width. */
  itemClass?: string;
  /** Extra classes on each item label — SettingsView's enum values are `capitalize`. */
  itemLabelClass?: string;
}

/**
 * A labelled segmented control. Generic over the option value so `onChange`
 * hands back the exact union, not a bare `string` (the old copies each cast).
 */
export function Segmented<T extends string>(props: SegmentedProps<T>): ReturnType<Component> {
  return (
    <KSegmentedControl
      value={props.value}
      onChange={(value) => props.onChange(value as T)}
      class={props.class ?? "flex flex-col gap-2"}
    >
      <KSegmentedControl.Label class={props.labelClass ?? "font-medium"}>
        {props.label}
      </KSegmentedControl.Label>
      <div class={`flex gap-1 rounded-lg bg-chrome-2 p-1 ${props.trackClass ?? ""}`}>
        <For each={props.options}>
          {(opt) => (
            <KSegmentedControl.Item value={opt.value} class={`flex-1 ${props.itemClass ?? ""}`}>
              <KSegmentedControl.ItemInput />
              <KSegmentedControl.ItemLabel
                class={
                  props.itemLabelClass
                    ? `${segmentedItemLabelClass} ${props.itemLabelClass}`
                    : segmentedItemLabelClass
                }
              >
                {opt.label}
              </KSegmentedControl.ItemLabel>
            </KSegmentedControl.Item>
          )}
        </For>
      </div>
    </KSegmentedControl>
  );
}
