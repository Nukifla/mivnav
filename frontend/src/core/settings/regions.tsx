import { batch, createMemo, createSignal, For, Show, type Accessor, type Component } from "solid-js";
import MapPin from "lucide-solid/icons/map-pin";
import { AccordionSection } from "../ui/Accordion";
import { Button } from "../ui/Button";
import { fetchJsonDefault, type FetchJson } from "./apiFetch";
import { dedupeId, slugify } from "./slug";

// The boat-wide named regions (backend `mivnav.config.model.Region`,
// `Config.regions`) — a sailor's areas of interest belong to the boat, not
// one dataset, so every region-shaped dataset (POI, satellite) picks from
// this ONE list. `RegionListSection` is its home (Sidebar.tsx, after
// Datasets); `DatasetEditForm`'s Region field is a plain <select> over it.
//
// `id` is the stable reference; `name` is just a label. A region used to be
// referenced SOLELY by `name` (`DatasetConfig.region_id -> Region.name`),
// fine while region UI was add-only. An edit form changes that: renaming
// would silently orphan every dataset pointed at the old name. So `Region`
// gained a separate immutable `id` (backend/mivnav/config/model.py); an old
// config.json is migrated on load (`migrate_region_ids`, derives an id from
// the current name once). A UI-added region mints its id the same way a
// fresh dataset does (`DatasetList.tsx`'s slug helpers), sent explicitly so
// a read-modify-write PATCH of untouched entries never drifts their ids.
//
// `Region.bboxes` is a LIST of boxes, not exactly one — see `regionSummary`
// and docs/architecture/region-draw.md for the draw-to-create/draw-to-edit
// flows this enables. A country-boundary-to-boxes helper is intentionally
// not built here (out of scope, POI's `country` variant already covers
// "the region IS a country").
//
// DOM-free controller (`createRegionForm`) + thin renderer (`RegionForm`),
// same split as `createPoiIngest`/`createSatelliteIngest`: the PATCH shape,
// wire format and id minting are asserted without a DOM.

/** One rectangular bounding box — the unit `Region.bboxes` is built from
 * (backend `mivnav.config.model.BBox`). */
export interface BBox {
  min_lon: number;
  min_lat: number;
  max_lon: number;
  max_lat: number;
}

/** One boat-wide named area of interest. EITHER a whole country (`country`
 * set — the bake fetches its real boundary) OR one or more explicit boxes
 * (`bboxes`, `country` unset); both fields are always present on the wire,
 * empty on the unused side. `id` is the stable, immutable reference (see the
 * module docstring); `name` is an editable label only. */
export interface Region {
  id: string;
  name: string;
  country?: string | null;
  bboxes: BBox[];
}

/**
 * The wire shape for ONE region in a `PATCH /api/config` body: `id` always
 * included (the backend validates it, never re-derives it), plus country XOR
 * `bboxes`, narrowed back down to the one variant in force — a `GET` returns
 * every field, so a country region comes back with an empty `bboxes` too.
 * Not dodging a backend rejection (`Region._country_xor_bbox` resolves both
 * present by value precedence, country first) — just not sending noise back.
 */
export function regionPatch(r: Region): object {
  if (r.country) return { id: r.id, name: r.name, country: r.country };
  return { id: r.id, name: r.name, bboxes: r.bboxes };
}

/** How many of `datasets` reference each region, by `id` — the "used by N
 * dataset(s)" line and the input to the delete guard (no cascade delete: a
 * referenced region's Delete is blocked, not confirm-offered). Every region
 * in `regions` gets an entry, `0` if unreferenced. */
export function regionUsageCounts(
  regions: readonly Region[],
  datasets: readonly { region_id: string | null }[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of regions) counts.set(r.id, 0);
  for (const d of datasets) {
    if (d.region_id !== null && counts.has(d.region_id)) {
      counts.set(d.region_id, (counts.get(d.region_id) ?? 0) + 1);
    }
  }
  return counts;
}

/** The one-line "what this region covers" a list row shows: country code,
 * rounded bbox for a single box (eyeballing, not surveying — precision
 * editing is the per-box rows in the edit form), else box count. */
export function regionSummary(r: Region): string {
  if (r.country) return r.country;
  if (r.bboxes.length === 1) {
    const [w, s, e, n] = [r.bboxes[0].min_lon, r.bboxes[0].min_lat, r.bboxes[0].max_lon, r.bboxes[0].max_lat].map(
      (v) => v.toFixed(2),
    );
    return `${w}, ${s} – ${e}, ${n}`;
  }
  return `${r.bboxes.length} boxes`;
}

/** One installed set's bounds, offered as a prefill source. `key` is unique
 * across both catalogs (prefixed), so the two id spaces cannot collide. */
export interface ChartBoundsOption {
  key: string;
  label: string;
  /** [west, south, east, north] in degrees — same order both catalogs use. */
  bounds: [number, number, number, number];
}

interface BoundsCatalogResponse {
  sets: { id: string; name: string; bounds: [number, number, number, number] }[];
}

/** `GET /api/config`'s shape, narrowed to the one field this module (and
 * `DatasetList.tsx`) actually reads. */
export interface ConfigRegionsResponse {
  config: { regions: Region[] };
}

/** One box's DRAFT — string fields so a partial/invalid number doesn't fight
 * back while typing; parsed and validated only at `save()`. */
export interface DraftBox {
  minLon: string;
  minLat: string;
  maxLon: string;
  maxLat: string;
}

const draftFromBox = (b: BBox): DraftBox => ({
  minLon: String(b.min_lon),
  minLat: String(b.min_lat),
  maxLon: String(b.max_lon),
  maxLat: String(b.max_lat),
});

export interface RegionFormDeps {
  /** The region being edited — `id`/`country` preserved verbatim; `undefined`
   * for a fresh "add" draft. */
  region?: Region;
  /** Every region id already in use, so a fresh draft's derived id can
   * dedupe against them. Unused when editing (id never changes). */
  existingIds: readonly string[];
  /** Seed a FRESH draft's boxes (ignored when `region` is set) — the
   * draw-to-create completion step: the sailor drew the shape first, so the
   * form opens prefilled and only asks for a Name. */
  initialBoxes?: readonly BBox[];
  /** A region was added or edited: the caller re-reads its own regions list. */
  onSaved: () => void;
  /** The JSON fetch seam (tests stub it). */
  fetchJson?: FetchJson;
}

export interface RegionFormController {
  /** Installed chart/imagery sets offering their bounds as a prefill source,
   * merged from both catalogs; either failing silently drops just that half. */
  installedCharts: Accessor<ChartBoundsOption[]>;
  /** Whether this is an edit of a country region (only the name is editable
   * then). Plain `boolean`: fixed for the controller's whole lifetime. */
  isCountryEdit: boolean;
  name: Accessor<string>;
  setName: (v: string) => void;
  /** The draft's boxes — a region is a LIST now, not exactly one. */
  boxes: Accessor<DraftBox[]>;
  /** A blank box, appended to the end — the sailor fills it in by hand. */
  addBlankBox: () => void;
  removeBox: (index: number) => void;
  setBoxField: (index: number, field: keyof DraftBox, value: string) => void;
  /** Append a box from real bounds (installed set or a map-drawn rectangle).
   * Sets the Name too, but ONLY while it's still empty. Fills the draft only. */
  appendBox: (bounds: readonly [number, number, number, number], nameHint?: string) => void;
  /** Copy an installed option's bounds into a new box row (`appendBox`). */
  prefillFrom: (key: string) => void;
  /** Re-read the installed-chart bounds list. */
  refresh: () => Promise<void>;
  /** Validate the draft, read-modify-write it onto `Config.regions` (adding,
   * or replacing IN PLACE for an edit), and clear the draft on success (add
   * only — an edit's fields stay as last saved). */
  save: () => Promise<void>;
  busy: Accessor<boolean>;
  error: Accessor<string>;
}

export function createRegionForm(deps: RegionFormDeps): RegionFormController {
  const getJson = deps.fetchJson ?? fetchJsonDefault;
  const editing = deps.region;
  // A country region's `bboxes` is a meaningless empty default (`country`
  // wins by precedence, see `regionPatch`), so there's nothing to edit there
  // — this form has no country picker, only the name is touched.
  const isCountryEdit = !!editing?.country;

  const [installedCharts, setInstalledCharts] = createSignal<ChartBoundsOption[]>([]);
  const [name, setName] = createSignal(editing?.name ?? "");
  const [boxes, setBoxes] = createSignal<DraftBox[]>(
    editing && !isCountryEdit
      ? editing.bboxes.map(draftFromBox)
      : (deps.initialBoxes?.map(draftFromBox) ?? []),
  );
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  const addBlankBox = () => setBoxes((bs) => [...bs, { minLon: "", minLat: "", maxLon: "", maxLat: "" }]);
  const removeBox = (index: number) => setBoxes((bs) => bs.filter((_, i) => i !== index));
  const setBoxField = (index: number, field: keyof DraftBox, value: string) =>
    setBoxes((bs) => bs.map((b, i) => (i === index ? { ...b, [field]: value } : b)));

  const appendBox = (bounds: readonly [number, number, number, number], nameHint?: string) => {
    const [w, s, e, n] = bounds;
    batch(() => {
      if (!name().trim() && nameHint) setName(nameHint);
      setBoxes((bs) => [...bs, { minLon: String(w), minLat: String(s), maxLon: String(e), maxLat: String(n) }]);
    });
  };

  const refresh = async () => {
    const options: ChartBoundsOption[] = [];
    try {
      const body = await getJson<BoundsCatalogResponse>("/api/catalog");
      for (const s of body.sets) {
        options.push({ key: `chart:${s.id}`, label: s.name, bounds: s.bounds });
      }
    } catch {
      /* installed charts unreachable — the picker just offers fewer options */
    }
    try {
      const body = await getJson<BoundsCatalogResponse>("/api/satellite/catalog");
      for (const s of body.sets) {
        options.push({ key: `satellite:${s.id}`, label: s.name, bounds: s.bounds });
      }
    } catch {
      /* baked imagery unreachable — same fallback */
    }
    setInstalledCharts(options);
  };

  const prefillFrom = (key: string) => {
    const opt = installedCharts().find((o) => o.key === key);
    if (!opt) return;
    appendBox(opt.bounds, opt.label);
  };

  const save = async () => {
    setError("");
    const trimmed = name().trim();
    if (!trimmed) {
      setError("Name the region before saving.");
      return;
    }

    let parsedBoxes: BBox[] | null = null;
    if (!isCountryEdit) {
      if (boxes().length === 0) {
        setError("Add at least one bounding box before saving.");
        return;
      }
      const result: BBox[] = [];
      for (const b of boxes()) {
        const w = Number(b.minLon);
        const s = Number(b.minLat);
        const e = Number(b.maxLon);
        const n = Number(b.maxLat);
        if (![w, s, e, n].every(Number.isFinite)) {
          setError("Every bound must be a number.");
          return;
        }
        if (!(w < e) || !(s < n)) {
          setError("Need west < east and south < north.");
          return;
        }
        result.push({ min_lon: w, min_lat: s, max_lon: e, max_lat: n });
      }
      parsedBoxes = result;
    }

    setBusy(true);
    try {
      // Read-modify-write, same shape as serverConfig.ts's subscribeExtraPath
      // (`regions` is a whole-list field a PATCH replaces wholesale). Read
      // fresh rather than trusting a possibly-stale prop, so a concurrent
      // edit from elsewhere is never silently discarded.
      const current = await getJson<ConfigRegionsResponse>("/api/config");

      let draft: Region;
      if (isCountryEdit) {
        draft = { ...editing, name: trimmed };
      } else {
        // Dedupe against both the caller's `existingIds` and the fresh read
        // above, covering the gap between mount and this component's own
        // fetch resolving. An edit keeps its id verbatim, never re-slugged.
        const id =
          editing?.id ??
          dedupeId(slugify(trimmed, "region"), [
            ...deps.existingIds,
            ...current.config.regions.map((r) => r.id),
          ]);
        draft = { id, name: trimmed, country: null, bboxes: parsedBoxes! };
      }

      const next = editing
        ? current.config.regions.map((r) => (r.id === draft.id ? draft : r))
        : [...current.config.regions, draft];
      const regions = next.map(regionPatch);
      await getJson("/api/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ regions }),
      });
      if (!editing) {
        batch(() => {
          setName("");
          setBoxes([]);
        });
      }
      deps.onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  void refresh();

  return {
    installedCharts,
    isCountryEdit,
    name,
    setName,
    boxes,
    addBlankBox,
    removeBox,
    setBoxField,
    appendBox,
    prefillFrom,
    refresh,
    save,
    busy,
    error,
  };
}

const INPUT_CLASS =
  "w-full rounded border border-line px-2 py-1 focus:border-accent focus:outline-none";

const BoxField: Component<{
  label: string;
  value: string;
  onInput: (v: string) => void;
  disabled?: boolean;
}> = (props) => (
  <label class="block space-y-1">
    <span class="text-xs text-fg-2">{props.label}</span>
    <input
      type="number"
      step="any"
      class={INPUT_CLASS}
      disabled={props.disabled}
      value={props.value}
      onInput={(e) => props.onInput(e.currentTarget.value)}
    />
  </label>
);

/** One draft box's editable row — four number fields plus Remove. */
const BoxRow: Component<{
  box: DraftBox;
  index: number;
  disabled?: boolean;
  onField: (field: keyof DraftBox, value: string) => void;
  onRemove: () => void;
}> = (props) => (
  <div class="space-y-1 rounded border border-line-2 p-2">
    <div class="grid grid-cols-2 gap-2">
      <BoxField
        label="West (min lon)"
        value={props.box.minLon}
        onInput={(v) => props.onField("minLon", v)}
        disabled={props.disabled}
      />
      <BoxField
        label="South (min lat)"
        value={props.box.minLat}
        onInput={(v) => props.onField("minLat", v)}
        disabled={props.disabled}
      />
      <BoxField
        label="East (max lon)"
        value={props.box.maxLon}
        onInput={(v) => props.onField("maxLon", v)}
        disabled={props.disabled}
      />
      <BoxField
        label="North (max lat)"
        value={props.box.maxLat}
        onInput={(v) => props.onField("maxLat", v)}
        disabled={props.disabled}
      />
    </div>
    <Button disabled={props.disabled} onClick={props.onRemove}>
      Remove box {props.index + 1}
    </Button>
  </div>
);

/**
 * The "add" / "edit" region form mounted for both "+ Add region" and each
 * row's Edit. Self-contained (builds its own `createRegionForm`).
 *
 * **No LIVE "Draw on map" button inside this form itself.** Settings is a
 * true modal that unmounts this form when it closes (which it must, for the
 * chart to be tappable) — a draw session started from a button HERE would
 * return to a form instance that no longer exists, taking any unsaved edits
 * down with it. `RegionListSection` routes around that instead: an
 * already-saved row's "Draw a box on the map" PATCHes directly; "Draw a
 * region on the map" stages the boxes in `SettingsCtx.stageDrawnRegion`
 * (survives the unmount, lives above Settings) and hands them to a FRESH
 * mount via `initialBoxes` once Settings reopens.
 */
export const RegionForm: Component<{
  region?: Region;
  existingIds: readonly string[];
  /** Prefill a fresh draft's boxes — ignored when `region` is set (the
   * draw-to-create completion step, see the docstring above). */
  initialBoxes?: readonly BBox[];
  disabled?: boolean;
  onSaved: () => void;
  onCancel?: () => void;
  fetchJson?: FetchJson;
}> = (props) => {
  const ctrl = createRegionForm({
    region: props.region,
    existingIds: props.existingIds,
    initialBoxes: props.initialBoxes,
    onSaved: props.onSaved,
    fetchJson: props.fetchJson,
  });
  const [selectedChart, setSelectedChart] = createSignal("");

  return (
    <section class="space-y-2 border-t border-line pt-2">
      <h3 class="text-xs font-medium text-fg-2">{props.region ? "Edit region" : "Add a region"}</h3>
      <Show when={ctrl.isCountryEdit}>
        <p class="text-xs text-fg-3">
          Defined by country ({props.region?.country}) — box editing isn't available for country
          regions yet; only the name can change here.
        </p>
      </Show>
      <label class="block space-y-1">
        <span class="text-xs text-fg-2">Name</span>
        <input
          class={INPUT_CLASS}
          disabled={props.disabled}
          value={ctrl.name()}
          onInput={(e) => ctrl.setName(e.currentTarget.value)}
        />
      </label>
      <Show when={!ctrl.isCountryEdit}>
        <div class="space-y-2">
          <For each={ctrl.boxes()}>
            {(box, i) => (
              <BoxRow
                box={box}
                index={i()}
                disabled={props.disabled}
                onField={(field, v) => ctrl.setBoxField(i(), field, v)}
                onRemove={() => ctrl.removeBox(i())}
              />
            )}
          </For>
          <div class="flex flex-wrap gap-1">
            <Button disabled={props.disabled} onClick={ctrl.addBlankBox}>
              + Add a box
            </Button>
          </div>
          <Show when={ctrl.installedCharts().length > 0}>
            <label class="block space-y-1">
              <span class="text-xs text-fg-2">Add a box from an installed chart</span>
              <select
                class={INPUT_CLASS}
                disabled={props.disabled}
                value={selectedChart()}
                onChange={(e) => {
                  const key = e.currentTarget.value;
                  setSelectedChart(key);
                  if (key) {
                    ctrl.prefillFrom(key);
                    setSelectedChart("");
                  }
                }}
              >
                <option value="">Pick a chart…</option>
                <For each={ctrl.installedCharts()}>{(o) => <option value={o.key}>{o.label}</option>}</For>
              </select>
            </label>
          </Show>
        </div>
      </Show>
      <div class="flex gap-1">
        <Button
          variant="primary"
          disabled={props.disabled || ctrl.busy()}
          onClick={() => void ctrl.save()}
        >
          {ctrl.busy() ? "Saving…" : props.region ? "Save" : "Add region"}
        </Button>
        <Show when={props.onCancel}>
          <Button disabled={props.disabled || ctrl.busy()} onClick={props.onCancel}>
            Cancel
          </Button>
        </Show>
      </div>
      <Show when={ctrl.error()}>
        <p class="text-xs text-alarm">{ctrl.error()}</p>
      </Show>
    </section>
  );
};

interface DatasetRegionRef {
  region_id: string | null;
}

interface DatasetsResponse {
  datasets: DatasetRegionRef[];
}

/**
 * Every boat-wide region, with add/edit/delete. Fetches its own
 * `Config.regions` and `/api/datasets` independently of
 * `DatasetListSection`'s fetch of the same resources — a known rough edge:
 * adding/renaming a region here does not live-refresh `DatasetEditForm`'s
 * Region `<select>` elsewhere; a re-open picks up the change. Not wired
 * together on purpose — a re-open is an acceptable cost for a rare action.
 */
const RegionListSection: Component<{
  /** Draw one or more bounding boxes on the map, `existing` shown for
   * context. Absent under `bun test` (no map/modes), in which case
   * `rowActions`/`startCreateDraw` don't offer the action. */
  startDraw?: (existing: readonly BBox[], onDone: (boxes: BBox[]) => void) => void;
  /** Stage a draw-to-create session's result so it survives Settings
   * unmounting this component (`startCreateDraw`, below). */
  stageDrawnRegion?: (boxes: BBox[]) => void;
  /** Read + clear whatever `stageDrawnRegion` staged — called once, on
   * mount, so a freshly-remounted instance picks up a just-finished draw. */
  takeDrawnRegion?: () => BBox[] | null;
}> = (props) => {
  const [regions, setRegions] = createSignal<Region[]>([]);
  const [datasets, setDatasets] = createSignal<DatasetRegionRef[]>([]);
  const [listError, setListError] = createSignal("");
  const [loading, setLoading] = createSignal(true);
  const [busyId, setBusyId] = createSignal("");
  const [confirmDelete, setConfirmDelete] = createSignal("");
  // The region id being edited, `""` for a fresh draft, or `null` for none.
  const [editing, setEditing] = createSignal<string | null>(null);
  const [actionError, setActionError] = createSignal("");
  // A fresh draft's boxes, prefilled from a just-finished draw-to-create
  // session — undefined for the ordinary "+ Add region" path.
  const [draftInitialBoxes, setDraftInitialBoxes] = createSignal<BBox[] | undefined>(undefined);

  // Consumed ONCE per mount: if Settings just reopened after a draw-to-
  // create session, land straight in the prefilled "Add region" draft.
  const drawnOnMount = props.takeDrawnRegion?.();
  if (drawnOnMount && drawnOnMount.length > 0) {
    setDraftInitialBoxes(drawnOnMount);
    setEditing("");
  }

  const refresh = async () => {
    setListError("");
    try {
      const body = await fetchJsonDefault<ConfigRegionsResponse>("/api/config");
      setRegions(body.config.regions);
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };
  const refreshDatasets = async () => {
    try {
      const body = await fetchJsonDefault<DatasetsResponse>("/api/datasets");
      setDatasets(body.datasets);
    } catch {
      /* usage counts default to 0 if the dataset list is unreachable — the
         Datasets section above already surfaces that failure on its own */
    }
  };
  void refresh();
  void refreshDatasets();

  // Memoized: read multiple times per row (count + singular/plural), so a
  // full recompute per read would be waste.
  const usage = createMemo(() => regionUsageCounts(regions(), datasets()));

  const remove = async (id: string) => {
    setBusyId(id);
    setActionError("");
    try {
      const current = await fetchJsonDefault<ConfigRegionsResponse>("/api/config");
      const remaining = current.config.regions.filter((r) => r.id !== id).map(regionPatch);
      // PATCH's response is the same shape GET returns — use it directly
      // rather than a follow-up GET.
      const patched = await fetchJsonDefault<ConfigRegionsResponse>("/api/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ regions: remaining }),
      });
      setRegions(patched.config.regions);
      setConfirmDelete("");
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId("");
    }
  };

  /** Append every box a draw session produced to an ALREADY-SAVED region:
   * read-modify-write, PATCHing straight onto the stored region by `id`.
   * Deliberately bypasses `RegionForm`'s draft (see that form's docstring:
   * Settings closing to draw would unmount it) — this is why "Draw on map"
   * lives here, on the row. Not offered for a country region (`bboxes` is
   * meaningless there). */
  const addBoxesToRegion = async (id: string, boxes: readonly BBox[]) => {
    setBusyId(id);
    setActionError("");
    try {
      const current = await fetchJsonDefault<ConfigRegionsResponse>("/api/config");
      const next = current.config.regions.map((r) =>
        r.id === id ? { ...r, bboxes: [...r.bboxes, ...boxes] } : r,
      );
      const patched = await fetchJsonDefault<ConfigRegionsResponse>("/api/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ regions: next.map(regionPatch) }),
      });
      setRegions(patched.config.regions);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId("");
    }
  };

  /** Every box every CURRENT region already has, overlaid on the map while
   * drawing. Deliberately not excluding the row's own region — seeing your
   * own already-saved boxes avoids an accidental duplicate/overlap. */
  const allExistingBoxes = () => regions().flatMap((r) => r.bboxes);

  /** Start a draw-to-CREATE session. Unlike the row action, does not PATCH
   * anything itself — stages the result (`stageDrawnRegion`) for the fresh
   * mount once Settings reopens (`takeDrawnRegion`) to land in a prefilled
   * "Add region" draft, so the sailor still types a Name and gets validation. */
  const startCreateDraw = () => {
    props.startDraw?.(allExistingBoxes(), (boxes) => props.stageDrawnRegion?.(boxes));
  };

  const rowActions = (r: Region) => {
    const count = () => usage().get(r.id) ?? 0;
    return (
      <Show
        when={confirmDelete() === r.id}
        fallback={
          <span class="flex flex-wrap items-center gap-1">
            <Button disabled={busyId() === r.id} onClick={() => setEditing(r.id)}>
              Edit
            </Button>
            <Show when={!!props.startDraw && !r.country}>
              <Button
                disabled={busyId() === r.id}
                onClick={() =>
                  props.startDraw?.(allExistingBoxes(), (boxes) => void addBoxesToRegion(r.id, boxes))
                }
              >
                Draw a box on the map
              </Button>
            </Show>
            <Show
              when={count() === 0}
              fallback={
                <span class="text-xs text-fg-2">
                  Used by {count()} dataset{count() === 1 ? "" : "s"} — repoint or delete those
                  first
                </span>
              }
            >
              <Button
                variant="tinted"
                tone="alarm"
                class="font-medium"
                disabled={busyId() === r.id}
                onClick={() => setConfirmDelete(r.id)}
              >
                Delete
              </Button>
            </Show>
          </span>
        }
      >
        <span class="flex shrink-0 items-center gap-1">
          <span class="text-xs text-fg-2">Delete {r.name}?</span>
          <Button variant="danger" disabled={busyId() === r.id} onClick={() => void remove(r.id)}>
            Really delete
          </Button>
          <Button disabled={busyId() === r.id} onClick={() => setConfirmDelete("")}>
            Keep
          </Button>
        </span>
      </Show>
    );
  };

  return (
    <AccordionSection value="regions" title="Regions" icon={MapPin}>
      <Show
        when={!listError()}
        fallback={
          <div class="space-y-1 pb-2">
            <p class="text-xs text-notice">
              The boat's server did not answer for the region list. Regions cannot be shown right
              now.
            </p>
            <p class="break-all text-xs text-fg-2">{listError()}</p>
            <Button disabled={loading()} onClick={() => void refresh()}>
              Retry
            </Button>
          </div>
        }
      >
        <section class="space-y-2">
          <p class="text-xs text-fg-2">
            Boat-wide areas of interest — shared by every dataset that bakes a region (POI,
            satellite imagery). A region can be one or more bounding boxes.
          </p>

          <Show
            when={regions().length > 0}
            fallback={<p class="text-fg-2">{loading() ? "Loading…" : "No regions declared yet."}</p>}
          >
            <ul class="space-y-1">
              <For each={regions()}>
                {(r) => (
                  <li class="space-y-1 rounded border border-line-2 p-2">
                    <Show
                      when={editing() !== r.id}
                      fallback={
                        <RegionForm
                          region={r}
                          existingIds={regions().map((x) => x.id)}
                          disabled={busyId() === r.id}
                          onCancel={() => setEditing(null)}
                          onSaved={() => {
                            setEditing(null);
                            void refresh();
                          }}
                        />
                      }
                    >
                      <div class="flex items-center justify-between gap-2">
                        <div class="min-w-0">
                          <div class="truncate font-medium">{r.name}</div>
                          <div class="truncate text-xs text-fg-2">{regionSummary(r)}</div>
                        </div>
                        <span class="shrink-0 text-xs text-fg-2">
                          used by {usage().get(r.id) ?? 0} dataset{(usage().get(r.id) ?? 0) === 1 ? "" : "s"}
                        </span>
                      </div>
                      {rowActions(r)}
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>

          <Show
            when={editing() === ""}
            fallback={
              <span class="flex flex-wrap gap-1">
                <Button variant="primary" class="font-medium" onClick={() => setEditing("")}>
                  + Add region
                </Button>
                <Show when={!!props.startDraw}>
                  <Button onClick={startCreateDraw}>Draw a region on the map</Button>
                </Show>
              </span>
            }
          >
            <RegionForm
              existingIds={regions().map((r) => r.id)}
              initialBoxes={draftInitialBoxes()}
              onCancel={() => {
                setEditing(null);
                setDraftInitialBoxes(undefined);
              }}
              onSaved={() => {
                setEditing(null);
                setDraftInitialBoxes(undefined);
                void refresh();
              }}
            />
          </Show>

          <Show when={actionError()}>
            <p class="text-xs text-alarm">{actionError()}</p>
          </Show>
        </section>
      </Show>
    </AccordionSection>
  );
};

export default RegionListSection;
