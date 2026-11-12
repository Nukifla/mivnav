// VISIBILITY toggle lives in the Layers panel instead (`./index.ts`), like
// satellite's split. An ENUM, not a free number: fixed choices work with a
// gloved thumb and avoid a slider spamming SignalK with a query per drag.

import History from "lucide-solid/icons/history";
import { CHART_DATA } from "../../core/settings/device";
import type { SettingsCtx } from "../../core/settings/ctx";
import {
  defineSetting,
  defineSettingsSection,
  type Setting,
  type SettingsSection,
} from "../../core/settings/registry";
import { DEFAULT_SETTINGS, type ChartSettings } from "../../core/style/settings";
import { TRACK_ALL } from "./client";

const TRACK_SECTION = "track";

/** The offered windows, in hours. Kept as strings because the settings
 * registry's `enum` control is a string domain; the bridge is one `Number()`
 * in `write`, where the field is a number because that is what the API takes. */
/** `"0"` is `TRACK_ALL`: everything the history plugin holds. */
const HOURS = ["1", "3", "6", "12", "24", "72", "168", "336", "504", "672", String(TRACK_ALL)] as const;
const HOURS_LABELS: Record<string, string> = {
  "1": "1 hour",
  "3": "3 hours",
  "6": "6 hours",
  "12": "12 hours",
  "24": "24 hours",
  "72": "3 days",
  "168": "1 week",
  "336": "2 weeks",
  "504": "3 weeks",
  "672": "4 weeks",
  [String(TRACK_ALL)]: "Forever",
};

/** Declared by the feature so a build without it shows the "Data on this
 * chart" pane without an empty heading. */
export const trackSection: SettingsSection<SettingsCtx> = defineSettingsSection<SettingsCtx>({
  id: TRACK_SECTION,
  title: "Ship track",
  icon: History,
  group: "device",
  category: CHART_DATA,
  // After the satellite source picker (65) in the same pane.
  order: 70,
});

export const trackSettings: readonly Setting<SettingsCtx>[] = [
  defineSetting<SettingsCtx>({
    id: "trackHours",
    scope: "device",
    control: { kind: "enum", options: HOURS, as: "select", labels: HOURS_LABELS },
    label: "Show the last",
    help: "Read from the SignalK history plugin — this boat keeps the track, not this app.",
    group: TRACK_SECTION,
    order: 10,
    default: String(DEFAULT_SETTINGS.trackHours),
    coerce: (raw) =>
      typeof raw === "string" && (HOURS as readonly string[]).includes(raw)
        ? raw
        : String(DEFAULT_SETTINGS.trackHours),
    read: (c) => String(c.settings.trackHours),
    write: (c, v) => c.onSettings({ trackHours: Number(v) } as Partial<ChartSettings>),
    // Always enabled, even while the track is off (Layers panel): picking
    // a window fetches nothing until the track is shown, so there is no cost
    // to guard — and a greyed select read as "broken", not "turn it on".
  }),
];
