// What the info surface WILL cover once it opens, for a caller that moves the
// camera BEFORE opening it (features/notices `openNotice`: fit the notice,
// then show it on the panel). The marker's reveal-warp (./marker.ts) measures
// the live sheet (../chrome/Sheet.ts `measureObscured`) because it runs after
// the sheet has settled; a fit-then-open cannot measure a surface that does not
// exist yet, so it predicts the info surface's resting box from the same
// constants that size it, and feeds the result through the same
// `obscuredFromRects` arithmetic the measured path uses.

import { isCompact } from "../media";
import { obscuredFromRects, SHEET_MAX_FRACTION, type ObscuredEdges } from "../chrome/Sheet";

/** The phone info sheet's PEEK detent (./InfoPanel.tsx `detents`) — the
 * fraction of the sheet's height showing when it opens. */
export const INFO_SHEET_PEEK = 0.5;

/** The desktop info card's horizontal box, container px: InfoPanel's
 * `left-3.5 w-[258px]`. Stated twice (Tailwind needs the literals); pinned by
 * surface.test.ts. */
export const INFO_CARD_LEFT_PX = 14;
export const INFO_CARD_WIDTH_PX = 258;

/** The smallest box (px per axis) a fit is left to frame. MapLibre refuses a
 * fit outright (warns, camera doesn't move) when padding eats the whole
 * canvas, so a landscape phone shrinks the padding instead. */
export const MIN_FIT_PX = 64;

/** Coverage per edge, container px. `ObscuredEdges` plus `left`: the desktop
 * card is a left-edge surface, which the bottom/top-only marker rules never
 * needed. */
export interface Cover extends ObscuredEdges {
  left?: number;
}

/** MapLibre's `PaddingOptions`, spelled out so this file stays map-free. */
export interface FitPadding {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * The info surface's coverage once open, pure. Phone: the nav band (measured)
 * on top, and the non-modal info sheet at its peek on the bottom — the sheet
 * is content-sized up to `SHEET_MAX_FRACTION` of the viewport, so the peek
 * covers at most `SHEET_MAX_FRACTION * INFO_SHEET_PEEK` of it; the bound is
 * used (a notice's text all but always fills the sheet, and erring high only
 * frames the notice a little smaller). Desktop: the floating card's column on
 * the left; the docked list panel is a flex sibling of the map (DockPanel.tsx)
 * and already outside the container.
 */
export function predictInfoCover(args: {
  compact: boolean;
  container: { top: number; bottom: number; clientHeight: number };
  viewportHeight: number;
  navBand?: { bottom: number };
}): Cover {
  if (!args.compact) return { top: 0, bottom: 0, left: INFO_CARD_LEFT_PX + INFO_CARD_WIDTH_PX };
  const sheetTop = args.viewportHeight * (1 - SHEET_MAX_FRACTION * INFO_SHEET_PEEK);
  return { ...obscuredFromRects({ ...args, sheet: { top: sheetTop } }), left: 0 };
}

/** Squeeze `a + b` so at least `MIN_FIT_PX` of `span` is left free. */
function squeeze(a: number, b: number, span: number): [number, number] {
  const room = Math.max(0, span - MIN_FIT_PX);
  const sum = a + b;
  if (sum <= room) return [a, b];
  const k = sum > 0 ? room / sum : 0;
  return [a * k, b * k];
}

/**
 * `fitBounds` padding that frames a geometry in what `cover` leaves visible:
 * each edge's coverage plus `margin`. Never more than the canvas can take (see
 * `MIN_FIT_PX`).
 */
export function fitPadding(
  size: { clientWidth: number; clientHeight: number },
  cover: Cover,
  margin: number,
): FitPadding {
  const [top, bottom] = squeeze(
    Math.max(0, cover.top ?? 0) + margin,
    Math.max(0, cover.bottom) + margin,
    size.clientHeight,
  );
  const [left, right] = squeeze(Math.max(0, cover.left ?? 0) + margin, margin, size.clientWidth);
  return { top, bottom, left, right };
}

/** `fitPadding` for the info surface about to open over `container`, measured
 * off the live DOM (the nav band) like `measureObscured`. */
export function measureInfoFitPadding(container: HTMLElement, margin: number): FitPadding {
  if (typeof document === "undefined") return fitPadding(container, { bottom: 0 }, margin);
  const c = container.getBoundingClientRect();
  const navBand = document.querySelector<HTMLElement>("[data-nav-band]");
  const cover = predictInfoCover({
    compact: isCompact(),
    container: { top: c.top, bottom: c.bottom, clientHeight: container.clientHeight },
    viewportHeight: window.innerHeight,
    navBand: navBand?.getBoundingClientRect(),
  });
  return fitPadding(container, cover, margin);
}
