// The built-in `mivport` POI source (registered at start-up, src/index.tsx): its kinds, place types,
// dataset form, and the place details (attributes, shelter rose, fuel
// prices, reviews, photos, the mivport and OpenStreetMap links) in the info
// panel, read from the boat's own bake.

import type { InfoNote } from "../../../core/info/types";
import type { PoiFeatureProps, PoiSourcePlugin } from "../sources";
import { fetchMivportDetail, type MivportPlaceDetail } from "./detail";
import { MIVPORT_KIND_GLYPHS, MIVPORT_TYPES } from "./icons";
import { MivportDetail } from "./MivportDetail";
import { MIVPORT_DESCRIPTION, MIVPORT_PARAM_KEYS, MivportParams } from "./params";

/** The POI `src` (and dataset implementation) of every mivport point. */
export const MIVPORT_SRC = "mivport";

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

export type MivportDetailLoader = (setId: string, ref: string) => Promise<MivportPlaceDetail>;

/** The mivport place details: an INLINE note (shown expanded as part of the
 * POI), loaded once as soon as the detail is shown,
 * resolving to a structured body. The "Open in mivport" link lives in that
 * body: its URL comes with the record (`web_url`), not with the tile. */
export function mivportDetailNote(
  setId: string,
  ref: string,
  load: MivportDetailLoader = fetchMivportDetail,
): InfoNote {
  return {
    label: "mivport details",
    display: "inline",
    load: async () => {
      const detail = await load(setId, ref);
      return () => MivportDetail({ detail });
    },
  };
}

/** The info panel's extras for one mivport point: the details note, when the
 * point carries the place id and the set it was baked into. */
export function mivportDetailExtras(props: PoiFeatureProps, load?: MivportDetailLoader) {
  const ref = str(props.ref);
  const set = str(props.set);
  return ref && set ? { notes: [mivportDetailNote(set, ref, load)] } : {};
}

export function mivportPoiSource(load?: MivportDetailLoader): PoiSourcePlugin {
  return {
    id: MIVPORT_SRC,
    label: "mivport",
    description: MIVPORT_DESCRIPTION,
    ParamsForm: MivportParams,
    paramKeys: MIVPORT_PARAM_KEYS,
    kinds: MIVPORT_KIND_GLYPHS,
    types: MIVPORT_TYPES,
    // A harbour office (POI kind `harbourmaster`) only matters at the
    // harbour, like OSM's harbourmaster — but the host's rule for that
    // matches only src-less (OSM) points. The bake ranks it at min_zoom 14;
    // this hides it in archives baked before that.
    harbourOnly: [{ prop: "kind_detail", values: ["harbour_office"] }],
    // Keyed by the mivport place id, so the same place from two baked sets
    // is ONE hit.
    hitId: (props) => str(props.ref),
    detail: (props) => mivportDetailExtras(props, load),
  };
}
