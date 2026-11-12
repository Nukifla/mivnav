/**
 * Escape closes the info-at-point ("poi") popup — through the wiring
 * ./attach.tsx uses (`useBackDismiss(state.open, () => state.close())`), so
 * what Escape runs is `InfoState.close()`, the very call the panel's X makes.
 * That is what clears the selection: the marker and the chart highlight both
 * follow `state.current()`.
 *
 * Driven against a fake-history stack (the app singleton is an inert stub with
 * no DOM); no mock.module.
 */

import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { bindBackDismiss, createBackStack, type HistoryLike } from "../chrome/backStack";
import { dismissOnEscape, type EscapeKeyEvent } from "../chrome/escape";
import { createInfoState } from "./state";
import type { InfoHit } from "./types";

const hit = (id: string): InfoHit => ({
  providerId: "chart",
  id,
  priority: "aid",
  precision: "point",
  title: id,
});

function escapeKey(over: Partial<EscapeKeyEvent> = {}): EscapeKeyEvent {
  let prevented = over.defaultPrevented ?? false;
  return {
    key: "Escape",
    target: null,
    ...over,
    get defaultPrevented() {
      return prevented;
    },
    preventDefault: () => (prevented = true),
  };
}

function setup() {
  const calls: string[] = [];
  const history: HistoryLike = { pushState: () => calls.push("push"), back: () => calls.push("back") };
  const stack = createBackStack(history);
  const { state, dispose } = createRoot((dispose) => {
    const state = createInfoState();
    bindBackDismiss(stack, state.open, () => state.close()); // attach.tsx's line
    return { state, dispose };
  });
  return { stack, state, dispose, calls };
}

describe("Escape closes the info popup", () => {
  test("closes the panel and clears the selection, exactly as close() does", () => {
    const { stack, state, calls } = setup();
    state.show([hit("a"), hit("b")]);
    state.select(1);
    expect(state.open()).toBe(true);
    expect(stack.depth()).toBe(1);

    expect(dismissOnEscape(escapeKey(), stack.dismissTop)).toBe(true);
    expect(state.open()).toBe(false);
    expect(state.hits()).toEqual([]);
    expect(state.current()).toBeUndefined(); // what marker + highlight follow
    // Its layer is unwound through the programmatic-close path (one back()).
    expect(stack.depth()).toBe(0);
    expect(calls).toEqual(["push", "back"]);
  });

  test("the whole panel in one press — not a step through the hit list", () => {
    const { stack, state } = setup();
    state.show([hit("a"), hit("b"), hit("c")]);
    dismissOnEscape(escapeKey(), stack.dismissTop);
    expect(state.open()).toBe(false);
  });

  test("a window opened over the popup closes first; the popup on the next press", () => {
    const { stack, state } = setup();
    state.show([hit("a")]);
    let overOpen = true;
    const over = stack.register(() => ((overOpen = false), over.close()));

    dismissOnEscape(escapeKey(), stack.dismissTop);
    expect(overOpen).toBe(false);
    expect(state.open()).toBe(true);

    dismissOnEscape(escapeKey(), stack.dismissTop);
    expect(state.open()).toBe(false);
  });

  test("an Escape something else already handled leaves the popup open", () => {
    const { stack, state } = setup();
    state.show([hit("a")]);
    expect(dismissOnEscape(escapeKey({ defaultPrevented: true }), stack.dismissTop)).toBe(false);
    expect(dismissOnEscape(escapeKey({ isComposing: true }), stack.dismissTop)).toBe(false);
    expect(state.open()).toBe(true);
  });

  test("closed popup: Escape has nothing to do; a disposed panel leaves no layer behind", () => {
    const { stack, state, dispose } = setup();
    expect(dismissOnEscape(escapeKey(), stack.dismissTop)).toBe(false);
    state.show([hit("a")]);
    dispose();
    expect(stack.depth()).toBe(0);
    expect(dismissOnEscape(escapeKey(), stack.dismissTop)).toBe(false);
  });
});
