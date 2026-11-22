// see docs/architecture/dataset-list.md (`datasetParams.ts`: the per-provider params contract)
import type { Component } from "solid-js";
import type { Region } from "./regions";

/** `value`/`onChange` are a plain draft object — the component validates
 * nothing client-side; a bad value 422s from `PUT /datasets/{id}` with the
 * provider's own message, same posture as `regions.tsx`'s `RegionForm`. */
export interface DatasetParamsProps {
  provider: string;
  /** Reactive `DatasetConfig.mode`; see docs/architecture/dataset-list.md. */
  mode: "bake" | "live-cache";
  /** Which backing of a multi-backing provider (`null` if only one);
   * see docs/architecture/dataset-list.md. */
  implementation: string | null;
  onImplementationChange: (value: string | null) => void;
  /** Reactive selected region, `undefined` if none;
   * see docs/architecture/dataset-list.md. */
  region?: Region;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  disabled: boolean;
  /** A draft not saved yet (a form may pick a different default for it). */
  isNew?: boolean;
}

/** Keyed by `DatasetConfig.provider`. A provider with no entry gets
 * `DatasetEditForm`'s own "no options for this provider" fallback. */
export type DatasetParamsRegistry = Partial<Record<string, Component<DatasetParamsProps>>>;
