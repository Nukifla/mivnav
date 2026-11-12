// The follow-boat crew-move gate: which camera moves hold the recentre off
// and re-anchor it at their end — every one that is not our own. Event shapes
// are MapLibre's: our own moves carry `mivnavAuto`; gestures USUALLY carry
// `originalEvent` (a wheel zoom's movestart does not), a programmatic go-to
// neither. The gate must not care which.

import { describe, expect, test } from "bun:test";
import { createFollowMoveGate, followMayRecentre } from "./followGate";

function gate() {
  let ends = 0;
  const g = createFollowMoveGate(() => ends++);
  return { g, ends: () => ends };
}

describe("createFollowMoveGate", () => {
  test("a programmatic go-to / fit (no tag, no originalEvent) is a crew move: held, then re-anchored", () => {
    const { g, ends } = gate();
    g.movestart(undefined); // easeTo/fitBounds with no eventData
    expect(g.moving()).toBe(true);
    g.moveend(undefined);
    expect(g.moving()).toBe(false);
    expect(ends()).toBe(1);
  });

  test("a user pan is a crew move, through its inertia", () => {
    const { g, ends } = gate();
    g.movestart({ originalEvent: {} });
    g.dragstart();
    expect(g.moving()).toBe(true);
    g.moveend({ originalEvent: {} });
    expect(g.moving()).toBe(false);
    expect(ends()).toBe(1);
  });

  // "if i am a bit off boat center and zoom or move it sometimes moves the map
  // back to boat center ... it only happens on pc". A zoom stamped
  // `originalEvent` with no drag used to be exempt ("gesture zoom"): the old
  // offset was kept and the next fix glided the chart back to it. On desktop
  // that is every zoom; a phone pinch nearly always pans too, so it re-anchored.
  // The event shapes below are the ones measured in the browser
  // (experiments/followHoldOffset.ts).
  const wheel = { originalEvent: { type: "wheel" } };
  const zooms: Array<[string, Parameters<ReturnType<typeof gate>["g"]["movestart"]>[0], typeof wheel | undefined]> = [
    ["mouse wheel whose movestart came from a render frame", undefined, wheel],
    ["mouse wheel / trackpad scroll / trackpad pinch stamped at both ends", wheel, wheel],
    ["double-click, shift-drag box zoom", { originalEvent: { type: "dblclick" } }, { originalEvent: { type: "dblclick" } }],
    ["zoom button", { originalEvent: { type: "click" } }, { originalEvent: { type: "click" } }],
    ["+/- key", { originalEvent: { key: "+" } }, { originalEvent: { key: "+" } }],
    ["touch pinch with no pan in it", { originalEvent: { type: "touchmove" } }, { originalEvent: { type: "touchend" } }],
  ];
  for (const [name, start, end] of zooms)
    test(`a zoom is the crew's too, whatever made it — ${name}: held, then re-anchored`, () => {
      const { g, ends } = gate();
      g.movestart(start);
      expect(g.moving()).toBe(true); // the recentre stands down mid-zoom
      g.moveend(end);
      expect(g.moving()).toBe(false);
      expect(ends()).toBe(1); // …and the offset is re-based where it left the boat
    });

  test("a crew move's end re-anchors even when its start was never seen", () => {
    const { g, ends } = gate();
    g.moveend({ originalEvent: {} });
    expect(ends()).toBe(1);
  });

  test("our own recentre (mivnavAuto) is never the crew, even mid crew move", () => {
    const { g, ends } = gate();
    g.movestart({ mivnavAuto: true });
    expect(g.moving()).toBe(false);
    g.moveend({ mivnavAuto: true });
    expect(ends()).toBe(0);
    g.movestart(undefined);
    g.moveend({ mivnavAuto: true }); // an AUTO end can't close the crew move
    expect(g.moving()).toBe(true);
    g.moveend(undefined);
    expect(ends()).toBe(1);
  });

  test("cancel (centre on boat) drops an interrupted crew move without re-anchoring", () => {
    for (const interrupted of [undefined, { originalEvent: {} }]) {
      const { g, ends } = gate();
      g.movestart(interrupted); // a go-to, or a zoom-button ease / pan inertia
      g.cancel();
      expect(g.moving()).toBe(false);
      g.moveend(interrupted); // the interrupted move's own moveend
      expect(ends()).toBe(0);
      // …and only that one: the crew's next move re-anchors as usual.
      g.movestart({ originalEvent: {} });
      g.moveend({ originalEvent: {} });
      expect(ends()).toBe(1);
    }
  });

  test("cancel with nothing in flight swallows nothing", () => {
    const { g, ends } = gate();
    g.cancel();
    g.moveend({ originalEvent: {} });
    expect(ends()).toBe(1);
  });
});

describe("followMayRecentre", () => {
  const ok = { crewMoving: false, userGesture: false, inFrame: true };

  test("recentres on a fix with the boat in frame and nobody touching the chart", () => {
    expect(followMayRecentre(ok)).toBe(true);
  });

  test("stands down while a person is touching/gesturing — a recentre's easeTo would cancel their pinch or drag", () => {
    expect(followMayRecentre({ ...ok, userGesture: true })).toBe(false);
  });

  test("stands down for a crew move, and pauses with the boat off-screen or unknown", () => {
    expect(followMayRecentre({ ...ok, crewMoving: true })).toBe(false);
    expect(followMayRecentre({ ...ok, inFrame: false })).toBe(false);
    expect(followMayRecentre({ ...ok, inFrame: undefined })).toBe(false);
  });
});
