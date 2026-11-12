import { splitProps, type Component, type JSX } from "solid-js";

// Shared button family (v1.0 plan, D2), replacing ~70 raw `<button>`s that
// each re-derived the same tokens by hand. `buttonClass` is a pure, tested
// function so variant→token mapping is asserted without a DOM.

/** The button's colour intent. `primary`/`danger`/`success` are saturated FILLS
 * (white-on-colour); `secondary` is the neutral bordered button; `tinted` is a
 * tone-coloured outline whose hover is a wash of its own tone (see {@link ButtonTone}). */
export type ButtonVariant = "primary" | "secondary" | "tinted" | "danger" | "success";

/** Tone of a `tinted` button. `notice` deliberately keeps a full-opacity
 * border where `accent`/`alarm` use `/40` — preserves existing weighting
 * (amber "Overwrite…" reads heavier than in-list Unset/Delete). */
export type ButtonTone = "accent" | "notice" | "alarm";

/** `sm` is the dense in-panel button (`text-xs`); `md` is the standard action
 * button; `lg` is the tall primary CTA (chart-library import). Coarse-pointer
 * padding grows with each so a finger target survives. */
export type ButtonSize = "sm" | "md" | "lg";

const SIZE: Record<ButtonSize, string> = {
  sm: "px-2 py-1 text-xs pointer-coarse:px-3 pointer-coarse:py-2",
  md: "px-3 py-1 pointer-coarse:px-4 pointer-coarse:py-2",
  lg: "px-3 py-1.5 pointer-coarse:px-4 pointer-coarse:py-2.5",
};

/** The saturated fills — white text via `accent-fg` (the on-fill token; never
 * `text-white`, which the theming gate forbids), hover/active a darker step. */
const FILL: Partial<Record<ButtonVariant, string>> = {
  primary: "bg-accent text-accent-fg hover:bg-accent/90 active:bg-accent/80",
  danger: "bg-alarm text-accent-fg hover:bg-alarm/90 active:bg-alarm/80",
  success: "bg-ok text-accent-fg hover:bg-ok/90 active:bg-ok/80",
};

const TINTED: Record<ButtonTone, string> = {
  accent: "border border-accent/40 text-accent hover:bg-accent/10 active:bg-accent/20",
  notice: "border border-notice text-notice hover:bg-notice/10 active:bg-notice/20",
  alarm: "border border-alarm/40 text-alarm hover:bg-alarm/10 active:bg-alarm/20",
};

const SECONDARY = "border border-line hover:bg-chrome-2 active:bg-chrome-2";

const isFill = (variant: ButtonVariant): boolean =>
  variant === "primary" || variant === "danger" || variant === "success";

/** Pure, unit-testable class-string builder. `font-medium` rides every fill
 * and every `md`/`lg` button; dense `sm` outline/tinted buttons stay regular
 * weight unless `class` adds it back. Caller's `class` wins by coming last. */
export function buttonClass(opts: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  tone?: ButtonTone;
  class?: string;
}): string {
  const variant = opts.variant ?? "secondary";
  const size = opts.size ?? "sm";
  const tone = opts.tone ?? "accent";
  const look =
    variant === "tinted" ? TINTED[tone] : variant === "secondary" ? SECONDARY : (FILL[variant] ?? SECONDARY);
  const bold = isFill(variant) || size !== "sm" ? "font-medium" : "";
  return ["rounded focus-ring disabled:opacity-50", SIZE[size], look, bold, opts.class ?? ""]
    .filter(Boolean)
    .join(" ");
}

export type ButtonProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  tone?: ButtonTone;
};

/** Defaults `type="button"` so it never accidentally submits a form. */
export const Button: Component<ButtonProps> = (props) => {
  const [own, rest] = splitProps(props, ["variant", "size", "tone", "class"]);
  return (
    <button
      type="button"
      {...rest}
      class={buttonClass({ variant: own.variant, size: own.size, tone: own.tone, class: own.class })}
    />
  );
};

/** Bordered `chrome-2` box, touch-sized at `pointer-coarse`. Was defined
 * byte-identically in ChromeSection and DashboardEditor; unified here. */
export const iconButtonClass =
  "flex size-7 shrink-0 items-center justify-center rounded border border-line bg-chrome-2 text-fg-2 transition-colors hover:border-accent hover:text-accent disabled:cursor-default disabled:opacity-30 disabled:hover:border-line disabled:hover:text-fg-2 pointer-coarse:size-9";

export type IconButtonProps = Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "title"> & {
  /** Titles the button AND labels it for a screen reader — an icon has no text. */
  title: string;
};

export const IconButton: Component<IconButtonProps> = (props) => {
  const [own, rest] = splitProps(props, ["class"]);
  return (
    <button
      type="button"
      {...rest}
      aria-label={props.title}
      class={own.class ? `${iconButtonClass} ${own.class}` : iconButtonClass}
    />
  );
};
