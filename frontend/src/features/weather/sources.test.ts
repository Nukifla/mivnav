import { describe, expect, it } from "bun:test";
import {
  DEFAULT_WEATHER,
  DEFAULT_WEATHER_MODEL,
  isWeatherField,
  isWeatherModel,
  type WeatherSettings,
} from "../../core/weatherSettings";
import {
  coverageWindow,
  fieldTileUrl,
  fieldVariable,
  isDarkPalette,
  pointUrl,
  resolveWeatherRaster,
  sourceById,
  sourceServes,
  sourcesFromWire,
  stepSource,
  validTimeFor,
  washTilesUrl,
  weatherEnabled,
  WEATHER_ATTRIBUTION,
  WEATHER_HOST,
  type WeatherSourceInfo,
} from "./sources";

const on: WeatherSettings = { ...DEFAULT_WEATHER };

const HOUR = 3_600_000;
/** A whole hour, so `validTimeFor`'s floor is a no-op and the arithmetic in the
 * expectations below is exact. */
const NOW = Date.parse("2026-07-29T12:00:00Z");

function source(over: Partial<WeatherSourceInfo> = {}): WeatherSourceInfo {
  return {
    id: "om:dwd_icon",
    label: "DWD ICON",
    badge: "Online · Open-Meteo",
    requiresNetwork: true,
    variables: ["wind", "gusts", "pressure", "temperature"],
    coverage: { local: [], remote: [], referenceMs: null },
    region: null,
    ...over,
  };
}

describe("sourcesFromWire — the discovery payload", () => {
  it("reads one row, snake_case and ISO times included", () => {
    const [s] = sourcesFromWire({
      sources: [
        {
          id: "grib:my-set:dwd_icon_eu",
          label: "DWD ICON-EU",
          badge: "Offline · GRIB",
          requires_network: false,
          variables: ["wind"],
          coverage: {
            local: ["2026-07-29T12:00:00Z", "2026-07-29T15:00:00Z"],
            remote: [],
            reference_time: "2026-07-29T12:00:00Z",
          },
          region: null,
        },
      ],
    });
    expect(s.id).toBe("grib:my-set:dwd_icon_eu");
    expect(s.label).toBe("DWD ICON-EU");
    expect(s.badge).toBe("Offline · GRIB");
    expect(s.requiresNetwork).toBe(false);
    expect(s.variables).toEqual(["wind"]);
    expect(s.coverage.local).toEqual([NOW, NOW + 3 * HOUR]);
    expect(s.coverage.referenceMs).toBe(NOW);
  });

  it("drops rows with no id, and unparseable times, rather than failing the list", () => {
    const list = sourcesFromWire({
      sources: [
        { label: "no id" },
        { id: "", label: "empty id" },
        { id: "om:x", coverage: { local: ["not a time", "2026-07-29T12:00:00Z"] } },
      ],
    });
    expect(list.map((s) => s.id)).toEqual(["om:x"]);
    expect(list[0].coverage.local).toEqual([NOW]);
    // A row with no label falls back to its own id rather than rendering blank.
    expect(list[0].label).toBe("om:x");
  });

  it("is an empty list for a body of the wrong shape (never throws into the picker)", () => {
    expect(sourcesFromWire(null)).toEqual([]);
    expect(sourcesFromWire({})).toEqual([]);
    expect(sourcesFromWire({ sources: "nope" })).toEqual([]);
  });
});

describe("sourceById / stepSource — selection over an OPAQUE id", () => {
  const list = [source({ id: "a" }), source({ id: "b" }), source({ id: "c" })];

  it("returns null for an id this boat does not offer — the UI reports it, nothing is substituted", () => {
    expect(sourceById(list, "b")?.id).toBe("b");
    expect(sourceById(list, "gone")).toBeNull();
    expect(sourceById([], "a")).toBeNull();
  });

  it("cycles by INDEX and wraps, never by parsing the id", () => {
    expect(stepSource(list, "a", 1)).toBe("b");
    expect(stepSource(list, "c", 1)).toBe("a");
    expect(stepSource(list, "a", -1)).toBe("c");
  });

  it("starts from the first entry for an unknown current, and is a no-op on an empty list", () => {
    expect(stepSource(list, "gone", 1)).toBe("b"); // index 0 + 1
    expect(stepSource([], "a", 1)).toBe("a");
  });
});

describe("sourceServes — capabilities are STATED, never inferred", () => {
  it("reads the source's own variable list", () => {
    expect(sourceServes(source({ variables: ["wind"] }), "wind")).toBe(true);
    expect(sourceServes(source({ variables: ["wind"] }), "waves")).toBe(false);
  });

  it("is false with no source — nothing is 'assumed to carry wind' any more", () => {
    // The deleted `modelHasWind` assumed exactly that for an id it did not
    // recognise, which is what let a wave-named GRIB dataset silently repoint
    // the particles at another model.
    expect(sourceServes(null, "wind")).toBe(false);
  });
});

describe("coverageWindow — declared times in the ruler's hours", () => {
  it("spans first→last as offsets from now", () => {
    expect(coverageWindow([NOW + HOUR, NOW + 12 * HOUR], NOW)).toEqual({
      fromHours: 1,
      toHours: 12,
    });
  });

  it("clamps a span that starts in the past at 0 — the scrubber cannot reach behind now", () => {
    expect(coverageWindow([NOW - 5 * HOUR, NOW + 6 * HOUR], NOW)).toEqual({
      fromHours: 0,
      toHours: 6,
    });
  });

  it("is null when there is nothing ahead, and for an empty list", () => {
    expect(coverageWindow([NOW - 5 * HOUR, NOW - HOUR], NOW)).toBeNull();
    expect(coverageWindow([], NOW)).toBeNull();
  });
});

describe("validTimeFor — one instant, snapped only within a step", () => {
  it("is the floored hour plus the offset when the source declares no coverage", () => {
    // A live Open-Meteo domain reports `remote=()` today (the cached capture
    // manifest is not wired in yet), and an empty coverage must NOT be read as
    // "covers nothing" — the request goes out and the backend answers or 404s
    // with the reason.
    expect(validTimeFor(source(), 6, NOW + 42 * 60_000)).toBe(
      new Date(NOW + 6 * HOUR).toISOString(),
    );
  });

  it("snaps to the nearest DECLARED time when there is coverage", () => {
    // Both backings match exactly, never nearest (`openmeteo._live_path`,
    // `GribStore.resolve_uv`), so an unsnapped instant simply 404s.
    const s = source({ coverage: { local: [NOW + 3 * HOUR], remote: [], referenceMs: null } });
    expect(validTimeFor(s, 2, NOW)).toBe(new Date(NOW + 3 * HOUR).toISOString());
  });

  it("refuses to snap further than one step — a bake that stops must not paint its last hour under a later label", () => {
    // THE reason the snap is bounded: scrub to +120 h on a bake that ends at
    // +6 h and an unbounded nearest-match would draw the +6 h field, with the
    // ruler saying +120 h.
    const s = source({ coverage: { local: [NOW + 6 * HOUR], remote: [], referenceMs: null } });
    expect(validTimeFor(s, 120, NOW)).toBeNull();
  });

  it("considers remote times as well as local ones", () => {
    const s = source({ coverage: { local: [], remote: [NOW + 24 * HOUR], referenceMs: null } });
    expect(validTimeFor(s, 24, NOW)).toBe(new Date(NOW + 24 * HOUR).toISOString());
  });

  it("is null with no source at all", () => {
    expect(validTimeFor(null, 0, NOW)).toBeNull();
  });
});

describe("core settings vocabulary after the opaque-id change", () => {
  it("defaults to NOTHING selected — no source-shaped id is constructed in core", () => {
    expect(DEFAULT_WEATHER_MODEL).toBe("");
    expect(DEFAULT_WEATHER.model).toBe("");
  });

  it("isWeatherModel is a shape guard that accepts the unselected state", () => {
    expect(isWeatherModel("")).toBe(true);
    expect(isWeatherModel("om:dwd_icon")).toBe(true);
    expect(isWeatherModel("grib:my-set:dwd_icon_eu")).toBe(true);
    // A hand-edited profile.json — never throws, just falls back.
    expect(isWeatherModel(undefined)).toBe(false);
    expect(isWeatherModel(42)).toBe(false);
    expect(isWeatherModel({ id: "x" })).toBe(false);
  });

  it("field ids ARE canonical variables, and visibility is no longer one", () => {
    expect(isWeatherField("wind")).toBe(true);
    expect(isWeatherField("waves")).toBe(true);
    expect(isWeatherField("off")).toBe(true);
    // No source declares `visibility` (`sources/base.py`'s VARIABLES), so it
    // could never have been drawn.
    expect(isWeatherField("visibility")).toBe(false);
  });
});

describe("isDarkPalette", () => {
  it("is dark for dusk and night, light for day", () => {
    expect(isDarkPalette("day")).toBe(false);
    expect(isDarkPalette("dusk")).toBe(true);
    expect(isDarkPalette("night")).toBe(true);
  });
});

describe("weatherEnabled", () => {
  it("is on iff a field or arrows is selected", () => {
    expect(weatherEnabled({ ...on, field: "off", arrows: false })).toBe(false);
    expect(weatherEnabled({ ...on, field: "pressure", arrows: false })).toBe(true);
    expect(weatherEnabled({ ...on, field: "off", arrows: true })).toBe(true);
  });
});

describe("fieldVariable — the displayed field IS a canonical variable", () => {
  it("is null when no field is selected", () => {
    expect(fieldVariable({ ...on, field: "off" })).toBeNull();
  });

  it("passes the field id straight through — no per-model convention pick", () => {
    // `windVariable`/`SPEED_DIR_MODELS` used to turn this into
    // `wind_speed_10m` or `wind_u_component_10m` depending on the model; that
    // fact lives in `openmeteo.upstream_variable` now.
    expect(fieldVariable({ ...on, field: "wind" })).toBe("wind");
    expect(fieldVariable({ ...on, field: "waves" })).toBe("waves");
  });
});

describe("the id-addressed URLs", () => {
  it("builds the wash tile template", () => {
    expect(washTilesUrl("grib:my set:dwd_icon_eu", "wind", "2026-07-29T12:00:00Z", true)).toBe(
      `${WEATHER_HOST}/sources/grib%3Amy%20set%3Adwd_icon_eu/wash/wind/{z}/{x}/{y}.png` +
        `?time=2026-07-29T12%3A00%3A00Z&dark=true`,
    );
  });

  it("builds the particle field tile URL — `field`, not `wind`, so waves need no new route", () => {
    expect(fieldTileUrl("om:dwd_icon", "wind", "2026-07-29T12:00:00Z", 4, 8, 5)).toBe(
      `${WEATHER_HOST}/sources/om%3Adwd_icon/field/wind/4/8/5.png` +
        `?time=2026-07-29T12%3A00%3A00Z`,
    );
  });

  it("builds the point URL", () => {
    expect(pointUrl("om:dwd_icon", "waves", "2026-07-29T12:00:00Z", 55.7, 12.6)).toBe(
      `${WEATHER_HOST}/sources/om%3Adwd_icon/point` +
        `?variable=waves&time=2026-07-29T12%3A00%3A00Z&lat=55.7&lon=12.6`,
    );
  });
});

describe("resolveWeatherRaster — the wash tile source", () => {
  const s = source({ id: "om:dwd_icon", variables: ["wind", "gusts"] });

  it("builds the id-addressed tile route", () => {
    const r = resolveWeatherRaster({ ...on, model: s.id, field: "gusts" }, s, false, NOW);
    expect(r).not.toBeNull();
    expect(r!.tiles).toBe(washTilesUrl(s.id, "gusts", new Date(NOW).toISOString(), false));
    expect(r!.attribution).toBe(WEATHER_ATTRIBUTION);
  });

  it("draws NOTHING rather than substituting, in every not-answerable case", () => {
    // No field.
    expect(resolveWeatherRaster({ ...on, model: s.id, field: "off" }, s, false, NOW)).toBeNull();
    // No source selected, or a selection this boat does not offer (mode.ts
    // resolves both to `null`).
    expect(resolveWeatherRaster({ ...on, field: "gusts" }, null, false, NOW)).toBeNull();
    // A field this source does not serve — the picker would not offer it, but a
    // stale profile can still name it.
    expect(
      resolveWeatherRaster({ ...on, model: s.id, field: "waves" }, s, false, NOW),
    ).toBeNull();
    // A time it cannot cover.
    const bounded = source({
      variables: ["wind"],
      coverage: { local: [NOW], remote: [], referenceMs: null },
    });
    expect(
      resolveWeatherRaster(
        { ...on, model: bounded.id, field: "wind", hours: 48 },
        bounded,
        false,
        NOW,
      ),
    ).toBeNull();
  });

  it("caps maxzoom to the backend's render ceiling — regression for utmolwkt", () => {
    // Without a maxzoom MapLibre requests tiles at the view's native zoom, and
    // every z11+ request 404s, so the wash never rendered at harbour zooms.
    const r = resolveWeatherRaster({ ...on, model: s.id, field: "wind" }, s, false, NOW);
    expect(r!.maxzoom).toBe(10);
  });

  it("bakes dark into the URL — a palette flip must refetch, not repaint", () => {
    const r = resolveWeatherRaster({ ...on, model: s.id, field: "wind" }, s, true, NOW);
    expect(r!.tiles).toContain("dark=true");
  });

  it("the key changes with the source, the variable, the TIME, or dark", () => {
    const base = resolveWeatherRaster({ ...on, model: s.id, field: "wind" }, s, false, NOW)!;
    const other = source({ id: "om:ncep_gfs025", variables: ["wind", "gusts"] });
    expect(
      resolveWeatherRaster({ ...on, model: other.id, field: "wind" }, other, false, NOW)!.key,
    ).not.toBe(base.key);
    expect(
      resolveWeatherRaster({ ...on, model: s.id, field: "gusts" }, s, false, NOW)!.key,
    ).not.toBe(base.key);
    // A scrub. Without the time in the key the reconcile would keep painting
    // the previous hour's tiles.
    expect(
      resolveWeatherRaster({ ...on, model: s.id, field: "wind", hours: 6 }, s, false, NOW)!.key,
    ).not.toBe(base.key);
    expect(resolveWeatherRaster({ ...on, model: s.id, field: "wind" }, s, true, NOW)!.key).not.toBe(
      base.key,
    );
  });
});
