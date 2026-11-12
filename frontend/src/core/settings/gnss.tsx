// The GNSS-lost and connection alarms' settings page — boat-wide
// (mivnav.gnss.config.GnssConfig), the collision page's shape
// (`collision.tsx`): the server raises GNSS-lost on SignalK, and every
// screen raises all three alarms by these settings, which reach it in the
// SignalK snapshot (`gnssSettings`). See core/linkAlarms.ts.

import LocateOff from "lucide-solid/icons/locate-off";
import { Show, type Component } from "solid-js";
import type { AlarmMode } from "../gnssSettings";
import { coerceBoolean, coerceFiniteNumber } from "../persist";
import type { ConfigPatch, GnssServerConfig, ServerConfig } from "../serverConfig";
import { DEFAULT_GNSS_SETTINGS } from "../gnssSettings";
import type { SettingsCtx } from "./ctx";
import {
  defineSetting,
  defineSettingsSection,
  type Control,
  type CustomControlProps,
  type Setting,
  type SettingValue,
  type SettingsSection,
} from "./registry";

/** The feedback scope every write on this page is addressed under. */
const GNSS_SCOPE = "gnss";

const SIDE_EFFECT =
  "Boat-wide: the server's GNSS watch and every screen's connection alarms use this at once.";

function gnssSetting<K extends keyof GnssServerConfig>(opts: {
  key: K;
  control: Control<SettingsCtx>;
  label: string;
  help: string;
  order: number;
  coerce: (raw: unknown) => SettingValue;
}): Setting<SettingsCtx> {
  const fallback = DEFAULT_GNSS_SETTINGS[opts.key];
  return defineSetting<SettingsCtx>({
    id: `gnss.${opts.key}`,
    scope: "server",
    control: opts.control,
    label: opts.label,
    help: opts.help,
    group: "gnss",
    order: opts.order,
    default: fallback,
    coerce: opts.coerce,
    disabledWhen: (ctx) => ctx.cfg.busy(),
    writeSideEffect: SIDE_EFFECT,
    read: (ctx) => {
      const config: ServerConfig | null = ctx.cfg.config();
      return config?.gnss?.[opts.key] ?? fallback;
    },
    write: (ctx, value) => {
      const patch: ConfigPatch = { gnss: { [opts.key]: value } };
      return ctx.cfg.patch(patch, { scope: GNSS_SCOPE, done: "Saved." });
    },
  });
}

const GnssFeedback: Component<CustomControlProps<SettingsCtx>> = (props) => {
  const cfg = () => props.ctx.cfg;
  return (
    <Show when={cfg().scope() === GNSS_SCOPE}>
      <Show when={cfg().error()}>
        <p class="text-xs text-alarm">{cfg().error()}</p>
      </Show>
      <Show when={cfg().status()}>
        <p class="text-xs text-ok">{cfg().status()}</p>
      </Show>
    </Show>
  );
};

const MODES: readonly AlarmMode[] = ["off", "show", "tell"];
const coerceMode = (raw: unknown): AlarmMode => (MODES.includes(raw as AlarmMode) ? (raw as AlarmMode) : "tell");

/** Defaults mirror `GnssConfig` (and `DEFAULT_GNSS_SETTINGS`). */
export const GNSS_SETTINGS: readonly Setting<SettingsCtx>[] = [
  gnssSetting({
    key: "mode",
    control: {
      kind: "enum",
      options: MODES,
      as: "segmented",
      labels: { off: "Off", show: "Show", tell: "Tell" },
    },
    label: "GNSS & connection alarm",
    help: "Off raises nothing. Show puts a LOST tile on the rail, silently. Tell raises the alarm strip and sounds it. Covers a lost GPS position, the server losing SignalK, and a screen losing the server.",
    order: 5,
    coerce: coerceMode,
  }),
  gnssSetting({
    key: "delay_s",
    control: { kind: "number", min: 1, max: 120, step: 1, as: "field" },
    label: "Alarm after (s) of continuous loss",
    help: "A brief dropout shorter than this never alarms. A GPS reports every second.",
    order: 10,
    coerce: (raw) => coerceFiniteNumber(raw, DEFAULT_GNSS_SETTINGS.delay_s),
  }),
  gnssSetting({
    key: "sound",
    control: { kind: "toggle" },
    label: "Sound & vibrate on screens",
    help: "In Tell, every mivnav screen sounds and vibrates until someone acknowledges. Off: screens only show it; the SignalK notification still sounds on the MFD and other displays.",
    order: 20,
    coerce: (raw) => coerceBoolean(raw, true),
  }),
  gnssSetting({
    key: "connection",
    control: { kind: "toggle" },
    label: "Alarm on lost connections",
    help: "Also alarm when this screen loses the mivnav server, or the server loses SignalK. Screens only: neither can be raised on SignalK — with the server gone, nothing reaches it.",
    order: 30,
    coerce: (raw) => coerceBoolean(raw, true),
  }),
  gnssSetting({
    key: "publish",
    control: { kind: "toggle" },
    label: "Raise GNSS-lost on SignalK",
    help: "Raise a lost GPS position as a SignalK notification (notifications.navigation.gnss.fixLost), so the MFD, KIP and other displays alarm too, with every screen closed. Needs SignalK admin access (see SignalK).",
    order: 40,
    coerce: (raw) => coerceBoolean(raw, true),
  }),
  defineSetting<SettingsCtx>({
    id: "gnss.feedback",
    scope: "server",
    control: { kind: "custom", component: GnssFeedback },
    label: "GNSS alarm feedback",
    group: "gnss",
    order: 50,
  }),
];

export const GNSS_SECTION: SettingsSection<SettingsCtx> = defineSettingsSection<SettingsCtx>({
  id: "gnss",
  title: "GNSS & connection alarm",
  icon: LocateOff,
  group: "server",
  category: "alarms",
  order: 30,
});
