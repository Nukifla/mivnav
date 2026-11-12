import { Slider as KSlider } from "@kobalte/core/slider";
import { Switch } from "@kobalte/core/switch";
import { createSignal, Show, type Component } from "solid-js";
import { clampStep, isScrubTap, scrubDelta, scrubValue } from "../gesture";

// The settings surface's shared primitives: the form controls every generated
// and hand-authored setting is drawn with.

export const Toggle: Component<{
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  /** Greyed out when the setting it depends on is off — the callers already
   * AND the two, so an enabled-looking switch would do nothing. */
  disabled?: boolean;
  /** One line under the label, for a setting whose *label* cannot carry the
   * consequence. Opt-in, not on every switch — that would teach a sailor to
   * skip them all. */
  hint?: string;
}> = (props) => (
  <Switch
    checked={props.checked}
    onChange={props.onChange}
    disabled={props.disabled}
    class={`flex gap-2 data-[disabled]:opacity-40 ${props.hint ? "items-start" : "items-center"}`}
  >
    <Switch.Input />
    <Switch.Control
      class={`h-5 w-9 shrink-0 cursor-pointer rounded-full bg-line transition-colors data-[checked]:bg-accent active:brightness-90 data-[disabled]:cursor-not-allowed ${props.hint ? "mt-0.5" : ""}`}
    >
      {/* The hairline isn't decoration: at NIGHT the knob and unchecked
          track collapse toward black (~1.35:1 contrast) and an off switch
          loses its knob entirely without this border re-stating its edge. */}
      <Switch.Thumb class="m-0.5 block size-4 rounded-full border border-fg-3 bg-chrome transition-transform data-[checked]:translate-x-4" />
    </Switch.Control>
    <div class="flex flex-col">
      <Switch.Label class="cursor-pointer select-none data-[disabled]:cursor-not-allowed">
        {props.label}
      </Switch.Label>
      <Show when={props.hint}>
        {(hint) => <Switch.Description class="text-xs text-fg-2">{hint()}</Switch.Description>}
      </Show>
    </div>
  </Switch>
);

/**
 * A numeric setting on a track, with an optional colour swatch for values
 * that mean nothing without knowing which on-chart thing they colour (AIS's
 * CPA rings). Visible bar and touch target differ in size — a thin bar with
 * a larger invisible hit area for wet/gloved hands. See
 * docs/architecture/controls-touch-targets.md.
 */
export const Slider: Component<{
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  /** The on-chart colour this value governs — see AIS's danger/warning rings. */
  swatch?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
  /** Fires once when the drag settles, not on every tick — the seam a control
   * whose commit is expensive (a boat-config PATCH) hangs its write on, driving
   * `onChange` only the local display in between. */
  onChangeEnd?: (value: number) => void;
}> = (props) => (
  <KSlider
    value={[props.value]}
    onChange={(values) => props.onChange(values[0])}
    onChangeEnd={(values) => props.onChangeEnd?.(values[0])}
    minValue={props.min}
    maxValue={props.max}
    step={props.step}
    disabled={props.disabled}
    getValueLabel={(params) => props.format(params.values[0])}
    class="flex w-full flex-col gap-2 data-[disabled]:opacity-40"
  >
    <div class="flex items-center justify-between">
      <KSlider.Label class="flex items-center gap-1.5 font-medium">
        {/* The fill is the chart layer's own colour and stays a literal —
            quoting the chart. The ring outline is chrome and tracks the
            palette instead. */}
        {props.swatch && (
          <span
            aria-hidden="true"
            class="size-2.5 shrink-0 rounded-full ring-1 ring-fg-3"
            style={{ "background-color": props.swatch }}
          />
        )}
        {props.label}
      </KSlider.Label>
      <KSlider.ValueLabel class="tabular-nums" />
    </div>
    {/* Track's invisible hit band, stops at the root's gap-2 so it can't eat
        a tap meant for label/control neighbours (see controls-touch-targets.md). */}
    <KSlider.Track class="relative h-1.5 w-full rounded-full bg-line before:absolute before:-inset-y-2 before:inset-x-0 before:content-[''] pointer-coarse:h-2">
      <KSlider.Fill class="absolute h-full rounded-full bg-accent" />
      {/* Thumb's invisible hit area sits BEFORE it in tree order, so the
          thumb still wins the hit where they overlap. */}
      <KSlider.Thumb class="-top-1 block size-3.5 rounded-full bg-accent outline-none before:absolute before:-inset-2 before:touch-none before:content-[''] hover:bg-accent/90 active:bg-accent/80 focus:ring-2 focus:ring-accent pointer-coarse:-top-1.5 pointer-coarse:size-5 pointer-coarse:before:-inset-3">
        <KSlider.Input />
      </KSlider.Thumb>
    </KSlider.Track>
  </KSlider>
);

/**
 * A scrubbable value field — a slider's replacement for a single-line row.
 * Press-and-drag scrubs (tap-vs-drag disambiguated by travel, see
 * {@link isScrubTap}); a sub-slop tap opens text entry. Mirrors
 * {@link Slider}'s `onChange`/`onChangeEnd` contract so a swap is drop-in.
 */
export const ScrubNumber: Component<{
  value: number;
  min: number;
  max: number;
  step: number;
  /** Live value on every drag tick / arrow press (mirrors {@link Slider} `onChange`). */
  onChange: (value: number) => void;
  /** Fires once when the value SETTLES — drag release, Enter or blur (mirrors
   * {@link Slider} `onChangeEnd`). Defaults to {@link onChange} when omitted. */
  onChangeEnd?: (value: number) => void;
  /** value → display string, e.g. `0.75 → "75%"`. */
  format: (value: number) => string;
  /** display string → value, or `null` when the text is not a number (cancel). */
  parse: (text: string) => number | null;
  "aria-label": string;
  /** Dimmed + not scrubbable. The row still shows it (a hidden layer keeps its
   * opacity), so this greys, it does not remove. */
  disabled?: boolean;
}> = (props) => {
  const [editing, setEditing] = createSignal(false);
  const [dragging, setDragging] = createSignal(false);
  const [draft, setDraft] = createSignal("");

  let field: HTMLSpanElement | undefined;
  // Live pointer state — locals, not signals: the render never reads them.
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let startVal = 0;
  let moved = false; // crossed tap slop → this press is a scrub, not a tap

  const commit = (v: number): void => {
    const c = clampStep(v, props.min, props.max, props.step);
    props.onChange(c);
    (props.onChangeEnd ?? props.onChange)(c);
  };

  const nudge = (dir: 1 | -1, big: boolean): void => {
    commit(props.value + dir * props.step * (big ? 2 : 1));
  };

  const down = (e: PointerEvent): void => {
    if (props.disabled || editing() || !e.isPrimary || pointerId !== null) return;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    startVal = props.value;
    moved = false;
    field?.setPointerCapture?.(e.pointerId);
  };
  const move = (e: PointerEvent): void => {
    if (pointerId === null || e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!moved) {
      if (isScrubTap(dx, dy)) return; // still within tap slop
      moved = true;
      setDragging(true);
    }
    // Ours now — block any native drag/text-selection the pointer would start.
    if (e.cancelable) e.preventDefault();
    props.onChange(scrubValue(startVal, scrubDelta(dx, dy), props.min, props.max, props.step));
  };
  const up = (e: PointerEvent): void => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    if (field?.hasPointerCapture?.(e.pointerId)) field.releasePointerCapture(e.pointerId);
    if (moved) {
      setDragging(false);
      (props.onChangeEnd ?? props.onChange)(props.value); // commit the live value
      return;
    }
    // A tap — no meaningful travel — opens direct entry.
    beginEdit();
  };

  const beginEdit = (): void => {
    // Seed with the numeric part of the formatted value ("75%" → "75") so typing
    // replaces a familiar number, not a percent sign.
    setDraft(props.format(props.value).replace(/[^\d.-]/g, ""));
    setEditing(true);
  };
  const commitEdit = (): void => {
    if (!editing()) return;
    const v = props.parse(draft());
    setEditing(false);
    if (v !== null) commit(v);
  };
  const cancelEdit = (): void => {
    setEditing(false);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (props.disabled) return;
    if (e.key === "ArrowUp" || e.key === "ArrowRight") {
      e.preventDefault();
      nudge(1, e.shiftKey);
    } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
      e.preventDefault();
      nudge(-1, e.shiftKey);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      beginEdit();
    }
  };

  return (
    <Show
      when={!editing()}
      fallback={
        <input
          // `inputmode=decimal` brings up the numeric keypad on the touchscreen;
          // it stays a text input so a lone "-" mid-edit doesn't get eaten.
          type="text"
          inputmode="decimal"
          class="w-14 shrink-0 rounded bg-line px-1 py-0.5 text-right font-mono text-sm tabular-nums text-fg outline-none focus-ring"
          value={draft()}
          aria-label={props["aria-label"]}
          ref={(el) => {
            // Focus + select once mounted so the typed value replaces the seed.
            queueMicrotask(() => {
              el.focus();
              el.select();
            });
          }}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitEdit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancelEdit();
            }
          }}
          onBlur={commitEdit}
        />
      }
    >
      <span
        ref={field}
        // `data-no-drag` latches the sheet's touch machine out of this press
        // (gesture.ts), `touch-action:none` stops the browser starting a scroll
        // so pointermove is ours to scrub with.
        data-no-drag
        role="slider"
        tabindex={props.disabled ? -1 : 0}
        aria-label={props["aria-label"]}
        aria-valuemin={props.min}
        aria-valuemax={props.max}
        aria-valuenow={props.value}
        aria-valuetext={props.format(props.value)}
        aria-disabled={props.disabled}
        style={{ "touch-action": "none" }}
        class="inline-flex w-14 shrink-0 select-none justify-end rounded px-1 py-0.5 text-right font-mono text-sm tabular-nums focus-ring pointer-coarse:py-1.5"
        classList={{
          "cursor-move hover:bg-line/60": !props.disabled && !dragging(),
          "cursor-grabbing bg-line text-accent": dragging(),
          "cursor-not-allowed opacity-40": props.disabled,
        }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onKeyDown={onKeyDown}
      >
        {props.format(props.value)}
      </span>
    </Show>
  );
};

/** value → "NN%" for a 0–1 fraction. Rounded, so the field width is stable.
 * Exported for the unit test that pins the {@link ScrubPercent} contract. */
export const formatPercent = (v: number): string => `${Math.round(v * 100)}%`;
/** "75" or "75%" → 0.75; non-numeric → null (edit cancelled). */
export const parsePercent = (t: string): number | null => {
  const n = Number.parseFloat(t.replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n / 100 : null;
};

/** {@link ScrubNumber} preset for a 0-1 fraction shown as a percentage (the
 * opacity control in the Layers panel); only format/parse are fixed. */
export const ScrubPercent: Component<{
  value: number;
  min?: number;
  max?: number;
  step: number;
  onChange: (value: number) => void;
  onChangeEnd?: (value: number) => void;
  "aria-label": string;
  disabled?: boolean;
}> = (props) => (
  <ScrubNumber
    value={props.value}
    min={props.min ?? 0}
    max={props.max ?? 1}
    step={props.step}
    onChange={props.onChange}
    onChangeEnd={props.onChangeEnd}
    format={formatPercent}
    parse={parsePercent}
    aria-label={props["aria-label"]}
    disabled={props.disabled}
  />
);

// `SettingsGroup`'s device/boat rail is gone (task woqknwzy): the redesign
// made that split navigational (separate tabs, `SettingsBrowser.tsx`)
// instead, so the rail was redundant. `--color-notice` remains for marking
// a boat-wide consequence elsewhere.
