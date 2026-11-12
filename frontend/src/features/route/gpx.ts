// GPX 1.1 in and out for saved routes — pure (no fetch, no download, no
// signals), so every rule here is unit-tested (./gpx.test.ts).
//
// Export: one route → one `<rte>` with an `<rtept lat lon><name>` per
// waypoint. Import: each `<rte>` becomes a route as-is (waypoints exactly
// where they were placed); each `<trk>` becomes a route by simplification
// (`core/simplify.ts`, the same one "Make route from track" uses). Loose
// `<wpt>` lists are counted and skipped — they are marks, not an ordered
// passage.
//
// Parsing goes through `DOMParser` in the app. The parse step is injected
// (`XmlParse`) because bun's test runtime has no DOM; tests drive the same
// code through ./testXml.ts.
//
// The store's limits (backend `features/route/store.py`) are enforced HERE,
// so an import never fails half-way through a save: ≤ 500 waypoints, names
// ≤ 64 chars, fresh uuid ids (GPX carries no ids we could trust to match
// `[A-Za-z0-9_:-]{1,64}` or to be unique).

import { DEFAULT_PLAN_SPEED_KN, type Route, type Waypoint } from "../../core/routes";
import { simplifyTrack, TRACK_ROUTE_MAX_POINTS, type LatLon } from "../../core/simplify";

/** Mirrors backend `route/store.py`. */
export const MAX_WAYPOINTS = 500;
export const MAX_NAME_LENGTH = 64;

const GPX_NS = "http://www.topografix.com/GPX/1/1";

// ── Export ───────────────────────────────────────────────────────────────────

/** XML 1.0 forbids most C0 controls even escaped; drop them, escape the rest. */
const xmlText = (s: string): string =>
  s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/** A coordinate as `xsd:decimal` (no exponent), 7 places (~1 cm), trailing
 * zeros trimmed. */
const coord = (v: number): string =>
  v
    .toFixed(7)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");

/** The route as a GPX 1.1 document with one `<rte>`. */
export function routeToGpx(route: Route, creator = "mivnav"): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="${xmlText(creator)}" xmlns="${GPX_NS}">`,
    "  <rte>",
  ];
  if (route.name.trim()) lines.push(`    <name>${xmlText(route.name.trim())}</name>`);
  for (const w of route.waypoints) {
    const name = w.name.trim();
    lines.push(
      name
        ? `    <rtept lat="${coord(w.lat)}" lon="${coord(w.lon)}"><name>${xmlText(name)}</name></rtept>`
        : `    <rtept lat="${coord(w.lat)}" lon="${coord(w.lon)}"/>`,
    );
  }
  lines.push("  </rte>", "</gpx>", "");
  return lines.join("\n");
}

/** A download file name for the route: its name made filesystem-safe. */
export function gpxFileName(route: Route): string {
  const base = route.name
    .trim()
    .replace(/[^\p{L}\p{N}._ -]+/gu, "_")
    .replace(/\s+/g, " ")
    .slice(0, MAX_NAME_LENGTH)
    .trim();
  return `${base || "route"}.gpx`;
}

// ── Import ───────────────────────────────────────────────────────────────────

/** The few DOM members the importer reads — a DOM `Element` satisfies it
 * structurally, and so does ./testXml.ts's element. `localName` is the name
 * without any namespace prefix, so `gpx:rte` and default-namespace `rte`
 * read the same. */
export interface XmlElement {
  readonly localName: string;
  readonly children: ArrayLike<XmlElement>;
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
}

/** Text → the document's root element, or null if it is not well-formed. */
export type XmlParse = (text: string) => XmlElement | null;

/** The app's parser: the browser's own `DOMParser`. Malformed input yields a
 * `<parsererror>` (inside the document in Chromium/WebKit, as the root in
 * Firefox) rather than an exception. */
export const domParse: XmlParse = (text) => {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) return null;
  return doc.documentElement;
};

export interface GpxImport {
  /** Ready to save: fresh ids, `rev` 0, within the store's limits. */
  routes: Route[];
  /** One line per `<rte>`/`<trk>` NOT imported, and why. */
  skipped: string[];
  /** One line per track simplified ("… 5234 → 87 points"). */
  notes: string[];
  /** Loose `<wpt>` elements, not imported. */
  looseWaypoints: number;
}

export type GpxImportResult = ({ ok: true } & GpxImport) | { ok: false; error: string };

export interface GpxImportOptions {
  /** Used to name a route the file leaves unnamed. */
  fileName?: string;
  mintId: () => string;
  /** Defaults to `domParse`. */
  parse?: XmlParse;
}

const kids = (el: XmlElement, name: string): XmlElement[] =>
  Array.from(el.children).filter((c) => c.localName === name);

const childText = (el: XmlElement, name: string): string => {
  const c = kids(el, name)[0];
  return (c?.textContent ?? "").replace(/\s+/g, " ").trim();
};

/** A name the store accepts (≤ 64 chars, single-spaced). */
export const clampName = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH).trim();

/** `lat`/`lon` attributes as a valid point, or null. */
function readPoint(el: XmlElement): LatLon | null {
  const latS = el.getAttribute("lat");
  const lonS = el.getAttribute("lon");
  if (latS === null || lonS === null || latS.trim() === "" || lonS.trim() === "") return null;
  const lat = Number(latS);
  const lon = Number(lonS);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

const fileBase = (fileName: string | undefined): string =>
  clampName((fileName ?? "").replace(/^.*[\\/]/, "").replace(/\.gpx$/i, ""));

/** Build a store-ready route from points — each gets a fresh id, its name
 * clamped. Manual-editor shaped: every point a deliberately placed one. */
export function buildRoute(
  name: string,
  points: readonly (LatLon & { name?: string })[],
  mintId: () => string,
): Route {
  const waypoints: Waypoint[] = points.map((p) => ({
    id: mintId(),
    name: clampName(p.name ?? ""),
    lat: p.lat,
    lon: p.lon,
    stop: true,
  }));
  return {
    id: mintId(),
    name: clampName(name),
    waypoints,
    plan_speed_kn: DEFAULT_PLAN_SPEED_KN,
    rev: 0,
    updated: 0,
  };
}

/** A recorded track as a route: simplified (`simplifyTrack`) to at most
 * `TRACK_ROUTE_MAX_POINTS` waypoints. Null for fewer than 2 distinct points. */
export function routeFromTrack(
  name: string,
  points: readonly LatLon[],
  mintId: () => string,
): { route: Route; from: number; toleranceM: number } | null {
  const { points: simple, toleranceM } = simplifyTrack(points, TRACK_ROUTE_MAX_POINTS);
  if (simple.length < 2) return null;
  return { route: buildRoute(name, simple, mintId), from: points.length, toleranceM };
}

/** "Track 2026-11-06" from a GPX `<time>` / ISO string, or null. */
export function trackDateName(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return `Track ${new Date(t).toISOString().slice(0, 10)}`;
}

/** Parse a GPX file into routes ready to save. Never throws. */
export function importGpx(text: string, opts: GpxImportOptions): GpxImportResult {
  const parse = opts.parse ?? domParse;
  let root: XmlElement | null;
  try {
    root = parse(text);
  } catch {
    root = null;
  }
  if (!root) return { ok: false, error: "This file is not valid XML." };
  if (root.localName !== "gpx") return { ok: false, error: "This file is not GPX (no <gpx> root element)." };

  const base = fileBase(opts.fileName);
  const out: GpxImport = { routes: [], skipped: [], notes: [], looseWaypoints: 0 };
  let unnamed = 0;
  const fallbackName = (): string => {
    unnamed++;
    const stem = base || "Imported route";
    return unnamed === 1 ? stem : `${stem.slice(0, MAX_NAME_LENGTH - 4)} ${unnamed}`;
  };

  for (const el of Array.from(root.children)) {
    if (el.localName === "wpt") {
      out.looseWaypoints++;
    } else if (el.localName === "rte") {
      const given = childText(el, "name");
      const label = given || `route ${out.routes.length + out.skipped.length + 1}`;
      const pts = kids(el, "rtept");
      const points: (LatLon & { name: string })[] = [];
      let bad = -1;
      pts.forEach((p, i) => {
        const at = readPoint(p);
        if (!at) {
          if (bad < 0) bad = i;
          return;
        }
        points.push({ ...at, name: childText(p, "name") });
      });
      if (bad >= 0) {
        // Dropping a waypoint would silently change the passage: refuse.
        out.skipped.push(`“${label}”: waypoint ${bad + 1} has no valid lat/lon.`);
      } else if (points.length === 0) {
        out.skipped.push(`“${label}”: no waypoints.`);
      } else if (points.length > MAX_WAYPOINTS) {
        out.skipped.push(`“${label}”: ${points.length} waypoints — at most ${MAX_WAYPOINTS} are allowed.`);
      } else {
        out.routes.push(buildRoute(given || fallbackName(), points, opts.mintId));
      }
    } else if (el.localName === "trk") {
      const given = childText(el, "name");
      const points: LatLon[] = [];
      let firstTime: string | null = null;
      // Segments are joined in order: as a route, a gap in the recording is
      // just a straight leg.
      for (const seg of kids(el, "trkseg")) {
        for (const p of kids(seg, "trkpt")) {
          const at = readPoint(p);
          // A track is a recording: a bad fix is noise, not a decision.
          if (!at) continue;
          firstTime ??= childText(p, "time") || null;
          points.push(at);
        }
      }
      const label = given || trackDateName(firstTime) || fallbackName();
      const made = routeFromTrack(label, points, opts.mintId);
      if (!made) {
        out.skipped.push(`Track “${label}”: fewer than two usable points.`);
      } else {
        out.routes.push(made.route);
        out.notes.push(
          `Track “${made.route.name}”: ${made.from} → ${made.route.waypoints.length} points (±${Math.round(made.toleranceM)} m).`,
        );
      }
    }
  }
  return { ok: true, ...out };
}

/** One line for a notice: what an import did. */
export function importSummary(r: GpxImport): string {
  const parts: string[] = [];
  const n = r.routes.length;
  parts.push(n === 1 ? "1 route" : `${n} routes`);
  if (r.skipped.length) parts.push(`${r.skipped.length} skipped`);
  if (r.looseWaypoints) parts.push(`${r.looseWaypoints} loose waypoint${r.looseWaypoints === 1 ? "" : "s"} ignored`);
  return parts.join(" · ");
}
