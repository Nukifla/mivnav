// The swipe-up intent — pure, so the threshold + axis-lock that open the
// dashboard and route drawers are pinned without a finger on the glass.

import { describe, expect, test } from "bun:test";
import { swipeUpIntent, SWIPE_OPEN_PX } from "./swipeUp";
import { DRAG_SLOP_PX } from "../gesture";

describe("swipeUpIntent", () => {
  test("undecided while within the drag slop", () => {
    expect(swipeUpIntent(0, 0)).toBeNull();
    expect(swipeUpIntent(DRAG_SLOP_PX - 1, -(DRAG_SLOP_PX - 1))).toBeNull();
  });

  test("undecided when moving up but short of the open threshold", () => {
    // Past slop (so the axis is committed to vertical) but not yet the open pull.
    expect(swipeUpIntent(0, -(SWIPE_OPEN_PX - 1))).toBeNull();
  });

  test("opens once an upward drag clears the threshold", () => {
    expect(swipeUpIntent(0, -SWIPE_OPEN_PX)).toBe("open");
    expect(swipeUpIntent(2, -(SWIPE_OPEN_PX + 20))).toBe("open");
  });

  test("aborts on a downward drag past slop — never the open pull", () => {
    expect(swipeUpIntent(0, SWIPE_OPEN_PX + 20)).toBe("abort");
  });

  test("aborts on a horizontal drag — a pan/scroll, not a pull", () => {
    // Horizontal dominates: even a large upward-ish component that is smaller
    // than the horizontal one is not a pull.
    expect(swipeUpIntent(SWIPE_OPEN_PX + 40, -10)).toBe("abort");
  });

  test("a steep diagonal up (vertical dominant) still opens", () => {
    expect(swipeUpIntent(5, -(SWIPE_OPEN_PX + 5))).toBe("open");
  });

  test("honours a custom open distance", () => {
    expect(swipeUpIntent(0, -12, 10)).toBe("open");
    expect(swipeUpIntent(0, -8, 10)).toBeNull();
  });
});
