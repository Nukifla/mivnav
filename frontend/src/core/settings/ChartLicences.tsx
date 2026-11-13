// Settings → Charts → Chart licences: every installed licensed o-charts set,
// its licence agreement (readable at any time, as the o-charts policy
// requires), and when it was accepted. Not tied to this screen's device
// registration — an agreement is not chart data, and `/api/ocharts/licences`
// and `/api/ocharts/eula/{id}` are not device-gated.

import { createResource, createSignal, For, Show, type Component } from "solid-js";
import ScrollText from "lucide-solid/icons/scroll-text";
import type { components } from "../../api.generated";
import { AccordionSection } from "../ui/Accordion";
import { Button } from "../ui/Button";
import { EulaFrame } from "../chrome/EulaFrame";
import { acceptedText, NOT_OFFICIAL_CHARTS } from "../ochartsLicence";

type LicencesOut = components["schemas"]["LicencesOut"];

export const CHART_LICENCES_SCOPE = "chart-licences";

async function fetchLicences(): Promise<LicencesOut> {
  const res = await fetch("/api/ocharts/licences");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as LicencesOut;
}

const ChartLicencesSection: Component = () => {
  const [licences, { refetch }] = createResource(fetchLicences);
  // set id whose agreement is open — one iframe at a time
  const [open, setOpen] = createSignal("");
  return (
    <AccordionSection value={CHART_LICENCES_SCOPE} title="Chart licences" icon={ScrollText}>
      <p class="text-xs font-medium">{NOT_OFFICIAL_CHARTS}</p>
      <Show
        when={!licences.error}
        fallback={
          <div class="space-y-1">
            <p class="text-xs text-notice">The boat's server did not answer for the chart licences.</p>
            <Button onClick={() => void refetch()}>Retry</Button>
          </div>
        }
      >
        <Show
          when={(licences()?.sets ?? []).length > 0}
          fallback={
            <p class="text-xs text-fg-2">
              {licences.loading ? "Loading…" : "No licensed o-charts sets are installed."}
            </p>
          }
        >
          <ul class="space-y-1">
            <For each={licences()?.sets}>
              {(l) => (
                <li class="space-y-1 rounded border border-line-2 p-2">
                  <div class="flex items-center justify-between gap-2">
                    <div class="min-w-0">
                      <div class="font-medium">{l.name}</div>
                      <div class="text-xs text-fg-2">
                        {l.edition && `edition ${l.edition} · `}
                        {acceptedText(l)}
                      </div>
                    </div>
                    <Show when={l.eula_id}>
                      <Button
                        class="shrink-0"
                        onClick={() => setOpen(open() === l.set_id ? "" : l.set_id)}
                      >
                        {open() === l.set_id ? "Hide agreement" : "Read agreement"}
                      </Button>
                    </Show>
                  </div>
                  <Show when={open() === l.set_id && l.eula_id}>
                    {(id) => <EulaFrame id={id()} sets={[l.name]} />}
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </AccordionSection>
  );
};

export default ChartLicencesSection;
