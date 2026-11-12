// The per-family filters of the Notices to Mariners overlay. The overlay's
// own on/off is its Layers-panel row (`./index.ts`), like the track's; these
// are the sub-toggles of efs.md §2.6. One section, not sub-rows in the
// Layers panel: every Layers row is a draggable stack member, and six rows
// that all move the same layer would be six grips for one thing.

import TriangleAlert from "lucide-solid/icons/triangle-alert";
import { coerceBoolean } from "../../core/persist";
import { CHART_DATA } from "../../core/settings/device";
import type { SettingsCtx } from "../../core/settings/ctx";
import {
  defineSetting,
  defineSettingsSection,
  type Setting,
  type SettingsSection,
} from "../../core/settings/registry";
import { DEFAULT_SETTINGS, type ChartSettings } from "../../core/style/settings";

export const NOTICES_SECTION = "notices";

export const noticesSection: SettingsSection<SettingsCtx> = defineSettingsSection<SettingsCtx>({
  id: NOTICES_SECTION,
  title: "Notices to Mariners",
  icon: TriangleAlert,
  group: "device",
  category: CHART_DATA,
  // After the ship track (70) in the same pane.
  order: 75,
});

type NoticesToggle =
  | "noticesWarnings"
  | "noticesTemporary"
  | "noticesPreliminary"
  | "noticesPermanent"
  | "noticesFiring"
  | "noticesShowEnded";

function toggle(field: NoticesToggle, order: number, label: string, help?: string): Setting<SettingsCtx> {
  return defineSetting<SettingsCtx>({
    id: field,
    scope: "device",
    control: { kind: "toggle" },
    label,
    help,
    group: NOTICES_SECTION,
    order,
    default: DEFAULT_SETTINGS[field],
    coerce: (raw) => coerceBoolean(raw, DEFAULT_SETTINGS[field]),
    read: (c) => c.settings[field],
    write: (c, v) => c.onSettings({ [field]: v } as Partial<ChartSettings>),
    // Always enabled, even with the overlay off (Layers panel): choosing what
    // to show costs nothing until it is shown — the trackHours rationale.
  });
}

export const noticesSettings: readonly Setting<SettingsCtx>[] = [
  toggle("noticesWarnings", 10, "Navigational warnings (NW)", "Coastal and local warnings — short-lived, also read on VHF/NAVTEX."),
  toggle("noticesTemporary", 20, "Temporary notices (T)", "Works, surveys, missing buoys, reduced depths."),
  toggle("noticesPreliminary", 30, "Preliminary notices (P)", "Announced future changes, drawn dashed."),
  toggle("noticesPermanent", 40, "Permanent notices (chart corrections)", "Where your chart differs from the latest correction."),
  toggle(
    "noticesFiring",
    50,
    "Firing exercises and firing areas",
    "Firing areas are always outlined; red hatched on a day they are in use.",
  ),
  toggle("noticesShowEnded", 60, "Show ended notices", "Event over but not yet cancelled — drawn faint."),
];
