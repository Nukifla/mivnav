// POI dataset's provider-specific params: which implementation backs it
// (OpenStreetMap via Overpass, or a plugin POI source) and that source's own
// params form. Registered against `datasetParams.poi` in ./index.ts, picked
// up generically by `DatasetEditForm` (core/settings/DatasetList.tsx). Pure
// logic lives in ./datasetParamsModel.ts.

import { For, Show, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { DatasetParamsProps } from "../../core/settings/datasetParams";
import {
  implementationFor,
  OVERPASS,
  paramsForSource,
  poiSourceOf,
  type PoiSource,
} from "./datasetParamsModel";
import { poiSource, poiSources } from "./sources";

const PoiDatasetParams: Component<DatasetParamsProps> = (props) => {
  const source = () => poiSourceOf(props.implementation);
  const plugin = () => poiSource(source());
  const choices = (): readonly { value: PoiSource; label: string }[] => [
    { value: OVERPASS, label: "OpenStreetMap (Overpass)" },
    ...poiSources().map((s) => ({ value: s.id, label: s.label })),
  ];

  const setSource = (next: PoiSource) => {
    if (next === source()) return;
    props.onChange(paramsForSource(props.value, next));
    props.onImplementationChange(implementationFor(next));
  };

  return (
    <div class="space-y-3">
      <Show when={choices().length > 1}>
        <div class="space-y-1">
          <span class="block text-xs text-fg-2" id="poi-source-label">
            Source
          </span>
          <div class="flex gap-1" role="group" aria-labelledby="poi-source-label">
            <For each={choices()}>
              {(s) => (
                <button
                  type="button"
                  aria-pressed={source() === s.value}
                  class="flex-1 rounded border border-line px-1.5 py-1 text-center text-[11px] disabled:opacity-40"
                  classList={{
                    "bg-accent! text-accent-fg! border-accent!": source() === s.value,
                    "text-fg-2 hover:bg-chrome-2 hover:text-fg": source() !== s.value,
                  }}
                  disabled={props.disabled}
                  onClick={() => setSource(s.value)}
                >
                  {s.label}
                </button>
              )}
            </For>
          </div>
          <Show when={plugin()?.description}>
            {(text) => <p class="text-[11px] leading-snug text-fg-3">{text()}</p>}
          </Show>
        </div>
      </Show>

      <Show when={plugin()?.ParamsForm}>{(form) => <Dynamic component={form()} {...props} />}</Show>
    </div>
  );
};

export default PoiDatasetParams;
