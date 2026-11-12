/**
 * The generic SignalK-path widget's PURE half: the helpers and the instrument
 * built from a per-device spec. The `maxUrgency: "none"` safety invariant is
 * asserted directly here (a user widget is never alarm-grade); the registry
 * resolution and its structural exclusion from `alerts()` moved to the unified
 * `withWidgets` and are tested in `widget.test.ts`.
 *
 * NB: needs `--conditions=browser` (the `test` script).
 */

import { describe, expect, test } from "bun:test";
import type { PathValue } from "../signalk";
import { type SkWidgetSpec } from "./config";
import { DESK, type ReadCtx } from "./registry";
import { formatSkValue, readablePath, shortPath, skInstrument } from "./skWidget";

const CTX: ReadCtx = { density: DESK, band: "rail", room: "board" };

describe("readablePath / shortPath — deriving words from a machine path", () => {
  test("takes the last two segments, splits camelCase, capitalises", () => {
    expect(readablePath("electrical.batteries.house.voltage")).toBe("House voltage");
    expect(readablePath("navigation.speedOverGround")).toBe("Navigation speed over ground");
  });

  test("drops numeric instance segments", () => {
    expect(readablePath("electrical.batteries.1.voltage")).toBe("Batteries voltage");
    expect(shortPath("electrical.batteries.1.voltage")).toBe("VOLTAG");
  });

  test("falls back to the whole path when there is nothing better", () => {
    expect(readablePath("")).toBe("");
  });
});

describe("formatSkValue — tolerant of whatever the bus reports", () => {
  test("a number is fixed to the given decimals", () => {
    expect(formatSkValue(12.567, 1)).toBe("12.6");
    expect(formatSkValue(12.567, 0)).toBe("13");
  });
  test("a numeric string is formatted, a non-numeric one shown verbatim", () => {
    expect(formatSkValue("3.14159", 2)).toBe("3.14");
    expect(formatSkValue("charging", 1)).toBe("charging");
  });
  test("an object is JSON, never [object Object]", () => {
    expect(formatSkValue({ latitude: 1 }, 1)).toBe('{"latitude":1}');
  });
});

describe("skInstrument — the generic per-spec instrument", () => {
  const paths = (v: Record<string, PathValue>) => () => v;

  test("is maxUrgency:none — MANDATORY, never alarm-grade", () => {
    const inst = skInstrument("sk:1", { path: "a" }, paths({}));
    expect(inst.maxUrgency).toBe("none");
    // and it declares no way to request urgency or alert text
    expect(inst.urgency).toBeUndefined();
    expect(inst.alertText).toBeUndefined();
  });

  test("reads the value from signalk.paths, with unit and decimals defaults", () => {
    const inst = skInstrument("sk:1", { path: "elec.v" }, paths({ "elec.v": { value: 12.63, units: "V" } }));
    expect(inst.read(CTX)).toEqual({ value: "12.6", unit: "V" });
  });

  test("spec overrides win over the SignalK meta and the default decimals", () => {
    const spec: SkWidgetSpec = { path: "elec.v", label: "House", unit: "volts", decimals: 2 };
    const inst = skInstrument("sk:1", spec, paths({ "elec.v": { value: 12.634, units: "V" } }));
    expect(inst.label).toBe("House");
    expect(inst.read(CTX)).toEqual({ value: "12.63", unit: "volts" });
  });

  test("shows a null-state dash when the path has no value", () => {
    const inst = skInstrument("sk:1", { path: "elec.v" }, paths({}));
    expect(inst.read(CTX)).toEqual({ value: "—", state: "null" });
  });

  test("reports the backend-computed age via staleAge (only present when stale)", () => {
    const fresh = skInstrument("sk:1", { path: "a" }, paths({ a: { value: 1 } }));
    expect(fresh.staleAge!()).toBeNull();
    const stale = skInstrument("sk:1", { path: "a" }, paths({ a: { value: 1, age: 30 } }));
    expect(stale.staleAge!()).toBe(30);
  });

  test("the label is derived from the path when the spec gives none", () => {
    const inst = skInstrument("sk:1", { path: "tanks.freshWater.0.currentLevel" }, paths({}));
    expect(inst.label).toBe("Fresh water current level");
  });
  test("converts SI to the chosen display unit", () => {
    const p = paths({ "nav.sog": { value: 5, units: "m/s" } });
    expect(skInstrument("sk:1", { path: "nav.sog", unit: "km/h" }, p).read(CTX)).toEqual({ value: "18.0", unit: "km/h" });
    // blank → the quantity's default (kn)
    expect(skInstrument("sk:1", { path: "nav.sog" }, p).read(CTX)).toEqual({ value: "9.7", unit: "kn" });
  });

  test("no live meta units: falls back to the path list's units and still converts", () => {
    // SignalK sends meta about once, at connect; a path subscribed later has
    // a value but no units in the live snapshot — it showed "0.5 %".
    const p = paths({ "bat.soc": { value: 0.53 } });
    const listed = (path: string) => (path === "bat.soc" ? "ratio" : undefined);
    expect(skInstrument("sk:1", { path: "bat.soc", unit: "%" }, p, listed).read(CTX)).toEqual({ value: "53", unit: "%" });
    expect(skInstrument("sk:1", { path: "bat.soc" }, p, listed).read(CTX)).toEqual({ value: "53", unit: "%" });
  });

  test("a legacy free-text unit naming a known unit converts; other text stays a label", () => {
    const p = paths({ "nav.sog": { value: 5, units: "m/s" }, "tank.l": { value: 0.5, units: "ratio" } });
    expect(skInstrument("sk:1", { path: "nav.sog", unit: "knots" }, p).read(CTX)).toEqual({ value: "9.7", unit: "kn" });
    expect(skInstrument("sk:1", { path: "tank.l", unit: "%" }, p).read(CTX)).toEqual({ value: "50", unit: "%" });
    expect(skInstrument("sk:1", { path: "nav.sog", unit: "boatspeed" }, p).read(CTX)).toEqual({ value: "5.0", unit: "boatspeed" });
  });

  test("unknown or missing SignalK units: raw value plus the label", () => {
    const p = paths({ a: { value: 3.21 }, b: { value: 3.21, units: "zz" } });
    expect(skInstrument("sk:1", { path: "a", unit: "kn" }, p).read(CTX)).toEqual({ value: "3.2", unit: "kn" });
    expect(skInstrument("sk:1", { path: "b" }, p).read(CTX)).toEqual({ value: "3.2", unit: "zz" });
  });
});
