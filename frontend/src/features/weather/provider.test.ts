import { afterEach, describe, expect, it, test } from "bun:test";
import { createRoot } from "solid-js";
import { createWeatherInfoProvider, gridWindSufficient } from "./provider";
import type { SampledPoint } from "./point";
import type { WeatherSourceInfo } from "./sources";
import { DEFAULT_SETTINGS, type ChartSettings } from "../../core/style/settings";
import { createInfoMarker, type InfoMarkerMap } from "../../core/info/marker";
import { createInfoState } from "../../core/info/state";
import type { InfoHit } from "../../core/info/types";

/** The SELECTED source seam (tests). The provider reads the mode's resolved
 *  row rather than fetching the registry itself, so a test hands it one
 *  directly. It serves wind and waves and declares no coverage, so
 *  `validTimeFor` falls through to the plain computed instant — this file
 *  mocks `globalThis.fetch` for the FORECAST API only, and the grid sampler is
 *  seamed separately below. */
const SOURCE: WeatherSourceInfo = {
  id: "om:dwd_icon",
  label: "DWD ICON",
  badge: "",
  requiresNetwork: true,
  variables: ["wind", "waves"],
  coverage: { local: [], remote: [], referenceMs: null },
  region: null,
};
const selectedSource = () => SOURCE;

const HIT: InfoHit = {
  providerId: "weather",
  id: "wind",
  priority: "context",
  precision: "point",
  title: "Wind",
  lngLat: { lat: 55, lng: 12 },
};

function settings(over: Partial<ChartSettings["weather"]> = {}): ChartSettings {
  return { ...DEFAULT_SETTINGS, windUnit: "ms", weather: { ...DEFAULT_SETTINGS.weather, field: "wind", ...over } };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A forecast API double: constant wind, valid at "now". */
function mockForecast(speedMs: number, dirDeg: number, gustMs: number): void {
  const now = Math.floor(Date.now() / 1000);
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({
      hourly: {
        time: [now],
        wind_speed_10m: [speedMs],
        wind_direction_10m: [dirDeg],
        wind_gusts_10m: [gustMs],
      },
    }),
  })) as unknown as typeof fetch;
}

/** Flush microtasks + one macrotask so a non-blocking extras fetch settles. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("weather infoProvider headline (hybrid)", () => {
  it("renders the grid wind immediately, then gains the API gusts on a re-resolve", async () => {
    mockForecast(5, 45, 8); // API gusts 8; its speed/dir must NOT win the headline
    const sampled: SampledPoint = { value: 12, direction: 247.5 }; // 12 m/s WSW
    const provider = createWeatherInfoProvider({
      settings,
      toggleWindUnit: () => {},
      sample: async () => sampled,
      selectedSource,
    });

    // First resolve: grid speed+dir, NO wait on the network → no gusts yet.
    const first = await provider.detail(HIT);
    expect(first.subtitle).toBe("12 m/s · from WSW");
    expect(first.sections.find((s) => s.label === "Wind")?.rows[0]?.value).toBe("12 m/s");

    // The extras fetch lands non-blocking; a re-resolve now carries the gusts,
    // still with the grid's (not the API's) speed and direction.
    await tick();
    const second = await provider.detail(HIT);
    expect(second.subtitle).toBe("12 m/s · gusts 8 · from WSW");
    expect(second.sections.find((s) => s.label === "Wind")?.rows[0]?.value).toBe("12 m/s");
  });

  it("keeps the grid-driven Wind section the SAME rows before and after the extras land (no row added → no height jump)", async () => {
    mockForecast(5, 45, 8);
    const sampled: SampledPoint = { value: 12, direction: 247.5 };
    const provider = createWeatherInfoProvider({
      settings,
      toggleWindUnit: () => {},
      sample: async () => sampled,
      selectedSource,
    });
    const windRows = (d: Awaited<ReturnType<typeof provider.detail>>) =>
      d.sections.find((s) => s.label === "Wind")?.rows ?? [];

    // First resolve (extras still pending): the API-only rows are ALREADY present,
    // reading a muted "—" placeholder — the readout renders at its full height.
    const first = await provider.detail(HIT);
    expect(windRows(first).map((r) => r.label)).toEqual(["Speed", "Gusts", "Direction", "Valid"]);
    expect(windRows(first).find((r) => r.label === "Gusts")?.value).toBe("—");
    expect(windRows(first).find((r) => r.label === "Valid")?.value).toBe("—");

    // After the extras land: the SAME rows, now populated in place — the row set
    // did not change, so the panel's height cannot have jumped.
    await tick();
    const second = await provider.detail(HIT);
    expect(windRows(second).map((r) => r.label)).toEqual(["Speed", "Gusts", "Direction", "Valid"]);
    expect(windRows(second).find((r) => r.label === "Gusts")?.value).toBe("8 m/s");
  });

  it("falls back to the forecast API when no grid is present", async () => {
    mockForecast(5, 45, 8); // API says 5 m/s NE — must win when no grid
    const provider = createWeatherInfoProvider({
      settings,
      toggleWindUnit: () => {},
      sample: async () => null, // no decoded grid
      selectedSource,
    });
    const detail = await provider.detail(HIT);
    expect(detail.subtitle).toBe("5 m/s · gusts 8 · from NE");
  });

  it("still renders the sampled wind summary when the API is offline", async () => {
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const provider = createWeatherInfoProvider({
      settings,
      toggleWindUnit: () => {},
      sample: async () => ({ value: 9 }), // grid speed only, no gusts, no direction
      selectedSource,
    });
    const detail = await provider.detail(HIT);
    expect(detail.subtitle).toBe("9 m/s");
  });

  it("does not put the forecast time in the pre-fetch hit subtitle", () => {
    const provider = createWeatherInfoProvider({ settings, toggleWindUnit: () => {}, selectedSource });
    const [hit] = provider.queryAt({ point: { x: 0, y: 0 }, lngLat: { lng: 12, lat: 55 }, radius: 8 });
    expect(hit.subtitle).toBeUndefined();
  });
});

describe("gridWindSufficient — the grid-alone-drives-the-readout predicate", () => {
  it("is true only for a finite speed AND a finite direction", () => {
    expect(gridWindSufficient({ value: 12, direction: 247.5 })).toBe(true);
  });
  it("is false with no sample", () => {
    expect(gridWindSufficient(null)).toBe(false);
  });
  it("is false with speed but no direction (a scalar-only or decoding grid)", () => {
    expect(gridWindSufficient({ value: 9 })).toBe(false);
  });
  it("is false with a non-finite speed", () => {
    expect(gridWindSufficient({ value: NaN, direction: 90 })).toBe(false);
  });
  it("is false with a non-finite direction", () => {
    expect(gridWindSufficient({ value: 9, direction: NaN })).toBe(false);
  });
});

// MARKER UNIFICATION (mandate 5). "Wind at a point" is reached through the
// info-at-point seam, so its on-chart marker must be the ONE shared info marker
// (info/InfoMarker.tsx, driven by info/marker.ts `createInfoMarker`) every other
// provider's hit gets — not a weather-specific crosshair. That is not a special
// case in this provider: it volunteers a plain point hit carrying the tapped
// `lngLat`, and the shared marker model renders any current hit generically. The
// only weather-specific crosshair (MapView's `weatherMarkerElement`) belongs to
// the weather MODE's live cursor readout, a different surface gated on the mode
// being active — never drawn on this path. This test pins the unification: the
// weather hit resolves through `createInfoMarker` to a ring placed EXACTLY on the
// read point (the misalignment the weather-mode marker once had must never leak
// in here).
describe("weather info hit renders via the shared info marker", () => {
  test("createInfoMarker places the ring on the tapped point — same path every provider uses", () => {
    const provider = createWeatherInfoProvider({ settings, toggleWindUnit: () => {}, selectedSource });
    const at = { lng: 12, lat: 55 };
    const [hit] = provider.queryAt({ point: { x: 0, y: 0 }, lngLat: at, radius: 8 });
    expect(hit).toBeDefined();
    expect(hit.providerId).toBe("weather");

    const state = createInfoState();
    // A plain-scale projection (1° = 10 px, top-left origin) so the screen
    // position reads as arithmetic — the same double info/marker.test.ts uses.
    const map: InfoMarkerMap = {
      project: (p) => ({ x: p.lng * 10, y: p.lat * 10 }),
      getContainer: () => ({ clientWidth: 800, clientHeight: 600 }),
      easeTo: () => {},
      on: () => {},
      off: () => {},
    };
    const [marker, dispose] = createRoot(
      (d) =>
        [
          createInfoMarker({ state, providers: [provider], map, obscured: () => ({ bottom: 0 }) }),
          d,
        ] as const,
    );

    // Nothing selected → no marker, exactly as for any other provider.
    expect(marker.screen()).toBeUndefined();

    state.show([hit]);
    // The shared marker resolves the weather hit to the SAME ring, landing on the
    // read point — no crosshair, no half-map offset.
    expect(marker.lngLat()).toEqual(at);
    expect(marker.screen()).toEqual({ x: 120, y: 550 });

    dispose();
  });
});
