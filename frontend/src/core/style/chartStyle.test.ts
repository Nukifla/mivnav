import { describe, expect, test } from "bun:test";
import { createPropertyExpression, featureFilter, v8 } from "@maplibre/maplibre-gl-style-spec";
import type { ChartSet } from "../catalog";
import { basemapColors, PALETTES, paletteColors, S52_PALETTES } from "./colors";
import { LAND_FEATURE_WASH_OPACITY } from "./expr";
import { DEFAULT_SETTINGS } from "./settings";

// The table the styles built below are actually painted from. Was
// `S52_COLORS` (the day table) back when day was also the default palette;
// `paper2` holds the day role now (uqolozkr), so the assertions have to read
// the DEFAULT palette's table or they compare two different themes.
const S52_COLORS = paletteColors(DEFAULT_SETTINGS.palette);

// chartStyle reads `location.origin` for the tile URLs
(globalThis as { location?: unknown }).location = { origin: "http://localhost" };
const {
  buildStyle,
  chartSetLayers,
  LAND_WASH_OPACITY,
  basemapTintPaint,
  rasterPaint,
  OSM_WORLD_LAYER_IDS,
} = await import("./chartStyle");

const set: ChartSet = {
  id: "dk",
  name: "Denmark",
  bounds: [8, 54, 13, 58],
  min_zoom: 0,
  max_zoom: 16,
  sequence: 1,
  tiles: "/tiles/dk/{z}/{x}/{y}.pbf",
  vector_layers: [
    { id: "_nodata", minzoom: 0, maxzoom: 16, fields: {} },
    { id: "UNSARE", minzoom: 0, maxzoom: 16, fields: {} },
    { id: "DEPARE", minzoom: 0, maxzoom: 16, fields: {} },
  ],
};

const style = buildStyle([set], DEFAULT_SETTINGS);
const ids = style.layers.map((l) => l.id);
const layer = (id: string) => style.layers.find((l) => l.id === id)!;

describe("no-data fallback", () => {
  /**
   * THE claim of this change, and the reason it is a test rather than the
   * absence of one.
   *
   * USER, 2026-07-17, verbatim: "remove the gray hatch and no coverage
   * overlay completely to make it transparent". Where the chart set has no
   * coverage, the basemap shows through and the chart says nothing.
   *
   * This is asserted over the WHOLE style rather than by naming the two
   * layer ids that used to exist, because the failure it guards against is
   * someone adding a *third*. Every prior attempt here was individually
   * well-argued — opaque AC(NODTA), then a 0.5 wash, then the wash plus
   * AP(NODATA03) ticks when alpha alone could not separate NODTA from DEPMD
   * — and each one is exactly what a future reader reaches for after finding
   * the reasoning that is still (deliberately) in chartcore's module docs.
   * The user rejected the premise those arguments share. So: no layer of any
   * kind may name this source-layer.
   *
   * The source-layer itself is untouched — still cut, tiled, served and in
   * the catalog — so restoring the indication is adding a layer here, not
   * rebuilding the pipeline that produces the claim.
   */
  test("nothing paints the `_nodata` source-layer", () => {
    const painting = style.layers.filter(
      (l) => "source-layer" in l && l["source-layer"] === "_nodata",
    );
    expect(painting).toEqual([]);
    // and the set still advertises it: the tiles carry the layer, we choose
    // not to draw it. If this ever fails the premise moved, not the style.
    expect(set.vector_layers.map((v) => v.id)).toContain("_nodata");
  });

  /**
   * UNSARE is the deliberate other half of the split, and the reason the
   * change above is not "no-data symbology is gone from the style".
   *
   * Its lookup is literally `AC(NODTA);AP(NODATA03);LS(SOLD,2,CHGRD)` and it
   * keeps every part of it, opaque fill included. It is not the same
   * statement as `_nodata`: a cell *does* cover this water and declares
   * nobody surveyed it, which is charted content rather than an absence of
   * it, so there is nothing underneath worth uncovering and no basemap to
   * defer to. It is also now the only caller of AC(NODTA) and AP(NODATA03)
   * left in the style — the one thing that keeps the pattern alive at all.
   */
  test("unsurveyed areas are patterned but stay opaque", () => {
    const fill = (layer("chart-dk-unsare") as { paint: Record<string, unknown> }).paint;
    expect(fill["fill-color"]).toBe(S52_COLORS.NODTA);
    expect(fill["fill-opacity"]).toBeUndefined();
    const pat = (layer("chart-dk-unsare-pattern") as { paint: Record<string, unknown> }).paint;
    expect(pat["fill-pattern"]).toBe("NODATA03");
    // LS(SOLD,2,CHGRD)
    const edge = (layer("chart-dk-unsare-edge") as { paint: Record<string, unknown> }).paint;
    expect(edge["line-color"]).toBe(S52_COLORS.CHGRD);
  });

  /**
   * The tick pattern is UNSARE's alone now. Worth pinning: "is anything still
   * using it?" is what decides whether ./nodataPattern.ts (and the image
   * MapView registers from it on every `style.load`) is dead weight. It is
   * not — this is the live caller, and the only one.
   */
  test("only UNSARE is patterned", () => {
    const patterned = style.layers
      .filter((l) => "paint" in l && (l.paint as Record<string, unknown>)?.["fill-pattern"])
      .map((l) => l.id);
    expect(patterned).toEqual(["chart-dk-unsare-pattern"]);
  });

  test("the fallback sources render under the chart", () => {
    // OSM basemap below, OpenSeaMap seamarks above — the basemap is what
    // shows wherever the chart set contributes no features, which is now
    // *every* uncovered area, so this ordering carries the whole no-coverage
    // rendering rather than merely framing it. All basemap layers sit
    // together, below every chart layer.
    for (const id of OSM_WORLD_LAYER_IDS) {
      expect(ids).toContain(id);
      expect(ids.indexOf(id)).toBeLessThan(ids.indexOf("chart-dk-unsare"));
    }
    expect(ids.indexOf("chart-dk-unsare")).toBeLessThan(ids.indexOf("openseamap"));
  });

  test("the basemap layers keep their bottom-to-top order", () => {
    // earth fill, then boundaries, then roads, then place labels — a fill
    // drawn after the labels would bury them.
    const order = OSM_WORLD_LAYER_IDS.map((id) => ids.indexOf(id));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test("the background floor makes no no-data claim", () => {
    // The background is what shows for the moment every tile is in flight,
    // not just when offline. It used to be NODTA, so a routine pan flashed a
    // meaningful S-52 no-data grey over areas that have data — the `_nodata`
    // mistake one layer down. Only a producer's declaration may wear
    // AC(NODTA); an unpainted canvas is an absence of information.
    expect(ids[0]).toBe("background");
    const paint = (layer("background") as { paint: Record<string, unknown> }).paint;
    expect(paint["background-color"]).not.toBe(S52_COLORS.NODTA);
    expect(paint["background-color"]).toBe(S52_COLORS.CANVAS);
  });
});

describe("display priority", () => {
  /** Every source-layer the generator styles, plus one it does not (so the
   * debug band is exercised): a chart set that reaches every draw-order band. */
  const ALL_LAYERS = [
    "_nodata", "UNSARE", "DEPARE", "DRGARE", "LNDARE", "LNDRGN", "DEPCNT",
    "SOUNDG", "COALNE", "SLCONS", "ATON", "TOPMAR", "DAYMAR", "LIGHTS",
    "WRECKS", "OBSTRN", "UWTROC", "RESARE", "ACHARE", "CTNARE", "MIPARE",
    "DMPGRD", "UNSTYLED",
  ];
  const full = (id: string): ChartSet => ({
    ...set,
    id,
    tiles: `/tiles/${id}/{z}/{x}/{y}.pbf`,
    vector_layers: ALL_LAYERS.map((v) => ({ id: v, minzoom: 0, maxzoom: 16, fields: {} })),
  });
  const chartIds = (s: { layers: { id: string }[] }) =>
    s.layers
      .map((l) => l.id)
      .filter(
        (id) => !["background", "openseamap", ...OSM_WORLD_LAYER_IDS].includes(id),
      );

  /**
   * The refactor's safety net, and the reason it is safe at all.
   *
   * Display priority used to be prose (`-- prio 5:` comments) plus the index a
   * layer happened to land on in one array; it is now a number each layer
   * carries, and buildStyle sorts on it. The sort is stable and chartSetLayers
   * still emits in nondecreasing priority, so for ONE chart set the sort is
   * the identity and the style must be *exactly* what shipped before. This is
   * that claim, pinned to the literal sequence captured from the pre-refactor
   * generator — the thing that catches a priority transcribed onto the wrong
   * layer, which no amount of typechecking can. A diff here is either a
   * mis-transcription (fix the priority) or a deliberate S-52 order change
   * (argue for it, then update this list).
   */
  test("one chart set renders in the exact pre-refactor order", () => {
    expect(chartIds(buildStyle([full("a")], DEFAULT_SETTINGS, { debug: true }))).toEqual([
      // bottom-most, painting nothing: the interior tap targets of the
      // boundary-only area classes (./areaHit.ts — derived, see areaHit.test.ts)
      "chart-a-resare-area-hit", "chart-a-achare-area-hit", "chart-a-ctnare-area-hit",
      "chart-a-mipare-area-hit", "chart-a-dmpgrd-area-hit",
      // prio 0 — unsurveyed (`_nodata` is in the set and deliberately unpainted)
      "chart-a-unsare", "chart-a-unsare-pattern", "chart-a-unsare-edge",
      // prio 1 — group-1 fills
      "chart-a-depare", "chart-a-drgare", "chart-a-drgare-edge", "chart-a-lndare",
      // prio 4 — land points
      "chart-a-lndare-point",
      // prio 4 / 3-6 — hazard fills, restricted boundaries, hazard lines
      "chart-a-obstrn-fill", "chart-a-wrecks-fill",
      "chart-a-resare-bdy", "chart-a-achare-bdy", "chart-a-ctnare-bdy",
      "chart-a-mipare-bdy", "chart-a-dmpgrd-bdy",
      "chart-a-obstrn-line-dott", "chart-a-obstrn-line-dash",
      "chart-a-obstrn-edge-dott", "chart-a-obstrn-edge-dash", "chart-a-obstrn-edge-sold",
      "chart-a-wrecks-edge-dott", "chart-a-wrecks-edge-dash", "chart-a-wrecks-edge-sold",
      // prio 5 — contours
      "chart-a-depcnt",
      // prio 6 — soundings
      "chart-a-soundg",
      // prio 7 — coastline and shoreline constructions
      "chart-a-coalne-glow", "chart-a-coalne",
      "chart-a-slcons-fill", "chart-a-slcons",
      // prio 8 — construction points and land lines
      "chart-a-slcons-point", "chart-a-lndare-line",
      // hoisted symbols: restricted → hazards → topmar → daymar → aton → lights
      "chart-a-resare-sym", "chart-a-resare-sym-cs",
      "chart-a-achare-sym", "chart-a-achare-sym-cs",
      "chart-a-ctnare-sym", "chart-a-ctnare-sym-cs",
      "chart-a-mipare-sym", "chart-a-mipare-sym-cs",
      "chart-a-dmpgrd-sym", "chart-a-dmpgrd-sym-cs",
      "chart-a-obstrn-sym", "chart-a-uwtroc-sym",
      "chart-a-wrecks-sym",
      "chart-a-obstrn-sym-pos", "chart-a-uwtroc-sym-pos", "chart-a-wrecks-sym-pos",
      "chart-a-obstrn-snd", "chart-a-uwtroc-snd", "chart-a-wrecks-snd",
      "chart-a-topmar", "chart-a-daymar", "chart-a-aton",
      // the all-round range ring moved to the sector-lights custom layer
      // (slsynkln) — no more chart-a-lights-ring/-ring-outline JSON layers
      "chart-a-lights-sector",
      // flare/QUESMRK1 icon for a light with no sector and no range ring (yqxkluqv)
      "chart-a-lights-sym",
      // position star for the converse population — the ring-only and sector
      // lights, which draw no `sym` at all (szrwnlum)
      "chart-a-lights-star",
      "chart-a-lights-extra", "chart-a-lights-text",
      // debug view for the unstyled source-layer, above everything
      "debug-chart-a-UNSTYLED-fill", "debug-chart-a-UNSTYLED-line",
      "debug-chart-a-UNSTYLED-circle",
    ]);
  });

  /**
   * THE bug this priority model exists to kill. Layers used to be appended one
   * whole chart set at a time, so with two sets loaded, every one of set B's
   * layers sat above every one of set A's: B's opaque SEABED01 depth fill
   * painted over A's soundings, A's contours, A's hazard symbols and A's
   * lights. Roughly 45 of B's layers were above an A layer of strictly higher
   * display priority.
   *
   * S-52 display priority is a property of the feature class, not of the cell
   * it came from — the reference stable-sorts every object of every cell on
   * DPRI with cell membership no part of the key (OESUChart.cpp:898-901). So
   * the invariant is over the WHOLE style, not per set: priority never
   * decreases as you walk the chart layers upward. Set membership shows up
   * only as the tie-break inside a band.
   */
  test("priority never decreases across the whole two-set style", () => {
    const prio = new Map<string, number>();
    for (const [id, tagged] of [
      ["a", chartSetLayers(full("a"), DEFAULT_SETTINGS, { debug: true })],
      ["b", chartSetLayers(full("b"), DEFAULT_SETTINGS, { debug: true })],
    ] as const) {
      expect(id).toBeTruthy();
      for (const p of tagged) prio.set(p.layer.id, p.prio);
    }
    const style = buildStyle([full("a"), full("b")], DEFAULT_SETTINGS, { debug: true });
    const walk = chartIds(style).map((id) => ({ id, prio: prio.get(id)! }));
    const inversions = walk.filter((l, i) => i > 0 && l.prio < walk[i - 1].prio);
    expect(inversions).toEqual([]);
  });

  /** The concrete casualty, spelled out so the regression is legible without
   * reconstructing the invariant: B's opaque depth fill (prio 1) must not
   * cover A's soundings, coastline or lights. */
  test("a second chart set's depth fill cannot bury the first set's detail", () => {
    const ids = chartIds(buildStyle([full("a"), full("b")], DEFAULT_SETTINGS));
    const at = (id: string) => ids.indexOf(id);
    for (const above of ["chart-a-soundg", "chart-a-coalne", "chart-a-lights-extra"]) {
      expect(at("chart-b-depare")).toBeLessThan(at(above));
      expect(at("chart-b-unsare")).toBeLessThan(at(above));
    }
  });

  /** Sorting must not lose, duplicate or reorder a set's own layers: within a
   * band the tie-break is emission order, then `sets` order. */
  test("each set keeps its own internal order, and nothing is lost", () => {
    const one = chartIds(buildStyle([full("a")], DEFAULT_SETTINGS, { debug: true }));
    const two = chartIds(buildStyle([full("a"), full("b")], DEFAULT_SETTINGS, { debug: true }));
    expect(two).toHaveLength(one.length * 2);
    expect(new Set(two).size).toBe(two.length);
    for (const s of ["a", "b"]) {
      expect(two.filter((id) => id.includes(`-${s}-`))).toEqual(
        one.map((id) => id.replace("-a-", `-${s}-`)),
      );
    }
  });
});

describe("OSM on land", () => {
  // a set that actually has the skin of the earth and its boundary in it
  const coast: ChartSet = {
    ...set,
    vector_layers: ["_nodata", "DEPARE", "LNDARE", "COALNE", "SLCONS"].map((id) => ({
      id,
      minzoom: 0,
      maxzoom: 16,
      fields: {},
    })),
  };
  const off = buildStyle([coast], { ...DEFAULT_SETTINGS, showOsmOnLand: false });
  const on = buildStyle([coast], { ...DEFAULT_SETTINGS, showOsmOnLand: true });
  const landFill = (s: typeof off) =>
    s.layers.find((l) => l.id === "chart-dk-lndare") as { paint: Record<string, unknown> };

  test("on by default; off, land is opaque LANDA", () => {
    expect(DEFAULT_SETTINGS.showOsmOnLand).toBe(true);
    expect(landFill(off).paint).toEqual({ "fill-color": S52_COLORS.LANDA, "fill-opacity": 1 });
  });

  test("on, land is a wash — still painted by the chart, never a hole", () => {
    // The setting's entire safety argument. At alpha 0 land would fall back
    // to whatever is under it: the OSM raster if the internet happens to be
    // up, and otherwise the CANVAS background — i.e. the same colour as "no
    // chart here". LNDARE is DISPLAYBASE; land may not become legible only
    // when the boat is online. So: strictly translucent, strictly not
    // absent, and still LANDA so it reads as land with no tiles at all.
    const paint = landFill(on).paint;
    expect(paint["fill-color"]).toBe(S52_COLORS.LANDA);
    expect(paint["fill-opacity"]).toBe(LAND_WASH_OPACITY);
    expect(LAND_WASH_OPACITY).toBeGreaterThan(0);
    expect(LAND_WASH_OPACITY).toBeLessThan(1);
  });

  test("the setting hides nothing: one paint property is the whole diff", () => {
    // The strong claim. Not "the coastline is still there" (a test that
    // would pass while the setting quietly dropped the land points, or
    // reordered LNDARE under the depth shades) but: every layer, its order,
    // its filter and its paint are byte-identical between the two styles,
    // except `fill-opacity` on the one fill. So COALNE, SLCONS, the LNDARE
    // line and point primitives and every symbol above them are untouched by
    // construction — the land/water boundary cannot go missing here, and the
    // diff MapLibre applies is one setPaintProperty, not a re-layout.
    const strip = (s: typeof off) =>
      s.layers.map((l) =>
        l.id === "chart-dk-lndare"
          ? { ...l, paint: { ...(l as { paint: object }).paint, "fill-opacity": null } }
          : l,
      );
    expect(strip(on)).toEqual(strip(off));
    expect(on.layers.map((l) => l.id)).toContain("chart-dk-coalne");
    expect(on.layers.map((l) => l.id)).toContain("chart-dk-lndare-line");
  });

  test("the basemap it reveals is the one below the chart", () => {
    // No second OSM source and no hoisting: "show OSM on land" is the land
    // fill letting the existing basemap through, so the basemap must stay
    // under the chart — over it, it would bury the depth shades and every
    // symbol.
    expect(Object.keys(on.sources)).toEqual(Object.keys(off.sources));
    const ids = on.layers.map((l) => l.id);
    for (const id of OSM_WORLD_LAYER_IDS) {
      expect(ids.filter((i) => i === id)).toHaveLength(1);
      expect(ids.indexOf(id)).toBeLessThan(ids.indexOf("chart-dk-lndare"));
    }
  });
});

describe("the palette reaches the chart", () => {
  // The design's claim is that ONE field drives the chart and the chrome
  // together. The chrome half is CSS (index.css + style/palette.ts) and has no
  // DOM here to assert against; this is the chart half — that the field is
  // actually threaded through the generator rather than merely stored.
  const night = buildStyle([set], { ...DEFAULT_SETTINGS, palette: "night" });
  const nightLayer = (id: string) => night.layers.find((l) => l.id === id)!;

  test("the depth ramp is drawn from the night table, not the day one", () => {
    const ramp = JSON.stringify((nightLayer("chart-dk-depare") as { paint: unknown }).paint);
    expect(ramp).toContain(S52_PALETTES.night.DEPDW);
    expect(ramp).not.toContain(S52_PALETTES.day.DEPDW);
  });

  test("the background is the night CANVAS", () => {
    const paint = (nightLayer("background") as { paint: Record<string, unknown> }).paint;
    expect(paint["background-color"]).toBe(S52_PALETTES.night.CANVAS);
  });

  test("unsurveyed water still wears the night NODTA", () => {
    // Retargeted from `_nodata` to UNSARE: `_nodata` is no longer painted at
    // all (the user's call — no-coverage renders transparent), which leaves
    // UNSARE as the style's only caller of AC(NODTA). The claim under test is
    // unchanged: the night table, not the day one, reaches the chart.
    const paint = (nightLayer("chart-dk-unsare") as { paint: Record<string, unknown> }).paint;
    expect(paint["fill-color"]).toBe(S52_PALETTES.night.NODTA);
  });

  test("the area PATTERN name is the same on every palette", () => {
    // It used to be `dark_NODATA03` at night — one of three baked crops of
    // the raster atlas. There are no atlases left at all: every point symbol
    // is a per-key SVG chartcore serves palette-neutral and `atonIcons.ts`
    // recolours, and this `AP()` fill pattern is drawn client-side by
    // `nodataPattern.ts` (seamless tiling is a different mechanism from a
    // symbol, which is why it was last). So one name on every palette — and
    // the night tint the prefix used to carry comes back from the image
    // being re-inked in the active palette's CHGRD, not from the id.
    const night = (nightLayer("chart-dk-unsare-pattern") as { paint: Record<string, unknown> }).paint;
    const day = (layer("chart-dk-unsare-pattern") as { paint: Record<string, unknown> }).paint;
    expect(night["fill-pattern"]).toBe("NODATA03");
    expect(day["fill-pattern"]).toBe("NODATA03");
  });

  test("the vector OSM basemap paints each theme's own basemap colours", () => {
    // The single largest bright surface in the app used to be a raster
    // image dimmed by a filter; it is now real vector geometry (task
    // usvzsqzu), so "night is darker" is a per-theme colour choice
    // (`basemapColors`), not a `raster-brightness-max` filter.
    const nightRoads = (nightLayer("world-roads") as { paint: Record<string, unknown> }).paint;
    const dayRoads = (layer("world-roads") as { paint: Record<string, unknown> }).paint;
    // `layer(...)` is the DEFAULT-settings style, and the default palette is
    // `paper2` since uqolozkr — so the "day" side reads the default palette's
    // basemap colours, not literally `day`'s (which is S52-Day now).
    expect(JSON.stringify(nightRoads["line-color"])).toContain(basemapColors("night").roadMajor);
    expect(JSON.stringify(dayRoads["line-color"])).toContain(
      basemapColors(DEFAULT_SETTINGS.palette).roadMajor,
    );
    expect(nightRoads["line-color"]).not.toEqual(dayRoads["line-color"]);

    const nightPlaces = (nightLayer("world-places") as { paint: Record<string, unknown> }).paint;
    expect(nightPlaces["text-color"]).toBe(basemapColors("night").place);
    expect(nightPlaces["text-halo-color"]).toBe(basemapColors("night").placeHalo);
  });

  test("the world-context underlay paints each theme's own land/boundary colours", () => {
    const nightEarth = (nightLayer("world-earth") as { paint: Record<string, unknown> }).paint;
    const dayEarth = (layer("world-earth") as { paint: Record<string, unknown> }).paint;
    expect(nightEarth["fill-color"]).toBe(basemapColors("night").land);
    expect(dayEarth["fill-color"]).toBe(basemapColors(DEFAULT_SETTINGS.palette).land);
    expect(nightEarth["fill-color"]).not.toBe(dayEarth["fill-color"]);

    const dayBoundaries = (layer("world-boundaries") as { paint: Record<string, unknown> }).paint;
    expect(dayBoundaries["line-color"]).toBe(basemapColors(DEFAULT_SETTINGS.palette).boundary);
  });

  test("paper's OSM water (CANVAS) is white-ish, and land is sand, not the old grey", () => {
    // quznqvzm, user's ask: match the paper-chart reference (water white,
    // land a subtle sand/parchment). There is no `world-water` layer — a
    // water polygon paints the same colour as `background`, i.e. CANVAS
    // (BasemapColors' own docstring on `land`) — so "water" here means the
    // paper style's background-color, not a fill layer.
    const paperStyle = buildStyle([set], { ...DEFAULT_SETTINGS, palette: "paper" });
    const background = paperStyle.layers.find((l) => l.id === "background") as {
      paint: Record<string, unknown>;
    };
    // `#dce8fa` is rgb(220, 232, 250) — same colour, the one notation every
    // theme value uses since task zrtxyypv.
    expect(background.paint["background-color"]).toBe("#dce8fa");

    const paperEarth = paperStyle.layers.find((l) => l.id === "world-earth") as {
      paint: Record<string, unknown>;
    };
    // Sand, not the grey this used to override to.
    expect(paperEarth.paint["fill-color"]).toBe(basemapColors("paper").land);
    expect(paperEarth.paint["fill-color"]).toBe("#ddd3b8");
  });

  test("blackback's OSM land is its own muted LANDA, not DAY's bright sand on a near-black canvas", () => {
    const blackbackEarth = (
      buildStyle([set], { ...DEFAULT_SETTINGS, palette: "blackback" }).layers.find(
        (l) => l.id === "world-earth",
      ) as { paint: Record<string, unknown> }
    ).paint;
    expect(blackbackEarth["fill-color"]).toBe(basemapColors("blackback").land);
    expect(blackbackEarth["fill-color"]).not.toBe(basemapColors("day").land);
  });

  test("every palette builds a style at all", () => {
    // Cheap, but it is the test that catches a table with a hole in it: an
    // undefined colour serializes to `undefined` and MapLibre throws at
    // setStyle, i.e. at the moment the mariner flips to night at sea.
    for (const palette of PALETTES) {
      const s = buildStyle([set], { ...DEFAULT_SETTINGS, palette });
      expect(JSON.stringify(s)).not.toContain("undefined");
    }
  });

  // The bug the tests above CANNOT catch: `rasterPaint`/`basemapTintPaint`'s
  // output is well-formed JSON with well-typed numbers, so `buildStyle`
  // never emits an `undefined` and this whole file's other assertions pass —
  // but `raster-contrast: 1.15` is still an INVALID value (the property is
  // clamped to [-1, 1], not a CSS `filter: contrast()` multiplier), and a
  // MapLibre `setStyle` given it throws in the style-spec VALIDATOR before
  // applying a single diff op — silently stranding the whole map on the
  // PREVIOUS theme, no console error a mariner would ever see. Caught this
  // exact way, live, in a browser, while adding `blackback`/`slick`'s
  // basemap tint (colors.ts BASEMAP_TINT's own comment tells the story).
  // Validate every value THE SPEC ITSELF publishes ranges for, across every
  // palette — no hand-copied numbers to drift from the real limits.
  test("every raster paint property basemapTintPaint/rasterPaint can emit is in range", () => {
    const RASTER_SPEC = v8["paint_raster"] as Record<
      string,
      { minimum?: number; maximum?: number }
    >;
    for (const palette of PALETTES) {
      const paint = { ...rasterPaint(palette), ...basemapTintPaint(palette) };
      for (const [prop, value] of Object.entries(paint)) {
        const spec = RASTER_SPEC[prop];
        expect(spec, `${palette}.${prop} is not a raster paint property`).toBeDefined();
        if (spec.minimum !== undefined) {
          expect(value, `${palette}.${prop} below spec minimum`).toBeGreaterThanOrEqual(
            spec.minimum,
          );
        }
        if (spec.maximum !== undefined) {
          expect(value, `${palette}.${prop} above spec maximum`).toBeLessThanOrEqual(spec.maximum);
        }
      }
    }
  });
});

describe("the scamin fade dissolves gated features instead of popping them", () => {
  // The reported bug: only lights faded on SCAMIN, everything else vanished the
  // instant a new tile dropped it. The generator now folds the uniform fade
  // (sectorGate.ts) into the opacity of every gated symbol/line/fill layer, so a
  // feature dissolves over its `scamin·B/2 … scamin·B` band. A feature with no
  // `scamin` is never gated, so its opacity must stay a flat 1 (or its own
  // constant) — the fade term saturates to 1.
  const full: ChartSet = {
    ...set,
    id: "f",
    tiles: "/tiles/f/{z}/{x}/{y}.pbf",
    vector_layers: ["DEPARE", "LNDARE", "OBSTRN", "SOUNDG", "ATON", "DEPCNT"].map((id) => ({
      id,
      minzoom: 0,
      maxzoom: 16,
      fields: {},
    })),
  };
  const built = buildStyle([full], { ...DEFAULT_SETTINGS, showOsmOnLand: false });
  const paintOf = (id: string) =>
    (built.layers.find((l) => l.id === id) as { paint?: Record<string, unknown> }).paint ?? {};
  const propSpec = {
    type: "number",
    "property-type": "data-driven",
    expression: { interpolated: true, parameters: ["zoom", "feature"] },
  } as const;
  const evalOpacity = (value: unknown, zoom: number, props: Record<string, unknown>) => {
    const r = createPropertyExpression(value as never, propSpec as never);
    if (r.result === "error") throw new Error(r.value.map((e) => e.message).join("; "));
    return r.value.evaluate({ zoom } as never, { properties: props } as never) as number;
  };

  test("an aid symbol fades its icon (and text) across the scamin band", () => {
    const icon = paintOf("chart-f-aton")["icon-opacity"];
    expect(icon).toBeDefined();
    // no scamin → always fully opaque (never gated)
    expect(evalOpacity(icon, 10, {})).toBeCloseTo(1, 6);
    expect(evalOpacity(icon, 16, {})).toBeCloseTo(1, 6);
    // a gated aid: full where the tile still carries it, faded to nothing at the
    // scale the server drops it (scamin=300000 → gone by z10)
    expect(evalOpacity(icon, 14, { scamin: 300_000 })).toBeCloseTo(1, 6);
    expect(evalOpacity(icon, 10, { scamin: 300_000 })).toBeCloseTo(0, 6);
    // ATON also labels, so its text fades in lockstep
    expect(paintOf("chart-f-aton")["text-opacity"]).toBeDefined();
  });

  test("a sounding fades its text; a contour fades its line", () => {
    expect(evalOpacity(paintOf("chart-f-soundg")["text-opacity"], 10, { scamin: 300_000 })).toBeCloseTo(0, 6);
    expect(evalOpacity(paintOf("chart-f-depcnt")["line-opacity"], 10, { scamin: 300_000 })).toBeCloseTo(0, 6);
  });

  test("the fade composes with a hazard's danger case rather than clobbering it", () => {
    // obstrn-fill opacity was `["case", <danger|has fill>, 1, 0]`; the fade folds
    // in, so a shown-but-decluttering hazard fades, a danger stays opaque, and a
    // hazard with no fill fact stays invisible.
    const fill = paintOf("chart-f-obstrn-fill")["fill-opacity"];
    expect(evalOpacity(fill, 14, { fill: "depit", scamin: 300_000 })).toBeCloseTo(1, 6); // shown, not yet faded
    expect(evalOpacity(fill, 10, { fill: "depit", scamin: 300_000 })).toBeCloseTo(0, 6); // decluttered → faded out
    expect(evalOpacity(fill, 14, { scamin: 300_000 })).toBeCloseTo(0, 6); // no fill fact → still 0
    // a danger is DISPLAYBASE-promoted (SCAMIN-exempt): it must NOT fade
    expect(evalOpacity(fill, 10, { depth_value: 3, encl_drval1: 10 })).toBeCloseTo(1, 6);
  });

  test("a promoted safety contour is exempt and never fades", () => {
    const shallow = buildStyle([full], { ...DEFAULT_SETTINGS, safetyContour: 10 });
    const line = (shallow.layers.find((l) => l.id === "chart-f-depcnt") as { paint: Record<string, unknown> })
      .paint["line-opacity"];
    // the safety contour (VALDCO==safety, no shallower contour) stays opaque even
    // at an overview where its scamin band would otherwise have faded it out
    expect(evalOpacity(line, 8, { VALDCO: 10, scamin: 300_000 })).toBeCloseTo(1, 6);
    // an ordinary deeper contour (a shallower one already satisfies safety, so
    // valdco_prev is not below it) is NOT the safety contour and still fades
    expect(evalOpacity(line, 8, { VALDCO: 30, valdco_prev: 20, scamin: 300_000 })).toBeCloseTo(0, 6);
  });

  test("the DISPLAYBASE skin fills keep a plain constant opacity — no per-zoom fade", () => {
    // Folding a zoom-driven opacity into the biggest, densest fills would make
    // them re-evaluate paint on every zoom for a fade that is always 1 (they
    // carry no scamin). DEPARE has no fill-opacity at all; LNDARE keeps its flat
    // number. Neither is a zoom expression.
    expect(paintOf("chart-f-depare")["fill-opacity"]).toBeUndefined();
    expect(paintOf("chart-f-lndare")["fill-opacity"]).toBe(1);
  });
});

describe("chartEpoch busts the ENC source URL", () => {
  const tilesOf = (s: ReturnType<typeof buildStyle>, id: string) =>
    (s.sources[id] as { tiles: string[] }).tiles;

  test("without chartEpoch the URLs are byte-identical to today", () => {
    // The whole point: an unset (or zero) epoch must leave the source URL
    // exactly as it shipped, so no map without a serving-detail change reloads.
    const base = tilesOf(buildStyle([set], DEFAULT_SETTINGS), "chart-dk");
    expect(base).toEqual([`${location.origin}/api${set.tiles}`]);
    expect(tilesOf(buildStyle([set], DEFAULT_SETTINGS, { chartEpoch: 0 }), "chart-dk")).toEqual(base);
  });

  test("a set epoch is appended as ?e=<n> when the tile path has no query", () => {
    const tiles = tilesOf(buildStyle([set], DEFAULT_SETTINGS, { chartEpoch: 3 }), "chart-dk");
    expect(tiles).toEqual([`${location.origin}/api${set.tiles}?e=3`]);
    expect(tiles[0].endsWith("?e=3")).toBe(true);
  });

  test("it is appended as &e=<n> when the tile path already has a query", () => {
    const q: ChartSet = { ...set, id: "q", tiles: "/tiles/q/{z}/{x}/{y}.pbf?v=2" };
    const tiles = tilesOf(buildStyle([q], DEFAULT_SETTINGS, { chartEpoch: 5 }), "chart-q");
    expect(tiles).toEqual([`${location.origin}/api${q.tiles}&e=5`]);
  });

  test("only the ENC vector sources carry the epoch — never the osm basemap", () => {
    const s = buildStyle([set], DEFAULT_SETTINGS, { chartEpoch: 7 });
    expect((s.sources["osm-world"] as { tiles: string[] }).tiles).toEqual([
      `${location.origin}/api/osm_world/tiles/all/{z}/{x}/{y}`,
    ]);
    expect(tilesOf(s, "chart-dk")[0].endsWith("?e=7")).toBe(true);
  });
});

describe("the osm-world source's zoom hint is catalog-driven, not hardcoded (jt xqoyqxou)", () => {
  const osmWorldOf = (s: ReturnType<typeof buildStyle>) =>
    s.sources["osm-world"] as { minzoom: number; maxzoom: number };

  test("with no opts, it falls back to the static default (0/8)", () => {
    const src = osmWorldOf(buildStyle([], DEFAULT_SETTINGS));
    expect(src.minzoom).toBe(0);
    expect(src.maxzoom).toBe(8);
  });

  test("osmWorldMinZoom/osmWorldMaxZoom opts override the fallback", () => {
    // A raised OsmWorldConfig.max_zoom (or a dataset's own per-bake
    // override) re-baked to z12 must move this source's own maxzoom, or
    // MapLibre keeps overzooming past z8 forever — the exact bug this task
    // exists to fix.
    const src = osmWorldOf(
      buildStyle([], DEFAULT_SETTINGS, { osmWorldMinZoom: 2, osmWorldMaxZoom: 12 }),
    );
    expect(src.minzoom).toBe(2);
    expect(src.maxzoom).toBe(12);
  });
});

describe("the chart-all union source (#snyzntrn)", () => {
  // Two o-charts (on-demand) sets, `kind: "ocharts"` — the shape catalog()
  // now advertises for a subscribed o-charts set (mivnav.ocharts.service
  // catalog_entries), vs. `set`/`coast` above, which have no `kind` and so
  // exercise the pre-union "own source" default (a PMTiles set, or an older
  // fixture — buildStyle must treat both exactly as it always did).
  const ocA: ChartSet = {
    id: "oc-a",
    name: "O-charts A",
    bounds: [10, 53, 12, 55],
    min_zoom: 8,
    max_zoom: 14,
    sequence: 1,
    tiles: "/tiles/oc-a/{z}/{x}/{y}",
    vector_layers: [
      { id: "UNSARE", minzoom: 0, maxzoom: 16, fields: {} },
      { id: "DEPARE", minzoom: 0, maxzoom: 16, fields: {} },
    ],
    kind: "ocharts",
  };
  const ocB: ChartSet = {
    ...ocA,
    id: "oc-b",
    bounds: [11, 54, 13, 56],
    min_zoom: 6,
    max_zoom: 16,
  };

  test("every o-charts set folds into ONE chart-all source, sized to their union", () => {
    const s = buildStyle([ocA, ocB], DEFAULT_SETTINGS);
    expect(Object.keys(s.sources).filter((id) => id.startsWith("chart-"))).toEqual(["chart-all"]);
    const src = s.sources["chart-all"] as {
      tiles: string[];
      minzoom: number;
      maxzoom: number;
      bounds: number[];
    };
    expect(src.tiles).toEqual([`${location.origin}/api/tiles/all/{z}/{x}/{y}`]);
    // min over min_zoom, max over max_zoom — mirrors _cut_tile_all's own
    // claim_allowed (OR of bounds) / set_max_zoom (max over every set).
    expect(src.minzoom).toBe(6);
    expect(src.maxzoom).toBe(16);
    expect(src.bounds).toEqual([10, 53, 13, 56]); // union bbox of both sets
  });

  test("an unregistered o-charts screen draws the free union, at its own URL", () => {
    const s = buildStyle([ocB], DEFAULT_SETTINGS, { ochartsUnion: "free" });
    const src = s.sources["chart-all"] as { tiles: string[]; bounds: number[] };
    expect(src.tiles).toEqual([`${location.origin}/api/tiles/free/{z}/{x}/{y}`]);
    expect(src.bounds).toEqual([11, 54, 13, 56]);
  });

  test("the union emits ONE set of layers, not one per subscribed o-charts set", () => {
    const one = buildStyle([ocA], DEFAULT_SETTINGS).layers.filter((l) => l.id.startsWith("chart-all-"));
    const two = buildStyle([ocA, ocB], DEFAULT_SETTINGS).layers.filter((l) =>
      l.id.startsWith("chart-all-"),
    );
    expect(one.length).toBeGreaterThan(0);
    // Same layer ids, same count — a second o-charts set does not double the
    // style, unlike a second PMTiles set (see "each set keeps its own
    // internal order" above, which is exactly the N-sources behaviour this
    // does NOT want for o-charts sets).
    expect(two.map((l) => l.id)).toEqual(one.map((l) => l.id));
  });

  test("a PMTiles-kind set keeps its own source alongside chart-all", () => {
    const s = buildStyle([set, ocA, ocB], DEFAULT_SETTINGS);
    expect(Object.keys(s.sources).filter((id) => id.startsWith("chart-")).sort()).toEqual([
      "chart-all",
      "chart-dk",
    ]);
    const ids = s.layers.map((l) => l.id);
    expect(ids.some((id) => id.startsWith("chart-dk-"))).toBe(true);
    expect(ids.some((id) => id.startsWith("chart-all-"))).toBe(true);
  });

  /** Evaluate a chart-all layer's filter against synthetic feature
   * properties — no `scamin`, so the SCAMIN gate passes trivially and only
   * the disabledSets clause this test cares about can fail it. */
  const passes = (filter: unknown, props: Record<string, unknown>) =>
    featureFilter(filter as never).filter({ zoom: 10 } as never, { properties: props } as never);

  test("disabledSets excludes a set's features by filter, never by omitting the source", () => {
    const enabled = buildStyle([ocA, ocB], DEFAULT_SETTINGS);
    const disabled = buildStyle([ocA, ocB], DEFAULT_SETTINGS, { disabledSets: ["oc-a"] });
    // The source is unchanged either way — oc-a's cells still have to reach
    // the union tile for oc-b, which stays enabled.
    expect(Object.keys(disabled.sources)).toEqual(Object.keys(enabled.sources));
    const depare = (s: typeof enabled) => s.layers.find((l) => l.id === "chart-all-depare")!.filter;
    // Enabled: no disabledSets clause at all, so every set's tag passes —
    // byte-identical to before this option existed (same argument the
    // chartEpoch "byte-identical to today" tests above make for that knob).
    expect(passes(depare(enabled), { set: "oc-a" })).toBe(true);
    expect(passes(depare(enabled), { set: "oc-b" })).toBe(true);
    // Disabled: oc-a's own features are filtered out, oc-b's still show, and
    // the union's untagged synthetic `_nodata` claim (no "set" property at
    // all) is unaffected — it has no single owning set to exclude.
    expect(passes(depare(disabled), { set: "oc-a" })).toBe(false);
    expect(passes(depare(disabled), { set: "oc-b" })).toBe(true);
    expect(passes(depare(disabled), {})).toBe(true);
  });

  test("disabledSets never touches a PMTiles-kind set's own layers", () => {
    // `set` (kind-less/PMTiles) disabled the OLD way: the caller (App.tsx)
    // simply leaves it out of `sets`. If it were left IN and named in
    // `disabledSets` instead, buildStyle must not try to filter its
    // features by a `set` tag it never carries — this pins that chartStyle
    // stays silent (no filter injected) for anything not `kind: "ocharts"`.
    const s = buildStyle([set], DEFAULT_SETTINGS, { disabledSets: ["dk"] });
    const unsare = s.layers.find((l) => l.id === "chart-dk-unsare")!;
    const plain = buildStyle([set], DEFAULT_SETTINGS).layers.find((l) => l.id === "chart-dk-unsare")!;
    expect(unsare.filter).toEqual(plain.filter);
  });

  test("every o-charts set disabled: chart-all is skipped entirely, not filtered to empty", () => {
    // A layer filter hides features, it does not stop the tile FETCH — with
    // nothing left for the union to draw, paying the Pi to cut and gzip an
    // always-empty /tiles/all is pure waste (CLAUDE.md: tiles cost Pi CPU,
    // not bandwidth). Mirrors a fully-disabled PMTiles set, which was always
    // just omitted.
    const s = buildStyle([ocA, ocB], DEFAULT_SETTINGS, { disabledSets: ["oc-a", "oc-b"] });
    expect(s.sources["chart-all"]).toBeUndefined();
    expect(s.layers.some((l) => l.id.startsWith("chart-all-"))).toBe(false);
  });

  test("partial disabling still builds the union — only ALL-disabled skips it", () => {
    const s = buildStyle([ocA, ocB], DEFAULT_SETTINGS, { disabledSets: ["oc-a"] });
    expect(s.sources["chart-all"]).toBeDefined();
    expect(s.layers.some((l) => l.id.startsWith("chart-all-"))).toBe(true);
  });
});

describe("soundings layers carry a generated text-field", () => {
  const withSoundings: ChartSet = {
    ...set,
    id: "snd",
    tiles: "/tiles/snd/{z}/{x}/{y}.pbf",
    vector_layers: ["DEPARE", "SOUNDG", "OBSTRN"].map((id) => ({
      id,
      minzoom: 0,
      maxzoom: 16,
      fields: {},
    })),
  };
  const textFieldOf = (id: string) =>
    (buildStyle([withSoundings], DEFAULT_SETTINGS).layers.find((l) => l.id === id) as {
      layout?: Record<string, unknown>;
    }).layout?.["text-field"];

  test("SOUNDG text-field is generated", () => {
    expect(textFieldOf("chart-snd-soundg")).toBeDefined();
  });

  test("the hazard VALSOU text-field (OBSTRN -snd) is generated", () => {
    expect(textFieldOf("chart-snd-obstrn-snd")).toBeDefined();
  });
});

describe("ThemeFonts.all puts every text layer on one stack", () => {
  // The shared `set` declares only three source layers, so it builds no chart
  // text at all — name the text-bearing classes, shorthand (SOUNDG, LIGHTS)
  // and named (SEAARE, LNDMRK) alike.
  const textSet: ChartSet = {
    ...set,
    vector_layers: ["DEPARE", "SOUNDG", "LIGHTS", "SEAARE", "LNDMRK", "BOYLAT", "WRECKS"].map((id) => ({
      id,
      minzoom: 0,
      maxzoom: 16,
      fields: {},
    })),
  };
  const textFonts = (palette: string) =>
    buildStyle([textSet], { ...DEFAULT_SETTINGS, palette: palette as typeof DEFAULT_SETTINGS.palette })
      .layers.filter((l) => l.type === "symbol" && l.layout?.["text-font"] !== undefined)
      .map((l) => [l.id, (l.layout as Record<string, unknown>)["text-font"]] as const);

  test("modern-paper-2: every text layer, shorthand and basemap included", () => {
    const fonts = textFonts("modern-paper-2");
    expect(fonts.map(([id]) => id)).toContain("world-places");
    expect(fonts.length).toBeGreaterThan(5);
    for (const [, font] of fonts) expect(font).toEqual(["Termes Chart Italic"]);
  });

  test("a theme without it keeps its per-role fonts", () => {
    const fonts = new Map(textFonts("paper2"));
    expect(fonts.get("world-places")).not.toEqual(["Termes Chart Italic"]);
  });
});

describe("showOsmOnLand washes every opaque land-area fill, not just LNDARE", () => {
  // User report: a cemetery (LNDMRK CATLMK=2) stayed a solid AC(CHBRN) slab
  // over the basemap the setting exists to reveal.
  const landSet: ChartSet = {
    ...set,
    vector_layers: ["LNDARE", "LNDMRK", "SILTNK", "PRDARE"].map((id) => ({ id, minzoom: 0, maxzoom: 16, fields: {} })),
  };
  const opacity = (on: boolean, id: string) =>
    (buildStyle([landSet], { ...DEFAULT_SETTINGS, showOsmOnLand: on }).layers.find((l) => l.id === id)!.paint as
      Record<string, unknown>)["fill-opacity"];

  // SCAMIN-gated classes fold the base opacity into a zoom fade as its
  // `["*", base, …]` factor, so look for the wash factor anywhere inside.
  const washed = (v: unknown, alpha: number) => v === alpha || JSON.stringify(v).includes(`["*",${alpha},`);

  test("LNDARE takes the land wash", () => {
    expect(washed(opacity(true, "chart-dk-lndare"), LAND_WASH_OPACITY)).toBe(true);
    expect(opacity(false, "chart-dk-lndare")).toBe(1);
  });

  test.each(["chart-dk-lndmrk-fill", "chart-dk-siltnk-fill", "chart-dk-prdare-fill"])(
    "%s takes the lighter structure wash",
    (id) => {
      expect(washed(opacity(true, id), LAND_FEATURE_WASH_OPACITY)).toBe(true);
      expect(washed(opacity(false, id), LAND_FEATURE_WASH_OPACITY)).toBe(false);
    },
  );

  test("the structure wash is lighter than the land wash it sits on", () => {
    expect(LAND_FEATURE_WASH_OPACITY).toBeLessThan(LAND_WASH_OPACITY);
    expect(LAND_FEATURE_WASH_OPACITY).toBeGreaterThan(0);
  });
});
