// Search rows from the backend index's `notices` slice
// (backend/mivnav/features/notices/normalize.py `search_record`): `source`
// "notices", `data = {kind: "notice", id, sid, fam, cls}`, the class in
// `category`. Selecting one opens that notice on the info panel like a tap
// (App's `searchResultToHit`); the row id is the index's prefixed
// `notices:<region>:<uuid>`, so the notice id comes from `data.id`.

import type { InfoHit } from "../../core/info/types";
import type { SearchResult } from "../../core/search/client";
import { NOTICE_FAMILIES, type NoticeFamily } from "./types";
import { noticeHit, noticeHitTitle } from "./provider";

export const NOTICES_SEARCH_SOURCE = "notices";

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function noticeSearchHit(r: SearchResult): InfoHit | undefined {
  if (r.source !== NOTICES_SEARCH_SOURCE) return undefined;
  const data = r.data ?? {};
  const id = str(data.id) ?? r.id.split(":").pop();
  if (!id) return undefined;
  const famRaw = str(data.fam);
  const fam = famRaw && (NOTICE_FAMILIES as readonly string[]).includes(famRaw) ? (famRaw as NoticeFamily) : undefined;
  const sid = str(data.sid) ?? null;
  return noticeHit({
    id,
    fam,
    cls: str(data.cls) ?? r.category ?? undefined,
    sid,
    title: noticeHitTitle(fam, sid, r.title ?? undefined),
    lngLat: r.lat !== null && r.lon !== null ? { lng: r.lon, lat: r.lat } : undefined,
  });
}
