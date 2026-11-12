import { describe, expect, test } from "bun:test";
import { isTypingTarget } from "./accelerators";

/** A fake `EventTarget` carrying only what `isTypingTarget` reads — there is
 * no DOM under `bun test` (modes.test.ts's note), so a real `<input>` is not
 * on offer and the check is duck-typed precisely so this stand-in works. */
const el = (props: { tagName?: string; isContentEditable?: boolean }) =>
  props as unknown as EventTarget;

describe("isTypingTarget", () => {
  test("an input is typing", () => {
    expect(isTypingTarget(el({ tagName: "INPUT" }))).toBe(true);
  });

  test("a textarea is typing", () => {
    expect(isTypingTarget(el({ tagName: "TEXTAREA" }))).toBe(true);
  });

  test("a select is typing — arrow keys change its value", () => {
    expect(isTypingTarget(el({ tagName: "SELECT" }))).toBe(true);
  });

  test("contenteditable is typing even though the tag is plain", () => {
    expect(isTypingTarget(el({ tagName: "DIV", isContentEditable: true }))).toBe(true);
  });

  test("an ordinary button or div is not typing", () => {
    expect(isTypingTarget(el({ tagName: "BUTTON" }))).toBe(false);
    expect(isTypingTarget(el({ tagName: "DIV" }))).toBe(false);
    expect(isTypingTarget(el({ tagName: "DIV", isContentEditable: false }))).toBe(false);
  });

  test("null, or a target with no tagName at all (window/document, when nothing has focus), is not typing", () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(el({}))).toBe(false);
  });
});
