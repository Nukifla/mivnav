// The notices dataset's provider-specific params (backend
// `NoticesDatasetParams`): the source (the dataset's `implementation`) and
// which of its regions the dataset shows (`params.regions`). Registered
// against `datasetParams.notices` in ./index.ts. Everything shown comes
// from `GET /notices/sources`, so another country's source appears here
// without a frontend change. Pure logic: ./datasetParamsModel.ts.

import { For, Show, createEffect, createResource, type Component } from "solid-js";
import type { DatasetParamsProps } from "../../core/settings/datasetParams";
import { fetchJsonDefault } from "../../core/settings/apiFetch";
import { NOTICES_API } from "./client";
import { regionsOf, sourceOf, withRegion, type NoticeSourcesResponse } from "./datasetParamsModel";

const selectClass =
  "w-full rounded border border-line px-2 py-1 focus:border-accent focus:outline-none disabled:opacity-40";

const NoticesDatasetParams: Component<DatasetParamsProps> = (props) => {
  const [catalog] = createResource(async () => {
    try {
      return await fetchJsonDefault<NoticeSourcesResponse>(`${NOTICES_API}/sources`);
    } catch {
      return undefined;
    }
  });
  const source = () => sourceOf(catalog(), props.implementation);
  const regions = () => regionsOf(props.value, source());

  // Save the regions explicitly once the catalog is known — an absent list
  // means "all", but a saved dataset should say what it shows.
  createEffect(() => {
    const src = source();
    if (src && !Array.isArray(props.value.regions)) {
      props.onChange({ ...props.value, regions: src.regions.map((r) => r.id) });
    }
  });

  const setSource = (id: string) => {
    const next = catalog()?.sources.find((s) => s.id === id);
    props.onImplementationChange(id);
    // A different source has different regions: start from all of them.
    props.onChange({ ...props.value, regions: next?.regions.map((r) => r.id) ?? [] });
  };

  return (
    <div class="space-y-3">
      <Show
        when={catalog()}
        fallback={
          <p class="text-xs text-fg-3">
            {catalog.loading ? "Loading notice sources…" : "The boat's server did not list its notice sources."}
          </p>
        }
      >
        {(cat) => (
          <>
            <Show
              when={cat().sources.length > 1}
              fallback={
                <p class="text-xs text-fg-2">
                  Source: {source()?.label ?? props.implementation} ·{" "}
                  <span class="text-fg-3">{source()?.publisher}</span>
                </p>
              }
            >
              <label class="block space-y-1">
                <span class="text-xs text-fg-2">Source</span>
                <select
                  class={selectClass}
                  disabled={props.disabled}
                  value={source()?.id ?? ""}
                  onChange={(e) => setSource(e.currentTarget.value)}
                >
                  <For each={cat().sources}>{(s) => <option value={s.id}>{s.label}</option>}</For>
                </select>
              </label>
            </Show>

            <Show when={source()}>
              {(src) => (
                <fieldset class="space-y-1">
                  <legend class="text-xs text-fg-2">Regions</legend>
                  <For each={src().regions}>
                    {(r) => (
                      <label class="flex items-start gap-2 text-sm">
                        <input
                          type="checkbox"
                          class="mt-0.5"
                          checked={regions().includes(r.id)}
                          disabled={
                            props.disabled || (regions().length === 1 && regions()[0] === r.id)
                          }
                          onChange={(e) =>
                            props.onChange(withRegion(props.value, src(), r.id, e.currentTarget.checked))
                          }
                        />
                        <span>
                          {r.label}
                          <span class="block text-[11px] leading-snug text-fg-3">{r.description}</span>
                        </span>
                      </label>
                    )}
                  </For>
                  <p class="text-[11px] leading-snug text-fg-3">
                    The whole feed is downloaded either way; regions only choose what is shown, so a
                    change applies at once, without a new download.
                  </p>
                </fieldset>
              )}
            </Show>
          </>
        )}
      </Show>
    </div>
  );
};

export default NoticesDatasetParams;
