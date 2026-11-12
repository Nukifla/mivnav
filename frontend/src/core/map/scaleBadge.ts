// Overscale badge: one line of small text above the
// scale bar, never anything drawn over the chart (overlays must not wash it).
// The finest o-charts cell charting the map centre comes from GET
// /api/cells/at; everything else is a pure function of zoom and latitude.

import type maplibregl from "maplibre-gl";
import type { components } from "../../api.generated";
import { RENDER_SCALE_DENOM_Z0 } from "../style/expr";

export type CellAt = components["schemas"]["CellAt"];

/** Show "Overscale" from this enlargement on. ×2 showed at ordinary
 * harbour zooms up north (user, 2026-11-06: "shows too early"); ×4 is where
 * the chart's own accuracy is really being stretched. The "Zoom in for
 * detail" hint was dropped the same day — it was on at most planning zooms. */
export const OVERSCALE_SHOW = 4;

export type ScaleBadge = { kind: "overscale"; factor: number; text: string } | null;

/** The true display scale denominator at `lat` (what the scale bar measures):
 * MapLibre's 512 px world, the S-52 0.28 mm pixel, Mercator's cos(lat). */
export function trueScaleDenom(zoom: number, lat: number): number {
  return (RENDER_SCALE_DENOM_Z0 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

/** "2.4", "3", "12" — one decimal only while it says something. */
export function formatFactor(f: number): string {
  if (f >= 10) return String(Math.round(f));
  const r = Math.round(f * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** The badge for `cells` (charting the map centre, any order) at
 * `zoom`/`lat`: "Overscale ×N" once the true display scale is
 * `OVERSCALE_SHOW`× or more larger than the finest chart's compilation scale. */
export function scaleBadge(cells: readonly Pick<CellAt, "scale">[], zoom: number, lat: number): ScaleBadge {
  const scales = cells.map((c) => c.scale).filter((s) => s > 0);
  if (scales.length === 0) return null;
  const finest = Math.min(...scales);
  const factor = finest / trueScaleDenom(zoom, lat);
  if (factor < OVERSCALE_SHOW) return null;
  return { kind: "overscale", factor, text: `Overscale ×${formatFactor(factor)}` };
}

export interface ScaleBadgeOptions {
  /** Set ids the mariner turned off: their cells don't count. */
  disabledSets: () => readonly string[];
  /** `free` while this screen draws `/tiles/free` (licensed sets left out). */
  union: () => "all" | "free";
  /** The seam a test drives. */
  fetchCells?: (lon: number, lat: number, free: boolean, signal: AbortSignal) => Promise<CellAt[]>;
}

async function fetchCellsAt(
  lon: number,
  lat: number,
  free: boolean,
  signal: AbortSignal,
): Promise<CellAt[]> {
  const q = new URLSearchParams({ lon: lon.toFixed(5), lat: lat.toFixed(5), free: String(free) });
  const res = await fetch(`/api/cells/at?${q}`, { signal });
  if (!res.ok) throw new Error(`cells/at: HTTP ${res.status}`);
  return ((await res.json()) as { cells: CellAt[] }).cells;
}

/** The badge as a MapLibre control (bottom-left, stacked above the scale
 * bar). Re-reads the cells on `moveend`, re-judges on every `move`; call
 * `refresh()` when an option's input changes. */
export class ScaleBadgeControl implements maplibregl.IControl {
  private map?: maplibregl.Map;
  private container!: HTMLElement;
  private cells: CellAt[] = [];
  private inflight?: AbortController;
  private readonly fetchCells;

  constructor(private readonly opts: ScaleBadgeOptions) {
    this.fetchCells = opts.fetchCells ?? fetchCellsAt;
  }

  getDefaultPosition(): maplibregl.ControlPosition {
    return "bottom-left";
  }

  onAdd(map: maplibregl.Map) {
    this.map = map;
    this.container = document.createElement("div");
    this.container.className = "maplibregl-ctrl mivnav-scale-badge";
    this.container.hidden = true;
    map.on("move", this.render);
    map.on("moveend", this.load);
    void this.load();
    return this.container;
  }

  onRemove() {
    this.inflight?.abort();
    this.map?.off("move", this.render);
    this.map?.off("moveend", this.load);
    this.container.remove();
    this.map = undefined;
  }

  /** Re-fetch for the current centre (an input like the union changed). */
  refresh() {
    void this.load();
  }

  private readonly load = async () => {
    const map = this.map;
    if (!map) return;
    this.inflight?.abort();
    const ctl = new AbortController();
    this.inflight = ctl;
    const { lng, lat } = map.getCenter().wrap();
    try {
      this.cells = await this.fetchCells(lng, lat, this.opts.union() === "free", ctl.signal);
    } catch {
      if (ctl.signal.aborted) return;
      // An unknown answer must not keep claiming the last spot's chart.
      this.cells = [];
    }
    this.render();
  };

  private readonly render = () => {
    const map = this.map;
    if (!map) return;
    const off = this.opts.disabledSets();
    const cells = this.cells.filter((c) => !off.includes(c.set));
    const badge = scaleBadge(cells, map.getZoom(), map.getCenter().lat);
    this.container.hidden = badge === null;
    this.container.textContent = badge?.text ?? "";
    this.container.dataset.kind = badge?.kind ?? "";
    const finest = cells.length ? Math.min(...cells.map((c) => c.scale)) : 0;
    this.container.title = finest ? `Best chart here: 1:${finest.toLocaleString("en-US")}` : "";
  };
}
