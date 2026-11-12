import { createSignal, Match, Show, Switch, type Component } from "solid-js";
import Package from "lucide-solid/icons/package";
import { AccordionSection } from "../ui/Accordion";
import { Button } from "../ui/Button";
import { Toggle } from "../ui/Controls";
import type { ServerConfigController } from "../serverConfig";
import {
  createSoftwareUpdate,
  displayVersion,
  isInProgress,
  STATE_LABEL,
  type SoftwareUpdateController,
  type UpdateStatus,
} from "../softwareUpdate";

/** Its own feedback scope, so a refused toggle reports here. */
export const SOFTWARE_SCOPE = "software";

const OUTCOME_CLASS: Partial<Record<UpdateStatus["state"], string>> = {
  done: "text-ok",
  failed: "text-alarm",
  rolled_back: "text-notice",
};

/** `2026-11-02T10:00:00Z` → the reader's local date and time, short. */
function when(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** The running version line: version, install kind, and a source
 * checkout's commit. */
const Running: Component<{ ctl: SoftwareUpdateController }> = (props) => {
  const v = () => props.ctl.version();
  return (
    <div class="flex items-baseline justify-between gap-2">
      <span>
        <span class="text-xs text-fg-2">Running </span>
        <span class="font-mono font-medium">{displayVersion(v()?.version ?? "…")}</span>
        <Show when={v()?.commit}>
          <span class="font-mono text-xs text-fg-3"> ({v()!.commit!.slice(0, 7)})</span>
        </Show>
      </span>
      <Show when={v()}>
        <span class="shrink-0 text-xs text-fg-3">
          {v()!.install === "release" ? "release install" : "source checkout"}
        </span>
      </Show>
    </div>
  );
};

/** Newest release, its notes, and when GitHub was last asked. */
const Latest: Component<{ ctl: SoftwareUpdateController }> = (props) => {
  const info = () => props.ctl.info();
  const latest = () => info()?.latest ?? null;
  return (
    <div class="space-y-1">
      <Switch>
        <Match when={latest()}>
          <div class="flex flex-wrap items-baseline justify-between gap-x-2">
            <span class="text-xs">
              <span class="text-fg-2">Latest release </span>
              <span class="font-mono font-medium">{displayVersion(latest()!.version)}</span>
              <Show when={latest()!.published_at}>
                <span class="text-fg-3"> · {when(latest()!.published_at)}</span>
              </Show>
            </span>
            <span class={`shrink-0 text-xs ${info()!.available ? "text-accent" : "text-ok"}`}>
              {info()!.available ? "update available" : "up to date"}
            </span>
          </div>
          <Show when={latest()!.notes || latest()!.notes_url}>
            <details class="text-xs">
              <summary class="cursor-pointer text-fg-2 pointer-coarse:py-1">Release notes</summary>
              <Show when={latest()!.notes}>
                <p class="mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded border border-line-2 p-2 text-fg-2">
                  {latest()!.notes}
                </p>
              </Show>
              <Show when={latest()!.notes_url}>
                <a
                  class="mt-1 inline-block text-accent underline"
                  href={latest()!.notes_url!}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  On GitHub
                </a>
              </Show>
            </details>
          </Show>
        </Match>
        <Match when={info() && !info()!.checked_at}>
          <p class="text-xs text-fg-3">Not checked for updates yet.</p>
        </Match>
        <Match when={info()?.checked_at && !info()!.error}>
          <p class="text-xs text-fg-3">No releases published yet.</p>
        </Match>
      </Switch>
      <Show when={info()?.error}>
        <p class="text-xs text-notice">Could not check for updates: {info()!.error}</p>
      </Show>
      <Show when={info()?.checked_at}>
        <p class="text-xs text-fg-3">Checked {when(info()!.checked_at)}</p>
      </Show>
    </div>
  );
};

/** Live progress while an update runs, else the last run's outcome. */
const Progress: Component<{ ctl: SoftwareUpdateController }> = (props) => {
  const status = () => props.ctl.info()?.status;
  const phase = () => props.ctl.phase();
  const label = () => {
    switch (phase()) {
      case "starting":
        return "Starting the updater…";
      case "restarting":
        return "Restarting…";
      case "reloading":
        return "Updated — reloading…";
      default:
        return status() ? STATE_LABEL[status()!.state] : "";
    }
  };
  const detail = () =>
    phase() === "restarting"
      ? "The server is away while it switches versions. This page reloads when it is back."
      : status()?.message;
  const running = () => props.ctl.busy();
  const outcome = () => {
    const s = status();
    return s && !running() && OUTCOME_CLASS[s.state] ? s : null;
  };

  return (
    <Switch>
      <Match when={running()}>
        <div class="space-y-1" role="status" aria-live="polite">
          <div class="flex items-baseline justify-between gap-2">
            <span class="text-xs font-medium text-fg-2">{label()}</span>
            <Show when={status()?.to && (phase() === "running" || isInProgress(status()))}>
              <span class="shrink-0 font-mono text-xs text-fg-3">
                {status()!.from ? `${displayVersion(status()!.from!)} → ` : ""}
                {displayVersion(status()!.to!)}
              </span>
            </Show>
          </div>
          <div class="h-1.5 w-full overflow-hidden rounded-full bg-line">
            <div class="h-full w-1/3 animate-pulse rounded-full bg-accent" />
          </div>
          <Show when={detail()}>
            <p class="text-xs text-fg-3">{detail()}</p>
          </Show>
        </div>
      </Match>
      <Match when={outcome()}>
        <div class="space-y-0.5">
          <p class={`text-xs ${OUTCOME_CLASS[outcome()!.state]}`}>
            {STATE_LABEL[outcome()!.state]}
            {outcome()!.to ? ` (${displayVersion(outcome()!.to!)})` : ""}
            <Show when={outcome()!.updated_at}>
              <span class="text-fg-3"> · {when(outcome()!.updated_at)}</span>
            </Show>
          </p>
          <Show when={outcome()!.message}>
            <p class="text-xs text-fg-3">{outcome()!.message}</p>
          </Show>
        </div>
      </Match>
    </Switch>
  );
};

/**
 * Settings → Software: what the boat's server runs, whether a newer release
 * exists, and — on a release install — the one-button update and rollback.
 * A source checkout gets the facts and how to update it by hand instead.
 */
const SoftwareSection: Component<{ cfg: ServerConfigController }> = (props) => {
  const ctl = createSoftwareUpdate();
  const [confirmRollback, setConfirmRollback] = createSignal(false);
  const canUpdate = () => ctl.version()?.can_update ?? false;
  const isSource = () => ctl.version()?.install === "source";
  const latest = () => ctl.info()?.latest ?? null;
  const updates = () => props.cfg.config()?.updates;
  const saveUpdates = async (patch: { check?: boolean; include_prereleases?: boolean }) => {
    const ok = await props.cfg.patch({ updates: patch }, { scope: SOFTWARE_SCOPE, done: "Saved." });
    // The server drops its cached answer with the setting; ask again.
    if (ok && patch.include_prereleases !== undefined) void ctl.refresh();
  };

  return (
    <AccordionSection value="software" title="Software" icon={Package}>
      <Show when={ctl.loaded()} fallback={<p class="text-xs text-fg-3">Loading…</p>}>
        <Running ctl={ctl} />
        <Latest ctl={ctl} />
        <Progress ctl={ctl} />

        <Show when={isSource()}>
          <p class="text-xs text-fg-2">
            This server runs from a source checkout, so it is updated by hand: pull the new code
            with git and run <code>deploy/install-from-source.sh</code> (or{" "}
            <code>just deploy</code> from a development machine). The update button is for
            release installs.
          </p>
        </Show>
        <Show when={ctl.version()?.install === "release" && !canUpdate()}>
          <p class="text-xs text-notice">
            The updater is not installed on this server. Run <code>install.sh</code> once on it
            to enable updates from here.
          </p>
        </Show>

        <div class="flex flex-wrap items-center gap-2">
          <Button
            disabled={ctl.checking() || ctl.busy()}
            onClick={() => void ctl.checkNow()}
          >
            {ctl.checking() ? "Checking…" : "Check now"}
          </Button>
          <Show when={canUpdate() && ctl.info()?.available && latest()}>
            <Button
              variant="primary"
              size="md"
              disabled={ctl.busy()}
              onClick={() => void ctl.update()}
            >
              Update to {displayVersion(latest()!.version)}
            </Button>
          </Show>
          <Show when={canUpdate()}>
            <Show
              when={confirmRollback()}
              fallback={
                <Button disabled={ctl.busy()} onClick={() => setConfirmRollback(true)}>
                  Roll back
                </Button>
              }
            >
              <Button
                variant="tinted"
                tone="notice"
                disabled={ctl.busy()}
                onClick={() => {
                  setConfirmRollback(false);
                  void ctl.rollback();
                }}
              >
                Roll back to the previous release
              </Button>
              <Button onClick={() => setConfirmRollback(false)}>Cancel</Button>
            </Show>
          </Show>
        </div>
        <Show when={canUpdate()}>
          <p class="text-xs text-fg-3">
            Updating restarts the chart server; charts and instruments pause for about a minute.
          </p>
        </Show>
        <Show when={ctl.error()}>
          <p class="text-xs text-alarm">{ctl.error()}</p>
        </Show>

        <Show when={updates()}>
          <div class="space-y-2 border-t border-line-2 pt-2">
            <Toggle
              label="Check for updates automatically"
              hint="When this panel opens, at most every 6 hours. Off: only on Check now."
              checked={updates()!.check}
              disabled={props.cfg.busy()}
              onChange={(value) => void saveUpdates({ check: value })}
            />
            <Toggle
              label="Include pre-releases"
              checked={updates()!.include_prereleases}
              disabled={props.cfg.busy()}
              onChange={(value) => void saveUpdates({ include_prereleases: value })}
            />
            <Show when={props.cfg.scope() === SOFTWARE_SCOPE}>
              <Show when={props.cfg.error()}>
                <p class="text-xs text-alarm">{props.cfg.error()}</p>
              </Show>
              <Show when={props.cfg.status()}>
                <p class="text-xs text-ok">{props.cfg.status()}</p>
              </Show>
            </Show>
          </div>
        </Show>
      </Show>
    </AccordionSection>
  );
};

export default SoftwareSection;
