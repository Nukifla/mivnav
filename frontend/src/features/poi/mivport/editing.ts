// mivport editing on the boat (docs/architecture/mivport-editing.md): the
// account, the registry, the outbox and the local overlay as signals over
// the backend's `/api/mivport/*` routes; the info-panel actions on a mivport
// point (Edit, Delete / Restore, Write review, Add photo, Request removal,
// History); the place editor's draft and its pin mode; the "Add mivport
// place" command and "Add to mivport" on a mark; and Settings → mivport.
//
// Every write answers at once from the boat (it is queued in the boat's
// outbox and uploaded when mivport is reachable), so nothing here waits on
// mivport except logging in and the history.

import { batch, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import type { Map as MLMap } from "maplibre-gl";
import MapPinPlus from "lucide-solid/icons/map-pin-plus";
import UserRound from "lucide-solid/icons/user-round";
import { defineCommand } from "../../../core/chrome/command";
import { defineFeature, type AppFeature } from "../../../core/chrome/feature";
import type { GeoPoint } from "../../../core/chrome/geo";
import type { InfoAction, InfoHit } from "../../../core/info/types";
import { defineSettingsSection } from "../../../core/settings/registry";
import type { SettingsCtx } from "../../../core/settings/ctx";
import { POI_PROVIDER_ID, poiSubtitle } from "../provider";
import type { PoiFeatureProps } from "../sources";
import { createMivportApi, type MivportApi, type MivportPhotoUpload } from "./client";
import { fetchMivportDetail } from "./detail";
import {
  buildEdit,
  initialDraft,
  kindLabel,
  newOrigin,
  originFromDetail,
  type PlaceDraft,
  type PlaceOrigin,
} from "./form";
import { bindMivportHooks } from "./hooks";
import { detailSet, MIVPORT_SRC } from "./index";
import { createMivportLocalOverlay } from "./localLayer";
import { canDeletePlace, cleanHide, placeActions, reviewBody, today } from "./model";
import { MivportSettingsSection } from "./Settings";
import type {
  MivportAccount,
  MivportEditRequest,
  MivportGeom,
  MivportLocalFeature,
  MivportLocalLayer,
  MivportOutboxItem,
  MivportPlaceDetail,
  MivportRegistry,
} from "./types";

export const MIVPORT_PIN_MODE_ID = "mivport-pin";
/** The local layer and the account are re-read this often (doc: 30 s). */
export const MIVPORT_POLL_MS = 30_000;

/** What the mivport panel (./MivportPanel.tsx) shows. */
export type MivportPanelView =
  | { view: "edit"; title: string }
  | { view: "photo"; placeId: string; name?: string; set: string }
  | { view: "history"; placeId: string; name?: string };

export interface MivportEditingDeps {
  api?: MivportApi;
  /** The detail read (default: the backend's merged detail route). */
  loadDetail?: (setId: string, ref: string) => Promise<MivportPlaceDetail>;
  /** Open the info panel on these hits. */
  showHits?: (hits: InfoHit[]) => void;
  /** Say something to the skipper (a write queued, a write refused). */
  notify?: (title: string, detail?: string) => void;
  /** The boat's position, when there is a fix. */
  boat?: () => GeoPoint | undefined;
  /** Close the other docked panels before this one opens. */
  beforeOpenPanel?: () => void;
  /** Bind the source's hooks (default true; tests that only drive the store
   * may leave the global binding alone). */
  bind?: boolean;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (id: unknown) => void;
}

export interface MivportEditing {
  feature: AppFeature;
  api: MivportApi;
  account: Accessor<MivportAccount | undefined>;
  registry: Accessor<MivportRegistry | undefined>;
  local: Accessor<MivportLocalLayer>;
  outbox: Accessor<MivportOutboxItem[]>;
  refreshAccount: () => Promise<void>;
  refreshLocal: () => Promise<void>;
  refreshOutbox: () => Promise<void>;
  refreshRegistry: () => Promise<MivportRegistry | undefined>;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string, email?: string) => Promise<void>;
  deviceLogin: () => Promise<void>;
  logout: () => Promise<void>;
  sync: () => Promise<void>;
  discard: (id: string) => Promise<void>;

  /** The remembered detail of a place (reactive). */
  cachedDetail: (setId: string, ref: string) => MivportPlaceDetail | undefined;
  loadDetail: (setId: string, ref: string) => Promise<MivportPlaceDetail>;
  /** The info-panel actions for a mivport point's props. */
  placeActionsFor: (props: PoiFeatureProps) => { actions?: InfoAction[]; footerActions?: InfoAction[] };
  /** "Add to mivport" for a dropped mark. */
  markActions: (m: { name: string; lat: number; lon: number }) => InfoAction[];

  // The panel
  panel: Accessor<MivportPanelView | undefined>;
  panelOpen: Accessor<boolean>;
  closePanel: () => void;
  origin: Accessor<PlaceOrigin | undefined>;
  draft: Accessor<PlaceDraft | undefined>;
  setDraft: (d: PlaceDraft) => void;
  /** Open the editor on an existing place. */
  editPlace: (setId: string, ref: string) => Promise<void>;
  /** Start a new place: at `at` (default the chart's centre); `pin` first
   * asks for the position on the chart. */
  addPlace: (opts?: { at?: MivportGeom; name?: string; pin?: boolean }) => Promise<void>;
  /** Hide the editor and position the pin on the chart. */
  startPin: () => void;
  /** Send the editor's place. Resolves an error to show, or undefined. */
  saveDraft: () => Promise<string | undefined>;
  uploadPhoto: (placeId: string, photo: MivportPhotoUpload) => Promise<boolean>;
  deletePhoto: (placeId: string, photoId: string) => Promise<void>;
  openHistory: (placeId: string, name?: string) => void;
  /** Wire the mode seam once both exist (App's `createModeState`). */
  bindMode: (opts: { enter: (id: string) => void; leave: () => void; active: Accessor<string | null> }) => void;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const keyOf = (setId: string, ref: string) => `${setId}\n${ref}`;
const message = (e: unknown) => (e instanceof Error && e.message ? e.message : "The boat’s server didn’t answer.");

/** The info-panel hit for a place of the local layer. */
export function localPlaceHit(f: MivportLocalFeature): InfoHit {
  const p = f.properties;
  const subtitle = poiSubtitle(str(p.kind), str(p.kind_detail), MIVPORT_SRC);
  const [lng, lat] = f.geometry.coordinates;
  return {
    providerId: POI_PROVIDER_ID,
    id: `${MIVPORT_SRC}:${p.ref}`,
    priority: "regulated",
    precision: "point",
    title: str(p.name) ?? subtitle ?? "POI",
    ...(subtitle ? { subtitle } : {}),
    lngLat: { lng, lat },
    payload: { ...p },
  };
}

export function createMivportEditing(deps: MivportEditingDeps = {}): MivportEditing {
  const api = deps.api ?? createMivportApi();
  const load = deps.loadDetail ?? ((s: string, r: string) => fetchMivportDetail(s, r));
  const notify = (title: string, detail?: string) => deps.notify?.(title, detail);
  const every = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const stopEvery = deps.clearInterval ?? ((id) => clearInterval(id as ReturnType<typeof setInterval>));

  // Equal polls are no change: a re-read that changes nothing must not
  // re-resolve an open info panel (and close a review being typed).
  const sameJson = <T,>(a: T, b: T) => JSON.stringify(a) === JSON.stringify(b);
  const [account, setAccount] = createSignal<MivportAccount | undefined>(undefined, { equals: sameJson });
  const [registry, setRegistry] = createSignal<MivportRegistry>();
  const [local, setLocal] = createSignal<MivportLocalLayer>({ features: [], hide: [] }, { equals: sameJson });
  const [outbox, setOutbox] = createSignal<MivportOutboxItem[]>([]);
  const [details, setDetails] = createSignal<Record<string, MivportPlaceDetail>>({});
  const [panel, setPanel] = createSignal<MivportPanelView>();
  const [panelOpen, setPanelOpen] = createSignal(false);
  const [origin, setOrigin] = createSignal<PlaceOrigin>();
  const [draft, setDraft] = createSignal<PlaceDraft>();
  const [map, setMap] = createSignal<MLMap>();
  let enterMode: (id: string) => void = () => {};
  let leaveMode: () => void = () => {};
  let activeMode: Accessor<string | null> = () => null;

  // ---- reads

  const refreshAccount = async () => {
    try {
      setAccount(await api.account());
    } catch {
      setAccount(undefined);
    }
  };
  let latestLocal = 0;
  const refreshLocal = async () => {
    const request = ++latestLocal;
    try {
      const l = await api.local();
      if (request !== latestLocal) return;
      setLocal({ features: Array.isArray(l?.features) ? l.features : [], hide: cleanHide(l?.hide) });
    } catch {
      // Unreachable: keep what we have.
    }
  };
  const refreshOutbox = async () => {
    try {
      const o = await api.outbox();
      setOutbox(Array.isArray(o?.items) ? o.items : []);
    } catch {
      // Keep the last list.
    }
  };
  const refreshRegistry = async () => {
    try {
      const r = await api.registry();
      if (r && Array.isArray(r.kinds) && Array.isArray(r.attrs)) setRegistry(r);
    } catch {
      // Never fetched yet (503) or unreachable: the editor says so.
    }
    return registry();
  };

  const inflight = new Map<string, Promise<MivportPlaceDetail>>();
  const loadDetail = (setId: string, ref: string): Promise<MivportPlaceDetail> => {
    const key = keyOf(setId, ref);
    const pending = inflight.get(key);
    if (pending) return pending;
    const p = load(setId, ref)
      .then((d) => {
        if (!sameJson(details()[key], d)) setDetails((all) => ({ ...all, [key]: d }));
        return details()[key] ?? d;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };
  const cachedDetail = (setId: string, ref: string) => details()[keyOf(setId, ref)];
  /** Re-read every remembered detail of `ref` (or all), after a write. */
  const refetchDetails = async (ref?: string) => {
    const keys = Object.keys(details()).filter((k) => ref === undefined || k.endsWith(`\n${ref}`));
    await Promise.all(
      keys.map((k) => {
        const [s, r] = k.split("\n");
        return loadDetail(s, r).catch(() => undefined);
      }),
    );
  };

  void refreshAccount();
  void refreshLocal();
  void refreshRegistry();
  const timer = every(() => {
    void refreshLocal();
    void refreshAccount();
  }, MIVPORT_POLL_MS);
  onCleanup(() => stopEvery(timer));
  if (typeof document !== "undefined") {
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void refreshLocal();
        void refreshAccount();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    onCleanup(() => document.removeEventListener("visibilitychange", onVisible));
  }

  // ---- writes

  const queuedNote = () =>
    account()?.online ? "Uploading to mivport." : "Saved on the boat; uploaded when mivport can be reached.";

  const afterWrite = async (ref?: string) => {
    await Promise.all([refreshLocal(), refreshAccount(), refreshOutbox(), refetchDetails(ref)]);
  };

  /** Run one queued write: say it is saved (or why not), then re-read. */
  const write = async <T>(run: () => Promise<T>, done: string, ref?: string): Promise<T | undefined> => {
    try {
      const out = await run();
      notify(done, queuedNote());
      await afterWrite(ref);
      return out;
    } catch (e) {
      notify("Couldn’t save the change", message(e));
      return undefined;
    }
  };

  const showPlace = (ref: string) => {
    const f = local().features.find((x) => x.properties?.ref === ref && !x.properties.deleted);
    if (f) deps.showHits?.([localPlaceHit(f)]);
  };

  // ---- account

  const login = async (username: string, password: string) => {
    setAccount(await api.login(username, password));
    void refreshRegistry();
    void refreshOutbox();
  };
  const register = async (username: string, password: string, email?: string) => {
    setAccount(await api.register(username, password, email));
    void refreshRegistry();
  };
  const deviceLogin = async () => {
    await api.deviceLogin();
    await refreshAccount();
  };
  const logout = async () => {
    setAccount(await api.logout());
  };
  const sync = async () => {
    setAccount(await api.sync());
    await Promise.all([refreshOutbox(), refreshLocal(), refetchDetails()]);
  };
  const discard = async (id: string) => {
    await api.discard(id);
    await Promise.all([refreshOutbox(), refreshLocal(), refreshAccount(), refetchDetails()]);
  };

  // ---- the panel and the editor

  const openPanel = (view: MivportPanelView) => {
    deps.beforeOpenPanel?.();
    batch(() => {
      setPanel(view);
      setPanelOpen(true);
    });
  };
  const closePanel = () => {
    batch(() => {
      setPanelOpen(false);
      if (activeMode() !== MIVPORT_PIN_MODE_ID) {
        setOrigin(undefined);
        setDraft(undefined);
      }
    });
  };

  const needRegistry = async (): Promise<MivportRegistry | undefined> => {
    const reg = registry() ?? (await refreshRegistry());
    if (!reg) {
      notify(
        "mivport’s place types aren’t on the boat yet",
        "Log in to mivport once while it can be reached (Settings → mivport).",
      );
    }
    return reg;
  };

  const needLogin = (): boolean => {
    if (account()?.logged_in) return true;
    notify("Log in to mivport first", "Settings → mivport.");
    return false;
  };

  const localPos = (ref: string): MivportGeom | undefined => {
    const f = local().features.find((x) => x.properties?.ref === ref);
    return f ? { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] } : undefined;
  };

  const chartCentre = (): MivportGeom | undefined => {
    const c = map()?.getCenter();
    if (c) return { lat: c.lat, lon: c.lng };
    const b = deps.boat?.();
    return b ? { lat: b.lat, lon: b.lng } : undefined;
  };

  const editPlace = async (setId: string, ref: string) => {
    if (!needLogin()) return;
    const reg = await needRegistry();
    if (!reg) return;
    let d: MivportPlaceDetail;
    try {
      d = cachedDetail(setId, ref) ?? (await loadDetail(setId, ref));
    } catch (e) {
      notify("Couldn’t open the place", message(e));
      return;
    }
    const o = originFromDetail(d, localPos(ref));
    batch(() => {
      setOrigin(o);
      setDraft(initialDraft(o, reg));
    });
    const name = str(d.name) ?? kindLabel(reg, d.kind);
    openPanel({ view: "edit", title: o.isCore ? `Edit ${name}` : `Add mivport details: ${name}` });
  };

  // The pin mode's bookkeeping: what it was started for, and the position
  // before, to put back on Cancel.
  let pinIntent: "add" | "edit" | undefined;
  let pinDone = false;
  let pinBefore: Pick<PlaceDraft, "pos" | "posMoved"> | undefined;

  const startPin = () => {
    const d = draft();
    if (!d) return;
    pinIntent = origin()?.ref === undefined && !panelOpen() ? "add" : "edit";
    pinDone = false;
    pinBefore = { pos: d.pos, posMoved: d.posMoved };
    if (!d.pos) {
      const c = chartCentre();
      if (c) setDraft({ ...d, pos: c, posMoved: true });
    }
    setPanelOpen(false);
    enterMode(MIVPORT_PIN_MODE_ID);
  };

  const addPlace = async (opts: { at?: MivportGeom; name?: string; pin?: boolean } = {}) => {
    if (!needLogin()) return;
    const reg = await needRegistry();
    if (!reg) return;
    const o = newOrigin(opts.at ?? chartCentre());
    batch(() => {
      setOrigin(o);
      setDraft(initialDraft(o, reg, opts.name ?? ""));
      setPanel({ view: "edit", title: "New mivport place" });
    });
    if (opts.pin) {
      startPin();
      return;
    }
    openPanel({ view: "edit", title: "New mivport place" });
  };

  const saveDraft = async (): Promise<string | undefined> => {
    const reg = registry();
    const o = origin();
    const d = draft();
    if (!reg || !o || !d) return "Nothing to save";
    const built = buildEdit(reg, o, d);
    if (built.error) return built.error;
    if (!built.request) {
      notify("Nothing changed");
      return undefined;
    }
    const req: MivportEditRequest = built.request;
    const res = await write(() => api.edit(req), o.ref === undefined ? "Place added" : "Place saved", o.ref);
    if (!res) return "Not saved";
    batch(() => {
      setPanelOpen(false);
      setOrigin(undefined);
      setDraft(undefined);
    });
    // The new place (or the place under its new id) from the local layer.
    if (res.place_id !== o.ref) await refetchDetails(res.place_id);
    showPlace(res.place_id);
    return undefined;
  };

  const uploadPhoto = async (placeId: string, photo: MivportPhotoUpload) => {
    const res = await write(() => api.uploadPhoto(placeId, photo), "Photo added", placeId);
    return res !== undefined;
  };
  const deletePhoto = async (placeId: string, photoId: string) => {
    await write(() => api.deletePhoto(photoId), "Photo removed", placeId);
  };
  const openHistory = (placeId: string, name?: string) =>
    openPanel({ view: "history", placeId, ...(name ? { name } : {}) });

  // ---- the info-panel actions

  // Only what the actions depend on: the last sync's time moving on must
  // not re-resolve the panel.
  const who = createMemo(
    () => {
      const a = account();
      return a
        ? { logged_in: a.logged_in, online: a.online, username: a.username ?? null, role: a.role ?? null }
        : undefined;
    },
    undefined,
    { equals: sameJson },
  );

  const placeActionsFor = (props: PoiFeatureProps) => {
    const ref = str(props.ref);
    if (!ref) return {};
    const setId = detailSet(props) ?? "local";
    const detail = cachedDetail(setId, ref);
    const acct = who();
    const ids = placeActions({ account: acct, ref, ...(detail ? { detail } : {}) });
    if (!ids.length) return {};
    const name = str(detail?.name) ?? str(props.name) ?? "this place";
    const me = acct?.username;
    const head: InfoAction[] = [];
    const foot: InfoAction[] = [];
    const placeEdit = (op: "delete" | "restore") =>
      write(
        () =>
          api.edit({
            op,
            place_id: ref,
            ...(detail?.rev !== undefined ? { base_rev: detail.rev } : {}),
          }),
        op === "delete" ? "Place deleted" : "Place restored",
        ref,
      );
    const mine = detail?.reviews?.find((r) => me && r.user === me);

    for (const id of ids) {
      switch (id) {
        case "edit":
          head.push({ label: "Edit", run: () => void editPlace(setId, ref) });
          break;
        case "review":
          head.push({
            label: mine ? "Change review" : "Write review",
            keepOpen: true,
            run: () => {},
            form: {
              submitLabel: "Save review",
              fields: [
                {
                  key: "stars",
                  label: "Stars",
                  value: String(mine?.stars ?? 5),
                  maxLength: 1,
                  options: [5, 4, 3, 2, 1].map((n) => ({ value: String(n), label: "★".repeat(n) })),
                },
                { key: "body", label: "Review", value: mine?.body ?? "", maxLength: 5000, multiline: true },
                {
                  key: "visited_on",
                  label: "Visited on (YYYY-MM-DD)",
                  value: mine ? (mine.visited_on ?? "") : today(),
                  maxLength: 10,
                },
              ],
              submit: (values) => {
                const r = reviewBody(values);
                if ("error" in r) {
                  notify("Review not saved", r.error);
                  return;
                }
                void write(() => api.review(ref, r.body), "Review saved", ref);
              },
            },
          });
          break;
        case "photo":
          head.push({
            label: "Add photo",
            run: () => openPanel({ view: "photo", placeId: ref, name, set: setId }),
          });
          break;
        case "delete":
          foot.push({
            label: "Delete place",
            keepOpen: true,
            confirm: { question: `Delete ${name}? It can be restored later.`, label: "Delete" },
            run: () => void placeEdit("delete"),
          });
          break;
        case "restore":
          foot.push({ label: "Restore place", keepOpen: true, run: () => void placeEdit("restore") });
          break;
        case "removal": {
          const targets: { value: string; label: string }[] = [];
          if (!canDeletePlace({ account: acct, ref, ...(detail ? { detail } : {}) }) && !detail?.deleted) {
            targets.push({ value: `place:${ref}`, label: "This place" });
          }
          for (const r of detail?.reviews ?? []) {
            if (r.id && r.user !== me) targets.push({ value: `review:${r.id}`, label: `Review by ${r.user}` });
          }
          (detail?.photos ?? []).forEach((p, i) => {
            if (p.id && p.user !== me) {
              targets.push({ value: `photo:${p.id}`, label: p.caption ? `Photo: ${p.caption}` : `Photo ${i + 1}` });
            }
          });
          if (!targets.length) break;
          foot.push({
            label: "Ask to remove…",
            keepOpen: true,
            run: () => {},
            form: {
              submitLabel: "Send to moderators",
              fields: [
                { key: "target", label: "What", value: targets[0].value, maxLength: 200, options: targets },
                { key: "reason", label: "Why should it be removed?", value: "", maxLength: 1000, multiline: true },
              ],
              submit: ({ target, reason }) => {
                const why = (reason ?? "").trim();
                const [type, ...rest] = (target ?? "").split(":");
                const tid = rest.join(":");
                if (!why || !tid || (type !== "place" && type !== "review" && type !== "photo")) {
                  notify("Not sent", "Say why it should be removed.");
                  return;
                }
                void write(
                  () => api.requestRemoval({ target_type: type, target_id: tid, reason: why }),
                  "Removal request saved",
                  ref,
                );
              },
            },
          });
          break;
        }
        case "history":
          foot.push({ label: "History", run: () => openHistory(ref, name) });
          break;
      }
    }
    if (mine?.id && !detail?.deleted) {
      const reviewId = mine.id;
      foot.push({
        label: "Delete my review",
        keepOpen: true,
        confirm: { question: "Delete your review of this place?", label: "Delete" },
        run: () => void write(() => api.deleteReview(reviewId), "Review deleted", ref),
      });
    }
    return {
      ...(head.length ? { actions: head } : {}),
      ...(foot.length ? { footerActions: foot } : {}),
    };
  };

  const markActions = (m: { name: string; lat: number; lon: number }): InfoAction[] =>
    account()?.logged_in
      ? [
          {
            label: "Add to mivport",
            run: () => void addPlace({ at: { lat: m.lat, lon: m.lon }, name: m.name }),
          },
        ]
      : [];

  // ---- the feature

  const pinShown = () => activeMode() === MIVPORT_PIN_MODE_ID || (panelOpen() && panel()?.view === "edit");

  const overlay = createMivportLocalOverlay({
    features: () => local().features,
    pin: () => (pinShown() ? draft()?.pos : undefined),
    pinDraggable: () => activeMode() === MIVPORT_PIN_MODE_ID,
    onPinDrag: (at) => {
      const d = draft();
      if (d) setDraft({ ...d, pos: at, posMoved: true });
    },
    onMap: (m) => {
      if (map() !== m) setMap(m);
    },
  });

  const section = defineSettingsSection<SettingsCtx>({
    id: "mivport",
    title: "mivport",
    icon: UserRound,
    group: "server",
    // After Datasets (20), before Storage (40): where a POI source's account
    // belongs.
    order: 30,
    render: (p) => MivportSettingsSection({ ctx: p.ctx, editing }),
  });

  const feature = defineFeature({
    id: "mivport-editing",
    overlay,
    modes: [
      {
        id: MIVPORT_PIN_MODE_ID,
        label: "Place position",
        // Reached from the editor and the Add place command only.
        hidden: true,
        hint: () => "Drag the pin, or tap where the place is",
        onClick: (click) => {
          const d = draft();
          if (d) setDraft({ ...d, pos: { lat: click.lngLat.lat, lon: click.lngLat.lng }, posMoved: true });
          return true;
        },
        pill: () => ({
          actions: [
            {
              id: "mivport-pin-done",
              label: pinIntent === "add" ? "Next" : "Use this position",
              kind: "primary",
              disabled: !draft()?.pos,
              run: () => {
                pinDone = true;
                leaveMode();
              },
            },
          ],
        }),
        leave: () => {
          const intent = pinIntent;
          pinIntent = undefined;
          if (!pinDone) {
            // Left without "Use this position": a new place is dropped, an
            // edit gets its old position back.
            if (intent === "add") {
              batch(() => {
                setOrigin(undefined);
                setDraft(undefined);
              });
              return;
            }
            const d = draft();
            if (d && pinBefore) setDraft({ ...d, ...pinBefore });
          }
          const view = panel();
          if (draft()) openPanel(view?.view === "edit" ? view : { view: "edit", title: "New mivport place" });
        },
      },
    ],
    commands: () => [
      defineCommand({
        id: "mivport-add-place",
        label: "Add mivport place",
        group: "App",
        hint: "A new place in mivport, the sailors’ place database",
        keywords: ["mivport", "place", "poi", "add", "anchorage", "marina", "new"],
        icon: MapPinPlus,
        run: (ctx) => {
          ctx.close();
          void addPlace({ pin: true });
        },
      }),
    ],
    settings: { settings: [], sections: [section] },
  });

  const editing: MivportEditing = {
    feature,
    api,
    account,
    registry,
    local,
    outbox,
    refreshAccount,
    refreshLocal,
    refreshOutbox,
    refreshRegistry,
    login,
    register,
    deviceLogin,
    logout,
    sync,
    discard,
    cachedDetail,
    loadDetail,
    placeActionsFor,
    markActions,
    panel,
    panelOpen,
    closePanel,
    origin,
    draft,
    setDraft,
    editPlace,
    addPlace,
    startPin,
    saveDraft,
    uploadPhoto,
    deletePhoto,
    openHistory,
    bindMode: (opts) => {
      enterMode = opts.enter;
      leaveMode = opts.leave;
      activeMode = opts.active;
    },
  };

  if (deps.bind !== false) {
    const unbind = bindMivportHooks({
      actions: placeActionsFor,
      hiddenRefs: () => local().hide,
      loadDetail,
      cachedDetail,
    });
    onCleanup(unbind);
  }

  return editing;
}
