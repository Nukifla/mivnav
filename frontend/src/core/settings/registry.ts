// The SETTINGS registry: one descriptor for every setting the app exposes,
// plus the generic wiring that turns those descriptors into a rendered
// surface. THREE LEVELS, smallest first: a Setting is one control; a
// SettingsSection is a block of them (or one bespoke component); a
// SettingsCategory is one entry in the settings surface's navigation whose
// pane holds one or more sections. Modelled on `chrome/widget.ts`'s
// `defineWidget`: a `define*` validates+freezes at import time, a
// `create*Registry` indexes+dedups, `SettingsView.tsx` walks it. See
// docs/architecture/settings-registry.md.

import type { LucideIcon } from "lucide-solid";
import type { Component, JSX } from "solid-js";

/** Where a setting's value lives, and how the registry routes it:
 *  - `device` → localStorage (`persist.ts`), read/write closing over the live
 *    `ChartSettings` signals (`settings/device.tsx`).
 *  - `server` → the always-on server; `write` issues a merge-`PATCH /config`
 *    through `ServerConfigController` and the panel refills from the
 *    response (`settings/boat.tsx`).
 *  - `profile` → not its own settings, a SNAPSHOT of the device-scoped ones:
 *    loading one copies each coerced `scope:"device"` value into the device
 *    signals (a copy, not a live binding). See `deviceScopedSettings`. */
export type SettingScope = "device" | "server" | "profile";

/** The value domain of a generated control. A control that needs a richer value
 * (an object, a tuple) is a `custom` control and manages its own shape. */
export type SettingValue = boolean | number | string;

/** A plain on/off switch → `Controls.tsx` `Toggle`. */
export interface ToggleControl {
  kind: "toggle";
}

/** A one-of-N choice. `segmented` reproduces the day/dusk/night rail (the
 * mariner-in-the-dark control); `select` is a compact dropdown. */
export interface EnumControl {
  kind: "enum";
  options: readonly string[];
  as?: "segmented" | "select";
  /** Optional display label per option; defaults to the option string (the
   * segmented rail additionally capitalizes it, matching the palette control). */
  labels?: Readonly<Record<string, string>>;
}

/** A number on a track → `Controls.tsx` `Slider`. */
export interface NumberControl {
  kind: "number";
  min: number;
  max: number;
  step: number;
  /** How the value reads on the track (`(v) => `${v} m``). Defaults to `String`. */
  format?: (value: number) => string;
  /** The on-chart colour this value governs — the swatch beside the label. */
  swatch?: string;
  /** How the number is entered. `slider` (the default) is the depth/predictor
   * dial; `field` COMMITS ON BLUR — each commit is a network write, and a
   * slider dragged across the boat config would fire a PATCH per frame. A
   * `field` write is accepted only when finite and within `[min, max]`. */
  as?: "slider" | "field";
}

/** A free-text field. `live` writes on every keystroke; otherwise on blur/enter. */
export interface TextControl {
  kind: "text";
  placeholder?: string;
  live?: boolean;
}

/** ESCAPE HATCH: a single setting renders itself. The component is mounted in the
 * setting's place, in order, and handed the live `ctx` + its computed `disabled`. */
export interface CustomControl<C> {
  kind: "custom";
  component: Component<CustomControlProps<C>>;
}

export type Control<C = unknown> =
  | ToggleControl
  | EnumControl
  | NumberControl
  | TextControl
  | CustomControl<C>;

/** Props a `custom` control's component receives — its own descriptor, the live
 * shared `ctx` (read/write through it), and whether a cascade has disabled it. */
export interface CustomControlProps<C> {
  setting: Setting<C>;
  ctx: C;
  disabled: boolean;
}

/** A master/sub cascade — the sub is enabled only when EVERY listed master
 * satisfies `enabledWhen`. One master reproduces Text→AtonText; an array
 * reproduces Lights+Text→LightDescriptions (both masters must be on). */
export interface DependsOn {
  setting: string | readonly string[];
  /** Predicate on a master's current value; defaults to truthiness. */
  enabledWhen?: (value: SettingValue) => boolean;
}

/**
 * One setting. `C` is the shared context type a feature's read/write close over
 * (the DEVICE context bundles `ChartSettings` + the debug-layers signal — see
 * `settings/device.tsx`), kept generic so this module stays feature-agnostic.
 */
export interface Setting<C = unknown> {
  id: string;
  scope: SettingScope;
  control: Control<C>;
  label: string;
  /** One line under the label the label itself cannot carry. Rendered as the
   * toggle's hint today; opt-in, so most controls stay captionless. */
  help?: string;
  /** The `SettingsSection.id` this setting renders under. */
  group: string;
  /** Sort order within its section. */
  order: number;
  /** Flagged for a future quick-settings surface (feeds C4). Metadata only here. */
  quick?: boolean;
  /**
   * The value's default — the value a fresh device shows. Required for a
   * generated control; a display-only `custom` control may omit it.
   */
  default?: SettingValue;
  /** TOTAL storage→value coercer (reuse `persist.ts`'s primitives);
   * `defineSetting` checks `default` is a fixpoint of it. MUST NOT throw — the
   * last line of defence against a stored blob written by an older client. */
  coerce?: (raw: unknown) => SettingValue;
  /** Read the live value from `ctx`. Required for a generated control. */
  read?: (ctx: C) => SettingValue;
  /** Write a new value through `ctx`. Required for a generated control. */
  write?: (ctx: C, value: SettingValue) => void;
  dependsOn?: DependsOn;
  /** Optional extra check of a candidate value; returns an error string or nothing. */
  validate?: (value: SettingValue) => string | undefined;
  /** A live, ctx-derived disable that is NOT a setting-to-setting cascade —
   * ANDed into `isSettingEnabled` on top of any `dependsOn`. Used to grey a
   * boat control while a write is in flight, without the `dependsOn` indent
   * (a boat gate isn't a sub-toggle under a master in the same section). */
  disabledWhen?: (ctx: C) => boolean;
  /** Documentation of a WRITE's blast radius (a SignalK re-dial, a cache
   * drop) for settings whose write isn't a local paint change. Metadata only
   * — empty on a plain device/profile setting. */
  writeSideEffect?: string;
}

/**
 * One CATEGORY — one entry in the settings surface's navigation, one content
 * pane. Exists because a pane often wants MORE THAN ONE section: a
 * contributor joins an existing pane by naming its `category`, no shell edit
 * needed. A section naming none gets one SYNTHESIZED from itself — see
 * docs/architecture/settings-registry.md.
 */
export interface SettingsCategory {
  id: string;
  /** The rail/list label, and the pane's heading. */
  title: string;
  /** The rail/list icon. Required of a hand-declared category; a SYNTHESIZED one
   * inherits its section's `icon`, which a render-only section does not have —
   * so the renderer carries a documented default for that case. */
  icon?: LucideIcon;
  /** Which top-level tab this rides — "This device" or "Server settings". */
  group: "device" | "server";
  order: number;
  /** One line under the pane heading: what this pane is for. */
  blurb?: string;
}

/**
 * One section — a block of controls inside a category's pane. A generated section
 * supplies `icon` and a `title`, optional `intro` prose, and hosts the settings
 * whose `group` is its `id`. A render-only section supplies `render` and hosts
 * nothing generated: it is emitted verbatim (its component brings its own
 * `AccordionSection`, which the pane renders flat — see `ui/Accordion.tsx`).
 */
export interface SettingsSection<C = unknown> {
  id: string;
  title: string;
  /** The section header's icon — required unless the section is render-only. */
  icon?: LucideIcon;
  /** Which top-level tab this rides — device or server. Must match its category's. */
  group: "device" | "server";
  /** The `SettingsCategory.id` whose pane this section renders in. Omitted = the
   * section IS its own category (one synthesized from it). */
  category?: string;
  /** Curated prose at the top of the section body. */
  intro?: JSX.Element;
  order: number;
  /**
   * WHOLE-SECTION escape hatch: render bespoke, verbatim. When set, generation
   * is skipped and no `Setting` may target this section. The component receives
   * the live `ctx` so a bespoke section reads/writes the same signals.
   */
  render?: Component<{ ctx: C }>;
  /** Live, ctx-derived: true leaves the section out of its pane entirely
   * (e.g. a section that only applies to one choice of another setting). */
  hidden?: (ctx: C) => boolean;
}

/**
 * Validate a setting descriptor and freeze it — the `defineWidget` twin. Throws
 * at import time rather than trusting review: a generated control must have a
 * total coercer, a read/write binding, and a default that survives its own
 * coercion (a mismatched default/coerce is a silent bug — the default would
 * be rewritten the first time the value round-trips).
 */
export function defineSetting<C = unknown>(s: Setting<C>): Setting<C> {
  if (!s.id) throw new Error("setting needs an id");
  if (!s.label) throw new Error(`setting "${s.id}" needs a label`);
  const c = s.control;
  if (c.kind === "number") {
    if (c.min > c.max) throw new Error(`setting "${s.id}": number min ${c.min} > max ${c.max}`);
    if (!(c.step > 0)) throw new Error(`setting "${s.id}": number step must be > 0`);
  }
  if (c.kind === "enum" && c.options.length === 0) {
    throw new Error(`setting "${s.id}": enum needs at least one option`);
  }
  if (c.kind !== "custom") {
    if (typeof s.coerce !== "function") throw new Error(`setting "${s.id}" needs a coerce`);
    if (typeof s.read !== "function" || typeof s.write !== "function") {
      throw new Error(`setting "${s.id}" needs read/write`);
    }
    if (s.default === undefined) throw new Error(`setting "${s.id}" needs a default`);
    const roundTrip = s.coerce(s.default);
    if (!Object.is(roundTrip, s.default)) {
      throw new Error(
        `setting "${s.id}": default ${JSON.stringify(s.default)} is not coerce-stable ` +
          `(coerce returned ${JSON.stringify(roundTrip)})`,
      );
    }
    if (c.kind === "enum" && !c.options.includes(String(s.default))) {
      throw new Error(`setting "${s.id}": default ${JSON.stringify(s.default)} is not an option`);
    }
  }
  return Object.freeze({ ...s });
}

/**
 * Validate a section descriptor and freeze it. A generated section (no `render`)
 * must carry an `icon`; a render-only section need not.
 */
export function defineSettingsSection<C = unknown>(s: SettingsSection<C>): SettingsSection<C> {
  if (!s.id) throw new Error("section needs an id");
  if (!s.title) throw new Error(`section "${s.id}" needs a title`);
  if (!s.render && !s.icon) throw new Error(`generated section "${s.id}" needs an icon`);
  return Object.freeze({ ...s });
}

/**
 * Validate a category descriptor and freeze it. A hand-declared category MUST
 * carry an icon — it is a navigation row, and a rail entry with no icon is a
 * hole in the rail. (A synthesized one may end up iconless; the renderer
 * defaults it.)
 */
export function defineSettingsCategory(c: SettingsCategory): SettingsCategory {
  if (!c.id) throw new Error("category needs an id");
  if (!c.title) throw new Error(`category "${c.id}" needs a title`);
  if (!c.icon) throw new Error(`category "${c.id}" needs an icon`);
  return Object.freeze({ ...c });
}

export interface SettingsRegistry<C = unknown> {
  settings: readonly Setting<C>[];
  sections: readonly SettingsSection<C>[];
  /** Every category — the declared ones plus the ones synthesized from sections
   * that named none. */
  categories: readonly SettingsCategory[];
  byId: (id: string) => Setting<C> | undefined;
  sectionById: (id: string) => SettingsSection<C> | undefined;
  categoryById: (id: string) => SettingsCategory | undefined;
  /** Sections in ascending `order`. */
  orderedSections: readonly SettingsSection<C>[];
  /** Categories in ascending `order`. */
  orderedCategories: readonly SettingsCategory[];
  /** The settings targeting `sectionId`, in ascending `order`. */
  settingsFor: (sectionId: string) => readonly Setting<C>[];
  /** The sections rendering in `categoryId`'s pane, in ascending `order`. */
  sectionsFor: (categoryId: string) => readonly SettingsSection<C>[];
  /** The categories of one top-level tab, in ascending `order` — the rail. */
  categoriesIn: (group: "device" | "server") => readonly SettingsCategory[];
}

/**
 * Index assembled descriptors — the `createWidgetRegistry` twin. Called
 * construction-time. Catches a duplicate setting/section id, a setting
 * pointed at an unknown or render-only section, and a `dependsOn` on a
 * setting that does not exist — all import-time, so a wiring mistake is a
 * throw at boot, not a silent no-op.
 */
export function createSettingsRegistry<C = unknown>(
  settings: readonly Setting<C>[],
  sections: readonly SettingsSection<C>[],
  categories: readonly SettingsCategory[] = [],
): SettingsRegistry<C> {
  const byId = new Map<string, Setting<C>>();
  for (const s of settings) {
    if (byId.has(s.id)) throw new Error(`duplicate setting id: "${s.id}"`);
    byId.set(s.id, s);
  }
  const sectionById = new Map<string, SettingsSection<C>>();
  for (const sec of sections) {
    if (sectionById.has(sec.id)) throw new Error(`duplicate section id: "${sec.id}"`);
    sectionById.set(sec.id, sec);
  }
  for (const s of settings) {
    const sec = sectionById.get(s.group);
    if (!sec) throw new Error(`setting "${s.id}" targets unknown section "${s.group}"`);
    if (sec.render) throw new Error(`setting "${s.id}" targets render-only section "${s.group}"`);
  }
  for (const s of settings) {
    if (!s.dependsOn) continue;
    const ids = normalizeDeps(s.dependsOn.setting);
    for (const id of ids) {
      if (!byId.has(id)) throw new Error(`setting "${s.id}" dependsOn unknown setting "${id}"`);
    }
  }
  const orderedSections = [...sections].sort((a, b) => a.order - b.order);

  // Category resolution is the ONE place this function is deliberately
  // tolerant rather than throwing (a partial two-arg registry, or a plugin
  // whose pane owner is absent, must still render). A category that IS
  // found still must agree on `group`, which does throw. See
  // docs/architecture/settings-registry.md.
  const categoryById = new Map<string, SettingsCategory>();
  for (const c of categories) {
    if (categoryById.has(c.id)) throw new Error(`duplicate category id: "${c.id}"`);
    categoryById.set(c.id, c);
  }
  const categoryOf = new Map<string, string>();
  const all: SettingsCategory[] = [...categories];
  for (const sec of orderedSections) {
    const named = sec.category ? categoryById.get(sec.category) : undefined;
    if (named) {
      if (named.group !== sec.group) {
        throw new Error(
          `section "${sec.id}" (${sec.group}) targets category "${named.id}" (${named.group})`,
        );
      }
      categoryOf.set(sec.id, named.id);
      continue;
    }
    if (categoryById.has(sec.id)) {
      // A declared category already owns this id — the section is that
      // category's own body (the id-sharing idiom a one-section category uses).
      categoryOf.set(sec.id, sec.id);
      continue;
    }
    const synthesized: SettingsCategory = Object.freeze({
      id: sec.id,
      title: sec.title,
      icon: sec.icon,
      group: sec.group,
      order: sec.order,
    });
    categoryById.set(sec.id, synthesized);
    categoryOf.set(sec.id, sec.id);
    all.push(synthesized);
  }
  const orderedCategories = [...all].sort((a, b) => a.order - b.order);

  return {
    settings,
    sections,
    categories: all,
    byId: (id) => byId.get(id),
    sectionById: (id) => sectionById.get(id),
    categoryById: (id) => categoryById.get(id),
    orderedSections,
    orderedCategories,
    settingsFor: (sectionId) =>
      settings.filter((s) => s.group === sectionId).sort((a, b) => a.order - b.order),
    sectionsFor: (categoryId) => orderedSections.filter((s) => categoryOf.get(s.id) === categoryId),
    categoriesIn: (group) => orderedCategories.filter((c) => c.group === group),
  };
}

function normalizeDeps(setting: string | readonly string[]): readonly string[] {
  return Array.isArray(setting) ? setting : [setting as string];
}

/**
 * The profile-scope adapter: the DEVICE-scoped settings a profile is a
 * snapshot of (`profiles.ts`, `settingsFromProfile`) — loading one copies
 * each into the device signals, so a new device setting rides into profiles
 * for free.
 */
export function deviceScopedSettings<C>(reg: SettingsRegistry<C>): readonly Setting<C>[] {
  return reg.settings.filter((s) => s.scope === "device");
}

/**
 * Whether a setting's cascade leaves it ENABLED, given the live `ctx`. Reads each
 * master through its own `read(ctx)`, so the answer tracks the master signals
 * reactively when called inside a reactive scope (the renderer's `disabled`
 * binding). A missing master or one without a `read` is treated as satisfied —
 * a cascade never wedges a control off because of a typo.
 */
export function isSettingEnabled<C>(
  reg: SettingsRegistry<C>,
  setting: Setting<C>,
  ctx: C,
): boolean {
  // A live ctx-derived disable (boat busy / a server master off) wins first,
  // ANDed with the setting-to-setting cascade below.
  if (setting.disabledWhen?.(ctx)) return false;
  const dep = setting.dependsOn;
  if (!dep) return true;
  const test = dep.enabledWhen ?? ((v: SettingValue) => Boolean(v));
  return normalizeDeps(dep.setting).every((id) => {
    const master = reg.byId(id);
    if (!master?.read) return true;
    return test(master.read(ctx));
  });
}
