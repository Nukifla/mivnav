/**
 * MID (Maritime Identification Digits) table generator.
 *
 * Emits `src/midTable.generated.ts` — the MID → country map that `src/mmsi.ts`
 * reads to answer "what country is that AIS target from?".
 *
 * ## Provenance: the ITU, directly
 *
 * Source: https://www.itu.int/gladapp/Allocation/MIDs — the ITU's own "Table of
 * MIDs", served by the GLAD application that backs the human-facing page at
 * https://www.itu.int/en/ITU-R/terrestrial/fmd/Pages/mid.aspx (that page is a
 * SharePoint shell which loads this endpoint; scraping the shell gets you
 * nothing).
 *
 * The ITU is not merely *a* source for this table, it is the body that
 * *assigns* MIDs — every other copy in the wild (OpenCPN's, and the various
 * AIS libraries') is a snapshot of this list and can only be equal or staler.
 * So this generator goes to the origin. Our own reference implementation,
 * ochartsng, was checked and ships no MID table at all — it is a chart
 * renderer and never resolves an MMSI — so there was nothing to port.
 *
 * Country names are emitted **verbatim** from the ITU. See `src/mmsi.ts` for
 * why they are not prettified.
 *
 * ## Why a generator and not a hand-written table
 *
 * ~250 rows of country data is exactly the shape of thing that rots silently
 * and that nobody proofreads. Committing the *generator* next to its output
 * means the next person can re-run it and diff, rather than wonder. It also
 * means no one hand-types a country name, which would be a real navigation
 * error rather than a typo.
 *
 * ## This never runs on the boat
 *
 * The boat has no internet. This is a developer tool, run by hand; its output
 * is committed and is the only thing shipped. Nothing at runtime, build time or
 * test time fetches anything.
 *
 * Regenerate:  cd frontend && bun run mids
 * Validate:    cd frontend && bun run test src/mmsi.test.ts
 */

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_URL = "https://www.itu.int/gladapp/Allocation/MIDs";
const OUT_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "midTable.generated.ts");

/**
 * One `<tr>` of the ITU table: a cell holding one or more MID `<span>`s, then a
 * cell holding the country. Several countries own several MIDs (Denmark has
 * 219 and 220), which is why the first cell is a list.
 */
const ROW_RE = /<tr>\s*<td style="max-width:40px;">(.*?)<\/td>\s*<td>(.*?)<\/td>\s*<\/tr>/gs;
const MID_RE = /button-style[^>]*>\s*(\d{3})\s*<\/span>/g;

/** MIDs are 3-digit and, per the ITU's own assignments, all fall in 2xx-7xx. */
const MID_MIN = 200;
const MID_MAX = 799;

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

function unescapeHtml(s: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] ?? m);
}

/**
 * The one genuine many-to-one in the ITU table.
 *
 * MID 306 is listed three times — for Bonaire/Sint Eustatius and Saba, for
 * Curaçao, and for Sint Maarten. That is not a scraping bug and not something
 * to pick a winner from: an MMSI beginning 306 genuinely does not say which of
 * the three Dutch Caribbean territories it is. What it *does* say
 * unambiguously is the sovereign state, which is what all three share and what
 * "country of origin" asks for. So the shared prefix is the answer, and it is
 * derived from the data rather than typed in.
 */
function reconcile(mid: string, existing: string, incoming: string): string {
  const a = existing.split(" - ")[0].trim();
  const b = incoming.split(" - ")[0].trim();
  if (a === b) return a;
  throw new Error(
    `MID ${mid} maps to two unrelated countries (${existing!} / ${incoming}). ` +
      `The ITU table's shape has changed; this generator needs a human.`,
  );
}

async function main(): Promise<void> {
  const res = await fetch(SOURCE_URL, { headers: { Accept: "text/html" } });
  if (!res.ok) throw new Error(`ITU MID table: HTTP ${res.status}`);
  const html = await res.text();

  const table = new Map<string, string>();
  let rows = 0;
  for (const [, midCell, countryCell] of html.matchAll(ROW_RE)) {
    rows += 1;
    const country = unescapeHtml(stripTags(countryCell)).trim();
    if (!country) throw new Error(`Row ${rows} has MIDs but no country`);
    const mids = [...midCell.matchAll(MID_RE)].map((m) => m[1]);
    if (mids.length === 0) throw new Error(`Row ${rows} (${country}) has no MID`);
    for (const mid of mids) {
      const n = Number(mid);
      if (n < MID_MIN || n > MID_MAX) throw new Error(`MID ${mid} (${country}) is outside 2xx-7xx`);
      const prev = table.get(mid);
      table.set(mid, prev === undefined ? country : reconcile(mid, prev, country));
    }
  }

  // A structural change upstream (a redesigned page, an empty response) must
  // fail loudly rather than quietly emit a table with three countries in it.
  if (rows < 200) throw new Error(`Only ${rows} rows parsed — the ITU page shape has probably changed`);
  if (table.size < 250) throw new Error(`Only ${table.size} MIDs parsed — expected ~290`);

  const entries = [...table.entries()].sort(([a], [b]) => a.localeCompare(b));
  const body = entries.map(([mid, country]) => `  ${mid}: ${JSON.stringify(country)},`).join("\n");

  writeFileSync(
    OUT_FILE,
    `// GENERATED by tools/mid-table/build-mid-table.ts — do not edit by hand.
// Source: ${SOURCE_URL} (the ITU's Table of MIDs; the ITU assigns them).
// Regenerate: cd frontend && bun run mids
//
// ${entries.length} MIDs. Country names are the ITU's own, verbatim — see
// src/mmsi.ts for why they are not shortened.

/** MID (3 digits, as a string — leading digits are significant) to the ITU's
 * name for the administration that owns it. */
export const MID_TO_COUNTRY: Readonly<Record<string, string>> = {
${body}
};
`,
    "utf8",
  );

  console.log(`Wrote ${entries.length} MIDs from ${rows} rows to ${OUT_FILE}`);
}

await main();
