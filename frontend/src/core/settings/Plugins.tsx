// Settings → Plugins: every plugin installed on the boat's server, each with
// an on/off switch. Boat-wide (see core/pluginSwitch.ts): the server stops
// serving a switched-off plugin at once; this screen reloads to drop (or
// load) its frontend half, and other screens pick it up on their next load.

import { createSignal, For, onMount, Show, type Component } from "solid-js";
import Puzzle from "lucide-solid/icons/puzzle";
import { AccordionSection } from "../ui/Accordion";
import { Toggle } from "../ui/Controls";
import { listInstalledPlugins, setPluginEnabled, type InstalledPlugin } from "../pluginSwitch";

const PluginsSection: Component<{ reload?: () => void }> = (props) => {
  const [plugins, setPlugins] = createSignal<InstalledPlugin[] | null>(null);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal<string | null>(null);
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

  onMount(async () => {
    try {
      setPlugins(await listInstalledPlugins());
    } catch (e) {
      setError(`Could not reach the server: ${message(e)}`);
    }
  });

  const toggle = async (id: string, enabled: boolean) => {
    setBusy(id);
    setError("");
    try {
      setPlugins(await setPluginEnabled(id, enabled));
      // A plugin's frontend half is registered at boot: reload to apply.
      (props.reload ?? (() => location.reload()))();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <AccordionSection value="plugins" title="Plugins" icon={Puzzle}>
      <Show when={plugins()} fallback={<p class="text-xs text-fg-3">{error() || "Loading…"}</p>}>
        {(list) => (
          <>
            <Show
              when={list().length > 0}
              fallback={<p class="text-xs text-fg-3">No plugins are installed on the boat's server.</p>}
            >
              <For each={list()}>
                {(p) => (
                  <Toggle
                    label={p.label}
                    checked={p.enabled}
                    disabled={busy() !== null}
                    onChange={(v) => void toggle(p.id, v)}
                  />
                )}
              </For>
              <p class="text-[11px] leading-snug text-fg-3">
                For the whole boat: a plugin switched off stops working on every screen, and
                its settings and data are kept for when it is switched back on. This screen
                reloads to apply the change.
              </p>
            </Show>
            <Show when={error()}>
              <p class="text-xs text-alarm">{error()}</p>
            </Show>
          </>
        )}
      </Show>
    </AccordionSection>
  );
};

export default PluginsSection;
