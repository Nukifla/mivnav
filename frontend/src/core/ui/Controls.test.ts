import { describe, expect, test } from "bun:test";
import { scrubDelta, scrubValue } from "../gesture";
import { formatPercent, parsePercent } from "./Controls";

// The ScrubPercent format/parse pair — the only pure surface of the scrub value
// field (its drag/tap/keyboard wiring is DOM and browser-driven, its value maths
// live in gesture.ts's scrubValue/clampStep/scrubDelta, tested there and — for
// scrubDelta — also here, since it's this field's fix for vertical drag). These
// pin the 0–1 ⇄ "NN%" round-trip the opacity control shows and accepts.

describe("formatPercent — 0–1 fraction as a rounded percentage", () => {
  test("scales and rounds so the field width stays stable", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(1)).toBe("100%");
    expect(formatPercent(0.75)).toBe("75%");
    expect(formatPercent(0.734)).toBe("73%"); // rounded, no long decimal
  });
});

describe("parsePercent — typed text back to a 0–1 fraction", () => {
  test("accepts a bare number or a trailing percent sign", () => {
    expect(parsePercent("75")).toBe(0.75);
    expect(parsePercent("75%")).toBe(0.75);
    expect(parsePercent("100")).toBe(1);
  });

  test("non-numeric text cancels (null), so a fat-fingered entry is dropped", () => {
    expect(parsePercent("")).toBeNull();
    expect(parsePercent("abc")).toBeNull();
  });
});

// Regression: ScrubNumber's pointer handler used to compute only
// `dx = clientX - startX` and feed that alone to scrubValue(), so a straight
// up/down drag never moved the value — only isScrubTap() looked at dy, and
// only to decide tap-vs-drag. The fix folds dy into the same single delta via
// scrubDelta() before it reaches scrubValue(), so any direction scrubs.
describe("scrubDelta — folding a 2-D drag into scrubValue's one delta", () => {
  test("horizontal-only drag behaves exactly as before (dy = 0 is a no-op)", () => {
    expect(scrubDelta(50, 0)).toBe(50);
    expect(scrubDelta(-50, 0)).toBe(-50);
  });

  test("vertical-only drag now also moves the value — up raises, down lowers", () => {
    // Previously dx alone was 0 here, so scrubValue never budged.
    expect(scrubValue(0.5, scrubDelta(0, -20), 0, 1, 0.05)).toBeGreaterThan(0.5); // up
    expect(scrubValue(0.5, scrubDelta(0, 20), 0, 1, 0.05)).toBeLessThan(0.5); // down
  });

  test("a full vertical sweep matches the equivalent horizontal one", () => {
    expect(scrubDelta(0, -200)).toBe(scrubDelta(200, 0));
  });

  test("diagonal drags combine both axes rather than picking one", () => {
    expect(scrubDelta(50, -50)).toBe(100); // right + up: both raise, they add
    expect(scrubDelta(50, 50)).toBe(0); // right + down: cancel out
  });
});
