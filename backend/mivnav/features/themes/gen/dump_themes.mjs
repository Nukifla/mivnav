// Regenerate `backend/mivnav/features/themes/data/*.json` — one file per
// palette — from the frontend's own theme modules and `index.css`. Run from
// `backend/`:
//
//   bun mivnav/features/themes/gen/dump_themes.mjs
//
// (bun, not node: it reads the TypeScript theme modules directly. No
// `frontend/node_modules` needed — the theme files import only types plus the
// generated S-52 tables, and `themes/index.ts`'s one runtime import,
// `solid-js`'s `createSignal` via `override.ts`, resolves from
// `frontend/node_modules` if present; run `bun install` in `frontend/` if it
// is not.)
//
// WHY A GENERATOR AND NOT A HAND-TRANSCRIPTION. The 12 `ThemeDef`s are not
// pure data:
//   - 9 of 12 reuse `ROUTE_OVERLAY_DAY`/`OVERLAY_DAY`/`POI_DAY`/`BASEMAP_DAY`
//     from `day.ts` BY REFERENCE, 7 of them spreading `{...BASEMAP_DAY, …}`;
//   - `blackback.ts` COMPUTES `basemap.land` as `S52_TABLES.blackback.LANDA`;
//   - `day.ts` cross-references its own siblings (`BASEMAP_DAY.place =
//     POI_DAY.label`);
//   - 5 slice `S52_TABLES`, 7 declare a hand-authored `S52Colors`.
// Evaluating the real modules flattens all of that BY CONSTRUCTION, so the
// JSON cannot drift from the TS by a transcription slip. Same precedent as
// `mivnav/features/weather/gen/dump_colorscales.mjs`.
//
// THREE THINGS THE JSON ADDS that no `ThemeDef` carries:
//
//   `chrome` — the 18 `--color-*` chrome tokens, which live ONLY in
//     `frontend/src/index.css` (Tailwind's `@theme static` only generates
//     utilities from real CSS, so they could not move into the TS). Parsed
//     out of the `:root[data-palette="…"]` blocks; day's come from the
//     `@theme static` block, since day is the unattributed default and has no
//     block of its own. The backend regenerates that CSS at `GET /themes.css`.
//
//   `dark` — whether this palette sets `color-scheme: dark`. Exactly the same
//     five palettes (dusk, night, blackback, graphite, graphite2) that
//     index.css's MapLibre-furniture rules hardcode by name, so ONE flag
//     drives both halves of the generated CSS and a runtime-added dark
//     palette gets control styling instead of nothing.
//
//   `icons` — the 35 icon ROLES from `chartcore/assets/s52-icons/icon-roles.json`.
//     See `deriveIcons` below for the rule.
//
// ABSENCE IS SEMANTIC. `rasterDim`/`basemapTint`/`contourWidth`/`fonts`/
// `sectorOutline`/`sectorArcScale` are optional and an ABSENT key is a real,
// load-bearing choice (day must diff to no raster-paint keys at all — see
// `themes/types.ts`). `JSON.stringify` drops `undefined`, and the theme files
// OMIT rather than null these, so absence survives; `assertShape` below pins
// that no theme grew an unexpected key and no nested `undefined` silently
// vanished.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..", "..", "..", "..");
const FRONTEND = join(REPO, "frontend");
const OUT_DIR = join(import.meta.dirname, "..", "data");
const ROLES_PATH = join(REPO, "chartcore", "assets", "s52-icons", "icon-roles.json");

const { THEMES } = await import(join(FRONTEND, "src", "core", "style", "themes", "index.ts"));

// ── The chrome-token contract ───────────────────────────────────────────────
// The 18 `--color-*` tokens a palette block declares, in index.css's own
// order. Listed explicitly rather than scraped, because the `@theme static`
// block day's values come from also declares non-chrome tokens (--text-*,
// --radius-*, --spacing-*) that are NOT per-palette.
const CHROME_TOKENS = [
  "chrome",
  "chrome-2",
  "fg",
  "fg-2",
  "fg-3",
  "line",
  "line-2",
  "accent",
  "accent-fg",
  "ok",
  "notice",
  "alarm",
  "alarm-fg",
  "on-scrim",
  "route",
  "ap",
  "poi",
  "shadow",
];

const css = readFileSync(join(FRONTEND, "src", "index.css"), "utf8");

/** The `{ … }` body of the rule whose selector is exactly `head`.
 *
 * Anchored at column 0 and required to be followed by `{`, which is what
 * distinguishes the three lookalikes index.css contains for the same text:
 * its own header comment quotes `:root[data-palette="night"] { --color-chrome:
 * … }` as an EXAMPLE (indented, inside a comment), and the MapLibre-furniture
 * rules further down open with `:root[data-palette="dusk"] .maplibregl-…`
 * (column 0, but a descendant selector, not a bare block). Brace-counting for
 * the body rather than a regex: the blocks are comment-heavy. */
function blockBody(head) {
  const at = css.search(new RegExp(`^${head.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`, "m"));
  if (at < 0) throw new Error(`index.css: no block ${head}`);
  const open = css.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`index.css: unterminated block ${head}`);
}

/** `--color-<token>: <value>;` out of one block body, comments stripped. */
function chromeFrom(body, what) {
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = {};
  for (const token of CHROME_TOKENS) {
    const m = new RegExp(`--color-${token}\\s*:\\s*([^;]+);`).exec(clean);
    if (!m) throw new Error(`index.css: ${what} declares no --color-${token}`);
    out[token] = m[1].trim();
  }
  return out;
}

const dayChrome = chromeFrom(blockBody("@theme static"), "@theme static");

// ── Colour maths (OKLab/OKLCH) ──────────────────────────────────────────────

function parseColor(c) {
  c = c.trim();
  let m = /^#([0-9a-f]{6})$/i.exec(c);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(c);
  if (m) return [+m[1], +m[2], +m[3]];
  throw new Error(`cannot parse colour ${c}`);
}
const hex = (rgb) => "#" + rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");
const toLinear = (v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : (((v / 255) + 0.055) / 1.055) ** 2.4);
const fromLinear = (v) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

function rgbToOklab([r8, g8, b8]) {
  const r = toLinear(r8), g = toLinear(g8), b = toLinear(b8);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToRgb([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

const inGamut = (rgb) => rgb.every((v) => v >= -0.5 && v <= 255.5);

/** OKLCH → sRGB, holding L and hue and shrinking CHROMA until the colour
 * fits — the standard gamut-map. Clipping the channels instead would shift
 * the hue (a too-saturated red clips to pure red AND loses its blue), which
 * is the one property this whole derivation exists to preserve. */
function oklchToHex(L, C, h) {
  let lo = 0, hi = C;
  if (inGamut(oklabToRgb([L, C * Math.cos(h), C * Math.sin(h)]))) lo = C;
  else {
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklabToRgb([L, mid * Math.cos(h), mid * Math.sin(h)]))) lo = mid;
      else hi = mid;
    }
  }
  return hex(oklabToRgb([L, lo * Math.cos(h), lo * Math.sin(h)]));
}

// ── The icon-role derivation ────────────────────────────────────────────────

const roles = JSON.parse(readFileSync(ROLES_PATH, "utf8")).roles;

/** Roles that ARE one of the theme's own S-52 tokens, and so are taken
 * verbatim from it rather than remapped. The light colours and the chart
 * magenta are a navigational CONVENTION a theme may retone but must not
 * re-hue (`themes/paper.ts` states the rule for the chart itself: "the S-52
 * light colours and the chart magenta keep their standard hue family
 * regardless"), and every theme already answers exactly that question in its
 * own table — so an icon reads the same token the chart does instead of a
 * second, independently-derived answer to the same question.
 *
 * `lit-white` → LITYW is deliberate and matches day: the roles file records
 * that lights-white and lights-yellow share a hex upstream ("a faithful
 * upstream quirk, NOT a typo… a theme MAY separate them; day must not"), and
 * the S-52 tables have one LITYW token for both. Same for warn-magenta and
 * obj-magenta both taking CHMGD: two roles so a theme CAN split them, one
 * value until one does.
 *
 * `lit-blue`/`lit-amber`/`lit-orange`/`lit-generic` are NOT here — S-52's
 * 27-token subset has no blue/amber/orange/purple light token to read, so
 * they go through the lightness remap below like the object colours. */
const TOKEN_ROLES = {
  "lit-red": "LITRD",
  "lit-green": "LITGN",
  "lit-yellow": "LITYW",
  "lit-white": "LITYW",
  "warn-magenta": "CHMGD",
  "obj-magenta": "CHMGD",
};

/** THE RULE, in one sentence: keep every role's DAY HUE, and re-map its
 * lightness from day's black→white range onto this theme's own ink→paper
 * range.
 *
 * Anchors, both read off the theme's own S-52 table:
 *   ink   = CHBLK — "chart black", the colour a theme draws default point
 *           symbols in. That is literally what the `ink` role is.
 *   paper = UIBCK — the theme's background token, the ground a symbol sits
 *           on. That is literally what the `paper` role is (".basepoint fill
 *           — the disc a buoy body sits on").
 * Measured across all 12: CHBLK is DARKER than UIBCK in the seven light
 * palettes and LIGHTER in the five dark ones (dusk/night/blackback/graphite/
 * graphite2), i.e. the pair tracks each theme's polarity with no exception —
 * which is what makes one affine map correct for all of them. So a dark theme
 * inverts the whole role set for free: `art-ink` (near-black artwork) comes
 * out near-white, which is the single thing a dark palette most needs (the
 * roles file: `ink` "is the outline of every parametric buoy").
 *
 * The map is affine in OKLab L, holding chroma and hue, with the chroma then
 * shrunk to fit sRGB (`oklchToHex`). Two properties fall out of it rather
 * than needing a special case:
 *   - `ink` (day #000000, L=0) lands exactly on CHBLK and `paper` (day
 *     #ffffff, L=1) exactly on UIBCK — the anchors reproduce themselves.
 *   - `obj-black`/`obj-white` do the same, which is right: a black buoy is
 *     drawn in the theme's ink and a white one on the theme's paper.
 *
 * KNOWN, INTENDED CONSEQUENCE: night's ink→paper interval is narrow
 * (L 0.249→0.129) and dusk's narrower still than the light themes', so their
 * icon sets separate by hue far more than by lightness. That is what a
 * dark-adapted palette IS — night's whole S-52 table is compressed the same
 * way — not a bug in this map.
 *
 * These 11 × 35 values are DATA, meant to be retuned by eye (the house style
 * — CLAUDE.md's tuning-knobs note). Edit the JSON, not this function, for a
 * one-off; change this function when the RULE is wrong. day.json is exempt:
 * it is a verbatim copy of the roles file, because a role-substituted day
 * icon must stay byte-identical to today's baked render (the roles file's own
 * "DAY IS THE PROOF"), and `test_themes_api.py` pins that.
 *
 * SUPERSEDED FOR THE SIX `TOKEN_ROLES` (2026-07-29, task otwvprzk). Day's
 * exemption above is exactly what the user saw and asked to be rid of: day's
 * icon red/green/yellow/magenta sat deltaE 13-18 from its own LITRD/LITGN/
 * LITYW/CHMGD while every other theme's matched. Those six are no longer
 * authored in any theme JSON — the frontend derives them from the theme's own
 * S-52 table when a theme set is installed
 * (`frontend/src/core/style/themes/derivedIcons.ts`, which carries the
 * `TOKEN_ROLES` table above verbatim), day included. The other 29 roles are
 * still exactly as described here. This generator is already dead — it imports
 * per-theme TypeScript modules that no longer exist, the JSON being the source
 * of truth now — and is kept as the record of where these values came from. */
function deriveIcons(theme) {
  if (theme.id === "day") return Object.fromEntries(Object.entries(roles).map(([n, r]) => [n, r.day]));
  const inkL = rgbToOklab(parseColor(theme.s52.CHBLK))[0];
  const paperL = rgbToOklab(parseColor(theme.s52.UIBCK))[0];
  const out = {};
  for (const [name, role] of Object.entries(roles)) {
    const token = TOKEN_ROLES[name];
    if (token) {
      out[name] = hex(parseColor(theme.s52[token]));
      continue;
    }
    const [L, a, b] = rgbToOklab(parseColor(role.day));
    out[name] = oklchToHex(inkL + L * (paperL - inkL), Math.hypot(a, b), Math.atan2(b, a));
  }
  return out;
}

// ── Shape check ─────────────────────────────────────────────────────────────

const REQUIRED = ["id", "label", "s52", "canvas", "spritePrefix", "routeOverlay", "overlay", "poi", "basemap"];
const OPTIONAL = ["rasterDim", "basemapTint", "contourWidth", "sectorOutline", "sectorArcScale", "fonts"];

function assertShape(theme) {
  for (const k of REQUIRED) if (!(k in theme)) throw new Error(`${theme.id}: missing required ${k}`);
  for (const k of Object.keys(theme)) {
    if (!REQUIRED.includes(k) && !OPTIONAL.includes(k)) throw new Error(`${theme.id}: unknown key ${k} — update types.ts's mirror here`);
  }
  // `JSON.stringify` silently DROPS a nested `undefined`, which would punch a
  // hole in the schema that looks exactly like a deliberate omission.
  const walk = (o, path) => {
    for (const [k, v] of Object.entries(o)) {
      if (v === undefined) throw new Error(`${theme.id}: ${path}${k} is undefined`);
      if (v && typeof v === "object" && !Array.isArray(v)) walk(v, `${path}${k}.`);
    }
  };
  walk(theme, "");
}

// ── Emit ────────────────────────────────────────────────────────────────────

for (const [order, theme] of THEMES.entries()) {
  assertShape(theme);
  const isDay = theme.id === "day";
  const body = isDay ? null : blockBody(`:root[data-palette="${theme.id}"]`);
  const out = {
    id: theme.id,
    label: theme.label,
    // The Settings dropdown's order (`themes/index.ts`'s THEMES array), carried
    // per-file because there is no barrel on the backend side — the loader
    // sorts by it. A hand-added theme with no `order` sorts last, by id.
    order,
    // See the header: drives BOTH `color-scheme: dark` and the MapLibre
    // furniture overrides in the generated CSS.
    dark: isDay ? false : /color-scheme\s*:\s*dark/.test(body),
    spritePrefix: theme.spritePrefix,
    canvas: theme.canvas,
    s52: theme.s52,
    routeOverlay: theme.routeOverlay,
    overlay: theme.overlay,
    poi: theme.poi,
    basemap: theme.basemap,
    chrome: isDay ? dayChrome : chromeFrom(body, `:root[data-palette="${theme.id}"]`),
    icons: deriveIcons(theme),
  };
  // Optional keys: appended only when the theme actually declares them.
  for (const k of OPTIONAL) if (k in theme) out[k] = theme[k];
  writeFileSync(join(OUT_DIR, `${theme.id}.json`), JSON.stringify(out, null, 2) + "\n");
  console.error(`wrote ${theme.id}.json`);
}
