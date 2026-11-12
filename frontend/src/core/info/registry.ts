// Fan a question out over providers and rank the answers, route a hit back to
// its owner. Every lookup routes on `hit.providerId` alone — the seam's one
// addressing rule lives here: a hit is a name, the registry owns it.

import type { Component } from "solid-js";
import { dedupeHits, rankHits } from "./rank";
import type { InfoDetail, InfoHit, InfoIconProps, InfoPoint, InfoProvider, InfoQuery } from "./types";

/** Every provider's answer to one query, best first. `providerId` is stamped
 * from the registry's own view of who answered, not trusted from the hit, so
 * a provider cannot (even by accident) route its lookups to someone else. */
export function queryInfoAt(providers: readonly InfoProvider[], query: InfoQuery): InfoHit[] {
  const answers: { provider: InfoProvider; hits: InfoHit[] }[] = [];
  for (const provider of providers) {
    const hits: InfoHit[] = [];
    for (const hit of provider.queryAt(query)) {
      hits.push(hit.providerId === provider.id ? hit : { ...hit, providerId: provider.id });
    }
    answers.push({ provider, hits });
  }
  const hits = dropSuperseded(answers);
  // Dedupe first, rank second: dedupe keeps the first of a run, and the
  // providers hand us their hits in their own z-order.
  return rankHits(dedupeHits(hits));
}

/** Everyone's answers, minus the ones another provider declared redundant
 * (`InfoProvider.supersedes`). Each hook is shown the ORIGINAL answers, so the
 * outcome is independent of provider order; a provider that answered nothing
 * supersedes nothing (its overlay is off, its data not loaded — the other
 * source is then the only answer there is), and it can only name OTHER
 * providers' hits. */
function dropSuperseded(answers: readonly { provider: InfoProvider; hits: InfoHit[] }[]): InfoHit[] {
  const all = answers.flatMap((a) => a.hits);
  const dropped = new Set<InfoHit>();
  for (const { provider, hits: own } of answers) {
    if (!provider.supersedes || own.length === 0) continue;
    const others = all.filter((h) => h.providerId !== provider.id);
    if (others.length === 0) continue;
    for (const hit of provider.supersedes(own, others)) {
      if (hit.providerId !== provider.id) dropped.add(hit);
    }
  }
  return dropped.size === 0 ? all : all.filter((h) => !dropped.has(h));
}

/** The full record behind a hit. Always async, even for providers that answer
 * from memory — the panel has one code path, and a second consumer (AIS
 * detail from SignalK state) is free to become a real fetch untouched. */
function providerFor(
  providers: readonly InfoProvider[],
  hit: InfoHit,
): InfoProvider | undefined {
  return providers.find((p) => p.id === hit.providerId);
}

/**
 * Where a hit is *now*, or `undefined` when it cannot be placed. NOT
 * `locate(hit) ?? hit.lngLat`: a provider's `undefined` is authoritative — a
 * vessel that can no longer be resolved must not fall back to the stale tap position.
 */
export function locateHit(
  providers: readonly InfoProvider[],
  hit: InfoHit,
): InfoPoint | undefined {
  const provider = providerFor(providers, hit);
  return provider?.locate ? provider.locate(hit) : hit.lngLat;
}

/** Subscribe to whatever would make `resolveDetail` answer differently. Call
 * in a tracking scope; a provider with no `watch` reads nothing, so a static
 * record resolves exactly once. */
export function watchHit(providers: readonly InfoProvider[], hit: InfoHit): void {
  providerFor(providers, hit)?.watch?.(hit);
}

/** The icon for a hit, or `undefined` to fall back to the panel's generic
 * chip. Chain: owning provider's per-hit `icon`, then `defaultIcon`, then nothing. */
export function iconForHit(
  providers: readonly InfoProvider[],
  hit: InfoHit,
): Component<InfoIconProps> | undefined {
  const provider = providerFor(providers, hit);
  if (!provider) return undefined;
  return provider.icon?.(hit) ?? provider.defaultIcon;
}

export async function resolveDetail(
  providers: readonly InfoProvider[],
  hit: InfoHit,
): Promise<InfoDetail> {
  const provider = providerFor(providers, hit);
  if (!provider) {
    // A hit whose provider has gone away (a list held across a settings
    // change, say). Say so rather than throwing: the panel is an information
    // surface, and "we can't look this up any more" is information.
    return { sections: [{ rows: [{ label: "Source", value: `unavailable (${hit.providerId})` }] }] };
  }
  return await provider.detail(hit);
}
