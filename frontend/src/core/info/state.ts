// Panel state: which hit is showing, and cycling between them. JSX-free by
// design so this stays unit-testable (no DOM under `bun test`). `show`/`probe`
// take values, not events, so a list/search/alarm can open the panel directly.

import { batch, createMemo, createSignal, type Accessor } from "solid-js";
import type { InfoHit } from "./types";

export interface InfoState {
  open: Accessor<boolean>;
  /** Best first (./rank.ts). */
  hits: Accessor<InfoHit[]>;
  index: Accessor<number>;
  current: Accessor<InfoHit | undefined>;
  /**
   * Open on `hits`, best first, showing the top one. An empty array closes
   * instead of opening: a tap on blank water should not throw a bottom sheet
   * over the chart to say nothing is there.
   */
  show(hits: InfoHit[]): void;
  /** Advances the selection instead of resetting to top when the same hits
   * (provider+id, same order) come back — a repeat tap on the same spot
   * cycles. `show` is for list/search/alarm entry, always fresh.
   *
   * `sameSpot: false` says the tap landed somewhere else, and then it is
   * always a fresh answer: hit ids name the OBJECT (a chart hit's is its
   * attributes, the wind hit's is just "wind"), so every tap inside one big
   * depth area returns "the same hits" — cycling there walked the selection
   * off the area just tapped (its highlight gone) onto a hit still placed at
   * the PREVIOUS tap. Defaults to true for a caller with no position. */
  probe(hits: InfoHit[], sameSpot?: boolean): void;
  /** Show hit `i`. Out-of-range indices are ignored — the desktop list and the
   * phone carousel both call this to swap which hit is in detail. */
  select(i: number): void;
  /** Cycle. Wraps, so a two-hit tap is a toggle and the user never hits a
   * dead button. */
  next(): void;
  prev(): void;
  close(): void;
}

/** Same objects, same order (provider+id) — order matters because the
 * ranking is part of "the same answer": a changed best hit means a new spot. */
function sameHits(a: readonly InfoHit[], b: readonly InfoHit[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((h, i) => h.providerId === b[i].providerId && h.id === b[i].id);
}

/** Is a tap at `b` a repeat of the one at `a` (screen pixels)? Each tap has
 * `radius` of slack (./attach.tsx), so two of them may sit `2 × radius` apart. */
export function isSameSpot(
  a: { x: number; y: number },
  b: { x: number; y: number },
  radius: number,
): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= 2 * radius;
}

export function createInfoState(): InfoState {
  const [hits, setHits] = createSignal<InfoHit[]>([]);
  const [index, setIndex] = createSignal(0);
  const open = createMemo(() => hits().length > 0);
  const current = createMemo(() => hits()[index()]);

  const step = (delta: number) => {
    const n = hits().length;
    if (n === 0) return;
    setIndex((i) => (i + delta + n) % n);
  };

  // One change, not two: unbatched, `current()` is for a moment the OLD index
  // into the NEW hits — a hit nobody selected, which every observer (chart
  // highlight, marker warp, `InfoProvider.selected`) then acted on.
  const replace = (next: InfoHit[]) =>
    batch(() => {
      setHits(next);
      setIndex(0);
    });

  return {
    open,
    hits,
    index,
    current,
    show(next) {
      replace(next);
    },
    probe(next, sameSpot = true) {
      // Repeat tap on the same spot: advance instead of re-showing the top.
      if (sameSpot && next.length > 0 && open() && sameHits(hits(), next)) {
        step(1);
        return;
      }
      replace(next);
    },
    select(i) {
      if (!Number.isInteger(i) || i < 0 || i >= hits().length) return;
      setIndex(i);
    },
    next: () => step(1),
    prev: () => step(-1),
    close() {
      replace([]);
    },
  };
}
