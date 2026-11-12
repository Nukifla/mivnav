// The list panel's pure logic: chips, text filter, distance sort with the
// no-position group last, the "new since last opened" badge, its storage,
// and the header status line.

import { describe, expect, test } from "bun:test";
import {
  buildList,
  FAMILY_CHIPS,
  formatDistanceNm,
  isNewSince,
  LAST_OPENED_KEY,
  matchesText,
  readLastOpened,
  rowText,
  writeLastOpened,
  type KeyValueStore,
} from "./listModel";
import { stateText, statusLine } from "./labels";
import type { NoticeListItem, NoticesList } from "./types";
import LIST_JSON from "./fixtures/list.json";

const LIST = LIST_JSON as unknown as NoticesList;
const ITEMS = LIST.items;
const NONE = new Set<string>();
const sid = (i: NoticeListItem) => i.sid;

describe("buildList", () => {
  test("located notices nearest the reference first; no-geometry ones grouped after", () => {
    // Femern Belt — NM-053 is right there.
    const g = buildList(ITEMS, { chips: NONE, query: "", from: { lng: 11.3, lat: 54.57 }, lastOpened: null });
    expect(g.located[0].item.sid).toBe("NM-053-26");
    for (let i = 1; i < g.located.length; i++) {
      expect(g.located[i].distanceNm!).toBeGreaterThanOrEqual(g.located[i - 1].distanceNm!);
    }
    expect(g.unlocated.map((r) => r.item.fam).sort()).toEqual(["efs-a", "efs-b", "nm-misc"]);
    expect(g.located.length + g.unlocated.length).toBe(ITEMS.length);
  });

  test("a different reference point re-orders", () => {
    // Skagen — the NW off the north tip.
    const g = buildList(ITEMS, { chips: NONE, query: "", from: { lng: 10.6, lat: 57.7 }, lastOpened: null });
    expect(g.located[0].item.sid).toBe("NW-375-26");
  });

  test("no reference point: located rows still listed (by shortId), without distance", () => {
    const g = buildList(ITEMS, { chips: NONE, query: "", lastOpened: null });
    expect(g.located.every((r) => r.distanceNm === undefined)).toBe(true);
    expect(g.located.length).toBe(10);
  });

  test("family chips: union of the chosen chips; Firing covers exercises and areas", () => {
    const g = buildList(ITEMS, { chips: new Set(["firing"]), query: "", lastOpened: null });
    expect(new Set(g.located.map((r) => r.item.fam))).toEqual(new Set(["fe", "fa"]));
    const g2 = buildList(ITEMS, { chips: new Set(["efs-a", "efs-b", "general"]), query: "", lastOpened: null });
    expect(g2.located).toEqual([]);
    expect(g2.unlocated).toHaveLength(3);
    expect(FAMILY_CHIPS.flatMap((c) => c.fams).sort()).toEqual(
      ["efs-a", "efs-b", "fa", "fe", "nm-misc", "nm-p", "nm-perm", "nm-t", "nw"].sort(),
    );
  });

  test("text filter: shortId, Danish/English words, Danish letters folded", () => {
    expect(buildList(ITEMS, { chips: NONE, query: "nm-053", lastOpened: null }).located.map((r) => sid(r.item))).toEqual([
      "NM-053-26",
    ]);
    const femern = ITEMS.find((i) => i.sid === "NM-053-26")!;
    expect(matchesText(femern, "femern tunnel")).toBe(true);
    expect(matchesText(femern, "baelt")).toBe(true); // Bælt
    expect(matchesText(femern, "belt rute")).toBe(true); // en + da
    expect(matchesText(femern, "skagen")).toBe(false);
  });

  test("the new badge: updated since the previous open; never on the first open", () => {
    const item = ITEMS[0];
    expect(isNewSince(item, null)).toBe(false);
    expect(isNewSince(item, (item.updated ?? 0) - 1)).toBe(true);
    expect(isNewSince(item, (item.updated ?? 0) + 1)).toBe(false);
    const cut = 1_790_500_000_000;
    const g = buildList(ITEMS, { chips: NONE, query: "", lastOpened: cut });
    const fresh = [...g.located, ...g.unlocated].filter((r) => r.isNew).map((r) => r.item.sid ?? r.item.fam);
    expect(fresh.sort()).toEqual(["Local Warning-224-26", "NW-375-26", "fe"].sort());
  });
});

describe("row text", () => {
  // User: "chose english as language" — rows read English, Danish per field
  // only where English is missing (the text filter still searches both).
  const femern = ITEMS.find((i) => i.sid === "NM-053-26")!;
  test("English vicinity headline, English title under it", () => {
    expect(rowText(femern)).toEqual({ headline: femern.vicinity.en!, title: femern.title.en });
  });
  test("a field with no English falls back to Danish", () => {
    const t = rowText({ ...femern, vicinity: { da: "Femern Bælt", en: null }, title: { da: "Dansk titel", en: "" } });
    expect(t).toEqual({ headline: "Femern Bælt", title: "Dansk titel" });
  });
  test("no vicinity: the title is the headline, not repeated under it", () => {
    expect(rowText({ ...femern, vicinity: { da: null, en: null } })).toEqual({ headline: femern.title.en, title: undefined });
  });
});

describe("last-opened storage", () => {
  test("round-trips, and survives a throwing or empty store", () => {
    const m = new Map<string, string>();
    const store: KeyValueStore = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
    expect(readLastOpened(store)).toBeNull();
    writeLastOpened(1234, store);
    expect(m.get(LAST_OPENED_KEY)).toBe("1234");
    expect(readLastOpened(store)).toBe(1234);
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readLastOpened(broken)).toBeNull();
    expect(() => writeLastOpened(1, broken)).not.toThrow();
    expect(readLastOpened(undefined)).toBeNull();
  });
});

describe("labels", () => {
  const NOW = Date.UTC(2026, 9, 3, 12);
  test("status line: age, offline date, loading", () => {
    expect(statusLine({ state: "ready", fetched_at: new Date(NOW - 3 * 3_600_000).toISOString() }, null, NOW)).toBe(
      "Updated 3 h ago",
    );
    expect(statusLine({ state: "offline", fetched_at: "2026-10-01T08:00:00Z" }, null, NOW)).toMatch(
      /^Offline — data from 1\/10/,
    );
    expect(statusLine(undefined, null, NOW)).toBe("Loading…");
    expect(statusLine({ state: "idle", fetched_at: null }, null, NOW)).toBe("No data yet");
    expect(statusLine(undefined, new Date(NOW - 60_000).toISOString(), NOW)).toBe("Updated 1 min ago");
    expect(statusLine({ state: "loading", fetched_at: null }, null, NOW)).toBe("Loading…");
  });

  test("state text: active / from d/m / ended; firing areas by day", () => {
    expect(stateText("nw", [[NOW - 1000, null]], NOW)).toBe("Active");
    expect(stateText("nm-t", [[NOW + 2 * 86_400_000, null]], NOW)).toMatch(/^From \d+\/\d+$/);
    expect(stateText("nm-t", [[NOW - 2000, NOW - 1000]], NOW)).toBe("Ended");
    expect(stateText("fa", [], NOW)).toBe("No firing today");
    expect(stateText("fa", [[NOW - 1000, NOW + 1000]], NOW)).toBe("Firing today");
  });

  test("distance format", () => {
    expect(formatDistanceNm(3.24)).toBe("3.2 nm");
    expect(formatDistanceNm(42.6)).toBe("43 nm");
  });
});
