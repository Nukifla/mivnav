/**
 * The selection highlight: which features it selects, and when the layers exist.
 *
 * Driven against a HighlightMap-shaped double — no WebGL, no DOM, no
 * mock.module (bun shares one module registry per run and mocks leak across
 * files; nothing here needs one, because createInfoHighlight takes its map as
 * an argument, the same bargain marker.ts and MapView's wireMap strike).
 *
 * What a unit test *cannot* say is that the thing looks right or that it spans
 * a tile seam — that claim is a browser's, and experiments/infoHighlight.ts
 * makes it. This pins the rules underneath it.
 *
 * NB: needs `--conditions=browser` (the `test` script). Bare `bun test` resolves
 * solid-js's `node` export — the SSR build, whose createEffect never runs, so
 * every reactive assertion here would pass vacuously.
 */

import { describe, expect, test } from "bun:test";
import type { LayerSpecification } from "maplibre-gl";
import { createComputed, createRoot, createSignal } from "solid-js";
import { chartHitPayload, type ChartHitPayload } from "./chartProvider";
import {
  createInfoHighlight,
  FILL_OPACITY,
  highlightFilter,
  HIGHLIGHT_FILL_LAYER_ID,
  HIGHLIGHT_GLOW_LAYER_ID,
  HIGHLIGHT_LINE_LAYER_ID,
  highlightMagenta,
  highlightTarget,
} from "./highlight";
import { paletteColors, PALETTES, type Palette } from "../style/colors";
import { createInfoState } from "./state";
import type { InfoHit } from "./types";

function chartHit(id: string, payload: Partial<ChartHitPayload> = {}): InfoHit {
  return {
    providerId: "chart",
    id,
    priority: "area",
    precision: "area",
    title: "Depth area",
    payload: {
      sourceLayer: "DEPARE",
      source: "chart-DK",
      props: { drval1: 3, drval2: 6 },
      danger: false,
      rcid: 838,
      ...payload,
    } satisfies ChartHitPayload,
  };
}

const vesselHit: InfoHit = {
  providerId: "vessel",
  id: "mmsi:1",
  priority: "traffic",
  precision: "point",
  title: "Nordkap",
  lngLat: { lng: 12, lat: 55 },
};

class FakeMap {
  layers = new Map<string, LayerSpecification>();
  sources = new Set<string>(["chart-DK"]);
  /** No style object at all (before the first setStyle, after map.remove()):
   * MapLibre's layer/source calls dereference `this.style` and throw. */
  hasStyle = true;
  /** Style.loaded() is false while any source has tiles in flight, and for
   * the frame after any layer change — the style is fully usable throughout. */
  tilesLoading = false;
  private handlers: (() => void)[] = [];

  private style() {
    if (!this.hasStyle) throw new TypeError("undefined is not an object (evaluating 'this.style')");
  }
  getLayer(id: string) {
    this.style();
    return this.layers.get(id);
  }
  getSource(id: string) {
    this.style();
    return this.sources.has(id) ? {} : undefined;
  }
  addLayer(layer: LayerSpecification) {
    this.style();
    this.layers.set(layer.id, layer);
  }
  removeLayer(id: string) {
    this.style();
    this.layers.delete(id);
  }
  isStyleLoaded(): boolean | void {
    if (!this.hasStyle) return;
    return !this.tilesLoading;
  }
  on(_type: "style.load", fn: () => void) {
    this.handlers.push(fn);
  }
  off(_type: "style.load", fn: () => void) {
    this.handlers = this.handlers.filter((h) => h !== fn);
  }

  /** What setStyle(diff) does to a layer the generated style has never heard
   * of: removes it, then fires 'style.load' — synchronously, as MapLibre does
   * from inside Style.setState. */
  reStyle() {
    this.layers.clear();
    for (const fn of [...this.handlers]) fn();
  }
  get ids() {
    return [...this.layers.keys()];
  }
}

function withHighlight(
  body: (ctx: {
    state: ReturnType<typeof createInfoState>;
    map: FakeMap;
    setPalette: (p: Palette) => void;
  }) => void,
) {
  const state = createInfoState();
  const map = new FakeMap();
  const [palette, setPalette] = createSignal<Palette>("day");
  // The body runs *outside* the root, the same trap ./marker.test.ts documents:
  // Solid flushes the effects a root creates when the root's body returns, so a
  // body inside it would do all its work before the install effect had ever run
  // once — and prove nothing. Out here, every signal write flushes on its own,
  // as it does in the app.
  const dispose = createRoot((dispose) => {
    createInfoHighlight({ state, map, palette });
    return dispose;
  });
  try {
    body({ state, map, setPalette });
  } finally {
    dispose();
  }
}

describe("highlightFilter — which features are *this* object", () => {
  test("the RCID and the attributes, together", () => {
    const filter = highlightFilter(chartHitPayload(chartHit("a"))!);
    expect(filter).toEqual([
      "all",
      ["==", ["id"], 838],
      ["==", ["get", "drval1"], 3],
      ["==", ["get", "drval2"], 6],
    ]);
  });

  test("the attributes are kept as a backstop to the namespaced id", () => {
    // chartcore now namespaces the id per cell ((cell_namespace << 32) | rcid,
    // mvt::cell_namespace), so an object is unique within a merged tile without
    // the attributes. They stay because the 21-bit namespace is a hash with a
    // small residual collision chance, and because they align this predicate
    // with chartProvider `hitId` — so the filter still carries all three terms.
    const filter = highlightFilter(chartHitPayload(chartHit("a"))!) as unknown[];
    expect(filter.filter((t) => Array.isArray(t) && t[0] === "==")).toHaveLength(3);
  });

  test("no id and no attributes is no predicate, not a predicate matching everything", () => {
    // `_nodata` — the synthetic coverage-gap polygon, with no S-57 object
    // behind it. A filter of ["all"] is *true*, which would halo every gap on
    // the chart.
    expect(
      highlightFilter({ sourceLayer: "_nodata", source: "chart-DK", props: {}, danger: false }),
    ).toBeUndefined();
  });

  test("attributes alone still select, for a feature the tiler gave no id", () => {
    const filter = highlightFilter(chartHitPayload(chartHit("a", { rcid: undefined }))!);
    expect(filter).toEqual(["all", ["==", ["get", "drval1"], 3], ["==", ["get", "drval2"], 6]]);
  });

  test("many same-attribute objects under one tap: the id is the disambiguator", () => {
    // A marina's pontoon SLCONS lines share attributes (`catgeo: 2`, or
    // `CATSLC: 3, catgeo: 2`), so an attribute-only filter would light every one
    // of them. The namespaced id keys the filter on the tapped object; the shared
    // attributes only narrow the residual namespace-hash collision (see
    // `highlightFilter`). So the tapped pontoon is selected, not the whole run.
    const filter = highlightFilter(
      chartHitPayload(
        chartHit("a", { sourceLayer: "SLCONS", rcid: 8050405095244067, props: { CATSLC: 3, catgeo: 2 } }),
      )!,
    );
    expect(filter).toEqual([
      "all",
      ["==", ["id"], 8050405095244067],
      ["==", ["get", "CATSLC"], 3],
      ["==", ["get", "catgeo"], 2],
    ]);
  });
});

describe("highlightFilter — reaching a sibling copy across a cell seam (lnzwzyww)", () => {
  // A real-world object spanning two adjoining S-57 cells has one RCID-copy
  // per cell, so the namespaced id (unlike at ordinary tile seams) can never
  // equal across them by construction — two different cell namespaces make
  // two unrelated numbers. Below, a rich-enough attribute set (as a real
  // RESARE carries: CATREA, RESTRN, sym/lc/bcol/bwid/dpri — see
  // chartcore/src/derive/restricted.rs) is the only thing that *can* bridge
  // the seam, so the filter widens to match on attributes alone once there
  // are enough of them, per-`scamin` excluded (chartcore bakes a different
  // SCAMIN per cell for the same object).

  const richProps = {
    CATREA: 1,
    RESTRN: 7,
    sym: "no-entry",
    lc: "RESARE51",
    bcol: "CHMGF",
    bwid: 2,
    dpri: 6,
    scamin: 21999,
  };

  function evalFilter(filter: unknown, feature: { id?: number; properties: Record<string, unknown> }): boolean {
    const [op, ...rest] = filter as [string, ...unknown[]];
    if (op === "all") return rest.every((t) => evalFilter(t, feature));
    if (op === "any") return rest.some((t) => evalFilter(t, feature));
    if (op === "==") {
      const [lhs, rhs] = rest as [unknown[], unknown];
      const [kind, key] = lhs as [string, string | undefined];
      const actual = kind === "id" ? feature.id : feature.properties[key!];
      return actual === rhs;
    }
    throw new Error(`unhandled op ${op}`);
  }

  test("rich attributes (>=3, minus scamin) widen the filter to an id-or-attrs OR", () => {
    const filter = highlightFilter(
      chartHitPayload(chartHit("a", { sourceLayer: "RESARE", rcid: 111, props: richProps }))!,
    );
    expect(filter).toEqual([
      "any",
      [
        "all",
        ["==", ["id"], 111],
        ["==", ["get", "CATREA"], 1],
        ["==", ["get", "RESTRN"], 7],
        ["==", ["get", "sym"], "no-entry"],
        ["==", ["get", "lc"], "RESARE51"],
        ["==", ["get", "bcol"], "CHMGF"],
        ["==", ["get", "bwid"], 2],
        ["==", ["get", "dpri"], 6],
      ],
      [
        "all",
        ["==", ["get", "CATREA"], 1],
        ["==", ["get", "RESTRN"], 7],
        ["==", ["get", "sym"], "no-entry"],
        ["==", ["get", "lc"], "RESARE51"],
        ["==", ["get", "bcol"], "CHMGF"],
        ["==", ["get", "bwid"], 2],
        ["==", ["get", "dpri"], 6],
      ],
    ]);
  });

  test("that widened filter lights the tapped copy AND the neighbouring cell's copy", () => {
    const filter = highlightFilter(
      chartHitPayload(chartHit("a", { sourceLayer: "RESARE", rcid: 111, props: richProps }))!,
    )!;
    const tapped = { id: 111, properties: richProps };
    // Adjoining cell's copy: unrelated namespaced id, and its OWN scamin
    // (merge.rs: SevenCs bakes a different one per cell) — everything else
    // that describes the *charted object* agrees.
    const sibling = { id: 8_050_405_095_244_067, properties: { ...richProps, scamin: 17999 } };
    // An unrelated RESARE elsewhere that merely shares the class but not the
    // attributes must NOT light up.
    const unrelated = { id: 222, properties: { ...richProps, CATREA: 27 } };
    expect(evalFilter(filter, tapped)).toBe(true);
    expect(evalFilter(filter, sibling)).toBe(true);
    expect(evalFilter(filter, unrelated)).toBe(false);
  });

  test("thin attributes (below the bar) stay id-anchored — no map-wide widening", () => {
    // A plain DEPARE's two depth values are not enough to trust as an
    // identity on their own (they recur constantly across a chart), so the
    // default two-attribute fixture must NOT gain an OR-branch: doing so
    // would highlight every same-band depth area in view, not just the
    // tapped one's cross-cell siblings.
    const filter = highlightFilter(chartHitPayload(chartHit("a"))!);
    expect(filter).toEqual([
      "all",
      ["==", ["id"], 838],
      ["==", ["get", "drval1"], 3],
      ["==", ["get", "drval2"], 6],
    ]);
  });
});

describe("highlightTarget", () => {
  test("a chart hit names its source and its class", () => {
    expect(highlightTarget(chartHit("a"))).toMatchObject({
      source: "chart-DK",
      sourceLayer: "DEPARE",
    });
  });

  test("a hit that is not the chart provider's has nothing to outline", () => {
    // Routed on providerId, like every lookup in the seam — a vessel is a point
    // with no extent and no chart source, and it is already marked.
    expect(highlightTarget(vesselHit)).toBeUndefined();
    expect(highlightTarget(undefined)).toBeUndefined();
  });

  test("a merged Depth hit outlines the primary band, ignoring its components", () => {
    // The composite Depth hit's payload IS the primary area's, with a
    // `components` array bolted on (the folded-in contours). ./highlight.ts
    // reads only the primary — the band the mariner is standing in — so the
    // wash and glow trace the DEPARE polygon, not the contour lines.
    const merged = chartHit("depth", {
      components: [
        { sourceLayer: "DEPCNT", source: "chart-DK", props: { VALDCO: 6 }, danger: false, rcid: 20 },
      ],
    });
    expect(highlightTarget(merged)).toMatchObject({ source: "chart-DK", sourceLayer: "DEPARE" });
    // The filter keys on the primary band's id + attrs — no contour term leaks in.
    const filter = highlightFilter(chartHitPayload(merged)!) as unknown[];
    expect(filter).toContainEqual(["==", ["id"], 838]);
    expect(JSON.stringify(filter)).not.toContain("VALDCO");
  });
});

describe("createInfoHighlight — the layers track the selection", () => {
  test("nothing is installed until something is selected", () => {
    withHighlight(({ map }) => {
      expect(map.ids).toEqual([]);
    });
  });

  test("selecting a chart object installs the wash, then the glow, then the line", () => {
    // Order is the design, not an accident: the wash is bottom so the outline's
    // white halo reads over it rather than under it, and every layer selects the
    // same one object off the same source.
    withHighlight(({ state, map }) => {
      state.show([chartHit("depare")]);
      expect(map.ids).toEqual([
        HIGHLIGHT_FILL_LAYER_ID,
        HIGHLIGHT_GLOW_LAYER_ID,
        HIGHLIGHT_LINE_LAYER_ID,
      ]);
      for (const id of map.ids) {
        expect(map.getLayer(id)).toMatchObject({ source: "chart-DK", "source-layer": "DEPARE" });
      }
      expect(map.getLayer(HIGHLIGHT_FILL_LAYER_ID)!.type).toBe("fill");
      expect(map.getLayer(HIGHLIGHT_GLOW_LAYER_ID)!.type).toBe("line");
      expect(map.getLayer(HIGHLIGHT_LINE_LAYER_ID)!.type).toBe("line");
    });
  });

  test("the wash is a tint, not a cover, and has no crisp edge of its own", () => {
    // Two ways the fill could quietly become a charted fact: opaque enough to
    // replace the depth shade rather than tint it (see highlightFill.test.ts for
    // the measurement), or wearing MapLibre's 1 px `fill-outline-color`
    // hairline, which is exactly the crisp magenta chart-limit lookalike the
    // blurred glow exists to avoid.
    withHighlight(({ state, map }) => {
      state.show([chartHit("depare")]);
      const fill = map.getLayer(HIGHLIGHT_FILL_LAYER_ID) as any;
      expect(fill.paint["fill-color"]).toBe(highlightMagenta("day"));
      expect(fill.paint["fill-opacity"]).toBe(FILL_OPACITY);
      expect(fill.paint["fill-opacity"]).toBeLessThan(0.25);
      expect(fill.paint["fill-outline-color"]).toBe("rgba(0,0,0,0)");
    });
  });

  test("the wash and the outline pick out the same object", () => {
    // A wash over one polygon and an outline round another would be worse than
    // either alone. The glow and the outline share the exact selection filter;
    // the wash is that same selection ANDed with the polygon gate (so a line is
    // never earcut-filled — see the marina-basin test below), and nothing more.
    withHighlight(({ state, map }) => {
      state.show([chartHit("depare")]);
      const sel = (map.getLayer(HIGHLIGHT_LINE_LAYER_ID) as any).filter;
      expect((map.getLayer(HIGHLIGHT_GLOW_LAYER_ID) as any).filter).toEqual(sel);
      expect((map.getLayer(HIGHLIGHT_FILL_LAYER_ID) as any).filter).toEqual([
        "all",
        ["==", ["geometry-type"], "Polygon"],
        sel,
      ]);
    });
  });

  test("the wash is gated to area geometry; the marina basin line bug", () => {
    // The regression: an SLCONS run of pontoon fingers is charted as ONE
    // multi-part LINE (catgeo 2). MapLibre's fill bucket earcut-triangulates a
    // line's vertices into a filled blob, so the wash — installed for every
    // selection — painted magenta over the whole marina basin. The fill layer's
    // filter now carries `geometry-type == Polygon`, which a line cannot pass, so
    // the wash renders nothing for it; the glow and outline still trace the line
    // (they carry no such gate — a line must glow, and a polygon's boundary too).
    withHighlight(({ state, map }) => {
      state.show([
        chartHit("slcons", { sourceLayer: "SLCONS", rcid: 8050405095244067, props: { catgeo: 2 } }),
      ]);
      expect(map.ids).toEqual([
        HIGHLIGHT_FILL_LAYER_ID,
        HIGHLIGHT_GLOW_LAYER_ID,
        HIGHLIGHT_LINE_LAYER_ID,
      ]);
      const fill = (map.getLayer(HIGHLIGHT_FILL_LAYER_ID) as any).filter;
      expect(fill[0]).toBe("all");
      expect(fill).toContainEqual(["==", ["geometry-type"], "Polygon"]);
      for (const id of [HIGHLIGHT_GLOW_LAYER_ID, HIGHLIGHT_LINE_LAYER_ID]) {
        expect(JSON.stringify((map.getLayer(id) as any).filter)).not.toContain("geometry-type");
      }
    });
  });

  test("cycling moves the highlight to the selected hit, and lights only it", () => {
    withHighlight(({ state, map }) => {
      state.show([chartHit("a"), chartHit("b", { rcid: 1902, sourceLayer: "DRGARE" })]);
      expect(map.getLayer(HIGHLIGHT_LINE_LAYER_ID)).toMatchObject({ "source-layer": "DEPARE" });
      state.next();
      expect(map.ids).toEqual([
        HIGHLIGHT_FILL_LAYER_ID,
        HIGHLIGHT_GLOW_LAYER_ID,
        HIGHLIGHT_LINE_LAYER_ID,
      ]);
      const line = map.getLayer(HIGHLIGHT_LINE_LAYER_ID)!;
      expect(line).toMatchObject({ "source-layer": "DRGARE" });
      expect(line.filter).toContainEqual(["==", ["id"], 1902]);
    });
  });

  test("closing the panel clears it", () => {
    withHighlight(({ state, map }) => {
      state.show([chartHit("depare")]);
      state.close();
      expect(map.ids).toEqual([]);
    });
  });

  test("a merged Depth hit installs the area highlight and clears on close", () => {
    // The composite Depth hit (a band + its contours) must light + clear exactly
    // like a lone area — the primary is the DEPARE polygon, so the same three
    // layers select it, and closing removes them.
    withHighlight(({ state, map }) => {
      state.show([
        chartHit("depth", {
          components: [
            { sourceLayer: "DEPCNT", source: "chart-DK", props: { VALDCO: 6 }, danger: false, rcid: 20 },
          ],
        }),
      ]);
      expect(map.ids).toEqual([
        HIGHLIGHT_FILL_LAYER_ID,
        HIGHLIGHT_GLOW_LAYER_ID,
        HIGHLIGHT_LINE_LAYER_ID,
      ]);
      expect(map.getLayer(HIGHLIGHT_LINE_LAYER_ID)).toMatchObject({ "source-layer": "DEPARE" });
      state.close();
      expect(map.ids).toEqual([]);
    });
  });

  test("selecting a vessel clears the chart's highlight", () => {
    withHighlight(({ state, map }) => {
      state.show([chartHit("depare")]);
      state.show([vesselHit]);
      expect(map.ids).toEqual([]);
    });
  });

  test("a hit whose chart set is no longer in the style does not install", () => {
    // addLayer against a missing source throws. The panel can still answer from
    // the payload it captured; it just cannot point at a chart nobody draws.
    withHighlight(({ state, map }) => {
      map.sources.delete("chart-DK");
      state.show([chartHit("depare")]);
      expect(map.ids).toEqual([]);
    });
  });

  test("goes away with its owner", () => {
    const map = new FakeMap();
    const state = createInfoState();
    const dispose = createRoot((dispose) => {
      createInfoHighlight({ state, map, palette: () => "day" });
      return dispose;
    });
    state.show([chartHit("depare")]);
    expect(map.ids).toHaveLength(3);
    dispose();
    expect(map.ids).toEqual([]);
    // ...and stops answering the map, so a later 'style.load' cannot re-add it.
    map.reStyle();
    expect(map.ids).toEqual([]);
  });
});

describe("createInfoHighlight — converges while isStyleLoaded() is false", () => {
  // The flaky-highlight regression. `install` used to open with
  // `if (!map.isStyleLoaded()) return`, and Style.loaded() is false not only
  // before the style JSON arrives but whenever a source has tiles in flight
  // and for the frame after ANY layer change — including this module's own
  // addLayer, which marks the chart source for reload. In that window install
  // did nothing at all, and nothing retried: 'style.load' only fires on a
  // style (re)build. All three tests fail against that guard.
  test("a tap while tiles are loading still highlights", () => {
    withHighlight(({ state, map }) => {
      map.tilesLoading = true;
      state.show([chartHit("depare")]);
      expect(map.ids).toEqual([
        HIGHLIGHT_FILL_LAYER_ID,
        HIGHLIGHT_GLOW_LAYER_ID,
        HIGHLIGHT_LINE_LAYER_ID,
      ]);
    });
  });

  test("closing the panel while tiles are loading still clears", () => {
    withHighlight(({ state, map }) => {
      state.show([chartHit("depare")]);
      map.tilesLoading = true;
      state.close();
      expect(map.ids).toEqual([]);
    });
  });

  test("switching hits while tiles are loading moves the highlight, not strands it", () => {
    withHighlight(({ state, map }) => {
      state.show([chartHit("a"), chartHit("b", { rcid: 1902, sourceLayer: "DRGARE" }), vesselHit]);
      map.tilesLoading = true;
      state.select(1);
      const line = map.getLayer(HIGHLIGHT_LINE_LAYER_ID)!;
      expect(line).toMatchObject({ "source-layer": "DRGARE" });
      expect(line.filter).toContainEqual(["==", ["id"], 1902]);
      // ...and on to a hit with nothing to outline: the old one must come off.
      state.select(2);
      expect(map.ids).toEqual([]);
    });
  });

  test("no style at all: hands off, and 'style.load' installs once there is one", () => {
    // The one case the guard is still for — every layer call would throw.
    withHighlight(({ state, map }) => {
      map.hasStyle = false;
      expect(() => state.show([chartHit("depare")])).not.toThrow();
      map.hasStyle = true;
      expect(map.ids).toEqual([]);
      map.reStyle();
      expect(map.ids).toHaveLength(3);
    });
  });

  test("a replaced style whose JSON is still loading: waits for its 'style.load'", () => {
    // setStyle without a diff: a fresh Style, not loaded, with no layers and no
    // sources yet. The getters answer empty rather than throw, so nothing is
    // attempted, and the new style's own 'style.load' does the install.
    withHighlight(({ state, map }) => {
      map.layers.clear();
      map.sources.clear();
      map.tilesLoading = true;
      state.show([chartHit("depare")]);
      expect(map.ids).toEqual([]);
      map.sources.add("chart-DK");
      map.reStyle();
      expect(map.ids).toHaveLength(3);
    });
  });

  test("an owner disposed after the map dropped its style does not throw", () => {
    const map = new FakeMap();
    const state = createInfoState();
    const dispose = createRoot((dispose) => {
      createInfoHighlight({ state, map, palette: () => "day" });
      return dispose;
    });
    state.show([chartHit("depare")]);
    map.hasStyle = false; // map.remove() → setStyle(null)
    expect(() => dispose()).not.toThrow();
  });
});

describe("createInfoHighlight — surviving a settings change", () => {
  test("a diffing setStyle removes the layers; 'style.load' puts them back", () => {
    // The layers are not in the generated style (chartStyle.ts is a pure
    // function of catalog+settings and this is a function of the last tap), so
    // setStyle(diff) removes them. Without the re-install a settings change
    // would silently un-answer "which one?".
    withHighlight(({ state, map }) => {
      state.show([chartHit("depare")]);
      map.reStyle();
      expect(map.ids).toEqual([
        HIGHLIGHT_FILL_LAYER_ID,
        HIGHLIGHT_GLOW_LAYER_ID,
        HIGHLIGHT_LINE_LAYER_ID,
      ]);
    });
  });

  test("re-installing does not subscribe the caller to the selection", () => {
    /**
     * The regression MapView.tsx's `ensureOverlays` documents, one file over.
     * MapLibre fires 'style.load' synchronously from inside setStyle(diff), so
     * the re-install runs in the tracking scope of MapView's style effect.
     * Tracked, its read of state.current() would subscribe that effect to the
     * panel: every tap would rebuild the style, whose diff removes and re-adds
     * the SignalK sources — the symbol flash, from a new direction.
     *
     * So: run the 'style.load' handler inside a tracked computation, then
     * change the selection, and assert the computation did not re-run.
     */
    withHighlight(({ state, map }) => {
      state.show([chartHit("a")]);
      let runs = 0;
      createRoot((disposeInner) => {
        // createComputed: a tracking scope that runs eagerly, standing in for
        // MapView's style effect, which is one.
        createComputed(() => {
          runs++;
          map.reStyle(); // fires 'style.load' synchronously, as setStyle(diff) does
        });
        expect(runs).toBe(1);
        state.show([chartHit("b", { rcid: 1902 })]);
        expect(runs).toBe(1); // a tap must not rebuild the style
        disposeInner();
      });
    });
  });
});

describe("createInfoHighlight — the magenta is the THEME's, not a literal", () => {
  // The regression this exists for: `MARKER_MAGENTA = "#c800c8"` was a
  // day-palette literal that stayed day magenta under all twelve themes, and
  // the user reported it against the selected-area overlay specifically. A
  // colour equal to `paletteColors(p).CHMGD` is the whole fix; a hardcoded hex
  // would pass that assertion for exactly one palette and fail it for eleven,
  // which is what the second test below refuses to let regress silently.
  test("every theme washes and outlines in its own CHMGD", () => {
    withHighlight(({ state, map, setPalette }) => {
      state.show([chartHit("depare")]);
      for (const p of PALETTES) {
        setPalette(p);
        const fill = map.getLayer(HIGHLIGHT_FILL_LAYER_ID) as any;
        const line = map.getLayer(HIGHLIGHT_LINE_LAYER_ID) as any;
        expect(fill.paint["fill-color"], `${p} wash`).toBe(paletteColors(p).CHMGD);
        expect(line.paint["line-color"], `${p} outline`).toBe(paletteColors(p).CHMGD);
      }
    });
  });

  test("...and the themes do not all agree, so a literal cannot fake this", () => {
    // The teeth. `toBe(paletteColors(p).CHMGD)` alone is satisfiable by a
    // constant if every theme happens to share one magenta; this says they do
    // not, so the only way to pass both is to actually read the table.
    const seen = new Set<string>();
    withHighlight(({ state, map, setPalette }) => {
      state.show([chartHit("depare")]);
      for (const p of PALETTES) {
        setPalette(p);
        seen.add((map.getLayer(HIGHLIGHT_LINE_LAYER_ID) as any).paint["line-color"]);
      }
    });
    expect(seen.size).toBeGreaterThan(1);
    expect(paletteColors("night").CHMGD).not.toBe(paletteColors("day").CHMGD);
  });

  test("switching theme with a selection open repaints it — no re-tap needed", () => {
    // `install` is wrapped in `untrack`, so a read of the palette INSIDE it
    // would never re-run. The theme is a dependency of the effect's own `on`
    // instead; this is what proves that, and it is the difference between the
    // fix working and it working only for selections made after the switch.
    withHighlight(({ state, map, setPalette }) => {
      state.show([chartHit("depare")]);
      const before = (map.getLayer(HIGHLIGHT_LINE_LAYER_ID) as any).paint["line-color"];
      setPalette("night");
      const after = (map.getLayer(HIGHLIGHT_LINE_LAYER_ID) as any).paint["line-color"];
      expect(before).toBe(paletteColors("day").CHMGD);
      expect(after).toBe(paletteColors("night").CHMGD);
      // ...and still exactly one highlight, not two stacked installs.
      expect(map.ids).toEqual([
        HIGHLIGHT_FILL_LAYER_ID,
        HIGHLIGHT_GLOW_LAYER_ID,
        HIGHLIGHT_LINE_LAYER_ID,
      ]);
    });
  });
});
