import ArrowLeftRight from "lucide-solid/icons/arrow-left-right";
import CircleStop from "lucide-solid/icons/circle-stop";
import Download from "lucide-solid/icons/download";
import Footprints from "lucide-solid/icons/footprints";
import ListOrdered from "lucide-solid/icons/list-ordered";
import Navigation from "lucide-solid/icons/navigation";
import Upload from "lucide-solid/icons/upload";
import Pencil from "lucide-solid/icons/pencil";
import Plus from "lucide-solid/icons/plus";
import Trash2 from "lucide-solid/icons/trash-2";
import { createSignal, For, Show, type Component } from "solid-js";
import Sheet from "../../core/chrome/Sheet";
import DockPanel from "../../core/chrome/DockPanel";
import { useBackDismiss } from "../../core/chrome/backStack";
import { isCompact } from "../../core/media";
import type { Route } from "../../core/routes";
import { routePlanner } from "../../core/routePlanner";
import { planRouteMetrics, type RoutesModel } from "./index";
import { formatRange } from "../../core/format";
import { downloadGpx } from "./download";

// The surface that makes a saved-but-inactive route reachable: open one back
// into the editor, save its return passage as a copy, export it as GPX, or
// delete it; and the way routes come IN — New, Import GPX, From track. Before this,
// `routesClient.routes()` held every saved route but nothing listed them.

export interface RouteListProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  routes: RoutesModel;
  /** The MANUAL editor (features/routeDraw): open a route in it, or start a
   * blank one. With no route planner (core/routePlanner.ts) these are the
   * list's open/New; with one, the planner's editor keeps those and this is a
   * row's "Edit points". */
  editPoints?: (route: Route) => void;
  newManual?: () => void;
  /** "Make route from track" (features/track) — absent hides the button. */
  fromTrack?: () => void;
  /** Open the leg table on a route (features/legTable) — absent hides it. */
  showLegs?: (route: Route) => void;
}

/** A route's summary line: its name (or a placeholder), its waypoint count
 * and total distance (`3 WP · 12.4 nm`, the info card's `summary` figures). */
const routeName = (r: Route): string => r.name.trim() || "Untitled route";
export const routeGlance = (r: Route): string => {
  const n = r.waypoints.length;
  const wps = `${n} WP`;
  if (n < 2) return wps;
  const d = formatRange(planRouteMetrics(r.waypoints, r.plan_speed_kn).totalNm);
  return `${wps} · ${d.value} ${d.unit}`;
};

const RouteList: Component<RouteListProps> = (props) => {
  useBackDismiss(() => props.open, () => props.onOpenChange(false));
  // Two-tap delete (same guard as `ProfilesSection`): first tap arms the row
  // ("Delete?"), second confirms. Holds the id being confirmed.
  const [confirmDelete, setConfirmDelete] = createSignal<string | null>(null);
  // The same two-tap guard for Follow while ANOTHER route is followed:
  // replacing the passage being sailed is never one stray tap.
  const [confirmSwitch, setConfirmSwitch] = createSignal<string | null>(null);

  const follow = (r: Route) => {
    const other = props.routes.activeRouteId();
    if (other && other !== r.id && confirmSwitch() !== r.id) {
      setConfirmSwitch(r.id);
      return;
    }
    setConfirmSwitch(null);
    void props.routes.follow(r, { confirmed: true });
    props.onOpenChange(false);
  };

  // Tapping a row SHOWS the route on the chart, framed — looking at a route
  // is the common case, and must not drop you into an editor. Edit is a button.
  const canNew = () => !!routePlanner() || !!props.newManual;

  const open = (r: Route) => {
    if (r.waypoints.length === 0) return;
    props.routes.showRoute(r, { fit: true });
    props.onOpenChange(false);
  };

  const edit = (r: Route) => {
    const planner = routePlanner();
    if (planner) planner.editRoute(r);
    else if (props.editPoints) props.editPoints(r);
    else return;
    props.onOpenChange(false);
  };

  const editPoints = (r: Route) => {
    props.editPoints?.(r);
    props.onOpenChange(false);
  };

  // Works even while a route is being followed — the new draft is separate.
  const startNew = () => {
    const planner = routePlanner();
    if (planner) planner.newRoute();
    else props.newManual?.();
    props.onOpenChange(false);
  };

  // Import: a hidden file input behind a button. Parsed and saved entirely
  // in the browser (./gpx.ts) — the store sees ordinary new routes.
  let fileInput: HTMLInputElement | undefined;
  const [importing, setImporting] = createSignal(false);
  const importFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setImporting(true);
    try {
      for (const f of Array.from(files)) await props.routes.importGpx(await f.text(), f.name);
    } finally {
      setImporting(false);
      // Same file again must fire `change` again.
      if (fileInput) fileInput.value = "";
    }
  };

  const btn =
    "flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs font-semibold text-fg-2 enabled:hover:border-accent enabled:hover:text-accent enabled:active:brightness-95 disabled:opacity-40 focus-ring";
  // The primary action: a solid accent button (no blur, per the UI rule).
  const newBtn =
    "flex w-full items-center justify-center gap-1.5 rounded-md border border-accent bg-accent px-2.5 py-2 text-xs font-semibold text-accent-fg transition-colors hover:brightness-110 active:brightness-95 focus-ring";

  const Body: Component = () => (
    <div class="flex flex-col gap-3">
      <Show when={canNew()}>
        <button type="button" class={newBtn} onClick={startNew}>
          <Plus size={14} aria-hidden="true" />
          New route
        </button>
      </Show>
      <div class="flex flex-wrap items-center gap-1.5">
        <input
          ref={fileInput}
          type="file"
          accept=".gpx,application/gpx+xml,application/xml,text/xml"
          multiple
          class="hidden"
          onChange={(e) => void importFiles(e.currentTarget.files)}
        />
        <button
          type="button"
          class={btn}
          disabled={importing()}
          title="Add routes from a .gpx file — its routes, and its tracks simplified"
          onClick={() => fileInput?.click()}
        >
          <Upload size={13} aria-hidden="true" />
          {importing() ? "Importing…" : "Import GPX"}
        </button>
        <Show when={props.fromTrack}>
          <button
            type="button"
            class={btn}
            title="A new route from the latest stretch of the ship track"
            onClick={() => props.fromTrack?.()}
          >
            <Footprints size={13} aria-hidden="true" />
            From track
          </button>
        </Show>
      </div>
      <Show
        when={props.routes.routes().length > 0}
        fallback={
          <p class="px-1 py-4 text-center text-sm text-fg-3">
            {canNew()
              ? "No saved routes yet. Tap New route to draw one."
              : "No saved routes yet."}
          </p>
        }
      >
        <ul class="flex flex-col gap-2">
          <For each={props.routes.routes()}>
            {(r) => {
              const following = () => props.routes.activeRouteId() === r.id;
              const armed = () => confirmDelete() === r.id;
              const switching = () => confirmSwitch() === r.id;
              const rowOpens = () => r.waypoints.length > 0;
              // Whole row shows the route (fat-finger target); nested Reverse/
              // Delete controls `stopPropagation` to avoid also opening.
              const openFromKey = (e: KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  open(r);
                }
              };
              return (
                <li
                  role={rowOpens() ? "button" : undefined}
                  tabindex={rowOpens() ? 0 : undefined}
                  aria-label={rowOpens() ? `Show ${routeName(r)} on the chart` : undefined}
                  onClick={() => open(r)}
                  onKeyDown={openFromKey}
                  class="rounded-lg border border-line bg-chrome-2 p-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  classList={{
                    "cursor-pointer hover:border-line-2 hover:bg-chrome active:bg-chrome": rowOpens(),
                  }}
                >
                  <div class="mb-2 flex items-baseline justify-between gap-2">
                    <span class="truncate font-semibold text-fg">{routeName(r)}</span>
                    <span class="shrink-0 font-mono text-[11px] text-fg-3">{routeGlance(r)}</span>
                  </div>
                  <Show when={following()}>
                    <div class="mb-2 inline-flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 font-mono text-[10px] font-bold tracking-[0.06em] text-accent">
                      FOLLOWING
                    </div>
                  </Show>
                  <Show when={switching()}>
                    <div class="mb-2 flex flex-wrap items-center gap-1.5">
                      <span class="text-xs font-semibold text-fg">Switch to {routeName(r)}?</span>
                      <button
                        type="button"
                        class={btn}
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmSwitch(null);
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        class={`${btn} border-accent! text-accent!`}
                        onClick={(e) => {
                          e.stopPropagation();
                          follow(r);
                        }}
                      >
                        <Navigation size={13} aria-hidden="true" />
                        Switch
                      </button>
                    </div>
                  </Show>
                  <div class="flex flex-wrap items-center gap-1.5">
                    {/* Not planner-gated: following needs no autorouter. */}
                    <Show when={!following() && !switching()}>
                      <button
                        type="button"
                        class={`${btn} border-accent/50! text-accent!`}
                        disabled={r.waypoints.length === 0}
                        title="Follow from the nearest leg ahead of the boat"
                        onClick={(e) => {
                          e.stopPropagation();
                          follow(r);
                        }}
                      >
                        <Navigation size={13} aria-hidden="true" />
                        Follow
                      </button>
                    </Show>
                    <Show when={props.showLegs}>
                      <button
                        type="button"
                        class={btn}
                        disabled={r.waypoints.length < 2}
                        title="Each leg's bearing, distance and ETA"
                        onClick={(e) => {
                          e.stopPropagation();
                          // Both dock left on desktop: the table takes the list's place.
                          props.onOpenChange(false);
                          props.showLegs?.(r);
                        }}
                      >
                        <ListOrdered size={13} aria-hidden="true" />
                        Legs
                      </button>
                    </Show>
                    <button
                      type="button"
                      class={btn}
                      disabled={r.waypoints.length < 2}
                      title="Save the return passage as a new route — this one stays as it is"
                      onClick={(e) => {
                        e.stopPropagation();
                        void props.routes.reverseRoute(r);
                      }}
                    >
                      <ArrowLeftRight size={13} aria-hidden="true" />
                      Reverse
                    </button>
                    <button
                      type="button"
                      class={btn}
                      disabled={r.waypoints.length === 0}
                      title="Download as a .gpx file"
                      onClick={(e) => {
                        e.stopPropagation();
                        downloadGpx(r);
                      }}
                    >
                      <Download size={13} aria-hidden="true" />
                      GPX
                    </button>
                    <Show when={routePlanner() || props.editPoints}>
                      <button
                        type="button"
                        class={btn}
                        title="Open the route in the editor"
                        onClick={(e) => {
                          e.stopPropagation();
                          edit(r);
                        }}
                      >
                        <Pencil size={13} aria-hidden="true" />
                        Edit
                      </button>
                    </Show>
                    {/* Beside the planner's editor: hand-edit the points. */}
                    <Show when={routePlanner() && props.editPoints}>
                      <button
                        type="button"
                        class={btn}
                        title="Move, add or delete points by hand"
                        onClick={(e) => {
                          e.stopPropagation();
                          editPoints(r);
                        }}
                      >
                        <Pencil size={13} aria-hidden="true" />
                        Edit points
                      </button>
                    </Show>
                    {/* Not planner-gated, unlike the editor's own Stop following. */}
                    <Show when={following()}>
                      <button
                        type="button"
                        class={btn}
                        onClick={(e) => {
                          e.stopPropagation();
                          void props.routes.stopFollowing();
                        }}
                      >
                        <CircleStop size={13} aria-hidden="true" />
                        Stop following
                      </button>
                    </Show>
                    <Show
                      when={armed()}
                      fallback={
                        <button
                          type="button"
                          class={`${btn} ml-auto`}
                          aria-label={`Delete ${routeName(r)}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmDelete(r.id);
                          }}
                        >
                          <Trash2 size={13} aria-hidden="true" />
                          Delete
                        </button>
                      }
                    >
                      <div class="ml-auto flex items-center gap-1.5">
                        <button
                          type="button"
                          class={btn}
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmDelete(null);
                          }}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          class={`${btn} border-alarm! text-alarm!`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmDelete(null);
                            void props.routes.removeRoute(r);
                          }}
                        >
                          Delete?
                        </button>
                      </div>
                    </Show>
                  </div>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
    </div>
  );

  // DESKTOP: docked LEFT column that shrinks the map. PHONE: modal bottom sheet.
  return (
    <Show
      when={isCompact()}
      fallback={
        <DockPanel
          open={props.open}
          onClose={() => props.onOpenChange(false)}
          title="Routes"
          side="left"
        >
          <Body />
        </DockPanel>
      }
    >
      <Sheet open={props.open} onOpenChange={props.onOpenChange} title="Routes" modal>
        <Body />
      </Sheet>
    </Show>
  );
};

export default RouteList;
