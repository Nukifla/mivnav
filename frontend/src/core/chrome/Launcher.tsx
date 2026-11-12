import { Popover } from "@kobalte/core/popover";
import Command from "lucide-solid/icons/command";
import MapPinned from "lucide-solid/icons/map-pinned";
import Menu from "lucide-solid/icons/menu";
import RefreshCw from "lucide-solid/icons/refresh-cw";
import Sailboat from "lucide-solid/icons/sailboat";
import RouteIcon from "lucide-solid/icons/route";
import Settings from "lucide-solid/icons/settings";
import TriangleAlert from "lucide-solid/icons/triangle-alert";
import { createSignal, For, Show, type Accessor, type Component, type JSX } from "solid-js";
import { clearAllClientState } from "../tileCache";
import { Kbd } from "../ui/Kbd";
import type { Palette } from "../style/colors";
import type { CpaMode } from "../collisionSettings";
import { railDensity } from "./rail-density";
import type { Density } from "./registry";

/**
 * The overflow menu's "hard reset" escape hatch: drops caches/SW/settings and
 * reloads, for stale tiles/icons/SW assets surviving a deploy. Actual
 * clearing logic lives in `tileCache.ts`'s `clearAllClientState`, unit-tested.
 */
async function hardResetClient(): Promise<void> {
  try {
    await clearAllClientState({
      // `typeof` first: the boat's plain-HTTP LAN has neither Cache
      // Storage nor Service Worker (both secure-context-only); a bare
      // reference would throw before `storage.clear()` ran.
      caches: typeof caches !== "undefined" ? caches : undefined,
      serviceWorker: typeof navigator !== "undefined" ? navigator.serviceWorker : undefined,
      storage: localStorage,
    });
  } finally {
    location.reload();
  }
}

// Kobalte `Popover` portals, so it escapes the rail's own `overflow` without
// the rail having to stop clipping its scroll. Controlled (not
// `Popover.CloseButton`): that hard-codes `aria-label="Dismiss"`, which would
// replace every item's own accessible name.
const CPA_MODES: readonly { id: CpaMode; label: string; title: string }[] = [
  { id: "off", label: "Off", title: "No CPA lines, no alarm — for the whole boat" },
  { id: "show", label: "Show", title: "Draw CPA lines, but no alarm — for the whole boat" },
  { id: "tell", label: "Tell", title: "Draw CPA lines and alarm — for the whole boat" },
];

// THEME IDS (the persistence key), not labels: `paper2`/`graphite2` are the
// day/dusk themes now (uqolozkr); old S-52 tables stay reachable as
// "S52-Day"/"S52-Dusk" in Settings. Same three ids in `commands.ts`'s Palette
// command group — keep the two lists in step.
//
// Since 2026-09-27 (user's ask) the three roles are the Modern Paper II
// family: the day theme, Night A (dim blue) for dusk and Night B (red,
// dark-adapted) for night. paper2/graphite2/night stay in the Settings
// dropdown under their own ids.
const PALETTE_MODES: readonly { id: Palette; label: string; title: string }[] = [
  { id: "modern-paper-2", label: "Day", title: "Modern Paper II — full-brightness colours" },
  { id: "modern-paper-2-night-dim", label: "Dusk", title: "Modern Paper II Night A — dimmed blue for twilight" },
  { id: "modern-paper-2-night-red", label: "Night", title: "Modern Paper II Night B — red, preserves dark adaptation" },
];

// Chart MODES no longer live here — each is a dedicated rail button now
// (Rail.tsx `RailToolButton`). The launcher keeps what has no better home:
// command palette, the CPA/palette "reach in the dark" toggles, routes, the
// notices list, settings.
export const Launcher: Component<{
  density: Density;
  onSettings: () => void;
  onCommandPalette?: () => void;
  onRoutes?: () => void;
  onNotices?: () => void;
  onBuddies?: () => void;
  onMarks?: () => void;
  cpaMode?: Accessor<CpaMode>;
  onCpaMode?: (mode: CpaMode) => void;
  palette?: Accessor<Palette>;
  onPalette?: (palette: Palette) => void;
  class: string;
  /** The trigger's height, at the rail's foot — a `rail-density.ts` scaled px
   * value the Tailwind scanner cannot see written down, so it rides `style`
   * rather than `class` (#DENS-SLIDER; see `rail-density.ts`'s header). */
  style?: JSX.CSSProperties;
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  // Armed by a first click, reset whenever the menu closes so re-opening it
  // never lands on the "really?" state from a previous visit.
  const [resetArmed, setResetArmed] = createSignal(false);
  const item =
    "flex w-full items-center gap-2.5 rounded px-2.5 py-[7px] text-left text-xs text-fg hover:bg-accent hover:text-accent-fg";
  const pick = (run: () => void) => () => {
    setOpen(false);
    run();
  };
  const onOpenChange = (next: boolean): void => {
    setOpen(next);
    if (!next) setResetArmed(false);
  };
  return (
    <Popover open={open()} onOpenChange={onOpenChange} placement="top-end" gutter={6}>
      <Popover.Trigger
        // Not "Tools & settings": the menu contains a "Settings" item, and a
        // name containing another control's makes both unaddressable by name.
        aria-label="Tools"
        title="Tools · Charts · Settings"
        class={`flex items-center justify-center text-fg-2 hover:bg-chrome-2 hover:text-fg data-[expanded]:bg-accent data-[expanded]:text-accent-fg ${props.class}`}
        style={props.style}
      >
        <Menu size={railDensity(props.density).icon} aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          class="z-50 min-w-[190px] rounded-[7px] border border-line bg-chrome p-1"
          // --color-shadow is a shadow COLOUR, not a shadow: the chrome casts
          // several geometries and they share one colour.
          style={{ "box-shadow": "0 8px 26px var(--color-shadow)" }}
        >
          <Show when={props.onCommandPalette}>
            {(open) => (
              <>
                <button type="button" class={item} onClick={pick(() => open()())}>
                  <Command size={15} aria-hidden="true" class="shrink-0" />
                  Command palette
                  <Kbd class="ml-auto text-[9px]">⌘K</Kbd>
                </button>
                <hr class="mx-0.5 my-1 border-line-2" />
              </>
            )}
          </Show>
          <Show when={props.onCpaMode}>
            {/* A live toggle, not a launcher: selecting does NOT close the
                menu, so the mariner sees the choice take before leaving. */}
            <div
              class="px-2.5 pb-[5px] pt-1 font-mono text-[8px] font-bold tracking-[0.08em] text-fg-3"
              id="cpa-mode-label"
            >
              CPA ALARM
            </div>
            <div class="flex gap-1 px-2 pb-1.5" role="group" aria-labelledby="cpa-mode-label">
              <For each={CPA_MODES}>
                {(m) => (
                  <button
                    type="button"
                    title={m.title}
                    aria-pressed={props.cpaMode?.() === m.id}
                    class="flex-1 rounded border border-line px-1.5 py-1 text-center text-[11px]"
                    classList={{
                      "bg-accent! text-accent-fg! border-accent!": props.cpaMode?.() === m.id,
                      "text-fg-2 hover:bg-chrome-2 hover:text-fg": props.cpaMode?.() !== m.id,
                    }}
                    onClick={() => props.onCpaMode?.(m.id)}
                  >
                    {m.label}
                  </button>
                )}
              </For>
            </div>
          </Show>
          <Show when={props.onPalette}>
            {/* Same "reach in the dark" toggle pattern as CPA above, not
                Kobalte's SegmentedControl, so the two read as one family. */}
            <div
              class="px-2.5 pb-[5px] pt-1 font-mono text-[8px] font-bold tracking-[0.08em] text-fg-3"
              id="palette-label"
            >
              PALETTE
            </div>
            <div class="flex gap-1 px-2 pb-1.5" role="group" aria-labelledby="palette-label">
              <For each={PALETTE_MODES}>
                {(m) => (
                  <button
                    type="button"
                    title={m.title}
                    aria-pressed={props.palette?.() === m.id}
                    class="flex-1 rounded border border-line px-1.5 py-1 text-center text-[11px]"
                    classList={{
                      "bg-accent! text-accent-fg! border-accent!": props.palette?.() === m.id,
                      "text-fg-2 hover:bg-chrome-2 hover:text-fg": props.palette?.() !== m.id,
                    }}
                    onClick={() => props.onPalette?.(m.id)}
                  >
                    {m.label}
                  </button>
                )}
              </For>
            </div>
          </Show>
          <Show when={props.onCpaMode || props.onPalette}>
            <hr class="mx-0.5 my-1 border-line-2" />
          </Show>
          <Show when={props.onRoutes}>
            {(open) => (
              <button type="button" class={item} onClick={pick(() => open()())}>
                <RouteIcon size={15} aria-hidden="true" class="shrink-0" />
                Routes
                <Kbd class="ml-auto text-[9px]">open · edit</Kbd>
              </button>
            )}
          </Show>
          <Show when={props.onNotices}>
            {(open) => (
              <button type="button" class={item} onClick={pick(() => open()())}>
                <TriangleAlert size={15} aria-hidden="true" class="shrink-0" />
                Notices to Mariners
              </button>
            )}
          </Show>
          <Show when={props.onBuddies}>
            {(open) => (
              <button type="button" class={item} onClick={pick(() => open()())}>
                <Sailboat size={15} aria-hidden="true" class="shrink-0" />
                Buddies
              </button>
            )}
          </Show>
          <Show when={props.onMarks}>
            {(open) => (
              <button type="button" class={item} onClick={pick(() => open()())}>
                <MapPinned size={15} aria-hidden="true" class="shrink-0" />
                Marks
              </button>
            )}
          </Show>
          <button type="button" class={item} onClick={pick(() => props.onSettings())}>
            <Settings size={15} aria-hidden="true" class="shrink-0" />
            Settings
            <Kbd class="ml-auto text-[9px]">device · boat</Kbd>
          </button>
          <hr class="mx-0.5 my-1 border-line-2" />
          {/* Two clicks (armed, then confirmed): wipes every device setting
              along with the caches, and there is no undo. jt zyrrxnno. */}
          <Show
            when={resetArmed()}
            fallback={
              <button
                type="button"
                class={item}
                title="Delete every cached tile/icon, unregister the Service Worker, clear device settings, then reload"
                onClick={() => setResetArmed(true)}
              >
                <RefreshCw size={15} aria-hidden="true" class="shrink-0" />
                Clear cache &amp; reload
              </button>
            }
          >
            <button
              type="button"
              class={`${item} text-alarm`}
              onClick={() => {
                setResetArmed(false);
                setOpen(false);
                void hardResetClient();
              }}
            >
              <RefreshCw size={15} aria-hidden="true" class="shrink-0" />
              Really clear &amp; reload?
            </button>
          </Show>
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  );
};
