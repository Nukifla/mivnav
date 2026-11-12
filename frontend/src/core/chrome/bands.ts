// The band model: where chrome is allowed to live. See docs/architecture/chrome-bands.md
// — a band is the ONLY place a widget may render (the alarm band and autopilot
// are deliberately NOT here, see RESERVED in ./registry). Pure: no DOM/map/reactive state.

import type { ChromeConfig, DashboardTab } from "./config";
import { lerpDensity, type Density, type Instrument, type Registry } from "./registry";

export type BandId = "rail" | "top";

/**
 * How much room a band's CURRENT PRESENTATION gives one widget. Not a band —
 * the board is `band.rail` WIDENED, not a separate place (giving it its own
 * band was considered and rejected, see docs/architecture/chrome-bands.md).
 */
export type Room = "strip" | "board";

const ROOM_RANK: Record<Room, number> = { strip: 0, board: 1 };

export interface BandSpec {
  id: BandId;
  /** The axis the band packs along: the screen's abundant one. */
  axis: "x" | "y";
  /** `top` is the one exception to "chrome never covers the chart". */
  overChart: boolean;
  /** A conditional band can go dark. Nothing alarm-grade may be seated in one
   * — `defineFeature` refuses. See invariant #3 in registry.ts. */
  conditional: boolean;
  /** The presentations this band actually has. Every band has a strip; only
   * the rail also widens into the board. */
  rooms: readonly Room[];
}

/** Static metadata only — band *liveness* (see `bandLive`) is derived from the
 * configured instruments instead, since a `when()` here would make this impure. */
export const BANDS: Readonly<Record<BandId, BandSpec>> = Object.freeze({
  rail: { id: "rail", axis: "y", overChart: false, conditional: false, rooms: ["strip", "board"] },
  top: { id: "top", axis: "x", overChart: true, conditional: true, rooms: ["strip"] },
});

export const BAND_IDS = Object.freeze(["rail", "top"] as const);

export const isBandId = (id: string): id is BandId => id === "rail" || id === "top";

/** The room an instrument needs for its reading to be true. Most need none in particular. */
export const roomOf = (i: Instrument): Room => i.needsRoom ?? "strip";

/** Whether this presentation is roomy enough for that instrument (invariant #7,
 * counterpart to `desktopOnly`: that says "gloves do not hover", this says
 * "four glyphs is not a position"). */
export const fitsRoom = (i: Instrument, room: Room): boolean => ROOM_RANK[room] >= ROOM_RANK[roomOf(i)];

/** A widget is on unless the config says otherwise: adding a feature must never silently hide it. */
export const isEnabled = (cfg: ChromeConfig, id: string): boolean => cfg.enabled[id] !== false;

/** Which band an instrument is configured into on this device, if any. */
export function bandOf(cfg: ChromeConfig, id: string): BandId | null {
  return BAND_IDS.find((b) => cfg.bands[b].order.includes(id)) ?? null;
}

/**
 * Everything the config has seated in this band that still exists. `desktopOnly`
 * is filtered by POINTER, not screen width (invariant #10). `when()`/room are
 * NOT filtered here — this is the config editor's list, not the render.
 */
export function configurable(reg: Registry, cfg: ChromeConfig, band: BandId): Instrument[] {
  return cfg.bands[band].order
    .map((id) => reg.byId(id))
    .filter((i): i is Instrument => !!i)
    .filter((i) => !(i.desktopOnly && cfg.pointerCoarse));
}

/** What this device COULD show in the band right now: `configurable`, minus
 * widgets whose feature isn't currently present. Enablement is deliberately
 * not applied here — see `bandList`. */
export function available(reg: Registry, cfg: ChromeConfig, band: BandId): Instrument[] {
  return configurable(reg, cfg, band).filter((i) => i.when?.() ?? true);
}

/**
 * The resolved list: available, minus what's off, minus what this presentation
 * has no room for, in the order YOU put it in. Nothing here re-ranks, demotes
 * or drops to fit (invariant #5) — `room` is not an allocator.
 */
export function bandList(
  reg: Registry,
  cfg: ChromeConfig,
  band: BandId,
  room: Room = "strip",
): Instrument[] {
  return available(reg, cfg, band).filter((i) => isEnabled(cfg, i.id) && fitsRoom(i, room));
}

/** The cards a dashboard tab shows, in its OWN order (`DashboardTab.order`,
 * decoupled from the rail band); filters mirror `bandList` at `room: "board"`. */
export function boardTab(reg: Registry, cfg: ChromeConfig, tab: DashboardTab): Instrument[] {
  return resolveCards(reg, cfg, tab.order);
}

/**
 * The room the editor renders a TARGET's cards at — the roomiest the target
 * has. A dashboard tab is always `board`; a band target is capped at the
 * roomiest room the BAND offers (`top` is strip-only, e.g.).
 */
export function targetRoom(target: string): Room {
  if (isBandId(target)) return BANDS[target].rooms.includes("board") ? "board" : "strip";
  return "board";
}

/**
 * The board cards for an ORDER — shared body of `boardTab`, so a band target
 * renders through the same filters. `opts.ignoreWhen` skips the `when()`
 * filter: the EDITOR's list must show CONFIGURED widgets even when absent.
 */
export function resolveCards(
  reg: Registry,
  cfg: ChromeConfig,
  order: readonly string[],
  opts?: { room?: Room; ignoreWhen?: boolean },
): Instrument[] {
  const room = opts?.room ?? "board";
  const ignoreWhen = opts?.ignoreWhen ?? false;
  return order
    .map((id) => reg.byId(id))
    .filter((i): i is Instrument => !!i)
    .filter((i) => !(i.desktopOnly && cfg.pointerCoarse))
    .filter((i) => ignoreWhen || (i.when?.() ?? true))
    .filter((i) => isEnabled(cfg, i.id) && fitsRoom(i, room));
}

/**
 * The EDITOR's cards for a generic TARGET — a BAND or a dashboard tab, both
 * through `resolveCards`. Every target IGNORES `when()`/liveness: the editor
 * must show what is CONFIGURED, or a conditional widget (the route readings
 * with no route followed) is invisible in edit mode — it can't be moved or
 * removed, and adding one looks like nothing happened (#BOARD-PHONE). The
 * read-only board renders `boardTab`; the physical strips render `bandList`.
 */
export function targetCards(reg: Registry, cfg: ChromeConfig, target: string): Instrument[] {
  const order = isBandId(target)
    ? cfg.bands[target].order
    : cfg.dashboard.tabs.find((t) => t.id === target)?.order ?? [];
  return resolveCards(reg, cfg, order, { room: targetRoom(target), ignoreWhen: true });
}

/** Whether a widget the editor shows is hidden on the live board right now
 * (its `when()` is false) — the editor dims it and says so. */
export const hiddenNow = (i: Instrument): boolean => !(i.when?.() ?? true);

/** Whether the band should be painted at all: an unconditional band always is;
 * a conditional one only while something is present (`band.top` vanishes with
 * the route rather than leaving an empty strip over the chart). */
export function bandLive(reg: Registry, cfg: ChromeConfig, band: BandId): boolean {
  return !BANDS[band].conditional || available(reg, cfg, band).length > 0;
}

/**
 * APPROXIMATE band capacity, for the config editor's overflow warning ONLY —
 * never feeds `bandList` and never removes a widget (invariant #5). Footprints
 * mirror `Rail.tsx`'s `rail-density.ts` tile sizes; keep the two in step.
 */
const CELL_PX_DESK = { height: 44, width: 56 };
const CELL_PX_HELM = { height: 76, width: 84 };
const RAIL_FOOT_PX = 140;

export interface Viewport {
  width: number;
  height: number;
  /** The phone layout (App.tsx `isCompact`): the rail is a bottom bar, packing x. */
  compact: boolean;
}

export function bandCapacity(band: BandId, density: Density, vp: Viewport): number {
  const cell = {
    height: lerpDensity(CELL_PX_DESK.height, CELL_PX_HELM.height, density),
    width: lerpDensity(CELL_PX_DESK.width, CELL_PX_HELM.width, density),
  };
  const horizontal = band === "top" || vp.compact;
  const extent = horizontal ? vp.width : vp.height - RAIL_FOOT_PX;
  const per = horizontal ? cell.width : cell.height;
  return Math.max(0, Math.floor(extent / per));
}

/** The short labels appearing more than once across the given instruments —
 * a diagnostic, not enforcement: only a collision if the cells are on screen
 * TOGETHER (a fact about a resolved band list, not the registry). */
export function collisions(instruments: readonly Instrument[]): string[] {
  const seen = new Map<string, number>();
  for (const i of instruments) seen.set(i.short, (seen.get(i.short) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([short]) => short);
}

/** Every short label on screen at once, across every live band. `room` because
 * the board shows a different set than the strip. */
export function onScreen(reg: Registry, cfg: ChromeConfig, room: Room = "strip"): Instrument[] {
  return BAND_IDS.filter((b) => bandLive(reg, cfg, b)).flatMap((b) => bandList(reg, cfg, b, room));
}
