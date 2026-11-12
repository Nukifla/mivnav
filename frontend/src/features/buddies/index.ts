// Buddies: boats the skipper follows wherever they are, kept on the chart
// after they go quiet. One AppFeature: the overlay of quiet buddies, their
// info provider, and the palette command for the list panel (`list`, rendered
// by App as <BuddyList>). The server owns the list and every position; this
// is one poller over `/api/buddies`. See docs/architecture/buddies.md.

import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import type { Map as MLMap } from "maplibre-gl";
import Sailboat from "lucide-solid/icons/sailboat";
import { defineCommand } from "../../core/chrome/command";
import { defineFeature, type AppFeature } from "../../core/chrome/feature";
import { vesselInfoHit } from "../../core/info/vesselProvider";
import type { InfoAction, InfoHit } from "../../core/info/types";
import type { AisVessel } from "../../core/info/vessel";
import type { SignalKState } from "../../core/signalk";
import type { ChartSettings } from "../../core/style/settings";
import { createBuddiesApi, type BuddiesApi } from "./client";
import { buddyFeatures, canAddBuddy, displayName, remembered, type Buddy, type BuddyList } from "./model";
import { createBuddiesOverlay } from "./overlay";
import { buddyHit, createBuddyProvider } from "./provider";

const POLL_MS = 30_000;
const POSITION_SETTLE_MS = 3_000;

function removeAction(b: Buddy, run: () => void, keepOpen: boolean): InfoAction {
  return {
    label: "Remove buddy",
    keepOpen,
    run,
    confirm: { question: `Remove ${displayName(b)}?`, label: "Remove" },
  };
}

export interface BuddiesDeps {
  signalk: SignalKState;
  settings: Accessor<ChartSettings>;
  showHits?: (hits: InfoHit[]) => void;
  beforeOpenList?: () => void;
  api?: BuddiesApi;
  /** Say something to the skipper: a panel button has nowhere to show an error. */
  notify?: (text: string) => void;
}

export interface Buddies {
  feature: AppFeature;
  api: BuddiesApi;
  list: {
    open: Accessor<boolean>;
    setOpen: (open: boolean) => void;
    show: () => void;
  };
  data: Accessor<BuddyList | undefined>;
  /** Re-read the list now, after an edit. */
  reload: () => Promise<void>;
  /** Fly to a buddy and open its panel. No-op without a position. */
  focus: (b: Buddy) => void;
  /** The "Add to buddies" button on a tapped boat's panel. */
  vesselActions: (v: AisVessel) => InfoAction[];
}

export function createBuddies(deps: BuddiesDeps): Buddies {
  const api = deps.api ?? createBuddiesApi();
  const [data, setData] = createSignal<BuddyList>();
  const [map, setMap] = createSignal<MLMap>();
  const [listOpen, setListOpen] = createSignal(false);

  // Latest request wins: a poll that left before an edit must not land after
  // the edit's own reload and put the old list back.
  let latest = 0;
  const reload = async () => {
    const request = ++latest;
    try {
      const list = await api.list();
      if (request === latest) setData(list);
    } catch {
      // The server is unreachable: keep showing what we have.
    }
  };
  void reload();
  const timer = setInterval(() => void reload(), POLL_MS);
  onCleanup(() => clearInterval(timer));

  const buddies = createMemo(() => data()?.buddies ?? []);
  createEffect(() => {
    deps.signalk.setBuddies(
      new Map(
        buddies().flatMap((b) =>
          b.mmsi
            ? [[b.mmsi, { aisName: b.aisName, nickname: b.nickname, note: b.note }] as const]
            : [],
        ),
      ),
    );
  });

  // A target hidden by `showAisTargets` isn't on the chart, so this feature
  // draws it instead: a buddy never vanishes because traffic is switched off.
  const liveMmsis = createMemo(() => {
    if (!deps.settings().showAisTargets) return new Set<string>();
    return new Set(deps.signalk.vessels().flatMap((v) => (v.mmsi && !v.self ? [v.mmsi] : [])));
  });
  const drawn = createMemo(() => remembered(buddies(), liveMmsis()));

  const provider = createBuddyProvider({
    drawn,
    // Closes the panel: once removed, a quiet buddy has nothing left to show.
    actions: (b) => [
      editAction(b),
      removeAction(b, () => void api.remove(b.id).then(reload, fail), false),
    ],
    settings: deps.settings,
    own: () => {
      const s = deps.signalk.self();
      return s ? { lng: s.lng, lat: s.lat } : undefined;
    },
    project: (p) => map()?.project([p.lng, p.lat]),
  });

  const list = {
    open: listOpen,
    setOpen: setListOpen,
    show: () => {
      deps.beforeOpenList?.();
      setListOpen(true);
    },
  };

  const focus = (b: Buddy) => {
    const p = b.position;
    if (!p) return;
    map()?.flyTo({ center: [p.lng, p.lat] });
    const live = b.mmsi && liveMmsis().has(b.mmsi)
      ? deps.signalk.vessels().find((v) => v.mmsi === b.mmsi)
      : undefined;
    deps.showHits?.([live ? vesselInfoHit(live.id, displayName(b)) : buddyHit(b)]);
  };

  const fail = (e: unknown) => {
    deps.notify?.(e instanceof Error ? e.message : "Couldn’t reach the boat’s server.");
  };

  const editAction = (b: Buddy): InfoAction => ({
    label: "Edit buddy",
    keepOpen: true,
    run: () => {},
    form: {
      fields: [
        { key: "nickname", label: "Nickname", value: b.nickname ?? "", maxLength: 64 },
        { key: "note", label: "Note", value: b.note ?? "", maxLength: 500, multiline: true },
      ],
      submit: ({ nickname, note }) => {
        void api
          .edit(b.id, nickname?.trim() || undefined, note?.trim() || undefined)
          .then(reload, fail);
      },
    },
  });

  const removeBuddy = (b: Buddy) => {
    void api.remove(b.id).then(reload, fail);
  };

  const addBuddy = (mmsi: string) => {
    void api.add(mmsi).then(async () => {
      await reload();
      // The server fetches the position after answering.
      setTimeout(() => void reload(), POSITION_SETTLE_MS);
    }, fail);
  };

  const vesselActions = (v: AisVessel): InfoAction[] => {
    const buddy = v.mmsi ? buddies().find((b) => b.mmsi === v.mmsi) : undefined;
    if (buddy) return [editAction(buddy), removeAction(buddy, () => removeBuddy(buddy), true)];
    const mmsi = v.mmsi;
    if (mmsi === undefined || !canAddBuddy(v)) return [];
    return [{ label: "Add to buddies", keepOpen: true, run: () => addBuddy(mmsi) }];
  };

  const feature = defineFeature({
    id: "buddies",
    overlay: createBuddiesOverlay((palette) => buddyFeatures(drawn(), palette), setMap),
    provider,
    commands: () => [
      defineCommand({
        id: "open-buddies",
        label: "Buddies",
        group: "App",
        hint: "Boats you follow, with their last known positions",
        keywords: ["buddy", "buddies", "friends", "follow", "mmsi", "track"],
        icon: Sailboat,
        run: (ctx) => {
          list.show();
          ctx.close();
        },
      }),
    ],
  });

  return { feature, api, list, data, reload, focus, vesselActions };
}
