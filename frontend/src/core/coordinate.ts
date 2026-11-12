// Parse a coordinate a mariner typed: decimal degrees, degrees-decimal-minutes,
// or degrees-minutes-seconds. PURE and map-free (see coordinate.test.ts).
// lat/lon order: a hemisphere letter pins the axis; else |v|>90 must be longitude; else lat-first.

/** A parsed position. `lng` (not `lon`) to match MapLibre's naming everywhere
 * else in the tree (`{ lng, lat }`). */
export interface ParsedCoordinate {
  lat: number;
  lng: number;
}

/** Result monad, same `{ ok }` shape the config code uses — the caller shows
 * `error` inline and does NOT move the map, or reads `value`. */
export type CoordinateResult =
  | { ok: true; value: ParsedCoordinate }
  | { ok: false; error: string };

type Unit = "deg" | "min" | "sec" | "plain";
type Hemi = "N" | "S" | "E" | "W";

interface NumberTok {
  value: number;
  unit: Unit;
}

/** One half of the input: its numbers (deg[/min[/sec]]) and its hemisphere, if
 * it carried one. */
interface Component {
  numbers: NumberTok[];
  hemi: Hemi | null;
}

type Event =
  | { t: "num"; value: number }
  | { t: "sym"; unit: Exclude<Unit, "plain"> }
  | { t: "hemi"; h: Hemi };

// Ordered alternation, matched sticky so a stray character can be caught rather
// than skipped. Seconds (`''`, `″`, `”`, `"`) before minutes (`'`, `’`, `′`) so
// a doubled apostrophe reads as seconds, not two empty minutes.
const TOKEN =
  /(\s+|,|;)|([-+]?\d+(?:\.\d+)?)|(°|º)|(''|″|”|")|('|’|′)|([NSEW])|(.)/y;

function tokenize(raw: string): Event[] | null {
  const s = raw.toUpperCase();
  const events: Event[] = [];
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (TOKEN.lastIndex < s.length) {
    m = TOKEN.exec(s);
    if (!m) return null;
    if (m[1] !== undefined) continue; // whitespace / separator
    if (m[2] !== undefined) events.push({ t: "num", value: Number(m[2]) });
    else if (m[3] !== undefined) events.push({ t: "sym", unit: "deg" });
    else if (m[4] !== undefined) events.push({ t: "sym", unit: "sec" });
    else if (m[5] !== undefined) events.push({ t: "sym", unit: "min" });
    else if (m[6] !== undefined) events.push({ t: "hemi", h: m[6] as Hemi });
    else return null; // group 7: anything else — garbage, reject the whole input
  }
  return events;
}

/** Attach each degree/minute/second symbol to the number it follows. A symbol
 * with no number before it in its run is malformed. */
function assignUnits(events: Event[]): NumberTok[] | null {
  const nums: NumberTok[] = [];
  for (const e of events) {
    if (e.t === "num") nums.push({ value: e.value, unit: "plain" });
    else if (e.t === "sym") {
      const last = nums[nums.length - 1];
      if (!last || last.unit !== "plain") return null;
      last.unit = e.unit;
    }
  }
  return nums;
}

/** Split the flat event stream into its two components. Decided once, globally,
 * by where the FIRST hemisphere letter sits: leading (`N55 E10`) or trailing
 * (`55N 10E`). Letterless input must be exactly two bare numbers. */
function toComponents(events: Event[]): Component[] | null {
  const firstNum = events.findIndex((e) => e.t === "num");
  const firstHemi = events.findIndex((e) => e.t === "hemi");

  if (firstHemi === -1) {
    const nums = assignUnits(events);
    if (!nums) return null;
    // Only bare decimal degrees, exactly two, is unambiguous without letters.
    if (nums.length !== 2 || nums.some((n) => n.unit !== "plain")) return null;
    return [
      { numbers: [nums[0]], hemi: null },
      { numbers: [nums[1]], hemi: null },
    ];
  }

  const leading = firstNum === -1 || firstHemi < firstNum;
  const components: Component[] = [];
  let run: Event[] = [];
  let pending: Hemi | null = null;
  let started = false;

  const flush = (hemi: Hemi | null) => {
    const nums = assignUnits(run);
    if (!nums) return false;
    components.push({ numbers: nums, hemi });
    run = [];
    return true;
  };

  for (const e of events) {
    if (e.t === "hemi") {
      if (leading) {
        if (started && !flush(pending)) return null;
        pending = e.h;
        started = true;
      } else {
        if (!flush(e.h)) return null;
      }
    } else {
      run.push(e);
    }
  }
  // Trailing: anything after the last letter is a final, letter-less component
  // (e.g. `55N 10` — one axis pinned, the other inferred). Leading: the last
  // pending letter still owns the numbers gathered after it.
  if (leading) {
    if (started && !flush(pending)) return null;
  } else if (run.length > 0) {
    if (!flush(null)) return null;
  }
  return components;
}

interface Axised {
  value: number;
  axis: "lat" | "lon" | null;
}

/** One component to signed decimal degrees, plus which axis (if any) its letter
 * fixed. Returns an error string on an out-of-form component. */
function toDegrees(c: Component): Axised | string {
  const n = c.numbers;
  if (n.length === 0) return "Missing a coordinate";
  if (n.length > 3) return "Too many numbers in one coordinate";

  // Explicit symbols must read deg, then min, then sec, in that order; bare
  // numbers take their unit from position (1 ⇒ deg, 2 ⇒ +min, 3 ⇒ +sec).
  const want: Unit[] = ["deg", "min", "sec"];
  for (let i = 0; i < n.length; i++) {
    if (n[i].unit !== "plain" && n[i].unit !== want[i]) return "Coordinate parts out of order";
  }

  const deg = Math.abs(n[0].value);
  const min = n[1]?.value ?? 0;
  const sec = n[2]?.value ?? 0;
  if (min < 0 || min >= 60) return "Minutes must be between 0 and 60";
  if (sec < 0 || sec >= 60) return "Seconds must be between 0 and 60";

  const magnitude = deg + min / 60 + sec / 3600;
  // A hemisphere letter is the sign; without one, the degrees number's own sign
  // is. (An explicit minus AND a letter — `-55N` — lets the letter win rather
  // than reject: no real input means both, and forgiving beats pedantic.)
  let sign = n[0].value < 0 ? -1 : 1;
  let axis: "lat" | "lon" | null = null;
  if (c.hemi === "N" || c.hemi === "S") axis = "lat";
  else if (c.hemi === "E" || c.hemi === "W") axis = "lon";
  if (c.hemi === "S" || c.hemi === "W") sign = -1;
  else if (c.hemi === "N" || c.hemi === "E") sign = 1;

  return { value: magnitude * sign, axis };
}

/** Parse a typed coordinate. Never throws; a bad input is `{ ok: false, error }`
 * with a message fit to show inline, and the caller must not move the map on it. */
export function parseCoordinate(raw: string): CoordinateResult {
  const text = raw.trim();
  if (text === "") return { ok: false, error: "Enter a coordinate" };

  const events = tokenize(text);
  if (!events) return { ok: false, error: "Unrecognised coordinate" };

  const components = toComponents(events);
  if (!components) return { ok: false, error: "Unrecognised coordinate" };
  if (components.length !== 2) return { ok: false, error: "Enter both latitude and longitude" };

  const parts = components.map(toDegrees);
  for (const p of parts) if (typeof p === "string") return { ok: false, error: p };
  const [a, b] = parts as Axised[];

  let lat: number;
  let lng: number;
  if (a.axis && b.axis) {
    if (a.axis === b.axis) return { ok: false, error: "Need one N/S and one E/W" };
    lat = a.axis === "lat" ? a.value : b.value;
    lng = a.axis === "lon" ? a.value : b.value;
  } else if (a.axis || b.axis) {
    // One letter given: it fixes its axis, the other takes what is left.
    const known = a.axis ? a : b;
    const other = a.axis ? b : a;
    lat = known.axis === "lat" ? known.value : other.value;
    lng = known.axis === "lon" ? known.value : other.value;
  } else {
    // Neither pinned: an out-of-lat-range magnitude can only be longitude;
    // otherwise the conventional latitude-first order stands.
    if (Math.abs(a.value) > 90 && Math.abs(b.value) > 90)
      return { ok: false, error: "Latitude out of range (±90°)" };
    if (Math.abs(a.value) > 90) {
      lng = a.value;
      lat = b.value;
    } else if (Math.abs(b.value) > 90) {
      lat = a.value;
      lng = b.value;
    } else {
      lat = a.value;
      lng = b.value;
    }
  }

  if (!Number.isFinite(lat) || lat < -90 || lat > 90)
    return { ok: false, error: "Latitude out of range (±90°)" };
  if (!Number.isFinite(lng) || lng < -180 || lng > 180)
    return { ok: false, error: "Longitude out of range (±180°)" };

  return { ok: true, value: { lat, lng } };
}

/** Render a decimal position back to DDM with a hemisphere letter — the
 * marine idiom, e.g. `55°30.5′N 010°30.5′E`. */
export function formatCoordinate(lat: number, lng: number): string {
  return `${formatAxis(lat, "lat")} ${formatAxis(lng, "lon")}`;
}

/**
 * Degrees + decimal minutes, shared by every DDM formatter (`formatAxis`,
 * `info/pointProvider.ts`, `info/vesselProvider.ts`). Keep the rollover guard:
 * a copy once lacked it and printed the impossible `60.000′` at `xx°59.9996′`.
 */
export function degreesDecimalMinutes(value: number, decimals: number): { deg: number; min: string } {
  const abs = Math.abs(value);
  let deg = Math.floor(abs);
  let min = (abs - deg) * 60;
  if (Number(min.toFixed(decimals)) >= 60) {
    min = 0;
    deg += 1;
  }
  return { deg, min: min.toFixed(decimals) };
}

/** One axis to `DDD°MM.m′H`, the tree's canonical `′N`-no-space DDM form.
 * `decimals` is the caller's precision — 1 for `formatCoordinate`'s compact
 * label, 3 for `chrome/core.ts`'s `nav.pos` (each axis on its own line). */
export function formatAxis(value: number, axis: "lat" | "lon", decimals = 1): string {
  const hemi = axis === "lat" ? (value < 0 ? "S" : "N") : value < 0 ? "W" : "E";
  const { deg, min } = degreesDecimalMinutes(value, decimals);
  const pad = axis === "lat" ? 2 : 3;
  return `${String(deg).padStart(pad, "0")}°${min.padStart(3 + decimals, "0")}′${hemi}`;
}
