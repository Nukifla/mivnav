// POI dataset's provider-specific params: which implementation backs it
// (OpenStreetMap via Overpass, or a plugin POI source) and that source's own
// params form. Registered against `datasetParams.poi` in ./index.ts, picked
// up generically by `DatasetEditForm` (core/settings/DatasetList.tsx). Pure
// logic lives in ./datasetParamsModel.ts.

import { createEffect, For, Show, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { osmPoiImports } from "../../core/serverConfig";
import type { DatasetParamsProps } from "../../core/settings/datasetParams";
import {
  implementationFor,
  OVERPASS,
  paramsForSource,
  poiSourceOf,
  sourceToSwitchTo,
  type PoiSource,
} from "./datasetParamsModel";
import { poiSource, poiSources } from "./sources";

const PoiDatasetParams: Component<DatasetParamsProps> = (props) => {
  const source = () => poiSourceOf(props.implementation);
  const plugin = () => poiSource(source());
  const choices = (): readonly { value: PoiSource; label: string; off?: boolean }[] => [
    // Greyed out while OSM imports are off (Settings → Advanced): the
    // backend refuses the bake.
    { value: OVERPASS, label: "OpenStreetMap (Overpass)", off: !osmPoiImports() },
    ...poiSources().map((s) => ({ value: s.id, label: s.label })),
  ];

  const setSource = (next: PoiSource) => {
    if (next === source()) return;
    props.onChange(paramsForSource(props.value, next));
    props.onImplementationChange(implementationFor(next));
  };

  // A new dataset starts on OSM; with OSM imports off, on the first source
  // that can bake instead. A saved OSM dataset is never switched by itself.
  createEffect(() => {
    const next = sourceToSwitchTo(source(), {
      isNew: props.isNew ?? false,
      osmImports: osmPoiImports(),
      others: poiSources().map((s) => s.id),
    });
    if (next) setSource(next);
  });

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
                  disabled={props.disabled || (s.off && source() !== s.value)}
                  title={s.off ? "OpenStreetMap POI imports are off (Settings → Advanced)" : undefined}
                  onClick={() => setSource(s.value)}
                >
                  {s.label}
                </button>
              )}
            </For>
          </div>
          <Show when={source() === OVERPASS && !osmPoiImports()}>
            <p class="text-[11px] leading-snug text-alarm">
              OpenStreetMap POI imports are off (Settings → Advanced) — this dataset can’t be baked.
            </p>
          </Show>
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
