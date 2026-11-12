// No overlay/mode of its own — the underlay is baked straight into
// `chartStyle.ts`'s `buildStyle`. This only registers the dataset-params
// sub-form and exposes min/maxZoom, which `App.tsx` threads to `MapView`.

import { defineFeature, type AppFeature } from "../../core/chrome/feature";
import { createOsmWorldCatalog, type OsmWorldCatalog, type OsmWorldCatalogOptions } from "./catalog";
import OsmWorldDatasetParams from "./DatasetParams";

export type OsmWorldDeps = OsmWorldCatalogOptions;

export interface OsmWorld {
  feature: AppFeature;
  catalog: OsmWorldCatalog;
}

export function createOsmWorld(deps: OsmWorldDeps = {}): OsmWorld {
  const catalog = createOsmWorldCatalog(deps);
  return {
    catalog,
    feature: defineFeature({
      id: "osm_world",
      settings: {
        settings: [],
        // Per-dataset min_zoom/max_zoom override of the boat-wide extract range.
        datasetParams: { osm_world: OsmWorldDatasetParams },
      },
    }),
  };
}
