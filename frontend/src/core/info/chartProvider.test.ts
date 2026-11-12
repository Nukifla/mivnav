/**
 * The chart provider: the layer↔S-57 mapping, the isolated-danger promotion,
 * and the identity that collapses one object's many style-layer hits.
 *
 * Driven against a queryRenderedFeatures-shaped double, the same way
 * MapView.test.ts drives wireMap against a FakeMap — no WebGL, no DOM, and no
 * mock.module (bun shares one module registry per run and mocks leak across
 * files; nothing here needs one, because the provider takes its map and its
 * settings as arguments).
 */

import { describe, expect, test } from "bun:test";
import type { MapGeoJSONFeature } from "maplibre-gl";
import WavesHorizontal from "lucide-solid/icons/waves-horizontal";
import ArrowDownToLine from "lucide-solid/icons/arrow-down-to-line";
import CircleQuestionMark from "lucide-solid/icons/circle-question-mark";
import { WreckGlyph } from "./WreckGlyph";
import { paletteColors } from "../style/colors";
import { DEFAULT_SETTINGS, type ChartSettings } from "../style/settings";
import {
  aidIconLayers,
  chartHitPayload,
  chartInteriorOnlyArea,
  chartSpriteId,
  createChartInfoProvider,
  fetchChartText,
  isIsolatedDanger,
  lightSegments,
} from "./chartProvider";
import type { ChartHitPayload } from "./chartProvider";
import { dedupeHits, rankHits } from "./rank";
import type { InfoQuery } from "./types";

const QUERY: InfoQuery = { point: { x: 100, y: 100 }, lngLat: { lng: 12.6, lat: 55.9 }, radius: 8 };

type Geom = MapGeoJSONFeature["geometry"];

const areaGeom = { type: "Polygon", coordinates: [] } as unknown as Geom;
const lineGeom = { type: "LineString", coordinates: [] } as unknown as Geom;
const pointGeom = (lng = 12.6, lat = 55.9) =>
  ({ type: "Point", coordinates: [lng, lat] }) as unknown as Geom;

/** One queryRenderedFeatures result. `styleLayer` matters only in that a real
 * object arrives once per style layer with identical properties — which is
 * exactly what the identity rule has to survive.
 *
 * `extra.id` is the MVT feature id, where chartcore writes the S-57 RCID;
 * `extra.layer` is the *style* layer the hit came through, which matters only
 * where the seam has to recognise its own highlight. Both default to what a
 * plain tile feature looks like, so the tests that predate them read unchanged. */
function feat(
  sourceLayer: string,
  props: Record<string, unknown>,
  geometry: Geom = areaGeom,
  source = "chart-US5OAKIQ",
  extra: { id?: number; layer?: string } = {},
): MapGeoJSONFeature {
  return {
    source,
    sourceLayer,
    properties: props,
    geometry,
    id: extra.id,
    layer: { id: extra.layer ?? `${sourceLayer}-fill` },
  } as unknown as MapGeoJSONFeature;
}

function providerOver(features: MapGeoJSONFeature[], settings: ChartSettings = DEFAULT_SETTINGS) {
  return createChartInfoProvider({
    map: { queryRenderedFeatures: () => features },
    settings: () => settings,
  });
}

describe("layer → object class", () => {
  test("the source-layer names the class, and ATON is un-merged by shape", () => {
    // The tiler routes every BOY*/BCN* class into one ATON layer and drops the
    // acronym (mvt/mod.rs layer_name); BOYSHP/BCNSHP is what is left to tell
    // a buoy from a beacon.
    const hits = providerOver([
      feat("ATON", { BOYSHP: 2, CATLAM: 1 }, pointGeom()),
      feat("ATON", { BCNSHP: 4 }, pointGeom()),
      feat("ATON", {}, pointGeom()),
      feat("WRECKS", {}, areaGeom),
      feat("_nodata", {}, areaGeom),
    ]).queryAt(QUERY);
    expect(hits.map((h) => h.title)).toEqual([
      "Buoy",
      "Beacon",
      "Aid to navigation",
      "Wreck",
      "No chart data",
    ]);
  });

  test("DEPCNT also carries line-primitive DEPARE, which has no VALDCO", () => {
    // Queried one at a time so each contour's subtitle is read on its own — two
    // depth objects in one tap fold into a single Depth hit (see the depth-merge
    // suite), which is not what this asserts about.
    const [contour] = providerOver([feat("DEPCNT", { VALDCO: 10 }, lineGeom)]).queryAt(QUERY);
    const [depare] = providerOver([feat("DEPCNT", { drval1: 5, drval2: 10 }, lineGeom)]).queryAt(QUERY);
    expect(contour.title).toBe("Depth contour");
    expect(contour.subtitle).toBe("10 m");
    expect(depare.subtitle).toBe("5–10 m");
  });

  test("only chart sources answer — rasters and live overlays are other sources", () => {
    const hits = providerOver([
      feat("DEPARE", { drval1: 0, drval2: 5 }),
      feat("ships", { mmsi: 1 }, pointGeom(), "signalk-targets"),
    ]).queryAt(QUERY);
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe("Depth area");
  });

  test("geometry type becomes precision", () => {
    // OBSTRN stands in for the line case: COALNE/SLCONS/LNDARE are excluded now
    // and never reach a hit (see the exclusion test below).
    const hits = providerOver([
      feat("SOUNDG", { DEPTH: 5 }, pointGeom()),
      feat("OBSTRN", {}, lineGeom),
      feat("DEPARE", {}, areaGeom),
    ]).queryAt(QUERY);
    expect(hits.map((h) => h.precision)).toEqual(["point", "line", "area"]);
  });

  test("render-only / uninformative structural classes never answer as info", () => {
    // #IAP-STRUCTURAL-STRIP + #INFO-LNDARE-STRIP: drawn on the map, but "not
    // interesting as info features at all" — excluded from hit building outright.
    // LNDARE (land fill) and LNDRGN (named land region) join SLCONS/COALNE:
    // tapping land must select nothing, so neither reaches a hit — only the
    // depth area answers.
    const hits = providerOver([
      feat("SLCONS", { CATSLC: 6 }, lineGeom),
      feat("COALNE", { CATCOA: 6 }, lineGeom),
      feat("LNDARE", {}, areaGeom),
      feat("LNDRGN", { OBJNAM: "Some Island" }, areaGeom),
      feat("DEPARE", { drval1: 0, drval2: 5 }, areaGeom),
    ]).queryAt(QUERY);
    expect(hits.map((h) => h.title)).toEqual(["Depth area"]);
  });

  test("a drying height reads as drying, never as a negative depth", () => {
    const hits = providerOver([
      feat("SOUNDG", { DEPTH: -1.5 }, pointGeom()),
      feat("SOUNDG", { DEPTH: 5 }, pointGeom()),
      // the 99999 no-depth sentinel the SOUNDG layer filters out
      feat("SOUNDG", { DEPTH: 99999 }, pointGeom()),
    ]).queryAt(QUERY);
    expect(hits.map((h) => h.subtitle)).toEqual(["1.5 m drying", "5 m", undefined]);
  });

  test("a point hit is placed at itself; a hit with extent, at where you asked", () => {
    // Two different questions with one field. A light *is* somewhere, and the
    // marker must be on it and not near it. A depth area is not anywhere — but
    // the hit is: the mariner pointed at a spot inside it, and that spot is
    // what the panel is about and what the camera has to keep in view. The
    // area's shape is ./highlight.ts's answer, not this field's.
    // The area + contour fold into one Depth hit (see the depth-merge suite);
    // the light stays its own point hit. Both placements are still exercised:
    // the light at itself, the merged depth band at where you asked.
    const hits = providerOver([
      feat("LIGHTS", { litdsn: "Fl(2)10s" }, pointGeom(11.1, 57.2)),
      feat("DEPARE", {}, areaGeom),
      feat("DEPCNT", { VALDCO: 10 }, lineGeom),
    ]).queryAt(QUERY);
    const light = hits.find((h) => h.title === "Light");
    const depth = hits.find((h) => h.title === "Depth");
    expect(light?.lngLat).toEqual({ lng: 11.1, lat: 57.2 });
    expect(depth?.lngLat).toEqual(QUERY.lngLat);
  });
});

describe("#INFO-SUBTITLE-AIDS: buoy and light subtitles", () => {
  test("a nameless buoy summarises as category + shape", () => {
    // East cardinal spar: CATCAM=2 + BOYSHP=5, decoded through the same table
    // the detail rows use, capitalised and joined with a middot.
    const [hit] = providerOver([feat("ATON", { BOYSHP: 5, CATCAM: 2 }, pointGeom())]).queryAt(QUERY);
    expect(hit.title).toBe("Buoy");
    expect(hit.subtitle).toBe("East cardinal · spar");
  });

  test("a beacon summarises its lateral hand and shape too", () => {
    const [hit] = providerOver([feat("ATON", { BCNSHP: 3, CATLAM: 1 }, pointGeom())]).queryAt(QUERY);
    expect(hit.title).toBe("Beacon");
    expect(hit.subtitle).toBe("Port hand · beacon tower");
  });

  test("a named aid keeps its name as the subtitle, not the summary", () => {
    const [hit] = providerOver([
      feat("ATON", { BOYSHP: 4, CATLAM: 2, OBJNAM: "No 3" }, pointGeom()),
    ]).queryAt(QUERY);
    expect(hit.subtitle).toBe("No 3");
  });

  test("a light's subtitle is its characteristic — chartcore's baked litdsn", () => {
    const [hit] = providerOver([feat("LIGHTS", { litdsn: "Fl(2)10s" }, pointGeom())]).queryAt(QUERY);
    expect(hit.title).toBe("Light");
    expect(hit.subtitle).toBe("Fl(2)10s");
  });
});

describe("LNDMRK: the category a generic 'Landmark' title does not say", () => {
  test("a named landmark shows its name AND its category, not one or the other", () => {
    // The real DE6OSTIM light tower (backend/data/fnc's fixture cell):
    // CATLMK=17 tower, FUNCTN=33 light support, OBJNAM Timmendorf. The name
    // alone never told the mariner it is a tower; the shape is the useful
    // word here, not FUNCTN's "light support".
    const [hit] = providerOver([
      feat("LNDMRK", { CATLMK: "17", FUNCTN: "33", OBJNAM: "Timmendorf", CONVIS: 1 }, pointGeom()),
    ]).queryAt(QUERY);
    expect(hit.title).toBe("Landmark");
    expect(hit.subtitle).toBe("Timmendorf · tower");
  });

  test("a nameless landmark is its category alone, capitalised", () => {
    const [hit] = providerOver([feat("LNDMRK", { CATLMK: "5", CONVIS: 2 }, pointGeom())]).queryAt(
      QUERY,
    );
    expect(hit.subtitle).toBe("Flagstaff");
  });

  test("a place of worship reads by function, not by the shape it is charted as", () => {
    // CATLMK=20 spire/minaret + FUNCTN=20 church — "Church" is what it is,
    // "Spire/minaret" only what it looks like. Same precedence chartcore's
    // symbol pick uses.
    const [hit] = providerOver([
      feat("LNDMRK", { CATLMK: "20", FUNCTN: "20" }, pointGeom()),
    ]).queryAt(QUERY);
    expect(hit.subtitle).toBe("Church");
  });

  test("list-valued CATLMK arrives comma-joined and takes its first code", () => {
    // MVT has no list type, so chartcore joins S-57 lists into one string.
    const [hit] = providerOver([
      feat("LNDMRK", { CATLMK: "15,17", OBJNAM: "St Mary" }, pointGeom()),
    ]).queryAt(QUERY);
    expect(hit.subtitle).toBe("St Mary · dome");
  });

  test("FUNCTN alone still names a landmark that has no CATLMK", () => {
    const [hit] = providerOver([feat("LNDMRK", { FUNCTN: "17" }, pointGeom())]).queryAt(QUERY);
    expect(hit.subtitle).toBe("Power station");
  });

  test("a landmark with neither name nor category has no subtitle, not a bare dot", () => {
    const [hit] = providerOver([feat("LNDMRK", { CONVIS: 1 }, pointGeom())]).queryAt(QUERY);
    expect(hit.subtitle).toBeUndefined();
  });

  test("an out-of-domain code is no category rather than a bare number", () => {
    const [hit] = providerOver([
      feat("LNDMRK", { CATLMK: "99", OBJNAM: "Timmendorf" }, pointGeom()),
    ]).queryAt(QUERY);
    expect(hit.subtitle).toBe("Timmendorf");
  });
});

describe("the RCID: the identity the highlight needs, next to the one the panel needs", () => {
  test("the MVT feature id reaches the payload as the RCID", () => {
    const [hit] = providerOver([
      feat("DEPARE", { drval1: 3, drval2: 6 }, areaGeom, "chart-DK", { id: 838 }),
    ]).queryAt(QUERY);
    expect(chartHitPayload(hit)?.rcid).toBe(838);
  });

  test("a hit adopts an RCID from a duplicate when its first representative had none", () => {
    // The area-wreck case, in the order MapLibre really returns it: the derived
    // label point (mvt/mod.rs wants_label_point) carries the polygon's
    // attributes and no id, and its symbol layer draws above the fill, so it
    // arrives first. One hit either way — the two say the same words — but only
    // the polygon's id can find the geometry to draw around.
    const hits = providerOver([
      feat("WRECKS", { CATWRK: 2 }, pointGeom(11.1, 57.2), "chart-DK", { id: undefined }),
      feat("WRECKS", { CATWRK: 2 }, areaGeom, "chart-DK", { id: 512 }),
    ]).queryAt(QUERY);
    expect(hits).toHaveLength(1);
    expect(hits[0].precision).toBe("point"); // still answered by the symbol
    expect(chartHitPayload(hits[0])?.rcid).toBe(512); // ...pointing at the polygon
  });

  test("the RCID does not split what the panel would say twice", () => {
    // Two cells of one merged tile can carry the same class with the same
    // attributes and *different* RCIDs. Keying identity on the RCID would list
    // the same sentence twice; content-keying is what collapses them, and it is
    // still right now that the id exists.
    const hits = providerOver([
      feat("DEPARE", { drval1: 3, drval2: 6 }, areaGeom, "chart-DK", { id: 838 }),
      feat("DEPARE", { drval1: 3, drval2: 6 }, areaGeom, "chart-DK", { id: 1902 }),
    ]).queryAt(QUERY);
    expect(hits).toHaveLength(1);
  });

  test("the highlight's own layers are not a source of hits", () => {
    // The highlight draws the selected object out of the chart source, so its
    // features pass the `chart-` check and arrive first (it sits on top). Left
    // in, an area wreck's highlight polygon would displace the label point that
    // answers for it — a rendering of the answer becoming an input to it.
    const hits = providerOver([
      feat("WRECKS", { CATWRK: 2 }, areaGeom, "chart-DK", {
        id: 512,
        layer: "info-highlight-line",
      }),
      feat("WRECKS", { CATWRK: 2 }, pointGeom(11.1, 57.2), "chart-DK"),
    ]).queryAt(QUERY);
    expect(hits).toHaveLength(1);
    expect(hits[0].precision).toBe("point");
    expect(hits[0].lngLat).toEqual({ lng: 11.1, lat: 57.2 });
  });
});

describe("area interiors: a drawn area answers a tap anywhere inside it", () => {
  // User: "some areas only show up in the poi list if i click the outline not
  // in the middle of it eg Restricted area at 55°19.1′N 015°09.4′E […] if a
  // area is drawn then clicking anywhere in that area should show it in the
  // list, maybe not first but it should be there". The real object (DK set,
  // RESARE "Ertholmene"): boundary line + centred symbol, no fill. Its
  // interior now reaches the query through the style's invisible tap target
  // (../style/areaHit.ts), which arrives as an ordinary RESARE polygon.
  const ERTHOLMENE = {
    CATREA: "4",
    INFORM: "Speed limit is 12 knots",
    OBJNAM: "Ertholmene",
    RESTRN: "27",
    bcol: "CHMGD",
    bwid: 2,
    sym: "notice-board",
  };
  const interior = (id = 4084) =>
    feat("RESARE", ERTHOLMENE, areaGeom, "chart-all", { id, layer: "chart-all-resare-area-hit" });
  const boundary = (id = 4084) =>
    feat("RESARE", ERTHOLMENE, areaGeom, "chart-all", { id, layer: "chart-all-resare-bdy" });
  const labelPoint = () =>
    feat("RESARE", ERTHOLMENE, pointGeom(15.19, 55.32), "chart-all", { layer: "chart-all-resare-sym" });
  const depth = () =>
    feat("DEPARE", { drval1: 40, drval2: 100 }, areaGeom, "chart-all", { id: 3967, layer: "chart-all-depare" });

  test("a tap in the middle of a restricted area lists it", () => {
    const hits = providerOver([depth(), interior()]).queryAt(QUERY);
    const resare = hits.find((h) => chartHitPayload(h)?.sourceLayer === "RESARE")!;
    expect(resare).toBeDefined();
    expect(resare.title).toBe("Restricted area");
    expect(resare.subtitle).toBe("Ertholmene");
    expect(resare.precision).toBe("area");
    // and the highlight can find the polygon to draw around
    expect(chartHitPayload(resare)?.rcid).toBe(4084);
  });

  test("interior-only ranks with the depth area, not ahead of everything in it", () => {
    // "maybe not first": the class tier (`regulated`) would put an area the
    // size of a firing range first on every tap inside it.
    const sounding = feat("SOUNDG", { DEPTH: 42 }, pointGeom(), "chart-all", { layer: "chart-all-soundg" });
    const hits = rankHits(providerOver([sounding, depth(), interior()]).queryAt(QUERY));
    expect(hits.map((h) => chartHitPayload(h)?.sourceLayer)).toEqual(["SOUNDG", "DEPARE", "RESARE"]);
    expect(hits[2].priority).toBe("area");
  });

  test("a tap on the boundary or the centred symbol keeps the class's own tier", () => {
    // MapLibre's order: symbol, boundary, then the bottom-most tap target.
    for (const drawn of [boundary(), labelPoint()]) {
      const hits = providerOver([drawn, depth(), interior()]).queryAt(QUERY);
      const resare = hits.filter((h) => chartHitPayload(h)?.sourceLayer === "RESARE");
      expect(resare).toHaveLength(1); // one object, however many layers answered
      expect(resare[0].priority).toBe("regulated");
      expect(chartHitPayload(resare[0])?.rcid).toBe(4084);
      expect(rankHits(hits)[0]).toBe(resare[0]);
    }
  });

  test("…whichever of the two arrives first", () => {
    const hits = providerOver([interior(), boundary()]).queryAt(QUERY);
    expect(hits).toHaveLength(1);
    expect(hits[0].priority).toBe("regulated");
  });

  test("the same area cut across two tiles is still interior-only", () => {
    const hits = providerOver([interior(), interior()]).queryAt(QUERY);
    expect(hits).toHaveLength(1);
    expect(hits[0].priority).toBe("area");
  });

  test("chartInteriorOnlyArea: the class and attributes of an interior-only hit, nothing for a drawn one", () => {
    // What another provider's `supersedes` reads: "the tap merely fell
    // inside" may be superseded, "the user pointed at the object" never.
    const [inside] = providerOver([interior()]).queryAt(QUERY);
    expect(chartInteriorOnlyArea(inside)).toEqual({ sourceLayer: "RESARE", props: ERTHOLMENE });
    // boundary or symbol under the tap as well — in either arrival order
    for (const features of [[boundary(), interior()], [interior(), boundary()], [labelPoint(), interior()]]) {
      const [drawn] = providerOver(features).queryAt(QUERY);
      expect(chartInteriorOnlyArea(drawn)).toBeUndefined();
    }
    // a filled area, a point object, a foreign hit, nothing at all
    const [filled] = providerOver([depth()]).queryAt(QUERY);
    expect(chartInteriorOnlyArea(filled)).toBeUndefined();
    expect(chartInteriorOnlyArea({ ...inside, providerId: "notices" })).toBeUndefined();
    expect(chartInteriorOnlyArea(undefined)).toBeUndefined();
  });

  test("the interior tier only ever demotes: a background class stays where it was", () => {
    const [sea] = providerOver([
      feat("SEAARE", { OBJNAM: "ØSTERSØEN" }, areaGeom, "chart-all", { layer: "chart-all-seaare-area-hit" }),
    ]).queryAt(QUERY);
    expect(sea.priority).toBe("context");
  });
});

describe("the isolated-danger promotion", () => {
  // The official S-52 UDWHAZ03 predicate over the tiles' derived facts. This
  // is the one place the panel's answer depends on a user setting, and it is
  // why a hit is ranked at query time and not at ingest.
  const wreck = { depth_value: 3, encl_drval1: 10 };

  test("shallow hazard in deep water is a danger, and outranks everything", () => {
    const hits = providerOver([
      feat("SOUNDG", { DEPTH: 12 }, pointGeom()),
      feat("WRECKS", wreck, areaGeom),
      feat("DEPARE", { drval1: 10, drval2: 20 }, areaGeom),
    ]).queryAt(QUERY);
    const best = rankHits(hits)[0];
    expect(best.title).toBe("Wreck");
    expect(best.priority).toBe("danger");
  });

  test("dragging the safety contour under it demotes it to a plain hazard", () => {
    const shallow: ChartSettings = { ...DEFAULT_SETTINGS, safetyContour: 2 };
    const [hit] = providerOver([feat("WRECKS", wreck)], shallow).queryAt(QUERY);
    expect(hit.priority).toBe("hazard");
  });

  test("a hazard with no surrounding depth area is not promoted", () => {
    expect(isIsolatedDanger("WRECKS", { depth_value: 3 }, DEFAULT_SETTINGS)).toBe(false);
  });

  test("WRECKS' QUASOU=7 gate blocks the promotion; OBSTRN has no such gate", () => {
    const props = { ...wreck, quasou7: true };
    expect(isIsolatedDanger("WRECKS", props, DEFAULT_SETTINGS)).toBe(false);
    expect(isIsolatedDanger("OBSTRN", props, DEFAULT_SETTINGS)).toBe(true);
  });

  test("only the three hazard classes can be promoted", () => {
    expect(isIsolatedDanger("DEPARE", wreck, DEFAULT_SETTINGS)).toBe(false);
    expect(isIsolatedDanger("UWTROC", wreck, DEFAULT_SETTINGS)).toBe(true);
  });
});

describe("identity", () => {
  test("one wreck across seven style layers and two tiles is one hit", () => {
    // A real wreck tap: fill, three edge cross-fades, symbol, overbar and
    // accuracy marker all return the same feature, and the tile buffer
    // returns it again from the neighbour.
    const props = { depth_value: 3, encl_drval1: 10, OBJNAM: "Nordkap" };
    const hits = providerOver(Array.from({ length: 7 }, () => feat("WRECKS", props))).queryAt(
      QUERY,
    );
    // Collapsed here rather than left for ./rank.ts, because a duplicate can
    // carry an RCID the first representative lacked and the registry never sees
    // the feature it came from. `dedupeHits` still runs, and still must — it is
    // what dedupes *across* providers — so this asserts the two agree.
    expect(hits).toHaveLength(1);
    expect(dedupeHits(hits)).toHaveLength(1);
  });

  test("different objects of the same class stay distinct", () => {
    const hits = providerOver([
      feat("SOUNDG", { DEPTH: 5 }, pointGeom()),
      feat("SOUNDG", { DEPTH: 7 }, pointGeom()),
    ]).queryAt(QUERY);
    expect(dedupeHits(hits)).toHaveLength(2);
  });

  test("the same class in two chart sets stays distinct", () => {
    const hits = providerOver([
      feat("DEPARE", { drval1: 0, drval2: 5 }, areaGeom, "chart-US5OAKIQ"),
      feat("DEPARE", { drval1: 0, drval2: 5 }, areaGeom, "chart-NO4XXXXX"),
    ]).queryAt(QUERY);
    expect(dedupeHits(hits)).toHaveLength(2);
  });
});

describe("detail", () => {
  test("decodes S-57 enums, including the comma-joined lists MVT forces", () => {
    // chartcore joins list attributes into a string (mvt/mod.rs attr_to_tag),
    // because MVT has no list type.
    const [hit] = providerOver([
      feat("ATON", { BOYSHP: 2, CATLAM: 1, COLOUR: "3,1", OBJNAM: "No 4" }, pointGeom()),
    ]).queryAt(QUERY);
    const rows = provider_rows(hit);
    expect(rows).toContainEqual({ label: "Name", value: "No 4" });
    expect(rows).toContainEqual({ label: "Colour", value: "red, white" });
    expect(rows).toContainEqual({ label: "Lateral mark", value: "port hand" });
    expect(rows).toContainEqual({ label: "Buoy shape", value: "can" });
  });

  test("calls the danger out first, and in the mariner's terms", () => {
    const [hit] = providerOver([feat("WRECKS", { depth_value: 3, encl_drval1: 10 })]).queryAt(
      QUERY,
    );
    const first = provider_rows(hit)[0];
    expect(first.label).toBe("Isolated danger");
    expect(first.emphasis).toBe(true);
  });

  test("shows chart truth but not the style's plumbing", () => {
    const [hit] = providerOver([
      feat("WRECKS", { CATWRK: 2, WATLEV: 3, sym: "wreck-hull_showing", lsty: "dott", dispcat: "base" }),
    ]).queryAt(QUERY);
    const rows = provider_rows(hit);
    expect(rows).toContainEqual({ label: "Category of wreck", value: "dangerous" });
    expect(rows).toContainEqual({ label: "Water level effect", value: "always under water/submerged" });
    expect(rows.map((r) => r.value)).not.toContain("wreck-hull_showing");
    expect(rows.map((r) => r.value)).not.toContain("dott");
  });

  test("an unknown attribute degrades to its acronym and raw value", () => {
    const [hit] = providerOver([feat("MORFAC", { CATMOR: 4 }, pointGeom())]).queryAt(QUERY);
    expect(provider_rows(hit)).toContainEqual({ label: "CATMOR", value: "4" });
  });

  test("names the chart set and the object class", () => {
    const [hit] = providerOver([feat("DEPARE", { DRVAL1: 0, DRVAL2: 5 })]).queryAt(QUERY);
    const provider = providerOver([]);
    const detail = provider.detail(hit) as { sections: { label?: string; rows: unknown[] }[] };
    const chart = detail.sections.find((s) => s.label === "Chart");
    expect(chart?.rows).toContainEqual({ label: "Chart set", value: "US5OAKIQ" });
    expect(chart?.rows).toContainEqual({ label: "Object class", value: "DEPARE" });
  });

  /**
   * #snyzntrn: under the `chart-all` union source every o-charts feature's
   * MapLibre `source` is just `"chart-all"` (../style/chartStyle.ts
   * `buildStyle`), so slicing `CHART_SOURCE_PREFIX` off it no longer names a
   * real set — chartcore instead stamps every served feature with a `set`
   * property (`merge_tiles_tagged`), and provenance must read THAT. This is
   * the frontend half of the #qwxtvtwo backend contract.
   */
  test("under chart-all, provenance comes from the feature's `set` tag, not the source id", () => {
    const [hit] = providerOver([
      feat("DEPARE", { DRVAL1: 0, DRVAL2: 5, set: "US5OAKIQ" }, areaGeom, "chart-all"),
    ]).queryAt(QUERY);
    const provider = providerOver([]);
    const detail = provider.detail(hit) as { sections: { label?: string; rows: unknown[] }[] };
    const chart = detail.sections.find((s) => s.label === "Chart");
    // NOT "all" — the slice of "chart-all" a naive source-id read would give.
    expect(chart?.rows).toContainEqual({ label: "Chart set", value: "US5OAKIQ" });
  });

  test("a hit with no payload says so instead of throwing", () => {
    const provider = providerOver([]);
    const detail = provider.detail({
      providerId: "chart",
      id: "x",
      priority: "aid",
      precision: "point",
      title: "?",
    }) as { sections: { rows: { value: string }[] }[] };
    expect(detail.sections[0].rows[0].value).toBe("not available");
  });
});

describe("external text descriptions (TXTDSC/NTXTDS)", () => {
  /** A provider whose text fetches are captured, so the note's `load` thunk can
   * be exercised without a network. */
  function withText(features: MapGeoJSONFeature[]) {
    const calls: [string, string][] = [];
    const provider = createChartInfoProvider({
      map: { queryRenderedFeatures: () => features },
      settings: () => DEFAULT_SETTINGS,
      loadText: (setId, name) => {
        calls.push([setId, name]);
        return Promise.resolve(`body of ${name}`);
      },
    });
    return { provider, calls };
  }

  test("a TXTDSC becomes a lazily-fetched note, not a bare filename row", async () => {
    const feature = feat("ACHARE", { OBJNAM: "Anchorage", TXTDSC: "US389IQB.TXT" }, areaGeom);
    const { provider, calls } = withText([feature]);
    const [hit] = provider.queryAt(QUERY);
    const detail = provider.detail(hit) as {
      sections: { rows: { value: string }[] }[];
      notes?: { label: string; load: () => Promise<string> }[];
    };

    // The filename is not shown as a row...
    const allRows = detail.sections.flatMap((s) => s.rows);
    expect(allRows.map((r) => r.value)).not.toContain("US389IQB.TXT");

    // ...it is a note, and nothing is fetched until the thunk is called.
    expect(detail.notes).toHaveLength(1);
    expect(detail.notes?.[0].label).toBe("Text description");
    expect(calls).toEqual([]);

    const body = await detail.notes?.[0].load();
    expect(body).toBe("body of US389IQB.TXT");
    expect(calls).toEqual([["US5OAKIQ", "US389IQB.TXT"]]);
  });

  test("TXTDSC and NTXTDS fold into one note, national as `alt` (#87-fork)", async () => {
    const feature = feat("CTNARE", { TXTDSC: "INTL.TXT", NTXTDS: "LOCAL.TXT" }, areaGeom);
    const { provider, calls } = withText([feature]);
    const [hit] = provider.queryAt(QUERY);
    const detail = provider.detail(hit) as {
      notes?: { label: string; load: () => Promise<string>; alt?: { label: string; load: () => Promise<string> } }[];
    };

    // One note, not two — TXTDSC (international) is the default...
    expect(detail.notes).toHaveLength(1);
    expect(detail.notes?.[0].label).toBe("Text description");
    expect(await detail.notes?.[0].load()).toBe("body of INTL.TXT");

    // ...NTXTDS (national) rides along as `alt`, its own independent fetch.
    expect(detail.notes?.[0].alt?.label).toBe("Text description (national language)");
    expect(await detail.notes?.[0].alt?.load()).toBe("body of LOCAL.TXT");
    expect(calls).toEqual([
      ["US5OAKIQ", "INTL.TXT"],
      ["US5OAKIQ", "LOCAL.TXT"],
    ]);
  });

  test("NTXTDS alone (no TXTDSC) stands as a plain note, no toggle", () => {
    const feature = feat("CTNARE", { NTXTDS: "LOCAL.TXT" }, areaGeom);
    const { provider } = withText([feature]);
    const [hit] = provider.queryAt(QUERY);
    const detail = provider.detail(hit) as { notes?: { label: string; alt?: unknown }[] };
    expect(detail.notes).toHaveLength(1);
    expect(detail.notes?.[0].label).toBe("Text description (national language)");
    expect(detail.notes?.[0].alt).toBeUndefined();
  });

  test("no notes field when the object references no text", () => {
    const { provider } = withText([feat("DEPARE", { DRVAL1: 0, DRVAL2: 5 })]);
    const [hit] = provider.queryAt(QUERY);
    const detail = provider.detail(hit) as { notes?: unknown };
    expect(detail.notes).toBeUndefined();
  });

  test("#snyzntrn: under chart-all, the text fetch keys on the feature's `set` tag", async () => {
    // Same as the plain TXTDSC test above, but the feature came from the
    // union source — /text/{set_id}/{name} would 404 against "all" (the
    // source-slice fallback), so this pins the fetch uses the tag instead.
    const feature = feat(
      "ACHARE",
      { OBJNAM: "Anchorage", TXTDSC: "US389IQB.TXT", set: "US5OAKIQ" },
      areaGeom,
      "chart-all",
    );
    const { provider, calls } = withText([feature]);
    const [hit] = provider.queryAt(QUERY);
    const detail = provider.detail(hit) as {
      notes?: { load: () => Promise<string> }[];
    };
    await detail.notes?.[0].load();
    expect(calls).toEqual([["US5OAKIQ", "US389IQB.TXT"]]);
  });
});

describe("the chart object's own S-52 sprite (icon)", () => {
  const payload = (props: Record<string, unknown>, danger = false): ChartHitPayload => ({
    sourceLayer: "LIGHTS",
    source: "chart-DK",
    props,
    danger,
  });

  test("names the class's `sym`, the same on every palette", () => {
    // Was `dark_LIGHTS11` at night. Symbol ids are palette-neutral now — the
    // colour comes from the theme's icon role table, applied where the SVG is
    // rasterised, not from picking a differently-baked atlas by name.
    expect(chartSpriteId(payload({ sym: "LIGHTS11" }))).toBe("LIGHTS11");
  });

  test("a promoted isolated danger wears ISODGR51, as the chart overpaints it", () => {
    expect(chartSpriteId(payload({ sym: "wreck-hull_showing" }, true))).toBe("ISODGR51");
  });

  test("a QUASOU=7 wreck wears wreck-dangerous here too, outranking its baked sym", () => {
    // lppokvtq: the chart stopped stacking a WRECKS07 overbar and now selects
    // the dangerous-wreck symbol outright (../style/aidsHazards.ts). If the
    // panel kept reading `sym` it would show bare masts for the object the
    // water shows a full dotted ellipse for.
    const props = { sym: "wreck-hull_showing", quasou7: true };
    expect(chartSpriteId(payload(props))).toBe("wreck-dangerous");
  });

  test("an ATON body with no class `sym` names its `sym_s`", () => {
    // There is exactly one ATON symbol attribute now — the `sym_p` paper twin
    // and the `symbolStyle` toggle that chose between them are gone (qpznkrtr),
    // so the name is no longer settings-dependent at all.
    expect(chartSpriteId(payload({ sym_s: "TOPMAR02S" }))).toBe("TOPMAR02S");
  });

  test("a line/area object with no point symbol has no sprite — the panel's chip stands in", () => {
    expect(chartSpriteId(payload({ drval1: 3, drval2: 6 }))).toBeUndefined();
  });

  test("icon() declines when the map exposes no sprite sheet (the unit-test double)", () => {
    // The default double has no `hasImage`, so the provider returns no icon and
    // the panel falls back to its chip — which is exactly what keeps every
    // pre-existing chart test unconcerned with sprites. ATON, not LIGHTS: every
    // light now resolves its own sector glyph regardless of the sprite sheet
    // (wwptvymz) and so is no longer a useful example of the plain sprite path.
    const [hit] = providerOver([feat("ATON", { sym: "BOYCON11" }, pointGeom())]).queryAt(QUERY);
    const provider = providerOver([]);
    expect(provider.icon?.(hit)).toBeUndefined();
  });

  test("icon() returns a component once the sprite is on the sheet", () => {
    const provider = createChartInfoProvider({
      map: {
        queryRenderedFeatures: () => [],
        hasImage: (id: string) => id === "BOYCON11",
      },
      settings: () => DEFAULT_SETTINGS,
    });
    const [hit] = providerOver([feat("ATON", { sym: "BOYCON11" }, pointGeom())]).queryAt(QUERY);
    expect(typeof provider.icon?.(hit)).toBe("function");
    // ...and a hit whose sprite is NOT on the sheet still declines.
    const [other] = providerOver([feat("ATON", { sym: "MISSING" }, pointGeom())]).queryAt(QUERY);
    expect(provider.icon?.(other)).toBeUndefined();
  });
});

describe("dedicated class icons (depth area, land, sounding, wreck)", () => {
  // The classes whose only picture used to be the chip (two areas, and a wreck
  // whose label point carries no sym) or a faint sprite (a sounding). A per-class
  // glyph, taking precedence over the sprite path so it works even against the
  // sprite-less unit-test double.
  test("DEPARE, DRGARE, SOUNDG and WRECKS resolve their class glyph without any sprite sheet", () => {
    const provider = providerOver([]);
    const iconFor = (sourceLayer: string, geom: Geom, props: Record<string, unknown> = {}) => {
      const [hit] = providerOver([feat(sourceLayer, props, geom)]).queryAt(QUERY);
      return provider.icon?.(hit);
    };
    expect(iconFor("DEPARE", areaGeom)).toBe(WavesHorizontal);
    // DRGARE (dredged area) carries a custom class glyph too — the same water
    // waves. (Land, LNDARE and LNDRGN both, is excluded from info now, so it has
    // no class glyph; see the exclusion test below.)
    expect(iconFor("DRGARE", areaGeom)).toBe(WavesHorizontal);
    expect(iconFor("SOUNDG", pointGeom(), { DEPTH: 5 })).toBe(ArrowDownToLine);
    expect(iconFor("WRECKS", areaGeom, { CATWRK: 2 })).toBe(WreckGlyph);
  });

  test("#INFO-ICONS-COMPLETE: UNSARE resolves the question-mark, and it is the generic floor", () => {
    // Every info-at-point type shows a picture, never a bare chip. UNSARE
    // (unsurveyed area) had no icon → the circle-with-question-mark; and that
    // same glyph is the fallback for any class with neither a class glyph nor an
    // S-52 point symbol, so an otherwise-unmapped class cannot render iconless.
    const provider = providerOver([]);
    const iconFor = (sourceLayer: string, props: Record<string, unknown> = {}) => {
      const [hit] = providerOver([feat(sourceLayer, props, areaGeom)]).queryAt(QUERY);
      return provider.icon?.(hit);
    };
    expect(iconFor("UNSARE")).toBe(CircleQuestionMark);
    // M_QUAL: a real class with no glyph here and no sym — the generic fallback.
    expect(iconFor("M_QUAL")).toBe(CircleQuestionMark);
  });

  test("a hit that names a sprite not on this sheet still declines (the sprite path's blank)", () => {
    // The generic fallback must NOT swallow the sprite path: an object that names
    // a sprite absent from the current sheet keeps declining (→ caller's chip),
    // exactly as before — only symbol-less classes take the question-mark. ATON,
    // not LIGHTS: every light now resolves its own sector glyph unconditionally
    // (wwptvymz), so it no longer exercises this "named but absent" sprite blank.
    const provider = providerOver([]);
    const [hit] = providerOver([feat("ATON", { sym: "BOYCON11" }, pointGeom())]).queryAt(QUERY);
    expect(provider.icon?.(hit)).toBeUndefined();
  });

  test("DEPCNT reuses the depth-area water glyph (it also carries line-primitive DEPARE)", () => {
    const provider = providerOver([]);
    const iconFor = (props: Record<string, unknown>) => {
      const [hit] = providerOver([feat("DEPCNT", props, lineGeom)]).queryAt(QUERY);
      return provider.icon?.(hit);
    };
    // a true contour (VALDCO) and a routed line-primitive DEPARE (drval1) both
    // resolve the same water glyph, without any sprite sheet
    expect(iconFor({ VALDCO: 10 })).toBe(WavesHorizontal);
    expect(iconFor({ drval1: 5, drval2: 10 })).toBe(WavesHorizontal);
  });

  test("a sounding's class glyph wins over the sprite it could otherwise resolve", () => {
    // SOUNDG is a point and could name a sprite, but the depth number is the
    // subject — so the class icon comes first, even when the sprite IS on sheet.
    const provider = createChartInfoProvider({
      map: {
        queryRenderedFeatures: () => [],
        hasImage: () => true,
      },
      settings: () => DEFAULT_SETTINGS,
    });
    const [hit] = providerOver([feat("SOUNDG", { DEPTH: 5, sym: "SOUNDS01" }, pointGeom())]).queryAt(QUERY);
    expect(provider.icon?.(hit)).toBe(ArrowDownToLine);
  });

  test("a wreck's class glyph wins over the sprite/ISODGR it could otherwise resolve", () => {
    // A wreck with an on-sheet sym, and even a promoted isolated danger (which
    // would otherwise overpaint ISODGR51), still shows the recognizable wreck
    // glyph — the class icon takes precedence for WRECKS too.
    const provider = createChartInfoProvider({
      map: {
        queryRenderedFeatures: () => [],
        hasImage: () => true,
      },
      settings: () => DEFAULT_SETTINGS,
    });
    const danger = { depth_value: 3, encl_drval1: 10, sym: "wreck-hull_showing" };
    const [hit] = providerOver([feat("WRECKS", danger, pointGeom())]).queryAt(QUERY);
    expect(hit.priority).toBe("danger"); // still ranked as a danger...
    expect(provider.icon?.(hit)).toBe(WreckGlyph); // ...but the icon is the wreck glyph
  });

  test("classes NOT in the lookup keep the sprite-or-chip path", () => {
    // A caution area is not a class-icon class and not a light, so with no
    // sprite sheet it still declines to the chip — the working sprite path
    // is untouched.
    const provider = providerOver([]);
    const [hit] = providerOver([feat("CTNARE", { sym: "caution" }, pointGeom())]).queryAt(QUERY);
    expect(provider.icon?.(hit)).toBeUndefined();
  });

  test("a sectored (or ring-only) light resolves the sector glyph, with no sprite sheet needed", () => {
    // A light with a real sector has no sprite at all (derive/lights.rs never
    // bakes `sym` alongside SECTR1/SECTR2) — the sector glyph is the only
    // picture it can ever show, sheet or not.
    const provider = providerOver([]);
    const [sectored] = providerOver([
      feat("LIGHTS", { SECTR1: 100, SECTR2: 200, lit_col: "LITRD", litdsn: "OcWRG 4s" }, pointGeom()),
    ]).queryAt(QUERY);
    expect(typeof provider.icon?.(sectored)).toBe("function");

    // A ring-only major light (no SECTR1/2, no `sym` either — VALNMR>=10)
    // keeps the sector glyph too, degraded to its one full-circle segment: a
    // reasonable stand-in for "there is a range ring here" absent a sprite.
    const [ringOnly] = providerOver([feat("LIGHTS", { lit_col: "LITYW" }, pointGeom())]).queryAt(QUERY);
    expect(typeof provider.icon?.(ringOnly)).toBe("function");
  });

  test("yqxkluqv: a light with a baked `sym` (flare/QUESMRK1) uses its real sprite, not the glyph", () => {
    // rkmzlpxy retired the flare/QUESMRK1 sprite in favour of a themed dot
    // drawn by the sector-arc overlay for every non-sectored light; the
    // user's own eyes on that (yqxkluqv) came back against it, so
    // aidsHazards.ts's `-lights-sym` icon layer is back for exactly the
    // lights that carry `sym` — the info panel must show that SAME icon, not
    // the abstract sector glyph, or the two would disagree again.
    const withSheet = createChartInfoProvider({
      map: {
        queryRenderedFeatures: () => [],
        hasImage: (id: string) => id === "LIGHTS11",
      },
      settings: () => DEFAULT_SETTINGS,
    });
    const [nonSectored] = providerOver([feat("LIGHTS", { sym: "LIGHTS11", lit_col: "LITYW" }, pointGeom())]).queryAt(
      QUERY,
    );
    // A component-less function is ambiguous between the sprite path and the
    // glyph, so pin it down: with NO sheet at all, the sprite path must
    // decline exactly as any other sprite-less object does.
    const noSheet = providerOver([feat("LIGHTS", { sym: "LIGHTS11", lit_col: "LITYW" }, pointGeom())]);
    const [noSheetHit] = noSheet.queryAt(QUERY);
    expect(noSheet.icon?.(noSheetHit)).toBeUndefined();
    expect(typeof withSheet.icon?.(nonSectored)).toBe("function");
  });
});

describe("lightSegments — a light hit's own sector geometry for the icon glyph", () => {
  test("a sectored light resolves one segment at its own angles and colour", () => {
    // SECTR1=100 (from seaward), SECTR2=200 -> flipped 180 and wrapped
    // (LIGHTS06), matching ../style/sectorGate.ts's own `sectorAngles`
    // (the exact function ../../features/sector-lights/overlay.ts derives
    // the on-chart arc from).
    const [hit] = providerOver([
      feat("LIGHTS", { SECTR1: 100, SECTR2: 200, lit_col: "LITGN" }, pointGeom()),
    ]).queryAt(QUERY);
    const payload = chartHitPayload(hit)!;
    const [seg] = lightSegments(payload, DEFAULT_SETTINGS);
    expect(seg.hasSector).toBe(true);
    expect(seg.a1).toBe(280); // 100 + 180
    expect(seg.a2).toBe(380); // (200 - 180) + 360, wrapped past a1
    expect(seg.color).toBe(paletteColors(DEFAULT_SETTINGS.palette).LITGN);
  });

  test("a non-sectored light degenerates to one full-circle segment in its own colour", () => {
    // Pinned to `day` rather than DEFAULT_SETTINGS: this asserts the OUTLINE
    // is present, so it needs a theme that keeps one. The default palette is
    // `paper2` since uqolozkr, and paper2 sets `sectorOutline: false` — see
    // the paper case below, which is the same assertion the other way.
    const outlined = { ...DEFAULT_SETTINGS, palette: "day" } as const;
    const [hit] = providerOver([feat("LIGHTS", { lit_col: "LITYW" }, pointGeom())]).queryAt(QUERY);
    const payload = chartHitPayload(hit)!;
    const [seg] = lightSegments(payload, outlined);
    expect(seg).toEqual({
      a1: 0,
      a2: 360,
      hasSector: false,
      color: paletteColors(outlined.palette).LITYW,
      outline: paletteColors(outlined.palette).OUTLW,
    });
  });

  test("no lit_col falls back to magenta (chartcore's own unknown-colour rule)", () => {
    const [hit] = providerOver([feat("LIGHTS", {}, pointGeom())]).queryAt(QUERY);
    const payload = chartHitPayload(hit)!;
    const [seg] = lightSegments(payload, DEFAULT_SETTINGS);
    expect(seg.color).toBe(paletteColors(DEFAULT_SETTINGS.palette).CHMGD);
  });

  test("a theme with sectorOutline: false (paper) carries no outline colour", () => {
    const [hit] = providerOver([feat("LIGHTS", { lit_col: "LITRD" }, pointGeom())]).queryAt(QUERY);
    const payload = chartHitPayload(hit)!;
    const [seg] = lightSegments(payload, { ...DEFAULT_SETTINGS, palette: "paper" });
    expect(seg.outline).toBeUndefined();
  });

  test("a light with several sectors (shared aid_group) resolves one segment each", () => {
    // Several LIGHTS objects at one coordinate — chartcore's `derive::
    // aid_group` co-location fold (no LNAM_REFS between siblings) — merge
    // into one hit whose `components` carry the other sectors (see the
    // "merging a lit buoy's components" describe block below, same mechanism).
    const at = pointGeom(12.6, 55.9);
    const G = "@1000:2000";
    const red = feat("LIGHTS", { SECTR1: 0, SECTR2: 90, lit_col: "LITRD", aid_group: G }, at, "chart-DK", {
      id: 1,
    });
    const green = feat("LIGHTS", { SECTR1: 90, SECTR2: 180, lit_col: "LITGN", aid_group: G }, at, "chart-DK", {
      id: 2,
    });
    const [hit] = providerOver([red, green]).queryAt(QUERY);
    const payload = chartHitPayload(hit)!;
    expect(payload.sourceLayer).toBe("LIGHTS"); // no ATON in the group — a light is its own primary
    const segments = lightSegments(payload, DEFAULT_SETTINGS);
    expect(segments).toHaveLength(2);
    expect(segments.map((s) => s.color).sort()).toEqual(
      [paletteColors(DEFAULT_SETTINGS.palette).LITRD, paletteColors(DEFAULT_SETTINGS.palette).LITGN].sort(),
    );
  });
});

describe("merging a lit buoy's components by aid_group", () => {
  // A lit buoy with a topmark is three S-57 objects: the ATON (buoy), a TOPMAR
  // and a LIGHTS. chartcore's derive binds them from the S-57 master/slave
  // relationship (LNAM_REFS, co-location fallback) and stamps a shared
  // `aid_group` tag on each; the merge groups by that tag, not by coordinate.
  const at = pointGeom(12.6, 55.9);
  const G = "022612409D780001"; // shared aid_group id, as chartcore would emit
  const buoy = () =>
    feat("ATON", { BOYSHP: 4, CATLAM: 2, OBJNAM: "No 3", aid_group: G }, at, "chart-DK", { id: 1 });
  const topmark = () => feat("TOPMAR", { TOPSHP: 2, aid_group: G }, at, "chart-DK", { id: 2 });
  const light = () =>
    feat(
      "LIGHTS",
      { COLOUR: 4, LITCHR: 2, SIGPER: 5, litdsn: "FlG 5s 12m 10M", aid_group: G },
      at,
      "chart-DK",
      { id: 3 },
    );

  test("buoy + topmark + light collapse to one hit, primary the structure", () => {
    const hits = providerOver([topmark(), light(), buoy()]).queryAt(QUERY);
    expect(hits).toHaveLength(1);
    const [hit] = hits;
    expect(hit.title).toBe("Buoy"); // the structure, not the topmark or light
    // the buoy's name, then the light's characteristic appended — the folded
    // LIGHTS component's baked `litdsn` trimmed of its "12m 10M" height/range
    // tail (the standalone light's subtitle minus that tail)
    expect(hit.subtitle).toBe("No 3 · FlG 5s");
    expect(hit.precision).toBe("point");
    expect(hit.priority).toBe("aid");
    // The composite payload is the primary object's, so the highlight/icon
    // still resolve the buoy.
    const payload = chartHitPayload(hit);
    expect(payload?.sourceLayer).toBe("ATON");
    expect(payload?.rcid).toBe(1);
    expect(payload?.components?.map((c) => c.sourceLayer)).toEqual(["TOPMAR", "LIGHTS"]);
  });

  test("the id is stable regardless of the order the components arrive", () => {
    const a = providerOver([topmark(), light(), buoy()]).queryAt(QUERY)[0];
    const b = providerOver([buoy(), light(), topmark()]).queryAt(QUERY)[0];
    expect(a.id).toBe(b.id);
    expect(dedupeHits([a, b])).toHaveLength(1);
  });

  test("detail carries the primary rows, then a Topmark and a Light section", () => {
    const [hit] = providerOver([buoy(), topmark(), light()]).queryAt(QUERY);
    const provider = providerOver([]);
    const detail = provider.detail(hit) as {
      sections: { label?: string; rows: { label: string; value: string }[] }[];
    };
    const labels = detail.sections.map((s) => s.label);
    expect(labels).toEqual([undefined, "Topmark", "Light", "Chart"]);
    // primary rows are the buoy's
    expect(detail.sections[0].rows).toContainEqual({ label: "Name", value: "No 3" });
    // topmark shape decoded in its own section
    const topSec = detail.sections.find((s) => s.label === "Topmark");
    expect(topSec?.rows).toContainEqual({ label: "Topmark shape", value: "cone, point down" });
    // the light's characteristics, including the description that would
    // otherwise be swallowed as a subtitle
    const lightSec = detail.sections.find((s) => s.label === "Light");
    expect(lightSec?.rows).toContainEqual({ label: "Colour", value: "green" });
    expect(lightSec?.rows).toContainEqual({ label: "Light character", value: "flashing" });
    expect(lightSec?.rows).toContainEqual({ label: "Light description", value: "FlG 5s 12m 10M" });
    // one Chart section, not three
    expect(labels.filter((l) => l === "Chart")).toHaveLength(1);
    const chart = detail.sections.find((s) => s.label === "Chart");
    expect(chart?.rows).toContainEqual({ label: "Object class", value: "ATON" });
  });

  test("the composite icon resolves the primary structure's sprite", () => {
    // Give the buoy a `sym` so the sprite path has something to resolve; the
    // composite payload is the buoy's, so `icon` finds it through the merge.
    // Only the buoy's sprite is on the sheet here, so the stack collapses to
    // the single base sprite — still a rendered component.
    const provider = createChartInfoProvider({
      map: {
        queryRenderedFeatures: () => [
          feat("ATON", { BOYSHP: 4, sym: "BOYLAT13", aid_group: G }, at, "chart-DK", { id: 1 }),
          topmark(),
          light(),
        ],
        hasImage: (id: string) => id === "BOYLAT13",
      },
      settings: () => DEFAULT_SETTINGS,
    });
    const [hit] = provider.queryAt(QUERY);
    expect(typeof provider.icon?.(hit)).toBe("function"); // the buoy's sprite
  });

  test("the composite icon stacks the on-sheet component sprites over the base", () => {
    // Buoy base + a light flare both on the sheet → the composite path fires
    // (a distinct component from the single-sprite one, still a function).
    const provider = createChartInfoProvider({
      map: {
        queryRenderedFeatures: () => [
          feat("ATON", { BOYSHP: 4, sym: "BOYLAT13", aid_group: G }, at, "chart-DK", { id: 1 }),
          feat("LIGHTS", { sym: "LIGHTS13", litdsn: "FlG 5s", aid_group: G }, at, "chart-DK", { id: 3 }),
        ],
        hasImage: (id: string) => id === "BOYLAT13" || id === "LIGHTS13",
      },
      settings: () => DEFAULT_SETTINGS,
    });
    const [hit] = provider.queryAt(QUERY);
    expect(chartHitPayload(hit)?.components?.map((c) => c.sourceLayer)).toEqual(["LIGHTS"]);
    expect(typeof provider.icon?.(hit)).toBe("function");
  });

  test("#BUOY-ICON-TOPMARK: the extracted icon keeps the topmark's mark", () => {
    // The reported bug: an East cardinal spar buoy (topmark "2 cones, base
    // together") showed the spar body only — no topmark, because the composite
    // dropped a component whose styled sprite was absent, even though the detail
    // panel still listed a TOPMARK section from raw props. The original fix was
    // an `iconFallback` opt-in to the `sym_p` paper mark; that opt-in is gone
    // with the paper/simplified split itself (qpznkrtr) — a TOPMAR now always
    // carries `sym_s` — but the regression it guards is the same: the topmark
    // must survive into the stacked icon.
    const baseSym = "BOYCAR01"; // the spar body
    const topmarkSym = "TOPMAR13"; // 2 cones base together
    const provider = createChartInfoProvider({
      map: {
        queryRenderedFeatures: () => [
          feat("ATON", { BOYSHP: 5, sym: baseSym, aid_group: G }, at, "chart-DK", { id: 1 }),
          feat("TOPMAR", { TOPSHP: 2, sym_s: topmarkSym, aid_group: G }, at, "chart-DK", { id: 2 }),
        ],
        // both the spar body and the topmark are on the sheet
        hasImage: (id: string) => id === baseSym || id === topmarkSym,
      },
      settings: () => DEFAULT_SETTINGS,
    });
    const [hit] = provider.queryAt(QUERY);
    const payload = chartHitPayload(hit);
    expect(payload?.components?.map((c) => c.sourceLayer)).toEqual(["TOPMAR"]);
    const onSheet = (id: string | undefined): id is string =>
      !!id && (id === baseSym || id === topmarkSym);
    const layers = aidIconLayers(payload!, onSheet);
    expect(layers).toEqual([
      { spriteId: baseSym, role: "base" },
      { spriteId: topmarkSym, role: "topmark" },
    ]);
    // the same TOPMAR tapped on its own resolves to that same sprite — base and
    // component resolution are one path now, no opt-in between them.
    const topmarkPayload = payload!.components![0];
    expect(chartSpriteId(topmarkPayload)).toBe(topmarkSym);
  });

  test("a light on a buoy keeps the buoy's danger/aid rank as the max across the group", () => {
    // All aid components are `aid`, so the max is `aid`; the reducer is what
    // would carry a higher-ranked component through if one ever appeared.
    const [hit] = providerOver([buoy(), light()]).queryAt(QUERY);
    expect(hit.priority).toBe("aid");
  });

  test("a light with no buoy (no ATON) is primary when merged with a topmark", () => {
    const [hit] = providerOver([topmark(), light()]).queryAt(QUERY);
    expect(hit.title).toBe("Light");
    // the light is the primary here (no ATON), so its subtitle is the full
    // baked litdsn — the standalone form, untrimmed (only a FOLDED light trims)
    expect(hit.subtitle).toBe("FlG 5s 12m 10M");
    expect(chartHitPayload(hit)?.components?.map((c) => c.sourceLayer)).toEqual(["TOPMAR"]);
  });

  test("#AID-PICK-PARTIAL: every group member is folded even when co-located components share identical props and the primary is tapped last", () => {
    // The boat bug: tapping an aid sometimes shows only PART of its group,
    // "primarily when it is NOT the first target". Two distinct S-57 objects of
    // ONE aid can be byte-identical in their decoded tile props — here a buoy
    // carrying two same-characteristic sector LIGHTS (distinct RCIDs, identical
    // attributes). The content-only `hitId` dedup, keep-first, would collapse the
    // second light into the first BEFORE `mergeAidComponents` groups by
    // `aid_group`, so the composite lost a member — the one that was not the
    // first-seen representative. Arrange the group NOT first in the hit list and
    // the structure (the eventual primary) LAST, so a naive forward scan/keep-
    // first is maximally exposed: both lights must still survive into components.
    const litProps = { COLOUR: "3,1", LITCHR: 4, litdsn: "QRW 5s", aid_group: G };
    const hits = providerOver([
      feat("DEPARE", { drval1: 0, drval2: 5 }, areaGeom, "chart-DK", { id: 90 }), // unrelated, first
      feat("LIGHTS", litProps, at, "chart-DK", { id: 3 }), // sector light A
      feat("LIGHTS", litProps, at, "chart-DK", { id: 4 }), // sector light B — identical props, distinct object
      feat("ATON", { BOYSHP: 4, CATLAM: 2, OBJNAM: "No 3", aid_group: G }, at, "chart-DK", { id: 1 }),
    ]).queryAt(QUERY);
    const aid = hits.find((h) => chartHitPayload(h)?.sourceLayer === "ATON")!;
    expect(chartHitPayload(aid)?.sourceLayer).toBe("ATON"); // primary by PRIMARY_ORDER, not tap order
    // both distinct lights are folded in — neither dropped by the pre-fold dedup
    expect(chartHitPayload(aid)?.components?.map((c) => c.sourceLayer)).toEqual(["LIGHTS", "LIGHTS"]);
  });

  test("#trsowlwt: several standalone lights on one structure (no ATON, no OBJNAM) fold into ONE info-panel entry", () => {
    // The reported symptom: several LIGHTS on one physical structure (no BOY*/
    // BCN* — e.g. a lighthouse charted as LNDMRK, not a buoy) each showing as
    // its own separate info-panel row. The merge already keys purely off
    // `aid_group` (mergeAidComponents/isMergeableGroup: "a light with no
    // structure still merges" — no ATON is required), so this collapses the
    // same way #AID-PICK-PARTIAL's buoy+2-lights case does; this test just
    // exercises the no-structure shape end to end, including `detail()`,
    // which #AID-PICK-PARTIAL does not check.
    const red = feat("LIGHTS", { SECTR1: 0, SECTR2: 120, COLOUR: 3, lit_col: "LITRD", litdsn: "FR", aid_group: G }, at, "chart-DK", {
      id: 11,
    });
    const green = feat(
      "LIGHTS",
      { SECTR1: 120, SECTR2: 240, COLOUR: 4, lit_col: "LITGN", litdsn: "FG", aid_group: G },
      at,
      "chart-DK",
      { id: 12 },
    );
    const hits = providerOver([red, green]).queryAt(QUERY);
    expect(hits).toHaveLength(1); // not two separate rows
    const [hit] = hits;
    expect(hit.title).toBe("Light"); // no ATON in the group — a light is its own primary
    const payload = chartHitPayload(hit);
    expect(payload?.components?.map((c) => c.sourceLayer)).toEqual(["LIGHTS"]);
    // The icon reads both sectors (createSectorLightGlyph via lightSegments),
    // not just the primary's own.
    expect(lightSegments(payload!, DEFAULT_SETTINGS)).toHaveLength(2);
    // detail(): the primary's own rows, then one more "Light" section for the
    // folded sibling — two lights' worth of attributes, not one hit silently
    // dropped.
    const provider = providerOver([]);
    const detail = provider.detail(hit) as {
      sections: { label?: string; rows: { label: string; value: string }[] }[];
    };
    expect(detail.sections.map((s) => s.label)).toEqual([undefined, "Light", "Chart"]);
    expect(detail.sections[0].rows).toContainEqual({ label: "Colour", value: "red" });
    const foldedLight = detail.sections.find((s) => s.label === "Light");
    expect(foldedLight?.rows).toContainEqual({ label: "Colour", value: "green" });
  });

  test("#SECTOR-LIGHT-TAP: a sectored light is tappable through its opacity-0 hit-target circle alone", () => {
    // A sectored light draws its arcs from a custom WebGL layer that
    // queryRenderedFeatures cannot see; its symbol/description layers may be off.
    // aidsHazards.ts keeps it tappable with a deliberately opacity-0 circle on the
    // LIGHTS source-layer (`-lights-sector`). MapLibre hit-tests geometry, not
    // alpha, so that hit reaches queryAt as an ordinary LIGHTS feature — and folds
    // into its aid_group like any other light. Simulate the circle being the ONLY
    // queryable representative of the light.
    const hits = providerOver([
      feat("ATON", { BOYSHP: 4, OBJNAM: "No 3", aid_group: G }, at, "chart-DK", { id: 1 }),
      feat("LIGHTS", { lit_arc: true, litdsn: "OcWRG 4s", aid_group: G }, at, "chart-DK", {
        id: 3,
        layer: "chart-DK-lights-sector", // the opacity-0 hit-target layer
      }),
    ]).queryAt(QUERY);
    expect(hits).toHaveLength(1);
    expect(chartHitPayload(hits[0])?.components?.map((c) => c.sourceLayer)).toEqual(["LIGHTS"]);
  });

  test("a plain unlit buoy is unchanged — a group of one is not a merge", () => {
    const [hit] = providerOver([buoy()]).queryAt(QUERY);
    expect(hit.title).toBe("Buoy");
    expect(chartHitPayload(hit)?.components).toBeUndefined();
    const provider = providerOver([]);
    const detail = provider.detail(hit) as { sections: { label?: string }[] };
    expect(detail.sections.map((s) => s.label)).toEqual([undefined, "Chart"]);
  });

  test("a standalone major light is unchanged", () => {
    const [hit] = providerOver([
      feat("LIGHTS", { litdsn: "Fl(2)10s", VALNMR: 18 }, pointGeom(11.1, 57.2)),
    ]).queryAt(QUERY);
    expect(hit.title).toBe("Light");
    expect(chartHitPayload(hit)?.components).toBeUndefined();
  });

  test("two distinct aids do not merge — no shared aid_group", () => {
    // Two separate lit buoys carry two different aid_group ids (or none),
    // so they stay two hits even were they to share a point.
    const hits = providerOver([
      feat("ATON", { BOYSHP: 4, aid_group: "AID-A" }, pointGeom(12.6, 55.9), "chart-DK", { id: 1 }),
      feat("ATON", { BOYSHP: 2, aid_group: "AID-B" }, pointGeom(12.7, 55.9), "chart-DK", { id: 2 }),
    ]).queryAt(QUERY);
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => chartHitPayload(h)?.components === undefined)).toBe(true);
  });

  test("a co-located hazard is never folded in — only the aid-component classes", () => {
    // A wreck happening to share the buoy's coordinate is a different thing and
    // stays its own hit.
    const hits = providerOver([
      buoy(),
      light(),
      feat("WRECKS", { CATWRK: 2 }, at, "chart-DK", { id: 9 }),
    ]).queryAt(QUERY);
    expect(hits).toHaveLength(2);
    const wreck = hits.find((h) => h.title === "Wreck");
    expect(wreck).toBeDefined();
    expect(chartHitPayload(wreck!)?.components).toBeUndefined();
  });

  test("an untagged line aid is not merged — chartcore tags only point aids", () => {
    // A line LIGHTS (a sector's arc, say) carries no aid_group, so it never
    // joins the buoy's group however it is positioned.
    const hits = providerOver([
      buoy(),
      light(),
      feat("LIGHTS", { litdsn: "sector" }, lineGeom, "chart-DK", { id: 9 }),
    ]).queryAt(QUERY);
    // the tagged buoy+light merge; the untagged line LIGHTS stays separate
    expect(hits).toHaveLength(2);
  });
});

describe("#AID-DOUBLE-COUNT: a light-only tap re-queries at the light's anchor for its buoy", () => {
  // The S-52 flare draws its graphic OFFSET from the icon pivot, so a tap on the
  // flare tip can land on the LIGHTS feature alone — the co-located buoy is not
  // under the finger. The light carries only its `aid_group` id, none of the
  // buoy's props, so a bare "Light" is all the one query can build. The fix
  // re-queries at the light's OWN anchor (shared with the buoy) to pull the buoy
  // in, then folds as normal so it presents identically to a direct buoy tap.
  const at = pointGeom(12.6, 55.9);
  const G = "022612409D780001"; // shared aid_group id, as chartcore would emit
  const lightFeat = () =>
    feat(
      "LIGHTS",
      { COLOUR: 4, LITCHR: 2, SIGPER: 5, litdsn: "FlG 5s 12m 10M", aid_group: G },
      at,
      "chart-DK",
      { id: 3 },
    );
  const buoyFeat = () =>
    feat("ATON", { BOYSHP: 4, CATLAM: 2, OBJNAM: "No 3", aid_group: G }, at, "chart-DK", { id: 1 });

  /** A queryRenderedFeatures double whose Nth call returns `responses[N]` (the
   * last entry repeats), and that projects any lngLat to a fixed screen point.
   * `calls` records each query's geometry so a test can assert whether — and how
   * many times — a re-query fired. */
  function requeryMap(responses: MapGeoJSONFeature[][]) {
    const calls: unknown[] = [];
    return {
      calls,
      // Screen origin read through `this` on purpose: MapLibre's `Map.project`
      // reads `this.transform`, so `project` must be called on its receiver.
      // A method (not an arrow) that touches `this` makes a DETACHED call throw
      // ("this is undefined") — reproducing the crash from pulling
      // `opts.map.project` into a bare variable, and guarding the fix.
      _origin: { x: 100, y: 100 },
      queryRenderedFeatures: (geometry?: unknown) => {
        const response = responses[Math.min(calls.length, responses.length - 1)];
        calls.push(geometry);
        return response;
      },
      project(this: { _origin: { x: number; y: number } }, _lngLat: { lng: number; lat: number }) {
        return { x: this._origin.x, y: this._origin.y };
      },
    };
  }

  test("a lone grouped LIGHTS (no ATON present) folds to the composite after re-query", () => {
    // Initial query returns only the light; the re-query at its anchor returns
    // the co-located buoy (and the light again).
    const map = requeryMap([[lightFeat()], [buoyFeat(), lightFeat()]]);
    const hits = createChartInfoProvider({ map, settings: () => DEFAULT_SETTINGS }).queryAt(QUERY);
    expect(hits).toHaveLength(1);
    const [hit] = hits;
    expect(hit.title).toBe("Buoy"); // presents identically to a direct buoy tap
    expect(hit.subtitle).toBe("No 3 · FlG 5s"); // name + the light's trimmed litdsn
    expect(chartHitPayload(hit)?.sourceLayer).toBe("ATON");
    expect(chartHitPayload(hit)?.rcid).toBe(1);
    expect(chartHitPayload(hit)?.components?.map((c) => c.sourceLayer)).toEqual(["LIGHTS"]);
    expect(map.calls).toHaveLength(2); // exactly one re-query
  });

  test("re-query finds no buoy → the light stays a standalone target, no loop", () => {
    const map = requeryMap([[lightFeat()]]); // every query returns only the light
    const hits = createChartInfoProvider({ map, settings: () => DEFAULT_SETTINGS }).queryAt(QUERY);
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe("Light");
    expect(chartHitPayload(hits[0])?.components).toBeUndefined();
    expect(map.calls).toHaveLength(2); // tried once, then gave up — no re-query loop
  });

  test("no-regression: an ATON already present is not re-queried or double-counted", () => {
    const map = requeryMap([[buoyFeat(), lightFeat()]]);
    const hits = createChartInfoProvider({ map, settings: () => DEFAULT_SETTINGS }).queryAt(QUERY);
    expect(hits).toHaveLength(1);
    expect(chartHitPayload(hits[0])?.sourceLayer).toBe("ATON");
    expect(chartHitPayload(hits[0])?.components?.map((c) => c.sourceLayer)).toEqual(["LIGHTS"]);
    expect(map.calls).toHaveLength(1); // NO re-query when the structure is already there
  });
});

describe("merging depth at a point", () => {
  // A tap in shoal water lands on the depth AREA it is inside and, near a
  // boundary, on the depth CONTOURS around it — separate S-57 objects with no
  // shared coordinate or tag. They fold into one "Depth" hit by class (unlike
  // aids, which fold by the chartcore `aid_group` tag). SOUNDG is left out.
  const area = (drval1: number, drval2: number, id: number, cls = "DEPARE") =>
    feat(cls, { drval1, drval2, DRVAL1: drval1, DRVAL2: drval2 }, areaGeom, "chart-DK", { id });
  const contour = (valdco: number, id: number) =>
    feat("DEPCNT", { VALDCO: valdco, valdco }, lineGeom, "chart-DK", { id });

  test("a depth area + contour collapse to one Depth hit, primary the area", () => {
    const hits = providerOver([contour(6, 20), area(4, 6, 10)]).queryAt(QUERY);
    expect(hits).toHaveLength(1);
    const [hit] = hits;
    expect(hit.title).toBe("Depth");
    expect(hit.subtitle).toBe("4–6 m"); // the band's range, not a contour value
    // Priority/precision are the band's — the area, not the contour.
    expect(hit.priority).toBe("area");
    expect(hit.precision).toBe("area");
    const payload = chartHitPayload(hit);
    // The composite payload is the area's, so ./highlight.ts outlines the band.
    expect(payload?.sourceLayer).toBe("DEPARE");
    expect(payload?.rcid).toBe(10);
    expect(payload?.components?.map((c) => c.sourceLayer)).toEqual(["DEPCNT"]);
  });

  test("its detail combines the band range, the contour value, and provenance", () => {
    const [hit] = providerOver([area(4, 6, 10), contour(6, 20)]).queryAt(QUERY);
    const provider = providerOver([]);
    const detail = provider.detail(hit) as {
      sections: { label?: string; rows: { label: string; value: string }[] }[];
    };
    const labels = detail.sections.map((s) => s.label);
    expect(labels).toEqual([undefined, "Depth contour", "Chart"]);
    // the band's range in the primary (unlabelled) section
    expect(detail.sections[0].rows).toContainEqual({ label: "Minimum depth (m)", value: "4" });
    expect(detail.sections[0].rows).toContainEqual({ label: "Maximum depth (m)", value: "6" });
    // the contour value in its own section
    const contourSec = detail.sections.find((s) => s.label === "Depth contour");
    expect(contourSec?.rows).toContainEqual({ label: "Contour depth (m)", value: "6" });
    // one Chart section, naming the primary band's class
    expect(labels.filter((l) => l === "Chart")).toHaveLength(1);
    const chart = detail.sections.find((s) => s.label === "Chart");
    expect(chart?.rows).toContainEqual({ label: "Chart set", value: "DK" });
    expect(chart?.rows).toContainEqual({ label: "Object class", value: "DEPARE" });
  });

  test("the composite Depth hit shows the water glyph", () => {
    const provider = providerOver([]);
    const [hit] = providerOver([area(4, 6, 10), contour(6, 20)]).queryAt(QUERY);
    expect(provider.icon?.(hit)).toBe(WavesHorizontal);
  });

  test("a lone depth area is unchanged — a group of one is not a merge", () => {
    const [hit] = providerOver([area(4, 6, 10)]).queryAt(QUERY);
    expect(hit.title).toBe("Depth area");
    expect(chartHitPayload(hit)?.components).toBeUndefined();
  });

  test("a lone contour is unchanged", () => {
    const [hit] = providerOver([contour(10, 20)]).queryAt(QUERY);
    expect(hit.title).toBe("Depth contour");
    expect(chartHitPayload(hit)?.components).toBeUndefined();
  });

  test("multiple contours and a second area all fold into one Depth hit", () => {
    const hits = providerOver([
      area(4, 6, 10),
      area(6, 10, 11),
      contour(6, 20),
      contour(10, 21),
    ]).queryAt(QUERY);
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe("Depth");
    // primary the first area; the other area + both contours are components
    expect(chartHitPayload(hits[0])?.components?.map((c) => c.sourceLayer)).toEqual([
      "DEPARE",
      "DEPCNT",
      "DEPCNT",
    ]);
  });

  test("a dredged area merges too, and is the primary band when no DEPARE was tapped", () => {
    const [hit] = providerOver([contour(6, 20), area(4, 6, 12, "DRGARE")]).queryAt(QUERY);
    expect(hit.title).toBe("Depth");
    expect(hit.priority).toBe("area");
    expect(chartHitPayload(hit)?.sourceLayer).toBe("DRGARE");
    expect(providerOver([]).icon?.(hit)).toBe(WavesHorizontal);
  });

  test("a SOUNDG is never folded in — it is a more precise, separate answer", () => {
    const hits = providerOver([
      area(4, 6, 10),
      contour(6, 20),
      feat("SOUNDG", { DEPTH: 5.2 }, pointGeom(), "chart-DK", { id: 30 }),
    ]).queryAt(QUERY);
    expect(hits).toHaveLength(2);
    const depth = hits.find((h) => h.title === "Depth");
    const sounding = hits.find((h) => h.title === "Sounding");
    expect(depth).toBeDefined();
    expect(sounding).toBeDefined();
    expect(sounding?.subtitle).toBe("5.2 m");
    expect(chartHitPayload(depth!)?.components?.map((c) => c.sourceLayer)).toEqual(["DEPCNT"]);
  });

  test("the id is stable regardless of the order the depth objects arrive", () => {
    const a = providerOver([area(4, 6, 10), contour(6, 20)]).queryAt(QUERY)[0];
    const b = providerOver([contour(6, 20), area(4, 6, 10)]).queryAt(QUERY)[0];
    expect(a.id).toBe(b.id);
    expect(dedupeHits([a, b])).toHaveLength(1);
  });

  test("depth and aids merge independently in one tap", () => {
    const G = "022612409D780001";
    const hits = providerOver([
      feat("ATON", { BOYSHP: 4, OBJNAM: "No 3", aid_group: G }, pointGeom(12.6, 55.9), "chart-DK", { id: 1 }),
      feat("LIGHTS", { litdsn: "FlG 5s", aid_group: G }, pointGeom(12.6, 55.9), "chart-DK", { id: 2 }),
      area(4, 6, 10),
      contour(6, 20),
    ]).queryAt(QUERY);
    expect(hits).toHaveLength(2);
    const buoy = hits.find((h) => h.title === "Buoy");
    const depth = hits.find((h) => h.title === "Depth");
    expect(chartHitPayload(buoy!)?.components?.map((c) => c.sourceLayer)).toEqual(["LIGHTS"]);
    expect(chartHitPayload(depth!)?.components?.map((c) => c.sourceLayer)).toEqual(["DEPCNT"]);
  });
});

/** First section's rows of a chart hit's detail (sync by construction). */
function provider_rows(hit: Parameters<ReturnType<typeof providerOver>["detail"]>[0]) {
  const detail = providerOver([]).detail(hit) as {
    sections: { rows: { label: string; value: string; emphasis?: boolean }[] }[];
  };
  return detail.sections[0].rows;
}

describe("fetchChartText (the default note loader)", () => {
  /** Swap `fetch` for a canned response, always restoring — bun shares one
   * global per run, so a leaked stub would poison every later file. */
  async function withFetch<T>(
    reply: () => Promise<Response>,
    body: (url: () => string | undefined) => Promise<T>,
  ): Promise<T> {
    const original = globalThis.fetch;
    let seen: string | undefined;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      seen = String(input);
      return reply();
    }) as typeof fetch;
    try {
      return await body(() => seen);
    } finally {
      globalThis.fetch = original;
    }
  }

  test("a note the set really ships comes back as its text", async () => {
    const text = await withFetch(
      async () => new Response("ROUTE T and THE SOUND\n", { status: 200 }),
      async (url) => {
        const got = await fetchChartText("oeuSENC-DK", "DKNO7001.TXT");
        expect(url()).toBe("/api/text/oeuSENC-DK/DKNO7001.TXT");
        return got;
      },
    );
    expect(text).toBe("ROUTE T and THE SOUND\n");
  });

  test("404 says the chart set has no such note, naming it", async () => {
    await withFetch(
      async () => new Response("nope", { status: 404 }),
      async () =>
        expect(fetchChartText("set", "DKNO7001.TXT")).rejects.toThrow(
          /doesn.t include the note DKNO7001\.TXT/,
        ),
    );
  });

  test("any other status is a real failure and keeps the status", async () => {
    await withFetch(
      async () => new Response("boom", { status: 503 }),
      async () => expect(fetchChartText("set", "N.TXT")).rejects.toThrow(/HTTP 503/),
    );
  });

  test("a dead server does not leak a raw network error into the panel", async () => {
    await withFetch(
      () => Promise.reject(new TypeError("Failed to fetch")),
      async () =>
        expect(fetchChartText("set", "N.TXT")).rejects.toThrow(/chart server didn.t answer/),
    );
  });
});
