/**
 * The info-panel vessel icon draws the SAME picture the chart draws.
 *
 * `vesselIconModel` is the panel's half of the map's `targetFeatures`: it picks
 * the body, the colour and the day-shape overlay by the identical rules. Pinned
 * here so the two can never drift — a target that is a red leaf-with-anchor on
 * the chart is a red leaf-with-anchor in the panel.
 *
 * Pure and DOM-free: the model is a plain object, so no rendering, no
 * `mock.module` (which bun leaks across the run).
 */

import { describe, expect, test } from "bun:test";
import { vesselIconModel } from "./BoatGlyph";
import { OWN_SHIP_ID, type AisVessel } from "./vessel";
import { AIS_COLORS, RISK_COLORS, RISK_OFF_COLOR, symbolColors } from "../layers/aisSymbols";
import { DEFAULT_SETTINGS, type ChartSettings } from "../style/settings";

const settings = (patch: Partial<ChartSettings> = {}): ChartSettings => ({ ...DEFAULT_SETTINGS, ...patch });
const target = (patch: Partial<AisVessel> = {}): AisVessel => ({ id: "mmsi:1", lat: 0, lng: 0, ...patch });

describe("vesselIconModel — the panel icon matches the chart symbol", () => {
  test("own ship is its own red, no day shape, no risk colour", () => {
    const m = vesselIconModel({ id: OWN_SHIP_ID, self: true, lat: 0, lng: 0, headingDeg: 42 }, settings(), "red");
    expect(m.hull).toEqual({ body: "dart", fill: AIS_COLORS.own, shape: null });
    expect(m.rotation).toBe(42);
    expect(m.station).toBeUndefined();
  });

  test("a target wears its risk colour when the risk engine is on", () => {
    expect(vesselIconModel(target(), settings(), "red").hull?.fill).toBe(RISK_COLORS.red);
    expect(vesselIconModel(target(), settings(), "yellow").hull?.fill).toBe(RISK_COLORS.yellow);
    // Never green: unknown is grey, the same ladder the map uses.
    expect(vesselIconModel(target(), settings(), "unknown").hull?.fill).toBe(RISK_COLORS.unknown);
    expect(vesselIconModel(target(), settings(), "unknown").hull?.fill).not.toBe(RISK_COLORS.green);
  });

  test("risk OFF collapses every target to the one neutral colour", () => {
    const off = settings({ showAisRisk: false });
    for (const risk of ["red", "yellow", "green", "unknown"] as const) {
      expect(vesselIconModel(target(), off, risk).hull?.fill).toBe(RISK_OFF_COLOR);
    }
  });

  test("the body is the vessel's type — a sailing vessel is a leaf", () => {
    expect(vesselIconModel(target({ shipTypeId: 36 }), settings(), "green").hull?.body).toBe("leaf");
    expect(vesselIconModel(target({ shipTypeId: 74 }), settings(), "green").hull?.body).toBe("house");
    expect(vesselIconModel(target({ shipTypeId: 60 }), settings(), "green").hull?.body).toBe("dart");
  });

  test("the day-shape overlay follows overlayShape — leaf drops its sail, keeps its anchor", () => {
    // A sailing leaf under way: the redundant mainsail overlay is suppressed.
    expect(vesselIconModel(target({ shipTypeId: 36 }), settings(), "green").hull?.shape).toBeNull();
    // ...but an anchored one keeps the safety shape on the leaf.
    expect(vesselIconModel(target({ shipTypeId: 36, navStatus: "anchored" }), settings(), "green").hull?.shape).toBe(
      "anchor",
    );
    // A plain dart shows whatever COLREGS shape she flies.
    expect(vesselIconModel(target({ navStatus: "aground" }), settings(), "unknown").hull?.shape).toBe("aground");
  });

  test("a non-vessel station is peeled off — its fixed symbol, never a risk hull", () => {
    const m = vesselIconModel(target({ id: "mmsi:992191234", mmsi: "992191234" }), settings(), "red");
    expect(m.station).toBe("aton");
    expect(m.hull).toBeUndefined();
  });

  test("rotation is heading, falling back to COG, else undefined", () => {
    expect(vesselIconModel(target({ headingDeg: 10, cogDeg: 20 }), settings(), "green").rotation).toBe(10);
    expect(vesselIconModel(target({ cogDeg: 20 }), settings(), "green").rotation).toBe(20);
    expect(vesselIconModel(target(), settings(), "green").rotation).toBeUndefined();
  });

  test("outline and halo track the palette — day and night invert", () => {
    const day = vesselIconModel(target(), settings({ palette: "day" }), "green");
    const night = vesselIconModel(target(), settings({ palette: "night" }), "green");
    expect(day.ui).toBe(symbolColors("day").ui);
    expect(night.ui).toBe(symbolColors("night").ui);
    expect(day.ui).not.toBe(night.ui);
  });
});
