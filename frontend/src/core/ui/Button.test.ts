import { describe, expect, test } from "bun:test";
import { buttonClass, iconButtonClass } from "./Button";
import { segmentedItemLabelClass } from "./SegmentedControl";

// The variant API of the shared button family (v1.0 plan, D2). The class string
// is a pure function, so the variant/size/tone → token mapping is asserted here
// without a DOM. These lock the exact recipes the ~70 raw buttons collapsed onto,
// so a future edit that silently restyles a variant fails the build.

describe("buttonClass", () => {
  test("defaults to a secondary sm button", () => {
    const c = buttonClass({});
    expect(c).toContain("border border-line");
    expect(c).toContain("px-2 py-1 text-xs");
    expect(c).toContain("focus-ring");
    expect(c).toContain("disabled:opacity-50");
    // sm outline is regular weight.
    expect(c).not.toContain("font-medium");
  });

  test("primary is an accent fill with on-fill text and is bold", () => {
    const c = buttonClass({ variant: "primary", size: "md" });
    expect(c).toContain("bg-accent");
    expect(c).toContain("text-accent-fg");
    expect(c).toContain("hover:bg-accent/90");
    expect(c).toContain("active:bg-accent/80");
    expect(c).toContain("font-medium");
    // md padding, no explicit text size.
    expect(c).toContain("px-3 py-1");
    expect(c).not.toContain("text-xs");
  });

  test("danger is an alarm fill; success is an ok fill; both bold even at sm", () => {
    const danger = buttonClass({ variant: "danger", size: "sm" });
    expect(danger).toContain("bg-alarm");
    expect(danger).toContain("text-accent-fg");
    expect(danger).toContain("font-medium");
    const success = buttonClass({ variant: "success", size: "sm" });
    expect(success).toContain("bg-ok");
    expect(success).toContain("font-medium");
  });

  test("tinted picks the tone's border/text/hover, notice keeping a full border", () => {
    expect(buttonClass({ variant: "tinted", tone: "accent" })).toContain("border border-accent/40");
    expect(buttonClass({ variant: "tinted", tone: "alarm" })).toContain("border border-alarm/40");
    // notice reads heavier (full-opacity border) — preserved, not flattened.
    const notice = buttonClass({ variant: "tinted", tone: "notice" });
    expect(notice).toContain("border border-notice");
    expect(notice).not.toContain("border-notice/");
    expect(notice).toContain("text-notice");
    expect(notice).toContain("hover:bg-notice/10");
  });

  test("coarse-pointer target: every size bumps its padding under a finger", () => {
    expect(buttonClass({ size: "sm" })).toContain("pointer-coarse:px-3 pointer-coarse:py-2");
    expect(buttonClass({ size: "md" })).toContain("pointer-coarse:px-4 pointer-coarse:py-2");
    expect(buttonClass({ size: "lg" })).toContain("pointer-coarse:px-4 pointer-coarse:py-2.5");
  });

  test("md/lg outline buttons are bold; caller class comes last and wins", () => {
    expect(buttonClass({ variant: "secondary", size: "md" })).toContain("font-medium");
    const c = buttonClass({ variant: "secondary", size: "sm", class: "shrink-0 font-medium" });
    expect(c.endsWith("shrink-0 font-medium")).toBe(true);
  });

  test("no raw on-fill colour class in any variant (theming gate)", () => {
    for (const variant of ["primary", "secondary", "tinted", "danger", "success"] as const) {
      const c = buttonClass({ variant, tone: "notice" });
      expect(c).not.toContain("text-white");
      expect(c).not.toContain("text-black");
    }
  });
});

describe("iconButtonClass", () => {
  test("is a touch-sized bordered box that tints accent on hover", () => {
    expect(iconButtonClass).toContain("size-7");
    expect(iconButtonClass).toContain("pointer-coarse:size-9");
    expect(iconButtonClass).toContain("border border-line");
    expect(iconButtonClass).toContain("hover:border-accent");
    expect(iconButtonClass).toContain("disabled:opacity-30");
  });
});

describe("segmentedItemLabelClass", () => {
  test("is the raised-chip-on-checked pill with a coarse-pointer height", () => {
    expect(segmentedItemLabelClass).toContain("data-[checked]:bg-chrome");
    expect(segmentedItemLabelClass).toContain("data-[checked]:font-medium");
    expect(segmentedItemLabelClass).toContain("pointer-coarse:py-2.5");
  });
});
