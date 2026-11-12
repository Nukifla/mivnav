// The sheet's one piece of pure logic: which fields the picker may offer.
//
// "The field picker offers what the selected source lists, and nothing else" is
// this task's headline requirement (#qmnwrupv), and it is the rule that
// replaced a hardcoded marine set whose entries rendered a blank wash on any
// backing that never carried them.

import { describe, expect, it } from "bun:test";
import { fieldOptions } from "./sheet";

const ids = (opts: { value: string }[]) => opts.map((o) => o.value);

describe("fieldOptions — only what the source serves", () => {
  it("keeps the design card's three as segments and pushes the rest under Others", () => {
    const o = fieldOptions(["wind", "gusts", "pressure", "temperature"]);
    expect(ids(o.primary)).toEqual(["wind", "gusts"]);
    // Pressure/Temp must NOT be promoted into the segment row just because this
    // source happens not to serve waves — the card's identity is fixed, its
    // membership is not.
    expect(ids(o.others)).toEqual(["pressure", "temperature", "off"]);
  });

  it("shows a wave-only source its one segment, not an empty Wind/Gusts row", () => {
    const o = fieldOptions(["waves"]);
    expect(ids(o.primary)).toEqual(["waves"]);
    expect(ids(o.others)).toEqual(["off"]);
  });

  it("shows a wind-only source (a GRIB bake) exactly one field", () => {
    const o = fieldOptions(["wind"]);
    expect(ids(o.primary)).toEqual(["wind"]);
    expect(ids(o.others)).toEqual(["off"]);
  });

  it("offers NOTHING but Off when the source serves nothing this app draws", () => {
    // An ocean / air-quality domain is a real product with no wash here, and
    // `variables_for` reports it as empty rather than guessing.
    const o = fieldOptions([]);
    expect(o.primary).toEqual([]);
    expect(ids(o.others)).toEqual(["off"]);
  });

  it("never offers a variable no source declares", () => {
    // `visibility` was in the old hardcoded set. Even handed one explicitly it
    // cannot appear: the list is filtered from WEATHER_FIELDS, which mirrors
    // `sources/base.py`'s canonical VARIABLES.
    const o = fieldOptions(["wind", "visibility"]);
    expect([...ids(o.primary), ...ids(o.others)]).not.toContain("visibility");
  });

  it("Off is always last and always available — it is not a variable", () => {
    for (const vars of [[], ["wind"], ["wind", "gusts", "waves", "pressure"]]) {
      const o = fieldOptions(vars);
      expect(o.others[o.others.length - 1].value).toBe("off");
    }
  });
});
