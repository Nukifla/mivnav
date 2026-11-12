// This device's chrome config: which widgets, in which band, in what order, at
// what density. Per-device, never a network write — the o-charts login and
// SignalK connection are the boat's and live in the server's config.json.
// Stored as `storedSignal("chrome", DEFAULT_CHROME)` -> mivnav.chrome.
//
// Pure. App.tsx owns the signal; this file only says what a config IS and how
// a loaded one adopts the defaults of a build it has never seen.

import { BAND_IDS, isBandId, type BandId } from "./bands";
import { clampDensity, DEFAULT_DENSITY, homeOf, type Density, type Registry } from "./registry";

/** A widget instance's parameters — opaque to the config writers; the widget
 * descriptor's `spec` schema (`chrome/widget.ts`) gives it meaning. */
export type WidgetSpec = Record<string, string | number | undefined>;

/** One stored widget instance: which KIND built it and the params it was built
 * from, keyed by a minted id in `DashboardConfig.widgets` — generalizes the
 * old SK-only `skWidgets` store (see `migrateWidgets`) to any widget kind. */
export interface StoredWidget {
  /** The widget KIND (`Widget.id`) that resolves this instance — e.g. `"sk"`. */
  kind: string;
  spec: WidgetSpec;
}

export interface BandConfig {
  /** Instrument ids, in the user's order. Fixed: nothing re-ranks it (invariant #4). */
  order: string[];
}

/**
 * One tab on the board, as a PER-DEVICE layout rather than a code default.
 * `order` is the tab's own widget order, decoupled from the rail band (a tab
 * used to inherit the rail's order — "the board is the rail widened"), seeded
 * once by `adoptDefaults` from the registry page so an unedited device is
 * unchanged. An id this build no longer has is left alone, never pruned.
 */
export interface DashboardTab {
  id: string;
  label: string;
  /** Widget ids on this tab, in the user's order — decoupled from the rail band. */
  order: string[];
}

/**
 * A user-defined SignalK-path widget. PER-DEVICE like the rest of this
 * config: the server subscribing to the path lives in `signalk.extra_paths`
 * (PATCHed on add); this spec is only how THIS device renders the value.
 * `label`/`unit`/`decimals` are OVERRIDES — absent, the generic instrument
 * derives them from the path/SignalK `meta`/a default.
 */
export interface SkWidgetSpec {
  /** The SignalK path this widget reads (`signalk.paths()[path]`). */
  path: string;
  /** Override the derived label. */
  label?: string;
  /** The display unit. When the path's SignalK `meta.units` is a known
   * quantity and this names one of its units (id or alias — see
   * `core/units.ts`), the value is CONVERTED to it; blank picks the
   * quantity's default (kn, °, °C, hPa, %...). Any other text is a plain
   * label on the raw value. */
  unit?: string;
  /** Override the default number of decimals for a numeric reading. */
  decimals?: number;
}

export interface DashboardConfig {
  /** One tab per registry page, in seed order — Pilot included (the autopilot
   * is a normal feature). */
  tabs: DashboardTab[];
  /** User-added, parameterized widget instances, keyed by a MINTED id (see
   * `mintWidgetId`). Replaces the old SK-only `skWidgets` store — see
   * `migrateWidgets` for the migration of existing dashboards. */
  widgets: Record<string, StoredWidget>;
}

/** The chrome-config updater (App.tsx `setChrome`), handed up through
 * `onChrome`. Lives here so Dashboard.tsx and DashboardEditor.tsx can both
 * name it without importing each other. */
export type ChromeUpdater = (updater: (cfg: ChromeConfig) => ChromeConfig) => void;

/** Id prefix for a user SK-widget, DISTINCT from every registry instrument id
 * (dotted names like `nav.sog`) so a minted id can never collide. */
export const SK_WIDGET_PREFIX = "sk:";

/** Whether an id names a user SK-widget (vs a registry instrument). */
export const isSkWidgetId = (id: string): boolean => id.startsWith(SK_WIDGET_PREFIX);

/** The id the next `addWidget` with `prefix` would mint — the first free
 * `${prefix}N`, pure and deterministic like `mintTabId`. */
export function mintWidgetId(cfg: ChromeConfig, prefix: string): string {
  const taken = new Set(Object.keys(cfg.dashboard.widgets));
  for (let n = 1; ; n++) {
    const id = `${prefix}${n}`;
    if (!taken.has(id)) return id;
  }
}

/** The id the next `addSkWidget` would mint — `mintWidgetId` at the SK prefix. */
export function mintSkWidgetId(cfg: ChromeConfig): string {
  return mintWidgetId(cfg, SK_WIDGET_PREFIX);
}

export interface ChromeConfig {
  /** The UI-scale slider, `0..1` (`registry.ts` DESK/HELM). A SETTING, not a
   * breakpoint (invariant #10) — never re-derived from a media query. */
  density: Density;
  /**
   * Does this device point with a finger rather than a mouse? A SEPARATE
   * device fact from `density` (#DENS-SLIDER), seeded once from
   * `matchMedia("(pointer: coarse)")` at FIRST RUN ONLY and never re-read.
   * It used to be the same bit as `density === "helm"`, which meant dragging
   * the scale up would have silently turned off hover for a mouse user —
   * wrong, since "gloves don't hover" is about the pointer, not tile size.
   * Gates `desktopOnly` filtering, the rail hover card, and tap-target radius.
   */
  pointerCoarse: boolean;
  /** Sparse and negative: absent means ON. Only what you turned OFF is recorded. */
  enabled: Record<string, boolean>;
  bands: Record<BandId, BandConfig>;
  /** The board's per-device layout — one tab per registry page, each with its
   * own widget order (see `DashboardTab`), seeded by `adoptDefaults`. */
  dashboard: DashboardConfig;
}

/** Empty band orders, on purpose: `adoptDefaults` fills them from the registry
 * on first boot, so the default order is stated once in the feature rather
 * than duplicated here and left to drift. */
export const DEFAULT_CHROME: ChromeConfig = {
  // DEFAULT_DENSITY is the old HELM size, now the slider's MIDPOINT
  // (#DENS-SLIDER) since the scale extends upwards past it. `pointerCoarse`
  // stays false (a mouse) — only the size default moved.
  density: DEFAULT_DENSITY,
  pointerCoarse: false,
  enabled: {},
  bands: { rail: { order: [] }, top: { order: [] } },
  dashboard: { tabs: [], widgets: {} },
};

/**
 * Seat every widget the config has never seen in its feature's declared home
 * band, at the end, ON. Returns a new config; never mutates.
 *
 * MUST run after load, on every boot: `storedSignal`'s shallow merge
 * (`{...initial, ...parsed}`) leaves arrays — `bands.rail.order` included —
 * AS-IS from storage, so without this a widget added in a later release would
 * silently never appear for an existing user. Placement is only ever ADDED,
 * never reordered (invariant #4); an id from a feature this build lacks is
 * left alone rather than pruned, so it keeps its placement if the feature
 * returns.
 *
 * The board's tabs are seeded the same way, for the same shallow-merge reason:
 * an unseen registry page becomes a tab, rail-resident members first in rail
 * order (matching the old rail-coupled board), then any member with no rail
 * home (a `band.top` follow instrument, a `static` widget) in declaration
 * order — so a page whose cards aren't rail tiles (Route, Pilot) still gets them.
 */
export function adoptDefaults(cfg: ChromeConfig, reg: Registry): ChromeConfig {
  const seated = new Set(BAND_IDS.flatMap((b) => cfg.bands[b].order));
  const next: ChromeConfig = {
    ...cfg,
    enabled: { ...cfg.enabled },
    bands: Object.fromEntries(BAND_IDS.map((b) => [b, { order: [...cfg.bands[b].order] }])) as Record<
      BandId,
      BandConfig
    >,
    dashboard: {
      tabs: cfg.dashboard.tabs.map((t) => ({ ...t, order: [...t.order] })),
      widgets: { ...cfg.dashboard.widgets },
    },
  };
  for (const i of reg.instruments) if (!seated.has(i.id)) next.bands[homeOf(i)].order.push(i.id);

  const knownTabs = new Set(next.dashboard.tabs.map((t) => t.id));
  for (const page of reg.pages) {
    if (knownTabs.has(page.id)) continue;
    const members = new Set(page.instruments ?? []);
    const railOrdered = next.bands.rail.order.filter((id) => members.has(id));
    const rest = (page.instruments ?? []).filter((id) => !railOrdered.includes(id));
    next.dashboard.tabs.push({
      id: page.id,
      label: page.label,
      order: [...railOrdered, ...rest],
    });
  }
  return next;
}

// The config editor's writers below: all pure and total — take a config,
// return a new one, never mutate, no-op rather than throw on an id/band that
// is not there. Logic lives here, tested without a DOM; components are thin
// renderers over it.

/** Turn a widget on or off, SPARSELY: `enabled` records only what you turned
 * OFF (absent means on), so switching back on DELETES the key rather than
 * writing `true` — a widget added later is on for everyone with no migration. */
export function setEnabled(cfg: ChromeConfig, id: string, on: boolean): ChromeConfig {
  const enabled = { ...cfg.enabled };
  if (on) delete enabled[id];
  else enabled[id] = false;
  return { ...cfg, enabled };
}

/** Set the UI-scale slider. A SETTING, not a breakpoint (invariant #10):
 * clamped so a caller cannot push the stored value outside `[DESK, HELM]`. */
export function setDensity(cfg: ChromeConfig, density: Density): ChromeConfig {
  return { ...cfg, density: clampDensity(density) };
}

/** Swap two widgets' positions within a band's order — the editor's up/down.
 * By id, not index: the caller passes the two VISIBLE neighbours, since the
 * raw `order` can interleave widgets this device hides. No-op if either id
 * is not in the band. */
export function swapOrder(cfg: ChromeConfig, band: BandId, a: string, b: string): ChromeConfig {
  const order = [...cfg.bands[band].order];
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i < 0 || j < 0) return cfg;
  [order[i], order[j]] = [order[j], order[i]];
  return { ...cfg, bands: { ...cfg.bands, [band]: { order } } };
}

/** Move a widget to another band, appended at the end, keeping its enablement.
 * Removes it from EVERY band's order first, repairing a config that somehow
 * listed it twice. Does not re-check band legality — `defineFeature`/
 * `bands.configurable` already ensure the caller only offers a valid band. */
export function moveBand(cfg: ChromeConfig, id: string, to: BandId): ChromeConfig {
  const bands = Object.fromEntries(
    BAND_IDS.map((b) => [b, { order: cfg.bands[b].order.filter((x) => x !== id) }]),
  ) as Record<BandId, BandConfig>;
  bands[to].order.push(id);
  return { ...cfg, bands };
}

// The board editor's writers below — same pure/total discipline as the band
// writers, tab-scoped. Every tab is an ordinary config tab, Pilot included;
// AP surface widgets defend themselves with `deletable:false` instead.

/** Swap two widgets' positions within ONE tab's order — the tab-scoped twin
 * of `swapOrder`, by id and VISIBLE neighbour for the same reason. */
export function moveWidgetInTab(cfg: ChromeConfig, tabId: string, a: string, b: string): ChromeConfig {
  const tab = cfg.dashboard.tabs.find((t) => t.id === tabId);
  if (!tab) return cfg;
  const i = tab.order.indexOf(a);
  const j = tab.order.indexOf(b);
  if (i < 0 || j < 0) return cfg;
  const order = [...tab.order];
  [order[i], order[j]] = [order[j], order[i]];
  return {
    ...cfg,
    dashboard: {
      ...cfg.dashboard,
      tabs: cfg.dashboard.tabs.map((t) => (t.id === tabId ? { ...t, order } : t)),
    },
  };
}

/** Move a widget to another tab, appended at the end — the board's twin of
 * `moveBand`: removes it from EVERY tab first, then appends to the target.
 * No-op if the target tab is gone; enablement is untouched. */
export function moveWidgetToTab(cfg: ChromeConfig, id: string, toTabId: string): ChromeConfig {
  if (!cfg.dashboard.tabs.some((t) => t.id === toTabId)) return cfg;
  const tabs = cfg.dashboard.tabs.map((t) => ({
    ...t,
    order: t.id === toTabId ? [...t.order.filter((x) => x !== id), id] : t.order.filter((x) => x !== id),
  }));
  return { ...cfg, dashboard: { ...cfg.dashboard, tabs } };
}

/** Place a widget on a tab and make sure it SHOWS — the add-widget picker's
 * counterpart to `moveWidgetToTab`: this ADDS a card the board doesn't draw
 * yet (deduped, invariant #4) and ENABLES it, but does NOT remove it from
 * other tabs — a widget may honestly live on two (use `moveWidgetToTab` for
 * exclusivity). No-op if the target tab is gone. */
export function addWidgetToTab(cfg: ChromeConfig, tabId: string, widgetId: string): ChromeConfig {
  if (!cfg.dashboard.tabs.some((t) => t.id === tabId)) return cfg;
  const enabled = { ...cfg.enabled };
  delete enabled[widgetId]; // sparse: absent means ON — re-show a hidden instrument
  const tabs = cfg.dashboard.tabs.map((t) =>
    t.id === tabId && !t.order.includes(widgetId) ? { ...t, order: [...t.order, widgetId] } : t,
  );
  return { ...cfg, enabled, dashboard: { ...cfg.dashboard, tabs } };
}

/** The dashboard tab that CONTAINS an instrument — the first tab whose `order`
 * includes it, or `undefined`. The resolver behind "click an instrument tile
 * -> open its dashboard tab" (App's `openInstrumentTab`). */
export function owningTab(cfg: ChromeConfig, id: string): DashboardTab | undefined {
  return cfg.dashboard.tabs.find((t) => t.order.includes(id));
}

/** Add a parameterized widget instance to a tab — the MINTING twin of
 * `addWidgetToTab` (which places an EXISTING registry id): mints a fresh
 * `${prefix}N` id, stores `{kind, spec}`, appends it and enables it. Returns
 * `{cfg, id}`; a no-op-shaped return when the target tab is gone. The kind's
 * `onCommit` side effect (e.g. subscribing a SignalK path) is the caller's job. */
export function addWidget(
  cfg: ChromeConfig,
  tabId: string,
  kind: string,
  prefix: string,
  spec: WidgetSpec,
): { cfg: ChromeConfig; id: string } {
  const id = mintWidgetId(cfg, prefix);
  if (!cfg.dashboard.tabs.some((t) => t.id === tabId)) return { cfg, id };
  const enabled = { ...cfg.enabled };
  delete enabled[id];
  const tabs = cfg.dashboard.tabs.map((t) =>
    t.id === tabId && !t.order.includes(id) ? { ...t, order: [...t.order, id] } : t,
  );
  const widgets = { ...cfg.dashboard.widgets, [id]: { kind, spec } };
  return { cfg: { ...cfg, enabled, dashboard: { tabs, widgets } }, id };
}

/** Replace a stored widget instance's spec in place — the generated edit
 * form's writer. The form always carries every field, so this REPLACES
 * rather than merges. No-op on an id that is not a stored widget. */
export function updateWidget(cfg: ChromeConfig, id: string, spec: WidgetSpec): ChromeConfig {
  const cur = cfg.dashboard.widgets[id];
  if (!cur) return cfg;
  return {
    ...cfg,
    dashboard: {
      ...cfg.dashboard,
      widgets: { ...cfg.dashboard.widgets, [id]: { ...cur, spec } },
    },
  };
}

/**
 * Remove a stored widget instance — drop it and take its id off every tab AND
 * every band order (a parameterized widget can be placed on the rail too, so
 * this avoids leaving an orphan id in `bands.rail.order`). The only way to
 * delete a parameterized widget; a registry instrument is only ever disabled.
 *
 * NB: does NOT touch the server's `signalk.extra_paths` — that subscription
 * is BOAT-WIDE and another device may still show a widget on the same path,
 * which this per-device config cannot see.
 */
export function removeWidget(cfg: ChromeConfig, id: string): ChromeConfig {
  if (!(id in cfg.dashboard.widgets)) return cfg;
  const widgets = { ...cfg.dashboard.widgets };
  delete widgets[id];
  const tabs = cfg.dashboard.tabs.map((t) =>
    t.order.includes(id) ? { ...t, order: t.order.filter((x) => x !== id) } : t,
  );
  const bands = Object.fromEntries(
    BAND_IDS.map((b) => [b, { order: cfg.bands[b].order.filter((x) => x !== id) }]),
  ) as Record<BandId, BandConfig>;
  return { ...cfg, bands, dashboard: { tabs, widgets } };
}

/** Add a user SignalK-path widget to a tab — a thin `addWidget` shim at the
 * SK kind/prefix. */
export function addSkWidget(
  cfg: ChromeConfig,
  tabId: string,
  spec: SkWidgetSpec,
): { cfg: ChromeConfig; id: string } {
  return addWidget(cfg, tabId, "sk", SK_WIDGET_PREFIX, { ...spec });
}

/** Remove a user SignalK-path widget — `removeWidget` (the store is kind-agnostic). */
export function removeSkWidget(cfg: ChromeConfig, id: string): ChromeConfig {
  return removeWidget(cfg, id);
}

/** Take a widget off ONE tab. Unlike `removeSkWidget` (which erases the spec
 * and strips every tab, since an SK widget has nowhere else to live), this
 * only drops the id from the named tab — the instrument still exists in the
 * registry and stays enabled elsewhere. No-op if the tab is gone or lacks the id. */
export function removeWidgetFromTab(cfg: ChromeConfig, tabId: string, id: string): ChromeConfig {
  const tab = cfg.dashboard.tabs.find((t) => t.id === tabId);
  if (!tab || !tab.order.includes(id)) return cfg;
  const tabs = cfg.dashboard.tabs.map((t) =>
    t.id === tabId ? { ...t, order: t.order.filter((x) => x !== id) } : t,
  );
  return { ...cfg, dashboard: { ...cfg.dashboard, tabs } };
}

/**
 * Edit a user SignalK-path widget's spec in place, merging `patch` into the
 * stored spec. Overrides (`label`/`unit`/`decimals`) are CLEARED, not stored
 * empty, when the patch blanks them — absent means "derive it", same as a
 * freshly-added widget (`decimals: 0` is a real value and survives).
 *
 * NB: like `removeSkWidget`, does NOT touch `signalk.extra_paths` — changing
 * `path` subscribes the new one, but the old subscription (boat-wide, maybe
 * still read by another device) is left in place.
 */
export function updateSkWidget(
  cfg: ChromeConfig,
  id: string,
  patch: Partial<SkWidgetSpec>,
): ChromeConfig {
  const stored = cfg.dashboard.widgets[id];
  if (!stored) return cfg;
  const merged: SkWidgetSpec = { ...(stored.spec as unknown as SkWidgetSpec), ...patch };
  for (const k of ["label", "unit", "decimals"] as const) {
    if (merged[k] === undefined || merged[k] === "") delete merged[k];
  }
  return updateWidget(cfg, id, { ...merged });
}

/** The id the next `addTab` would mint — the first free `tab-N`; the prefix
 * cannot collide with a registry page id (`nav`, `wind`, ...). */
export function mintTabId(cfg: ChromeConfig): string {
  const taken = new Set(cfg.dashboard.tabs.map((t) => t.id));
  for (let n = 1; ; n++) {
    const id = `tab-${n}`;
    if (!taken.has(id)) return id;
  }
}

/** Add an empty tab at the end with a minted id and default label ("Tab N").
 * Labels need not be unique — only ids must. */
export function addTab(cfg: ChromeConfig, label?: string): ChromeConfig {
  const id = mintTabId(cfg);
  const tab: DashboardTab = { id, label: label ?? `Tab ${cfg.dashboard.tabs.length + 1}`, order: [] };
  return { ...cfg, dashboard: { ...cfg.dashboard, tabs: [...cfg.dashboard.tabs, tab] } };
}

/** Rename a tab. A no-op if the tab is gone; the empty-label guard is the UI's. */
export function renameTab(cfg: ChromeConfig, tabId: string, label: string): ChromeConfig {
  if (!cfg.dashboard.tabs.some((t) => t.id === tabId)) return cfg;
  return {
    ...cfg,
    dashboard: {
      ...cfg.dashboard,
      tabs: cfg.dashboard.tabs.map((t) => (t.id === tabId ? { ...t, label } : t)),
    },
  };
}

/** Remove a tab. Widgets are NOT deleted from the registry, they just leave
 * the layout — `adoptDefaults` won't re-seat a page it has already seen, so a
 * removed tab stays removed. The LAST tab cannot be removed. */
export function removeTab(cfg: ChromeConfig, tabId: string): ChromeConfig {
  if (cfg.dashboard.tabs.length <= 1) return cfg;
  if (!cfg.dashboard.tabs.some((t) => t.id === tabId)) return cfg;
  return {
    ...cfg,
    dashboard: { ...cfg.dashboard, tabs: cfg.dashboard.tabs.filter((t) => t.id !== tabId) },
  };
}

/** Reorder tabs — swap with the neighbour toward `dir` (-1 front, 1 back).
 * No-op at the ends or on a tab that is not there. */
export function moveTab(cfg: ChromeConfig, tabId: string, dir: -1 | 1): ChromeConfig {
  const tabs = cfg.dashboard.tabs;
  const i = tabs.findIndex((t) => t.id === tabId);
  if (i < 0) return cfg;
  const j = i + dir;
  if (j < 0 || j >= tabs.length) return cfg;
  const next = [...tabs];
  [next[i], next[j]] = [next[j], next[i]];
  return { ...cfg, dashboard: { ...cfg.dashboard, tabs: next } };
}

// ── Generic widget TARGETS ───────────────────────────────────────────────────
//
// A "target" is any named place a widget can be placed and ordered: a BAND
// (rail/top) or a dashboard TAB, addressed by one uniform id so the board's
// drag/drop editor never special-cases either kind. Each writer below
// DISPATCHES to the underlying band/tab writer, so the on-disk storage model
// (`bands[band].order` vs `dashboard.tabs[].order`) is unchanged — only the
// editor's vocabulary is unified.

/** The target id of the rail band. */
export const RAIL_TARGET = "rail";
/** The target id of the top (route) band. */
export const TOP_TARGET = "top";

/** Whether a target id names a BAND (rail or top) rather than a dashboard tab. */
export const isBandTarget = (target: string): boolean => isBandId(target);

/** Whether a target id names the rail band specifically. */
export const isRailTarget = (target: string): boolean => target === RAIL_TARGET;

/** The widget ids a target holds, in the user's order — `bands[band].order` for
 * a band target, else the tab's `order` (empty when the tab is gone). */
export function targetOrder(cfg: ChromeConfig, target: string): readonly string[] {
  return isBandTarget(target)
    ? cfg.bands[target as BandId].order
    : cfg.dashboard.tabs.find((t) => t.id === target)?.order ?? [];
}

/** Whether a target exists in this config — a band always does; a tab must be
 * listed. */
export function hasTarget(cfg: ChromeConfig, target: string): boolean {
  return isBandTarget(target) || cfg.dashboard.tabs.some((t) => t.id === target);
}

const withBandOrder = (cfg: ChromeConfig, band: BandId, order: string[]): ChromeConfig => ({
  ...cfg,
  bands: { ...cfg.bands, [band]: { order } },
});

/** Reorder within a target — dispatches to `swapOrder` (band) or
 * `moveWidgetInTab` (tab); both swap by VISIBLE neighbour. */
export function moveWidgetInTarget(cfg: ChromeConfig, target: string, a: string, b: string): ChromeConfig {
  return isBandTarget(target) ? swapOrder(cfg, target as BandId, a, b) : moveWidgetInTab(cfg, target, a, b);
}

/** Take a widget off ONE target, leaving it on any other. No-op when the
 * target does not hold it. */
export function removeWidgetFromTarget(cfg: ChromeConfig, target: string, id: string): ChromeConfig {
  if (!isBandTarget(target)) return removeWidgetFromTab(cfg, target, id);
  const band = target as BandId;
  if (!cfg.bands[band].order.includes(id)) return cfg;
  return withBandOrder(cfg, band, cfg.bands[band].order.filter((x) => x !== id));
}

/** Place an EXISTING widget id on a target and make sure it SHOWS — appends
 * (deduped) and enables it, dispatching to `addWidgetToTab` for a tab. */
export function addWidgetToTarget(cfg: ChromeConfig, target: string, id: string): ChromeConfig {
  if (!isBandTarget(target)) return addWidgetToTab(cfg, target, id);
  const band = target as BandId;
  const enabled = { ...cfg.enabled };
  delete enabled[id]; // sparse: absent means ON — re-show a hidden instrument
  const order = cfg.bands[band].order.includes(id) ? cfg.bands[band].order : [...cfg.bands[band].order, id];
  return withBandOrder({ ...cfg, enabled }, band, order);
}

/** Move a widget from one target to another, appended — ORIGIN-AWARE (removes
 * from origin, de-dupes on destination, then appends), so a tab-to-tab move
 * never disturbs a band. No-op when the destination tab is gone. */
export function moveWidgetToTarget(
  cfg: ChromeConfig,
  id: string,
  fromTarget: string,
  toTarget: string,
): ChromeConfig {
  if (!hasTarget(cfg, toTarget)) return cfg;
  const removed = removeWidgetFromTarget(removeWidgetFromTarget(cfg, fromTarget, id), toTarget, id);
  if (isBandTarget(toTarget)) {
    const band = toTarget as BandId;
    return withBandOrder(removed, band, [...removed.bands[band].order, id]);
  }
  return {
    ...removed,
    dashboard: {
      ...removed.dashboard,
      tabs: removed.dashboard.tabs.map((t) => (t.id === toTarget ? { ...t, order: [...t.order, id] } : t)),
    },
  };
}

/** MINT a parameterized widget instance onto a target, generalising `addWidget`
 * over bands. Returns `{cfg, id}`; no-op-shaped when a tab destination is gone. */
export function mintWidgetToTarget(
  cfg: ChromeConfig,
  target: string,
  kind: string,
  prefix: string,
  spec: WidgetSpec,
): { cfg: ChromeConfig; id: string } {
  if (!isBandTarget(target)) return addWidget(cfg, target, kind, prefix, spec);
  const band = target as BandId;
  const id = mintWidgetId(cfg, prefix);
  const enabled = { ...cfg.enabled };
  delete enabled[id];
  const widgets = { ...cfg.dashboard.widgets, [id]: { kind, spec } };
  const banded = withBandOrder({ ...cfg, enabled }, band, [...cfg.bands[band].order, id]);
  return { cfg: { ...banded, dashboard: { ...banded.dashboard, widgets } }, id };
}

/**
 * Repair a config that came back from storage structurally wrong — a
 * hand-edited localStorage, or a `bands` key missing a band this build has.
 *
 * `density` carries the #DENS-SLIDER MIGRATION: a stored NUMBER is clamped
 * and kept; anything else — including the legacy `"desk"`/`"helm"` strings —
 * becomes `DEFAULT_DENSITY`, not `DESK`. Deliberate, not "unknown -> safe
 * fallback": a stored `"desk"` was never a considered preference, only
 * `boot.ts`'s first-run guess from the pointer, indistinguishable in the
 * stored JSON from a human's pick — so every pre-slider device lands on the
 * new bigger default (the ask: "Helm size becomes the default on desktop
 * too"), and a genuinely-`"helm"` device is pixel-identical to before.
 */
export function normalize(cfg: ChromeConfig): ChromeConfig {
  return {
    density: typeof cfg.density === "number" ? clampDensity(cfg.density) : DEFAULT_DENSITY,
    pointerCoarse: typeof cfg.pointerCoarse === "boolean" ? cfg.pointerCoarse : false,
    enabled: typeof cfg.enabled === "object" && cfg.enabled ? { ...cfg.enabled } : {},
    bands: Object.fromEntries(
      BAND_IDS.map((b) => [b, { order: [...(cfg.bands?.[b]?.order ?? [])] }]),
    ) as Record<BandId, BandConfig>,
    // A missing/garbled dashboard becomes the empty default (the migration
    // path for a config from before this slice existed); adoptDefaults then
    // seeds a tab per registry page.
    dashboard: {
      tabs: Array.isArray(cfg.dashboard?.tabs)
        ? cfg.dashboard.tabs.map((t) => ({ id: t.id, label: t.label, order: [...(t.order ?? [])] }))
        : [],
      widgets: migrateWidgets(cfg.dashboard),
    },
  };
}

/**
 * The widget store's repair + MIGRATION, run on every boot (via `normalize`).
 * Two shapes must survive: the new `widgets: Record<id, {kind, spec}>`, and a
 * legacy `skWidgets: Record<id, SkWidgetSpec>` from before the store was
 * generalized — each legacy entry is lifted onto `{kind: "sk", spec}` so an
 * existing SignalK dashboard is not lost. An entry with no `path` is dropped.
 */
function migrateWidgets(d: unknown): Record<string, StoredWidget> {
  const dash = d as { widgets?: unknown; skWidgets?: unknown } | undefined;
  if (dash?.widgets && typeof dash.widgets === "object") {
    return Object.fromEntries(
      Object.entries(dash.widgets as Record<string, unknown>).filter(
        (e): e is [string, StoredWidget] => {
          const w = e[1] as StoredWidget | undefined;
          return !!w && typeof w.kind === "string" && w.kind !== "" && !!w.spec && typeof w.spec === "object";
        },
      ),
    );
  }
  if (dash?.skWidgets && typeof dash.skWidgets === "object") {
    return Object.fromEntries(
      Object.entries(dash.skWidgets as Record<string, SkWidgetSpec>)
        .filter(([, s]) => s && typeof s.path === "string" && s.path !== "")
        .map(([id, s]) => [id, { kind: "sk", spec: { ...s } } as StoredWidget]),
    );
  }
  return {};
}

// ── Named LAYOUTS — the arrangement half of a ChromeConfig, as an opaque
//    server-stored blob (mivnav.config.profiles' `NamedBlobStore` at the
//    "layout" kind, `/config/layouts` — see `../profiles.ts`'s `createLayouts`)
//    ──────────────────────────────────────────────────────────────────────
//
// A "Layout" is a NAME for `{enabled, bands, dashboard}` — WHICH widgets show
// and WHERE, minus `density`/`pointerCoarse` (device characteristics, not
// something a sailing/motoring/docking profile chooses between). A PROFILE
// may reference a layout by name; the reference is opaque to this file too.

/** The arrangement slice of a `ChromeConfig` — what a Layout saves and
 * restores. `density`/`pointerCoarse` ride the device, never the layout. */
export interface LayoutArrangement {
  enabled: Record<string, boolean>;
  bands: Record<BandId, BandConfig>;
  dashboard: DashboardConfig;
}

/** Capture the current arrangement, to send to `saveLayout`. A snapshot, not
 * a live view. */
export function arrangementFromChrome(cfg: ChromeConfig): LayoutArrangement {
  return { enabled: cfg.enabled, bands: cfg.bands, dashboard: cfg.dashboard };
}

/**
 * Apply a stored (opaque, untrusted) layout blob onto `cfg`, replacing its
 * arrangement WHOLESALE — never a merge. A merge would let a widget this
 * device seated after the layout was saved survive alongside the layout's
 * own tabs, so the same layout would render differently per device; see
 * `settingsFromProfile` for the identical rule on profiles.
 *
 * Reuses `normalize` + `adoptDefaults` (`boot.ts`'s `bootChrome`, inlined here
 * to avoid a cycle — `boot.ts` imports FROM this module) so a layout saved by
 * an older build repairs the same way a stored `ChromeConfig` does on boot.
 */
export function applyArrangement(cfg: ChromeConfig, blob: unknown, reg: Registry): ChromeConfig {
  const raw = (blob && typeof blob === "object" ? blob : {}) as Partial<ChromeConfig>;
  const candidate = adoptDefaults(
    normalize({
      ...cfg,
      enabled: raw.enabled,
      bands: raw.bands,
      dashboard: raw.dashboard,
    } as ChromeConfig),
    reg,
  );
  return { ...cfg, enabled: candidate.enabled, bands: candidate.bands, dashboard: candidate.dashboard };
}
