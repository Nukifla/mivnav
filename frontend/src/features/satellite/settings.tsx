// Imagery-source picker only — visibility/opacity are now the Layers panel's
// overlay control (features/satellite/index.ts). Filed in "Data on this
// chart" beside Chart sets (task woqknwzy), as its own section so a build
// without this feature just omits it instead of showing an empty heading.

import { createSignal, For, onMount, Show, type Component } from "solid-js";
import Satellite from "lucide-solid/icons/satellite";
import type { CustomControlProps } from "../../core/settings/registry";
import {
  defineSetting,
  defineSettingsSection,
  type Setting,
  type SettingsSection,
} from "../../core/settings/registry";
import { CHART_DATA } from "../../core/settings/device";
import type { SettingsCtx } from "../../core/settings/ctx";
import type { ChartSettings } from "../../core/style/settings";
import { fetchSatelliteSourceList } from "./catalog";
import { resolveSatelliteSource, type SatelliteSourceInfo } from "./sources";

const SOURCE_SECTION = "satellite-source";

/**
 * `custom` control: the choice is the live list from `GET /api/satellite/sources`
 * (baked + online in one answer, jt zsukvvxq), plus AUTO. `badge` is display
 * text only; `requires_network` is the machine-readable half a future
 * offline/metered mode would filter on.
 */
const SatelliteSourcePicker: Component<CustomControlProps<SettingsCtx>> = (props) => {
  const [sources, setSources] = createSignal<SatelliteSourceInfo[]>([]);

  onMount(() => {
    void fetchSatelliteSourceList().then(setSources).catch(() => {
      /* unreachable list: the picker shows its "nothing yet" note */
    });
  });

  const selected = () => props.ctx.settings.satelliteSource;
  const write = (v: string) => props.ctx.onSettings({ satelliteSource: v } as Partial<ChartSettings>);
  // The source the overlay will actually draw, given the pick + the list — so
  // the attribution shown here is exactly what is (or would be) on the map.
  const active = () => resolveSatelliteSource(selected(), sources());
  const empty = () => sources().length === 0;

  return (
    <label class="block space-y-1">
      <span class="text-xs text-fg-2">Imagery source</span>
      <select
        class="w-full rounded border border-line px-2 py-1 focus:border-accent focus:outline-none disabled:opacity-40"
        disabled={props.disabled}
        value={selected()}
        onChange={(e) => write(e.currentTarget.value)}
      >
        {/* AUTO — the first row, which the backend orders baked-first. The
            sensible default, and where a deleted-set id quietly lands. */}
        <option value="">Auto</option>
        <For each={sources()}>
          {(src) => (
            <option value={src.id}>
              {src.label} — {src.badge}
            </option>
          )}
        </For>
      </select>
      <Show
        when={!empty()}
        fallback={
          <p class="text-[11px] leading-snug text-fg-3">
            No imagery sources or baked sets yet. Bake a region under Server settings →{" "}
            <span class="font-medium">Datasets</span>.
          </p>
        }
      >
        <Show when={active()}>
          {(a) => (
            <p class="text-[11px] leading-snug text-fg-3">{a().attribution}</p>
          )}
        </Show>
      </Show>
    </label>
  );
};

export const satelliteSourceSection: SettingsSection<SettingsCtx> =
  defineSettingsSection<SettingsCtx>({
    id: SOURCE_SECTION,
    title: "Satellite imagery",
    icon: Satellite,
    group: "device",
    category: CHART_DATA,
    // A section's order is its position WITHIN its pane: 65 puts the source
    // picker after the core "Chart sets" section (60) in "Data on this chart".
    order: 65,
  });

/** Greyed via `disabledWhen`, not `dependsOn` — its master toggle
 * (`showSatellite`) lives in the Layers-panel overlay control, not this
 * section, so there's no local setting to cascade from. */
export const satelliteSettings: readonly Setting<SettingsCtx>[] = [
  defineSetting<SettingsCtx>({
    id: "satelliteSource",
    scope: "device",
    control: { kind: "custom", component: SatelliteSourcePicker },
    label: "Imagery source",
    group: SOURCE_SECTION,
    order: 10,
    disabledWhen: (c) => !c.settings.showSatellite,
  }),
];
