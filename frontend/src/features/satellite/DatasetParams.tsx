// Satellite dataset's `params.source_id` editor. Distinct from
// `SatelliteSourcePicker` (./settings.tsx): that edits live
// `DeviceCtx.satelliteSource` (VIEW); this edits a draft config (BAKE).

import { createSignal, For, onMount, Show, type Component } from "solid-js";
import type { DatasetParamsProps } from "../../core/settings/datasetParams";
import { fetchSatelliteSources } from "./catalog";
import type { SatelliteSource } from "./sources";

const SatelliteDatasetParams: Component<DatasetParamsProps> = (props) => {
  const [sources, setSources] = createSignal<SatelliteSource[]>([]);
  const [loading, setLoading] = createSignal(true);

  onMount(() => {
    void fetchSatelliteSources()
      .then(setSources)
      .catch(() => {
        /* no sources reachable: the select shows only the loading→empty note */
      })
      .finally(() => setLoading(false));
  });

  // Only BAKEABLE sources are valid bake targets (ESRI is online-only).
  const bakeable = () => sources().filter((s) => s.bakeable);
  const selected = () => (typeof props.value.source_id === "string" ? props.value.source_id : "");

  return (
    <label class="block space-y-1">
      <span class="text-xs text-fg-2">Imagery source</span>
      <select
        class="w-full rounded border border-line px-2 py-1 focus:border-accent focus:outline-none disabled:opacity-40"
        disabled={props.disabled}
        value={selected()}
        onChange={(e) => props.onChange({ source_id: e.currentTarget.value })}
      >
        <Show
          when={bakeable().length > 0}
          fallback={<option value="">{loading() ? "Loading…" : "No bakeable source"}</option>}
        >
          <option value="">Pick a source…</option>
          {/* `selected` per option, not just the select's `value`: the
              options arrive after the fetch, and a value set before its
              option exists leaves the select on "Pick a source…". */}
          <For each={bakeable()}>
            {(src) => (
              <option value={src.id} selected={src.id === selected()}>
                {src.name}
              </option>
            )}
          </For>
        </Show>
      </select>
    </label>
  );
};

export default SatelliteDatasetParams;
