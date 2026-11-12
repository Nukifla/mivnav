// Which camera moves follow-boat (MapView.tsx) must stand down for and then
// re-anchor on. Its own module, map-free, so both MapView's tests and a
// feature's (notices' openNotice) can pin the classification without
// importing MapView. See docs/architecture/mapview-follow-boat.md.

/** A camera event as follow-boat reads it: our own moves carry `mivnavAuto`;
 * MapLibre puts `originalEvent` on most gesture-driven moves (drag, pinch,
 * zoom buttons, double-click — and on a wheel zoom only sometimes: its
 * `movestart` comes from a render frame and has none), and so does our +/-
 * key zoom. Follow-boat does not read `originalEvent` at all any more. */
export interface FollowMoveEvent {
  mivnavAuto?: boolean;
  originalEvent?: unknown;
}

/** The ONE rule for which camera moves follow-boat must neither fight nor
 * undo: every move that is not our own (`mivnavAuto`: the follow recentre,
 * the follow button's centre, `initialView.ts`) is the CREW's — whatever
 * made it. A drag, a wheel / trackpad / pinch / double-click / box zoom, the
 * zoom buttons, the +/- and arrow keys, pan inertia, and a deliberate app
 * move made on the crew's behalf (search/coordinate go-to, a notice's fit,
 * the info marker's reveal-warp). The same "not ours, so the crew's" test
 * `initialView.ts` uses to decide the camera has been claimed.
 *
 * While one is in flight `moving()` is true (the recentre stands down); its
 * `moveend` calls `onCrewMoveEnd`, where MapView re-bases the held offset on
 * where that move LEFT the boat (still in frame → adopt its new screen spot;
 * off screen → pause). So the chart is never moved back to an older offset:
 * only the follow button centres.
 *
 * It used to exempt "gesture zooms" (a move stamped `originalEvent` with no
 * `dragstart`): those kept the OLD offset, so after a zoom about the cursor
 * the next fix glided the chart back — "if i am a bit off boat center and
 * zoom or move it sometimes moves the map back to boat center". Input-
 * agnostic on purpose: the classification by `originalEvent` was what made
 * it "sometimes" and desktop-only (see mapview-follow-boat.md).
 *
 * Pure (no map), so the rule is unit-testable. */
export function createFollowMoveGate(onCrewMoveEnd: () => void) {
  let moving = false;
  // The follow button took the camera back mid-move: that move's own
  // `moveend` (MapLibre fires it as the centre's ease replaces it) must not
  // re-anchor the offset the button just reset.
  let dropped = false;
  const start = () => {
    moving = true;
    dropped = false;
  };
  return {
    moving: () => moving,
    /** Our own one-shot centre takes the camera back: whatever crew move it
     * interrupts must not re-anchor the offset it just reset. */
    cancel: () => {
      dropped = moving;
      moving = false;
    },
    dragstart: start,
    movestart: (e?: FollowMoveEvent) => {
      if (!e?.mivnavAuto) start();
    },
    moveend: (e?: FollowMoveEvent) => {
      if (e?.mivnavAuto) return; // our recentre, never the crew — no recompute
      moving = false;
      if (dropped) {
        dropped = false;
        return;
      }
      onCrewMoveEnd();
    },
  };
}

/**
 * May the follow-boat recentre move the camera on this fix? Not during a crew
 * move (it would fight the pan / go-to), not while a person is touching or
 * gesturing the chart (`core/map/userGesture.ts`: MapLibre's `easeTo` CANCELS
 * every in-flight gesture, so a recentre on each SignalK snapshot killed any
 * pinch or drag with the boat in frame — the "can't zoom when my fingers hit
 * the route / course line" bug), and not with the boat off-screen (PAUSE).
 * The next fix after the hold lifts recentres as usual.
 */
export function followMayRecentre(s: { crewMoving: boolean; userGesture: boolean; inFrame: boolean | undefined }): boolean {
  return !s.crewMoving && !s.userGesture && s.inFrame === true;
}
