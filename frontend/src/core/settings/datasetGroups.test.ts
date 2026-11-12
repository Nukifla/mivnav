import { describe, expect, test } from "bun:test";
import type { DatasetEntry, ProviderCatalogEntry } from "./DatasetList";
import {
  groupDatasets,
  groupStatus,
  planGroupSave,
  sharedSchedule,
  variantLabel,
  type GroupDraft,
} from "./datasetGroups";
import type { Region } from "./regions";

const providers: ProviderCatalogEntry[] = [
  {
    id: "poi",
    label: "POI (points of interest)",
    implementation_labels: { overpass: "POI (OSM)", acme: "POI (Acme)" },
    default_implementation: "overpass",
    creatable: true,
    region_kind: "bbox",
  },
  { id: "satellite", label: "Satellite imagery", creatable: true, region_kind: "bbox" },
  { id: "notices", label: "Notices to mariners", creatable: true, region_kind: "none" },
];

const regions = [
  { id: "dk", name: "Denmark" },
  { id: "no", name: "Norway" },
  { id: "se", name: "Sweden" },
] as unknown as Region[];

function ds(over: Partial<DatasetEntry> & Pick<DatasetEntry, "id">): DatasetEntry {
  return {
    provider: "poi",
    name: over.id,
    region_id: "dk",
    mode: "bake",
    implementation: null,
    schedule: "manual",
    ttl_s: null,
    params: {},
    enabled: true,
    size: 100,
    last_bake_at: null,
    status: "baked",
    progress: null,
    declared: true,
    ...over,
  };
}

const osmDk = ds({ id: "osm-dk" });
const osmNo = ds({ id: "osm-no", region_id: "no" });
const acmeNo = ds({ id: "acme-no", region_id: "no", implementation: "acme", params: { download_photos: true } });
const notices = ds({ id: "notices", provider: "notices", region_id: null });
const orphan = ds({ id: "old-set", declared: false });

describe("groupDatasets", () => {
  const { groups, rest } = groupDatasets([osmDk, notices, acmeNo, osmNo, orphan], providers);

  test("one card per region-based provider; the rest stay plain rows", () => {
    expect(groups.map((g) => g.provider)).toEqual(["poi"]);
    expect(rest.map((d) => d.id)).toEqual(["notices", "old-set"]);
  });

  test("regions down, sources across", () => {
    const g = groups[0]!;
    expect(g.regionIds).toEqual(["dk", "no"]);
    expect(g.variants.map((v) => v.ids)).toEqual([["osm-dk", "osm-no"], ["acme-no"]]);
  });

  test("implementation null and the provider default are one source", () => {
    const explicit = ds({ id: "osm-se", region_id: "se", implementation: "overpass" });
    const g = groupDatasets([osmDk, explicit], providers).groups[0]!;
    expect(g.variants).toHaveLength(1);
  });

  test("param key order doesn't split a source", () => {
    const a = ds({ id: "a", implementation: "acme", params: { x: true, y: false } });
    const b = ds({ id: "b", region_id: "no", implementation: "acme", params: { y: false, x: true } });
    expect(groupDatasets([a, b], providers).groups[0]!.variants).toHaveLength(1);
  });
});

describe("variantLabel", () => {
  test("uses the per-implementation label", () => {
    expect(variantLabel(providers, "poi", { implementation: "acme", params: {} })).toBe("POI (Acme)");
  });
  test("satellite names its imagery source", () => {
    expect(
      variantLabel(providers, "satellite", { implementation: null, params: { source_id: "eox" } }),
    ).toBe("eox");
  });
});

describe("groupStatus", () => {
  const g = (statuses: DatasetEntry["status"][]) =>
    groupDatasets(
      statuses.map((status, i) => ds({ id: `d${i}`, region_id: `r${i}`, status })),
      providers,
    ).groups[0]!;
  test("baking wins, then error, then all-baked", () => {
    expect(groupStatus(g(["baked", "baking", "error"]))).toBe("baking");
    expect(groupStatus(g(["baked", "error"]))).toBe("error");
    expect(groupStatus(g(["baked", "baked"]))).toBe("baked");
    expect(groupStatus(g(["baked", "unbaked"]))).toBe("unbaked");
  });
});

describe("planGroupSave", () => {
  const group = groupDatasets([osmDk, osmNo, acmeNo], providers).groups[0]!;
  const makeId = (name: string, taken: readonly string[]) => {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return taken.includes(base) ? `${base}-2` : base;
  };
  const draft = (over: Partial<GroupDraft>): GroupDraft => ({
    provider: "poi",
    regionIds: group.regionIds,
    variants: group.variants,
    schedule: "manual",
    ttl_s: null,
    ...over,
  });
  const ids = ["osm-dk", "osm-no", "acme-no"];

  test("an untouched full grid plans nothing", () => {
    const acmeDk = ds({ id: "acme-dk", implementation: "acme", params: { download_photos: true } });
    const full = groupDatasets([osmDk, osmNo, acmeNo, acmeDk], providers).groups[0]!;
    const plan = planGroupSave(
      full,
      { ...draft({}), regionIds: full.regionIds, variants: full.variants },
      regions,
      providers,
      [...ids, "acme-dk"],
      makeId,
    );
    expect(plan).toEqual({ puts: [], deletes: [] });
  });

  test("saving a grid with a gap fills the gap", () => {
    const plan = planGroupSave(group, draft({}), regions, providers, ids, makeId);
    expect(plan.deletes).toEqual([]);
    expect(plan.puts.map((p) => [p.id, p.isNew])).toEqual([["poi-acme-denmark", true]]);
  });

  test("adding a region creates only the new cells, and fills the grid's gaps", () => {
    const plan = planGroupSave(
      group,
      draft({ regionIds: ["dk", "no", "se"] }),
      regions,
      providers,
      ids,
      makeId,
    );
    expect(plan.deletes).toEqual([]);
    expect(plan.puts.map((p) => [p.body.name, p.body.region_id, p.body.implementation, p.isNew])).toEqual([
      ["POI (OSM) - Sweden", "se", null, true],
      ["POI (Acme) - Denmark", "dk", "acme", true],
      ["POI (Acme) - Sweden", "se", "acme", true],
    ]);
    // new cells carry their source's params
    expect(plan.puts[1]!.body.params).toEqual({ download_photos: true });
  });

  test("removing a region deletes only that region's datasets", () => {
    const plan = planGroupSave(group, draft({ regionIds: ["dk"] }), regions, providers, ids, makeId);
    expect(plan.deletes.map((d) => d.id)).toEqual(["osm-no", "acme-no"]);
    // the Acme source keeps no region, so a DK cell is created for it
    expect(plan.puts.map((p) => p.id)).toEqual(["poi-acme-denmark"]);
  });

  test("removing a source deletes only its datasets", () => {
    const plan = planGroupSave(
      group,
      draft({ variants: [group.variants[0]!] }),
      regions,
      providers,
      ids,
      makeId,
    );
    expect(plan.deletes.map((d) => d.id)).toEqual(["acme-no"]);
    expect(plan.puts).toEqual([]);
  });

  test("a changed schedule or source option updates existing cells in place", () => {
    const acme = { ...group.variants[1]!, params: { download_photos: false } };
    const plan = planGroupSave(
      group,
      draft({ variants: [group.variants[0]!, acme], schedule: "ttl", ttl_s: 3600 }),
      regions,
      providers,
      ids,
      makeId,
    );
    expect(plan.deletes).toEqual([]);
    expect(plan.puts.filter((p) => !p.isNew).map((p) => p.id)).toEqual(["osm-dk", "osm-no", "acme-no"]);
    expect(plan.puts.find((p) => p.id === "acme-no")!.body).toMatchObject({
      name: "acme-no", // existing names kept
      params: { download_photos: false },
      ttl_s: 3600,
    });
  });

  test("new ids dedupe against existing and each other", () => {
    const plan = planGroupSave(
      undefined,
      {
        provider: "poi",
        regionIds: ["dk"],
        variants: [{ implementation: null, params: {}, ids: [] }],
        schedule: "manual",
        ttl_s: null,
      },
      regions,
      providers,
      ["poi-osm-denmark"],
      makeId,
    );
    expect(plan.puts.map((p) => p.id)).toEqual(["poi-osm-denmark-2"]);
  });
});

describe("mixed schedules", () => {
  const a = ds({ id: "a", schedule: "ttl", ttl_s: 86400 });
  const b = ds({ id: "b", region_id: "no", schedule: "ttl", ttl_s: 1_800_000 });
  const group = groupDatasets([a, b], providers).groups[0]!;

  test("a card whose datasets disagree has no shared schedule", () => {
    expect(sharedSchedule(group)).toBeNull();
    expect(sharedSchedule(groupDatasets([a], providers).groups[0]!)).toEqual({
      schedule: "ttl",
      ttl_s: 86400,
    });
  });

  test('"keep" leaves every existing schedule alone; a new cell copies its source', () => {
    const plan = planGroupSave(
      group,
      {
        provider: "poi",
        regionIds: ["dk", "no", "se"],
        variants: group.variants,
        schedule: "keep",
        ttl_s: null,
      },
      regions,
      providers,
      ["a", "b"],
      (name) => name,
    );
    expect(plan.deletes).toEqual([]);
    expect(plan.puts).toHaveLength(1);
    expect(plan.puts[0]!.body).toMatchObject({ region_id: "se", schedule: "ttl", ttl_s: 86400 });
  });
});
