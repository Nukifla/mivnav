import { describe, expect, test } from "bun:test";
import { convertValue, formatHMM, QUANTITIES, quantityFor, resolveUnit } from "./units";

const conv = (raw: number, si: string, unit?: string, d?: number) => convertValue(raw, si, unit, d);

describe("units: known values", () => {
  test("speed", () => {
    expect(conv(1, "m/s", "kn", 3)).toEqual({ value: "1.944", unit: "kn" });
    expect(conv(10, "m/s", "km/h")).toEqual({ value: "36.0", unit: "km/h" });
    expect(conv(1, "m/s", "mph", 3)).toEqual({ value: "2.237", unit: "mph" });
    expect(conv(5, "m/s", "m/s")).toEqual({ value: "5.0", unit: "m/s" });
  });
  test("angle, incl. a server reporting deg", () => {
    expect(conv(Math.PI, "rad")).toEqual({ value: "180", unit: "°" });
    expect(conv(90, "deg")).toEqual({ value: "90", unit: "°" });
    expect(conv(Math.PI, "rad", "rad")).toEqual({ value: "3.142", unit: "rad" });
  });
  test("temperature °C/°F/K", () => {
    expect(conv(273.15, "K")).toEqual({ value: "0.0", unit: "°C" });
    expect(conv(373.15, "K", "degF")).toEqual({ value: "212.0", unit: "°F" });
    expect(conv(233.15, "K", "degF")).toEqual({ value: "-40.0", unit: "°F" });
    expect(conv(300, "K", "K")).toEqual({ value: "300.0", unit: "K" });
  });
  test("pressure", () => {
    expect(conv(101325, "Pa")).toEqual({ value: "1013", unit: "hPa" });
    expect(conv(101325, "Pa", "inHg")).toEqual({ value: "29.92", unit: "inHg" });
    expect(conv(200000, "Pa", "bar")).toEqual({ value: "2.00", unit: "bar" });
    expect(conv(101325, "Pa", "psi")).toEqual({ value: "14.7", unit: "psi" });
  });
  test("ratio as percent and raw", () => {
    expect(conv(0.756, "ratio")).toEqual({ value: "76", unit: "%" });
    expect(conv(0.756, "ratio", "ratio")).toEqual({ value: "0.76", unit: "" });
  });
  test("length", () => {
    expect(conv(1852, "m", "NM")).toEqual({ value: "1.00", unit: "NM" });
    expect(conv(1.8288, "m", "fathom")).toEqual({ value: "1.0", unit: "fm" });
    expect(conv(3.048, "m", "ft")).toEqual({ value: "10.0", unit: "ft" });
  });
  test("volume and flow", () => {
    expect(conv(0.2, "m3")).toEqual({ value: "200", unit: "L" });
    expect(conv(M3(1), "m3", "usgal")).toEqual({ value: "1.0", unit: "gal" });
    expect(conv(1 / 3.6e6, "m3/s")).toEqual({ value: "1.0", unit: "L/h" });
  });
  test("frequency as rpm", () => {
    expect(conv(30, "Hz")).toEqual({ value: "1800", unit: "rpm" });
  });
  test("time incl. h:mm", () => {
    expect(conv(5400, "s", "h:mm")).toEqual({ value: "1:30", unit: "h" });
    expect(conv(5400, "s", "h")).toEqual({ value: "1.5", unit: "h" });
    expect(formatHMM(3599)).toBe("0:59");
    expect(formatHMM(-3660)).toBe("-1:01");
    expect(formatHMM(36000)).toBe("10:00");
  });
  test("charge, energy, power", () => {
    expect(conv(3600 * 100, "C")).toEqual({ value: "100.0", unit: "Ah" });
    expect(conv(3.6e6, "J", "kWh")).toEqual({ value: "1.00", unit: "kWh" });
    expect(conv(1500, "W", "kW")).toEqual({ value: "1.50", unit: "kW" });
  });
  test("a spec's decimals override the unit hint", () => {
    expect(conv(1, "m/s", "kn", 0)).toEqual({ value: "2", unit: "kn" });
  });
});

function M3(usgal: number): number {
  return usgal * 0.003785411784;
}

describe("units: resolution", () => {
  test("legacy free-text aliases resolve within the quantity", () => {
    for (const t of ["kn", "knots", "KTS", "kt"]) expect(resolveUnit("m/s", t)?.unit.id).toBe("kn");
    expect(resolveUnit("ratio", "%")?.unit.id).toBe("%");
    expect(resolveUnit("K", "°C")?.unit.id).toBe("degC");
    expect(resolveUnit("K", "C")?.unit.id).toBe("degC");
    expect(resolveUnit("C", "C")?.unit.id).toBe("C"); // coulombs on a charge path
    expect(resolveUnit("m", "nm")?.unit.id).toBe("NM");
  });
  test("non-matching text and unknown quantities do not resolve", () => {
    expect(resolveUnit("V", "volts")).toBeUndefined();
    expect(resolveUnit("m/s", "°C")).toBeUndefined();
    expect(resolveUnit(undefined, "kn")).toBeUndefined();
    expect(resolveUnit("furlong/fortnight", undefined)).toBeUndefined();
  });
  test("blank chooses the quantity default", () => {
    expect(resolveUnit("m/s", "")?.unit.id).toBe("kn");
    expect(resolveUnit("m/s", undefined)?.unit.id).toBe("kn");
  });
  test("every quantity's default exists and its native unit is listed", () => {
    for (const q of QUANTITIES) {
      expect(q.units.some((u) => u.id === q.defaultUnit)).toBe(true);
      expect(quantityFor(q.si)?.quantity).toBe(q);
      expect(q.units.some((u) => u.from(7) === 7 && !u.format)).toBe(true);
    }
  });
  test("unit ids are unique within a quantity", () => {
    for (const q of QUANTITIES) expect(new Set(q.units.map((u) => u.id)).size).toBe(q.units.length);
  });
});

describe("units: round-trips", () => {
  test("to(from(x)) ≈ x for every unit", () => {
    for (const q of QUANTITIES)
      for (const u of q.units)
        for (const x of [0, 1, 12.345, -3, 1e5]) expect(u.to(u.from(x))).toBeCloseTo(x, 6);
  });
});
