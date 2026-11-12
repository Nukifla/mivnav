// The notices API as the frontend sees it — HAND-TYPED from the frozen
// contract in efs.md §6 while the backend routes are built in parallel. Once
// `/notices/*` exists, `bun run api` regenerates `api.generated.ts` and these
// can become aliases of `components["schemas"][...]` (the usual idiom);
// until then this file IS the contract, so keep it literal to §6.

import type { Feature, FeatureCollection, LineString, Point, Polygon } from "geojson";

/** Message family — the colour axis (efs.md §2.1). `nm-misc`/`efs-a`/`efs-b`
 * carry no geometry and so never reach the map; they live in the list. */
export const NOTICE_FAMILIES = ["nw", "fe", "nm-t", "nm-p", "nm-perm", "nm-misc", "fa", "efs-a", "efs-b"] as const;
export type NoticeFamily = (typeof NOTICE_FAMILIES)[number];

/** Subject class — the glyph axis (efs.md §1.4 / §2.4). */
export const NOTICE_CLASSES = [
  "light",
  "buoy",
  "beacon",
  "wreck",
  "depth",
  "works",
  "survey",
  "dredging",
  "cable",
  "bridge",
  "farm",
  "firing",
  "exercise",
  "drifting",
  "radionav",
  "general",
  "other",
] as const;
export type NoticeClass = (typeof NOTICE_CLASSES)[number];

/** Category sub-type — changes the glyph's badge, never the colour. */
export const NOTICE_SUBCLASSES = [
  "missing",
  "off-station",
  "established",
  "withdrawn",
  "replaced",
  "unlit",
  "unreliable",
  "changed",
  "damaged",
  "lit",
  "moved",
  "reduced",
  "normal",
  "completed",
] as const;
export type NoticeSubclass = (typeof NOTICE_SUBCLASSES)[number];

/** `[[from_ms, to_ms | null], ...]` — from `eventDates`, falling back to the
 * publish window. `null` end = open-ended. */
export type NoticeWindow = readonly [number, number | null];
export type NoticeWindows = readonly NoticeWindow[];

/** What a map feature is FOR (efs.md §6). */
export type NoticeRole = "area" | "line" | "point" | "anchor" | "vertex";

/** `GET /notices/status`. */
export interface NoticesStatus {
  state: "idle" | "loading" | "ready" | "offline";
  version: string | null;
  fetched_at: string | null;
  count: number;
  by_family: Partial<Record<NoticeFamily, number>>;
  error: string | null;
}

/** Properties on every `GET /notices/map.geojson` feature. */
export interface NoticeFeatureProps {
  msg: string;
  sid: string | null;
  fam: NoticeFamily;
  cls: NoticeClass;
  sub: NoticeSubclass | null;
  win: NoticeWindows;
  gl: boolean;
  role: NoticeRole;
  /** `area` only (firing polygons): the area name. */
  name_da?: string;
  name_en?: string;
  /** `point`/`vertex`: the position number from the text's "1) 2) …" table. */
  n?: string;
  vl_da?: string;
  vl_en?: string;
  /** `fa` only: firing today (its `win` = today's periods). */
  firing_today?: boolean;
  /** `fa`/`fe` only: the firing area's MRN (`urn:mrn:iho:fa:dk:ek-r-45`) when
   * the message names exactly one — the key a permanent firing area and the
   * firing-exercise warning for the same range share (./provider.ts folds
   * the two tap hits into one on it). */
  mrn?: string;
}

export type NoticeGeometry = Point | LineString | Polygon;
export type NoticeFeature = Feature<NoticeGeometry, NoticeFeatureProps>;
export type NoticesMap = FeatureCollection<NoticeGeometry, NoticeFeatureProps>;

/** `{da, en}` — Niord's two languages, English complete (efs.md §1.2). */
export interface Bilingual<T = string> {
  da: T;
  en: T;
}

/** One row of `GET /notices/list`. */
export interface NoticeListItem {
  id: string;
  sid: string | null;
  fam: NoticeFamily;
  cls: NoticeClass;
  sub: NoticeSubclass | null;
  title: Bilingual;
  vicinity: Bilingual<string | null>;
  area: Bilingual<string[]>;
  win: NoticeWindows;
  publish_from: number | null;
  publish_to: number | null;
  created: number | null;
  updated: number | null;
  lon: number | null;
  lat: number | null;
  gl: boolean;
  has_geometry: boolean;
}

/** `GET /notices/list`. */
export interface NoticesList {
  version: string | null;
  fetched_at: string | null;
  items: NoticeListItem[];
}

/** `GET /notices/{id}` — for the info-panel worker (task 5). */
export interface NoticeDetail {
  id: string;
  sid: string | null;
  fam: NoticeFamily;
  cls: NoticeClass;
  sub: NoticeSubclass | null;
  main_type: string;
  type: string;
  status: string;
  title: Bilingual;
  vicinity: Bilingual<string | null>;
  area: Bilingual<string[]>;
  publication: Bilingual<string | null> | null;
  source: Bilingual<string | null>;
  charts: { number: string; int_number: string | null; scale: number | null }[];
  references: { id: string; type: string; description: Bilingual | null }[];
  original: boolean;
  win: NoticeWindows;
  publish_from: number | null;
  publish_to: number | null;
  created: number | null;
  updated: number | null;
  parts: {
    type: string;
    subject: Bilingual | null;
    hide_subject: boolean;
    details: Bilingual;
    win: NoticeWindows;
  }[];
  attachments: { url: string; file_name: string; mime: string; size: number; caption: Bilingual | null }[];
  pdf: Bilingual;
  bbox: [number, number, number, number] | null;
  /** CLIENT-side only, never on the wire: the firing-exercise warnings folded
   * into this firing area's record (./detailModel.ts `foldFiringExercises`). */
  folded?: readonly FoldedExercise[];
}

/** What survives of a folded firing-exercise warning beyond its text parts,
 * windows and references (which are merged into the area's own). */
export interface FoldedExercise {
  id: string;
  publish_from: number | null;
  updated: number | null;
  pdf: Bilingual;
}
