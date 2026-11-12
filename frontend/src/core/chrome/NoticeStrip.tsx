import Flag from "lucide-solid/icons/flag";
import { createEffect, createSignal, For, Show, type Component } from "solid-js";
import { prefersReducedMotion } from "../media";
import { createEnterExit } from "./useEnterExit";
import type { NoticesModel } from "./notices";

// Rendered BEFORE AlarmStrip at a lower z-index, so a live alarm paints over
// this strip on overlap (invariant #1: the reserved band wins). No ACK/rearm
// like the alarm strip — a notice has no ongoing condition, so dismiss just removes it.

const NoticeStrip: Component<{ notices: NoticesModel }> = (props) => {
  const reduce = prefersReducedMotion;
  const list = () => props.notices.list();
  // `held` is LATCHED so the leaving frame still shows the card through the fade-out.
  const ee = createEnterExit({ open: () => list().length > 0, closeProperty: "opacity" });
  const [held, setHeld] = createSignal(list());
  createEffect(() => {
    if (list().length > 0) setHeld(list());
  });
  return (
    <Show when={ee.rendered()}>
      <div
        class="pointer-events-none absolute inset-x-0 top-2 z-10 flex flex-col items-center gap-1.5 px-2"
        role="status"
        aria-live="polite"
        style={{
          opacity: ee.stage() === "open" ? 1 : 0,
          transform: `translateY(${ee.stage() === "open" ? "0" : "-6px"})`,
          transition: reduce()
            ? "none"
            : "opacity var(--duration-fast) ease-out, transform var(--duration-fast) var(--ease-sheet)",
        }}
        onTransitionEnd={ee.handleTransitionEnd}
      >
        <For each={held()}>
          {(notice) => (
            <div
              class="mivnav-slide-fade-in pointer-events-auto flex max-w-[min(560px,100%)] items-center gap-2.5 rounded-md border border-notice bg-chrome px-2.5 py-1.5 text-left"
              style={{ "box-shadow": "0 6px 22px var(--color-shadow)" }}
            >
            <Flag size={18} aria-hidden="true" class="shrink-0 text-notice" />
            <div class="min-w-0 font-mono text-fg">
              <div class="truncate text-[11px] font-bold tracking-[0.04em]">{notice.title}</div>
              <Show when={notice.detail}>
                <div class="truncate text-[10px] text-fg-2">{notice.detail}</div>
              </Show>
            </div>
            <Show when={notice.action}>
              {(action) => (
                <button
                  type="button"
                  class="ml-auto flex shrink-0 items-center justify-center rounded border border-accent px-2 py-1 font-mono text-[10px] font-bold tracking-[0.06em] text-accent hover:bg-accent/10 active:bg-accent/10 pointer-coarse:min-h-11 pointer-coarse:px-4"
                  onClick={() => {
                    action().run();
                    props.notices.dismiss(notice.id);
                  }}
                >
                  {action().label}
                </button>
              )}
            </Show>
            <button
              type="button"
              class={`${notice.action ? "" : "ml-auto "}flex shrink-0 items-center justify-center rounded border border-line px-2 py-1 font-mono text-[10px] font-bold tracking-[0.06em] text-fg-2 hover:bg-chrome-2 active:bg-chrome-2 pointer-coarse:min-h-11 pointer-coarse:px-4`}
              onClick={() => props.notices.dismiss(notice.id)}
            >
              OK
            </button>
          </div>
        )}
      </For>
      </div>
    </Show>
  );
};

export default NoticeStrip;
