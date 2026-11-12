/**
 * Area interiors are tap targets (user: "if a area is drawn then clicking
 * anywhere in that area should show it in the list, maybe not first but it
 * should be there").
 *
 * The invariant is pinned over the WHOLE generated style, by evaluating the
 * style's real filters with MapLibre's own filter compiler — not by naming
 * the classes that were broken (RESARE & co.), because the failure to guard
 * against is the NEXT outline-only class someone adds.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { featureFilter } from "@maplibre/maplibre-gl-style-spec";
import type { ExpressionSpecification as Expr, LayerSpecification } from "maplibre-gl";
import type { ChartSet } from "../catalog";
import {
  AREA_HIT_SUFFIX,
  AREA_LABEL_POINT_CLASSES,
  areaHitFilter,
  foldGeometryType,
  hasUnfoldableGeometryType,
  isAreaHitLayerId,
  NEVER_AREA_SOURCE_LAYERS,
} from "./areaHit";
import { line, point, poly, scaminVisible } from "./expr";
import { DEFAULT_ENC_GROUPS, type EncGroupsState } from "./encGroups";
import { DEFAULT_SETTINGS, type ChartSettings } from "./settings";

// chartStyle reads `location.origin` for the tile URLs
(globalThis as { location?: unknown }).location = { origin: "http://localhost" };
const { chartSetLayers, styledSourceLayers } = await import("./chartStyle");

/** A set advertising every class the generator styles — so every layer the
 * generator can emit, it does. */
const everything: ChartSet = {
  id: "all",
  name: "everything",
  bounds: [0, 0, 1, 1],
  min_zoom: 0,
  max_zoom: 16,
  sequence: 1,
  tiles: "/tiles/all/{z}/{x}/{y}",
  vector_layers: [...styledSourceLayers()].map((id) => ({ id, minzoom: 0, maxzoom: 16, fields: {} })),
};

function layersFor(settings: ChartSettings = DEFAULT_SETTINGS): LayerSpecification[] {
  return chartSetLayers(everything, settings).map((p) => p.layer);
}

const sourceLayerOf = (l: LayerSpecification) => (l as { "source-layer": string })["source-layer"];
const visible = (l: LayerSpecification) =>
  (l as { layout?: { visibility?: string } }).layout?.visibility !== "none";

const POLYGON = 3;
const POINT = 1;

function passes(l: LayerSpecification, type: number, props: Record<string, unknown>, zoom = 16) {
  const filter = (l as { filter?: Expr }).filter;
  if (!filter) return true;
  return featureFilter(filter as never).filter({ zoom } as never, { type, properties: props } as never);
}

/** Attributes any chart layer's filter keys "is this drawn" on. Each is tried
 * alone, plus none and all — enough to flip every `has`/`==` gate both ways. */
const GATE_PROPS: Record<string, unknown> = {
  sym: "x", sym_cs: "x", sym_s: "x", sym_pos: "x", sym_star: "x", sym_extra: "x",
  txt: "x", lc: "x", litdsn: "x", OBJNAM: "x", NOBJNM: "x", snd: true, fill: "chbrn",
  DEPTH: 5, VALSOU: 5,
};
const PROP_CASES: Record<string, unknown>[] = [
  {},
  GATE_PROPS,
  ...Object.entries(GATE_PROPS).map(([k, v]) => ({ [k]: v })),
];

/** Is a polygon of `cls` DRAWN by this style — filled, stroked, a symbol
 * placed on it, or (label-point classes) a symbol on its derived Point? */
function drawn(layers: LayerSpecification[], cls: string, props: Record<string, unknown>, zoom = 16) {
  return layers.some((l) => {
    if (sourceLayerOf(l) !== cls || !visible(l) || isAreaHitLayerId(l.id)) return false;
    if (passes(l, POLYGON, props, zoom)) return true;
    return (
      (l.type === "symbol" || l.type === "circle") &&
      AREA_LABEL_POINT_CLASSES.has(cls) &&
      passes(l, POINT, props, zoom)
    );
  });
}

/** Does a tap INSIDE a polygon of `cls` hit something — any visible fill
 * (real paint or the invisible tap target) that admits the polygon? */
function interiorHittable(
  layers: LayerSpecification[],
  cls: string,
  props: Record<string, unknown>,
  zoom = 16,
) {
  return layers.some(
    (l) => sourceLayerOf(l) === cls && l.type === "fill" && visible(l) && passes(l, POLYGON, props, zoom),
  );
}

const groups = (patch: Partial<Record<keyof EncGroupsState, boolean>>): ChartSettings => ({
  ...DEFAULT_SETTINGS,
  encGroups: Object.fromEntries(
    Object.entries(DEFAULT_ENC_GROUPS).map(([id, s]) => [
      id,
      { ...s, visible: patch[id as keyof EncGroupsState] ?? s.visible },
    ]),
  ) as EncGroupsState,
});

const SETTINGS_CASES: [string, ChartSettings][] = [
  ["default", DEFAULT_SETTINGS],
  ["boundaries/lines hidden", groups({ lines: false })],
  ["fills hidden", groups({ fills: false })],
  ["symbols hidden", groups({ aids: false })],
  ["lines + symbols hidden", groups({ lines: false, aids: false })],
  ["everything hidden", groups({ fills: false, lines: false, soundings: false, aids: false })],
  ["lights + text off", { ...DEFAULT_SETTINGS, showLights: false, showText: false }],
];

describe("THE invariant: a drawn chart area answers a tap anywhere inside it", () => {
  for (const [name, settings] of SETTINGS_CASES) {
    test(`drawn ⇔ interior-hittable, every styled class (${name})`, () => {
      const layers = layersFor(settings);
      const classes = new Set(layers.map(sourceLayerOf));
      expect(classes.size).toBeGreaterThan(40);
      const broken: string[] = [];
      for (const cls of classes) {
        // point-/line-only classes: no polygon exists to be drawn or tapped
        if (NEVER_AREA_SOURCE_LAYERS.has(cls)) continue;
        for (const props of PROP_CASES) {
          const d = drawn(layers, cls, props);
          const h = interiorHittable(layers, cls, props);
          // d && !h: the reported bug (drawn, interior dead).
          // !d && h: a phantom — an area nothing draws would answer a tap.
          if (d !== h) broken.push(`${cls} ${JSON.stringify(props)}: drawn=${d} hittable=${h}`);
        }
      }
      expect(broken).toEqual([]);
    });
  }

  test("SCAMIN: an area decluttered away at this zoom is not a tap target either", () => {
    const layers = layersFor();
    // 1:20 000 SCAMIN: visible at z16, gone at z8.
    const props = { ...GATE_PROPS, scamin: 20000 };
    for (const cls of new Set(layers.map(sourceLayerOf))) {
      if (!interiorHittable(layers, cls, props, 16)) continue;
      const d = drawn(layers, cls, props, 8);
      const h = interiorHittable(layers, cls, props, 8);
      expect(`${cls} z8 drawn=${d} hittable=${h}`).toBe(`${cls} z8 drawn=${d} hittable=${d}`);
    }
    // and the reported class really does gate, rather than vacuously agreeing
    expect(interiorHittable(layers, "RESARE", props, 16)).toBe(true);
    expect(interiorHittable(layers, "RESARE", props, 8)).toBe(false);
  });

  test("no chart layer uses geometry-type in a way the derivation cannot resolve", () => {
    // foldGeometryType treats such a layer as drawing nothing; this is the
    // gate that makes adding one a red test instead of a dead interior.
    const offenders = layersFor()
      .filter((l) => hasUnfoldableGeometryType((l as { filter?: Expr }).filter))
      .map((l) => l.id);
    expect(offenders).toEqual([]);
  });
});

describe("the reported case and its neighbours", () => {
  const layers = layersFor();
  const hitFor = (cls: string) =>
    layers.find((l) => l.id === `chart-all-${cls.toLowerCase()}${AREA_HIT_SUFFIX}`);

  test("RESARE (boundary + centred symbol, no fill) gets an invisible interior fill", () => {
    const hit = hitFor("RESARE")!;
    expect(hit).toBeDefined();
    expect(hit.type).toBe("fill");
    // Opacity 0, NOT visibility none: MapLibre hit-tests geometry, not alpha.
    expect((hit as { paint: Record<string, unknown> }).paint).toEqual({ "fill-opacity": 0 });
    expect(visible(hit)).toBe(true);
    expect(passes(hit, POLYGON, {})).toBe(true);
    // only the polygon: its label point and any line stay with their own layers
    expect(passes(hit, POINT, {})).toBe(false);
  });

  test("every outline-only / symbol-only area class has one", () => {
    for (const cls of [
      // restricted / cautionary group — boundary only
      "RESARE", "ACHARE", "CTNARE", "MIPARE", "DMPGRD", "CBLARE", "PIPARE", "ISTZNE", "PRCARE",
      "FAIRWY", "MARCUL", "CTSARE", "FERYRT", "PILBOP",
      // boundary only
      "SBDARE", "BRIDGE",
      // centred symbol / name only
      "TSSCRS", "TSSRON", "TSSLPT", "SEAARE",
    ]) {
      expect(`${cls}: ${hitFor(cls) ? "hit layer" : "MISSING"}`).toBe(`${cls}: hit layer`);
    }
  });

  test("the point-/line-only pruning list names only classes the style really has, and prunes them", () => {
    const styled = styledSourceLayers();
    for (const cls of NEVER_AREA_SOURCE_LAYERS) {
      expect(`${cls}: ${styled.has(cls) ? "styled" : "NOT STYLED (stale entry)"}`).toBe(`${cls}: styled`);
      expect(hitFor(cls)).toBeUndefined();
    }
    // …and never an area class: each of these is area-capable in S-57.
    for (const cls of ["RESARE", "MIPARE", "SEAARE", "TSSLPT", "M_NSYS", "MORFAC", "BRIDGE", "SBDARE"]) {
      expect(NEVER_AREA_SOURCE_LAYERS.has(cls)).toBe(false);
    }
  });

  test("a class with a real fill over every polygon gets no stand-in", () => {
    for (const cls of ["DEPARE", "DRGARE", "UNSARE", "LNDARE", "TSEZNE", "LNDMRK", "SILTNK", "PRDARE", "OBSTRN", "WRECKS"]) {
      expect(`${cls}: ${hitFor(cls) ? "hit layer" : "none"}`).toBe(`${cls}: none`);
    }
  });

  test("a symbol-only area is a target only when its symbol is actually baked", () => {
    const hit = hitFor("TSSLPT")!;
    expect(passes(hit, POLYGON, { sym: "TSS-arrow" })).toBe(true);
    expect(passes(hit, POLYGON, {})).toBe(false);
    // M_NSYS: area-only, drawn only where chartcore baked a `sym_s` — on the
    // real DK set none of 1026 polygons carry one, so none may answer.
    expect(interiorHittable(layers, "M_NSYS", {})).toBe(false);
  });

  test("hiding the boundary leaves only what the centred symbol still draws", () => {
    const noLines = layersFor(groups({ lines: false }));
    expect(interiorHittable(noLines, "RESARE", { sym: "no-entry" })).toBe(true);
    expect(interiorHittable(noLines, "RESARE", {})).toBe(false);
    const nothing = layersFor(groups({ lines: false, aids: false }));
    expect(nothing.some((l) => l.id.endsWith(`resare${AREA_HIT_SUFFIX}`))).toBe(false);
  });

  test("hiding a real fill hands the interior to a stand-in while the boundary still draws", () => {
    const noFills = layersFor(groups({ fills: false }));
    expect(drawn(noFills, "PRDARE", {})).toBe(true); // its boundary
    expect(interiorHittable(noFills, "PRDARE", {})).toBe(true);
  });

  test("tap targets paint nothing, sit at the bottom, and belong to no ENC group", () => {
    const all = chartSetLayers(everything, DEFAULT_SETTINGS);
    const hits = all.filter((p) => isAreaHitLayerId(p.layer.id));
    expect(hits.length).toBeGreaterThan(15);
    expect(all.slice(0, hits.length).every((p) => isAreaHitLayerId(p.layer.id))).toBe(true);
    for (const { layer } of hits) {
      expect((layer as { paint: unknown }).paint).toEqual({ "fill-opacity": 0 });
      expect((layer as { metadata?: unknown }).metadata).toBeUndefined();
    }
  });

  test("a disabled chart set's areas are not tap targets", () => {
    const ocharts: ChartSet = { ...everything, kind: "ocharts" };
    const hit = chartSetLayers(ocharts, DEFAULT_SETTINGS, { disabledSets: ["dk"] })
      .map((p) => p.layer)
      .find((l) => l.id.endsWith(`resare${AREA_HIT_SUFFIX}`))!;
    expect(passes(hit, POLYGON, { set: "de" })).toBe(true);
    expect(passes(hit, POLYGON, { set: "dk" })).toBe(false);
  });
});

describe("foldGeometryType", () => {
  const has: Expr = ["has", "sym"];
  test("resolves the geometry clause and simplifies around it", () => {
    expect(foldGeometryType(undefined, "Polygon")).toBe(true);
    expect(foldGeometryType(poly, "Polygon")).toBe(true);
    expect(foldGeometryType(poly, "Point")).toBe(false);
    expect(foldGeometryType(["all", point, has], "Point")).toEqual(has);
    expect(foldGeometryType(["all", point, has], "Polygon")).toBe(false);
    expect(foldGeometryType(["any", line, poly], "Polygon")).toBe(true);
    expect(foldGeometryType(["!=", ["geometry-type"], "Point"], "Polygon")).toBe(true);
    expect(foldGeometryType(["!", point], "Point")).toBe(false);
    expect(foldGeometryType(has, "Polygon")).toEqual(has);
  });

  test("an unresolvable geometry-type use means 'draws nothing', never 'draws everything'", () => {
    const odd: Expr = ["match", ["geometry-type"], "Polygon", true, false];
    expect(hasUnfoldableGeometryType(odd)).toBe(true);
    expect(foldGeometryType(odd, "Polygon")).toBe(false);
    // even negated: the whole layer is dropped, not flipped to true
    expect(foldGeometryType(["!", odd], "Polygon")).toBe(false);
  });
});

describe("areaHitFilter", () => {
  const gate = scaminVisible(1);
  test("a layer's SCAMIN exemption widens only that layer's term", () => {
    const exempt: Expr = ["==", ["get", "danger"], true];
    const filter = areaHitFilter(
      "XXXXXX",
      [
        { type: "line", filter: ["all", poly, ["has", "a"]], visible: true, scaminExempt: exempt },
        { type: "line", filter: ["all", poly, ["has", "b"]], visible: true },
      ],
      gate,
    )!;
    const ok = (props: Record<string, unknown>) =>
      featureFilter(filter as never).filter({ zoom: 4 } as never, { type: POLYGON, properties: props } as never);
    // z4 is far below a 1:20 000 SCAMIN: only the exempt layer's polygons survive
    expect(ok({ a: 1, danger: true, scamin: 20000 })).toBe(true);
    expect(ok({ b: 1, danger: true, scamin: 20000 })).toBe(false);
    expect(ok({ b: 1 })).toBe(true);
  });

  test("nothing drawing the class's polygons means no layer at all", () => {
    expect(areaHitFilter("XXXXXX", [{ type: "symbol", filter: point, visible: true }], gate)).toBeUndefined();
    expect(areaHitFilter("XXXXXX", [{ type: "line", filter: line, visible: true }], gate)).toBeUndefined();
    expect(areaHitFilter("XXXXXX", [{ type: "line", filter: poly, visible: false }], gate)).toBeUndefined();
  });
});

describe("AREA_LABEL_POINT_CLASSES mirrors chartcore's wants_label_point", () => {
  const MOD_RS = join(import.meta.dir, "../../../../chartcore/src/mvt/mod.rs");

  test("class for class", () => {
    const src = readFileSync(MOD_RS, "utf8");
    const body = src.match(/fn wants_label_point\([\s\S]*?\n}\n/);
    if (!body) throw new Error(`could not locate wants_label_point in ${MOD_RS}`);
    // match-arm patterns: one or more `"ACRONM"` joined by `|`, then `=>`
    const rust = new Set<string>();
    for (const arm of body[0].matchAll(/((?:"[A-Z_0-9]+"\s*\|?\s*)+)=>/g)) {
      for (const lit of arm[1].matchAll(/"([A-Z_0-9]+)"/g)) rust.add(lit[1]);
    }
    expect(rust.size).toBeGreaterThan(10);
    expect([...AREA_LABEL_POINT_CLASSES].sort()).toEqual([...rust].sort());
  });
});
