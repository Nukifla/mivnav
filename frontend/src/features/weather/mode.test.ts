import { afterEach, describe, expect, it } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import { DEFAULT_WEATHER, DEFAULT_WEATHER_MODEL, type WeatherSettings } from "../../core/weatherSettings";
import type { WindUnit } from "./point";
import { createWeatherMode } from "./mode";

/** A tick to let `refreshSources`'s promise chain (the mocked fetch, then the
 * `.then` that lands the list) actually run before a test asserts on it. */
const flush = () => new Promise((r) => setTimeout(r, 0));

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A `GET /weather/sources` double — the ONE endpoint `mode.ts` fetches now,
 * where it used to join `/weather/baked` and `/datasets/weather/models`. */
function mockSources(ids: string[], opts: { fail?: boolean } = {}): { calls: number } {
  const counter = { calls: 0 };
  globalThis.fetch = (async () => {
    counter.calls++;
    if (opts.fail) return { ok: false, status: 503, json: async () => ({}) };
    return {
      ok: true,
      json: async () => ({
        sources: ids.map((id) => ({
          id,
          label: id,
          badge: "",
          requires_network: false,
          variables: ["wind"],
          coverage: { local: [], remote: [], reference_time: null },
          region: null,
        })),
      }),
    };
  }) as unknown as typeof fetch;
  return counter;
}

// The clickable unit label in the sheet/bar reads `model.windUnit()` and calls
// `model.toggleWindUnit()`. This proves that wiring: the model surfaces the
// app-wide unit and forwards the toggle to App's single setter (the SAME one the
// map badge and info panel use), rather than holding any per-widget state.
describe("weather mode — app-wide unit wiring", () => {
  it("reads windUnit through and forwards the toggle to the app setter", () =>
    createRoot((dispose) => {
      const [unit, setUnit] = createSignal<WindUnit>("ms");
      const [weather] = createSignal<WeatherSettings>({ ...DEFAULT_WEATHER });
      let toggles = 0;
      const { model } = createWeatherMode({
        weather,
        setWeather: () => {},
        windUnit: unit,
        // App's real toggle flips the ChartSettings unit; here we just observe
        // that the sheet's label reaches it and see the new value read back.
        toggleWindUnit: () => {
          toggles++;
          setUnit((u) => (u === "ms" ? "kn" : "ms"));
        },
        palette: () => "day",
      });

      expect(model.windUnit()).toBe("ms");
      model.toggleWindUnit();
      expect(toggles).toBe(1);
      expect(model.windUnit()).toBe("kn");
      model.toggleWindUnit();
      expect(model.windUnit()).toBe("ms");

      dispose();
    }));
});

// The registry fetch and the ONE selection it is allowed to write. `model === ""`
// is the unselected state, so opening on the boat's first offered source is
// initialisation; a selection that is SET but no longer offered is left exactly
// as it is. That second half is the deleted behaviour: `preferBaked` used to
// silently re-point the selection at whatever was baked furthest out, and a
// second branch re-pointed anything missing from the list at its first entry.
describe("weather mode — the source registry", () => {
  function harness(initial: Partial<WeatherSettings> = {}) {
    return createRoot((dispose) => {
      const [weather, setWeather] = createSignal<WeatherSettings>({ ...DEFAULT_WEATHER, ...initial });
      const { mode, model } = createWeatherMode({
        weather,
        setWeather: (patch) => setWeather((s) => ({ ...s, ...patch })),
        windUnit: () => "ms",
        toggleWindUnit: () => {},
        palette: () => "day",
      });
      return { mode, model, weather, dispose };
    });
  }

  it("opens on the boat's FIRST offered source when nothing is selected yet", async () => {
    mockSources(["om:dwd_icon", "grib:my-wx:dwd_icon_eu"]);
    const h = harness();
    expect(h.weather().model).toBe(DEFAULT_WEATHER_MODEL); // ""
    h.mode.enter();
    await flush();
    expect(h.weather().model).toBe("om:dwd_icon");
    expect(h.model.selected()?.id).toBe("om:dwd_icon");
    h.dispose();
  });

  it("leaves an existing selection alone, even on a second entry", async () => {
    mockSources(["om:a", "om:b"]);
    const h = harness({ model: "om:b" });
    h.mode.enter();
    await flush();
    expect(h.weather().model).toBe("om:b");
    h.mode.enter();
    await flush();
    expect(h.weather().model).toBe("om:b");
    h.dispose();
  });

  it("does NOT substitute a source this boat no longer offers — `selected()` is null and the id stands", async () => {
    // The no-fallback rule, and the visible half of it: the chip reports
    // "not available on this boat" instead of quietly drawing another
    // dataset's numbers under the missing one's name.
    mockSources(["om:a"]);
    const h = harness({ model: "grib:removed-set:dwd_icon_eu" });
    h.mode.enter();
    await flush();
    expect(h.weather().model).toBe("grib:removed-set:dwd_icon_eu");
    expect(h.model.selected()).toBeNull();
    h.dispose();
  });

  it("keeps re-asking while the sheet is open, and stops on leave", async () => {
    // Coverage moves under a sitting sheet: a bake lands, and — the reason this
    // exists — the backend learns how far a LIVE run reaches only once a tile
    // has been decoded, which can happen a moment after the row the ruler is
    // drawing was handed over. Without the beat the hatch would not appear
    // until the sheet was closed and reopened. Same one endpoint, re-read.
    const counter = mockSources(["om:a"]);
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    let tick: (() => void) | null = null;
    let cleared = 0;
    globalThis.setInterval = ((fn: () => void) => {
      tick = fn;
      return 1;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = (() => {
      cleared++;
    }) as unknown as typeof clearInterval;
    try {
      const h = harness();
      h.mode.enter();
      await flush();
      expect(counter.calls).toBe(1);
      tick?.();
      await flush();
      expect(counter.calls).toBe(2);
      h.mode.leave?.();
      expect(cleared).toBeGreaterThan(0);
      h.dispose();
    } finally {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
    }
  });

  it("degrades to an EMPTY list when the backend is unreachable — the mode still opens", async () => {
    mockSources([], { fail: true });
    const h = harness();
    h.mode.enter();
    await flush();
    expect(h.model.sources()).toEqual([]);
    expect(h.weather().model).toBe("");
    h.dispose();
  });

  it("fetches once when weather turns on outside the mode (keepVisible), not at construction", async () => {
    // The overlay renders without the mode ever being entered, and MapView
    // needs a source row to build a tile URL at all. Deliberately lazy so a
    // sailor who never turns weather on never pays for the request.
    const counter = mockSources(["om:a"]);
    const h = createRoot((dispose) => {
      const [weather, setWeather] = createSignal<WeatherSettings>({ ...DEFAULT_WEATHER });
      const { model } = createWeatherMode({
        weather,
        setWeather: (patch) => setWeather((s) => ({ ...s, ...patch })),
        windUnit: () => "ms",
        toggleWindUnit: () => {},
        palette: () => "day",
      });
      return { model, weather, setWeather, dispose };
    });
    await flush();
    expect(counter.calls).toBe(0);
    h.setWeather((s) => ({ ...s, field: "wind" }));
    await flush();
    expect(counter.calls).toBe(1);
    expect(h.weather().model).toBe("om:a");
    h.dispose();
  });
});
