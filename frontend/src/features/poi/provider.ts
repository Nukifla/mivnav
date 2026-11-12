// InfoProvider answering taps against the POI union's fixed layers and any
// plugin layer drawn with the same spec (scopedQuery, poiQueryLayerIds
// #xnlxroux) — never a chart/vessel/raster hit.

import type { Accessor } from "solid-js";
import Anchor from "lucide-solid/icons/anchor";
import type { QueryableMap } from "../../core/info/queryGuard";
import { scopedQuery } from "../../core/info/queryGuard";
import type { InfoDetail, InfoHit, InfoProvider, InfoQuery } from "../../core/info/types";
import { poiQueryLayerIds } from "./overlay";
import { poiGlyphFor } from "./icons";
import { poiGlyphIcon } from "./PoiGlyphIcon";
import { poiSource } from "./sources";

export const POI_PROVIDER_ID = "poi";

/** `set` is the union's provenance tag (chartcore `merge_tiles_tagged`,
 * #wuvqsnxy) — used to keep `queryAt`'s dedup fallback set-scoped. */
interface PoiProps {
  name?: unknown;
  kind?: unknown;
  kind_detail?: unknown;
  set?: unknown;
  /** A plugin POI source's id on its points; absent = OpenStreetMap. */
  src?: unknown;
  /** A plugin source's own id for the place — its points only. */
  ref?: unknown;
  /** On a plugin source's point that an OpenStreetMap point describes too: the OSM
   * point(s) the backend merged into it (hidden from the map), as a JSON
   * list of `{name?, kind, kind_detail?, set}` (docs/architecture/poi-merge.md). */
  osm?: unknown;
}

/** The OSM points merged into a plugin source's feature (`props.osm`), as props of
 * their own — never throws: a malformed value is no merged points. */
export function mergedOsmProps(props: PoiProps): PoiProps[] {
  if (typeof props.osm !== "string" || !props.osm) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(props.osm);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (o): o is PoiProps => typeof o === "object" && o !== null && typeof (o as PoiProps).kind === "string",
  );
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

function humanize(value: string): string {
  const spaced = value.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** OpenStreetMap `kind_detail` values that are a real refinement of their
 * kind. Everything else tags.py can put there is the raw matched tag value —
 * `"yes"` (`harbour=yes`) or a tag-spelling synonym of the kind
 * (`fuel_station`, `harbour_master`, `boat`, `doityourself`) — and is never
 * shown. */
const OSM_DETAIL_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  hospital: { clinic: "Clinic" },
  pub: { bar: "Bar" },
};

/**
 * The line under a POI's title — "name, then what it is", as specific as the
 * source allows. A plugin source's point shows its TYPE (`kind_detail`), not
 * the kind it was grouped under — in the source's own wording where the type
 * is known (`PoiSourcePlugin.types`), humanized for one it added since; a
 * kind-only point (no type) shows its kind. An OpenStreetMap point shows its
 * kind, refined only where `kind_detail` means something (`OSM_DETAIL_LABELS`).
 *
 * `src` is the point's source id (`undefined` = OpenStreetMap).
 */
export function poiSubtitle(
  kind: string | undefined,
  kindDetail: string | undefined,
  src: string | undefined,
): string | undefined {
  if (src && kindDetail) {
    const type = kindDetail.toLowerCase();
    const types = poiSource(src)?.types;
    if (types && Object.hasOwn(types, type)) return types[type].label;
    if (!kind || kind === "other") return humanize(type);
  }
  if (!kind) return undefined;
  if (!src && kindDetail) {
    const refined = OSM_DETAIL_LABELS[kind]?.[kindDetail];
    if (refined) return refined;
  }
  return humanize(kind);
}

export interface PoiProviderDeps {
  /** Filled in by the sibling overlay's `ensure`; `queryAt` answers nothing
   * until then. */
  map: Accessor<QueryableMap | undefined>;
}

export function createPoiProvider(deps: PoiProviderDeps): InfoProvider {
  return {
    id: POI_PROVIDER_ID,
    label: "POI",

    // Reversed from an earlier "always anchor" design: mirrors the map
    // marker so a tapped POI reads as its kind. Anchor is the fallback.
    defaultIcon: Anchor,

    /** The map marker's own glyph (`poiGlyphFor` — a source type's, else the
     * kind's), so the panel's icon and the marker are the same shape. */
    icon(hit: InfoHit) {
      const glyph = poiGlyphFor((hit.payload ?? {}) as PoiProps);
      return glyph ? poiGlyphIcon(glyph) : undefined;
    },

    queryAt(q: InfoQuery): InfoHit[] {
      const map = deps.map();
      if (!map) return [];
      const { x, y } = q.point;
      const r = q.radius;
      // Guard's post-filter guarantees only this overlay's features come
      // back, whatever the underlying query returns.
      const query = scopedQuery(map, { layerIds: poiQueryLayerIds() });
      const features = query([
        [x - r, y - r],
        [x + r, y + r],
      ]);
      const byId = new Map<string, InfoHit>();
      /** `otherId`: the key of a point with no source-given id. */
      const add = (props: PoiProps, otherId: string): void => {
        const name = str(props.name);
        const kind = str(props.kind);
        const src = str(props.src);
        // A plugin source may key its points by its own place id, so the
        // same place from a baked set and from a live layer is ONE hit,
        // while two different places sharing a name ("Marina") stay two.
        // Otherwise `set` is folded into the fallback (#xnlxroux/#wuvqsnxy):
        // without it, nameless POIs from different sets in one query radius
        // collide under the union's single marker-layer id and one vanishes.
        const sourceId = src ? poiSource(src)?.hitId?.(props as Record<string, unknown>) : undefined;
        const id = sourceId ? `${src}:${sourceId}` : otherId;
        if (byId.has(id)) return;
        const subtitle = poiSubtitle(kind, str(props.kind_detail), src);
        byId.set(id, {
          providerId: POI_PROVIDER_ID,
          id,
          // Marinas/fuel/etc. serve the mariner, never a hazard — must not
          // outrank a charted danger or aid to navigation.
          priority: "regulated",
          precision: "point",
          // Nameless: what it is stands in (a source's "Shower" type, not its
          // grouped kind "Other").
          title: name ?? subtitle ?? "POI",
          subtitle,
          lngLat: q.lngLat,
          payload: props,
        });
      };
      for (const feature of features) {
        const props = (feature.properties ?? {}) as PoiProps;
        const set = str(props.set);
        add(props, String(feature.id ?? str(props.name) ?? `${feature.layer?.id}:${set ?? ""}`));
        // A source marker that also stands for OpenStreetMap point(s) of the
        // same place (merged by the backend, poi-merge.md): each OSM point is
        // its own hit, right AFTER the source one (rankHits is stable, so the
        // source hit leads). It keeps the OSM subtitle/icon: it is its payload.
        const ref = str(props.ref);
        for (const osm of mergedOsmProps(props)) {
          // Named: the name, as for a drawn OSM point (so a copy still drawn
          // by another OSM set is one hit). Nameless: owned by its source place.
          add(osm, str(osm.name) ?? `osm:${ref ?? ""}:${str(osm.set) ?? ""}:${str(osm.kind) ?? ""}`);
        }
      }
      return [...byId.values()];
    },

    detail(hit: InfoHit): InfoDetail {
      const props = (hit.payload ?? {}) as PoiProps;
      const name = str(props.name);
      const kind = str(props.kind);
      const src = str(props.src);
      // No rows: what the place is lives in the subtitle (`poiSubtitle`) — a
      // Type/Detail/Source section only repeated it. A plugin source adds
      // its own notes (details) and links (its page for the place).
      const extra = src ? poiSource(src)?.detail?.(props as Record<string, unknown>) : undefined;
      return {
        title: name,
        subtitle: poiSubtitle(kind, str(props.kind_detail), src),
        sections: [],
        ...(extra?.notes?.length ? { notes: extra.notes } : {}),
        ...(extra?.links?.length ? { links: extra.links } : {}),
      };
    },
  };
}
