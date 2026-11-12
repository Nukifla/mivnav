// The weather feature's command contribution — `weatherCommands` closing over
// the mode model. Drives them against a mutable settings signal and asserts each
// writes the SAME slice the sheet's controls do, is enabled only while the
// weather mode is active, and that the ids stay unique (the registry throws on a
// collision).

import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import { DEFAULT_WEATHER, WEATHER_MAX_HOURS, type WeatherSettings } from "../../core/weatherSettings";
import { createWeatherMode } from "./mode";
import { weatherCommands } from "./commands";
import type { WeatherModeModel } from "./mode";
import type { WeatherSourceInfo } from "./sources";
import type { CommandDeps } from "../../core/chrome/commands";

function fakeSource(id: string, label: string): WeatherSourceInfo {
  return {
    id,
    label,
    badge: "",
    requiresNetwork: false,
    variables: ["wind"],
    coverage: { local: [], remote: [], referenceMs: null },
    region: null,
  };
}

/** A stand-in offered list — the cycling commands step over `model.sources()`,
 * a live per-boat fact fetched from the backend. The ids are deliberately
 * shapeless: the commands step an INDEX and must never read one (see
 * `sources.test.ts` for the fetch/parse contract). */
const FAKE_SOURCES: WeatherSourceInfo[] = [
  fakeSource("model-a", "Model A"),
  fakeSource("model-b", "Model B"),
  fakeSource("model-c", "Model C"),
];

/** A model over a mutable settings signal, plus a `deps` whose `activeMode` the
 * test can flip between "weather" and elsewhere. `sources` overrides the mode's
 * own (fetch-backed) `sources()` accessor, patched on afterwards — cycling
 * needs a known list, and this test suite otherwise has no network. */
function harness(
  mode: string | null = "weather",
  initial: Partial<WeatherSettings> = {},
  sources: readonly WeatherSourceInfo[] = FAKE_SOURCES,
) {
  return createRoot((dispose) => {
    const [weather, setWeather] = createSignal<WeatherSettings>({ ...DEFAULT_WEATHER, ...initial });
    const { model: real } = createWeatherMode({
      weather,
      setWeather: (patch) => setWeather((s) => ({ ...s, ...patch })),
      windUnit: () => "ms",
      toggleWindUnit: () => {},
      palette: () => "day",
    });
    const model: WeatherModeModel = { ...real, sources: () => sources };
    const deps = { activeMode: () => mode } as unknown as CommandDeps;
    return { model, weather, deps, dispose };
  });
}

const run = (cmds: ReturnType<typeof weatherCommands>, id: string) => {
  const c = cmds.find((x) => x.id === id);
  if (!c) throw new Error(`no command ${id}`);
  c.run({ close: () => {}, prompt: () => {} });
};

describe("weatherCommands", () => {
  test("every command is enabled in weather mode and disabled outside it", () => {
    const on = harness("weather");
    for (const c of weatherCommands(on.deps, on.model)) expect(c.enabled!()).toBe(true);
    on.dispose();
    const off = harness("route-edit");
    for (const c of weatherCommands(off.deps, off.model)) expect(c.enabled!()).toBe(false);
    off.dispose();
  });

  test("field commands set the raster field, including an explicit off", () => {
    const h = harness("weather", { field: "off" });
    run(weatherCommands(h.deps, h.model), "weather-field-wind");
    expect(h.weather().field).toBe("wind");
    run(weatherCommands(h.deps, h.model), "weather-field-off");
    expect(h.weather().field).toBe("off");
    h.dispose();
  });

  test("forecast +/- a day steps the hours and clamps to [0, max]", () => {
    const h = harness("weather", { hours: 0 });
    run(weatherCommands(h.deps, h.model), "weather-forecast-later");
    expect(h.weather().hours).toBe(24);
    run(weatherCommands(h.deps, h.model), "weather-forecast-earlier");
    expect(h.weather().hours).toBe(0);
    // Already at the floor: earlier stays at 0, never negative.
    run(weatherCommands(h.deps, h.model), "weather-forecast-earlier");
    expect(h.weather().hours).toBe(0);
    h.dispose();

    const top = harness("weather", { hours: WEATHER_MAX_HOURS });
    run(weatherCommands(top.deps, top.model), "weather-forecast-later");
    expect(top.weather().hours).toBe(WEATHER_MAX_HOURS); // clamped to the ceiling
    top.dispose();
  });

  test("toggle-arrows flips wind flow and labels itself by state", () => {
    const off = harness("weather", { arrows: false });
    const cmd = weatherCommands(off.deps, off.model).find((c) => c.id === "weather-toggle-arrows")!;
    expect(cmd.label).toBe("Show wind flow");
    run(weatherCommands(off.deps, off.model), "weather-toggle-arrows");
    expect(off.weather().arrows).toBe(true);
    off.dispose();
    const on = harness("weather", { arrows: true });
    expect(
      weatherCommands(on.deps, on.model).find((c) => c.id === "weather-toggle-arrows")!.label,
    ).toBe("Hide wind flow");
    on.dispose();
  });

  test("source next / prev cycle through model.sources(), wrapping", () => {
    const first = FAKE_SOURCES[0].id;
    const second = FAKE_SOURCES[1].id;
    const last = FAKE_SOURCES[FAKE_SOURCES.length - 1].id;
    const h = harness("weather", { model: first });
    run(weatherCommands(h.deps, h.model), "weather-model-next");
    expect(h.weather().model).toBe(second);
    // From the first, previous wraps to the last.
    const p = harness("weather", { model: first });
    run(weatherCommands(p.deps, p.model), "weather-model-prev");
    expect(p.weather().model).toBe(last);
    h.dispose();
    p.dispose();
  });

  test("a GRIB-backed source is just another row — no special case anywhere in the cycle", () => {
    // The whole point of an opaque id: a baked GRIB dataset used to be a
    // separately-joined `BakedIndex` entry with its own parse. It is one more
    // row from the registry now, and the cycle cannot tell it apart.
    const gribId = "grib:my-wx:dwd_icon_eu";
    const sources = [...FAKE_SOURCES, fakeSource(gribId, "my-wx · DWD ICON-EU")];
    const last = FAKE_SOURCES[FAKE_SOURCES.length - 1].id;

    const h = harness("weather", { model: last }, sources);
    run(weatherCommands(h.deps, h.model), "weather-model-next");
    expect(h.weather().model).toBe(gribId);
    h.dispose();

    const p = harness("weather", { model: gribId }, sources);
    run(weatherCommands(p.deps, p.model), "weather-model-prev");
    expect(p.weather().model).toBe(last);
    p.dispose();
  });

  test("a stale/unknown current selection resolves to index 0, so the step still lands", () => {
    // A hand-edited profile whose source is no longer offered: findIndex is
    // -1, Math.max(0, -1) anchors it at index 0, so next → the second source
    // and prev → the last, rather than stepping off nothing.
    const second = FAKE_SOURCES[1].id;
    const last = FAKE_SOURCES[FAKE_SOURCES.length - 1].id;

    const n = harness("weather", { model: "gone_from_the_catalog" });
    run(weatherCommands(n.deps, n.model), "weather-model-next");
    expect(n.weather().model).toBe(second);
    n.dispose();

    const p = harness("weather", { model: "gone_from_the_catalog" });
    run(weatherCommands(p.deps, p.model), "weather-model-prev");
    expect(p.weather().model).toBe(last);
    p.dispose();
  });

  test("source next / prev is a no-op when this boat offers NOTHING", () => {
    // The fresh-boat empty state: nothing to cycle to, so the command must not
    // crash and must not change the selection.
    const h = harness("weather", { model: "om:dwd_icon" }, []);
    run(weatherCommands(h.deps, h.model), "weather-model-next");
    expect(h.weather().model).toBe("om:dwd_icon");
    run(weatherCommands(h.deps, h.model), "weather-model-prev");
    expect(h.weather().model).toBe("om:dwd_icon");
    h.dispose();
  });

  test("keep-visible toggles and labels itself by state", () => {
    const h = harness("weather", { keepVisible: false });
    run(weatherCommands(h.deps, h.model), "weather-keep-visible");
    expect(h.weather().keepVisible).toBe(true);
    h.dispose();
  });

  test("the command ids are unique", () => {
    const h = harness("weather");
    const ids = weatherCommands(h.deps, h.model).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    h.dispose();
  });
});
