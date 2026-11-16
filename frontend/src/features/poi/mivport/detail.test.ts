/**
 * The pure half of the mivport info body (./detail.ts): ours-over-OSM attrs
 * (and the raw-tag fallback), the sections with their units, value wording,
 * fuel prices with set dates, the shelter rose, photos/credits, and the
 * detail fetch's mariner-readable errors.
 */

import { describe, expect, test } from "bun:test";
import {
  averageStars,
  fetchMivportDetail,
  formatDepth,
  formatSetDate,
  lightboxCaption,
  mailHref,
  mivportSections,
  mivportWebUrl,
  osmElementUrl,
  photoCredits,
  photoSrc,
  placeAttrs,
  placeDescription,
  reviewMeta,
  roseDescription,
  roseLabelPoint,
  roseSectorPath,
  safeHttpUrl,
  shownPhotos,
  starString,
  telHref,
  websiteHref,
  WIND_DIRS,
  windGrades,
  type MivportPlaceDetail,
} from "./detail";

const OPTS = { locale: "en-GB", timeZone: "UTC", now: new Date(Date.UTC(2026, 10, 17)), lang: "da" };

const place = (extra: Partial<MivportPlaceDetail> = {}): MivportPlaceDetail => ({
  ref: "osm:w1",
  kind: "marina",
  source: "core",
  attribution: "© OpenStreetMap contributors (ODbL); © mivport contributors (ODbL)",
  fetched_at: 1,
  ...extra,
});

const section = (d: MivportPlaceDetail, id: string) => mivportSections(d, OPTS).find((s) => s.id === id);

describe("placeAttrs (ours over OSM)", () => {
  test("attrs.X wins over osm_attrs.X; OSM fills the gaps; empty values don't count", () => {
    const d = place({
      attrs: { vhf: "12", website: "", fee: false },
      osm_attrs: { vhf: "16", website: "https://osm.example/", wifi: true, fee: true },
    });
    expect(placeAttrs(d)).toEqual({ vhf: "12", website: "https://osm.example/", wifi: true, fee: false });
  });

  test("no osm_attrs (older export): the obvious raw tags, contact:* as fallback", () => {
    const d = place({
      osm_tags: {
        "contact:website": "https://h.dk",
        phone: "+45 1",
        "contact:phone": "+45 2",
        opening_hours: "Mo-Fr 08:00-16:00",
        description: "Small harbour",
        "seamark:type": "harbour",
      },
    });
    expect(placeAttrs(d)).toEqual({
      website: "https://h.dk",
      phone: "+45 1",
      opening_hours: "Mo-Fr 08:00-16:00",
      description: "Small harbour",
    });
  });

  test("with osm_attrs present, raw tags are not read", () => {
    expect(placeAttrs(place({ osm_attrs: {}, osm_tags: { phone: "+45 1" } }))).toEqual({});
  });
});

describe("placeDescription", () => {
  test("ours, else OSM's, else OSM's by language (viewer's, then English, then any)", () => {
    expect(placeDescription(place({ attrs: { description: " Ours " }, osm_attrs: { description: "OSM" } }), OPTS)).toBe("Ours");
    expect(placeDescription(place({ osm_attrs: { description: "OSM" } }), OPTS)).toBe("OSM");
    const by = (descriptions: Record<string, string>) => place({ osm_attrs: { descriptions } });
    expect(placeDescription(by({ en: "English", da: "Dansk" }), OPTS)).toBe("Dansk");
    expect(placeDescription(by({ en: "English", de: "Deutsch" }), OPTS)).toBe("English");
    expect(placeDescription(by({ de: "Deutsch" }), OPTS)).toBe("Deutsch");
    expect(placeDescription(place(), OPTS)).toBeUndefined();
  });
});

describe("mivportSections", () => {
  test("nothing known → no sections", () => {
    expect(mivportSections(place(), OPTS)).toEqual([]);
  });

  test("berthing: depth range, length, and the section's title by kind", () => {
    const s = section(place({ attrs: { depth_min_m: 2.5, depth_max_m: 4, max_length_m: 15 } }), "water")!;
    expect(s.title).toBe("Berthing");
    expect(s.rows).toEqual([
      { label: "Depth", value: "2.5–4 m" },
      { label: "Max boat length", value: "15 m" },
    ]);
    expect(section(place({ kind: "anchorage", attrs: { holding: "good" } }), "water")!.title).toBe("Anchoring");
    expect(section(place({ kind: "mooring", attrs: { depth_min_m: 3 } }), "water")!.title).toBe("Mooring");
    expect(section(place({ kind: "other", attrs: { depth_min_m: 3 } }), "water")!.title).toBe("Depth & shelter");
  });

  test("anchoring: bottom list, holding, and the rose", () => {
    const s = section(
      place({
        kind: "anchorage",
        attrs: { bottom: ["sand", "weed"], holding: "fair", protection: { N: "good", SW: "none", X: "good" } },
      }),
      "water",
    )!;
    expect(s.rows).toEqual([
      { label: "Bottom", value: "Sand, Weed" },
      { label: "Holding", value: "Fair" },
    ]);
    expect(s.rose).toEqual({ N: "good", SW: "none" });
  });

  test("facilities: yes/no chips in order; fuel prices with currency and set date", () => {
    const d = place({
      attrs: { water: true, diesel: true, electricity: false, diesel_price: 14.2, petrol_price: 15, currency: "DKK" },
      attrs_set_at: { diesel_price: "2026-11-12T10:00:00Z", petrol_price: "2025-06-01T10:00:00Z" },
      osm_attrs: { wifi: true },
    });
    const s = section(d, "facilities")!;
    expect(s.title).toBe("Facilities");
    expect(s.chips).toEqual([
      { label: "Diesel", yes: true },
      { label: "Water", yes: true },
      { label: "No shore power", yes: false },
      { label: "Wi-Fi", yes: true },
    ]);
    expect(s.rows).toEqual([
      { label: "Diesel", value: "14.20 DKK/L", note: "set 12 Nov" },
      { label: "Petrol", value: "15.00 DKK/L", note: "set 1 Jun 2025" },
    ]);
    expect(section(place({ kind: "fuel", attrs: { diesel: true } }), "facilities")!.title).toBe("Fuel");
  });

  test("no price for a fuel the place says it lacks; no date without one", () => {
    const s = section(place({ attrs: { petrol: false, petrol_price: 2, diesel_price: 1.9 } }), "facilities")!;
    expect(s.rows).toEqual([{ label: "Diesel", value: "1.90/L" }]);
  });

  test("fees & payment: free hides 'pay by'; payment wording", () => {
    expect(section(place({ attrs: { fee: true, payment: ["card", "honesty_box", "harbour_office"] } }), "fees")).toEqual({
      id: "fees",
      title: "Fees & payment",
      chips: [],
      rows: [
        { label: "Fee", value: "Paid" },
        { label: "Pay by", value: "Card, Honesty box, At the office" },
      ],
      links: [],
    });
    expect(section(place({ attrs: { fee: false, payment: ["cash"] } }), "fees")!.rows).toEqual([
      { label: "Fee", value: "Free" },
    ]);
    const pay = section(place({ kind: "fuel", attrs: { payment: ["app"] } }), "fees")!;
    expect(pay.title).toBe("Payment");
    expect(section(place({ osm_attrs: { charge: "50 DKK" } }), "fees")!.rows).toEqual([
      { label: "Charge", value: "50 DKK" },
    ]);
  });

  test("access", () => {
    expect(section(place({ attrs: { access: "customers" } }), "access")!.rows).toEqual([
      { label: "Open to", value: "Customers" },
    ]);
  });

  test("contact & hours: VHF channel, tel/mailto/website links, hours as text", () => {
    const s = section(
      place({
        attrs: { vhf: "12", phone: "+45 12 34", website: "marina.dk" },
        osm_attrs: { email: "hm@marina.dk", opening_hours: "Mo-Su 08:00-20:00", vhf: "16" },
      }),
      "contact",
    )!;
    expect(s.rows).toEqual([
      { label: "VHF", value: "Ch 12" },
      { label: "Phone", value: "+45 12 34", href: "tel:+451234" },
      { label: "Email", value: "hm@marina.dk", href: "mailto:hm@marina.dk" },
      { label: "Website", value: "marina.dk", href: "https://marina.dk/" },
      { label: "Opening hours", value: "Mo-Su 08:00-20:00" },
    ]);
  });

  test("a website that can't be a safe link stays text", () => {
    const s = section(place({ attrs: { website: "javascript:alert(1)" } }), "contact")!;
    expect(s.rows).toEqual([{ label: "Website", value: "javascript:alert(1)" }]);
  });

  test("more: chart note, capacity, reference links (http(s) only), unknown attrs humanized", () => {
    const s = section(
      place({
        attrs: { new_thing_m: 3, berths_free: true },
        osm_attrs: {
          seamark_information: "Leading lights 045°",
          capacity: 120,
          wikipedia: "https://da.wikipedia.org/wiki/R%C3%B8nne_Havn",
          image: "ftp://nope",
          descriptions: { en: "x" },
        },
      }),
      "more",
    )!;
    expect(s.rows).toEqual([
      { label: "Chart note", value: "Leading lights 045°" },
      { label: "Capacity", value: "120" },
      { label: "New thing", value: "3 m" },
      { label: "Berths free", value: "Yes" },
    ]);
    expect(s.links).toEqual([{ label: "Wikipedia", href: "https://da.wikipedia.org/wiki/R%C3%B8nne_Havn" }]);
  });

  test("section order follows the test client", () => {
    const d = place({
      attrs: { vhf: "9", access: "public", fee: true, water: true, depth_min_m: 2 },
      osm_attrs: { capacity: 5 },
    });
    expect(mivportSections(d, OPTS).map((s) => s.id)).toEqual(["water", "facilities", "fees", "access", "contact", "more"]);
  });
});

describe("wind rose", () => {
  test("windGrades keeps only the 8 sectors and 4 grades", () => {
    expect(windGrades({ N: "good", NE: "bad", E: "fair", NNE: "good", S: 3 })).toEqual({ N: "good", E: "fair" });
    expect(windGrades({})).toBeUndefined();
    expect(windGrades("N")).toBeUndefined();
    expect(windGrades(["good"])).toBeUndefined();
  });

  // The test client's roseSvg geometry (form.js): -20.9° to 20.9°, radii 13 and 44.
  test("sectors: one ring wedge per direction, N centred on top", () => {
    expect(roseSectorPath("N")).toBe(
      "M-4.64 -12.14 L-15.70 -41.10 A44 44 0 0 1 15.70 -41.10 L4.64 -12.14 A13 13 0 0 0 -4.64 -12.14 Z",
    );
    const paths = WIND_DIRS.map(roseSectorPath);
    expect(new Set(paths).size).toBe(8);
    expect(roseLabelPoint("N")).toEqual({ x: 0, y: -53 });
    expect(roseLabelPoint("E")).toEqual({ x: 53, y: 0 });
  });

  test("text alternative names the known and the unknown", () => {
    expect(roseDescription({ N: "good", S: "poor" })).toBe(
      "Shelter from wind: N good, S poor; NE, E, SE, SW, W, NW not known",
    );
  });
});

describe("photos", () => {
  const photo = (url: string, extra = {}) => ({ id: "p", url, thumb_url: `${url}?t`, attribution: "© Anna (CC BY-SA 4.0)", ...extra });

  test("photoSrc: API-relative under /api, remote http(s), nothing else", () => {
    expect(photoSrc("/poi/mivport/photos/dk/a.jpg")).toBe("/api/poi/mivport/photos/dk/a.jpg");
    expect(photoSrc("https://mivport.example/v1/photos/a/view")).toBe("https://mivport.example/v1/photos/a/view");
    expect(photoSrc("/poi/../../etc/passwd")).toBeUndefined();
    expect(photoSrc("//evil.example/x.jpg")).toBeUndefined();
    expect(photoSrc("javascript:alert(1)")).toBeUndefined();
    expect(photoSrc("data:image/png;base64,AA")).toBeUndefined();
    expect(photoSrc(undefined)).toBeUndefined();
  });

  test("shownPhotos: thumb + view, caption/credit/licence; unusable ones dropped", () => {
    const d = place({
      photos: [
        photo("/p/1.jpg", { caption: "Fuel dock", license_url: "https://creativecommons.org/licenses/by-sa/4.0/" }),
        photo("javascript:x"),
        { id: "r", url: "https://x.example/2.jpg", thumb_url: "", attribution: "", remote: true },
      ],
    });
    expect(shownPhotos(d)).toEqual([
      {
        url: "/api/p/1.jpg",
        thumb: "/api/p/1.jpg?t",
        caption: "Fuel dock",
        attribution: "© Anna (CC BY-SA 4.0)",
        licenseHref: "https://creativecommons.org/licenses/by-sa/4.0/",
      },
      { url: "https://x.example/2.jpg", thumb: "https://x.example/2.jpg" },
    ]);
  });

  test("credits: each attribution once, linked to its licence; the viewer caption carries it", () => {
    const shown = shownPhotos(
      place({
        photos: [
          photo("/1", { license_url: "https://l/" }),
          photo("/2", { license_url: "https://l/" }),
          photo("/3", { attribution: "© Bo", license_url: "ftp://x" }),
        ],
      }),
    );
    expect(photoCredits(shown)).toEqual([{ text: "© Anna (CC BY-SA 4.0)", href: "https://l/" }, { text: "© Bo" }]);
    expect(lightboxCaption({ url: "u", thumb: "t", caption: "Dock", attribution: "© Bo" })).toBe("Dock — © Bo");
    expect(lightboxCaption({ url: "u", thumb: "t" })).toBeUndefined();
  });
});

describe("reviews", () => {
  test("average over usable ratings; byline dates", () => {
    expect(averageStars([{ id: "1", user: "a", stars: 5 }, { id: "2", user: "b", stars: 2 }])).toBe(3.5);
    expect(averageStars([])).toBeUndefined();
    expect(averageStars(undefined)).toBeUndefined();
    expect(reviewMeta({ id: "1", user: "a", stars: 4, visited_on: "2026-07-01", created_at: "2026-07-03T09:00:00Z" }, OPTS)).toBe(
      "visited 1 Jul 2026 · 3 Jul 2026",
    );
    expect(reviewMeta({ id: "1", user: "a", stars: 4 }, OPTS)).toBeUndefined();
    expect(starString(3.6)).toBe("★★★★☆");
    expect(starString(9)).toBe("★★★★★");
  });
});

describe("small helpers", () => {
  test("links: http(s) only; bare hosts get https; tel/mailto sanity", () => {
    expect(safeHttpUrl("https://a.dk/")).toBe("https://a.dk/");
    expect(safeHttpUrl("javascript:alert(1)")).toBeUndefined();
    expect(websiteHref("www.a.dk/havn")).toBe("https://www.a.dk/havn");
    expect(websiteHref("http://a.dk")).toBe("http://a.dk/");
    expect(websiteHref("call us")).toBeUndefined();
    expect(websiteHref("mailto:x@y.z")).toBeUndefined();
    expect(telHref("+45 12 34 56 78")).toBe("tel:+4512345678");
    expect(telHref("n/a")).toBeUndefined();
    expect(mailHref("hm@a.dk")).toBe("mailto:hm@a.dk");
    expect(mailHref("not an address")).toBeUndefined();
  });

  test("depth wording", () => {
    expect(formatDepth(2, 2)).toBe("2 m");
    expect(formatDepth(2, undefined)).toBe("at least 2 m");
    expect(formatDepth(undefined, 6)).toBe("up to 6 m");
    expect(formatDepth(undefined, undefined)).toBeUndefined();
  });

  test("set date: year only when not this year; nonsense → undefined", () => {
    expect(formatSetDate("2026-03-05T00:00:00Z", OPTS)).toBe("5 Mar");
    expect(formatSetDate("2024-03-05T00:00:00Z", OPTS)).toBe("5 Mar 2024");
    expect(formatSetDate("yesterday", OPTS)).toBeUndefined();
  });

  test("footer links: OSM element page and the mivport web client (http(s) only)", () => {
    expect(osmElementUrl({ type: "way", id: 42 })).toBe("https://www.openstreetmap.org/way/42");
    expect(osmElementUrl({ type: "node", id: -1 })).toBeUndefined();
    expect(osmElementUrl(undefined)).toBeUndefined();
    expect(mivportWebUrl(place({ web_url: "https://mivport.example/#place/osm:w1" }))).toBe(
      "https://mivport.example/#place/osm:w1",
    );
    expect(mivportWebUrl(place({ web_url: "javascript:alert(1)" }))).toBeUndefined();
  });
});

describe("fetchMivportDetail", () => {
  const fake = (impl: () => Promise<Response>) => (() => impl()) as unknown as typeof fetch;

  test("hits /api/poi/mivport/details/{set}/{ref} (both encoded) and returns the JSON", async () => {
    let seen = "";
    const f = ((url: string) => {
      seen = url;
      return Promise.resolve(new Response(JSON.stringify(place())));
    }) as unknown as typeof fetch;
    expect(await fetchMivportDetail("dk mivport", "osm:w1", f)).toEqual(place());
    expect(seen).toBe("/api/poi/mivport/details/dk%20mivport/osm%3Aw1");
  });

  test("404 → 'no details downloaded'", async () => {
    await expect(
      fetchMivportDetail("s", "x", fake(() => Promise.resolve(new Response("", { status: 404 })))),
    ).rejects.toThrow(/No details downloaded for this place/);
  });

  test("network failure → the boat's server didn't answer", async () => {
    await expect(fetchMivportDetail("s", "x", fake(() => Promise.reject(new TypeError("fetch failed"))))).rejects.toThrow(
      /didn’t answer/,
    );
  });

  test("other status → HTTP code; unreadable body → its own message", async () => {
    await expect(
      fetchMivportDetail("s", "x", fake(() => Promise.resolve(new Response("", { status: 500 })))),
    ).rejects.toThrow("Couldn’t load the place details (HTTP 500).");
    await expect(
      fetchMivportDetail("s", "x", fake(() => Promise.resolve(new Response("{nope")))),
    ).rejects.toThrow(/couldn’t be read/);
  });
});
