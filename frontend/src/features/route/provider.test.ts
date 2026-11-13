/**
 * The route info provider (#RT-INFO): it answers a plain tap on the DRAWN route
 * line from its OWN layer only (via the C5 `scopedQuery` guard, scoped to
 * `ROUTE_LINE_LAYER`), builds a card with the route's name/distance/#waypoints
 * (+ live ETA while following) and a compact waypoint list, and its "Edit route"
 * action opens the route planner's editor on the route (when one is registered). Driven against a
 * `queryRenderedFeatures`-shaped double, like poi/provider.test.ts.
 */

import { describe, expect, test } from "bun:test";
import type { MapGeoJSONFeature } from "maplibre-gl";
import type { QueryableMap } from "../../core/info/queryGuard";
import type { InfoDetail, InfoHit, InfoQuery } from "../../core/info/types";
import { DEFAULT_PLAN_SPEED_KN, type Route } from "../../core/routes";
import { ROUTE_LINE_LAYER } from "./layers";
import { createRouteProvider, ROUTE_PROVIDER_ID, type RouteFollowMetrics } from "./provider";
import { routeGlance } from "./RouteList";

const QUERY: InfoQuery = { point: { x: 100, y: 100 }, lngLat: { lng: 10.2, lat: 55.5 }, radius: 8 };

const route = (over: Partial<Route> = {}): Route => ({
  id: "r1",
  name: "Weekend passage",
  waypoints: [
    { id: "a", name: "Start", lat: 55.0, lon: 10.0 },
    { id: "b", name: "", lat: 55.5, lon: 10.5 },
    { id: "c", name: "Harbour", lat: 56.0, lon: 11.0 },
  ],
  plan_speed_kn: DEFAULT_PLAN_SPEED_KN,
  rev: 1,
  updated: 0,
  ...over,
});

const lineFeature = (): MapGeoJSONFeature =>
  ({ source: "route", properties: { kind: "line", id: "r1" }, layer: { id: ROUTE_LINE_LAYER }, id: 1 }) as unknown as MapGeoJSONFeature;

const mapOver = (features: MapGeoJSONFeature[]): QueryableMap => ({
  queryRenderedFeatures: () => features,
  getLayer: () => ({}),
});

interface ProviderOpts {
  features?: MapGeoJSONFeature[];
  drawn?: Route | null;
  editing?: boolean;
  following?: boolean;
  metrics?: RouteFollowMetrics | null;
  /** A route planner is registered; its `editRoute` is this. */
  onEdit?: (r: Route) => void;
  activeRouteId?: string | null;
  onStop?: () => void;
}

const providerOver = (opts: ProviderOpts = {}) =>
  createRouteProvider({
    map: () => mapOver(opts.features ?? [lineFeature()]),
    route: () => (opts.drawn === undefined ? route() : opts.drawn),
    editing: () => opts.editing ?? false,
    following: () => opts.following ?? false,
    metrics: () => opts.metrics ?? null,
    planner: () =>
      opts.onEdit ? { editRoute: opts.onEdit, newRoute: () => {}, goTo: async () => true } : null,
    activeRouteId: () => opts.activeRouteId ?? null,
    stopFollowing: opts.onStop ?? (() => {}),
  });

describe("queryAt", () => {
  test("returns a hit when the drawn route line is under the tap", () => {
    const hits = providerOver().queryAt(QUERY);
    expect(hits.length).toBe(1);
    expect(hits[0].providerId).toBe(ROUTE_PROVIDER_ID);
    expect(hits[0].id).toBe("r1");
    expect(hits[0].priority).toBe("regulated");
    expect(hits[0].precision).toBe("line");
    expect(hits[0].title).toBe("Weekend passage");
    expect(hits[0].lngLat).toEqual(QUERY.lngLat);
  });

  test("returns nothing when the tap box hits no route line", () => {
    expect(providerOver({ features: [] }).queryAt(QUERY)).toEqual([]);
  });

  test("returns nothing while the editor is open", () => {
    expect(providerOver({ editing: true }).queryAt(QUERY)).toEqual([]);
  });

  test("returns nothing when no route is drawn", () => {
    expect(providerOver({ drawn: null }).queryAt(QUERY)).toEqual([]);
  });

  test("returns nothing for a route with fewer than two waypoints (no line drawn)", () => {
    const one = route({ waypoints: [{ id: "a", name: "Start", lat: 55, lon: 10 }] });
    expect(providerOver({ drawn: one }).queryAt(QUERY)).toEqual([]);
  });

  test("answers nothing before the map exists", () => {
    const p = createRouteProvider({
      map: () => undefined,
      route: () => route(),
      editing: () => false,
      following: () => false,
      metrics: () => null,
      planner: () => null,
    });
    expect(p.queryAt(QUERY)).toEqual([]);
  });
});

const sync = (d: InfoDetail | Promise<InfoDetail>): InfoDetail => {
  if (d instanceof Promise) throw new Error("route detail must be synchronous");
  return d;
};

const hitFor = (r: Route): InfoHit => ({
  providerId: ROUTE_PROVIDER_ID,
  id: r.id,
  priority: "regulated",
  precision: "line",
  title: r.name,
  payload: r,
});

describe("detail", () => {
  test("includes the name, distance, waypoint count and a waypoint list", () => {
    const detail = sync(providerOver().detail(hitFor(route())));
    expect(detail.title).toBe("Weekend passage");
    const routeSection = detail.sections.find((s) => s.label === "Route")!;
    expect(routeSection.rows.some((row) => row.label === "Distance")).toBe(true);
    expect(routeSection.rows.find((row) => row.label === "Waypoints")?.value).toBe("3");
    const wpSection = detail.sections.find((s) => s.label === "Waypoints")!;
    expect(wpSection.rows.length).toBe(3);
    // Named waypoints keep their name; a nameless one falls back to its number.
    expect(wpSection.rows.map((row) => row.label)).toEqual(["Start", "WP 2", "Harbour"]);
  });

  test("shows an ETA row only while the route is being followed", () => {
    const notFollowing = sync(providerOver({ following: false }).detail(hitFor(route())));
    const rows = notFollowing.sections.find((s) => s.label === "Route")!.rows;
    expect(rows.some((row) => row.label === "ETA")).toBe(false);

    const following = sync(
      providerOver({ following: true, metrics: { ttgDestSec: 3600 } }).detail(hitFor(route())),
    );
    const etaRows = following.sections.find((s) => s.label === "Route")!.rows;
    expect(etaRows.some((row) => row.label === "ETA")).toBe(true);
  });

  test("omits the ETA when becalmed (no finite arrival)", () => {
    const detail = sync(
      providerOver({ following: true, metrics: { ttgDestSec: Infinity } }).detail(hitFor(route())),
    );
    const rows = detail.sections.find((s) => s.label === "Route")!.rows;
    expect(rows.some((row) => row.label === "ETA")).toBe(false);
  });

  test("no Edit route action with no route planner", () => {
    const detail = sync(providerOver({}).detail(hitFor(route())));
    expect(detail.actions?.find((a) => a.label === "Edit route")).toBeUndefined();
  });

  test("the Edit route action opens the planner's editor on the tapped route", () => {
    let edited: Route | null = null;
    const r = route();
    const detail = sync(providerOver({ onEdit: (x) => (edited = x) }).detail(hitFor(r)));
    const action = detail.actions?.find((a) => a.label === "Edit route");
    expect(action).toBeDefined();
    action!.run();
    expect(edited).toBe(r);
  });

  test("Stop following is offered on the active route even with no route planner", () => {
    let stopped = 0;
    const detail = sync(
      providerOver({ activeRouteId: "r1", onStop: () => stopped++ }).detail(hitFor(route())),
    );
    const action = detail.actions?.find((a) => a.label === "Stop following");
    expect(action).toBeDefined();
    action!.run();
    expect(stopped).toBe(1);
  });

  test("no Stop following on a route that is not the active one", () => {
    for (const active of [null, "other"]) {
      const detail = sync(providerOver({ activeRouteId: active }).detail(hitFor(route())));
      expect(detail.actions?.find((a) => a.label === "Stop following")).toBeUndefined();
    }
  });

  test("Export GPX hands the tapped route to the exporter", () => {
    const exported: Route[] = [];
    const r = route();
    const p = createRouteProvider({
      map: () => mapOver([lineFeature()]),
      route: () => r,
      editing: () => false,
      following: () => false,
      metrics: () => null,
      planner: () => null,
      activeRouteId: () => null,
      stopFollowing: () => {},
      exportGpx: (x) => exported.push(x),
    });
    const action = sync(p.detail(hitFor(r))).actions?.find((a) => a.label === "Export GPX");
    action!.run();
    expect(exported).toEqual([r]);
    expect(sync(providerOver().detail(hitFor(r))).actions?.find((a) => a.label === "Export GPX")).toBeUndefined();
  });
});

describe("route list row glance", () => {
  const wp = (id: string, lat: number, lon: number) => ({ id, name: "", lat, lon });
  const r = (wps: Route["waypoints"]): Route => ({ id: "r", name: "", waypoints: wps, plan_speed_kn: 5, rev: 1, updated: 0 });
  test("point count and total distance", () => {
    // 0°N → 1°N up the meridian: 60 nm.
    expect(routeGlance(r([wp("a", 0, 0), wp("b", 1, 0)]))).toMatch(/^2 WP · 60(\.0+)? nm$/);
  });
  test("no distance without a leg", () => {
    expect(routeGlance(r([wp("a", 0, 0)]))).toBe("1 WP");
    expect(routeGlance(r([]))).toBe("0 WP");
  });
});
