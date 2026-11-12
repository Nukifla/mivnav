// The auto-routing settings declaration — safety depth/margin and four
// optional soft preferences (shallow-water, TSS avoidance, fairway
// preference, buoyage-side avoidance) for POST /routing/plan
// (mivnav.features.routing.config.RoutingConfig). Same generated-boat-
// setting shape as `settings/boat.tsx`'s nav declarations (`boatSetting`
// there, `routingSetting` here — same routing-onto-ServerConfigController
// contract, just addressed under this section's own scope/group so a
// refused write here never lights up the nav section's feedback and vice
// versa).
//
// Shares the "Routes" settings pane with `nav`/"Route following", but as
// separate sections: `nav` (the `route` feature) ADVANCES an already-planned
// leg; `routing` (this feature) COMPUTES the path in the first place.
// Different backend features — the section headings keep them apart. The
// router's own settings split three ways (general / soft preferences /
// per-engine knobs) so the ~30 controls aren't one undifferentiated list.

import Cpu from "lucide-solid/icons/cpu";
import FlaskConical from "lucide-solid/icons/flask-conical";
import Route from "lucide-solid/icons/route";
import SlidersHorizontal from "lucide-solid/icons/sliders-horizontal";
import { For, Show, type Component } from "solid-js";
import {
  artifactStatusLabel,
  createMivnavBuild,
  type MivnavArtifactEntry,
} from "../mivnavBuild";
import { coerceFiniteNumber } from "../persist";
import { pollRouteIQAccessRequest, startRouteIQAccessRequest } from "../routeiqAccess";
import { createSignalKAccess } from "../signalkAccess";
import type { ConfigPatch, RoutingServerConfig, ServerConfig } from "../serverConfig";
import { Button } from "../ui/Button";
import type { SettingsCtx } from "./ctx";
import { formatBytes, progressPercent } from "./DatasetList";
import {
  defineSetting,
  defineSettingsSection,
  type Control,
  type CustomControlProps,
  type Setting,
  type SettingValue,
  type SettingsSection,
} from "./registry";

/** The feedback scope every routing write is addressed under. */
const ROUTING_SCOPE = "routing";

/** The three sections the router's settings render under, in pane order. */
const ROUTING_SECTION_ID = "routing";
const ROUTING_PREFS_SECTION = "routing-prefs";
const ROUTING_ENGINES_SECTION = "routing-engines";
const BETA_SECTION = "beta";

/** Auto-router sections show only while "Beta autorouting" is on. */
const autoroutingOff = (ctx: SettingsCtx): boolean => ctx.cfg.config()?.routing.beta_enabled !== true;

/** Route one declared routing setting onto the server controller — same
 * shape as `boat.tsx`'s `boatSetting`, addressed under `ROUTING_SCOPE`/
 * the `"routing"` group instead of `nav`'s. */
function routingSetting(opts: {
  id: string;
  group: string;
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
    group: opts.group,
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
      ctx.cfg.patch(opts.toPatch(value), { scope: ROUTING_SCOPE, done: opts.done }),
  });
}

// This section's own feedback — same display-only custom control shape as
// `boat.tsx`'s `NavFeedback`, addressed under `ROUTING_SCOPE` instead.
const RoutingFeedback: Component<CustomControlProps<SettingsCtx>> = (props) => {
  const cfg = () => props.ctx.cfg;
  const shown = () => cfg().scope() === ROUTING_SCOPE;
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

const ROUTEIQ_MESSAGE_CLASS = {
  idle: "text-fg-2",
  pending: "text-notice",
  granted: "text-ok",
  denied: "text-alarm",
  error: "text-alarm",
} as const;

/**
 * Obtaining the RouteIQ plugin's own write token, via the SAME SignalK
 * device access-request flow the autopilot's write access uses
 * (`ServerSettings.tsx`'s `WriteAccess`) — reuses `createSignalKAccess`'s
 * own state machine wholesale (`signalkAccess.ts`), pointed at this
 * feature's own endpoints (`routeiqAccess.ts`) instead. A SEPARATE grant
 * from the autopilot's: confirmed live against a real signalk-routeiq
 * install that every one of its own routes needs a login, even though the
 * plain SignalK REST API beside it does not — see
 * `mivnav.features.routing.routeiq`'s own module docstring.
 *
 * Reflects `meta.routeiq_token_set` the same way `WriteAccess` reflects
 * `meta.signalk_token_set` — a sailor who already connected should not be
 * nudged to reconnect.
 */
const RouteIQAccess: Component<CustomControlProps<SettingsCtx>> = (props) => {
  const access = createSignalKAccess({
    request: startRouteIQAccessRequest,
    poll: pollRouteIQAccessRequest,
    onGranted: () => void props.ctx.cfg.refresh(),
    grantedMessage: "Access granted. RouteIQ can now be picked as the routing algorithm.",
  });
  const connected = () => props.ctx.cfg.meta()?.routeiq_token_set ?? false;

  return (
    <div class="space-y-1 border-t border-line-2 pt-2">
      <div class="flex items-baseline justify-between gap-2">
        <span class="text-xs font-medium text-fg-2">RouteIQ access</span>
        <span class={`shrink-0 text-xs ${connected() ? "text-ok" : "text-fg-3"}`}>
          {connected() ? "connected" : "not connected"}
        </span>
      </div>
      <p class="text-xs text-fg-3">
        {connected()
          ? "This server holds a RouteIQ access token. Request again only to replace it."
          : "RouteIQ needs its own access grant from the SignalK server, separate from mivnav's admin access."}
      </p>
      <Button disabled={access.busy()} onClick={() => void access.start()}>
        {access.busy() ? "Waiting for approval…" : connected() ? "Request access again" : "Request access"}
      </Button>
      <Show when={access.message()}>
        <p class={`text-xs ${ROUTEIQ_MESSAGE_CLASS[access.phase()]}`}>{access.message()}</p>
      </Show>
    </div>
  );
};

const ARTIFACT_TONE = {
  ok: "text-ok",
  notice: "text-notice",
  muted: "text-fg-3",
} as const;

/**
 * The v3 `.mivnav` precomputed-artifact build trigger — shown only when
 * the `"mivnav"` algorithm is selected, since it is the one thing that
 * makes that algorithm actually READ a precompute instead of rebuilding
 * the topology per request.
 *
 * `GET /routing/mivnav/artifacts` is rendered first: it is what tells a
 * sailor their artifact went stale (charts changed under it, or an older
 * mivnav built it). "Build" is `POST /routing/mivnav/build` — a
 * minutes-of-Pi-CPU background job, polled here through
 * `createMivnavBuild`. This never fires on its own: a build is only ever
 * started by the button below (repeated project decision — an
 * `O(bands × region)` build as a side effect of installing charts would
 * wedge the boat's server exactly when a sailor is loading charts).
 */
const MivnavBuild: Component<CustomControlProps<SettingsCtx>> = (props) => {
  const shown = () => (props.ctx.cfg.config()?.routing.algorithm ?? "raster") === "mivnav";
  const ctl = createMivnavBuild();
  const job = ctl.job;
  const percent = () => {
    const j = job();
    return j ? progressPercent(j.current, j.total) : null;
  };
  const multiSet = () => ctl.artifacts().length > 1;
  const buildOne = (entry: MivnavArtifactEntry) =>
    void ctl.build(multiSet() ? entry.chart_set_id : undefined);

  return (
    <Show when={shown()}>
      <div class="space-y-1.5 border-t border-line-2 pt-2">
        <div class="flex items-baseline justify-between gap-2">
          <span class="text-xs font-medium text-fg-2">Precomputed routing artifact</span>
          <button
            type="button"
            class="shrink-0 text-xs text-fg-3 underline decoration-dotted hover:text-fg-2"
            onClick={() => void ctl.refresh()}
          >
            refresh
          </button>
        </div>
        <p class="text-xs text-fg-3">
          The v3 mivnav engine reads this per-chart-set precompute instead of rebuilding its
          topology on every request. A build takes minutes of the server's CPU, runs in the
          background, and is only ever started here. Status is for the current CATZOC
          allowance; one built under another mode shows as not built.
        </p>

        <Show
          when={ctl.loaded()}
          fallback={<p class="text-xs text-fg-3">Loading…</p>}
        >
          <Show
            when={ctl.artifacts().length > 0}
            fallback={<p class="text-xs text-fg-3">No chart sets are installed.</p>}
          >
            <ul class="space-y-1">
              <For each={ctl.artifacts()}>
                {(entry) => {
                  const status = () => artifactStatusLabel(entry);
                  return (
                    <li class="flex items-center justify-between gap-2 rounded border border-line-2 bg-chrome-2/50 px-1.5 py-1">
                      <div class="min-w-0">
                        <div class="truncate text-xs text-fg-2">{entry.chart_set_id}</div>
                        <div class={`text-[11px] ${ARTIFACT_TONE[status().tone]}`}>
                          {status().text}
                          <Show when={entry.usable && (entry.bytes ?? 0) > 0}>
                            {" · "}
                            {formatBytes(entry.bytes ?? 0)}
                          </Show>
                          <Show when={(entry.cells ?? 0) > 0}>
                            {" · "}
                            {entry.cells} cells
                          </Show>
                        </div>
                      </div>
                      <Button
                        class="shrink-0"
                        disabled={ctl.busy() || ctl.running()}
                        onClick={() => buildOne(entry)}
                      >
                        {entry.usable ? "Rebuild" : "Build"}
                      </Button>
                    </li>
                  );
                }}
              </For>
            </ul>
          </Show>
        </Show>

        <Show when={job() && job()!.state !== "idle"}>
          <div class="space-y-1 rounded border border-line-2 bg-chrome-2/60 p-1.5">
            <div class="flex items-center justify-between gap-2 text-[11px] text-fg-2">
              <span class="truncate">
                {job()!.error === "cancelled"
                  ? "Cancelled"
                  : job()!.state === "done"
                    ? "Done"
                    : job()!.state === "error"
                      ? `Error: ${job()!.error || "unknown"}`
                      : job()!.task || job()!.detail || job()!.state}
              </span>
              <Show when={job()!.total > 0}>
                <span class="shrink-0 tabular-nums">
                  {job()!.current}/{job()!.total}
                </span>
              </Show>
            </div>
            <Show when={ctl.running()}>
              <div class="h-1.5 w-full overflow-hidden rounded-full bg-line">
                <Show
                  when={percent() !== null}
                  fallback={<div class="h-full w-1/3 animate-pulse rounded-full bg-accent" />}
                >
                  <div
                    class="h-full rounded-full bg-accent transition-[width]"
                    style={{ width: `${percent()}%` }}
                  />
                </Show>
              </div>
            </Show>
            <Show when={job()!.state === "done" && job()!.tile_count > 0}>
              <p class="text-[11px] text-fg-3">
                {formatBytes(job()!.bytes)} · {job()!.tile_count} tiles · {job()!.bands} bands ·{" "}
                {job()!.portals} portals · {job()!.total_cells.toLocaleString()} cells
                <Show when={(job()!.build_seconds ?? 0) > 0}>
                  {" · "}
                  {Math.round(job()!.decode_seconds ?? 0)}s decode + {Math.round(job()!.build_seconds ?? 0)}s build
                </Show>
              </p>
            </Show>
            <Show when={job()!.log.length > 0}>
              <pre class="max-h-24 overflow-y-auto rounded bg-chrome p-1 text-[10px] leading-snug whitespace-pre-wrap break-all text-fg-3">
                {[...job()!.log].reverse().join("\n")}
              </pre>
            </Show>
            <Show when={ctl.running()}>
              <Button disabled={ctl.busy()} onClick={() => void ctl.cancel()}>
                Cancel
              </Button>
            </Show>
          </div>
        </Show>

        <Show when={ctl.error()}>
          <p class="text-xs text-alarm">{ctl.error()}</p>
        </Show>
      </div>
    </Show>
  );
};

/**
 * Safety depth/margin/air-draft (all HARD thresholds — crossing them is
 * never allowed), plus seven soft preferences — shallow-water
 * (`shallow_avoidance_radius_m`/`_weight`), TSS avoidance
 * (`tss_avoidance_weight`), fairway preference
 * (`fairway_preference_weight`), buoyage-side avoidance
 * (`iala_region`/`buoyage_avoidance_radius_m`/`_weight`), cable/pipeline
 * avoidance (`cable_avoidance_weight`), caution-area avoidance
 * (`caution_area_avoidance_weight`), and low-confidence-survey avoidance
 * (`low_confidence_survey_avoidance_weight`) — see
 * `chartcore::routing::raster::shortest_path_weighted`'s own docs for the
 * mechanism each drives: every weight `0` is OFF (today's plain
 * shortest-distance search). `air_draft_m` is ALSO `0` by default, but
 * unlike the soft preferences that is not "off until validated" — see its
 * own setting's help text for why a hard hazard has no safe non-zero
 * default to fall back on. Shallow-water decays linearly from its own
 * weight at the hard margin's own edge to `0` by its own radius; TSS/
 * fairway/buoyage-side/cable/caution/low-confidence-survey are all flat
 * in-zone terms, no
 * distance falloff — TSS/fairway/cable/caution/low-confidence-survey are
 * charted zones with no
 * radius of their own; buoyage-side is a computed (not charted) zone, a
 * half-disc within its own `buoyage_avoidance_radius_m` of a lateral
 * mark, flat within that.
 * Defaults track `RoutingConfig`'s own Pydantic model.
 */
export const ROUTING_SETTINGS: readonly Setting<SettingsCtx>[] = [
  routingSetting({
    id: "routing.beta_enabled",
    group: BETA_SECTION,
    control: { kind: "toggle" },
    label: "Beta autorouting",
    help: "Plan routes automatically around charted hazards. Off hides the route editor, Go here, and the auto-routing settings.",
    order: 10,
    default: false,
    coerce: (raw) => raw === true,
    read: (config) => config.routing.beta_enabled === true,
    toPatch: (value) => ({ routing: { beta_enabled: value as boolean } }),
    done: "Saved.",
    writeSideEffect: "Shows or hides the auto-router on every screen.",
  }),
  routingSetting({
    id: "routing.algorithm",
    group: ROUTING_SECTION_ID,
    control: {
      kind: "enum",
      options: ["raster", "routeiq", "graph", "artifact", "mivnav"],
      as: "select",
      labels: {
        raster: "Built-in (chartcore raster grid)",
        routeiq: "RouteIQ (remote, via SignalK)",
        graph: "Adaptive graph (local, experimental)",
        artifact: "v3 artifact model (strict hazards, deterministic)",
        mivnav: "v3 mivnav (artifact + topology diagnostics, testing)",
      },
    },
    label: "Routing algorithm",
    help: "Which engine plans routes. Built-in is the default. RouteIQ calls the signalk-routeiq plugin on the SignalK server (needs access, under Engine options; it only has data for a few test regions so far). Adaptive graph is a local, experimental take on RouteIQ's approach. v3 artifact adds stricter hard limits (construction, unsurveyed water, single shallow soundings, survey-confidence buffers) and returns the same route every time. v3 mivnav routes exactly like v3 artifact for now, plus topology diagnostics — for testing.",
    order: 5,
    default: "raster",
    coerce: (raw) =>
      raw === "routeiq" || raw === "graph" || raw === "artifact" || raw === "mivnav"
        ? raw
        : "raster",
    read: (config) => config.routing.algorithm,
    toPatch: (value) => ({
      routing: { algorithm: value as "raster" | "routeiq" | "graph" | "artifact" | "mivnav" },
    }),
    done: "Saved.",
    writeSideEffect: "Affects every route plan request from here on.",
  }),
  routingSetting({
    id: "routing.default_draft_m",
    group: ROUTING_SECTION_ID,
    control: { kind: "number", min: 0.1, max: 20, step: 0.1, as: "field" },
    label: "Default draft (m)",
    help: "Used only when SignalK reports no draft. Better to have SignalK report the real one.",
    order: 10,
    default: 2.0,
    coerce: (raw) => coerceFiniteNumber(raw, 2.0),
    read: (config) => config.routing.default_draft_m,
    toPatch: (value) => ({ routing: { default_draft_m: value as number } }),
    done: "Saved.",
    writeSideEffect: "Affects the next route plan request that has no draft of its own to fall back on.",
  }),
  routingSetting({
    id: "routing.under_keel_margin_m",
    group: ROUTING_SECTION_ID,
    control: { kind: "number", min: 0, max: 10, step: 0.1, as: "field" },
    label: "Under-keel margin (m)",
    help: "Added to the draft to give the shallowest depth the router will use — allowance for squat, tide and sounder error.",
    order: 20,
    default: 1.0,
    coerce: (raw) => coerceFiniteNumber(raw, 1.0),
    read: (config) => config.routing.under_keel_margin_m,
    toPatch: (value) => ({ routing: { under_keel_margin_m: value as number } }),
    done: "Saved.",
    writeSideEffect: "Affects every route plan request from here on.",
  }),
  routingSetting({
    id: "routing.lateral_margin_m",
    group: ROUTING_SECTION_ID,
    control: { kind: "number", min: 0, max: 500, step: 1, as: "field" },
    label: "Lateral clearance (m)",
    help: "Preferred distance from a charted hazard. A soft pull: a narrower safe gap is still used, and land or charted danger is never touched. v3 artifact and v3 mivnav treat it as a hard buffer instead.",
    order: 30,
    default: 30,
    coerce: (raw) => coerceFiniteNumber(raw, 30),
    read: (config) => config.routing.lateral_margin_m,
    toPatch: (value) => ({ routing: { lateral_margin_m: value as number } }),
    done: "Saved.",
    writeSideEffect: "Affects every route plan request from here on.",
  }),
  routingSetting({
    id: "routing.air_draft_m",
    group: ROUTING_SECTION_ID,
    control: { kind: "number", min: 0, max: 100, step: 0.1, as: "field" },
    label: "Air draft (m)",
    help: "Mast height above the waterline. Bridges and overhead cables lower than this are never routed under. 0 = don't check (the default) — set the boat's real figure.",
    order: 25,
    default: 0,
    coerce: (raw) => coerceFiniteNumber(raw, 0),
    read: (config) => config.routing.air_draft_m,
    toPatch: (value) => ({ routing: { air_draft_m: value as number } }),
    done: "Saved.",
    writeSideEffect: "Affects every route plan request from here on — a nonzero air draft makes the router also check bridge/overhead-cable clearance.",
  }),
  routingSetting({
    id: "routing.shallow_avoidance_radius_m",
    group: ROUTING_PREFS_SECTION,
    control: { kind: "number", min: 0, max: 5000, step: 10, as: "field" },
    label: "Shallow-water avoidance radius (m)",
    help: "How far beyond a hazard's edge the shallow-water pull reaches, on top of the lateral clearance. 0 = off.",
    order: 40,
    default: 0,
    coerce: (raw) => coerceFiniteNumber(raw, 0),
    read: (config) => config.routing.shallow_avoidance_radius_m,
    toPatch: (value) => ({ routing: { shallow_avoidance_radius_m: value as number } }),
    done: "Saved.",
    writeSideEffect: "Affects every route plan request from here on — a nonzero radius makes near-hazard requests pay the full search every time (see the backend's own routing.log for what that costs).",
  }),
  routingSetting({
    id: "routing.shallow_avoidance_weight",
    group: ROUTING_PREFS_SECTION,
    control: { kind: "number", min: 0, max: 5, step: 0.1, as: "field" },
    label: "Shallow-water avoidance strength",
    help: "How strongly to favour deeper water near hazards, when it costs little distance.",
    order: 50,
    default: 0,
    coerce: (raw) => coerceFiniteNumber(raw, 0),
    read: (config) => config.routing.shallow_avoidance_weight,
    toPatch: (value) => ({ routing: { shallow_avoidance_weight: value as number } }),
    done: "Saved.",
    writeSideEffect: "Affects every route plan request from here on.",
  }),
  routingSetting({
    id: "routing.tss_avoidance_weight",
    group: ROUTING_PREFS_SECTION,
    control: { kind: "number", min: 0, max: 5, step: 0.1, as: "field" },
    label: "TSS avoidance strength",
    help: "Detour around traffic-separation lanes, roundabouts, crossings and precautionary areas rather than sail through them. Still crosses directly, and briefly, when there is no reasonable way round.",
    order: 52,
    default: 0,
    coerce: (raw) => coerceFiniteNumber(raw, 0),
    read: (config) => config.routing.tss_avoidance_weight,
    toPatch: (value) => ({ routing: { tss_avoidance_weight: value as number } }),
    done: "Saved.",
    writeSideEffect: "Affects every route plan request from here on.",
  }),
  routingSetting({
    id: "routing.fairway_preference_weight",
    group: ROUTING_PREFS_SECTION,
    control: { kind: "number", min: 0, max: 0.9, step: 0.05, as: "field" },
    label: "Preferred-route strength",
    help: "Prefer marked fairways, recommended tracks, leading lines and deep-water routes when one actually connects start and end.",
    order: 54,
    default: 0,
    coerce: (raw) => coerceFiniteNumber(raw, 0),
    read: (config) => config.routing.fairway_preference_weight,
    toPatch: (value) => ({ routing: { fairway_preference_weight: value as number } }),
    done: "Saved.",
    writeSideEffect: "Affects every route plan request from here on — a nonzero value makes near-fairway requests pay the full search every time.",
  }),
  routingSetting({
    id: "routing.iala_region",
    group: ROUTING_PREFS_SECTION,
    control: { kind: "enum", options: ["A", "B"], as: "select", labels: { A: "A (Europe, most of the world)", B: "B (Americas, Japan, Korea, Philippines)" } },
    label: "IALA buoyage region",
    help: "Which colour is port and which starboard, for a lateral mark that doesn't say. Only a fallback — the chart's own region wins.",
    order: 56,
    default: "A",
    coerce: (raw) => (raw === "B" ? "B" : "A"),
    read: (config) => config.routing.iala_region,
    toPatch: (value) => ({ routing: { iala_region: value as "A" | "B" } }),
    done: "Saved.",
    writeSideEffect: "Affects every route plan request from here on, for a corridor whose own charts declare no IALA region.",
  }),
  routingSetting({
    id: "routing.buoyage_avoidance_radius_m",
    group: ROUTING_PREFS_SECTION,
    control: { kind: "number", min: 0, max: 1000, step: 10, as: "field" },
    label: "Buoyage-side avoidance radius (m)",
    help: "How far from a lateral mark the wrong-side preference reaches. 0 = off.",
    order: 57,
    default: 0,
    coerce: (raw) => coerceFiniteNumber(raw, 0),
    read: (config) => config.routing.buoyage_avoidance_radius_m,
    toPatch: (value) => ({ routing: { buoyage_avoidance_radius_m: value as number } }),
    done: "Saved.",
    writeSideEffect: "Affects every route plan request from here on — a nonzero radius makes near-mark requests pay the full search every time.",
  }),
  routingSetting({
    id: "routing.buoyage_avoidance_weight",
    group: ROUTING_PREFS_SECTION,
    control: { kind: "number", min: 0, max: 5, step: 0.1, as: "field" },
    label: "Buoyage-side avoidance strength",
    help: "Pass lateral marks on their correct side for the direction sailed. Lateral marks only, not cardinals.",
    order: 58,
    default: 0,
    coerce: (raw) => coerceFiniteNumber(raw, 0),
    read: (config) => config.routing.buoyage_avoidance_weight,
    toPatch: (value) => ({ routing: { buoyage_avoidance_weight: value as number } }),
    done: "Saved.",
    writeSideEffect: "Affects every route plan request from here on.",
  }),
  routingSetting({
    id: "routing.cable_avoidance_weight",
    group: ROUTING_PREFS_SECTION,
    control: { kind: "number", min: 0, max: 5, step: 0.1, as: "field" },
    label: "Cable/pipeline avoidance strength",
    help: "Avoid running along submarine cables and pipelines. Crossing one briefly costs little.",
    order: 58.2,
    default: 0,
    coerce: (raw) => coerceFiniteNumber(raw, 0),
    read: (config) => config.routing.cable_avoidance_weight,
    toPatch: (value) => ({ routing: { cable_avoidance_weight: value as number } }),
    done: "Saved.",
    writeSideEffect: "Affects every route plan request from here on.",
  }),
  routingSetting({
    id: "routing.caution_area_avoidance_weight",
    group: ROUTING_PREFS_SECTION,
    control: { kind: "number", min: 0, max: 5, step: 0.1, as: "field" },
    label: "Caution-area avoidance strength",
    help: "Avoid anchorages, caution areas, and restricted or military-practice areas you may transit. Entry-prohibited areas are always blocked regardless.",
    order: 58.4,
    default: 0,
    coerce: (raw) => coerceFiniteNumber(raw, 0),
    read: (config) => config.routing.caution_area_avoidance_weight,
    toPatch: (value) => ({ routing: { caution_area_avoidance_weight: value as number } }),
    done: "Saved.",
    writeSideEffect: "Affects every route plan request from here on.",
  }),
  routingSetting({
    id: "routing.low_confidence_survey_avoidance_weight",
    group: ROUTING_PREFS_SECTION,
    control: { kind: "number", min: 0, max: 5, step: 0.1, as: "field" },
    label: "Low-confidence-survey avoidance strength",
    help: "Avoid water charted from a poor survey (CATZOC C, D or unassessed) — even on a large-scale chart.",
    order: 58.5,
    default: 0,
    coerce: (raw) => coerceFiniteNumber(raw, 0),
    read: (config) => config.routing.low_confidence_survey_avoidance_weight,
    toPatch: (value) => ({ routing: { low_confidence_survey_avoidance_weight: value as number } }),
    done: "Saved.",
    writeSideEffect: "Affects every route plan request from here on.",
  }),
  routingSetting({
    id: "routing.turn_cost_weight",
    group: ROUTING_PREFS_SECTION,
    control: { kind: "number", min: 0, max: 5, step: 0.1, as: "field" },
    label: "Turn-cost strength",
    help: "Prefer fewer, gentler turns: a sharp turn costs more than a gentle bend. A necessary sharp turn is still taken.",
    order: 58.6,
    default: 0,
    coerce: (raw) => coerceFiniteNumber(raw, 0),
    read: (config) => config.routing.turn_cost_weight,
    toPatch: (value) => ({ routing: { turn_cost_weight: value as number } }),
    done: "Saved.",
    writeSideEffect: "Affects every route plan request from here on.",
  }),
  routingSetting({
    id: "routing.macro_route_enabled",
    group: ROUTING_SECTION_ID,
    control: { kind: "toggle" },
    label: "Route around a whole landmass when needed",
    help: "If land blocks the direct way (round a peninsula, say), find a detour around it and route along that. Off: route as far as possible, then a straight line. Bridge, lock and cable clearance along such a detour is not checked; the route warns when this fires.",
    order: 59,
    default: true,
    coerce: (raw) => raw === true,
    read: (config) => config.routing.macro_route_enabled,
    toPatch: (value) => ({ routing: { macro_route_enabled: value as boolean } }),
    done: "Saved.",
    writeSideEffect: "Affects every route plan request from here on that the ordinary search can't otherwise reach.",
  }),
  routingSetting({
    id: "routing.routeiq_beam_m",
    group: ROUTING_ENGINES_SECTION,
    control: { kind: "number", min: 0.5, max: 30, step: 0.1, as: "field" },
    label: "RouteIQ / graph: vessel beam (m)",
    help: "The boat's beam. RouteIQ gets it as a constraint; the adaptive graph keeps half of it plus the lateral clearance as a hard minimum. Set the boat's real figure.",
    order: 61,
    default: 3.5,
    coerce: (raw) => coerceFiniteNumber(raw, 3.5),
    disabledWhen: (ctx) => {
      const algorithm = ctx.cfg.config()?.routing.algorithm ?? "raster";
      return algorithm !== "routeiq" && algorithm !== "graph";
    },
    read: (config) => config.routing.routeiq_beam_m,
    toPatch: (value) => ({ routing: { routeiq_beam_m: value as number } }),
    done: "Saved.",
    writeSideEffect: "Affects every RouteIQ/adaptive-graph plan request from here on. Moot unless the algorithm above is \"routeiq\" or \"graph\".",
  }),
  routingSetting({
    id: "routing.routeiq_air_draft_m",
    group: ROUTING_ENGINES_SECTION,
    control: { kind: "number", min: 0.5, max: 100, step: 0.1, as: "field" },
    label: "RouteIQ: air draft (m)",
    help: "Sent to RouteIQ, which won't route under a bridge lower than this. Set the boat's real figure.",
    order: 62,
    default: 18,
    coerce: (raw) => coerceFiniteNumber(raw, 18),
    disabledWhen: (ctx) => (ctx.cfg.config()?.routing.algorithm ?? "raster") !== "routeiq",
    read: (config) => config.routing.routeiq_air_draft_m,
    toPatch: (value) => ({ routing: { routeiq_air_draft_m: value as number } }),
    done: "Saved.",
    writeSideEffect: "Affects every RouteIQ plan request from here on. Moot unless the algorithm above is RouteIQ.",
  }),
  routingSetting({
    id: "routing.routeiq_min_coast_distance_nm",
    group: ROUTING_ENGINES_SECTION,
    control: { kind: "number", min: 0, max: 100, step: 0.1, as: "field" },
    label: "RouteIQ: minimum coast distance (nm)",
    help: "How far offshore RouteIQ keeps a route. RouteIQ's own default is 0.5 nm.",
    order: 63,
    default: 0.5,
    coerce: (raw) => coerceFiniteNumber(raw, 0.5),
    disabledWhen: (ctx) => (ctx.cfg.config()?.routing.algorithm ?? "raster") !== "routeiq",
    read: (config) => config.routing.routeiq_min_coast_distance_nm,
    toPatch: (value) => ({ routing: { routeiq_min_coast_distance_nm: value as number } }),
    done: "Saved.",
    writeSideEffect: "Affects every RouteIQ plan request from here on. Moot unless the algorithm above is RouteIQ.",
  }),
  routingSetting({
    id: "routing.artifact_endpoint_grace_radius_m",
    group: ROUTING_ENGINES_SECTION,
    control: { kind: "number", min: 0, max: 2000, step: 10, as: "field" },
    label: "Artifact: endpoint grace radius (m)",
    help: "Within this distance of the start and destination, a route may cross uncharted or unsurveyed water (blocked everywhere else), so a marina in unsurveyed water stays reachable. Never relaxes land, depth or obstruction blocks.",
    order: 65,
    default: 150,
    coerce: (raw) => coerceFiniteNumber(raw, 150),
    disabledWhen: (ctx) => {
      const algorithm = ctx.cfg.config()?.routing.algorithm ?? "raster";
      return algorithm !== "artifact" && algorithm !== "mivnav";
    },
    read: (config) => config.routing.artifact_endpoint_grace_radius_m,
    toPatch: (value) => ({ routing: { artifact_endpoint_grace_radius_m: value as number } }),
    done: "Saved.",
    writeSideEffect: "Affects every artifact/mivnav-algorithm plan request from here on. Moot unless the algorithm above is the v3 artifact model or v3 mivnav.",
  }),
  routingSetting({
    id: "routing.artifact_catzoc_allowance_mode",
    group: ROUTING_ENGINES_SECTION,
    control: {
      kind: "enum",
      options: ["full", "half", "depth_only", "off"],
      as: "select",
      labels: {
        full: "Full (buffer + depth allowance)",
        half: "Half (both, halved)",
        depth_only: "Depth allowance only",
        off: "Off (matches the other algorithms)",
      },
    },
    label: "Artifact: CATZOC allowance",
    help: "How much hazards grow with poor survey confidence (CATZOC). Full widens each hazard (5 m for the best surveys, up to 1000 m for unassessed ones) and takes a depth allowance off charted depths. Half does both at half strength; Depth allowance only skips the widening. Off matches the other engines.",
    order: 66,
    default: "full",
    coerce: (raw) =>
      raw === "half" || raw === "depth_only" || raw === "off" ? raw : "full",
    disabledWhen: (ctx) => {
      const algorithm = ctx.cfg.config()?.routing.algorithm ?? "raster";
      return algorithm !== "artifact" && algorithm !== "mivnav";
    },
    read: (config) => config.routing.artifact_catzoc_allowance_mode,
    toPatch: (value) => ({
      routing: {
        artifact_catzoc_allowance_mode: value as "full" | "half" | "depth_only" | "off",
      },
    }),
    done: "Saved.",
    writeSideEffect: "Affects every artifact/mivnav-algorithm plan request from here on. Moot unless the algorithm above is the v3 artifact model or v3 mivnav.",
  }),
  routingSetting({
    id: "routing.artifact_allow_restricted_entry",
    group: ROUTING_ENGINES_SECTION,
    control: { kind: "toggle" },
    label: "Artifact: allow restricted-entry areas",
    help: "Allow entry-restricted areas, marine farms and fish stakes, which this engine otherwise blocks. Entry-prohibited areas stay blocked. Leave off unless you know the restriction doesn't apply to this boat.",
    order: 67,
    default: false,
    coerce: (raw) => raw === true,
    disabledWhen: (ctx) => {
      const algorithm = ctx.cfg.config()?.routing.algorithm ?? "raster";
      return algorithm !== "artifact" && algorithm !== "mivnav";
    },
    read: (config) => config.routing.artifact_allow_restricted_entry,
    toPatch: (value) => ({ routing: { artifact_allow_restricted_entry: value as boolean } }),
    done: "Saved.",
    writeSideEffect: "Affects every artifact/mivnav-algorithm plan request from here on. Moot unless the algorithm above is the v3 artifact model or v3 mivnav.",
  }),
  routingSetting({
    id: "routing.avoid_depth_below_m",
    group: ROUTING_ENGINES_SECTION,
    control: { kind: "number", min: 0, max: 50, step: 0.5, as: "field" },
    label: "Artifact: avoid water shallower than (m)",
    help: "Water shallower than this — but above the hard limit of draft plus under-keel margin — is used only when there is no way round. 0 = off.",
    order: 67.2,
    default: 4,
    coerce: (raw) => coerceFiniteNumber(raw, 0),
    disabledWhen: (ctx) => {
      const algorithm = ctx.cfg.config()?.routing.algorithm ?? "raster";
      return algorithm !== "artifact" && algorithm !== "mivnav";
    },
    read: (config) => config.routing.avoid_depth_below_m,
    toPatch: (value) => ({ routing: { avoid_depth_below_m: value as number } }),
    done: "Saved.",
    writeSideEffect: "Affects every artifact/mivnav-algorithm plan request from here on.",
  }),
  routingSetting({
    id: "routing.avoid_depth_weight",
    group: ROUTING_ENGINES_SECTION,
    control: { kind: "number", min: 0, max: 5, step: 0.1, as: "field" },
    label: "Artifact: shallow-water avoidance strength",
    help: "How big a detour to accept to stay out of that shallower band. Never a hard block.",
    order: 67.3,
    default: 3,
    coerce: (raw) => coerceFiniteNumber(raw, 0),
    disabledWhen: (ctx) => {
      const algorithm = ctx.cfg.config()?.routing.algorithm ?? "raster";
      return algorithm !== "artifact" && algorithm !== "mivnav";
    },
    read: (config) => config.routing.avoid_depth_weight,
    toPatch: (value) => ({ routing: { avoid_depth_weight: value as number } }),
    done: "Saved.",
    writeSideEffect: "Affects every artifact/mivnav-algorithm plan request from here on.",
  }),
  routingSetting({
    id: "routing.soft_prefer_depth_below_m",
    group: ROUTING_ENGINES_SECTION,
    control: { kind: "number", min: 0, max: 50, step: 0.5, as: "field" },
    label: "Artifact: prefer water deeper than (m)",
    help: "Water between the 'avoid' depth and this one gets a light nudge toward deeper water. Must be at least the 'avoid' depth to do anything.",
    order: 67.4,
    default: 6,
    coerce: (raw) => coerceFiniteNumber(raw, 0),
    disabledWhen: (ctx) => {
      const algorithm = ctx.cfg.config()?.routing.algorithm ?? "raster";
      return algorithm !== "artifact" && algorithm !== "mivnav";
    },
    read: (config) => config.routing.soft_prefer_depth_below_m,
    toPatch: (value) => ({ routing: { soft_prefer_depth_below_m: value as number } }),
    done: "Saved.",
    writeSideEffect: "Affects every artifact/mivnav-algorithm plan request from here on.",
  }),
  routingSetting({
    id: "routing.soft_prefer_depth_weight",
    group: ROUTING_ENGINES_SECTION,
    control: { kind: "number", min: 0, max: 5, step: 0.1, as: "field" },
    label: "Artifact: prefer-deeper strength",
    help: "Strength of that nudge. Keep it well below the avoidance strength — it should shade the route, not cause detours.",
    order: 67.5,
    default: 0.8,
    coerce: (raw) => coerceFiniteNumber(raw, 0),
    disabledWhen: (ctx) => {
      const algorithm = ctx.cfg.config()?.routing.algorithm ?? "raster";
      return algorithm !== "artifact" && algorithm !== "mivnav";
    },
    read: (config) => config.routing.soft_prefer_depth_weight,
    toPatch: (value) => ({ routing: { soft_prefer_depth_weight: value as number } }),
    done: "Saved.",
    writeSideEffect: "Affects every artifact/mivnav-algorithm plan request from here on.",
  }),
  routingSetting({
    id: "routing.mivnav_beam_m",
    group: ROUTING_ENGINES_SECTION,
    control: { kind: "number", min: 0, max: 100, step: 0.1, as: "field" },
    label: "Mivnav: vessel beam (m)",
    help: "Above 0, a passage on the topology route narrower than this is re-routed against the chart's exact hazard outlines — the only case where a mivnav route differs from v3 artifact. 0 = off.",
    order: 68,
    default: 0,
    coerce: (raw) => coerceFiniteNumber(raw, 0),
    disabledWhen: (ctx) => (ctx.cfg.config()?.routing.algorithm ?? "raster") !== "mivnav",
    read: (config) => config.routing.mivnav_beam_m,
    toPatch: (value) => ({ routing: { mivnav_beam_m: value as number } }),
    done: "Saved.",
    writeSideEffect: "Affects every mivnav-algorithm plan request from here on. Moot unless the algorithm above is v3 mivnav.",
  }),
  routingSetting({
    id: "routing.mivnav_directional_rules",
    group: ROUTING_ENGINES_SECTION,
    control: { kind: "toggle" },
    label: "Mivnav: directional rules (TSS / buoyage)",
    help: "Forbid going against TSS lanes and one-way routes in the topology layer, and penalise the wrong side of lateral marks. Only affects the diagnostics for now, not the route.",
    order: 69,
    default: false,
    coerce: (raw) => raw === true,
    disabledWhen: (ctx) => (ctx.cfg.config()?.routing.algorithm ?? "raster") !== "mivnav",
    read: (config) => config.routing.mivnav_directional_rules,
    toPatch: (value) => ({ routing: { mivnav_directional_rules: value as boolean } }),
    done: "Saved.",
    writeSideEffect: "Affects every mivnav-algorithm plan request from here on. Moot unless the algorithm above is v3 mivnav.",
  }),
  routingSetting({
    id: "routing.mivnav_require_artifact",
    group: ROUTING_ENGINES_SECTION,
    control: { kind: "toggle" },
    label: "Mivnav: require a built artifact",
    help: "Refuse to plan (straight line plus a warning) unless a current precomputed artifact covers the route, instead of quietly rebuilding it. For testing; never changes the route.",
    order: 69.2,
    default: false,
    coerce: (raw) => raw === true,
    disabledWhen: (ctx) => (ctx.cfg.config()?.routing.algorithm ?? "raster") !== "mivnav",
    read: (config) => config.routing.mivnav_require_artifact,
    toPatch: (value) => ({ routing: { mivnav_require_artifact: value as boolean } }),
    done: "Saved.",
    writeSideEffect: "Affects every mivnav-algorithm plan request from here on. Moot unless the algorithm above is v3 mivnav.",
  }),
  defineSetting<SettingsCtx>({
    id: "routing.mivnav_build",
    scope: "server",
    control: { kind: "custom", component: MivnavBuild },
    label: "Precomputed routing artifact",
    group: ROUTING_ENGINES_SECTION,
    // Just after the two mivnav knobs above (68/69) — the build panel is
    // the thing that makes "mivnav" actually use a precompute.
    order: 69.5,
  }),
  defineSetting<SettingsCtx>({
    id: "routing.routeiq_access",
    scope: "server",
    control: { kind: "custom", component: RouteIQAccess },
    label: "RouteIQ access",
    group: ROUTING_ENGINES_SECTION,
    order: 64,
  }),
  // Section intros — display-only notes, the `DepthNote` idiom (device.tsx).
  defineSetting<SettingsCtx>({
    id: "routing-prefs.note",
    scope: "server",
    control: {
      kind: "custom",
      component: () => (
        <p class="text-xs text-fg-2">
          Soft preferences, for every engine. Each is 0 (off) by default; higher accepts a longer
          detour. None ever blocks a route.
        </p>
      ),
    },
    label: "Route preferences note",
    group: ROUTING_PREFS_SECTION,
    order: 1,
  }),
  defineSetting<SettingsCtx>({
    id: "routing-engines.note",
    scope: "server",
    control: {
      kind: "custom",
      component: () => (
        <p class="text-xs text-fg-2">
          Each applies only to the engine its label names, and is greyed out otherwise.
        </p>
      ),
    },
    label: "Engine options note",
    group: ROUTING_ENGINES_SECTION,
    order: 1,
  }),
  // One feedback line per section, so a refused write shows next to the
  // control that made it rather than at the foot of the pane.
  ...[ROUTING_SECTION_ID, ROUTING_PREFS_SECTION, ROUTING_ENGINES_SECTION, BETA_SECTION].map((group) =>
    defineSetting<SettingsCtx>({
      id: group === ROUTING_SECTION_ID ? "routing.feedback" : `${group}.feedback`,
      scope: "server",
      control: { kind: "custom", component: RoutingFeedback },
      label: "Auto-routing feedback",
      group,
      order: 70,
    }),
  ),
];

/** The auto-router's sections in the "Routes" pane, after Route following
 * (hidden while "Beta autorouting" is off), plus the Beta switch in Advanced. */
export const ROUTING_SECTIONS: readonly SettingsSection<SettingsCtx>[] = [
  defineSettingsSection<SettingsCtx>({
    id: BETA_SECTION,
    title: "Beta features",
    icon: FlaskConical,
    group: "server",
    category: "advanced",
    order: 7,
  }),
  defineSettingsSection<SettingsCtx>({
    id: ROUTING_SECTION_ID,
    title: "Auto-routing",
    icon: Route,
    group: "server",
    category: "routes",
    order: 20,
    hidden: autoroutingOff,
  }),
  defineSettingsSection<SettingsCtx>({
    id: ROUTING_PREFS_SECTION,
    title: "Route preferences",
    icon: SlidersHorizontal,
    group: "server",
    category: "routes",
    order: 30,
    hidden: autoroutingOff,
  }),
  defineSettingsSection<SettingsCtx>({
    id: ROUTING_ENGINES_SECTION,
    title: "Engine options",
    icon: Cpu,
    group: "server",
    category: "routes",
    order: 40,
    hidden: autoroutingOff,
  }),
];

export type { RoutingServerConfig };
