// For touch moments that commit something the mariner can't see their finger
// do precisely on a bouncing deck. Feature-detected: no-ops where
// `navigator.vibrate` is absent (desktop, iOS Safari).

/** A short haptic tick, where the platform supports it; a no-op otherwise. */
export function haptic(ms = 10): void {
  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
    // Some browsers throw if called outside a user gesture.
    try {
      navigator.vibrate(ms);
    } catch {
      // haptics are a nicety, never load-bearing
    }
  }
}
