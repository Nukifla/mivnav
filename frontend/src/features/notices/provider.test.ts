// The notices info provider: scoped to the overlay's own layers, ONE hit per
// message, hazard vs regulated priority, and the detail mapping (sections,
// references, Danish primary / English alt) — against a
// `queryRenderedFeatures` double and a detail-loader seam, no network.

import { describe, expect, test } from "bun:test";
import type { MapGeoJSONFeature } from "maplibre-gl";
import { chartHitPayload, createChartInfoProvider } from "../../core/info/chartProvider";
import type { QueryableMap } from "../../core/info/queryGuard";
import { DEFAULT_SETTINGS } from "../../core/style/settings";
import { queryInfoAt } from "../../core/info/registry";
import type { InfoDetail, InfoHit, InfoProvider, InfoQuery } from "../../core/info/types";
import {
  NOTICES_AREA_HIT_LAYER_ID,
  NOTICES_HATCH_LAYER_ID,
  NOTICES_ICON_LAYER_ID,
  NOTICES_OUTLINE_LAYER_ID,
  NOTICES_POINT_HIT_LAYER_ID,
  NOTICES_VERTEX_LABEL_LAYER_ID,
} from "./overlay";
import {
  buildNoticeDetail,
  createNoticesProvider,
  foldFiringHits,
  INTERIOR_PRIORITY,
  isChartedFiringInterior,
  noticeHit,
  noticePriority,
  NOTICES_PROVIDER_ID,
} from "./provider";
import {
  attachmentHref,
  chartsText,
  firingAreaName,
  foldFiringExercises,
  NOTICE_LANG,
  noticeBody,
  noticeHeader,
  noticeLinks,
  noticeSections,
} from "./detailModel";
import type { NoticeDetail } from "./types";
import DETAIL_JSON from "./fixtures/detail.json";

const DETAIL = DETAIL_JSON as unknown as NoticeDetail;
const QUERY: InfoQuery = { point: { x: 50, y: 50 }, lngLat: { lng: 11.3, lat: 54.57 }, radius: 8 };

const feat = (layer: string, props: Record<string, unknown>, source = "notices"): MapGeoJSONFeature =>
  ({ source, properties: props, layer: { id: layer } }) as unknown as MapGeoJSONFeature;

const mapOver = (features: MapGeoJSONFeature[]): QueryableMap => ({ queryRenderedFeatures: () => features });

const provider = (features: MapGeoJSONFeature[], loadDetail = async (_id: string) => DETAIL as NoticeDetail | undefined) =>
  createNoticesProvider({
    map: () => mapOver(features),
    palette: () => "day",
    openNotice: () => {},
    loadDetail,
    now: () => Date.UTC(2026, 9, 3, 12),
  });

describe("queryAt", () => {
  test("one hit per message however many of its features the tap caught", () => {
    const p = provider([
      feat(NOTICES_OUTLINE_LAYER_ID, { msg: "m1", sid: "NM-053-26", fam: "nm-t", cls: "works", role: "edge" }),
      feat(NOTICES_OUTLINE_LAYER_ID, { msg: "m1", sid: "NM-053-26", fam: "nm-t", cls: "works", role: "area" }),
      feat(NOTICES_ICON_LAYER_ID, { msg: "m1", sid: "NM-053-26", fam: "nm-t", cls: "works", role: "anchor" }),
      feat(NOTICES_VERTEX_LABEL_LAYER_ID, { msg: "m1", sid: "NM-053-26", fam: "nm-t", cls: "works", role: "vertex" }),
      feat(NOTICES_ICON_LAYER_ID, { msg: "m2", sid: "NW-375-26", fam: "nw", cls: "buoy", role: "point" }),
    ]);
    const hits = p.queryAt(QUERY);
    expect(hits.map((h) => h.id).sort()).toEqual(["m1", "m2"]);
    const m1 = hits.find((h) => h.id === "m1")!;
    expect(m1.providerId).toBe(NOTICES_PROVIDER_ID);
    expect(m1.title).toBe("NM-053");
    expect(m1.subtitle).toBe("Temporary (T) · Works");
    // The anchor icon is the most specific of m1's features.
    expect(m1.precision).toBe("point");
  });

  test("notices sharing a position all answer, also the ones whose icon was not placed", () => {
    // NW-359's icon is drawn; NM-947 (same light) lost the collision, so only
    // its invisible hit circle is under the tap.
    const nw = { msg: "m-nw", sid: "NW-359-26", fam: "nw", cls: "light", role: "point" };
    const nm = { msg: "m-nm", sid: "NM-947-26", fam: "nm-t", cls: "light", role: "point" };
    const hits = provider([
      feat(NOTICES_ICON_LAYER_ID, nw),
      feat(NOTICES_POINT_HIT_LAYER_ID, nw),
      feat(NOTICES_POINT_HIT_LAYER_ID, nm),
    ]).queryAt(QUERY);
    expect(hits.map((h) => h.title).sort()).toEqual(["NM-947", "NW-359"]);
    // The undrawn one ranks as its drawn icon would: a point, own priority.
    const hidden = hits.find((h) => h.id === "m-nm")!;
    expect(hidden.precision).toBe("point");
    expect(hidden.priority).toBe(noticePriority("nm-t", false));
  });

  test("an area-only tap is an area hit", () => {
    const [hit] = provider([
      feat(NOTICES_OUTLINE_LAYER_ID, { msg: "m1", sid: "NM-1-26", fam: "nm-perm", cls: "depth", role: "edge" }),
    ]).queryAt(QUERY);
    expect(hit.precision).toBe("area");
  });

  test("ignores features from other sources/layers (scoped query)", () => {
    const hits = provider([feat("poi-marker", { msg: "x", fam: "nw", cls: "buoy", role: "point" }, "poi-all")]).queryAt(
      QUERY,
    );
    expect(hits).toEqual([]);
  });

  test("a firing exercise has no shortId: titled by its area's name", () => {
    const [hit] = provider([
      feat(NOTICES_ICON_LAYER_ID, { msg: "f", sid: null, fam: "fe", cls: "firing", role: "anchor" }),
      feat(NOTICES_OUTLINE_LAYER_ID, { msg: "f", sid: null, fam: "fe", cls: "firing", role: "edge", name_da: "EK D 396 Hullebæk" }),
    ]).queryAt(QUERY);
    expect(hit.title).toBe("EK D 396 Hullebæk");
  });

  test("answers nothing before the overlay hands over a map", () => {
    const p = createNoticesProvider({ map: () => undefined, palette: () => "day", openNotice: () => {} });
    expect(p.queryAt(QUERY)).toEqual([]);
  });
});

// Two user asks, both honoured: "when clicking in the middle of a area the
// notice for mariners should also show up" — and, earlier, "when i click on
// one i should still have the ability to switch to other poi near it like i
// normally can eg weather or depth". So a tap merely INSIDE a notice area
// (the invisible `notices-area-hit` fill) answers with the notice, but in the
// chart's background-area tier (DEPARE's `area`), not its own hazard/
// regulated priority: it joins depth and weather instead of heading them.
describe("a tap INSIDE a notice area, away from its boundary and icon", () => {
  const area = { msg: "nm871", sid: "NM-871-26", fam: "nm-t", cls: "survey", role: "area" };
  const fe = { msg: "fe1", sid: null, fam: "fe", cls: "firing", role: "area", ft: true, name_en: "EK D 396 Hullebæk" };
  /** A MapLibre double that honours `{ layers }` the way the real one does:
   * under an interior tap, only the AREA-filling layers render a feature —
   * the notices hit fill and hatch (whatever their opacity) and the chart's
   * depth area. Lines and symbols are away from the tap. */
  const interior: QueryableMap = {
    getLayer: () => true,
    queryRenderedFeatures: (_g, opts) =>
      [
        feat(NOTICES_AREA_HIT_LAYER_ID, area),
        feat(NOTICES_AREA_HIT_LAYER_ID, fe),
        feat(NOTICES_HATCH_LAYER_ID, fe),
        feat("chart-all-depare", { DRVAL1: 10, DRVAL2: 20 }, "chart-all"),
      ].filter((f) => !opts?.layers || opts.layers.includes(f.layer.id)),
  };
  const notices = createNoticesProvider({ map: () => interior, palette: () => "day", openNotice: () => {} });
  const depth: InfoProvider = {
    id: "depth",
    label: "Depth",
    queryAt: (q): InfoHit[] => [
      { providerId: "depth", id: "d", priority: "area", precision: "area", title: "Depth area", lngLat: q.lngLat },
    ],
    detail: () => ({ sections: [] }),
  };
  const sounding: InfoProvider = {
    id: "sounding",
    label: "Sounding",
    queryAt: (q): InfoHit[] => [
      { providerId: "sounding", id: "s", priority: "depth", precision: "point", title: "Sounding", lngLat: q.lngLat },
    ],
    detail: () => ({ sections: [] }),
  };
  const wind: InfoProvider = {
    id: "weather",
    label: "Weather",
    queryAt: (q): InfoHit[] => [{ providerId: "weather", id: "wind", priority: "context", precision: "point", title: "Wind", lngLat: q.lngLat }],
    detail: () => ({ sections: [] }),
  };

  test("answers each notice it is inside, area-tier whatever the family (even a firing exercise)", () => {
    const hits = notices.queryAt(QUERY);
    expect(hits.map((h) => h.id).sort()).toEqual(["fe1", "nm871"]);
    for (const h of hits) {
      expect(h.priority).toBe(INTERIOR_PRIORITY);
      expect(h.precision).toBe("area");
    }
    expect(INTERIOR_PRIORITY).toBe("area");
    // A firing exercise is titled by its area's name.
    expect(hits.find((h) => h.id === "fe1")!.title).toBe("EK D 396 Hullebæk");
  });

  test("the panel shows the notice WITH depth and weather, sitting with the depth area (chart first), above weather", () => {
    const hits = queryInfoAt([sounding, depth, notices, wind], QUERY);
    expect(hits.map((h) => h.title)).toEqual(["Sounding", "Depth area", "NM-871", "EK D 396 Hullebæk", "Wind"]);
  });

  test("a tap ON its boundary still ranks with the notice's own priority, ahead of depth", () => {
    const edge: QueryableMap = {
      getLayer: () => true,
      queryRenderedFeatures: (_g, opts) =>
        [feat(NOTICES_OUTLINE_LAYER_ID, { ...area, role: "edge" }), feat(NOTICES_AREA_HIT_LAYER_ID, area)].filter(
          (f) => !opts?.layers || opts.layers.includes(f.layer.id),
        ),
    };
    const p = createNoticesProvider({ map: () => edge, palette: () => "day", openNotice: () => {} });
    const hits = queryInfoAt([depth, p, wind], QUERY);
    expect(hits.map((h) => h.title)).toEqual(["NM-871", "Depth area", "Wind"]);
    expect(hits[0]!.priority).toBe("regulated");
    expect(hits[0]!.precision).toBe("area");
  });

  test("an icon inside the area beats the interior: point precision, own priority", () => {
    const icon: QueryableMap = {
      getLayer: () => true,
      queryRenderedFeatures: () => [feat(NOTICES_AREA_HIT_LAYER_ID, fe), feat(NOTICES_ICON_LAYER_ID, { ...fe, role: "anchor" })],
    };
    const [hit] = createNoticesProvider({ map: () => icon, palette: () => "day", openNotice: () => {} }).queryAt(QUERY);
    expect(hit!.precision).toBe("point");
    expect(hit!.priority).toBe("hazard");
  });
});

describe("priority", () => {
  test("NW and firing exercises are hazards; firing areas only on a firing day", () => {
    expect(noticePriority("nw", false)).toBe("hazard");
    expect(noticePriority("fe", false)).toBe("hazard");
    expect(noticePriority("fa", true)).toBe("hazard");
    expect(noticePriority("fa", false)).toBe("regulated");
    expect(noticePriority("nm-t", false)).toBe("regulated");
    expect(noticePriority("nm-p", false)).toBe("regulated");
    expect(noticePriority("nm-perm", false)).toBe("regulated");
    expect(noticePriority(undefined, false)).toBe("regulated");
  });

  test("the tap hit's priority follows the rendered `ft`", () => {
    const [hit] = provider([
      feat(NOTICES_OUTLINE_LAYER_ID, { msg: "a", sid: "FA/EK-R-18 2026", fam: "fa", cls: "firing", role: "edge", ft: true }),
    ]).queryAt(QUERY);
    expect(hit.priority).toBe("hazard");
  });
});

describe("detail", () => {
  const NOW = Date.UTC(2026, 9, 3, 12);

  test("header: English vicinity as title, sid + family badge as subtitle", () => {
    // User: "chose english as language".
    expect(noticeHeader(DETAIL)).toEqual({ title: "Femern Belt. Route Tango", subtitle: "NM-053-26 · Temporary (T)" });
  });

  test("header falls back to Danish per field when English is missing", () => {
    const d = { ...DETAIL, vicinity: { da: "Femern Bælt. Rute Tango", en: null } } as NoticeDetail;
    expect(noticeHeader(d).title).toBe("Femern Bælt. Rute Tango");
  });

  test("body: English primary, Danish alt; a missing English field falls back to Danish", () => {
    expect(NOTICE_LANG).toBe("en");
    expect(noticeBody(DETAIL, NOTICE_LANG).title).toBe(DETAIL.title.en);
    expect(noticeBody(DETAIL, "da").title).toBe(DETAIL.title.da);
    const d = { ...DETAIL, title: { da: "Kun dansk", en: "" } } as NoticeDetail;
    expect(noticeBody(d, NOTICE_LANG).title).toBe("Kun dansk");
  });

  test("sections: type, state, original, windows, charts", () => {
    const sections = noticeSections(DETAIL, NOW);
    const rows = sections.flatMap((s) => s.rows.map((r) => [r.label, r.value]));
    expect(rows).toContainEqual(["Type", "Temporary (T) · Works"]);
    expect(rows).toContainEqual(["State", "Active"]);
    expect(rows).toContainEqual(["Original", "Original information (*)"]);
    expect(rows.find(([l]) => l === "Charts")?.[1]).toBe(
      "196 (1:75 000), 104 (1:200 000), 103 / INT 1303 (1:200 000)",
    );
    const events = sections.find((s) => s.label === "Event");
    expect(events?.rows).toHaveLength(1);
    expect(events?.rows[0].value).toMatch(/^from /);
  });

  test("an upcoming window and an ended one are labelled per window", () => {
    const d: NoticeDetail = {
      ...DETAIL,
      win: [
        [NOW - 3 * 86_400_000, NOW - 2 * 86_400_000],
        [NOW + 86_400_000, NOW + 2 * 86_400_000],
      ],
    };
    const ev = noticeSections(d, NOW).find((s) => s.label === "Events")!;
    expect(ev.rows.map((r) => r.label)).toEqual(["Ended", "Upcoming"]);
    expect(noticeSections(d, NOW)[0].rows.find((r) => r.label === "State")?.value).toMatch(/^From \d+\/\d+/);
  });

  test("body: parts headed per language, hidden subject dropped, references, attachments", () => {
    const da = noticeBody(DETAIL, "da");
    const en = noticeBody(DETAIL, "en");
    expect(da.title).toStartWith("Danmark. Tyskland.");
    expect(en.title).toStartWith("Denmark. Germany.");
    expect(da.area).toBe("Danmark › Østersøen");
    expect(da.parts).toHaveLength(1);
    expect(da.parts[0].heading).toBe("Detaljer");
    expect(en.parts[0].heading).toBe("Details");
    // hide_subject: true
    expect(da.parts[0].subject).toBeUndefined();
    expect(da.parts[0].html).toContain("Indtil videre");
    expect(en.parts[0].html).toContain("Until further notice");
    expect(da.references).toEqual([
      { id: "NM-270-22", label: "Reference", description: undefined },
      { id: "NM-306-25", label: "Opdatering", description: undefined },
    ]);
    expect(en.references[1].label).toBe("Update");
    expect(da.source).toBe("Femern A/S 20. januar 2026");
    expect(da.attachments[0]).toEqual({
      href: "/api/notices/attachments/beb0ff9a3a9e092350be4ed1",
      name: "NM-270-22 Femern_DK.pdf",
      image: false,
      size: "16 KB",
    });
  });

  test("a part's subject shows unless hide_subject; a missing language falls back", () => {
    const d: NoticeDetail = {
      ...DETAIL,
      parts: [{ type: "NOTE", subject: { da: "Bemærk", en: "" }, hide_subject: false, details: { da: "<p>x</p>", en: "" }, win: [] }],
    };
    const en = noticeBody(d, "en");
    expect(en.parts[0]).toEqual({ heading: "Note", subject: "Bemærk", html: "<p>x</p>" });
  });

  test("record: inline English note with the Danish alt and its own toggle words, PDF links", async () => {
    const opened: string[] = [];
    const detail: InfoDetail = buildNoticeDetail(DETAIL, NOW, (id) => opened.push(id));
    expect(detail.title).toBe("Femern Belt. Route Tango");
    expect(detail.notes).toHaveLength(1);
    const note = detail.notes![0];
    expect(note.display).toBe("inline");
    expect(note.alt).toBeDefined();
    expect(note.label).toBe("Notice text (English)");
    expect(note.alt!.label).toBe("Notice text (Dansk)");
    // The button names the language it switches TO: "Dansk" while reading English.
    expect(note.altToggle).toEqual({ primary: "Dansk", alt: "English" });
    expect(typeof (await note.load())).toBe("function");
    expect(typeof (await note.alt!.load())).toBe("function");
    expect(detail.links?.map((l) => l.label)).toEqual(["Official notice (PDF, English)", "Official notice (PDF, Dansk)"]);
  });

  test("provider.detail resolves through the loader, once per id (cached)", async () => {
    let calls = 0;
    const p = provider([], async () => {
      calls++;
      return DETAIL;
    });
    const hit = noticeHit({ id: DETAIL.id, fam: "nm-t", cls: "works", sid: "NM-053-26" });
    const a = await p.detail(hit);
    await p.detail(hit);
    expect(a.subtitle).toBe("NM-053-26 · Temporary (T)");
    expect(calls).toBe(1);
  });

  test("a failed read is a readable record, not a rejection — and is retried next time", async () => {
    let calls = 0;
    const p = provider([], async () => {
      calls++;
      return undefined;
    });
    const hit = noticeHit({ id: "NM-270-22", sid: "NM-270-22" });
    const d = await p.detail(hit);
    expect(d.sections[0].rows[0].value).toContain("Couldn’t load NM-270");
    await p.detail(hit);
    expect(calls).toBe(2);
  });

  test("a new snapshot version drops the cache", async () => {
    let calls = 0;
    let version = "a";
    const p = createNoticesProvider({
      map: () => undefined,
      palette: () => "day",
      openNotice: () => {},
      loadDetail: async () => {
        calls++;
        return DETAIL;
      },
      version: () => version,
    });
    await p.load("x");
    await p.load("x");
    version = "b";
    await p.load("x");
    expect(calls).toBe(2);
  });

  test("helpers", () => {
    expect(attachmentHref("/notices/attachments/k")).toBe("/api/notices/attachments/k");
    expect(attachmentHref("https://x.dk/a.png")).toBe("https://x.dk/a.png");
    expect(chartsText([])).toBeUndefined();
  });
});

// User: "the firing areas all have two "tabs" in the poi list, like there are
// two areas, check out why and if we can remove one or merge them" — then,
// shown the two causes, "do A and B plus the name title".
describe("firing areas: one entry per range", () => {
  const NOW = Date.UTC(2026, 9, 4, 12);
  const MRN = "urn:mrn:iho:fa:dk:ek-r-45";
  const NAME = { name_en: "EK R 45 Hevring", name_da: "EK R 45 Hevring" };
  /** Niord's two messages for one range, as the real snapshot has them:
   * different uuids, the same polygon, the same area MRN. */
  const FA = { msg: "fa-45", sid: "FA/EK-R-45 2026", fam: "fa", cls: "firing", mrn: MRN, ft: false, ...NAME };
  const FE = { msg: "fe-45", sid: null, fam: "fe", cls: "firing", mrn: MRN, ft: false, ...NAME };
  const inside = (p: Record<string, unknown>) => feat(NOTICES_AREA_HIT_LAYER_ID, { ...p, role: "area" });
  const onEdge = (p: Record<string, unknown>) => feat(NOTICES_OUTLINE_LAYER_ID, { ...p, role: "edge" });
  const onIcon = (p: Record<string, unknown>) => feat(NOTICES_ICON_LAYER_ID, { ...p, role: "anchor", name_en: undefined, name_da: undefined });

  describe("A: the area and its firing-exercise warning are folded on the area MRN", () => {
    test("a paired area answers with ONE hit: the area's id, the warning in its payload", () => {
      const hits = provider([inside(FE), inside(FA)]).queryAt(QUERY);
      expect(hits).toHaveLength(1);
      const [hit] = hits;
      // Stable: the permanent area's id, whichever of the two came first.
      expect(hit!.id).toBe("fa-45");
      expect(provider([inside(FA), inside(FE)]).queryAt(QUERY).map((h) => h.id)).toEqual(["fa-45"]);
      expect(hit!.payload).toMatchObject({ fam: "fa", sid: "FA/EK-R-45 2026", fe: ["fe-45"], ft: false });
      expect(hit!.title).toBe("EK R 45 Hevring");
      expect(hit!.subtitle).toBe("Firing area · Exercises announced");
      // interior-only: the background-area tier, like either alone
      expect(hit!.priority).toBe(INTERIOR_PRIORITY);
      expect(hit!.precision).toBe("area");
    });

    test("the higher priority of the two: on the boundary the warning's hazard, though the area is idle", () => {
      // The shared edge is drawn once (./time.ts `boundaryEdges`), so only one
      // of the two is hit on it; the other is an interior hit.
      for (const features of [[onEdge(FE), inside(FA)], [onEdge(FA), inside(FE)]]) {
        const [hit] = provider(features).queryAt(QUERY);
        expect(hit!.id).toBe("fa-45");
        expect(hit!.precision).toBe("area");
      }
      expect(provider([onEdge(FE), inside(FA)]).queryAt(QUERY)[0]!.priority).toBe("hazard");
      // the idle area's own boundary + the warning's interior: regulated
      expect(provider([onEdge(FA), inside(FE)]).queryAt(QUERY)[0]!.priority).toBe("regulated");
      // the icons sit on the same anchor: the most specific precision wins
      const [icon] = provider([onIcon(FE), onIcon(FA), inside(FA), inside(FE)]).queryAt(QUERY);
      expect(icon!.precision).toBe("point");
      expect(icon!.priority).toBe("hazard");
      expect(icon!.title).toBe("EK R 45 Hevring");
    });

    test("firing today survives the fold from EITHER side, with the area's hazard promotion", () => {
      // the area's schedule says so (periods feed) …
      const [a] = provider([onEdge({ ...FA, ft: true }), inside(FE)]).queryAt(QUERY);
      expect(a!.payload).toMatchObject({ ft: true });
      expect(a!.priority).toBe("hazard");
      expect(a!.subtitle).toBe("Firing area · Firing today");
      // … or only the warning's firing days do (no schedule fetched): the
      // area's boundary hit is promoted by the folded state.
      const [b] = provider([onEdge(FA), inside({ ...FE, ft: true })]).queryAt(QUERY);
      expect(b!.payload).toMatchObject({ ft: true });
      expect(b!.priority).toBe("hazard");
      expect(b!.subtitle).toBe("Firing area · Firing today");
    });

    test("the selection is the area's id — the overlay highlights that range", () => {
      const selected: (string | undefined)[] = [];
      const p = createNoticesProvider({
        map: () => mapOver([inside(FE), inside(FA)]),
        palette: () => "day",
        openNotice: () => {},
        onSelected: (id) => selected.push(id),
      });
      p.selected!(p.queryAt(QUERY)[0]);
      expect(selected).toEqual(["fa-45"]);
    });

    test("an area with no warning, and a warning with no area, are left as they were", () => {
      const [fa] = provider([inside(FA)]).queryAt(QUERY);
      expect(fa!.id).toBe("fa-45");
      expect((fa!.payload as { fe?: unknown }).fe).toBeUndefined();
      expect(fa!.priority).toBe(INTERIOR_PRIORITY);
      const [fe] = provider([onEdge(FE)]).queryAt(QUERY);
      expect(fe).toMatchObject({ id: "fe-45", priority: "hazard", title: "EK R 45 Hevring", subtitle: "Firing" });
      expect((fe!.payload as { fe?: unknown }).fe).toBeUndefined();
    });

    test("neighbouring ranges stay separate entries; no MRN, no fold", () => {
      const other = { ...FA, msg: "fa-44", sid: "FA/EK-R-44 2026", mrn: "urn:mrn:iho:fa:dk:ek-r-44", name_en: "EK R 44 Halk" };
      const hits = provider([inside(FE), inside(FA), inside(other)]).queryAt(QUERY);
      expect(hits.map((h) => h.title)).toEqual(["EK R 45 Hevring", "EK R 44 Halk"]);
      // An older snapshot (no `mrn` on its features) simply does not fold.
      const { mrn: _a, ...faBare } = FA;
      const { mrn: _b, ...feBare } = FE;
      expect(provider([inside(feBare), inside(faBare)]).queryAt(QUERY)).toHaveLength(2);
    });

    test("two AREAS on one MRN are not guessed at", () => {
      const hits: InfoHit[] = ["fa-a", "fa-b", "fe-x"].map((id) => noticeHit({ id, fam: id.startsWith("fe") ? "fe" : "fa", cls: "firing" }));
      const mrns = new Map(hits.map((h) => [h.id, MRN]));
      expect(foldFiringHits(hits, mrns).map((h) => h.id)).toEqual(["fa-a", "fa-b", "fe-x"]);
    });

    // The two records, shaped like the real Hevring pair: the warning repeats
    // the area's parts verbatim and adds TIME; the area alone has the FA
    // number, the reference to last year's notice and today's periods.
    const part = (type: string, text: string, subject: string | null = null) => ({
      type,
      subject: subject ? { da: subject, en: subject } : null,
      hide_subject: false,
      details: { da: `<p>${text}</p>`, en: `<p>${text}</p>` },
      win: [],
    });
    const TODAY: [number, number] = [Date.UTC(2026, 9, 4, 6), Date.UTC(2026, 9, 4, 14)];
    const TOMORROW: [number, number] = [Date.UTC(2026, 9, 5, 7), Date.UTC(2026, 9, 5, 13)];
    const AREA: NoticeDetail = {
      ...DETAIL,
      id: "fa-45",
      sid: "FA/EK-R-45 2026",
      fam: "fa",
      cls: "firing",
      title: { da: "Danmark. Kattegat. EK R 45 Hevring.", en: "Denmark. Kattegat. EK R 45 Hevring." },
      vicinity: { da: null, en: null },
      area: { da: ["Danmark", "Kattegat", "EK R 45 Hevring"], en: ["Denmark", "Kattegat", "EK R 45 Hevring"] },
      references: [{ id: "FA/EK-R-45 2025", type: "REPETITION", description: null }],
      win: [TODAY],
      parts: [part("DETAILS", "The area is bounded by …"), part("PROHIBITION", "Entry prohibited."), part("SIGNALS", "Red ball.")],
      attachments: [],
      pdf: { da: "https://niord.dma.dk/fa.pdf?lang=da", en: "https://niord.dma.dk/fa.pdf?lang=en" },
    };
    const EXERCISE: NoticeDetail = {
      ...AREA,
      id: "fe-45",
      sid: null,
      fam: "fe",
      title: { da: "… Skydeøvelser. Advarsel.", en: "… Firing exercises. Warning." },
      references: [],
      win: [TODAY, TOMORROW],
      publish_from: Date.UTC(2026, 9, 1, 9),
      parts: [
        part("TIME", "4 October 2026, hours 08:00 - 16:00. 5 October 2026, hours 09:00 - 15:00."),
        // same text, the warning's own subject line, different whitespace
        part("DETAILS", "The area is  bounded by …", "Firing exercises. Warning."),
        part("PROHIBITION", "Entry prohibited."),
        part("SIGNALS", "Red ball."),
      ],
      pdf: { da: "https://niord.dma.dk/fe.pdf?lang=da", en: "https://niord.dma.dk/fe.pdf?lang=en" },
    };

    test("the folded record keeps everything either message carried, each part once", () => {
      const d = foldFiringExercises(AREA, [EXERCISE]);
      expect(d.id).toBe("fa-45");
      expect(d.fam).toBe("fa");
      // the schedule (TIME) leads, the shared parts appear once
      expect(d.parts.map((p) => p.type)).toEqual(["TIME", "DETAILS", "PROHIBITION", "SIGNALS"]);
      // today's periods and every announced firing day, no duplicate
      expect(d.win).toEqual([TODAY, TOMORROW]);
      // what only the area has
      expect(d.sid).toBe("FA/EK-R-45 2026");
      expect(d.references).toEqual([{ id: "FA/EK-R-45 2025", type: "REPETITION", description: null }]);
      expect(d.folded).toEqual([{ id: "fe-45", publish_from: EXERCISE.publish_from, updated: EXERCISE.updated, pdf: EXERCISE.pdf }]);
      // a part only the AREA has is never lost either
      const d2 = foldFiringExercises({ ...AREA, parts: [...AREA.parts, part("NOTE", "Only in the definition.")] }, [EXERCISE]);
      expect(d2.parts.map((p) => p.type)).toEqual(["TIME", "DETAILS", "PROHIBITION", "SIGNALS", "NOTE"]);
      expect(foldFiringExercises(AREA, [])).toBe(AREA);
    });

    test("provider.detail: one record with the schedule, the FA number and the reference", async () => {
      const p = createNoticesProvider({
        map: () => mapOver([inside(FE), inside({ ...FA, ft: true })]),
        palette: () => "day",
        openNotice: () => {},
        loadDetail: async (id) => ({ "fa-45": AREA, "fe-45": EXERCISE })[id],
        now: () => NOW,
      });
      const [hit] = p.queryAt(QUERY);
      const detail = await p.detail(hit!);
      expect(detail.title).toBe("EK R 45 Hevring");
      expect(detail.subtitle).toBe("FA/EK-R-45 2026 · Firing area");
      const rows = detail.sections.flatMap((s) => s.rows);
      expect(rows.find((r) => r.label === "Number")).toMatchObject({ value: "FA/EK-R-45 2026", copy: "FA/EK-R-45 2026" });
      // "firing today", called out while a window is running (NOW is inside TODAY)
      expect(rows.find((r) => r.label === "State")).toMatchObject({ value: "Firing today", emphasis: true });
      expect(detail.sections.find((s) => s.label === "Events")?.rows.map((r) => r.label)).toEqual(["Active", "Upcoming"]);
      expect(rows.find((r) => r.label === "Firing warning")?.value).toMatch(/^issued 1\/10/);
      expect(detail.links?.map((l) => l.label)).toEqual([
        "Official notice (PDF, English)",
        "Official notice (PDF, Dansk)",
        "Firing warning (PDF, English)",
        "Firing warning (PDF, Dansk)",
      ]);
      // the text: schedule + definition, and the reference to last year's notice
      const body = noticeBody(foldFiringExercises(AREA, [EXERCISE]), "en");
      expect(body.parts.map((x) => x.heading)).toEqual(["Time", "Details", "Prohibition", "Signals"]);
      expect(body.references).toEqual([{ id: "FA/EK-R-45 2025", label: "Repetition", description: undefined }]);
    });

    test("a hit with no folded warning (list, search, reference) resolves the area alone; an unreadable area falls back to the warning", async () => {
      const load = async (id: string) => ({ "fa-45": AREA, "fe-45": EXERCISE })[id];
      const p = provider([], load);
      const alone = await p.detail(noticeHit({ id: "fa-45", fam: "fa", cls: "firing", sid: AREA.sid }));
      expect(alone.sections.flatMap((s) => s.rows).find((r) => r.label === "Firing warning")).toBeUndefined();
      expect(alone.links).toHaveLength(2);
      const q = createNoticesProvider({
        map: () => mapOver([inside(FE), inside(FA)]),
        palette: () => "day",
        openNotice: () => {},
        loadDetail: async (id) => (id === "fe-45" ? EXERCISE : undefined),
        now: () => NOW,
      });
      const fallback = await q.detail(q.queryAt(QUERY)[0]!);
      expect(fallback.subtitle).toBe("Firing exercise");
      expect(fallback.title).toBe("EK R 45 Hevring");
    });
  });

  describe("C: titled by the area's name", () => {
    test("a firing area's tap hit carries its name, not the FA number; the state is in the subtitle", () => {
      const [idle] = provider([inside(FA)]).queryAt(QUERY);
      expect(idle).toMatchObject({ title: "EK R 45 Hevring", subtitle: "Firing area · No firing today" });
      const [firing] = provider([inside({ ...FA, ft: true })]).queryAt(QUERY);
      expect(firing).toMatchObject({ title: "EK R 45 Hevring", subtitle: "Firing area · Firing today" });
      // the icon won the tap; the name still comes off the polygon
      const [icon] = provider([onIcon(FA), inside(FA)]).queryAt(QUERY);
      expect(icon!.title).toBe("EK R 45 Hevring");
      // no name on any feature under the tap: the FA number, as before
      const [bare] = provider([onIcon(FA)]).queryAt(QUERY);
      expect(bare!.title).toBe("FA/EK-R-45 2026");
    });

    test("NOTICE_LANG first (English), Danish where a feature has no English name", () => {
      expect(NOTICE_LANG).toBe("en");
      const [en] = provider([inside({ ...FA, name_en: "EK D 396 Hullebaek", name_da: "EK D 396 Hullebæk" })]).queryAt(QUERY);
      expect(en!.title).toBe("EK D 396 Hullebaek");
      const [da] = provider([inside({ ...FA, name_en: undefined, name_da: "EK D 396 Hullebæk" })]).queryAt(QUERY);
      expect(da!.title).toBe("EK D 396 Hullebæk");
    });

    test("every other notice keeps its shortId handle, name or not", () => {
      const [hit] = provider([
        feat(NOTICES_AREA_HIT_LAYER_ID, { msg: "m", sid: "NM-871-26", fam: "nm-t", cls: "survey", role: "area", name_en: "Some area" }),
      ]).queryAt(QUERY);
      expect(hit).toMatchObject({ title: "NM-871", subtitle: "Temporary (T) · Survey" });
    });

    test("the resolved record is headed by the area name too, the FA number beside it", () => {
      const fa = { ...DETAIL, fam: "fa", sid: "FA/EK-D-396 2026", vicinity: { da: null, en: null }, area: { da: ["Danmark", "Østersøen", "EK D 396 Hullebæk"], en: ["Denmark", "The Baltic Sea", "EK D 396 Hullebaek"] } } as NoticeDetail;
      expect(noticeHeader(fa)).toEqual({ title: "EK D 396 Hullebaek", subtitle: "FA/EK-D-396 2026 · Firing area" });
      expect(firingAreaName({ ...fa, area: { da: ["Danmark", "Østersøen", "EK D 396 Hullebæk"], en: [] } })).toBe("EK D 396 Hullebæk");
      // not a firing notice: its area path ends at a sea, not at a subject
      expect(firingAreaName(DETAIL)).toBeUndefined();
      expect(noticeLinks(DETAIL)).toHaveLength(2);
    });
  });

  describe("B: a firing notice supersedes the chart's entry for the same range", () => {
    // The charted range (real DK set): boundary line + centred symbol, no
    // fill — its inside answers through the style's invisible tap target.
    const mipare = (props: Record<string, unknown>, layer: string, id = 77, sourceLayer = "MIPARE"): MapGeoJSONFeature =>
      ({
        source: "chart-all",
        sourceLayer,
        properties: props,
        geometry: { type: "Polygon", coordinates: [] },
        id,
        layer: { id: layer },
      }) as unknown as MapGeoJSONFeature;
    const FIRING = { CATMPA: "4", OBJNAM: "EK R 45", sym: "caution" };
    const INTERIOR = "chart-all-mipare-area-hit";
    const BOUNDARY = "chart-all-mipare-bdy";
    const chartOver = (features: MapGeoJSONFeature[]) =>
      createChartInfoProvider({ map: { queryRenderedFeatures: () => features }, settings: () => DEFAULT_SETTINGS });
    const classes = (hits: InfoHit[]) => hits.map((h) => chartHitPayload(h)?.sourceLayer ?? h.title);

    test("a tap inside both: the charted practice area is dropped, the notice stays", () => {
      const chart = chartOver([mipare(FIRING, INTERIOR)]);
      expect(classes(queryInfoAt([chart], QUERY))).toEqual(["MIPARE"]);
      const hits = queryInfoAt([chart, provider([inside(FE), inside(FA)])], QUERY);
      expect(classes(hits)).toEqual(["EK R 45 Hevring"]);
      // an area-only or a warning-only notice supersedes just the same
      expect(classes(queryInfoAt([chart, provider([inside(FA)])], QUERY))).toEqual(["EK R 45 Hevring"]);
      expect(classes(queryInfoAt([provider([inside(FE)]), chart], QUERY))).toEqual(["EK R 45 Hevring"]);
    });

    test("CATMPA is a list: a firing danger area among other categories counts", () => {
      for (const CATMPA of ["2,4", "4,2", 4]) {
        const hits = queryInfoAt([chartOver([mipare({ ...FIRING, CATMPA }, INTERIOR)]), provider([inside(FA)])], QUERY);
        expect(classes(hits)).toEqual(["EK R 45 Hevring"]);
      }
    });

    test("a tap on the charted boundary or centred symbol keeps the chart entry", () => {
      // the user pointed at the charted object
      const onBoundary = chartOver([mipare(FIRING, BOUNDARY), mipare(FIRING, INTERIOR)]);
      expect(classes(queryInfoAt([onBoundary, provider([inside(FA)])], QUERY))).toEqual(["MIPARE", "EK R 45 Hevring"]);
      const symbol = { ...mipare(FIRING, "chart-all-mipare-sym"), id: undefined, geometry: { type: "Point", coordinates: [10.5, 56.6] } } as unknown as MapGeoJSONFeature;
      expect(classes(queryInfoAt([chartOver([symbol]), provider([inside(FA)])], QUERY))).toEqual(["MIPARE", "EK R 45 Hevring"]);
    });

    test("no firing notice under the tap: the chart entry stays", () => {
      const chart = chartOver([mipare(FIRING, INTERIOR)]);
      // overlay off / snapshot not loaded: the provider has no map
      const off = createNoticesProvider({ map: () => undefined, palette: () => "day", openNotice: () => {} });
      expect(classes(queryInfoAt([chart, off], QUERY))).toEqual(["MIPARE"]);
      // firing family toggled off, or a stretch no notice covers: nothing of ours under the tap
      expect(classes(queryInfoAt([chart, provider([])], QUERY))).toEqual(["MIPARE"]);
      // a notice, but not a firing one
      const survey = feat(NOTICES_AREA_HIT_LAYER_ID, { msg: "m", sid: "NM-871-26", fam: "nm-t", cls: "survey", role: "area" });
      expect(classes(queryInfoAt([chart, provider([survey])], QUERY))).toEqual(["MIPARE", "NM-871"]);
    });

    test("only charted FIRING practice areas: other military areas, restricted areas and the rest are untouched", () => {
      const chart = chartOver([
        mipare({ CATMPA: "3", OBJNAM: "Submarine exercise area" }, INTERIOR, 1),
        mipare({ OBJNAM: "uncategorised" }, INTERIOR, 2),
        mipare({ CATREA: "4", OBJNAM: "Ertholmene" }, "chart-all-resare-area-hit", 3, "RESARE"),
        mipare({ drval1: 10, drval2: 20 }, "chart-all-depare", 4, "DEPARE"),
        mipare(FIRING, INTERIOR, 5),
      ]);
      const hits = queryInfoAt([chart, provider([inside(FA)])], QUERY);
      // (the depth area arrives as the chart provider's folded "Depth" hit)
      expect(hits.map((h) => h.subtitle ?? h.title)).toEqual([
        "Submarine exercise area",
        "uncategorised",
        "Ertholmene",
        "10–20 m",
        "Firing area · No firing today",
      ]);
      expect(hits.filter(isChartedFiringInterior)).toEqual([]);
    });
  });
});

describe("noticeHit", () => {
  test("a hit from a list/search row needs only the id for detail", () => {
    const hit = noticeHit({ id: "u1", fam: "fe", cls: "firing", sid: null, lngLat: { lng: 1, lat: 2 } });
    expect(hit).toMatchObject({ providerId: NOTICES_PROVIDER_ID, id: "u1", priority: "hazard", title: "Firing exercise" });
  });
});
