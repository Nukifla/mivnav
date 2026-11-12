import { describe, expect, test } from "bun:test";
import { createPropertyExpression, latest } from "@maplibre/maplibre-gl-style-spec";
import { stationsSymbolLayers } from "./stations";
import { paletteColors } from "./colors";
import type { AddLayer, ChartLayer } from "./expr";
import { DEFAULT_SETTINGS } from "./settings";

// RDOCAL's COMCHA channel number, drawn inside the VHF symbol's circle.
// Since jt task ompyzypv, chartcore anchors free-standing artwork at its
// canvas centre, so VHF packs at native 16x40 and the pivot MapLibre puts on
// the feature point is (8, 20) — exactly the circle centre (stations.ts has
// the derivation). The number therefore takes NO offset at any bearing, and
// the 15°-spaced rotating offset table that compensated for the old
// bottom-centre pivot is gone. These tests pin its absence.

function rdocalLayers(): ChartLayer[] {
  const layers: ChartLayer[] = [];
  const add: AddLayer = (_prio, sl, l) => {
    if (sl === "RDOCAL") layers.push(l);
  };
  stationsSymbolLayers(add, "chart", DEFAULT_SETTINGS);
  return layers;
}

function layerById(id: string): ChartLayer {
  const l = rdocalLayers().find((x) => x.id === id);
  if (!l) throw new Error(`no ${id} layer`);
  return l;
}
const channelLayer = (): ChartLayer => layerById("chart-rdocal-pt-channel");
const lineChannelLayer = (): ChartLayer => layerById("chart-rdocal-line-channel");

function evaluate(expr: unknown, specKey: string, props: Record<string, unknown>): unknown {
  const spec = (latest as Record<string, Record<string, unknown>>)["layout_symbol"][specKey];
  const r = createPropertyExpression(expr as never, spec as never);
  if (r.result === "error") throw new Error(r.value.map((e) => e.message).join("; "));
  return r.value.evaluate({ zoom: 12 } as never, { properties: props } as never);
}

/** The offset the layer ACTUALLY places the number at, for the given feature
 * properties — the declared `text-offset` if there is one, else MapLibre's
 * own default. Written to survive the property being absent, which is the
 * point: an absent `text-offset` and a declared `[0, 0]` place identically,
 * and the tests below pin both the placement and the absence. */
const offsetFor = (props: Record<string, unknown>): number[] => {
  const declared = channelLayer().layout!["text-offset"];
  if (declared === undefined) return [0, 0];
  return evaluate(declared, "text-offset", props) as number[];
};
/** `text-field` evaluates to a `Formatted`, not a string — read its one
 * section back out. */
const textAt = (props: Record<string, unknown>) =>
  String(evaluate(channelLayer().layout!["text-field"], "text-field", props));

describe("RDOCAL channel number: which features get one", () => {
  test("each geometry's channel layer follows the icon layer it draws on top of", () => {
    const ids = rdocalLayers().map((l) => l.id);
    expect(ids).toEqual([
      "chart-rdocal-pt-sym",
      "chart-rdocal-pt-channel",
      "chart-rdocal-line-sym",
      "chart-rdocal-line-channel",
    ]);
  });

  test("sym == VHF only, per geometry — the RCLDEF01 fallback has no circle", () => {
    expect(channelLayer().filter).toEqual([
      "all",
      ["==", ["geometry-type"], "Point"],
      ["==", ["get", "sym"], "VHF"],
    ]);
    expect(lineChannelLayer().filter).toEqual([
      "all",
      ["==", ["geometry-type"], "LineString"],
      ["==", ["get", "sym"], "VHF"],
    ]);
  });

  test("it draws no icon of its own and paints the palette's CHMGD", () => {
    const l = channelLayer();
    expect(l.layout).not.toHaveProperty("icon-image");
    expect(l.paint!["text-color"]).toBe(paletteColors(DEFAULT_SETTINGS.palette).CHMGD);
    expect(l.layout!["text-size"]).toBe(13);
  });
});

describe("RDOCAL channel number: it sits ON the pivot, which IS the circle centre", () => {
  // The pivot is the circle centre, so the number is centred in the circle at
  // EVERY bearing — no rotation compensation, no offset. Sweeping bearings is
  // the whole point: the deleted table existed only to vary with ORIENT.
  test.each([0, 45, 90, 137, 180, 270, 359, 360, 370, -90, 720, -0.5])(
    "ORIENT %p places the number at [0, 0]",
    (orient) => {
      const [x, y] = offsetFor({ ORIENT: orient });
      expect(x).toBeCloseTo(0, 6);
      expect(y).toBeCloseTo(0, 6);
    },
  );

  test("a missing ORIENT is centred too", () => {
    const [x, y] = offsetFor({});
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(0, 6);
  });

  test("no `text-offset` is declared at all — a near-zero one would not do", () => {
    // Absent, not [0, 0]: an offset expression that merely evaluates near
    // zero would pass the sweep above, and would be the retune this fix
    // deliberately is not.
    expect(channelLayer().layout).not.toHaveProperty("text-offset");
  });

  test("no `text-anchor` either — a zero offset only centres from the centre", () => {
    // `text-anchor: "top"` with no offset would drop the digits below the
    // circle centre while every other assertion here still passed. The
    // default is "center", so absence is the invariant.
    expect(channelLayer().layout).not.toHaveProperty("text-anchor");
  });

  test("the layout reads no ORIENT anywhere — stronger than any bearing sweep", () => {
    // If nothing in the layout can see ORIENT, no bearing can move the
    // number, for all bearings rather than the twelve above. This is the
    // assertion that fails loudly if the rotating offset table comes back.
    expect(JSON.stringify(channelLayer().layout)).not.toContain("ORIENT");
  });

  test("the text is not rotated with the map either, so the digits stay upright", () => {
    // `text-rotation-alignment: "map"` only ever justified itself by keeping
    // an OFFSET number inside the circle. With no offset it would just turn
    // the digits upside down for half of all bearings.
    expect(channelLayer().layout).not.toHaveProperty("text-rotation-alignment");
    expect(channelLayer().layout).not.toHaveProperty("text-rotate");
  });
});

// The Line half could not carry a number while the number was OFFSET onto the
// circle: `line-center` rotates the icon by the LINE's screen bearing and adds
// `icon-rotate` on top, and no expression can see a line's bearing. A zero
// offset is invariant under every rotation, so the centred pivot (jt task
// ompyzypv) made the two halves the same problem. (jt task qrtyurzx)
describe("RDOCAL channel number: the Line half, at the line's midpoint", () => {
  test("it places where the Line icon places, and draws no icon of its own", () => {
    const l = lineChannelLayer();
    expect(l.layout!["symbol-placement"]).toBe("line-center");
    expect(layerById("chart-rdocal-line-sym").layout!["symbol-placement"]).toBe("line-center");
    expect(l.layout).not.toHaveProperty("icon-image");
  });

  test("the digits stay upright: `viewport`, which `auto` would NOT give here", () => {
    // For any non-`point` placement MapLibre resolves `auto` to `map`, which
    // lays the digits along the line and inverts them on a westward one. This
    // is the one key that must differ from the Point layer.
    expect(lineChannelLayer().layout!["text-rotation-alignment"]).toBe("viewport");
  });

  test("no offset and no ORIENT — the same zero placement the Point half uses", () => {
    const layout = lineChannelLayer().layout!;
    expect(layout).not.toHaveProperty("text-offset");
    expect(layout).not.toHaveProperty("text-anchor");
    expect(JSON.stringify(layout)).not.toContain("ORIENT");
  });

  test("same string, same size, same colour as the Point half", () => {
    const pt = channelLayer();
    const ln = lineChannelLayer();
    expect(ln.layout!["text-field"]).toEqual(pt.layout!["text-field"]);
    expect(ln.layout!["text-size"]).toBe(pt.layout!["text-size"]);
    expect(ln.paint!["text-color"]).toBe(paletteColors(DEFAULT_SETTINGS.palette).CHMGD);
    // Never dropped for colliding with the circle it sits in.
    expect(ln.layout!["text-allow-overlap"]).toBe(true);
  });
});

describe("RDOCAL channel number: COMCHA is free text", () => {
  test("a plain channel renders as-is", () => {
    expect(textAt({ COMCHA: "16" })).toBe("16");
    expect(textAt({ COMCHA: "9" })).toBe("9");
    expect(textAt({ COMCHA: "16A" })).toBe("16A");
  });

  test("a bracketed list value is unwrapped (s57-style.json's own hedge)", () => {
    expect(textAt({ COMCHA: "[16]" })).toBe("16");
  });

  test("anything longer than 3 characters draws nothing rather than spilling out", () => {
    expect(textAt({ COMCHA: "16,71" })).toBe("");
    expect(textAt({ COMCHA: "[16,71]" })).toBe("");
    expect(textAt({ COMCHA: "call on request" })).toBe("");
  });

  test("a missing COMCHA draws nothing", () => {
    expect(textAt({})).toBe("");
  });

  test("a numeric COMCHA still stringifies", () => {
    expect(textAt({ COMCHA: 16 })).toBe("16");
  });
});
