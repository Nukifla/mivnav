import { createSignal, Show, type Component, type JSX } from "solid-js";
import Database from "lucide-solid/icons/database";
import FlaskConical from "lucide-solid/icons/flask-conical";
import HardDrive from "lucide-solid/icons/hard-drive";
import KeyRound from "lucide-solid/icons/key-round";
import Library from "lucide-solid/icons/library";
import MapPin from "lucide-solid/icons/map-pin";
import Package from "lucide-solid/icons/package";
import Puzzle from "lucide-solid/icons/puzzle";
import Route from "lucide-solid/icons/route";
import SatelliteDish from "lucide-solid/icons/satellite-dish";
import SlidersHorizontal from "lucide-solid/icons/sliders-horizontal";
import ZoomIn from "lucide-solid/icons/zoom-in";
import { AccordionSection } from "../ui/Accordion";
import { Slider, Toggle } from "../ui/Controls";
import { Button } from "../ui/Button";
import ChartLibrarySection from "./ChartLibrary";
import OchartsScreensSection, { OCHARTS_SCREENS_SCOPE } from "./OchartsScreens";
import ChartLicencesSection, { CHART_LICENCES_SCOPE } from "./ChartLicences";
import ScrollText from "lucide-solid/icons/scroll-text";
import MonitorSmartphone from "lucide-solid/icons/monitor-smartphone";
import DatasetListSection from "./DatasetList";
import RegionListSection from "./regions";
import StorageSection from "./Storage";
import SoftwareSection from "./Software";
import PluginsSection from "./Plugins";
import { DiskTileCacheMeter } from "./diskTileCache";
import { HistoryProviderField } from "./historyProvider";
import {
  clampChartDetail,
  clampChartDetailSpread,
  createOchartsLogin,
  DEFAULT_CHART_DETAIL,
  DEFAULT_CHART_DETAIL_SPREAD,
  OCHARTS_SCOPE,
  type OchartsServerConfig,
  type ServerConfigController,
} from "../serverConfig";
import { bumpChartEpoch } from "../chartProtocol";
import { createSignalKAccess } from "../signalkAccess";
import type { SignalKStatus } from "../signalk";
import { NAV_SECTION } from "./boat";
import { COLLISION_SECTION } from "./collision";
import { GNSS_SECTION } from "./gnss";
import BellRing from "lucide-solid/icons/bell-ring";
import type { SettingsCtx } from "./ctx";
import {
  defineSettingsCategory,
  defineSettingsSection,
  type SettingsCategory,
  type SettingsSection,
} from "./registry";

// The boat group's declaration: every section/category of "The boat" tab.
// This file declares; the shell (`SettingsBrowser.tsx`) renders — task
// woqknwzy merged four hardcoded `Sidebar.tsx` sections into one registry
// (`./ctx.ts`).

/** Server unreachable: say so once and stop — chart display settings are
 * local, so a settings panel must not be able to make the plotter look broken. */
export const Offline: Component<{ cfg: ServerConfigController }> = (props) => (
  <div class="space-y-1 pb-2">
    <p class="text-xs text-notice">
      The boat's server is not reachable, so its settings cannot be shown or changed. Your chart
      display settings are local and unaffected.
    </p>
    <p class="text-xs text-fg-2">{props.cfg.offline()}</p>
    <Button disabled={props.cfg.loading()} onClick={() => void props.cfg.refresh()}>
      Retry
    </Button>
  </div>
);

/** Feedback for one section's writes, addressed by scope — without this a
 * port the server refused would report under the o-charts login instead.
 * `createServerConfig` sets exactly one of error/status per write. */
const Feedback: Component<{ cfg: ServerConfigController; scope: string }> = (props) => (
  <Show when={props.cfg.scope() === props.scope}>
    <Show when={props.cfg.error()}>
      <p class="text-xs text-alarm">{props.cfg.error()}</p>
    </Show>
    <Show when={props.cfg.status()}>
      <p class="text-xs text-ok">{props.cfg.status()}</p>
    </Show>
  </Show>
);

/**
 * Commits on change (blur/Enter), not per keystroke: most writes here re-dial
 * SignalK or drop chart caches. `live` opts out for a field whose `onCommit`
 * only moves a local draft, so a Save button gated on dirty doesn't deadlock.
 */
const Field: Component<{
  label: string;
  value: string;
  onCommit: (value: string) => void;
  /** Commit every keystroke. Only for drafts — never for a network write. */
  live?: boolean;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
  hint?: JSX.Element;
  /** Native stepper bounds for a `type="number"` field — the browser keeps a
   * coarse-pointer tap on the up/down arrows within range; `onCommit` re-guards
   * the range regardless, so a typed out-of-bounds value is never sent. */
  min?: number;
  max?: number;
  step?: number;
}> = (props) => (
  <label class="block">
    <span class="text-xs text-fg-2">{props.label}</span>
    <input
      type={props.type ?? "text"}
      class="mt-1 w-full rounded border border-line px-2 py-1 focus:border-accent focus:outline-none disabled:opacity-40"
      placeholder={props.placeholder}
      disabled={props.disabled}
      min={props.min}
      max={props.max}
      step={props.step}
      value={props.value}
      onInput={(e) => props.live && props.onCommit(e.currentTarget.value)}
      onChange={(e) => !props.live && props.onCommit(e.currentTarget.value)}
    />
    <Show when={props.hint}>
      <span class="text-xs text-fg-3">{props.hint}</span>
    </Show>
  </label>
);

const STATUS_CLASS: Record<SignalKStatus, string> = {
  connected: "text-ok",
  connecting: "text-notice",
  off: "text-fg-3",
};

/** The boat's SignalK connection. The status badge stays client-side and
 * answers "is the boat's server talking to the box" — the same answer on
 * every screen, not "did my browser reach SignalK". */
const SignalKSection: Component<{ cfg: ServerConfigController; status: SignalKStatus }> = (
  props,
) => {
  const sk = () => props.cfg.config()!.signalk;
  const save = (patch: Partial<ReturnType<typeof sk>>) =>
    void props.cfg.patch({ signalk: patch }, { scope: "signalk", done: "Saved. Reconnecting…" });

  return (
    <AccordionSection value="signalk" title="SignalK" icon={SatelliteDish}>
      <div class="flex items-baseline justify-between gap-2">
        <span class="text-xs text-fg-2">Proxied to every screen.</span>
        <span class={`shrink-0 text-xs ${STATUS_CLASS[props.status]}`}>{props.status}</span>
      </div>
      <Toggle
        label="Connected to a SignalK server"
        checked={sk().enabled}
        onChange={(value) => save({ enabled: value })}
      />
      <Field
        label="Host"
        placeholder="localhost"
        disabled={!sk().enabled || props.cfg.busy()}
        value={sk().host}
        onCommit={(value) => save({ host: value.trim() })}
      />
      <Field
        label="Port"
        type="number"
        disabled={!sk().enabled || props.cfg.busy()}
        value={String(sk().port)}
        onCommit={(value) => {
          const port = Number(value);
          // The server would refuse a non-number with a validator's words;
          // there is nothing it could tell the mariner that this doesn't.
          if (Number.isFinite(port)) save({ port });
        }}
      />
      <Toggle
        label="TLS (wss://)"
        checked={sk().tls}
        disabled={!sk().enabled}
        onChange={(value) => save({ tls: value })}
      />
      {/* Server's own derivation of the URL, echoed back: proof the edit landed. */}
      <p class="break-all font-mono text-xs text-fg-3">{props.cfg.meta()?.signalk_url}</p>
      <Feedback cfg={props.cfg} scope="signalk" />
      <Show when={sk().enabled}>
        <WriteAccess cfg={props.cfg} />
      </Show>
    </AccordionSection>
  );
};

// Route following (#yprzuqtt) is GENERATED, not hand-authored here — see
// `settings/boat.tsx`'s `NAV_SECTION`, routed via `scope: "server"`.

const ACCESS_MESSAGE_CLASS = {
  idle: "text-fg-2",
  pending: "text-notice",
  granted: "text-ok",
  denied: "text-alarm",
  error: "text-alarm",
} as const;

/** mivnav's SignalK ADMIN token, via SignalK's device access-request flow
 * (signalkAccess.ts). The token never reaches this browser — the backend
 * stores it; this only learns if it was granted. */
const WriteAccess: Component<{ cfg: ServerConfigController }> = (props) => {
  const access = createSignalKAccess({ onGranted: () => void props.cfg.refresh() });
  const configured = () => props.cfg.meta()?.signalk_token_set ?? false;

  return (
    <div class="space-y-1 border-t border-line-2 pt-2">
      <div class="flex items-baseline justify-between gap-2">
        <span class="text-xs font-medium text-fg-2">SignalK admin access</span>
        <span class={`shrink-0 text-xs ${configured() ? "text-ok" : "text-fg-3"}`}>
          {configured() ? "configured" : "not configured"}
        </span>
      </div>
      <p class="text-xs text-fg-3">
        {configured()
          ? "This server holds a SignalK token. Request again to replace it — e.g. an older write-only token, which can't read plugin settings such as the anchor alarm's."
          : "Reading the boat needs no login; the autopilot, alarms on SignalK, routes, marks and plugin settings need an admin token from the SignalK server."}
      </p>
      <Button disabled={access.busy()} onClick={() => void access.start()}>
        {access.busy()
          ? "Waiting for approval…"
          : configured()
            ? "Request admin access again"
            : "Request admin access"}
      </Button>
      <Show when={access.message()}>
        <p class={`text-xs ${ACCESS_MESSAGE_CLASS[access.phase()]}`}>{access.message()}</p>
      </Show>
    </div>
  );
};

/**
 * The o-charts.org account login. Password is write-only both ways — server
 * never sends it, empty box means "unchanged" (`createOchartsLogin` owns
 * these rules). No registration button, deliberately: that permanent,
 * one-attempt-per-run act already lives in ChartLibrary.tsx behind an
 * explicit warning, and a second casual path to it is not worth building.
 */
const OchartsSection: Component<{ cfg: ServerConfigController }> = (props) => {
  const login = createOchartsLogin(props.cfg);

  return (
    <AccordionSection value={OCHARTS_SCOPE} title="o-charts account" icon={KeyRound}>
      <p class="text-xs text-fg-2">
        Your o-charts.org login, used to download the charts you bought. Kept on the server only,
        in its own file — never sent back to a screen.
      </p>
      <Field
        label="Username"
        placeholder="you@example.com"
        // Live: Save is gated on dirty, and a disabled button can't take the
        // blur that would make it dirty.
        live
        disabled={props.cfg.busy()}
        value={login.user()}
        onCommit={login.setUser}
      />
      <label class="block">
        <span class="text-xs text-fg-2">Password</span>
        <input
          type="password"
          autocomplete="off"
          class="mt-1 w-full rounded border border-line px-2 py-1 focus:border-accent focus:outline-none disabled:opacity-40"
          // The stored password never comes back here; the placeholder carries
          // the only fact we have.
          placeholder={login.stored() ? "Stored — leave blank to keep it" : "Not set"}
          disabled={props.cfg.busy()}
          value={login.password()}
          onInput={(e) => login.setPassword(e.currentTarget.value)}
        />
      </label>
      <div class="flex items-center gap-2">
        <Button
          variant="primary"
          size="md"
          disabled={props.cfg.busy() || !login.dirty()}
          onClick={() => void login.save()}
        >
          Save
        </Button>
        <Show when={login.stored()}>
          <Button disabled={props.cfg.busy()} onClick={() => void login.forget()}>
            Forget password
          </Button>
        </Show>
      </div>
      <p class="text-xs text-fg-2">
        Registering this machine with o-charts is permanent and lives in the chart library above.
      </p>
      <Feedback cfg={props.cfg} scope={OCHARTS_SCOPE} />
    </AccordionSection>
  );
};

const MB = 1024 * 1024;
const inMb = (bytes: number) => String(Math.round(bytes / MB));
const GB = 1024 * MB;
/** Up to two decimals, no trailing zeros: 4 GiB shows "4", 1.5 GiB "1.5". */
const inGb = (bytes: number) => String(Math.round((bytes / GB) * 100) / 100);

/**
 * Where things live and how much memory they may have. Set once and behind
 * an unlock switch (a mistyped data directory is a plotter with no charts,
 * one lurch away on a moving boat). See docs/architecture/server-settings-scopes.md
 * for why the two halves still write to separate feedback scopes.
 */
const AdvancedSection: Component<{ cfg: ServerConfigController }> = (props) => {
  const [unlocked, setUnlocked] = createSignal(false);
  const oc = () => props.cfg.config()!.ocharts;
  const locked = () => !unlocked() || props.cfg.busy();
  const save = (patch: Parameters<ServerConfigController["patch"]>[0]) =>
    void props.cfg.patch(patch, { scope: "advanced" });
  const saveMb =
    (
      field:
        | "cell_budget_bytes"
        | "tile_budget_bytes"
        | "hazard_budget_bytes"
        | "land_bake_budget_bytes"
        | "render_budget_bytes",
    ) =>
    (value: string) => {
      const mb = Number(value);
      if (Number.isFinite(mb) && mb >= 0) save({ ocharts: { [field]: Math.round(mb * MB) } });
    };
  const saveDiskGb = (value: string) => {
    const gb = Number(value);
    if (Number.isFinite(gb) && gb >= 0)
      save({ ocharts: { tile_disk_budget_bytes: Math.round(gb * GB) } });
  };
  const saveKnob = async (patch: Partial<OchartsServerConfig>) => {
    const ok = await props.cfg.patch({ ocharts: patch }, { scope: "chartdetail" });
    if (ok) bumpChartEpoch();
  };
  const saveInt =
    (field: keyof OchartsServerConfig, min: number, max: number) => (value: string) => {
      const n = Math.round(Number(value));
      if (Number.isFinite(n) && n >= min && n <= max) void saveKnob({ [field]: n });
    };

  return (
    <AccordionSection value="advanced" title="Advanced" icon={SlidersHorizontal}>
      <p class="text-xs text-fg-2">
        Set once when the boat's computer is set up. Saving any of these rebuilds the chart service
        and drops its caches.
      </p>
      <Toggle label="Let me edit these" checked={unlocked()} onChange={setUnlocked} />

      <Field
        label="Data directory"
        hint="Root every provider's own dataset directory sits under (charts, o-charts sets, POI, satellite)."
        disabled={locked()}
        value={props.cfg.config()!.data_root}
        onCommit={(value) => save({ data_root: value.trim() })}
      />
      <Field
        label="S-52 data path"
        placeholder="Auto-detect"
        disabled={locked()}
        value={oc().s52_path ?? ""}
        hint="Blank auto-detects chartcore's fetched copy."
        // Blank means auto-detect here, not "unchanged" (unlike the password's null).
        onCommit={(value) => save({ ocharts: { s52_path: value.trim() || null } })}
      />
      <Field
        label="Decoded cell cache (MB)"
        type="number"
        disabled={locked()}
        value={inMb(oc().cell_budget_bytes)}
        onCommit={saveMb("cell_budget_bytes")}
      />
      <Field
        label="Rendered tile cache (MB)"
        type="number"
        disabled={locked()}
        value={inMb(oc().tile_budget_bytes)}
        onCommit={saveMb("tile_budget_bytes")}
      />
      <Field
        label="Routing hazard-index cache (MB)"
        type="number"
        disabled={locked()}
        value={inMb(oc().hazard_budget_bytes)}
        onCommit={saveMb("hazard_budget_bytes")}
      />
      <Field
        label="Routing land-hazard-bake cache (MB)"
        type="number"
        disabled={locked()}
        value={inMb(oc().land_bake_budget_bytes)}
        onCommit={saveMb("land_bake_budget_bytes")}
        hint="Not on any live route-planning path yet — a per-cell primitive built for a future search optimisation."
      />
      <Field
        label="Concurrent chart render memory (MB)"
        type="number"
        disabled={locked()}
        value={inMb(oc().render_budget_bytes)}
        onCommit={saveMb("render_budget_bytes")}
        hint="Not a cache: caps the estimated peak RAM of chart tiles being drawn at once. A zoomed-out tile over many detailed charts can need ~2 GB; one heavier than this still draws, alone."
      />
      <Field
        label="Chart tile disk cache (GB)"
        type="number"
        min={0}
        step={0.5}
        disabled={locked()}
        value={inGb(oc().tile_disk_budget_bytes)}
        onCommit={saveDiskGb}
        hint="Rendered chart tiles kept on disk across restarts, and pre-rendered in idle time, so zooming out is instant. 0 turns it off."
      />
      <DiskTileCacheMeter />
      <Field
        label="Chart rescan interval (s)"
        type="number"
        disabled={locked()}
        value={String(oc().rescan_interval_s)}
        hint="0 rescans the chart directories on every access."
        onCommit={(value) => {
          const seconds = Number(value);
          if (Number.isFinite(seconds) && seconds >= 0)
            save({ ocharts: { rescan_interval_s: seconds } });
        }}
      />

      {/* Serving-detail knobs, moved here from Chart detail (task woqknwzy) —
          see docs/architecture/server-settings-scopes.md for why the epoch bumps. */}
      <div class="mt-1 flex items-center gap-2 border-t border-line-2 pt-2 text-fg-2">
        <FlaskConical size={14} aria-hidden="true" class="shrink-0" />
        <span class="text-xs font-medium">Chart serving detail</span>
      </div>
      <p class="text-xs text-fg-2">
        Which o-charts cells are drawn into each tile, relative to the zoom being viewed. Each change
        applies at once and can be undone; it is refused while an install runs.
      </p>
      <Field
        label="Over-zoom (finer reach)"
        type="number"
        min={0}
        max={12}
        step={1}
        disabled={locked()}
        value={String(oc().over_zoom)}
        hint="How many zooms finer than the viewed zoom the primary band reaches — the dominant cold-decode cost. Higher shows fine detail earlier (and decodes more per overview tile)."
        onCommit={saveInt("over_zoom", 0, 12)}
      />
      <Field
        label="Under-zoom (coarser reach)"
        type="number"
        min={0}
        max={12}
        step={1}
        disabled={locked()}
        value={String(oc().under_zoom)}
        hint="How many zooms coarser than the viewed zoom count as normal chart; a coarser cell still completes coverage beyond it, as overzoomed rescue."
        onCommit={saveInt("under_zoom", 0, 12)}
      />
      <Field
        label="Detail gap (seam fill)"
        type="number"
        min={0}
        max={8}
        step={1}
        disabled={locked()}
        value={String(oc().detail_gap)}
        hint="A region more than this many zooms coarser than the finest detail present gets a finer cell pulled in, so adjacent scales reach full detail together. Keep small (1); 0 is most aggressive."
        onCommit={saveInt("detail_gap", 0, 8)}
      />
      <Field
        label="Overview detail cutoff"
        type="number"
        min={0}
        max={12}
        step={1}
        disabled={locked()}
        value={String(oc().overview_detail_cutoff)}
        hint="Upper bound on how many zooms finer than the viewed zoom the seam fill may reach: a cell far finer than this is SCAMIN-hidden at overview anyway, so pulling it is wasted decode. Must exceed over-zoom."
        onCommit={saveInt("overview_detail_cutoff", 0, 12)}
      />
      <Field
        label="Max cells per tile"
        type="number"
        min={8}
        max={128}
        step={1}
        disabled={locked()}
        value={String(oc().max_cells_per_tile)}
        hint="Last-resort safety cap on how many cells composite into one tile. It should never bite the authoritative set; raise it if a dense or fragmented overview trips it, lower to cap Pi load."
        onCommit={saveInt("max_cells_per_tile", 8, 128)}
      />
      <Field
        label="Tile-cut parallelism"
        type="number"
        min={1}
        max={16}
        step={1}
        disabled={locked()}
        value={String(oc().parallelism)}
        hint="Threads chartcore uses for the per-cell tile cut. Output is byte-identical regardless — a pure throughput knob. Raise to use more Pi cores under load; 1 is serial."
        onCommit={saveInt("parallelism", 1, 16)}
      />
      <Feedback cfg={props.cfg} scope="chartdetail" />

      <div class="mt-1 flex items-center gap-2 border-t border-line-2 pt-2 text-fg-2">
        <Route size={14} aria-hidden="true" class="shrink-0" />
        <span class="text-xs font-medium">Ship's track</span>
      </div>
      <HistoryProviderField
        disabled={locked()}
        value={props.cfg.config()!.track.history_provider}
        onCommit={(provider) => save({ track: { history_provider: provider } })}
      />

      {/* An operator over ssh can hand-edit this same file — name it, and give
          that edit a way to be believed without a restart. */}
      <div class="space-y-1 border-t border-line-2 pt-2">
        <p class="break-all font-mono text-xs text-fg-3">{props.cfg.meta()?.path}</p>
        <p class="break-all font-mono text-xs text-fg-3">
          {props.cfg.meta()?.credentials_path}
        </p>
        <Button disabled={props.cfg.busy()} onClick={() => void props.cfg.reload({ scope: "advanced" })}>
          Reload from file
        </Button>
      </div>
      <Feedback cfg={props.cfg} scope="advanced" />
    </AccordionSection>
  );
};

/** Its own feedback scope so a refused write doesn't land under the advanced
 * serving knobs. */
const CHART_DETAIL_SCOPE = "chartdetail-bias";

/**
 * The SCAMIN bias `B` (ocharts.chart_detail): a feature shows while
 * `display_scale_denom(z) <= scamin·B` — boat-wide by construction, not a
 * device preference (docs/architecture/server-settings-scopes.md). Two
 * sliders, deliberately: `B` shifts every object's turn-on zoom equally,
 * while spread `k` (chart_detail_spread, #qqlzrkkn) compresses the spacing
 * instead of shifting it.
 */
const ChartDetailSection: Component<{ cfg: ServerConfigController }> = (props) => {
  const stored = () => props.cfg.config()!.ocharts.chart_detail;
  // Local draft the slider shows while dragging; null = "show server truth".
  const [draft, setDraft] = createSignal<number | null>(null);
  const value = () => draft() ?? stored();
  const commit = async (raw: number) => {
    const b = clampChartDetail(raw);
    const ok = await props.cfg.patch(
      { ocharts: { chart_detail: b } },
      { scope: CHART_DETAIL_SCOPE, done: "Saved." },
    );
    setDraft(null);
    if (ok) bumpChartEpoch();
  };
  // Same draft/commit/epoch dance as the bias above.
  const storedSpread = () => props.cfg.config()!.ocharts.chart_detail_spread;
  const [spreadDraft, setSpreadDraft] = createSignal<number | null>(null);
  const spread = () => spreadDraft() ?? storedSpread();
  const commitSpread = async (raw: number) => {
    const k = clampChartDetailSpread(raw);
    const ok = await props.cfg.patch(
      { ocharts: { chart_detail_spread: k } },
      { scope: CHART_DETAIL_SCOPE, done: "Saved." },
    );
    setSpreadDraft(null);
    if (ok) bumpChartEpoch();
  };

  return (
    <AccordionSection value="chart-detail" title="Chart detail" icon={ZoomIn}>
      <p class="text-xs text-fg-2">
        How much the chart shows before it thins out to stay readable. Higher keeps more detail
        (buoys, lights, marks) on screen as you zoom out; lower declutters sooner. Shared by every
        screen.
      </p>
      {/* Friendlier band than the backend's full [0.1, 10]; config.json values
          outside this still load, the slider just clamps. */}
      <Slider
        label="Detail"
        value={value()}
        min={0.5}
        max={4}
        step={0.25}
        disabled={props.cfg.busy()}
        format={(v) => (v === DEFAULT_CHART_DETAIL ? "1× (default)" : `${v}×`)}
        onChange={setDraft}
        onChangeEnd={(v) => void commit(v)}
      />
      <p class="text-xs text-fg-2">
        Detail alone moves every object by the same number of zoom levels, so pulling the late ones
        in also crowds the wide views. Spread changes the gaps instead: below 1 the objects that
        only appear when you are zoomed right in arrive much earlier, while the ones already
        visible when zoomed out barely move. 1 leaves the chart's own spacing untouched.
      </p>
      {/* Compression only: 1.0 sits at the right-hand end. config.json accepts
          up to CHART_DETAIL_SPREAD_MAX for the opposite; the slider doesn't offer it. */}
      <Slider
        label="Spread"
        value={spread()}
        min={0.4}
        max={1}
        step={0.05}
        disabled={props.cfg.busy()}
        format={(v) => (v === DEFAULT_CHART_DETAIL_SPREAD ? "1.0 (off)" : v.toFixed(2))}
        onChange={setSpreadDraft}
        onChangeEnd={(v) => void commitSpread(v)}
      />
      <Feedback cfg={props.cfg} scope={CHART_DETAIL_SCOPE} />
    </AccordionSection>
  );
};


/**
 * The "The boat" rail, in rail order: dock-time setup first, then live
 * connections, then set-once knobs. A future dataset provider joins
 * `Datasets` just by naming the category — no edit here or in the shell.
 */
export const BOAT_CATEGORIES: readonly SettingsCategory[] = [
  defineSettingsCategory({ id: "charts", title: "Charts", icon: Library, group: "server", order: 10,
    blurb: "Installed charts, the o-charts account, and which screens may show them." }),
  // Regions only exist to feed datasets, so they share the pane.
  defineSettingsCategory({ id: "datasets", title: "Datasets", icon: Database, group: "server", order: 20,
    blurb: "Data the boat keeps for offline use, and the regions it covers." }),
  defineSettingsCategory({ id: "storage", title: "Storage", icon: HardDrive, group: "server", order: 40,
    blurb: "What is using the boat's disk." }),
  defineSettingsCategory({ id: "signalk", title: "SignalK", icon: SatelliteDish, group: "server", order: 50,
    blurb: "The boat's instrument feed, shared with every screen." }),
  // Collision, shallow water, GNSS & connection: one pane, same Off/Show/Tell shape.
  defineSettingsCategory({ id: "alarms", title: "Alarms", icon: BellRing, group: "server", order: 55,
    blurb: "When the boat's alarms fire — on every screen and on SignalK." }),
  // Route following + the auto-router, as separate sections (see routing.tsx).
  defineSettingsCategory({ id: "routes", title: "Routes", icon: Route, group: "server", order: 60,
    blurb: "Following a route, and how the auto-router plans one (with the Autorouting plugin)." }),
  // Chart detail rides here too, above the locked set-once fields: a rarely
  // touched boat-wide tuning knob, not something for the main rail.
  defineSettingsCategory({ id: "advanced", title: "Advanced", icon: SlidersHorizontal, group: "server", order: 80,
    blurb: "Chart detail, beta features, paths, caches and tuning — mostly set once when the boat's computer is set up." }),
  defineSettingsCategory({ id: "plugins", title: "Plugins", icon: Puzzle, group: "server", order: 85,
    blurb: "Add-ons installed on the boat's server, and switching them on or off." }),
  defineSettingsCategory({ id: "software", title: "Software", icon: Package, group: "server", order: 90,
    blurb: "Which mivnav the boat's server runs, and updating it." }),
];

/**
 * The boat group's sections, render-only, off shared ctx (`./ctx.ts`) —
 * except `NAV_SECTION` (settings/boat.tsx), the one GENERATED section. The
 * rest stay hand-authored because their writes are the risky ones.
 */
export const BOAT_SECTIONS: readonly SettingsSection<SettingsCtx>[] = [
  defineSettingsSection<SettingsCtx>({
    id: "charts",
    title: "Charts",
    icon: Library,
    group: "server",
    category: "charts",
    order: 10,
    render: (p) => <ChartLibrarySection cfg={p.ctx.cfg} onCatalogChanged={p.ctx.onCatalogChanged} />,
  }),
  defineSettingsSection<SettingsCtx>({
    id: OCHARTS_SCOPE,
    title: "o-charts account",
    icon: KeyRound,
    group: "server",
    category: "charts",
    order: 20,
    render: (p) => <OchartsSection cfg={p.ctx.cfg} />,
  }),
  defineSettingsSection<SettingsCtx>({
    id: OCHARTS_SCREENS_SCOPE,
    title: "Screens",
    icon: MonitorSmartphone,
    group: "server",
    category: "charts",
    order: 30,
    render: () => <OchartsScreensSection />,
  }),
  defineSettingsSection<SettingsCtx>({
    id: CHART_LICENCES_SCOPE,
    title: "Chart licences",
    icon: ScrollText,
    group: "server",
    category: "charts",
    order: 40,
    render: () => <ChartLicencesSection />,
  }),
  defineSettingsSection<SettingsCtx>({
    id: "datasets",
    title: "Datasets",
    icon: Database,
    group: "server",
    category: "datasets",
    order: 10,
    render: (p) => (
      <DatasetListSection
        paramsComponents={p.ctx.datasetParams}
        onCatalogChanged={p.ctx.onCatalogChanged}
      />
    ),
  }),
  defineSettingsSection<SettingsCtx>({
    id: "regions",
    title: "Regions",
    icon: MapPin,
    group: "server",
    category: "datasets",
    order: 20,
    render: (p) => (
      <RegionListSection
        startDraw={p.ctx.regionDraw}
        stageDrawnRegion={p.ctx.stageDrawnRegion}
        takeDrawnRegion={p.ctx.takeDrawnRegion}
      />
    ),
  }),
  defineSettingsSection<SettingsCtx>({
    id: "storage",
    title: "Storage",
    icon: HardDrive,
    group: "server",
    category: "storage",
    order: 10,
    render: () => <StorageSection />,
  }),
  defineSettingsSection<SettingsCtx>({
    id: "signalk",
    title: "SignalK",
    icon: SatelliteDish,
    group: "server",
    category: "signalk",
    order: 10,
    render: (p) => <SignalKSection cfg={p.ctx.cfg} status={p.ctx.signalkStatus} />,
  }),
  COLLISION_SECTION,
  GNSS_SECTION,
  NAV_SECTION,
  defineSettingsSection<SettingsCtx>({
    id: "chart-detail",
    title: "Chart detail",
    icon: ZoomIn,
    group: "server",
    category: "advanced",
    order: 5,
    render: (p) => <ChartDetailSection cfg={p.ctx.cfg} />,
  }),
  defineSettingsSection<SettingsCtx>({
    id: "advanced",
    title: "Advanced",
    icon: SlidersHorizontal,
    group: "server",
    category: "advanced",
    order: 10,
    render: (p) => <AdvancedSection cfg={p.ctx.cfg} />,
  }),
  defineSettingsSection<SettingsCtx>({
    id: "plugins",
    title: "Plugins",
    icon: Puzzle,
    group: "server",
    category: "plugins",
    order: 10,
    render: () => <PluginsSection />,
  }),
  defineSettingsSection<SettingsCtx>({
    id: "software",
    title: "Software",
    icon: Package,
    group: "server",
    category: "software",
    order: 10,
    render: (p) => <SoftwareSection cfg={p.ctx.cfg} />,
  }),
];
