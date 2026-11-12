// Standalone marks: points the skipper places outside any route — an icon, a
// name, a note. One AppFeature: the chart overlay, the info provider (edit /
// move / delete; "Go here" comes from the panel itself and is the existing
// course publish), a hidden "mark-move" mode, palette commands, and the list
// panel (`list`, rendered by App as <MarkList>). The server stores them on
// Signal K as waypoint resources; this is one poller over `/api/marks`.

import { createSignal, onCleanup, type Accessor } from "solid-js";
import type { Map as MLMap } from "maplibre-gl";
import MapPinPlus from "lucide-solid/icons/map-pin-plus";
import MapPinned from "lucide-solid/icons/map-pinned";
import { defineCommand } from "../../core/chrome/command";
import { defineFeature, type AppFeature } from "../../core/chrome/feature";
import type { GeoPoint } from "../../core/chrome/geo";
import type { InfoAction, InfoHit } from "../../core/info/types";
import type { SignalKState } from "../../core/signalk";
import type { ChartSettings } from "../../core/style/settings";
import { mintUuid } from "../route";
import { createMarksApi, type MarksApi } from "./client";
import { attachMarkDrop } from "./longPress";
import {
  displayName,
  iconOf,
  isMarkIcon,
  MARK_ICON_LABELS,
  MARK_ICONS,
  markFeatures,
  nextMarkName,
  type Mark,
  type MarkBody,
  type MarkList,
} from "./model";
import { createMarksOverlay } from "./overlay";
import { createMarkProvider, markHit } from "./provider";

const POLL_MS = 30_000;
export const MARK_MOVE_MODE_ID = "mark-move";

export interface MarksDeps {
  signalk: SignalKState;
  settings: Accessor<ChartSettings>;
  showHits?: (hits: InfoHit[]) => void;
  beforeOpenList?: () => void;
  api?: MarksApi;
  mintId?: () => string;
  /** Say something to the skipper: a failed save has nowhere else to show. */
  notify?: (text: string) => void;
  /** Injected by tests. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (id: unknown) => void;
}

export interface Marks {
  feature: AppFeature;
  api: MarksApi;
  list: { open: Accessor<boolean>; setOpen: (open: boolean) => void; show: () => void };
  marks: Accessor<Mark[]>;
  stale: Accessor<boolean>;
  reload: () => Promise<void>;
  /** Drop a new mark at `at` and open its panel. Resolves the new mark. */
  dropAt: (at: GeoPoint) => Promise<Mark | undefined>;
  /** Drop one at the boat's position; `undefined` with no fix. */
  dropAtBoat: () => Promise<Mark | undefined>;
  update: (m: Mark, patch: Partial<MarkBody>) => Promise<void>;
  remove: (m: Mark) => Promise<void>;
  /** Fly to a mark and open its panel. */
  focus: (m: Mark) => void;
  /** Wire the mode seam once both exist (App's `createModeState`). */
  bindMode: (opts: {
    enter: (id: string) => void;
    leave: () => void;
    active: Accessor<string | null>;
  }) => void;
}

const bodyOf = (m: Mark): MarkBody => ({
  name: m.name,
  note: m.note,
  icon: iconOf(m),
  lat: m.lat,
  lon: m.lon,
});

export function createMarks(deps: MarksDeps): Marks {
  const api = deps.api ?? createMarksApi();
  const mintId = deps.mintId ?? mintUuid;
  const every = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const stopEvery = deps.clearInterval ?? ((id) => clearInterval(id as ReturnType<typeof setInterval>));
  const [marks, setMarks] = createSignal<Mark[]>([]);
  const [stale, setStale] = createSignal(false);
  const [map, setMap] = createSignal<MLMap>();
  const [listOpen, setListOpen] = createSignal(false);
  const [moving, setMoving] = createSignal<string | null>(null);
  // The mark just dropped: its panel opens on the Edit form, once.
  let fresh: string | undefined;
  let enterMode: (id: string) => void = () => {};
  let leaveMode: () => void = () => {};
  let activeMode: Accessor<string | null> = () => null;

  // Latest request wins: a poll that left before an edit must not land after
  // the edit's own reload and put the old position back.
  let latest = 0;
  const reload = async () => {
    const request = ++latest;
    try {
      const list: MarkList = await api.list();
      if (request === latest) {
        setMarks(list.marks);
        setStale(list.stale);
      }
    } catch {
      // The server is unreachable: keep showing what we have.
    }
  };
  void reload();
  const timer = every(() => void reload(), POLL_MS);
  onCleanup(() => stopEvery(timer));

  const fail = (e: unknown) => {
    deps.notify?.(e instanceof Error ? e.message : "Couldn’t reach the boat’s server.");
  };

  /** Show `m` now (optimistic), store it, then re-read. A refused save puts
   * the server's copy back and says why. */
  const commit = async (m: Mark): Promise<boolean> => {
    latest++; // any poll in flight is now stale
    setMarks((all) => (all.some((x) => x.id === m.id) ? all.map((x) => (x.id === m.id ? m : x)) : [...all, m]));
    try {
      await api.save(m.id, bodyOf(m));
      await reload();
      return true;
    } catch (e) {
      fail(e);
      await reload();
      return false;
    }
  };

  const dropAt = async (at: GeoPoint): Promise<Mark | undefined> => {
    const mark: Mark = {
      id: mintId(),
      name: nextMarkName(marks()),
      note: "",
      icon: "pin",
      lat: at.lat,
      lon: at.lng,
      updated: Date.now() / 1000,
    };
    // Open the panel on it straight away, its Edit form already up.
    fresh = mark.id;
    const shown = commit(mark);
    deps.showHits?.([markHit(mark)]);
    return (await shown) ? marks().find((m) => m.id === mark.id) ?? mark : undefined;
  };

  const boat = (): GeoPoint | undefined => {
    const s = deps.signalk.self();
    return s ? { lng: s.lng, lat: s.lat } : undefined;
  };

  const dropAtBoat = async () => {
    const at = boat();
    if (!at) {
      deps.notify?.("No boat position to drop a mark at.");
      return undefined;
    }
    return dropAt(at);
  };

  const update = async (m: Mark, patch: Partial<MarkBody>) => {
    const next: Mark = { ...m, ...patch };
    await commit(next);
  };

  const remove = async (m: Mark) => {
    latest++;
    setMarks((all) => all.filter((x) => x.id !== m.id));
    try {
      await api.remove(m.id);
    } catch (e) {
      fail(e);
    }
    await reload();
  };

  const focus = (m: Mark) => {
    map()?.flyTo({ center: [m.lon, m.lat] });
    deps.showHits?.([markHit(m)]);
  };

  const startMove = (m: Mark) => {
    setMoving(m.id);
    enterMode(MARK_MOVE_MODE_ID);
  };

  const editAction = (m: Mark): InfoAction => ({
    label: "Edit",
    keepOpen: true,
    run: () => {},
    form: {
      fields: [
        { key: "name", label: "Name", value: m.name, maxLength: 64 },
        {
          key: "icon",
          label: "Icon",
          value: iconOf(m),
          maxLength: 16,
          options: MARK_ICONS.map((i) => ({ value: i, label: MARK_ICON_LABELS[i] })),
        },
        { key: "note", label: "Note", value: m.note, maxLength: 500, multiline: true },
      ],
      autoOpen: () => {
        if (fresh !== m.id) return false;
        fresh = undefined;
        return true;
      },
      submit: ({ name, icon, note }) => {
        void update(m, {
          name: (name ?? "").trim(),
          note: (note ?? "").trim(),
          icon: isMarkIcon(icon) ? icon : iconOf(m),
        });
      },
    },
  });

  const actions = (m: Mark): InfoAction[] => {
    const out: InfoAction[] = [{ label: "Move", run: () => startMove(m) }];
    const at = boat();
    if (at) {
      out.push({
        label: "Move to boat",
        keepOpen: true,
        run: () => void update(m, { lat: at.lat, lon: at.lng }),
        confirm: { question: `Move ${displayName(m)} to the boat?`, label: "Move" },
      });
    }
    out.push({
      label: "Delete",
      run: () => void remove(m),
      confirm: { question: `Delete ${displayName(m)}?`, label: "Delete" },
    });
    return out;
  };

  const provider = createMarkProvider({
    marks,
    own: boat,
    project: (p) => map()?.project([p.lng, p.lat]),
    headerActions: (m) => [editAction(m)],
    actions,
  });

  let detach: (() => void) | undefined;
  onCleanup(() => detach?.());
  const onMap = (m: MLMap) => {
    if (map() === m) return;
    detach?.();
    setMap(m);
    // A chart mode owns the chart (invariant #9): no drop while one is up.
    detach = attachMarkDrop(m, (at) => void dropAt(at), () => activeMode() === null);
  };

  const list = {
    open: listOpen,
    setOpen: setListOpen,
    show: () => {
      deps.beforeOpenList?.();
      setListOpen(true);
    },
  };

  const movingMark = () => marks().find((m) => m.id === moving());

  const feature = defineFeature({
    id: "marks",
    overlay: createMarksOverlay((palette) => markFeatures(marks(), palette), onMap),
    provider,
    modes: [
      {
        id: MARK_MOVE_MODE_ID,
        label: "Move mark",
        // Reached from a mark's panel only.
        hidden: true,
        leave: () => setMoving(null),
        hint: () => {
          const m = movingMark();
          return m ? `Tap the new position for ${displayName(m)}` : "Tap the new position";
        },
        onClick: (click) => {
          const m = movingMark();
          leaveMode();
          if (!m) return true;
          const moved = { ...m, lat: click.lngLat.lat, lon: click.lngLat.lng };
          void commit(moved);
          deps.showHits?.([markHit(moved)]);
          return true;
        },
      },
    ],
    commands: () => [
      defineCommand({
        id: "open-marks",
        label: "Marks",
        group: "App",
        hint: "Your marks: list, edit, go to",
        keywords: ["mark", "marks", "waypoint", "waypoints", "pin", "poi"],
        icon: MapPinned,
        run: (ctx) => {
          list.show();
          ctx.close();
        },
      }),
      defineCommand({
        id: "drop-mark-boat",
        label: "Drop mark at boat",
        group: "Navigation",
        hint: "A mark where the boat is now",
        keywords: ["mark", "waypoint", "pin", "here", "boat", "position"],
        icon: MapPinPlus,
        enabled: () => !!boat(),
        run: (ctx) => {
          void dropAtBoat();
          ctx.close();
        },
      }),
    ],
  });

  return {
    feature,
    api,
    list,
    marks,
    stale,
    reload,
    dropAt,
    dropAtBoat,
    update,
    remove,
    focus,
    bindMode: (opts) => {
      enterMode = opts.enter;
      leaveMode = opts.leave;
      activeMode = opts.active;
    },
  };
}
