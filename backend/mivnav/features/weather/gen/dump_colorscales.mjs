// Regenerate `backend/mivnav/features/weather/data/colorscales.json` from the real
// `@openmeteo/weather-map-layer` bundle's `getColorScale`, rather than
// hand-transcribing its breakpoint/color literals. Run from `backend/`:
//
//   node mivnav/features/weather/gen/dump_colorscales.mjs > mivnav/features/weather/data/colorscales.json
//
// (needs `frontend/node_modules` installed — `bun install` in `frontend/` if
// missing).
//
// Dumps the ALREADY-RESOLVED (light/dark) scale for every variable this app's
// wash actually serves — frontend/src/core/weatherSettings.ts's
// WEATHER_FIELDS variables, plus both wind conventions `windVariable()` can
// pick (`wind_speed_10m` for DMI/KNMI Harmonie models, `wind_u_component_10m`
// for the u/v-component models — see features/weather/sources.ts). Extend
// this list if a new field/variable is added there.
// Ported-from: @openmeteo/weather-map-layer dist/index.mjs `getColorScale`.
import { getColorScale } from "../../../../../frontend/node_modules/@openmeteo/weather-map-layer/dist/index.mjs";

const VARIABLES = [
  "temperature_2m",
  "pressure_msl",
  "visibility",
  "wave_height",
  "wind_gusts_10m",
  "wind_speed_10m",
  "wind_u_component_10m",
];

const out = {};
for (const v of VARIABLES) {
  out[v] = {
    light: getColorScale(v, false),
    dark: getColorScale(v, true),
  };
}
console.log(JSON.stringify(out, null, 2));
