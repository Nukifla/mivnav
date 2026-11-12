// Motion tokens, JS side. Canonical values live in index.css `@theme`
// (`--duration-sheet`, `--ease-sheet`, `--duration-close-fallback`); mirrored
// here because the sheet stage machines' `setTimeout` fallback needs a number, not `var()`. MUST stay equal to the CSS tokens.

/** How long a sheet waits for `transitionend` before forcing the unmount.
 * Mirrors `--duration-close-fallback`; must be >= any sheet-settle duration
 * so it never truncates a real transition — a safety net that normally never fires. */
export const CLOSE_FALLBACK_MS = 420;
