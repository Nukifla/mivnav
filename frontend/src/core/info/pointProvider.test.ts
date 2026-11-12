// The bare-coordinate fallback: the position format, and that the synthetic hit
// carries the tapped point so "Go here" and the marker have something to aim at.

import { describe, expect, test } from "bun:test";
import { createPointInfoProvider, formatPosition, POINT_PROVIDER_ID, pointHit } from "./pointProvider";

describe("formatPosition", () => {
  test("degrees and decimal minutes, hemispheres, three-digit longitude", () => {
    expect(formatPosition({ lat: 56.5, lng: 12.5 })).toBe("56°30.000′N 012°30.000′E");
  });

  test("south and west", () => {
    expect(formatPosition({ lat: -33.75, lng: -18.25 })).toBe("33°45.000′S 018°15.000′W");
  });

  // Regression: minutes that round up to 60.000 at 3dp must roll into the next
  // whole degree, not print the impossible "60.000′". `coordinate.ts` and
  // `vesselProvider.ts`'s DDM formatters both carry this guard; this copy was
  // missing it (see `degreesDecimalMinutes` in ../coordinate.ts).
  test("minutes rollover: 59.9997' rounds up into the next degree, not to 60.000'", () => {
    expect(formatPosition({ lat: 55.999995, lng: 12.999995 })).toBe("56°00.000′N 013°00.000′E");
  });
});

describe("pointHit", () => {
  test("a context-priority point at the tapped spot, owned by the point provider", () => {
    const hit = pointHit({ lat: 1, lng: 2 });
    expect(hit.providerId).toBe(POINT_PROVIDER_ID);
    expect(hit.priority).toBe("context");
    expect(hit.lngLat).toEqual({ lat: 1, lng: 2 });
    expect(hit.title).toBe("This location");
  });
});

describe("createPointInfoProvider", () => {
  test("never volunteers a hit — the seam synthesizes the fallback", () => {
    const p = createPointInfoProvider();
    expect(p.queryAt({ point: { x: 0, y: 0 }, lngLat: { lat: 0, lng: 0 }, radius: 8 })).toEqual([]);
  });

  test("resolves its synthetic hit to a position row, offered for copying", async () => {
    const p = createPointInfoProvider();
    const detail = await p.detail(pointHit({ lat: 56.5, lng: 12.5 }));
    expect(detail.sections[0].rows[0]).toEqual({
      label: "Position",
      value: "56°30.000′N 012°30.000′E",
      // `copy` is what the panel puts on the clipboard — the coordinate exactly
      // as shown, so what is pasted is what was read on screen.
      copy: "56°30.000′N 012°30.000′E",
    });
  });

  test("a hit with no position at all offers no copy — an em-dash is not one", async () => {
    const p = createPointInfoProvider();
    const detail = await p.detail({
      providerId: POINT_PROVIDER_ID,
      id: "here",
      priority: "context",
      precision: "point",
      title: "This location",
    });
    expect(detail.sections[0].rows[0]).toEqual({ label: "Position", value: "—" });
  });
});
