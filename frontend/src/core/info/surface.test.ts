/**
 * The info surface's PREDICTED coverage and the fit padding built from it —
 * what `openNotice` (features/notices) frames a notice into, so the notice
 * doesn't land under the panel that opens to describe it.
 */

import { describe, expect, test } from "bun:test";
import { SHEET_MAX_FRACTION } from "../chrome/Sheet";
import { DESKTOP_CLASS } from "./InfoPanel";
import {
  fitPadding,
  INFO_CARD_LEFT_PX,
  INFO_CARD_WIDTH_PX,
  INFO_SHEET_PEEK,
  MIN_FIT_PX,
  predictInfoCover,
} from "./surface";

/** A phone, upright, the map filling the viewport. */
const PHONE = { clientWidth: 390, clientHeight: 844 };
const PHONE_BOX = { top: 0, bottom: 844, clientHeight: 844 };

describe("predictInfoCover", () => {
  test("phone: the info sheet's peek covers the bottom, nothing on the sides", () => {
    const c = predictInfoCover({ compact: true, container: PHONE_BOX, viewportHeight: 844 });
    expect(c.bottom).toBeCloseTo(844 * SHEET_MAX_FRACTION * INFO_SHEET_PEEK);
    expect(c.top).toBe(0);
    expect(c.left).toBe(0);
  });

  test("phone: the nav band is excluded on top, like the reveal-warp's measure", () => {
    const c = predictInfoCover({
      compact: true,
      container: PHONE_BOX,
      viewportHeight: 844,
      navBand: { bottom: 72 },
    });
    expect(c.top).toBe(72);
  });

  test("phone: a container that stops above the viewport floor is covered less", () => {
    // A bar below the map: the sheet's lower part covers that bar, not the chart.
    const c = predictInfoCover({
      compact: true,
      container: { top: 0, bottom: 784, clientHeight: 784 },
      viewportHeight: 844,
    });
    expect(c.bottom).toBeCloseTo(844 * SHEET_MAX_FRACTION * INFO_SHEET_PEEK - 60);
  });

  test("desktop: the floating card's column on the left, nothing below", () => {
    const c = predictInfoCover({
      compact: false,
      container: { top: 0, bottom: 900, clientHeight: 900 },
      viewportHeight: 900,
    });
    expect(c).toEqual({ top: 0, bottom: 0, left: INFO_CARD_LEFT_PX + INFO_CARD_WIDTH_PX });
  });

  test("the card's box is stated twice and the two agree", () => {
    // Tailwind needs the literals; `left-3.5` is 0.875rem = 14px.
    expect(DESKTOP_CLASS).toContain("left-3.5");
    expect(INFO_CARD_LEFT_PX).toBe(3.5 * 4);
    expect(DESKTOP_CLASS).toContain(`w-[${INFO_CARD_WIDTH_PX}px]`);
  });
});

describe("fitPadding", () => {
  test("a clear viewport is the plain margin all round (the old fixed 60)", () => {
    expect(fitPadding({ clientWidth: 1200, clientHeight: 800 }, { bottom: 0 }, 60)).toEqual({
      top: 60,
      bottom: 60,
      left: 60,
      right: 60,
    });
  });

  test("phone: the notice is framed in the strip above the sheet", () => {
    const cover = predictInfoCover({ compact: true, container: PHONE_BOX, viewportHeight: 844 });
    const p = fitPadding(PHONE, cover, 60);
    expect(p.top).toBe(60);
    expect(p.bottom).toBeCloseTo(cover.bottom + 60);
    expect(p.left).toBe(60);
    expect(p.right).toBe(60);
    // The framed box ends above where the sheet's top will be.
    expect(PHONE.clientHeight - p.bottom).toBeLessThan(PHONE.clientHeight - cover.bottom);
  });

  test("desktop: the notice is framed to the right of the info card", () => {
    const cover = predictInfoCover({
      compact: false,
      container: { top: 0, bottom: 900, clientHeight: 900 },
      viewportHeight: 900,
    });
    const p = fitPadding({ clientWidth: 1400, clientHeight: 900 }, cover, 60);
    expect(p.left).toBe(INFO_CARD_LEFT_PX + INFO_CARD_WIDTH_PX + 60);
    expect(p.right).toBe(60);
    expect(p.top).toBe(60);
    expect(p.bottom).toBe(60);
  });

  test("never pads away the whole canvas — MapLibre would refuse the fit", () => {
    // Landscape phone: 390 tall, the sheet's peek alone is ~166.
    const size = { clientWidth: 844, clientHeight: 390 };
    const cover = predictInfoCover({
      compact: true,
      container: { top: 0, bottom: 390, clientHeight: 390 },
      viewportHeight: 390,
      navBand: { bottom: 150 },
    });
    const p = fitPadding(size, cover, 60);
    expect(size.clientHeight - p.top - p.bottom).toBeGreaterThanOrEqual(MIN_FIT_PX - 1e-9);
    // Squeezed proportionally: the sheet side still gets the larger share.
    expect(p.bottom).toBeGreaterThan(p.top);
    // A too-narrow window keeps a box too.
    const narrow = fitPadding({ clientWidth: 300, clientHeight: 600 }, { bottom: 0, left: 272 }, 60);
    expect(300 - narrow.left - narrow.right).toBeGreaterThanOrEqual(MIN_FIT_PX - 1e-9);
  });

  test("a negative or missing coverage is treated as none", () => {
    expect(fitPadding({ clientWidth: 500, clientHeight: 500 }, { bottom: -10, top: -5 }, 20)).toEqual({
      top: 20,
      bottom: 20,
      left: 20,
      right: 20,
    });
  });
});
