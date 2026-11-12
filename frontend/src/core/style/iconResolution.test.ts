/**
 * THE TEST THAT WOULD HAVE CAUGHT THE DUSK/NIGHT REGRESSION.
 *
 * The bug: `derive/` was ported to vendored icon names (`CTNARE51` ->
 * `caution`), the style then prefixed every id per palette (`dark_caution`),
 * the raster atlas had no such entry, AND `atonIcons.ts`'s
 * `isAtonIconCandidate` explicitly REFUSED `dusk_`/`dark_`-prefixed ids — so
 * on the two palettes a mariner uses after sunset, a large class of symbols
 * drew nothing at all. The whole suite stayed green because nothing evaluated
 * `icon-image` against a resolver for a non-day palette: the per-palette tests
 * asserted the PREFIXED STRING was produced, which it faithfully was.
 *
 * So this checks the pair, not either half:
 *
 *   1. Every `icon-image` a built style can emit is IDENTICAL on every
 *      palette. A palette-dependent id is the failure mode itself, and there
 *      is no longer any mechanism that could serve one (there are no baked
 *      per-palette atlases — the theme is applied to the SVG, client-side).
 *   2. Every one of those ids is something a resolver will actually accept —
 *      which now means the `/api/icons/` loader, and ONLY it: the style
 *      declares no `sprite:` (jt task sustkllt), so there is no atlas left to
 *      answer first.
 *
 * Evaluated over the REAL style (`buildStyle`), not a hand-written id list —
 * a hand-written list is what let the regression through.
 */
import { describe, expect, mock, test } from "bun:test";
import { createPropertyExpression, v8 } from "@maplibre/maplibre-gl-style-spec";
import type { ChartSet } from "../catalog";
import { atonIconUrl, installAtonIconLoader, isAtonIconCandidate, type AtonIconTarget } from "./atonIcons";
import { NODATA_PATTERN_ID } from "./nodataPattern";
import { PALETTES } from "./colors";
import { DEFAULT_SETTINGS } from "./settings";

// chartStyle reads `location.origin` for the tile URLs
(globalThis as { location?: unknown }).location = { origin: "http://localhost" };
const { buildStyle } = await import("./chartStyle");

/** Every source-layer the style knows how to draw, so no layer is silently
 * absent from the sweep. Taken off the style's own `source-layer` values by
 * building once with a permissive set. */
const ALL_LAYERS = [
  "_nodata", "UNSARE", "DEPARE", "DEPCNT", "SOUNDG", "LNDARE", "COALNE", "SLCONS",
  "BOYLAT", "BOYCAR", "BOYSAW", "BOYSPP", "BOYINB", "BOYISD", "BCNLAT", "BCNCAR",
  "BCNSAW", "BCNSPP", "BCNISD", "TOPMAR", "DAYMAR", "LIGHTS", "LITVES", "LITFLT",
  "MORFAC", "M_NSYS", "WRECKS", "OBSTRN", "UWTROC", "RESARE", "ACHARE", "CTNARE",
  "MIPARE", "DMPGRD", "SPLARE", "SEAARE", "TSSLPT", "TSELNE", "DWRTPT", "RCTLPT",
  "FAIRWY", "MARCUL", "FERYRT", "PILBOP", "RDOCAL", "RTPBCN", "RADSTA", "SISTAT",
  "CGUSTA", "RSCSTA", "SILTNK", "PRDARE", "CRANES", "HULKES", "LNDMRK", "BUISGL",
  "CBLARE", "PIPARE", "CBLSUB", "CBLOHD", "PIPSOL", "PIPOHD", "SBDARE", "RIVERS",
  "CANALS", "LOKBSN", "DOCARE",
];

const set: ChartSet = {
  id: "dk",
  name: "Denmark",
  bounds: [8, 54, 13, 58],
  min_zoom: 0,
  max_zoom: 16,
  sequence: 1,
  tiles: "/tiles/dk/{z}/{x}/{y}.pbf",
  vector_layers: ALL_LAYERS.map((id) => ({ id, minzoom: 0, maxzoom: 16, fields: {} })),
};

/** Feature property bags covering every attribute the style reads an icon name
 * out of, with values that are REAL chartcore output — the vendored names
 * `derive/` emits today plus the literal placeholder names it still emits. */
const SYM_VALUES = [
  "caution", "no-entry", "wreck-hull_showing", "anchorage", "TSS-arrow",
  "light/red", "light/generic", "floodlight/white", "QUESMRK1", "LIGHTS81",
  // `cylinder`/`barrel` sat here as industrial.rs's tank symbols; they are
  // parametric ATON shape templates and derive/ no longer emits them bare
  // (wyzqklzz), so this list carries what it emits for those arms now.
  "BOYSHP/4/1/3,1", "TOPSHP/3/0/0", "pilpnt", "building", "tower-lmk",
];
const SYM_KEYS = ["sym", "sym_s", "sym_cs", "sym_pos", "sym_extra"];

/** Shallower than the safety contour AND inside a deeper-than-safety area: the
 * S-52 isolated-danger rule (UDWHAZ03), which promotes the symbol to ISODGR51.
 * `quasou7` off, so the WRECKS-only gate does not veto it. */
const DANGER = { depth_value: 3, encl_drval1: 30, quasou7: 0 };
/** Deep enough not to be a danger — the DANGER51/DANGER52 depth pick instead. */
const NOT_DANGER = { depth_value: 30, encl_drval1: 3, quasou7: 0 };

function propBags(): Record<string, unknown>[] {
  const bags: Record<string, unknown>[] = [];
  for (const key of SYM_KEYS) {
    for (const value of SYM_VALUES) {
      // `depth_value`/`encl_drval1`/`quasou7` are the isolated-danger
      // predicate's own terms (isolatedDanger.ts) — sweep both sides of the
      // safety contour so the ISODGR51/DANGER51/DANGER52 branches are reached
      // as well as the plain symbol path.
      bags.push({ [key]: value, ...DANGER, ORIENT: 42 });
      bags.push({ [key]: value, ...NOT_DANGER, ORIENT: 42 });
    }
  }
  // Every branch a MISSING symbol attribute can reach (the `["has", …]`
  // fallbacks — DANGER51/DANGER52/ISODGR51), plus the WRECKS QUASOU=7 arm,
  // which is keyed on a property none of the bags above sets: without a bag
  // carrying it, `wreck-dangerous` is simply never emitted by the sweep and
  // the palette-neutrality claim silently stops covering it.
  bags.push(
    { ...DANGER },
    { ...NOT_DANGER },
    { ...NOT_DANGER, quasou7: 1 },
    { depth_value: 3 },
    { depth_value: 40 },
    {},
  );
  return bags;
}

/** `icon-image` evaluates to a `ResolvedImage`, not a bare string — unwrap it
 * to the name MapLibre will look up (and which `styleimagemissing` reports). */
function imageName(out: unknown): string | undefined {
  if (typeof out === "string") return out || undefined;
  const name = (out as { name?: unknown } | null)?.name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

/** Every distinct id the style can put in `icon-image`, for one palette. */
function emittedIconIds(palette: string): Set<string> {
  const style = buildStyle([set], { ...DEFAULT_SETTINGS, palette: palette as never });
  const ids = new Set<string>();
  const bags = propBags();
  for (const layer of style.layers) {
    const image = (layer as { layout?: Record<string, unknown> }).layout?.["icon-image"];
    if (image === undefined) continue;
    if (typeof image === "string") {
      ids.add(image);
      continue;
    }
    const compiled = createPropertyExpression(image as never, v8.layout_symbol["icon-image"] as never);
    if (compiled.result === "error") throw new Error(`${layer.id}: ${JSON.stringify(compiled.value)}`);
    for (const properties of bags) {
      let out: unknown;
      try {
        out = compiled.value.evaluate({ zoom: 12 } as never, { properties } as never);
      } catch {
        continue; // an attribute this branch needs is absent in this bag
      }
      const name = imageName(out);
      if (name) ids.add(name);
    }
  }
  return ids;
}

/** Strip chartcore's `,RRGGBB` PER-FEATURE COLOUR OVERRIDE (`icons::resolve`'s
 * literal form). That suffix is legitimately palette-dependent — the TSS arrow
 * asks for the current palette's own CHMGD, and cables/pipelines ask for the
 * tile's own `bcol` — and it is resolved by chartcore, not by an atlas lookup,
 * so it is NOT the prefix bug. Compared separately below. */
const baseName = (id: string): string => id.replace(/,[0-9a-f]{6}$/i, "");

const dayIds = emittedIconIds("day");

describe("symbol ids are palette-neutral", () => {
  test("the sweep actually found the symbols (a silent empty set would pass everything)", () => {
    expect(dayIds.size).toBeGreaterThanOrEqual(20);
    // The literal names the style still writes itself, and one of each
    // attribute-driven family — an empty or half-swept set would otherwise
    // make every assertion below vacuously true.
    for (const id of ["caution", "ISODGR51", "wreck-dangerous", "DANGER51", "DANGER52", "wreck-hull_showing", "light/red"]) {
      expect(dayIds, id).toContain(id);
    }
  });

  const bases = (ids: Iterable<string>) => [...new Set([...ids].map(baseName))].sort();

  for (const palette of PALETTES.filter((p) => p !== "day")) {
    test(`${palette} emits exactly day's symbol names`, () => {
      expect(bases(emittedIconIds(palette))).toEqual(bases(dayIds));
    });
  }

  test("the only palette-dependent part of an id is a `,RRGGBB` colour chartcore resolves", () => {
    // `TSS-arrow,c545c3` at day vs `TSS-arrow,964678` at vintage is CORRECT
    // and is not the bug: chartcore's literal address form takes an explicit
    // colour, so the id names an icon it can render for any palette. The bug
    // was a NAMESPACE prefix naming an atlas crop that did not exist.
    const withColour = [...emittedIconIds("night")].filter((id) => id !== baseName(id));
    expect(withColour.length).toBeGreaterThan(0);
    for (const id of withColour) expect(id).toMatch(/^[^,]+,[0-9a-f]{6}$/);
  });

  test("no id carries a palette prefix on ANY palette", () => {
    for (const palette of PALETTES) {
      for (const id of emittedIconIds(palette)) {
        expect(id.startsWith("dusk_"), `${palette}: ${id}`).toBe(false);
        expect(id.startsWith("dark_"), `${palette}: ${id}`).toBe(false);
        expect(id.startsWith("s52svg_"), `${palette}: ${id}`).toBe(false);
      }
    }
  });
});

describe("every emitted id resolves through something, on a NON-DAY palette", () => {
  for (const palette of ["dusk", "night"] as const) {
    test(`${palette}: the /api/icons/ loader answers all of them`, () => {
      for (const id of emittedIconIds(palette)) {
        // The `,RRGGBB` per-feature colour form is a loader key — it never was
        // a sheet name; `cablesPipelines.ts`/`trafficRoutes.ts` build it from
        // the tile's own `bcol` / the palette's CHMGD, and chartcore resolves
        // the colour.
        expect(isAtonIconCandidate(id), `${palette}: ${id} resolves through nothing`).toBe(true);
      }
    });
  }

  test("THE WRECKS CASE: a wreck with a `sym` gets an icon, not silence", () => {
    // The worst instance of the bug. `-wrecks-sym`'s `text-field` "Wk"
    // fallback is gated on `sym` being ABSENT, so when the prefixed id
    // resolved to nothing the feature drew NEITHER an icon NOR the fallback
    // text — a charted wreck rendered as blank water on the night palette.
    const style = buildStyle([set], { ...DEFAULT_SETTINGS, palette: "night" });
    const layer = style.layers.find((l) => l.id.endsWith("-wrecks-sym")) as {
      layout: Record<string, unknown>;
    };
    const compiled = createPropertyExpression(
      layer.layout["icon-image"] as never,
      v8.layout_symbol["icon-image"] as never,
    );
    if (compiled.result === "error") throw new Error("icon-image did not compile");
    const id = imageName(
      compiled.value.evaluate(
        { zoom: 12 } as never,
        { properties: { sym: "wreck-hull_showing", VALSOU: 40, QUASOU: 1 } } as never,
      ),
    )!;
    expect(id).toBe("wreck-hull_showing");
    expect(isAtonIconCandidate(id)).toBe(true);
  });
});

/**
 * THE TEST THAT WOULD HAVE CAUGHT THE SPRITE-SHADOWING BUG (jt task sustkllt).
 *
 * The style used to declare `sprite:` so that its ONE fill pattern could
 * resolve. MapLibre looks an image name up in the sprite BEFORE it fires
 * `styleimagemissing`, so every name that also existed in the day-baked atlas
 * — 27 of the ones `derive/` emitted AT THE TIME, `RESTRN51` among them — was
 * served from the sheet and never reached the loader that applies the palette. Nothing
 * failed: the ids were right, the loader was right, and the atlas quietly
 * answered first.
 *
 * So the pin is not "the sheet entry is gone" but the invariant underneath:
 * every image the style NAMES, of any kind, is one WE register.
 */
describe("nothing can answer for an image before the loader does", () => {
  for (const palette of PALETTES) {
    test(`${palette}: the style declares no sprite`, () => {
      const style = buildStyle([set], { ...DEFAULT_SETTINGS, palette: palette as never });
      expect((style as { sprite?: unknown }).sprite).toBeUndefined();
    });
  }

  /** Every image name in a built style that is NOT an `icon-image` — the
   * patterns, which is where a second sheet dependency would hide. Swept from
   * paint rather than named: `line-pattern` is a real and separate mechanism
   * (`derive_symbol_coverage.rs` deliberately does not require `lc` names to
   * resolve in chartcore's catalogue), so "only UNSARE has a fill-pattern" is
   * not the same claim as this one. */
  function patternNames(palette: string): Set<string> {
    const style = buildStyle([set], { ...DEFAULT_SETTINGS, palette: palette as never });
    const names = new Set<string>();
    for (const layer of style.layers) {
      const paint = (layer as { paint?: Record<string, unknown> }).paint ?? {};
      for (const key of ["fill-pattern", "line-pattern", "background-pattern"] as const) {
        const value = paint[key];
        if (value === undefined) continue;
        if (typeof value === "string") {
          names.add(value);
          continue;
        }
        const compiled = createPropertyExpression(
          value as never,
          (key === "fill-pattern" ? v8.paint_fill["fill-pattern"] : v8.paint_line["line-pattern"]) as never,
        );
        if (compiled.result === "error") throw new Error(`${layer.id}: ${JSON.stringify(compiled.value)}`);
        for (const properties of [{ bcol: "CHGRD" }, { bcol: "CHMGD" }, {}]) {
          try {
            const name = imageName(compiled.value.evaluate({ zoom: 12 } as never, { properties } as never));
            if (name) names.add(name);
          } catch {
            continue;
          }
        }
      }
    }
    return names;
  }

  test("the pattern sweep finds the patterns (an empty set would pass vacuously)", () => {
    expect(patternNames("day")).toContain(NODATA_PATTERN_ID);
    // The cable/pipeline line patterns, which are loader keys carrying the
    // tile's own `bcol` as a `,RRGGBB` colour — not sheet names.
    expect([...patternNames("day")].some((n) => n.startsWith("cable,"))).toBe(true);
  });

  for (const palette of PALETTES) {
    test(`${palette}: every pattern is loader-served or registered by us`, () => {
      for (const name of patternNames(palette)) {
        // NODATA03 is drawn client-side and added on `style.load`
        // (./nodataPattern.ts); everything else has to be a name `/api/icons`
        // can answer. A third answer — "it is in the sheet" — is what this
        // test exists to refuse.
        const ours = name === NODATA_PATTERN_ID || isAtonIconCandidate(name);
        expect(ours, `${palette}: ${name} resolves through nothing we register`).toBe(true);
      }
    });
  }

  /**
   * The measured collision set: names `derive/` emits that ALSO existed in
   * `public/sprites/s52.json`, so the sheet answered for them and the loader
   * never saw them. Hardcoded on purpose — it is a historical measurement
   * (recorded in the parent commit), and it must keep meaning the same thing
   * after the sheet files are deleted (jt task oyrukrrz).
   */
  const PREVIOUSLY_SHADOWED = [
    "DANGER01", "DANGER51", "DANGER52", "DANGER53", "DGPS01DRFSTA01", "FAIRWY51",
    "FAIRWY52", "FLTHAZ02", "FOULGND1", "ITZARE51", "LIGHTS81", "LNDARE01",
    "LOWACC03", "POSGEN01", "POSGEN03", "PRDINS02", "QUAPOS01", "QUAPOS02",
    "QUAPOS03", "QUARRY01", "QUESMRK1", "RACNSP01", "RCLDEF01", "RESTRN51",
    "TMBYRD01", "TSSCRS51", "TSSRON51",
  ];

  test("each of the 27 now reaches the loader — the whole point of the change", async () => {
    // Driven through the REAL loader rather than asserted about the predicate:
    // what broke was never "would the loader accept this id", it was "does the
    // id ever get there". `RESTRN51` is the one the user reported — the
    // CS(RESTRN01) symbol stacked on RESARE/CTNARE/PRCARE/ISTZNE/TSSLPT alike.
    // (It is no longer emitted at all — lppokvtq resolved it onto `no-anchor` —
    // but the list stays as measured: it pins the LOADER, not today's style.)
    const requested: string[] = [];
    const fetchImpl = mock(async (url: string) => {
      requested.push(url);
      return new Response(null, { status: 404 });
    });
    const map: AtonIconTarget = {
      on: () => map,
      hasImage: () => false,
      addImage: () => {},
      updateImage: () => {},
      removeImage: () => {},
    };
    let listener: ((e: { id: string }) => void) | undefined;
    installAtonIconLoader({ ...map, on: (_t, l) => ((listener = l), map) }, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      decode: async (svg: string) => ({ svg }),
    });
    for (const id of PREVIOUSLY_SHADOWED) listener!({ id });
    await new Promise((r) => setTimeout(r, 0));

    for (const id of PREVIOUSLY_SHADOWED) {
      expect(requested, `${id} never reached /api/icons`).toContain(atonIconUrl(id));
    }
  });
});
