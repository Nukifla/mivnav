/**
 * The ENC split into GROUPS, proved end-to-end through the style generator.
 *
 *  (a) groupForLayer maps every draw-order band to its group, and the `-snd`
 *      hazard soundings ride "Soundings" despite sharing the hazard band;
 *  (b) buildStyle stamps each chart layer with its group metadata (the runtime
 *      reorder pass reads this back);
 *  (c) a group at opacity 1 + visible emits BYTE-IDENTICAL paint — no wrapper,
 *      no visibility — so the default style is unchanged;
 *  (d) group opacity MULTIPLIES into the layer's own opacity (composing with the
 *      SCAMIN fade / land wash rather than clobbering it), and an absent key
 *      takes the group opacity directly;
 *  (e) group visibility off forces `layout.visibility: "none"`;
 *  (f) coerceEncGroups is a total field-by-field coercer.
 */

import { describe, expect, test } from "bun:test";
import type { ChartSet } from "../catalog";
import { DEFAULT_SETTINGS, type ChartSettings } from "./settings";
import {
  coerceEncGroups,
  DEFAULT_ENC_GROUPS,
  ENC_GROUP_META,
  groupForLayer,
  type EncGroupsState,
} from "./encGroups";
import { PRIO } from "./expr";

// chartStyle reads `location.origin` for the tile URLs
(globalThis as { location?: unknown }).location = { origin: "http://localhost" };
const { buildStyle } = await import("./chartStyle");

const layerIds = ["UNSARE", "DEPARE", "LNDARE", "DEPCNT", "SOUNDG", "COALNE", "OBSTRN", "LIGHTS"];
const set: ChartSet = {
  id: "dk",
  name: "Denmark",
  bounds: [8, 54, 13, 58],
  min_zoom: 0,
  max_zoom: 16,
  sequence: 1,
  tiles: "/tiles/dk/{z}/{x}/{y}.pbf",
  vector_layers: layerIds.map((id) => ({ id, minzoom: 0, maxzoom: 16, fields: {} })),
};

// OSM-on-land off, so LNDARE ships its plain fill-opacity 1 for the group to multiply.
const withGroups = (groups: EncGroupsState): ChartSettings => ({ ...DEFAULT_SETTINGS, showOsmOnLand: false, encGroups: groups });
const patch = (base: EncGroupsState, id: keyof EncGroupsState, s: Partial<{ visible: boolean; opacity: number }>): EncGroupsState => ({
  ...base,
  [id]: { ...base[id], ...s },
});

const layerOf = (settings: ChartSettings, id: string) =>
  buildStyle([set], settings).layers.find((l) => l.id === id)!;
const meta = (l: unknown) => (l as { metadata?: Record<string, unknown> }).metadata?.[ENC_GROUP_META];

describe("(a) groupForLayer", () => {
  test("bands map to the four groups", () => {
    expect(groupForLayer(PRIO.GROUP1, "chart-dk-depare")).toBe("fills");
    expect(groupForLayer(PRIO.HAZARD_FILL, "chart-dk-obstrn-fill")).toBe("fills");
    expect(groupForLayer(PRIO.CONTOUR, "chart-dk-depcnt")).toBe("lines");
    expect(groupForLayer(PRIO.COASTLINE, "chart-dk-coalne")).toBe("lines");
    expect(groupForLayer(PRIO.SOUNDING, "chart-dk-soundg")).toBe("soundings");
    expect(groupForLayer(PRIO.SYM_SEAARE, "chart-dk-seaare-name")).toBe("aids");
    expect(groupForLayer(PRIO.SYM_ATON, "chart-dk-aton")).toBe("aids");
    expect(groupForLayer(PRIO.SYM_LIGHTS, "chart-dk-lights-extra")).toBe("aids");
  });
  test("the hazard VALSOU soundings ride Soundings despite the hazard band", () => {
    expect(groupForLayer(PRIO.SYM_HAZARD, "chart-dk-obstrn-snd")).toBe("soundings");
    expect(groupForLayer(PRIO.SYM_HAZARD, "chart-dk-obstrn-sym")).toBe("aids");
  });
  test("the debug band is ungrouped", () => {
    expect(groupForLayer(PRIO.DEBUG, "chart-dk-x")).toBeNull();
  });
});

describe("(b) buildStyle stamps the group metadata", () => {
  test("chart layers carry their group id", () => {
    expect(meta(layerOf(DEFAULT_SETTINGS, "chart-dk-depare"))).toBe("fills");
    expect(meta(layerOf(DEFAULT_SETTINGS, "chart-dk-soundg"))).toBe("soundings");
    expect(meta(layerOf(DEFAULT_SETTINGS, "chart-dk-coalne"))).toBe("lines");
  });
});

describe("(c) opacity 1 + visible is byte-identical", () => {
  test("the DEPARE fill paint is untouched (no fill-opacity added)", () => {
    const paint = (layerOf(DEFAULT_SETTINGS, "chart-dk-depare") as { paint: Record<string, unknown> }).paint;
    expect("fill-opacity" in paint).toBe(false);
    expect(Object.keys(paint)).toEqual(["fill-color"]);
  });
  test("no chart layer is hidden by a default group", () => {
    const layers = buildStyle([set], DEFAULT_SETTINGS).layers.filter((l) => l.id.startsWith("chart-dk-"));
    for (const l of layers) {
      const vis = (l as { layout?: Record<string, unknown> }).layout?.visibility;
      // DEPCNT etc. never carry a `none`; only the setting-gated ones might, and
      // all those settings are ON in DEFAULT_SETTINGS.
      expect(vis === "none").toBe(false);
    }
  });
});

describe("(d) group opacity multiplies, composing with existing paint", () => {
  test("an absent opacity key takes the group opacity directly (DEPARE)", () => {
    const s = withGroups(patch(DEFAULT_ENC_GROUPS, "fills", { opacity: 0.5 }));
    const paint = (layerOf(s, "chart-dk-depare") as { paint: Record<string, unknown> }).paint;
    expect(paint["fill-opacity"]).toBe(0.5);
  });
  test("a present numeric opacity is multiplied, not clobbered (LNDARE fill-opacity 1)", () => {
    const s = withGroups(patch(DEFAULT_ENC_GROUPS, "fills", { opacity: 0.5 }));
    const paint = (layerOf(s, "chart-dk-lndare") as { paint: Record<string, unknown> }).paint;
    // LNDARE ships fill-opacity 1 (showOsmOnLand off) — the group multiplies in.
    expect(paint["fill-opacity"]).toEqual(["*", 0.5, 1]);
  });
  test("a soundings opacity folds into the SCAMIN-fade text-opacity expression's stops", () => {
    const s = withGroups(patch(DEFAULT_ENC_GROUPS, "soundings", { opacity: 0.4 }));
    const paint = (layerOf(s, "chart-dk-soundg") as { paint: Record<string, unknown> }).paint;
    const op = paint["text-opacity"] as unknown[];
    // The soundg text-opacity is the scamin-fade interpolate, and MUST STAY a
    // top-level zoom `interpolate` — MapLibre rejects a "zoom" expression
    // nested inside another expression (e.g. `["*", 0.4, interpolate(...)]`,
    // the bug this composition order fixes: layers[N].paint.fill-opacity:
    // "zoom" expression may only be used as input to a top-level "step" or
    // "interpolate" expression). So the group opacity folds into EACH STOP's
    // output instead (scaminFadeOpacity's own `base` parameter), applied
    // BEFORE the fade is built (chartStyle.ts's `add` composes
    // applyEncGroup → withScaminFade, not the other way around).
    expect(op[0]).toBe("interpolate");
    expect(op[2]).toEqual(["zoom"]);
    for (let i = 4; i < op.length; i += 2) {
      const stopOutput = op[i] as unknown[];
      expect(stopOutput[0]).toBe("*");
      expect(stopOutput[1]).toBe(0.4);
    }
  });
});

describe("(e) group visibility off hides the whole group", () => {
  test("fills invisible forces DEPARE layout.visibility none", () => {
    const s = withGroups(patch(DEFAULT_ENC_GROUPS, "fills", { visible: false }));
    const vis = (layerOf(s, "chart-dk-depare") as { layout?: Record<string, unknown> }).layout?.visibility;
    expect(vis).toBe("none");
  });
  test("the soundings group is the SOLE gate — off hides SOUNDG and the hazard -snd", () => {
    // No `showSoundings` setting exists any more: the `enc:soundings` group
    // alone drives soundings visibility, and it reaches the cross-band `-snd`
    // hazard sounding too (groupForLayer maps it to "soundings").
    const s = withGroups(patch(DEFAULT_ENC_GROUPS, "soundings", { visible: false }));
    const soundg = (layerOf(s, "chart-dk-soundg") as { layout?: Record<string, unknown> }).layout?.visibility;
    const snd = (layerOf(s, "chart-dk-obstrn-snd") as { layout?: Record<string, unknown> }).layout?.visibility;
    expect(soundg).toBe("none");
    expect(snd).toBe("none");
  });
  test("the soundings group visible leaves SOUNDG unhidden (no setting gate remains)", () => {
    const s = withGroups(DEFAULT_ENC_GROUPS);
    const vis = (layerOf(s, "chart-dk-soundg") as { layout?: Record<string, unknown> }).layout?.visibility;
    expect(vis === "none").toBe(false);
  });
});

describe("(f) coerceEncGroups", () => {
  test("garbage → all defaults", () => {
    expect(coerceEncGroups(null)).toEqual(DEFAULT_ENC_GROUPS);
    expect(coerceEncGroups(42)).toEqual(DEFAULT_ENC_GROUPS);
  });
  test("a partial/hand-edited blob is coerced field by field, opacity clamped", () => {
    const out = coerceEncGroups({
      fills: { visible: false, opacity: 2 }, // opacity clamps to 1
      soundings: { opacity: -1 }, // clamps to 0, visible defaults true
      aids: "nonsense", // whole group defaults
    });
    expect(out.fills).toEqual({ visible: false, opacity: 1 });
    expect(out.soundings).toEqual({ visible: true, opacity: 0 });
    expect(out.aids).toEqual(DEFAULT_ENC_GROUPS.aids);
    expect(out.lines).toEqual(DEFAULT_ENC_GROUPS.lines);
  });
});
