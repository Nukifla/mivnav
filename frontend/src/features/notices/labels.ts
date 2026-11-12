// Words for notices: family badge, class noun, time-state line, window
// ranges, status line. Pure — shared by the info panel (./provider.ts), the
// list panel (./NoticesList.tsx) and search rows (./search.ts), so a notice
// reads the same everywhere.

import { formatAgo } from "../../core/format";
import { fromLabel, overlapsToday, timeState, nextStart } from "./time";
import type { NoticeClass, NoticeFamily, NoticesStatus, NoticeWindow, NoticeWindows } from "./types";

/** The family badge (efs.md §2.5). nm-misc is Niord's "miscellaneous" NM —
 * general information, no chart change. */
export const FAMILY_LABELS: Record<NoticeFamily, string> = {
  nw: "Warning",
  fe: "Firing exercise",
  "nm-t": "Temporary (T)",
  "nm-p": "Preliminary (P)",
  "nm-perm": "Permanent",
  "nm-misc": "General",
  fa: "Firing area",
  "efs-a": "EfS A",
  "efs-b": "EfS B",
};

export function familyLabel(fam: unknown): string {
  return typeof fam === "string" && Object.hasOwn(FAMILY_LABELS, fam) ? FAMILY_LABELS[fam as NoticeFamily] : "Notice";
}

export const CLASS_LABELS: Record<NoticeClass, string> = {
  light: "Light",
  buoy: "Buoy",
  beacon: "Beacon",
  wreck: "Wreck / obstruction",
  depth: "Depth",
  works: "Works",
  survey: "Survey",
  dredging: "Dredging",
  cable: "Cable / pipeline",
  bridge: "Bridge",
  farm: "Marine farm",
  firing: "Firing",
  exercise: "Military exercise",
  drifting: "Drifting object",
  radionav: "Radio navigation",
  general: "General",
  other: "Other",
};

export function classLabel(cls: unknown): string | undefined {
  return typeof cls === "string" && Object.hasOwn(CLASS_LABELS, cls) ? CLASS_LABELS[cls as NoticeClass] : undefined;
}

const pad = (n: number): string => `${n}`.padStart(2, "0");

/** "5/10 14:00" (local), with the year when it is not `now`'s; midnight
 * drops the clock — most windows are whole days. */
export function formatStamp(ms: number, now: number): string {
  const d = new Date(ms);
  const year = d.getFullYear() !== new Date(now).getFullYear() ? `/${d.getFullYear()}` : "";
  const clock = d.getHours() === 0 && d.getMinutes() === 0 ? "" : ` ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getDate()}/${d.getMonth() + 1}${year}${clock}`;
}

/** One event window: "5/10 08:00 – 6/10 16:00", "from 5/10" (open end). */
export function formatWindow([from, to]: NoticeWindow, now: number): string {
  if (to === null) return `from ${formatStamp(from, now)}`;
  return `${formatStamp(from, now)} – ${formatStamp(to, now)}`;
}

/** The time-state line a list row / panel shows. A permanent firing area's
 * windows are only the day's firing periods, so it reads "Firing today" /
 * "No firing today" rather than active/ended. */
export function stateText(fam: NoticeFamily, win: NoticeWindows | null | undefined, now: number): string {
  if (fam === "fa") return overlapsToday(win, now) ? "Firing today" : "No firing today";
  const st = timeState(win, now);
  if (st === "a") return "Active";
  if (st === "u") {
    const start = nextStart(win, now);
    return start !== null ? fromLabel(start).replace(/^from/, "From") : "Upcoming";
  }
  return "Ended";
}

/** The list header's status line (efs.md §2.5 "Status"): stale warnings are
 * dangerous and the boat is often offline, so it always says how old. */
export function statusLine(
  status: Pick<NoticesStatus, "state" | "fetched_at"> | undefined,
  fallbackFetchedAt: string | null | undefined,
  now: number,
): string {
  const fetched = status?.fetched_at ?? fallbackFetchedAt ?? null;
  const at = fetched ? Date.parse(fetched) : Number.NaN;
  if (status?.state === "loading") return Number.isNaN(at) ? "Loading…" : `Updating… (data ${formatAgo((now - at) / 1000)})`;
  if (Number.isNaN(at)) return status ? "No data yet" : "Loading…";
  if (status?.state === "offline") return `Offline — data from ${formatStamp(at, now)}`;
  return `Updated ${formatAgo((now - at) / 1000)}`;
}
