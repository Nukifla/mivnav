/**
 * The shared region list/edit/delete controller (`createRegionForm`) and its
 * supporting pure helpers — the DOM-free half `RegionForm`/`RegionListSection`
 * mount. Asserted without a DOM:
 *
 *   1. `regionPatch` emits `id` + country XOR `bboxes` on the wire, never
 *      both — kolmnrsk: a region is a LIST of boxes now, not the old four
 *      flat fields (GET /api/config always returns every field, so a
 *      country region comes back with an empty `bboxes` alongside a real
 *      `country`) — while also never letting an untouched entry's id drift;
 *   2. `regionUsageCounts` — the "used by N dataset(s)" input, by region id;
 *   3. the installed-chart prefill list merges `/api/catalog` +
 *      `/api/satellite/catalog`, and picking one APPENDS a box to the draft
 *      (without saving anything);
 *   4. `save()` on a fresh draft mints an id (slugified from Name, deduped
 *      against `existingIds`), reads the CURRENT regions fresh (not a stale
 *      prop), appends the new one, and PATCHes the whole list back
 *      normalised;
 *   5. `save()` on an edit REPLACES the matching entry in place (never
 *      appends a duplicate) and keeps the existing id verbatim even when the
 *      name changes — the whole reason `Region.id` exists;
 *   6. editing a country region only ever touches its name — `bboxes` is
 *      empty for that variant, so this form has nothing to prefill or edit
 *      there;
 *   7. a region needs at least one box to save (kolmnrsk);
 *   8. `initialBoxes` seeds a FRESH draft (never an edit) — the draw-to-
 *      create completion step: the sailor drew the shape on the map first,
 *      the form just fills it in and still asks for a Name (kolmnrsk TESTED
 *      feedback: drawing must be able to create a region, not just PATCH an
 *      already-saved one).
 */

import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { createRegionForm, regionPatch, regionSummary, regionUsageCounts, type Region } from "./regions";
import type { FetchJson } from "./apiFetch";

describe("regionPatch", () => {
  test("a bbox region sends id + name + bboxes, no country", () => {
    const r: Region = {
      id: "solent",
      name: "Solent",
      bboxes: [{ min_lon: -1.65, min_lat: 50.68, max_lon: -1.05, max_lat: 50.82 }],
    };
    expect(regionPatch(r)).toEqual({
      id: "solent",
      name: "Solent",
      bboxes: [{ min_lon: -1.65, min_lat: 50.68, max_lon: -1.05, max_lat: 50.82 }],
    });
  });

  test("a multi-box region sends every box", () => {
    const r: Region = {
      id: "archipelago",
      name: "Archipelago",
      bboxes: [
        { min_lon: 10, min_lat: 55, max_lon: 11, max_lat: 56 },
        { min_lon: 12, min_lat: 57, max_lon: 13, max_lat: 58 },
      ],
    };
    expect(regionPatch(r)).toEqual({
      id: "archipelago",
      name: "Archipelago",
      bboxes: [
        { min_lon: 10, min_lat: 55, max_lon: 11, max_lat: 56 },
        { min_lon: 12, min_lat: 57, max_lon: 13, max_lat: 58 },
      ],
    });
  });

  test("a country region sends only id + name + country, dropping bboxes", () => {
    // Exactly what GET /api/config returns for a country region: `bboxes`
    // empty alongside a real `country`.
    const r: Region = {
      id: "denmark",
      name: "Denmark",
      country: "DK",
      bboxes: [],
    };
    expect(regionPatch(r)).toEqual({ id: "denmark", name: "Denmark", country: "DK" });
  });

  test("a null country (the bbox variant's wire value) is treated as bbox", () => {
    const r: Region = {
      id: "kattegat",
      name: "Kattegat",
      country: null,
      bboxes: [{ min_lon: 10.5, min_lat: 56.0, max_lon: 12.5, max_lat: 57.5 }],
    };
    expect(regionPatch(r)).toEqual({
      id: "kattegat",
      name: "Kattegat",
      bboxes: [{ min_lon: 10.5, min_lat: 56.0, max_lon: 12.5, max_lat: 57.5 }],
    });
  });
});

describe("regionUsageCounts", () => {
  const solent: Region = {
    id: "solent",
    name: "Solent",
    bboxes: [{ min_lon: -1.65, min_lat: 50.68, max_lon: -1.05, max_lat: 50.82 }],
  };
  const denmark: Region = { id: "denmark", name: "Denmark", country: "DK", bboxes: [] };

  test("every region gets an entry, defaulting to 0", () => {
    const counts = regionUsageCounts([solent, denmark], []);
    expect(counts.get("solent")).toBe(0);
    expect(counts.get("denmark")).toBe(0);
  });

  test("counts datasets by region id, ignoring datasets with no region", () => {
    const counts = regionUsageCounts(
      [solent, denmark],
      [{ region_id: "solent" }, { region_id: "solent" }, { region_id: "denmark" }, { region_id: null }],
    );
    expect(counts.get("solent")).toBe(2);
    expect(counts.get("denmark")).toBe(1);
  });

  test("a dataset referencing an id no longer in the regions list is not counted", () => {
    const counts = regionUsageCounts([solent], [{ region_id: "stale-id" }]);
    expect(counts.get("solent")).toBe(0);
    expect(counts.has("stale-id")).toBe(false);
  });
});

describe("regionSummary", () => {
  test("a country region shows the country code", () => {
    const r: Region = { id: "dk", name: "Denmark", country: "DK", bboxes: [] };
    expect(regionSummary(r)).toBe("DK");
  });

  test("a single-box region shows rounded bounds", () => {
    const r: Region = {
      id: "solent",
      name: "Solent",
      bboxes: [{ min_lon: -1.654321, min_lat: 50.681, max_lon: -1.05, max_lat: 50.82 }],
    };
    expect(regionSummary(r)).toBe("-1.65, 50.68 – -1.05, 50.82");
  });

  test("a multi-box region shows a count, not the boxes themselves", () => {
    const r: Region = {
      id: "archipelago",
      name: "Archipelago",
      bboxes: [
        { min_lon: 10, min_lat: 55, max_lon: 11, max_lat: 56 },
        { min_lon: 12, min_lat: 57, max_lon: 13, max_lat: 58 },
      ],
    };
    expect(regionSummary(r)).toBe("2 boxes");
  });
});

interface Fake {
  fetchJson: FetchJson;
  posted: unknown[];
}

function fakeBackend(
  chartSets: { id: string; name: string; bounds: [number, number, number, number] }[] = [],
  satelliteSets: { id: string; name: string; bounds: [number, number, number, number] }[] = [],
  initialRegions: Region[] = [],
): Fake {
  let regions = [...initialRegions];
  const posted: unknown[] = [];
  const fetchJson: FetchJson = async <T,>(url: string, init?: RequestInit): Promise<T> => {
    if (url === "/api/catalog") return { sets: chartSets } as T;
    if (url === "/api/satellite/catalog") return { sets: satelliteSets } as T;
    if (url === "/api/config") {
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        posted.push(body);
        regions = body.regions;
        return { config: { regions } } as T;
      }
      return { config: { regions } } as T;
    }
    throw new Error(`unexpected url ${url}`);
  };
  return { fetchJson, posted };
}

describe("createRegionForm — add", () => {
  test("installedCharts merges both catalogs, prefixed and labelled", () =>
    createRoot(async (dispose) => {
      const fake = fakeBackend(
        [{ id: "dk", name: "Denmark", bounds: [8, 54, 16, 58] }],
        [{ id: "oresund", name: "Øresund", bounds: [12.5, 55.5, 13.0, 56.2] }],
      );
      const ctrl = createRegionForm({ existingIds: [], onSaved: () => {}, fetchJson: fake.fetchJson });
      await ctrl.refresh();
      expect(ctrl.installedCharts()).toEqual([
        { key: "chart:dk", label: "Denmark", bounds: [8, 54, 16, 58] },
        { key: "satellite:oresund", label: "Øresund", bounds: [12.5, 55.5, 13.0, 56.2] },
      ]);
      dispose();
    }));

  test("one catalog failing does not blank the other", () =>
    createRoot(async (dispose) => {
      const fetchJson: FetchJson = async <T,>(url: string): Promise<T> => {
        if (url === "/api/catalog") throw new Error("offline");
        if (url === "/api/satellite/catalog") {
          return { sets: [{ id: "x", name: "X", bounds: [0, 0, 1, 1] }] } as T;
        }
        throw new Error(`unexpected ${url}`);
      };
      const ctrl = createRegionForm({ existingIds: [], onSaved: () => {}, fetchJson });
      await ctrl.refresh();
      expect(ctrl.installedCharts().map((o) => o.key)).toEqual(["satellite:x"]);
      dispose();
    }));

  test("prefillFrom appends a box and names the draft — does not save anything", () =>
    createRoot(async (dispose) => {
      const fake = fakeBackend([{ id: "dk", name: "Denmark", bounds: [8, 54, 16, 58] }]);
      const ctrl = createRegionForm({ existingIds: [], onSaved: () => {}, fetchJson: fake.fetchJson });
      await ctrl.refresh();

      ctrl.prefillFrom("chart:dk");
      expect(ctrl.name()).toBe("Denmark");
      expect(ctrl.boxes()).toEqual([{ minLon: "8", minLat: "54", maxLon: "16", maxLat: "58" }]);
      expect(fake.posted).toEqual([]); // nothing sent yet
      dispose();
    }));

  test("prefillFrom does not overwrite a name the sailor already typed", () =>
    createRoot(async (dispose) => {
      const fake = fakeBackend([{ id: "dk", name: "Denmark", bounds: [8, 54, 16, 58] }]);
      const ctrl = createRegionForm({ existingIds: [], onSaved: () => {}, fetchJson: fake.fetchJson });
      await ctrl.refresh();

      ctrl.setName("My region");
      ctrl.prefillFrom("chart:dk");
      expect(ctrl.name()).toBe("My region");
      expect(ctrl.boxes()).toEqual([{ minLon: "8", minLat: "54", maxLon: "16", maxLat: "58" }]);
      dispose();
    }));

  test("prefillFrom twice appends two boxes, not one overwritten", () =>
    createRoot(async (dispose) => {
      const fake = fakeBackend(
        [{ id: "dk", name: "Denmark", bounds: [8, 54, 16, 58] }],
        [{ id: "oresund", name: "Øresund", bounds: [12.5, 55.5, 13.0, 56.2] }],
      );
      const ctrl = createRegionForm({ existingIds: [], onSaved: () => {}, fetchJson: fake.fetchJson });
      await ctrl.refresh();

      ctrl.prefillFrom("chart:dk");
      ctrl.prefillFrom("satellite:oresund");
      expect(ctrl.boxes()).toEqual([
        { minLon: "8", minLat: "54", maxLon: "16", maxLat: "58" },
        { minLon: "12.5", minLat: "55.5", maxLon: "13", maxLat: "56.2" },
      ]);
      dispose();
    }));

  test("addBlankBox adds an empty row, removeBox drops it", () =>
    createRoot(async (dispose) => {
      const fake = fakeBackend();
      const ctrl = createRegionForm({ existingIds: [], onSaved: () => {}, fetchJson: fake.fetchJson });
      ctrl.addBlankBox();
      expect(ctrl.boxes()).toEqual([{ minLon: "", minLat: "", maxLon: "", maxLat: "" }]);
      ctrl.setBoxField(0, "minLon", "1");
      expect(ctrl.boxes()[0].minLon).toBe("1");
      ctrl.removeBox(0);
      expect(ctrl.boxes()).toEqual([]);
      dispose();
    }));

  test("appendBox is what a drawn rectangle feeds", () =>
    createRoot(async (dispose) => {
      const fake = fakeBackend();
      const ctrl = createRegionForm({ existingIds: [], onSaved: () => {}, fetchJson: fake.fetchJson });
      ctrl.appendBox([1, 2, 3, 4]);
      expect(ctrl.boxes()).toEqual([{ minLon: "1", minLat: "2", maxLon: "3", maxLat: "4" }]);
      // No name hint given (unlike a chart prefill) — the name stays untouched.
      expect(ctrl.name()).toBe("");
      dispose();
    }));

  test("initialBoxes seeds a fresh draft — the draw-to-create completion step (kolmnrsk)", () =>
    createRoot(async (dispose) => {
      const fake = fakeBackend();
      const ctrl = createRegionForm({
        existingIds: [],
        onSaved: () => {},
        fetchJson: fake.fetchJson,
        initialBoxes: [
          { min_lon: 1, min_lat: 2, max_lon: 3, max_lat: 4 },
          { min_lon: 5, min_lat: 6, max_lon: 7, max_lat: 8 },
        ],
      });
      expect(ctrl.boxes()).toEqual([
        { minLon: "1", minLat: "2", maxLon: "3", maxLat: "4" },
        { minLon: "5", minLat: "6", maxLon: "7", maxLat: "8" },
      ]);
      // The sailor still names it and Saves — drawing only seeds the shape.
      expect(ctrl.name()).toBe("");
      dispose();
    }));

  test("save() rejects an empty name without a network call", () =>
    createRoot(async (dispose) => {
      const fake = fakeBackend();
      const ctrl = createRegionForm({ existingIds: [], onSaved: () => {}, fetchJson: fake.fetchJson });
      ctrl.addBlankBox();
      ctrl.setBoxField(0, "minLon", "1");
      ctrl.setBoxField(0, "minLat", "1");
      ctrl.setBoxField(0, "maxLon", "2");
      ctrl.setBoxField(0, "maxLat", "2");
      await ctrl.save();
      expect(ctrl.error()).toContain("Name");
      expect(fake.posted).toEqual([]);
      dispose();
    }));

  test("save() rejects a draft with no boxes", () =>
    createRoot(async (dispose) => {
      const fake = fakeBackend();
      const ctrl = createRegionForm({ existingIds: [], onSaved: () => {}, fetchJson: fake.fetchJson });
      ctrl.setName("Empty");
      await ctrl.save();
      expect(ctrl.error()).toContain("bounding box");
      expect(fake.posted).toEqual([]);
      dispose();
    }));

  test("save() rejects a degenerate box (min >= max)", () =>
    createRoot(async (dispose) => {
      const fake = fakeBackend();
      const ctrl = createRegionForm({ existingIds: [], onSaved: () => {}, fetchJson: fake.fetchJson });
      ctrl.setName("Bad");
      ctrl.addBlankBox();
      ctrl.setBoxField(0, "minLon", "2");
      ctrl.setBoxField(0, "minLat", "1");
      ctrl.setBoxField(0, "maxLon", "1"); // max_lon < min_lon
      ctrl.setBoxField(0, "maxLat", "2");
      await ctrl.save();
      expect(ctrl.error()).toContain("west");
      expect(fake.posted).toEqual([]);
      dispose();
    }));

  test("save() mints an id from Name, reads regions fresh, appends normalised", () =>
    createRoot(async (dispose) => {
      const existingCountry: Region = { id: "denmark", name: "Denmark", country: "DK", bboxes: [] };
      const fake = fakeBackend([], [], [existingCountry]);
      let saved = 0;
      const ctrl = createRegionForm({
        existingIds: ["denmark"],
        onSaved: () => saved++,
        fetchJson: fake.fetchJson,
      });
      ctrl.setName("Kattegat");
      ctrl.addBlankBox();
      ctrl.setBoxField(0, "minLon", "10.5");
      ctrl.setBoxField(0, "minLat", "56.0");
      ctrl.setBoxField(0, "maxLon", "12.5");
      ctrl.setBoxField(0, "maxLat", "57.5");
      await ctrl.save();

      expect(fake.posted).toEqual([
        {
          regions: [
            { id: "denmark", name: "Denmark", country: "DK" }, // normalised: bboxes dropped
            {
              id: "kattegat",
              name: "Kattegat",
              bboxes: [{ min_lon: 10.5, min_lat: 56.0, max_lon: 12.5, max_lat: 57.5 }],
            },
          ],
        },
      ]);
      expect(saved).toBe(1);
      expect(ctrl.name()).toBe(""); // draft cleared
      expect(ctrl.boxes()).toEqual([]); // draft cleared
      expect(ctrl.error()).toBe("");
      dispose();
    }));

  test("save() dedupes the minted id against existingIds on a name collision", () =>
    createRoot(async (dispose) => {
      const fake = fakeBackend();
      const ctrl = createRegionForm({
        existingIds: ["solent"],
        onSaved: () => {},
        fetchJson: fake.fetchJson,
      });
      ctrl.setName("Solent");
      ctrl.addBlankBox();
      ctrl.setBoxField(0, "minLon", "1");
      ctrl.setBoxField(0, "minLat", "1");
      ctrl.setBoxField(0, "maxLon", "2");
      ctrl.setBoxField(0, "maxLat", "2");
      await ctrl.save();
      const body = fake.posted[0] as { regions: { id: string }[] };
      expect(body.regions[0].id).toBe("solent-2");
      dispose();
    }));

  test("a refused save surfaces the error and keeps the draft", () =>
    createRoot(async (dispose) => {
      const fetchJson: FetchJson = async <T,>(url: string, init?: RequestInit): Promise<T> => {
        if (url === "/api/catalog" || url === "/api/satellite/catalog") return { sets: [] } as T;
        if (url === "/api/config" && !init) return { config: { regions: [] } } as T;
        throw new Error("need min_lon < max_lon");
      };
      const ctrl = createRegionForm({ existingIds: [], onSaved: () => {}, fetchJson });
      ctrl.setName("X");
      ctrl.addBlankBox();
      ctrl.setBoxField(0, "minLon", "1");
      ctrl.setBoxField(0, "minLat", "1");
      ctrl.setBoxField(0, "maxLon", "2");
      ctrl.setBoxField(0, "maxLat", "2");
      await ctrl.save();
      expect(ctrl.error()).toBe("need min_lon < max_lon");
      expect(ctrl.name()).toBe("X"); // draft kept so the sailor can retry, not retype
      dispose();
    }));
});

describe("createRegionForm — edit", () => {
  const existing: Region = {
    id: "kattegat",
    name: "Kattegat",
    bboxes: [{ min_lon: 10.0, min_lat: 55.0, max_lon: 12.5, max_lat: 57.5 }],
  };

  test("prefills the draft's boxes from the region being edited", () =>
    createRoot(async (dispose) => {
      const fake = fakeBackend();
      const ctrl = createRegionForm({
        region: existing,
        existingIds: [],
        onSaved: () => {},
        fetchJson: fake.fetchJson,
      });
      expect(ctrl.name()).toBe("Kattegat");
      expect(ctrl.boxes()).toEqual([{ minLon: "10", minLat: "55", maxLon: "12.5", maxLat: "57.5" }]);
      dispose();
    }));

  test("save() keeps the id and REPLACES the matching entry in place, even on rename", () =>
    createRoot(async (dispose) => {
      const other: Region = {
        id: "solent",
        name: "Solent",
        bboxes: [{ min_lon: -1.65, min_lat: 50.68, max_lon: -1.05, max_lat: 50.82 }],
      };
      const fake = fakeBackend([], [], [other, existing]);
      const ctrl = createRegionForm({
        region: existing,
        existingIds: ["solent", "kattegat"],
        onSaved: () => {},
        fetchJson: fake.fetchJson,
      });
      ctrl.setName("Kattegat Strait"); // renamed — id must NOT be re-derived from this
      ctrl.setBoxField(0, "maxLat", "58.0");
      await ctrl.save();

      const body = fake.posted[0] as { regions: unknown[] };
      expect(body.regions).toEqual([
        {
          id: "solent",
          name: "Solent",
          bboxes: [{ min_lon: -1.65, min_lat: 50.68, max_lon: -1.05, max_lat: 50.82 }],
        },
        {
          id: "kattegat",
          name: "Kattegat Strait",
          bboxes: [{ min_lon: 10.0, min_lat: 55.0, max_lon: 12.5, max_lat: 58.0 }],
        },
      ]);
      // Position preserved (replaced in place), not appended at the end.
      dispose();
    }));

  test("save() on an edit can append a second box", () =>
    createRoot(async (dispose) => {
      const fake = fakeBackend([], [], [existing]);
      const ctrl = createRegionForm({
        region: existing,
        existingIds: ["kattegat"],
        onSaved: () => {},
        fetchJson: fake.fetchJson,
      });
      ctrl.appendBox([20, 60, 21, 61]);
      await ctrl.save();

      const body = fake.posted[0] as { regions: { bboxes: unknown[] }[] };
      expect(body.regions[0].bboxes).toEqual([
        { min_lon: 10.0, min_lat: 55.0, max_lon: 12.5, max_lat: 57.5 },
        { min_lon: 20, min_lat: 60, max_lon: 21, max_lat: 61 },
      ]);
      dispose();
    }));

  test("editing a country region only ever changes the name", () =>
    createRoot(async (dispose) => {
      const country: Region = { id: "denmark", name: "Denmark", country: "DK", bboxes: [] };
      const fake = fakeBackend([], [], [country]);
      const ctrl = createRegionForm({
        region: country,
        existingIds: ["denmark"],
        onSaved: () => {},
        fetchJson: fake.fetchJson,
      });
      expect(ctrl.boxes()).toEqual([]); // nothing to edit for a country region
      ctrl.setName("Danmark");
      await ctrl.save();

      expect(fake.posted).toEqual([
        { regions: [{ id: "denmark", name: "Danmark", country: "DK" }] },
      ]);
      dispose();
    }));
});
