// Lat/long graticule geometry — pure, so MapView feeds it view bounds/zoom
// and gets GeoJSON back, unit-testable without a browser. Lines and labels
// rebuild on different clocks (lines: padded-envelope, per `move`; labels:
// view-derived, per `moveend`) — see docs/architecture/graticule.md for why,
// including the visible mid-pan gap defect this fixed.

export interface GridBounds {
  west: number;
  east: number;
  south: number;
  north: number;
}

/** The lat/lon values whose lines the graticule draws — see {@link gridValues}. */
export interface GridValues {
  lons: number[];
  lats: number[];
}

/** Web mercator's usable latitude range; a line never runs past it. */
const MERCATOR_LIMIT = 85;

// "Nice" graticule steps in degrees, coarse→fine: whole degrees, then arc-
// minutes (30'..1'), then arc-seconds (30"..1"). The mariner's usual ladder.
const STEPS_DEG: readonly number[] = [
  30, 10, 5, 2, 1,
  30 / 60, 20 / 60, 10 / 60, 5 / 60, 2 / 60, 1 / 60,
  30 / 3600, 20 / 3600, 10 / 3600, 5 / 3600, 2 / 3600, 1 / 3600,
];

/** The largest nice step that draws at most ~`target` meridians across a
 * view `spanDeg` wide, so the grid stays legible at every zoom. */
export function gridStep(spanDeg: number, target = 8): number {
  // Finest nice step that still draws ≤ target lines: STEPS_DEG is
  // coarse→fine, keep taking finer steps while ≥ the ideal spacing.
  const ideal = spanDeg / target;
  let chosen = STEPS_DEG[0]!;
  for (const s of STEPS_DEG) {
    if (s >= ideal) chosen = s;
    else break;
  }
  return chosen;
}

/** A signed degree value as `DD°`, `DD°MM.m′` or `DD°MM′SS″` — precision
 * follows `step` so a 1° grid reads "56° N", a 5′ grid "56°05′ N". */
export function formatDeg(value: number, kind: "lat" | "lon", step: number): string {
  const hemi = kind === "lat" ? (value >= 0 ? "N" : "S") : (value >= 0 ? "E" : "W");
  const abs = Math.abs(value);
  const deg = Math.floor(abs + 1e-9);
  const minTotal = (abs - deg) * 60;
  if (step >= 1) return `${deg}° ${hemi}`;
  if (step >= 1 / 60) {
    // arc-minute grid: whole (or half) minutes, no seconds
    const min = Math.round(minTotal * 10) / 10;
    const minStr = Number.isInteger(min) ? String(min) : min.toFixed(1);
    return `${deg}°${minStr.padStart(2, "0")}′ ${hemi}`;
  }
  const min = Math.floor(minTotal + 1e-9);
  const sec = Math.round((minTotal - min) * 60);
  return `${deg}°${String(min).padStart(2, "0")}′${String(sec).padStart(2, "0")}″ ${hemi}`;
}

interface LineFeature {
  type: "Feature";
  properties: { kind: "meridian" | "parallel" };
  geometry: { type: "MultiLineString"; coordinates: [number, number][][] };
}

interface LabelFeature {
  type: "Feature";
  properties: { kind: "meridian" | "parallel"; label: string };
  geometry: { type: "Point"; coordinates: [number, number] };
}

interface Collection<F> {
  type: "FeatureCollection";
  features: F[];
}

/** The snapped longitudes/latitudes whose lines fall inside `b` at `step`.
 * Re-derived by integer index (never a running `+= step`) so labels stay
 * clean of float drift; latitude clamped to the mercator-safe range first. */
export function gridValues(b: GridBounds, step: number): GridValues {
  const south = Math.max(b.south, -MERCATOR_LIMIT);
  const north = Math.min(b.north, MERCATOR_LIMIT);
  const snap = (v: number) => Math.ceil(v / step - 1e-9) * step;
  const round = (v: number) => Math.round(v / step) * step;

  const lons: number[] = [];
  const lon0 = snap(b.west);
  for (let i = 0; lon0 + i * step <= b.east + 1e-9; i++) lons.push(round(lon0 + i * step));

  const lats: number[] = [];
  const lat0 = snap(south);
  for (let i = 0; lat0 + i * step <= north + 1e-9; i++) lats.push(round(lat0 + i * step));

  return { lons, lats };
}

/** The grid LINES at full extent — two features total (one MultiLineString
 * per orientation). Nothing here reads the view: correct from any position
 * inside the envelope its values were derived for. See graticule.md. */
export function graticuleLines(v: GridValues): Collection<LineFeature> {
  const features: LineFeature[] = [];
  if (v.lons.length > 0) {
    features.push({
      type: "Feature",
      properties: { kind: "meridian" },
      geometry: {
        type: "MultiLineString",
        coordinates: v.lons.map((lon) => [
          [lon, -MERCATOR_LIMIT],
          [lon, MERCATOR_LIMIT],
        ]),
      },
    });
  }
  if (v.lats.length > 0) {
    features.push({
      type: "Feature",
      properties: { kind: "parallel" },
      geometry: {
        type: "MultiLineString",
        coordinates: v.lats.map((lat) => [
          [-180, lat],
          [180, lat],
        ]),
      },
    });
  }
  return { type: "FeatureCollection", features };
}

/** The grid LABELS for a view: one Point per line, riding the north edge
 * (meridians) / west edge (parallels). View-derived, rebuilt as the view moves. */
export function graticuleLabels(b: GridBounds, step: number): Collection<LabelFeature> {
  const north = Math.min(b.north, MERCATOR_LIMIT);
  const { lons, lats } = gridValues(b, step);
  const features: LabelFeature[] = [];
  for (const lon of lons) {
    features.push({
      type: "Feature",
      properties: { kind: "meridian", label: formatDeg(lon, "lon", step) },
      geometry: { type: "Point", coordinates: [lon, north] },
    });
  }
  for (const lat of lats) {
    features.push({
      type: "Feature",
      properties: { kind: "parallel", label: formatDeg(lat, "lat", step) },
      geometry: { type: "Point", coordinates: [b.west, lat] },
    });
  }
  return { type: "FeatureCollection", features };
}

/** Grow `b` by `pad` view-spans on every side — the ENVELOPE line geometry is
 * built for. `pad = 1` triples width/height, giving a pan a screen of slack
 * before a new line can enter the view. Latitude clamps at the mercator limit. */
export function padBounds(b: GridBounds, pad: number): GridBounds {
  const dx = (b.east - b.west) * pad;
  const dy = (b.north - b.south) * pad;
  return {
    west: b.west - dx,
    east: b.east + dx,
    south: Math.max(b.south - dy, -MERCATOR_LIMIT),
    north: Math.min(b.north + dy, MERCATOR_LIMIT),
  };
}

/** Is `inner` wholly inside `outer`? The change-detection guard. `inner`'s
 * latitudes clamp the same way `padBounds` clamps the envelope's, so a view
 * past the mercator limit still compares equal instead of forever escaping. */
export function boundsContain(outer: GridBounds, inner: GridBounds): boolean {
  const south = Math.max(inner.south, -MERCATOR_LIMIT);
  const north = Math.min(inner.north, MERCATOR_LIMIT);
  return (
    outer.west <= inner.west &&
    outer.east >= inner.east &&
    outer.south <= south &&
    outer.north >= north
  );
}
