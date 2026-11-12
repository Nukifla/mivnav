// `map.addLayer` for our overlay layers, minus maplibre's per-layer validation
// in production builds.
//
// Why: `Map.addLayer` validates every layer, and `Style._validate` builds its
// context with `this.serialize()` — a deep clone of the WHOLE style, ~145
// chart layers — per call. N overlay layers therefore cost O(N × style); at
// boot that measured ~1.2 s of blocked main thread (`ensureOverlays`), and the
// same bill is paid again on every style re-apply (palette switch, settings).
// `Style.addLayer` takes `{ validate: false }`; `Map.addLayer` just never
// passes it. Our specs are static code, so dev builds keep the validation and
// a bad spec still fails loudly there.

import type maplibregl from "maplibre-gl";

export function addLayer(map: maplibregl.Map, layer: maplibregl.AddLayerObject, before?: string): void {
  // Test doubles have no `style`/`_update`; they (and dev) take the public path.
  const style = (map as Partial<maplibregl.Map>).style;
  if (import.meta.env?.PROD && style && typeof style.addLayer === "function" && typeof map._update === "function") {
    style.addLayer(layer, before, { validate: false });
    // What `Map.addLayer` does after `style.addLayer`: mark the style dirty.
    map._update(true);
    return;
  }
  map.addLayer(layer, before);
}
