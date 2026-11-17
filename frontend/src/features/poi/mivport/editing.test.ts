/**
 * mivport editing against an injected fake of the boat's `/api/mivport`
 * (never the network): what it reads at start and every 30 s, the actions a
 * mivport point gets and what each one queues, the place editor's draft and
 * its pin mode (add, move, cancel), "Add to mivport" on a mark, the outbox's
 * Discard, and a refused write said out loud.
 */

import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import type { MivportApi } from "./client";
import { createMivportEditing, localPlaceHit, MIVPORT_PIN_MODE_ID, MIVPORT_POLL_MS } from "./editing";
import type {
  MivportAccount,
  MivportEditRequest,
  MivportLocalFeature,
  MivportLocalLayer,
  MivportPlaceDetail,
  MivportRegistry,
} from "./types";
import type { InfoAction, InfoHit } from "../../../core/info/types";
import type { Mode } from "../../../core/chrome/registry";

const REG: MivportRegistry = {
  kinds: [
    { name: "anchorage", group: "anchoring", label: "Anchorage" },
    { name: "marina", group: "harbour", label: "Marina" },
  ],
  attrs: [
    { key: "vhf", type: "string", max_len: 10 },
    { key: "holding", type: "enum", values: ["good", "poor"], kinds: ["anchorage"] },
  ],
  fetched_at: 1,
};

const ACCOUNT: MivportAccount = {
  server: "https://m",
  logged_in: true,
  username: "anna",
  role: "contributor",
  online: false,
  outbox: { pending: 0, failed: 0 },
};

const DETAIL: MivportPlaceDetail = {
  ref: "u1",
  kind: "marina",
  name: "Havn",
  source: "core",
  rev: 4,
  lat: 55,
  lon: 12,
  attrs: { vhf: "16" },
  reviews: [
    { id: "r1", user: "bob", stars: 4 },
    { id: "r2", user: "anna", stars: 5, body: "Fine" },
  ],
  photos: [{ id: "p1", url: "/x", thumb_url: "/x", attribution: "© bob", user: "bob" }],
  attribution: "",
  fetched_at: 1,
};

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 5; i++) await tick();
};

interface Fake {
  api: MivportApi;
  calls: Record<string, unknown[][]>;
  account: MivportAccount;
  local: MivportLocalLayer;
  fail?: string;
}

function fakeApi(over: Partial<Fake> = {}): Fake {
  const calls: Record<string, unknown[][]> = {};
  const f: Fake = {
    calls,
    account: { ...ACCOUNT },
    local: { features: [], hide: ["u1"] },
    ...over,
    api: undefined as unknown as MivportApi,
  };
  const rec =
    <T,>(name: string, answer: (...a: unknown[]) => T) =>
    (...args: unknown[]) => {
      (calls[name] ??= []).push(args);
      if (f.fail && name === f.fail) return Promise.reject(new Error("mivport says no"));
      return Promise.resolve(answer(...args));
    };
  f.api = {
    account: rec("account", () => f.account),
    login: rec("login", () => f.account),
    register: rec("register", () => f.account),
    deviceLogin: rec("deviceLogin", () => ({ user_code: "ABCD", verification_url: "https://m/device", expires_in: 600 })),
    logout: rec("logout", () => ({ ...f.account, logged_in: false })),
    registry: rec("registry", () => REG),
    edit: rec("edit", (req) => ({ place_id: (req as MivportEditRequest).place_id ?? "new-uuid", item_id: "i1" })),
    review: rec("review", () => ({ item_id: "i2" })),
    deleteReview: rec("deleteReview", () => ({ item_id: "i3" })),
    uploadPhoto: rec("uploadPhoto", () => ({ item_id: "i4", photo_id: "lp" })),
    deletePhoto: rec("deletePhoto", () => ({ item_id: "i5" })),
    requestRemoval: rec("requestRemoval", () => ({ item_id: "i6" })),
    outbox: rec("outbox", () => ({ items: [] })),
    discard: rec("discard", () => undefined),
    sync: rec("sync", () => f.account),
    local: rec("local", () => f.local),
    history: rec("history", () => ({ revisions: [] })),
  };
  return f;
}

interface Setup {
  fake: Fake;
  e: ReturnType<typeof createMivportEditing>;
  notes: [string, string | undefined][];
  hits: InfoHit[][];
  poll: { fn?: () => void; ms?: number };
  mode: () => string | null;
  pinMode: Mode;
  dispose: () => void;
}

async function setup(over: Partial<Fake> = {}, detail: MivportPlaceDetail = DETAIL): Promise<Setup> {
  const fake = fakeApi(over);
  const notes: [string, string | undefined][] = [];
  const hits: InfoHit[][] = [];
  const poll: Setup["poll"] = {};
  let out!: Setup;
  createRoot((dispose) => {
    const [active, setActive] = createSignal<string | null>(null);
    const e = createMivportEditing({
      api: fake.api,
      bind: false,
      loadDetail: async () => structuredClone(detail),
      notify: (t, d) => notes.push([t, d]),
      showHits: (h) => hits.push(h),
      setInterval: (fn, ms) => {
        poll.fn = fn;
        poll.ms = ms;
        return 1;
      },
      clearInterval: () => {},
    });
    const pinMode = e.feature.core.modes!.find((m) => m.id === MIVPORT_PIN_MODE_ID)!;
    e.bindMode({
      enter: (id) => {
        setActive(id);
        pinMode.enter?.();
      },
      leave: () => {
        pinMode.leave?.();
        setActive(null);
      },
      active,
    });
    out = { fake, e, notes, hits, poll, mode: active, pinMode, dispose };
  });
  await settle();
  return out;
}

const labels = (a: readonly InfoAction[] | undefined) => (a ?? []).map((x) => x.label);
const props = { src: "mivport", ref: "u1", set: "dk", name: "Havn" };

describe("reads", () => {
  test("at start: the account, the local layer, the registry; the hidden refs come from the local layer", async () => {
    const s = await setup();
    expect(s.fake.calls.account?.length).toBe(1);
    expect(s.fake.calls.local?.length).toBe(1);
    expect(s.fake.calls.registry?.length).toBe(1);
    expect(s.e.local().hide).toEqual(["u1"]);
    expect(s.e.account()?.username).toBe("anna");
    s.dispose();
  });

  test("every 30 s: the local layer and the account again", async () => {
    const s = await setup();
    expect(s.poll.ms).toBe(MIVPORT_POLL_MS);
    expect(MIVPORT_POLL_MS).toBe(30_000);
    s.poll.fn!();
    await settle();
    expect(s.fake.calls.local?.length).toBe(2);
    expect(s.fake.calls.account?.length).toBe(2);
    s.dispose();
  });

  test("an unreachable server keeps the last local layer", async () => {
    const s = await setup();
    s.fake.fail = "local";
    s.poll.fn!();
    await settle();
    expect(s.e.local().hide).toEqual(["u1"]);
    s.dispose();
  });
});

describe("the actions on a mivport point", () => {
  test("logged out: none (offline, so not even history)", async () => {
    const s = await setup({ account: { ...ACCOUNT, logged_in: false, username: null } });
    expect(s.e.placeActionsFor(props)).toEqual({});
    s.dispose();
  });

  test("a contributor, someone else's place: Edit, review, photo; ask to remove; delete own review", async () => {
    const s = await setup();
    await s.e.loadDetail("dk", "u1");
    const a = s.e.placeActionsFor(props);
    expect(labels(a.actions)).toEqual(["Edit", "Change review", "Add photo"]);
    expect(labels(a.footerActions)).toEqual(["Ask to remove…", "Delete my review"]);
    // Others' review and photo, and the place itself (it can't delete it).
    const removal = a.footerActions![0].form!.fields[0].options!.map((o) => o.value);
    expect(removal).toEqual(["place:u1", "review:r1", "photo:p1"]);
    s.dispose();
  });

  test("trusted: Delete place, queued with the stored revision", async () => {
    const s = await setup({ account: { ...ACCOUNT, role: "trusted" } });
    await s.e.loadDetail("dk", "u1");
    const del = s.e.placeActionsFor(props).footerActions!.find((x) => x.label === "Delete place")!;
    expect(del.confirm?.label).toBe("Delete");
    const localBefore = s.fake.calls.local!.length;
    del.run();
    await settle();
    expect(s.fake.calls.edit![0][0]).toEqual({ op: "delete", place_id: "u1", base_rev: 4 });
    expect(s.notes[0]).toEqual(["Place deleted", "Saved on the boat; uploaded when mivport can be reached."]);
    // Re-read at once: the local layer (the place leaves the map) and the detail.
    expect(s.fake.calls.local!.length).toBeGreaterThan(localBefore);
    // Removal can't target the place any more — it can simply be deleted.
    const removal = s.e.placeActionsFor(props).footerActions!.find((x) => x.label === "Ask to remove…")!;
    expect(removal.form!.fields[0].options!.map((o) => o.value)).toEqual(["review:r1", "photo:p1"]);
    s.dispose();
  });

  test("a deleted place: Restore for who may; nothing to edit", async () => {
    const s = await setup({ account: { ...ACCOUNT, role: "trusted" } }, { ...DETAIL, deleted: true, local: "pending" });
    await s.e.loadDetail("dk", "u1");
    const a = s.e.placeActionsFor(props);
    expect(a.actions).toBeUndefined();
    expect(labels(a.footerActions)).toContain("Restore place");
    a.footerActions!.find((x) => x.label === "Restore place")!.run();
    await settle();
    expect(s.fake.calls.edit![0][0]).toEqual({ op: "restore", place_id: "u1", base_rev: 4 });
    s.dispose();
  });

  test("Write review: stars, text and date queued; bad stars said, nothing queued", async () => {
    const s = await setup({}, { ...DETAIL, reviews: [] });
    await s.e.loadDetail("dk", "u1");
    const review = s.e.placeActionsFor(props).actions!.find((x) => x.label === "Write review")!;
    review.form!.submit({ stars: "9", body: "", visited_on: "" });
    await settle();
    expect(s.fake.calls.review).toBeUndefined();
    expect(s.notes[0]).toEqual(["Review not saved", "Choose 1 to 5 stars"]);
    review.form!.submit({ stars: "4", body: "Calm", visited_on: "2026-07-01" });
    await settle();
    expect(s.fake.calls.review![0]).toEqual(["u1", { stars: 4, body: "Calm", visited_on: "2026-07-01" }]);
    s.dispose();
  });

  test("Ask to remove: the target and the reason queued", async () => {
    const s = await setup();
    await s.e.loadDetail("dk", "u1");
    const removal = s.e.placeActionsFor(props).footerActions!.find((x) => x.label === "Ask to remove…")!;
    removal.form!.submit({ target: "review:r1", reason: "  spam " });
    await settle();
    expect(s.fake.calls.requestRemoval![0][0]).toEqual({ target_type: "review", target_id: "r1", reason: "spam" });
    s.dispose();
  });

  test("a refused write is said, with the server's words", async () => {
    const s = await setup({ account: { ...ACCOUNT, role: "trusted" }, fail: "edit" });
    await s.e.loadDetail("dk", "u1");
    s.e.placeActionsFor(props).footerActions!.find((x) => x.label === "Delete place")!.run();
    await settle();
    expect(s.notes[0]).toEqual(["Couldn’t save the change", "mivport says no"]);
    s.dispose();
  });

  test("History opens the panel (online only)", async () => {
    const s = await setup({ account: { ...ACCOUNT, online: true } });
    await s.e.loadDetail("dk", "u1");
    s.e.placeActionsFor(props).footerActions!.find((x) => x.label === "History")!.run();
    expect(s.e.panel()).toEqual({ view: "history", placeId: "u1", name: "Havn" });
    expect(s.e.panelOpen()).toBe(true);
    s.dispose();
  });
});

describe("the editor", () => {
  test("Edit: opens on the place's own values; saving with no change sends nothing", async () => {
    const s = await setup();
    await s.e.editPlace("dk", "u1");
    expect(s.e.panelOpen()).toBe(true);
    expect(s.e.panel()).toEqual({ view: "edit", title: "Edit Havn" });
    expect(s.e.draft()).toEqual({ kind: "marina", name: "Havn", pos: { lat: 55, lon: 12 }, posMoved: false, values: { vhf: "16" } });
    expect(await s.e.saveDraft()).toBeUndefined();
    expect(s.fake.calls.edit).toBeUndefined();
    expect(s.notes.at(-1)).toEqual(["Nothing changed", undefined]);
    s.dispose();
  });

  test("Edit, change, save: a modify with base_rev; the panel closes", async () => {
    const s = await setup();
    await s.e.editPlace("dk", "u1");
    s.e.setDraft({ ...s.e.draft()!, values: { vhf: "12" } });
    expect(await s.e.saveDraft()).toBeUndefined();
    expect(s.fake.calls.edit![0][0]).toEqual({ op: "modify", place_id: "u1", base_rev: 4, set: { attrs: { vhf: "12" } } });
    expect(s.e.panelOpen()).toBe(false);
    s.dispose();
  });

  test("Add place: the pin first (from the chart's centre), then the form; saved as a create, then shown", async () => {
    const created: MivportLocalFeature = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [11, 54] },
      properties: { src: "mivport", ref: "new-uuid", kind: "anchorage", name: "Bugt", local: "pending" },
    };
    const s = await setup();
    await s.e.addPlace({ pin: true, at: { lat: 50, lon: 10 } });
    expect(s.mode()).toBe(MIVPORT_PIN_MODE_ID);
    expect(s.e.panelOpen()).toBe(false);
    // A tap moves the pin; the pill's primary action takes it.
    expect(s.pinMode.onClick!({ lngLat: { lat: 54, lng: 11 } } as never)).toBe(true);
    const done = s.pinMode.pill!({ density: 0 } as never).actions![0];
    expect(done.label).toBe("Next");
    done.run();
    expect(s.mode()).toBeNull();
    expect(s.e.panelOpen()).toBe(true);
    expect(s.e.draft()!.pos).toEqual({ lat: 54, lon: 11 });
    s.e.setDraft({ ...s.e.draft()!, name: "Bugt", values: { holding: "good" } });
    s.fake.local = { features: [created], hide: [] };
    expect(await s.e.saveDraft()).toBeUndefined();
    expect(s.fake.calls.edit![0][0]).toEqual({
      op: "create",
      set: { kind: "anchorage", name: "Bugt", geom: { lat: 54, lon: 11 }, attrs: { holding: "good" } },
    });
    expect(s.hits.at(-1)![0]).toMatchObject({ providerId: "poi", id: "mivport:new-uuid", title: "Bugt" });
    s.dispose();
  });

  test("Add place, then leave the pin mode without taking it: nothing is left behind", async () => {
    const s = await setup();
    await s.e.addPlace({ pin: true, at: { lat: 50, lon: 10 } });
    s.pinMode.leave!();
    expect(s.e.draft()).toBeUndefined();
    expect(s.e.panelOpen()).toBe(false);
    s.dispose();
  });

  test("Move pin from the editor, then cancel: the position is put back and the editor returns", async () => {
    const s = await setup();
    await s.e.editPlace("dk", "u1");
    s.e.startPin();
    expect(s.e.panelOpen()).toBe(false);
    s.pinMode.onClick!({ lngLat: { lat: 1, lng: 2 } } as never);
    expect(s.e.draft()!.pos).toEqual({ lat: 1, lon: 2 });
    s.pinMode.leave!();
    expect(s.e.draft()).toMatchObject({ pos: { lat: 55, lon: 12 }, posMoved: false });
    expect(s.e.panelOpen()).toBe(true);
    s.dispose();
  });

  test("logged out: Add place says to log in, opens nothing", async () => {
    const s = await setup({ account: { ...ACCOUNT, logged_in: false } });
    await s.e.addPlace({ pin: true });
    expect(s.mode()).toBeNull();
    expect(s.notes[0][0]).toBe("Log in to mivport first");
    s.dispose();
  });

  test("Add to mivport on a mark: the editor at the mark, with its name", async () => {
    const s = await setup();
    const [add] = s.e.markActions({ name: "Mark 3", lat: 54.5, lon: 11.5 });
    expect(add.label).toBe("Add to mivport");
    add.run();
    await settle();
    expect(s.e.panelOpen()).toBe(true);
    expect(s.e.draft()).toMatchObject({ name: "Mark 3", pos: { lat: 54.5, lon: 11.5 }, posMoved: true });
    s.dispose();
  });

  test("no Add to mivport on a mark while logged out", async () => {
    const s = await setup({ account: { ...ACCOUNT, logged_in: false } });
    expect(s.e.markActions({ name: "M", lat: 1, lon: 2 })).toEqual([]);
    s.dispose();
  });
});

describe("the outbox and the account", () => {
  test("Discard: dropped on the boat, then the outbox, the local layer and the account re-read", async () => {
    const s = await setup();
    const before = s.fake.calls.local!.length;
    await s.e.discard("i9");
    expect(s.fake.calls.discard![0]).toEqual(["i9"]);
    expect(s.fake.calls.outbox!.length).toBeGreaterThan(0);
    expect(s.fake.calls.local!.length).toBe(before + 1);
    s.dispose();
  });

  test("log in fetches the registry; log out takes the account the server answers", async () => {
    const s = await setup({ account: { ...ACCOUNT, logged_in: false } });
    s.fake.account = { ...ACCOUNT };
    await s.e.login("anna", "pw");
    expect(s.fake.calls.login![0]).toEqual(["anna", "pw"]);
    expect(s.e.account()?.logged_in).toBe(true);
    await settle();
    expect(s.fake.calls.registry!.length).toBe(2);
    await s.e.logout();
    expect(s.e.account()?.logged_in).toBe(false);
    s.dispose();
  });

  test("a refused login rejects with the server's words (the form shows them)", async () => {
    const s = await setup({ fail: "login" });
    await expect(s.e.login("anna", "bad")).rejects.toThrow("mivport says no");
    s.dispose();
  });
});

describe("localPlaceHit", () => {
  test("a POI hit keyed like the provider's (src:ref), titled by its name", () => {
    const h = localPlaceHit({
      type: "Feature",
      geometry: { type: "Point", coordinates: [12, 55] },
      properties: { src: "mivport", ref: "u1", kind: "marina", name: "Havn", local: "pending" },
    });
    expect(h).toMatchObject({
      providerId: "poi",
      id: "mivport:u1",
      title: "Havn",
      lngLat: { lng: 12, lat: 55 },
      payload: { ref: "u1", local: "pending" },
    });
  });
});
