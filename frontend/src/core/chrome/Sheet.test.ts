/**
 * The Sheet's PURE parts — the only thing this harness can reach: rendering the
 * component needs a DOM (see MapView.test.ts for the seam that trick costs), so
 * the rendered feel — the drag-vs-scroll handoff, the detent snap, the modal
 * overlay dim — is browser-verified, not here. What IS here: the shape/modality
 * map, the MEASURED chart-coverage arithmetic (`obscuredFromRects`, the pure core
 * of `measureObscured`), and the detent-offset resolution (which declaration
 * turns into which snap offsets, and where the sheet opens).
 */

import { describe, expect, test } from "bun:test";
import {
  hasPeek,
  lowestSnap,
  obscuredFromRects,
  phoneModalShape,
  sheetLayout,
  sheetSnaps,
  SHEET_MAX_FRACTION,
  SHEET_Z,
} from "./Sheet";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isPointShown, visibleCentre } from "../info/marker";

describe("sheetLayout", () => {
  test("the phone's bottom sheet is modal: it covers the chart", () => {
    const layout = sheetLayout("bottom");
    expect(layout.modal).toBe(true);
    expect(layout.contentClass).toContain("bottom-0");
    expect(layout.contentClass).toContain("inset-x-0");
    // Never vh: browser chrome would push the sheet's scroll container off.
    expect(layout.contentClass).toContain("dvh");
  });

  test("an edge drawer is not modal: the chart behind it stays readable", () => {
    for (const side of ["left", "right"] as const) {
      const layout = sheetLayout(side);
      expect(layout.modal).toBe(false);
      // Full height, hung off its own edge.
      expect(layout.contentClass).toContain("inset-y-0");
      expect(layout.contentClass).toContain(`${side}-0`);
      // Bounded on a narrow window, so it can never be the whole screen.
      expect(layout.contentClass).toContain("max-w-[85vw]");
    }
  });

  test("the sheet's height is stated twice and the two agree", () => {
    // Tailwind needs the arbitrary value as a literal and cannot read the
    // constant, so this is the join. The chart reads the constant to decide
    // what the sheet is hiding (../info/marker.ts); if they drift, it dodges
    // the wrong strip and the POI goes back under the sheet.
    const pct = `${SHEET_MAX_FRACTION * 100}dvh`;
    expect(sheetLayout("bottom").contentClass).toContain(`max-h-[${pct}]`);
  });
});

describe("phoneModalShape — phone modal: bottom drawer vs full-screen", () => {
  test("default is the read-and-dismiss bottom sheet (chart peeks above)", () => {
    const shape = phoneModalShape(false);
    expect(shape).toBe(sheetLayout("bottom").contentClass);
    // Docked to the floor, capped below full, rounded top.
    expect(shape).toContain("bottom-0");
    expect(shape).toContain("dvh");
    expect(shape).not.toContain("inset-0");
  });

  test("a detent'd modal sheet (dashboard) is a HARD height, not the content cap", () => {
    // Fixed-height swaps the content-driven `max-h-[85dvh]` cap for `h-[85dvh]`
    // so the board's declared detent is a fraction of a stable height and it
    // stops sizing to its widget count.
    const shape = phoneModalShape(false, true);
    expect(shape).toContain(`h-[${SHEET_MAX_FRACTION * 100}dvh]`);
    expect(shape).not.toContain("max-h-");
    // Still the docked, rounded bottom drawer — only the height rule changed.
    expect(shape).toContain("bottom-0");
    expect(shape).toContain("rounded-t");
    // Fullscreen ignores it (already inset-0, no cap to swap).
    expect(phoneModalShape(true, true)).toBe(phoneModalShape(true));
  });

  test("fullscreen fills the viewport: every edge pinned, no cap, no rounded floor", () => {
    const shape = phoneModalShape(true);
    // inset-0 is full width AND full height — no chart peek, so no tap-outside.
    expect(shape).toContain("inset-0");
    // Not a capped bottom drawer.
    expect(shape).not.toContain("max-h-");
    expect(shape).not.toContain("rounded-t");
    // Header clears the notch.
    expect(shape).toContain("safe-area-inset-top");
  });
});

describe("obscuredFromRects — the MEASURED coverage", () => {
  // A phone container filling the viewport top-to-bottom, upright.
  const container = { top: 0, bottom: 844, clientHeight: 844 };

  test("desktop covers nothing — the info panel is a corner card", () => {
    expect(obscuredFromRects({ compact: false, container, sheet: { top: 300 } })).toEqual({
      bottom: 0,
    });
  });

  test("a closed sheet (no [data-sheet-panel]) and no band cover nothing", () => {
    expect(obscuredFromRects({ compact: true, container })).toEqual({ bottom: 0, top: 0 });
  });

  test("the sheet's bottom is its REAL box: container bottom minus sheet top", () => {
    // The whole point of measuring: a sheet resting at 500 covers 344px, whatever
    // fraction of the viewport that happens to be — not a guessed 85dvh (717) nor
    // a guessed 0.5 peek (422).
    const o = obscuredFromRects({ compact: true, container, sheet: { top: 500 } });
    expect(o.bottom).toBe(344);
    expect(o.top).toBe(0);
    // Drag it taller (top rises) and the coverage grows to match — no drift.
    expect(obscuredFromRects({ compact: true, container, sheet: { top: 200 } }).bottom).toBe(644);
  });

  test("bottom is clamped to [0, container height]", () => {
    // A sheet whose top is below the container's bottom edge covers nothing.
    expect(obscuredFromRects({ compact: true, container, sheet: { top: 900 } }).bottom).toBe(0);
    // One whose top is above the container is clamped to the full height.
    expect(obscuredFromRects({ compact: true, container, sheet: { top: -100 } }).bottom).toBe(844);
  });

  test("the nav band's coverage is band-bottom minus container-top", () => {
    // The container may itself be inset from the top of the window; the band's
    // coverage is measured relative to the container, not the window.
    const inset = { top: 40, bottom: 844, clientHeight: 804 };
    expect(obscuredFromRects({ compact: true, container: inset, navBand: { bottom: 130 } }).top).toBe(
      90,
    );
    // A band above the container top (impossible in practice) floors at 0.
    expect(obscuredFromRects({ compact: true, container, navBand: { bottom: -5 } }).top).toBe(0);
  });

  test("visibleCentre over the measured coverage lands inside the visible strip", () => {
    // The property all three cursors rely on: the strip centre computed from the
    // measured obscured is somewhere `isPointShown` agrees is shown, so a cursor
    // placed there is never warped away.
    const o = obscuredFromRects({
      compact: true,
      container,
      navBand: { bottom: 90 },
      sheet: { top: 500 },
    });
    const size = { clientWidth: 390, clientHeight: 844 };
    const c = visibleCentre(size, o);
    expect(isPointShown({ x: c.x, y: c.y }, size, o)).toBe(true);
    // And it is genuinely between the band and the sheet, not under either.
    expect(c.y).toBeGreaterThan(o.top!);
    expect(c.y).toBeLessThan(size.clientHeight - o.bottom);
  });
});

describe("sheetSnaps — the detent declaration → offsets", () => {
  test("a single fully-open detent, however declared, is offset 0", () => {
    // [1] fraction and the no-detents/no-peek default are the same sheet.
    expect(sheetSnaps({ detents: [1], sheetHeight: 600, peekHeight: 0, hasPeek: false })).toEqual([
      0,
    ]);
    expect(sheetSnaps({ sheetHeight: 600, peekHeight: 0, hasPeek: false })).toEqual([0]);
  });

  test("explicit fractions become px offsets of the measured height, ascending", () => {
    // The fork-5 info sheet: 0.5 peek + full, off an 800px sheet → [full, peek].
    expect(sheetSnaps({ detents: [0.5, 1], sheetHeight: 800, peekHeight: 0, hasPeek: true })).toEqual(
      [0, 400],
    );
  });

  test("a peek slot with no explicit detents derives a measured [full, peek]", () => {
    // Weather: the peek offset is how much sheet sits BELOW the peek region.
    expect(sheetSnaps({ sheetHeight: 500, peekHeight: 120, hasPeek: true })).toEqual([0, 380]);
  });

  test("a peek as tall as the sheet collapses to a single detent (no half-state)", () => {
    expect(sheetSnaps({ sheetHeight: 200, peekHeight: 200, hasPeek: true })).toEqual([0]);
    // ...and never a negative offset if the peek is (transiently) over-measured.
    expect(sheetSnaps({ sheetHeight: 200, peekHeight: 260, hasPeek: true })).toEqual([0]);
  });
});

describe("hasPeek — presence WITHOUT realizing the peek (#RT-PEEK)", () => {
  test("no peek thunk is no peek", () => {
    expect(hasPeek(undefined)).toBe(false);
  });

  test("detects a peek by REFERENCE — it never invokes the thunk", () => {
    // The whole point of the `() => JSX.Element` thunk: deciding a peek exists
    // (measured-detent branch, ResizeObserver wiring) must NOT run the render
    // body, or it would instantiate the peek's reactive computations — the leak
    // that, during enter-measurement, landed them outside any createRoot. A
    // thunk that throws when called proves presence detection realizes nothing.
    let invoked = false;
    const peek = (): never => {
      invoked = true;
      throw new Error("peek thunk must not run during presence detection");
    };
    expect(hasPeek(peek)).toBe(true);
    expect(invoked).toBe(false);
  });
});

describe("lowestSnap — where the sheet opens / floors", () => {
  test("is the largest offset (the peek), so multi-detent sheets open showing the chart", () => {
    expect(lowestSnap([0, 400])).toBe(400);
    expect(lowestSnap([0, 200, 500])).toBe(500);
  });

  test("a single-detent sheet opens fully (offset 0)", () => {
    expect(lowestSnap([0])).toBe(0);
  });

  test("an empty set pins to fully-open", () => {
    expect(lowestSnap([])).toBe(0);
  });
});

describe("popover stacking vs the modal sheet (#BOARD-PHONE)", () => {
  test("the popover rung sits above the modal sheet", () => {
    expect(SHEET_Z.popover).toBeGreaterThan(SHEET_Z.modal);
    expect(SHEET_Z.popover).toBeLessThan(SHEET_Z.lightbox);
  });

  // The dashboard's add/edit popovers once carried `z-30` and painted BEHIND
  // the z-45 phone board sheet — so tapping one closed it and adding a widget
  // on a phone was impossible. Any Kobalte overlay content, anywhere, must
  // clear the modal rung.
  test("no overlay Content in src carries a z-index below the modal sheet", () => {
    const root = join(import.meta.dir, "..", "..");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".tsx")) files.push(p);
      }
    };
    walk(root);
    const offenders: string[] = [];
    const re = /<(Popover|DropdownMenu|Select|Combobox|HoverCard|Tooltip)\.Content[\s\S]*?>/g;
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(re)) {
        // Comments inside the tag may NAME z values (ColorPicker's does).
        const tag = m[0].replace(/\/\/.*$/gm, "");
        for (const z of tag.matchAll(/\bz-(\d+)\b|\bz-\[(\d+)\]/g)) {
          const n = Number(z[1] ?? z[2]);
          if (n < SHEET_Z.popover) offenders.push(`${f}: ${z[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
