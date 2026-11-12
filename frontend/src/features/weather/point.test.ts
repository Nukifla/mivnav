import { describe, expect, it } from "bun:test";
import {
  cardinal,
  formatWindSpeed,
  pointForecastUrl,
  weatherFromForecast,
  windFromForecast,
  type FullHourly,
} from "./point";

describe("formatWindSpeed", () => {
  it("shows m/s as-is and converts to knots", () => {
    expect(formatWindSpeed(10, "ms")).toBe("10 m/s");
    expect(formatWindSpeed(10, "kn")).toBe("19 kn"); // 10 * 1.94384 ≈ 19.4
    expect(formatWindSpeed(NaN, "ms")).toBe("—");
  });
});

describe("cardinal", () => {
  it("maps bearings to the 16-point compass, wrapping at 360", () => {
    expect(cardinal(0)).toBe("N");
    expect(cardinal(90)).toBe("E");
    expect(cardinal(247.5)).toBe("WSW");
    expect(cardinal(360)).toBe("N");
    expect(cardinal(-22.5)).toBe("NNW");
  });
});

describe("pointForecastUrl", () => {
  it("requests hourly wind in m/s (base unit) as unixtime", () => {
    const url = pointForecastUrl(55.9, 12.6);
    expect(url).toContain("latitude=55.9000");
    expect(url).toContain("longitude=12.6000");
    expect(url).toContain("wind_speed_unit=ms");
    expect(url).toContain("timeformat=unixtime");
    expect(url).toContain("wind_speed_10m");
    expect(url).toContain("wind_gusts_10m");
    expect(url).toContain("wind_direction_10m");
  });
});

describe("windFromForecast", () => {
  const body = {
    hourly: {
      time: [1000, 4600, 8200], // 0, +1h, +2h
      wind_speed_10m: [10, 14, 20],
      wind_direction_10m: [250, 260, 270],
      wind_gusts_10m: [15, 22, 30],
    },
  };

  it("picks the hour nearest the target time", () => {
    const w = windFromForecast(body, 4500); // nearest 4600
    expect(w.speedMs).toBe(14);
    expect(w.gustMs).toBe(22);
    expect(w.dirDeg).toBe(260);
    expect(w.cardinal).toBe("W");
    expect(w.validUnix).toBe(4600);
  });

  it("clamps to the first/last available step", () => {
    expect(windFromForecast(body, 0).validUnix).toBe(1000);
    expect(windFromForecast(body, 999999).validUnix).toBe(8200);
  });

  it("throws when the forecast has no times", () => {
    expect(() => windFromForecast({ hourly: { time: [] } }, 0)).toThrow();
    expect(() => windFromForecast({}, 0)).toThrow();
  });
});

// The scrub re-index: one fetched SERIES, re-picked at different target times
// WITHOUT refetching (mode.ts re-runs this pure pick as `hours` changes). Proves
// the picking is pure over a single body, which is why a scrub needs no network.
describe("weatherFromForecast — re-index over one cached body", () => {
  const body: FullHourly = {
    hourly: {
      time: [1000, 4600, 8200],
      wind_speed_10m: [10, 14, 20],
      wind_direction_10m: [250, 260, 270],
      wind_gusts_10m: [15, 22, 30],
      pressure_msl: [1010, 1008, 1005],
      temperature_2m: [12, 13, 14],
      visibility: [20000, 18000, 15000],
    },
  };

  it("returns a DIFFERENT hour's full readout from the same body per target", () => {
    const now = weatherFromForecast(body, 1000);
    const later = weatherFromForecast(body, 8200);
    expect(now.speedMs).toBe(10);
    expect(now.pressureHpa).toBe(1010);
    expect(later.speedMs).toBe(20);
    expect(later.pressureHpa).toBe(1005);
    expect(later.tempC).toBe(14);
    expect(later.validUnix).toBe(8200);
  });
});
