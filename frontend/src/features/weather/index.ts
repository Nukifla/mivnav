// The WEATHER feature — Open-Meteo forecast overlay, folded into ONE `defineFeature`.
// See docs/architecture/weather-overlay.md for why it's an imperative MapView
// overlay, not a declarative `overlay` slot.

import type { Accessor } from "solid-js";
import { defineFeature, type AppFeature } from "../../core/chrome/feature";
import type { ChartSettings } from "../../core/style/settings";
import WeatherDatasetParams from "./DatasetParams";
import { createWeatherMode, WEATHER_MODE_ID, type WeatherModeModel } from "./mode";
import { createWeatherInfoProvider } from "./provider";
import { weatherCommands } from "./commands";

export interface WeatherDeps {
  settings: Accessor<ChartSettings>;
  setSettings: (fn: (s: ChartSettings) => ChartSettings) => void;
  toggleWindUnit: () => void;
}

export interface Weather {
  feature: AppFeature;
  /** MapView draws the readout/double-buffer from this; the sheet edits it. */
  model: WeatherModeModel;
}

export function createWeather(deps: WeatherDeps): Weather {
  const { mode, model } = createWeatherMode({
    weather: () => deps.settings().weather,
    setWeather: (patch) =>
      deps.setSettings((s) => ({ ...s, weather: { ...s.weather, ...patch } })),
    windUnit: () => deps.settings().windUnit,
    toggleWindUnit: deps.toggleWindUnit,
    palette: () => deps.settings().palette,
  });
  const provider = createWeatherInfoProvider({
    settings: deps.settings,
    toggleWindUnit: deps.toggleWindUnit,
    // The mode owns the ONE `GET /weather/sources` fetch, fetched lazily on
    // first activation; the provider reads the resolved row rather than
    // fetching a second time.
    selectedSource: model.selected,
  });
  return {
    feature: defineFeature({
      id: "weather",
      modes: [mode],
      provider,
      commands: (deps) => weatherCommands(deps, model),
      settings: {
        // No standalone Settings-panel controls (the model/field/hour pickers
        // live in the mode's own sheet) — exists only to carry `datasetParams`.
        settings: [],
        // Weather half of `DatasetEditForm`'s per-provider params sub-form
        // (core/settings/DatasetList.tsx): which Open-Meteo model to bake
        // today's runs for (#rktyytqx).
        datasetParams: { weather: WeatherDatasetParams },
      },
      // The wash is VISIBLE while its mode is open OR when kept; the toggle
      // drives `keepVisible` alone and never enters/leaves the interactive
      // mode (that stays the rail button's / ⌘K's job).
      overlayControls: (deps) => [
        {
          id: "weather",
          label: "Weather",
          visible: () => model.weather().keepVisible || deps.activeMode() === WEATHER_MODE_ID,
          setVisible: (v) => model.setKeepVisible(v),
          opacity: () => model.weather().opacity,
          setOpacity: (v) => model.setOpacity(v),
        },
      ],
    }),
    model,
  };
}
