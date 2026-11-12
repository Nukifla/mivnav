import { createResource, createSignal, For, onCleanup, Show, type Component } from "solid-js";
import Library from "lucide-solid/icons/library";
import type { components } from "../../api.generated";
import type { ServerConfigController } from "../serverConfig";
import { AccordionSection } from "../ui/Accordion";
import { Button } from "../ui/Button";
import { Toggle } from "../ui/Controls";

/** The three chart-install request bodies this section sends, straight off
 * the OpenAPI schema (`mivnav.api.ocharts.routes`) rather than hand-mirrored. */
type RegisterBody = components["schemas"]["RegisterBody"];
type InstallBody = components["schemas"]["InstallBody"];
type FncInstallBody = components["schemas"]["FncInstallBody"];

// The boat's chart library: the o-charts sets installed on the server, the
// shop account that supplies them, chart install with progress, and delete.
// Talks to the backend's /api/ocharts/* endpoints; the login lives server-side
// and never reaches the browser.
//
// A *boat* section deliberately (every button here changes what the whole
// boat has) — which charts this screen draws is a separate device setting
// (ChartSetsSection). This section is also the ONLY path to the irreversible
// half of the o-charts relationship: registering this machine's fingerprint
// to the account, which cannot be undone at o-charts.org (see `canRegister`).

interface OchartsStatus {
  credentials_present: boolean;
  daemon: { state: string; error: string | null };
  sets: {
    id: string;
    name: string;
    edition: string;
    valid_to: string;
    cells: number;
    cell_errors: Record<string, string>;
  }[];
  install: InstallStatus;
  updates: UpdatesStatus;
}

/** One installed set the shop has a newer edition of (`/ocharts/updates`). */
export interface ChartUpdate {
  chart_id: string;
  name: string;
  set_id: string;
  installed_edition: string;
  available_edition: string;
  /** Why this edition's last install attempt failed; "" if it has not. */
  failed: string;
}

export interface UpdatesStatus {
  state: string;
  /** Epoch seconds of the last shop check, null if none since the server started. */
  checked_at: number | null;
  error: string;
  updates: ChartUpdate[];
  installed: { chart_id: string; name: string; edition: string; at: number }[];
  /** The freenauticalchart.net half of the last run: asked only about the
   * regions installed here, so `checked_at` stays null on a boat with none. */
  fnc: { checked_at: number | null; error: string };
}

/** The one line under "Updates". Pulled out of the JSX and tested like
 * `fncAction`: "up to date" must never be said about a check that failed or
 * never ran — at sea the shop is unreachable, and that is not "current". */
export function updatesSummary(u: UpdatesStatus | null | undefined, now: number): string {
  if (!u) return "";
  if (u.state === "checking") return "Checking the shop…";
  if (u.state === "installing") return "Installing updates…";
  if (u.checked_at == null) return "Not checked since the server started.";
  const when = `checked ${ago(now - u.checked_at)}`;
  if (u.error) return `Could not check (${when}): ${u.error}`;
  if (u.updates.length === 0) return `Up to date — ${when}.`;
  const n = u.updates.length;
  return `${n} update${n === 1 ? "" : "s"} available — ${when}.`;
}

/** The free charts' own line: they come from another publisher, so they can
 * fail (or succeed) independently of the shop. "" when none are installed. */
export function fncUpdatesSummary(u: UpdatesStatus | null | undefined, now: number): string {
  if (!u || u.fnc.checked_at == null) return "";
  const when = `checked ${ago(now - u.fnc.checked_at)}`;
  if (u.fnc.error) return `Free charts: could not update (${when}): ${u.fnc.error}`;
  return `Free charts ${when}.`;
}

function ago(seconds: number): string {
  if (seconds < 90) return "just now";
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 129600) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} days ago`;
}

interface InstallStatus {
  state: string;
  progress: number;
  detail: string;
  error: string;
  set_id: string;
}

interface ShopSlot {
  slot_uuid: string;
  assigned_system: string | null;
}

interface ShopChart {
  chart_id: string;
  name: string;
  edition: string;
  expired: boolean;
  order: string;
  quantity_id: string;
  slots: ShopSlot[];
}

interface ShopState {
  system_name: string | null;
  registered: boolean;
  charts: ShopChart[];
}

/** Every condition on the one permanent act in this app: registering binds
 * this machine's fingerprint to a system name at o-charts.org for good, so
 * the shop must be connected on purpose, not already registered, nothing
 * else in flight, and a name must be *typed* — no default to fall into. */
export function canRegister(shop: ShopState | null, systemName: string, busy: boolean): boolean {
  return shop != null && !shop.registered && !busy && systemName.trim() !== "";
}

// -- freenauticalchart.net (free CC0 charts, no account) ---------------------

export interface FncVersionInfo {
  etag: string;
  last_modified: string;
  published: string;
  size: number;
}

export interface FncRegionState {
  region: string;
  label: string;
  url: string;
  /** null when the publisher could not be reached; `error` says why. */
  available: FncVersionInfo | null;
  error?: string;
  installed: (FncVersionInfo & { set_id: string }) | null;
  update_available: boolean;
}

/** What the one button per region says and whether it can be pressed. Pulled
 * out of the JSX and tested for the same reason as `canRegister`: getting
 * "already up to date" wrong invites a re-download on a metered uplink. */
export function fncAction(
  entry: FncRegionState,
  busy: boolean,
  installActive: boolean,
): { label: string; disabled: boolean } {
  if (entry.available == null) return { label: "Unavailable", disabled: true };
  if (entry.installed != null && !entry.update_available) {
    return { label: "Up to date", disabled: true };
  }
  return {
    label: entry.installed == null ? "Install" : "Update",
    disabled: busy || installActive,
  };
}

/** Bytes as a rough download size — this is the number that decides whether
 * a sailor starts the transfer at all, so it is always shown. */
export function fncSize(bytes: number): string {
  if (!bytes) return "";
  const mb = bytes / 1e6;
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = body && typeof body.detail === "string" ? body.detail : `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return body as T;
}

const ACTIVE_INSTALL_STATES = new Set(["download", "unpack", "test", "parse"]);

// Only `download` reports a percentage; later phases get a "…" label and an
// indeterminate bar rather than a static full-width bar that reads as stuck.
const PHASE_LABEL: Record<string, string> = {
  download: "Downloading",
  unpack: "Unpacking…",
  test: "Testing cells…",
  parse: "Parsing…",
};

interface ChartLibraryProps {
  /** For the one config field this section owns: `ocharts.auto_update`. */
  cfg: ServerConfigController;
  /** A set was installed or deleted: the catalog needs a refetch. */
  onCatalogChanged: () => void;
}

/** Mounted with the sidebar: the status fetch and install poll start when a
 * sailor opens this surface and stop when they leave. An install outlives
 * that — it runs server-side and its progress comes back on the next open. */
const ChartLibrarySection: Component<ChartLibraryProps> = (props) => {
  const [status, { refetch: refetchStatus }] = createResource(() =>
    getJson<OchartsStatus>("/api/ocharts/status"),
  );
  const [shop, setShop] = createSignal<ShopState | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [systemName, setSystemName] = createSignal("");
  const [install, setInstall] = createSignal<InstallStatus | null>(null);
  // set id awaiting delete confirmation (two-step, no browser dialog)
  const [confirmDelete, setConfirmDelete] = createSignal("");
  // freenauticalchart.net: fetched only when asked for — see `loadFnc`
  const [fnc, setFnc] = createSignal<FncRegionState[] | null>(null);
  const [fncNote, setFncNote] = createSignal("");
  const [updates, setUpdates] = createSignal<UpdatesStatus | null>(null);
  const updatesState = () => updates() ?? status()?.updates ?? null;

  // poll install progress while a job runs
  const timer = setInterval(async () => {
    // An update run (ours or the unattended one) is several installs in a
    // row: follow it too, and pick up each install it starts.
    const run = updatesState();
    if (run && run.state !== "idle") {
      try {
        const next = await getJson<UpdatesStatus>("/api/ocharts/updates");
        setUpdates(next);
        if (next.state === "installing") {
          setInstall(await getJson<InstallStatus>("/api/ocharts/install"));
        } else if (next.state === "idle") {
          setInstall(await getJson<InstallStatus>("/api/ocharts/install"));
          void refetchStatus();
          props.onCatalogChanged();
        }
      } catch {
        /* transient poll failure: keep the last status */
      }
      return;
    }
    const current = install() ?? status()?.install;
    if (!current || !ACTIVE_INSTALL_STATES.has(current.state)) return;
    try {
      const st = await getJson<InstallStatus>("/api/ocharts/install");
      setInstall(st);
      if (st.state === "done") {
        void refetchStatus();
        props.onCatalogChanged();
        // Only if the list is already on screen — a HEAD per region must not
        // reintroduce a network call nobody asked for (see `loadFnc`).
        if (fnc() != null) void loadFnc();
      }
    } catch {
      /* transient poll failure: keep the last status */
    }
  }, 1000);
  onCleanup(() => clearInterval(timer));

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const connect = () =>
    act(async () => {
      setShop(await getJson<ShopState>("/api/ocharts/shop/connect", { method: "POST" }));
    });

  const register = () =>
    act(async () => {
      await getJson("/api/ocharts/shop/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ system_name: systemName() } satisfies RegisterBody),
      });
      await connect();
    });

  // With a slot already assigned to this system, install directly; else the
  // backend assigns one first (binds a license slot to this system).
  const installChart = (chart: ShopChart, slot: ShopSlot | null) =>
    act(async () => {
      const st = await getJson<InstallStatus>("/api/ocharts/shop/install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          edition: chart.edition,
          system_name: shop()?.system_name ?? "",
          detail: chart.name,
          slot_uuid: slot?.slot_uuid ?? "",
          chart_id: chart.chart_id,
          order: chart.order,
          quantity_id: chart.quantity_id,
        } satisfies InstallBody),
      });
      setInstall(st);
    });

  const checkUpdates = () =>
    act(async () => {
      setUpdates(await getJson<UpdatesStatus>("/api/ocharts/updates/check", { method: "POST" }));
    });

  const installUpdates = () =>
    act(async () => {
      setUpdates(await getJson<UpdatesStatus>("/api/ocharts/updates/install", { method: "POST" }));
    });

  const upload = (file: File) =>
    act(async () => {
      const form = new FormData();
      form.append("file", file);
      const st = await getJson<InstallStatus>("/api/ocharts/upload", {
        method: "POST",
        body: form,
      });
      setInstall(st);
    });

  /** Deliberately NOT a `createResource` on mount: this walks the regions
   * server-side with a HEAD each to freenauticalchart.net, and the boat is
   * normally at sea with no internet — a timeout, not a refusal. Opening the
   * Charts panel must not stall on a source nobody asked about. */
  const loadFnc = () =>
    act(async () => {
      setFncNote("");
      const body = await getJson<{ regions: FncRegionState[] }>("/api/ocharts/fnc/catalog");
      setFnc(body.regions);
    });

  const installFnc = (entry: FncRegionState) =>
    act(async () => {
      setFncNote("");
      const st = await getJson<InstallStatus>("/api/ocharts/fnc/install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // `force: false` matches the backend's own default (routes.py) —
        // spelled out because openapi-typescript treats a defaulted property
        // as always-present in the generated request type.
        body: JSON.stringify({ region: entry.region, force: false } satisfies FncInstallBody),
      });
      // `current`: the server started nothing, no job to poll — say so here.
      if (st.state === "current") {
        setFncNote(`${entry.label} is already up to date.`);
        return;
      }
      setInstall(st);
    });

  const deleteSet = (id: string) =>
    act(async () => {
      await getJson(`/api/ocharts/sets/${encodeURIComponent(id)}`, { method: "DELETE" });
      setConfirmDelete("");
      await refetchStatus();
      props.onCatalogChanged();
    });

  const installState = () => install() ?? status()?.install ?? null;

  return (
    <AccordionSection value="charts" title="Charts" icon={Library}>
      {/* Own request, independent of ServerSettings' reachability gate this
          section sits behind — a boat answering /config can still fail
          /api/ocharts/status, so this needs its own error/Retry too. */}
      <Show
        when={!status.error}
        fallback={
          <div class="space-y-1 pb-2">
            <p class="text-xs text-notice">
              The boat's server did not answer for the chart library. Installed sets and the shop
              cannot be shown right now.
            </p>
            <p class="break-all text-xs text-fg-2">{String(status.error)}</p>
            <Button disabled={status.loading} onClick={() => void refetchStatus()}>
              Retry
            </Button>
          </div>
        }
      >
        <section class="space-y-1">
          <h3 class="font-medium">Installed o-charts sets</h3>
          <Show
            when={(status()?.sets ?? []).length > 0}
            fallback={
              <p class="text-fg-2">{status.loading ? "Loading…" : "No o-charts sets installed."}</p>
            }
          >
            <ul class="space-y-1">
              <For each={status()?.sets}>
                {(set) => (
                  <li class="rounded border border-line-2 p-2">
                    <div class="flex items-center justify-between gap-2">
                      <div>
                        <div class="font-medium">{set.name}</div>
                        <div class="text-xs text-fg-2">
                          {set.cells} cells
                          {set.edition && ` · edition ${set.edition}`}
                          {set.valid_to && ` · valid to ${set.valid_to}`}
                        </div>
                      </div>
                      <Show
                        when={confirmDelete() === set.id}
                        fallback={
                          <Button
                            variant="tinted"
                            tone="alarm"
                            class="shrink-0 font-medium"
                            disabled={busy()}
                            onClick={() => setConfirmDelete(set.id)}
                          >
                            Delete
                          </Button>
                        }
                      >
                        <span class="flex shrink-0 gap-1">
                          <Button variant="danger" disabled={busy()} onClick={() => deleteSet(set.id)}>
                            Really delete
                          </Button>
                          <Button disabled={busy()} onClick={() => setConfirmDelete("")}>
                            Keep
                          </Button>
                        </span>
                      </Show>
                    </div>
                    <Show when={Object.keys(set.cell_errors).length > 0}>
                      <div class="text-xs text-alarm">
                        {Object.keys(set.cell_errors).length} cells failed to open
                      </div>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>

        {/* Not gated on the o-charts login: the free charts update without one. */}
        <section class="space-y-1">
            <h3 class="font-medium">Updates</h3>
            <Toggle
              label="Update charts automatically"
              checked={props.cfg.config()?.ocharts.auto_update ?? false}
              disabled={props.cfg.busy() || props.cfg.config() == null}
              onChange={(value) =>
                void props.cfg.patch({ ocharts: { auto_update: value } }, { scope: "charts" })
              }
            />
            <Show when={props.cfg.scope() === "charts" && props.cfg.error()}>
              <p class="text-xs text-alarm">{props.cfg.error()}</p>
            </Show>
            <p class="text-xs text-fg-2">
              About once a day, when the boat has internet, newer editions of the installed
              o-charts sets and free charts are downloaded and replace the old ones. No licence
              slot is used.
            </p>
            <Show when={status()?.credentials_present}>
              <p class="text-xs" classList={{ "text-notice": !!updatesState()?.error }}>
                {updatesSummary(updatesState(), Date.now() / 1000)}
              </p>
            </Show>
            <Show when={fncUpdatesSummary(updatesState(), Date.now() / 1000)}>
              {(line) => (
                <p class="text-xs" classList={{ "text-notice": !!updatesState()?.fnc.error }}>
                  {line()}
                </p>
              )}
            </Show>
            <Show when={(updatesState()?.updates ?? []).length > 0}>
              <ul class="space-y-1">
                <For each={updatesState()?.updates}>
                  {(u) => (
                    <li class="rounded border border-line-2 p-2 text-xs">
                      <span class="font-medium">{u.name}</span>: {u.installed_edition} →{" "}
                      {u.available_edition}
                      <Show when={u.failed}>
                        <div class="text-alarm">Last attempt failed: {u.failed}</div>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <For each={updatesState()?.installed}>
              {(done) => (
                <p class="text-xs text-ok">
                  Updated {done.name} to {done.edition}.
                </p>
              )}
            </For>
            <div class="flex gap-2">
              <Show when={status()?.credentials_present}>
                <Button
                  disabled={busy() || updatesState()?.state !== "idle"}
                  onClick={checkUpdates}
                >
                  Check for updates
                </Button>
              </Show>
              {/* Always offered: it also brings the free charts up to date,
                  which "Check for updates" (the shop's list) says nothing about. */}
              <Show when={(status()?.sets ?? []).length > 0}>
                <Button
                  variant={(updatesState()?.updates ?? []).length > 0 ? "primary" : "secondary"}
                  disabled={
                    busy() ||
                    updatesState()?.state !== "idle" ||
                    ACTIVE_INSTALL_STATES.has(installState()?.state ?? "")
                  }
                  onClick={installUpdates}
                >
                  Update now
                </Button>
              </Show>
            </div>
        </section>

        <section class="space-y-2">
          <h3 class="font-medium">o-charts shop</h3>
          <Show
            when={status()?.credentials_present}
            fallback={
              // The env file this used to name is gone; point at the config form instead.
              <p class="text-fg-2">
                No o-charts login configured. Add one under{" "}
                <span class="font-medium">o-charts account</span> below.
              </p>
            }
          >
            <Show
              when={shop()}
              fallback={
                <Button variant="primary" size="lg" disabled={busy()} onClick={connect}>
                  {busy() ? "Connecting…" : "Connect to shop"}
                </Button>
              }
            >
              {(state) => (
                <>
                  <Show
                    when={state().registered}
                    fallback={
                      <div class="space-y-2">
                        <p class="text-notice">
                          This system is not registered at o-charts.org. Registering binds this
                          machine to a system name — it cannot be undone.
                        </p>
                        <div class="flex gap-2">
                          <input
                            class="w-full rounded border border-line px-2 py-1 focus:border-accent focus:outline-none"
                            placeholder="System name (e.g. boatpc)"
                            value={systemName()}
                            onInput={(e) => setSystemName(e.currentTarget.value)}
                          />
                          <Button
                            variant="primary"
                            size="md"
                            disabled={!canRegister(state(), systemName(), busy())}
                            onClick={register}
                          >
                            Register
                          </Button>
                        </div>
                      </div>
                    }
                  >
                    <p>
                      Registered as <span class="font-medium">{state().system_name}</span>
                    </p>
                  </Show>

                  <div class="space-y-1">
                    <h4 class="font-medium">Your charts</h4>
                    <Show
                      when={state().charts.length > 0}
                      fallback={<p class="text-fg-2">No charts in this account.</p>}
                    >
                      <ul class="space-y-1">
                        <For each={state().charts}>
                          {(chart) => {
                            const mySlot = () =>
                              chart.slots.find((s) => s.assigned_system === state().system_name) ??
                              null;
                            const canInstall = () =>
                              !chart.expired &&
                              (mySlot() !== null || (!!chart.order && !!chart.quantity_id));
                            return (
                              <li class="rounded border border-line-2 p-2">
                                <div class="flex items-center justify-between gap-2">
                                  <div>
                                    <div class="font-medium">{chart.name}</div>
                                    <div class="text-xs text-fg-2">
                                      edition {chart.edition}
                                      {chart.expired && " · expired"}
                                      {!chart.expired &&
                                        !mySlot() &&
                                        " · installing binds a license slot"}
                                    </div>
                                  </div>
                                  <Show
                                    when={canInstall()}
                                    fallback={
                                      <span class="text-xs text-fg-3">
                                        {chart.expired ? "expired" : "not installable"}
                                      </span>
                                    }
                                  >
                                    <Button
                                      variant="success"
                                      disabled={
                                        busy() ||
                                        ACTIVE_INSTALL_STATES.has(installState()?.state ?? "")
                                      }
                                      onClick={() => installChart(chart, mySlot())}
                                    >
                                      Install
                                    </Button>
                                  </Show>
                                </div>
                              </li>
                            );
                          }}
                        </For>
                      </ul>
                    </Show>
                  </div>
                </>
              )}
            </Show>
          </Show>
        </section>

        <section class="space-y-2">
          <h3 class="font-medium">Free charts</h3>
          <p class="text-xs text-fg-2">
            Public-domain (CC0) vector charts from freenauticalchart.net, built from BSH and
            Rijkswaterstaat open data. No account and no licence — they install alongside the
            o-charts sets above.
          </p>
          <Show
            when={fnc()}
            fallback={
              <Button disabled={busy()} onClick={loadFnc}>
                {busy() ? "Checking…" : "Check for free charts"}
              </Button>
            }
          >
            {(regions) => (
              <ul class="space-y-1">
                <For each={regions()}>
                  {(entry) => {
                    const action = () =>
                      fncAction(entry, busy(), ACTIVE_INSTALL_STATES.has(installState()?.state ?? ""));
                    return (
                      <li class="rounded border border-line-2 p-2">
                        <div class="flex items-center justify-between gap-2">
                          <div>
                            <div class="font-medium">{entry.label}</div>
                            <div class="text-xs text-fg-2">
                              <Show
                                when={entry.available}
                                fallback={
                                  <span class="text-notice">
                                    Could not reach freenauticalchart.net
                                  </span>
                                }
                              >
                                {(v) => (
                                  <>
                                    published {v().published}
                                    {fncSize(v().size) && ` · ${fncSize(v().size)} download`}
                                    {entry.installed && ` · installed ${entry.installed.published}`}
                                  </>
                                )}
                              </Show>
                            </div>
                          </div>
                          <Button
                            variant={entry.update_available ? "primary" : "success"}
                            class="shrink-0"
                            disabled={action().disabled}
                            onClick={() => installFnc(entry)}
                          >
                            {action().label}
                          </Button>
                        </div>
                      </li>
                    );
                  }}
                </For>
              </ul>
            )}
          </Show>
          <Show when={fncNote()}>
            <p class="text-xs text-fg-2">{fncNote()}</p>
          </Show>
        </section>

        <section class="space-y-1">
          <h3 class="font-medium">Manual install</h3>
          <label class="block text-xs text-fg-2">
            Upload a chart zip (offline shop download)
            <input
              type="file"
              accept=".zip"
              class="mt-1 block w-full text-xs"
              disabled={busy()}
              onChange={(e) => {
                const file = e.currentTarget.files?.[0];
                if (file) void upload(file);
                e.currentTarget.value = "";
              }}
            />
          </label>
        </section>

        <Show when={installState()}>
          {(st) => (
            <Show when={st().state !== "idle"}>
              <section class="space-y-1">
                <h3 class="font-medium">Install</h3>
                <div class="text-xs">
                  {st().detail && <span class="font-medium">{st().detail}: </span>}
                  <span>{PHASE_LABEL[st().state] ?? st().state}</span>
                  <Show when={st().state === "download"}> — {st().progress}%</Show>
                </div>
                <Show when={ACTIVE_INSTALL_STATES.has(st().state)}>
                  <div class="h-1.5 w-full overflow-hidden rounded bg-chrome-2">
                    {/* Only download has a real fraction; other phases pulse. */}
                    <div
                      class="h-full rounded bg-accent transition-all"
                      classList={{ "animate-pulse": st().state !== "download" }}
                      style={{
                        width: st().state === "download" ? `${st().progress}%` : "100%",
                      }}
                    />
                  </div>
                </Show>
                <Show when={st().state === "error"}>
                  <p class="text-xs text-alarm">{st().error}</p>
                </Show>
                <Show when={st().state === "done"}>
                  <p class="text-xs text-ok">Installed {st().set_id}.</p>
                </Show>
              </section>
            </Show>
          )}
        </Show>

        <Show when={error()}>
          <p class="text-xs text-alarm">{error()}</p>
        </Show>
        <Show when={status()?.daemon?.error}>
          <p class="text-xs text-notice">Daemon: {status()?.daemon?.error}</p>
        </Show>
      </Show>
    </AccordionSection>
  );
};

export default ChartLibrarySection;
