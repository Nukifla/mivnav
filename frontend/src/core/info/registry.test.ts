/**
 * The icon resolver's fallback chain, the one behaviour the registry adds for
 * icons: per-hit `icon` → provider `defaultIcon` → nothing (the panel's chip).
 * Pure routing over `providerId`, so it needs no DOM — the components are opaque
 * identities here, and what is asserted is *which* one comes back.
 */

import { describe, expect, test } from "bun:test";
import type { Component } from "solid-js";
import { iconForHit, queryInfoAt } from "./registry";
import type { InfoDetail, InfoHit, InfoIconProps, InfoProvider, InfoQuery } from "./types";

const Specific: Component<InfoIconProps> = () => null;
const Default: Component<InfoIconProps> = () => null;

function hit(providerId: string): InfoHit {
  return { providerId, id: "x", priority: "context", precision: "point", title: "t" };
}

/** A minimal provider; `over` names the parts each case cares about. */
function provider(id: string, over: Partial<InfoProvider>): InfoProvider {
  const detail = (): InfoDetail => ({ sections: [] });
  return { id, label: id, queryAt: () => [], detail, ...over };
}

describe("iconForHit — the per-hit → default → chip fallback", () => {
  const providers: InfoProvider[] = [
    provider("both", { icon: () => Specific, defaultIcon: Default }),
    provider("null-icon", { icon: () => undefined, defaultIcon: Default }),
    provider("only-default", { defaultIcon: Default }),
    provider("bare", {}),
  ];

  test("a per-hit icon wins over the provider default", () => {
    expect(iconForHit(providers, hit("both"))).toBe(Specific);
  });

  test("a provider that declines this hit falls to its default icon", () => {
    expect(iconForHit(providers, hit("null-icon"))).toBe(Default);
  });

  test("a provider with no per-hit icon at all uses its default", () => {
    expect(iconForHit(providers, hit("only-default"))).toBe(Default);
  });

  test("a provider with neither yields nothing — the panel shows its chip", () => {
    expect(iconForHit(providers, hit("bare"))).toBeUndefined();
  });

  test("a hit whose provider is gone yields nothing", () => {
    expect(iconForHit(providers, hit("vanished"))).toBeUndefined();
  });
});

describe("queryInfoAt — a provider may supersede another's answer", () => {
  const QUERY: InfoQuery = { point: { x: 1, y: 1 }, lngLat: { lng: 10, lat: 56 }, radius: 8 };
  const h = (providerId: string, id: string, priority: InfoHit["priority"] = "area"): InfoHit => ({
    providerId,
    id,
    priority,
    precision: "area",
    title: `${providerId}/${id}`,
  });
  const answering = (id: string, hits: InfoHit[], over: Partial<InfoProvider> = {}): InfoProvider =>
    provider(id, { queryAt: () => hits, ...over });
  const titles = (providers: InfoProvider[]) => queryInfoAt(providers, QUERY).map((x) => x.title);

  test("the hits a provider names are dropped; everything else stays, in rank order", () => {
    const chart = answering("chart", [h("chart", "outline"), h("chart", "sounding", "depth")]);
    const better = answering("better", [h("better", "record")], {
      supersedes: (_own, others) => others.filter((o) => o.id === "outline"),
    });
    expect(titles([chart, better])).toEqual(["chart/sounding", "better/record"]);
  });

  test("independent of provider order", () => {
    const chart = answering("chart", [h("chart", "outline")]);
    const better = answering("better", [h("better", "record")], { supersedes: (_own, others) => others });
    expect(titles([chart, better])).toEqual(["better/record"]);
    expect(titles([better, chart])).toEqual(["better/record"]);
  });

  test("a provider that answered nothing supersedes nothing — its hook is not even asked", () => {
    let asked = 0;
    const chart = answering("chart", [h("chart", "outline")]);
    const silent = answering("better", [], {
      supersedes: (_own, others) => {
        asked++;
        return others;
      },
    });
    expect(titles([chart, silent])).toEqual(["chart/outline"]);
    expect(asked).toBe(0);
  });

  test("the hook sees its own hits and only OTHER providers' hits, and cannot drop its own", () => {
    const seen: { own: string[]; others: string[] }[] = [];
    const chart = answering("chart", [h("chart", "outline")]);
    const better = answering("better", [h("better", "a"), h("better", "b")], {
      supersedes: (own, others) => {
        seen.push({ own: own.map((x) => x.title), others: others.map((x) => x.title) });
        return own; // naming its own hits is ignored
      },
    });
    expect(titles([chart, better])).toEqual(["chart/outline", "better/a", "better/b"]);
    expect(seen).toEqual([{ own: ["better/a", "better/b"], others: ["chart/outline"] }]);
  });

  test("every hook judges the ORIGINAL answers: two providers superseding each other both lose theirs", () => {
    const a = answering("a", [h("a", "1")], { supersedes: (_own, others) => others });
    const b = answering("b", [h("b", "1")], { supersedes: (_own, others) => others });
    expect(titles([a, b])).toEqual([]);
  });
});
