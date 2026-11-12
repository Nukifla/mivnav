// Generic MAP-LAYER ORDER: merge a persisted stack order with the registry's
// default ({@link orderMapLayers}) plus the runtime moveLayer pass ({@link applyMapLayerOrder}).
// SAFETY: a `pinned` MapLayer (own-ship) is never reordered — see docs/architecture/mapview-layer-reorder.md.

import type { Map as MLMap } from "maplibre-gl";
import { ENC_GROUP_META, type EncGroupId } from "../style/encGroups";
import type { MapLayer } from "../chrome/feature";

/**
 * The MapLayers in their resolved bottom → top stack order: the persisted
 * order first, then any layer NOT in it spliced back in at its DEFAULT
 * position — so a newly-added layer lands near where it belongs instead of
 * at an end. PINNED layers (own-ship) are dropped from the reorderable set
 * and appended last, unconditionally topmost.
 */
export function orderMapLayers(
  layers: readonly MapLayer[],
  persisted: readonly string[],
): MapLayer[] {
  const pinned = layers.filter((l) => l.pinned);
  const free = layers.filter((l) => !l.pinned);
  const known = new Set(persisted);
  const byId = new Map(free.map((l) => [l.id, l] as const));
  // Persisted ids that still resolve to a layer, in persisted order.
  const result: MapLayer[] = persisted
    .map((id) => byId.get(id))
    .filter((l): l is MapLayer => l != null);
  // Splice each not-yet-placed layer in at its default position — counted as the
  // number of its default-predecessors already placed, so it lands among the
  // right neighbours rather than at the top or bottom.
  free.forEach((layer, i) => {
    if (known.has(layer.id)) return;
    const before = free.slice(0, i).filter((l) => result.includes(l)).length;
    result.splice(before, 0, layer);
  });
  return [...result, ...pinned];
}

/** Move the item at `from` to index `to`, returning a new array (a splice-out
 * then splice-in). A no-op for an out-of-range index or `from === to`. Pure — the
 * panel's drag resolves a drop to (from, to) and persists the result. */
export function moveInOrder<T>(items: readonly T[], from: number, to: number): T[] {
  const out = [...items];
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out;
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item!);
  return out;
}

/** The live layer ids of one ENC group, in stack order — every chart layer the
 * style stamped with this group (`ENC_GROUP_META`). `getStyle().layers` is in
 * render order, so the result is already bottom → top within the group. */
export function encGroupLayerIds(map: MLMap, group: EncGroupId): string[] {
  const style = map.getStyle?.();
  if (!style?.layers) return [];
  return style.layers
    .filter(
      (l) => (l as { metadata?: Record<string, unknown> }).metadata?.[ENC_GROUP_META] === group,
    )
    .map((l) => l.id);
}

/**
 * Move each band layer into `ordered`'s stack order, all of them BELOW
 * `anchor` (the lowest fixed safety overlay). `resolve` maps a MapLayer id to
 * its live layer ids (ENC groups via metadata, washes via the overlay's own
 * ids); absent/empty resolutions are skipped, so an off wash doesn't move.
 */
export function applyMapLayerOrder(
  map: MLMap,
  ordered: readonly string[],
  resolve: (id: string) => string[],
  anchor: string | undefined,
): void {
  if (typeof map.moveLayer !== "function") return;
  const getLayer = typeof map.getLayer === "function" ? map.getLayer.bind(map) : () => undefined;
  const hasAnchor = anchor != null && !!getLayer(anchor);
  for (const id of ordered) {
    for (const layerId of resolve(id)) {
      if (!getLayer(layerId)) continue;
      if (hasAnchor) map.moveLayer(layerId, anchor);
      else map.moveLayer(layerId);
    }
  }
}
