import { splitProps, type Component, type JSX } from "solid-js";

/** All-caps section heading. A call site with a different tone/size
 * (RouteSheet's tighter tracking, a settings pane's `<h2>`) stays put. */
export const SectionLabel: Component<JSX.HTMLAttributes<HTMLHeadingElement>> = (props) => {
  const [own, rest] = splitProps(props, ["class"]);
  return (
    <h3
      {...rest}
      class={
        own.class
          ? `text-xs font-semibold uppercase tracking-wide text-fg-2 ${own.class}`
          : "text-xs font-semibold uppercase tracking-wide text-fg-2"
      }
    />
  );
};

/** Muted small print for empty-state lines and one-line hints. */
export const Note: Component<JSX.HTMLAttributes<HTMLParagraphElement>> = (props) => {
  const [own, rest] = splitProps(props, ["class"]);
  return <p {...rest} class={own.class ? `text-xs text-fg-2 ${own.class}` : "text-xs text-fg-2"} />;
};
