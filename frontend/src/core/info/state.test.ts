/**
 * Panel behaviour: the best hit first, cycling through the rest, picking one,
 * and the entry point that is not a click.
 *
 * The panel component is a rendering of this and nothing more, which is why
 * this is where the behaviour lives — tsconfig excludes *.test.ts and there
 * is no DOM under `bun test`, so behaviour left inside a component is
 * behaviour left untested. (The multi-hit presentation itself — the desktop
 * list and the phone swipe carousel — is container chrome over this state; its
 * one testable seam, the swipe→index maths, lives in ../gesture.test.ts.)
 *
 * NB: needs `--conditions=browser` (the `test` script). Bare `bun test`
 * resolves solid-js's `node` export, whose createEffect never runs.
 */

import { describe, expect, test } from "bun:test";
import { createEffect, createRoot } from "solid-js";
import { createInfoState, isSameSpot } from "./state";
import type { InfoHit, InfoPriority } from "./types";

function hit(id: string, priority: InfoPriority = "aid"): InfoHit {
  return { providerId: "chart", id, priority, precision: "point", title: id };
}

/** Runs `body` with a fresh state under a disposed reactive root. */
function withState(body: (s: ReturnType<typeof createInfoState>) => void) {
  createRoot((dispose) => {
    body(createInfoState());
    dispose();
  });
}

describe("createInfoState", () => {
  test("opens on the best hit — first in, first shown", () => {
    withState((s) => {
      expect(s.open()).toBe(false);
      s.show([hit("wreck", "danger"), hit("sounding", "depth")]);
      expect(s.open()).toBe(true);
      // Several hits open on the top one's detail (not a bare list) — the rest
      // are reachable from the presentation, but `current()` is the best.
      expect(s.current()?.id).toBe("wreck");
      expect(s.index()).toBe(0);
    });
  });

  test("a single hit opens on its detail", () => {
    withState((s) => {
      s.show([hit("only", "aid")]);
      expect(s.open()).toBe(true);
      expect(s.current()?.id).toBe("only");
    });
  });

  test("an empty result closes rather than opening an empty sheet", () => {
    withState((s) => {
      s.show([hit("a")]);
      s.show([]);
      expect(s.open()).toBe(false);
      expect(s.current()).toBeUndefined();
    });
  });

  test("cycling walks every hit and wraps in both directions", () => {
    withState((s) => {
      s.show([hit("a"), hit("b"), hit("c")]);
      s.next();
      expect(s.current()?.id).toBe("b");
      s.next();
      expect(s.current()?.id).toBe("c");
      s.next(); // wraps — no dead button at the end
      expect(s.current()?.id).toBe("a");
      s.prev();
      expect(s.current()?.id).toBe("c");
    });
  });

  test("cycling a single hit is a no-op, not an error", () => {
    withState((s) => {
      s.show([hit("only")]);
      s.next();
      s.prev();
      expect(s.current()?.id).toBe("only");
      expect(s.index()).toBe(0);
    });
  });

  test("cycling with nothing open does nothing", () => {
    withState((s) => {
      s.next();
      expect(s.index()).toBe(0);
      expect(s.open()).toBe(false);
    });
  });

  test("selecting swaps which hit is in detail (the list / dot / carousel)", () => {
    withState((s) => {
      s.show([hit("a"), hit("b"), hit("c")]);
      expect(s.hits().map((h) => h.id)).toEqual(["a", "b", "c"]);

      s.select(2);
      expect(s.current()?.id).toBe("c");
      s.select(1);
      expect(s.current()?.id).toBe("b");
    });
  });

  test("select ignores an out-of-range index", () => {
    withState((s) => {
      s.show([hit("a"), hit("b")]);
      s.select(5);
      s.select(-1);
      s.select(1.5);
      expect(s.current()?.id).toBe("a");
    });
  });

  test("a new query lands on the new best hit, not the old cursor", () => {
    withState((s) => {
      s.show([hit("a"), hit("b"), hit("c")]);
      s.next();
      s.show([hit("x"), hit("y")]);
      expect(s.index()).toBe(0);
      expect(s.current()?.id).toBe("x");
    });
  });

  test("show() takes hits, not a click — anything can open the panel", () => {
    withState((s) => {
      // An AIS target list, a search result or an alarm, with no map involved.
      s.show([
        { providerId: "vessels", id: "mmsi:1", priority: "traffic", precision: "point", title: "Nordkap" },
      ]);
      expect(s.open()).toBe(true);
      expect(s.current()?.title).toBe("Nordkap");
    });
  });

  test("probe: a repeat tap on the same objects cycles to the next", () => {
    withState((s) => {
      s.probe([hit("a"), hit("b"), hit("c")]);
      expect(s.current()?.id).toBe("a");
      // Same objects again — a second click on the same point resolves to fresh
      // but equal hit objects (identity is provider+id, not reference).
      s.probe([hit("a"), hit("b"), hit("c")]);
      expect(s.current()?.id).toBe("b");
      s.probe([hit("a"), hit("b"), hit("c")]);
      expect(s.current()?.id).toBe("c");
      s.probe([hit("a"), hit("b"), hit("c")]); // wraps, never a dead click
      expect(s.current()?.id).toBe("a");
    });
  });

  test("probe: a different set of objects opens fresh at the best hit", () => {
    withState((s) => {
      s.probe([hit("a"), hit("b"), hit("c")]);
      s.probe([hit("a"), hit("b"), hit("c")]);
      expect(s.current()?.id).toBe("b"); // cycled onto a mid hit

      // A genuinely different probe (new objects) resets to index 0.
      s.probe([hit("x"), hit("y")]);
      expect(s.index()).toBe(0);
      expect(s.current()?.id).toBe("x");
    });
  });

  test("probe: same ids in a different ranking is a new answer, not a cycle", () => {
    withState((s) => {
      s.probe([hit("a"), hit("b")]);
      s.probe([hit("a"), hit("b")]);
      expect(s.current()?.id).toBe("b");
      // Best hit changed → the tap landed somewhere new even though the ids
      // overlap; open fresh rather than advancing.
      s.probe([hit("b"), hit("a")]);
      expect(s.index()).toBe(0);
      expect(s.current()?.id).toBe("b");
    });
  });

  test("probe: a single hit re-tapped does not grow past itself", () => {
    withState((s) => {
      s.probe([hit("only")]);
      s.probe([hit("only")]); // cycle of one — a no-op, no dead index
      expect(s.index()).toBe(0);
      expect(s.current()?.id).toBe("only");
    });
  });

  test("probe: an empty result closes, like show", () => {
    withState((s) => {
      s.probe([hit("a"), hit("b")]);
      s.probe([]);
      expect(s.open()).toBe(false);
      expect(s.current()).toBeUndefined();
    });
  });

  test("probe: the first probe onto a closed panel opens fresh, never cycles", () => {
    withState((s) => {
      s.probe([hit("a"), hit("b")]);
      expect(s.index()).toBe(0);
      expect(s.current()?.id).toBe("a");
    });
  });

  test("probe: a tap somewhere else is a new subject even when the same objects answer", () => {
    withState((s) => {
      // A big depth area: every tap inside it finds the same DEPARE + wind.
      const at = (lng: number) => [hit("depare"), hit("wind")].map((h) => ({ ...h, lngLat: { lng, lat: 55 } }));
      s.probe(at(10));
      expect(s.current()?.id).toBe("depare");
      // Tapped again 2 nm away, not on the same spot: the tapped area is the
      // subject (and stays highlighted), placed at the NEW tap — not a cycle
      // onto "wind" still describing the first tap's position.
      s.probe(at(10.05), false);
      expect(s.index()).toBe(0);
      expect(s.current()?.id).toBe("depare");
      expect(s.hits().map((h) => h.lngLat?.lng)).toEqual([10.05, 10.05]);
      // ... while a repeat tap on that spot still cycles.
      s.probe(at(10.05), true);
      expect(s.current()?.id).toBe("wind");
    });
  });

  test("isSameSpot: two taps each get their own tolerance, no more", () => {
    expect(isSameSpot({ x: 100, y: 100 }, { x: 110, y: 112 }, 8)).toBe(true); // 15.6 px ≤ 16
    expect(isSameSpot({ x: 100, y: 100 }, { x: 117, y: 100 }, 8)).toBe(false);
  });

  test("a new answer is one change: no observer sees the old index applied to the new hits", () => {
    // What the chart highlight, the marker and `InfoProvider.selected` all
    // key on. Driven from OUTSIDE the root, like a map click, so each write
    // would flush on its own.
    const seen: (string | undefined)[] = [];
    const { s, dispose } = createRoot((dispose) => {
      const s = createInfoState();
      createEffect(() => seen.push(s.current()?.id));
      return { s, dispose };
    });
    s.probe([hit("a"), hit("b"), hit("c")]);
    s.select(2);
    seen.length = 0;
    s.probe([hit("x"), hit("y"), hit("z")]);
    expect(seen).toEqual(["x"]); // never "z" — the old index into the new hits
    seen.length = 0;
    s.select(1);
    s.show([hit("p"), hit("q")]);
    expect(seen).toEqual(["y", "p"]); // never "q"
    dispose();
  });

  test("close resets everything", () => {
    withState((s) => {
      s.show([hit("a"), hit("b")]);
      s.next();
      s.close();
      expect(s.open()).toBe(false);
      expect(s.hits()).toEqual([]);
      expect(s.index()).toBe(0);
    });
  });
});
