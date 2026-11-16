import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Cross-language drift guard for the SERVER CONFIG SCHEMA.
//
// serverConfig.ts hand-types the config document the backend returns from
// GET /config and accepts on PATCH /config. The authority is the Pydantic
// `Config` model, assembled in backend/mivnav/config/model.py from per-feature
// slice classes that increasingly live in their own feature package (see
// CLASS_FILE below) — model.py itself for anything not yet split out. A field
// added there that the UI does not model is invisible to the settings panel —
// no drift error, it just silently cannot be seen or changed. (This is how
// `warm_overview` came to be missing.)
//
// This test enumerates the backend's user-facing config fields, per section,
// and asserts the frontend type covers them — minus a small, DOCUMENTED set of
// fields the frontend deliberately does not model. A new backend field lands as
// a red test here until it is either mirrored or added to BACKEND_ONLY with a
// reason. Sibling of style/chartStyle.vectorLayers.test.ts: parse, then assert.

const MODEL_PY = join(import.meta.dir, "../../../backend/mivnav/config/model.py");
const SERVER_CONFIG_TS = join(import.meta.dir, "serverConfig.ts");

// Every per-feature config SLICE class used to live in model.py; the Feature
// restructuring is moving each one out to its own feature package (see
// model.py's "Every per-feature config SLICE class ... now lives in that
// feature's own directory" comment) — OchartsConfig has already moved to
// features/ocharts/config.py, one class at a time. This map is the per-class
// override; anything not listed is still assembled/defined in MODEL_PY.
const CLASS_FILE: Record<string, string> = {
  OchartsConfig: join(import.meta.dir, "../../../backend/mivnav/features/ocharts/config.py"),
  NavConfig: join(import.meta.dir, "../../../backend/mivnav/features/route/config.py"),
  TrackConfig: join(import.meta.dir, "../../../backend/mivnav/features/track/config.py"),
};

/**
 * The fields of a Pydantic model class, from its source file (CLASS_FILE,
 * falling back to MODEL_PY). A field is a `name: type` at the class's own
 * 4-space indent; `model_config`, methods (`def`), decorators and `@property`
 * computed values are not fields and are skipped by construction (none match
 * `^    name:`). Throws on an unknown class so a rename fails loud rather
 * than yielding an empty set.
 */
function pyFields(cls: string): string[] {
  const path = CLASS_FILE[cls] ?? MODEL_PY;
  const src = readFileSync(path, "utf8");
  const lines = src.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^class ${cls}\\(`).test(l));
  if (start === -1) throw new Error(`class ${cls} not found in ${path}`);
  const fields: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^class /.test(line) || /^\S/.test(line)) break; // next class / dedent to module level
    const m = line.match(/^ {4}(\w+)\s*:/);
    if (m && m[1] !== "model_config") fields.push(m[1]);
  }
  if (fields.length === 0) throw new Error(`no fields parsed for ${cls}`);
  return fields;
}

/** The property names of a TS `export interface`, from the source. */
function tsInterfaceFields(src: string, name: string): string[] {
  const m = src.match(new RegExp(`export interface ${name}\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!m) throw new Error(`interface ${name} not found in ${SERVER_CONFIG_TS}`);
  return [...m[1].matchAll(/^\s*(\w+)\??\s*:/gm)].map((f) => f[1]);
}

/** The keys of an inline object typing one field of an interface, e.g. the
 * `credentials: { ocharts: … }` member of ServerConfig. */
function tsInlineObjectKeys(src: string, iface: string, field: string): string[] {
  const body = src.match(new RegExp(`export interface ${iface}\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!body) throw new Error(`interface ${iface} not found`);
  const m = body[1].match(new RegExp(`${field}\\s*:\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`inline object field ${field} not found on ${iface}`);
  return [...m[1].matchAll(/(\w+)\s*:/g)].map((f) => f[1]);
}

const tsSrc = readFileSync(SERVER_CONFIG_TS, "utf8");

/**
 * Backend config fields the frontend deliberately does NOT model, each with the
 * reason it is safe to omit. Anything not listed here MUST appear in the
 * matching frontend type — that is the gate.
 */
const BACKEND_ONLY: Record<string, string> = {
  // Each out-of-tree plugin's own settings block (backend mivnav.plugins),
  // validated by that plugin; the core settings UI never reads or writes it.
  "Config.plugins": "per-plugin settings, opaque to the core UI",
  // Read and written through /plugins (Settings → Plugins), not the config
  // document — the switch also has to list what is installed.
  "Config.plugins_disabled": "switched via /plugins (Settings → Plugins)",
  // The device's stable SignalK identity, minted once by the access-request
  // handshake and never edited by a human. The backend owns it end to end
  // (signalkAccess.ts); nothing in the settings UI reads or writes it.
  "Config.signalk_client_id":
    "device identity minted by the access-request flow; never shown or edited",
  // signalk_client_id's twin for the RouteIQ access-request grant — same
  // reasoning, same posture: the backend mints and owns it end to end
  // (the autorouting plugin), nothing in the settings UI reads or writes it.
  "Config.routeiq_client_id":
    "device identity minted by the RouteIQ access-request flow; never shown or edited",
  // The autopilot write token: a secret, always null on the wire (redacted),
  // obtained via the access-request handshake and never typed by hand. Its
  // presence is surfaced through meta.signalk_token_set, so — unlike the
  // o-charts password, which HAS a form (OchartsCredentialsView) — the config
  // document type models no signalk credentials at all.
  "CredentialsConfig.signalk":
    "write-only token from the access-request flow; presence shown via meta.signalk_token_set",
  // CredentialsConfig.signalk's exact twin for RouteIQ's own access-request
  // grant — a write-only token, presence shown via meta.routeiq_token_set
  // (the autorouting plugin's RouteIQ access UI), never modelled as an editable field.
  "CredentialsConfig.routeiq":
    "write-only token from the RouteIQ access-request flow; presence shown via meta.routeiq_token_set",
  // The POI PMTiles directory — a data-LOCATION tuning, a backend-only
  // tuning. The client only toggles the overlay (the device
  // setting `showPois`, ChartSettings); it does not manage where the boat's POI
  // files live, so the server-config document models no poi slice.
  "Config.poi":
    "POI PMTiles data-location tuning; the client toggles the overlay via the device setting showPois, not server config",
  // Satellite imagery sources + the offline PMTiles data-location — the exact
  // parallel of the POI slice. The client drives satellite through the dedicated
  // /satellite/{catalog,tiles,sets} + /ingest/satellite endpoints (source picker,
  // region bake, per-set management) and toggles the overlay via a device
  // setting, so the server-config document models no satellite slice.
  "Config.satellite":
    "satellite imagery source + PMTiles data-location tuning; the client uses the /satellite and /ingest/satellite endpoints + a device overlay toggle, not server config",
  // The Protomaps-extract basemap's build host/zoom range/pmtiles-binary
  // tuning (mivnav.features.osm_world.config) — the exact parallel of the
  // poi/satellite slices above. The client fetches the baked archives via
  // /osm_world/catalog + /osm_world/tiles, declares/triggers a bake via the
  // generic /datasets endpoints (region + per-dataset min_zoom/max_zoom
  // override), and toggles visibility via the device setting showOsmBase
  // (ChartSettings), so the server-config document models no osm_world
  // slice. (A `Config.osm` entry sat here for the second, Overpass-baked
  // basemap until task unqqplrl removed that feature outright.)
  // The mivport server a mivport POI dataset bakes from
  // (mivnav.features.poi.mivport.config). Not modelled yet: set in
  // config.json until the mivport account/settings panel lands.
  "Config.mivport": "mivport server URL (+ optional web-client URL); edited in config.json for now",
  "Config.osm_world":
    "osm_world build-host/zoom/pmtiles-binary tuning; the client uses /osm_world/catalog + /osm_world/tiles + /datasets and the shared showOsmBase overlay toggle, not server config",
  // The shared search index's SQLite path — a data-LOCATION tuning, the exact
  // parallel of the poi/satellite/weather slices above. The client only calls
  // GET /search (core/search); it does not manage where the index file lives,
  // so the server-config document models no search slice.
  "Config.search":
    "shared search index data-location tuning; the client only calls GET /search, not server config",
  // Declared offline datasets (id/provider/region/schedule/params) — managed
  // through the dedicated GET/POST/DELETE /datasets endpoints, the same
  // generic-CRUD-surface reasoning as poi/satellite above: this is a REST
  // resource collection, not a document field a settings panel edits in
  // place, so the server-config type models no datasets slice.
  "Config.datasets":
    "declared datasets are managed via the dedicated /datasets endpoints, not server config",
  // The Niord source's host/firing-area/attachment-cache tuning
  // (mivnav.features.notices.config) — same posture as the weather
  // slices: the client reads /notices/* and toggles the overlay via device
  // settings (ChartSettings), and no settings panel edits this slice (yet).
  // WHICH regions and WHEN are not here: each notices dataset carries them
  // (Datasets tab, /datasets). Hand-edit + POST /config/reload, or PATCH.
  "Config.notices":
    "Niord source tuning (host, firing areas, attachment cache); regions and schedule live on notices datasets (/datasets), the client uses /notices/* and device overlay toggles",
};

/** Each backend model mapped to the frontend type that must cover it. */
const SECTIONS: { py: string; fields: string[] }[] = [
  { py: "OchartsConfig", fields: tsInterfaceFields(tsSrc, "OchartsServerConfig") },
  { py: "NavConfig", fields: tsInterfaceFields(tsSrc, "NavServerConfig") },
  { py: "SignalKConfig", fields: tsInterfaceFields(tsSrc, "SignalKServerConfig") },
  { py: "TrackConfig", fields: tsInterfaceFields(tsSrc, "TrackServerConfig") },
  { py: "UpdatesConfig", fields: tsInterfaceFields(tsSrc, "UpdatesServerConfig") },
  { py: "Config", fields: tsInterfaceFields(tsSrc, "ServerConfig") },
  { py: "OchartsCredentials", fields: tsInterfaceFields(tsSrc, "OchartsCredentialsView") },
  { py: "CredentialsConfig", fields: tsInlineObjectKeys(tsSrc, "ServerConfig", "credentials") },
];

describe("server config schema stays in lockstep with the backend model", () => {
  test("the parse is non-trivial (guards against a vacuous pass)", () => {
    expect(pyFields("OchartsConfig").length).toBeGreaterThan(5);
    expect(tsInterfaceFields(tsSrc, "OchartsServerConfig").length).toBeGreaterThan(5);
  });

  for (const { py, fields } of SECTIONS) {
    test(`${py}: every user-facing backend field is modelled by the frontend`, () => {
      const frontend = new Set(fields);
      const missing = pyFields(py).filter(
        (f) => !frontend.has(f) && !(`${py}.${f}` in BACKEND_ONLY),
      );
      expect(missing).toEqual([]);
    });
  }

  test("the prefetch knob is modelled (the divergence this test was added for)", () => {
    // Was `warm_overview` when this test was added; M-DATA-2 normalised it to
    // the shared `prefetch` vocabulary. The gate is the same: a user-facing
    // o-charts knob the panel must be able to see.
    expect(tsInterfaceFields(tsSrc, "OchartsServerConfig")).toContain("prefetch");
  });

  test("the serving-detail tuning knobs are modelled (Chart detail advanced)", () => {
    // The reference-scale serving-detail knobs the "Chart detail (advanced)" boat
    // section reads/writes — a user-facing o-charts group the panel must be able
    // to see, same gate as `prefetch`. The generic backend→frontend check above
    // enforces them once the backend model lands them; this pins the frontend
    // side directly so a rename cannot silently drop a control. (serving_headroom
    // was renamed to over_zoom; the finest_fill* knobs were retired.)
    const fields = tsInterfaceFields(tsSrc, "OchartsServerConfig");
    for (const knob of [
      "over_zoom",
      "under_zoom",
      "detail_gap",
      "overview_detail_cutoff",
      "max_cells_per_tile",
    ])
      expect(fields).toContain(knob);
  });

  test("the chart-detail bias is modelled (the Chart detail slider)", () => {
    // `chart_detail` is the boat-wide SCAMIN bias B the "Chart detail" slider
    // writes and the chart style reads client-side to stay on the server's own
    // drop boundary — a user-facing o-charts knob the panel must be able to see,
    // same gate as `prefetch`. Pinned directly so a rename can't drop it.
    expect(tsInterfaceFields(tsSrc, "OchartsServerConfig")).toContain("chart_detail");
  });

  test("every BACKEND_ONLY exclusion still names a real backend field", () => {
    // A stale exclusion is a hole in the gate — if the backend drops the field,
    // its excuse must go too, or a future re-add sails through unmodelled.
    for (const dotted of Object.keys(BACKEND_ONLY)) {
      const [cls, field] = dotted.split(".");
      expect(pyFields(cls)).toContain(field);
    }
  });
});
