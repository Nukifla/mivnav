// The manual route editor's gestures, as pure decisions: screen pixels in,
// effects out. No map, no DOM, no time source — the MapLibre host
// (./overlay.ts) projects the draft's points to the screen, feeds pointer
// events through `createGestureMachine`, and turns each effect into a map or
// model call. Everything that decides WHAT a touch means lives here, tested.
//
// The rules (decided with the user, 2026-11-06):
//   - A tap resolves on finger-up, and only if the pointer moved less than
//     `TAP_SLOP_PX`. Anything more is a chart pan — the editor never steals a
//     pan, so the chart moves freely while editing.
//   - Nothing is time-based: there is no hold.
//   - Only three things can be dragged: the SELECTED point (by itself or by
//     its offset grab handle, which sits clear of the finger) and a leg's
//     midpoint "+" handle (drag out a new point). An unselected point pans
//     like open water, so a brushing finger can never move one.
//   - A second finger cancels a drag (the draft snaps back) and belongs to
//     MapLibre's pinch.

/** A screen position, px, relative to the map container. */
export interface Px {
  x: number;
  y: number;
}

/** One draft waypoint, projected. In route order. */
export interface ScreenPoint extends Px {
  id: string;
}

/** Below this much movement a press is a tap; past it, a pan or a drag. */
export const TAP_SLOP_PX = 12;
/** Where the selected point's grab handle sits, relative to the point —
 * down-left, so a right-handed finger on it leaves the point itself visible. */
export const GRAB_OFFSET: Px = { x: -40, y: 40 };
/** The grab handle's hit radius. Drawn smaller; a handle is a target. */
export const GRAB_RADIUS_PX = 22;
/** A leg shorter than this on screen gets no "+" handle — it would crowd its
 * own endpoints. */
export const PLUS_MIN_LEG_PX = 60;
/** MapLibre's one-finger zoom (TapDragZoomHandler) is a tap followed, within
 * this window, by a second press that drags. Mirrors MapLibre's own constants. */
export const TAP_ZOOM_MS = 500;
export const TAP_ZOOM_PX = 30;

/** What is under a press, most specific first. `anchor` is the screen position
 * of the thing a drag would move (the POINT, even when the grab handle was
 * pressed), so a drag keeps the finger-to-point offset it started with. */
export type Hit =
  | { kind: "grab"; id: string; anchor: Px }
  | { kind: "point"; id: string; selected: boolean; anchor: Px }
  | { kind: "plus"; leg: number; anchor: Px }
  | { kind: "leg"; leg: number; foot: Px }
  | { kind: "water" };

/** Hit-test tolerances. `radius` is the pointer's tap radius
 * (`core/chrome/modes.ts` `tapRadius`), grown here per target. */
export interface HitOpts {
  radius: number;
  /** The selected point's id, if a point is selected — it alone has a grab handle. */
  selectedId: string | null;
}

const dist = (a: Px, b: Px): number => Math.hypot(a.x - b.x, a.y - b.y);

/** A point's hit radius for a pointer of tap radius `radius`: grown past the
 * bare tap radius because a point is drawn as a ~13px handle. Snapping to a
 * mark (./snap.ts) uses the same reach, so "close enough to grab" and "close
 * enough to snap" are one distance. */
export const pointHitRadius = (radius: number): number => radius + 8;

/** The grab handle's screen position for a point. */
export const grabAt = (p: Px): Px => ({ x: p.x + GRAB_OFFSET.x, y: p.y + GRAB_OFFSET.y });

/** Midpoints of the legs long enough on screen to carry a "+" handle. Leg `i`
 * runs `points[i]` → `points[i + 1]`. The overlay draws exactly these. */
export function plusHandles(points: readonly Px[]): { leg: number; at: Px }[] {
  const out: { leg: number; at: Px }[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (dist(a, b) < PLUS_MIN_LEG_PX) continue;
    out.push({ leg: i, at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } });
  }
  return out;
}

/** Foot of the perpendicular from `p` onto segment `a`→`b`, clamped, and how far off `p` is. */
export function footOnSegment(p: Px, a: Px, b: Px): { foot: Px; t: number; d: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  const foot = { x: a.x + t * dx, y: a.y + t * dy };
  return { foot, t, d: dist(p, foot) };
}

/**
 * What a press at `at` lands on. Precedence: the selected point's grab handle,
 * then the nearest point, then a "+" handle, then the nearest leg, else open
 * water. Points are grown past the bare tap radius because a point is drawn
 * as a ~13px handle; legs only a little, so a tap NEAR a line still means
 * "here", not "that leg".
 */
export function hitTest(points: readonly ScreenPoint[], at: Px, opts: HitOpts): Hit {
  const pointR = pointHitRadius(opts.radius);
  const plusR = opts.radius + 6;
  const legR = opts.radius + 2;

  if (opts.selectedId) {
    const sel = points.find((p) => p.id === opts.selectedId);
    if (sel && dist(grabAt(sel), at) <= GRAB_RADIUS_PX) {
      return { kind: "grab", id: sel.id, anchor: { x: sel.x, y: sel.y } };
    }
  }

  let best: ScreenPoint | null = null;
  let bestD = Infinity;
  for (const p of points) {
    const d = dist(p, at);
    // `<=` on ties favours the LATER point: two stacked points (a closed
    // loop's ends) select the one drawn on top.
    if (d <= pointR && d <= bestD) {
      best = p;
      bestD = d;
    }
  }
  if (best) {
    return { kind: "point", id: best.id, selected: best.id === opts.selectedId, anchor: { x: best.x, y: best.y } };
  }

  for (const h of plusHandles(points)) {
    if (dist(h.at, at) <= plusR) return { kind: "plus", leg: h.leg, anchor: h.at };
  }

  let leg: { leg: number; foot: Px; d: number } | null = null;
  for (let i = 0; i < points.length - 1; i++) {
    const f = footOnSegment(at, points[i]!, points[i + 1]!);
    if (f.d <= legR && (!leg || f.d < leg.d)) leg = { leg: i, foot: f.foot, d: f.d };
  }
  if (leg) return { kind: "leg", leg: leg.leg, foot: leg.foot };

  return { kind: "water" };
}

/** Can a press on this hit become a drag? Everything else pans. */
export const isDraggable = (h: Hit): boolean =>
  h.kind === "grab" || h.kind === "plus" || (h.kind === "point" && h.selected);

export type DragHit = Extract<Hit, { kind: "grab" | "point" | "plus" }>;

/** What the host must do. `capture` = take the press from MapLibre's pan
 * (disable dragPan); `release` = give it back. `dragMove.to` is where the
 * dragged POINT goes, already offset-corrected. */
export type Effect =
  | { type: "capture" }
  | { type: "release" }
  | { type: "tap"; hit: Hit; at: Px }
  | { type: "dragStart"; hit: DragHit }
  | { type: "dragMove"; to: Px }
  | { type: "dragEnd" }
  | { type: "dragCancel" };

export interface PressOpts {
  touch: boolean;
  /** ms, any monotonic clock — only differences are read. */
  time: number;
}

export interface GestureMachine {
  down(at: Px, hit: Hit, opts: PressOpts): Effect[];
  move(at: Px): Effect[];
  up(at: Px, opts: PressOpts): Effect[];
  /** A second finger, a cancelled touch, or the mode closing mid-press. */
  cancel(): Effect[];
  /** Is a press in flight (pressed, dragging, or panning)? */
  busy(): boolean;
}

/** Where the dragged POINT goes for a pointer at `at`: its own start position
 * plus the pointer's travel, so the grab offset is kept. */
const dragTarget = (d: { down: Px; hit: DragHit }, at: Px): Px => ({
  x: d.hit.anchor.x + (at.x - d.down.x),
  y: d.hit.anchor.y + (at.y - d.down.y),
});

type State =
  | { s: "idle" }
  | { s: "pressed"; down: Px; hit: Hit; draggable: boolean }
  | { s: "dragging"; down: Px; hit: DragHit }
  | { s: "panning" }
  | { s: "dead" };

/** One press at a time: down → (move…) → up, or a cancel. */
export function createGestureMachine(): GestureMachine {
  let st: State = { s: "idle" };
  let lastTouchUp: { time: number; at: Px } | null = null;

  const releaseIfHeld = (): Effect[] =>
    (st.s === "pressed" && st.draggable) || st.s === "dragging" ? [{ type: "release" }] : [];

  const cancel = (): Effect[] => {
    const out: Effect[] = [];
    if (st.s === "dragging") out.push({ type: "dragCancel" });
    out.push(...releaseIfHeld());
    // Dead until the last finger lifts: the fingers left behind after a pinch
    // must not turn into a tap or a pan-to-drag.
    st = st.s === "idle" ? st : { s: "dead" };
    return out;
  };

  return {
    down(at, hit, opts) {
      // A down with a press still open (a lost up): close the old one first.
      const out = st.s === "idle" || st.s === "dead" ? [] : cancel();
      // The second press of MapLibre's tap-then-drag zoom: never capture it,
      // or the zoom the crew is doing becomes a point drag. Still a tap if it
      // ends as one.
      const inTapZoom =
        opts.touch &&
        lastTouchUp !== null &&
        opts.time - lastTouchUp.time < TAP_ZOOM_MS &&
        dist(at, lastTouchUp.at) < TAP_ZOOM_PX;
      const draggable = isDraggable(hit) && !inTapZoom;
      st = { s: "pressed", down: at, hit, draggable };
      if (draggable) out.push({ type: "capture" });
      return out;
    },

    move(at) {
      if (st.s === "pressed") {
        if (dist(at, st.down) < TAP_SLOP_PX) return [];
        if (!st.draggable) {
          st = { s: "panning" };
          return [];
        }
        // The first move past the slop starts the drag AND moves it, so the
        // point is under the finger from the very first frame.
        const drag: Extract<State, { s: "dragging" }> = { s: "dragging", down: st.down, hit: st.hit as DragHit };
        st = drag;
        return [{ type: "dragStart", hit: drag.hit }, { type: "dragMove", to: dragTarget(drag, at) }];
      }
      if (st.s === "dragging") return [{ type: "dragMove", to: dragTarget(st, at) }];
      return [];
    },

    up(at, opts) {
      let out: Effect[] = [];
      if (st.s === "pressed") {
        out = releaseIfHeld();
        // The up point is checked too, not just the moves: MapLibre fires no
        // map `mousemove`/`touchmove` while its own pan runs, so a pan can
        // reach here looking like it never moved.
        if (dist(at, st.down) < TAP_SLOP_PX) out.push({ type: "tap", hit: st.hit, at });
      } else if (st.s === "dragging") {
        out = [{ type: "dragEnd" }, { type: "release" }];
      }
      st = { s: "idle" };
      if (opts.touch) lastTouchUp = { time: opts.time, at };
      return out;
    },

    cancel,

    busy: () => st.s !== "idle",
  };
}

/** Which end a NEW point joins: before the first point when the FIRST is
 * selected (and first ≠ last), else after the last. Taps and the crosshair's
 * "+ Here" share it. */
export const addsAtStart = (draft: { firstId: string | null; count: number; selectedId: string | null }): boolean =>
  draft.count >= 2 && draft.selectedId !== null && draft.selectedId === draft.firstId;

/** What a tap does to the draft. */
export type TapAction =
  | { op: "append" }
  | { op: "prepend" }
  /** Crosshair mode: open water places nothing (the "+ Here" button does) —
   * a tap there only lets go of the selection. */
  | { op: "deselect" }
  | { op: "selectPoint"; id: string }
  /** `at` is the spot on the leg "Insert here" would insert at. */
  | { op: "selectLeg"; leg: number; at: Px };

/**
 * A tap, resolved. Open water appends after the last point — or, when the
 * FIRST point is selected (and there is more than one, so first ≠ last),
 * prepends before it: selecting the start is how you extend a route
 * backwards. A tap on a "+" handle selects its leg at the midpoint. With the
 * crosshair on, open water places nothing — no accidental points.
 */
export function resolveTap(
  hit: Hit,
  draft: { firstId: string | null; count: number; selectedId: string | null; crosshair?: boolean },
): TapAction {
  switch (hit.kind) {
    case "grab":
    case "point":
      return { op: "selectPoint", id: hit.id };
    case "leg":
      return { op: "selectLeg", leg: hit.leg, at: hit.foot };
    case "plus":
      return { op: "selectLeg", leg: hit.leg, at: hit.anchor };
    case "water":
      if (draft.crosshair) return { op: "deselect" };
      return addsAtStart(draft) ? { op: "prepend" } : { op: "append" };
  }
}
