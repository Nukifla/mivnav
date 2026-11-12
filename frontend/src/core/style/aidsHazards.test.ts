import { describe, expect, test } from "bun:test";
import { createPropertyExpression } from "@maplibre/maplibre-gl-style-spec";
import { aidsHazardsAreaLayers, aidsHazardsSymbolLayers } from "./aidsHazards";
import { isAtonIconCandidate } from "./atonIcons";
import { paletteColors } from "./colors";
import { poly, type AddLayer, type ChartLayer } from "./expr";
import { DEFAULT_SETTINGS } from "./settings";

// WRECKS' icon-image/text-field pick (S2, S52CondRules.cpp:525-616): a baked
// `sym` (wreck-non-dangerous/wreck-hull_showing, foul) wins; otherwise depth_value (ALWAYS baked
// by chartcore — real VALSOU, or its own CATWRK/WATLEV default table when
// VALSOU is absent) picks DANGER51/52, with 'Wk' alongside. tyvwupuk: keying
// the depth pick on `has(VALSOU)` instead of `!has(sym)` left wrecks with
// neither a resolvable sym (its CATWRK/WATLEV pair didn't match one — D1,
// chartcore/src/derive/hazards.rs) nor a real VALSOU with an empty icon-image
// AND an empty text-field — invisible on the chart.

function wrecksSymLayer(): ChartLayer {
  let layer: ChartLayer | undefined;
  const add: AddLayer = (_prio, sourceLayer, l) => {
    if (sourceLayer === "WRECKS" && l.id.endsWith("-wrecks-sym")) layer = l;
  };
  aidsHazardsSymbolLayers(add, "chart", DEFAULT_SETTINGS);
  if (!layer) throw new Error("chart-wrecks-sym layer not emitted");
  return layer;
}

const iconSpec = {
  type: "string",
  "property-type": "data-driven",
  expression: { interpolated: false, parameters: ["zoom", "feature"] },
} as const;
const textSpec = {
  type: "formatted",
  "property-type": "data-driven",
  expression: { interpolated: false, parameters: ["zoom", "feature"] },
} as const;
const numberSpec = {
  type: "number",
  "property-type": "data-driven",
  expression: { interpolated: false, parameters: ["zoom", "feature"] },
} as const;

function evalIcon(expr: unknown, props: Record<string, unknown>): string {
  const r = createPropertyExpression(expr as never, iconSpec as never);
  if (r.result === "error") throw new Error(r.value.map((e) => e.message).join("; "));
  return r.value.evaluate({ zoom: 12 } as never, { properties: props } as never) as unknown as string;
}

function evalText(expr: unknown, props: Record<string, unknown>): string {
  const r = createPropertyExpression(expr as never, textSpec as never);
  if (r.result === "error") throw new Error(r.value.map((e) => e.message).join("; "));
  const formatted = r.value.evaluate({ zoom: 12 } as never, { properties: props } as never) as unknown as {
    toString(): string;
  };
  return formatted.toString();
}

function evalNumber(expr: unknown, props: Record<string, unknown>): number {
  const r = createPropertyExpression(expr as never, numberSpec as never);
  if (r.result === "error") throw new Error(r.value.map((e) => e.message).join("; "));
  return r.value.evaluate({ zoom: 12 } as never, { properties: props } as never) as unknown as number;
}

describe("WRECKS symbol pick — every variant gets SOME icon, none get icon-less text", () => {
  const layer = wrecksSymLayer();
  const icon = layer.layout!["icon-image"];
  const text = layer.layout!["text-field"];

  test("a baked sym (CATWRK/WATLEV resolved) draws the sym, no 'Wk' text", () => {
    const props = { sym: "wreck-non-dangerous" };
    expect(evalIcon(icon, props)).toBe("wreck-non-dangerous");
    expect(evalText(text, props)).toBe("");
  });

  test("VALSOU present, no sym: DANGER51/52 by depth, plus 'Wk'", () => {
    const shallow = { VALSOU: 3, depth_value: 3 };
    expect(evalIcon(icon, shallow)).toBe("DANGER51");
    expect(evalText(text, shallow)).toBe("Wk");

    const deep = { VALSOU: 10, depth_value: 10 };
    expect(evalIcon(icon, deep)).toBe("DANGER52");
    expect(evalText(text, deep)).toBe("Wk");
  });

  test("the previously-invisible gap: no sym AND no VALSOU still gets DANGER51/52 + 'Wk', via chartcore's always-baked depth_value fallback", () => {
    const props = { depth_value: -15 }; // chartcore's CATWRK/WATLEV-fallback default
    expect(evalIcon(icon, props)).not.toBe("");
    expect(evalIcon(icon, props)).toBe("DANGER51");
    expect(evalText(text, props)).toBe("Wk");
  });

  test("isolated-danger promotion still wins over everything, with no 'Wk' text", () => {
    const props = { depth_value: 3, encl_drval1: 10, sym: "wreck-non-dangerous", VALSOU: 3 };
    expect(evalIcon(icon, props)).toBe("ISODGR51");
    expect(evalText(text, props)).toBe("");
  });

  // lppokvtq: QUASOU=7 ("depth unknown") used to add a separate WRECKS07
  // overbar layer stacked on whatever else the wreck drew. That symbol was a
  // raster bar sitting at the top of a 32x24 canvas, so once free-standing
  // artwork became centre-anchored it floated detached ABOVE the 16x6/16x16
  // wreck it was meant to overline. User decision: drop the bar and let the
  // wreck wear the vendored dangerous-wreck symbol instead — which is also
  // what s57-style.json layer 122's CATWRK DEFAULT arm does.
  test("QUASOU=7 wears wreck-dangerous, outranking any baked sym", () => {
    const props = { quasou7: 1, sym: "wreck-hull_showing", depth_value: -15 };
    expect(evalIcon(icon, props)).toBe("wreck-dangerous");
  });

  test("a QUASOU=7 wreck that would otherwise promote gets wreck-dangerous, not ISODGR51", () => {
    // The danger arm is written FIRST, but WRECKS' own predicate already
    // vetoes on quasou7 (isolatedDanger.ts: "a wreck of unknown depth is not
    // an isolated danger"), so the two arms cannot both be live. Pinning it
    // here because the arm order alone looks like the opposite claim.
    const props = { quasou7: 1, depth_value: 3, encl_drval1: 10, VALSOU: 3 };
    expect(evalIcon(icon, props)).toBe("wreck-dangerous");
  });
});

// yqxkluqv: a small light with a baked `sym` (flare/QUESMRK1 — VALNMR<10, or
// directional; chartcore derive/lights.rs) draws a real S-52 SVG symbol
// again, NOT the annulus rkmzlpxy replaced it with and NOT the old raster
// atlas crop either.
//
// wvrlupqx retargeted the flare from the old IHO-extracted chartsymbols.xml
// vectors onto chartcore's icon catalogue (`sym` = `light/<colourword>`).
// `icon-image` used to BRANCH on top of that — QUESMRK1 (directional) had no
// vendored equivalent and was routed to a second, static-SVG loader under an
// `s52svg_` id namespace — and the whole thing was then palette-prefixed.
//
// Both are gone. chartcore serves QUESMRK1 as a placeholder, so there is one
// loader and one id namespace; and ids are palette-neutral, so there is no
// prefix. THE REGRESSION THIS BLOCK USED TO FLAG IS FIXED: `dusk_light/red`
// used to be produced by the style and then explicitly REFUSED by
// `isAtonIconCandidate`, so the flare drew nothing at all on the palette a
// mariner actually uses at night. The id is now `light/red` on every palette
// and the theme supplies the colour (colors.ts's `iconRoleColors` ->
// atonIcons.ts's role substitution).
function lightsSymLayer(settings = DEFAULT_SETTINGS): ChartLayer {
  let layer: ChartLayer | undefined;
  const add: AddLayer = (_prio, sourceLayer, l) => {
    if (sourceLayer === "LIGHTS" && l.id.endsWith("-lights-sym")) layer = l;
  };
  aidsHazardsSymbolLayers(add, "chart", settings, 1);
  if (!layer) throw new Error("chart-lights-sym layer not emitted");
  return layer;
}

describe("-lights-sym: one chartcore id, unchanged by the palette", () => {
  test("a chartcore `light/<colourword>` key passes through unchanged", () => {
    const icon = lightsSymLayer().layout!["icon-image"];
    expect(evalIcon(icon, { sym: "light/red" })).toBe("light/red");
  });

  test("QUESMRK1 is no longer special-cased into a second loader's namespace", () => {
    const icon = lightsSymLayer().layout!["icon-image"];
    expect(evalIcon(icon, { sym: "QUESMRK1" })).toBe("QUESMRK1");
  });

  test("dusk and night emit exactly the day id, and it is loadable", () => {
    for (const palette of ["dusk", "night"] as const) {
      const icon = lightsSymLayer({ ...DEFAULT_SETTINGS, palette }).layout!["icon-image"];
      for (const sym of ["light/generic", "light/yellow", "QUESMRK1"]) {
        const id = evalIcon(icon, { sym });
        expect(id).toBe(sym);
        // The other half of the fix: the id the style emits is one the loader
        // will actually fetch. It was the pair — a prefixed id AND a
        // predicate that rejected prefixed ids — that made the symbol vanish.
        expect(isAtonIconCandidate(id as string)).toBe(true);
      }
    }
  });
});

// szrwnlum: `-lights-star`, the position star for the converse population —
// the lights that draw NO icon of their own (all-round range ring, sector
// arc), whose position was previously marked by nothing at all. chartcore
// bakes the pick as `sym_star` (derive/lights.rs); this layer only has to
// draw it, centred and upright. What this test actually guards is that it did
// NOT get folded into `-lights-sym`, which rotates and offsets its icon like
// the flare it was built for.
describe("-lights-star: the ring/arc position star", () => {
  function lightsStarLayer(settings = DEFAULT_SETTINGS): ChartLayer {
    let layer: ChartLayer | undefined;
    const add: AddLayer = (_prio, sourceLayer, l) => {
      if (sourceLayer === "LIGHTS" && l.id.endsWith("-lights-star")) layer = l;
    };
    aidsHazardsSymbolLayers(add, "chart", settings, 1);
    if (!layer) throw new Error("chart-lights-star layer not emitted");
    return layer;
  }

  test("draws chartcore's baked `sym_star`, unchanged, gated on it", () => {
    const layer = lightsStarLayer();
    expect(layer.filter).toEqual(["has", "sym_star"]);
    for (const sym_star of ["light-major", "light-minor"]) {
      expect(evalIcon(layer.layout!["icon-image"], { sym_star })).toBe(sym_star);
      // and the id is one the on-demand /api/icons loader will actually fetch
      expect(isAtonIconCandidate(sym_star)).toBe(true);
    }
  });

  test("centred and upright — no flare rotation, offset or anchor", () => {
    // The reference layer (s57-style.json `light-star`) declares none of
    // these; `-lights-sym` declares all three, which is exactly why the star
    // cannot ride that layer. `icon-anchor` absent = MapLibre's "center",
    // which is also where chartcore anchors free-standing artwork.
    const layout = lightsStarLayer().layout!;
    expect(layout["icon-rotate"]).toBeUndefined();
    expect(layout["icon-offset"]).toBeUndefined();
    expect(layout["icon-anchor"]).toBeUndefined();
  });

  test("hidden with the rest of the lights when showLights is off", () => {
    expect(lightsStarLayer().layout!.visibility).toBe("visible");
    expect(lightsStarLayer({ ...DEFAULT_SETTINGS, showLights: false }).layout!.visibility).toBe(
      "none",
    );
  });
});

// xlvpzzmn: `icon-rotate`, ported literally from s57-style.json's `light`
// layer. ORIENT wins outright; otherwise the sector-bisector branch (the
// reference's own `xSECTR1` typo — see LIGHT_ICON_ROTATE's doc comment — is
// corrected in this port, so the branch is reachable here even though it
// stays inert on mivnav's own tile data); otherwise a fixed per-colour
// fallback that is NOT a no-op default — it's the reference's real baseline
// for the common case (a plain light with neither ORIENT nor a sector).
// COLOUR arrives on the wire as a string always (chartcore's
// `AttrValue::StrList`, verified against a real ingested tile, not just unit
// tests) — both the numeric and string equality checks are kept, matching
// the reference verbatim, but only the string form ever actually matches
// mivnav's own data.
describe("-lights-sym: icon-rotate", () => {
  const rotate = () => lightsSymLayer().layout!["icon-rotate"];

  test("ORIENT present: used directly, sector/colour ignored", () => {
    expect(evalNumber(rotate(), { sym: "light/red", ORIENT: 123.4 })).toBe(123.4);
    expect(evalNumber(rotate(), { sym: "light/red", ORIENT: 123.4, SECTR1: 10, SECTR2: 20, COLOUR: "3" })).toBe(
      123.4,
    );
  });

  test("SECTR1/SECTR2 present, no ORIENT: the sector bisector ((SECTR2-SECTR1)/2 + SECTR1), typo fixed", () => {
    expect(evalNumber(rotate(), { sym: "light/generic", SECTR1: 10, SECTR2: 20 })).toBe(15);
    // sweep wraps through 0/360 when SECTR2 < SECTR1: (10-350+360)/2 + 350 = 360
    expect(evalNumber(rotate(), { sym: "light/generic", SECTR1: 350, SECTR2: 10 })).toBe(360);
  });

  test("no ORIENT/SECTR, COLOUR red (numeric 3 or string \"3\"): 60", () => {
    expect(evalNumber(rotate(), { sym: "light/red", COLOUR: 3 })).toBe(60);
    expect(evalNumber(rotate(), { sym: "light/red", COLOUR: "3" })).toBe(60);
  });

  test("no ORIENT/SECTR, COLOUR green (numeric 4 or string \"4\"): 30", () => {
    expect(evalNumber(rotate(), { sym: "light/green", COLOUR: 4 })).toBe(30);
    expect(evalNumber(rotate(), { sym: "light/green", COLOUR: "4" })).toBe(30);
  });

  test("no ORIENT/SECTR, no COLOUR (or any other colour, or a multi-colour list): 45", () => {
    expect(evalNumber(rotate(), { sym: "light/generic" })).toBe(45);
    expect(evalNumber(rotate(), { sym: "light/yellow", COLOUR: "1" })).toBe(45);
    // Multi-colour list, comma-joined on the wire (chartcore's join_list) —
    // matches neither the "3" nor "4" check, same as the reference.
    expect(evalNumber(rotate(), { sym: "light/generic", COLOUR: "1,3" })).toBe(45);
  });
});

// The restricted-group boundary `bcol` match (PRIO.RESTRICTED_BOUNDARY):
// CHGRD (FAIRWY/MARCUL, and PIPARE's pre-existing benign-product case) and
// CHBLK (FERYRT's CATFRY=2 case) were both missing at first — silently
// falling through to the CHMGD default. Locked in here since no test
// previously exercised this match at all. TRFCF (PILBOP's own Plain-row dash
// colour) added the same way, this task's own slice.
//
// (De-duplicated: this file briefly carried this exact describe block twice,
// a mechanical land-time artifact from two divergent history branches
// wanting the identical suite — see plkptvku's own "Slice 9 attempt" note.)
function restrictedBdyLayer(): ChartLayer {
  let layer: ChartLayer | undefined;
  const add: AddLayer = (_prio, sourceLayer, l) => {
    if (sourceLayer === "FAIRWY" && l.id.endsWith("-bdy")) layer = l;
  };
  aidsHazardsAreaLayers(add, "chart", DEFAULT_SETTINGS);
  if (!layer) throw new Error("chart-fairwy-bdy layer not emitted");
  return layer;
}

function pilbopBdyLayer(): ChartLayer {
  let layer: ChartLayer | undefined;
  const add: AddLayer = (_prio, sourceLayer, l) => {
    if (sourceLayer === "PILBOP" && l.id.endsWith("-bdy")) layer = l;
  };
  aidsHazardsAreaLayers(add, "chart", DEFAULT_SETTINGS);
  if (!layer) throw new Error("chart-pilbop-bdy layer not emitted");
  return layer;
}

describe("restricted-group boundary bcol -> line-color match", () => {
  const colorSpec = {
    type: "color",
    "property-type": "data-driven",
    expression: { interpolated: true, parameters: ["zoom", "feature"] },
  } as const;

  function evalColor(expr: unknown, props: Record<string, unknown>): unknown {
    const r = createPropertyExpression(expr as never, colorSpec as never);
    if (r.result === "error") throw new Error(r.value.map((e) => e.message).join("; "));
    return r.value.evaluate({ zoom: 12 } as never, { properties: props } as never);
  }

  test("every bcol token this group actually emits resolves to its own colour, not the CHMGD default", () => {
    const C = paletteColors(DEFAULT_SETTINGS.palette);
    const lineColor = restrictedBdyLayer().paint!["line-color"];
    const cases: [string, string][] = [
      ["CHMGF", C.CHMGF],
      ["TRFCD", C.TRFCD],
      ["CHGRD", C.CHGRD], // FAIRWY/MARCUL (always), PIPARE (benign case)
      ["CHBLK", C.CHBLK], // FERYRT's CATFRY=2 case
      ["TRFCF", C.TRFCF], // PILBOP's own Plain-row dash colour
      ["CHMGD", C.CHMGD], // the default itself: RESARE, FERYRT's other case, …
    ];
    for (const [bcol, expected] of cases) {
      expect(evalColor(lineColor, { bcol })).toEqual(evalColor(expected, {}));
    }
  });

  test("filter is poly, not '!= Point' — MARCUL/FERYRT also have a genuine Line row (./waterways.ts), which must NOT double-draw here", () => {
    expect(restrictedBdyLayer().filter).toEqual(poly);
    expect(pilbopBdyLayer().filter).toEqual(poly);
  });
});

// FAIRWY's centred symbol is the one member of the restricted-group symbol
// loop whose LUP passes a bearing to the symbol: `SY(FAIRWY51,ORIENT)`
// (TRAFIC 1-3) / `SY(FAIRWY52,ORIENT)` (TRAFIC 4), chartsymbols.xml RCID
// 32090-32093. chartcore only bakes `sym` when ORIENT is present at all
// (derive::restricted::fairway_sym), and ORIENT rides the tile untouched
// (no `render_only_keep` arm for FAIRWY, and the synthetic label point
// carries the same tags) — so the whole rotation was lost in the style,
// which emitted icon-image only. Regression guard for that.
function symLayer(cls: string): ChartLayer {
  let layer: ChartLayer | undefined;
  const add: AddLayer = (_prio, sourceLayer, l) => {
    if (sourceLayer === cls && l.id.endsWith("-sym")) layer = l;
  };
  aidsHazardsSymbolLayers(add, "chart", DEFAULT_SETTINGS);
  if (!layer) throw new Error(`chart-${cls.toLowerCase()}-sym layer not emitted`);
  return layer;
}

describe("FAIRWY centred symbol honours ORIENT", () => {
  test("icon-rotate reads ORIENT straight through (both TRAFIC branches)", () => {
    const rotate = symLayer("FAIRWY").layout!["icon-rotate"];
    expect(evalNumber(rotate, { sym: "FAIRWY51", ORIENT: 135 })).toBe(135);
    expect(evalNumber(rotate, { sym: "FAIRWY52", ORIENT: 47.5 })).toBe(47.5);
    // no ORIENT means chartcore baked no `sym` either, so nothing draws —
    // but the expression must still evaluate rather than error
    expect(evalNumber(rotate, { sym: "FAIRWY51" })).toBe(0);
  });

  test("rotation is map-aligned — ORIENT is a true bearing, not a screen angle", () => {
    expect(symLayer("FAIRWY").layout!["icon-rotation-alignment"]).toBe("map");
  });

  test("the rest of the restricted-symbol loop stays unrotated", () => {
    for (const cls of ["RESARE", "ACHARE", "CTNARE", "CTSARE", "FERYRT", "PILBOP"]) {
      expect(symLayer(cls).layout!["icon-rotate"]).toBeUndefined();
      expect(symLayer(cls).layout!["icon-rotation-alignment"]).toBeUndefined();
    }
  });
});
