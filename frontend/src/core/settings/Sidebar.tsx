import { Show, type Accessor, type Component } from "solid-js";
import type { ChartSet } from "../catalog";
import type { ChromeConfig } from "../chrome/config";
import type { DatasetParamsRegistry } from "./datasetParams";
import type { SettingsRegistry } from "./registry";
import type { BoatCtx, SettingsCtx } from "./ctx";
import Modal from "../chrome/Modal";
import Sheet from "../chrome/Sheet";
import SettingsBrowser from "./SettingsBrowser";
import { Offline } from "./ServerSettings";
import { createServerConfig } from "../serverConfig";
import { useBackDismiss } from "../chrome/backStack";
import { isCompact } from "../media";
import type { SignalKStatus } from "../signalk";
import type { ChartSettings } from "../style/settings";

interface SidebarProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: ChartSettings;
  onSettings: (patch: Partial<ChartSettings>) => void;
  /** The *backend's* SignalK connection state, not this browser's. */
  signalkStatus: SignalKStatus;
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
  /** Non-empty when the catalog did not arrive; see catalog.ts. */
  catalogError: string;
  onRetryCatalog: () => void;
  onCatalogChanged: () => void;
  /** THE assembled settings registry (App.tsx: base + every feature's
   * `settings` contributions, one ordering, one context — `./ctx.ts`).
   * Nothing in this file reads a single section id out of it. */
  settingsReg: SettingsRegistry<SettingsCtx>;
  /** This device's chrome config — the density control's input. */
  chrome: Accessor<ChromeConfig>;
  onChrome: (updater: (cfg: ChromeConfig) => ChromeConfig) => void;
  /** `SettingsCtx.applyLayout` — see its own doc comment (ctx.ts). */
  applyLayout: (blob: unknown) => void;
  /** Every feature's `settings.datasetParams`, assembled by `featureDatasetParams`
   * (chrome/feature.ts) — the dataset list's per-provider params sub-forms. */
  datasetParams: DatasetParamsRegistry;
  /** The Regions section's "Draw on map" entry point. Threaded through, not
   * built here, since closing Settings and entering the chart mode both
   * live in App.tsx alongside `modes`. */
  onStartRegionDraw?: BoatCtx["regionDraw"];
  /** The draw-to-create staging pair — same reason as `onStartRegionDraw`:
   * lives in App.tsx so it survives Settings unmounting `RegionListSection`
   * mid-session. */
  onStageDrawnRegion?: BoatCtx["stageDrawnRegion"];
  onTakeDrawnRegion?: BoatCtx["takeDrawnRegion"];
}

/** Settings shell — a true modal, deliberately. Owns the surface (modal
 * desktop / fullscreen sheet phone) and the one live context every setting
 * reads/writes through. See docs/architecture/settings-modal.md. */
const Sidebar: Component<SidebarProps> = (props) => {
  // The Android/gesture Back button dismisses the settings surface rather than
  // leaving the app. See ../chrome/backStack.ts. (`Modal` registers its own for
  // the desktop branch; this covers the phone `Sheet`, which does not.)
  useBackDismiss(
    () => props.open && isCompact(),
    () => props.onOpenChange(false),
  );

  /** Built over GETTERS on `props`, deliberately: each field re-reads its
   * reactive source at access time, so a control's `read(ctx)` tracks the
   * backing signal and only that one control repaints. */
  const Body: Component = () => {
    const cfg = createServerConfig();
    const ctx: SettingsCtx = {
      get settings() {
        return props.settings;
      },
      onSettings: (patch) => props.onSettings(patch),
      get debugLayers() {
        return props.debugLayers;
      },
      onDebugLayers: (v) => props.onDebugLayers(v),
      get debugTiles() {
        return props.debugTiles;
      },
      onDebugTiles: (v) => props.onDebugTiles(v),
      get debugCells() {
        return props.debugCells;
      },
      onDebugCells: (v) => props.onDebugCells(v),
      get fpsDebug() {
        return props.fpsDebug;
      },
      onFpsDebug: (v) => props.onFpsDebug(v),
      get showGrid() {
        return props.showGrid;
      },
      onShowGrid: (v) => props.onShowGrid(v),
      get sets() {
        return props.sets;
      },
      get disabledSets() {
        return props.disabledSets;
      },
      onToggleSet: (id, enabled) => props.onToggleSet(id, enabled),
      get catalogError() {
        return props.catalogError;
      },
      onRetryCatalog: () => props.onRetryCatalog(),
      get chrome() {
        return props.chrome;
      },
      onChrome: (updater) => props.onChrome(updater),
      applyLayout: (blob) => props.applyLayout(blob),
      cfg,
      get signalkStatus() {
        return props.signalkStatus;
      },
      onCatalogChanged: () => props.onCatalogChanged(),
      get datasetParams() {
        return props.datasetParams;
      },
      get regionDraw(): BoatCtx["regionDraw"] {
        return props.onStartRegionDraw;
      },
      get stageDrawnRegion(): BoatCtx["stageDrawnRegion"] {
        return props.onStageDrawnRegion;
      },
      get takeDrawnRegion(): BoatCtx["takeDrawnRegion"] {
        return props.onTakeDrawnRegion;
      },
    };

    return (
      <SettingsBrowser
        reg={props.settingsReg}
        ctx={ctx}
        // The boat tab's reachability gate — the whole tab says the outage
        // once, instead of every section re-explaining it. Chart/device
        // settings are local and unaffected.
        boatBlocked={() => Boolean(cfg.offline()) || !cfg.config()}
        boatNotice={() => (
          <Show when={cfg.offline()} fallback={<p class="text-xs text-fg-3">Loading…</p>}>
            <Offline cfg={cfg} />
          </Show>
        )}
      />
    );
  };

  return (
    <Show
      when={isCompact()}
      fallback={
        <Modal open={props.open} onOpenChange={props.onOpenChange} title="Settings">
          <Body />
        </Modal>
      }
    >
      <Sheet
        open={props.open}
        onOpenChange={props.onOpenChange}
        title="Settings"
        modal
        fullscreen
        // The sheet's own body stays the scroller (its swipe-to-dismiss depends
        // on it — see SettingsBrowser). Only the padding is dropped, so the
        // category list can run edge to edge.
        bodyClass="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        <Body />
      </Sheet>
    </Show>
  );
};

export default Sidebar;
