// One settings context, replacing two incompatible registries (device/boat)
// that were never merged. DeviceCtx/BoatCtx stay separate types — the
// intersection SettingsCtx is what every descriptor is declared against.

import type { Accessor } from "solid-js";
import type { ChartSet } from "../catalog";
import type { ChromeConfig } from "../chrome/config";
import type { ServerConfigController } from "../serverConfig";
import type { SignalKStatus } from "../signalk";
import type { ChartSettings } from "../style/settings";
import type { DatasetParamsRegistry } from "./datasetParams";
import type { BBox } from "./regions";

/** Live inputs a DEVICE setting's read/write closes over. Built once over
 * live getters, so every field re-reads its reactive source on touch. */
export interface DeviceCtx {
  settings: ChartSettings;
  onSettings: (patch: Partial<ChartSettings>) => void;
  debugLayers: boolean;
  onDebugLayers: (value: boolean) => void;
  debugTiles: boolean;
  onDebugTiles: (value: boolean) => void;
  debugCells: boolean;
  onDebugCells: (value: boolean) => void;
  fpsDebug: boolean;
  onFpsDebug: (value: boolean) => void;
  showGrid: boolean;
  onShowGrid: (value: boolean) => void;
  sets: ChartSet[];
  disabledSets: string[];
  onToggleSet: (id: string, enabled: boolean) => void;
  catalogError: string;
  onRetryCatalog: () => void;
  chrome: Accessor<ChromeConfig>;
  onChrome: (updater: (cfg: ChromeConfig) => ChromeConfig) => void;
  /** Apply a stored (opaque) layout blob onto this device's chrome —
   * `ProfilesSection.tsx`'s "load a profile that references a layout" path. */
  applyLayout: (blob: unknown) => void;
}

/** The DeviceCtx twin for BOAT settings. `cfg` is the ONE controller every
 * boat setting reads/writes; `signalkStatus` is the BACKEND's link state,
 * not this browser's. */
export interface BoatCtx {
  cfg: ServerConfigController;
  signalkStatus: SignalKStatus;
  /** Draw bounding boxes for "Regions" (kolmnrsk): closes Settings, enters
   * `region-draw` mode, calls back with every committed box, reopens
   * Settings. Absent under `bun test` (no map, no modes). */
  regionDraw?: (existing: readonly BBox[], onDone: (boxes: BBox[]) => void) => void;
  /** Stage a draw-to-CREATE result (kolmnrsk). Drawing closes Settings, which
   * unmounts `RegionListSection`, so this lives in App.tsx instead;
   * `takeDrawnRegion` picks it back up once Settings reopens. */
  stageDrawnRegion?: (boxes: BBox[]) => void;
  /** Read-and-clear (one-shot, so a later Settings open never resurrects a
   * stale draft), called once on `RegionListSection` mount. */
  takeDrawnRegion?: () => BBox[] | null;
}

/** Context every descriptor (device, boat, or a feature's) is declared
 * against — `onCatalogChanged`/`datasetParams` exist because core boat
 * sections are registry entries now too, not hardcoded shell children. */
export interface SettingsCtx extends DeviceCtx, BoatCtx {
  /** Something installed, baked or deleted the boat's chart/dataset catalog —
   * the shell drops its chart tile cache and refetches. */
  onCatalogChanged: () => void;
  /** Every feature's `settings.datasetParams` — the dataset list's per-provider
   * params sub-form registry (`chrome/feature.ts` `featureDatasetParams`). */
  datasetParams: DatasetParamsRegistry;
}

/** BOAT half stub for a device-only surface. Reading `cfg` throws — a
 * surface offering no server controller is the honest outcome. */
export const NO_BOAT_CTX = {
  cfg: undefined as unknown as ServerConfigController,
  signalkStatus: "off" as SignalKStatus,
  onCatalogChanged: () => {},
  datasetParams: {} as DatasetParamsRegistry,
};
