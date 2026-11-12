// The ENC split into separately-controllable GROUPS, keyed on each layer's
// draw-order band (`PRIO`, ./expr.ts) — no per-set/per-name list to keep in
// sync. See docs/architecture/enc-groups.md.

import { PRIO, type Prio } from "./expr";

/** The four ENC groups, in bottom → top draw order. */
export type EncGroupId = "fills" | "lines" | "soundings" | "aids";

/** Ordered group metadata — bottom → top, matching the PRIO bands each spans.
 * The order here is the DEFAULT stack order the Layers panel lists them in. */
export const ENC_GROUPS: readonly { id: EncGroupId; label: string }[] = [
  { id: "fills", label: "Chart fills" },
  { id: "lines", label: "Depths & coastline" },
  { id: "soundings", label: "Soundings" },
  { id: "aids", label: "Aids & lights" },
];

/** One group's live control state — a visibility flag and an opacity blend. */
export interface EncGroupState {
  visible: boolean;
  opacity: number;
}

export type EncGroupsState = Record<EncGroupId, EncGroupState>;

/** All groups shown, fully opaque — the default, which emits byte-identical
 * paint to a style with no group machinery at all. */
export const DEFAULT_ENC_GROUPS: EncGroupsState = {
  fills: { visible: true, opacity: 1 },
  lines: { visible: true, opacity: 1 },
  soundings: { visible: true, opacity: 1 },
  aids: { visible: true, opacity: 1 },
};

/** The MapLayer id a group registers under in the generic registry (App.tsx) —
 * namespaced so it can never collide with a wash-overlay id. */
export function encGroupLayerId(group: EncGroupId): string {
  return `enc:${group}`;
}

/** The metadata key buildStyle stamps each chart layer with, so the runtime
 * reorder pass can bucket the live style's layers back into their group without
 * re-deriving the PRIO→group mapping from layer ids. */
export const ENC_GROUP_META = "mivnav:group";

/** The group a chart layer belongs to, from its draw-order band and id.
 * `null` for DEBUG. ONE id-keyed exception: layers ending `-snd`. */
export function groupForLayer(prio: Prio, layerId: string): EncGroupId | null {
  // Hazard VALSOU soundings share SYM_HAZARD's band but read as soundings.
  if (layerId.endsWith("-snd")) return "soundings";
  switch (prio) {
    case PRIO.NODATA:
    case PRIO.GROUP1:
    case PRIO.LAND_POINT:
    case PRIO.HAZARD_FILL:
    case PRIO.TSS_FILL:
    case PRIO.INDUSTRIAL_FILL:
    case PRIO.LNDMRK_FILL:
      return "fills";
    case PRIO.RESTRICTED_BOUNDARY:
    case PRIO.INDUSTRIAL_BOUNDARY:
    case PRIO.LNDMRK_BOUNDARY:
    case PRIO.HAZARD_LINE:
    case PRIO.CABLE_PIPELINE_LINE:
    case PRIO.TSS_LINE:
    case PRIO.WATERWAY_LINE:
    case PRIO.SBDARE_LINE:
    case PRIO.STATION_LINE:
    case PRIO.CONTOUR:
    case PRIO.COASTLINE:
    case PRIO.LAND_LINE:
      return "lines";
    case PRIO.SOUNDING:
      return "soundings";
    // SEAARE's bay/sound names ride "aids" (like SBDARE's NATSUR letters):
    // they're things drawn ON the chart, so hiding "Chart fills" must not
    // silently take the place names with it. See docs/architecture/enc-groups.md.
    case PRIO.SYM_SEAARE:
    case PRIO.SYM_RESTRICTED:
    case PRIO.SYM_INDUSTRIAL:
    case PRIO.SYM_LNDMRK:
    case PRIO.SYM_SBDARE:
    case PRIO.SYM_HAZARD:
    case PRIO.SYM_CABLE_PIPELINE:
    case PRIO.SYM_STATIONS:
    case PRIO.SYM_TOPMAR:
    case PRIO.SYM_DAYMAR:
    case PRIO.SYM_ATON:
    case PRIO.SYM_LIGHTS:
      return "aids";
    default:
      return null; // DEBUG — not chart content
  }
}

/** Coerce one stored group blob (opaque, hand-editable, outlives its writer)
 * into a valid {@link EncGroupState}: a non-boolean `visible` defaults to shown,
 * a non-finite/out-of-range `opacity` clamps into [0,1] or defaults to 1. */
function coerceGroupState(raw: unknown, fallback: EncGroupState): EncGroupState {
  const o = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const visible = typeof o.visible === "boolean" ? o.visible : fallback.visible;
  const opacity =
    typeof o.opacity === "number" && Number.isFinite(o.opacity)
      ? Math.max(0, Math.min(1, o.opacity))
      : fallback.opacity;
  return { visible, opacity };
}

/** Coerce the whole `encGroups` slice field by field — a missing/wrong-typed
 * group degrades to "all shown, opaque" rather than crashing the style
 * generator. */
export function coerceEncGroups(raw: unknown): EncGroupsState {
  const o = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    fills: coerceGroupState(o.fills, DEFAULT_ENC_GROUPS.fills),
    lines: coerceGroupState(o.lines, DEFAULT_ENC_GROUPS.lines),
    soundings: coerceGroupState(o.soundings, DEFAULT_ENC_GROUPS.soundings),
    aids: coerceGroupState(o.aids, DEFAULT_ENC_GROUPS.aids),
  };
}
