// TEMPORARY dev tool. Hooks MapLibre's `render` event (fires after every
// drawn frame, incl. custom layers) rather than its own rAF loop, so the
// number matches actual render cadence. Gated by DEV or the "FPS counter" setting.

import { createSignal, onCleanup, onMount, type Component } from "solid-js";
import type { Map as MLMap } from "maplibre-gl";

/** Averaging window: a raw per-frame delta jitters too fast to read. */
const SAMPLE_WINDOW_MS = 500;

export const FpsCounter: Component<{ map: MLMap }> = (props) => {
  const [fps, setFps] = createSignal(0);
  const [frameMs, setFrameMs] = createSignal(0);
  let frames = 0;
  let windowStart = performance.now();

  const onRender = () => {
    frames++;
    const now = performance.now();
    const elapsed = now - windowStart;
    if (elapsed >= SAMPLE_WINDOW_MS) {
      setFps(Math.round((frames * 1000) / elapsed));
      setFrameMs(Math.round((elapsed / frames) * 10) / 10);
      frames = 0;
      windowStart = now;
    }
  };

  onMount(() => props.map.on("render", onRender));
  onCleanup(() => props.map.off("render", onRender));

  return (
    // Solid bg + drop-shadow (no blur, per the UI rule).
    <div class="pointer-events-none absolute left-2 top-2 z-50 select-none rounded-md bg-neutral-900 px-2 py-1 font-mono text-xs text-on-scrim shadow-lg">
      {fps()} fps · {frameMs()} ms
    </div>
  );
};

export default FpsCounter;
