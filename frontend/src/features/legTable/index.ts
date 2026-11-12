// THE LEG TABLE: a route's legs in a list — from → to, bearing, distance,
// running total, ETA — with the passage totals above. Opened from the manual
// editor (on its DRAFT: planned speed and departure are editable there, and a
// row selects that leg) or on a SAVED route (read-only, from the route card
// or the route list; a row frames that leg and the preview overlay bands it).
//
// When the route is the one being followed and there is a fix, the ETAs count
// from the boat (./table.ts, LIVE).
//
// Split: ./table.ts (the numbers, pure), ./overlay.ts (the saved route's
// preview), ./LegTableSheet.tsx (the surface), this file (state).

import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import type { Map as MLMap } from "maplibre-gl";
import type { Route, RoutesClient } from "../../core/routes";
import type { Vessel } from "../../core/signalk";
import { knotsFromMs } from "../../core/cpa";
import { isCompact, prefersReducedMotion } from "../../core/media";
import { measureObscured } from "../../core/chrome/Sheet";
import { defineFeature, type AppFeature } from "../../core/chrome/feature";
import type { RouteDrawModel } from "../routeDraw";
import { legMidpoint, legTable, type LegTableData, type LiveFix } from "./table";
import { createLegTableOverlay, type LegTablePreview } from "./overlay";

export type LegTableTarget = { kind: "draft" } | { kind: "saved"; id: string } | null;

export interface LegTableModel {
  open: Accessor<boolean>;
  /** The table's route: the editor's draft, or the saved route by id. */
  route: Accessor<Route | null>;
  table: Accessor<LegTableData | null>;
  /** Editing is the editor's: speed and departure are draft edits there. */
  editable: Accessor<boolean>;
  /** The highlighted leg (the editor's selected leg, or the last row tapped). */
  selectedLeg: Accessor<number | null>;
  /** The clock the table was computed at (ticks while open). */
  now: Accessor<number>;
  openDraft(): void;
  openRoute(route: Route): void;
  close(): void;
  /** A row tapped: select (editor) / band (saved) the leg and frame it. */
  pick(leg: number): void;
  setPlanSpeed(kn: number): void;
  setDepartAt(iso: string | null): void;
}

export interface LegTableDeps {
  client: RoutesClient;
  routeDraw: RouteDrawModel;
  /** The own ship — position and SOG for a followed route's live ETAs. */
  self: Accessor<Vessel | null | undefined>;
  /** Injectable clock for tests. */
  clock?: () => number;
}

/** How often the open table re-reads the clock — ETAs move by the minute. */
const TICK_MS = 20_000;

export function createLegTable(deps: LegTableDeps): { feature: AppFeature; model: LegTableModel } {
  const clock = deps.clock ?? Date.now;
  const [target, setTarget] = createSignal<LegTableTarget>(null);
  const [savedLeg, setSavedLeg] = createSignal<number | null>(null);
  const [now, setNow] = createSignal(clock());

  const route = createMemo<Route | null>(() => {
    const t = target();
    if (!t) return null;
    if (t.kind === "draft") return deps.routeDraw.draft();
    return deps.client.routes().find((r) => r.id === t.id) ?? null;
  });

  // The editor closed under its table, or the saved route was deleted: close.
  createEffect(() => {
    if (target() && !route()) setTarget(null);
  });

  // Tick while open.
  createEffect(() => {
    if (!target() || typeof setInterval === "undefined") return;
    setNow(clock());
    const timer = setInterval(() => setNow(clock()), TICK_MS);
    onCleanup(() => clearInterval(timer));
  });

  const live = createMemo<LiveFix | null>(() => {
    const r = route();
    const a = deps.client.active();
    if (!r || !a || a.route_id !== r.id) return null;
    const self = deps.self();
    if (!self) return null;
    const activeIndex = r.waypoints.findIndex((w) => w.id === a.waypoint_id);
    if (activeIndex < 0) return null;
    return { boat: { lng: self.lng, lat: self.lat }, sogKn: knotsFromMs(self.sogMs ?? 0), activeIndex };
  });

  const table = createMemo(() => {
    const r = route();
    return r ? legTable(r, now(), live()) : null;
  });

  const selectedLeg = (): number | null => {
    const t = target();
    if (t?.kind === "draft") {
      const s = deps.routeDraw.selection();
      return s?.kind === "leg" ? s.leg : null;
    }
    return t ? savedLeg() : null;
  };

  // ── Framing ──────────────────────────────────────────────────────────────
  let map: MLMap | undefined;
  const frame = (r: Route, leg: number) => {
    const a = r.waypoints[leg];
    const b = r.waypoints[leg + 1];
    if (!map || !a || !b || typeof map.fitBounds !== "function") return;
    // Unwrap across the antimeridian so the box spans the short way.
    let bLon = b.lon;
    if (bLon - a.lon > 180) bLon -= 360;
    if (bLon - a.lon < -180) bLon += 360;
    const pad = 48;
    // A sheet over the map's foot (phone) hides its lower part: frame above it.
    const obscured = isCompact() ? measureObscured(map.getContainer()) : { bottom: 0, top: 0 };
    map.fitBounds(
      [
        [Math.min(a.lon, bLon), Math.min(a.lat, b.lat)],
        [Math.max(a.lon, bLon), Math.max(a.lat, b.lat)],
      ],
      {
        padding: { top: pad + (obscured.top ?? 0), bottom: pad + obscured.bottom, left: pad, right: pad },
        // A short leg must not zoom the chart in to the harbour wall.
        maxZoom: Math.max(map.getZoom(), 14),
        duration: prefersReducedMotion() ? 0 : 500,
      },
    );
  };

  const preview = (): LegTablePreview | null => {
    const t = target();
    const r = route();
    if (t?.kind !== "saved" || !r) return null;
    // The followed route is drawn by the route display already.
    const drawn = deps.client.active()?.route_id === r.id;
    return { route: r, line: !drawn, leg: savedLeg() };
  };

  // A boolean MEMO: `route()` is a new object per 5 s poll and per draft
  // edit, and a plain accessor would re-run everything keyed on `open` —
  // the back-stack's registration included (one history entry per re-run).
  const open = createMemo(() => target() !== null && route() !== null);

  const model: LegTableModel = {
    open,
    route,
    table,
    editable: () => target()?.kind === "draft",
    selectedLeg,
    now,
    openDraft() {
      if (!deps.routeDraw.active()) return;
      setTarget({ kind: "draft" });
    },
    openRoute(r) {
      setSavedLeg(null);
      setTarget({ kind: "saved", id: r.id });
    },
    close() {
      setTarget(null);
      setSavedLeg(null);
    },
    pick(leg) {
      const t = target();
      const r = route();
      if (!t || !r || leg < 0 || leg >= r.waypoints.length - 1) return;
      if (t.kind === "draft") {
        const at = legMidpoint(r, leg);
        if (at) deps.routeDraw.select({ kind: "leg", leg, at });
      } else {
        setSavedLeg(leg);
      }
      frame(r, leg);
    },
    setPlanSpeed(kn) {
      if (target()?.kind === "draft") deps.routeDraw.setPlanSpeed(kn);
    },
    setDepartAt(iso) {
      if (target()?.kind === "draft") deps.routeDraw.setDepartAt(iso);
    },
  };

  const feature = defineFeature({
    id: "legTable",
    overlay: createLegTableOverlay(preview, (m) => (map = m)),
  });

  return { feature, model };
}
