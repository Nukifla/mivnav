// The mivport dataset's own params, shown by the host's POI dataset form under
// the source picker while mivport is selected. The backend is the validator;
// this only shapes the draft and its defaults.

import type { Component } from "solid-js";
import type { DatasetParamsProps } from "../../../core/settings/datasetParams";
import { Toggle } from "../../../core/ui/Controls";

/** The params keys only a mivport dataset carries — the host drops them on a
 * switch to another source. */
export const MIVPORT_PARAM_KEYS = ["download_photos"] as const;

/** Backend default: on — every place photo is kept on the boat. */
export function downloadPhotosOf(value: Record<string, unknown>): boolean {
  return typeof value.download_photos === "boolean" ? value.download_photos : true;
}

/** The draft after one mivport toggle edit. */
export function setMivportParam(
  value: Record<string, unknown>,
  key: (typeof MIVPORT_PARAM_KEYS)[number],
  on: boolean,
): Record<string, unknown> {
  return { ...value, [key]: on };
}

export const MIVPORT_DESCRIPTION =
  "Harbours, anchorages and services from mivport — its own sailor-edited data merged with " +
  "OpenStreetMap. The whole region is downloaded at once, with every place’s details, " +
  "reviews and photos, for offline use.";

export const MivportParams: Component<DatasetParamsProps> = (props) => (
  <div class="space-y-2">
    <Toggle
      label="Download photos"
      hint="Every place photo (view + thumbnail), kept on the boat for offline viewing."
      checked={downloadPhotosOf(props.value)}
      disabled={props.disabled}
      onChange={(v) => props.onChange(setMivportParam(props.value, "download_photos", v))}
    />
  </div>
);
