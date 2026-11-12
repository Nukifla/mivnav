// Which SignalK history provider the ship's track is read from — a dropdown of
// the providers the box itself has registered (`GET /track/providers`). Exists
// because a second plugin registering as a history provider can become
// SignalK's default and silently empty the track (KIP did, on this boat:
// mivnav.features.track.config).

import { createResource, For, Show, type Component } from "solid-js";
import { Button } from "../ui/Button";

export interface HistoryProvider {
  id: string;
  /** The one SignalK answers from when a query names none. */
  default: boolean;
}

export interface HistoryProviders {
  providers: HistoryProvider[];
  /** `track.history_provider`; `null` = SignalK's default. */
  selected: string | null;
}

export async function fetchHistoryProviders(): Promise<HistoryProviders> {
  const res = await fetch("/api/track/providers");
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: unknown } | null;
    throw new Error(typeof body?.detail === "string" ? body.detail : `HTTP ${res.status}`);
  }
  return (await res.json()) as HistoryProviders;
}

export interface ProviderOption {
  /** `""` = name none, use SignalK's default. */
  value: string;
  label: string;
}

/** The dropdown's options: SignalK's default first, then every registered
 * provider — and the configured one even when the box no longer registers
 * it, so the select never silently shows a different choice than is saved. */
export function providerOptions(
  providers: readonly HistoryProvider[],
  selected: string | null,
): ProviderOption[] {
  const current = providers.find((p) => p.default);
  const options: ProviderOption[] = [
    { value: "", label: current ? `SignalK's default (now ${current.id})` : "SignalK's default" },
    ...providers.map((p) => ({ value: p.id, label: p.default ? `${p.id} (default)` : p.id })),
  ];
  if (selected && !providers.some((p) => p.id === selected)) {
    options.push({ value: selected, label: `${selected} (not registered)` });
  }
  return options;
}

export const HistoryProviderField: Component<{
  /** The saved choice, from the config document. */
  value: string | null;
  disabled: boolean;
  onCommit: (provider: string | null) => void;
  /** Test seam; the app reads the real endpoint. */
  load?: () => Promise<HistoryProviders>;
}> = (props) => {
  const [found, { refetch }] = createResource(props.load ?? fetchHistoryProviders);
  const options = () => providerOptions(found.latest?.providers ?? [], props.value);

  return (
    <div class="space-y-1">
      <label class="block">
        <span class="text-xs text-fg-2">Track history provider</span>
        <select
          class="mt-1 w-full rounded border border-line px-2 py-1 focus:border-accent focus:outline-none disabled:opacity-40"
          disabled={props.disabled}
          value={props.value ?? ""}
          onChange={(e) => props.onCommit(e.currentTarget.value || null)}
        >
          <For each={options()}>{(o) => <option value={o.value}>{o.label}</option>}</For>
        </select>
      </label>
      <Show
        when={!found.error}
        fallback={
          <p class="text-xs text-alarm">
            Could not list the box's history providers: {(found.error as Error).message}
          </p>
        }
      >
        <p class="text-xs text-fg-3">
          The SignalK plugin the ship's track is read from. Another plugin that registers one (KIP
          does) can become SignalK's default and hold no track at all — name the one that records
          positions. Takes effect at once.
        </p>
      </Show>
      <Button disabled={found.loading} onClick={() => void refetch()}>
        Detect again
      </Button>
    </div>
  );
};
