// The anchor mode's control card (shown in ./sheet.tsx, see ./index.ts).
// One card per phase — up: drop (or place on chart); dropping: the alarm is
// off while the rode goes out, then armed at a radius (Freeboard's flow);
// down: watch, refine the radius, move, raise. Raising switches the guard off, so it is the one
// hold-to-confirm here (autopilot-ui-safety's posture for "takes the guard
// away"); everything else is a tap. Every control is inert behind a dead
// link: the numbers are last-known, and the plugin still watches anyway.

import { createEffect, createSignal, on, Show, onCleanup, type Component } from "solid-js";
import { createHoldToFire } from "../../core/autopilot";
import type { SignalKState } from "../../core/signalk";
import type { AnchorController, AnchorFeedback } from "./client";
import {
  anchorLive,
  anchorPhase,
  armRadiusFromHere,
  clampRadius,
  DEFAULT_RADIUS_M,
  FROM_HERE_MARGIN_M,
  fromAnchorM,
  isAlarming,
  RADIUS_STEP_M,
} from "./model";
import { watchTone } from "./overlay";

export interface AnchorControlProps {
  signalk: SignalKState;
  controller: AnchorController;
  /** The farthest the boat has been from the anchor on the swing track, m. */
  maxSeenM: () => number | undefined;
  /** Enter the place-on-chart mode (with the radius it should use; `null`
   * keeps it unarmed). */
  placeOnChart: (radiusM: number | null) => void;
}

const BTN =
  "rounded-[5px] border border-line bg-chrome py-[9px] font-mono text-[12px] font-semibold tabular-nums text-fg active:bg-chrome-2 disabled:opacity-35 focus-ring pointer-coarse:min-h-11";
const LABEL = "font-mono text-[8px] tracking-[0.06em] text-fg-3";
const BIG = "font-mono text-[20px] font-semibold tabular-nums tracking-[-0.03em]";

function feedbackText(fb: AnchorFeedback): { text: string; cls: string } {
  switch (fb.kind) {
    case "pending":
      return { text: `${fb.label}…`, cls: "text-fg-3" };
    case "ok":
      return { text: `✓ ${fb.label}`, cls: "text-fg-2" };
    case "unreachable":
      return { text: `${fb.label}: DID NOT HAPPEN — ${fb.message}`, cls: "text-alarm font-bold" };
    case "refused":
      return { text: `Anchor alarm: ${fb.message}`, cls: "text-notice" };
    case "unavailable":
      return { text: fb.message, cls: "text-notice" };
    case "error":
      return { text: fb.message, cls: "text-alarm font-bold" };
  }
}

/** Raising switches the guard off — the one hold-to-confirm on the card. */
const RaiseButton: Component<{ live: boolean; hold: ReturnType<typeof createHoldToFire> }> = (props) => (
  <button
    type="button"
    disabled={!props.live}
    class="relative w-full overflow-hidden rounded-[5px] border border-line bg-chrome py-[11px] text-center font-mono text-[11.5px] font-semibold tracking-[0.05em] text-fg disabled:opacity-40 focus-ring pointer-coarse:min-h-11"
    onPointerDown={(e) => {
      if (props.live) {
        e.preventDefault();
        props.hold.start();
      }
    }}
    onPointerUp={props.hold.cancel}
    onPointerLeave={props.hold.cancel}
    onPointerCancel={props.hold.cancel}
  >
    <span
      class="absolute inset-y-0 left-0 bg-alarm/30"
      style={{ width: `${Math.round(props.hold.progress() * 100)}%` }}
      aria-hidden="true"
    />
    <span class="relative">{props.hold.holding() ? "KEEP HOLDING…" : "HOLD TO RAISE ANCHOR"}</span>
  </button>
);

/** `—` for an unknown number, else whole metres. */
const m = (v: number | undefined): string => (v === undefined ? "—" : `${Math.round(v)}`);

export const AnchorControl: Component<AnchorControlProps> = (props) => {
  const a = () => props.signalk.anchor();
  const phase = () => anchorPhase(a());
  const live = () => anchorLive(props.signalk.status());
  const tone = () => watchTone(a());
  // The radius arming will use: distance-now + margin, live, until a stepper
  // pins it. Forgotten once the phase moves on, so the next anchoring starts
  // live again.
  const [armOverride, setArmOverride] = createSignal<number | null>(null);
  createEffect(on(phase, () => setArmOverride(null)));
  const boat = () => props.signalk.self();
  const armRadius = () => armOverride() ?? armRadiusFromHere(a(), boat()) ?? DEFAULT_RADIUS_M;
  const watchRadius = () => a()?.maxRadiusM;
  const depth = () => props.signalk.self()?.depthBelowSurfaceM ?? props.signalk.self()?.depthBelowTransducerM;

  const step = (delta: number) => {
    const cur = watchRadius();
    if (cur === undefined) return;
    void props.controller.setRadius(clampRadius(cur + delta));
  };

  const hold = createHoldToFire({ onFire: () => void props.controller.raise() });
  onCleanup(hold.dispose);

  const alarmId = () => {
    const alarm = a()?.alarm;
    return alarm?.id && !alarm.acknowledged && alarm.canAcknowledge !== false ? alarm.id : undefined;
  };

  return (
    <div
      class="rounded-md border px-[9px] py-2"
      classList={{
        "border-alarm bg-alarm/10": tone() === "alarm",
        "border-notice bg-notice/10": tone() === "warn",
        "border-line-2 bg-chrome-2": tone() === "ok",
      }}
    >
      <div class="flex items-baseline justify-between gap-2">
        <h3 class="font-mono text-[8.5px] font-bold tracking-[0.07em] text-fg-3">ANCHOR WATCH</h3>
        <span
          class="font-mono text-[12px] font-bold tracking-[0.06em]"
          classList={{
            "text-alarm": tone() === "alarm",
            "text-notice": tone() === "warn" || (live() && phase() === "dropping"),
            "text-fg-2": tone() === "ok" && !(live() && phase() === "dropping"),
          }}
        >
          {!live()
            ? "— NO LINK"
            : phase() === "none"
              ? "NO PLUGIN"
              : phase() === "up"
                ? "ANCHOR UP"
                : phase() === "dropping"
                  ? "◌ DROPPING · NO ALARM"
                  : tone() === "alarm"
                  ? "● ALARM"
                  : "● WATCHING"}
        </span>
      </div>

      <Show when={phase() === "none"}>
        <p class="mt-2 font-mono text-[10px] leading-[1.4] text-fg-2">
          The SignalK anchoralarm plugin has not reported. Install and enable it on the
          SignalK server — it is the watcher; this card only drives it.
        </p>
      </Show>

      <Show when={phase() === "up"}>
        <div class="mb-2 mt-[5px] flex items-end gap-[14px]">
          <div>
            <div class={LABEL}>DEPTH</div>
            <div class={BIG}>
              {depth() === undefined ? "—" : depth()!.toFixed(1)}
              <span class="ml-0.5 text-[11px] text-fg-3">m</span>
            </div>
          </div>
          {/* Scope at 5:1 and 7:1 on the depth alone — a hint, not a
              calculator: bow height and tide are not known here. */}
          <Show when={depth() !== undefined}>
            <div class="pb-[3px] font-mono text-[9px] leading-[1.35] text-fg-3">
              <div>5:1 ≈ {Math.round(depth()! * 5)} m</div>
              <div>7:1 ≈ {Math.round(depth()! * 7)} m</div>
            </div>
          </Show>
        </div>
        <button
          type="button"
          disabled={!live()}
          class={`${BTN} w-full py-[11px] text-[11.5px] tracking-[0.05em]`}
          onClick={() => void props.controller.drop()}
        >
          ⚓ DROP ANCHOR HERE
        </button>
        <button
          type="button"
          disabled={!live()}
          class={`${BTN} mt-[5px] w-full py-[7px] text-[10px] text-fg-2`}
          onClick={() => props.placeOnChart(null)}
        >
          PLACE ON CHART…
        </button>
      </Show>

      <Show when={phase() === "dropping"}>
        <div class="mb-2 mt-[5px] flex gap-[14px]">
          <div>
            <div class={LABEL}>FROM ANCHOR</div>
            <div class={BIG}>
              {m(fromAnchorM(a(), boat()))}
              <span class="ml-0.5 text-[11px] text-fg-3">m</span>
            </div>
          </div>
          <div>
            <div class={LABEL}>ALARM AT</div>
            <div class={BIG}>
              {armRadius()}
              <span class="ml-0.5 text-[11px] text-fg-3">m</span>
            </div>
          </div>
          <div>
            <div class={LABEL}>DEPTH</div>
            <div class={BIG}>
              {depth() === undefined ? "—" : depth()!.toFixed(1)}
              <span class="ml-0.5 text-[11px] text-fg-3">m</span>
            </div>
          </div>
        </div>
        <div class="flex gap-[5px]">
          <button type="button" class={`${BTN} flex-1`} onClick={() => setArmOverride(clampRadius(armRadius() - RADIUS_STEP_M))}>
            −{RADIUS_STEP_M}
          </button>
          <button
            type="button"
            disabled={armOverride() === null}
            class={`${BTN} flex-[2] text-[10px] tracking-[0.03em]`}
            onClick={() => setArmOverride(null)}
            title={`Follow the distance to the anchor + ${FROM_HERE_MARGIN_M} m`}
          >
            {armOverride() === null ? `FROM HERE +${FROM_HERE_MARGIN_M}` : `BACK TO HERE +${FROM_HERE_MARGIN_M}`}
          </button>
          <button type="button" class={`${BTN} flex-1`} onClick={() => setArmOverride(clampRadius(armRadius() + RADIUS_STEP_M))}>
            +{RADIUS_STEP_M}
          </button>
        </div>
        <button
          type="button"
          disabled={!live()}
          class={`${BTN} mt-[9px] w-full border-accent py-[11px] text-[11.5px] tracking-[0.05em]`}
          onClick={() => void props.controller.setRadius(armRadius())}
        >
          ACTIVATE ALARM AT {armRadius()} m
        </button>
        <button
          type="button"
          disabled={!live()}
          class={`${BTN} mt-[5px] w-full py-[7px] text-[10px] text-fg-2`}
          onClick={() => props.placeOnChart(null)}
        >
          MOVE ANCHOR ON CHART…
        </button>
        <div class="my-[9px] h-px bg-line" />
        <RaiseButton live={live()} hold={hold} />
      </Show>

      <Show when={phase() === "down"}>
        <div class="mb-2 mt-[5px] flex gap-[14px]">
          <div>
            <div class={LABEL}>FROM ANCHOR</div>
            <div class={BIG} classList={{ "text-alarm": tone() === "alarm" }}>
              {m(a()?.currentRadiusM)}
              <span class="ml-0.5 text-[11px] text-fg-3">m</span>
            </div>
          </div>
          <div>
            <div class={LABEL}>WATCH</div>
            <div class={BIG}>
              {m(watchRadius())}
              <span class="ml-0.5 text-[11px] text-fg-3">m</span>
            </div>
          </div>
          <div>
            <div class={LABEL}>MAX SEEN</div>
            <div class={BIG}>
              {m(props.maxSeenM())}
              <span class="ml-0.5 text-[11px] text-fg-3">m</span>
            </div>
          </div>
          <div>
            <div class={LABEL}>ANCHOR BRG</div>
            <div class={BIG}>
              {a()?.bearingTrueDeg === undefined ? "—" : `${Math.round(a()!.bearingTrueDeg!) % 360}°`}
            </div>
          </div>
        </div>

        <Show when={isAlarming(a())}>
          <div class="mb-2 flex items-center gap-2 rounded border border-alarm bg-alarm px-2 py-1.5 font-mono text-[10px] font-bold text-alarm-fg">
            <span class="min-w-0 flex-1 truncate">{a()?.alarm?.message ?? "Anchor alarm"}</span>
            <Show when={alarmId()}>
              {(id) => (
                <button
                  type="button"
                  disabled={!live()}
                  class="shrink-0 rounded border border-alarm-fg/60 px-2 py-1 pointer-coarse:min-h-11 pointer-coarse:px-4"
                  onClick={() => void props.controller.ack(id())}
                >
                  ACK
                </button>
              )}
            </Show>
          </div>
        </Show>

        {/* −5 / from here / +5. "From here" is the real workflow: drop, let
            out rode, back down, then measure + 10 m (+ the plugin's fudge). */}
        <div class="flex gap-[5px]">
          <button type="button" disabled={!live()} class={`${BTN} flex-1`} onClick={() => step(-RADIUS_STEP_M)}>
            −{RADIUS_STEP_M}
          </button>
          <button
            type="button"
            disabled={!live()}
            class={`${BTN} flex-[2] text-[10px] tracking-[0.03em]`}
            onClick={() => void props.controller.radiusFromHere()}
            title={`Sets the watch to the distance to the anchor now + 10 m${a()?.fudgeM ? ` + the plugin's ${m(a()?.fudgeM)} m margin` : ""}`}
          >
            RADIUS FROM HERE
          </button>
          <button type="button" disabled={!live()} class={`${BTN} flex-1`} onClick={() => step(RADIUS_STEP_M)}>
            +{RADIUS_STEP_M}
          </button>
        </div>
        <button
          type="button"
          disabled={!live()}
          class={`${BTN} mt-[5px] w-full py-[7px] text-[10px] text-fg-2`}
          onClick={() => props.placeOnChart(watchRadius() ?? DEFAULT_RADIUS_M)}
        >
          MOVE ANCHOR ON CHART…
        </button>
        <div class="my-[9px] h-px bg-line" />
        <RaiseButton live={live()} hold={hold} />
      </Show>

      <Show
        when={props.controller.feedback()}
        fallback={
          <>
            <Show when={phase() === "up"}>
              <div class="mt-1 text-center font-mono text-[9px] text-fg-3">
                no alarm until you activate it, once the anchor is set
              </div>
            </Show>
            <Show when={phase() === "dropping"}>
              <div class="mt-1 text-center font-mono text-[9px] text-fg-3">
                let out the rode, back down, then activate
              </div>
            </Show>
            <Show when={phase() === "down"}>
              <div class="mt-1 text-center font-mono text-[9px] text-fg-3">
                raising stops the watch · hold 600 ms
              </div>
            </Show>
          </>
        }
      >
        {(fb) => (
          <div class={`mt-1 text-center font-mono text-[9px] leading-[1.3] ${feedbackText(fb()).cls}`} role="status" aria-live="polite">
            {feedbackText(fb()).text}
          </div>
        )}
      </Show>
    </div>
  );
};
