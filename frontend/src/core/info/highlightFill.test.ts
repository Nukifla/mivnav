/**
 * The area wash, judged the way the objection to it was framed.
 *
 * A test asserting `fill-opacity === 0.16` would have no teeth: it restates the
 * number instead of checking the thing the number is *for*. What the wash must
 * not do is stop a mariner reading the depth band underneath it — the panel is
 * usually a sentence *about* that colour — and that is measurable, so it is
 * measured. Change the alpha or the hue and these fail with a reason.
 *
 * CIEDE2000 over ../style/colors.ts's real DAY_BRIGHT tokens. Compositing here
 * mirrors what a MapLibre `fill` layer does and all it can do: source-over,
 * no blend mode.
 *
 * The wash is no longer a fixed hex — it is the ACTIVE THEME's CHMGD (task
 * uqosnyyv) — so this file now has two halves. The first is unchanged in
 * intent and re-measured in value: the α was chosen against DAY_BRIGHT and
 * DAY_BRIGHT is where it is judged, now with day's real CHMGD
 * `rgb(197,69,195)` in place of the retired `#c800c8`. The second
 * ("every theme", at the bottom) is new: eleven other tables now feed the
 * same wash, and a criterion measured on one of them is not a claim about
 * the rest.
 *
 * See highlight.ts `FILL_OPACITY` for the argument these thresholds come from.
 */

import { describe, expect, test } from "bun:test";
import { paletteColors, PALETTES, S52_COLORS, type Palette } from "../style/colors";
import { FILL_OPACITY, highlightMagenta } from "./highlight";

type RGB = [number, number, number];

function parse(css: string): RGB {
  const m = css.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
  if (m) return [+m[1], +m[2], +m[3]];
  const h = css.match(/^#([0-9a-f]{6})$/i);
  if (!h) throw new Error(`unparsed colour: ${css}`);
  const n = parseInt(h[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const srgb = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

function lab([r, g, b]: RGB): [number, number, number] {
  const [R, G, B] = [srgb(r), srgb(g), srgb(b)];
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

/** CIEDE2000. ~2.3 is a just-noticeable difference; ~5 reads as "different". */
function dE(c1: RGB, c2: RGB): number {
  const [L1, a1, b1] = lab(c1);
  const [L2, a2, b2] = lab(c2);
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const [ap1, ap2] = [(1 + G) * a1, (1 + G) * a2];
  const [Cp1, Cp2] = [Math.hypot(ap1, b1), Math.hypot(ap2, b2)];
  const hp = (b: number, a: number) => {
    if (b === 0 && a === 0) return 0;
    const h = (Math.atan2(b, a) / rad) % 360;
    return h < 0 ? h + 360 : h;
  };
  const [hp1, hp2] = [hp(b1, ap1), hp(b2, ap2)];
  const dL = L2 - L1;
  const dC = Cp2 - Cp1;
  let dh = 0;
  if (Cp1 * Cp2 !== 0) {
    dh = hp2 - hp1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dh * rad) / 2);
  const Lb = (L1 + L2) / 2;
  const Cpb = (Cp1 + Cp2) / 2;
  let hb = hp1 + hp2;
  if (Cp1 * Cp2 !== 0) {
    if (Math.abs(hp1 - hp2) > 180) hb += hp1 + hp2 < 360 ? 360 : -360;
    hb /= 2;
  }
  const T =
    1 -
    0.17 * Math.cos((hb - 30) * rad) +
    0.24 * Math.cos(2 * hb * rad) +
    0.32 * Math.cos((3 * hb + 6) * rad) -
    0.2 * Math.cos((4 * hb - 63) * rad);
  const Rc = 2 * Math.sqrt(Cpb ** 7 / (Cpb ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2);
  const Sc = 1 + 0.045 * Cpb;
  const Sh = 1 + 0.015 * Cpb * T;
  const Rt = -Math.sin(2 * (30 * Math.exp(-(((hb - 275) / 25) ** 2))) * rad) * Rc;
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
}

/** What the highlight's fill layer does to the colour under it, and all it can
 * do: MapLibre composites source-over and offers no blend mode. */
function washed(token: RGB): RGB {
  const c = parse(highlightMagenta("day"));
  return token.map((v, i) => Math.round((1 - FILL_OPACITY) * v + FILL_OPACITY * c[i])) as RGB;
}

/** The CIEDE2000 just-noticeable difference: below this, two colours are the
 * same colour to a viewer. Every threshold in this file is a multiple of it,
 * so "visible" and "confusable" mean something rather than being round
 * numbers that happened to pass. */
const JND = 2.3;

const BAND_NAMES = ["DEPIT", "DEPVS", "DEPMS", "DEPMD", "DEPDW"] as const;
const band = (n: (typeof BAND_NAMES)[number]) => parse(S52_COLORS[n]);
/** The depth bands, shallow to deep, plus every other fill a mariner reads as a
 * named area colour. Confusing a washed band with any of these is the failure. */
const NAMED_FILLS = [...BAND_NAMES, "LANDA", "NODTA", "CHMGF"] as const;

describe("the area wash must not cost the mariner the depth band", () => {
  /** Bands that touch on a chart, so the mariner reads one against the other. */
  const ADJACENT: [(typeof BAND_NAMES)[number], (typeof BAND_NAMES)[number]][] = [
    ["DEPIT", "DEPVS"],
    ["DEPVS", "DEPMS"],
    ["DEPMS", "DEPMD"],
    ["DEPMD", "DEPDW"],
  ];

  test("adjacent bands are still obviously different under the wash", () => {
    // When two *washed* bands ever sit side by side. That is not the DEPARE
    // case and never can be — a depth area **is** a band, so a wash covers
    // exactly one. It takes a class drawn *over* water rather than being it: a
    // caution or restricted area straddling a shelving bottom washes every band
    // it happens to cover. Rare, real, and cheap to hold to.
    for (const [a, b] of ADJACENT) {
      const under = dE(washed(band(a)), washed(band(b)));
      expect(under, `washed ${a} vs washed ${b}`).toBeGreaterThan(5);
    }
  });

  test("the everyday case: a washed band against its unwashed neighbour", () => {
    // What a mariner sees on every single selection, and what the original
    // objection to filling at all was really about. On the depth axis the wash
    // turns out to *sharpen* this boundary rather than blur it: those bands
    // differ only in the lightness of one blue, and magenta leaves that axis, so
    // the washed band moves away from its neighbour rather than toward it.
    // Pinned because it is the opposite of the intuition, and because a hue that
    // broke it would break silently.
    //
    // DEPIT is excluded, and the exclusion is the same fact rather than an
    // exception to it: intertidal is *green*, already off the blue axis, so
    // magenta pulls it toward its blue neighbour instead of away (30.8 → 17.7).
    // No sharpening there, and none needed — what is left is three times the
    // floor, and the "cannot be read as another band" test above is what
    // actually guards it.
    const BLUE_AXIS = ADJACENT.filter(([a, b]) => a !== "DEPIT" && b !== "DEPIT");
    for (const [a, b] of BLUE_AXIS) {
      const bare = dE(band(a), band(b));
      const oneWashed = dE(washed(band(a)), band(b));
      expect(oneWashed, `washed ${a} vs unwashed ${b}`).toBeGreaterThan(bare);
    }
    // ...and the green one is still nowhere near its neighbour.
    expect(dE(washed(band("DEPIT")), band("DEPVS"))).toBeGreaterThan(15);
  });

  test("the wash does not eat the contrasts that were already marginal", () => {
    // The absolute floor above is not enough on its own: what it cannot see is
    // a pair that starts near the floor and is pushed to it. Compositing is
    // affine, so the wash scales every contrast by (1−α) in linear light —
    // which is survivable for a pair the chart separates well and is exactly
    // the risk for one it barely separates at all.
    //
    // Only the marginal pairs get the relative rule, and deliberately: DEPIT
    // vs DEPVS is green against blue and drops 30.8 → 23.4, a big relative
    // loss of a contrast so large that what is left is still three times the
    // floor. Holding *that* to a ratio would be a rule about arithmetic rather
    // than about reading a chart.
    //
    // The ratio is (1−α), and that is the point rather than a fitted number:
    // in linear light source-over scales every contrast by exactly (1−α), so
    // this asks that the wash cost no more than compositing arithmetic makes
    // unavoidable. (It used to read 0.9, fitted to the retired `#c800c8`;
    // day's real CHMGD lands DEPMD/DEPDW at 0.893, and a threshold that a
    // 3-point saturation change can trip was measuring the hue, not the rule.)
    for (const [a, b] of ADJACENT) {
      const bare = dE(band(a), band(b));
      if (bare >= 8) continue; // not marginal; the floor above is the rule
      const under = dE(washed(band(a)), washed(band(b)));
      expect(under, `washed ${a} vs ${b}: ${bare.toFixed(1)} → ${under.toFixed(1)}`).toBeGreaterThan(
        bare * (1 - FILL_OPACITY),
      );
    }
  });

  test("a washed band cannot be read as a different, unwashed chart colour", () => {
    // The safety criterion, and the one that chose magenta over any neutral.
    // The failure it forbids is not "the chart looks odd" — it is a mariner
    // reading "6–10 m" off ground charted 4–6 m.
    for (const name of BAND_NAMES) {
      for (const other of NAMED_FILLS) {
        if (other === name) continue;
        const d = dE(washed(band(name)), parse(S52_COLORS[other]));
        expect(
          d,
          `washed ${name} is only ΔE ${d.toFixed(1)} from charted ${other}`,
        ).toBeGreaterThan(5);
      }
    }
  });

  test("a neutral wash would fail that, which is why the hue is not a taste call", () => {
    // Not a test of our code: a test of the *reason* for it, pinned so the
    // argument in highlight.ts cannot quietly become folklore. The depth bands
    // vary along one axis — lightness of blue — so a neutral slides a band
    // along it and onto its neighbour's colour.
    const neutral = (t: RGB, c: RGB, a: number): RGB =>
      t.map((v, i) => Math.round((1 - a) * v + a * c[i])) as RGB;
    // White at the alpha that would make it as visible as ours: DEPVS becomes
    // DEPMS. That is the misreading, in the colours we actually ship.
    expect(dE(neutral(band("DEPVS"), [255, 255, 255], 0.25), band("DEPMS"))).toBeLessThan(3);
    // Black puts deep water in the no-data colour.
    expect(dE(neutral(band("DEPDW"), [0, 0, 0], 0.25), parse(S52_COLORS.NODTA))).toBeLessThan(3);
    // Magenta at our alpha does neither — it leaves the axis entirely.
    expect(dE(washed(band("DEPVS")), band("DEPMS"))).toBeGreaterThan(5);
    expect(dE(washed(band("DEPDW")), parse(S52_COLORS.NODTA))).toBeGreaterThan(5);
  });

  test("the wash is actually visible — a highlight nobody sees is not one", () => {
    // Three JNDs, i.e. "obviously changed" rather than "arguably changed".
    // Was a bare `> 8`, which day's real CHMGD misses by a hair at DEPVS
    // (7.9): less saturated hue, smaller shift, same visible wash. A round
    // number nobody could derive was the wrong pin for it — this one is
    // JND-relative and says what "visible" is supposed to mean.
    for (const name of BAND_NAMES) {
      expect(dE(washed(band(name)), band(name)), `wash on ${name}`).toBeGreaterThan(3 * JND);
    }
  });
});

describe("every theme, not just the one the alpha was tuned on", () => {
  // The wash reads the active theme's CHMGD, so the twelve tables are twelve
  // different washes over twelve different depth ramps. The α stays day's (it
  // is one number and it cannot be twelve), which makes "does it still hold
  // over there?" a question with an answer rather than an assumption — and one
  // that has to be re-answered whenever a theme is added or retuned. That is
  // why these loop `PALETTES` instead of listing what exists today.
  const table = (p: Palette) => paletteColors(p) as unknown as Record<string, string>;
  const wash = (p: Palette, token: RGB): RGB => {
    const c = parse(paletteColors(p).CHMGD);
    return token.map((v, i) => Math.round((1 - FILL_OPACITY) * v + FILL_OPACITY * c[i])) as RGB;
  };
  const ADJACENT: [(typeof BAND_NAMES)[number], (typeof BAND_NAMES)[number]][] = [
    ["DEPIT", "DEPVS"],
    ["DEPVS", "DEPMS"],
    ["DEPMS", "DEPMD"],
    ["DEPMD", "DEPDW"],
  ];

  test("no washed band can be read as a different charted fill, in any theme", () => {
    // THE safety criterion, and the one that has to survive the port: a
    // mariner reading the wrong depth off a washed area is the failure, and it
    // is a failure in whatever theme they are running. Worst case measured is
    // night at ΔE 2.9 — the dark tables collapse the depth ramp on purpose, so
    // there is less room over there, and it still clears a JND.
    for (const p of PALETTES) {
      const T = table(p);
      for (const name of BAND_NAMES) {
        for (const other of NAMED_FILLS) {
          if (other === name) continue;
          const d = dE(wash(p, parse(T[name])), parse(T[other]));
          expect(d, `${p}: washed ${name} is ΔE ${d.toFixed(1)} from charted ${other}`)
            .toBeGreaterThan(JND);
        }
      }
    }
  });

  test("the wash preserves adjacent-band contrast everywhere, never creates it", () => {
    // The relative form of criterion (1), because it is the only form that
    // means anything across these tables: NIGHT deliberately gives DEPVS and
    // DEPMS the SAME value, so an absolute floor is unreachable there and
    // would be a test of S-52's night calibration rather than of our wash.
    // (1−α)=0.84 is what source-over costs in linear light; ΔE is not linear,
    // so the measured range is 0.73–0.91 and the floor is 0.7. A wash that
    // pulled two bands together would fall through it immediately.
    for (const p of PALETTES) {
      const T = table(p);
      for (const [a, b] of ADJACENT) {
        const bare = dE(parse(T[a]), parse(T[b]));
        if (bare < 0.5) continue; // the theme itself does not separate them
        const under = dE(wash(p, parse(T[a])), wash(p, parse(T[b])));
        expect(under / bare, `${p}: ${a}/${b} ${bare.toFixed(1)} → ${under.toFixed(1)}`)
          .toBeGreaterThan(0.7);
      }
    }
  });

  test("the wash is visible in every theme — faint on the dark ones, but there", () => {
    // Only a JND here, not day's three: dusk and night bottom out at 2.6 and
    // 3.3 and that is the NIGHT column working as specified — a desaturated
    // magenta over a collapsed ramp, for an eye that is dark-adapted and must
    // stay that way. The selection is not carried by the wash alone on those
    // themes; the near-white glow line is. Retuning CHMGD per theme is task
    // srxqkvkylnrv, and if it happens this floor is what stops a retune from
    // quietly making the wash invisible.
    for (const p of PALETTES) {
      const T = table(p);
      for (const name of BAND_NAMES) {
        const t = parse(T[name]);
        expect(dE(wash(p, t), t), `${p}: wash on ${name}`).toBeGreaterThan(JND);
      }
    }
  });
});
