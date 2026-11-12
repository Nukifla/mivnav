/**
 * The on-demand symbol loader (jt task qkmvmwps) — the piece that replaced a
 * pre-baked ~2.5 MiB sprite atlas, and now also the piece that APPLIES THE
 * PALETTE.
 *
 * What is worth pinning here is the arithmetic, the bookkeeping and the
 * recolouring, not the pixels: the SCALE factor (getting it wrong halves every
 * buoy on the chart — exactly the regression yxrmtltk had just fixed), the
 * request discipline (one fetch per id, ever, however many tiles mention it —
 * this runs on a Pi over a boat LAN), and the palette-change path, which must
 * re-decode from the CACHED document rather than refetching. The decode step
 * is injected, so none of this needs a DOM.
 */

import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ATON_ICON_SCALE,
  atonIconRaster,
  atonIconUrl,
  installAtonIconLoader,
  isAtonIconCandidate,
  NO_ARTWORK_SYMBOLS,
  PLACEHOLDER_ALIAS,
  sizeSvg,
  svgViewBoxSize,
  type AtonIconTarget,
} from "./atonIcons";
import { iconRoleSentinel } from "./themes/iconRoles";

/** Shaped like a real roles-mode `icons::pack::render` result: explicit
 * viewBox, the width/height usvg's writer emits in the SVG's own native units,
 * and painted colours that are ROLE SENTINELS rather than hexes — `ink` (15)
 * and `obj-red` (02), the pair every parametric red buoy carries. */
const INK = iconRoleSentinel("15");
const OBJ_RED = iconRoleSentinel("02");
const SVG =
  `<svg viewBox="0 0 11 24" width="11" height="24" xmlns="http://www.w3.org/2000/svg">` +
  `<path fill="${OBJ_RED}" stroke="${INK}"/></svg>`;

describe("atonIconUrl", () => {
  test("a slash-bearing key becomes a real nested path, unescaped", () => {
    expect(atonIconUrl("BOYSHP/4/1/3,1")).toBe("/api/icons/BOYSHP/4/1/3,1.svg?roles=1");
    expect(atonIconUrl("pilpnt")).toBe("/api/icons/pilpnt.svg?roles=1");
  });

  test("always asks for ROLES mode — the palette is applied here, not on the server", () => {
    // Without `?roles=1` the backend serves the day-baked render and every
    // substitution below is a silent no-op: the icons would be right on day
    // and wrong on every other palette, which is the failure mode this whole
    // migration exists to end.
    expect(atonIconUrl("light/red")).toContain("?roles=1");
  });
});

describe("isAtonIconCandidate", () => {
  test("every key form is a candidate, including the literal chartsymbols names", () => {
    // No hand-maintained key list: the two literal address forms are not
    // distinguishable by spelling, so the endpoint's 404 is the arbiter.
    for (const id of ["BOYSHP/4/1/3,1", "TOPSHP/3/0/0", "light_float/white", "pilpnt", "ISODGR51", "QUESMRK1"]) {
      expect(isAtonIconCandidate(id)).toBe(true);
    }
  });

  test("THE FIXED REGRESSION: nothing is rejected for looking palette-prefixed", () => {
    // These ids are not produced any more — that is the point — but the
    // rejection that used to sit here is what made dusk/night draw NOTHING for
    // a renamed symbol, so the predicate is pinned as permissive rather than
    // left to drift back.
    expect(isAtonIconCandidate("dusk_BOYSHP/4/1/3,1")).toBe(true);
    expect(isAtonIconCandidate("dark_BOYSHP/4/1/3,1")).toBe(true);
    expect(isAtonIconCandidate("s52svg_QUESMRK1")).toBe(true);
  });

  test("only an empty id is refused", () => {
    expect(isAtonIconCandidate("")).toBe(false);
  });
});

describe("svgViewBoxSize / sizeSvg", () => {
  test("reads the icon's own units off the viewBox", () => {
    expect(svgViewBoxSize(SVG)).toEqual({ width: 11, height: 24 });
    expect(svgViewBoxSize("<svg/>")).toBeUndefined();
  });

  test("sizeSvg replaces width/height and leaves the viewBox alone", () => {
    const out = sizeSvg(SVG, 44, 96);
    expect(out).toContain('viewBox="0 0 11 24"');
    expect(out).toContain('width="44"');
    expect(out).toContain('height="96"');
    expect(out).not.toContain('width="11"');
  });
});

describe("atonIconRaster", () => {
  test("on-screen size is SCALE x the SVG's native units at every device ratio", () => {
    // MapLibre's on-screen size is `pixels / pixelRatio`. The deleted packer
    // achieved the same 2x via spreet --ratio 2 with pixelRatio 1.
    for (const dpr of [1, 2, 3]) {
      const plan = atonIconRaster(SVG, dpr)!;
      expect(plan.width / plan.pixelRatio).toBe(11 * ATON_ICON_SCALE);
      expect(plan.height / plan.pixelRatio).toBe(24 * ATON_ICON_SCALE);
    }
  });

  test("decodes at more pixels on a hidpi screen", () => {
    expect(atonIconRaster(SVG, 2)!.width).toBe(atonIconRaster(SVG, 1)!.width * 2);
  });

  test("a document with no usable viewBox is refused rather than guessed at", () => {
    expect(atonIconRaster("<svg/>", 1)).toBeUndefined();
    expect(atonIconRaster('<svg viewBox="0 0 0 0"/>', 1)).toBeUndefined();
  });

  test("scale is a parameter, not hardcoded to ATON_ICON_SCALE", () => {
    const plan = atonIconRaster(SVG, 1, 1)!;
    expect(plan.width / plan.pixelRatio).toBe(11);
    expect(plan.height / plan.pixelRatio).toBe(24);
  });
});

/** A map double with the sliver the loader touches, recording registrations
 * AND the SVG each one was painted from (the decode double passes it through),
 * so the palette tests can assert on colour rather than on call counts alone. */
function fakeMap() {
  let listener: ((e: { id: string }) => void) | undefined;
  const images = new Map<string, { pixelRatio?: number }>();
  const painted = new Map<string, string>();
  const updates: string[] = [];
  /** The last object handed to addImage/updateImage, so a test can tell the
   * 1x1 placeholder apart from real artwork. */
  const raw = new Map<string, unknown>();
  const map: AtonIconTarget & {
    images: typeof images;
    painted: typeof painted;
    updates: typeof updates;
    raw: typeof raw;
    missing(id: string): void;
  } = {
    on(_type, l) {
      listener = l;
      return map;
    },
    hasImage: (id) => images.has(id),
    addImage: (id, image, options) => {
      if (images.has(id)) throw new Error(`duplicate image ${id}`); // as MapLibre does
      images.set(id, options ?? {});
      raw.set(id, image);
      painted.set(id, (image as { svg: string }).svg);
    },
    updateImage: (id, image) => {
      if (!images.has(id)) throw new Error(`no such image ${id}`); // as MapLibre does
      updates.push(id);
      raw.set(id, image);
      painted.set(id, (image as { svg: string }).svg);
    },
    removeImage: (id) => {
      if (!images.has(id)) throw new Error(`no such image ${id}`); // as MapLibre does
      images.delete(id);
      painted.delete(id);
      raw.delete(id);
    },
    images,
    painted,
    updates,
    raw,
    missing: (id) => listener?.({ id }),
  };
  return map;
}

function okFetch() {
  return mock(async () => new Response(SVG, { status: 200 }));
}

/** Hands the sized document straight back, so a test can read what colour the
 * icon would actually have rasterised at. */
const decode = async (svg: string) => ({ svg });

/** The loader's promises are fire-and-forget; let the microtask queue drain. */
const settle = () => new Promise((r) => setTimeout(r, 0));

const DAY = { ink: "#000000", "obj-red": "#ed1c24" } as const;
const NIGHT = { ink: "#8f2f2f", "obj-red": "#7a1216" } as const;

describe("installAtonIconLoader", () => {
  test("registers a missing symbol at the pixel ratio the raster plan asked for", async () => {
    const map = fakeMap();
    const fetchImpl = okFetch();
    installAtonIconLoader(map, { fetchImpl: fetchImpl as unknown as typeof fetch, decode, devicePixelRatio: 2 });

    map.missing("BOYSHP/4/1/3,1");
    await settle();

    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/api/icons/BOYSHP/4/1/3,1.svg?roles=1");
    expect(map.images.get("BOYSHP/4/1/3,1")).toEqual({ pixelRatio: 2 });
  });

  test("one fetch per id however many tiles report it missing", async () => {
    const map = fakeMap();
    const fetchImpl = okFetch();
    installAtonIconLoader(map, { fetchImpl: fetchImpl as unknown as typeof fetch, decode });

    map.missing("pilpnt");
    map.missing("pilpnt"); // same frame, still in flight
    await settle();
    map.missing("pilpnt"); // already registered
    await settle();

    expect(fetchImpl.mock.calls.length).toBe(1);
  });

  test("a 404 is remembered — a name chartcore doesn't carry is not re-asked on every tile", async () => {
    const map = fakeMap();
    const fetchImpl = mock(async () => new Response(null, { status: 404 }));
    installAtonIconLoader(map, { fetchImpl: fetchImpl as unknown as typeof fetch, decode });

    map.missing("NOT-A-SYMBOL");
    await settle();
    map.missing("NOT-A-SYMBOL");
    await settle();

    expect(fetchImpl.mock.calls.length).toBe(1);
    expect(map.images.size).toBe(0);
  });

  test("a failing fetch leaves the chart iconless, never rejecting", async () => {
    const map = fakeMap();
    const fetchImpl = mock(async () => {
      throw new Error("offline");
    });
    installAtonIconLoader(map, { fetchImpl: fetchImpl as unknown as typeof fetch, decode });

    map.missing("BOYSHP/4/1/3,1");
    await settle();

    expect(map.images.size).toBe(0);
  });

  test("a name with no artwork anywhere draws a question mark, not nothing", async () => {
    // WHY THIS IS NOT "just let it 404": these used to be answered — badly
    // — by the sprite sheet, which MapLibre consulted before firing
    // `styleimagemissing` at all. Dropping `sprite:` (jt task sustkllt) turns
    // "wrong crop" into "no image", and a charted feature that stops marking
    // its position is the worse of the two. The alias reproduces what the old
    // raster atlas did with these names anyway (placeholders.json: "the raster
    // atlas aliases this to 'QUESMRK1'").
    const map = fakeMap();
    const fetchImpl = mock(async (url: string) =>
      url === atonIconUrl(PLACEHOLDER_ALIAS) ? new Response(SVG, { status: 200 }) : new Response(null, { status: 404 }),
    );
    installAtonIconLoader(map, { fetchImpl: fetchImpl as unknown as typeof fetch, decode });

    // LNDARE01 is the whole of NO_ARTWORK_SYMBOLS now. FOULGND1 used to stand
    // here, and its removal is the case this test exists to catch: it was
    // never missing artwork, it was chartcore emitting an area-PATTERN token
    // as a point symbol, so it got renamed onto the vendored `foul` instead.
    map.missing("LNDARE01");
    await settle();

    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([
      atonIconUrl("LNDARE01"),
      atonIconUrl(PLACEHOLDER_ALIAS),
    ]);
    // Registered under ITS OWN id — the alias is what it is PAINTED from, not
    // what it is called, so real artwork landing later needs no rename here.
    expect(map.images.has("LNDARE01")).toBe(true);
  });

  test("the alias is tried AFTER the real request, so artwork landing later wins", async () => {
    const map = fakeMap();
    const fetchImpl = okFetch();
    installAtonIconLoader(map, { fetchImpl: fetchImpl as unknown as typeof fetch, decode });

    map.missing("LNDARE01");
    await settle();

    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([atonIconUrl("LNDARE01")]);
    expect(map.images.has("LNDARE01")).toBe(true);
  });

  test("only the named six alias — an unknown id still resolves to nothing", async () => {
    const map = fakeMap();
    const fetchImpl = mock(async () => new Response(null, { status: 404 }));
    installAtonIconLoader(map, { fetchImpl: fetchImpl as unknown as typeof fetch, decode });

    // A transient miss for another subsystem's image (POI/AIS/route all
    // `addImage` eagerly, and a style reload can race that) must NOT leave a
    // question mark registered under their id, shadowing the real icon when
    // it arrives.
    map.missing("poi-marina-day");
    await settle();

    expect(fetchImpl.mock.calls.length).toBe(1);
    expect(map.images.size).toBe(0);
  });

  test("the six are exactly chartcore's NO_ARTWORK list", () => {
    // The authority is `chartcore/tests/derive_symbol_coverage.rs`, which
    // proves every symbol `derive/` can emit resolves EXCEPT these — so this
    // copy is read back off it rather than trusted. Artwork landing in
    // chartcore shortens that list; this fails until the alias set follows.
    const rust = readFileSync(
      join(import.meta.dir, "..", "..", "..", "..", "chartcore", "tests", "derive_symbol_coverage.rs"),
      "utf8",
    );
    const block = /const NO_ARTWORK: &\[&str\] = &\[([^\]]*)\]/.exec(rust);
    expect(block, "NO_ARTWORK not found in derive_symbol_coverage.rs").not.toBeNull();
    const names = [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    expect([...NO_ARTWORK_SYMBOLS].sort()).toEqual(names.sort());
  });

  test("the theme's role table is substituted in before rasterising", async () => {
    const map = fakeMap();
    installAtonIconLoader(map, {
      fetchImpl: okFetch() as unknown as typeof fetch,
      decode,
      iconColors: NIGHT,
    });

    map.missing("BOYSHP/4/1/3,1");
    await settle();

    const svg = map.painted.get("BOYSHP/4/1/3,1")!;
    expect(svg).toContain(NIGHT["obj-red"]);
    expect(svg).toContain(NIGHT.ink);
    // No sentinel survives into the raster: one left behind is a magenta-ish
    // #fe00XX blob on the chart, which is how a missing role would show up.
    expect(svg).not.toContain("#fe00");
  });
});

// MapLibre re-reads the image the instant the `styleimagemissing` handler
// returns and logs one `Image "…" could not be loaded…` per id when it is still
// absent. This loader is async by construction, so without a synchronous
// registration EVERY symbol warns once per session — benign lines that bury the
// ones that mean something. (jt task tooqktxt)
describe("the transparent placeholder that silences styleimagemissing", () => {
  const isPlaceholder = (v: unknown) =>
    !!v && (v as { width?: number }).width === 1 && (v as { height?: number }).height === 1;

  test("an image exists SYNCHRONOUSLY, before any fetch has resolved", () => {
    const map = fakeMap();
    installAtonIconLoader(map, { fetchImpl: okFetch() as unknown as typeof fetch, decode });

    map.missing("BOYSHP/4/1/3,1"); // no await: this is the whole point

    expect(map.hasImage("BOYSHP/4/1/3,1")).toBe(true);
    expect(isPlaceholder(map.raw.get("BOYSHP/4/1/3,1"))).toBe(true);
  });

  test("the real bitmap replaces it — a swap, since updateImage cannot resize", async () => {
    const map = fakeMap();
    installAtonIconLoader(map, {
      fetchImpl: okFetch() as unknown as typeof fetch,
      decode,
      devicePixelRatio: 2,
    });

    map.missing("BOYSHP/4/1/3,1");
    await settle();

    expect(isPlaceholder(map.raw.get("BOYSHP/4/1/3,1"))).toBe(false);
    expect(map.painted.get("BOYSHP/4/1/3,1")).toContain("<svg");
    expect(map.images.get("BOYSHP/4/1/3,1")).toEqual({ pixelRatio: 2 });
    expect(map.updates).toEqual([]); // never updateImage across a size change
  });

  test("a symbol that cannot load ends with NO image, so MapLibre still warns once", async () => {
    // The point of silencing the benign lines is that a real failure becomes
    // visible. Leaving the 1x1 behind would silence that too, and would leave
    // an invisible quad standing in for artwork that is never coming.
    const map = fakeMap();
    installAtonIconLoader(map, {
      fetchImpl: mock(async () => new Response(null, { status: 404 })) as unknown as typeof fetch,
      decode,
    });

    map.missing("NOT-A-SYMBOL");
    expect(map.hasImage("NOT-A-SYMBOL")).toBe(true); // optimistic, mid-flight
    await settle();

    expect(map.hasImage("NOT-A-SYMBOL")).toBe(false);
  });

  test("a rejecting fetch takes its placeholder with it too", async () => {
    const map = fakeMap();
    installAtonIconLoader(map, {
      fetchImpl: mock(async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
      decode,
    });

    map.missing("BOYSHP/4/1/3,1");
    await settle();

    expect(map.images.size).toBe(0);
  });

  test("a name MapLibre asks for that is not ours gets no placeholder at all", () => {
    // isAtonIconCandidate rejects it, so nothing is registered and the warning
    // still fires — which is right: that id is somebody else's bug.
    const map = fakeMap();
    installAtonIconLoader(map, { fetchImpl: okFetch() as unknown as typeof fetch, decode });

    map.missing("");

    expect(map.images.size).toBe(0);
  });
});

describe("a palette change re-colours what is already on the map", () => {
  // THE REASON THIS EXISTS: with ids palette-neutral, a theme switch changes
  // no `icon-image`, so MapView's `setStyle(style, {diff: true})` deliberately
  // keeps every registered image. Without `refresh` the buoys would simply
  // stay in the previous theme's colours forever.
  async function loaded() {
    const map = fakeMap();
    const fetchImpl = okFetch();
    const loader = installAtonIconLoader(map, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      decode,
      iconColors: DAY,
    });
    map.missing("BOYSHP/4/1/3,1");
    map.missing("pilpnt");
    await settle();
    return { map, fetchImpl, loader };
  }

  test("re-substitutes and calls updateImage for every loaded icon", async () => {
    const { map, loader } = await loaded();
    expect(map.painted.get("pilpnt")).toContain(DAY["obj-red"]);

    await loader.refresh(NIGHT);

    expect(map.updates.sort()).toEqual(["BOYSHP/4/1/3,1", "pilpnt"]);
    expect(map.painted.get("pilpnt")).toContain(NIGHT["obj-red"]);
    expect(map.painted.get("BOYSHP/4/1/3,1")).toContain(NIGHT.ink);
  });

  test("refetches NOTHING — the cached document is palette-neutral", async () => {
    const { fetchImpl, loader } = await loaded();
    const before = fetchImpl.mock.calls.length;

    await loader.refresh(NIGHT);

    expect(fetchImpl.mock.calls.length).toBe(before);
  });

  test("an unchanged table is a no-op, so a reactive effect can call it freely", async () => {
    const { map, loader } = await loaded();

    await loader.refresh({ ...DAY });

    expect(map.updates).toEqual([]);
  });

  test("a symbol loaded AFTER the switch comes back in the new colours", async () => {
    const { map, loader } = await loaded();
    await loader.refresh(NIGHT);

    map.missing("ISODGR51");
    await settle();

    expect(map.painted.get("ISODGR51")).toContain(NIGHT["obj-red"]);
  });
});
