import { For, Show, type Component } from "solid-js";
import Map from "lucide-solid/icons/map";
import { AccordionSection } from "../ui/Accordion";
import { Toggle } from "../ui/Controls";
import { Button } from "../ui/Button";
import type { ChartSet } from "../catalog";

interface ChartSetsSectionProps {
  /** The full catalog — disabled sets included, since this is where they are
   * turned back on. */
  sets: ChartSet[];
  disabledSets: string[];
  onToggleSet: (id: string, enabled: boolean) => void;
  /** Non-empty when the catalog did not arrive (catalog.ts). An empty list
   * then means "we don't know", not "none installed", and this section must
   * not say the second thing while the first is true. */
  catalogError: string;
  onRetryCatalog: () => void;
}

/**
 * `disabledSets` is a per-device setting (localStorage) — one screen on the
 * harbour plan while another shows the approach is the point, not a bug. A
 * catalog that never arrived is a server fact, not a device one, so it gets the amber `Offline` treatment.
 */
const ChartSetsSection: Component<ChartSetsSectionProps> = (props) => (
  <AccordionSection value="sets" title="Chart sets" icon={Map}>
    <Show
      when={props.sets.length > 0}
      fallback={
        <Show
          when={props.catalogError}
          fallback={<p class="text-fg-2">No chart sets available.</p>}
        >
          <CatalogFailed error={props.catalogError} onRetry={props.onRetryCatalog} />
        </Show>
      }
    >
      <ul class="space-y-1">
        <For each={props.sets}>
          {(set) => (
            <li class="rounded border border-line-2 p-2">
              <Toggle
                label={set.name}
                checked={!props.disabledSets.includes(set.id)}
                onChange={(value) => props.onToggleSet(set.id, value)}
              />
              <div class="pl-11 text-xs text-fg-2">
                {set.id} · z{set.min_zoom}–{set.max_zoom}
              </div>
            </li>
          )}
        </For>
      </ul>
    </Show>
  </AccordionSection>
);

/** The chart list did not arrive — reuses the `Offline` vocabulary ServerSettings established. */
const CatalogFailed: Component<{ error: string; onRetry: () => void }> = (props) => (
  <div class="space-y-1">
    <p class="text-xs text-notice">
      The boat's server did not send the chart list, so we cannot tell which charts it has. Retrying
      automatically.
    </p>
    <p class="text-xs text-fg-3">{props.error}</p>
    <Button onClick={props.onRetry}>Retry now</Button>
  </div>
);

export default ChartSetsSection;
