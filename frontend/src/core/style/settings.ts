// User settings that feed the style generator — every one lives only in
// style expressions, so changing them never refetches tiles. The AIS block
// at the bottom stretches that (feeds the imperative SignalK overlay instead).

import type { Palette } from "./colors";
import { DEFAULT_ENC_GROUPS, type EncGroupsState } from "./encGroups";

export interface ChartSettings {
  /** Day/dusk/night — which S-52 colour table the chart draws from. ONE
   * field: it picks the table *and* the chrome tokens via `data-palette`,
   * so nothing can drift. Per-device, instant, never a tile refetch. */
  palette: Palette;
  /** Safety contour depth in metres (S52_MAR_SAFETY_CONTOUR) — drives the
   * SEABED01 depth-shade ramp, the DEPCNT02 safety-contour highlight and
   * the hazard isolated-danger predicate (UDWHAZ03 shape). */
  safetyContour: number;
  /** Safety depth in metres (S-52 SAFETY_DEPTH), emphasizes shallow
   * soundings. Distinct from `safetyContour` per official S-52 SNDFRM02
   * (ochartsng conflates the two): dragging the contour must not recolor soundings. */
  safetyDepth: number;
  /** Shallow contour depth in metres (S52_MAR_SHALLOW_CONTOUR). */
  shallowDepth: number;
  /** Deep contour depth in metres (S52_MAR_DEEP_CONTOUR). */
  deepDepth: number;
  /** Uniform `icon-size` multiplier for ATON symbol layers (buoys/beacons/
   * topmarks/daymarks/lights), not hazard symbols. 1 reproduces MapLibre's
   * own default — "make nav marks easier to see", not a general scale. */
  atonIconScale: number;
  /** Uniform `icon-size` multiplier for the own-ship symbol (and its heading
   * stick, so the stick still clears the bow). AIS targets are unaffected.
   * Rides the scene as a feature property — see `ownFeatures`. */
  ownShipScale: number;
  /** Master text toggle (S-52 "show text"). */
  showText: boolean;
  /** Buoy/beacon name labels (ochartsng bShowAtonText). */
  showAtonText: boolean;
  /** Show lights at all — overrides display category in the reference
   * (S57Object.cpp:647-649). Also gates the sector-arc custom layer. */
  showLights: boolean;
  /** Light description strings (LITDSN). */
  showLightDescriptions: boolean;
  /** Base OSM basemap, extracted server-side from Protomaps (task
   * suxmwpst). On by default; doesn't need internet once baked, but avoids
   * a wasted fetch when nothing's baked for the area. */
  showOsmBase: boolean;
  /** OpenSeaMap seamark raster overlay. Off by default: duplicates the
   * S-52 aids-to-navigation symbology and needs internet. */
  showOpenSeaMap: boolean;
  /** OSM POI overlay (marinas, fuel, harbourmaster …), served from the
   * boat's own pre-baked PMTiles (`features/poi`). Off by default like
   * OpenSeaMap: an informational annotation, not a chart layer. */
  showPois: boolean;
  /** Visibility of each plugin map layer (src/plugins.ts), by the layer's
   * own id. Absent = the plugin's default. */
  pluginLayers: Readonly<Record<string, boolean>>;
  /** Let the OSM basemap show through the chart's land: LANDA fill becomes
   * a translucent WASH, not a hole (LNDARE is DISPLAYBASE and must stay
   * unmistakable with no tile). Off by default — costs internet, dilutes colour. */
  showOsmOnLand: boolean;
  /** Satellite/aerial imagery wash, drawn OVER the base chart, blended by
   * `satelliteOpacity`. Off by default and BORN INERT: no imagery source
   * added at all, so MapLibre requests zero tiles when disabled. */
  showSatellite: boolean;
  /** Which imagery source the underlay draws from — an OPAQUE id from `GET
   * /api/satellite/sources` (jt zsukvvxq); never parsed here. Empty string
   * = AUTO (backend's baked-first order); a stale id falls back to auto. */
  satelliteSource: string;
  /** Imagery wash opacity (0-1), the overlay's only lever now imagery draws
   * ON TOP of the chart. Defaults to 0.75 — readable wash, marks stay legible. */
  satelliteOpacity: number;
  /** The vessel's past track (`features/track`), read from SignalK's
   * History API — exists only if the SignalK box runs a history plugin.
   * Off by default and BORN INERT: no request without a history plugin. */
  showTrack: boolean;
  /** How far back the track reaches, hours — a display choice, not a
   * retention policy (nothing here stores the track). Defaults to 6h, a
   * passage-length window. */
  trackHours: number;
  /** Notices to Mariners overlay (`features/notices`): Danish EfS/NW from
   * the backend's Niord snapshot. On by default — safety information the
   * boat's own server already holds (it works offline from the last good
   * snapshot). Off is INERT: no source, no layer, no status poll. */
  showNotices: boolean;
  /** Per-family filters under `showNotices` (the Notices settings section). */
  noticesWarnings: boolean; // NW — coastal + local navigational warnings
  noticesTemporary: boolean; // NM T
  noticesPreliminary: boolean; // NM P
  noticesPermanent: boolean; // NM permanent — chart corrections
  /** Firing exercises AND the permanent firing areas (grey outline when not
   * firing today, red hatched when they are — one toggle, user Q4). */
  noticesFiring: boolean;
  /** Draw notices whose event windows are all over but which BRS still
   * publishes. Off by default (Q5): stale clutter, not information. */
  noticesShowEnded: boolean;
  /** Each plugin's own settings slice, by the plugin's key — opaque here
   * (`core/pluginSettings.ts`). */
  pluginSettings: Readonly<Record<string, unknown>>;

  /** Per-ENC-group visibility + opacity (`style/encGroups.ts`). Opacity
   * MULTIPLIES into the generated style; a group at opacity 1 + visible is
   * byte-identical to a style with no group machinery. */
  encGroups: EncGroupsState;
  /** Persisted STACK ORDER of generic map layers, bottom->top. Own-ship is
   * NEVER in it — pinned topmost (`layers/overlay.ts`, never lose your own
   * boat). Empty = default order, reorder pass skipped entirely. */
  layerOrder: string[];

  /** Master on/off for other vessels' AIS/SignalK targets — own ship
   * (`ownShipOverlay`) is a separate always-on overlay, untouched. On by
   * default, preserving the previous always-on behaviour. */
  showAisTargets: boolean;
  /** Length of the course/speed predictor vector, in *minutes* of travel at
   * current SOG — so two vessels' vectors are directly comparable. 60 is
   * the plotting-sheet convention: a one-hour vector's length *is* the speed. */
  predictorMinutes: number;
  /** Draw the true-heading stick (bow direction) as well as the predictor.
   * On by default: heading vs COG *is* the leeway/tide, and a sailing boat cares. */
  showHeadingLine: boolean;

  /** Draw a faded "ghost" copy of each AIS target at its DEAD-RECKONED
   * position — extrapolated along COG/SOG by elapsed time since last
   * received. Off by default; guards live in `ghostPosition`. */
  showAisGhost: boolean;

  /** Colour AIS targets by collision risk and draw CPA geometry for
   * dangerous ones. Off falls back to one neutral colour for every target. */
  showAisRisk: boolean;
  /** Wind-speed display unit, global across wind readouts (instruments, the
   * weather plugin), toggled by tapping a wind value. m/s by default (SI the models report in). */
  windUnit: "ms" | "kn";
  /** Hold a Screen Wake Lock while the chart is visible (`core/wakeLock.ts`),
   * so the screen doesn't dim/lock at the helm. On by default; silently a
   * no-op where the browser can't (plain-http origins included). */
  keepScreenOn: boolean;

  // The collision settings — thresholds, off/show/tell, sound — are not here:
  // they are boat-wide server config (`collision.*`, core/collisionSettings.ts),
  // the same on every screen. Only the colouring's on/off is per device.
}

/** Sailing-boat-sensible defaults (S-52's own 30m safety default is tuned
 * for ships). The CPA defaults are the safety-relevant ones — full
 * rationale: docs/architecture/cpa-defaults.md. */
export const DEFAULT_SETTINGS: ChartSettings = {
  // Day, not a guess from prefers-color-scheme (a desk fact, not a boat
  // fact). `paper2` IS the day theme now (uqolozkr) — the old S-52 day
  // table kept its `day` id, offered as "S52-Day"; ids are the persistence key.
  palette: "paper2",
  // The three blue depth bands the Depth settings expose as "levels" (user,
  // 2026-09-27): 0-2 m, 2-4 m, 4-6 m, white beyond — with the safety contour
  // on the 4 m edge of the middle band. Were 2/6/10.
  safetyContour: 4,
  safetyDepth: 4,
  shallowDepth: 2,
  deepDepth: 6,
  atonIconScale: 1, // native sprite pixel size — unchanged from before this field existed
  ownShipScale: 1, // the 18×40 px hull as drawn — unchanged from before this field existed
  showText: true,
  showAtonText: true,
  showLights: true,
  showLightDescriptions: true,
  showOsmBase: true,
  showOpenSeaMap: false,
  showPois: false,
  pluginLayers: {},
  showOsmOnLand: true,
  showSatellite: false,
  satelliteSource: "", // AUTO: baked set if any, else first online source
  satelliteOpacity: 0.75, // a wash over the base chart, not a full cover
  showTrack: false, // born inert: no history plugin on the box, no requests
  trackHours: 6, // a passage-length window, not a retention policy
  showNotices: true, // safety info the boat already holds — on (efs.md §2.6)
  noticesWarnings: true,
  noticesTemporary: true,
  noticesPreliminary: true,
  noticesPermanent: true, // Q3: on, violet
  noticesFiring: true,
  noticesShowEnded: false, // Q5: ended-but-published notices hidden
  pluginSettings: {},
  encGroups: DEFAULT_ENC_GROUPS, // all groups shown, opaque — byte-identical style
  layerOrder: [], // default stack order — the reorder pass is a no-op while empty

  showAisTargets: true, // preserves the previous always-on behaviour
  predictorMinutes: 30,
  showHeadingLine: true,
  showAisGhost: true, // dead-reckoned ghost target — on by default (user request)
  showAisRisk: true,
  windUnit: "ms",
  keepScreenOn: true, // a chart plotter that sleeps mid-passage is useless
};

/** Contour depths normalized so shallow <= safety <= deep, mirroring how
 * S-52 keeps the four depth shades ordered as the safety contour is dragged. */
export function normalizedContours(s: ChartSettings): {
  shallow: number;
  safety: number;
  deep: number;
} {
  return {
    shallow: Math.min(s.shallowDepth, s.safetyContour),
    safety: s.safetyContour,
    deep: Math.max(s.deepDepth, s.safetyContour),
  };
}
