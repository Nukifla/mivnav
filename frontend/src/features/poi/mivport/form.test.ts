/**
 * The place editor's rules (./form.ts, ported from the poi-testclient's
 * form.js): which fields a kind has and how they group, when a field
 * applies, what is wrong with a value, and — the part mivport sees — what an
 * edit sends: everything set for a new place, only the changes for an edit,
 * a linked create for an OSM-only place.
 */

import { describe, expect, test } from "bun:test";
import {
  applies,
  buildEdit,
  changeSummary,
  choiceOptions,
  controlKind,
  defaultKind,
  formAttrs,
  formErrors,
  formLayout,
  initialDraft,
  kindGroups,
  labelOf,
  newOrigin,
  nextChip,
  nextGrade,
  norm,
  originFromDetail,
  parseNumber,
  same,
  sectionShown,
  type PlaceDraft,
  type PlaceOrigin,
} from "./form";
import type { MivportAttr, MivportPlaceDetail, MivportRegistry } from "./types";

const HARBOURS = ["marina", "harbour"];
const ANCHORING = ["anchorage", "mooring"];
const FUEL = [...HARBOURS, "fuel"];

const attrs: MivportAttr[] = [
  { key: "description", type: "string", max_len: 5000 },
  { key: "website", type: "string", max_len: 500 },
  { key: "phone", type: "string", max_len: 50 },
  { key: "vhf", type: "string", max_len: 10 },
  { key: "fee", type: "bool" },
  { key: "payment", type: "enum_list", values: ["cash", "card", "app"] },
  { key: "depth_min_m", type: "number", min: 0, max: 100, kinds: [...HARBOURS, ...ANCHORING] },
  { key: "depth_max_m", type: "number", min: 0, max: 100, kinds: [...HARBOURS, ...ANCHORING] },
  { key: "max_length_m", type: "number", min: 0, max: 500, kinds: HARBOURS },
  { key: "bottom", type: "enum_list", values: ["sand", "mud", "rock"], kinds: ["anchorage"] },
  { key: "holding", type: "enum", values: ["good", "fair", "poor"], kinds: ["anchorage"] },
  {
    key: "protection",
    type: "wind_grade",
    values: ["good", "fair", "poor", "none"],
    sectors: ["N", "NE", "E", "SE", "S", "SW", "W", "NW"],
    kinds: ANCHORING,
  },
  { key: "water", type: "bool", kinds: HARBOURS },
  { key: "electricity", type: "bool", kinds: HARBOURS },
  { key: "diesel", type: "bool", kinds: FUEL },
  { key: "petrol", type: "bool", kinds: FUEL },
  { key: "diesel_price", type: "number", min: 0, max: 1000, kinds: FUEL },
  { key: "petrol_price", type: "number", min: 0, max: 1000, kinds: FUEL },
  { key: "currency", type: "currency", kinds: FUEL },
  { key: "berths", type: "int", min: 0, max: 5000, kinds: HARBOURS },
  { key: "banner_photo", type: "photo" },
];

const REG: MivportRegistry = {
  kinds: [
    { name: "marina", group: "harbour", label: "Marina" },
    { name: "anchorage", group: "anchoring", label: "Anchorage" },
    { name: "fuel", group: "service", label: "Fuel station" },
    { name: "toilets", group: "facility", label: "Toilets" },
    { name: "viewpoint", group: "shore", label: "Viewpoint" },
  ],
  attrs,
  fetched_at: 1,
};

const editOf = (o: Partial<PlaceOrigin> & { ref: string }): PlaceOrigin => ({
  isCore: true,
  kind: "marina",
  name: "Havn",
  attrs: {},
  rev: 7,
  ...o,
});

const draftOf = (o: PlaceOrigin, change: Partial<PlaceDraft> = {}): PlaceDraft => ({
  ...initialDraft(o, REG),
  ...change,
});

describe("the form for a kind", () => {
  test("only the attributes that fit the kind, in form order, never the banner photo", () => {
    const keys = formAttrs(REG, "anchorage").map((a) => a.key);
    expect(keys).toEqual([
      "description",
      "depth_min_m",
      "depth_max_m",
      "bottom",
      "holding",
      "protection",
      "fee",
      "payment",
      "vhf",
      "phone",
      "website",
    ]);
    expect(formAttrs(REG, "marina").some((a) => a.key === "banner_photo")).toBe(false);
  });

  test("a marina: description on top, depths on one row, the bools as chips, unknown attrs in More", () => {
    const { main, sections } = formLayout(REG, "marina");
    expect(main).toEqual(["description"]);
    const water = sections.find((s) => s.id === "water")!;
    expect(water.title).toBe("Berthing");
    expect(water.items[0]).toEqual({ type: "row", row: "depth", keys: ["depth_min_m", "depth_max_m"] });
    const fac = sections.find((s) => s.id === "facilities")!;
    expect(fac.items.find((i) => i.type === "chips")).toEqual({
      type: "chips",
      keys: ["diesel", "petrol", "water", "electricity"],
    });
    expect(fac.items.find((i) => i.type === "row")).toEqual({
      type: "row",
      row: "fuelprice",
      keys: ["diesel_price", "petrol_price", "currency"],
    });
    expect(sections.find((s) => s.id === "more")!.items).toEqual([{ type: "field", key: "berths" }]);
    expect(sections.find((s) => s.id === "fees")!.title).toBe("Fees & payment");
  });

  test("section titles follow the kind: anchoring, fuel", () => {
    expect(formLayout(REG, "anchorage").sections.find((s) => s.id === "water")!.title).toBe("Anchoring");
    expect(formLayout(REG, "fuel").sections.find((s) => s.id === "facilities")!.title).toBe("Fuel");
  });

  test("primary sections open; the others wait behind Add until they hold a value or are opened", () => {
    const { sections } = formLayout(REG, "anchorage");
    const contact = sections.find((s) => s.id === "contact")!;
    const water = sections.find((s) => s.id === "water")!;
    expect(sectionShown(water, sections, {}, new Set())).toBe(true);
    expect(sectionShown(contact, sections, {}, new Set())).toBe(false);
    expect(sectionShown(contact, sections, { vhf: "16" }, new Set())).toBe(true);
    expect(sectionShown(contact, sections, {}, new Set(["contact"]))).toBe(true);
  });

  test("a kind with no primary section but More shows every section", () => {
    const reg: MivportRegistry = {
      kinds: [{ name: "toilets", group: "facility", label: "Toilets" }],
      attrs: [
        { key: "vhf", type: "string" },
        { key: "berths", type: "int" },
      ],
      fetched_at: 1,
    };
    const { sections } = formLayout(reg, "toilets");
    expect(sections.map((s) => [s.id, s.primary])).toEqual([
      ["contact", false],
      ["more", true],
    ]);
    expect(sections.every((s) => sectionShown(s, sections, {}, new Set()))).toBe(true);
  });

  test("controls by type", () => {
    const by = (k: string) => attrs.find((a) => a.key === k)!;
    expect(controlKind(by("water"))).toBe("chip");
    expect(controlKind(by("fee"))).toBe("choice");
    expect(controlKind(by("holding"))).toBe("choice");
    expect(controlKind(by("payment"))).toBe("multi");
    expect(controlKind(by("protection"))).toBe("wind");
    expect(controlKind(by("currency"))).toBe("currency");
    expect(controlKind(by("berths"))).toBe("number");
    expect(controlKind(by("description"))).toBe("textarea");
    expect(controlKind(by("vhf"))).toBe("text");
    expect(controlKind({ key: "x", type: "enum", values: ["a", "b", "c", "d", "e", "f"] })).toBe("select");
    expect(choiceOptions(by("fee"))).toEqual([
      [false, "Free"],
      [true, "Paid"],
    ]);
  });

  test("labels: hinted, row parts, humanized", () => {
    expect(labelOf("electricity")).toBe("Shore power");
    expect(labelOf("max_length_m")).toBe("Max boat length");
    expect(labelOf("berths")).toBe("Berths");
  });
});

describe("values", () => {
  test("norm: trimmed text, empty = not known, lists and roses order-free", () => {
    expect(norm("  x ")).toBe("x");
    expect(norm("  ")).toBeNull();
    expect(norm([])).toBeNull();
    expect(norm({})).toBeNull();
    expect(norm(undefined)).toBeNull();
    expect(same(["b", "a"], ["a", "b"])).toBe(true);
    expect(same({ N: "good", S: "poor" }, { S: "poor", N: "good" })).toBe(true);
    expect(same(false, null)).toBe(false);
  });

  test("a chip cycles not known → yes → no → not known; a sector through the grades", () => {
    expect(nextChip(null)).toBe(true);
    expect(nextChip(true)).toBe(false);
    expect(nextChip(false)).toBeNull();
    const g = ["good", "fair", "poor", "none"];
    expect(nextGrade(g, undefined)).toBe("good");
    expect(nextGrade(g, "poor")).toBe("none");
    expect(nextGrade(g, "none")).toBeUndefined();
  });

  test("numbers: empty is null, a comma is a decimal point, nonsense is kept to be flagged", () => {
    expect(parseNumber("")).toBeNull();
    expect(parseNumber("2,5")).toBe(2.5);
    expect(parseNumber("12")).toBe(12);
    expect(parseNumber("abc")).toBe("abc");
  });
});

describe("when a field applies", () => {
  const present = new Set(formAttrs(REG, "marina").map((a) => a.key));
  test("a fuel price only with that fuel; the currency only with a price", () => {
    expect(applies("diesel_price", {}, {}, present)).toBe(false);
    expect(applies("diesel_price", { diesel: true }, {}, present)).toBe(true);
    expect(applies("currency", { diesel: true }, {}, present)).toBe(false);
    expect(applies("currency", { diesel: true, diesel_price: 14 }, {}, present)).toBe(true);
    // A price whose fuel no longer applies doesn't count for the currency.
    expect(applies("currency", { diesel: false, diesel_price: 14 }, {}, present)).toBe(false);
  });

  test("pay by only with a fee", () => {
    expect(applies("payment", { fee: false }, {}, present)).toBe(false);
    expect(applies("payment", { fee: true }, {}, present)).toBe(true);
  });

  test("a stored value stays shown while its controller is as it was", () => {
    const orig = { diesel_price: 14 };
    expect(applies("diesel_price", {}, orig, present)).toBe(true);
    // The skipper changes the controller: now the rule speaks.
    expect(applies("diesel_price", { diesel: false }, orig, present)).toBe(false);
  });

  test("a controller the kind doesn't have doesn't hide the field", () => {
    const toilets = new Set(formAttrs(REG, "toilets").map((a) => a.key));
    expect(applies("payment", {}, {}, toilets)).toBe(false); // fee fits every kind
    const noFee = new Set([...toilets].filter((k) => k !== "fee"));
    expect(applies("payment", {}, {}, noFee)).toBe(true);
  });
});

describe("errors", () => {
  test("ranges, whole numbers, not-a-number, currency codes, lengths", () => {
    const e = formErrors(REG, "marina", {
      depth_min_m: 120,
      berths: 2.5,
      max_length_m: "abc",
      diesel: true,
      diesel_price: 14,
      currency: "kr",
      vhf: "12345678901",
    });
    expect(e.depth_min_m).toBe("Least depth: 0 to 100 m");
    expect(e.berths).toBe("Enter a whole number");
    expect(e.max_length_m).toBe("Enter a number");
    expect(e.currency).toBe("A three-letter currency code, like NOK");
    expect(e.vhf).toBe("At most 10 characters");
  });

  test("a depth range the wrong way round; a field that doesn't apply isn't checked", () => {
    expect(formErrors(REG, "marina", { depth_min_m: 5, depth_max_m: 2 }).depth_max_m).toBe(
      "The least depth is more than the greatest",
    );
    expect(formErrors(REG, "marina", { diesel_price: -3 })).toEqual({});
  });
});

describe("what a new place sends", () => {
  const at = { lat: 55.123456789, lon: 12.987654321 };

  test("only what was set, the kind, the name, and the position (rounded)", () => {
    const o = newOrigin(at);
    const d = draftOf(o, {
      kind: "anchorage",
      name: " Bugten ",
      values: { depth_min_m: 3, holding: "good", vhf: "", bottom: [], protection: { N: "good" } },
    });
    const built = buildEdit(REG, o, d);
    expect(built.request).toEqual({
      op: "create",
      set: {
        kind: "anchorage",
        name: "Bugten",
        geom: { lat: 55.123457, lon: 12.987654 },
        attrs: { depth_min_m: 3, holding: "good", protection: { N: "good" } },
      },
    });
  });

  test("no position: not sent, and says why", () => {
    const o = newOrigin(undefined);
    const built = buildEdit(REG, o, draftOf(o));
    expect(built.request).toBeNull();
    expect(built.error).toBe("Set the position on the chart");
  });

  test("a field that doesn't apply isn't sent (a price without its fuel)", () => {
    const o = newOrigin(at);
    const d = draftOf(o, { kind: "marina", values: { diesel: false, diesel_price: 14 } });
    expect(buildEdit(REG, o, d).request?.set?.attrs).toEqual({ diesel: false });
  });

  test("a new place starts as an anchorage, with a mark's name when given", () => {
    expect(defaultKind(REG)).toBe("anchorage");
    const d = initialDraft(newOrigin(at), REG, "Mark 3");
    expect(d).toEqual({ kind: "anchorage", name: "Mark 3", pos: at, posMoved: true, values: {} });
  });
});

describe("what an edit sends", () => {
  test("nothing changed: nothing to send", () => {
    const o = editOf({ ref: "u1", attrs: { vhf: "16" } });
    const built = buildEdit(REG, o, draftOf(o));
    expect(built.request).toBeNull();
    expect(changeSummary(built.labels)).toBe("No changes yet");
  });

  test("only the changes, null to remove, base_rev from the stored revision", () => {
    const o = editOf({ ref: "u1", attrs: { vhf: "16", phone: "+45 1", water: true } });
    const d = draftOf(o, { values: { vhf: "12", phone: "", water: true, electricity: false } });
    const built = buildEdit(REG, o, d);
    expect(built.request).toEqual({
      op: "modify",
      place_id: "u1",
      base_rev: 7,
      set: { attrs: { electricity: false, vhf: "12", phone: null } },
    });
    expect(changeSummary(built.labels)).toBe("3 changes: Shore power, VHF channel, Phone");
  });

  test("name: changed, or cleared to null; a position only when the pin moved", () => {
    const o = editOf({ ref: "u1", pos: { lat: 1, lon: 2 } });
    expect(buildEdit(REG, o, draftOf(o, { name: "" })).request?.set).toEqual({ name: null });
    expect(buildEdit(REG, o, draftOf(o, { pos: { lat: 1.5, lon: 2 }, posMoved: true })).request?.set).toEqual({
      geom: { lat: 1.5, lon: 2 },
    });
    expect(buildEdit(REG, o, draftOf(o, { pos: { lat: 9, lon: 9 }, posMoved: false })).request).toBeNull();
  });

  test("a kind change sends the kind and removes what the new kind doesn't have", () => {
    const o = editOf({ ref: "u1", attrs: { water: true, vhf: "16", depth_min_m: 2 } });
    const built = buildEdit(REG, o, draftOf(o, { kind: "toilets" }));
    expect(built.request?.set).toEqual({
      kind: "toilets",
      attrs: { depth_min_m: null, water: null },
    });
    expect(built.labels[0]).toBe("Kind");
  });

  test("a place only on the boat (no revision yet) is modified without base_rev", () => {
    const o = editOf({ ref: "u2", rev: undefined });
    expect(buildEdit(REG, o, draftOf(o, { name: "New" })).request).toEqual({
      op: "modify",
      place_id: "u2",
      set: { name: "New" },
    });
  });
});

describe("an OSM-only place", () => {
  const d: MivportPlaceDetail = {
    ref: "osm:n42",
    kind: "marina",
    name: "OSM Havn",
    source: "osm",
    attrs: { vhf: "9" },
    lat: 55,
    lon: 12,
    attribution: "",
    fetched_at: 1,
  };

  test("starts with no own name or attrs (the OSM name is only the placeholder)", () => {
    const o = originFromDetail(d);
    expect(o).toEqual({
      ref: "osm:n42",
      isCore: false,
      kind: "marina",
      name: "",
      osmName: "OSM Havn",
      pos: { lat: 55, lon: 12 },
      attrs: {},
    });
  });

  test("an edit is a modify of the osm ref with the kind and only what was entered (no nulls)", () => {
    const o = originFromDetail(d);
    const built = buildEdit(REG, o, draftOf(o, { values: { water: true, vhf: "" } }));
    expect(built.request).toEqual({
      op: "modify",
      place_id: "osm:n42",
      set: { kind: "marina", attrs: { water: true } },
    });
  });
});

describe("the kind picker", () => {
  test("groups in registry order, searched by label, name or group, accents folded", () => {
    expect(kindGroups(REG).map((g) => g.group)).toEqual(["harbour", "anchoring", "service", "facility", "shore"]);
    expect(kindGroups(REG, "ANCHOR").flatMap((g) => g.kinds.map((k) => k.name))).toEqual(["anchorage"]);
    expect(kindGroups(REG, "harbours").flatMap((g) => g.kinds.map((k) => k.name))).toEqual(["marina"]);
    expect(kindGroups(REG, "vïewpoint").flatMap((g) => g.kinds.map((k) => k.name))).toEqual(["viewpoint"]);
  });
});

describe("originFromDetail of a mivport place", () => {
  test("its name, attrs, revision and stored position", () => {
    const o = originFromDetail({
      ref: "u1",
      kind: "anchorage",
      name: "Bugten",
      source: "core",
      attrs: { holding: "good" },
      rev: 3,
      lat: 1,
      lon: 2,
      attribution: "",
      fetched_at: 1,
    });
    expect(o).toEqual({
      ref: "u1",
      isCore: true,
      kind: "anchorage",
      name: "Bugten",
      pos: { lat: 1, lon: 2 },
      attrs: { holding: "good" },
      rev: 3,
    });
  });

  test("no stored position: the local layer's, else none", () => {
    const base = { ref: "u1", kind: "x", source: "core" as const, attribution: "", fetched_at: 1 };
    expect(originFromDetail(base, { lat: 5, lon: 6 }).pos).toEqual({ lat: 5, lon: 6 });
    expect(originFromDetail(base).pos).toBeUndefined();
  });
});
