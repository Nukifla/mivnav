/**
 * The rules of mivport editing on the boat (./model.ts): which place actions
 * an account sees (mivport's roles: delete only own places unless trusted),
 * the badge on a place changed on the boat, the outbox as listed, the
 * account's status line, the review form, and the photo-licence notice.
 */

import { describe, expect, test } from "bun:test";
import {
  accountStatus,
  acceptPhotoLicence,
  ago,
  canDeletePlace,
  canDiscard,
  cleanHide,
  conflictLines,
  localBadge,
  outboxGroups,
  photoLicenceAccepted,
  placeActions,
  reviewBody,
  roleAtLeast,
  today,
  wireTime,
  type PlaceActionState,
} from "./model";
import type { MivportAccount, MivportOutboxItem } from "./types";

const acct = (o: Partial<MivportAccount> = {}): MivportAccount => ({
  server: "https://m",
  logged_in: true,
  username: "anna",
  role: "contributor",
  online: true,
  outbox: { pending: 0, failed: 0 },
  ...o,
});

const core = { source: "core" as const, rev: 3 };

describe("roles", () => {
  test("ordered contributor < trusted < moderator < admin; unknown counts as contributor", () => {
    expect(roleAtLeast("trusted", "trusted")).toBe(true);
    expect(roleAtLeast("admin", "trusted")).toBe(true);
    expect(roleAtLeast("contributor", "trusted")).toBe(false);
    expect(roleAtLeast(undefined, "contributor")).toBe(true);
    expect(roleAtLeast("visitor", "trusted")).toBe(false);
    expect(roleAtLeast(null, "trusted")).toBe(false);
  });
});

describe("who may delete a place", () => {
  const s = (o: Partial<PlaceActionState>): PlaceActionState => ({ account: acct(), ref: "u1", detail: core, ...o });
  test("a contributor only the places they created", () => {
    expect(canDeletePlace(s({}))).toBe(false);
    expect(canDeletePlace(s({ detail: { ...core, created_by: "bob" } }))).toBe(false);
    expect(canDeletePlace(s({ detail: { ...core, created_by: "anna" } }))).toBe(true);
  });
  test("trusted and above any mivport place", () => {
    for (const role of ["trusted", "moderator", "admin"]) {
      expect(canDeletePlace(s({ account: acct({ role }) }))).toBe(true);
    }
  });
  test("nobody an OSM-only place; nobody logged out", () => {
    expect(canDeletePlace(s({ account: acct({ role: "admin" }), ref: "osm:n1", detail: undefined }))).toBe(false);
    expect(canDeletePlace(s({ account: acct({ role: "admin" }), detail: { source: "osm" } }))).toBe(false);
    expect(canDeletePlace(s({ account: acct({ logged_in: false, role: "admin" }) }))).toBe(false);
  });
});

describe("place actions", () => {
  test("logged out: only the history, and only online for a stored mivport place", () => {
    const out = acct({ logged_in: false, username: null, role: null });
    expect(placeActions({ account: out, ref: "u1", detail: core })).toEqual(["history"]);
    expect(placeActions({ account: { ...out, online: false }, ref: "u1", detail: core })).toEqual([]);
    expect(placeActions({ account: undefined, ref: "u1", detail: core })).toEqual([]);
  });

  test("a contributor on someone else's place: edit, review, photo, ask to remove, history", () => {
    expect(placeActions({ account: acct(), ref: "u1", detail: { ...core, created_by: "bob" } })).toEqual([
      "edit",
      "review",
      "photo",
      "removal",
      "history",
    ]);
  });

  test("own place, or trusted: delete too", () => {
    expect(placeActions({ account: acct(), ref: "u1", detail: { ...core, created_by: "anna" } })).toContain("delete");
    expect(placeActions({ account: acct({ role: "trusted" }), ref: "u1", detail: core })).toContain("delete");
  });

  test("a deleted place: restore (where allowed), no editing", () => {
    expect(placeActions({ account: acct({ role: "trusted" }), ref: "u1", detail: { ...core, deleted: true } })).toEqual([
      "restore",
      "removal",
      "history",
    ]);
    expect(placeActions({ account: acct(), ref: "u1", detail: { ...core, deleted: true } })).toEqual([
      "removal",
      "history",
    ]);
  });

  test("an OSM-only place: no delete, no history (mivport has none for it)", () => {
    expect(placeActions({ account: acct({ role: "admin" }), ref: "osm:w5", detail: { source: "osm" } })).toEqual([
      "edit",
      "review",
      "photo",
      "removal",
    ]);
  });

  test("offline: everything but history still works (it is queued)", () => {
    expect(placeActions({ account: acct({ online: false }), ref: "u1", detail: core })).toEqual([
      "edit",
      "review",
      "photo",
      "removal",
    ]);
  });

  test("a place created on the boat (no revision yet): no history; before the detail loads: none either", () => {
    expect(placeActions({ account: acct(), ref: "u9", detail: { source: "core", local: "pending" } })).not.toContain(
      "history",
    );
    expect(placeActions({ account: acct(), ref: "u9" })).not.toContain("history");
  });
});

describe("the local badge", () => {
  test("pending, refused, uploaded; none for a baked place", () => {
    expect(localBadge("pending")).toMatchObject({ label: "Changed · not uploaded", tone: "notice" });
    expect(localBadge("pending", true)?.label).toBe("Deleted · not uploaded");
    expect(localBadge("failed")).toMatchObject({ label: "Upload refused", tone: "alarm" });
    expect(localBadge("synced")).toMatchObject({ label: "Changed · uploaded", tone: "ok" });
    expect(localBadge(undefined)).toBeUndefined();
  });
});

describe("the outbox", () => {
  const item = (o: Partial<MivportOutboxItem>): MivportOutboxItem => ({
    id: "i",
    kind: "edit",
    summary: "s",
    state: "pending",
    created_at: 0,
    ...o,
  });

  test("grouped waiting / refused / uploaded, newest first", () => {
    const g = outboxGroups([
      item({ id: "a", state: "pending", created_at: 1 }),
      item({ id: "b", state: "sending", created_at: 3 }),
      item({ id: "c", state: "failed", created_at: 2 }),
      item({ id: "d", state: "done", created_at: 5 }),
      item({ id: "e", state: "pending", created_at: "1970-01-01T00:00:04Z" }),
    ]);
    expect(g.waiting.map((i) => i.id)).toEqual(["e", "b", "a"]);
    expect(g.failed.map((i) => i.id)).toEqual(["c"]);
    expect(g.done.map((i) => i.id)).toEqual(["d"]);
  });

  test("only a pending or refused item can be discarded", () => {
    expect(canDiscard(item({ state: "pending" }))).toBe(true);
    expect(canDiscard(item({ state: "failed" }))).toBe(true);
    expect(canDiscard(item({ state: "sending" }))).toBe(false);
    expect(canDiscard(item({ state: "done" }))).toBe(false);
  });

  test("conflicts worded", () => {
    expect(
      conflictLines(item({ conflicts: [{ field: "name", won: true }, { field: "attrs.vhf", won: false }] })),
    ).toEqual(["name: your newer value was kept", "attrs.vhf: a newer value from someone else was kept"]);
    expect(conflictLines(item({ conflicts: null }))).toEqual([]);
  });

  test("wire times: epoch seconds or ISO", () => {
    expect(wireTime(2)).toBe(2000);
    expect(wireTime("1970-01-01T00:00:01Z")).toBe(1000);
    expect(wireTime(undefined)).toBeNaN();
  });
});

describe("the account line", () => {
  const now = 1_000_000_000;
  test("reachable, last sync, the queue", () => {
    expect(accountStatus(acct({ last_sync: now / 1000 - 120, outbox: { pending: 2, failed: 1 } }), now)).toBe(
      "mivport reachable · last sync 2 min ago · 2 waiting · 1 refused",
    );
  });
  test("offline says the changes wait; no server says so", () => {
    expect(accountStatus(acct({ online: false, last_sync: null }), now)).toBe(
      "mivport not reachable — changes wait on the boat",
    );
    expect(accountStatus(undefined)).toBe("The boat’s server isn’t answering.");
  });
  test("ago", () => {
    expect(ago(now - 10_000, now)).toBe("just now");
    expect(ago(now - 3 * 3600_000, now)).toBe("3 h ago");
    expect(ago(now - 3 * 86400_000, now)).toBe("3 days ago");
  });
});

describe("the review form", () => {
  test("stars 1–5, text and date only when given", () => {
    expect(reviewBody({ stars: "4", body: " Nice ", visited_on: "2026-07-01" })).toEqual({
      body: { stars: 4, body: "Nice", visited_on: "2026-07-01" },
    });
    expect(reviewBody({ stars: "5", body: "", visited_on: "" })).toEqual({ body: { stars: 5 } });
  });
  test("bad stars or date: why", () => {
    expect(reviewBody({ stars: "0" })).toEqual({ error: "Choose 1 to 5 stars" });
    expect(reviewBody({ stars: "3", visited_on: "1 July" })).toEqual({ error: "Visited on: a date like 2026-07-01" });
  });
  test("today is the local date", () => {
    expect(today(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});

describe("the photo licence notice", () => {
  test("asked until accepted once on this device; a broken storage asks again, never throws", () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    expect(photoLicenceAccepted(store)).toBe(false);
    acceptPhotoLicence(store);
    expect(photoLicenceAccepted(store)).toBe(true);
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(photoLicenceAccepted(broken)).toBe(false);
    expect(() => acceptPhotoLicence(broken)).not.toThrow();
  });
});

describe("cleanHide", () => {
  test("string refs only", () => {
    expect(cleanHide(["u1", 3, "", null, "osm:n2"])).toEqual(["u1", "osm:n2"]);
    expect(cleanHide("nope")).toEqual([]);
  });
});
