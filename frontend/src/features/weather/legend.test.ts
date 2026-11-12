import { describe, expect, it } from "bun:test";
import { getColorScale } from "@openmeteo/weather-map-layer";
import { DEFAULT_WEATHER, type WeatherSettings } from "../../core/weatherSettings";
import { legendModel, legendVariable } from "./legend";

const base: WeatherSettings = { ...DEFAULT_WEATHER };

describe("legendVariable — keyed like the wash", () => {
  it("is null when the field is off", () => {
    expect(legendVariable({ ...base, field: "off" })).toBeNull();
  });

  it("maps the canonical field to the colour table's own key, INDEPENDENTLY of the source", () => {
    // The upstream convention (`wind_speed_10m` vs `wind_u_component_10m`) is
    // the backing's business now, and either decodes to the same SPEED
    // magnitude — which is the table `wind` must resolve to whichever source
    // answered.
    expect(legendVariable({ ...base, field: "wind", model: "om:dmi_harmonie_arome_europe" })).toBe(
      "wind_speed_10m",
    );
    expect(legendVariable({ ...base, field: "wind", model: "om:dwd_icon" })).toBe(
      "wind_speed_10m",
    );
    expect(legendVariable({ ...base, field: "gusts" })).toBe("wind_gusts_10m");
    expect(legendVariable({ ...base, field: "pressure" })).toBe("pressure_msl");
    expect(legendVariable({ ...base, field: "waves" })).toBe("wave_height");
  });

  it("does NOT hand the canonical name straight to getColorScale — measured, the library mis-resolves it", () => {
    // `getColorScale` falls back through `variable.split("_")` prefix matching
    // and finally to temperature, so a canonical `gusts`/`waves` silently
    // returns the °C table. The legend would then advertise colours the wash
    // never paints.
    expect(getColorScale("gusts", false).unit).toBe("°C");
    expect(getColorScale(legendVariable({ ...base, field: "gusts" })!, false).unit).toBe("m/s");
    expect(getColorScale("waves", false).unit).toBe("°C");
    expect(getColorScale(legendVariable({ ...base, field: "waves" })!, false).unit).toBe("m");
  });
});

describe("legendModel", () => {
  it("returns null for an off field", () => {
    expect(legendModel({ ...base, field: "off" }, "ms", false)).toBeNull();
  });

  it("resolves colours from getColorScale for the keyed variable", () => {
    const w = { ...base, field: "gusts" };
    const scale = getColorScale("wind_gusts_10m", false);
    const model = legendModel(w, "ms", false)!;
    expect(model).not.toBeNull();
    expect(model.unit).toBe(scale.unit); // "m/s"
    // A breakpoint scale contributes one gradient stop per breakpoint.
    if (scale.type === "breakpoint") {
      expect(model.gradient.length).toBe(scale.breakpoints.length);
    }
    // First gradient colour matches the scale's first colour.
    const c0 = scale.colors[0];
    expect(model.gradient[0].css).toBe(`rgba(${c0[0]},${c0[1]},${c0[2]},${c0[3]})`);
  });

  it("thins a many-band key to at most maxStops, keeping the extremes", () => {
    const w = { ...base, field: "gusts" }; // 23 breakpoints
    const scale = getColorScale("wind_gusts_10m", false);
    const model = legendModel(w, "ms", false)!;
    // The gradient stays FULL (every band feeds the smooth ramp)…
    if (scale.type === "breakpoint") {
      expect(model.gradient.length).toBe(scale.breakpoints.length);
      expect(model.gradient.length).toBeGreaterThan(7);
    }
    // …but the labels are thinned so the compact ramp is readable.
    expect(model.stops.length).toBeLessThanOrEqual(7);
    // Endpoints are the scale extremes (stops ordered max→min).
    expect(model.stops[0].frac).toBeCloseTo(1, 6);
    expect(model.stops[model.stops.length - 1].frac).toBeCloseTo(0, 6);
  });

  it("honours a custom maxStops", () => {
    const w = { ...base, field: "gusts" };
    expect(legendModel(w, "ms", false, 5, 4)!.stops.length).toBe(4);
  });

  it("converts wind-like units to knots and back", () => {
    const w = { ...base, field: "wind" };
    const ms = legendModel(w, "ms", false)!;
    const kn = legendModel(w, "kn", false)!;
    expect(ms.unit).toBe("m/s");
    expect(kn.unit).toBe("kn");
    // Stops are ordered top→bottom (max first), so stops[0] is the top label.
    // The top label in knots exceeds the same in m/s (1 m/s ≈ 1.94 kn).
    const msTop = Number(ms.stops[0].label);
    const knTop = Number(kn.stops[0].label);
    expect(knTop).toBeGreaterThan(msTop);
  });

  it("does NOT knot-convert a non-wind field's unit", () => {
    const p = legendModel({ ...base, field: "pressure" }, "kn", false)!;
    expect(p.unit).toBe("hPa");
  });

  it("thins the discrete BANDS like the stops, keeping the extremes", () => {
    const w = { ...base, field: "gusts" }; // ~22-band breakpoint scale
    const scale = getColorScale("wind_gusts_10m", false);
    if (scale.type !== "breakpoint") return;
    const full = legendModel(w, "ms", false, 5, 7, scale.breakpoints.length)!;
    const thinned = legendModel(w, "ms", false)!; // default maxBands = 7
    // Unthinned lists every band; the default thins it so the legend fits a short
    // helm screen instead of turning into a scroll box.
    expect(full.bands.length).toBe(scale.breakpoints.length);
    expect(thinned.bands.length).toBeLessThanOrEqual(7);
    expect(thinned.bands.length).toBeLessThan(full.bands.length);
    // Extremes preserved (first + last band survive the thinning).
    expect(thinned.bands[0].label).toBe(full.bands[0].label);
    expect(thinned.bands.at(-1)!.label).toBe(full.bands.at(-1)!.label);
  });

  it("keys the DARK colour scale when dark is set (same as the wash)", () => {
    const w = { ...base, field: "gusts" };
    const darkScale = getColorScale("wind_gusts_10m", true);
    const model = legendModel(w, "ms", true)!;
    const c0 = darkScale.colors[0];
    expect(model.gradient[0].css).toBe(`rgba(${c0[0]},${c0[1]},${c0[2]},${c0[3]})`);
  });
});
