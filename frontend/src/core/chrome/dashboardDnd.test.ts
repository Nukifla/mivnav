/**
 * The board drag's PURE decisions — the reorder maths and the drop-plan
 * resolver. The Pointer-Events wiring (`createDashboardDrag`) needs a DOM and is
 * driven in a real browser, not here (see gesture.test.ts's note); this locks
 * what that wiring defers to: turning a from-index + a drop gap into the right
 * sequence of `moveWidgetInTab` swaps, and turning a released drag's hover state
 * into the right `config.ts` writer call.
 */
import { describe, expect, test } from "bun:test";
import {
  AUTOSCROLL_EDGE_PX,
  AUTOSCROLL_MAX_PX,
  autoScrollStep,
  dropTargetIndex,
  planDrop,
  reorderSwaps,
  type DropInput,
} from "./dashboardDnd";

/** Apply a swap sequence to a plain array — the moral of `moveWidgetInTab` folded
 * over a tab's order, so a swap plan can be checked by its final order. */
function applySwaps(ids: string[], swaps: [string, string][]): string[] {
  const arr = [...ids];
  for (const [a, b] of swaps) {
    const i = arr.indexOf(a);
    const j = arr.indexOf(b);
    if (i >= 0 && j >= 0) [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

/** The end-to-end reorder a drag produces: move `id` to insertion `gap`. */
function reorder(ids: string[], id: string, gap: number): string[] {
  const from = ids.indexOf(id);
  return applySwaps(ids, reorderSwaps(ids, from, dropTargetIndex(from, gap)));
}

describe("dropTargetIndex — a visual gap becomes a target index", () => {
  test("dropping before your own slot leaves the gap as the index", () => {
    expect(dropTargetIndex(3, 1)).toBe(1);
    expect(dropTargetIndex(3, 3)).toBe(3); // the gap at your own left edge = no move
  });
  test("dropping after your own slot decrements — one fewer item precedes you", () => {
    expect(dropTargetIndex(1, 4)).toBe(3);
    expect(dropTargetIndex(1, 2)).toBe(1); // the gap at your own right edge = no move
  });
});

describe("reorderSwaps — adjacent swaps that carry an item across the list", () => {
  const ids = ["a", "b", "c", "d", "e"];

  test("no-op when from === to, or out of range", () => {
    expect(reorderSwaps(ids, 2, 2)).toEqual([]);
    expect(reorderSwaps(ids, -1, 3)).toEqual([]);
    expect(reorderSwaps(ids, 1, 9)).toEqual([]);
  });

  test("moving forward bubbles right, moving back bubbles left", () => {
    expect(applySwaps(ids, reorderSwaps(ids, 0, 3))).toEqual(["b", "c", "d", "a", "e"]);
    expect(applySwaps(ids, reorderSwaps(ids, 4, 1))).toEqual(["a", "e", "b", "c", "d"]);
  });

  test("every swap is of two ADJACENT ids — an honest moveWidgetInTab call", () => {
    const swaps = reorderSwaps(ids, 0, 4);
    // Each pair is neighbours in the running order, so the caller can pass them
    // straight to moveWidgetInTab (which swaps by id).
    expect(swaps.length).toBe(4);
  });
});

describe("reorder — the whole drag, from a from-index to an insertion gap", () => {
  const ids = ["a", "b", "c", "d"];
  test("drag the first card to the end", () => {
    expect(reorder(ids, "a", 4)).toEqual(["b", "c", "d", "a"]);
  });
  test("drag the last card to the front", () => {
    expect(reorder(ids, "d", 0)).toEqual(["d", "a", "b", "c"]);
  });
  test("drag into the middle", () => {
    expect(reorder(ids, "a", 3)).toEqual(["b", "c", "a", "d"]);
    expect(reorder(ids, "d", 1)).toEqual(["a", "d", "b", "c"]);
  });
  test("dropping either side of your own slot is a no-op", () => {
    expect(reorder(ids, "b", 1)).toEqual(ids);
    expect(reorder(ids, "b", 2)).toEqual(ids);
  });
});

describe("planDrop — a released drag becomes a writer call", () => {
  const base: DropInput = {
    id: "x",
    originTab: "nav",
    overRemove: false,
    overTab: null,
    overGrid: "nav",
    deletable: false,
    gap: null,
    visibleIds: ["a", "x", "c"],
  };

  test("remove zone: a re-addable instrument leaves its tab immediately", () => {
    expect(planDrop({ ...base, overRemove: true })).toEqual({
      kind: "removeFromTab",
      tabId: "nav",
      id: "x",
    });
  });

  test("remove zone: a deletable widget ARMS the two-step confirm, never deletes", () => {
    expect(planDrop({ ...base, overRemove: true, deletable: true })).toEqual({
      kind: "confirmDelete",
      id: "x",
    });
  });

  test("over another tab's header → append to that tab", () => {
    expect(planDrop({ ...base, overTab: "wind" })).toEqual({
      kind: "toTab",
      id: "x",
      toTabId: "wind",
    });
  });

  test("over its OWN tab's header is not a move", () => {
    // overTab === originTab falls through to the grid decision (gap null → none).
    expect(planDrop({ ...base, overTab: "nav" })).toEqual({ kind: "none" });
  });

  test("over neither a grid nor a header → none", () => {
    expect(planDrop({ ...base, overGrid: null })).toEqual({ kind: "none" });
  });

  test("dropped in its own grid → a reorder to the gap", () => {
    const plan = planDrop({ ...base, gap: 3 });
    expect(plan.kind).toBe("reorder");
    if (plan.kind === "reorder") {
      expect(plan.tabId).toBe("nav");
      expect(applySwaps([...base.visibleIds], plan.swaps)).toEqual(["a", "c", "x"]);
    }
  });

  test("dropped on the SAME slot it came from → none", () => {
    expect(planDrop({ ...base, gap: 1 })).toEqual({ kind: "none" });
    expect(planDrop({ ...base, gap: 2 })).toEqual({ kind: "none" });
  });

  test("dropped in ANOTHER zone's grid (a tab reached by hover-switch) → move-and-position", () => {
    expect(planDrop({ ...base, overGrid: "wind", gap: 2 })).toEqual({
      kind: "toTabAt",
      id: "x",
      toTabId: "wind",
      gap: 2,
    });
  });

  test("dropped in another zone's grid off any cell → append", () => {
    expect(planDrop({ ...base, overGrid: "wind", gap: null })).toEqual({
      kind: "toTab",
      id: "x",
      toTabId: "wind",
    });
  });

  // ── Multi-zone: the rail strip is now just another target ────────────────────
  // The rail is a second, always-visible zone (`overGrid === "rail"`), keyed off
  // the slot's own target rather than a single active grid — so every board
  // behaviour holds within it and across it.

  test("reorder WITHIN the rail (a non-board zone: overGrid === originTab === rail)", () => {
    const plan = planDrop({
      ...base,
      originTab: "rail",
      overGrid: "rail",
      gap: 3,
      visibleIds: ["a", "x", "c"],
    });
    expect(plan.kind).toBe("reorder");
    if (plan.kind === "reorder") {
      expect(plan.tabId).toBe("rail");
      expect(applySwaps(["a", "x", "c"], plan.swaps)).toEqual(["a", "c", "x"]);
    }
  });

  test("move a card from a board tab ONTO the rail → move-and-position", () => {
    expect(planDrop({ ...base, originTab: "nav", overGrid: "rail", gap: 1 })).toEqual({
      kind: "toTabAt",
      id: "x",
      toTabId: "rail",
      gap: 1,
    });
  });

  test("move a card from a board tab onto the rail off any cell → append to rail", () => {
    expect(planDrop({ ...base, originTab: "nav", overGrid: "rail", gap: null })).toEqual({
      kind: "toTab",
      id: "x",
      toTabId: "rail",
    });
  });

  test("move a card FROM the rail onto a board tab", () => {
    expect(planDrop({ ...base, originTab: "rail", overGrid: "wind", gap: null })).toEqual({
      kind: "toTab",
      id: "x",
      toTabId: "wind",
    });
  });

  test("drag a rail card to the remove bar → leaves the rail target", () => {
    expect(planDrop({ ...base, originTab: "rail", overGrid: "rail", overRemove: true })).toEqual({
      kind: "removeFromTab",
      tabId: "rail",
      id: "x",
    });
  });
});

describe("autoScrollStep — edge auto-scroll while a card is lifted", () => {
  // A board body spanning y 100..700.
  test("mid-container never scrolls", () => {
    expect(autoScrollStep(400, 100, 700)).toBe(0);
  });
  test("near the top edge scrolls up, near the bottom scrolls down", () => {
    expect(autoScrollStep(110, 100, 700)).toBeLessThan(0);
    expect(autoScrollStep(690, 100, 700)).toBeGreaterThan(0);
  });
  test("faster the closer to the edge, capped at the max", () => {
    expect(Math.abs(autoScrollStep(101, 100, 700))).toBeGreaterThan(Math.abs(autoScrollStep(150, 100, 700)));
    expect(autoScrollStep(700, 100, 700)).toBe(AUTOSCROLL_MAX_PX);
    expect(autoScrollStep(100, 100, 700)).toBe(-AUTOSCROLL_MAX_PX);
  });
  test("just inside the band edge still moves; just outside it doesn't", () => {
    expect(autoScrollStep(100 + AUTOSCROLL_EDGE_PX - 1, 100, 700)).toBeLessThan(0);
    expect(autoScrollStep(100 + AUTOSCROLL_EDGE_PX + 1, 100, 700)).toBe(0);
  });
  // The phone's remove pill sits over the chart ABOVE the sheet: a finger
  // there must not scroll the board.
  test("outside the container is 0", () => {
    expect(autoScrollStep(40, 100, 700)).toBe(0);
    expect(autoScrollStep(760, 100, 700)).toBe(0);
  });
  test("a short container's bands never overlap", () => {
    expect(autoScrollStep(130, 100, 160)).toBe(0);
  });
});
