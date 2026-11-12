import X from "lucide-solid/icons/x";
import Navigation from "lucide-solid/icons/navigation";
import type { Route } from "../../core/routes";
import { createEffect, createSignal, Index, onCleanup, Show, type Component } from "solid-js";
import Sheet, { measureKeepClearInset, SHEET_Z } from "../../core/chrome/Sheet";
import DockPanel from "../../core/chrome/DockPanel";
import { useBackDismiss } from "../../core/chrome/backStack";
import { isCompact } from "../../core/media";
import { formatDuration, formatRange, padDeg } from "../../core/format";
import {
  parseDatetimeLocal,
  parsePlanSpeed,
  stepPlanSpeed,
  toDatetimeLocal,
} from "../route/planSheet";
import { departIso, formatWhen, pointLabel, type LegRowData } from "./table";
import type { LegTableModel } from "./index";

// The leg table's surface. PHONE: a non-modal bottom sheet, opening with the
// header and the first legs showing, so the chart above it stays live and a
// tapped leg is framed in view; it rests above the mode pill and the MOB
// button. DESKTOP:
// the docked left column (the route list's), which shrinks the map instead.
// One layout for both — 22rem is about a phone's width.

const dist = (nm: number): string => {
  const r = formatRange(nm);
  return `${r.value} ${r.unit}`;
};

const Cell: Component<{ label: string; value: string; title?: string }> = (c) => (
  <div class="min-w-0" title={c.title}>
    <div class="font-mono text-[10px] font-bold tracking-[0.06em] text-fg-3 uppercase">{c.label}</div>
    <div class="truncate font-mono font-semibold tabular-nums">{c.value}</div>
  </div>
);

/** The header's Follow button (App wires it to the routes model). */
export interface LegTableFollow {
  /** Is `route` the one being followed? Then there is nothing to start. */
  following: (route: Route) => boolean;
  /** Why Follow can't run right now (an unsaved draft), or null. */
  blocked: () => string | null;
  run: (route: Route) => void;
}

const LegTableBody: Component<{ model: LegTableModel; follow?: LegTableFollow }> = (props) => {
  const m = props.model;
  const t = () => m.table();
  const r = () => m.route();
  const speed = () => r()?.plan_speed_kn ?? 0;
  const departLabel = () => {
    const d = t()?.departMs ?? null;
    return d === null ? "Now" : formatWhen(d, m.now());
  };
  const btn =
    "flex items-center justify-center rounded-md border border-line bg-chrome-2 px-2.5 py-1 text-xs font-semibold text-fg-2 enabled:hover:border-accent enabled:hover:text-accent disabled:opacity-40 pointer-coarse:min-h-11 pointer-coarse:min-w-11 focus-ring";

  const rowEta = (row: LegRowData) => (row.state === "done" ? "done" : formatWhen(row.etaMs, m.now()));

  return (
    <div class="flex flex-col gap-3 text-[13px]">
      <div class="min-w-0">
        <div class="flex items-center justify-between gap-2">
          <div class="truncate text-[15px] font-semibold">{r()?.name.trim() || "Untitled route"}</div>
          <Show when={props.follow && r() && !props.follow.following(r()!) && r()!.waypoints.length > 0}>
            <button
              type="button"
              class={`${btn} shrink-0 gap-1 border-accent/50! text-accent!`}
              disabled={!!props.follow!.blocked()}
              title={props.follow!.blocked() ?? "Follow from the nearest leg ahead of the boat"}
              onClick={() => props.follow!.run(r()!)}
            >
              <Navigation size={13} aria-hidden="true" />
              Follow
            </button>
          </Show>
        </div>
        <Show when={props.follow && r() && !props.follow.following(r()!) && props.follow.blocked()}>
          {(why) => <div class="mt-0.5 text-[11px] text-fg-3">{why()}</div>}
        </Show>
        <Show when={t()?.live}>
          {(l) => (
            <div class="mt-0.5 font-mono text-[11px] text-accent tabular-nums">
              FOLLOWING · from the boat at {l().sogKn.toFixed(1)} kn
            </div>
          )}
        </Show>
      </div>

      <div class="grid grid-cols-3 gap-x-3 gap-y-2">
        <Show
          when={t()?.live}
          fallback={
            <>
              <Cell label="Distance" value={dist(t()?.totalNm ?? 0)} />
              <Cell label="Time" value={formatDuration(t()?.totalSec ?? Infinity)} />
              <Cell label="Arrive" value={formatWhen(t()?.arriveMs ?? null, m.now())} />
            </>
          }
        >
          {(l) => (
            <>
              <Cell label="To go" value={dist(l().remainingNm)} title={`Route ${dist(t()?.totalNm ?? 0)}`} />
              <Cell label="Time" value={formatDuration(l().remainingSec)} />
              <Cell label="ETA" value={formatWhen(t()?.arriveMs ?? null, m.now())} />
            </>
          )}
        </Show>
        <Show when={!m.editable()}>
          <Cell label="Speed" value={`${speed().toFixed(1)} kn`} />
          <div class="col-span-2">
            <Cell label="Departure" value={departLabel()} />
          </div>
        </Show>
      </div>

      {/* Editor only: planned speed and departure are draft edits (one undo
          step each, saved on Done). */}
      <Show when={m.editable()}>
        <div data-no-drag class="flex flex-wrap items-end gap-x-3 gap-y-2">
          <div>
            <div class="font-mono text-[10px] font-bold tracking-[0.06em] text-fg-3 uppercase">Speed</div>
            <div class="mt-0.5 flex items-center gap-1">
              <button type="button" class={btn} aria-label="Slower" onClick={() => m.setPlanSpeed(stepPlanSpeed(speed(), -1))}>
                −
              </button>
              <input
                type="text"
                inputmode="decimal"
                aria-label="Planned speed, knots"
                class="w-[4.5ch] rounded-md border border-line bg-chrome-2 px-1 py-1 text-center font-mono font-semibold text-fg tabular-nums focus-ring"
                value={speed().toFixed(1)}
                onChange={(e) => {
                  const next = parsePlanSpeed(e.currentTarget.value, speed());
                  e.currentTarget.value = next.toFixed(1);
                  m.setPlanSpeed(next);
                }}
              />
              <button type="button" class={btn} aria-label="Faster" onClick={() => m.setPlanSpeed(stepPlanSpeed(speed(), 1))}>
                +
              </button>
              <span class="pl-0.5 text-fg-2">kn</span>
            </div>
          </div>
          <div class="min-w-0 flex-1">
            <div class="font-mono text-[10px] font-bold tracking-[0.06em] text-fg-3 uppercase">Departure</div>
            <div class="mt-0.5 flex items-center gap-1">
              <input
                type="datetime-local"
                aria-label="Departure time"
                class="min-w-0 flex-1 rounded-md border border-line bg-chrome-2 px-1.5 py-1 font-mono text-[12px] text-fg focus-ring"
                value={t()?.departMs != null ? toDatetimeLocal(t()!.departMs!) : ""}
                onChange={(e) => m.setDepartAt(departIso(parseDatetimeLocal(e.currentTarget.value)))}
              />
              <button
                type="button"
                class={btn}
                disabled={t()?.departMs == null}
                title="Leave now: ETAs count from the current time"
                onClick={() => m.setDepartAt(null)}
              >
                Now
              </button>
            </div>
          </div>
        </div>
      </Show>

      <Show
        when={(t()?.rows.length ?? 0) > 0}
        fallback={<p class="py-3 text-center text-fg-3">Place two points to see the legs.</p>}
      >
        <div role="list" aria-label="Legs" class="flex flex-col">
          <div
            class="grid grid-cols-[1.5rem_2.6rem_1fr_1fr_auto] gap-x-2 whitespace-nowrap border-b border-line-2 px-1.5 pb-1 font-mono text-[10px] font-bold tracking-[0.06em] text-fg-3 uppercase"
            aria-hidden="true"
          >
            <span>Leg</span>
            <span class="text-right">°T</span>
            <span class="text-right">Dist</span>
            <span class="text-right">Total</span>
            <span class="text-right">ETA</span>
          </div>
          {/* Index, not For: the rows are rebuilt on every poll/tick, and a
              keyed list would recreate each button under the finger. */}
          <Index each={t()?.rows ?? []}>
            {(rowAt) => {
              const selected = () => m.selectedLeg() === rowAt().leg;
              return (
                <button
                  type="button"
                  role="listitem"
                  aria-current={selected() ? "true" : undefined}
                  class="flex flex-col gap-0.5 border-b border-line-2 px-1.5 py-1.5 text-left transition-colors hover:bg-chrome-2 focus-ring"
                  classList={{
                    "bg-accent/15": selected(),
                    "opacity-50": rowAt().state === "done",
                    "border-l-2 border-l-accent": rowAt().state === "active",
                  }}
                  onClick={() => m.pick(rowAt().leg)}
                >
                  <span class="truncate text-[12px] text-fg-2">
                    {pointLabel(rowAt().from, rowAt().fromName)} → <span class="text-fg">{pointLabel(rowAt().to, rowAt().toName)}</span>
                  </span>
                  <span class="grid w-full grid-cols-[1.5rem_2.6rem_1fr_1fr_auto] gap-x-2 whitespace-nowrap font-mono tabular-nums">
                    <span class="font-semibold">{rowAt().leg + 1}</span>
                    <span class="text-right">{padDeg(rowAt().brgDeg)}°</span>
                    <span class="text-right">{dist(rowAt().distNm)}</span>
                    <span class="text-right text-fg-2">{dist(rowAt().cumNm)}</span>
                    <span class="truncate text-right font-semibold">{rowEta(rowAt())}</span>
                  </span>
                </button>
              );
            }}
          </Index>
        </div>
      </Show>
    </div>
  );
};

const LegTableSheet: Component<{ model: LegTableModel; follow?: LegTableFollow }> = (props) => {
  const m = props.model;
  useBackDismiss(m.open, () => m.close());
  // Rest above the mode pill (opened from the editor: Undo / Redo / Done and
  // the X stay reachable) and the MOB button (never covered). Measured on
  // open and on resize.
  const [floorInset, setFloorInset] = createSignal(0);
  createEffect(() => {
    if (!m.open() || typeof window === "undefined") return;
    const measure = () => setFloorInset(measureKeepClearInset());
    measure();
    window.addEventListener("resize", measure);
    onCleanup(() => window.removeEventListener("resize", measure));
  });
  return (
    <Show
      when={isCompact()}
      fallback={
        <DockPanel open={m.open()} onClose={() => m.close()} title="Legs" side="left">
          <LegTableBody model={m} follow={props.follow} />
        </DockPanel>
      }
    >
      <Sheet
        open={m.open()}
        onOpenChange={(open) => !open && m.close()}
        title="Legs"
        // `fill`: a fixed height, so the detents are fractions of the SCREEN,
        // not of the content (a content-sized half showed no rows at all).
        // The lower one shows the header and the first few legs.
        fill
        detents={[0.85, 1]}
        bottomInset={floorInset()}
        overdragAbove={false}
        dismissable
        z={SHEET_Z.info}
      >
        <div class="mb-2 flex items-center justify-between">
          <h2 class="font-semibold">Legs</h2>
          <button
            type="button"
            aria-label="Close"
            class="flex size-9 items-center justify-center rounded-full text-fg-2 hover:bg-chrome-2 pointer-coarse:size-11"
            onClick={() => m.close()}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <LegTableBody model={m} follow={props.follow} />
      </Sheet>
    </Show>
  );
};

export default LegTableSheet;
