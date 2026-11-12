import { describe, expect, test } from "bun:test";
import { formatCoordinate, parseCoordinate } from "./coordinate";

/** Parse and assert success, with a small tolerance on the fractional maths. */
function expectCoord(input: string, lat: number, lng: number) {
  const r = parseCoordinate(input);
  if (!r.ok) throw new Error(`expected ${input} to parse, got error: ${r.error}`);
  expect(r.value.lat).toBeCloseTo(lat, 5);
  expect(r.value.lng).toBeCloseTo(lng, 5);
}

describe("decimal degrees", () => {
  test("comma separated", () => expectCoord("55.5, 10.5", 55.5, 10.5));
  test("space separated", () => expectCoord("55.5 10.5", 55.5, 10.5));
  test("semicolon separated", () => expectCoord("55.5; 10.5", 55.5, 10.5));
  test("signed negatives", () => expectCoord("-33.9 18.4", -33.9, 18.4));
  test("explicit plus sign", () => expectCoord("+55.5 +10.5", 55.5, 10.5));
  test("integers", () => expectCoord("55 10", 55, 10));
  test("extra whitespace", () => expectCoord("   55.5   ,   10.5  ", 55.5, 10.5));
  test("tab separated", () => expectCoord("55.5\t10.5", 55.5, 10.5));
});

describe("degrees decimal minutes", () => {
  test("with symbols and hemispheres", () =>
    expectCoord("55°30.5'N 010°30.5'E", 55.508333, 10.508333));
  test("without symbols, hemispheres only", () =>
    expectCoord("55 30.5 N 10 30.5 E", 55.508333, 10.508333));
  test("southern / western hemispheres", () =>
    expectCoord("33°54.0'S 018°25.0'E", -33.9, 18.416667));
  test("typographic prime for minutes", () =>
    expectCoord("55°30.5′N 010°30.5′E", 55.508333, 10.508333));
});

describe("degrees minutes seconds", () => {
  test("with all symbols", () => expectCoord("55°30'30\"N 010°30'30\"E", 55.508333, 10.508333));
  test("doubled apostrophe for seconds", () =>
    expectCoord("55°30'30''N 010°30'30''E", 55.508333, 10.508333));
  test("south west", () => expectCoord("55°30'30\"S 010°30'30\"W", -55.508333, -10.508333));
  test("bare numbers with hemispheres (dms)", () =>
    expectCoord("55 30 30 N 10 30 30 E", 55.508333, 10.508333));
});

describe("lat/lon ordering", () => {
  test("lon first, disambiguated by out-of-lat-range value", () =>
    expectCoord("120.0 40.0", 40.0, 120.0));
  test("lon first via hemisphere letters", () =>
    expectCoord("010°30'E 55°30'N", 55.5, 10.5));
  test("lat first via hemisphere letters", () =>
    expectCoord("55°30'N 010°30'E", 55.5, 10.5));
  test("leading hemisphere letters", () => expectCoord("N55.5 E10.5", 55.5, 10.5));
  test("leading letters, lon first", () => expectCoord("E10.5 N55.5", 55.5, 10.5));
  test("one letter pins the axis, other inferred", () => expectCoord("55.5N 10.5", 55.5, 10.5));
  test("both under 90 keeps conventional lat,lon", () => expectCoord("10.5 55.5", 10.5, 55.5));
  test("negative longitude past 90 is disambiguated", () =>
    expectCoord("40.0 -120.0", 40.0, -120.0));
});

describe("range validation", () => {
  test("latitude above 90 with hemisphere", () => {
    const r = parseCoordinate("95°N 10°E");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Latitude/);
  });
  test("longitude above 180", () => {
    const r = parseCoordinate("55°N 190°E");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Longitude/);
  });
  test("both values above 90, no letters", () => {
    const r = parseCoordinate("120 130");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Latitude/);
  });
  test("minutes at or above 60", () => {
    const r = parseCoordinate("55°60'N 10°E");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Minutes/);
  });
  test("seconds at or above 60", () => {
    const r = parseCoordinate("55°30'60\"N 10°E");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Seconds/);
  });
  test("edge values are accepted", () => {
    expectCoord("90 180", 90, 180);
    expectCoord("-90 -180", -90, -180);
  });
});

describe("rejections", () => {
  const bad: [string, string][] = [
    ["empty", ""],
    ["whitespace only", "   "],
    ["garbage", "hello world"],
    ["half a pair", "55.5"],
    ["single lettered coord", "55.5N"],
    ["stray letter", "55.5x 10.5"],
    ["three bare numbers", "55 10 20"],
    ["four bare numbers (ambiguous)", "55 30 10 30"],
    ["two latitudes", "55N 10N"],
    ["two longitudes", "10E 20E"],
    ["trailing junk after a pair", "55N 10E 5"],
    ["letters but no numbers", "N E"],
  ];
  for (const [name, input] of bad) {
    test(`rejects ${name}`, () => {
      expect(parseCoordinate(input).ok).toBe(false);
    });
  }
});

describe("formatCoordinate", () => {
  test("marine DDM with padded degrees and hemispheres", () => {
    expect(formatCoordinate(55.5, 10.5)).toBe("55°30.0′N 010°30.0′E");
    expect(formatCoordinate(-33.9, 18.4)).toBe("33°54.0′S 018°24.0′E");
    expect(formatCoordinate(0, -179.5)).toBe("00°00.0′N 179°30.0′W");
  });

  test("round-trips through the parser", () => {
    const r = parseCoordinate(formatCoordinate(55.5, 10.5));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.lat).toBeCloseTo(55.5, 4);
      expect(r.value.lng).toBeCloseTo(10.5, 4);
    }
  });

  test("guards the minute-rounding seam (never prints 60.0′)", () => {
    // 30.999′ rounds up to a whole degree rather than 30°60.0′.
    expect(formatCoordinate(30 + 59.999 / 60, 10)).toBe("31°00.0′N 010°00.0′E");
  });
});
