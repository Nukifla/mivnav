// The weather feature's command contribution — closes over the weather
// MODEL (never a second copy of its setters), gated to when weather mode is
// active. No keybindings: browse-and-pick, not an accelerator surface.

import { defineCommand, type Command } from "../../core/chrome/command";
import type { CommandDeps } from "../../core/chrome/commands";
import {
  WEATHER_FIELDS,
  WEATHER_MAX_HOURS,
  type WeatherFieldId,
} from "../../core/weatherSettings";
import { stepSource } from "./sources";
import { WEATHER_MODE_ID, type WeatherModeModel } from "./mode";

/** Hours in a day — the forecast steps a whole day at a time (the sheet's slider
 * is for finer moves). Kept aligned to the 3-hour grid because 24 is a multiple
 * of `WEATHER_HOUR_STEP`, so ±day never lands off a valid step. */
const DAY_HOURS = 24;

/** Is the weather mode active? Gates every command below — the palette hides
 * them and `dispatchKey` skips them when the mode is not open. */
const active = (deps: CommandDeps): boolean => deps.activeMode() === WEATHER_MODE_ID;

/** The weather commands, closing over the mode's `model`; `deps` is only
 * read for the `enabled` gate. */
export function weatherCommands(deps: CommandDeps, model: WeatherModeModel): Command[] {
  const enabled = () => active(deps);
  const w = model.weather;

  // One "select this field" command per raster field, plus an explicit "off" —
  // the ~7 the field list defines. Generated from `WEATHER_FIELDS` so a new field
  // gets its command for free, exactly as the sheet's field row is generated.
  const fieldCommands: Command[] = [
    ...WEATHER_FIELDS.map((f) =>
      defineCommand({
        id: `weather-field-${f.id}`,
        label: `Weather: ${f.label}`,
        group: "Weather",
        hint: `Show the ${f.label.toLowerCase()} overlay`,
        keywords: ["weather", "field", "overlay", "wash", f.label.toLowerCase()],
        enabled,
        run: (ctx) => {
          model.setField(f.id as WeatherFieldId);
          ctx.close();
        },
      }),
    ),
    defineCommand({
      id: "weather-field-off",
      label: "Weather: off",
      group: "Weather",
      hint: "Hide the weather raster overlay",
      keywords: ["weather", "field", "off", "none", "hide", "clear"],
      enabled,
      run: (ctx) => {
        model.setField("off");
        ctx.close();
      },
    }),
  ];

  return [
    ...fieldCommands,

    // Forecast time, a whole day at a time, clamped to the ruler's window. The
    // sheet's slider is the fine control; these are the quick jumps.
    defineCommand({
      id: "weather-forecast-later",
      label: "Forecast +1 day",
      group: "Weather",
      hint: "Step the forecast time forward one day",
      keywords: ["weather", "forecast", "time", "later", "forward", "day", "+"],
      enabled,
      run: (ctx) => {
        model.setHours(Math.min(w().hours + DAY_HOURS, WEATHER_MAX_HOURS));
        ctx.close();
      },
    }),
    defineCommand({
      id: "weather-forecast-earlier",
      label: "Forecast −1 day",
      group: "Weather",
      hint: "Step the forecast time back one day (0 = now)",
      keywords: ["weather", "forecast", "time", "earlier", "back", "day", "-"],
      enabled,
      run: (ctx) => {
        model.setHours(Math.max(w().hours - DAY_HOURS, 0));
        ctx.close();
      },
    }),

    // Wind flow (the animated streaks — the setting is still named `arrows`, see
    // WeatherSettings). Labels the action off the live state, like every toggle.
    defineCommand({
      id: "weather-toggle-arrows",
      label: `${w().arrows ? "Hide" : "Show"} wind flow`,
      group: "Weather",
      hint: "Animated wind-flow streaks over the chart",
      keywords: ["weather", "wind", "flow", "arrows", "streaks", "animation"],
      enabled,
      run: (ctx) => {
        model.setArrows(!w().arrows);
        ctx.close();
      },
    }),

    // Cycle the forecast source over `model.sources()`, this boat's actual
    // offered list, so it never offers an id the server would 404. Steps an
    // INDEX (see `stepSource`), never reads an id.
    defineCommand({
      id: "weather-model-next",
      label: "Next weather source",
      group: "Weather",
      hint: "Switch to the next forecast source",
      keywords: ["weather", "model", "next", "forecast", "source"],
      enabled,
      run: (ctx) => {
        model.setModel(stepSource(model.sources(), w().model, +1));
        ctx.close();
      },
    }),
    defineCommand({
      id: "weather-model-prev",
      label: "Previous weather source",
      group: "Weather",
      hint: "Switch to the previous forecast source",
      keywords: ["weather", "model", "previous", "prev", "forecast", "source"],
      enabled,
      run: (ctx) => {
        model.setModel(stepSource(model.sources(), w().model, -1));
        ctx.close();
      },
    }),

    // Keep the overlay drawn after the mode is closed (else it is a transient
    // look that vanishes on leave). Labels the action off the live state.
    defineCommand({
      id: "weather-keep-visible",
      label: w().keepVisible ? "Clear weather when closing" : "Keep weather visible when closing",
      group: "Weather",
      hint: "Whether the overlay persists after you leave weather mode",
      keywords: ["weather", "keep", "visible", "persist", "overlay"],
      enabled,
      run: (ctx) => {
        model.setKeepVisible(!w().keepVisible);
        ctx.close();
      },
    }),
  ];
}
