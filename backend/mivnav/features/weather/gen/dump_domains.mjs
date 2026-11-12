// Regenerate `backend/mivnav/features/weather/data/domain_grids.json` from the real
// `@openmeteo/weather-map-layer` bundle, rather than hand-transcribing the
// per-domain grid/projection literals (they change when the package updates
// its domain catalog). Run from `backend/`:
//
//   node mivnav/features/weather/gen/dump_domains.mjs > mivnav/features/weather/data/domain_grids.json
//
// (needs `frontend/node_modules` installed — `bun install` in `frontend/` if
// missing).
//
// Dumps {value: grid} for every domain — the per-model grid/projection
// definition the backend needs to build the same GridFactory the frontend
// builds (mivnav.features.weather.grid.GridFactory), keyed by Open-Meteo domain id
// (parsed from the .om path's model segment — see mivnav.features.weather.domains).
// Ported-from: @openmeteo/weather-map-layer dist/index.mjs `domainOptions`.
import { domainOptions } from "../../../../../frontend/node_modules/@openmeteo/weather-map-layer/dist/index.mjs";

const out = {};
for (const d of domainOptions) {
  out[d.value] = d.grid;
}
console.log(JSON.stringify(out, null, 2));
