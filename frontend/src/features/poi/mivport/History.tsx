// A mivport place's revisions, newest first — online only (the boat keeps
// no history). After the poi-testclient's history view, without the
// moderators' revert.

import { createResource, For, Show, type Component } from "solid-js";
import { formatDate } from "./detail";
import type { MivportApi } from "./client";
import type { MivportRevision } from "./types";

/** One revision's byline: "anna · 1 Jul 2026 · mivnav · “typo”". */
export function revisionMeta(r: MivportRevision): string {
  const parts = [r.changeset?.user, formatDate(r.made_at), r.changeset?.client].filter(
    (x): x is string => typeof x === "string" && x.length > 0,
  );
  const comment = r.changeset?.comment?.trim();
  if (comment) parts.push(`“${comment}”`);
  return parts.join(" · ");
}

export const History: Component<{ api: MivportApi; placeId: string }> = (props) => {
  const [history] = createResource(
    () => props.placeId,
    (id) => props.api.history(id),
  );
  const revisions = () =>
    [...(history()?.revisions ?? [])].filter((r) => typeof r?.rev === "number").sort((a, b) => b.rev - a.rev);
  return (
    <div class="space-y-2 text-xs">
      <Show when={history.loading}>
        <p class="text-fg-3">Asking mivport…</p>
      </Show>
      <Show when={history.error}>
        <p class="text-alarm">
          {history.error instanceof Error && history.error.message
            ? history.error.message
            : "The history needs mivport to be reachable."}
        </p>
      </Show>
      <Show when={history() && revisions().length === 0}>
        <p class="text-fg-3">No revisions.</p>
      </Show>
      <ul class="space-y-1.5">
        <For each={revisions()}>
          {(r) => (
            <li class="space-y-0.5 rounded-md border border-line-2 bg-chrome-2 px-2 py-1.5">
              <div class="flex flex-wrap items-baseline gap-x-1.5">
                <span class="font-semibold text-fg">rev {r.rev}</span>
                <Show when={r.status === "deleted"}>
                  <span class="text-[11px] font-semibold text-alarm">deleted</span>
                </Show>
                <Show when={r.reverts_rev}>
                  <span class="text-[11px] text-fg-2">reverts to rev {r.reverts_rev}</span>
                </Show>
              </div>
              <p class="text-fg-2">changed: {(r.changed ?? []).join(", ") || "–"}</p>
              <p class="text-[11px] text-fg-3">{revisionMeta(r)}</p>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
};
