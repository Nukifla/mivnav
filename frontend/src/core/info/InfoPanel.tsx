// The info-at-point surface: the TOP-ranked hit's detail (./rank.ts), never a
// bare list, with the rest reachable beside it (desktop: ranked list below;
// phone: swipe carousel). Reuses ../Panel.tsx, not a MapLibre popup — see
// docs/architecture/info-panel.md for the full layout/placement rationale.

import { For, Show, type Accessor, type Component, type JSX } from "solid-js";
import X from "lucide-solid/icons/x";
import { isCompact } from "../media";
import Sheet, { SHEET_Z } from "../chrome/Sheet";
import { SectionLabel } from "../ui/Text";
import { createHitDetail } from "./detail";
import { HitCarousel, HitSlide } from "./HitCarousel";
import { HitIcon } from "./HitIcon";
// The phone sheet's PEEK detent. InfoMarker measures the real box instead;
// only a fit-BEFORE-open caller predicts with it (./surface.ts).
import { INFO_SHEET_PEEK } from "./surface";
import type { InfoState } from "./state";
import type { InfoHit, InfoPoint, InfoProvider } from "./types";

interface InfoPanelProps {
  state: InfoState;
  providers: readonly InfoProvider[];
  /** "Go here": route the boat to a point and follow it. Absent → no button. */
  goHere?: (to: InfoPoint, label?: string) => void;
  /** Is there a fix to route FROM? Absent → assume yes. */
  canGoHere?: Accessor<boolean>;
  /** Is a route currently being FOLLOWED? When so, "Go here" confirms (two-tap)
   * before it replaces that passage. Absent → assume not following. */
  isFollowing?: Accessor<boolean>;
  /** "Measure": enter the measure tool anchored at this point. Absent → no
   * button. Needs no fix — it measures point→point, not from the boat. */
  measureFrom?: (from: InfoPoint) => void;
  /** "Add mark": drop a new mark at this point. Absent → no button. */
  addMark?: (at: InfoPoint) => void;
  /** "New route from here" (open water): start the manual route editor
   * with this point as point 1. Absent → no button. */
  newRouteFrom?: (at: InfoPoint) => void;
}

/**
 * Desktop placement: bottom-left, above the map's corner controls. See
 * docs/architecture/info-panel.md. `!p-0` overrides Panel's card padding so
 * the header border and list-row dividers bleed to the frame. `left-3.5` and
 * `w-[258px]` are restated in ./surface.ts (`INFO_CARD_*`) — test-pinned.
 */
export const DESKTOP_CLASS =
  "left-3.5 bottom-[84px] w-[258px] !p-0 overflow-hidden border border-line bg-chrome";

/** Desktop body padding — the detail and list-header carry their own inset so
 * the row dividers below can still bleed to the card frame. */
const DESKTOP_PAD = "px-[11px]";

/** The `.rank` badge: a threat says so, everything else shows its place in the
 * ranking. */
function rankLabel(hit: InfoHit, i: number, n: number): string {
  return hit.priority === "danger" ? "DANGER" : `${i + 1} of ${n}`;
}

/**
 * Most hits carry a synchronous `subtitle` and show it straight away. The
 * weather wind hit has none — its glance needs an async resolve — so a
 * subtitle-less hit resolves its detail lazily instead of showing blank.
 */
const ListRowSubtitle: Component<{ hit: InfoHit; providers: readonly InfoProvider[] }> = (props) => {
  const detail = props.hit.subtitle ? undefined : createHitDetail(props.providers, () => props.hit);
  const subtitle = () => props.hit.subtitle ?? detail?.()?.subtitle;
  return (
    <Show when={subtitle()}>
      {(s) => <div class="font-mono text-[10px] leading-snug text-fg-2">{s()}</div>}
    </Show>
  );
};

/** The desktop way to the other hits: a compact ranked list under the
 * detail. Dividers bleed to the card frame, so it reads as one body. */
const HitList: Component<{ state: InfoState; providers: readonly InfoProvider[] }> = (props) => {
  const hits = () => props.state.hits();
  return (
    <div class="border-t border-line-2">
      <div class={`pb-1 pt-2 ${DESKTOP_PAD}`}>
        <SectionLabel>All {hits().length}</SectionLabel>
      </div>
      <For each={hits()}>
        {(listed, i) => (
          <button
            type="button"
            aria-current={i() === props.state.index() ? "true" : undefined}
            class={`flex w-full items-start gap-[7px] border-b border-line-2 py-[6px] text-left last:border-b-0 hover:bg-chrome-2 active:bg-chrome-2 active:brightness-95 pointer-coarse:min-h-11 focus-ring ${DESKTOP_PAD}`}
            classList={{ "bg-chrome-2": i() === props.state.index() }}
            onClick={() => props.state.select(i())}
          >
            <HitIcon hit={listed} providers={props.providers} class="mt-px size-[15px] shrink-0" />
            <div class="min-w-0 flex-1">
              <div class="text-[11.5px] font-medium leading-tight">{listed.title}</div>
              <ListRowSubtitle hit={listed} providers={props.providers} />
            </div>
            <div class="ml-auto shrink-0 pt-0.5 font-mono text-[7.5px] tracking-wider text-fg-3">
              {rankLabel(listed, i(), hits().length)}
            </div>
          </button>
        )}
      </For>
    </div>
  );
};

const InfoPanel: Component<InfoPanelProps> = (props) => {
  const current = () => props.state.current();
  const multi = () => props.state.hits().length > 1;

  // Header title only — the body's own resolve lives in HitSlide. Refines an
  // MMSI-titled AIS hit to the vessel's name once its record lands.
  const currentDetail = createHitDetail(props.providers, current);
  const title = () => currentDetail()?.title ?? current()?.title ?? "Info";

  // The single detail every surface shares; desktop/phone differ only in the
  // CONTAINER around it.
  const detail = (): JSX.Element => (
    <HitSlide
      providers={props.providers}
      hit={current}
      goHere={props.goHere}
      canGoHere={props.canGoHere}
      isFollowing={props.isFollowing}
      measureFrom={props.measureFrom}
      addMark={props.addMark}
      newRouteFrom={props.newRouteFrom}
      onClose={() => props.state.close()}
    />
  );

  return (
    // Fork D5: phone info sheet is NON-MODAL (chart stays interactive
    // underneath). See docs/architecture/info-panel.md.
    <Sheet
      open={props.state.open()}
      onOpenChange={(open) => !open && props.state.close()}
      title={title()}
      detents={[INFO_SHEET_PEEK, 1]}
      // `dismissable` defaults to `modal`; a non-modal sheet needs it explicit
      // or a drag-down can't close it.
      dismissable
      // Above co-existing mode sheets, below modal read drawers — see SHEET_Z.
      z={SHEET_Z.info}
      desktop={{ kind: "floating-card", class: DESKTOP_CLASS }}
    >
      {/* Desktop only — phone sheet supplies its own title bar (Panel.tsx).
          Close-only: the subject (icon+title+subtitle) lives in the shared
          HitSlide block below, not doubled here. */}
      <Show when={!isCompact()}>
        <header class="flex items-center justify-end border-b border-line-2 bg-chrome-2 py-[5px] pl-[9px] pr-[5px]">
          <button
            type="button"
            aria-label="Close"
            title="Close"
            class="flex size-5 items-center justify-center rounded text-fg-2 hover:bg-line-2 hover:text-fg active:bg-line-2 active:brightness-95 pointer-coarse:size-11 focus-ring"
            onClick={() => props.state.close()}
          >
            <X size={15} />
          </button>
        </header>
      </Show>

      <Show
        when={isCompact()}
        fallback={
          // Desktop stack sizing (viewport cap, list vs detail share) — see
          // docs/architecture/info-panel.md.
          <div class="flex max-h-[calc(100dvh-104px)] flex-col overflow-hidden">
            <div
              class={`overflow-y-auto py-2.5 ${DESKTOP_PAD}`}
              classList={{ "max-h-[67dvh]": multi() }}
            >
              {detail()}
            </div>
            <Show when={multi()}>
              <div class="min-h-0 max-h-[33dvh] shrink-0 overflow-y-auto">
                <HitList state={props.state} providers={props.providers} />
              </div>
            </Show>
          </div>
        }
      >
        <Show when={multi()} fallback={detail()}>
          <HitCarousel
            state={props.state}
            providers={props.providers}
            goHere={props.goHere}
            canGoHere={props.canGoHere}
            isFollowing={props.isFollowing}
            measureFrom={props.measureFrom}
            addMark={props.addMark}
            newRouteFrom={props.newRouteFrom}
          />
        </Show>
      </Show>
    </Sheet>
  );
};

export default InfoPanel;
