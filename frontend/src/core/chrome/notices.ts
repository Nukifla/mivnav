// A notice is a momentary EVENT with no ongoing condition to poll (you
// reached a waypoint), so it can't ride the alarm band's alerts() machinery —
// this is a self-clearing, dismissible list instead, keyed by id.

import { createSignal, onCleanup, type Accessor } from "solid-js";

export interface Notice {
  /** Stable per event: pushing the same id refreshes the card and its timer. */
  id: string;
  title: string;
  detail?: string;
  /** An optional inline action — the "Undo" on a just-deleted waypoint, say.
   * The strip renders it as a button; tapping runs it AND dismisses the card
   * (the notice has done its job once acted on). */
  action?: { label: string; run: () => void };
}

export interface NoticesModel {
  list: Accessor<Notice[]>;
  push(notice: Notice): void;
  dismiss(id: string): void;
}

/**
 * A self-clearing notice list. `push` adds (or replaces, by id) a card and
 * arms a timeout; `dismiss` removes it early. `timeoutMs` of 0 disables the
 * auto-clear (tests). Owns an owner-scoped cleanup for its timers.
 */
export function createNotices(opts: { timeoutMs?: number } = {}): NoticesModel {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const [list, setList] = createSignal<Notice[]>([]);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const clearTimer = (id: string) => {
    const t = timers.get(id);
    if (t !== undefined) {
      clearTimeout(t);
      timers.delete(id);
    }
  };

  const dismiss = (id: string) => {
    clearTimer(id);
    setList((ns) => ns.filter((n) => n.id !== id));
  };

  const push = (notice: Notice) => {
    clearTimer(notice.id);
    setList((ns) => [...ns.filter((n) => n.id !== notice.id), notice]);
    if (timeoutMs > 0 && typeof setTimeout !== "undefined") {
      timers.set(
        notice.id,
        setTimeout(() => dismiss(notice.id), timeoutMs),
      );
    }
  };

  onCleanup(() => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  });

  return { list, push, dismiss };
}
