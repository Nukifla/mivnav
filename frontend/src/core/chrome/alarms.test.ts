import { describe, expect, test } from "bun:test";
import { audibleAlerts, rearm, visibleAlerts } from "./alarms";
import type { Alert } from "./registry";

const alert = (id: string): Alert => ({ id, title: `⚠ ${id}`, detail: "detail" });

const DEPTH = alert("depth.belowKeel");
const CPA = alert("ais.cpa");

describe("visibleAlerts", () => {
  test("everything firing is shown when nothing is acknowledged", () => {
    expect(visibleAlerts([DEPTH, CPA], new Set())).toEqual([DEPTH, CPA]);
  });

  test("an acknowledged alarm is hidden; the others are not", () => {
    expect(visibleAlerts([DEPTH, CPA], new Set(["depth.belowKeel"]))).toEqual([CPA]);
  });

  test("acknowledging everything empties the strip", () => {
    expect(visibleAlerts([DEPTH, CPA], new Set(["depth.belowKeel", "ais.cpa"]))).toEqual([]);
  });

  test("firing order is preserved: nothing here re-ranks (invariant #4)", () => {
    expect(visibleAlerts([CPA, DEPTH], new Set()).map((a) => a.id)).toEqual(["ais.cpa", "depth.belowKeel"]);
  });
});

describe("rearm — an ack dismisses one EVENT, not one instrument for ever", () => {
  test("an ack survives while its alarm is still firing", () => {
    expect([...rearm([DEPTH], new Set(["depth.belowKeel"]))]).toEqual(["depth.belowKeel"]);
  });

  /**
   * ⚠️ The bug this whole set-of-ids design exists to prevent. Acknowledge a
   * shallow sounding, sail into deep water, sail back into the shallows: with a
   * boolean "acked" flag the second alarm never shows. The condition ending is
   * the only thing that clears an ack — there is no timer and no snooze,
   * because the only thing that should stop an alarm coming back is the danger
   * going away.
   */
  test("an alarm that clears re-arms itself, with no action from anyone", () => {
    const acked = rearm([DEPTH], new Set(["depth.belowKeel"]));
    const cleared = rearm([], acked);
    expect([...cleared]).toEqual([]);
    // ...and when it fires again, it is shown.
    expect(visibleAlerts([DEPTH], cleared)).toEqual([DEPTH]);
  });

  test("clearing one alarm does not re-arm another that is still firing", () => {
    const acked = new Set(["depth.belowKeel", "ais.cpa"]);
    expect([...rearm([CPA], acked)]).toEqual(["ais.cpa"]);
  });

  test("never invents an ack for an alarm nobody acknowledged", () => {
    expect([...rearm([DEPTH, CPA], new Set())]).toEqual([]);
  });

  test("does not mutate the set it is given", () => {
    const acked = new Set(["depth.belowKeel"]);
    rearm([], acked);
    expect([...acked]).toEqual(["depth.belowKeel"]);
  });
});

describe("audibleAlerts", () => {
  test("a MUTE quiets an alarm without hiding it", () => {
    expect(visibleAlerts([DEPTH, CPA], new Set())).toEqual([DEPTH, CPA]);
    expect(audibleAlerts([DEPTH, CPA], new Set(["ais.cpa"]))).toEqual([DEPTH]);
  });

  test("silenced at the source (SignalK, by anyone) is quiet here too", () => {
    const silenced = { ...CPA, silenced: true };
    expect(audibleAlerts([DEPTH, silenced], new Set())).toEqual([DEPTH]);
  });
});
