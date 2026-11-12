import { describe, expect, test } from "bun:test";
import { attrLabel, classTitle, decodeAttr, trimLitdsn } from "./s57";

describe("trimLitdsn: characteristic + period from chartcore's baked litdsn", () => {
  test("drops the height and range tail, keeping the characteristic + period", () => {
    // chartcore emits `<char><group><colours> <period>s <height> <range>`.
    expect(trimLitdsn("Fl(2)WR 5s 12m 10M")).toBe("Fl(2)WR 5s");
    expect(trimLitdsn("FlG 5s 12m 10M")).toBe("FlG 5s");
    expect(trimLitdsn("OcWRG 4s 8m 5Nm")).toBe("OcWRG 4s");
  });

  test("a litdsn already without height/range is unchanged", () => {
    expect(trimLitdsn("FlG 5s")).toBe("FlG 5s");
    // A two-digit period fuses to the characteristic (no width-pad space); the
    // trailing-shape fallback leaves it whole when there is no tail to drop.
    expect(trimLitdsn("Fl(2)10s")).toBe("Fl(2)10s");
  });

  test("a two-word characteristic (Al Fl) keeps both words", () => {
    // The period anchor spans the whole characteristic, not just the last word.
    expect(trimLitdsn("Al FlWR 5s 12m")).toBe("Al FlWR 5s");
  });

  test("a periodless fixed light still strips its height/range", () => {
    expect(trimLitdsn("FR 12m 5M")).toBe("FR");
  });

  test("empty or non-string → undefined", () => {
    expect(trimLitdsn("")).toBeUndefined();
    expect(trimLitdsn(undefined)).toBeUndefined();
    expect(trimLitdsn(42)).toBeUndefined();
  });
});

describe("classTitle: every drawn source-layer resolves to a human name", () => {
  // Every class the style (../style/*.ts) actually queries against — a
  // regression here means an info-panel hit with no OBJNAM falls back to the
  // raw S-57 acronym (wkmquskz). ATON is excluded: it un-merges via
  // BOYSHP/BCNSHP, tested separately below.
  const DRAWN_CLASSES = [
    "UNSARE", "DEPARE", "DRGARE", "LNDARE", "LNDRGN", "DEPCNT", "SOUNDG", "COALNE", "SLCONS",
    "TOPMAR", "DAYMAR", "LIGHTS", "WRECKS", "OBSTRN", "UWTROC", "RESARE", "ACHARE", "CTNARE",
    "MIPARE", "DMPGRD", "CBLARE", "PIPARE", "CBLSUB", "CBLOHD", "PIPSOL", "PIPOHD", "ISTZNE",
    "PRCARE", "FAIRWY", "MARCUL", "CTSARE", "FERYRT", "PILBOP", "TSSCRS", "TSSRON", "TSSLPT",
    "TSEZNE", "TSSBND", "SILTNK", "PRDARE", "RDOCAL", "RDOSTA", "RSCSTA", "SISTAT", "SISTAW",
    "LITVES", "LITFLT", "MORFAC", "LNDMRK", "SBDARE",
  ];

  test.each(DRAWN_CLASSES)("%s does not fall back to its own acronym", (cls) => {
    expect(classTitle(cls, {})).not.toBe(cls);
  });

  test("ATON un-merges to Buoy/Beacon, and falls back to the generic name without either", () => {
    expect(classTitle("ATON", { BOYSHP: 1 })).toBe("Buoy");
    expect(classTitle("ATON", { BCNSHP: 1 })).toBe("Beacon");
    expect(classTitle("ATON", {})).toBe("Aid to navigation");
  });
});

describe("landmark and industrial categories decode to words", () => {
  // User report: a cemetery showed as "CATLMK 2" in the info panel.
  test("CATLMK", () => {
    expect(attrLabel("CATLMK")).toBe("Category of landmark");
    expect(decodeAttr("CATLMK", 2)).toBe("cemetery");
    expect(decodeAttr("CATLMK", "17,20")).toBe("tower, spire/minaret");
  });
  test("FUNCTN, CATSIL, CATPRA", () => {
    expect(decodeAttr("FUNCTN", 20)).toBe("church");
    expect(decodeAttr("CATSIL", 4)).toBe("water tower");
    expect(decodeAttr("CATPRA", 8)).toBe("tank farm");
  });
});
