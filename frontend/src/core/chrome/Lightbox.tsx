// A fullscreen photo viewer: one image at a time, big, on a dark scrim.
// Swipe (touch or mouse drag), arrow keys or the on-screen chevrons page
// through the set; the close button, Escape, the hardware/gesture Back
// (./backStack.ts) or a tap on the backdrop closes it. Provider-agnostic —
// handed plain URLs, it knows nothing about where they came from (first user:
// a POI place's photos in a plugin's detail body).
//
// Portalled to <body> above every surface (SHEET_Z.lightbox), so it clears the
// info sheet/card it is usually opened from and the modal drawers alike. The
// boat is often OFFLINE: a photo that fails to load shows a quiet placeholder,
// never the browser's broken-image glyph. The pure rules (wrap, swipe
// threshold, keys) live in ./lightboxNav.ts.

import {
  createSignal,
  onCleanup,
  onMount,
  Show,
  type Component,
} from "solid-js";
import { Portal } from "solid-js/web";
import ChevronLeft from "lucide-solid/icons/chevron-left";
import ChevronRight from "lucide-solid/icons/chevron-right";
import ImageOff from "lucide-solid/icons/image-off";
import X from "lucide-solid/icons/x";
import { prefersReducedMotion } from "../media";
import { useBackDismiss } from "./backStack";
import { SHEET_Z } from "./Sheet";
import {
  clampIndex,
  isDrag,
  lightboxKey,
  positionLabel,
  swipeStep,
  wrapIndex,
} from "./lightboxNav";

export interface LightboxImage {
  url: string;
  /** Shown under the photo and as its alt text. */
  caption?: string | null;
}

export interface LightboxProps {
  images: readonly LightboxImage[];
  /** The photo shown; `undefined` = closed. Owned by the caller so it can open
   * the viewer on the thumbnail that was tapped. */
  index: number | undefined;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}

/** 44px round control on the scrim — a finger target on the boat's tablet,
 * and still tidy under a mouse. */
const ROUND =
  "flex size-11 items-center justify-center rounded-full bg-black/45 text-on-scrim hover:bg-black/65 active:brightness-90 focus-ring";

export const Lightbox: Component<LightboxProps> = (props) => (
  <Show when={props.index !== undefined && props.images.length > 0}>
    <Portal>
      <LightboxView {...props} index={props.index ?? 0} />
    </Portal>
  </Show>
);

/** Mounted only while open, so its Back-stack entry, key listener and focus
 * grab live exactly as long as the viewer does. */
const LightboxView: Component<LightboxProps & { index: number }> = (props) => {
  const count = () => props.images.length;
  const current = () => clampIndex(props.index, count());
  const image = () => props.images[current()];
  const go = (step: number) => {
    if (count() > 1) props.onIndexChange(wrapIndex(current() + step, count()));
  };

  // Back peels THIS layer first — it registered after the panel under it.
  useBackDismiss(() => true, () => props.onClose());

  // Offline, a photo 404s/times out: remember which, show the placeholder.
  const [failed, setFailed] = createSignal<ReadonlySet<string>>(new Set());
  const markFailed = (url: string) => setFailed((s) => new Set(s).add(url));

  // Capture phase on window: runs before the app's command keys, the map's
  // arrow-pan and the info panel's own Escape — none of them may also act.
  let closeBtn: HTMLButtonElement | undefined;
  onMount(() => {
    const before = document.activeElement as HTMLElement | null;
    closeBtn?.focus();
    const onKey = (e: KeyboardEvent) => {
      const action = lightboxKey(e.key);
      if (action === undefined) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (action === "close") props.onClose();
      else go(action);
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey, true);
      before?.focus?.();
    });
  });

  // One pointer at a time; the stage follows the finger horizontally and
  // pages (or springs back) on release.
  let stageEl: HTMLDivElement | undefined;
  let start: { id: number; x: number; y: number } | undefined;
  let dragged = false;
  const [offset, setOffset] = createSignal(0);
  const [tracking, setTracking] = createSignal(false);

  const onPointerDown = (e: PointerEvent) => {
    if (start || (e.pointerType === "mouse" && e.button !== 0)) return;
    start = { id: e.pointerId, x: e.clientX, y: e.clientY };
    dragged = false;
    setTracking(true);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (isDrag(dx, dy)) dragged = true;
    if (Math.abs(dx) > Math.abs(dy) && count() > 1) setOffset(dx);
  };
  const onPointerUp = (e: PointerEvent) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    start = undefined;
    setTracking(false);
    setOffset(0);
    const step = swipeStep(dx, dy, stageEl?.clientWidth ?? 0);
    if (step !== 0) go(step);
  };
  const onPointerCancel = () => {
    start = undefined;
    setTracking(false);
    setOffset(0);
  };

  // A tap on the scrim closes; a tap on the photo or a control doesn't, and
  // the click that ENDS a swipe is never a tap (it may land on the scrim).
  const onClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (dragged) {
      dragged = false;
      return;
    }
    if ((e.target as Element).hasAttribute?.("data-lightbox-backdrop")) {
      props.onClose();
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Photo viewer"
      data-lightbox-backdrop
      class="fixed inset-0 flex touch-none select-none flex-col bg-black/90 text-on-scrim"
      style={{ "z-index": SHEET_Z.lightbox }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onClick={onClick}
    >
      <div
        data-lightbox-backdrop
        class="flex shrink-0 items-center justify-between gap-2 pt-[max(0.5rem,env(safe-area-inset-top))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(0.5rem,env(safe-area-inset-right))]"
      >
        <span class="font-mono text-xs tabular-nums opacity-80" aria-live="polite">
          <Show when={count() > 1}>{positionLabel(current(), count())}</Show>
        </span>
        <button
          ref={(el) => (closeBtn = el)}
          type="button"
          aria-label="Close photo"
          title="Close"
          class={ROUND}
          onClick={() => props.onClose()}
        >
          <X size={20} />
        </button>
      </div>

      <div
        ref={(el) => (stageEl = el)}
        data-lightbox-backdrop
        class="relative flex min-h-0 flex-1 items-center justify-center px-[max(0.5rem,env(safe-area-inset-left))] py-2"
      >
        <div
          class="flex size-full items-center justify-center"
          data-lightbox-backdrop
          style={{
            transform: `translateX(${offset()}px)`,
            transition:
              tracking() || prefersReducedMotion()
                ? "none"
                : "transform var(--duration-fast) var(--ease-sheet)",
          }}
        >
          <Show when={image()} keyed>
            {(img) => (
              <Show
                when={!failed().has(img.url)}
                fallback={
                  <div class="flex flex-col items-center gap-2 text-xs opacity-60">
                    <ImageOff size={32} />
                    <span>Photo not available offline</span>
                  </div>
                }
              >
                <img
                  src={img.url}
                  alt={img.caption ?? ""}
                  draggable={false}
                  referrerpolicy="no-referrer"
                  class="max-h-full max-w-full object-contain"
                  onError={() => markFailed(img.url)}
                />
              </Show>
            )}
          </Show>
        </div>

        <Show when={count() > 1}>
          <button
            type="button"
            aria-label="Previous photo"
            class={`absolute left-[max(0.5rem,env(safe-area-inset-left))] top-1/2 -translate-y-1/2 ${ROUND}`}
            onClick={() => go(-1)}
          >
            <ChevronLeft size={24} />
          </button>
          <button
            type="button"
            aria-label="Next photo"
            class={`absolute right-[max(0.5rem,env(safe-area-inset-right))] top-1/2 -translate-y-1/2 ${ROUND}`}
            onClick={() => go(1)}
          >
            <ChevronRight size={24} />
          </button>
        </Show>
      </div>

      <div
        data-lightbox-backdrop
        class="min-h-4 shrink-0 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] text-center text-xs leading-snug opacity-80"
      >
        {image()?.caption ?? ""}
      </div>
    </div>
  );
};
