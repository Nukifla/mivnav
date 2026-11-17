// The pure half of the mivport place editor: which fields a kind has, how
// they are grouped and shown, when a field applies, what is wrong with a
// value, and what an edit sends. No DOM, no Solid — ./PlaceEditor.tsx
// renders what this describes.
//
// Ported from the poi-testclient's place form (form.js: SECTIONS, ROWS,
// HINTS, `layout`, `applies`, `validate`, `build`). What can be entered comes
// from mivport's `/v1/attrs` (the boat's cached `/mivport/registry`): keys,
// types, ranges, the kinds each fits. The tables here only say how to present
// them; an attribute they don't list still shows, under "More details", with
// a control that fits its type. A new place sends only what was set; an edit
// only what changed.

import type {
  MivportAttr,
  MivportEditRequest,
  MivportGeom,
  MivportPlaceDetail,
  MivportRegistry,
  MivportSet,
} from "./types";

// ---------------------------------------------------------------------------
// Presentation tables

export type FormSectionId = "water" | "facilities" | "fees" | "access" | "contact" | "more";

/** A `when` value meaning "has any value". */
export const ANY = "\u0000any";

export interface FieldHint {
  /** `main` = the top block, under the name. */
  section: FormSectionId | "main";
  label?: string;
  /** Shares a line with others (`ROWS`); `sub` labels it there. */
  row?: keyof typeof ROWS;
  sub?: string;
  /** Shown beside the input. */
  unit?: string;
  /** A bool shown as a toggle chip (yes / no / not known); `no` labels "no". */
  chip?: boolean;
  no?: string;
  /** A bool as a two-way switch: labels for [false, true]. */
  choice?: readonly [string, string];
  /** Only applies while one of these attributes has that value (`ANY`: any
   * value), or while none of them fits the kind. */
  when?: Readonly<Record<string, unknown>>;
  multiline?: boolean;
  placeholder?: string;
  inputmode?: "numeric" | "decimal" | "url" | "tel" | "text";
  narrow?: boolean;
}

/** Sections in order. `primary`: the kind groups whose new places show it
 * open; for the others it waits behind an "Add …" button until it has a
 * value. */
export const FORM_SECTIONS: readonly { id: FormSectionId; primary: readonly string[] | "*" }[] = [
  { id: "water", primary: ["harbour", "anchoring"] },
  { id: "facilities", primary: ["harbour", "service"] },
  { id: "fees", primary: "*" },
  { id: "access", primary: ["facility"] },
  { id: "contact", primary: ["service", "shore"] },
  { id: "more", primary: "*" },
];

/** Fields shown together on one line, under one label. */
export const ROWS = {
  depth: { label: "Depth", range: true },
  fuelprice: { label: "Price per litre", range: false },
} as const;

/** Per attribute, in form order. Nothing has a default: a new place starts
 * with every detail not known. */
export const HINTS: Readonly<Record<string, FieldHint>> = {
  description: {
    section: "main",
    label: "Description",
    multiline: true,
    placeholder: "What should a sailor know? Approach, shelter, services nearby…",
  },

  depth_min_m: { section: "water", row: "depth", sub: "min", label: "Least depth", unit: "m" },
  depth_max_m: { section: "water", row: "depth", sub: "max", label: "Greatest depth", unit: "m" },
  max_length_m: { section: "water", label: "Max boat length", unit: "m", narrow: true },
  bottom: { section: "water", label: "Bottom" },
  holding: { section: "water", label: "Holding" },
  protection: { section: "water", label: "Shelter from wind" },

  diesel: { section: "facilities", chip: true, label: "Diesel", no: "No diesel" },
  petrol: { section: "facilities", chip: true, label: "Petrol", no: "No petrol" },
  water: { section: "facilities", chip: true, label: "Water", no: "No water" },
  electricity: { section: "facilities", chip: true, label: "Shore power", no: "No shore power" },
  wifi: { section: "facilities", chip: true, label: "Wi-Fi", no: "No Wi-Fi" },
  diesel_price: { section: "facilities", row: "fuelprice", sub: "Diesel", label: "Diesel price", when: { diesel: true } },
  petrol_price: { section: "facilities", row: "fuelprice", sub: "Petrol", label: "Petrol price", when: { petrol: true } },
  currency: {
    section: "facilities",
    row: "fuelprice",
    sub: "Currency",
    label: "Currency",
    when: { diesel_price: ANY, petrol_price: ANY },
  },

  fee: { section: "fees", label: "Fee", choice: ["Free", "Paid"] },
  payment: { section: "fees", label: "Pay by", when: { fee: true } },

  access: { section: "access", label: "Open to" },

  vhf: { section: "contact", label: "VHF channel", placeholder: "e.g. 12", inputmode: "numeric", narrow: true },
  phone: { section: "contact", label: "Phone", inputmode: "tel", placeholder: "+47 …" },
  website: { section: "contact", label: "Website", inputmode: "url", placeholder: "https://…" },
  opening_hours: { section: "contact", label: "Opening hours", placeholder: "e.g. Mo-Fr 08:00-17:00 (OSM syntax)" },
};
const ORDER = Object.keys(HINTS);

const VALUE_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  payment: { harbour_office: "At the office", honesty_box: "Honesty box", app: "App", machine: "Machine" },
  access: { customers: "Customers", members: "Members" },
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const humanize = (key: string) => cap(key.replace(/_m$/, "").replace(/_/g, " "));

export const hintOf = (key: string): FieldHint | undefined => HINTS[key];

export function labelOf(key: string): string {
  const h = HINTS[key];
  if (h?.label) return h.label;
  if (h?.row) return `${ROWS[h.row].label} ${h.sub ?? ""}`.trim();
  return humanize(key);
}

export const valueLabel = (key: string, v: unknown): string =>
  VALUE_LABELS[key]?.[String(v)] ?? cap(String(v).replace(/_/g, " "));

export function sectionOf(key: string): FormSectionId | "main" {
  const s = HINTS[key]?.section;
  return s === "main" || FORM_SECTIONS.some((x) => x.id === s) ? s! : "more";
}

export const fits = (a: MivportAttr, kind: string): boolean => !a.kinds?.length || a.kinds.includes(kind);

export const groupOf = (reg: MivportRegistry, kind: string): string =>
  reg.kinds.find((k) => k.name === kind)?.group ?? "other";

export const kindLabel = (reg: MivportRegistry, kind: string): string =>
  reg.kinds.find((k) => k.name === kind)?.label ?? humanize(kind);

const order = (k: string) => {
  const i = ORDER.indexOf(k);
  return i < 0 ? ORDER.length : i;
};

/** Every attribute of a kind, in form order (photos included). */
export function attrsFor(reg: MivportRegistry, kind: string): MivportAttr[] {
  return reg.attrs.filter((a) => fits(a, kind)).sort((a, b) => order(a.key) - order(b.key));
}

/** The attributes the form edits: not the banner photo (picked from photos). */
export const formAttrs = (reg: MivportRegistry, kind: string): MivportAttr[] =>
  attrsFor(reg, kind).filter((a) => a.type !== "photo");

export function sectionTitle(id: FormSectionId, kind: string, reg: MivportRegistry): string {
  switch (id) {
    case "water":
      if (kind === "anchorage") return "Anchoring";
      if (kind === "mooring") return "Mooring";
      return groupOf(reg, kind) === "harbour" ? "Berthing" : "Depth & shelter";
    case "facilities":
      return kind === "fuel" ? "Fuel" : "Facilities";
    case "fees":
      return reg.attrs.some((a) => a.key === "fee" && fits(a, kind)) ? "Fees & payment" : "Payment";
    case "access":
      return "Access";
    case "contact":
      return "Contact & hours";
    case "more":
      return "More details";
  }
}

// ---------------------------------------------------------------------------
// Layout

/** One form line: a field, a row of fields under one label, or the chips. */
export type FormItem =
  | { type: "field"; key: string }
  | { type: "row"; row: keyof typeof ROWS; keys: string[] }
  | { type: "chips"; keys: string[] };

export interface FormSection {
  id: FormSectionId;
  title: string;
  /** Open on a new place of this kind's group. */
  primary: boolean;
  items: FormItem[];
}

export const itemKeys = (it: FormItem): string[] => (it.type === "field" ? [it.key] : it.keys);

/** A kind's form: the top block's fields (under Name) and the sections. */
export function formLayout(reg: MivportRegistry, kind: string): { main: string[]; sections: FormSection[] } {
  const main: string[] = [];
  const bySec = new Map<FormSectionId, FormItem[]>(FORM_SECTIONS.map((s) => [s.id, []]));
  for (const a of formAttrs(reg, kind)) {
    const sec = sectionOf(a.key);
    if (sec === "main") {
      main.push(a.key);
      continue;
    }
    const items = bySec.get(sec)!;
    const h = HINTS[a.key];
    if (h?.row) {
      const it = items.find((i) => i.type === "row" && i.row === h.row);
      if (it && it.type === "row") it.keys.push(a.key);
      else items.push({ type: "row", row: h.row, keys: [a.key] });
    } else if (h?.chip && a.type === "bool") {
      const it = items.find((i) => i.type === "chips");
      if (it && it.type === "chips") it.keys.push(a.key);
      else items.push({ type: "chips", keys: [a.key] });
    } else items.push({ type: "field", key: a.key });
  }
  // A row that ended up with one field is just that field.
  for (const items of bySec.values()) {
    items.forEach((it, i) => {
      if (it.type === "row" && it.keys.length === 1) items[i] = { type: "field", key: it.keys[0] };
    });
  }
  const group = groupOf(reg, kind);
  const sections = FORM_SECTIONS.flatMap((s) => {
    const items = bySec.get(s.id)!;
    if (!items.length) return [];
    const primary = s.primary === "*" || s.primary.includes(group);
    return [{ id: s.id, title: sectionTitle(s.id, kind, reg), primary, items }];
  });
  return { main, sections };
}

/** Whether a section shows open: a primary one, one the skipper opened, one
 * with a value — or every section, when the kind has no primary one but
 * "More". */
export function sectionShown(
  sec: FormSection,
  all: readonly FormSection[],
  values: Readonly<Record<string, unknown>>,
  opened: ReadonlySet<string>,
): boolean {
  const anyPrimary = all.some((s) => s.primary && s.id !== "more");
  const hasValue = sec.items.some((it) => itemKeys(it).some((k) => norm(values[k]) !== null));
  return sec.primary || opened.has(sec.id) || hasValue || !anyPrimary;
}

// ---------------------------------------------------------------------------
// Values

/** A value as it would be sent: trimmed text, `null` for "not known" (an
 * empty string, list or rose). */
export function norm(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (Array.isArray(v)) return v.length ? [...v].sort() : null;
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined && x !== null);
    return entries.length ? Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : 1))) : null;
  }
  return v;
}

/** Equal regardless of list or key order. */
export const same = (a: unknown, b: unknown): boolean => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

const meets = (v: unknown, want: unknown) => (want === ANY ? v !== null : v === want);

/**
 * Whether a field applies: one with a `when` applies while a controlling
 * attribute has that value (a controller that doesn't apply itself counts as
 * empty). A stored value stays shown as long as its controllers are as they
 * were, so nothing already there is hidden — or removed — behind the
 * skipper's back. `present`: the keys the form has for this kind.
 */
export function applies(
  key: string,
  values: Readonly<Record<string, unknown>>,
  orig: Readonly<Record<string, unknown>>,
  present: ReadonlySet<string>,
  seen: ReadonlySet<string> = new Set(),
): boolean {
  const ctls = Object.entries(HINTS[key]?.when ?? {}).filter(([ctl]) => present.has(ctl));
  if (!ctls.length || seen.has(key)) return true;
  const inner = new Set([...seen, key]);
  const val = (ctl: string) => (applies(ctl, values, orig, present, inner) ? norm(values[ctl]) : null);
  return (
    ctls.some(([ctl, want]) => meets(val(ctl), want)) ||
    (norm(orig[key]) !== null && ctls.every(([ctl]) => same(val(ctl), orig[ctl])))
  );
}

/** The control a field gets. */
export type ControlKind =
  | "chip"
  | "choice"
  | "select"
  | "multi"
  | "wind"
  | "currency"
  | "number"
  | "text"
  | "textarea";

export function controlKind(a: MivportAttr): ControlKind {
  const h = HINTS[a.key];
  switch (a.type) {
    case "bool":
      return h?.chip ? "chip" : "choice";
    case "enum":
      return (a.values?.length ?? 0) > 5 ? "select" : "choice";
    case "enum_list":
      return "multi";
    case "wind_grade":
      return "wind";
    case "currency":
      return "currency";
    case "int":
    case "number":
      return "number";
    default:
      return h?.multiline || (a.max_len ?? 0) >= 1000 ? "textarea" : "text";
  }
}

/** The options of a one-of control: `[value, label]`. */
export function choiceOptions(a: MivportAttr): [unknown, string][] {
  if (a.type === "bool") {
    const c = HINTS[a.key]?.choice;
    return [
      [false, c?.[0] ?? "No"],
      [true, c?.[1] ?? "Yes"],
    ];
  }
  return (a.values ?? []).map((v) => [v, valueLabel(a.key, v)]);
}

/** A chip's next state: not known → yes → no → not known. */
export const nextChip = (v: unknown): boolean | null => (v === true ? false : v === false ? null : true);

/** A rose sector's next grade: through the grades, then not known. */
export function nextGrade(grades: readonly string[], g: string | undefined): string | undefined {
  const cycle = [...grades, undefined];
  return cycle[(cycle.indexOf(g) + 1) % cycle.length];
}

/** A number field's text → its value: `null` empty, the number, or the text
 * itself when it isn't one (kept, so the field can say so). */
export function parseNumber(text: string): number | string | null {
  const t = text.trim().replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : text;
}

export const isCurrency = (v: unknown): boolean => typeof v === "string" && /^[A-Z]{3}$/.test(v);

/** What is wrong with one field's value, if anything. */
export function fieldError(a: MivportAttr, v: unknown): string | undefined {
  const value = norm(v);
  if (value === null) return undefined;
  const h = HINTS[a.key];
  if (a.type === "int" || a.type === "number") {
    if (typeof value !== "number") return "Enter a number";
    if (a.type === "int" && !Number.isInteger(value)) return "Enter a whole number";
    if ((a.min !== undefined && value < a.min) || (a.max !== undefined && value > a.max)) {
      return `${labelOf(a.key)}: ${a.min ?? "…"} to ${a.max ?? "…"}${h?.unit ? ` ${h.unit}` : ""}`;
    }
    return undefined;
  }
  if (a.type === "currency") return isCurrency(value) ? undefined : "A three-letter currency code, like NOK";
  if (typeof value === "string" && a.max_len && value.length > a.max_len) return `At most ${a.max_len} characters`;
  return undefined;
}

/** Every field's problem, by key (only the fields that apply), plus a depth
 * range the wrong way round. */
export function formErrors(
  reg: MivportRegistry,
  kind: string,
  values: Readonly<Record<string, unknown>>,
  orig: Readonly<Record<string, unknown>> = {},
): Record<string, string> {
  const attrs = formAttrs(reg, kind);
  const present = new Set(attrs.map((a) => a.key));
  const out: Record<string, string> = {};
  for (const a of attrs) {
    if (!applies(a.key, values, orig, present)) continue;
    const e = fieldError(a, values[a.key]);
    if (e) out[a.key] = e;
  }
  const lo = norm(values.depth_min_m);
  const hi = norm(values.depth_max_m);
  if (!out.depth_min_m && !out.depth_max_m && typeof lo === "number" && typeof hi === "number" && lo > hi) {
    out.depth_max_m = "The least depth is more than the greatest";
  }
  return out;
}

// ---------------------------------------------------------------------------
// The edit

/** What the editor starts from. */
export interface PlaceOrigin {
  /** The place id; absent for a new place. */
  ref?: string;
  /** mivport has its own data for it (an OSM-only place does not: editing
   * one creates a mivport place linked to it). */
  isCore: boolean;
  kind?: string;
  /** Its own name ("" when it has none, or it comes from OSM). */
  name: string;
  /** The OSM name, shown as the placeholder of an OSM-only place. */
  osmName?: string;
  pos?: MivportGeom;
  /** mivport's own attributes. */
  attrs: Readonly<Record<string, unknown>>;
  rev?: number;
}

/** What the editor holds. */
export interface PlaceDraft {
  kind: string;
  name: string;
  pos?: MivportGeom;
  /** The skipper put the pin somewhere: an edit sends `geom` only then. */
  posMoved: boolean;
  values: Record<string, unknown>;
}

/** A new place at `at`, of `kind` (prefilled `name`, from a mark). */
export function newOrigin(at: MivportGeom | undefined): PlaceOrigin {
  return { isCore: false, name: "", attrs: {}, ...(at ? { pos: at } : {}) };
}

/** An existing place's editor start, from its (locally merged) detail. */
export function originFromDetail(d: MivportPlaceDetail, at?: MivportGeom): PlaceOrigin {
  const isCore = d.source === "core";
  const name = typeof d.name === "string" ? d.name : "";
  const pos =
    typeof d.lat === "number" && typeof d.lon === "number" && Number.isFinite(d.lat) && Number.isFinite(d.lon)
      ? { lat: d.lat, lon: d.lon }
      : at;
  return {
    ref: d.ref,
    isCore,
    kind: d.kind,
    name: isCore ? name : "",
    ...(isCore ? {} : name ? { osmName: name } : {}),
    ...(pos ? { pos } : {}),
    attrs: isCore && d.attrs && typeof d.attrs === "object" ? d.attrs : {},
    ...(typeof d.rev === "number" ? { rev: d.rev } : {}),
  };
}

/** The kind a new place starts as: an anchorage if mivport has one, else its
 * first kind. */
export function defaultKind(reg: MivportRegistry): string {
  return reg.kinds.some((k) => k.name === "anchorage") ? "anchorage" : (reg.kinds[0]?.name ?? "other");
}

export function initialDraft(origin: PlaceOrigin, reg: MivportRegistry, name = ""): PlaceDraft {
  const isNew = origin.ref === undefined;
  return {
    kind: origin.kind ?? defaultKind(reg),
    name: origin.name || name,
    ...(origin.pos ? { pos: origin.pos } : {}),
    // A new place's position is always sent.
    posMoved: isNew && origin.pos !== undefined,
    values: { ...origin.attrs },
  };
}

export interface BuiltEdit {
  /** `null`: nothing to send (an edit with no change). */
  request: MivportEditRequest | null;
  /** What changed, for the summary line. */
  labels: string[];
  /** Why it can't be sent (no position for a new place). */
  error?: string;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * What the editor sends. A new place: everything set (no empty fields). An
 * edit of a mivport place: only what changed, with `null` to remove, and on a
 * kind change the attributes the new kind doesn't have removed. An OSM-only
 * place: a modify of its `osm:` ref (the backend makes it a create linked to
 * the OSM element), with only what was entered.
 */
export function buildEdit(reg: MivportRegistry, origin: PlaceOrigin, draft: PlaceDraft): BuiltEdit {
  const isNew = origin.ref === undefined;
  const { isCore } = origin;
  const orig = origin.attrs;
  const attrs = formAttrs(reg, draft.kind);
  const present = new Set(attrs.map((a) => a.key));
  const patch: Record<string, unknown> = {};
  const labels: string[] = [];
  for (const a of attrs) {
    const v = applies(a.key, draft.values, orig, present) ? norm(draft.values[a.key]) : null;
    if (!same(v, orig[a.key])) {
      patch[a.key] = v;
      labels.push(labelOf(a.key));
    }
  }
  const kindChanged = !isNew && origin.kind !== undefined && draft.kind !== origin.kind;
  // On a kind change mivport checks every attribute against the new kind, so
  // the ones that don't fit it are removed; otherwise they are left alone.
  if (kindChanged) {
    const allowed = new Set(attrsFor(reg, draft.kind).map((a) => a.key));
    for (const k of Object.keys(orig)) {
      if (!allowed.has(k) && norm(orig[k]) !== null) {
        patch[k] = null;
        labels.push(`${labelOf(k)} (removed)`);
      }
    }
  }
  const set: MivportSet = {};
  const sendAttrs =
    isCore || isNew ? patch : Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null));
  if (Object.keys(sendAttrs).length) set.attrs = sendAttrs;

  const nm = draft.name.trim();
  if (isNew || !isCore) {
    if (nm) set.name = nm;
  } else if (nm !== origin.name.trim()) set.name = nm || null;
  if (!isNew && "name" in set) labels.unshift("Name");

  const geom = draft.pos ? { lat: round6(draft.pos.lat), lon: round6(draft.pos.lon) } : undefined;
  if (isNew) {
    if (geom) set.geom = geom;
  } else if (draft.posMoved && geom) {
    set.geom = geom;
    labels.unshift("Position");
  }

  if (isNew || !isCore || kindChanged) set.kind = draft.kind;
  if (kindChanged) labels.unshift("Kind");

  if (isNew) {
    if (!set.geom) return { request: null, labels, error: "Set the position on the chart" };
    return { request: { op: "create", set }, labels };
  }
  if (!isCore) return { request: { op: "modify", place_id: origin.ref, set }, labels };
  if (!labels.length) return { request: null, labels };
  return {
    request: {
      op: "modify",
      place_id: origin.ref,
      ...(origin.rev !== undefined ? { base_rev: origin.rev } : {}),
      set,
    },
    labels,
  };
}

/** "3 changes: Name, Depth min, Water" / "No changes yet". */
export function changeSummary(labels: readonly string[]): string {
  if (!labels.length) return "No changes yet";
  return `${labels.length} change${labels.length > 1 ? "s" : ""}: ${labels.join(", ")}`;
}

/** Kinds by group, for the kind picker, filtered by a search (accents and
 * case folded). */
export function kindGroups(
  reg: MivportRegistry,
  query = "",
): { group: string; kinds: MivportRegistry["kinds"] }[] {
  const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const q = fold(query.trim());
  const out = new Map<string, MivportRegistry["kinds"]>();
  for (const k of reg.kinds) {
    if (q && !fold(`${k.label} ${k.name} ${GROUP_LABELS[k.group] ?? k.group}`).includes(q)) continue;
    const list = out.get(k.group) ?? [];
    list.push(k);
    out.set(k.group, list);
  }
  return [...out].map(([group, kinds]) => ({ group, kinds }));
}

/** mivport's kind groups, worded. */
export const GROUP_LABELS: Readonly<Record<string, string>> = {
  harbour: "Harbours",
  anchoring: "Anchoring",
  service: "Services",
  facility: "Facilities",
  shore: "Shore",
  other: "Other",
};
