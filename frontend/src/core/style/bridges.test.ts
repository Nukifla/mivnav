import { describe, expect, test } from "bun:test";
import { bridgesLineLayers, bridgesSymbolLayers } from "./bridges";
import { paletteColors } from "./colors";
import type { AddLayer, ChartLayer } from "./expr";
import { DEFAULT_SETTINGS } from "./settings";

// BRIDGE used to be decoded (and consulted by the routing hazard engine for
// air-draft blocking) but never drawn — chartcore/src/derive/bridges.rs now
// bakes bcol/bwid/lsty (outline, Line/Area only) and sym/txt (clearance
// marker, any geometry). These pin the frontend half: one line layer, two
// symbol layers.

function lineLayersFor(sourceLayer: string): ChartLayer[] {
  const layers: ChartLayer[] = [];
  const add: AddLayer = (_prio, sl, l) => {
    if (sl === sourceLayer) layers.push(l);
  };
  bridgesLineLayers(add, "chart", DEFAULT_SETTINGS);
  return layers;
}

function symbolLayersFor(sourceLayer: string): ChartLayer[] {
  const layers: ChartLayer[] = [];
  const add: AddLayer = (_prio, sl, l) => {
    if (sl === sourceLayer) layers.push(l);
  };
  bridgesSymbolLayers(add, "chart", DEFAULT_SETTINGS);
  return layers;
}

const C = paletteColors(DEFAULT_SETTINGS.palette);

describe("bridgesLineLayers", () => {
  test("emits exactly one outline layer, bound to the BRIDGE source-layer", () => {
    const layers = lineLayersFor("BRIDGE");
    expect(layers.map((l) => l.id)).toEqual(["chart-bridge-line"]);
    expect(lineLayersFor("CBLOHD")).toEqual([]);
  });

  test("filter covers both Line and Area geometry (S-52's own Point row is blank)", () => {
    const [outline] = lineLayersFor("BRIDGE");
    expect(outline.filter).toEqual([
      "any",
      ["==", ["geometry-type"], "LineString"],
      ["==", ["geometry-type"], "Polygon"],
    ]);
  });

  test("colour is always CHGRD; width falls back to 4 when bwid is absent", () => {
    const [outline] = lineLayersFor("BRIDGE");
    expect(outline.paint!["line-color"]).toBe(C.CHGRD);
    expect(outline.paint!["line-width"]).toEqual(["coalesce", ["get", "bwid"], 4]);
  });
});

describe("bridgesSymbolLayers", () => {
  test("emits the clearance marker and the name label, both bound to BRIDGE", () => {
    const layers = symbolLayersFor("BRIDGE");
    expect(layers.map((l) => l.id)).toEqual(["chart-bridge-clearance", "chart-bridge-label"]);
    expect(symbolLayersFor("CBLOHD")).toEqual([]);
  });

  test("the clearance marker filters on has(sym) and reads sym/txt straight off the tile", () => {
    const [clearance] = symbolLayersFor("BRIDGE");
    expect(clearance.filter).toEqual(["has", "sym"]);
    expect(clearance.layout!["icon-image"]).toEqual(["get", "sym"]);
    expect(clearance.layout!["text-field"]).toEqual(["coalesce", ["get", "txt"], ""]);
  });

  test("the name label prefers NOBJNM over OBJNAM and fires on either being present", () => {
    const [, label] = symbolLayersFor("BRIDGE");
    expect(label.filter).toEqual(["any", ["has", "OBJNAM"], ["has", "NOBJNM"]]);
    expect(label.layout!["text-field"]).toEqual(["coalesce", ["get", "NOBJNM"], ["get", "OBJNAM"], ""]);
  });
});
