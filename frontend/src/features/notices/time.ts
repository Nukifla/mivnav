// Time state and visibility for notices — derived CLIENT-side from each
// feature's `win` and the device clock (efs.md §2.2), so a boat that has been
// offline for a day still shows yesterday's "upcoming" as active and an
// expired one as ended, without the server's help. Pure functions: the
// overlay re-runs `prepareNotices` once a minute and on every toggle change.

import type { Feature, FeatureCollection, Geometry, MultiPolygon, Polygon, Position } from "geojson";
import type { ChartSettings } from "../../core/style/settings";
import type { NoticeFamily, NoticeFeatureProps, NoticesMap, NoticeWindows } from "./types";
import { NOTICE_LANG, otherLang, type NoticeLang } from "./lang";

/** `a`ctive now, `u`pcoming (starts later), `e`nded (still published). One
 * letter because it rides on every feature into the GeoJSON worker. */
export type TimeState = "a" | "u" | "e";

/** Active if ANY window contains `now` (start inclusive, end exclusive, a
 * `null` end open); else upcoming if any window starts later; else ended. No
 * windows at all means the notice carries no time — treat it as in force,
 * never hide a notice for lack of a date. */
export function timeState(win: NoticeWindows | null | undefined, now: number): TimeState {
  if (!win || win.length === 0) return "a";
  let upcoming = false;
  for (const [from, to] of win) {
    if (from <= now && (to === null || now < to)) return "a";
    if (from > now) upcoming = true;
  }
  return upcoming ? "u" : "e";
}

/** The earliest window start after `now`, or null — the "from 5/10" an
 * upcoming notice's label/panel shows. */
export function nextStart(win: NoticeWindows | null | undefined, now: number): number | null {
  let best: number | null = null;
  for (const [from] of win ?? []) if (from > now && (best === null || from < best)) best = from;
  return best;
}

const DAY_MS = 86_400_000;

/** Local midnight at or before `now` — the boat's own day, which is the day
 * a firing schedule is published for. */
export function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Whether any window overlaps today (local). A firing exercise is hatched
 * "in use" for the whole firing DAY, not only inside its shooting hours:
 * that is how the danger is published and how a passage is planned. */
export function overlapsToday(win: NoticeWindows | null | undefined, now: number): boolean {
  const start = startOfLocalDay(now);
  const end = start + DAY_MS;
  for (const [from, to] of win ?? []) if (from < end && (to === null || to > start)) return true;
  return false;
}

/** Which theme colour (`NoticesColors` key) a feature paints in. Computed
 * here, not in a paint expression, so the family→colour rule (and firing
 * areas switching red/grey with the day) is one tested function. */
export type NoticeColourKey = "warning" | "firing" | "temporary" | "preliminary" | "permanent" | "inactive";

export function colourKey(fam: NoticeFamily, firingToday: boolean): NoticeColourKey {
  switch (fam) {
    case "nw":
      return "warning";
    case "fe":
      return "firing";
    case "fa":
      return firingToday ? "firing" : "inactive";
    case "nm-p":
      return "preliminary";
    case "nm-perm":
      return "permanent";
    default:
      // nm-t, and nm-misc should one ever carry geometry.
      return "temporary";
  }
}

/** The settings that shape what is drawn — narrowed so the overlay re-derives
 * only when one of THESE changes, not on every unrelated settings write. */
export type NoticesFilter = Pick<
  ChartSettings,
  | "noticesWarnings"
  | "noticesTemporary"
  | "noticesPreliminary"
  | "noticesPermanent"
  | "noticesFiring"
  | "noticesShowEnded"
>;

export const noticesFilterOf = (s: ChartSettings): NoticesFilter => ({
  noticesWarnings: s.noticesWarnings,
  noticesTemporary: s.noticesTemporary,
  noticesPreliminary: s.noticesPreliminary,
  noticesPermanent: s.noticesPermanent,
  noticesFiring: s.noticesFiring,
  noticesShowEnded: s.noticesShowEnded,
});

export const sameFilter = (a: NoticesFilter, b: NoticesFilter): boolean =>
  (Object.keys(a) as (keyof NoticesFilter)[]).every((k) => a[k] === b[k]);

/** The family's own toggle. List-only families (EfS A/B) never draw. */
export function familyShown(fam: NoticeFamily, f: NoticesFilter): boolean {
  switch (fam) {
    case "nw":
      return f.noticesWarnings;
    case "fe":
    case "fa":
      return f.noticesFiring;
    case "nm-t":
    case "nm-misc":
      return f.noticesTemporary;
    case "nm-p":
      return f.noticesPreliminary;
    case "nm-perm":
      return f.noticesPermanent;
    default:
      return false;
  }
}

/** The properties the map layers read, beyond the wire ones: `st` time state,
 * `ft` firing today, `fc` colour key. `win` is dropped — nested arrays only
 * bloat the GeoJSON worker's copy, and nothing on the map reads it. */
export type PreparedNoticeProps = Omit<NoticeFeatureProps, "win" | "role"> & {
  role: PreparedRole;
  /** Area sort key (`./shape.ts`), areas of a shaped snapshot only. */
  ar?: number;
  st: TimeState;
  ft: boolean;
  fc: NoticeColourKey;
  /** Icon-side label (z11+): the short id, or a firing area's name. */
  lbl?: string;
  /** Vertex label (z13+): "3) grøn stage Q.G". */
  vtx?: string;
  /** Same geometry as an earlier-kept line (one notice repeated by
   * another): not drawn twice. */
  dup?: true;
};

/** Prepared features add one role: an area's BOUNDARY as lines ("edge"),
 * each polygon edge drawn once however many areas share it. */
export type PreparedRole = NoticeFeatureProps["role"] | "edge";
type PreparedFeature = Feature<Geometry, PreparedNoticeProps>;

/** Geometry identity, cached per (shared) geometry object. */
const geomKeys = new WeakMap<object, string>();
function geomKey(g: Geometry): string {
  let k = geomKeys.get(g);
  if (k === undefined) {
    k = JSON.stringify("coordinates" in g ? g.coordinates : g);
    geomKeys.set(g, k);
  }
  return k;
}

const ST_RANK: Record<TimeState, number> = { a: 0, u: 1, e: 2 };

/** Mark all but the most current (active over upcoming over ended) of each
 * set of identical line geometries `dup`. */
function markDuplicateLines(features: PreparedFeature[]): void {
  const best = new Map<string, PreparedNoticeProps>();
  for (const f of features) {
    const p = f.properties;
    if (p.role !== "line" || !f.geometry) continue;
    const key = geomKey(f.geometry);
    const prev = best.get(key);
    if (!prev) best.set(key, p);
    else if (ST_RANK[p.st] < ST_RANK[prev.st]) {
      prev.dup = true;
      best.set(key, p);
    } else p.dup = true;
  }
}

const pt = (p: Position) => `${p[0]!.toFixed(7)},${p[1]!.toFixed(7)}`;
const segKey = (a: Position, b: Position) => {
  const [x, y] = [pt(a), pt(b)];
  return x < y ? `${x} ${y}` : `${y} ${x}`;
};

/**
 * The areas' boundaries as `edge` features, every polygon edge drawn ONCE.
 * Why: the chart's boundary is a DASH, and adjacent areas (the Danish firing
 * ranges are sectors of one range; an exercise repeats its firing area) share
 * edges — two dashes on one edge, phases offset, read as a solid line, which
 * the chart's own MIPARE never does. An edge goes to the most current of
 * the areas that have it (active over upcoming over ended, then snapshot
 * order), so the drawn line carries that area's time state. Runs on the
 * PREPARED (visible) areas, so a filtered-out area never takes an edge away
 * from one that is shown.
 */
export function boundaryEdges(features: readonly PreparedFeature[]): PreparedFeature[] {
  const areas = features
    .filter((f) => f.properties.role === "area" && (f.geometry?.type === "Polygon" || f.geometry?.type === "MultiPolygon"))
    .map((f, i) => ({ f, i }))
    .sort((a, b) => ST_RANK[a.f.properties.st] - ST_RANK[b.f.properties.st] || a.i - b.i);
  const taken = new Set<string>();
  const out: PreparedFeature[] = [];
  for (const { f } of areas) {
    const g = f.geometry as Polygon | MultiPolygon;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    const chains: Position[][] = [];
    for (const ring of polys.flat()) {
      let cur: Position[] | null = null;
      for (let j = 0; j + 1 < ring.length; j++) {
        const a = ring[j]!;
        const b = ring[j + 1]!;
        const key = segKey(a, b);
        if (taken.has(key)) {
          if (cur) chains.push(cur);
          cur = null;
          continue;
        }
        taken.add(key);
        if (!cur) cur = [a];
        cur.push(b);
      }
      if (cur) chains.push(cur);
    }
    if (chains.length)
      out.push({
        type: "Feature",
        geometry: { type: "MultiLineString", coordinates: chains },
        properties: { ...f.properties, role: "edge" },
      });
  }
  return out;
}

/** "NM-842-26" → "NM-842", "Local Warning-244-26" → "LW-244": the label is a
 * handle to find the notice in the list, the year is noise on the chart. */
export function shortLabel(sid: string): string {
  return sid.replace(/^Local Warning/i, "LW").replace(/-\d{2}$/, "");
}

/** "from 5/10" (day/month, the boat's local date). */
export function fromLabel(ms: number): string {
  const d = new Date(ms);
  return `from ${d.getDate()}/${d.getMonth() + 1}`;
}

/** `NOTICE_LANG` first (./lang.ts — English), the other language where a
 * feature has none. The info panel offers the other language. */
const pickBy = (vals: Record<NoticeLang, string | undefined>): string | undefined => {
  const first = vals[NOTICE_LANG];
  const other = vals[otherLang(NOTICE_LANG)];
  return first && first.trim() ? first : other && other.trim() ? other : undefined;
};

/**
 * What the source is fed: every feature the toggles let through, each
 * stamped with its time state as of `now`. Rebuilt whole each minute — about
 * 600 features, so a map over them is nothing next to the tessellation that
 * follows, and it keeps the layers' filters static.
 *
 * Permanent firing AREAS (`fa`) are exempt from the ended rule: their `win`
 * is only today's firing periods, so a quiet day reads "ended" — but the
 * area itself is always drawn (user, Q4), grey when quiet, red hatched when
 * firing today.
 */
export function prepareNotices(
  data: NoticesMap | FeatureCollection<Geometry, NoticeFeatureProps & { ar?: number }> | null | undefined,
  filter: NoticesFilter,
  now: number,
): FeatureCollection<Geometry, PreparedNoticeProps> {
  const features: FeatureCollection<Geometry, PreparedNoticeProps>["features"] = [];
  // A firing exercise has no shortId; its icon is labelled with its area's
  // name instead (`name_*` rides on the area polygon, the icon on its anchor).
  const areaName = new Map<string, string>();
  for (const f of data?.features ?? []) {
    const p = f.properties;
    const name = p?.role === "area" ? pickBy({ en: p.name_en, da: p.name_da }) : undefined;
    if (name && !areaName.has(p!.msg)) areaName.set(p!.msg, name);
  }
  for (const f of data?.features ?? []) {
    const p = f.properties;
    if (!p || !familyShown(p.fam, filter)) continue;
    const isArea = p.fam === "fa";
    const st = isArea ? "a" : timeState(p.win, now);
    if (st === "e" && !filter.noticesShowEnded) continue;
    // A firing area's `win` is the snapshot day's periods, so derive "today"
    // from it (it ages correctly offline); the server's `firing_today` is
    // only trusted when it gave no periods at all.
    const ft = isArea
      ? p.win?.length
        ? overlapsToday(p.win, now)
        : p.firing_today === true
      : p.fam === "fe" && overlapsToday(p.win, now);
    const { win: _win, ...rest } = p;
    const props: PreparedNoticeProps = { ...rest, st, ft, fc: colourKey(p.fam, ft) };
    if (p.role === "point" || p.role === "anchor") {
      const base = p.sid ? shortLabel(p.sid) : areaName.get(p.msg);
      const start = st === "u" ? nextStart(p.win, now) : null;
      const lbl = [base, start !== null ? fromLabel(start) : undefined].filter(Boolean).join(" · ");
      if (lbl) props.lbl = lbl;
    }
    if (p.role === "point" || p.role === "vertex") {
      const vl = pickBy({ en: p.vl_en, da: p.vl_da });
      const vtx = p.n ? (vl ? `${p.n}) ${vl}` : `${p.n})`) : vl;
      if (vtx) props.vtx = vtx;
    }
    features.push({ type: "Feature", geometry: f.geometry, properties: props });
  }
  markDuplicateLines(features);
  features.push(...boundaryEdges(features));
  return { type: "FeatureCollection", features };
}
