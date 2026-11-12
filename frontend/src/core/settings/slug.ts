// Shared id-derivation for client-side synthetic ids (DatasetList.tsx dataset
// ids, and Region ids per settings task uxzqvqpv). One slug rule so both agree
// with the backend's identical `[A-Za-z0-9._-]+` regex (config/model.py's
// `_DATASET_ID_OK`/`_REGION_ID_OK`).

/** A safe id candidate from a sailor-typed Name. Create-time derivation only —
 * the backend's own regex validator is still the real safety net. */
// Combining diacritical marks (U+0300-U+036F) left behind by NFKD folding.
const COMBINING_MARKS = /[̀-ͯ]/g;

export function slugify(name: string, fallback: string): string {
  const folded = name.normalize("NFKD").replace(COMBINING_MARKS, "");
  const slug = folded
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

/** Dedupe a candidate id against ids already in use, appending `-2`, `-3`, … */
export function dedupeId(base: string, taken: readonly string[]): string {
  const takenSet = new Set(taken);
  if (!takenSet.has(base)) return base;
  let n = 2;
  while (takenSet.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}
