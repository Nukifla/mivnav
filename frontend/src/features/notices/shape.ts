// Geometry preparation done ONCE per snapshot version (not per minute like
// `./time.ts`'s `prepareNotices`): the area size the area portrayal
// (`./overlay.ts`) sorts by, which never changes with the clock. Winding is
// left alone: the boundary is the chart's plain dashed line, which has no
// inside/outside side to get wrong.
//
// AREA: `ar` = −(approximate area) on every area feature, so `line-sort-key`
// / `fill-sort-key` draw smaller areas over larger ones (ascending key → the
// largest, most negative, first). Only the ordering matters, so it is a
// cos(lat)-scaled deg² — no projection, no units.

import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import type { NoticeFeatureProps, NoticesMap } from "./types";

/** Wire props plus the shaped extras. */
export type ShapedNoticeProps = NoticeFeatureProps & {
  /** Area sort key: −(area), areas only. */
  ar?: number;
};
export type ShapedNoticesMap = FeatureCollection<Geometry, ShapedNoticeProps>;

/** Shoelace, in lon/lat: > 0 is counter-clockwise (y up). Closed or open ring. */
export function signedArea(ring: readonly Position[]): number {
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[(i + 1) % n]!;
    s += x1! * y2! - x2! * y1!;
  }
  return s / 2;
}

/** Approximate polygon area (exterior minus holes), cos(lat)-scaled deg². */
export function polygonArea(rings: readonly Position[][]): number {
  const outer = rings[0];
  if (!outer || outer.length === 0) return 0;
  let lat = 0;
  for (const p of outer) lat += p[1]!;
  const k = Math.cos(((lat / outer.length) * Math.PI) / 180);
  let a = Math.abs(signedArea(outer));
  for (let i = 1; i < rings.length; i++) a -= Math.abs(signedArea(rings[i]!));
  return Math.max(0, a) * k;
}

function shapeFeature(f: Feature<Geometry, NoticeFeatureProps>): Feature<Geometry, ShapedNoticeProps> {
  const g = f.geometry;
  const area =
    g?.type === "Polygon"
      ? polygonArea(g.coordinates)
      : g?.type === "MultiPolygon"
        ? g.coordinates.reduce((s, p) => s + polygonArea(p), 0)
        : undefined;
  return area === undefined ? f : { ...f, properties: { ...f.properties, ar: -area } };
}

/** Area-keyed copy of the snapshot (geometry shared, not copied). `null`/`undefined` pass through. */
export function shapeNotices(data: NoticesMap | null | undefined): ShapedNoticesMap | null {
  if (!data) return null;
  return {
    type: "FeatureCollection",
    features: (data.features as Feature<Geometry, NoticeFeatureProps>[]).map(shapeFeature),
  };
}
