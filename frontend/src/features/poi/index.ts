// `createPoi` shares one catalog accessor and one `map` signal across the
// overlay/provider/commands: the overlay fills the signal in on `ensure`,
// and the provider (built before the map exists) reads the same signal.

import { createSignal } from "solid-js";
import type { Map as MLMap } from "maplibre-gl";
import { defineFeature, type AppFeature } from "../../core/chrome/feature";
import { clearChartTileCache } from "../../core/chartProtocol";
import type { QueryableMap } from "../../core/info/queryGuard";
import PoiDatasetParams from "./DatasetParams";
import { createPoiCatalog, type PoiCatalogOptions } from "./catalog";
import { poiCommands } from "./commands";
import { createPoiOverlay } from "./overlay";
import { createPoiProvider } from "./provider";

export type PoiDeps = PoiCatalogOptions;

export interface Poi {
  feature: AppFeature;
  /** Drops the RAM tile cache (a re-baked/deleted set reuses its tile URLs,
   * which a URL-keyed cache can't see on its own) and refetches the catalog.
   * See docs/architecture/dataset-list.md. */
  onCatalogChanged: () => void;
}

/** Build the POI feature. `deps.fetch` is the catalog seam (tests). */
export function createPoi(deps: PoiDeps = {}): Poi {
  const catalog = createPoiCatalog({ fetch: deps.fetch });
  const [map, setMap] = createSignal<MLMap>();
  const onCatalogChanged = () => {
    clearChartTileCache();
    catalog.refetch();
  };
  return {
    onCatalogChanged,
    feature: defineFeature({
      id: "poi",
      overlay: createPoiOverlay({ sets: catalog.sets, onMap: setMap }),
      provider: createPoiProvider({
        map: () => map() as QueryableMap | undefined,
      }),
      commands: poiCommands,
      // No opacity control: POI markers read as symbols, not a wash.
      overlayControls: (deps) => [
        {
          id: "poi",
          label: "Points of interest",
          visible: () => deps.settings().showPois,
          setVisible: (v) => deps.setSettings({ showPois: v }),
        },
      ],
      // No `settings.sections`: list+delete lives in the generic dataset list
      // (docs/architecture/dataset-list.md). No standalone settings either —
      // exists only to carry `datasetParams`: the source picker (OSM or a
      // plugin source) and that source's own params (DatasetParams.tsx).
      settings: { settings: [], datasetParams: { poi: PoiDatasetParams } },
    }),
  };
}
