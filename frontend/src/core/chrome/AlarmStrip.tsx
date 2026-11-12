import TriangleAlert from "lucide-solid/icons/triangle-alert";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
  type Accessor,
  type Component,
} from "solid-js";
import { audibleAlerts, rearm, visibleAlerts } from "./alarms";
import { createBrowserSink, createSiren, shouldSound } from "./alarmSound";
import { alerts, type Alert, type Registry } from "./registry";

// RESERVED CHROME (invariant #1) — not a band, unaddressable by
// `defineFeature`; App.tsx renders it directly into the map pane.
// See docs/architecture/chrome-registry.md ("AlarmStrip.tsx").

export interface AlarmStripProps {
  /** The whole registry, not a band. Config is deliberately not consulted. */
  reg: Registry;
  /** Sound/vibrate for EVERY unacked alarm, not only those whose own
   * `alertSound` asks to. The app does not wire it (each alarm decides for
   * itself: the anchor alarm by SignalK, the collision alarm by the boat's
   * `collision.sound`). Absent → only alarms that ask sound. */
  alarmSound?: Accessor<boolean>;
}

const AlarmStrip: Component<AlarmStripProps> = (props) => {
  const [acked, setAcked] = createSignal<ReadonlySet<string>>(new Set());
  const firing = createMemo(() => alerts(props.reg));

  // An ack dismisses one event, not one instrument forever — dropped the
  // moment the alarm stops firing (`alarms.ts`).
  createEffect(() => {
    const all = firing();
    setAcked((prev) => {
      const next = rearm(all, prev);
      return next.size === prev.size ? prev : next;
    });
  });

  const shown = () => visibleAlerts(firing(), acked());
  // `alerts()` builds FRESH objects on every recompute (each AIS/sensor tick
  // changes `detail`), and <For> keys by reference — iterating them directly
  // tore down and rebuilt every row per tick, replaying the fade-in: the alarm
  // BLINKED. Key rows by id instead (a string, so equal ids are identical
  // keys) and read the live alert through `byId`; a row mounts — and fades
  // in — exactly once per alarm event.
  const shownIds = createMemo(() => shown().map((a) => a.id), [], {
    equals: (a, b) => a.length === b.length && a.every((id, i) => id === b[i]),
  });
  const byId = createMemo(() => new Map(shown().map((a) => [a.id, a])));

  // MUTE: quiet on this screen at once, for the alert's own `seconds`, while
  // the source's silence (SignalK's, for the collision alarm) catches up and
  // then outlasts it. Dropped early, like an ack, if the alarm stops firing.
  const [muted, setMuted] = createSignal<ReadonlySet<string>>(new Set());
  const unmute = new Map<string, ReturnType<typeof setTimeout>>();
  onCleanup(() => unmute.forEach(clearTimeout));
  const mute = (alert: Alert) => {
    const { seconds, run } = alert.mute!;
    setMuted((prev) => new Set([...prev, alert.id]));
    clearTimeout(unmute.get(alert.id));
    unmute.set(
      alert.id,
      setTimeout(() => {
        unmute.delete(alert.id);
        setMuted((prev) => new Set([...prev].filter((id) => id !== alert.id)));
      }, seconds * 1000),
    );
    run();
  };
  createEffect(() => {
    const all = firing();
    setMuted((prev) => {
      const next = rearm(all, prev);
      return next.size === prev.size ? prev : next;
    });
  });

  // Sounds while unacked and unmuted, silences on ACK/clear (both drop it
  // from `shown()`) and on MUTE. Mechanics live in `alarmSound.ts`; built
  // lazily so no AudioContext exists until this mounts.
  const siren = createSiren(createBrowserSink());
  onCleanup(() => siren.dispose());
  createEffect(() => {
    const up = audibleAlerts(shown(), muted());
    const enabled = props.alarmSound?.() ?? false;
    // Harsh siren while any SOUNDING alarm is a critical one (MOB, collision,
    // anchor); a quiet critical alarm next to a sounding depth alarm doesn't
    // turn the depth beep into the siren.
    const critical = up.some((a) => a.critical && (enabled || a.sound));
    siren.set(
      shouldSound({
        enabled,
        unackedAlarms: up.length,
        soundRequested: up.filter((a) => a.sound).length,
      }),
      critical,
    );
  });

  return (
    <Show when={shown().length > 0}>
      {/* Centred at the top of the chart and horizontally bounded, so it cannot
          grow into the whole pane. `pointer-events-none` on the wrapper keeps
          the chart draggable everywhere the strip is not actually drawn. */}
      <div
        class="pointer-events-none absolute inset-x-0 top-2 z-20 flex flex-col items-center gap-1.5 px-2"
        role="alert"
        aria-live="assertive"
      >
        <For each={shownIds()}>
          {(id) => {
            // Live alert for this row; holds the last one seen so a row being
            // torn down in the same tick it left `byId` never reads undefined.
            const alert = createMemo<Alert>(
              (prev) => byId().get(id) ?? prev,
              byId().get(id)!,
            );
            return (
              // A QUICK fade entrance only (`mivnav-fade-in`, 150ms) — an alarm must
              // read as urgent, so it appears fast and, deliberately, leaves
              // INSTANTLY on ACK/clear (no exit animation to delay silencing it).
              <div
                class="mivnav-fade-in pointer-events-auto flex max-w-[min(560px,100%)] items-center gap-2.5 rounded-md border border-alarm bg-alarm px-2.5 py-1.5 text-left"
                style={{ "box-shadow": "0 6px 22px var(--color-shadow)" }}
              >
                <TriangleAlert
                  size={18}
                  aria-hidden="true"
                  class="shrink-0 text-alarm-fg"
                />
                <div class="min-w-0 font-mono text-alarm-fg">
                  <div class="truncate text-[11px] font-bold tracking-[0.04em]">
                    {alert().title}
                  </div>
                  <Show when={alert().detail}>
                    <div class="truncate text-[10px] opacity-90">
                      {alert().detail}
                    </div>
                  </Show>
                </div>
                {/* MUTE only where the alarm offers it (the collision alarm:
                  re-armed on SignalK after `mute.seconds`); ACK is the only
                  dismissal. Real coarse-pointer targets: a mis-tap is a worse
                  failure than most. */}
                <Show when={alert().mute}>
                  {(m) => {
                    const quiet = () =>
                      alert().silenced || muted().has(alert().id);
                    return (
                      <button
                        type="button"
                        class="ml-auto flex shrink-0 items-center justify-center rounded border border-alarm-fg/60 px-2 py-1 font-mono text-[10px] font-bold tracking-[0.06em] text-alarm-fg hover:bg-alarm-fg/20 active:bg-alarm-fg/30 disabled:opacity-60 disabled:hover:bg-transparent pointer-coarse:min-h-11 pointer-coarse:px-4"
                        disabled={quiet()}
                        onClick={() => mute(alert())}
                      >
                        {quiet()
                          ? "MUTED"
                          : `MUTE ${Math.round(m().seconds / 60)}m`}
                      </button>
                    );
                  }}
                </Show>
                <button
                  type="button"
                  class="flex shrink-0 items-center justify-center rounded border border-alarm-fg/60 px-2 py-1 font-mono text-[10px] font-bold tracking-[0.06em] text-alarm-fg hover:bg-alarm-fg/20 active:bg-alarm-fg/30 pointer-coarse:min-h-11 pointer-coarse:px-4"
                  classList={{ "ml-auto": !alert().mute }}
                  onClick={() => {
                    setAcked((prev) => new Set([...prev, alert().id]));
                    alert().ack?.();
                  }}
                >
                  ACK
                </button>
              </div>
            );
          }}
        </For>
      </div>
    </Show>
  );
};

export default AlarmStrip;
