// Which of Niord's two languages (efs.md §1.2) the notices are read in.
// Its own tiny module so the map labels (./time.ts) and the panel/list
// (./detailModel.ts, which imports ./time.ts) share it without a cycle.

export type NoticeLang = "da" | "en";

/** The language notices are READ in: every surface (info panel, list rows,
 * hit titles) shows this first and falls back to the other per field; the
 * info panel offers the other as its `alt` toggle. One constant so the
 * choice can be flipped (or turned into a setting) in one place. User
 * 2026-10-04: "chose english as language" (was Danish-primary). */
export const NOTICE_LANG: NoticeLang = "en";

/** The language that is not `lang` — the panel's alt, every field's fallback. */
export const otherLang = (lang: NoticeLang): NoticeLang => (lang === "da" ? "en" : "da");

/** A language's own name, as its toggle button reads. */
export const LANG_NAME: Record<NoticeLang, string> = { da: "Dansk", en: "English" };
