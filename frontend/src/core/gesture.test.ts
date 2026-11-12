/**
 * The sheet-drag DECISIONS — the pure physics behind the bottom drawer. The
 * wiring (createSheetDrag) needs touch events and a DOM, so it is driven in a
 * real browser (experiments), not here; these lock the maths it defers to:
 * velocity → dismiss, snap resolution, and the rubber-band clamp.
 */
import { describe, expect, test } from "bun:test";
import { createRoot, createSignal, type Accessor } from "solid-js";
import {
  canScrollX,
  clampIndex,
  clampStep,
  createPagerDrag,
  createScrubSelect,
  createVelocityTracker,
  isScrubTap,
  lockAxis,
  nearestIndex,
  overdragOffset,
  pagerLandingIndex,
  resolveSnap,
  rubberBand,
  scrubValue,
  slideIndexFromScroll,
  DRAG_SLOP_PX,
  SCRUB_TAP_SLOP_PX,
  snapOffsets,
  DISMISS_DISTANCE_PX,
  PAGER_SCROLL_X_ATTR,
  SNAP_MOMENTUM_MS,
  type SheetDrag,
  type TouchHandlers,
} from "./gesture";

describe("snapOffsets", () => {
  test("fractions become ascending px offsets off the measured height", () => {
    // 1 = fully open (offset 0), 0.5 = half showing (offset = half the height).
    expect(snapOffsets([1], 400)).toEqual([0]);
    expect(snapOffsets([0.5, 1], 400)).toEqual([0, 200]);
    // Order of the input does not matter — always ascending (fully-open first).
    expect(snapOffsets([1, 0.5], 400)).toEqual([0, 200]);
  });

  test("derives off the given height, so the 85dvh cap is respected for free", () => {
    // A shorter sheet just yields smaller offsets; nothing here restates a cap.
    expect(snapOffsets([0.5, 1], 200)).toEqual([0, 100]);
  });
});

describe("rubberBand", () => {
  test("no resistance below zero overdrag", () => {
    expect(rubberBand(0)).toBe(0);
    expect(rubberBand(-40)).toBe(0);
  });

  test("small overdrags feel near 1:1, large ones fall away", () => {
    // At scale, exactly half of scale.
    expect(rubberBand(160, 160)).toBeCloseTo(80);
    // A tiny pull is barely damped…
    expect(rubberBand(10, 160)).toBeGreaterThan(9);
    // …and the response never reaches, but approaches, `scale`.
    expect(rubberBand(100000, 160)).toBeLessThan(160);
    expect(rubberBand(100000, 160)).toBeGreaterThan(159);
  });

  test("monotonic and always less than the raw overdrag", () => {
    let prev = 0;
    for (let x = 1; x <= 400; x += 7) {
      const y = rubberBand(x, 160);
      expect(y).toBeGreaterThan(prev);
      expect(y).toBeLessThan(x);
      prev = y;
    }
  });
});

describe("overdragOffset — tracking below rest, resist-or-clamp above open", () => {
  test("at or below rest it tracks the finger 1:1, either way", () => {
    expect(overdragOffset(0, true)).toBe(0);
    expect(overdragOffset(40, true)).toBe(40);
    expect(overdragOffset(40, false)).toBe(40);
  });

  test("above fully-open (raw < 0) it rubber-bands when overdrag is allowed", () => {
    // A resisted lift: same magnitude as rubberBand, negative (upward).
    expect(overdragOffset(-40, true)).toBeCloseTo(-rubberBand(40));
    expect(overdragOffset(-40, true)).toBeLessThan(0);
  });

  test("above fully-open it HARD-CLAMPS to the ceiling when overdrag is off", () => {
    // The route-sheet floor: no lift off bottom-0, so no rail shows through.
    expect(overdragOffset(-40, false)).toBe(0);
    expect(overdragOffset(-1, false)).toBe(0);
  });
});

describe("resolveSnap — single snap (dismiss or spring back)", () => {
  const snaps = [0]; // one detent: fully open

  test("a small, slow pull springs back", () => {
    const r = resolveSnap(20, 0, snaps);
    expect(r.dismiss).toBe(false);
    expect(r.offset).toBe(0);
  });

  test("a long slow pull past the dismiss line dismisses (distance)", () => {
    expect(resolveSnap(DISMISS_DISTANCE_PX + 10, 0, snaps).dismiss).toBe(true);
  });

  test("a fast flick dismisses from near rest (velocity, not distance)", () => {
    // 20px in, but heading down fast enough to project past the line.
    const velocity = (DISMISS_DISTANCE_PX + 40) / SNAP_MOMENTUM_MS; // clears it via projection
    expect(resolveSnap(20, velocity, snaps).dismiss).toBe(true);
  });

  test("a fast flick UPWARD never dismisses, however far down it started", () => {
    expect(resolveSnap(DISMISS_DISTANCE_PX + 5, -2, snaps).dismiss).toBe(false);
  });
});

describe("resolveSnap — two snaps (velocity carries between detents)", () => {
  // 400px sheet, half + full → offsets [0, 200]; dismiss below ~256.
  const snaps = snapOffsets([0.5, 1], 400);

  test("released near a detent settles to the nearest one", () => {
    expect(resolveSnap(30, 0, snaps).offset).toBe(0); // near full-open
    expect(resolveSnap(180, 0, snaps).offset).toBe(200); // near half
  });

  test("a downward flick from full carries to the half detent, not dismiss", () => {
    // From near-open, project toward ~half but not past the dismiss line.
    const r = resolveSnap(60, 120 / SNAP_MOMENTUM_MS, snaps);
    expect(r.dismiss).toBe(false);
    expect(r.offset).toBe(200);
  });

  test("an upward flick from the half detent carries back to full-open", () => {
    const r = resolveSnap(180, -150 / SNAP_MOMENTUM_MS, snaps);
    expect(r.dismiss).toBe(false);
    expect(r.offset).toBe(0);
  });

  test("dragging well past the lowest detent still dismisses", () => {
    expect(resolveSnap(200 + DISMISS_DISTANCE_PX + 5, 0, snaps).dismiss).toBe(true);
  });
});

describe("clampIndex", () => {
  test("pins into range, and an empty set to 0", () => {
    expect(clampIndex(-1, 5)).toBe(0);
    expect(clampIndex(2, 5)).toBe(2);
    expect(clampIndex(9, 5)).toBe(4);
    expect(clampIndex(3, 0)).toBe(0);
  });
});

describe("clampStep — snap to grid + clamp", () => {
  test("snaps to the step grid anchored at min", () => {
    expect(clampStep(0.73, 0, 1, 0.05)).toBe(0.75);
    expect(clampStep(0.72, 0, 1, 0.05)).toBe(0.7);
  });

  test("clamps into [min,max]", () => {
    expect(clampStep(1.4, 0, 1, 0.05)).toBe(1);
    expect(clampStep(-0.3, 0, 1, 0.05)).toBe(0);
  });

  test("kills binary-float drift (0.05 is not exact)", () => {
    // 15 * 0.05 = 0.7500000000000001 without the final round.
    expect(clampStep(0.75, 0, 1, 0.05)).toBe(0.75);
    expect(clampStep(0.6, 0, 1, 0.05)).toBe(0.6);
  });

  test("step <= 0 is continuous — clamp only, no snap", () => {
    expect(clampStep(0.731, 0, 1, 0)).toBe(0.731);
    expect(clampStep(2, 0, 1, 0)).toBe(1);
  });
});

describe("scrubValue — the value a horizontal drag lands on", () => {
  // Default travel is 200px for a 0→1 range, so 2px per 1%.
  test("no travel holds the start value", () => {
    expect(scrubValue(0.5, 0, 0, 1, 0.05)).toBe(0.5);
  });

  test("dragging right raises, left lowers — 200px sweeps the whole range", () => {
    expect(scrubValue(0, 200, 0, 1, 0.05)).toBe(1); // full sweep right
    expect(scrubValue(1, -200, 0, 1, 0.05)).toBe(0); // full sweep left
    expect(scrubValue(0, 100, 0, 1, 0.05)).toBe(0.5); // half sweep = 50%
  });

  test("no jump on grab — delta is added to the snapshotted start", () => {
    // +20px from 0.5 = +10% → 0.6, not an absolute remap of the position.
    expect(scrubValue(0.5, 20, 0, 1, 0.05)).toBe(0.6);
  });

  test("snaps to step and clamps at the ends", () => {
    expect(scrubValue(0.5, 7, 0, 1, 0.05)).toBe(0.55); // 3.5% → nearest 5% step
    expect(scrubValue(0.9, 400, 0, 1, 0.05)).toBe(1); // way past max clamps
    expect(scrubValue(0.1, -400, 0, 1, 0.05)).toBe(0);
  });

  test("a custom travelPx changes sensitivity", () => {
    // Half the travel = twice as fast: 100px sweeps the whole range.
    expect(scrubValue(0, 100, 0, 1, 0.05, 100)).toBe(1);
  });
});

describe("isScrubTap — tap-vs-drag threshold", () => {
  test("sub-slop travel on both axes is a tap", () => {
    expect(isScrubTap(0, 0)).toBe(true);
    expect(isScrubTap(SCRUB_TAP_SLOP_PX - 1, SCRUB_TAP_SLOP_PX - 1)).toBe(true);
  });

  test("reaching slop on either axis is a drag, not a tap", () => {
    expect(isScrubTap(SCRUB_TAP_SLOP_PX, 0)).toBe(false);
    expect(isScrubTap(0, SCRUB_TAP_SLOP_PX)).toBe(false);
    expect(isScrubTap(-SCRUB_TAP_SLOP_PX, 0)).toBe(false); // sign-agnostic
  });
});

describe("nearestIndex — which item a scrub x lands on", () => {
  // Five items centred at 50, 150, 250, 350, 450 (100px apart).
  const centers = [50, 150, 250, 350, 450];

  test("picks the item whose centre is nearest the pointer", () => {
    expect(nearestIndex(50, centers)).toBe(0);
    expect(nearestIndex(250, centers)).toBe(2);
    expect(nearestIndex(451, centers)).toBe(4);
  });

  test("crossing a midpoint flips to the next item", () => {
    expect(nearestIndex(199, centers)).toBe(1); // just left of the 1↔2 midpoint (200)
    expect(nearestIndex(201, centers)).toBe(2); // just right of it
  });

  test("clamps past either end — no item before the first or after the last", () => {
    expect(nearestIndex(-1000, centers)).toBe(0);
    expect(nearestIndex(9999, centers)).toBe(4);
  });

  test("an empty strip has no item — pins to 0", () => {
    expect(nearestIndex(123, [])).toBe(0);
  });
});

// The scrub CONTROLLER, driven DOM-light with no browser: a fake row captures
// the pointer listeners and hands back item rects, so the real
// pointer-down/move/up path runs with no browser. It exercises the two things
// the wiring owns — that a press selects the pressed item (a tap) and that a
// slide re-selects live as the finger crosses item centres (the scrub).
function scrub(centers: number[], count = centers.length) {
  return createRoot((dispose) => {
    const selected: number[] = [];
    const h: FakeHandlers = {};
    const items = centers.map((c) => ({
      getBoundingClientRect: () => ({ left: c - 16, width: 32 }),
    }));
    const el = {
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        h[type] = fn;
      },
      removeEventListener: () => {},
      setPointerCapture: () => {},
      releasePointerCapture: () => {},
      hasPointerCapture: () => false,
      querySelectorAll: () => items,
    } as unknown as HTMLElement;
    const s = createScrubSelect({ count: () => count, onSelect: (i) => selected.push(i) });
    s.bindRow(el);
    return { s, h, selected, dispose };
  });
}
const pointer = (clientX: number, extra: Record<string, unknown> = {}) => ({
  pointerId: 1,
  isPrimary: true,
  clientX,
  cancelable: true,
  preventDefault() {},
  ...extra,
});

describe("createScrubSelect", () => {
  // Three icons centred at 50, 150, 250.
  const C = [50, 150, 250];

  test("a plain tap selects just the pressed item", () => {
    const c = scrub(C);
    c.h.pointerdown!(pointer(150)); // press item 1
    c.h.pointerup!(pointer(150));
    expect(c.selected).toEqual([1]); // one select, the tapped icon
    expect(c.s.scrubbing()).toBe(false);
    c.dispose();
  });

  test("a slide re-selects live as the finger crosses item centres", () => {
    const c = scrub(C);
    c.h.pointerdown!(pointer(50)); // press item 0
    expect(c.s.scrubbing()).toBe(true);
    c.h.pointermove!(pointer(150)); // slid onto item 1
    c.h.pointermove!(pointer(250)); // and onto item 2
    c.h.pointerup!(pointer(250));
    expect(c.selected).toEqual([0, 1, 2]); // continuous selection under the finger
    expect(c.s.scrubbing()).toBe(false);
    c.dispose();
  });

  test("a non-primary pointer never scrubs", () => {
    const c = scrub(C);
    c.h.pointerdown!(pointer(150, { isPrimary: false }));
    expect(c.selected).toEqual([]);
    expect(c.s.scrubbing()).toBe(false);
    c.dispose();
  });

  test("moves from a different pointer id are ignored mid-scrub", () => {
    const c = scrub(C);
    c.h.pointerdown!(pointer(50)); // pointer 1 owns it
    c.h.pointermove!(pointer(250, { pointerId: 2 })); // a stray second contact
    c.h.pointerup!(pointer(50));
    expect(c.selected).toEqual([0]); // only the owning pointer's press counted
    c.dispose();
  });
});

describe("createVelocityTracker", () => {
  test("zero until it has two samples", () => {
    const v = createVelocityTracker();
    expect(v.velocity()).toBe(0);
    v.push(0, 100);
    expect(v.velocity()).toBe(0);
  });

  test("px/ms across the retained window", () => {
    const v = createVelocityTracker(100);
    v.push(0, 0);
    v.push(50, 50); // 1 px/ms
    expect(v.velocity()).toBeCloseTo(1);
  });

  test("only the trailing window counts — an early stall does not dampen a late flick", () => {
    const v = createVelocityTracker(100);
    v.push(0, 0); // ancient, dropped
    v.push(500, 0); // stalled here
    v.push(560, 120); // then flicked: 120px in 60ms
    expect(v.velocity()).toBeCloseTo(2);
  });

  test("reset clears the window", () => {
    const v = createVelocityTracker();
    v.push(0, 0);
    v.push(10, 40);
    v.reset();
    expect(v.velocity()).toBe(0);
  });
});

describe("slideIndexFromScroll — which slide a settled scroll rests on", () => {
  // 5 slides, pitch 316px (a 300px viewport + a 16px gutter gap).
  const STEP = 316;
  const N = 5;

  test("rounds scrollLeft to the nearest slide at the pitch", () => {
    expect(slideIndexFromScroll(0, STEP, N)).toBe(0);
    expect(slideIndexFromScroll(STEP, STEP, N)).toBe(1);
    expect(slideIndexFromScroll(2 * STEP, STEP, N)).toBe(2);
  });

  test("a partial swipe rounds to the nearer slide (half-pitch is the flip)", () => {
    expect(slideIndexFromScroll(STEP * 0.49, STEP, N)).toBe(0);
    expect(slideIndexFromScroll(STEP * 0.51, STEP, N)).toBe(1);
  });

  test("clamps past either end — no slide before the first or after the last", () => {
    expect(slideIndexFromScroll(-50, STEP, N)).toBe(0);
    expect(slideIndexFromScroll(999 * STEP, STEP, N)).toBe(N - 1);
  });

  test("an unmeasured pitch pins to 0 — no divide by zero", () => {
    expect(slideIndexFromScroll(1234, 0, N)).toBe(0);
  });
});

// A fake element that captures the listeners a controller binds, so its real
// pointer/touch path runs with no DOM — used by the scrub and pager harnesses.
type FakeHandlers = Record<string, (e: unknown) => void>;

describe("lockAxis — the pager's axis arbitration", () => {
  test("below slop on both axes is unlocked (a tap stays a tap)", () => {
    expect(lockAxis(0, 0)).toBe(null);
    expect(lockAxis(DRAG_SLOP_PX - 1, DRAG_SLOP_PX - 1)).toBe(null);
  });

  test("past slop the dominant delta wins — a drift swipe still locks horizontal", () => {
    // A real thumb-swipe drifts: mostly across, a little down. It must lock x.
    expect(lockAxis(40, 12)).toBe("x");
    expect(lockAxis(-40, 12)).toBe("x"); // sign-agnostic
    expect(lockAxis(9, 40)).toBe("y"); // vertical-dominant
  });

  test("a tie falls to the sheet's vertical axis, never the pager", () => {
    expect(lockAxis(20, 20)).toBe("y");
  });
});

describe("pagerLandingIndex — a swipe lands on an INTEGER slide, never between", () => {
  const PITCH = 300;
  const N = 5;

  test("a gentle drag past half-pitch advances one; short of it springs back", () => {
    expect(pagerLandingIndex(1, -160, 0, PITCH, N)).toBe(2); // dragged left past half
    expect(pagerLandingIndex(1, -140, 0, PITCH, N)).toBe(1); // short of half → back
    expect(pagerLandingIndex(1, 160, 0, PITCH, N)).toBe(0); // dragged right → previous
  });

  test("a flick carries one slide even on a tiny drag (velocity, not distance)", () => {
    // 30px is short of half a slide, but a fast flick projects over it.
    expect(pagerLandingIndex(1, -30, -2, PITCH, N)).toBe(2);
    expect(pagerLandingIndex(1, 30, 2, PITCH, N)).toBe(0);
  });

  test("a full-width pager advances AT MOST one per swipe — a wild flick never skips", () => {
    // Huge drag + huge velocity is still bounded to startIndex ± 1.
    expect(pagerLandingIndex(2, -2000, -9, PITCH, N)).toBe(3);
    expect(pagerLandingIndex(2, 2000, 9, PITCH, N)).toBe(1);
  });

  test("clamps at the ends — no slide before the first or after the last", () => {
    expect(pagerLandingIndex(0, 200, 5, PITCH, N)).toBe(0); // already at 0, dragged right
    expect(pagerLandingIndex(N - 1, -200, -5, PITCH, N)).toBe(N - 1); // at last, dragged left
  });

  test("an unmeasured pitch holds the start index — no divide by zero", () => {
    expect(pagerLandingIndex(2, -500, -3, 0, N)).toBe(2);
  });

  test("always an integer, across a sweep of positions and velocities", () => {
    for (let i = 0; i < N; i++) {
      for (let dx = -400; dx <= 400; dx += 37) {
        for (let v = -4; v <= 4; v += 0.7) {
          const landed = pagerLandingIndex(i, dx, v, PITCH, N);
          expect(Number.isInteger(landed)).toBe(true);
          expect(landed).toBeGreaterThanOrEqual(0);
          expect(landed).toBeLessThan(N);
        }
      }
    }
  });
});

// The pager WIRING driven DOM-light, no browser: a fake viewport captures the
// touch listeners, and a fake SheetDrag records what the pager forwards to it
// and whether it declared the vertical drag its own. This exercises the
// arbitration the recogniser owns — that a horizontal-with-drift swipe pages the
// track (and never touches the sheet), and that a vertical drag is forwarded to
// the sheet and, when the sheet declines it, scrolls the body by hand.
//
// CAVEAT: this cannot reproduce the actual iOS failure. The bug is that iOS's
// compositor makes the touchmoves non-cancelable once it preemptively scrolls;
// a synthetic touch (here, or in headless Chromium) is ALWAYS cancelable, so no
// harness can. What `touch-action: none` fixes is arbitration, not
// cancelability — and arbitration is exactly what this asserts. On-device
// confirmation is the user's to make on the tablet.
interface FakeSheet {
  sheet: SheetDrag;
  forwarded: string[];
  scrollEl: { scrollTop: number };
  setDragging: (v: boolean) => void;
}
function fakeSheet(): FakeSheet {
  const [dragging, setDragging] = createSignal(false);
  const forwarded: string[] = [];
  const scrollEl = { scrollTop: 100 };
  const body: TouchHandlers = {
    onTouchStart: () => forwarded.push("start"),
    onTouchMove: () => forwarded.push("move"),
    onTouchEnd: () => forwarded.push("end"),
    onTouchCancel: () => forwarded.push("cancel"),
  };
  const sheet = {
    body,
    dragging,
    scrollEl: () => scrollEl as unknown as HTMLElement,
  } as unknown as SheetDrag;
  return { sheet, forwarded, scrollEl, setDragging };
}

const tev = (
  pts: { x: number; y: number }[],
  target: unknown = null,
): TouchEvent =>
  ({
    target,
    touches: pts.map((p) => ({ clientX: p.x, clientY: p.y })),
    changedTouches: pts.map((p) => ({ clientX: p.x, clientY: p.y })),
    cancelable: true,
    preventDefault() {},
    stopPropagation() {},
  }) as unknown as TouchEvent;

function pagerHarness(opts: { index?: number; count?: number; pitch?: number } = {}) {
  return createRoot((dispose) => {
    const fs = fakeSheet();
    const [index, setIndex] = createSignal(opts.index ?? 0);
    const selected: number[] = [];
    const h: FakeHandlers = {};
    const el = {
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        h[type] = fn;
      },
      removeEventListener: () => {},
      // Every fake scroller below lives inside this viewport.
      contains: () => true,
    } as unknown as HTMLElement;
    let clock = 0;
    const pager = createPagerDrag({
      index: index as Accessor<number>,
      count: () => opts.count ?? 3,
      pitch: () => opts.pitch ?? 300,
      onSelect: (i) => {
        selected.push(i);
        setIndex(i);
      },
      sheet: fs.sheet,
      now: () => (clock += 16),
    });
    pager.bindViewport(el);
    return { pager, fs, h, selected, index, setIndex, dispose };
  });
}

describe("createPagerDrag — axis arbitration wiring", () => {
  test("a horizontal swipe WITH vertical drift pages the track by exactly one", () => {
    const c = pagerHarness({ index: 0, count: 3, pitch: 300 });
    // Start, then a drifting leftward swipe (mostly across, a little down).
    c.h.touchstart!(tev([{ x: 200, y: 200 }]));
    c.h.touchmove!(tev([{ x: 178, y: 194 }])); // dx -22, dy -6 → locks x
    expect(c.pager.dragging()).toBe(true);
    c.h.touchmove!(tev([{ x: 70, y: 188 }])); // dragged well past half a slide
    c.h.touchend!(tev([{ x: 60, y: 186 }]));

    expect(c.selected).toEqual([1]); // advanced exactly one
    expect(c.pager.offset()).toBe(-300); // landed on slide 1's snap (integer)
    expect(c.pager.dragging()).toBe(false);
    expect(c.pager.animate()).toBe(true); // settles with a transition
    // The pager owned the horizontal outright — it never drove the sheet.
    expect(c.fs.forwarded).toEqual(["start"]);
    c.dispose();
  });

  test("a vertical drag the sheet declines is content-scrolled by hand", () => {
    const c = pagerHarness();
    c.fs.setDragging(false); // sheet leaves it to content scroll
    c.h.touchstart!(tev([{ x: 200, y: 200 }]));
    c.h.touchmove!(tev([{ x: 198, y: 220 }])); // dy +20 → locks y, forwarded
    c.h.touchmove!(tev([{ x: 198, y: 260 }])); // dy +40 more
    c.h.touchend!(tev([{ x: 198, y: 262 }]));

    expect(c.selected).toEqual([]); // no paging
    expect(c.pager.offset()).toBe(0); // track never moved
    // Forwarded to the sheet's body machine, and scrolled the body by the finger
    // (100 − 20 − 40 = 40) since touch-action:none left no native scroll to run.
    expect(c.fs.forwarded).toEqual(["start", "move", "move", "end"]);
    expect(c.fs.scrollEl.scrollTop).toBe(40);
    c.dispose();
  });

  test("a vertical drag the sheet CLAIMS (a boundary drag) is left to the sheet", () => {
    const c = pagerHarness();
    c.fs.setDragging(true); // sheet armed: it owns this drag (dismiss/detent)
    c.h.touchstart!(tev([{ x: 200, y: 200 }]));
    c.h.touchmove!(tev([{ x: 198, y: 230 }])); // locks y, forwarded — sheet dragging
    c.h.touchend!(tev([{ x: 198, y: 232 }]));

    // The sheet drives; the pager must NOT also scroll the body.
    expect(c.fs.scrollEl.scrollTop).toBe(100); // untouched
    expect(c.fs.forwarded).toEqual(["start", "move", "end"]);
    c.dispose();
  });

  test("an external index change glides the track to that slide", () => {
    const c = pagerHarness({ index: 0, count: 3, pitch: 300 });
    // The indicator strip (or a keyboard step) moves the shared index signal;
    // the pager's on(index) effect must glide the track to that slide.
    c.setIndex(2);
    expect(c.pager.offset()).toBe(-600); // slide 2 at pitch 300
    expect(c.pager.animate()).toBe(true); // an external select animates
    c.dispose();
  });
});

describe("canScrollX — can a horizontal drag still scroll this region?", () => {
  const box = (scrollLeft: number, scrollWidth = 600, clientWidth = 300) => ({
    scrollLeft,
    scrollWidth,
    clientWidth,
  });

  test("a leftward drag needs room to the right; a rightward one room to the left", () => {
    expect(canScrollX(box(0), -20)).toBe(true); // at the start, reveal more
    expect(canScrollX(box(0), +20)).toBe(false); // already at the left edge
    expect(canScrollX(box(300), -20)).toBe(false); // at the right edge (max 300)
    expect(canScrollX(box(300), +20)).toBe(true);
    expect(canScrollX(box(150), -20)).toBe(true);
    expect(canScrollX(box(150), +20)).toBe(true);
  });

  test("a region that doesn't overflow never scrolls (the pager keeps it)", () => {
    expect(canScrollX(box(0, 300, 300), -20)).toBe(false);
    expect(canScrollX(box(0, 301, 300), -20)).toBe(false); // sub-pixel overflow
  });

  test("fractional scroll positions at an edge count as the edge", () => {
    expect(canScrollX(box(299.5), -20)).toBe(false);
    expect(canScrollX(box(0.5), +20)).toBe(false);
  });
});

// A horizontally scrollable region inside a slide (a place's photo strip)
// carries PAGER_SCROLL_X_ATTR; a horizontal drag that starts on it scrolls it
// by hand instead of paging — decided once at axis lock.
describe("createPagerDrag — a scroll-x region owns the horizontal drags that start on it", () => {
  function strip(scrollLeft: number, scrollWidth = 600, clientWidth = 300) {
    const s = {
      scrollLeft,
      scrollWidth,
      clientWidth,
      // The browser clamps an assigned scrollLeft; so does the fake.
      set(v: number) {
        this.scrollLeft = Math.min(Math.max(v, 0), scrollWidth - clientWidth);
      },
    };
    const el = {
      get scrollLeft() {
        return s.scrollLeft;
      },
      set scrollLeft(v: number) {
        s.set(v);
      },
      scrollWidth,
      clientWidth,
    };
    // A touch lands on a thumbnail INSIDE the strip: closest() finds the strip.
    const thumb = { closest: (sel: string) => (sel === `[${PAGER_SCROLL_X_ATTR}]` ? el : null) };
    return { el, thumb };
  }
  const elsewhere = { closest: () => null }; // the card's text, buttons, …

  test("the marker is the data attribute the photo strip carries", () => {
    expect(PAGER_SCROLL_X_ATTR).toBe("data-pager-scroll-x");
  });

  test("a leftward drag on the strip scrolls it and never pages", () => {
    const c = pagerHarness({ index: 0, count: 3, pitch: 300 });
    const s = strip(0);
    c.h.touchstart!(tev([{ x: 200, y: 200 }], s.thumb));
    c.h.touchmove!(tev([{ x: 180, y: 198 }], s.thumb)); // locks x
    c.h.touchmove!(tev([{ x: 80, y: 196 }], s.thumb));
    expect(s.el.scrollLeft).toBe(120); // followed the finger 1:1
    expect(c.pager.dragging()).toBe(false);
    expect(c.pager.offset()).toBe(0); // the track never moved
    c.h.touchend!(tev([{ x: 60, y: 196 }], s.thumb));
    expect(c.selected).toEqual([]); // no POI change
    expect(c.pager.offset()).toBe(0);
    expect(c.fs.forwarded).toEqual(["start"]); // nothing driven on the sheet
    c.dispose();
  });

  test("the strip scrolls back rightward from the middle, clamped at its start", () => {
    const c = pagerHarness({ index: 1, count: 3, pitch: 300 });
    const s = strip(100);
    c.h.touchstart!(tev([{ x: 100, y: 200 }], s.thumb));
    c.h.touchmove!(tev([{ x: 120, y: 200 }], s.thumb));
    expect(s.el.scrollLeft).toBe(80);
    c.h.touchmove!(tev([{ x: 400, y: 200 }], s.thumb)); // past the start
    expect(s.el.scrollLeft).toBe(0);
    c.h.touchend!(tev([{ x: 400, y: 200 }], s.thumb));
    expect(c.selected).toEqual([]); // reaching the edge mid-drag never hands over
    c.dispose();
  });

  test("at the edge it hands over: a drag the strip can't scroll pages instead", () => {
    const c = pagerHarness({ index: 0, count: 3, pitch: 300 });
    const s = strip(300); // scrolled fully right
    c.h.touchstart!(tev([{ x: 250, y: 200 }], s.thumb));
    c.h.touchmove!(tev([{ x: 230, y: 198 }], s.thumb)); // leftward: strip can't
    expect(c.pager.dragging()).toBe(true);
    c.h.touchmove!(tev([{ x: 60, y: 196 }], s.thumb));
    c.h.touchend!(tev([{ x: 50, y: 196 }], s.thumb));
    expect(c.selected).toEqual([1]);
    expect(s.el.scrollLeft).toBe(300); // untouched
    c.dispose();
  });

  test("a strip that doesn't overflow never blocks paging", () => {
    const c = pagerHarness({ index: 0, count: 3, pitch: 300 });
    const s = strip(0, 200, 300);
    c.h.touchstart!(tev([{ x: 250, y: 200 }], s.thumb));
    c.h.touchmove!(tev([{ x: 230, y: 198 }], s.thumb));
    c.h.touchmove!(tev([{ x: 60, y: 196 }], s.thumb));
    c.h.touchend!(tev([{ x: 50, y: 196 }], s.thumb));
    expect(c.selected).toEqual([1]);
    c.dispose();
  });

  test("a drag that starts elsewhere on the card still pages", () => {
    const c = pagerHarness({ index: 0, count: 3, pitch: 300 });
    c.h.touchstart!(tev([{ x: 250, y: 200 }], elsewhere));
    c.h.touchmove!(tev([{ x: 230, y: 198 }], elsewhere));
    c.h.touchmove!(tev([{ x: 60, y: 196 }], elsewhere));
    c.h.touchend!(tev([{ x: 50, y: 196 }], elsewhere));
    expect(c.selected).toEqual([1]);
    c.dispose();
  });

  test("a vertical drag on the strip is still the sheet's (scroll/dismiss)", () => {
    const c = pagerHarness();
    const s = strip(50);
    c.fs.setDragging(false);
    c.h.touchstart!(tev([{ x: 200, y: 200 }], s.thumb));
    c.h.touchmove!(tev([{ x: 199, y: 230 }], s.thumb)); // locks y
    c.h.touchend!(tev([{ x: 199, y: 232 }], s.thumb));
    expect(c.fs.forwarded).toEqual(["start", "move", "end"]);
    expect(c.fs.scrollEl.scrollTop).toBe(70); // 100 − 30, by hand
    expect(s.el.scrollLeft).toBe(50); // the strip didn't move
    c.dispose();
  });

  test("a tap on a thumbnail locks nothing — it ends as a tap (the click opens the lightbox)", () => {
    const c = pagerHarness();
    const s = strip(0);
    c.h.touchstart!(tev([{ x: 200, y: 200 }], s.thumb));
    c.h.touchmove!(tev([{ x: 203, y: 201 }], s.thumb)); // within slop
    c.h.touchend!(tev([{ x: 203, y: 201 }], s.thumb));
    expect(s.el.scrollLeft).toBe(0);
    expect(c.selected).toEqual([]);
    // Ends through the sheet like any tap, so nothing claims or cancels it.
    expect(c.fs.forwarded).toEqual(["start", "end"]);
    c.dispose();
  });
});
