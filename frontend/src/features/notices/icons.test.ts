// Notice icons: every class has a glyph, every subclass a badge mark, and the
// `icon-image` expressions only ever name an image `ensureNoticeImages`
// registers — a missing image is a blank where a warning should be.
//
// NB: run with `--conditions=browser` (`bun run test`).

import { describe, expect, test } from "bun:test";
import { createPropertyExpression, v8 } from "@maplibre/maplibre-gl-style-spec";
import type { ExpressionSpecification } from "maplibre-gl";
import { DEFAULT_SETTINGS } from "../../core/style/settings";
import MAP from "./fixtures/map.json";
import {
  NOTICE_GLYPHS,
  noticeGlyphFor,
  noticeIconExpr,
  noticeIconIdFor,
  SUB_MARK,
  subMarkFor,
} from "./icons";
import { noticesFilterOf, prepareNotices } from "./time";
import { NOTICE_CLASSES, NOTICE_SUBCLASSES, type NoticesMap } from "./types";

function evalImage(expr: ExpressionSpecification, props: Record<string, unknown>): string {
  const r = createPropertyExpression(expr, (v8 as never)["layout_symbol"]["icon-image"]);
  if (r.result === "error") throw new Error(r.value.map((e) => e.message).join("; "));
  const out = r.value.evaluate({ zoom: 12 } as never, { properties: props } as never) as unknown;
  return typeof out === "string" ? out : String((out as { name?: string }).name ?? out);
}

describe("glyph tables", () => {
  test("every contract class has a glyph; unknown falls back to `other`", () => {
    for (const cls of NOTICE_CLASSES) expect(NOTICE_GLYPHS[cls].length).toBeGreaterThan(0);
    expect(noticeGlyphFor("windfarm")).toBe(NOTICE_GLYPHS.other);
    expect(noticeGlyphFor("buoy")).toBe(NOTICE_GLYPHS.buoy);
  });

  test("every contract subclass maps to a badge mark; none/unknown → no badge", () => {
    for (const sub of NOTICE_SUBCLASSES) expect(subMarkFor(sub)).toBe(SUB_MARK[sub]);
    expect(subMarkFor(null)).toBeNull();
    expect(subMarkFor("exploded")).toBeNull();
  });
});

describe("icon-image only names images ensureNoticeIcons registers", () => {
  // `ensureNoticeIcons` registers `noticeIconIdFor(props)` for every marker
  // it is fed; the layer's expression must resolve to exactly that id.
  const prepared = prepareNotices(
    MAP as unknown as NoticesMap,
    { ...noticesFilterOf(DEFAULT_SETTINGS), noticesShowEnded: true },
    1791028800000,
  );
  const markers = prepared.features.filter((f) => f.properties.role === "point" || f.properties.role === "anchor");

  for (const palette of ["day", "dusk", "night"] as const) {
    test(palette, () => {
      for (const f of markers) {
        expect(evalImage(noticeIconExpr(palette), f.properties)).toBe(noticeIconIdFor(f.properties, palette));
      }
    });
  }

  test("an unknown class, colour key or sub still resolves the same way on both sides", () => {
    const props = { cls: "windfarm", fc: "bogus", sub: "exploded" };
    expect(evalImage(noticeIconExpr("day"), props)).toBe(noticeIconIdFor(props, "day"));
    expect(noticeIconIdFor(props, "day")).toBe("notice-other-temporary-none-day");
  });

  test("the sub badge is part of the image: same class, different sub → different image", () => {
    const a = evalImage(noticeIconExpr("day"), { cls: "light", fc: "temporary", sub: "unlit" });
    const b = evalImage(noticeIconExpr("day"), { cls: "light", fc: "temporary", sub: null });
    expect(a).toBe("notice-light-temporary-cross-day");
    expect(b).toBe("notice-light-temporary-none-day");
  });

  test("ring colour follows the family: same class, different family → different image", () => {
    const a = evalImage(noticeIconExpr("day"), { cls: "light", fc: "warning" });
    const b = evalImage(noticeIconExpr("day"), { cls: "light", fc: "permanent" });
    expect(a).not.toBe(b);
  });
});
