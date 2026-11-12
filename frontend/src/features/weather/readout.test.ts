import { describe, expect, it } from "bun:test";
import type { PointWeather } from "./point";
import { readoutParts, type SubPart } from "./readout";

const pw: PointWeather = {
  speedMs: 12.4,
  gustMs: 18,
  dirDeg: 225, // from SW
  cardinal: "SW",
  validUnix: 0,
  pressureHpa: 1013,
  tempC: 18.6,
  visibilityM: 24000,
};

const text = (parts: SubPart[]) => parts.map((p) => p.text).join("");
const strong = (parts: SubPart[]) => parts.filter((p) => p.strong).map((p) => p.text);

describe("readoutParts", () => {
  it("splits the wind value from its (toggling) unit", () => {
    const r = readoutParts(pw, "wind", "ms");
    expect(r.value).toBe("12"); // rounded like formatWindSpeed, so all readouts agree
    expect(r.unit).toBe("m/s");
    expect(r.unitToggles).toBe(true);
    expect(r.dirDeg).toBe(225);
  });

  it("formats the wind value in knots when the app unit is knots", () => {
    const r = readoutParts(pw, "wind", "kn");
    expect(r.unit).toBe("kn");
    expect(r.value).toBe(String(Math.round(12.4 * 1.94384)));
  });

  it("bolds the cardinal and the gust in the wind sub line", () => {
    const r = readoutParts(pw, "wind", "ms");
    expect(text(r.sub)).toContain("from SW");
    expect(text(r.sub)).toContain("gusts 18");
    expect(strong(r.sub)).toContain("SW");
    expect(strong(r.sub)).toContain("18");
  });

  it("uses gusts as the headline for the gusts field, still toggling unit", () => {
    const r = readoutParts(pw, "gusts", "ms");
    expect(r.value).toBe("18");
    expect(r.unit).toBe("m/s");
    expect(r.unitToggles).toBe(true);
  });

  it("uses native, non-toggling units for scalar fields", () => {
    expect(readoutParts(pw, "pressure", "ms")).toMatchObject({ value: "1013", unit: "hPa", unitToggles: false });
    expect(readoutParts(pw, "temperature", "ms")).toMatchObject({ value: "19", unit: "°C", unitToggles: false });
    expect(readoutParts(pw, "visibility", "ms")).toMatchObject({ value: "24.0", unit: "km", unitToggles: false });
  });

  it("still exposes the wind bearing for the vane on a scalar field", () => {
    expect(readoutParts(pw, "pressure", "ms").dirDeg).toBe(225);
  });

  it("renders an em dash when the value is missing", () => {
    const r = readoutParts({ ...pw, speedMs: NaN }, "wind", "ms");
    expect(r.value).toBe("—");
  });

  // Waves: the point API carries no wave height, so the value comes from the
  // decoded wash grid (`sampled`). The unit is ALWAYS metres — the readout must
  // never silently print the wind m/s for a metres field (the bug this fixes).
  describe("waves", () => {
    it("formats the grid-sampled wave height in metres, with wind as the sub", () => {
      const r = readoutParts(pw, "waves", "ms", { value: 1.24, direction: 200 });
      expect(r.value).toBe("1.2");
      expect(r.unit).toBe("m");
      expect(r.unitToggles).toBe(false); // metres never toggle
      expect(r.dirDeg).toBe(200); // wave FROM bearing from the grid
      expect(text(r.sub)).toContain("wind"); // wind still shown, labelled
    });

    it("labels metres with a dash (never a wind m/s) when no grid is loaded", () => {
      const r = readoutParts(pw, "waves", "ms");
      expect(r.value).toBe("—");
      expect(r.unit).toBe("m");
      expect(r.unitToggles).toBe(false);
      expect(r.dirDeg).toBe(225); // falls back to the wind bearing for the vane
    });
  });
});
