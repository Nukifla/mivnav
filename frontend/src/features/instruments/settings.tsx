// Settings → Alarms — boat-wide (`mivnav.shallow.config.ShallowConfig`),
// the twin of the collision page (`core/settings/collision.tsx`): the alarm
// runs on the server and is raised on SignalK for every display at once.

import Waves from "lucide-solid/icons/waves-arrow-down";
import { Show, type Component } from "solid-js";
import type { ShallowMode, ShallowSettings } from "../../core/shallow";
import { coerceBoolean, coerceFiniteNumber } from "../../core/persist";
import type { ConfigPatch, ServerConfig } from "../../core/serverConfig";
import type { SettingsCtx } from "../../core/settings/ctx";
import {
  defineSetting,
  defineSettingsSection,
  type Control,
  type CustomControlProps,
  type Setting,
  type SettingValue,
  type SettingsSection,
} from "../../core/settings/registry";

const SCOPE = "shallow";

const SIDE_EFFECT =
  "Boat-wide: the server's depth watch uses this on its next snapshot — every screen and the SignalK notification change together.";

function shallowSetting<K extends keyof ShallowSettings>(opts: {
  key: K;
  control: Control<SettingsCtx>;
  label: string;
  help: string;
  order: number;
  default: SettingValue;
  coerce: (raw: unknown) => SettingValue;
  /** Stored → shown, and shown → stored, where they differ (`depth_m`). */
  toUi?: (v: ShallowSettings[K] | undefined) => SettingValue;
  fromUi?: (v: SettingValue) => ShallowSettings[K];
}): Setting<SettingsCtx> {
  return defineSetting<SettingsCtx>({
    id: `shallow.${opts.key}`,
    scope: "server",
    control: opts.control,
    label: opts.label,
    help: opts.help,
    group: "shallow",
    order: opts.order,
    default: opts.default,
    coerce: opts.coerce,
    disabledWhen: (ctx) => ctx.cfg.busy(),
    writeSideEffect: SIDE_EFFECT,
    read: (ctx) => {
      const config: ServerConfig | null = ctx.cfg.config();
      const stored = config?.shallow?.[opts.key];
      return opts.toUi ? opts.toUi(stored) : ((stored as SettingValue | undefined) ?? opts.default);
    },
    write: (ctx, value) => {
      const stored = opts.fromUi ? opts.fromUi(value) : (value as ShallowSettings[K]);
      const patch: ConfigPatch = { shallow: { [opts.key]: stored } };
      return ctx.cfg.patch(patch, { scope: SCOPE, done: "Saved." });
    },
  });
}

const Feedback: Component<CustomControlProps<SettingsCtx>> = (props) => {
  const cfg = () => props.ctx.cfg;
  return (
    <Show when={cfg().scope() === SCOPE}>
      <Show when={cfg().error()}>
        <p class="text-xs text-alarm">{cfg().error()}</p>
      </Show>
      <Show when={cfg().status()}>
        <p class="text-xs text-ok">{cfg().status()}</p>
      </Show>
    </Show>
  );
};

const field = (min: number, max: number, step: number): Control<SettingsCtx> => ({
  kind: "number",
  min,
  max,
  step,
  as: "field",
});

const MODES: readonly ShallowMode[] = ["off", "show", "tell"];
const coerceMode = (raw: unknown): ShallowMode =>
  MODES.includes(raw as ShallowMode) ? (raw as ShallowMode) : "tell";

/** Defaults mirror `ShallowConfig` (and `DEFAULT_SHALLOW_SETTINGS`). */
export const SHALLOW_SETTINGS: readonly Setting<SettingsCtx>[] = [
  shallowSetting({
    key: "mode",
    control: { kind: "enum", options: MODES, as: "segmented", labels: { off: "Off", show: "Show", tell: "Tell" } },
    label: "Shallow-water alarm",
    help: "Off raises nothing. Show shows the alarm on every screen and SignalK, silently. Tell also sounds it.",
    order: 5,
    default: "tell",
    coerce: coerceMode,
  }),
  shallowSetting({
    key: "sound",
    control: { kind: "toggle" },
    label: "Sound & vibrate on screens",
    help: "In Tell, every mivnav screen sounds and vibrates until someone acknowledges. Off: screens only show it; the SignalK notification still sounds on the MFD and other displays.",
    order: 7,
    default: true,
    coerce: (raw) => coerceBoolean(raw, true),
  }),
  shallowSetting({
    key: "depth_m",
    control: field(0, 100, 0.1),
    label: "Alarm under depth (m)",
    help: "Depth below the surface: your draft plus the water you want under the keel. A below-keel sounder is converted using the draft SignalK reports.",
    order: 10,
    default: 3,
    coerce: (raw) => coerceFiniteNumber(raw, 3),
  }),
  shallowSetting({
    key: "hysteresis_m",
    control: field(0, 10, 0.1),
    label: "Clears when deeper by (m)",
    help: "Raises after 2 s shallower than the alarm depth; clears only after 10 s this much deeper, so a sounder hovering around the line doesn't flap the alarm.",
    order: 30,
    default: 0.5,
    coerce: (raw) => coerceFiniteNumber(raw, 0.5),
  }),
  shallowSetting({
    key: "publish",
    control: { kind: "toggle" },
    label: "Raise on SignalK",
    help: "Also raise the alarm as a SignalK notification (notifications.environment.depth.shallowWater), so the MFD, KIP and other displays alarm too, and it keeps watching with every screen closed. Needs SignalK admin access (see SignalK).",
    order: 40,
    default: true,
    coerce: (raw) => coerceBoolean(raw, true),
  }),
  defineSetting<SettingsCtx>({
    id: "shallow.feedback",
    scope: "server",
    control: { kind: "custom", component: Feedback },
    label: "Shallow-water alarm feedback",
    group: "shallow",
    order: 50,
  }),
];

export const SHALLOW_SECTION: SettingsSection<SettingsCtx> = defineSettingsSection<SettingsCtx>({
  id: "shallow",
  title: "Shallow-water alarm",
  icon: Waves,
  group: "server",
  category: "alarms",
  order: 20,
});
