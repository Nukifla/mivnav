// The fallback chip's sizing rule: box and letter scale together.
//
// `chipClasses` is the string the chip's box wears — priority colour plus a
// sizing class that is either the caller's or the 15px default. This harness
// can't render a Solid component (renderToString throws under the browser
// condition), so the box+text scaling is asserted on the pure string instead,
// which is where the bug lived: the carousel strip grew the box and left the
// letter at a fixed 9px.

import { describe, expect, test } from "bun:test";
import { chipClasses } from "./HitIcon";

describe("chipClasses (the fallback chip's box + letter sizing)", () => {
  test("with no class passed, the default carries BOTH the 15px box and the 9px letter", () => {
    const cls = chipClasses("hazard");
    expect(cls).toContain("size-[15px]");
    expect(cls).toContain("text-[9px]");
    expect(cls).toContain("bg-alarm"); // priority colour still applied
  });

  test("a passed class replaces the sizing wholesale — box and letter scale together", () => {
    // What the carousel strip passes for the SELECTED hit: box and letter both
    // grow, so the chip swells in lockstep with its neighbour icons instead of
    // sitting at 15px.
    const selected = chipClasses("hazard", "shrink-0 size-7 text-[15px]");
    expect(selected).toContain("size-7");
    expect(selected).toContain("text-[15px]");
    expect(selected).not.toContain("size-[15px]"); // default box gone
    expect(selected).not.toContain("text-[9px]"); // default letter gone

    // ...and the UNSELECTED hit's smaller pair.
    const unselected = chipClasses("hazard", "shrink-0 size-5 text-[11px]");
    expect(unselected).toContain("size-5");
    expect(unselected).toContain("text-[11px]");
  });

  test("the priority colour is keyed on the band, not the size", () => {
    expect(chipClasses("aid", "size-7 text-[15px]")).toContain("bg-ok");
    expect(chipClasses("depth")).toContain("bg-fg-3");
  });
});
