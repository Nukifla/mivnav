// The pure rules behind the photo lightbox (./Lightbox.tsx): index wrap and
// clamp, what a released drag means, what a key does.

import { describe, expect, test } from "bun:test";
import {
  clampIndex,
  isDrag,
  LIGHTBOX_SWIPE_PX,
  lightboxKey,
  positionLabel,
  swipeStep,
  swipeThreshold,
  wrapIndex,
} from "./lightboxNav";

describe("wrapIndex", () => {
  test("next on the last photo lands on the first, prev on the first on the last", () => {
    expect(wrapIndex(5, 5)).toBe(0);
    expect(wrapIndex(-1, 5)).toBe(4);
    expect(wrapIndex(2, 5)).toBe(2);
    expect(wrapIndex(11, 5)).toBe(1);
  });

  test("a single photo always stays on itself; an empty set is 0", () => {
    expect(wrapIndex(1, 1)).toBe(0);
    expect(wrapIndex(-1, 1)).toBe(0);
    expect(wrapIndex(3, 0)).toBe(0);
    expect(wrapIndex(Number.NaN, 4)).toBe(0);
  });
});

describe("clampIndex", () => {
  test("a stale start index opens the nearest real photo, never out of range", () => {
    expect(clampIndex(7, 3)).toBe(2);
    expect(clampIndex(-2, 3)).toBe(0);
    expect(clampIndex(1, 3)).toBe(1);
    expect(clampIndex(0, 0)).toBe(0);
  });
});

describe("swipeStep", () => {
  test("a leftward drag past the threshold goes NEXT, rightward goes PREVIOUS", () => {
    expect(swipeStep(-80, 5)).toBe(1);
    expect(swipeStep(80, -5)).toBe(-1);
  });

  test("a short drag springs back", () => {
    expect(swipeStep(-(LIGHTBOX_SWIPE_PX - 1), 0)).toBe(0);
    expect(swipeStep(LIGHTBOX_SWIPE_PX - 1, 0)).toBe(0);
    expect(swipeStep(-LIGHTBOX_SWIPE_PX, 0)).toBe(1);
  });

  test("a mostly-vertical drag never pages, however long", () => {
    expect(swipeStep(-100, 200)).toBe(0);
    expect(swipeStep(100, -100)).toBe(0); // a perfect diagonal isn't horizontal
  });

  test("the threshold is the SMALLER of the floor and a fifth of the stage", () => {
    expect(swipeThreshold(0)).toBe(LIGHTBOX_SWIPE_PX);
    expect(swipeThreshold(1000)).toBe(LIGHTBOX_SWIPE_PX);
    expect(swipeThreshold(200)).toBe(40);
    // On a 200px stage a 42px flick pages; with no width known it doesn't.
    expect(swipeStep(-42, 0, 200)).toBe(1);
    expect(swipeStep(-42, 0)).toBe(0);
  });
});

describe("isDrag", () => {
  test("sub-slop travel is a tap (backdrop tap closes); past it the click ends a drag", () => {
    expect(isDrag(2, 3)).toBe(false);
    expect(isDrag(-30, 0)).toBe(true);
    expect(isDrag(0, 12)).toBe(true);
  });
});

describe("lightboxKey", () => {
  test("arrows page, Escape closes, anything else is not ours", () => {
    expect(lightboxKey("ArrowRight")).toBe(1);
    expect(lightboxKey("ArrowLeft")).toBe(-1);
    expect(lightboxKey("Escape")).toBe("close");
    expect(lightboxKey("ArrowUp")).toBeUndefined();
    expect(lightboxKey("a")).toBeUndefined();
  });
});

describe("positionLabel", () => {
  test("1-based n / N", () => {
    expect(positionLabel(0, 5)).toBe("1 / 5");
    expect(positionLabel(4, 5)).toBe("5 / 5");
  });
});
