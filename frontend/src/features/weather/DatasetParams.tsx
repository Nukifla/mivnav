// Weather dataset's provider-specific params (backend `WeatherDatasetParams`):
// `params.domains` plus, for bakes, `params.max_forecast_hours`. Registered
// against `datasetParams.weather` in ./index.ts; full rationale, legacy
// compat: see docs/architecture/weather-dataset-params.md.

import { For, Show, createResource, type Component } from "solid-js";
import type { DatasetParamsProps } from "../../core/settings/datasetParams";
import { WEATHER_MAX_HOURS } from "../../core/weatherSettings";
import {
  WEATHER_GRIB_PRODUCTS,
  WEATHER_MODELS,
  fetchModelManifest,
  horizonHoursFromManifest,
  modelFieldsLabel,
  stepLabel,
  type WeatherModel,
} from "./datasetCatalog";

/** "om" (default) mirrors an Open-Meteo domain; "grib" fetches DWD/ICON
 * directly (jt mzyvvmux), bake-mode only (no live path). Falls back to the
 * retired `params.source` spelling permanently — see
 * docs/architecture/weather-dataset-params.md. */
function sourceOf(implementation: string | null, value: Record<string, unknown>): "om" | "grib" {
  if (implementation) return implementation === "grib" ? "grib" : "om";
  return value.source === "grib" ? "grib" : "om";
}

/** Offered forecast horizons. `null` = leave `max_forecast_hours` unset, which
 * the backend reads as "today's hours only". Capped at `WEATHER_MAX_HOURS`. */
const HORIZONS: readonly { hours: number | null; label: string }[] = [
  { hours: null, label: "Today only" },
  { hours: 24, label: "1 day ahead" },
  { hours: 48, label: "2 days ahead" },
  { hours: 72, label: "3 days ahead" },
  { hours: 120, label: "5 days ahead" },
  { hours: WEATHER_MAX_HOURS, label: "7 days ahead" },
];

/** `params.domains` if present, else `[params.domain]` (pre-#xkpmrvxw shape),
 * else `[]`. Mirrors backend `WeatherDatasetParams._legacy_domain_alias`. */
function domainsOf(value: Record<string, unknown>): string[] {
  if (Array.isArray(value.domains)) {
    return value.domains.filter((d): d is string => typeof d === "string");
  }
  return typeof value.domain === "string" ? [value.domain] : [];
}

/** One option's text: label, what it can draw, how dense its steps are. The
 * no-renderable-fields case is spelled out — a bare label there would look
 * identical to a model whose list simply failed to load. */
function optionLabel(m: WeatherModel): string {
  const fields = modelFieldsLabel(m.value);
  const step = stepLabel(m.timeInterval);
  const offers = fields ?? "nothing this app can draw";
  return step ? `${m.label} — ${offers} · ${step}` : `${m.label} — ${offers}`;
}

/** Grouped exactly like sheet.tsx's own picker: one <optgroup> per model
 * group, in WEATHER_MODELS' own order (first-seen group order). */
function groupedModels(): { label: string; models: WeatherModel[] }[] {
  const order: string[] = [];
  const byGroup = new Map<string, WeatherModel[]>();
  for (const m of WEATHER_MODELS) {
    if (!byGroup.has(m.groupLabel)) {
      order.push(m.groupLabel);
      byGroup.set(m.groupLabel, []);
    }
    byGroup.get(m.groupLabel)!.push(m);
  }
  return order.map((label) => ({ label, models: byGroup.get(label)! }));
}

function modelLabel(value: string): string {
  return WEATHER_MODELS.find((m) => m.value === value)?.label ?? value;
}

const selectClass =
  "w-full rounded border border-line px-2 py-1 focus:border-accent focus:outline-none disabled:opacity-40";

const WeatherDatasetParams: Component<DatasetParamsProps> = (props) => {
  const isOnDemand = () => props.mode === "live-cache";
  const domains = () => domainsOf(props.value);
  // A live cache never offers "grib" (no toggle shown for it — see sourceOf's
  // docstring), so its own domains are always read/written as "om" regardless
  // of whatever implementation happens to be sitting in the draft.
  const source = () => (isOnDemand() ? "om" : sourceOf(props.implementation, props.value));

  // Every field of the draft `params` object is replaced wholesale, and the
  // legacy singular `domain` key is always dropped once this component has
  // touched the value — `domains` is the one shape saved from here on.
  const setDomains = (next: string[]) => {
    const value = { ...props.value };
    delete value.domain;
    value.domains = next;
    props.onChange(value);
  };

  // Switching source clears the picked domain(s): an Open-Meteo domain id and
  // a GRIB product id validate against different catalogs server-side (see
  // docs/architecture/weather-dataset-params.md for the one exception).
  const setSource = (next: "om" | "grib") => {
    const value = { ...props.value };
    delete value.domain;
    // Drop the retired `params.source` spelling too, so re-saving an old
    // dataset stops carrying two spellings of one fact.
    delete value.source;
    value.domains = [];
    props.onChange(value);
    props.onImplementationChange(next);
  };

  // "" is the null/unset horizon — a <select> value is always a string, and
  // an absent `max_forecast_hours` must round-trip as absent, not as 0.
  const horizon = () => {
    const v = props.value.max_forecast_hours;
    return typeof v === "number" && Number.isFinite(v) ? String(v) : "";
  };

  const setHorizon = (raw: string) => {
    const next = { ...props.value };
    delete next.domain;
    if (raw === "") delete next.max_forecast_hours;
    else next.max_forecast_hours = Number(raw);
    props.onChange(next);
  };

  // Selected domain's live reach — single-domain "om" mode only (a GRIB
  // product has no `latest.json` to query). A failure resolves to nothing
  // rather than an error — this line is an aid, never a save gate.
  const [reach] = createResource(
    () => (!isOnDemand() && source() === "om" && domains()[0]) || null,
    async (domain) => {
      try {
        return horizonHoursFromManifest(await fetchModelManifest(domain), Date.now());
      } catch {
        return null;
      }
    },
  );

  /** "reaches 2 days 12 h ahead right now" — whole days once past one. */
  const reachLabel = (): string | null => {
    const h = reach();
    if (h === undefined || h === null || h <= 0) return null;
    const hours = Math.round(h);
    if (hours < 48) return `${hours} h`;
    const days = Math.floor(hours / 24);
    const rest = hours % 24;
    return rest ? `${days} days ${rest} h` : `${days} days`;
  };

  return (
    <div class="space-y-3">
      <Show when={!isOnDemand()}>
        <div class="space-y-1">
          <span class="block text-xs text-fg-2" id="weather-source-label">
            Source
          </span>
          <div class="flex gap-1" role="group" aria-labelledby="weather-source-label">
            <button
              type="button"
              aria-pressed={source() === "om"}
              class="flex-1 rounded border border-line px-1.5 py-1 text-center text-[11px] disabled:opacity-40"
              classList={{
                "bg-accent! text-accent-fg! border-accent!": source() === "om",
                "text-fg-2 hover:bg-chrome-2 hover:text-fg": source() !== "om",
              }}
              disabled={props.disabled}
              onClick={() => setSource("om")}
            >
              Open-Meteo (.om)
            </button>
            <button
              type="button"
              aria-pressed={source() === "grib"}
              class="flex-1 rounded border border-line px-1.5 py-1 text-center text-[11px] disabled:opacity-40"
              classList={{
                "bg-accent! text-accent-fg! border-accent!": source() === "grib",
                "text-fg-2 hover:bg-chrome-2 hover:text-fg": source() !== "grib",
              }}
              disabled={props.disabled}
              onClick={() => setSource("grib")}
            >
              GRIB (direct DWD/ICON)
            </button>
          </div>
          <p class="text-[11px] leading-snug text-fg-3">
            GRIB fetches wind @ 10 m directly from DWD's own opendata — much smaller than an
            Open-Meteo mirror, but wind only, DWD only for now.
          </p>
        </div>
      </Show>

      <Show
        when={isOnDemand()}
        fallback={
          <Show
            when={source() === "grib"}
            fallback={
              <label class="block space-y-1">
                <span class="text-xs text-fg-2">Weather model (domain)</span>
                <select
                  class={selectClass}
                  disabled={props.disabled}
                  value={domains()[0] ?? ""}
                  onChange={(e) => setDomains([e.currentTarget.value])}
                >
                  <option value="">Pick a model…</option>
                  <For each={groupedModels()}>
                    {(g) => (
                      <optgroup label={g.label}>
                        <For each={g.models}>
                          {(m) => <option value={m.value}>{optionLabel(m)}</option>}
                        </For>
                      </optgroup>
                    )}
                  </For>
                </select>
                <p class="text-[11px] leading-snug text-fg-3">
                  Mirrors this model full-grid — a weather bake is not clipped to a region (Open-Meteo
                  domains aren't bbox-subsettable); the Region above is only a label for which area this
                  is for.
                </p>
              </label>
            }
          >
            <label class="block space-y-1">
              <span class="text-xs text-fg-2">GRIB product</span>
              <select
                class={selectClass}
                disabled={props.disabled}
                value={domains()[0] ?? ""}
                onChange={(e) => setDomains([e.currentTarget.value])}
              >
                <option value="">Pick a product…</option>
                <For each={WEATHER_GRIB_PRODUCTS}>
                  {(p) => <option value={p.value}>{p.label} — Wind only</option>}
                </For>
              </select>
              <p class="text-[11px] leading-snug text-fg-3">
                Fetches this product's whole domain directly from DWD — not clipped to a region
                either (DWD's own files aren't bbox-subsettable); the Region above is only a label
                for which area this is for.
              </p>
            </label>
          </Show>
        }
      >
        <div class="space-y-1">
          <span class="block text-xs text-fg-2">Models allowed to live-cache</span>
          <Show
            when={domains().length > 0}
            fallback={<p class="text-xs text-fg-3">No domain chosen yet — add one below.</p>}
          >
            <ul class="flex flex-wrap gap-1">
              <For each={domains()}>
                {(d) => (
                  <li class="flex items-center gap-1 rounded border border-line bg-chrome-2 px-1.5 py-0.5 text-xs">
                    <span>{modelLabel(d)}</span>
                    <button
                      type="button"
                      class="text-fg-3 hover:text-alarm disabled:opacity-40"
                      disabled={props.disabled}
                      aria-label={`Remove ${modelLabel(d)}`}
                      onClick={() => setDomains(domains().filter((x) => x !== d))}
                    >
                      ×
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <select
            class={selectClass}
            disabled={props.disabled}
            value=""
            onChange={(e) => {
              const picked = e.currentTarget.value;
              if (picked && !domains().includes(picked)) setDomains([...domains(), picked]);
              e.currentTarget.value = ""; // an "add" control, not a current-value picker
            }}
          >
            <option value="">Add a model…</option>
            <For each={groupedModels()}>
              {(g) => (
                <optgroup label={g.label}>
                  <For each={g.models}>
                    {(m) => (
                      <option value={m.value} disabled={domains().includes(m.value)}>
                        {optionLabel(m)}
                      </option>
                    )}
                  </For>
                </optgroup>
              )}
            </For>
          </select>
          <p class="text-[11px] leading-snug text-fg-3">
            Which models the boat's one shared live cache may fetch and keep as views request them —
            not a bake, and not clipped to a region. The cache's own disk budget is a separate,
            boat-wide setting.
          </p>
        </div>
      </Show>

      <Show when={!isOnDemand()}>
        <label class="block space-y-1">
          <span class="text-xs text-fg-2">Download forecast up to</span>
          <select
            class={selectClass}
            disabled={props.disabled}
            value={horizon()}
            onChange={(e) => setHorizon(e.currentTarget.value)}
          >
            <For each={HORIZONS}>
              {(h) => (
                <option value={h.hours === null ? "" : String(h.hours)}>
                  {h.hours === null && source() === "grib" ? "Everything published" : h.label}
                </option>
              )}
            </For>
          </select>
          <Show
            when={source() === "grib"}
            fallback={
              <p class="text-[11px] leading-snug text-fg-3">
                Every forecast hour is its own full-size download, so this is what a bake costs in
                disk and time. Yesterday's hours are never kept, and lowering this frees the extra
                files on the next bake.
              </p>
            }
          >
            <p class="text-[11px] leading-snug text-fg-3">
              GRIB steps are small (roughly 1 MB each) — even "everything published" is on the order
              of 100–250 MB, bounded by the product's own forecast horizon (named in its label
              above), not by this setting.
            </p>
          </Show>
          <Show when={source() === "om" && reachLabel()}>
            {(r) => (
              <p class="text-[11px] leading-snug text-fg-2">
                This model's latest run reaches <b class="font-semibold">{r()}</b> ahead — asking
                for more than that just downloads nothing extra.
              </p>
            )}
          </Show>
        </label>
      </Show>
    </div>
  );
};

export default WeatherDatasetParams;
