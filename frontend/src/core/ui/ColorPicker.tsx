import { ColorArea } from "@kobalte/core/color-area";
import { ColorSlider } from "@kobalte/core/color-slider";
import type { Color } from "@kobalte/core/colors";
import { Popover } from "@kobalte/core/popover";
import { createSignal, Show, type Component, type JSX } from "solid-js";
import { formatThemeColour, isColourValue, parseThemeColour } from "../style/colors";

/**
 * Colour swatch + picker for a theme colour token (`settings/ThemeEditorSection.tsx`).
 * Not `<input type="color">`: a native picker has no alpha channel, and some
 * token paths (halos, `chrome.shadow`) carry one. The draft colour is the
 * authority while open — never read back from the committed hex string, or a
 * hue at brightness 0 ("black, but still red underneath") would be lost.
 */
interface ColorPickerProps {
  /** What is being coloured, for the trigger's accessible name. */
  label: string;
  /** The row's CURRENT value, in any notation `isColourValue` accepts. */
  value: string;
  /** Emits the theme files' own notation: `#rrggbb`, or `#rrggbbaa` when the
   * alpha byte is not `ff` (see `formatThemeColour`). */
  onChange: (value: string) => void;
}

/** The transparency chequer: chrome tokens, not fixed greys, so it's a faint
 * texture in every palette instead of a bright rectangle at night. */
const CHEQUER: JSX.CSSProperties = {
  "background-image": "repeating-conic-gradient(var(--color-line) 0% 25%, var(--color-chrome-2) 0% 50%)",
  "background-size": "8px 8px",
};

/** A thumb that stays visible on an arbitrary colour: the chrome's own ground
 * as a ring, outlined in the text colour. Shared by the area and both sliders. */
const THUMB = "rounded-full border-2 border-chrome ring-1 ring-fg outline-none focus-visible:ring-2 focus-visible:ring-accent";

/** Track geometry, and the thumb offset that centers on it. 16px track / 20px
 * thumb on a mouse, 24/28 under a finger — the offset is −2px either way. */
const TRACK = "relative h-4 w-full rounded-full pointer-coarse:h-6";
const TRACK_THUMB = `-top-0.5 block size-5 pointer-coarse:size-7 ${THUMB}`;

export const ColorPicker: Component<ColorPickerProps> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [draft, setDraft] = createSignal<Color>();

  const onOpenChange = (next: boolean): void => {
    if (next) {
      // `parseThemeColour` returns undefined rather than throwing on a
      // half-typed value like `#c5`.
      const seed = parseThemeColour(props.value);
      if (!seed) return;
      setDraft(seed.toFormat("hsb"));
    }
    setOpen(next);
  };

  // Live on every drag tick, not on release: changes show on the map
  // immediately, matching the row's field which already commits per keystroke.
  const commit = (c: Color): void => {
    setDraft(c);
    props.onChange(formatThemeColour(c));
  };

  return (
    <Show
      // A boolean, deliberately: keying on the parsed Color gets a new
      // identity every tick and tears the popover down mid-drag.
      when={isColourValue(props.value)}
      fallback={
        <span
          aria-hidden="true"
          class="size-6 shrink-0 rounded-full border border-dashed border-fg-3 pointer-coarse:size-8"
        />
      }
    >
      <Popover open={open()} onOpenChange={onOpenChange} placement="bottom-end" gutter={6}>
        <Popover.Trigger
          aria-label={`${props.label} colour`}
          class="size-6 shrink-0 overflow-hidden rounded-full ring-1 ring-fg-3 focus-ring pointer-coarse:size-8"
          style={CHEQUER}
        >
          <span aria-hidden="true" class="block size-full" style={{ "background-color": props.value }} />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            // Latches the sheet's touch machine out of presses here (gesture.ts
            // `begin`), so an area/slider drag is the picker's, not the sheet's.
            data-no-drag
            // z-[70]: above the sheet (z-40…z-60, chrome/Sheet.tsx). Padding is
            // load-bearing: each thumb centres on its edge (translate(-50%,-50%)).
            class="z-[70] w-60 rounded-[7px] border border-line bg-chrome p-3.5"
            // Solid ground + shadow halo, never backdrop blur (project UI rule).
            style={{ "box-shadow": "0 8px 26px var(--color-shadow)" }}
          >
            <Show when={draft()}>
              {(color) => (
                <div class="flex flex-col gap-2.5">
                  <ColorArea
                    colorSpace="hsb"
                    xChannel="saturation"
                    yChannel="brightness"
                    value={color()}
                    onChange={commit}
                  >
                    <ColorArea.Background
                      class="relative h-28 w-full rounded"
                      style={{ "touch-action": "none" }}
                    >
                      <ColorArea.Thumb class={`block size-5 pointer-coarse:size-7 ${THUMB}`}>
                        <ColorArea.HiddenInputX />
                        <ColorArea.HiddenInputY />
                      </ColorArea.Thumb>
                    </ColorArea.Background>
                  </ColorArea>

                  <ColorSlider colorSpace="hsb" channel="hue" value={color()} onChange={commit} class="w-full">
                    <ColorSlider.Track class={TRACK} style={{ "touch-action": "none" }}>
                      <ColorSlider.Thumb class={TRACK_THUMB}>
                        <ColorSlider.Input />
                      </ColorSlider.Thumb>
                    </ColorSlider.Track>
                  </ColorSlider>

                  {/* The alpha track's gradient runs transparent → colour, so
                      the chequer goes on the wrapper and shows through it. */}
                  <div class="rounded-full" style={CHEQUER}>
                    <ColorSlider colorSpace="hsb" channel="alpha" value={color()} onChange={commit} class="w-full">
                      <ColorSlider.Track class={TRACK} style={{ "touch-action": "none" }}>
                        <ColorSlider.Thumb class={TRACK_THUMB}>
                          <ColorSlider.Input />
                        </ColorSlider.Thumb>
                      </ColorSlider.Track>
                    </ColorSlider>
                  </div>

                  {/* Theme file's own notation, so the `aa` alpha suffix is visible. */}
                  <p class="text-center font-mono text-[11px] tabular-nums text-fg-2">
                    {formatThemeColour(color())}
                  </p>
                </div>
              )}
            </Show>
          </Popover.Content>
        </Popover.Portal>
      </Popover>
    </Show>
  );
};
