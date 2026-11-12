// `navigator.clipboard` is a SECURE-CONTEXT API: `undefined` on the boat's
// plain-HTTP LAN but present on a dev's `localhost`, so a bare `writeText`
// passes every dev test and silently does nothing on the real deploy. Falls back to `execCommandCopy`.

/** The two ways out, injectable so the policy above is testable without a DOM
 * (and without a secure context we cannot fabricate in the test runner). */
export interface ClipboardEnv {
  /** The secure-context API, when the browser exposes it. */
  writeText?: (text: string) => Promise<void>;
  /** The legacy selection-based copy. Returns whether it took. */
  legacy: (text: string) => boolean;
}

/**
 * Falls through to the legacy path on absence OR rejection — a `writeText`
 * that exists can still reject (a denied permission).
 */
export async function copyText(text: string, env: ClipboardEnv = browserEnv()): Promise<boolean> {
  if (env.writeText) {
    try {
      await env.writeText(text);
      return true;
    } catch {
      // fall through — the legacy path is not subject to the same gate
    }
  }
  try {
    return env.legacy(text);
  } catch {
    return false;
  }
}

/** The real browser's two paths. */
export function browserEnv(): ClipboardEnv {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  return {
    writeText: clipboard ? (text) => clipboard.writeText(text) : undefined,
    legacy: execCommandCopy,
  };
}

/**
 * The element must be RENDERED — `display:none`/`visibility:hidden` gives the
 * selection nothing to take, so it's moved off-screen instead. `readOnly` keeps
 * iOS from raising the keyboard; `fixed` keeps `.focus()` from scrolling the map.
 */
export function execCommandCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const area = document.createElement("textarea");
  area.value = text;
  area.readOnly = true;
  area.setAttribute("aria-hidden", "true");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.opacity = "0";
  area.style.pointerEvents = "none";
  const previous = document.activeElement;
  document.body.appendChild(area);
  try {
    area.focus({ preventScroll: true });
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    if (previous instanceof HTMLElement) previous.focus({ preventScroll: true });
  }
}
