// osm_world's registered `DatasetParams` — per-dataset override of the zoom
// range the daily Protomaps planet build is extracted to. See
// docs/architecture/osm-world-dataset-params.md for the rationale.

import { createEffect, Show, type Component } from "solid-js";
import type { DatasetParamsProps } from "../../core/settings/datasetParams";
import { formatBytes } from "../../core/settings/DatasetList";
import { estimateOsmWorldExtractBytes, estimateOsmWorldRegionBytes } from "./sizeEstimate";

const ZOOM_MIN = 0;
const ZOOM_MAX = 15;

const numberInputClass =
  "w-full rounded border border-line px-2 py-1 focus:border-accent focus:outline-none disabled:opacity-40";

/** `value[key]` as the `<input>`'s string, `""` when unset — an absent field
 * must show as a blank ("use the boat default") input, never a 0. */
function zoomField(value: Record<string, unknown>, key: "min_zoom" | "max_zoom"): string {
  const v = value[key];
  return typeof v === "number" && Number.isFinite(v) ? String(v) : "";
}

/** The field's current NUMBER, or `null` while unset — used for the size
 * estimate and the client-side ordering warning, both of which must only
 * fire once a sailor has actually typed something. */
function explicitZoom(value: Record<string, unknown>, key: "min_zoom" | "max_zoom"): number | null {
  const raw = zoomField(value, key);
  return raw === "" ? null : Number(raw);
}

const OsmWorldDatasetParams: Component<DatasetParamsProps> = (props) => {
  const isOnDemand = () => props.mode === "live-cache";
  const scoped = () => props.region !== undefined;
  const regionEstimate = () => {
    const hi = max();
    if (hi === null || props.region === undefined) return null;
    return estimateOsmWorldRegionBytes(hi, props.region.bboxes);
  };
  const min = () => explicitZoom(props.value, "min_zoom");
  const max = () => explicitZoom(props.value, "max_zoom");
  const inverted = () => {
    const lo = min();
    const hi = max();
    return !isOnDemand() && lo !== null && hi !== null && lo > hi;
  };

  const setZoom = (key: "min_zoom" | "max_zoom", raw: string) => {
    const next = { ...props.value };
    if (raw === "") {
      delete next[key];
    } else {
      const n = Math.round(Number(raw));
      if (Number.isFinite(n)) next[key] = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, n));
    }
    props.onChange(next);
  };

  // Clear a stale min_zoom on the bake->on-demand transition: left alone it's
  // invisible in this form yet still checked by the backend's
  // `_zoom_ordered` validator against the reinterpreted max_zoom, and can 422.
  createEffect(() => {
    if (isOnDemand() && min() !== null) setZoom("min_zoom", "");
  });

  return (
    <div class="space-y-2">
      <div class="grid grid-cols-2 gap-2">
        <Show when={!isOnDemand()}>
          <label class="block space-y-1">
            <span class="text-xs text-fg-2">Min zoom</span>
            <input
              type="number"
              min={ZOOM_MIN}
              max={ZOOM_MAX}
              step="1"
              class={numberInputClass}
              placeholder="Boat default"
              disabled={props.disabled}
              value={zoomField(props.value, "min_zoom")}
              onInput={(e) => setZoom("min_zoom", e.currentTarget.value)}
            />
          </label>
        </Show>
        <label class="block space-y-1">
          <span class="text-xs text-fg-2">{isOnDemand() ? "Live cache serves up to zoom" : "Max zoom"}</span>
          <input
            type="number"
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step="1"
            class={numberInputClass}
            placeholder="Boat default"
            disabled={props.disabled}
            value={zoomField(props.value, "max_zoom")}
            onInput={(e) => setZoom("max_zoom", e.currentTarget.value)}
          />
        </label>
      </div>

      <Show
        when={isOnDemand()}
        fallback={
          <>
            <p class="text-[11px] leading-snug text-fg-3">
              Leave either blank to keep using the boat-wide osm_world config default (Settings) — for
              max zoom that is{" "}
              {scoped()
                ? "the region default (12), not the world one"
                : "the world default (8)"}
              . This only overrides THIS dataset's own bake.
            </p>

            <Show
              when={scoped()}
              fallback={
                <p class="text-[11px] leading-snug text-fg-3">
                  Max zoom is what drives disk use — with no region selected this bakes the WHOLE WORLD,
                  which has nothing to shrink it by, so each step up costs far more than the same step
                  over a region. Measured against a real build: roughly 45 MB at z6, 550 MB at z8, 3.7 GB
                  at z10, 17 GB at z12.
                  <Show when={max() !== null}>
                    {" "}
                    At max zoom {max()}, this dataset is roughly{" "}
                    <b class="font-semibold">{formatBytes(estimateOsmWorldExtractBytes(max()!))}</b> (a
                    rough estimate from those measured points, not a promise).
                  </Show>
                </p>
              }
            >
              <p class="text-[11px] leading-snug text-fg-3">
                Scoped to {props.region?.name} — only that area is extracted, which is what makes a much
                deeper zoom affordable. Measured against a real build, a Denmark-sized box costs roughly
                22 MB at z10, 92 MB at z12, 356 MB at z14; the whole world at z12 would be 17 GB.
                <Show when={regionEstimate() !== null}>
                  {" "}
                  Scaled to this region's own area, at max zoom {max()} it is roughly{" "}
                  <b class="font-semibold">{formatBytes(regionEstimate()!)}</b> (a rough estimate, not a
                  promise).
                </Show>
                <Show when={max() !== null && regionEstimate() === null}>
                  {" "}
                  This is a country region, whose boundary the backend resolves at bake time, so there is
                  no box here to size it from.
                </Show>
              </p>
            </Show>

            <p class="text-[11px] leading-snug text-fg-3">
              Takes effect on the NEXT bake — and the map's own zoom hint (how far it lets you zoom into
              the world basemap) only picks up the new range after a page reload once that bake
              finishes.
            </p>
          </>
        }
      >
        <p class="text-[11px] leading-snug text-fg-3">
          Leave blank to use the boat-wide default (Settings, itself capped at the daily build's own
          z15). This can only LOWER how far the live fallback reaches past whatever is baked — it does
          not affect what gets baked, and it can never raise the fallback above the boat-wide default or
          past z15.
        </p>
        <p class="text-[11px] leading-snug text-fg-3">
          A Region has no effect on this kind of dataset: the live cache fetches whatever tile the map
          asks for, wherever that is, so it is global by nature. Pick one only for a scheduled bake.
        </p>
        <p class="text-[11px] leading-snug text-fg-3">
          Disk use for this cache is bounded by its own boat-wide budget (Settings), not by this zoom
          cap — a live cache only ever holds the individual tiles a view has actually panned to, unlike
          a bake's whole sub-pyramid.
        </p>
        <p class="text-[11px] leading-snug text-fg-3">
          Takes effect on the next request past the baked cap — but same as the bake side, the map's own
          zoom hint only picks up a raised ceiling after a page reload.
        </p>
      </Show>

      <Show when={inverted()}>
        <p class="text-xs text-alarm">Min zoom must not be greater than max zoom.</p>
      </Show>
    </div>
  );
};

export default OsmWorldDatasetParams;
