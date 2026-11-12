// Autopilot feature UI (widgets `ap.control`/`ap.rudder`, see ./index.ts).
// SAFETY INVARIANTS — who can command, why a control goes inert, why stale
// state must never read as engaged: see docs/architecture/autopilot-ui-safety.md.

import { For, Show, onCleanup, type Component } from "solid-js";
import {
  createHoldToFire,
  type ApFeedback,
  type AutopilotController,
  type Direction,
} from "../../core/autopilot";
import type { Autopilot, SignalKState, SignalKStatus } from "../../core/signalk";
import { padDeg } from "../../core/format";

/** The one honest read of the pilot. Absence and a dead link both collapse to
 * "unknown" here so nothing downstream can paint a frozen snapshot green. */
export type ApMode = "unknown" | "standby" | "engaged";

export function apMode(status: SignalKStatus, ap: Autopilot | null): ApMode {
  // The link is the only liveness signal — a frozen snapshot is "cannot tell".
  if (status !== "connected") return "unknown";
  // Nothing heard, or the pilot never reported whether it is steering.
  if (!ap || ap.engaged === undefined) return "unknown";
  return ap.engaged ? "engaged" : "standby";
}

/** In a wind mode the target and the ±° adjust mean a WIND ANGLE, not a compass
 * bearing — the labels relabel so a nudge is not mistaken for a course change.
 * "wind" and "true wind" both match. */
export const isWind = (mode: string | undefined): boolean =>
  !!mode && mode.toLowerCase().includes("wind");

/** `12°P` / `4°S` / `0°`. Negative is to port. Absent → em dashes. */
export const rudTxt = (deg: number | undefined): string =>
  deg === undefined
    ? "– –"
    : `${Math.abs(Math.round(deg))}°${Math.round(deg) === 0 ? "" : deg < 0 ? "P" : "S"}`;

// 200 "took" and 502 "did not happen" must read as DIFFERENT facts (see
// ../../core/autopilot's file header), so they get different words/colours.
type Tone = "pending" | "ok" | "warn" | "alarm";
const TONE_CLASS: Record<Tone, string> = {
  pending: "text-fg-3",
  ok: "text-ap",
  warn: "text-notice",
  alarm: "text-alarm",
};

function feedbackView(fb: ApFeedback): { text: string; tone: Tone } {
  switch (fb.kind) {
    case "pending":
      return { text: `${fb.label}…`, tone: "pending" };
    case "ok":
      return { text: `✓ ${fb.label}`, tone: "ok" };
    case "unreachable":
      // The pilot never heard it. Loudest wording — this is the "did my
      // disengage take?" case, and the honest answer is "no, try again".
      return { text: `${fb.label}: DID NOT HAPPEN — ${fb.message}`, tone: "alarm" };
    case "unavailable":
      return { text: fb.message ?? "Cannot command the pilot.", tone: "warn" };
    case "refused":
      return { text: `Pilot refused: ${fb.message}`, tone: "warn" };
    case "error":
      return { text: fb.message ?? "Command failed.", tone: "alarm" };
  }
}

const FeedbackLine: Component<{ fb: ApFeedback }> = (props) => {
  const view = () => feedbackView(props.fb);
  return (
    <div
      class="mt-1 text-center font-mono text-[9px] leading-[1.3]"
      classList={{
        [TONE_CLASS.pending]: view().tone === "pending",
        [TONE_CLASS.ok]: view().tone === "ok",
        [TONE_CLASS.warn]: view().tone === "warn",
        [TONE_CLASS.alarm]: view().tone === "alarm",
        "font-bold": view().tone === "alarm",
      }}
      role="status"
      aria-live="polite"
    >
      {view().text}
    </div>
  );
};

export interface ApControlProps {
  signalk: SignalKState;
  /** The write half. Absent → display-only (every control disabled). */
  controller?: AutopilotController;
}

const ADJUSTS: { label: string; delta: number }[] = [
  { label: "−10", delta: -10 },
  { label: "−1", delta: -1 },
  { label: "+1", delta: 1 },
  { label: "+10", delta: 10 },
];

export const ApControl: Component<ApControlProps> = (props) => {
  const mode = () => apMode(props.signalk.status(), props.signalk.autopilot());
  const ap = () => props.signalk.autopilot();
  const engaged = () => mode() === "engaged";
  // Everything below gates on this AND a controller being present.
  const live = () => mode() !== "unknown";
  const has = () => !!props.controller;
  const wind = () => isWind(ap()?.mode);

  const commanded = () => {
    const t = ap()?.targetDeg;
    return engaged() && t !== undefined && Number.isFinite(t) ? `${padDeg(t)}°` : "– – –";
  };
  // Under a dropped link the whole surface is "cannot tell": the snapshot is
  // frozen, so even the boat's heading and the pilot's mode are last-known, not
  // live. Dash them rather than present a frozen number as current.
  const actualHdg = () => {
    const h = props.signalk.self()?.headingDeg;
    return mode() !== "unknown" && h !== undefined ? `${padDeg(h)}°` : "– – –";
  };
  const pill = () =>
    mode() === "engaged" ? "● ENGAGED" : mode() === "standby" ? "STANDBY" : "— NO LINK";

  const modes = () => props.controller?.options()?.modes ?? [];
  const feedback = () => props.controller?.feedback() ?? null;
  // NAV/GPS one-tap shortcuts — only for pilots that actually report the mode
  // (some don't). Keep the reported casing when commanding it, same as the
  // dropdown's own <option value={m}>.
  const navMode = () => modes().find((m) => m.toLowerCase() === "nav");
  const gpsMode = () => modes().find((m) => m.toLowerCase() === "gps");

  // Hold-to-engage: 600 ms of unbroken hold, release aborts and sends nothing.
  const hold = createHoldToFire({ onFire: () => void props.controller?.engage() });
  onCleanup(hold.dispose);

  return (
    <div
      class="rounded-md border px-[9px] py-2"
      classList={{
        "border-ap bg-ap/10": engaged(),
        "border-line-2 bg-chrome-2": !engaged(),
      }}
    >
      <div class="flex items-baseline justify-between gap-2">
        <h3 class="font-mono text-[8.5px] font-bold tracking-[0.07em] text-fg-3">AUTOPILOT</h3>
        <span
          class="font-mono text-[12px] font-bold tracking-[0.06em]"
          classList={{ "text-ap": engaged(), "text-fg-2": !engaged() }}
        >
          {pill()}
        </span>
      </div>
      <div class="mb-2 mt-[5px] flex gap-[14px]">
        <div>
          <div class="font-mono text-[8px] tracking-[0.06em] text-fg-3">
            {wind() ? "WIND ANGLE" : "COMMANDED"}
          </div>
          <div class="font-mono text-[20px] font-semibold tabular-nums tracking-[-0.03em]">
            {commanded()}
          </div>
        </div>
        <div>
          <div class="font-mono text-[8px] tracking-[0.06em] text-fg-3">ACTUAL HDG</div>
          <div class="font-mono text-[20px] font-semibold tabular-nums tracking-[-0.03em]">
            {actualHdg()}
          </div>
        </div>
        {/* MODE — a real picker from the device's own `options.modes`, or the
            last-known text when there is no picker (no controller / no
            options / dead link). Switching modes reissues via PUT /mode. */}
        <div class="min-w-0">
          <div class="font-mono text-[8px] tracking-[0.06em] text-fg-3">MODE</div>
          <Show
            when={has() && modes().length > 0}
            fallback={
              <div class="pt-[5px] font-mono text-[13px] font-semibold">
                {mode() === "unknown" ? "—" : (ap()?.mode?.toUpperCase() ?? "—")}
              </div>
            }
          >
            <select
              class="mt-[3px] w-full rounded-[4px] border border-line bg-chrome py-[3px] font-mono text-[12px] font-semibold uppercase text-fg focus-ring disabled:opacity-40"
              disabled={!live()}
              value={ap()?.mode ?? ""}
              onChange={(e) => {
                const v = e.currentTarget.value;
                if (live() && v) void props.controller!.setMode(v);
              }}
              title="Steering mode"
            >
              {/* An unknown/last-known mode still shows even if it is not in
                  the option list, so the select never silently changes it. */}
              <Show when={!modes().includes(ap()?.mode ?? "")}>
                <option value={ap()?.mode ?? ""}>{ap()?.mode?.toUpperCase() ?? "—"}</option>
              </Show>
              <For each={modes()}>{(m) => <option value={m}>{m.toUpperCase()}</option>}</For>
            </select>
          </Show>
        </div>
      </div>
      {/* NAV/GPS shortcuts: same setMode() as the dropdown; hidden entirely
          (not disabled) when a pilot doesn't report the mode. */}
      <Show when={has() && (navMode() !== undefined || gpsMode() !== undefined)}>
        <div class="mt-[5px] flex gap-[5px]">
          <Show when={navMode()}>
            {(m) => (
              <button
                type="button"
                disabled={!live()}
                onClick={() => {
                  if (live()) void props.controller!.setMode(m());
                }}
                class="flex-1 rounded-[5px] border border-line bg-chrome py-[7px] font-mono text-[10px] font-semibold tracking-[0.03em] text-fg-2 active:bg-chrome-2 disabled:opacity-35 focus-ring"
              >
                NAV
              </button>
            )}
          </Show>
          <Show when={gpsMode()}>
            {(m) => (
              <button
                type="button"
                disabled={!live()}
                onClick={() => {
                  if (live()) void props.controller!.setMode(m());
                }}
                class="flex-1 rounded-[5px] border border-line bg-chrome py-[7px] font-mono text-[10px] font-semibold tracking-[0.03em] text-fg-2 active:bg-chrome-2 disabled:opacity-35 focus-ring"
              >
                GPS
              </button>
            )}
          </Show>
        </div>
      </Show>
      {/* Adjust the target — a device-side relative delta (race-free). In a
          wind mode this nudges the WIND ANGLE, hence the relabel above.
          Enabled ONLY while engaged. */}
      <div class="flex gap-[5px]">
        <For each={ADJUSTS}>
          {(a) => (
            <button
              type="button"
              disabled={!(has() && engaged())}
              onClick={() => {
                if (has() && engaged()) void props.controller!.adjust(a.delta);
              }}
              class="flex-1 rounded-[5px] border border-line bg-chrome py-[9px] font-mono text-[13px] font-semibold tabular-nums text-fg active:bg-chrome-2 disabled:opacity-35 focus-ring"
            >
              {a.label}
            </button>
          )}
        </For>
      </div>
      {/* Pilot refuses tack/gybe outside a wind mode (backend client.py
          tack()/gybe()), so the row is HIDDEN, not disabled, elsewhere —
          a guaranteed refusal is not a control to offer. */}
      <Show when={wind()}>
        <div class="mt-[5px] flex gap-[5px]">
          <For
            each={
              [
                { label: "TACK P", act: "tack", dir: "port" },
                { label: "TACK S", act: "tack", dir: "starboard" },
                { label: "GYBE P", act: "gybe", dir: "port" },
                { label: "GYBE S", act: "gybe", dir: "starboard" },
              ] as { label: string; act: "tack" | "gybe"; dir: Direction }[]
            }
          >
            {(m) => (
              <button
                type="button"
                disabled={!(has() && engaged())}
                onClick={() => {
                  if (!(has() && engaged())) return;
                  if (m.act === "tack") void props.controller!.tack(m.dir);
                  else void props.controller!.gybe(m.dir);
                }}
                class="flex-1 rounded-[5px] border border-line bg-chrome py-[7px] font-mono text-[10px] font-semibold tracking-[0.03em] text-fg-2 active:bg-chrome-2 disabled:opacity-35 focus-ring"
              >
                {m.label}
              </button>
            )}
          </For>
        </div>
      </Show>
      <div class="my-[11px] h-px bg-line" />
      {/* Engage / disengage. Disengage is one tap, no confirm. Engage is a
          600 ms hold with a filling bar; release before then aborts. Both
          inert unless the pilot is live. */}
      <Show
        when={engaged()}
        fallback={
          <button
            type="button"
            disabled={!(has() && mode() === "standby")}
            class="relative w-full overflow-hidden rounded-[5px] border border-line bg-chrome py-[11px] text-center font-mono text-[11.5px] font-semibold tracking-[0.05em] text-fg disabled:opacity-40 focus-ring"
            onPointerDown={(e) => {
              if (has() && mode() === "standby") {
                e.preventDefault();
                hold.start();
              }
            }}
            onPointerUp={hold.cancel}
            onPointerLeave={hold.cancel}
            onPointerCancel={hold.cancel}
          >
            <span
              class="absolute inset-y-0 left-0 bg-ap/40"
              style={{ width: `${Math.round(hold.progress() * 100)}%` }}
              aria-hidden="true"
            />
            <span class="relative">{hold.holding() ? "KEEP HOLDING…" : "HOLD TO ENGAGE"}</span>
          </button>
        }
      >
        <button
          type="button"
          class="w-full rounded-[5px] border border-alarm bg-alarm py-[11px] text-center font-mono text-[11.5px] font-semibold tracking-[0.05em] text-alarm-fg active:opacity-90 focus-ring"
          onClick={() => void props.controller?.disengage()}
        >
          ■ STANDBY — DISENGAGE
        </button>
      </Show>
      <Show
        when={feedback()}
        fallback={
          <div class="mt-1 text-center font-mono text-[9px] text-fg-3">
            {engaged() ? "one press · no confirmation · always" : "hold 600 ms · release to abort"}
          </div>
        }
      >
        {(fb) => <FeedbackLine fb={fb()} />}
      </Show>
    </div>
  );
};

// Read-only. Absent angle (or a dead link) → no fill and em dashes, never a
// centred rudder implying "amidships".
export interface ApRudderProps {
  signalk: SignalKState;
}

export const ApRudder: Component<ApRudderProps> = (props) => {
  const mode = () => apMode(props.signalk.status(), props.signalk.autopilot());
  const rudder = () => (mode() === "unknown" ? undefined : props.signalk.autopilot()?.rudderAngleDeg);
  const rudPct = () => {
    const r = rudder();
    if (r === undefined) return 0;
    return Math.min(50, (Math.min(35, Math.abs(r)) / 35) * 50);
  };
  const rudLeft = () => {
    const r = rudder();
    // Port is negative → fill grows to the LEFT of centre.
    return r !== undefined && r < 0 ? 50 - rudPct() : 50;
  };
  return (
    <div class="rounded-md border border-line-2 bg-chrome-2 px-[9px] py-2">
      <h3 class="mb-[5px] font-mono text-[8.5px] font-bold tracking-[0.07em] text-fg-3">
        RUDDER <span class="text-fg-2">read-only indicator</span>
      </h3>
      <div class="relative h-[26px] overflow-hidden rounded border border-line bg-chrome">
        <div
          class="absolute bottom-0 top-0 bg-ok opacity-55 transition-[width,left] duration-[var(--duration-fast)] ease-out"
          style={{ left: `${rudLeft()}%`, width: `${rudPct()}%` }}
        />
        <div class="absolute bottom-0 left-1/2 top-0 z-[2] w-px bg-fg-3" />
        <div class="absolute inset-0 z-[3] flex items-end justify-between px-[3px] font-mono text-[7.5px] text-fg-3">
          <span>P35</span>
          <span>0</span>
          <span>S35</span>
        </div>
        <div class="absolute inset-0 z-[4] flex items-center justify-center font-mono text-[11px] font-semibold tabular-nums text-fg">
          {rudTxt(rudder())}
        </div>
      </div>
      <div class="mt-1 font-mono text-[10px] text-fg-2">
        beside AP state, always — hard-over while engaged with the heading not
        changing is a fault you must see
      </div>
    </div>
  );
};

// `Widget.render` is `(inst, density) => JSX.Element`; these ignore both
// (closing over signalk/controller instead) so ./index.ts can stay plain .ts.
export const apControlCell =
  (signalk: SignalKState, controller?: AutopilotController) => () =>
    <ApControl signalk={signalk} controller={controller} />;

export const apRudderCell = (signalk: SignalKState) => () => <ApRudder signalk={signalk} />;
