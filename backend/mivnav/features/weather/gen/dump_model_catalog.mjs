// Regenerate `backend/mivnav/features/weather/data/weather_model_catalog.json`
// from the real `@openmeteo/weather-map-layer` bundle — the label/group
// catalog the backend's `GET /datasets/weather/models` discovery endpoint
// (#qtwquuww) serves, so the frontend no longer needs its own copy of
// `domainOptions`/`domainGroups` to build a picker label. Run from `backend/`:
//
//   node mivnav/features/weather/gen/dump_model_catalog.mjs > mivnav/features/weather/data/weather_model_catalog.json
//
// (needs `frontend/node_modules` installed — `bun install` in `frontend/` if
// missing).
//
// Sibling of `dump_domains.mjs` (which dumps the GRID definition per domain,
// for server-side decode); this dumps the DISPLAY metadata per domain instead
// — `{value: {label, group, groupLabel, timeInterval}}`, keyed by Open-Meteo
// domain id, in `domainOptions`' own declaration order (preserved by JSON
// object insertion order, and relied on by `mivnav.features.weather.models`
// so the discovery response lists models in the same order the frontend's
// old `WEATHER_MODELS` picker always has).
//
// The group-derivation is ported VERBATIM from `frontend/src/features/weather
// /sources.ts`'s `WEATHER_MODELS` builder (the longest `domainGroups` id that
// prefixes the model id, e.g. "dmi_harmonie_arome_europe" -> "dmi") — kept
// byte-for-byte identical so a backend-served label never disagrees with the
// grouping `DatasetParams.tsx`'s dataset-declare picker still computes
// client-side from the same npm package (that picker answers "what could I
// ask Open-Meteo to bake", a different question from "what can this boat
// show now" — see `sources.ts`'s own module docstring — so it keeps building
// WEATHER_MODELS itself rather than reading this generated file).
import { domainOptions, domainGroups } from "../../../../../frontend/node_modules/@openmeteo/weather-map-layer/dist/index.mjs";

const groupLabel = new Map(domainGroups.map((g) => [g.value, g.label]));
const groupValues = domainGroups.map((g) => g.value);

function groupFor(value) {
  const matches = groupValues
    .filter((gv) => value === gv || value.startsWith(`${gv}_`))
    .sort((a, b) => b.length - a.length);
  return matches[0] ?? value.split("_")[0];
}

const out = {};
for (const d of domainOptions) {
  const group = groupFor(d.value);
  out[d.value] = {
    label: d.label ?? d.value,
    group,
    groupLabel: groupLabel.get(group) ?? group,
    timeInterval: d.time_interval ?? "",
  };
}
console.log(JSON.stringify(out, null, 2));
