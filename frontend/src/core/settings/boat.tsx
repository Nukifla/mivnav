// The BOAT settings declaration — twin of `settings/device.tsx`, but reads/
// writes a slice of the server config (serverConfig.ts) instead of a browser
// signal. Only the two safe nav controls are generated (B4). See docs/architecture/boat-settings.md.

import Navigation from "lucide-solid/icons/navigation";
import { Show, type Component } from "solid-js";
import { coerceBoolean, coerceFiniteNumber } from "../persist";
import type { ConfigPatch, NavServerConfig, ServerConfig } from "../serverConfig";
import type { BoatCtx, SettingsCtx } from "./ctx";
import {
  defineSetting,
  defineSettingsSection,
  type Control,
  type CustomControlProps,
  type Setting,
  type SettingValue,
  type SettingsSection,
} from "./registry";

// `BoatCtx`/`SettingsCtx` live in ./ctx.ts (one registry spans device+boat,
// task woqknwzy — see docs/architecture/boat-settings.md); re-exported here
// for readers who look for them beside the boat declarations they describe.
export type { BoatCtx, SettingsCtx };

/** The feedback scope every nav write is addressed under — the `NavigationSection`
 * used the same string, so its feedback still renders in the nav section (below,
 * as a custom control) and nowhere else. */
const NAV_SCOPE = "nav";

/** Route one declared boat setting onto the server controller: `read(config)`
 * picks the live slice, `toPatch(value)` builds the merge patch. */
function boatSetting(opts: {
  id: string;
  control: Control<SettingsCtx>;
  label: string;
  help?: string;
  order: number;
  default: SettingValue;
  coerce: (raw: unknown) => SettingValue;
  read: (config: ServerConfig) => SettingValue;
  toPatch: (value: SettingValue) => ConfigPatch;
  done: string;
  writeSideEffect: string;
  disabledWhen?: (ctx: SettingsCtx) => boolean;
}): Setting<SettingsCtx> {
  return defineSetting<SettingsCtx>({
    id: opts.id,
    scope: "server",
    control: opts.control,
    label: opts.label,
    help: opts.help,
    group: "nav",
    order: opts.order,
    default: opts.default,
    coerce: opts.coerce,
    disabledWhen: opts.disabledWhen,
    writeSideEffect: opts.writeSideEffect,
    read: (ctx) => {
      const config = ctx.cfg.config();
      return config ? opts.read(config) : opts.default;
    },
    write: (ctx, value) =>
      ctx.cfg.patch(opts.toPatch(value), { scope: NAV_SCOPE, done: opts.done }),
  });
}

// Display-only custom control: a refused nav write surfaces here, addressed
// by NAV_SCOPE, matching the former hand-authored `<Feedback scope="nav"/>`.
const NavFeedback: Component<CustomControlProps<SettingsCtx>> = (props) => {
  const cfg = () => props.ctx.cfg;
  const shown = () => cfg().scope() === NAV_SCOPE;
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

/** Route following (#yprzuqtt): replaced `auto_advance`/`arrival_radius_m`
 * one-for-one in shape. See docs/architecture/boat-settings.md for why. */
export const BOAT_SETTINGS: readonly Setting<SettingsCtx>[] = [
  boatSetting({
    id: "nav.course_sync",
    control: { kind: "toggle" },
    label: "Follow SignalK's course",
    help: "The boat's active leg tracks whatever course SignalK reports (a second app, or its own arrival), and steps the followed route on arrival. Off: the leg only ever moves when you press GO.",
    order: 10,
    default: true,
    coerce: (raw) => coerceBoolean(raw, true),
    read: (config) => config.nav.course_sync,
    toPatch: (value) => ({ nav: { course_sync: value as boolean } }),
    done: "Saved.",
    writeSideEffect:
      "Boat-wide: the server's nav watcher (backend nav.watcher) starts or stops adopting/advancing the followed leg for every screen at once.",
  }),
  boatSetting({
    id: "nav.course_match_tolerance_m",
    // Typed field, not a slider: each commit is a network write. `max` is a
    // sanity ceiling, not a model limit (backend only requires gt=0).
    control: { kind: "number", min: 1, max: 100000, step: 1, as: "field" },
    label: "Course match tolerance (m)",
    help: "How close a SignalK-reported course point must be to one of your own waypoints to count as the same point.",
    order: 20,
    default: 10,
    coerce: (raw) => coerceFiniteNumber(raw, 10),
    read: (config) => config.nav.course_match_tolerance_m,
    toPatch: (value) => ({ nav: { course_match_tolerance_m: value as number } }),
    done: "Saved.",
    // NOT a `dependsOn` cascade: that would indent it under the toggle, and
    // the hand-authored Field was not indented.
    disabledWhen: (ctx) => {
      const config = ctx.cfg.config();
      return !config?.nav.course_sync || ctx.cfg.busy();
    },
    writeSideEffect:
      "Boat-wide: the nav watcher's course/waypoint matching uses this tolerance on every screen.",
  }),
  defineSetting<SettingsCtx>({
    id: "nav.feedback",
    scope: "server",
    control: { kind: "custom", component: NavFeedback },
    label: "Route-following feedback",
    group: "nav",
    order: 30,
  }),
];

/** The generated boat section the two nav settings render under — icon and title
 * as the former `NavigationSection`. It is the whole of the "Route following"
 * category (declared in `ServerSettings.tsx` with the rest of the boat rail). */
export const NAV_SECTION: SettingsSection<SettingsCtx> = defineSettingsSection<SettingsCtx>({
  id: "nav",
  title: "Route following",
  icon: Navigation,
  group: "server",
  category: "routes",
  order: 10,
});

// Re-exported for readers reasoning about a nav write's blast radius from one
// place, and so a `NavServerConfig` type change surfaces here at compile time.
export type { NavServerConfig };
