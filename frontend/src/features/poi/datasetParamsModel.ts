// Pure half of the POI dataset params sub-form (./DatasetParams.tsx): which
// implementation backs a POI dataset. OpenStreetMap (Overpass) is built in;
// any other source is a plugin's (./sources.ts), with params of its own.
// Mirrors the backend's `PoiDatasetParams` (backend/mivnav/features/poi/provider.py)
// — the backend is the validator; this only shapes the draft.

import { poiSources } from "./sources";

/** `DatasetConfig.implementation` for provider "poi": `"overpass"` or a
 * plugin source's id. `null` (the stored spelling of OpenStreetMap) reads
 * as `"overpass"`. */
export type PoiSource = string;

export const OVERPASS = "overpass";

export function poiSourceOf(implementation: string | null): PoiSource {
  return implementation || OVERPASS;
}

/** The draft `params` after switching source: every key another source owns
 * goes (the backend rejects them there); the new source's own keys stay —
 * absent keys mean the backend defaults. */
export function paramsForSource(
  value: Record<string, unknown>,
  next: PoiSource,
): Record<string, unknown> {
  const out = { ...value };
  for (const source of poiSources()) {
    if (source.id === next) continue;
    for (const key of source.paramKeys ?? []) delete out[key];
  }
  return out;
}

/** The `implementation` to store for a source: `null` for overpass, so an
 * existing OSM dataset round-trips byte-identical. */
export function implementationFor(source: PoiSource): string | null {
  return source === OVERPASS ? null : source;
}

/** The source a draft should switch to, or `undefined` to leave it: a NEW
 * draft on OpenStreetMap moves to the first other source while OSM imports
 * are off (Settings → Advanced). A saved dataset is never switched. */
export function sourceToSwitchTo(
  current: PoiSource,
  opts: { isNew: boolean; osmImports: boolean; others: readonly PoiSource[] },
): PoiSource | undefined {
  if (!opts.isNew || opts.osmImports || current !== OVERPASS) return undefined;
  return opts.others[0];
}
