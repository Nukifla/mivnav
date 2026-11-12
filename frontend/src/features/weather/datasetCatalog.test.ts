import { describe, expect, it } from "bun:test";
import {
  WEATHER_GRIB_PRODUCTS,
  WEATHER_MODELS,
  horizonHoursFromManifest,
  lastValidMs,
  manifestUrl,
  modelFields,
  modelFieldsLabel,
  modelKind,
  stepLabel,
} from "./datasetCatalog";
import { WEATHER_HOST } from "./sources";

// These tests moved here with the catalog itself (from sources.test.ts /
// availability.test.ts). The catalog is scoped to the dataset-DECLARE form
// now — see datasetCatalog.ts's header for why the registry cannot answer its
// question — and the weather MODE has no copy of any of it.

describe("models", () => {
  it("exposes the full Open-Meteo domain list, including DMI", () => {
    expect(WEATHER_MODELS.length).toBeGreaterThan(20);
    expect(WEATHER_MODELS.some((m) => m.value === "dwd_icon")).toBe(true);
    expect(WEATHER_MODELS.some((m) => m.value === "ncep_gfs025")).toBe(true);
    expect(WEATHER_MODELS.some((m) => /dmi/.test(m.value))).toBe(true);
  });

  it("groups a model by its domain-group prefix", () => {
    const dmi = WEATHER_MODELS.find((m) => m.value === "dmi_harmonie_arome_europe");
    expect(dmi?.group).toBe("dmi");
    const gfs = WEATHER_MODELS.find((m) => m.value === "ncep_gfs025");
    expect(gfs?.group).toBe("ncep");
  });
});

describe("WEATHER_GRIB_PRODUCTS — the direct-DWD offline-bake catalog (jt mzyvvmux)", () => {
  it("matches the backend's gribfetch.PRODUCTS ids (kept in sync by hand)", () => {
    expect(WEATHER_GRIB_PRODUCTS.map((p) => p.value)).toEqual(["dwd_icon_eu", "dwd_icon_d2"]);
    for (const p of WEATHER_GRIB_PRODUCTS) expect(p.label.length).toBeGreaterThan(0);
  });
});

describe("modelKind / modelFields", () => {
  it("classifies a wave model as waves-only", () => {
    expect(modelKind("dwd_ewam")).toBe("wave");
    expect(modelFields("dwd_ewam")).toEqual(["waves"]);
  });

  it("classifies a surface NWP model as the atmospheric field set", () => {
    expect(modelKind("dwd_icon")).toBe("atmospheric");
    expect(modelFieldsLabel("dwd_icon")).toBe("Wind, Gusts, Pressure, Temp");
  });

  it("an AI emulator carries wind but no gust product", () => {
    expect(modelFields("ncep_aigfs025")).toEqual(["wind", "pressure", "temperature"]);
  });

  it("ocean / air-quality / long-range domains draw NOTHING here, and say so", () => {
    expect(modelFields("meteofrance_currents")).toEqual([]);
    expect(modelFields("cams_global")).toEqual([]);
    // `null`, not "", so the caller can own the "nothing this app can draw" copy
    // — a blank where every other option shows a list reads as a bug.
    expect(modelFieldsLabel("cams_global")).toBeNull();
  });

  it("an unknown domain degrades to atmospheric rather than throwing", () => {
    expect(modelKind("some_domain_added_next_year")).toBe("atmospheric");
  });
});

describe("stepLabel", () => {
  it("renders the library's time_interval vocabulary in plain words", () => {
    expect(stepLabel("hourly")).toBe("hourly");
    expect(stepLabel("3_hourly")).toBe("3-hourly");
    expect(stepLabel("15_minute")).toBe("15-min");
    expect(stepLabel("weekly_on_monday")).toBe("weekly");
  });

  it("is empty (so the caller omits it) for anything unrecognised", () => {
    expect(stepLabel("")).toBe("");
    expect(stepLabel("fortnightly")).toBe("");
  });

  it("every catalog model carries a time_interval the label understands", () => {
    for (const m of WEATHER_MODELS) expect(stepLabel(m.timeInterval)).not.toBe("");
  });
});

describe("the capture manifest — the declare form's horizon hint", () => {
  const NOW = Date.parse("2026-07-29T12:00:00Z");

  it("reads the LAST valid time as the horizon", () => {
    const manifest = {
      valid_times: ["2026-07-29T12:00Z", "2026-07-29T18:00Z", "2026-07-31T00:00Z"],
    };
    expect(lastValidMs(manifest)).toBe(Date.parse("2026-07-31T00:00Z"));
    expect(horizonHoursFromManifest(manifest, NOW)).toBe(36);
  });

  it("is null for a manifest with no usable times — say nothing rather than guess", () => {
    expect(lastValidMs({})).toBeNull();
    expect(lastValidMs({ valid_times: [] })).toBeNull();
    expect(horizonHoursFromManifest({}, NOW)).toBeNull();
  });

  it("never reports a negative horizon for a stale run", () => {
    expect(horizonHoursFromManifest({ valid_times: ["2026-07-28T00:00Z"] }, NOW)).toBe(0);
  });

  it("asks the boat's own proxy, per DOMAIN — not per source id", () => {
    expect(manifestUrl("dwd_icon")).toBe(`${WEATHER_HOST}/data_spatial/dwd_icon/latest.json`);
  });
});
