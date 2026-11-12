import { createSignal } from "solid-js";

// Viewport queries as app-lifetime signals; listener is never removed since
// there is exactly one document and it outlives every component.

function query(mediaQuery: string) {
  // Runs at module scope, so it may execute in a headless test importer with
  // no DOM — report desktop (`false`) rather than throw in that case.
  if (typeof window === "undefined" || !window.matchMedia) return () => false;
  const mql = window.matchMedia(mediaQuery);
  const [matches, setMatches] = createSignal(mql.matches);
  mql.addEventListener("change", (e) => setMatches(e.matches));
  return matches;
}

/** Phone-width viewport: floating panels present as bottom sheets instead.
 * Mirrors Tailwind's `md` breakpoint so CSS and JS agree on the split. */
export const isCompact = query("(max-width: 767px)");

/** OS-level reduced-motion request. The bottom sheet skips its enter/exit
 * slide and drag-settle easing, but still tracks the finger 1:1 while
 * dragging — that's direct manipulation, not decoration. */
export const prefersReducedMotion = query("(prefers-reduced-motion: reduce)");

/**
 * Live viewport size for `chrome/bands.bandCapacity`'s overflow estimate.
 * NOT a layout input: density is a setting, not a measurement (invariant #10).
 */
export const viewport = (() => {
  const read = () => ({ width: window.innerWidth, height: window.innerHeight });
  if (typeof window === "undefined") return () => ({ width: 1280, height: 800 });
  const [size, setSize] = createSignal(read());
  window.addEventListener("resize", () => setSize(read()));
  return size;
})();
