// see docs/architecture/satellite-routes.md (Frontend feature module)

import { defineFeature, type AppFeature } from "../../core/chrome/feature";
import { createSatelliteCatalog, type SatelliteCatalogOptions } from "./catalog";
import SatelliteDatasetParams from "./DatasetParams";
import { createSatelliteOverlay } from "./overlay";
import { satelliteSettings, satelliteSourceSection } from "./settings";

export type SatelliteDeps = SatelliteCatalogOptions;

export interface Satellite {
  feature: AppFeature;
  /** Refetch after a bake/delete elsewhere changed what is baked — no
   * tile-cache drop needed (unlike POI's): imagery is raster fetched
   * directly by MapLibre, and the refetch alone rotates the source key. */
  onCatalogChanged: () => void;
}

/** `deps` is the fetch seam for tests; the app calls `createSatellite()` with
 * nothing. */
export function createSatellite(deps: SatelliteDeps = {}): Satellite {
  const catalog = createSatelliteCatalog(deps);
  return {
    onCatalogChanged: catalog.refetch,
    feature: defineFeature({
      id: "satellite",
      overlay: createSatelliteOverlay({ sources: catalog.sources }),
      settings: {
        settings: satelliteSettings,
        // Boat-section list+delete moved into the generic Datasets list
        // (`declared: false` rows, mivnav.api.datasets._orphan_entries).
        sections: [satelliteSourceSection],
        datasetParams: { satellite: SatelliteDatasetParams },
      },
      overlayControls: (deps) => [
        {
          id: "satellite",
          label: "Satellite imagery",
          visible: () => deps.settings().showSatellite,
          setVisible: (v) => deps.setSettings({ showSatellite: v }),
          opacity: () => deps.settings().satelliteOpacity,
          setOpacity: (v) => deps.setSettings({ satelliteOpacity: v }),
        },
      ],
    }),
  };
}
