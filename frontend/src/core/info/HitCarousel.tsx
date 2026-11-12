// One hit's detail, and the phone way to the others: the shared detail slide
// (HitSlide), used for the single-hit tap, the desktop detail and every phone
// carousel slide, plus the horizontal carousel that cycles hits on a phone.

import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Index,
  indexArray,
  onCleanup,
  onMount,
  Show,
  type Accessor,
  type Component,
} from "solid-js";
import ChevronRight from "lucide-solid/icons/chevron-right";
import Copy from "lucide-solid/icons/copy";
import MapPinPlus from "lucide-solid/icons/map-pin-plus";
import Navigation from "lucide-solid/icons/navigation";
import Ruler from "lucide-solid/icons/ruler";
import RouteIcon from "lucide-solid/icons/route";
import { copyText } from "../clipboard";
import { formatCoordinate } from "../coordinate";
import { createPagerDrag, createScrubSelect, useSheetDrag } from "../gesture";
import { isCompact } from "../media";
import { betaAutorouting } from "../serverConfig";
import { SectionLabel } from "../ui/Text";
import { createHitDetail, hitKey } from "./detail";
import { HitIcon } from "./HitIcon";
import { POINT_PROVIDER_ID } from "./pointProvider";
import type { InfoState } from "./state";
import type {
  InfoDetail,
  InfoHit,
  InfoAction,
  InfoNote,
  InfoNoteBody,
  InfoPoint,
  InfoProvider,
  InfoRow,
} from "./types";

/** Which side of an `InfoNote.alt` toggle is currently shown. `"primary"` is
 * `note.label`/`note.load` (TXTDSC — international, the default); `"alt"` is
 * `note.alt` (NTXTDS — national). */
type NoteLang = "primary" | "alt";

/** State behind one `NoteBlock`. Each side's `load` fires at most once no
 * matter how many times the language is toggled (two independent `wanted`
 * latches) — so a fetched body is reused. Defaults to `"primary"` (TXTDSC, #87-fork).
 * An inline note (`display: "inline"`) starts open with its primary side
 * already wanted, so it loads on mount — still exactly once. */
export function createNoteState(note: InfoNote) {
  const inline = note.display === "inline";
  const [open, setOpen] = createSignal(inline);
  const [lang, setLang] = createSignal<NoteLang>("primary");
  const [primaryWanted, setPrimaryWanted] = createSignal(inline);
  const [altWanted, setAltWanted] = createSignal(false);
  const [primaryBody] = createResource(primaryWanted, () => note.load());
  // A falsy source means createResource fetches nothing until both the
  // toggle exists and has been reached — no non-null assertion needed.
  const [altBody] = createResource(
    () => (altWanted() ? note.alt : undefined),
    (alt) => alt.load(),
  );

  const want = (l: NoteLang) => (l === "alt" ? setAltWanted(true) : setPrimaryWanted(true));

  // An inline note has no disclosure: it is always open.
  const toggleOpen = () => {
    if (inline) return;
    setOpen((o) => !o);
    want(lang());
  };
  const toggleLang = () => {
    const next: NoteLang = lang() === "primary" ? "alt" : "primary";
    setLang(next);
    if (open()) want(next);
  };

  const active = () =>
    lang() === "alt" && note.alt
      ? { label: note.alt.label, body: altBody }
      : { label: note.label, body: primaryBody };

  return { note, inline, open, toggleOpen, lang, toggleLang, active };
}

export type NoteState = ReturnType<typeof createNoteState>;

/**
 * The note states behind the notes of the detail on screen — and they belong
 * to its HIT. A note's state (its load, its body, open/language) is created
 * once per hit and reused for as long as that hit stays shown, so a live
 * re-resolve of the same hit (a fresh `InfoDetail` per tick) neither reloads
 * a note nor rebuilds its nodes. When a DIFFERENT hit is shown in the same
 * slot (the desktop panel swapping to B while A is open, the phone's
 * single-hit sheet likewise), every state is dropped and B's notes get new
 * ones that load B's bodies; coming back to A builds A's afresh.
 *
 * `detail` must only ever be the record OF `hit` (`createHitDetail`
 * guarantees that): the owner is keyed on the hit's identity while a record
 * is present, so the notes can never be paired with another hit's states.
 */
export function createHitNotes(
  hit: Accessor<InfoHit | undefined>,
  detail: Accessor<InfoDetail | undefined>,
): Accessor<NoteState[]> {
  const owner = createMemo(() => {
    const h = hit();
    return h && detail() ? hitKey(h) : undefined;
  });
  // Re-run only when the OWNER changes (a memo'd string, so a tick of the same
  // hit stops here); the re-run disposes the previous hit's states. Within
  // one owner, `indexArray` maps a note slot to a state once, like the `Index`
  // it replaces — later ticks' fresh note objects don't rebuild it.
  const mapper = createMemo(() =>
    owner() === undefined
      ? undefined
      : indexArray(
          () => detail()?.notes ?? [],
          (note) => createNoteState(note()),
        ),
  );
  // Eager, so an inline note starts loading as soon as its record is here,
  // not when something first happens to read the list.
  return createMemo(() => mapper()?.() ?? []);
}

/** What a failed `note.load()` shows. Contract: `InfoNote.load` must reject
 * with prose fit for the panel (see `fetchChartText` in ./chartProvider.ts) —
 * a non-`Error` or message-less rejection falls back to the generic line. */
export function noteError(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : "";
  return message || "Couldn’t load this note.";
}

/** A loaded `InfoNoteBody`: prose as a TEXT node (never markup), or the
 * provider's own component for a structured body. */
const NoteBody: Component<{ body: InfoNoteBody | undefined }> = (props) => (
  <Show
    when={typeof props.body === "function" ? (props.body as Component) : undefined}
    keyed
    fallback={
      <p class="whitespace-pre-wrap break-words text-xs leading-snug text-fg">
        {props.body as string | undefined}
      </p>
    }
  >
    {(Body) => <Body />}
  </Show>
);

/** One `InfoNote` (./types.ts): fetches its prose on first open; when
 * `note.alt` is present (TXTDSC/NTXTDS pair, #87-fork) adds a toggle to the
 * national-language body. An inline note drops the disclosure button and its
 * label entirely — the body (or its loading/error line) IS the block. */
const NoteBlock: Component<{ state: NoteState }> = (props) => {
  const state = props.state;
  return (
    <div class="space-y-1">
      <Show when={!state.inline}>
        <button
          type="button"
          class="-my-0.5 flex w-full items-center gap-0.5 rounded py-0.5 text-left text-[11.5px] font-semibold text-fg-2 hover:text-fg active:brightness-95 pointer-coarse:min-h-11 focus-ring"
          aria-expanded={state.open()}
          onClick={state.toggleOpen}
        >
          <ChevronRight
            size={13}
            class="shrink-0 transition-transform"
            classList={{ "rotate-90": state.open() }}
          />
          {state.note.label}
        </button>
      </Show>
      <Show when={state.open()}>
        <Show when={state.note.alt}>
          <button
            type="button"
            class="cursor-pointer rounded text-[11px] text-fg-2 underline decoration-dotted underline-offset-2 hover:text-accent focus-ring"
            onClick={state.toggleLang}
          >
            {state.lang() === "alt"
              ? (state.note.altToggle?.alt ?? "National")
              : (state.note.altToggle?.primary ?? "International")}
          </button>
        </Show>
        <Show
          when={!state.active().body.loading}
          fallback={<div class="text-xs text-fg-2">Loading…</div>}
        >
          <Show
            when={!state.active().body.error}
            fallback={
              <div class="text-xs text-alarm">{noteError(state.active().body.error)}</div>
            }
          >
            <NoteBody body={state.active().body()} />
          </Show>
        </Show>
      </Show>
    </div>
  );
};

/** How long a copy's verdict stays on the row before reverting. */
export const COPY_FEEDBACK_MS = 1600;

/** What a tap on a copy row leaves behind. */
export type CopyStatus = "idle" | "copied" | "failed";

/** The word a copy's outcome puts on the row. `undefined` while idle — the row
 * shows its value and the copy icon then, and nothing else. */
export function copyStatusLabel(status: CopyStatus): string | undefined {
  if (status === "copied") return "Copied";
  if (status === "failed") return "Copy failed";
  return undefined;
}

/** `copyText` falls back to `document.execCommand`: the boat is plain HTTP,
 * so there's no `navigator.clipboard`; failure says "Copy failed" rather than
 * silently no-op. Stable `<button>` (only the child swaps), same reason `HitDetailBody` below uses `Index`. */
const CopyableValue: Component<{ row: Accessor<InfoRow> }> = (props) => {
  const [status, setStatus] = createSignal<CopyStatus>("idle");
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  const run = async () => {
    const ok = await copyText(props.row().copy ?? props.row().value);
    setStatus(ok ? "copied" : "failed");
    clearTimeout(timer);
    timer = setTimeout(() => setStatus("idle"), COPY_FEEDBACK_MS);
  };
  return (
    <button
      type="button"
      class="inline-flex cursor-pointer items-center gap-1 rounded underline decoration-dotted underline-offset-2 hover:text-accent focus-ring"
      aria-label={`Copy ${props.row().label}`}
      title="Copy"
      onClick={() => void run()}
    >
      <span>{props.row().value}</span>
      <Show when={status() === "idle"}>
        <Copy size={11} class="shrink-0 opacity-60" />
      </Show>
      {/* Pre-exists the verdict (empty while idle): a screen reader only
          announces a change inside a region it was already watching. */}
      <span
        aria-live="polite"
        class="shrink-0 text-[10px] uppercase tracking-wide no-underline empty:hidden"
        classList={{ "text-alarm": status() === "failed", "text-fg-2": status() === "copied" }}
      >
        {copyStatusLabel(status()) ?? ""}
      </span>
    </button>
  );
};

/** `Index` not `For` (#5th-attempt-carousel-stuck): a fresh `InfoDetail` on
 * every live tick made `For`'s by-reference keys rebuild nodes mid-gesture,
 * killing a touch iOS never retargets and freezing the pager. */
const HitDetailBody: Component<{
  detail: InfoDetail | undefined;
  notes: NoteState[];
}> = (props) => (
  <>
    <Show when={props.detail} fallback={<div class="text-xs text-fg-2">Loading…</div>}>
      {(resolved) => (
        <>
          <Index each={resolved().sections}>
            {(section) => (
              <Show when={section().rows.length > 0}>
                <section class="space-y-1">
                  <Show when={section().label}>
                    <SectionLabel>{section().label}</SectionLabel>
                  </Show>
                  <dl class="space-y-0.5">
                    <Index each={section().rows}>
                      {(row) => (
                        <div
                          class="flex justify-between gap-3"
                          classList={{ "font-semibold text-alarm": row().emphasis }}
                        >
                          <dt class="shrink-0 text-fg-2">{row().label}</dt>
                          <dd class="text-right">
                            <Show when={row().copy === undefined} fallback={<CopyableValue row={row} />}>
                              <Show when={row().onClick} fallback={row().value}>
                                <button
                                  type="button"
                                  class="cursor-pointer rounded underline decoration-dotted underline-offset-2 hover:text-accent"
                                  onClick={() => row().onClick?.()}
                                >
                                  {row().value}
                                </button>
                              </Show>
                            </Show>
                          </dd>
                        </div>
                      )}
                    </Index>
                  </dl>
                </section>
              </Show>
            )}
          </Index>
          {/* `For` over states that are stable per hit (createHitNotes): a tick
              keeps every node; a different hit gets new states, new blocks. */}
          <For each={props.notes}>{(state) => <NoteBlock state={state} />}</For>
          <Show when={resolved().links?.length}>
            <div class="space-y-0.5">
              <Index each={resolved().links}>
                {(link) => (
                  <a
                    href={link().href}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="block break-all text-xs text-accent underline decoration-dotted underline-offset-2 hover:brightness-110 focus-ring"
                  >
                    {link().label}
                  </a>
                )}
              </Index>
            </div>
          </Show>
        </>
      )}
    </Show>
  </>
);

/** Two-tap "Go here" gate: `"arm"` on first tap while a route is followed (a
 * mis-tap can't discard a planned passage), `"proceed"` on confirm or when
 * nothing is followed. Same arm/confirm idiom as RouteList's delete. */
export function goHereGate(following: boolean, armed: boolean): "arm" | "proceed" {
  return following && !armed ? "arm" : "proceed";
}

/**
 * One hit shown in full: the pressed-point actions ("Go here", "Measure"),
 * then its record (HitDetailBody). Owns the resolve (createHitDetail) so a
 * carousel slide stays live on *its own* hit while neighbours sit idle.
 */
// A border, not a ring: a ring is a shadow outside the box, and the panel's
// scroll edge clips it (seen on a phone, with the footer buttons cut off).
const ACTION_BUTTON =
  "flex h-8 items-center gap-1.5 rounded border px-2.5 text-[12px] font-semibold hover:bg-line-2 active:brightness-95 pointer-coarse:h-11 focus-ring";

/** One action. Takes an accessor, not a value: `detail` re-resolves at least
 * once a second on a live vessel with new action objects, so anything keyed on
 * the object rebuilds the button mid-press. The mouse-up then lands on a new
 * element, no click fires, and the tap is lost. See `ActionButtons`. */
const ActionButton: Component<{ action: Accessor<InfoAction>; onClose: () => void }> = (props) => {
  const [asking, setAsking] = createSignal(false);
  // Drafts held here, opened from the action once: `detail` re-resolving while
  // someone types must not reset their text.
  const [draft, setDraft] = createSignal<Record<string, string> | undefined>();
  let formEl: HTMLFormElement | undefined;
  const open = () => {
    const form = props.action().form;
    if (form) {
      setDraft(Object.fromEntries(form.fields.map((f) => [f.key, f.value])));
      // Opened to type into: the first text field takes the cursor, its
      // text selected so a default name ("Mark 3") is typed over. Next tick:
      // from `onMount` the write is batched and the form isn't rendered yet.
      queueMicrotask(() => {
        const first = formEl?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
        first?.focus();
        first?.select();
      });
    } else if (props.action().confirm) setAsking(true);
    else perform();
  };
  onMount(() => {
    if (props.action().form?.autoOpen?.()) open();
  });
  const perform = () => {
    setAsking(false);
    const action = props.action();
    action.run();
    if (!action.keepOpen) props.onClose();
  };
  const fieldClass =
    "w-full rounded-md border border-line bg-chrome-2 px-2.5 py-1.5 text-xs text-fg placeholder:text-fg-3 focus-ring";
  return (
    <Show
      when={!draft()}
      fallback={
        <form
          ref={formEl}
          class="flex w-full flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const values = draft();
            setDraft(undefined);
            if (values) props.action().form?.submit(values);
          }}
        >
          <Index each={props.action().form?.fields}>
            {(field) => {
              const common = () => ({
                class: fieldClass,
                "aria-label": field().label,
                placeholder: field().label,
                maxLength: field().maxLength,
                value: draft()?.[field().key] ?? "",
                onInput: (e: { currentTarget: { value: string } }) => {
                  const value = e.currentTarget.value;
                  setDraft((d) => ({ ...d, [field().key]: value }));
                },
              });
              const options = field().options;
              if (options) {
                return (
                  <select
                    class={fieldClass}
                    aria-label={field().label}
                    value={draft()?.[field().key] ?? ""}
                    onChange={(e) => {
                      const value = e.currentTarget.value;
                      setDraft((d) => ({ ...d, [field().key]: value }));
                    }}
                  >
                    <Index each={options}>
                      {(o) => (
                        <option value={o().value} selected={o().value === draft()?.[field().key]}>
                          {o().label}
                        </option>
                      )}
                    </Index>
                  </select>
                );
              }
              return field().multiline ? (
                <textarea {...common()} rows={3} />
              ) : (
                <input {...common()} />
              );
            }}
          </Index>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class={`${ACTION_BUTTON} border-line text-fg-2`}
              onClick={() => setDraft(undefined)}
            >
              Cancel
            </button>
            <button type="submit" class={`${ACTION_BUTTON} border-accent/40 text-accent`}>
              {props.action().form?.submitLabel ?? "Save"}
            </button>
          </div>
        </form>
      }
    >
    <Show
      when={asking() && props.action().confirm}
      fallback={
        <button
          type="button"
          class={`${ACTION_BUTTON} border-accent/40 text-accent`}
          onClick={open}
        >
          <Show when={props.action().icon}>
            {(icon) => {
              const Icon = icon();
              return <Icon class="size-3.5 shrink-0" />;
            }}
          </Show>
          {props.action().label}
        </button>
      }
    >
      {(confirm) => (
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-[12px] font-semibold text-fg">{confirm().question}</span>
          <button type="button" class={`${ACTION_BUTTON} border-alarm/40 text-alarm`} onClick={perform}>
            {confirm().label}
          </button>
          <button
            type="button"
            class={`${ACTION_BUTTON} border-line text-fg-2`}
            onClick={() => setAsking(false)}
          >
            Cancel
          </button>
        </div>
      )}
    </Show>
    </Show>
  );
};

/** A detail's action buttons. `Index`, not `For`: see `ActionButton`. */
const ActionButtons: Component<{
  actions: readonly InfoAction[] | undefined;
  onClose: () => void;
}> = (props) => (
  <Show when={props.actions?.length}>
    <div class="flex flex-wrap gap-2 pb-1">
      <Index each={props.actions}>
        {(action) => <ActionButton action={action} onClose={props.onClose} />}
      </Index>
    </div>
  </Show>
);

export const HitSlide: Component<{
  providers: readonly InfoProvider[];
  hit: Accessor<InfoHit | undefined>;
  goHere?: (to: InfoPoint, label?: string) => void;
  canGoHere?: Accessor<boolean>;
  /** Is a route currently being FOLLOWED? When so, "Go here" arms before it
   * replaces that passage (a two-tap confirm); absent → assume not following. */
  isFollowing?: Accessor<boolean>;
  measureFrom?: (from: InfoPoint) => void;
  /** Drop a new mark here; the new mark opens its own panel. */
  addMark?: (at: InfoPoint) => void;
  /** Start the manual route editor with this (open-water) point as point 1. */
  newRouteFrom?: (at: InfoPoint) => void;
  onClose: () => void;
}> = (props) => {
  // Resolved for this hit and kept current for as long as its source says it
  // has changed — an open panel is a claim about *now*. See ./detail.ts.
  const detail = createHitDetail(props.providers, props.hit);
  const notes = createHitNotes(props.hit, detail);

  const target = (): InfoPoint | undefined => props.hit()?.lngLat;
  const label = () => detail()?.title ?? props.hit()?.title;
  const canGo = () => (props.canGoHere ? props.canGoHere() : true);
  const following = () => (props.isFollowing ? props.isFollowing() : false);
  // With "Beta autorouting" off, App wires the STRAIGHT-line Go to (no
  // router, no hazard check) — the button says which one it is.
  const goTitle = () =>
    betaAutorouting() ? "Go here" : "Go to — straight line from the boat, not checked for hazards";
  const [armed, setArmed] = createSignal(false);
  const goHere = () => {
    const to = target();
    if (!to || !props.goHere || !canGo()) return;
    if (goHereGate(following(), armed()) === "arm") {
      setArmed(true);
      return;
    }
    setArmed(false);
    props.goHere(to, label());
    props.onClose();
  };
  // No fix needed — measure doesn't touch the boat — so unlike "Go here" it's
  // never disabled where it appears.
  const measure = () => {
    const to = target();
    if (!to || !props.measureFrom) return;
    props.measureFrom(to);
    props.onClose();
  };
  // Not on a mark's own panel — there's already one there. No onClose: the
  // new mark replaces this panel with its own (`Marks.dropAt`).
  const canAddMark = () => !!props.addMark && props.hit()?.providerId !== "marks";
  const addMark = () => {
    const at = target();
    if (!at || !props.addMark) return;
    props.addMark(at);
  };
  // Open water only: anything else has a subject of its own to act on.
  const canNewRoute = () => !!props.newRouteFrom && props.hit()?.providerId === POINT_PROVIDER_ID;
  const newRoute = () => {
    const at = target();
    if (!at || !props.newRouteFrom) return;
    props.newRouteFrom(at);
    props.onClose();
  };

  return (
    <div class="space-y-3">
      {/* On a phone the sheet has no per-slide title bar and the carousel shows
          a different hit per slide, so each slide names its own subject. */}
      <Show when={detail()?.title ?? props.hit()?.title}>
        {(t) => (
          <div class="flex items-center gap-2.5">
            <Show when={props.hit()}>
              {(hit) => (
                <HitIcon
                  hit={hit()}
                  providers={props.providers}
                  class={isCompact() ? "size-[34px] shrink-0" : "size-[26px] shrink-0"}
                />
              )}
            </Show>
            <div class="min-w-0">
              <h3 class="text-sm font-semibold leading-tight text-fg">{t()}</h3>
              <Show when={detail()?.subtitle ?? props.hit()?.subtitle}>
                {(s) => <div class="text-xs leading-snug text-fg-2">{s()}</div>}
              </Show>
            </div>
          </div>
        )}
      </Show>
      {/* The subject's own actions (e.g. the route's "Edit route"), carried on
          the detail — each hands the chart back, closing the panel after. */}
      <ActionButtons actions={detail()?.actions} onClose={props.onClose} />
      {/* Hidden when the subject has no point to aim at (a live vessel has no
          coordinate to name); each button appears only when its handler is wired. */}
      <Show when={target()}>
        {(pt) => (
          <div class="space-y-1">
            <div class="flex items-center justify-between gap-2">
              <div class="font-mono text-[11px] leading-tight text-fg-2">
                {formatCoordinate(pt().lat, pt().lng)}
              </div>
              <div class="flex shrink-0 items-center gap-1">
                <Show when={props.goHere}>
                  {/* Armed: swaps for an explicit Keep / Replace route? pair so a
                      stray tap can't silently discard the passage being sailed. */}
                  <Show
                    when={armed()}
                    fallback={
                      <button
                        type="button"
                        aria-label={betaAutorouting() ? "Go here" : "Go to"}
                        title={goTitle()}
                        disabled={!canGo()}
                        class="flex size-7 items-center justify-center rounded text-accent hover:bg-line-2 active:bg-line-2 active:brightness-95 disabled:opacity-50 pointer-coarse:size-11 focus-ring"
                        onClick={goHere}
                      >
                        <Navigation size={15} />
                      </button>
                    }
                  >
                    <button
                      type="button"
                      class="flex h-7 items-center rounded px-2 text-[11px] text-fg-2 hover:bg-line-2 hover:text-fg active:brightness-95 pointer-coarse:h-11 focus-ring"
                      onClick={() => setArmed(false)}
                    >
                      Keep
                    </button>
                    <button
                      type="button"
                      class="flex h-7 items-center gap-1 rounded px-2 text-[11px] font-semibold text-accent ring-1 ring-accent/40 hover:bg-line-2 active:brightness-95 pointer-coarse:h-11 focus-ring"
                      onClick={goHere}
                    >
                      <Navigation size={13} />
                      Replace route?
                    </button>
                  </Show>
                </Show>
                <Show when={canAddMark() && !armed()}>
                  <button
                    type="button"
                    aria-label="Add mark"
                    title="Add a mark here"
                    class="flex size-7 items-center justify-center rounded text-fg-2 hover:bg-line-2 hover:text-accent active:bg-line-2 active:text-accent pointer-coarse:size-11 focus-ring"
                    onClick={addMark}
                  >
                    <MapPinPlus size={15} />
                  </button>
                </Show>
                <Show when={canNewRoute() && !armed()}>
                  <button
                    type="button"
                    aria-label="New route from here"
                    title="New route from here"
                    class="flex size-7 items-center justify-center rounded text-fg-2 hover:bg-line-2 hover:text-accent active:bg-line-2 active:text-accent pointer-coarse:size-11 focus-ring"
                    onClick={newRoute}
                  >
                    <RouteIcon size={15} />
                  </button>
                </Show>
                <Show when={props.measureFrom && !armed()}>
                  <button
                    type="button"
                    aria-label="Measure"
                    title="Measure from here"
                    class="flex size-7 items-center justify-center rounded text-fg-2 hover:bg-line-2 hover:text-accent active:bg-line-2 active:text-accent pointer-coarse:size-11 focus-ring"
                    onClick={measure}
                  >
                    <Ruler size={15} />
                  </button>
                </Show>
              </div>
            </div>
            <Show when={props.goHere && !canGo()}>
              <p class="text-[10px] leading-snug text-fg-2">
                No position fix — can’t route from the boat.
              </p>
            </Show>
            <Show when={armed()}>
              <p class="text-[10px] leading-snug text-fg-2">
                Replaces the route you’re following — tap “Replace route?” to confirm.
              </p>
            </Show>
          </div>
        )}
      </Show>
      <HitDetailBody detail={detail()} notes={notes()} />
      <ActionButtons actions={detail()?.footerActions} onClose={props.onClose} />
    </div>
  );
};

/** The carousel position readout: per-hit icons in a row, current one lit,
 * rest dimmed. Tap jumps; a drag scrubs live ({@link createScrubSelect}). The
 * strip scrolls rather than squashing icons; the selected one stays in view. */
const CarouselIndicator: Component<{
  state: InfoState;
  providers: readonly InfoProvider[];
}> = (props) => {
  const count = () => props.state.hits().length;
  let rowEl: HTMLElement | undefined;

  const scrub = createScrubSelect({
    count,
    onSelect: (i) => props.state.select(i),
  });

  // `inline: "nearest"` is a no-op while the icon is fully shown, so a
  // mid-strip select never jerks the row; only an edge one nudges it.
  createEffect(() => {
    const i = props.state.index();
    rowEl
      ?.querySelector<HTMLElement>(`[data-scrub-item="${i}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });

  return (
    <div class="flex items-center justify-center gap-2 pb-2">
      <div
        ref={(el) => {
          rowEl = el;
          scrub.bindRow(el);
        }}
        // touch-none: the scrub owns every touch on the strip, so the browser
        // must start no competing pan.
        class="flex min-w-0 items-center gap-0.5 overflow-x-auto touch-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <For each={props.state.hits()}>
          {(hit, i) => {
            const selected = () => i() === props.state.index();
            return (
              <button
                type="button"
                data-scrub-item={i()}
                aria-label={`Show ${i() + 1} of ${count()}`}
                aria-current={selected() ? "true" : undefined}
                class="flex shrink-0 items-center justify-center rounded p-0.5 transition-opacity focus-ring"
                classList={{ "opacity-40 active:opacity-70": !selected() }}
                onClick={() => props.state.select(i())}
              >
                <HitIcon
                  hit={hit}
                  providers={props.providers}
                  class={`shrink-0 transition-[width,height] ${selected() ? "size-7" : "size-5"}`}
                  chipClass={`shrink-0 transition-[width,height,font-size] ${selected() ? "size-7 text-[15px]" : "size-5 text-[11px]"}`}
                />
              </button>
            );
          }}
        </For>
      </div>
    </div>
  );
};

/**
 * The phone way to the other hits: a horizontal pager driven by a single
 * hand-rolled recogniser owning BOTH axes ({@link createPagerDrag}). See
 * docs/architecture/pager-drag.md for why it must own `touch-action: none`.
 */
export const HitCarousel: Component<{
  state: InfoState;
  providers: readonly InfoProvider[];
  goHere?: (to: InfoPoint, label?: string) => void;
  canGoHere?: Accessor<boolean>;
  isFollowing?: Accessor<boolean>;
  measureFrom?: (from: InfoPoint) => void;
  addMark?: (at: InfoPoint) => void;
  newRouteFrom?: (at: InfoPoint) => void;
}> = (props) => {
  const sheet = useSheetDrag();
  const [pitch, setPitch] = createSignal(0);
  let viewportEl: HTMLDivElement | undefined;
  let trackEl: HTMLDivElement | undefined;

  // Slide PITCH = gap between adjacent slide starts, measured off two
  // rendered slides; a lone slide falls back to the viewport width.
  const measure = (): void => {
    const kids = trackEl?.children;
    if (kids && kids.length >= 2) {
      setPitch((kids[1] as HTMLElement).offsetLeft - (kids[0] as HTMLElement).offsetLeft);
    } else if (viewportEl) {
      setPitch(viewportEl.clientWidth);
    }
  };

  const pager = createPagerDrag({
    index: props.state.index,
    count: () => props.state.hits().length,
    pitch,
    onSelect: (i) => props.state.select(i),
    // Non-null on this phone-only path; the ref guard below skips binding if
    // ever mounted outside a sheet.
    sheet: sheet!,
  });

  onMount(measure);
  const observe = (el: HTMLElement): void => {
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  };

  return (
    <div>
      <CarouselIndicator state={props.state} providers={props.providers} />
      <div
        ref={(el) => {
          viewportEl = el;
          if (sheet) pager.bindViewport(el);
          observe(el);
        }}
        class="touch-none overflow-hidden"
      >
        {/* Gutter is the flex `gap`, off-screen between settled slides, shown
            only mid-swipe. Transition off while the finger drives it 1:1. */}
        <div
          ref={(el) => (trackEl = el)}
          class="flex gap-4 will-change-transform"
          style={{
            transform: `translateX(${pager.offset()}px)`,
            transition: pager.animate()
              ? "transform var(--duration-fast) var(--ease-sheet)"
              : "none",
          }}
        >
          <For each={props.state.hits()}>
            {(listed) => (
              <div class="w-full min-w-0 shrink-0">
                <HitSlide
                  providers={props.providers}
                  hit={() => listed}
                  goHere={props.goHere}
                  canGoHere={props.canGoHere}
                  isFollowing={props.isFollowing}
                  measureFrom={props.measureFrom}
                  addMark={props.addMark}
                  newRouteFrom={props.newRouteFrom}
                  onClose={() => props.state.close()}
                />
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
};
