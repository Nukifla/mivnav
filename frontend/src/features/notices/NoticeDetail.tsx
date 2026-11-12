// The notice's text body in ONE language — the inline `InfoNote` of the
// notices provider (./provider.ts), whose `alt` is the other language. Draws
// ./detailModel.ts's `NoticeBodyModel`: title, area breadcrumb, each part as
// a headed section with its sanitised HTML (./NoticeHtml.tsx, never
// innerHTML), publication, source, references (tappable: opens that notice,
// a cancelled one included — the backend fetches it from Niord), attachments.

import { For, Show, type Component } from "solid-js";
import FileText from "lucide-solid/icons/file-text";
import { SectionLabel } from "../../core/ui/Text";
import { word, type NoticeBodyModel } from "./detailModel";
import { NoticeHtml } from "./NoticeHtml";

export interface NoticeBodyProps {
  model: NoticeBodyModel;
  /** Open another notice (a reference) in the panel. */
  onOpenNotice: (id: string) => void;
}

export const NoticeBody: Component<NoticeBodyProps> = (props) => {
  const m = props.model;
  return (
    <div class="space-y-2 text-xs leading-snug text-fg" lang={m.lang}>
      <Show when={m.title}>
        <p class="font-semibold">{m.title}</p>
      </Show>
      <Show when={m.area}>
        <p class="text-[11px] text-fg-3">{m.area}</p>
      </Show>
      <For each={m.parts}>
        {(part) => (
          <section class="space-y-0.5">
            <SectionLabel>{part.heading}</SectionLabel>
            <Show when={part.subject}>
              <p class="font-semibold">{part.subject}</p>
            </Show>
            <NoticeHtml html={part.html} />
          </section>
        )}
      </For>
      <Show when={m.publication}>
        <section class="space-y-0.5">
          <SectionLabel>{word("publication", m.lang)}</SectionLabel>
          <NoticeHtml html={m.publication} />
        </section>
      </Show>
      <Show when={m.source}>
        <p class="text-[11px] text-fg-2">
          {word("source", m.lang)}: {m.source}
        </p>
      </Show>
      <Show when={m.references.length > 0}>
        <section class="space-y-0.5">
          <SectionLabel>{word("references", m.lang)}</SectionLabel>
          <ul class="space-y-0.5">
            <For each={m.references}>
              {(r) => (
                <li>
                  <button
                    type="button"
                    class="cursor-pointer rounded text-left text-accent underline decoration-dotted underline-offset-2 hover:brightness-110 pointer-coarse:min-h-9 focus-ring"
                    onClick={() => props.onOpenNotice(r.id)}
                  >
                    <span class="font-mono">{r.id}</span>
                  </button>
                  <span class="text-fg-2"> · {r.label}</span>
                  <Show when={r.description}>
                    <span class="text-fg-2"> — {r.description}</span>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>
      <Show when={m.attachments.length > 0}>
        <section class="space-y-1">
          <SectionLabel>{word("attachments", m.lang)}</SectionLabel>
          <For each={m.attachments}>
            {(a) => (
              <a
                href={a.href}
                target="_blank"
                rel="noopener noreferrer"
                class="flex items-center gap-1.5 rounded text-accent hover:brightness-110 focus-ring"
              >
                <Show
                  when={a.image}
                  fallback={
                    <>
                      <FileText size={13} class="shrink-0" aria-hidden="true" />
                      <span class="min-w-0 truncate underline underline-offset-2">{a.name}</span>
                      <Show when={a.size}>
                        <span class="shrink-0 text-[10px] text-fg-3">{a.size}</span>
                      </Show>
                    </>
                  }
                >
                  <img src={a.href} alt={a.name} loading="lazy" class="max-h-48 max-w-full rounded border border-line" />
                </Show>
              </a>
            )}
          </For>
        </section>
      </Show>
    </div>
  );
};
