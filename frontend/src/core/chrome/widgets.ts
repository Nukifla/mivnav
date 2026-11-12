// The assembled widget-KIND list. Adding a dashboard widget kind is ONE
// `defineWidget({...})` here + one line in `WIDGETS` — the picker, forms, and
// `withWidgets` all derive from this list. See docs/architecture/widget-registry.md.

import { subscribeExtraPath } from "../serverConfig";
import { listedUnitsFor } from "../signalk";
import type { SkWidgetSpec, WidgetSpec } from "./config";
import { skInstrument } from "./skWidget";
import { defineWidget, type Widget } from "./widget";

/** Read a spec field as a trimmed non-empty string, else undefined. */
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

/** Read a spec field as a finite integer ≥ 0, else undefined (0 survives). */
const nonNegInt = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : undefined;
};

/** A generic `WidgetSpec` as the SK widget's typed view. `path` is required. */
const asSkSpec = (spec: WidgetSpec): SkWidgetSpec => ({
  path: str(spec.path) ?? "",
  label: str(spec.label),
  unit: str(spec.unit),
  decimals: nonNegInt(spec.decimals),
});

/**
 * Any SignalK path as a card — replaces the old bespoke `skWidget.ts` bridge.
 * `onCommit` subscribes the boat to the path. Picker body is custom
 * (DashboardEditor.tsx, keyed by "sk"); others get the generated spec form.
 */
export const SK_WIDGET: Widget = defineWidget({
  id: "sk",
  kind: "parameterized",
  label: "SignalK path",
  idPrefix: "sk:",
  maxUrgency: "none",
  spec: [
    { key: "path", type: "text", label: "PATH", required: true },
    { key: "label", type: "text", label: "LABEL", placeholder: "(from path)" },
    { key: "unit", type: "unit", pathKey: "path", label: "UNIT", placeholder: "(from SignalK)" },
    { key: "decimals", type: "number", label: "DECIMALS", placeholder: "(default)" },
  ],
  build: (id, spec, ctx) => skInstrument(id, asSkSpec(spec), ctx.paths, listedUnitsFor),
  onCommit: (spec) => {
    const path = str(spec.path);
    if (path) void subscribeExtraPath(path).catch(() => {});
  },
});

/** Every widget KIND this build has, in picker/registration order. */
export const WIDGETS: readonly Widget[] = [SK_WIDGET];
