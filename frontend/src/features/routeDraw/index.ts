// THE MANUAL ROUTE EDITOR: straight legs a person places by hand. No hazard
// check, no planner — every point is exactly where it was put. Separate from
// the autorouting plugin's editor (its `route-edit` mode) by design:
// its own mode, draft, overlay and card; it only shares the route STORE
// (`core/routes.ts`) and the route display's colours.
//
// Editing works on a DRAFT: entering copies the route (or starts a blank
// one), and nothing reaches the server until Done — one `save`, guarded by
// `If-Match`. Cancel discards (asking first if anything changed). Editing the
// route the boat is following changes nothing on the boat until Done.
//
// Split: ./draft.ts (pure edits + undo history), ./gesture.ts (pure
// gesture decisions), ./overlay.ts (the MapLibre host + layers), this file
// (state, mode, commands), ./RouteDrawCard.tsx (the selection/readout card).

import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor, type Setter } from "solid-js";
import type { Map as MLMap } from "maplibre-gl";
import { DEFAULT_PLAN_SPEED_KN, RouteSaveError, type Route, type RoutesClient } from "../../core/routes";
import type { Notice } from "../../core/chrome/notices";
import type { GeoPoint } from "../../core/chrome/geo";
import type { Mode } from "../../core/chrome/registry";
import { defineFeature, type AppFeature } from "../../core/chrome/feature";
import { coerceBoolean, deviceSetting } from "../../core/persist";
import { mintUuid, planRouteMetrics, type RoutePlan } from "../route";
import {
  blankRoute,
  canRedo,
  canUndo,
  commit,
  commitFrom,
  copyRoute,
  historyOf,
  insertPoint,
  movePoint,
  newWaypoint,
  redo,
  removePoint,
  renamePoint,
  renameRoute,
  replacePresent,
  sameContent,
  setDepartAt,
  setPlanSpeed,
  undo,
  type History,
} from "./draft";
import { addsAtStart, pointHitRadius, type Px, type TapAction } from "./gesture";
import { findSnap, snapPoint, snapWaypoint, type SnapMark } from "./snap";
import { aimAnchor, aimLeg, type AimLeg } from "./crosshair";
import { attachRouteDrawGestures, createRouteDrawOverlay } from "./overlay";
import { routeDrawCommands } from "./commands";
import { ROUTE_DRAW_MODE_ID } from "./ids";

export { ROUTE_DRAW_MODE_ID };

/** What is selected: a point (by id — survives inserts before it), or a leg
 * (by index, plus where on it "Insert here" would put a point). A leg
 * selection is dropped by any structural edit, since its index may shift. */
export type Selection =
  | { kind: "point"; id: string }
  | { kind: "leg"; leg: number; at: GeoPoint }
  | null;

export interface RouteDrawModel {
  /** True while the editor is open (there is a draft). */
  active: Accessor<boolean>;
  draft: Accessor<Route | null>;
  selection: Accessor<Selection>;
  /** Draft differs from what was opened (or last saved). */
  dirty: Accessor<boolean>;
  canUndo: Accessor<boolean>;
  canRedo: Accessor<boolean>;
  saving: Accessor<boolean>;
  /** The last Done hit a 409: another screen saved this route first. The
   * draft is kept; the card offers Overwrite / Save as copy. */
  conflict: Accessor<boolean>;
  /** The 409 was a DELETE on another screen (the route is gone): Overwrite
   * recreates it, so the card labels it "Save again". */
  conflictDeleted: Accessor<boolean>;
  /** A Cancel with unsaved changes armed a "Discard?" confirm. */
  confirmingDiscard: Accessor<boolean>;
  /** The id of the route being edited — the route display hides its saved
   * copy while the draft is drawn, so the two never double-draw. */
  editingRouteId: Accessor<string | null>;
  /** The point being dragged, or null. */
  draggingId: Accessor<string | null>;
  /** The draft measured at rest (per-leg bearing/distance, total). */
  plan: Accessor<RoutePlan>;
  /** Crosshair mode (remembered per device): a fixed centre crosshair is the
   * aim, "+ Here"/"Move here" act on it, open-water taps place nothing. */
  crosshair: Accessor<boolean>;
  setCrosshair(on: boolean): void;
  /** Where "+ Here"/"Move here" would put a point: the map centre, or the
   * mark it snaps to. Null outside crosshair mode. */
  aim: Accessor<GeoPoint | null>;
  /** The rubber band to the aim, from the selected (else last) point. */
  aimLeg: Accessor<AimLeg | null>;
  /** The mark a point would snap to right now — under a drag, or the aim. */
  snapTarget: Accessor<SnapMark | null>;
  /** "Go" is possible: a point is selected (an unsaved draft is saved first). */
  canGo: Accessor<boolean>;

  /** Open the editor on a blank route. */
  newRoute(): void;
  /** Open the editor on a copy of `route`. */
  edit(route: Route): void;
  /** Open the editor on a blank route whose point 1 is `at`. */
  newRouteFrom(at: GeoPoint): void;
  /** Crosshair "+ Here": add a point at the aim — appended, or prepended
   * when point 1 is selected (the tap rule). One undo step. */
  addHere(): void;
  /** Crosshair "Move here": move the selected point to the aim. One undo step. */
  moveHere(): void;
  /** A resolved tap (./gesture.ts `resolveTap`); `at` is where it landed —
   * for a leg selection, the spot on the leg. */
  tap(action: TapAction, at: GeoPoint): void;
  select(sel: Selection): void;
  /** Start dragging an existing (selected) point. */
  beginMove(id: string): void;
  /** Start dragging a NEW point out of leg `leg`, from the pressed spot `at`. */
  beginInsert(leg: number, at: GeoPoint): void;
  dragTo(at: GeoPoint): void;
  /** Close the drag as ONE undo step. */
  endDrag(): void;
  /** Abort the drag: the draft snaps back to its pre-drag state. */
  cancelDrag(): void;
  /** Insert a point at the selected leg's tapped spot. */
  insertAtSelectedLeg(): void;
  deleteSelected(): void;
  renamePoint(id: string, name: string): void;
  renameRoute(name: string): void;
  /** The draft's planning speed (knots) — one undo step, saved on Done. */
  setPlanSpeed(kn: number): void;
  /** The draft's planned departure (ISO UTC), or null = "leave now". One undo step. */
  setDepartAt(iso: string | null): void;
  undo(): void;
  redo(): void;
  /** Save (one PUT with If-Match) and close. Clean → just close. */
  done(): Promise<void>;
  /** Save WITHOUT closing — Follow/Go from the card save first. Resolves to
   * the saved route (the draft itself when already clean and saved), or null
   * when nothing could be saved (empty, a 409, a network failure). */
  save(): Promise<Route | null>;
  /** Close, asking first if dirty — the same path as the pill's X / Esc. */
  cancel(): void;
  /** Confirm the armed discard. */
  discard(): void;
  /** Back out of the armed discard (a Cancel's, or a switch to another route's). */
  keepEditing(): void;
  /** After a 409: save over the other screen's version. */
  overwrite(): Promise<void>;
  /** After a 409: save the draft as a new route instead. */
  saveCopy(): Promise<void>;
  /** Save if needed, start following at the selected point, and close. */
  go(): Promise<void>;
  /** App binds the mode state machine once both exist. */
  bindMode(m: { enter: () => void; leave: () => boolean }): void;
  /** The gesture host (./overlay.ts) lends the map's projection for
   * snapping — mark distance is a SCREEN distance. Null unbinds. */
  bindProjector(project: ((p: GeoPoint) => Px) | null): void;
}

export interface RouteDrawDeps {
  client: RoutesClient;
  notify?: (notice: Notice) => void;
  /** Injectable for deterministic tests. */
  mintId?: () => string;
  /** The live tap tolerance, px (`core/chrome/modes.ts` `tapRadius`). */
  tapRadius?: () => number;
  /** The map centre — App's `onCenterChange` feed. Read lazily (only while
   * the editor is open in crosshair mode). */
  center?: () => GeoPoint | null | undefined;
  /** Standalone marks to snap to (features/marks). Read lazily. */
  marks?: () => readonly SnapMark[];
  /** A short haptic buzz; default `navigator.vibrate` where it exists. */
  vibrate?: (ms: number) => void;
  /** Injectable crosshair-mode setting (tests); default a per-device one. */
  crosshairSetting?: [Accessor<boolean>, Setter<boolean>];
  /** The editor closed on a SAVED route (Done, Overwrite, Save as copy) —
   * App starts following it (else keeps it drawn), so Done starts the route. */
  onClosedSaved?: (route: Route) => void;
}

const defaultVibrate = (ms: number) => {
  try {
    if (typeof navigator !== "undefined") navigator.vibrate?.(ms);
  } catch {
    // Not allowed (no user activation yet, or an iframe): a buzz is a nicety.
  }
};

export function createRouteDraw(deps: RouteDrawDeps): { feature: AppFeature; model: RouteDrawModel } {
  const { client } = deps;
  const mintId = deps.mintId ?? mintUuid;
  const notify = (n: Notice) => deps.notify?.(n);

  const [history, setHistory] = createSignal<History | null>(null);
  // What "clean" means: the route as opened, or as last saved.
  const [baseline, setBaseline] = createSignal<Route | null>(null);
  const [selection, setSelection] = createSignal<Selection>(null);
  const [saving, setSaving] = createSignal(false);
  // The last save's 409: "changed" (another screen saved it first) or
  // "deleted" (another screen deleted it — Overwrite then recreates it).
  const [conflictKind, setConflict] = createSignal<"changed" | "deleted" | null>(null);
  const conflict = () => conflictKind() !== null;
  const [confirmingDiscard, setConfirmingDiscard] = createSignal(false);
  const [draggingId, setDraggingId] = createSignal<string | null>(null);
  // The pre-drag draft, so a drag is one undo step and a pinch restores it.
  let dragBase: Route | null = null;
  // The route the next `enter` opens (null = blank).
  let pendingOpen: Route | null = null;
  // ...and the point it starts from ("New route from here").
  let pendingFirst: GeoPoint | null = null;
  // A switch to another route (or New) that is waiting on "Discard?".
  let pendingSwitch: { route: Route | null; first: GeoPoint | null } | null = null;
  // Set by `discard()`: lets the next leave through `requestLeave`.
  let discardOk = false;

  const [crosshair, setCrosshair] =
    deps.crosshairSetting ?? deviceSetting("routeDraw.crosshair", { coerce: (raw) => coerceBoolean(raw, false) });
  const buzz = () => (deps.vibrate ?? defaultVibrate)(15);
  // The map's projection, lent by the gesture host; snapping needs screen px.
  let project: ((p: GeoPoint) => Px) | null = null;
  const snapAt = (at: GeoPoint): SnapMark | null =>
    project ? findSnap(at, deps.marks?.() ?? [], project, pointHitRadius(deps.tapRadius?.() ?? 8)) : null;
  // The mark the dragged point would snap to if dropped now.
  const [dragSnap, setDragSnap] = createSignal<SnapMark | null>(null);

  let enterMode: (() => void) | undefined;
  let leaveMode: (() => boolean) | undefined;

  const draft = createMemo(() => history()?.present ?? null);
  const active = () => draft() !== null;
  const dirty = createMemo(() => {
    const d = draft();
    const b = baseline();
    return !!d && !!b && !sameContent(d, b);
  });
  const plan = createMemo(() => {
    const d = draft();
    return d ? planRouteMetrics(d.waypoints, d.plan_speed_kn) : { legs: [], totalNm: 0, totalSec: 0 };
  });
  // ── Crosshair ─────────────────────────────────────────────────────────────
  // `active()` is read FIRST: App hands `center`/`marks` over as closures over
  // signals it declares later, so nothing may call them before the editor opens.
  const aimRaw = createMemo<GeoPoint | null>(() => (active() && crosshair() ? (deps.center?.() ?? null) : null));
  const aimSnap = createMemo<SnapMark | null>(() => {
    const c = aimRaw();
    return c ? snapAt(c) : null;
  });
  const aim = createMemo<GeoPoint | null>(() => {
    const m = aimSnap();
    return m ? { lng: m.lon, lat: m.lat } : aimRaw();
  });
  const aimLegNow = createMemo<AimLeg | null>(() => {
    const d = draft();
    if (!d || draggingId()) return null;
    const s = selection();
    return aimLeg(aimAnchor(d.waypoints, s?.kind === "point" ? s.id : null), aim());
  });
  const snapTarget = () => (draggingId() ? dragSnap() : aimSnap());
  // A buzz each time the aim catches a (new) mark — the same cue a drag gives.
  createEffect(
    on(
      () => aimSnap()?.id,
      (id, prev) => {
        if (id && id !== prev) buzz();
      },
      { defer: true },
    ),
  );

  const canGo = () => {
    const d = draft();
    const s = selection();
    return !!d && !saving() && !draggingId() && s?.kind === "point";
  };

  /** After the draft jumps from `prev` to `r` (undo/redo/cancelled drag):
   * keep a point selection while its point exists, and a leg's while that leg
   * is the same two points in the same places (an undone speed change keeps
   * it; a moved, inserted or removed end drops it — its index or spot may
   * have shifted). */
  const fixSelection = (prev: Route, r: Route) => {
    const s = selection();
    if (s?.kind === "point" && !r.waypoints.some((w) => w.id === s.id)) setSelection(null);
    if (s?.kind === "leg") {
      const same = (i: number) => {
        const a = prev.waypoints[i];
        const b = r.waypoints[i];
        return !!a && !!b && a.id === b.id && a.lat === b.lat && a.lon === b.lon;
      };
      if (!same(s.leg) || !same(s.leg + 1)) setSelection(null);
    }
  };

  /** Answer an armed "Discard?" with "keep editing". */
  const disarm = () => {
    setConfirmingDiscard(false);
    pendingSwitch = null;
  };

  /** Apply one edit as one undo step. Any edit answers an armed confirm/409
   * banner — the person has gone back to editing. */
  const edit = (fn: (r: Route) => Route): Route | null => {
    const h = history();
    if (!h) return null;
    const next = fn(h.present);
    if (next === h.present) return null;
    setHistory(commit(h, next));
    disarm();
    return next;
  };

  const seed = (r: Route) => {
    const copy = copyRoute(r);
    setHistory(historyOf(copy));
    setBaseline(copy);
    setSelection(null);
    setSaving(false);
    setConflict(null);
    setConfirmingDiscard(false);
    setDraggingId(null);
    setDragSnap(null);
    dragBase = null;
    discardOk = false;
    pendingSwitch = null;
  };

  const clear = () => {
    setHistory(null);
    setBaseline(null);
    setSelection(null);
    setConflict(null);
    setConfirmingDiscard(false);
    setDraggingId(null);
    setDragSnap(null);
    dragBase = null;
    pendingSwitch = null;
  };

  /** A new point at `at` — on a mark instead, if it is that close to one. */
  const addPoint = (index: (r: Route) => number, at: GeoPoint) => {
    const snap = snapAt(at);
    const plain = newWaypoint(mintId(), at);
    const wp = snap ? snapWaypoint(plain, snap) : plain;
    if (edit((r) => insertPoint(r, index(r), wp))) {
      setSelection({ kind: "point", id: wp.id });
      if (snap) buzz();
    }
  };

  /** Seed a fresh draft (blank when `r` is null), with point 1 at `first`. */
  const start = (r: Route | null, first: GeoPoint | null) => {
    seed(r ?? blankRoute(mintId(), DEFAULT_PLAN_SPEED_KN));
    if (first) addPoint(() => 0, first);
  };

  const open = (r: Route | null, first: GeoPoint | null = null) => {
    if (active()) {
      // Already open: switching would drop this draft's edits — ask first
      // (the card's "Discard?"; Discard then opens the new one).
      if (dirty()) {
        pendingSwitch = { route: r, first };
        setConfirmingDiscard(true);
        return;
      }
      start(r, first);
      return;
    }
    pendingOpen = r;
    pendingFirst = first;
    enterMode?.();
  };

  // ── Saving ────────────────────────────────────────────────────────────────

  const exit = () => leaveMode?.();

  /** Close after a save (or a clean Done on a saved route): hand the saved
   * route to App so it stays on the chart. */
  const closeSaved = (r: Route | null) => {
    discardOk = true;
    exit();
    if (r && r.rev > 0 && r.waypoints.length > 0) deps.onClosedSaved?.(r);
  };

  /** One PUT. On success the saved route becomes the clean baseline (and the
   * draft takes its new rev). `quiet`: no "Route saved" notice (a Follow/Go
   * that saves first says what it did itself). */
  const persist = async (r: Route, quiet = false): Promise<Route | null> => {
    setSaving(true);
    try {
      const saved = await client.save(r);
      setConflict(null);
      // Rebase the history on the saved rev, keeping undo steps meaningful
      // were the editor to stay open.
      setHistory((h) => (h ? { ...h, present: saved } : h));
      setBaseline(copyRoute(saved));
      if (!quiet) {
        notify({
          id: "route-draw-saved",
          title: "Route saved",
          detail: saved.name || undefined,
        });
      }
      return saved;
    } catch (e) {
      if (e instanceof RouteSaveError && e.status === 409) {
        // Changed, or deleted? A delete elsewhere also 409s (the If-Match rev
        // names a route that is gone) — re-read the store to tell which.
        try {
          await client.refresh();
        } catch (re) {
          console.error("routeDraw: refresh after 409 failed", re);
        }
        const gone = !client.routes().some((x) => x.id === r.id);
        setConflict(gone ? "deleted" : "changed");
        notify(
          gone
            ? {
                id: "route-draw-conflict",
                title: "Route deleted on another screen",
                detail: "Not saved — your edits are kept. Save it again, or save as a copy.",
              }
            : {
                id: "route-draw-conflict",
                title: "Route changed on another screen",
                detail: "Not saved — your edits are kept. Overwrite, or save as a copy.",
              },
        );
      } else {
        console.error("routeDraw: save failed", e);
        notify({ id: "route-draw-failed", title: "Couldn’t save the route", detail: "Your edits are kept — try Done again." });
      }
      return null;
    } finally {
      setSaving(false);
    }
  };

  const done = async () => {
    const d = draft();
    if (!d || saving()) return;
    // Nothing to save: unchanged, or a blank route never placed.
    if (!dirty() || (d.rev === 0 && d.waypoints.length === 0)) return closeSaved(d);
    const saved = await persist(d);
    if (saved) closeSaved(saved);
  };

  const save = async (): Promise<Route | null> => {
    const d = draft();
    if (!d || saving() || d.waypoints.length === 0) return null;
    if (conflict()) return null; // the card's Overwrite / Save as copy decides
    if (d.rev > 0 && !dirty()) return d;
    return persist(d, true);
  };

  const overwrite = async () => {
    const d = draft();
    if (!d || saving()) return;
    await client.refresh();
    const server = client.routes().find((r) => r.id === d.id);
    // Deleted meanwhile → recreate it (rev 0 = no If-Match).
    const saved = await persist({ ...d, rev: server?.rev ?? 0 });
    if (saved) closeSaved(saved);
  };

  const saveCopy = async () => {
    const d = draft();
    if (!d || saving()) return;
    const name = d.name ? `${d.name} (copy)`.slice(0, 64) : "";
    const saved = await persist({ ...d, id: mintId(), name, rev: 0, updated: 0 });
    if (saved) closeSaved(saved);
  };

  const go = async () => {
    const d = draft();
    const s = selection();
    if (!d || s?.kind !== "point" || !canGo()) return;
    const saved = await save();
    if (!saved) return;
    try {
      await client.setActive({ route_id: saved.id, waypoint_id: s.id });
      discardOk = true;
      exit();
    } catch (e) {
      console.error("routeDraw: GO failed", e);
      notify({ id: "route-draw-go-failed", title: "Couldn’t start following the route" });
    }
  };

  // ── The mode ──────────────────────────────────────────────────────────────

  const mode: Mode = {
    id: ROUTE_DRAW_MODE_ID,
    // A getter: the tool button reads "New route"; once a saved route is
    // open, the pill names what is happening to it.
    get label() {
      return (draft()?.rev ?? 0) > 0 ? "Edit route" : "New route";
    },
    enter: () => {
      const r = pendingOpen;
      const first = pendingFirst;
      pendingOpen = null;
      pendingFirst = null;
      start(r, first);
      suspendDoubleClickZoom();
    },
    requestLeave: () => {
      if (discardOk || !dirty()) return true;
      // The second Cancel (X, Esc, Back) while the confirm is up IS the
      // confirm — the card says so.
      if (confirmingDiscard()) return true;
      setConfirmingDiscard(true);
      return false;
    },
    leave: () => {
      clear();
      discardOk = false;
      restoreDoubleClickZoom();
    },
    // The editor's gestures are the host's (./overlay.ts), which resolves taps
    // with its own slop. Every click is consumed so the info panel never
    // opens under the editor.
    onClick: () => active(),
    // No floating hint: the card (RouteDrawCard.tsx) is always up while the
    // editor is open and says "tap to place the first point" itself.
    pill: () => ({
      actions: [
        { id: "undo", label: "Undo", disabled: !canUndoNow(), run: () => model.undo() },
        { id: "redo", label: "Redo", disabled: !canRedoNow(), run: () => model.redo() },
        {
          id: "done",
          label: saving() ? "Saving…" : "Done",
          kind: "primary",
          disabled: saving(),
          run: () => void done(),
        },
      ],
    }),
  };

  const canUndoNow = () => {
    const h = history();
    return !!h && canUndo(h) && !draggingId();
  };
  const canRedoNow = () => {
    const h = history();
    return !!h && canRedo(h) && !draggingId();
  };

  const model: RouteDrawModel = {
    active,
    draft,
    selection,
    dirty,
    canUndo: canUndoNow,
    canRedo: canRedoNow,
    saving,
    conflict,
    conflictDeleted: () => conflictKind() === "deleted",
    confirmingDiscard,
    editingRouteId: () => draft()?.id ?? null,
    draggingId,
    plan,
    canGo,
    crosshair,
    setCrosshair: (on) => void setCrosshair(on),
    aim,
    aimLeg: aimLegNow,
    snapTarget,

    newRoute: () => open(null),
    edit: (route) => open(route),
    newRouteFrom: (at) => open(null, at),

    addHere() {
      const d = draft();
      const c = aimRaw();
      if (!d || !c || draggingId()) return;
      const s = selection();
      const atStart = addsAtStart({
        firstId: d.waypoints[0]?.id ?? null,
        count: d.waypoints.length,
        selectedId: s?.kind === "point" ? s.id : null,
      });
      addPoint(atStart ? () => 0 : (r) => r.waypoints.length, c);
    },

    moveHere() {
      const s = selection();
      const c = aimRaw();
      if (s?.kind !== "point" || !c || draggingId()) return;
      const snap = snapAt(c);
      if (edit((r) => (snap ? snapPoint(r, s.id, snap) : movePoint(r, s.id, c))) && snap) buzz();
    },

    tap(action, at) {
      if (!active() || draggingId()) return;
      switch (action.op) {
        case "append":
          return addPoint((r) => r.waypoints.length, at);
        case "prepend":
          return addPoint(() => 0, at);
        case "selectPoint":
          return setSelection({ kind: "point", id: action.id });
        case "insertOnLeg":
          return addPoint(() => action.leg + 1, at);
        case "deselect":
          return setSelection(null);
      }
    },

    select: setSelection,

    beginMove(id) {
      const h = history();
      if (!h || !h.present.waypoints.some((w) => w.id === id)) return;
      dragBase = h.present;
      setDragSnap(null);
      setDraggingId(id);
      setSelection({ kind: "point", id });
    },

    beginInsert(leg, at) {
      const h = history();
      if (!h || leg < 0 || leg >= h.present.waypoints.length - 1) return;
      const wp = newWaypoint(mintId(), at);
      const next = insertPoint(h.present, leg + 1, wp);
      if (next === h.present) return;
      dragBase = h.present;
      setDragSnap(null);
      setHistory(replacePresent(h, next));
      setDraggingId(wp.id);
      setSelection({ kind: "point", id: wp.id });
    },

    dragTo(at) {
      const id = draggingId();
      const h = history();
      if (!id || !h) return;
      setHistory(replacePresent(h, movePoint(h.present, id, at)));
      // The point follows the finger; the mark it would land on lights up,
      // with a buzz each time a new one catches.
      const snap = snapAt(at);
      if (snap?.id !== dragSnap()?.id) {
        setDragSnap(snap);
        if (snap) buzz();
      }
    },

    endDrag() {
      const id = draggingId();
      const snap = dragSnap();
      let h = history();
      if (h && id && snap) {
        h = replacePresent(h, snapPoint(h.present, id, snap));
        setHistory(h);
      }
      if (h && dragBase) {
        setHistory(commitFrom(h, dragBase));
        disarm();
      }
      dragBase = null;
      setDragSnap(null);
      setDraggingId(null);
    },

    cancelDrag() {
      const h = history();
      if (h && dragBase) {
        setHistory(replacePresent(h, dragBase));
        fixSelection(h.present, dragBase);
      }
      dragBase = null;
      setDragSnap(null);
      setDraggingId(null);
    },

    insertAtSelectedLeg() {
      const s = selection();
      if (s?.kind !== "leg") return;
      addPoint(() => s.leg + 1, s.at);
    },

    deleteSelected() {
      const s = selection();
      if (s?.kind !== "point" || draggingId()) return;
      if (edit((r) => removePoint(r, s.id))) setSelection(null);
    },

    renamePoint(id, name) {
      edit((r) => renamePoint(r, id, name));
    },

    renameRoute(name) {
      edit((r) => renameRoute(r, name));
    },

    setPlanSpeed(kn) {
      edit((r) => setPlanSpeed(r, kn));
    },

    setDepartAt(iso) {
      edit((r) => setDepartAt(r, iso));
    },

    undo() {
      const h = history();
      if (!h || !canUndoNow()) return;
      const next = undo(h);
      setHistory(next);
      fixSelection(h.present, next.present);
    },

    redo() {
      const h = history();
      if (!h || !canRedoNow()) return;
      const next = redo(h);
      setHistory(next);
      fixSelection(h.present, next.present);
    },

    done,
    save,
    cancel: () => void exit(),
    discard() {
      // A switch was waiting on this: open the other route instead of closing.
      const sw = pendingSwitch;
      if (sw && active()) return start(sw.route, sw.first);
      discardOk = true;
      exit();
    },
    keepEditing: disarm,
    overwrite,
    saveCopy,
    go,

    bindMode(m) {
      enterMode = m.enter;
      leaveMode = m.leave;
    },

    bindProjector(p) {
      project = p;
    },
  };

  // The overlay hands over the live map; the gesture host attaches once per map.
  let detach: (() => void) | undefined;
  let attachedTo: MLMap | undefined;
  onCleanup(() => detach?.());
  const onMap = (map: MLMap) => {
    if (attachedTo === map) return;
    detach?.();
    attachedTo = map;
    detach = attachRouteDrawGestures(map, model, deps.tapRadius);
  };

  // Quick taps place quick points, so MapLibre's double-tap/double-click zoom
  // is off while editing — and restored exactly as found on the way out.
  let dblZoomWasOn = false;
  const suspendDoubleClickZoom = () => {
    const h = attachedTo?.doubleClickZoom;
    dblZoomWasOn = !!h?.isEnabled();
    if (dblZoomWasOn) h!.disable();
  };
  const restoreDoubleClickZoom = () => {
    if (dblZoomWasOn) attachedTo?.doubleClickZoom?.enable();
    dblZoomWasOn = false;
  };

  const feature = defineFeature({
    id: "routeDraw",
    modes: [mode],
    overlay: createRouteDrawOverlay(model, onMap),
    commands: (cdeps) => routeDrawCommands(cdeps, model),
  });

  return { feature, model };
}
