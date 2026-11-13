import X from "lucide-solid/icons/x";
import Pencil from "lucide-solid/icons/pencil";
import Trash2 from "lucide-solid/icons/trash-2";
import Navigation from "lucide-solid/icons/navigation";
import Plus from "lucide-solid/icons/plus";
import Crosshair from "lucide-solid/icons/crosshair";
import Move from "lucide-solid/icons/move";
import ListOrdered from "lucide-solid/icons/list-ordered";
import { createEffect, createSignal, Match, Show, Switch, type Accessor, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { formatRange, padDeg } from "../../core/format";
import { lerpDensity, type Density } from "../../core/chrome/registry";
import { overlayColors, routeOverlayColors, type Palette } from "../../core/style/colors";
import { CrosshairMarker } from "../../core/map/CrosshairMarker";
import { MAX_NAME_LENGTH } from "./draft";
import type { RouteDrawModel } from "./index";
import { mobClearBottom } from "../mob/MobControl";

// The manual route editor's one card, floating above the mode pill (which
// carries Undo / Redo / Done and the X that cancels) and above the MOB button
// bottom-left, which it must never cover. Compact: ONE line at
// rest — the route's size, or what is selected and its actions as icons —
// plus a second line of big "+ Here" / "Move here" buttons in crosshair
// mode. The crosshair toggle leads the line. When needed, the line is the
// discard confirm or the save-conflict choice instead.
//
// Also here: crosshair mode's fixed centre crosshair and its live readout,
// drawn over the map's centre (this component sits in the map's box).

export interface RouteDrawCardProps {
  model: RouteDrawModel;
  density: Accessor<Density>;
  pointerCoarse: Accessor<boolean>;
  palette: Accessor<Palette>;
  /** Open the leg table on the draft (features/legTable). Absent hides it. */
  onLegs?: () => void;
  /** Follow the (saved, unmodified) route from the nearest leg ahead. Absent
   * hides it. */
  onFollow?: () => void;
  /** Is the draft's route the one being followed? Then Follow is hidden. */
  isFollowed?: () => boolean;
  /** Does the server hold this route (saved at least once)? */
  isSaved?: () => boolean;
}

/** How far from the map pane's right edge a bottom card must stop to clear the
 * map-tools column (MapView's phone/desktop stacks: `right-2.5` = 10px + a
 * `size-11` coarse / `size-10` fine button) + 8px air. Keep in step with
 * MapView's MAP_CTRL_BASE, as `mobClearBottom` is with MobControl. */
export const mapToolsClearRight = (pointerCoarse: boolean): number => 10 + (pointerCoarse ? 44 : 40) + 8;

const dist = (nm: number): string => {
  const r = formatRange(nm);
  return `${r.value} ${r.unit}`;
};

type Icon = Component<{ size?: number; "aria-hidden"?: boolean | "true" }>;

/** The fixed centre crosshair and, under it, the rubber band's bearing and
 * distance (or the mark it will snap to). Never takes a touch. */
const AimCrosshair: Component<{ model: RouteDrawModel; palette: Accessor<Palette> }> = (props) => {
  const m = props.model;
  return (
    <Show when={m.active() && m.crosshair()}>
      <div class="pointer-events-none absolute top-1/2 left-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
        <CrosshairMarker
          px={40}
          r={8}
          inner={11}
          outer={19}
          color={routeOverlayColors(props.palette()).route}
          halo={overlayColors(props.palette()).markerHalo}
          haloWidth={4}
          innerWidth={2}
        />
        <Show when={m.aimLeg() || m.snapTarget()}>
          <div
            class="absolute top-full left-1/2 mt-1 -translate-x-1/2 text-center font-mono text-[11px] leading-tight font-semibold whitespace-nowrap tabular-nums text-fg"
            style={{
              "text-shadow": "0 0 3px var(--color-chrome), 0 0 6px var(--color-chrome), 0 0 9px var(--color-chrome)",
            }}
          >
            <Show when={m.aimLeg()}>{(l) => <div>{`${padDeg(l().brgDeg)}°T · ${dist(l().distNm)}`}</div>}</Show>
            <Show when={m.snapTarget()}>
              {(s) => <div class="font-sans">{`→ ${s().name.trim() || "mark"}`}</div>}
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  );
};

const RouteDrawCard: Component<RouteDrawCardProps> = (props) => {
  const m = props.model;
  // Which name is being edited inline: a point's id, the route, or nothing.
  const [renaming, setRenaming] = createSignal<{ kind: "point"; id: string } | { kind: "route" } | null>(null);
  const [text, setText] = createSignal("");

  // A selection change (or leaving) abandons an open rename.
  createEffect(() => {
    const s = m.selection();
    const r = renaming();
    if (r?.kind === "point" && (s?.kind !== "point" || s.id !== r.id)) setRenaming(null);
    if (!m.active()) setRenaming(null);
  });

  const pointIndex = () => {
    const s = m.selection();
    if (s?.kind !== "point") return -1;
    return m.draft()?.waypoints.findIndex((w) => w.id === s.id) ?? -1;
  };
  const selectedPoint = () => m.draft()?.waypoints[pointIndex()] ?? null;
  const selectedLeg = () => {
    const s = m.selection();
    return s?.kind === "leg" ? (m.plan().legs[s.leg] ?? null) : null;
  };
  const count = () => m.draft()?.waypoints.length ?? 0;
  const banner = () => m.confirmingDiscard() || m.conflict();

  const startRename = (target: { kind: "point"; id: string } | { kind: "route" }, current: string) => {
    setText(current);
    setRenaming(target);
  };
  const commitRename = () => {
    const r = renaming();
    if (r?.kind === "point") m.renamePoint(r.id, text());
    else if (r?.kind === "route") m.renameRoute(text());
    setRenaming(null);
  };
  const onRenameKey = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      commitRename();
    } else if (e.key === "Escape") {
      // Claimed: Escape here closes the field, not the editor.
      e.preventDefault();
      e.stopPropagation();
      setRenaming(null);
    }
  };

  const minTarget = () => (props.pointerCoarse() ? "44px" : undefined);
  const button =
    "flex flex-none items-center justify-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-chrome-2 px-3 py-1.5 font-semibold text-fg transition-colors enabled:hover:border-accent enabled:hover:text-accent enabled:active:brightness-90 disabled:opacity-40 focus-ring";
  const primary = "bg-accent! border-accent! text-accent-fg!";
  const danger = "border-alarm! text-alarm!";
  const iconBtn =
    "flex flex-none items-center justify-center rounded-full border-0 bg-transparent px-2 py-1.5 text-fg-2 transition-colors enabled:hover:bg-line-2 enabled:hover:text-fg disabled:opacity-40 focus-ring";

  const Btn: Component<{
    label: string;
    onClick: () => void;
    class?: string;
    disabled?: boolean;
    title?: string;
    icon?: Icon;
  }> = (b) => (
    <button
      type="button"
      class={`${button} ${b.class ?? ""}`}
      style={{ "min-height": minTarget() }}
      disabled={b.disabled}
      title={b.title}
      onClick={() => b.onClick()}
    >
      <Show when={b.icon}>{(icon) => <Dynamic component={icon()} size={14} aria-hidden="true" />}</Show>
      {b.label}
    </button>
  );

  /** An icon-only action: the label is its name for screen readers and its tooltip. */
  const IconBtn: Component<{
    label: string;
    icon: Icon;
    onClick: () => void;
    class?: string;
    disabled?: boolean;
    title?: string;
    pressed?: boolean;
  }> = (b) => (
    <button
      type="button"
      class={`${iconBtn} ${b.class ?? ""}`}
      style={{ "min-height": minTarget(), "min-width": minTarget() }}
      aria-label={b.label}
      title={b.title ?? b.label}
      aria-pressed={b.pressed}
      disabled={b.disabled}
      onClick={() => b.onClick()}
    >
      <Dynamic component={b.icon} size={16} aria-hidden="true" />
    </button>
  );

  const RenameField: Component<{ label: string }> = (f) => (
    <div class="flex min-w-0 flex-1 items-center gap-1.5">
      <input
        type="text"
        class="min-w-0 flex-1 rounded-md border border-line bg-chrome-2 px-2 py-1.5 text-fg focus-ring"
        style={{ "min-height": minTarget() }}
        aria-label={f.label}
        maxLength={MAX_NAME_LENGTH}
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={onRenameKey}
        ref={(el) => queueMicrotask(() => el.focus())}
      />
      <Btn label="OK" class={primary} onClick={commitRename} />
    </div>
  );

  // Follow: the boat follows the SAVED copy, so App saves the draft first
  // (one tap, no "Done, then Follow" dance). Not while a 409 is unresolved.
  const canFollow = () => !m.saving() && !m.conflict() && !m.draggingId();
  const followBtn = () => (
    <Show when={props.onFollow && count() >= 2 && !props.isFollowed?.()}>
      <IconBtn
        label="Follow route"
        icon={Navigation}
        class={canFollow() ? "text-accent!" : ""}
        disabled={!canFollow()}
        title={
          canFollow()
            ? m.dirty() || !props.isSaved?.()
              ? "Save and follow from the nearest leg ahead of the boat"
              : "Follow from the nearest leg ahead of the boat"
            : "Resolve the save conflict first"
        }
        onClick={() => props.onFollow?.()}
      />
    </Show>
  );
  const clearSel = () => <IconBtn label="Clear selection" icon={X} onClick={() => m.select(null)} />;
  // The leg table: speed, departure, and every leg's bearing/distance/ETA.
  const legsBtn = () => (
    <Show when={props.onLegs && count() >= 2}>
      <IconBtn label="Leg table" title="Legs, speed and departure" icon={ListOrdered} onClick={() => props.onLegs?.()} />
    </Show>
  );

  return (
    <>
      <AimCrosshair model={m} palette={props.palette} />
      <Show when={m.active()}>
        {/* Pointer-transparent lane the card centres in: above the MOB button
            (bottom-left — a safety control is never covered, and on a phone
            the card is as wide as the screen) and left of the map-tools
            column (bottom-right), which it must not touch either. */}
        <div
          class="pointer-events-none absolute left-2 z-20 flex justify-center pl-[env(safe-area-inset-left)]"
          style={{
            bottom: `${mobClearBottom(props.pointerCoarse())}px`,
            right: `${mapToolsClearRight(props.pointerCoarse())}px`,
          }}
        >
          <div
            class="pointer-events-auto flex w-max max-w-full min-w-[15rem] flex-col gap-1.5 rounded-xl border border-line bg-chrome px-1.5 py-1 text-fg"
            style={{
              "font-size": `${lerpDensity(12, 13.5, props.density())}px`,
              "box-shadow": "0 6px 22px var(--color-shadow)",
            }}
            role="region"
            aria-label="Route editor"
          >
            <Switch>
              <Match when={m.confirmingDiscard()}>
                <div class="flex flex-wrap items-center justify-end gap-1.5 pl-1.5">
                  <span class="flex-1 font-semibold whitespace-nowrap">Discard changes?</span>
                  <Btn label="Keep editing" onClick={m.keepEditing} />
                  <Btn label="Discard" class={danger} onClick={m.discard} />
                </div>
              </Match>

              <Match when={m.conflict()}>
                <div class="flex flex-wrap items-center justify-end gap-1.5 pl-1.5">
                  <span class="flex-1 font-semibold whitespace-nowrap" title="Not saved — your edits are kept.">
                    {m.conflictDeleted() ? "Deleted on another screen" : "Changed on another screen"}
                  </span>
                  <Btn label="Save as copy" disabled={m.saving()} onClick={() => void m.saveCopy()} />
                  <Btn
                    label={m.conflictDeleted() ? "Save again" : "Overwrite"}
                    class={danger}
                    disabled={m.saving()}
                    onClick={() => void m.overwrite()}
                  />
                </div>
              </Match>

              <Match when={!banner()}>
                <div class="flex items-center gap-1">
                  <IconBtn
                    label="Crosshair"
                    title={m.crosshair() ? "Crosshair on — place points at the centre" : "Place points with a centre crosshair"}
                    icon={Crosshair}
                    pressed={m.crosshair()}
                    class={m.crosshair() ? "text-accent!" : ""}
                    onClick={() => m.setCrosshair(!m.crosshair())}
                  />
                  <div class="mx-0.5 h-5 w-px flex-none bg-line" aria-hidden="true" />
                  <Switch
                    fallback={
                      <Show
                        when={renaming()?.kind === "route"}
                        fallback={
                          <>
                            <Show
                              when={count() > 0}
                              fallback={
                                <span class="min-w-0 flex-1 truncate px-1 text-fg-2">
                                  {m.crosshair() ? "Aim at the first point, then + Here" : "Tap the chart to place the first point"}
                                </span>
                              }
                            >
                              {/* Name over numbers: the name may truncate, the
                                  numbers never do (they are the point). */}
                              <span class="flex min-w-0 flex-1 flex-col px-1 leading-tight">
                                <span class="truncate font-semibold">{m.draft()?.name || "Untitled route"}</span>
                                <span class="font-mono whitespace-nowrap text-fg-2 tabular-nums">
                                  {count()} pt{count() === 1 ? "" : "s"} · {dist(m.plan().totalNm)}
                                </span>
                              </span>
                            </Show>
                            <IconBtn
                              label="Rename route"
                              icon={Pencil}
                              onClick={() => startRename({ kind: "route" }, m.draft()?.name ?? "")}
                            />
                            {legsBtn()}
                            {followBtn()}
                          </>
                        }
                      >
                        <RenameField label="Route name" />
                      </Show>
                    }
                  >
                    <Match when={selectedPoint()}>
                      {(wp) => (
                        <Show
                          when={renaming()?.kind === "point"}
                          fallback={
                            <>
                              <span class="min-w-0 flex-1 truncate px-1">
                                <span class="font-semibold">Point {pointIndex() + 1}</span>
                                <Show when={wp().name}>
                                  <span class="text-fg-2"> · {wp().name}</span>
                                </Show>
                              </span>
                              <IconBtn
                                label="Rename point"
                                icon={Pencil}
                                onClick={() => startRename({ kind: "point", id: wp().id }, wp().name)}
                              />
                              <IconBtn label="Delete point" icon={Trash2} class="text-alarm!" onClick={m.deleteSelected} />
                              <IconBtn
                                label="Go"
                                icon={Navigation}
                                disabled={!m.canGo()}
                                title={
                                  m.canGo()
                                    ? "Save and start following this route from this point"
                                    : "Not while saving"
                                }
                                onClick={() => void m.go()}
                              />
                              {legsBtn()}
                              {clearSel()}
                            </>
                          }
                        >
                          <RenameField label={`Name for point ${pointIndex() + 1}`} />
                        </Show>
                      )}
                    </Match>

                    <Match when={selectedLeg()}>
                      {(leg) => (
                        <>
                          <span class="flex min-w-0 flex-1 flex-col px-1 leading-tight">
                            <span class="truncate font-semibold">
                              Leg {leg().fromIndex + 1}→{leg().toIndex + 1}
                            </span>
                            <span class="font-mono whitespace-nowrap text-fg-2 tabular-nums">
                              {padDeg(leg().brgDeg)}°T · {dist(leg().distNm)}
                            </span>
                          </span>
                          <IconBtn label="Insert point here" icon={Plus} onClick={m.insertAtSelectedLeg} />
                          {legsBtn()}
                          {clearSel()}
                        </>
                      )}
                    </Match>
                  </Switch>
                </div>

                <Show when={m.crosshair()}>
                  <div class="flex items-center gap-1.5 pb-0.5">
                    <Btn
                      label="Here"
                      icon={Plus}
                      class={`${primary} flex-1`}
                      title="Add a point at the crosshair"
                      disabled={!m.aim()}
                      onClick={m.addHere}
                    />
                    <Show when={selectedPoint()}>
                      <Btn
                        label="Move here"
                        icon={Move}
                        class="flex-1"
                        title="Move the selected point to the crosshair"
                        disabled={!m.aim()}
                        onClick={m.moveHere}
                      />
                    </Show>
                  </div>
                </Show>
              </Match>
            </Switch>
          </div>
        </div>
      </Show>
    </>
  );
};

export default RouteDrawCard;
