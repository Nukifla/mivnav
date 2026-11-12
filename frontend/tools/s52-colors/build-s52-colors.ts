/**
 * S-52 colour-table generator: emits src/style/s52Tables.generated.ts.
 *
 * The chart's colours are not ours to invent. S-52 ships a <color-table> per
 * palette in chartsymbols.xml, and DAY_BRIGHT/DUSK/NIGHT are three columns of
 * one table — the same token set, three sets of values. This tool transcribes
 * the subset we actually use into the tree so that `style/colors.ts` can hold
 * the *semantics* (what NODTA means, why CANVAS exists) while upstream holds
 * the *values*.
 *
 * WHY GENERATE RATHER THAN HAND-COPY. chartsymbols.xml is a git-ignored fetch
 * cache (tools/s52-colors/.cache/, see .gitignore) — a fresh workspace does
 * not have it, and we do not vendor ochartsng (CLAUDE.md). Hand-copying 69
 * numbers off a file that isn't in the tree leaves no way to check them again;
 * generating them leaves the command in the header. Same pattern as
 * tools/mid-table/build-mid-table.ts -> src/midTable.generated.ts.
 *
 * Source data provenance: ochartsng (GPLv2, github.com/wellenvogel/ochartsng)
 * pinned to UPSTREAM_COMMIT below — the same commit chartcore compiled its
 * symbol names against, so colours and symbology cannot drift apart. Cached in
 * tools/s52-colors/.cache/ (this tool is now the only thing that fetches
 * chartsymbols.xml: the HPGL sprite pipeline that used to share the cache is
 * gone). Set MIVNAV_S57DATA=<dir> to seed from a local clone's s57data/
 * instead of the network.
 *
 * Regenerate:  cd frontend && bun run s52-colors
 * Validate:    cd frontend && bun test src/style/colors.test.ts
 */

import { existsSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(TOOL_DIR, ".cache");

/** ochartsng commit the tables are transcribed from. KEEP IN SYNC with the
 * justfile's `s52_commit` and chartcore/src/s52/mod.rs::UPSTREAM_COMMIT
 * (`just check-s52-sync` guards the latter pair). */
export const UPSTREAM_COMMIT = "ed3972268a728d2b1a1d3eccd7861ce38efbee02";

type ColorTable = Map<string, [number, number, number]>;

/** Parse `<color-table name="...">` blocks into name -> token -> rgb. */
function parseColorTables(xml: string): Map<string, ColorTable> {
  const tables = new Map<string, ColorTable>();
  for (const m of xml.matchAll(/<color-table\s+name="([^"]+)"[\s\S]*?<\/color-table>/g)) {
    const table: ColorTable = new Map();
    for (const c of m[0].matchAll(/<color\s+name="([^"]+)"\s+r="(\d+)"\s+g="(\d+)"\s+b="(\d+)"\s*\/>/g)) {
      table.set(c[1], [parseInt(c[2], 10), parseInt(c[3], 10), parseInt(c[4], 10)]);
    }
    tables.set(m[1], table);
  }
  return tables;
}
const OUT_FILE = join(TOOL_DIR, "..", "..", "src", "core", "style", "s52Tables.generated.ts");
const XML_FILE = "chartsymbols.xml";
const UPSTREAM_BASE = `https://raw.githubusercontent.com/wellenvogel/ochartsng/${UPSTREAM_COMMIT}/s57data`;

/** Our palette names -> the S-52 <color-table> each is drawn from.
 *
 * DAY_WHITEBACK/DAY_BLACKBACK are the same day palette re-tuned for a display
 * whose *surround* is fixed white or black — a bridge-hardware fact we cannot
 * guess, so they were left out for years. The theming pass turned that into a
 * mariner's own choice instead of a guess: `whiteback`/`blackback` are now
 * selectable themes (`style/colors.ts`), not an unresolved hardware question. */
const TABLES: { palette: string; table: string }[] = [
  { palette: "day", table: "DAY_BRIGHT" },
  { palette: "dusk", table: "DUSK" },
  { palette: "night", table: "NIGHT" },
  { palette: "whiteback", table: "DAY_WHITEBACK" },
  { palette: "blackback", table: "DAY_BLACKBACK" },
];

/**
 * The tokens we use, and what each one *means*.
 *
 * This map is the manifest twice over: its keys select the subset transcribed
 * out of upstream's ~60-token tables, and its values are the prose emitted as
 * JSDoc onto the generated interface. The split is deliberate — upstream ships
 * numbers, not documentation, so the numbers are generated and the meanings
 * are written here by hand and reviewed like any other prose in the tree.
 *
 * Keep the order: it is the generated file's order, so a re-run after an
 * upstream bump produces a diff of *values* and nothing else.
 */
const DOC: Record<string, string> = {
  NODTA: "No data covered by any chart cell.",
  DEPIT: "Depth: intertidal / dries.",
  DEPVS: "Depth: very shallow (above shallow contour).",
  DEPMS: "Depth: medium shallow (shallow…safety).",
  DEPMD: "Depth: medium deep (safety…deep).",
  DEPDW: "Depth: deep water.",
  DEPSC: "Safety contour line.",
  DEPCN: "Ordinary depth contour line.",
  LANDA: "Land area fill.",
  CHGRF: "Grey outline (dredged area boundary etc.).",
  CHBLK: "Chart black (default point symbols, shallow soundings).",
  CHGRD: "Chart grey (unsurveyed-area edge).",
  CHMGF: "Magenta glow (radar-conspicuous coastline underlay).",
  CHBRN: "Chart brown (shoreline-construction area tint).",
  LANDF: "Land-structure boundary brown (SILTNK/PRDARE's non-conspicuous LS boundary — a genuinely distinct token from CHBRN, not an alias: checked directly against all 5 upstream <color-table>s before assuming otherwise, unlike TRFCF==CHMGF).",
  CSTLN: "Coastline / shoreline constructions.",
  SNDG1: "Soundings deeper than the safety depth (deemphasized).",
  SNDG2: "Soundings at or shallower than the safety depth.",
  LITRD: "Red light (flare tint reference / all-round ring).",
  LITGN: "Green light.",
  LITYW: "White/yellow/amber light.",
  CHMGD: "Chart magenta (restricted-area boundaries, default light colour).",
  TRFCD: "Traffic/caution boundary (CTNARE).",
  TRFCF: "Traffic separation zone fill (TSEZNE, AC(TRFCF,3) — ochartsng's AreaRule drops the trailing transparency arg and draws opaque like every other AC(), so this is a plain fill colour, not a wash).",
  OUTLW: "Symbol outline (black on the day palette; light-ring halo).",
  // The UI-overlay foreground/background pair. Everything above is chart data;
  // these two are for what is drawn *over* it and is not the chart — AIS
  // targets above all. They are the only tokens here that invert across the
  // palettes, and that inversion is the whole reason they are transcribed
  // rather than hand-picked: see the note on halos in ../../src/layers/aisSymbols.ts.
  UINFD: "User-info foreground: outlines and labels of overlays that are not chart data (AIS). Inverts — near-black rgb(7,7,7) on day, light grey rgb(43,48,48) at night.",
  UIBCK: "User-info background: the halo behind such an overlay. UINFD's other half, and it inverts with it — near-white rgb(212,234,238) on day, near-black rgb(7,7,7) at night.",
};

async function ensureXml(): Promise<string> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const dest = join(CACHE_DIR, XML_FILE);
  if (!existsSync(dest)) {
    const seedDir = process.env.MIVNAV_S57DATA;
    if (seedDir && existsSync(join(seedDir, XML_FILE))) {
      copyFileSync(join(seedDir, XML_FILE), dest);
      console.log(`seeded ${XML_FILE} from ${seedDir}`);
    } else {
      const url = `${UPSTREAM_BASE}/${XML_FILE}`;
      console.log(`fetching ${url}`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fetch failed (${res.status}): ${url}`);
      writeFileSync(dest, new Uint8Array(await res.arrayBuffer()));
    }
  }
  return await readFile(dest, "utf8");
}

function main(xml: string): string {
  const tables = parseColorTables(xml);
  const tokens = Object.keys(DOC);

  const body = TABLES.map(({ palette, table }) => {
    const t = tables.get(table);
    if (!t) throw new Error(`no <color-table name="${table}"> in ${XML_FILE}`);
    const rows = tokens.map((tok) => {
      const rgb = t.get(tok);
      if (!rgb) throw new Error(`${table} has no colour "${tok}"`);
      const [r, g, b] = rgb;
      return `    ${tok}: "rgb(${r}, ${g}, ${b})",`;
    });
    return `  ${palette}: {\n${rows.join("\n")}\n  },`;
  }).join("\n");

  const iface = tokens
    .map((tok) => `  /** ${DOC[tok]} */\n  ${tok}: string;`)
    .join("\n");

  const palettes = TABLES.map((t) => `"${t.palette}"`).join(" | ");

  return `// GENERATED by tools/s52-colors/build-s52-colors.ts — do not edit by hand.
// Source: ochartsng s57data/chartsymbols.xml, <color-table name="${TABLES.map((t) => t.table).join('"/"')}">
//   (GPLv2, github.com/wellenvogel/ochartsng @ ${UPSTREAM_COMMIT})
// Regenerate: cd frontend && bun run s52-colors
//
// ${tokens.length} tokens x ${TABLES.length} palettes, transcribed verbatim — these are the
// presentation library's own numbers, not an interpretation of them. The
// meanings in the JSDoc are ours (see the tool's DOC map); the values are not.
// CANVAS is deliberately absent: it is not an S-52 colour. See ./colors.ts.

/** One palette's S-52 colour table, as the subset of tokens we use. */
export interface S52Colors {
${iface}
}

/** The S-52 colour tables, one per palette. */
export const S52_TABLES: Record<${palettes}, S52Colors> = {
${body}
};
`;
}

if (import.meta.main) {
  const xml = await ensureXml();
  const out = main(xml);
  writeFileSync(OUT_FILE, out);
  console.log(`wrote ${OUT_FILE} (${Object.keys(DOC).length} tokens x ${TABLES.length} palettes)`);
}
