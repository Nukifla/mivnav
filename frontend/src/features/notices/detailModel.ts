// `GET /notices/{id}` → what the info panel shows (efs.md §2.5): the
// language-neutral rows (`InfoSection`s: type, state, area, windows, charts)
// and, per language, the body model ./NoticeDetail.tsx renders (title, parts,
// references, source, attachments). Pure, so the mapping is tested without a
// DOM; the component only draws what this decides.

import type { InfoLink, InfoRow, InfoSection } from "../../core/info/types";
import { classLabel, familyLabel, formatStamp, formatWindow, stateText } from "./labels";
import { timeState } from "./time";
import type { NoticeDetail, NoticeWindow } from "./types";
import { NOTICES_API } from "./client";

import { LANG_NAME, NOTICE_LANG, otherLang, type NoticeLang } from "./lang";

export { LANG_NAME, NOTICE_LANG, otherLang, type NoticeLang };

/** Niord part types → panel headings, both languages. */
const PART_HEADINGS: Record<string, Record<NoticeLang, string>> = {
  DETAILS: { da: "Detaljer", en: "Details" },
  TIME: { da: "Tid", en: "Time" },
  SIGNALS: { da: "Signaler", en: "Signals" },
  PROHIBITION: { da: "Forbud", en: "Prohibition" },
  NOTE: { da: "Bemærkning", en: "Note" },
};

const REFERENCE_TYPES: Record<string, Record<NoticeLang, string>> = {
  REFERENCE: { da: "Reference", en: "Reference" },
  REPETITION: { da: "Gentagelse", en: "Repetition" },
  REPETITION_NEW_TIME: { da: "Gentagelse, ny tid", en: "Repetition, new time" },
  CANCELLATION: { da: "Annulleret", en: "Cancelled" },
  UPDATE: { da: "Opdatering", en: "Update" },
};

const WORDS = {
  publication: { da: "Publikation", en: "Publication" },
  source: { da: "Kilde", en: "Source" },
  references: { da: "Henvisninger", en: "References" },
  attachments: { da: "Bilag", en: "Attachments" },
} as const;

export const word = (k: keyof typeof WORDS, lang: NoticeLang): string => WORDS[k][lang];

const humanize = (s: string): string => {
  const t = s.replace(/_/g, " ").toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** Pick a language, falling back to the other one — Niord's English is
 * nearly complete, its Danish complete, but never trust either fully. */
export function pickLang<T extends string | null | undefined>(
  b: { da: T; en: T } | null | undefined,
  lang: NoticeLang,
): string | undefined {
  if (!b) return undefined;
  const first = b[lang];
  const other = b[otherLang(lang)];
  if (typeof first === "string" && first.trim()) return first;
  if (typeof other === "string" && other.trim()) return other;
  return undefined;
}

/** An attachment's `url` is the backend route (`/notices/attachments/…`);
 * the browser reaches the backend under `/api`, like every other call. */
export function attachmentHref(url: string): string {
  if (/^https?:/i.test(url)) return url;
  if (url.startsWith("/notices/")) return `${NOTICES_API}${url.slice("/notices".length)}`;
  return url;
}

export interface NoticeBodyPart {
  heading: string;
  subject?: string;
  html?: string;
}
export interface NoticeBodyReference {
  id: string;
  label: string;
  description?: string;
}
export interface NoticeBodyAttachment {
  href: string;
  name: string;
  image: boolean;
  /** "15 KB" */
  size?: string;
}
export interface NoticeBodyModel {
  lang: NoticeLang;
  title?: string;
  area?: string;
  parts: NoticeBodyPart[];
  publication?: string;
  source?: string;
  references: NoticeBodyReference[];
  attachments: NoticeBodyAttachment[];
}

const formatSize = (bytes: number | null | undefined): string | undefined => {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return undefined;
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;
};

export function noticeBody(d: NoticeDetail, lang: NoticeLang): NoticeBodyModel {
  const area = (d.area?.[lang]?.length ? d.area[lang] : d.area?.[otherLang(lang)]) ?? [];
  return {
    lang,
    title: pickLang(d.title, lang),
    area: area.length ? area.join(" › ") : undefined,
    parts: (d.parts ?? []).map((p) => ({
      heading: PART_HEADINGS[p.type]?.[lang] ?? humanize(p.type),
      subject: p.hide_subject ? undefined : pickLang(p.subject, lang),
      html: pickLang(p.details, lang),
    })),
    publication: pickLang(d.publication, lang),
    source: pickLang(d.source, lang),
    references: (d.references ?? []).map((r) => ({
      id: r.id,
      label: REFERENCE_TYPES[r.type]?.[lang] ?? humanize(r.type),
      description: pickLang(r.description, lang),
    })),
    attachments: (d.attachments ?? []).map((a) => ({
      href: attachmentHref(a.url),
      name: pickLang(a.caption, lang) ?? a.file_name,
      image: typeof a.mime === "string" && a.mime.startsWith("image/"),
      size: formatSize(a.size),
    })),
  };
}

/** "196 (1:75 000)", "103 / INT 1303 (1:200 000)". */
export function chartsText(charts: NoticeDetail["charts"]): string | undefined {
  if (!charts?.length) return undefined;
  return charts
    .map((c) => {
      const intl = c.int_number ? ` / INT ${c.int_number}` : "";
      const scale = c.scale ? ` (1:${c.scale.toLocaleString("en-US").replace(/,/g, " ")})` : "";
      return `${c.number}${intl}${scale}`;
    })
    .join(", ");
}

/** How many event windows the panel lists before "… n more" (a firing
 * exercise can publish dozens of days). */
export const MAX_WINDOWS = 6;

const WINDOW_STATE = { a: "Active", u: "Upcoming", e: "Ended" } as const;

/** The name of the firing area a firing notice (`fa`/`fe`) is about — the
 * last step of its area path ("Denmark › Kattegat › EK R 45 Hevring"), in
 * `lang` with the other language as fallback. `undefined` for every other
 * family: their path ends at a sea, not at a subject. */
export function firingAreaName(d: Pick<NoticeDetail, "fam" | "area">, lang: NoticeLang = NOTICE_LANG): string | undefined {
  if (d.fam !== "fa" && d.fam !== "fe") return undefined;
  for (const l of [lang, otherLang(lang)]) {
    const name = d.area?.[l]?.at(-1);
    if (typeof name === "string" && name.trim()) return name.trim();
  }
  return undefined;
}

const textOf = (html: string | null | undefined): string =>
  (html ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const partKey = (p: NoticeDetail["parts"][number]): string =>
  `${p.type}\u0000${textOf(p.details?.da)}\u0000${textOf(p.details?.en)}`;

/**
 * ONE record for a firing area that Niord describes twice: its permanent
 * definition (`fa`, "FA/EK-R-45 2026") and the firing-exercise warning (`fe`)
 * published for the same range while exercises are announced. Measured on the
 * Danish feed (12 of 32 areas paired, 2026-10-04): the warning repeats every
 * text part of the definition verbatim and adds a TIME part listing the firing
 * days; the definition alone carries the FA number, the reference to last
 * year's notice and today's periods from the firing schedule.
 *
 * So the area's record is kept and the warning folded INTO it — nothing is
 * dropped: the warning's parts the area lacks lead the text (TIME first, as
 * Niord orders them), a part both carry appears once, windows and references
 * are unioned (today's scheduled periods + every announced firing day), and
 * what is left of the warning (its publication stamp and PDF) rides along in
 * `folded`. The result is still an `fa` record, so the state line reads
 * "Firing today" / "No firing today" over the union.
 */
export function foldFiringExercises(area: NoticeDetail, exercises: readonly NoticeDetail[]): NoticeDetail {
  if (exercises.length === 0) return area;
  const own = new Set(area.parts.map(partKey));
  const extra: NoticeDetail["parts"] = [];
  for (const e of exercises) {
    for (const p of e.parts ?? []) {
      const key = partKey(p);
      if (own.has(key)) continue;
      own.add(key);
      extra.push(p);
    }
  }
  const wins = new Map<string, NoticeWindow>();
  for (const w of [...(area.win ?? []), ...exercises.flatMap((e) => e.win ?? [])]) wins.set(`${w[0]}:${w[1]}`, w);
  const refs = [...(area.references ?? [])];
  const attachments = [...(area.attachments ?? [])];
  for (const e of exercises) {
    for (const r of e.references ?? []) if (!refs.some((x) => x.id === r.id && x.type === r.type)) refs.push(r);
    for (const a of e.attachments ?? []) if (!attachments.some((x) => x.url === a.url)) attachments.push(a);
  }
  return {
    ...area,
    parts: [...extra, ...area.parts],
    win: [...wins.values()].sort((a, b) => a[0] - b[0]),
    references: refs,
    attachments,
    folded: exercises.map((e) => ({ id: e.id, publish_from: e.publish_from, updated: e.updated, pdf: e.pdf })),
  };
}

/** The language-neutral record rows. */
export function noticeSections(d: NoticeDetail, now: number): InfoSection[] {
  // A firing area with a warning folded in is called out while a firing
  // window is running, exactly as the warning alone was.
  const hazard = d.fam === "nw" || d.fam === "fe" || (d.fam === "fa" && !!d.folded?.length);
  const head: InfoRow[] = [
    { label: "Type", value: [familyLabel(d.fam), classLabel(d.cls)].filter(Boolean).join(" · ") },
    {
      label: "State",
      value: stateText(d.fam, d.win, now),
      emphasis: hazard && timeState(d.win, now) === "a",
    },
  ];
  // The area breadcrumb leads the body, in the language being read.
  if (d.sid) head.push({ label: "Number", value: d.sid, copy: d.sid });
  if (d.original) head.push({ label: "Original", value: "Original information (*)" });
  if (d.status && d.status !== "PUBLISHED") head.push({ label: "Status", value: humanize(d.status), emphasis: true });

  const sections: InfoSection[] = [{ rows: head }];

  const wins = d.win ?? [];
  if (wins.length) {
    const rows: InfoRow[] = wins.slice(0, MAX_WINDOWS).map((w) => ({
      label: WINDOW_STATE[timeState([w], now)],
      value: formatWindow(w, now),
    }));
    if (wins.length > MAX_WINDOWS) rows.push({ label: "", value: `… ${wins.length - MAX_WINDOWS} more` });
    sections.push({ label: wins.length === 1 ? "Event" : "Events", rows });
  }

  const tail: InfoRow[] = [];
  const charts = chartsText(d.charts);
  if (charts) tail.push({ label: "Charts", value: charts });
  if (d.publish_from) tail.push({ label: "Published", value: formatStamp(d.publish_from, now) });
  if (d.updated) tail.push({ label: "Updated", value: formatStamp(d.updated, now) });
  for (const e of d.folded ?? []) {
    const at = e.publish_from ?? e.updated;
    if (at) tail.push({ label: "Firing warning", value: `issued ${formatStamp(at, now)}` });
  }
  if (tail.length) sections.push({ label: "Publication", rows: tail });
  return sections;
}

/** The official PDFs (Niord's own report) — absolute upstream URLs, so they
 * need internet; the text above is the offline copy. */
export function noticeLinks(d: NoticeDetail): InfoLink[] {
  const links: InfoLink[] = [];
  for (const lang of [NOTICE_LANG, otherLang(NOTICE_LANG)]) {
    const href = d.pdf?.[lang];
    if (href && /^https?:/i.test(href)) links.push({ label: `Official notice (PDF, ${LANG_NAME[lang]})`, href });
  }
  for (const e of d.folded ?? []) {
    for (const lang of [NOTICE_LANG, otherLang(NOTICE_LANG)]) {
      const href = e.pdf?.[lang];
      if (href && /^https?:/i.test(href)) links.push({ label: `Firing warning (PDF, ${LANG_NAME[lang]})`, href });
    }
  }
  return links;
}

/** Header line for a resolved notice: a short handle, not Niord's full
 * "Denmark. The Baltic Sea. …" title (that leads the body, in either
 * language). In `NOTICE_LANG`, the other where it has none. A firing notice
 * is headed by its AREA's name ("EK R 45 Hevring") — the same title its tap
 * hit carries; the FA number stays in the subtitle and the Number row. */
export function noticeHeader(d: NoticeDetail): { title: string; subtitle: string } {
  const title =
    firingAreaName(d) ??
    pickLang(d.vicinity, NOTICE_LANG) ??
    pickLang(d.title, NOTICE_LANG) ??
    d.sid ??
    familyLabel(d.fam);
  const subtitle = [d.sid, familyLabel(d.fam)].filter(Boolean).join(" · ");
  return { title, subtitle };
}

/** The centre of a notice's bbox — where a list/reference/search open puts
 * the info marker. */
export function bboxCentre(bbox: NoticeDetail["bbox"]): { lng: number; lat: number } | undefined {
  if (!bbox) return undefined;
  const [w, s, e, n] = bbox;
  return { lng: (w + e) / 2, lat: (s + n) / 2 };
}
