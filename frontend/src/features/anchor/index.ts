// Anchor watch — a front-end to SignalK's anchoralarm plugin (anchor.md).
// The plugin watches (on the always-on box, alarms reach the MFD with every
// browser closed); this feature shows its state on the chart, puts its alarm
// in the reserved band, and commands it from the anchor mode's sheet.
//
// Contributes: the `anchor.watch` rail readout (alarm-grade — the plugin's
// notification decides urgency, never our own arithmetic), the chart
// overlay, the `anchor` mode (a tool-stack button like Weather/Route, whose
// sheet is the control card — ./sheet.tsx), the hidden `anchor-place` mode
// and palette commands.

import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js";
import { defineFeature, type AppFeature } from "../../core/chrome/feature";
import type { Instrument, Urgency } from "../../core/chrome/registry";
import { defineCommand } from "../../core/chrome/command";
import type { SignalKState } from "../../core/signalk";
import type { GeoPoint } from "../../core/chrome/geo";
import { createAnchorController, type AnchorController, type TrackFix } from "./client";
import {
  anchorAlertText,
  anchorLive,
  anchorPhase,
  anchorPoint,
  anchorReading,
  anchorUrgency,
  isAlarming,
  isAnchored,
  metres,
} from "./model";
import { createAnchorOverlay, type AnchorScene } from "./overlay";
import type { AnchorControlProps } from "./ui";

/** The tool-stack mode whose sheet is the anchor control card. */
export const ANCHOR_MODE_ID = "anchor";

export interface AnchorDeps {
  signalk: SignalKState;
  /** Injected by tests; the app builds the real one. */
  controller?: AnchorController;
  /** Test seam for the track poll. */
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (id: ReturnType<typeof setInterval>) => void;
}

export interface AnchorFeature {
  feature: AppFeature;
  /** App binds these once the mode state exists (routes' `bindEnter` idiom). */
  bindMode: (opts: { enter: (id: string) => void; leave: () => void }) => void;
  scene: Accessor<AnchorScene>;
  /** What the card's "place/move on chart" runs: swap the sheet for the
   * `anchor-place` mode with `radiusM` (`null` = keep it unarmed, the rode
   * still going out); the next chart tap moves the anchor
   * there and brings the sheet back. */
  placeOnChart: (radiusM: number | null) => void;
  /** The control card's props, for the mode sheet (./sheet.tsx). */
  control: AnchorControlProps;
}

/** How often the plugin's minute-by-minute track is re-read while anchored. */
const TRACK_POLL_MS = 60_000;
/** The live tail between polls: a fix is kept once the boat has moved this
 * far from the last kept one — GPS jitter at rest is not a swing. */
const TAIL_MIN_STEP_M = 2;
const TAIL_MAX = 3_000;


export function createAnchor(deps: AnchorDeps): AnchorFeature {
  const { signalk } = deps;
  const controller = deps.controller ?? createAnchorController();
  const every = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const stopEvery = deps.clearInterval ?? ((id) => clearInterval(id));

  const phase = createMemo(() => anchorPhase(signalk.anchor()));
  const point = createMemo(() => anchorPoint(signalk.anchor()), undefined, {
    equals: (a, b) => a?.lat === b?.lat && a?.lng === b?.lng,
  });
  const boat = (): GeoPoint | null => {
    const s = signalk.self();
    return s ? { lng: s.lng, lat: s.lat } : null;
  };

  // -- the swing track: the plugin's minute fixes + this screen's tail ------
  const [pluginTrack, setPluginTrack] = createSignal<TrackFix[]>([]);
  const [tail, setTail] = createSignal<TrackFix[]>([]);
  let generation = 0;
  const loadTrack = () => {
    const gen = generation;
    void controller.track().then((fixes) => {
      if (gen === generation) setPluginTrack(fixes);
    });
  };
  // Re-armed on every anchor POSITION change (a drop, a move), cleared on
  // raise: a track belongs to one anchoring.
  createEffect(
    on(point, (at) => {
      generation++;
      setPluginTrack([]);
      setTail([]);
      if (!at) return;
      loadTrack();
      const id = every(loadTrack, TRACK_POLL_MS);
      onCleanup(() => stopEvery(id));
    }),
  );
  createEffect(() => {
    const b = boat();
    if (!b || !isAnchored(signalk.anchor())) return;
    setTail((prev) => {
      const last = prev[prev.length - 1];
      if (last && metres(b, { lng: last[0], lat: last[1] }) < TAIL_MIN_STEP_M) return prev;
      const next: TrackFix[] = [...prev, [b.lng, b.lat, Date.now()]];
      return next.length > TAIL_MAX ? next.slice(next.length - TAIL_MAX) : next;
    });
  });
  const track = createMemo<TrackFix[]>(() => {
    const plugin = pluginTrack();
    const lastT = plugin.length > 0 ? plugin[plugin.length - 1]![2] : -Infinity;
    // The tail's clock is this browser's and the plugin's is the server's;
    // both are wall clocks on one LAN, so "newer than the last minute fix"
    // is close enough for a line that only fades with age.
    return [...plugin, ...tail().filter((f) => f[2] > lastT)];
  });
  const maxSeenM = createMemo(() => {
    const at = point();
    if (!at) return undefined;
    let max = signalk.anchor()?.currentRadiusM;
    for (const f of track()) {
      const d = metres(at, { lng: f[0], lat: f[1] });
      if (max === undefined || d > max) max = d;
    }
    return max;
  });

  const scene = createMemo<AnchorScene>(() => ({
    anchor: signalk.anchor(),
    boat: isAnchored(signalk.anchor()) ? boat() : null,
    track: track(),
  }));

  // -- link staleness: the SignalK LINK, not the fix ------------------------
  // A lost fix is itself an anchor alarm, and the plugin raises it; greying
  // out on fix age would suppress exactly that. What this screen cannot vouch
  // for is a dead link to the backend — then every number is last-known.
  const [lostAt, setLostAt] = createSignal<number | null>(null);
  createEffect(
    on(signalk.status, (s) => setLostAt(anchorLive(s) ? null : (lostAt() ?? Date.now()))),
  );

  // -- the place-on-chart mode ----------------------------------------------
  let enterMode = (_id: string) => {};
  let leaveMode = () => {};
  // Boxed: `null` inside is a real choice (place unarmed), `null` outside is
  // "not armed by the sheet".
  const [placing, setPlacing] = createSignal<{ radiusM: number | null } | null>(null);
  // Entering replaces the anchor mode (one mode at a time), so the sheet
  // steps aside for the tap rather than covering the chart under it.
  const placeOnChart = (radiusM: number | null) => {
    enterMode("anchor-place");
    setPlacing({ radiusM });
  };

  const watch: Instrument = {
    id: "anchor.watch",
    short: "ANC",
    label: "Anchor watch",
    band: "rail",
    maxUrgency: "alarm",
    // Present while anchored (dropping too), and while the plugin alarms at
    // all. Its "No position received" alarm outlives a raise: anchoralarm
    // 2.0.1 never clears it (the clear branch tests `alarmSent === null`, a
    // boolean), not on the fix returning nor on raise; only a drag alarm and
    // its return overwrite it. ACK is the only way to quiet it.
    when: () => isAnchored(signalk.anchor()) || isAlarming(signalk.anchor()),
    staleAge: () => {
      const t = lostAt();
      return t === null ? null : Math.max(0, Math.round((Date.now() - t) / 1000));
    },
    urgency: (): Urgency => anchorUrgency(signalk.anchor()),
    read: () => anchorReading(signalk.anchor()),
    alertText: () => anchorAlertText(signalk.anchor()),
    // The strip's ACK acknowledges on the SERVER: quiet on every display and
    // the MFD too (Q5). The local ack still hides it here at once.
    onAck: () => {
      const alarm = signalk.anchor()?.alarm;
      if (alarm?.id && !alarm.acknowledged && alarm.canAcknowledge !== false) void controller.ack(alarm.id);
    },
    // SignalK's own method decides: an unACKed anchor emergency sounds even
    // with the collision-alarm opt-in off (Q3: "sound and visual").
    alertCritical: true,
    alertSound: () => {
      const alarm = signalk.anchor()?.alarm;
      return !!alarm && alarm.sound && !alarm.acknowledged;
    },
  };

  const control: AnchorControlProps = { signalk, controller, maxSeenM, placeOnChart };

  const feature = defineFeature({
    id: "anchor",
    instruments: [watch],
    overlay: createAnchorOverlay(scene),
    modes: [
      {
        id: ANCHOR_MODE_ID,
        label: "Anchor",
        // Solo like weather: the sheet is the surface, the helm tiles step
        // aside. No onClick — a tap still asks "what is here?".
        solo: true,
      },
      {
        id: "anchor-place",
        label: "Place anchor",
        // Reached from the anchor sheet only — a tool-row button would have
        // no "with what radius?" behind it.
        hidden: true,
        leave: () => setPlacing(null),
        hint: () =>
          phase() === "up" ? "Tap where you dropped the anchor" : "Tap where the anchor really is",
        onClick: (click) => {
          const p = placing();
          if (p === null) {
            leaveMode();
            return true;
          }
          void controller.move(click.lngLat.lat, click.lngLat.lng, p.radiusM);
          // Back to the sheet, to watch the move land.
          enterMode(ANCHOR_MODE_ID);
          return true;
        },
        pill: () => {
          const p = placing();
          if (!p) return {};
          return { status: p.radiusM === null ? "no alarm yet" : `watch ${p.radiusM} m` };
        },
      },
    ],
    commands: (cmd) => {
      const live = anchorLive(signalk.status());
      const open = () => {
        if (cmd.activeMode() !== ANCHOR_MODE_ID) enterMode(ANCHOR_MODE_ID);
      };
      return [
        defineCommand({
          id: "anchor-open",
          label: "Anchor watch",
          group: "Navigation",
          hint: "Drop, watch and raise the anchor",
          keywords: ["anchor", "anker", "drag", "swing", "alarm"],
          run: (ctx) => {
            open();
            ctx.close();
          },
        }),
        ...(phase() === "up" && live
          ? [
              defineCommand({
                id: "anchor-drop",
                label: "Drop anchor here",
                group: "Navigation",
                hint: "Mark the anchor at the bow — arm the alarm once it is set",
                keywords: ["anchor", "anker", "drop"],
                run: (ctx) => {
                  void controller.drop();
                  open();
                  ctx.close();
                },
              }),
            ]
          : []),
      ];
    },
  });

  return {
    feature,
    scene,
    placeOnChart,
    control,
    bindMode: (opts) => {
      enterMode = opts.enter;
      leaveMode = opts.leave;
    },
  };
}
