// The frontend half of the POI source registry: what a plugin POI source
// (backend `mivnav.features.poi.sources.PoiSource`) tells the POI feature
// about its points — how to draw, title and describe them, and the dataset
// form for it. Filled by `registerPlugin` (src/plugins.ts) before the app
// renders; read lazily by the overlay, icons, info provider and dataset form.
//
// A source's points carry `src: <id>` in the tile; OpenStreetMap ones carry
// no `src` at all.

import type { Component } from "solid-js";
import type { DatasetParamsProps } from "../../core/settings/datasetParams";
import type { InfoLink, InfoNote } from "../../core/info/types";
import type { Prim } from "./icons";

/** One place type (`kind_detail`) of a source as the frontend shows it. */
export interface PoiSourceType {
  /** The info panel's subtitle — the source's own wording for the type. */
  label: string;
  /** The per-type map/info glyph. */
  glyph: readonly Prim[];
  /** A glyph accent other than the neutral `other`. */
  accent?: "marina" | "fuel";
}

/** The POI props a source's hooks see (the tile feature's properties). */
export type PoiFeatureProps = Readonly<Record<string, unknown>>;

export interface PoiSourcePlugin {
  /** The dataset `implementation` and the points' `src` tag. */
  id: string;
  /** The dataset form's source-picker label. */
  label: string;
  /** Shown under the picker while this source is selected. */
  description?: string;
  /** Its own dataset params, below the picker while it is selected. */
  ParamsForm?: Component<DatasetParamsProps>;
  /** Every params key this source owns (current AND retired): dropped from
   * the draft when the dataset switches to another source. */
  paramKeys?: readonly string[];
  /** Extra POI `kind`s this source produces that OpenStreetMap never does,
   * with their glyph — drawn and titled like the built-in kinds. */
  kinds?: Readonly<Record<string, readonly Prim[]>>;
  /** Per `kind_detail` type: a point of this source with a known type draws
   * and titles as that type, else as its kind. */
  types?: Readonly<Record<string, PoiSourceType>>;
  /** POI types that only matter once zoomed right in to the harbour, drawn
   * from `POI_HARBOUR_ZOOM` only (see overlay.ts `HARBOUR_ONLY`). */
  harbourOnly?: readonly { prop: "kind" | "kind_detail"; values: readonly string[] }[];
  /** A stable per-place hit id (so the same place from two sets/layers is
   * one info hit), e.g. from the point's own `ref`. */
  hitId?: (props: PoiFeatureProps) => string | undefined;
  /** Extra info-panel content for one of its points. */
  detail?: (props: PoiFeatureProps) => { notes?: InfoNote[]; links?: InfoLink[] };
}

const registry = new Map<string, PoiSourcePlugin>();
const queryLayers: string[] = [];

export function registerPoiSource(source: PoiSourcePlugin): void {
  if (source.id === "overpass" || source.id === "osm" || registry.has(source.id)) {
    throw new Error(`duplicate POI source id ${source.id}`);
  }
  registry.set(source.id, source);
}

/** Extra map layers the POI info provider answers taps on (a plugin layer
 * drawn with the POI marker spec, e.g. an online-only one). */
export function registerPoiQueryLayers(ids: readonly string[]): void {
  for (const id of ids) if (!queryLayers.includes(id)) queryLayers.push(id);
}

export function poiSources(): readonly PoiSourcePlugin[] {
  return [...registry.values()];
}

export function poiSource(id: unknown): PoiSourcePlugin | undefined {
  return typeof id === "string" ? registry.get(id) : undefined;
}

export function extraPoiQueryLayers(): readonly string[] {
  return queryLayers;
}

/** Tests only. */
export function resetPoiSources(): void {
  registry.clear();
  queryLayers.length = 0;
}
