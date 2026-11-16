// The pure half of a mivport place's info-panel body: fetching the baked
// detail record (GET /api/poi/mivport/details/{set}/{ref}), merging mivport's
// own attributes over OpenStreetMap's, and turning them into the sections,
// rows, chips, wind-protection rose, reviews and photo credits the panel
// shows. No DOM, no Solid — ./MivportDetail.tsx renders what this builds.
//
// The presentation (sections, labels, units, value wording, fuel prices with
// the date they were set, the graded rose) follows the poi-testclient's
// place details (form.js `placeDetails`, `rowText`, `roseSvg`).
//
// Every value is user-edited data: it only ever reaches a TEXT node, and only
// http(s) URLs (plus tel:/mailto: built here) become links.

import type { MivportPhoto, MivportPlaceDetail, MivportReview } from "./types";

export type { MivportPhoto, MivportPlaceDetail, MivportReview };

// ---------------------------------------------------------------------------
// Fetch

export function mivportDetailUrl(setId: string, ref: string): string {
  return `/api/poi/mivport/details/${encodeURIComponent(setId)}/${encodeURIComponent(ref)}`;
}

/**
 * Read one place's baked detail. Offline-first: served from the boat's own
 * bake. Rejects with prose fit for the panel (`InfoNote.load` contract): the
 * panel shows the message verbatim.
 */
export async function fetchMivportDetail(
  setId: string,
  ref: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MivportPlaceDetail> {
  let res: Response;
  try {
    res = await fetchImpl(mivportDetailUrl(setId, ref));
  } catch {
    throw new Error("The boat’s server didn’t answer, so there are no place details right now.");
  }
  if (res.status === 404) {
    throw new Error(
      "No details downloaded for this place yet. They arrive with the POI dataset’s next bake.",
    );
  }
  if (!res.ok) throw new Error(`Couldn’t load the place details (HTTP ${res.status}).`);
  try {
    return (await res.json()) as MivportPlaceDetail;
  } catch {
    throw new Error("The server sent place details that couldn’t be read.");
  }
}

// ---------------------------------------------------------------------------
// Value helpers

const text = (v: unknown): string | undefined => {
  const t = typeof v === "string" ? v.trim() : "";
  return t || undefined;
};

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.flatMap((x) => (text(x) ? [text(x)!] : [])) : [];

const isSet = (v: unknown): boolean =>
  v !== undefined &&
  v !== null &&
  !(typeof v === "string" && !v.trim()) &&
  !(Array.isArray(v) && v.length === 0);

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** `"max_length_m"` → `"Max length"`. */
export const humanize = (key: string) => cap(key.replace(/_m$/, "").replace(/_/g, " ").trim());

/** Only http(s) URLs become links — everything here is user-entered. */
export function safeHttpUrl(url: unknown): string | undefined {
  const t = text(url);
  if (!t) return undefined;
  try {
    const u = new URL(t);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** A website as typed into mivport ("marina.dk") or read from OSM: a bare
 * host gets `https://`; anything else that isn't http(s) is no link. */
export function websiteHref(v: unknown): string | undefined {
  const t = text(v);
  if (!t) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return safeHttpUrl(t);
  return /^[^\s/]+\.[^\s/]+(\/\S*)?$/.test(t) ? safeHttpUrl(`https://${t}`) : undefined;
}

/** A link's visible text: the URL without its scheme or a trailing slash. */
export function linkLabel(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

/** `tel:` for a phone number with enough digits to dial. */
export function telHref(v: unknown): string | undefined {
  const t = text(v);
  if (!t) return undefined;
  const dial = t.replace(/[^\d+]/g, "");
  return dial.replace(/\D/g, "").length >= 3 ? `tel:${dial}` : undefined;
}

/** `mailto:` for one plain address. */
export function mailHref(v: unknown): string | undefined {
  const t = text(v);
  return t && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(t) ? `mailto:${t}` : undefined;
}

/** Filled/empty star string for a 0–5 rating, rounded to whole stars. */
export function starString(stars: number): string {
  const n = Math.max(0, Math.min(5, Math.round(stars)));
  return "★".repeat(n) + "☆".repeat(5 - n);
}

export interface FormatOpts {
  locale?: string;
  timeZone?: string;
  /** "Now", for whether a date needs its year (tests). */
  now?: Date;
  /** Preferred description language (default: the browser's). */
  lang?: string;
}

function parseDate(v: unknown): Date | undefined {
  const t = text(v);
  if (!t) return undefined;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** An ISO time → the viewer's locale date ("12 Nov 2026"). */
export function formatDate(iso: unknown, opts: FormatOpts = {}): string | undefined {
  const d = parseDate(iso);
  if (!d) return undefined;
  return new Intl.DateTimeFormat(opts.locale, { dateStyle: "medium", timeZone: opts.timeZone }).format(d);
}

/** A plain `YYYY-MM-DD` day (a review's visit) → locale date, never shifted
 * a day by the viewer's time zone. */
export function formatDay(day: unknown, opts: FormatOpts = {}): string | undefined {
  const t = text(day);
  if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return formatDate(`${t}T12:00:00Z`, { ...opts, timeZone: "UTC" });
}

/** When a price was set, short: "12 Nov", with the year only when it isn't
 * this year's — prices go stale, so the date matters. */
export function formatSetDate(iso: unknown, opts: FormatOpts = {}): string | undefined {
  const d = parseDate(iso);
  if (!d) return undefined;
  const year = (x: Date) =>
    new Intl.DateTimeFormat("en", { year: "numeric", timeZone: opts.timeZone }).format(x);
  const sameYear = year(d) === year(opts.now ?? new Date());
  return new Intl.DateTimeFormat(opts.locale, {
    day: "numeric",
    month: "short",
    year: sameYear ? undefined : "numeric",
    timeZone: opts.timeZone,
  }).format(d);
}

const metres = (n: number) => `${n} m`;

/** The depth line: "2.5–4 m", "at least 2 m", "up to 6 m". */
export function formatDepth(min: number | undefined, max: number | undefined): string | undefined {
  if (min !== undefined && max !== undefined) return min === max ? metres(min) : `${min}–${max} m`;
  if (min !== undefined) return `at least ${metres(min)}`;
  if (max !== undefined) return `up to ${metres(max)}`;
  return undefined;
}

/** A price per litre: "14.20 DKK/L" (no currency known: "14.20/L"). */
export function formatPrice(n: number, currency: string | undefined, opts: FormatOpts = {}): string {
  const v = new Intl.NumberFormat(opts.locale, { minimumFractionDigits: 2, maximumFractionDigits: 3 }).format(n);
  return currency ? `${v} ${currency}/L` : `${v}/L`;
}

// ---------------------------------------------------------------------------
// Attributes: mivport's own over OpenStreetMap's

/** The few raw OSM tags read when an older export has no `osm_attrs`. */
const OSM_TAG_FALLBACK: Readonly<Record<string, readonly string[]>> = {
  website: ["website", "contact:website", "url"],
  phone: ["phone", "contact:phone"],
  email: ["email", "contact:email"],
  opening_hours: ["opening_hours"],
  description: ["description"],
};

function fromOsmTags(tags: Record<string, string> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!tags || typeof tags !== "object") return out;
  for (const [key, names] of Object.entries(OSM_TAG_FALLBACK)) {
    for (const name of names) {
      const v = text(tags[name]);
      if (v) {
        out[key] = v;
        break;
      }
    }
  }
  return out;
}

/**
 * The place's attributes as mivport means them shown: `attrs.X` when set,
 * else `osm_attrs.X`; with no `osm_attrs` at all (an older export), the
 * obvious raw OSM tags (website, phone, email, opening hours, description).
 */
export function placeAttrs(d: MivportPlaceDetail): Record<string, unknown> {
  const osm =
    d.osm_attrs && typeof d.osm_attrs === "object" ? d.osm_attrs : fromOsmTags(d.osm_tags);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(osm)) if (isSet(v)) out[k] = v;
  if (d.attrs && typeof d.attrs === "object") {
    for (const [k, v] of Object.entries(d.attrs)) if (isSet(v)) out[k] = v;
  }
  return out;
}

/** The description to show: ours, else OSM's, else OSM's in the viewer's
 * language (then English, then any). Plain text. */
export function placeDescription(d: MivportPlaceDetail, opts: FormatOpts = {}): string | undefined {
  const own = text(placeAttrs(d).description);
  if (own) return own;
  const by = d.osm_attrs?.descriptions;
  if (!by || typeof by !== "object") return undefined;
  const all = by as Record<string, unknown>;
  const lang = (opts.lang ?? (typeof navigator !== "undefined" ? navigator.language : "en"))
    .toLowerCase()
    .split("-")[0];
  for (const want of [lang, "en"]) if (text(all[want])) return text(all[want]);
  for (const v of Object.values(all)) if (text(v)) return text(v);
  return undefined;
}

// ---------------------------------------------------------------------------
// Wind-protection rose

/** Compass order — also the order sectors are drawn in. */
export const WIND_DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
export type WindDir = (typeof WIND_DIRS)[number];
export const GRADES = ["good", "fair", "poor", "none"] as const;
export type Grade = (typeof GRADES)[number];
export type WindGrades = Partial<Record<WindDir, Grade>>;

/** A `protection` value cleaned up: only the 8 sectors and the 4 grades;
 * `undefined` when nothing usable is left. */
export function windGrades(v: unknown): WindGrades | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: WindGrades = {};
  for (const dir of WIND_DIRS) {
    const g = (v as Record<string, unknown>)[dir];
    if (typeof g === "string" && (GRADES as readonly string[]).includes(g)) out[dir] = g as Grade;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The rose's frame: viewBox -60..60, sectors between `inner` and `outer`
 * radius, `gap` degrees apart, compass letters at `label`. */
export const ROSE = { inner: 13, outer: 44, gap: 1.6, label: 53 } as const;

const f2 = (n: number) => {
  const s = n.toFixed(2);
  return s === "-0.00" ? "0.00" : s;
};
const polar = (rad: number, deg: number) => {
  const t = ((deg - 90) * Math.PI) / 180;
  return [rad * Math.cos(t), rad * Math.sin(t)] as const;
};

/** One sector of the ring, centred on `dir` (the test client's `roseSvg`). */
export function roseSectorPath(dir: WindDir): string {
  const i = WIND_DIRS.indexOf(dir);
  const step = 360 / WIND_DIRS.length;
  const a0 = i * step - step / 2 + ROSE.gap;
  const a1 = i * step + step / 2 - ROSE.gap;
  const pt = (rad: number, deg: number) => polar(rad, deg).map(f2).join(" ");
  const { inner: r, outer: R } = ROSE;
  return `M${pt(r, a0)} L${pt(R, a0)} A${R} ${R} 0 0 1 ${pt(R, a1)} L${pt(r, a1)} A${r} ${r} 0 0 0 ${pt(r, a0)} Z`;
}

/** Where `dir`'s letter sits. */
export function roseLabelPoint(dir: WindDir): { x: number; y: number } {
  const [x, y] = polar(ROSE.label, WIND_DIRS.indexOf(dir) * 45);
  return { x: Number(f2(x)), y: Number(f2(y)) };
}

/** The rose's text alternative: "N good, NE fair, …; E not known". */
export function roseDescription(g: WindGrades): string {
  const known = WIND_DIRS.filter((d) => g[d]).map((d) => `${d} ${g[d]}`);
  const unknown = WIND_DIRS.filter((d) => !g[d]);
  return `Shelter from wind: ${known.join(", ")}` + (unknown.length ? `; ${unknown.join(", ")} not known` : "");
}

// ---------------------------------------------------------------------------
// Sections

/** One label/value line; `href` makes the value a link, `note` is a muted
 * aside after it (a price's set date). */
export interface Fact {
  label: string;
  value: string;
  href?: string;
  note?: string;
}

/** A yes/no facility, shown as a chip. */
export interface Chip {
  label: string;
  yes: boolean;
}

export type SectionId = "water" | "facilities" | "fees" | "access" | "contact" | "more";

export interface DetailSection {
  id: SectionId;
  title: string;
  chips: Chip[];
  rows: Fact[];
  /** The `protection` rose (water section only). */
  rose?: WindGrades;
  /** Reference links (OSM's Wikipedia, image pages …). */
  links: { label: string; href: string }[];
}

const VALUE_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  payment: {
    cash: "Cash",
    card: "Card",
    app: "App",
    machine: "Machine",
    harbour_office: "At the office",
    honesty_box: "Honesty box",
  },
  access: { public: "Public", customers: "Customers", members: "Members", private: "Private" },
};

const valueLabel = (key: string, v: string) => VALUE_LABELS[key]?.[v] ?? cap(v.replace(/_/g, " "));

/** The facility chips: [key, yes label, no label]. */
const CHIPS: readonly (readonly [string, string, string])[] = [
  ["diesel", "Diesel", "No diesel"],
  ["petrol", "Petrol", "No petrol"],
  ["water", "Water", "No water"],
  ["electricity", "Shore power", "No shore power"],
  ["wifi", "Wi-Fi", "No Wi-Fi"],
];

/** OSM reference links, in order. */
const REF_LINKS: readonly (readonly [string, string])[] = [
  ["wikipedia", "Wikipedia"],
  ["wikidata", "Wikidata"],
  ["image", "Image"],
  ["wikimedia_commons", "Wikimedia Commons"],
  ["panoramax", "Panoramax"],
  ["mapillary", "Mapillary"],
];

/** Every key a section below places — anything else is "More". */
const KNOWN = new Set([
  "description",
  "descriptions",
  "banner_photo",
  "depth_min_m",
  "depth_max_m",
  "max_length_m",
  "bottom",
  "holding",
  "protection",
  ...CHIPS.map(([k]) => k),
  "diesel_price",
  "petrol_price",
  "currency",
  "fee",
  "charge",
  "payment",
  "access",
  "vhf",
  "phone",
  "email",
  "website",
  "opening_hours",
  "capacity",
  "seamark_information",
  ...REF_LINKS.map(([k]) => k),
]);

const HARBOUR_KINDS = new Set(["marina", "harbour"]);

function waterTitle(kind: string): string {
  if (kind === "anchorage") return "Anchoring";
  if (kind === "mooring") return "Mooring";
  return HARBOUR_KINDS.has(kind) ? "Berthing" : "Depth & shelter";
}

/** A generic value as text (for an attribute this client doesn't know). */
function plain(key: string, v: unknown): string | undefined {
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number" && Number.isFinite(v)) return key.endsWith("_m") ? metres(v) : String(v);
  if (typeof v === "string") return text(v);
  const list = strings(v);
  return list.length ? list.map((x) => valueLabel(key, x)).join(", ") : undefined;
}

/**
 * The place's details, grouped like the mivport test client: Berthing /
 * Anchoring (depth, length, bottom, holding, the shelter rose), Facilities /
 * Fuel (yes/no chips, prices with currency and set date), Fees & payment,
 * Access, Contact & hours, and More (OSM's chart note, capacity, reference
 * links, any attribute added since). Empty sections are left out.
 */
export function mivportSections(d: MivportPlaceDetail, opts: FormatOpts = {}): DetailSection[] {
  const a = placeAttrs(d);
  const own = d.attrs && typeof d.attrs === "object" ? d.attrs : {};
  const kind = text(d.kind) ?? "other";
  const section = (id: SectionId, title: string): DetailSection => ({ id, title, chips: [], rows: [], links: [] });
  const add = (s: DetailSection, label: string, value: string | undefined, href?: string, note?: string) => {
    if (!value) return;
    const f: Fact = { label, value };
    if (href) f.href = href;
    if (note) f.note = note;
    s.rows.push(f);
  };

  // --- water: berthing / anchoring
  const water = section("water", waterTitle(kind));
  add(water, "Depth", formatDepth(num(a.depth_min_m), num(a.depth_max_m)));
  const len = num(a.max_length_m);
  add(water, "Max boat length", len !== undefined ? metres(len) : undefined);
  const bottom = strings(a.bottom).map((b) => valueLabel("bottom", b));
  add(water, "Bottom", bottom.length ? bottom.join(", ") : undefined);
  const holding = text(a.holding);
  add(water, "Holding", holding ? valueLabel("holding", holding) : undefined);
  const rose = windGrades(a.protection);
  if (rose) water.rose = rose;

  // --- facilities / fuel
  const facilities = section("facilities", kind === "fuel" ? "Fuel" : "Facilities");
  for (const [key, yes, no] of CHIPS) {
    const v = bool(a[key]);
    if (v !== undefined) facilities.chips.push({ label: v ? yes : no, yes: v });
  }
  const currency = text(a.currency);
  for (const [key, label, flag] of [
    ["diesel_price", "Diesel", "diesel"],
    ["petrol_price", "Petrol", "petrol"],
  ] as const) {
    const price = num(a[key]);
    // No price for a fuel the place says it doesn't have.
    if (price === undefined || bool(a[flag]) === false) continue;
    // The set date is only known for our own value.
    const setAt = isSet(own[key]) ? formatSetDate(d.attrs_set_at?.[key], opts) : undefined;
    add(facilities, label, formatPrice(price, currency, opts), undefined, setAt ? `set ${setAt}` : undefined);
  }

  // --- fees & payment
  const fee = bool(a.fee);
  const fees = section("fees", fee !== undefined || text(a.charge) ? "Fees & payment" : "Payment");
  add(fees, "Fee", fee === undefined ? undefined : fee ? "Paid" : "Free");
  add(fees, "Charge", text(a.charge));
  const payment = strings(a.payment).map((p) => valueLabel("payment", p));
  // No "pay by" for a place that says it's free.
  if (fee !== false) add(fees, "Pay by", payment.length ? payment.join(", ") : undefined);

  // --- access
  const access = section("access", "Access");
  const openTo = text(a.access);
  add(access, "Open to", openTo ? valueLabel("access", openTo) : undefined);

  // --- contact & hours
  const contact = section("contact", "Contact & hours");
  const vhf = text(a.vhf) ?? (num(a.vhf) !== undefined ? String(a.vhf) : undefined);
  add(contact, "VHF", vhf && !/^ch/i.test(vhf) ? `Ch ${vhf}` : vhf);
  const phone = text(a.phone);
  add(contact, "Phone", phone, telHref(phone));
  const email = text(a.email);
  add(contact, "Email", email, mailHref(email));
  const site = websiteHref(a.website);
  add(contact, "Website", site ? linkLabel(site) : text(a.website), site);
  add(contact, "Opening hours", text(a.opening_hours));

  // --- more
  const more = section("more", "More");
  add(more, "Chart note", text(a.seamark_information));
  const capacity = num(a.capacity);
  add(more, "Capacity", capacity !== undefined ? String(capacity) : undefined);
  for (const [key, v] of Object.entries(a)) {
    if (KNOWN.has(key) || (v !== null && typeof v === "object" && !Array.isArray(v))) continue;
    add(more, humanize(key), plain(key, v));
  }
  for (const [key, label] of REF_LINKS) {
    const href = safeHttpUrl(a[key]);
    if (href) more.links.push({ label, href });
  }

  return [water, facilities, fees, access, contact, more].filter(
    (s) => s.rows.length || s.chips.length || s.rose || s.links.length,
  );
}

// ---------------------------------------------------------------------------
// Reviews, photos, footer

/** Average stars over the reviews that have a usable rating. */
export function averageStars(reviews: readonly MivportReview[] | undefined): number | undefined {
  const stars = (reviews ?? []).map((r) => num(r.stars)).filter((s): s is number => s !== undefined && s > 0);
  return stars.length ? stars.reduce((x, y) => x + y, 0) / stars.length : undefined;
}

/** A review's byline after the name: "visited 1 Jul 2026 · 3 Jul 2026". */
export function reviewMeta(r: MivportReview, opts: FormatOpts = {}): string | undefined {
  const visited = formatDay(r.visited_on, opts);
  const written = formatDate(r.created_at, opts);
  const parts = [visited ? `visited ${visited}` : undefined, written].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

/**
 * Where to load a photo from: the boat's copy (a path relative to the API
 * root, served under `/api` like every backend path), else a remote http(s)
 * URL (`remote: true` — only loads while online). Anything else → undefined.
 */
export function photoSrc(url: unknown): string | undefined {
  const t = text(url);
  if (!t) return undefined;
  if (t.startsWith("/") && !t.startsWith("//") && !t.includes("..") && !t.includes("\\")) return `/api${t}`;
  return safeHttpUrl(t);
}

/** One photo ready to show. */
export interface ShownPhoto {
  url: string;
  thumb: string;
  caption?: string;
  attribution?: string;
  /** The licence page, http(s) only. */
  licenseHref?: string;
}

/** The place's photos that have somewhere to load from. */
export function shownPhotos(d: MivportPlaceDetail): ShownPhoto[] {
  return (d.photos ?? []).flatMap((p) => {
    const url = photoSrc(p.url);
    if (!url) return [];
    const out: ShownPhoto = { url, thumb: photoSrc(p.thumb_url) ?? url };
    const caption = text(p.caption);
    const attribution = text(p.attribution);
    const licenseHref = safeHttpUrl(p.license_url);
    if (caption) out.caption = caption;
    if (attribution) out.attribution = attribution;
    if (licenseHref) out.licenseHref = licenseHref;
    return [out];
  });
}

/** The full-screen viewer's caption: the photo's caption and its credit, so
 * the credit is on screen with the photo. */
export function lightboxCaption(p: ShownPhoto): string | undefined {
  const parts = [p.caption, p.attribution].filter(Boolean);
  return parts.length ? parts.join(" — ") : undefined;
}

/** The photos' credits, each once: "© Anna (CC BY-SA 4.0)" linked to its
 * licence. */
export function photoCredits(photos: readonly ShownPhoto[]): { text: string; href?: string }[] {
  const seen = new Set<string>();
  const out: { text: string; href?: string }[] = [];
  for (const p of photos) {
    if (!p.attribution) continue;
    const key = `${p.attribution}\n${p.licenseHref ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p.licenseHref ? { text: p.attribution, href: p.licenseHref } : { text: p.attribution });
  }
  return out;
}

/** The place's OpenStreetMap element page. */
export function osmElementUrl(osm: MivportPlaceDetail["osm"]): string | undefined {
  if (!osm || !["node", "way", "relation"].includes(osm.type)) return undefined;
  if (!Number.isSafeInteger(osm.id) || osm.id <= 0) return undefined;
  return `https://www.openstreetmap.org/${osm.type}/${osm.id}`;
}

/** The place in the mivport web client (http(s) only). */
export function mivportWebUrl(d: MivportPlaceDetail): string | undefined {
  return safeHttpUrl(d.web_url);
}
