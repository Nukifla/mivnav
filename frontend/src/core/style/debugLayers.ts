// Debug styling for MVT layers the S-52 generator does not cover yet: one
// fill/line/circle triplet per source-layer, hue keyed by a stable hash of
// the layer name.

import type { FilterSpecification, LayerSpecification } from "maplibre-gl";
import { paletteColors, type Palette } from "./colors";

/** Stable hue (FNV-1a) so a layer keeps its color across reloads. */
function layerHue(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 360;
}

interface Kind {
  suffix: string;
  geometry: string[];
  build: (color: string, filter: FilterSpecification, halo: string) => Partial<LayerSpecification>;
}

const KINDS: Kind[] = [
  {
    suffix: "fill",
    geometry: ["Polygon", "MultiPolygon"],
    build: (color, filter) => ({
      type: "fill",
      filter,
      paint: { "fill-color": color, "fill-opacity": 0.15, "fill-outline-color": color },
    }),
  },
  {
    suffix: "line",
    geometry: ["LineString", "MultiLineString"],
    build: (color, filter) => ({
      type: "line",
      filter,
      paint: { "line-color": color, "line-width": 1, "line-opacity": 0.8 },
    }),
  },
  {
    suffix: "circle",
    geometry: ["Point", "MultiPoint"],
    build: (color, filter, halo) => ({
      type: "circle",
      filter,
      paint: {
        "circle-radius": 2.5,
        "circle-color": color,
        "circle-stroke-width": 1,
        // Was `#ffffff`: a hard white ring turned this into the brightest thing on the chart at night.
        "circle-stroke-color": halo,
      },
    }),
  },
];

/**
 * Debug layers for the given source-layers, in fill < line < circle order.
 * Hues stay palette-independent (a hash of the layer name); only the point
 * ring's halo follows the palette.
 */
export function debugLayers(
  sourceId: string,
  sourceLayers: readonly string[],
  palette: Palette,
): LayerSpecification[] {
  const names = [...sourceLayers].sort();
  const halo = paletteColors(palette).UIBCK;
  const layers: LayerSpecification[] = [];
  for (const kind of KINDS) {
    for (const name of names) {
      const color = `hsl(${layerHue(name)}, 75%, 45%)`;
      const filter: FilterSpecification = ["in", ["geometry-type"], ["literal", kind.geometry]];
      layers.push({
        id: `debug-${sourceId}-${name}-${kind.suffix}`,
        source: sourceId,
        "source-layer": name,
        ...kind.build(color, filter, halo),
      } as LayerSpecification);
    }
  }
  return layers;
}
