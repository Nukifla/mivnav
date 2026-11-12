import { Show, type Component } from "solid-js";
import TriangleAlert from "lucide-solid/icons/triangle-alert";
import Info from "lucide-solid/icons/info";
import { Button } from "../ui/Button";
import { describeFetchError, faultHint } from "../splash";

// The one on-chart signal that the chart is missing (the sidebar hides this
// otherwise). Amber not red (red is reserved for real alarms), shown only
// when no chart at all — a stale-but-present chart stays silent.
// See docs/architecture/catalog-alert.md.

/** Pure decision behind the component, extracted so it's testable without a
 * DOM. `"empty"` requires `!error`, so error wins over empty by
 * construction. See docs/architecture/catalog-alert.md for the three states. */
export type CatalogSignpost = "error" | "empty" | "none";

export function catalogSignpost(s: {
  loading: boolean;
  error: string;
  setCount: number;
}): CatalogSignpost {
  const chartless = s.setCount === 0;
  if (s.error && chartless) return "error";
  if (!s.loading && !s.error && chartless) return "empty";
  return "none";
}

const CatalogAlert: Component<{
  /** An attempt is in flight (catalog.ts's `loading`) — gates the empty signpost. */
  loading: boolean;
  /** catalog.ts's `error`. Empty when the last fetch was fine. */
  error: string;
  /** How many chart sets the catalog holds. Zero is the blank-map case. */
  setCount: number;
  onRetry: () => void;
}> = (props) => {
  const signpost = () =>
    catalogSignpost({ loading: props.loading, error: props.error, setCount: props.setCount });
  return (
  <>
    <Show when={signpost() === "error"}>
      {/* Left gutter clears the sidebar button; the strip itself takes no
          pointer events, so the chart under it stays draggable. */}
      <div
        role="status"
        class="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center p-3 pl-16 pr-3 pt-[max(0.75rem,env(safe-area-inset-top))]"
      >
        <div class="pointer-events-auto flex max-w-sm items-start gap-2 rounded-lg bg-chrome/90 p-3 shadow-lg">
          <TriangleAlert size={20} aria-hidden="true" class="mt-0.5 shrink-0 text-notice" />
          <div class="space-y-1">
            <p class="font-medium text-notice">No charts loaded: {describeFetchError(props.error)}</p>
            <p class="text-xs text-fg-2">
              The boat's server did not send the chart list. This is not an empty chart folder — the
              chart is missing, not absent. {faultHint(props.error, navigator.onLine)} Retrying
              automatically.
            </p>
            <p class="break-all text-xs text-fg-3">{props.error}</p>
            <Button onClick={props.onRetry}>Retry now</Button>
          </div>
        </div>
      </div>
    </Show>

    {/* First-run signpost: quiet and neutral, no Retry — nothing to retry,
        the mariner installs a chart. Deliberately distinct from the fault
        box above so failure and empty folder never read as the same thing. */}
    <Show when={signpost() === "empty"}>
      <div
        role="status"
        class="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center p-3 pl-16 pr-3 pt-[max(0.75rem,env(safe-area-inset-top))]"
      >
        <div class="pointer-events-auto flex max-w-sm items-start gap-2 rounded-lg bg-chrome/90 p-3 shadow-lg">
          <Info size={20} aria-hidden="true" class="mt-0.5 shrink-0 text-fg-2" />
          <div class="space-y-1">
            <p class="font-medium text-fg">No charts installed yet</p>
            <p class="text-xs text-fg-2">
              The boat's server is fine — there are just no charts here yet. Open Tools → Settings →
              Server settings → Charts to add some.
            </p>
          </div>
        </div>
      </div>
    </Show>
  </>
  );
};

export default CatalogAlert;
