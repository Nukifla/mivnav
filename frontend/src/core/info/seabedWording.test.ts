import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeAttr } from "./s57";

// Cross-language drift guard for the SEABED-NATURE WORDING.
//
// The same fact is written twice, in two languages, for two consumers:
//   * the chart label — chartcore/src/derive/sbdare.rs bakes SBDARE's `txt`
//     from `NATQUA_WORDS`/`NATSUR_WORDS` at ingest time;
//   * the info panel — ./s57.ts decodes the raw NATSUR/NATQUA codes the tile
//     also carries.
// They used to be worded independently and diverged in three codes (the chart
// said "rocky", "stones", "boulders"; the panel said "rock", "stone",
// "boulder"), which is the bug this guard exists to make impossible to
// reintroduce.
//
// The panel does NOT simply render chartcore's baked `txt` instead, for two
// independent reasons. NATSUR/NATQUA are legal on OBSTRN, UWTROC, LNDRGN,
// SLOGRD, SLOTOP and the two bank classes (chartcore/src/osenc/
// s57objectclasses.csv), none of which derive::sbdare labels and none of which
// are stripped by `render_only_keep` — so their raw codes reach the tile and
// this table is their ONLY decoder. And even on SBDARE, `txt` is deliberately
// absent wherever chartsymbols.xml draws no text (an area with no WATLEV, or a
// WATLEV=4 rock/lava/coral area, which takes the AP(RCKLDG01) pattern instead).
//
// Both tables are IHO S-57 Appendix A, attributes 113 and 114, verbatim and
// lowercase. This test asserts they agree code for code, both ways.

const SBDARE_RS = join(import.meta.dir, "../../../../chartcore/src/derive/sbdare.rs");

/** The `(code, "word")` pairs of one `pub const …_WORDS` table in the Rust
 * source. Throws on a failed parse or an empty table — a regex that quietly
 * stops matching would otherwise leave this whole file green forever. */
function rustWords(src: string, name: string): [number, string][] {
  const table = src.match(new RegExp(`pub const ${name}: &\\[\\(i64, &str\\)\\] = &\\[([^\\]]*)\\]`));
  if (!table) throw new Error(`${name} not found in ${SBDARE_RS}`);
  const pairs = [...table[1].matchAll(/\((\d+),\s*"([^"]+)"\)/g)].map(
    (m) => [Number(m[1]), m[2]] as [number, string],
  );
  if (pairs.length === 0) throw new Error(`no entries parsed for ${name}`);
  return pairs;
}

const src = readFileSync(SBDARE_RS, "utf8");
const NATSUR = rustWords(src, "NATSUR_WORDS");
const NATQUA = rustWords(src, "NATQUA_WORDS");

describe("seabed wording is one table in two languages", () => {
  test("the Rust tables parsed whole", () => {
    // Exact counts, so a parse that finds only the first few entries fails
    // here rather than passing a partial comparison below.
    expect(NATSUR.length).toBe(13);
    expect(NATQUA.length).toBe(10);
  });

  test.each([
    ["NATSUR", NATSUR],
    ["NATQUA", NATQUA],
  ] as const)("%s decodes to chartcore's words", (acronym, words) => {
    for (const [code, word] of words) {
      expect(`${acronym} ${code} → ${decodeAttr(acronym, String(code))}`).toBe(
        `${acronym} ${code} → ${word}`,
      );
    }
  });

  test.each([
    ["NATSUR", NATSUR],
    ["NATQUA", NATQUA],
  ] as const)("%s knows no code chartcore lacks", (acronym, words) => {
    // The other direction: a code the panel labels but the chart cannot is a
    // divergence too. `decodeAttr` falls back to the bare number, so an
    // unlisted code must decode to itself.
    const known = new Set(words.map(([code]) => code));
    for (let code = 1; code <= 30; code++) {
      if (known.has(code)) continue;
      expect(`${acronym} ${code} → ${decodeAttr(acronym, String(code))}`).toBe(
        `${acronym} ${code} → ${code}`,
      );
    }
  });

  test("the user's 2026-07-29 wording call is the one in force", () => {
    // 'rock', not s57.py's 'rocky' — and the same standard's singulars for the
    // two codes s57.py also pluralised.
    expect(decodeAttr("NATSUR", "9")).toBe("rock");
    expect(decodeAttr("NATSUR", "5")).toBe("stone");
    expect(decodeAttr("NATSUR", "18")).toBe("boulder");
  });
});
