// THE collision settings page — boat-wide (mivnav.collision.config.CollisionConfig),
// because the alarm runs on the boat's server and is raised on SignalK for
// every display at once (docs/architecture/cpa-backend.md). Every screen also
// colours targets and draws CPA lines by these same thresholds, and follows
// the same Off/Show/Tell and sound: they reach it in the SignalK snapshot
// (`collisionSettings`). Same generated-boat-setting shape as `boat.tsx`'s nav
// and `routing.tsx`'s declarations, under its own scope/group so feedback
// lands here and nowhere else. The only per-device collision setting left is
// whether the chart colours targets at all (`showAisRisk`, AisSection.tsx).

import ShieldAlert from "lucide-solid/icons/shield-alert";
import { Show, type Component } from "solid-js";
import type { CpaMode } from "../collisionSettings";
import { coerceBoolean, coerceFiniteNumber } from "../persist";
import type { CollisionServerConfig, ConfigPatch, ServerConfig } from "../serverConfig";
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

/** The feedback scope every collision-alarm write is addressed under. */
const COLLISION_SCOPE = "collision";

const SIDE_EFFECT =
  "Boat-wide: the server's collision watch uses this on its next snapshot — every screen's colouring and alarm and the SignalK notification change together.";

/** `boat.tsx`'s `boatSetting`, addressed under `COLLISION_SCOPE`. Every
 * number is a typed `field` (commit on blur): each commit is a network write. */
function collisionSetting<K extends keyof CollisionServerConfig>(opts: {
  key: K;
  control: Control<SettingsCtx>;
  label: string;
  help: string;
  order: number;
  default: CollisionServerConfig[K];
  coerce: (raw: unknown) => SettingValue;
}): Setting<SettingsCtx> {
  return defineSetting<SettingsCtx>({
    id: `collision.${opts.key}`,
    scope: "server",
    control: opts.control,
    label: opts.label,
    help: opts.help,
    group: "collision",
    order: opts.order,
    default: opts.default,
    coerce: opts.coerce,
    disabledWhen: (ctx) => ctx.cfg.busy(),
    writeSideEffect: SIDE_EFFECT,
    read: (ctx) => {
      const config: ServerConfig | null = ctx.cfg.config();
      return config?.collision?.[opts.key] ?? opts.default;
    },
    write: (ctx, value) => {
      const patch: ConfigPatch = { collision: { [opts.key]: value } };
      return ctx.cfg.patch(patch, { scope: COLLISION_SCOPE, done: "Saved." });
    },
  });
}

const CollisionFeedback: Component<CustomControlProps<SettingsCtx>> = (props) => {
  const cfg = () => props.ctx.cfg;
  const shown = () => cfg().scope() === COLLISION_SCOPE;
  return (
    <Show when={shown()}>
      <Show when={cfg().error()}>
        <p class="text-xs text-alarm">{cfg().error()}</p>
      </Show>
      <Show when={cfg().status()}>
        <p class="text-xs text-ok">{cfg().status()}</p>
      </Show>
    </Show>
  );
};

const nm = (v: unknown, fallback: number) => coerceFiniteNumber(v, fallback);
const field = (min: number, max: number, step: number): Control<SettingsCtx> => ({
  kind: "number",
  min,
  max,
  step,
  as: "field",
});

const CPA_MODES: readonly CpaMode[] = ["off", "show", "tell"];
const coerceMode = (raw: unknown): CpaMode =>
  CPA_MODES.includes(raw as CpaMode) ? (raw as CpaMode) : "tell";

/** Defaults mirror `CollisionConfig` (and `DEFAULT_COLLISION_SETTINGS`). */
export const COLLISION_SETTINGS: readonly Setting<SettingsCtx>[] = [
  collisionSetting({
    key: "mode",
    control: {
      kind: "enum",
      options: CPA_MODES,
      as: "segmented",
      labels: { off: "Off", show: "Show", tell: "Tell" },
    },
    label: "Collision alarm",
    help: "Off draws no CPA lines and raises nothing. Show draws the CPA line to a close-passing target and shows the alarm, silently. Tell also sounds it. Also on the Tools menu.",
    order: 5,
    default: "tell",
    coerce: coerceMode,
  }),
  collisionSetting({
    key: "sound",
    control: { kind: "toggle" },
    label: "Sound & vibrate on screens",
    help: "In Tell, every mivnav screen sounds and vibrates until someone acknowledges. Off: screens only show it; the SignalK notification still sounds on the MFD and other displays.",
    order: 7,
    default: true,
    coerce: (raw) => coerceBoolean(raw, true),
  }),
  collisionSetting({
    key: "danger_nm",
    control: field(0.05, 5, 0.05),
    label: "Alarm: closer than (nm)",
    help: "A target that will pass closer than this … (red on the chart; sounds in Tell)",
    order: 10,
    default: 0.3,
    coerce: (raw) => nm(raw, 0.3),
  }),
  collisionSetting({
    key: "horizon_min",
    control: field(1, 120, 1),
    label: "Alarm: within (min)",
    help: "… within this many minutes.",
    order: 20,
    default: 15,
    coerce: (raw) => nm(raw, 15),
  }),
  collisionSetting({
    key: "warning_nm",
    control: field(0.05, 10, 0.05),
    label: "Warning: closer than (nm)",
    help: "A silent warning for a target that will pass closer than this … (yellow on the chart)",
    order: 30,
    default: 1,
    coerce: (raw) => nm(raw, 1),
  }),
  collisionSetting({
    key: "warning_horizon_min",
    control: field(1, 120, 1),
    label: "Warning: within (min)",
    help: "… within this many minutes.",
    order: 40,
    default: 30,
    coerce: (raw) => nm(raw, 30),
  }),
  collisionSetting({
    key: "at_rest_kn",
    control: field(0, 5, 0.1),
    label: "Treat as stopped below (kn)",
    help: "A vessel slower than this is at rest — its course is GPS noise. Two vessels both at rest never alarm on each other.",
    order: 50,
    default: 0.2,
    coerce: (raw) => nm(raw, 0.2),
  }),
  collisionSetting({
    key: "publish",
    control: { kind: "toggle" },
    label: "Raise on SignalK",
    help: "Also raise the alarm as a SignalK notification, so the MFD, KIP and other displays alarm too, and it keeps watching with every screen closed. Needs SignalK admin access (see SignalK).",
    order: 60,
    default: true,
    coerce: (raw) => coerceBoolean(raw, true),
  }),
  defineSetting<SettingsCtx>({
    id: "collision.feedback",
    scope: "server",
    control: { kind: "custom", component: CollisionFeedback },
    label: "Collision alarm feedback",
    group: "collision",
    order: 70,
  }),
];

export const COLLISION_SECTION: SettingsSection<SettingsCtx> = defineSettingsSection<SettingsCtx>({
  id: "collision",
  title: "Collision alarm",
  icon: ShieldAlert,
  group: "server",
  category: "alarms",
  order: 10,
});
