// The theming gate — the color half of the RATCHET (v1.0 plan, Decision 10).
//
// Mandate 3 says every surface reads design tokens and nothing hardcodes a
// colour outside the token layer. This test makes NEW violations impossible by
// FAILING the build on them, so the invariant is enforced, not review-hoped.
//
// It gates the two things the color half is about:
//   (a) raw hex literals anywhere in product source EXCEPT `style/colors.ts`.
//       Most such literals are MapLibre-paint / Canvas / SVG values that
//       structurally cannot read a CSS var — the whole point of the carve-out
//       is that they still live in ONE file, so this asserts exactly that.
//   (b) `text-white` / `text-black` in product source — the on-fill colour
//       bypass, which now goes through --color-alarm-fg / --color-on-scrim.
//
// SCOPE / what it does NOT gate (deliberately, per RATCHET):
//   - Arbitrary text sizes (`text-[11px]` &c). The ~316 arbitrary utilities are
//     migrated file-by-file across D2/D3/D5; the size gate flips at Phase-3
//     exit, not here.
//   - `bg-black/*` scrims (Panel/CommandPalette backdrops, the readout pill).
//     Those are dimming overlays, not text-on-a-fill; a different question.
//   - CSS (`index.css`). The @theme tokens ARE hex, legitimately; only .ts/.tsx
//     is scanned, so index.css is out of scope by construction.
//
// ALLOWLIST (minimal, documented):
//   - `style/colors.ts` — the sanctioned home for hex that ISN'T one theme's
//     own fact (marker/debug/grid literals, the derivation glue).
//   - `style/themes/*.ts` — the theme layer. It used to be one hand-authored
//     file per theme; the themes are now JSON in the Python backend, and what
//     remains here is `bundled.generated.ts` (the offline/first-paint copy of
//     that JSON) and `iconRoles.ts` (the role vocabulary generated from
//     chartcore's `icon-roles.json`). Both are GENERATED, so the directory is
//     now closed by construction rather than by convention — nothing
//     hand-written may add hex to it.
//   - `style/s52Tables.generated.ts` — machine-generated S-52 tables (hex).
//   - `*.test.ts` / `*.test.tsx` — tests assert on concrete values (this file
//     included: it contains planted hex to prove the detector works), and tests
//     render no UI, so they are excluded from the scan.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_ROOT = join(import.meta.dir, "..", "..");

/** Files (relative to src/) where hex is allowed, and the one directory
 * (relative to src/, trailing slash) where every file in it is allowed. */
const HEX_ALLOWLIST = new Set(["core/style/colors.ts", "core/style/s52Tables.generated.ts"]);
const HEX_ALLOWLIST_DIRS = ["core/style/themes/"];
const hexAllowed = (rel: string): boolean =>
  HEX_ALLOWLIST.has(rel) || HEX_ALLOWLIST_DIRS.some((dir) => rel.startsWith(dir));

/** A hex colour literal: #rgb, #rgba, #rrggbb or #rrggbbaa, word-bounded so it
 *  does not catch `#privateField` or a `#fragment` in a URL. */
const HEX_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g;

/** The raw on-fill colour classes the gate forbids. */
const COLOR_CLASS_RE = /\btext-(?:white|black)\b/g;

/**
 * Strip `//` and block comments so hex/classes that appear only in explanatory
 * comments (e.g. Controls.tsx documenting a contrast ratio) are not flagged,
 * while keeping string contents intact — a hex inside a real string IS code and
 * must still be caught. Newlines are preserved so reported line numbers hold.
 * A small hand tokenizer, because comment vs string vs template needs state.
 */
function stripComments(src: string): string {
  let out = "";
  let mode: "code" | "line" | "block" | "sq" | "dq" | "tpl" = "code";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const c2 = src[i + 1];
    switch (mode) {
      case "code":
        if (c === "/" && c2 === "/") { mode = "line"; i++; }
        else if (c === "/" && c2 === "*") { mode = "block"; i++; }
        else if (c === "'") { mode = "sq"; out += c; }
        else if (c === '"') { mode = "dq"; out += c; }
        else if (c === "`") { mode = "tpl"; out += c; }
        else out += c;
        break;
      case "line":
        if (c === "\n") { mode = "code"; out += c; }
        break;
      case "block":
        if (c === "*" && c2 === "/") { mode = "code"; i++; }
        else if (c === "\n") out += c;
        break;
      case "sq":
      case "dq":
      case "tpl": {
        const q = mode === "sq" ? "'" : mode === "dq" ? '"' : "`";
        out += c;
        if (c === "\\") { out += c2 ?? ""; i++; }
        else if (c === q) mode = "code";
        break;
      }
    }
  }
  return out;
}

interface Hit {
  readonly line: number;
  readonly text: string;
}

/** Every match of `re` in `code` (comment-stripped), with 1-based line numbers. */
function scan(code: string, re: RegExp): Hit[] {
  const stripped = stripComments(code);
  const hits: Hit[] = [];
  const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = rx.exec(stripped)) !== null) {
    const line = stripped.slice(0, m.index).split("\n").length;
    hits.push({ line, text: m[0] });
  }
  return hits;
}

/** All .ts/.tsx under src/, excluding test files, as paths relative to src/. */
function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "node_modules") continue;
        walk(abs);
      } else if (/\.tsx?$/.test(ent.name) && !/\.test\.tsx?$/.test(ent.name)) {
        found.push(relative(SRC_ROOT, abs));
      }
    }
  };
  walk(SRC_ROOT);
  return found;
}

describe("theming gate (RATCHET color half)", () => {
  const files = sourceFiles();

  test("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  test("no hex literal outside style/colors.ts or style/themes/", () => {
    const offenders: string[] = [];
    for (const rel of files) {
      if (hexAllowed(rel.split("\\").join("/"))) continue;
      const code = readFileSync(join(SRC_ROOT, rel), "utf8");
      for (const hit of scan(code, HEX_RE)) {
        offenders.push(`${rel}:${hit.line} — ${hit.text}`);
      }
    }
    if (offenders.length) {
      throw new Error(
        `Hex must live only in style/colors.ts. Move these into the palette and import them back:\n  ` +
          offenders.join("\n  "),
      );
    }
  });

  test("no text-white / text-black (use --color-alarm-fg / --color-on-scrim)", () => {
    const offenders: string[] = [];
    for (const rel of files) {
      const code = readFileSync(join(SRC_ROOT, rel), "utf8");
      for (const hit of scan(code, COLOR_CLASS_RE)) {
        offenders.push(`${rel}:${hit.line} — ${hit.text}`);
      }
    }
    if (offenders.length) {
      throw new Error(
        `Raw on-fill colour class. Use an on-fill token class (text-alarm-fg, text-on-scrim, …):\n  ` +
          offenders.join("\n  "),
      );
    }
  });

  // The detector itself, on planted violations — so a green suite proves the
  // gate can actually fail, not just that the tree is currently clean.
  describe("the detector catches planted violations", () => {
    test("hex in a string is caught", () => {
      expect(scan('const c = "#abc123";', HEX_RE).map((h) => h.text)).toEqual(["#abc123"]);
      expect(scan('el.style.color = "#fff";', HEX_RE).map((h) => h.text)).toEqual(["#fff"]);
      expect(scan('const c = `stroke="#c800c8"`;', HEX_RE).map((h) => h.text)).toEqual(["#c800c8"]);
    });
    test("hex in a comment is ignored", () => {
      expect(scan("// was #ffffff, now a token", HEX_RE)).toHaveLength(0);
      expect(scan("/* #080c10 on #1d2830 */", HEX_RE)).toHaveLength(0);
    });
    test("non-colour # is not a false positive", () => {
      expect(scan("class Foo { #field = 1; }", HEX_RE)).toHaveLength(0);
      expect(scan('const u = "https://x/y#faq";', HEX_RE)).toHaveLength(0);
    });
    test("text-white / text-black in a class is caught", () => {
      expect(scan('<div class="p-2 text-white" />', COLOR_CLASS_RE).map((h) => h.text)).toEqual([
        "text-white",
      ]);
      expect(scan('<div class="text-black" />', COLOR_CLASS_RE)).toHaveLength(1);
      // A token class is fine.
      expect(scan('<div class="text-alarm-fg" />', COLOR_CLASS_RE)).toHaveLength(0);
    });
  });
});
