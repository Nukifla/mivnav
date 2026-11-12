// Live-updating detail for the open info panel (fixes #52, "frozen panel").
// Liveness stays with `InfoProvider.watch`, not `detail` itself — see
// docs/architecture/info-provider-contract.md for why.

import { createMemo, createResource, type Accessor } from "solid-js";
import { resolveDetail, watchHit } from "./registry";
import type { InfoDetail, InfoHit, InfoProvider } from "./types";

/** A hit's identity for "is this still the same subject?" — provider + id,
 * the same identity `state.ts`'s `sameHits` compares. Not the object: a
 * repeat tap or a live re-query hands over a fresh `InfoHit` for the same
 * thing. */
export function hitKey(hit: InfoHit): string {
  return `${hit.providerId}\u0000${hit.id}`;
}

/**
 * Resolved record behind `hit`, kept current: the old record stays until a
 * new one lands, so a ticking source refreshes rather than flashing "Loading…".
 *
 * But only for the SAME hit. Each resolve is tagged with the hit it was asked
 * for, and a record resolved for another hit is never returned: when the
 * panel swaps to hit B in place (desktop: tap B with A still open), the
 * accessor reads `undefined` until B's own record lands, rather than showing
 * A's record under B's title.
 */
export function createHitDetail(
  providers: readonly InfoProvider[],
  hit: Accessor<InfoHit | undefined>,
): Accessor<InfoDetail | undefined> {
  // `watchHit` belongs here, in the tracking scope, not the fetcher: reading
  // a provider's live state is what subscribes the panel to it, so a run
  // only happens when something a provider read actually changed.
  const ask = createMemo(() => {
    const current = hit();
    if (!current) return null; // `null` is createResource's "nothing to ask"
    watchHit(providers, current);
    return { hit: current };
  });

  // Resolved per hit, not per query: a tap can land on a dozen objects and the
  // user reads one. Async because a provider's record may live somewhere the
  // hit never touched (AIS's full vessel record).
  const [resolved] = createResource(ask, async ({ hit: current }) => ({
    key: hitKey(current),
    detail: await resolveDetail(providers, current),
  }));
  return () => {
    const r = resolved();
    const current = hit();
    return r && current && r.key === hitKey(current) ? r.detail : undefined;
  };
}
