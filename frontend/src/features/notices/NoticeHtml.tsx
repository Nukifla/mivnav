// Renders a notice's sanitised HTML (./html.ts's tree) as real DOM nodes —
// element by element via `Dynamic`, text as text nodes, never innerHTML.
// Styling is local: the panel has no prose stylesheet, and Niord's position
// tables ("1) 54° 38,433'N - 011° 22,183'E  kyst") must stay readable at
// panel width.

import { For, Show, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { parseNoticeHtml, type HtmlElement, type HtmlNode } from "./html";

const CLASSES: Partial<Record<HtmlElement["tag"], string>> = {
  p: "my-1",
  ul: "my-1 list-disc pl-4",
  ol: "my-1 list-decimal pl-4",
  // Niord's position tables (number, coordinate, description): a coordinate
  // only breaks between its latitude and longitude (./html.ts glues each
  // half with no-break spaces); the wrapper below scrolls a table that still
  // doesn't fit.
  table: "border-collapse font-mono text-[10.5px]",
  td: "pr-2 align-top",
  th: "pr-2 text-left align-top font-semibold",
  strong: "font-semibold",
  b: "font-semibold",
  a: "text-accent underline underline-offset-2 break-all",
};

const Element: Component<{ el: HtmlElement }> = (props) => (
  <Show when={props.el.tag === "table"} fallback={<Plain el={props.el} />}>
    <div class="my-1 max-w-full overflow-x-auto">
      <Plain el={props.el} />
    </div>
  </Show>
);

const Node: Component<{ node: HtmlNode }> = (props) => (
  <Show
    when={
      typeof props.node !== "string" ? (props.node as HtmlElement) : undefined
    }
    fallback={props.node as string}
  >
    {(el) => <Element el={el()} />}
  </Show>
);

const Plain: Component<{ el: HtmlElement }> = (props) => {
  const el = () => props.el;
  return (
    <Dynamic
      component={el().tag}
      class={CLASSES[el().tag]}
      href={el().attrs.href}
      target={el().tag === "a" ? "_blank" : undefined}
      rel={el().tag === "a" ? "noopener noreferrer" : undefined}
      colspan={el().attrs.colspan}
      rowspan={el().attrs.rowspan}
    >
      <For each={el().children}>{(child) => <Node node={child} />}</For>
    </Dynamic>
  );
};

export const NoticeHtml: Component<{
  html: string | null | undefined;
  class?: string;
}> = (props) => (
  <div class={`break-words text-xs leading-snug text-fg ${props.class ?? ""}`}>
    <For each={parseNoticeHtml(props.html)}>{(n) => <Node node={n} />}</For>
  </div>
);
