// The full-screen "register this screen for o-charts" prompt, and the device
// list it shares with Settings. Opens on its own once per launch while this
// screen may not show the boat's licensed charts (core/ochartsDevice.ts);
// closable, reopenable from Settings → Charts → Screens, and silenced for
// good by "Don't show again". Nothing else on the plotter depends on it.

import { Dialog } from "@kobalte/core/dialog";
import { createEffect, createResource, createSignal, For, Show, type Component } from "solid-js";
import { Button } from "../ui/Button";
import { useBackDismiss } from "./backStack";
import { SHEET_Z } from "./Sheet";
import { EulaFrame } from "./EulaFrame";
import {
  defaultDeviceName,
  pendingEulaIds,
  seenText,
  type DeviceInfo,
  type OchartsDevice,
} from "../ochartsDevice";

const INPUT =
  "mt-1 w-full rounded border border-line bg-chrome px-2 py-1 focus:border-accent focus:outline-none disabled:opacity-40";

function suggestedName(): string {
  const standalone =
    typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches;
  return defaultDeviceName(navigator.userAgent, navigator.maxTouchPoints > 1, standalone);
}

/** The registered screens, each removable (by anyone — the cap counts
 * screens, it is not a login) and, for this one, renamable. */
export const DeviceSlots: Component<{
  device: OchartsDevice;
  /** Bumped by the caller to refetch (after registering etc.). */
  version?: number;
}> = (props) => {
  const [devices, { refetch }] = createResource(
    () => props.version ?? 0,
    () => props.device.list(),
  );
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal("");
  const [editing, setEditing] = createSignal<string | null>(null);

  const act = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    setError("");
    try {
      await fn();
      await refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  return (
    <div class="space-y-1">
      <Show when={devices.error}>
        <p class="text-xs text-notice">Could not load the list of screens.</p>
      </Show>
      <ul class="space-y-1">
        <For each={devices() ?? []}>
          {(d: DeviceInfo) => (
            <li class="flex items-center gap-2 rounded border border-line-2 p-2">
              <div class="min-w-0 flex-1">
                <Show
                  when={editing() !== null && d.current}
                  fallback={
                    <div class="truncate font-medium">
                      {d.name}
                      <Show when={d.current}>
                        <span class="ml-2 text-xs font-normal text-accent">this screen</span>
                      </Show>
                    </div>
                  }
                >
                  <input
                    class={INPUT}
                    aria-label="Name for this screen"
                    value={editing() ?? ""}
                    maxLength={60}
                    onInput={(e) => setEditing(e.currentTarget.value)}
                  />
                </Show>
                <div class="text-xs text-fg-2">{seenText(d.seen_ago_s)}</div>
              </div>
              <Show when={d.current}>
                <Show
                  when={editing() !== null}
                  fallback={
                    <Button disabled={busy() !== ""} onClick={() => setEditing(d.name)}>
                      Rename
                    </Button>
                  }
                >
                  <Button
                    disabled={busy() !== "" || (editing() ?? "").trim() === ""}
                    onClick={() => {
                      const name = (editing() ?? "").trim();
                      setEditing(null);
                      if (name !== d.name) void act(d.id, () => props.device.rename(d.id, name));
                    }}
                  >
                    Save
                  </Button>
                </Show>
              </Show>
              <Button
                variant="tinted"
                tone="alarm"
                disabled={busy() !== ""}
                onClick={() => void act(d.id, () => props.device.remove(d.id))}
              >
                {busy() === d.id ? "Removing…" : "Remove"}
              </Button>
            </li>
          )}
        </For>
      </ul>
      <Show when={error()}>
        <p class="text-xs text-alarm">{error()}</p>
      </Show>
    </div>
  );
};

const DeviceRegistration: Component<{
  device: OchartsDevice;
  /** False while the boot splash is up: the prompt waits behind it rather
   * than open under it, where its modal lock would also take the splash's
   * own "Try again"/"Open anyway" buttons out of reach. */
  ready?: () => boolean;
}> = (props) => {
  const d = props.device;
  const open = () => d.promptOpen() && (props.ready?.() ?? true);
  useBackDismiss(open, d.closePrompt);

  const status = () => d.status();
  const pending = () => (status()?.eulas ?? []).filter((e) => !e.accepted);
  const full = () => {
    const s = status();
    return s !== undefined && !s.registered && s.count >= s.max;
  };

  const [name, setName] = createSignal("");
  const [agreed, setAgreed] = createSignal(false);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [listVersion, setListVersion] = createSignal(0);

  // Fresh each time it opens: a suggested name, nothing pre-ticked.
  createEffect(() => {
    if (!open()) return;
    setName(suggestedName());
    setAgreed(false);
    setError("");
    setListVersion((v) => v + 1);
  });

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const ids = pending().map((e) => e.id);
      if (status()?.registered) await d.accept(ids);
      else await d.register(name().trim(), ids);
      d.closePrompt();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setListVersion((v) => v + 1); // the list may have changed under us
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = () =>
    !busy() &&
    (pending().length === 0 || agreed()) &&
    (status()?.registered || (name().trim() !== "" && !full()));

  return (
    <Dialog open={open()} onOpenChange={(o) => !o && d.closePrompt()} modal>
      <Dialog.Portal>
        <Dialog.Content
          class="fixed inset-0 flex flex-col bg-chrome text-sm text-fg"
          style={{ "z-index": SHEET_Z.modal }}
          onEscapeKeyDown={() => d.closePrompt()}
        >
          <div class="flex shrink-0 items-center justify-between gap-2 border-b border-line-2 py-1 pl-4 pr-1">
            <Dialog.Title class="font-semibold">
              {status()?.registered ? "o-charts licence agreement" : "Register this screen for o-charts"}
            </Dialog.Title>
            <Dialog.CloseButton
              class="flex size-11 items-center justify-center rounded-full text-2xl leading-none text-fg-2 hover:bg-chrome-2"
              aria-label="Close"
            >
              ×
            </Dialog.CloseButton>
          </div>

          <div class="min-h-0 flex-1 overflow-y-auto">
            <div class="mx-auto max-w-2xl space-y-4 p-4">
              <Show
                when={status()?.registered}
                fallback={
                  <>
                    <Show when={status()?.removed}>
                      <p class="rounded border border-notice p-2 text-notice">
                        Another screen removed this one from the o-charts list.
                      </p>
                    </Show>
                    <p class="text-fg-2">
                      Up to {status()?.max ?? 5} screens can show this boat's o-charts. This one is not
                      registered, so it shows only the free charts. Everything else — AIS, instruments,
                      routes, the autopilot — works the same either way.
                    </p>
                    <label class="block">
                      <span class="text-xs text-fg-2">Name for this screen</span>
                      <input
                        class={INPUT}
                        value={name()}
                        maxLength={60}
                        onInput={(e) => setName(e.currentTarget.value)}
                      />
                    </label>
                  </>
                }
              >
                <p class="text-fg-2">
                  The licence agreement of the installed o-charts has changed. Accept it to keep showing
                  them on this screen.
                </p>
              </Show>

              {/* Keyed by id, not by the poll's fresh objects: a remount
                  reloads the iframe and loses the reader's place. */}
              <For each={pendingEulaIds(status())}>
                {(id) => <EulaFrame id={id} sets={pending().find((e) => e.id === id)?.sets ?? []} />}
              </For>
              <Show when={pending().length > 0}>
                <label class="flex items-center gap-2">
                  <input
                    type="checkbox"
                    class="size-4 accent-accent"
                    checked={agreed()}
                    onChange={(e) => setAgreed(e.currentTarget.checked)}
                  />
                  <span>I accept the licence agreement{pending().length > 1 ? "s" : ""}</span>
                </label>
              </Show>

              <Show when={full()}>
                <div class="space-y-2">
                  <p class="text-notice">
                    All {status()?.max} screens are registered. Remove one that no longer needs o-charts
                    to register this one.
                  </p>
                  <DeviceSlots device={d} version={listVersion()} />
                </div>
              </Show>

              <Show when={error()}>
                <p class="text-alarm">{error()}</p>
              </Show>
            </div>
          </div>

          <div class="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line-2 p-3">
            <Show when={!status()?.registered}>
              <Button size="md" onClick={() => d.hidePromptForever()}>
                Don't show again
              </Button>
            </Show>
            <Button size="md" onClick={() => d.closePrompt()}>
              Not now
            </Button>
            <Button size="md" variant="primary" disabled={!canSubmit()} onClick={() => void submit()}>
              {busy() ? "Saving…" : status()?.registered ? "Accept" : "Register"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  );
};

export default DeviceRegistration;
