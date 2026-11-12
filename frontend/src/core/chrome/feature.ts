// The APP-LAYER feature: one declaration folding everything a feature can
// contribute (kernel instruments/modes/dashboard PLUS app-layer overlay,
// info provider, commands, widgets, settings) into a single `AppFeature`.
// See docs/architecture/app-feature-registry.md for why this sits above the
// pure, DOM-free ./registry.ts, and how the six feature*() projections work.

import type { Accessor } from "solid-js";
import { defineFeature as defineKernelFeature, type Feature as KernelFeature } from "./registry";
import type { DashboardPage, Instrument, Mode } from "./registry";
import type { Overlay } from "../layers/overlay";
import type { InfoProvider } from "../info/types";
import type { Command } from "./command";
import type { CommandDeps } from "./commands";
import type { Widget } from "./widget";
import type { Setting, SettingsCategory, SettingsSection } from "../settings/registry";
import type { SettingsCtx } from "../settings/ctx";
import type { ChartSettings } from "../style/settings";
import type { DatasetParamsRegistry } from "../settings/datasetParams";

/**
 * One descriptor per controllable map LAYER, so the Layers panel renders
 * every one uniformly. Deliberately NOT the chart's imperative {@link Overlay}
 * — see docs/architecture/app-feature-registry.md.
 */
export interface MapLayer {
  id: string;
  label: string;
  /** Is the layer currently shown. */
  visible: () => boolean;
  /** Show/hide it — the ONLY thing the panel toggle does (never a mode change). */
  setVisible: (v: boolean) => void;
  /** Present only for layers that support an opacity blend (the ENC groups, the
   * weather wash, satellite imagery). Absent ⇒ the panel draws a toggle alone. */
  opacity?: () => number;
  setOpacity?: (v: number) => void;
  /** Optional availability/cascade gate — false greys the row out (nothing
   * today uses it, but a future "needs a baked set" layer would). */
  enabled?: () => boolean;
  /** PINNED topmost, never reordered — own-ship. Absent/false ⇒ freely
   * reorderable. See docs/architecture/app-feature-registry.md. */
  pinned?: boolean;
}

/** @deprecated Old name for {@link MapLayer}; kept for source compat. */
export type OverlayControl = MapLayer;

/**
 * The live app-state an overlay's descriptor builder closes over — same
 * shape-of-deps pattern as `commands: (deps: CommandDeps) => Command[]`.
 */
export interface OverlayControlDeps {
  settings: Accessor<ChartSettings>;
  setSettings: (patch: Partial<ChartSettings>) => void;
  /** Weather's wash is visible while its mode is open even before
   * `keepVisible` is set. Matches `modes.active`. */
  activeMode: () => string | null;
}

/**
 * A feature's settings contribution: controls, whole sections, whole nav
 * categories. A section may JOIN an existing category by naming it rather
 * than declaring one. See docs/architecture/app-feature-registry.md.
 */
export interface FeatureSettings {
  settings: readonly Setting<SettingsCtx>[];
  sections?: readonly SettingsSection<SettingsCtx>[];
  categories?: readonly SettingsCategory[];
  datasetParams?: DatasetParamsRegistry;
}

/** Everything a feature can declare in ONE call. `id`/`instruments`/`modes`/
 * `dashboard` are validated by the kernel `defineFeature`; the rest are the
 * app-layer surfaces this feature also feeds. */
export interface AppFeatureSpec {
  id: string;
  instruments?: readonly Instrument[];
  modes?: readonly Mode[];
  dashboard?: readonly DashboardPage[];
  /** A chart overlay this feature draws (the ruler line, the route line). */
  overlay?: Overlay;
  /** An info-at-point source this feature contributes (the wind readout). */
  provider?: InfoProvider;
  /** The commands this feature contributes — a builder over the shared
   * `CommandDeps`, so a mode's launcher closes over `toggleMode`/`activeMode`. */
  commands?: (deps: CommandDeps) => Command[];
  /** Dashboard widget KINDS this feature adds (beyond the built-in `WIDGETS`). */
  widgets?: readonly Widget[];
  settings?: FeatureSettings;
  /** The Layers-panel OVERLAY controls this feature contributes — a builder,
   * like `commands`, so a descriptor can close over live app state. */
  overlayControls?: (deps: OverlayControlDeps) => OverlayControl[];
}

/** A feature as assembled: the validated, frozen kernel `Feature` (`core`)
 * plus the app-layer surfaces carried as data. */
export interface AppFeature {
  core: KernelFeature;
  overlay?: Overlay;
  provider?: InfoProvider;
  commands?: (deps: CommandDeps) => Command[];
  widgets?: readonly Widget[];
  settings?: FeatureSettings;
  overlayControls?: (deps: OverlayControlDeps) => OverlayControl[];
}

/** Declare a feature: kernel invariants run on the `core` sub-object via the
 * kernel `defineFeature`; app-layer surfaces ride alongside. Feature authors
 * import THIS `defineFeature`, not `registry.ts`'s. */
export function defineFeature(spec: AppFeatureSpec): AppFeature {
  return {
    core: defineKernelFeature({
      id: spec.id,
      instruments: spec.instruments,
      modes: spec.modes,
      dashboard: spec.dashboard,
    }),
    overlay: spec.overlay,
    provider: spec.provider,
    commands: spec.commands,
    widgets: spec.widgets,
    settings: spec.settings,
    overlayControls: spec.overlayControls,
  };
}

// The projections: one list in, six registries out. Each collector is
// `features.flatMap(...)` over one field; App.tsx concatenates with its BASE
// list and hands the result to the matching `create*` fan-out.

/** The pure kernel features — what `createRegistry` assembles. */
export const coreFeatures = (features: readonly AppFeature[]): KernelFeature[] =>
  features.map((f) => f.core);

/** The chart overlays features draw — merged after `baseOverlays` in MapView. */
export const featureOverlays = (features: readonly AppFeature[]): Overlay[] =>
  features.flatMap((f) => (f.overlay ? [f.overlay] : []));

/** The info-at-point providers features contribute — `attachInfoPanel`'s
 * `opts.providers` (slotted between the built-in chart and point sources). */
export const featureProviders = (features: readonly AppFeature[]): InfoProvider[] =>
  features.flatMap((f) => (f.provider ? [f.provider] : []));

/** The commands features contribute, built against the live `deps`. */
export const featureCommands = (
  features: readonly AppFeature[],
  deps: CommandDeps,
): Command[] => features.flatMap((f) => f.commands?.(deps) ?? []);

/** The dashboard widget KINDS features add — merged after the built-in `WIDGETS`. */
export const featureWidgets = (features: readonly AppFeature[]): Widget[] =>
  features.flatMap((f) => [...(f.widgets ?? [])]);

/** The settings features declare — merged after the base declarations. */
export const featureSettings = (features: readonly AppFeature[]): Setting<SettingsCtx>[] =>
  features.flatMap((f) => [...(f.settings?.settings ?? [])]);

/** The settings SECTIONS features introduce — merged after the base sections. */
export const featureSettingsSections = (
  features: readonly AppFeature[],
): SettingsSection<SettingsCtx>[] =>
  features.flatMap((f) => [...(f.settings?.sections ?? [])]);

/** The settings CATEGORIES features introduce — merged after the base rails. A
 * feature only needs one when it wants its own pane; joining an existing pane is
 * a `category` on its section. */
export const featureSettingsCategories = (features: readonly AppFeature[]): SettingsCategory[] =>
  features.flatMap((f) => [...(f.settings?.categories ?? [])]);

/** The per-provider dataset-params form components features register, merged
 * into ONE map `DatasetEditForm` picks from by `DatasetConfig.provider`. Last
 * write wins on a collision — see docs/architecture/app-feature-registry.md. */
export const featureDatasetParams = (features: readonly AppFeature[]): DatasetParamsRegistry =>
  features.reduce<DatasetParamsRegistry>(
    (acc, f) => ({ ...acc, ...(f.settings?.datasetParams ?? {}) }),
    {},
  );

/** The Layers-panel OVERLAY controls features contribute, concatenated with
 * App's base list and handed straight to `LayersPanel`. */
export const featureOverlayControls = (
  features: readonly AppFeature[],
  deps: OverlayControlDeps,
): OverlayControl[] => features.flatMap((f) => f.overlayControls?.(deps) ?? []);
