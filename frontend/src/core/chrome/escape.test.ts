/**
 * The Escape decision: which keydown is a free Escape that may close a window,
 * and that exactly one layer answers it. DOM-free — the event is a plain
 * object with the fields ./escape.ts reads (no KeyboardEvent under `bun test`).
 */

import { describe, expect, test } from "bun:test";
import { createBackStack, type HistoryLike } from "./backStack";
import { dismissOnEscape, isFreeEscape, type EscapeKeyEvent } from "./escape";

function esc(over: Partial<EscapeKeyEvent> = {}): EscapeKeyEvent & { prevented(): boolean } {
  let prevented = over.defaultPrevented ?? false;
  return {
    key: "Escape",
    target: null,
    ...over,
    get defaultPrevented() {
      return prevented;
    },
    preventDefault: () => (prevented = true),
    prevented: () => prevented,
  };
}

const NO_HISTORY: HistoryLike = { pushState() {}, back() {} };

describe("isFreeEscape", () => {
  test("a plain Escape is free; any other key is not", () => {
    expect(isFreeEscape(esc())).toBe(true);
    expect(isFreeEscape(esc({ key: "Enter" }))).toBe(false);
    expect(isFreeEscape(esc({ key: "m" }))).toBe(false);
  });

  test("already handled (defaultPrevented) — a Kobalte layer or an inline edit took it", () => {
    expect(isFreeEscape(esc({ defaultPrevented: true }))).toBe(false);
  });

  test("an IME composition owns its Escape (isComposing, or legacy keyCode 229)", () => {
    expect(isFreeEscape(esc({ isComposing: true }))).toBe(false);
    expect(isFreeEscape(esc({ keyCode: 229 }))).toBe(false);
  });

  test("auto-repeat is ignored — a held key peels one layer, not the stack", () => {
    expect(isFreeEscape(esc({ repeat: true }))).toBe(false);
  });

  test("modified Escapes belong to the browser/OS", () => {
    for (const mod of ["ctrlKey", "metaKey", "altKey", "shiftKey"] as const)
      expect(isFreeEscape(esc({ [mod]: true }))).toBe(false);
  });

  test("a field with its own Escape meaning goes first", () => {
    const field = (f: object) => esc({ target: f as unknown as EventTarget });
    // Native <select>: Escape closes its dropdown.
    expect(isFreeEscape(field({ tagName: "SELECT" }))).toBe(false);
    // A search field with text: Escape clears it; once empty it is free.
    expect(isFreeEscape(field({ tagName: "INPUT", type: "search", value: "buoy" }))).toBe(false);
    expect(isFreeEscape(field({ tagName: "INPUT", type: "search", value: "" }))).toBe(true);
    // A plain text field has no Escape meaning of its own.
    expect(isFreeEscape(field({ tagName: "INPUT", type: "text", value: "abc" }))).toBe(true);
    expect(isFreeEscape(field({ tagName: "TEXTAREA", value: "abc" }))).toBe(true);
    expect(isFreeEscape(field({ tagName: "BUTTON" }))).toBe(true);
  });
});

describe("dismissOnEscape", () => {
  test("a free Escape closes the top layer and claims the event", () => {
    const e = esc();
    let calls = 0;
    expect(dismissOnEscape(e, () => (calls++, true))).toBe(true);
    expect(calls).toBe(1);
    expect(e.prevented()).toBe(true);
  });

  test("nothing open: the event is left alone", () => {
    const e = esc();
    expect(dismissOnEscape(e, () => false)).toBe(false);
    expect(e.prevented()).toBe(false);
  });

  test("a claimed / composing / non-Escape key never reaches the stack", () => {
    let calls = 0;
    const dismissTop = () => (calls++, true);
    expect(dismissOnEscape(esc({ defaultPrevented: true }), dismissTop)).toBe(false);
    expect(dismissOnEscape(esc({ isComposing: true }), dismissTop)).toBe(false);
    expect(dismissOnEscape(esc({ key: "a" }), dismissTop)).toBe(false);
    expect(calls).toBe(0);
  });

  test("against a real stack: one press = one layer, topmost first, down to nothing", () => {
    const bs = createBackStack(NO_HISTORY);
    const log: string[] = [];
    const panel = bs.register(() => (log.push("panel"), panel.close()));
    const popup = bs.register(() => (log.push("popup"), popup.close()));

    expect(dismissOnEscape(esc(), bs.dismissTop)).toBe(true);
    expect(log).toEqual(["popup"]);
    expect(dismissOnEscape(esc(), bs.dismissTop)).toBe(true);
    expect(log).toEqual(["popup", "panel"]);
    // Bare chart: Escape is nobody's, and is not swallowed.
    const last = esc();
    expect(dismissOnEscape(last, bs.dismissTop)).toBe(false);
    expect(last.prevented()).toBe(false);
  });

  test("the claim stops a second handler on the same event double-closing", () => {
    const bs = createBackStack(NO_HISTORY);
    const log: string[] = [];
    const under = bs.register(() => (log.push("under"), under.close()));
    const top = bs.register(() => (log.push("top"), top.close()));
    const e = esc();
    dismissOnEscape(e, bs.dismissTop);
    dismissOnEscape(e, bs.dismissTop); // e.g. the element handler, then the window's
    expect(log).toEqual(["top"]);
  });
});
