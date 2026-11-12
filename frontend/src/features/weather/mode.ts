// The WEATHER mode: owns the SOURCE REGISTRY (one shared `GET
// /weather/sources` fetch, read by MapView and the info provider too).
// DOM-free/map-free like every `chrome/` mode (see chrome/modes.ts).

import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import type { GeoPoint } from "../../core/chrome/geo";
import type { Mode } from "../../core/chrome/registry";
import type { WeatherSettings } from "../../core/weatherSettings";
import type { Palette } from "../../core/style/colors";
import {
  fetchGridPoint,
  fetchPointForecast,
  weatherFromForecast,
  type FullHourly,
  type PointWeather,
  type SampledPoint,
  type WindUnit,
} from "./point";
import {
  EMPTY_SOURCES,
  fetchWeatherSources,
  sourceById,
  sourceServes,
  validTimeFor,
  weatherEnabled,
  type WeatherSourceInfo,
} from "./sources";

/** Debounce before the readout fetches: the pointer/centre settles between a
 * mouse sweep and a pan, and the point API is a network round-trip. */
const READOUT_DEBOUNCE_MS = 300;

/** How often `GET /weather/sources` is re-asked while the weather sheet is
 * open. Coarse on purpose: coverage moves on the timescale of a bake step or an
 * upstream run, and the ruler's marks are the only thing that reads it. */
const SOURCES_POLL_MS = 60_000;

/** The mode id — also the string MapView keys its hover-feed and crosshair on. */
export const WEATHER_MODE_ID = "weather";

/** The cursor readout's state: a value, a spinner, or an error (offline). */
export interface WeatherReadout {
  loading: boolean;
  point: PointWeather | null;
  error: boolean;
  /** Field value sampled straight from the decoded wash grid, for fields the
   * point-forecast API cannot answer (waves). Null otherwise or until decoded. */
  sampled: SampledPoint | null;
}

export interface WeatherModeModel {
  /** The live weather settings the sheet edits and the overlay renders from. */
  weather: Accessor<WeatherSettings>;
  /** The app-wide wind-speed unit (ChartSettings.windUnit) — the sheet/bar
   * readouts format speeds with it, and the clickable unit label flips it. */
  windUnit: Accessor<WindUnit>;
  /** The live chart palette — the floating legend keys the same scale the
   * wash paints, so it never shows bright colours over a dimmed night chart. */
  palette: Accessor<Palette>;
  /** Flip the app-wide wind unit (m/s ⇄ kn) — the SAME setter every other
   * readout (map badge, info panel) uses, so they all agree. */
  toggleWindUnit: () => void;
  setField: (field: WeatherSettings["field"]) => void;
  setModel: (model: string) => void;
  setArrows: (arrows: boolean) => void;
  setHours: (hours: number) => void;
  setKeepVisible: (keepVisible: boolean) => void;
  setOpacity: (opacity: number) => void;
  /** The live pointer, pushed by MapView (mouse on desktop, centre crosshair on
   * touch), or null when it leaves the chart / the mode is left. */
  hover: (at: GeoPoint | null) => void;
  /** Where the readout is anchored, for MapView to place the badge. */
  at: Accessor<GeoPoint | null>;
  /** The debounced forecast readout at `at()` for the selected forecast time. */
  readout: Accessor<WeatherReadout>;
  /** Whether the weather tiles are loading (set by MapView). The first tile of
   * a new forecast is a slow all-variable `.om` read, so the sheet must say
   * "working" rather than look frozen. */
  tilesLoading: Accessor<boolean>;
  setTilesLoading: (v: boolean) => void;
  /** Every source this boat offers (`./sources.ts`, `GET /weather/sources`):
   * id/label/badge/variables/coverage in ONE payload. Empty means "offer
   * nothing" (point at Settings › Datasets) — never a hardcoded catalog. */
  sources: Accessor<readonly WeatherSourceInfo[]>;
  /** The SELECTED source's row, or `null` when unselected or no longer offered.
   * `null` is a state the UI reports, never papered over by picking another. */
  selected: Accessor<WeatherSourceInfo | null>;
  /** Wire the sheet's exit (its X / Done) to the mode state machine. */
  bindExit: (fn: () => void) => void;
  exit: () => void;
}

export function createWeatherMode(deps: {
  weather: Accessor<WeatherSettings>;
  setWeather: (patch: Partial<WeatherSettings>) => void;
  /** The app-wide wind unit and its toggle (App owns the ChartSettings slice). */
  windUnit: Accessor<WindUnit>;
  toggleWindUnit: () => void;
  /** The live chart palette (App owns the ChartSettings slice). */
  palette: Accessor<Palette>;
}): { mode: Mode; model: WeatherModeModel } {
  const [at, setAt] = createSignal<GeoPoint | null>(null);
  const [tilesLoading, setTilesLoading] = createSignal(false);
  // The whole-week forecast SERIES for the current location, fetched ONCE and
  // re-indexed locally as the scrub moves; `null` until the first fetch lands.
  const [series, setSeries] = createSignal<FullHourly | null>(null);
  const [fetchState, setFetchState] = createSignal<{ loading: boolean; error: boolean }>({
    loading: false,
    error: false,
  });
  // Grid-sampled field value (waves) — see WeatherReadout.sampled above.
  const [sampled, setSampled] = createSignal<SampledPoint | null>(null);

  // Read through a memo so a field/source/arrows toggle does not re-index.
  const hours = createMemo(() => deps.weather().hours);

  // `selected()` is `null` for BOTH "nothing chosen yet" and "chosen, but this
  // boat does not offer it" — distinguished by `weather().model` being empty
  // or not; only the first is something the mode acts on (see `refreshSources`).
  const [sources, setSources] = createSignal<readonly WeatherSourceInfo[]>(EMPTY_SOURCES);
  const selected = createMemo(() => sourceById(sources(), deps.weather().model));

  // ONE request per LOCATION, debounced. The whole week is fetched at once so
  // scrubbing time re-indexes locally instead of refetching (the flicker /
  // spurious "Offline" this replaces). Cleanup cancels the timer AND aborts.
  createEffect(() => {
    const p = at();
    setSeries(null);
    setSampled(null);
    if (!p) {
      setFetchState({ loading: false, error: false });
      return;
    }
    setFetchState({ loading: true, error: false });
    const ac = new AbortController();
    const timer = setTimeout(() => {
      fetchPointForecast(p.lat, p.lng, ac.signal)
        .then((body) => {
          setSeries(body);
          setFetchState({ loading: false, error: false });
        })
        .catch((err) => {
          if ((err as { name?: string })?.name !== "AbortError") {
            setFetchState({ loading: false, error: true });
          }
        });
    }, READOUT_DEBOUNCE_MS);
    onCleanup(() => {
      clearTimeout(timer);
      ac.abort();
    });
  });

  // Grid sample for fields the point API can't answer (waves): reads the SAME
  // server-rendered field the wash paints via `/weather/sources/{id}/point` —
  // never another source's data under this label.
  createEffect(() => {
    const p = at();
    const w = deps.weather();
    const src = selected();
    if (!p || w.field !== "waves" || !sourceServes(src, "waves")) {
      setSampled(null);
      return;
    }
    const time = validTimeFor(src, w.hours, Date.now());
    if (!time) {
      setSampled(null);
      return;
    }
    const ac = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const s = await fetchGridPoint(src!.id, "waves", time, p.lat, p.lng, ac.signal);
          if (!ac.signal.aborted) setSampled(s);
        } catch {
          if (!ac.signal.aborted) setSampled(null);
        }
      })();
    }, READOUT_DEBOUNCE_MS);
    onCleanup(() => {
      clearTimeout(timer);
      ac.abort();
    });
  });

  // DERIVED, not fetched: re-indexes the cached series at the selected
  // forecast time and folds in the grid sample — the fix for scrub flicker.
  const readout = createMemo<WeatherReadout>(() => {
    const body = series();
    const st = fetchState();
    const smp = sampled();
    if (!body) return { loading: st.loading, point: null, error: st.error, sampled: smp };
    const targetUnix = Math.floor(Date.now() / 1000) + hours() * 3600;
    return { loading: false, point: weatherFromForecast(body, targetUnix), error: false, sampled: smp };
  });

  let exitFn: () => void = () => {};

  // Re-ask what this boat offers; degrades to EMPTY on failure, never stale or
  // fabricated. See docs/architecture/weather-source-selection.md for why only
  // the first-ever selection is written here.
  const refreshSources = () => {
    void fetchWeatherSources()
      .catch(() => EMPTY_SOURCES)
      .then((list) => {
        setSources(list);
        if (deps.weather().model === "" && list.length > 0) {
          deps.setWeather({ model: list[0].id });
        }
      });
  };

  // Also fetched the first time weather turns on (`keepVisible`), not only on
  // mode entry — deliberately lazy, so a sailor who never enables weather
  // never pays for the request.
  let fetchedOnce = false;
  createEffect(() => {
    const w = deps.weather();
    if (fetchedOnce || !(weatherEnabled(w) || w.keepVisible)) return;
    fetchedOnce = true;
    refreshSources();
  });

  // Re-asked on a slow beat while the sheet is OPEN: a bake can land/prune, and
  // the backend's own coverage estimate can update after a tile decode. Same
  // discovery payload, re-read (`no-store`) — not a second endpoint.
  let poll: ReturnType<typeof setInterval> | undefined;
  const stopPolling = () => {
    if (poll !== undefined) clearInterval(poll);
    poll = undefined;
  };
  onCleanup(stopPolling);

  const mode: Mode = {
    id: WEATHER_MODE_ID,
    label: "Weather",
    // Solo like the route editor: sheet + cursor readout are the whole
    // surface, so no ModePill and the helm tiles step aside.
    solo: true,
    enter: () => {
      setAt(null);
      fetchedOnce = true;
      refreshSources();
      stopPolling();
      poll = setInterval(refreshSources, SOURCES_POLL_MS);
    },
    leave: () => {
      setAt(null);
      stopPolling();
    },
    // Consumes the click so the info probe does not also fire.
    onClick: (click) => {
      setAt({ lng: click.lngLat.lng, lat: click.lngLat.lat });
      return true;
    },
  };

  const model: WeatherModeModel = {
    weather: deps.weather,
    windUnit: deps.windUnit,
    toggleWindUnit: deps.toggleWindUnit,
    palette: deps.palette,
    setField: (field) => deps.setWeather({ field }),
    setModel: (model) => deps.setWeather({ model }),
    setArrows: (arrows) => deps.setWeather({ arrows }),
    setHours: (hours) => deps.setWeather({ hours }),
    setKeepVisible: (keepVisible) => deps.setWeather({ keepVisible }),
    setOpacity: (opacity) => deps.setWeather({ opacity }),
    hover: (a) => setAt(a),
    at,
    readout,
    tilesLoading,
    setTilesLoading,
    sources,
    selected,
    bindExit: (fn) => {
      exitFn = fn;
    },
    exit: () => exitFn(),
  };

  return { mode, model };
}
