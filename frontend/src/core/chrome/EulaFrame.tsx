// One o-charts licence agreement (EULA), as the chart set ships it. Shared by
// the screen-registration prompt, the install-time accept step and the Chart
// licences page.

import type { Component } from "solid-js";

/** Sandboxed vendor HTML (the server also sends `CSP: sandbox`). `id` is the
 * EULA's hash; `/api/ocharts/eula/{id}` serves installed sets' texts and the
 * one a waiting install ships. */
export const EulaFrame: Component<{ id: string; sets: string[] }> = (props) => (
  <div class="space-y-1">
    <div class="text-xs text-fg-2">Licence agreement for {props.sets.join(", ")}</div>
    <iframe
      title={`Licence agreement for ${props.sets.join(", ")}`}
      src={`/api/ocharts/eula/${encodeURIComponent(props.id)}`}
      sandbox=""
      class="h-[40dvh] w-full rounded border border-line bg-white"
    />
  </div>
);
