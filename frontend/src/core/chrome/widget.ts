// The WIDGET registry: one descriptor per KIND of dashboard widget, resolved
// to a rendered `Instrument`. See docs/architecture/widget-registry.md for
// the two SAFETY-CRITICAL invariants `defineWidget`/`withWidgets` enforce below.

import type { JSX } from "solid-js";
import type { ChromeConfig, StoredWidget, WidgetSpec } from "./config";
import type { Accessor } from "solid-js";
import type { PathValue } from "../signalk";
import type { Density, Instrument, Registry, Urgency } from "./registry";

/**
 * One field of a widget's declarative spec schema. The add-confirm AND edit
 * forms are GENERATED from these (`SpecForm` in DashboardEditor.tsx), so a
 * field is stated ONCE instead of duplicated across ~4 sites like skWidget.ts had.
 */
export interface SpecField {
  /** The key under which the value is stored in the widget's `WidgetSpec`. */
  key: string;
  /** `unit`: a display-unit picker (`UnitPicker`) for the SignalK path held
   * in the `pathKey` field; stored as text like `text`. */
  type: "text" | "number" | "unit";
  /** For `type: "unit"`: the key of the field holding the SignalK path. */
  pathKey?: string;
  /** The form field's label. */
  label: string;
  placeholder?: string;
  /** The field's default when adding a fresh instance. Blank if omitted. */
  default?: string | number;
  /** A required field is never cleared to empty by the form. An optional
   * field left blank is OMITTED from the spec, falling back to its derived
   * default. */
  required?: boolean;
}

/** The live inputs a widget's `build` closes over. Bundled once (App.tsx) and
 * handed to every `build`. `paths` is the raw SignalK snapshot the SK widget
 * reads; a future kind that needs more grows this bundle. */
export interface WidgetCtx {
  paths: Accessor<Record<string, PathValue>>;
}

/**
 * A widget KIND. `static`: a single, fixed-id widget with no parameters; `id`
 * IS the instrument id. `parameterized`: MINTED per instance from user input;
 * `idPrefix` namespaces minted ids, `spec` drives the generated forms.
 */
export interface Widget {
  /** The KIND name — also the store's `kind` discriminant; for `static` it
   * doubles as the resolvable instrument id. */
  id: string;
  kind: "static" | "parameterized";
  /** Human name — the picker's section header. */
  label: string;
  /** Minted-id prefix for a `parameterized` widget (`"sk:"`). Required for
   * `parameterized`, forbidden for `static` — `defineWidget` enforces both. */
  idPrefix?: string;
  /** The urgency ceiling this KIND is granted. `defineWidget` FORCES a
   * `parameterized` widget to `"none"` (safety invariant #1, see header). */
  maxUrgency: Urgency;
  /** The declarative field schema. Empty for a no-parameter widget. */
  spec: readonly SpecField[];
  /** Build the `Instrument` for one instance. Closes over `ctx` for the live
   * reads: `build`'s `read` reads `ctx.paths()` at render time, but building
   * itself does not, so a config change rebuilds but a 5 Hz snapshot does not. */
  build: (id: string, spec: WidgetSpec, ctx: WidgetCtx) => Instrument;
  /** Whether `EditCard` offers the generated edit form. Defaults to true for a
   * parameterized widget with a non-empty spec, false otherwise. */
  editable?: boolean;
  /** Whether `EditCard` offers a full delete (drop the instance + all tabs) vs.
   * a remove-from-this-tab. Defaults to true for parameterized, false for
   * static (a static/built-in widget is only ever taken off a tab). */
  deletable?: boolean;
  /** OPTIONAL own-cell renderer, decoupling a widget from the shell `Card`.
   * Unset descriptors ride the shell `Card`; the autopilot's `ap.control`/
   * `ap.rudder` are the first users (features/autopilot). */
  render?: (inst: Instrument, density: Density) => JSX.Element;
  /** OPTIONAL: spans BOTH columns of the 2-col grid (`col-span-2`) — for a
   * `render` that needs full width (the autopilot control set/rudder bar). */
  wide?: boolean;
  /** OPTIONAL side effect after an instance is added/edited (the SK widget
   * subscribes its path here). Fire-and-forget; runs on every commit, so
   * must be idempotent — re-subscribing an already subscribed path is fine. */
  onCommit?: (spec: WidgetSpec) => void;
}

/** Validate a widget descriptor and freeze it. Throws at import time rather
 * than trusting review, and ENFORCES safety invariant #1 by coercing a
 * `parameterized` widget to `maxUrgency: "none"` rather than merely checking. */
export function defineWidget(w: Widget): Widget {
  if (w.kind === "parameterized") {
    if (!w.idPrefix) throw new Error(`parameterized widget "${w.id}" needs an idPrefix`);
  } else if (w.idPrefix) {
    throw new Error(`static widget "${w.id}" must not have an idPrefix`);
  }
  const parameterized = w.kind === "parameterized";
  return Object.freeze({
    ...w,
    // ⚠️ SAFETY: a user/parameterized widget is coerced to "none" here, so no
    // descriptor can grant one an alarm. Do not remove — see the header.
    maxUrgency: parameterized ? "none" : w.maxUrgency,
    editable: w.editable ?? (parameterized && w.spec.length > 0),
    deletable: w.deletable ?? parameterized,
  });
}

export interface WidgetRegistry {
  widgets: readonly Widget[];
  /** A parameterized (or any) widget by its KIND name. */
  byKind: (kind: string) => Widget | undefined;
  /** A static widget resolvable by its exact instrument id. */
  staticById: (id: string) => Widget | undefined;
  /** The parameterized kinds, in registration order — the picker's dynamic sources. */
  parameterized: readonly Widget[];
  /** The static kinds, in registration order — the picker's standalone add rows. */
  statics: readonly Widget[];
}

/** Index an assembled array of descriptors — the `createRegistry` twin.
 * Catches a duplicate KIND the way `createRegistry` catches a duplicate
 * instrument. */
export function createWidgetRegistry(widgets: readonly Widget[]): WidgetRegistry {
  const byKind = new Map<string, Widget>();
  for (const w of widgets) {
    if (byKind.has(w.id)) throw new Error(`duplicate widget kind: "${w.id}"`);
    byKind.set(w.id, w);
  }
  const statics = widgets.filter((w) => w.kind === "static");
  const parameterized = widgets.filter((w) => w.kind === "parameterized");
  const staticIndex = new Map(statics.map((w) => [w.id, w] as const));
  return {
    widgets,
    byKind: (kind) => byKind.get(kind),
    staticById: (id) => staticIndex.get(id),
    parameterized,
    statics,
  };
}

/** The registry the BOARD sees: `base`, with widget-registry widgets ALSO
 * resolving through `byId`. `instruments` does NOT gain these, keeping
 * `alerts(reg)` from ever seeing them (invariant #2). */
export function withWidgets(
  base: Registry,
  reg: WidgetRegistry,
  chrome: Accessor<ChromeConfig>,
  ctx: WidgetCtx,
): Registry {
  return {
    ...base,
    byId: (id) => {
      const found = base.byId(id);
      if (found) return found;
      const stat = reg.staticById(id);
      if (stat) return stat.build(id, {}, ctx);
      const stored: StoredWidget | undefined = chrome().dashboard.widgets[id];
      if (!stored) return undefined;
      const w = reg.byKind(stored.kind);
      if (!w) return undefined;
      const inst = w.build(id, stored.spec, ctx);
      // ⚠️ SAFETY (invariant #1, enforced structurally): a parameterized instance
      // can never be alarm-grade or request urgency, whatever its `build` did.
      return w.kind === "parameterized"
        ? { ...inst, maxUrgency: "none", urgency: undefined, alertText: undefined }
        : inst;
    },
  };
}
