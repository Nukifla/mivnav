/**
 * The ranking rule and the seam it is written against.
 *
 * Two things are under test and they are the substance of info-at-point:
 *
 * 1. **Best hit is not topmost hit.** The motivating case is a danger under a
 *    depth area: our layer order is S-52 display priority, so a wreck's fill
 *    draws *below* the soundings and the coastline, and MapLibre's z-ordered
 *    queryRenderedFeatures would answer "5.2 m" for a tap on a wreck.
 * 2. **The seam is source-agnostic.** A second, entirely fake provider is
 *    added here and slots in with no change to rank.ts, registry.ts, state.ts
 *    or InfoPanel.tsx. If that ever stops being true, this file stops
 *    compiling or stops passing.
 *
 * No mock.module anywhere: bun shares one module registry per run and mocks
 * leak across files (see MapView.test.ts). Nothing here needs one — the
 * modules take their dependencies as arguments.
 */

import { describe, expect, test } from "bun:test";
import { dedupeHits, rankHits } from "./rank";
import { queryInfoAt, resolveDetail } from "./registry";
import type { InfoHit, InfoPrecision, InfoPriority, InfoProvider, InfoQuery } from "./types";

const QUERY: InfoQuery = { point: { x: 10, y: 10 }, lngLat: { lng: 12.6, lat: 55.9 }, radius: 8 };

function hit(
  id: string,
  priority: InfoPriority,
  precision: InfoPrecision = "area",
  providerId = "chart",
): InfoHit {
  return { providerId, id, priority, precision, title: id };
}

describe("rankHits", () => {
  test("a danger under a depth area beats the topmost rendered feature", () => {
    // The order here is MapLibre's: descending z. The wreck's polygon fill
    // sits in DPRI band 4, under the contours (5), the soundings (6) and the
    // coastline (7) — so the thing that can sink the boat arrives *last*.
    const asRendered = [
      hit("coastline", "land", "line"),
      hit("sounding", "depth", "point"),
      hit("contour", "depth", "line"),
      hit("wreck", "danger"),
      hit("depth-area", "area"),
    ];
    expect(rankHits(asRendered).map((h) => h.id)).toEqual([
      "wreck",
      "sounding",
      "contour",
      "coastline",
      "depth-area",
    ]);
  });

  test("priority beats precision: an area danger outranks a point sounding", () => {
    const ranked = rankHits([hit("sounding", "depth", "point"), hit("wreck", "danger", "area")]);
    expect(ranked[0].id).toBe("wreck");
  });

  test("precision breaks a priority tie: the tapped point beats the area under it", () => {
    const ranked = rankHits([
      hit("resare", "regulated", "area"),
      hit("achare-point", "regulated", "point"),
      hit("ctnare-line", "regulated", "line"),
    ]);
    expect(ranked.map((h) => h.id)).toEqual(["achare-point", "ctnare-line", "resare"]);
  });

  test("z-order survives as the last tiebreak, not the rule", () => {
    const ranked = rankHits([hit("upper", "aid", "point"), hit("lower", "aid", "point")]);
    expect(ranked.map((h) => h.id)).toEqual(["upper", "lower"]);
  });

  test("an unknown priority sorts last rather than first", () => {
    const rogue = { ...hit("rogue", "context"), priority: "invented" as InfoPriority };
    const ranked = rankHits([rogue, hit("nodata", "context")]);
    expect(ranked.map((h) => h.id)).toEqual(["nodata", "rogue"]);
  });
});

describe("dedupeHits", () => {
  test("collapses one object arriving from many style layers and many tiles", () => {
    // What a real wreck tap looks like: fill, three edge cross-fades, symbol,
    // overbar — plus the same object again from the neighbouring tile.
    const hits = Array.from({ length: 7 }, () => hit("wreck", "danger"));
    expect(dedupeHits(hits)).toHaveLength(1);
  });

  test("ids are provider-scoped, so two sources never collide", () => {
    const hits = [hit("1", "traffic", "point", "ais"), hit("1", "aid", "point", "chart")];
    expect(dedupeHits(hits)).toHaveLength(2);
  });

  test("keeps the first of a run, so a z-ordered caller keeps the topmost", () => {
    const first = { ...hit("wreck", "danger"), title: "topmost" };
    const second = { ...hit("wreck", "danger"), title: "buried" };
    expect(dedupeHits([first, second])[0].title).toBe("topmost");
  });
});

// ---- the seam's acceptance test -------------------------------------------

/**
 * A second source, invented here and implementing nothing but InfoProvider.
 * It is deliberately unlike the chart provider: its hits come from a live
 * in-memory list rather than the map, its detail is async and is resolved from
 * a record the hit never carried, and it classifies one of its own targets as
 * a `danger` on a rule (a closing CPA) that has nothing to do with S-57.
 *
 * This is the shape AIS will need. If it needed a change to rank.ts or
 * registry.ts to work, the seam would be a fiction.
 */
function fakeVesselProvider(): InfoProvider {
  const records: Record<string, { name: string; callsign: string; cpa: number }> = {
    "mmsi:1": { name: "Nordkap", callsign: "LA1234", cpa: 0.2 },
    "mmsi:2": { name: "Kolga", callsign: "LB5678", cpa: 4.0 },
  };
  return {
    id: "vessels",
    label: "AIS",
    queryAt: () =>
      Object.entries(records).map(([id, rec]) => ({
        // deliberately wrong: the registry must stamp its own id
        providerId: "spoofed",
        id,
        priority: (rec.cpa < 1 ? "danger" : "traffic") as InfoPriority,
        precision: "point" as InfoPrecision,
        title: rec.name,
      })),
    // resolved from `id` alone — no payload, the non-map entry path
    detail: async (h) => ({
      title: records[h.id].name,
      sections: [{ label: "Vessel", rows: [{ label: "Call sign", value: records[h.id].callsign }] }],
    }),
  };
}

/** A stand-in for the chart provider with no map behind it: the seam only
 * requires `queryAt` + `detail`, which is the claim being tested. */
function fakeChartProvider(hits: InfoHit[]): InfoProvider {
  return {
    id: "chart",
    label: "Chart",
    queryAt: () => hits,
    detail: () => ({ sections: [{ rows: [{ label: "Object class", value: "WRECKS" }] }] }),
  };
}

describe("the source-agnostic seam", () => {
  test("a second provider slots in and is ranked against the first, unchanged", () => {
    const chart = fakeChartProvider([hit("wreck", "hazard"), hit("depare", "area")]);
    const ranked = queryInfoAt([chart, fakeVesselProvider()], QUERY);

    // The AIS target with the closing CPA outranks a charted wreck — because
    // *its own provider* called it a danger. rank.ts has never heard of AIS.
    expect(ranked.map((h) => h.id)).toEqual(["mmsi:1", "wreck", "mmsi:2", "depare"]);
  });

  test("the registry stamps providerId, so a hit cannot misroute its detail", async () => {
    const providers = [fakeChartProvider([]), fakeVesselProvider()];
    const ranked = queryInfoAt(providers, QUERY);
    expect(ranked.every((h) => h.providerId === "vessels")).toBe(true);

    // and the detail comes from the record, not from the hit
    const detail = await resolveDetail(providers, ranked[0]);
    expect(detail.title).toBe("Nordkap");
    expect(detail.sections[0].rows[0]).toEqual({ label: "Call sign", value: "LA1234" });
  });

  test("detail is resolvable from id alone — the non-map entry point", async () => {
    const providers = [fakeVesselProvider()];
    // No query, no click: exactly what an AIS target list or an alarm would do.
    const constructed: InfoHit = {
      providerId: "vessels",
      id: "mmsi:2",
      priority: "traffic",
      precision: "point",
      title: "Kolga",
    };
    const detail = await resolveDetail(providers, constructed);
    expect(detail.sections[0].rows[0].value).toBe("LB5678");
  });

  test("a hit whose provider is gone reports that instead of throwing", async () => {
    const detail = await resolveDetail([], hit("x", "aid"));
    expect(detail.sections[0].rows[0].value).toContain("unavailable");
  });
});
