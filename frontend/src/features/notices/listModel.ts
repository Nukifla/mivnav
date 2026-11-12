// The notices list panel's logic (efs.md §2.5 "Notices list panel"), pure:
// family chips, the text filter, distance sort from own ship (else the map
// centre) with no-geometry notices grouped last, and the "new / updated since
// you last opened the list" badge. ./NoticesList.tsx only draws this.

import { rangeNm, type GeoPoint } from "../../core/chrome/geo";
import { NOTICE_LANG, pickLang } from "./detailModel";
import type { NoticeFamily, NoticeListItem } from "./types";

export type { GeoPoint };

/** A filter chip: one or more families. Firing exercises and permanent
 * firing areas are one chip (one map toggle too); EfS A/B and General carry
 * no geometry and live only here. */
export interface FamilyChip {
  id: string;
  label: string;
  fams: readonly NoticeFamily[];
}

export const FAMILY_CHIPS: readonly FamilyChip[] = [
  { id: "nw", label: "Warnings", fams: ["nw"] },
  { id: "t", label: "T", fams: ["nm-t"] },
  { id: "p", label: "P", fams: ["nm-p"] },
  { id: "perm", label: "Permanent", fams: ["nm-perm"] },
  { id: "firing", label: "Firing", fams: ["fe", "fa"] },
  { id: "general", label: "General", fams: ["nm-misc"] },
  { id: "efs-a", label: "EfS A", fams: ["efs-a"] },
  { id: "efs-b", label: "EfS B", fams: ["efs-b"] },
];

export function formatDistanceNm(nm: number): string {
  if (nm < 10) return `${nm.toFixed(1)} nm`;
  return `${Math.round(nm)} nm`;
}

/** A list row's two text lines in `NOTICE_LANG`, the other language per
 * field where it has none: the vicinity (else the title) as the headline,
 * the full title under it — omitted when it would repeat the headline. */
export function rowText(item: NoticeListItem): { headline?: string; title?: string } {
  const title = pickLang(item.title, NOTICE_LANG);
  const headline = pickLang(item.vicinity, NOTICE_LANG) ?? title;
  return { headline, title: title !== headline ? title : undefined };
}

/** Lower-case, accents stripped (NFKD: "å"→"a"), and the two Danish letters
 * NFKD leaves whole spelled out — so "aro" finds "Årø". */
const fold = (s: string): string =>
  s
    .toLocaleLowerCase("da")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae");

/** Does the item match the free-text filter? Every whitespace-separated word
 * must appear in its shortId, title, vicinity or area, either language
 * (folded, see `fold`). */
export function matchesText(item: NoticeListItem, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fold(
    [
      item.sid ?? "",
      item.title?.da ?? "",
      item.title?.en ?? "",
      item.vicinity?.da ?? "",
      item.vicinity?.en ?? "",
      ...(item.area?.da ?? []),
      ...(item.area?.en ?? []),
    ].join(" "),
  );
  return words.every((w) => hay.includes(w));
}

/** No chip selected = every family. */
export function matchesChips(item: NoticeListItem, chips: ReadonlySet<string>): boolean {
  if (chips.size === 0) return true;
  return FAMILY_CHIPS.some((c) => chips.has(c.id) && c.fams.includes(item.fam));
}

export interface ListRow {
  item: NoticeListItem;
  /** Nautical miles from the reference point; undefined = no position. */
  distanceNm?: number;
  /** Updated (or created) since the list was last opened. */
  isNew: boolean;
}

export interface ListGroups {
  /** Notices with a position, nearest first. */
  located: ListRow[];
  /** Notices with no geometry (general, EfS A/B …), newest first. */
  unlocated: ListRow[];
}

/** Whether `item` counts as new/updated since `lastOpened`. Nothing is new on
 * the very first open (`lastOpened` null) — everything would be. */
export function isNewSince(item: NoticeListItem, lastOpened: number | null): boolean {
  if (lastOpened === null) return false;
  const t = Math.max(item.updated ?? 0, item.created ?? 0, item.publish_from ?? 0);
  return t > lastOpened;
}

const newest = (i: NoticeListItem): number => Math.max(i.updated ?? 0, i.publish_from ?? 0, i.created ?? 0);

/** Filter, measure and sort. `from` is own ship if there is a fix, else the
 * map centre; with neither, located rows sort by shortId. */
export function buildList(
  items: readonly NoticeListItem[],
  opts: { chips: ReadonlySet<string>; query: string; from?: GeoPoint; lastOpened: number | null },
): ListGroups {
  const located: ListRow[] = [];
  const unlocated: ListRow[] = [];
  for (const item of items) {
    if (!matchesChips(item, opts.chips) || !matchesText(item, opts.query)) continue;
    const isNew = isNewSince(item, opts.lastOpened);
    if (item.lon === null || item.lat === null || item.lon === undefined || item.lat === undefined) {
      unlocated.push({ item, isNew });
    } else {
      const distance = opts.from ? rangeNm(opts.from, { lng: item.lon, lat: item.lat }) : undefined;
      located.push({ item, distanceNm: distance, isNew });
    }
  }
  located.sort((a, b) =>
    a.distanceNm !== undefined && b.distanceNm !== undefined
      ? a.distanceNm - b.distanceNm
      : (a.item.sid ?? "").localeCompare(b.item.sid ?? ""),
  );
  unlocated.sort((a, b) => newest(b.item) - newest(a.item));
  return { located, unlocated };
}

// --- "last opened" — per device, in localStorage, never trusted to exist ---

export const LAST_OPENED_KEY = "mivnav.notices.lastOpened";

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const defaultStore = (): KeyValueStore | undefined => {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
};

export function readLastOpened(store: KeyValueStore | undefined = defaultStore()): number | null {
  try {
    const raw = store?.getItem(LAST_OPENED_KEY);
    const n = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function writeLastOpened(t: number, store: KeyValueStore | undefined = defaultStore()): void {
  try {
    store?.setItem(LAST_OPENED_KEY, String(t));
  } catch {
    // Private window / blocked storage: the badge just never shows.
  }
}
