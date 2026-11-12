// InfoProvider for Notices to Mariners (efs.md §2.5 "Tap → info panel").
// Answers taps on the notices overlay's own layers only (scopedQuery over
// NOTICES_QUERY_LAYER_IDS — never a chart hit), ONE hit per message however
// many of its features the tap radius caught (boundary + anchor icon +
// vertex labels + interior). A tap ON an icon/line/boundary ranks with the
// notice's own priority (hazard/regulated); a tap merely INSIDE an area ranks
// in the chart's background-area tier, like a DEPARE (`INTERIOR_PRIORITY`),
// so it JOINS the tap's other hits (depth, weather, POI …) instead of
// heading every tap within a huge area. The record comes from `GET /notices/{id}` — read in
// `NOTICE_LANG` (./lang.ts: English, user "chose english as language"),
// the other language as the `InfoNote.alt` toggle, same mechanism as
// S-57's TXTDSC/NTXTDS pair.
//
// The hit carries only what the map feature knows (family, class, sid); the
// id is the message uuid — or a shortId, for a hit built from a reference —
// so list rows, search rows and references resolve the same `detail`.
//
// FIRING AREAS are the one place a hit is not a message (user: "the firing
// areas all have two "tabs" in the poi list, like there are two areas", then
// "do A and B plus the name title"):
//  A. Niord describes a range twice while exercises are announced — the
//     permanent area (`fa`) and a firing-exercise warning (`fe`), different
//     uuids, same polygon, same area MRN. The two tap hits are folded into
//     ONE on that MRN (`foldFiringHits`), and `detail` folds the records
//     (./detailModel.ts `foldFiringExercises`).
//  B. The chart draws the same range as an S-57 MIPARE that answers a tap
//     anywhere inside it. With a firing notice under the same tap that entry
//     is redundant, and is dropped (`supersedes`).
//  C. A firing hit is titled by the AREA's name ("EK R 45 Hevring"), not the
//     FA number — which stays in the record.

import { createComponent, type Accessor } from "solid-js";
import TriangleAlert from "lucide-solid/icons/triangle-alert";
import type { QueryableMap } from "../../core/info/queryGuard";
import { scopedQuery } from "../../core/info/queryGuard";
import { chartInteriorOnlyArea } from "../../core/info/chartProvider";
import { precisionRank, priorityRank } from "../../core/info/rank";
import type {
  InfoDetail,
  InfoHit,
  InfoNote,
  InfoPoint,
  InfoPrecision,
  InfoPriority,
  InfoProvider,
  InfoQuery,
} from "../../core/info/types";
import type { Palette } from "../../core/style/colors";
import { fetchNoticeDetail } from "./client";
import { NoticeBody } from "./NoticeDetail";
import { noticeIconComponent } from "./NoticeIcon";
import {
  foldFiringExercises,
  LANG_NAME,
  NOTICE_LANG,
  noticeBody,
  noticeHeader,
  noticeLinks,
  noticeSections,
  otherLang,
  type NoticeLang,
} from "./detailModel";
import { classLabel, familyLabel } from "./labels";
import { NOTICES_QUERY_LAYER_IDS } from "./overlay";
import { colourKey, shortLabel } from "./time";
import type { NoticeDetail, NoticeFamily } from "./types";

export const NOTICES_PROVIDER_ID = "notices";

/** What a notices hit carries (`InfoHit.payload`). All optional: a hit built
 * from a bare reference id knows none of it until `detail` resolves. */
export interface NoticeHitPayload {
  fam?: NoticeFamily;
  cls?: string;
  sid?: string | null;
  /** Firing today — a firing area's red/grey, and its priority. */
  ft?: boolean;
  /** The firing-exercise warnings (`fe` message ids) folded into this firing
   * AREA's hit — set by a tap only (`foldFiringHits`). `detail` reads them
   * to fold the records; without them (a list/search/reference-built hit)
   * the area resolves as its own record alone. */
  fe?: readonly string[];
}

const isFiring = (fam: unknown): boolean => fam === "fa" || fam === "fe";

/** Is this one of OUR hits on a firing area or firing exercise? */
function isFiringHit(hit: InfoHit): boolean {
  return hit.providerId === NOTICES_PROVIDER_ID && isFiring((hit.payload as NoticeHitPayload | undefined)?.fam);
}

/** S-57 CATMPA 4: "firing danger area". A list attribute ("4", "2,4"). */
const CATMPA_FIRING = "4";

/**
 * A charted military practice area (S-57 MIPARE) that is a firing danger
 * area and answered the tap only because the tap fell INSIDE it — the entry
 * a firing notice under the same tap makes redundant: same range, but the
 * chart knows neither the schedule, the prohibition nor whether it fires
 * today. A tap on the charted boundary or its centred symbol is not this
 * (`chartInteriorOnlyArea` answers `undefined`): the user pointed at the
 * charted object, and gets it.
 */
export function isChartedFiringInterior(hit: InfoHit): boolean {
  const area = chartInteriorOnlyArea(hit);
  if (!area || area.sourceLayer !== "MIPARE") return false;
  const cat = area.props.CATMPA;
  return (typeof cat === "string" || typeof cat === "number") && `${cat}`.split(",").some((c) => c.trim() === CATMPA_FIRING);
}

/** A firing exercise in force, an NW, or a firing area firing today is a
 * HAZARD — the mariner must keep out or keep watch. Every other notice
 * (T/P/permanent chart corrections, a quiet firing area, general info)
 * constrains rather than endangers: "regulated", like a charted restricted
 * area. */
export function noticePriority(fam: unknown, firingToday: boolean): InfoPriority {
  if (fam === "nw" || fam === "fe") return "hazard";
  if (fam === "fa" && firingToday) return "hazard";
  return "regulated";
}

const PRECISION: Record<string, InfoPrecision> = {
  point: "point",
  anchor: "point",
  vertex: "point",
  line: "line",
  area: "area",
  // An area's boundary line (./time.ts `boundaryEdges`): still the area.
  edge: "area",
};
/** Which of one message's features best answers the tap, most specific
 * first: its icon, its line, its boundary, and only then its interior
 * (`role: "area"`, the invisible hit fill). */
const ROLE_RANK: Record<string, number> = { point: 0, anchor: 0, vertex: 0, line: 1, edge: 2, area: 3 };

/** A tap that only falls INSIDE a notice area (no icon, line or boundary
 * under it) ranks where the chart ranks a tap inside its own background
 * area — DEPARE/DRGARE's `area` tier (core/info/chartProvider.ts
 * CLASS_PRIORITY): below soundings, aids and charted hazards, above weather
 * (`context`), tied with the depth area (chart provider first, so depth
 * leads). The notice's own hazard/regulated priority would put a survey area
 * spanning half the Kattegat FIRST on every tap in it — the hijack the user
 * reported ("i should still have the ability to switch to other poi near it
 * like i normally can eg weather or depth"). The chart's own RESARE/MIPARE
 * make the same split: `regulated` on their boundary or symbol, this tier
 * for a tap that only falls inside (core/info/chartProvider.ts
 * `AREA_INTERIOR_PRIORITY`, through core/style/areaHit.ts's invisible fill). */
export const INTERIOR_PRIORITY: InfoPriority = "area";

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** The hit's list line: the shortId handle ("NM-842"), else (a firing
 * exercise/area has none) its area name, else the family. */
export function noticeHitTitle(fam: unknown, sid: unknown, name?: string): string {
  const s = str(sid);
  return s ? shortLabel(s) : (name ?? familyLabel(fam));
}

export function noticeHitSubtitle(fam: unknown, cls: unknown, sid: unknown): string | undefined {
  return [str(sid) ? familyLabel(fam) : undefined, classLabel(cls)].filter(Boolean).join(" · ") || undefined;
}

/** A firing AREA's list line under its name: what it is and whether it fires
 * today; with a warning folded in and no firing today, that exercises are
 * announced (the days are in the record). */
export function firingAreaSubtitle(firingToday: boolean, exercises: boolean): string {
  const state = firingToday ? "Firing today" : exercises ? "Exercises announced" : "No firing today";
  return `${familyLabel("fa")} · ${state}`;
}

/** A notices hit from what a list row / search row / reference knows —
 * `detail` needs only the id. */
export function noticeHit(fields: {
  id: string;
  fam?: NoticeFamily;
  cls?: string;
  sid?: string | null;
  title?: string;
  lngLat?: InfoPoint;
  precision?: InfoPrecision;
  firingToday?: boolean;
}): InfoHit {
  const payload: NoticeHitPayload = { fam: fields.fam, cls: fields.cls, sid: fields.sid, ft: fields.firingToday };
  return {
    providerId: NOTICES_PROVIDER_ID,
    id: fields.id,
    priority: noticePriority(fields.fam, fields.firingToday === true),
    precision: fields.precision ?? "point",
    title: fields.title ?? noticeHitTitle(fields.fam, fields.sid),
    subtitle: noticeHitSubtitle(fields.fam, fields.cls, fields.sid),
    lngLat: fields.lngLat,
    payload,
  };
}

export interface NoticesProviderDeps {
  /** The live map once the overlay is installed; `queryAt` answers nothing
   * until then (and while the overlay is off — its layers are gone). */
  map: Accessor<QueryableMap | undefined>;
  /** The palette — the panel icon takes the family colour. */
  palette: () => Palette;
  /** Open another notice in the panel (a tapped reference). */
  openNotice: (id: string) => void;
  /** Detail read; defaults to `fetchNoticeDetail`. Seam for tests. */
  loadDetail?: (id: string) => Promise<NoticeDetail | undefined>;
  /** The info panel's selection, narrowed to this provider: the notice id
   * it is showing, or undefined (`InfoProvider.selected`). */
  onSelected?: (id: string | undefined) => void;
  /** Clock seam (tests). */
  now?: () => number;
  /** The snapshot version — a new one drops the detail cache (an updated
   * notice must not show its previous text). */
  version?: () => string | null;
}

/** The record for a fetched notice. `now` decides each window's state. */
export function buildNoticeDetail(d: NoticeDetail, now: number, openNotice: (id: string) => void): InfoDetail {
  const body = (lang: NoticeLang) => () =>
    Promise.resolve(() => createComponent(NoticeBody, { model: noticeBody(d, lang), onOpenNotice: openNotice }));
  const alt = otherLang(NOTICE_LANG);
  const note: InfoNote = {
    label: `Notice text (${LANG_NAME[NOTICE_LANG]})`,
    display: "inline",
    load: body(NOTICE_LANG),
    alt: { label: `Notice text (${LANG_NAME[alt]})`, load: body(alt) },
    // The button names the language it switches TO.
    altToggle: { primary: LANG_NAME[alt], alt: LANG_NAME[NOTICE_LANG] },
  };
  const links = noticeLinks(d);
  return {
    ...noticeHeader(d),
    sections: noticeSections(d, now),
    notes: [note],
    ...(links.length ? { links } : {}),
  };
}

/** What `detail` shows when the record can't be read (backend down, an id
 * Niord no longer has): never a rejection — the panel would only show an
 * empty slide. */
export function unavailableDetail(hit: InfoHit): InfoDetail {
  return {
    sections: [
      {
        rows: [
          {
            label: "Notice",
            value: `Couldn’t load ${hit.title} — the boat’s server has no copy and can’t reach the Danish Maritime Authority right now.`,
          },
        ],
      },
    ],
  };
}

/**
 * A: one hit per firing AREA. Hits are grouped on the area MRN their features
 * carry; a group holding exactly one firing area (`fa`) and at least one
 * firing-exercise warning (`fe`) becomes ONE hit, in the place of the first
 * of them:
 *  - the AREA's id — it is the permanent one, so the entry (and the panel's
 *    selection, and the highlight) is the same before, during and after the
 *    weeks a warning is published;
 *  - the higher priority and the more specific precision of the lot (an `fe`
 *    is a hazard where an idle `fa` is only regulated; on a boundary tap only
 *    one of the two owns the shared edge, the other is an interior hit);
 *  - firing today if EITHER says so (the area's schedule, the warning's
 *    firing days) — which also re-derives the area's own hazard promotion;
 *  - the folded warnings' ids in the payload, for `detail`.
 * Anything else is left exactly as it was: an area with no warning, a
 * warning with no area, a message naming no single area (no MRN), and a
 * group with two areas (nothing says which one a warning belongs to).
 */
export function foldFiringHits(
  hits: readonly InfoHit[],
  mrns: ReadonlyMap<string, string>,
  names: ReadonlyMap<string, string> = new Map(),
): InfoHit[] {
  const groups = new Map<string, InfoHit[]>();
  for (const hit of hits) {
    const mrn = isFiring((hit.payload as NoticeHitPayload | undefined)?.fam) ? mrns.get(hit.id) : undefined;
    if (!mrn) continue;
    const group = groups.get(mrn);
    if (group) group.push(hit);
    else groups.set(mrn, [hit]);
  }
  const replaced = new Map<InfoHit, InfoHit | null>();
  for (const group of groups.values()) {
    const fam = (h: InfoHit) => (h.payload as NoticeHitPayload).fam;
    const areas = group.filter((h) => fam(h) === "fa");
    const exercises = group.filter((h) => fam(h) === "fe");
    if (areas.length !== 1 || exercises.length === 0) continue;
    const area = areas[0]!;
    const payload = area.payload as NoticeHitPayload;
    const ft = group.some((h) => (h.payload as NoticeHitPayload).ft === true);
    // What each would rank as; the area's own tier is re-derived from the
    // folded `ft` unless it was capped as an interior-only hit.
    const tiers = group.map((h) => (h === area && h.priority !== INTERIOR_PRIORITY ? noticePriority("fa", ft) : h.priority));
    const priority = tiers.reduce((a, b) => (priorityRank(b) < priorityRank(a) ? b : a));
    const precision = group
      .map((h) => h.precision)
      .reduce((a, b) => (precisionRank(b) < precisionRank(a) ? b : a));
    const merged: InfoHit = {
      ...area,
      priority,
      precision,
      // One range, so one name: the area's own, else the warning's.
      title: [area, ...exercises].map((h) => names.get(h.id)).find(Boolean) ?? area.title,
      subtitle: firingAreaSubtitle(ft, true),
      payload: { ...payload, ft, fe: exercises.map((h) => h.id) } satisfies NoticeHitPayload,
    };
    group.forEach((h, i) => replaced.set(h, i === 0 ? merged : null));
  }
  if (replaced.size === 0) return [...hits];
  const out: InfoHit[] = [];
  for (const hit of hits) {
    const r = replaced.get(hit);
    if (r === undefined) out.push(hit);
    else if (r) out.push(r);
  }
  return out;
}

export interface NoticesProvider extends InfoProvider {
  /** The cached detail read — shared with list/search/reference opens so a
   * notice is fetched once per panel visit, not once per surface. */
  load(id: string): Promise<NoticeDetail | undefined>;
}

export function createNoticesProvider(deps: NoticesProviderDeps): NoticesProvider {
  const loadDetail = deps.loadDetail ?? ((id: string) => fetchNoticeDetail(id));
  const now = deps.now ?? Date.now;
  // A small cache: the panel re-resolves a hit on every re-show, and a
  // reference opened from a notice usually comes straight back. Failures are
  // not cached (the next tap retries, e.g. once the backend is back).
  const cache = new Map<string, Promise<NoticeDetail | undefined>>();
  const MAX_CACHED = 32;
  let cachedVersion: string | null | undefined;
  const load = (id: string): Promise<NoticeDetail | undefined> => {
    const v = deps.version?.() ?? null;
    if (v !== cachedVersion) {
      cache.clear();
      cachedVersion = v;
    }
    const hit = cache.get(id);
    if (hit) return hit;
    const p = loadDetail(id).then((d) => {
      if (!d) cache.delete(id);
      return d;
    });
    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string);
    cache.set(id, p);
    return p;
  };

  return {
    id: NOTICES_PROVIDER_ID,
    label: "Notices",
    defaultIcon: TriangleAlert,
    load,

    icon(hit: InfoHit) {
      const p = (hit.payload ?? {}) as NoticeHitPayload;
      if (!p.fam || !p.cls) return undefined;
      // An area with a warning folded in takes the warning's colour, the
      // more severe of the two the map draws there.
      const fam = p.fe?.length ? "fe" : p.fam;
      return noticeIconComponent(p.cls, colourKey(fam, p.ft === true), deps.palette);
    },

    queryAt(q: InfoQuery): InfoHit[] {
      const map = deps.map();
      if (!map) return [];
      const { x, y } = q.point;
      const r = q.radius;
      const features = scopedQuery(map, { layerIds: NOTICES_QUERY_LAYER_IDS })([
        [x - r, y - r],
        [x + r, y + r],
      ]);
      // One hit per MESSAGE: a tap on a buoyed area's corner catches its
      // boundary, its anchor icon and a vertex label — all one notice.
      const byMsg = new Map<string, { hit: InfoHit; rank: number }>();
      const names = new Map<string, string>();
      const mrns = new Map<string, string>();
      for (const f of features) {
        const p = (f.properties ?? {}) as Record<string, unknown>;
        const msg = str(p.msg);
        if (!msg) continue;
        const mrn = str(p.mrn);
        if (mrn && !mrns.has(msg)) mrns.set(msg, mrn);
        const name = str(p[`name_${NOTICE_LANG}`]) ?? str(p[`name_${otherLang(NOTICE_LANG)}`]);
        if (name && !names.has(msg)) names.set(msg, name);
        const role = str(p.role) ?? "area";
        const rank = ROLE_RANK[role] ?? ROLE_RANK.area!;
        const prev = byMsg.get(msg);
        // Keep the most specific answer (a tapped icon beats the boundary,
        // the boundary beats the interior).
        if (prev && prev.rank <= rank) continue;
        const hit = noticeHit({
          id: msg,
          fam: str(p.fam) as NoticeFamily | undefined,
          cls: str(p.cls),
          sid: str(p.sid) ?? null,
          lngLat: q.lngLat,
          precision: PRECISION[role] ?? "area",
          firingToday: p.ft === true,
        });
        if (role === "area") hit.priority = INTERIOR_PRIORITY;
        byMsg.set(msg, { hit, rank });
      }
      // Names ride on a firing area's polygon only; the icon hit may have
      // won. A firing notice is titled by its AREA's name whether or not it
      // has a shortId (the FA number is in the record); every other notice
      // keeps its shortId handle.
      for (const [msg, { hit }] of byMsg) {
        const name = names.get(msg);
        const p = hit.payload as NoticeHitPayload;
        if (name && (isFiring(p.fam) || !str(p.sid))) hit.title = name;
        if (p.fam === "fa") hit.subtitle = firingAreaSubtitle(p.ft === true, false);
      }
      return foldFiringHits(
        [...byMsg.values()].map((v) => v.hit),
        mrns,
        names,
      );
    },

    /** B: a firing notice under the tap supersedes the chart's own entry for
     * a firing practice area the tap merely fell inside. No key joins the
     * two (OBJNAM "EK R 45" vs "EK R 45 Hevring", "No.14" vs "14 Hyby
     * Faelled"; one charted area spans three notice areas), so this is by
     * co-occurrence under one tap and deliberately NOT name-matched. Known
     * imprecision: where ranges overlap, a charted area whose own range has
     * no notice under the tap is hidden by a neighbour's notice. With no
     * firing notice in the answer — overlay off, firing family off, snapshot
     * not loaded, a stretch of a charted area no notice covers — the
     * registry never calls this, and the chart entry stays. */
    supersedes(own: readonly InfoHit[], others: readonly InfoHit[]): readonly InfoHit[] {
      return own.some(isFiringHit) ? others.filter(isChartedFiringInterior) : [];
    },

    selected(hit: InfoHit | undefined) {
      // A folded firing hit keeps the AREA's id, and the area's polygon is
      // the exercise's too — the highlight outlines the one range.
      deps.onSelected?.(hit?.id);
    },

    async detail(hit: InfoHit): Promise<InfoDetail> {
      const read = (id: string) => load(id).catch(() => undefined);
      const folded = (hit.payload as NoticeHitPayload | undefined)?.fe ?? [];
      const [d, ...rest] = await Promise.all([read(hit.id), ...folded.map(read)]);
      const exercises = rest.filter((e): e is NoticeDetail => e !== undefined);
      // The area's record unreadable but its warning not: show the warning
      // rather than nothing.
      const record = d ? foldFiringExercises(d, exercises) : exercises[0];
      return record ? buildNoticeDetail(record, now(), deps.openNotice) : unavailableDetail(hit);
    },
  };
}
