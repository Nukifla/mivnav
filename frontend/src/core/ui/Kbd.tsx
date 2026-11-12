import { splitProps, type Component, type JSX } from "solid-js";

// Shared base for the launcher/command-palette keyboard-hint chips
// (previously hand-typed per site); per-site sizing/color rides in via `class`.

export const Kbd: Component<JSX.HTMLAttributes<HTMLElement>> = (props) => {
  const [own, rest] = splitProps(props, ["class"]);
  return <kbd {...rest} class={own.class ? `font-mono text-fg-3 ${own.class}` : "font-mono text-fg-3"} />;
};
