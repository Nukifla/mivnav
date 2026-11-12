// `buildCommands(deps)` assembles the command list; each `run` calls the SAME
// `deps` handler the on-screen control calls, so a command is a second way in,
// never a second copy of logic. Exception: the INLINE go-to (`inlineCoordinateCommand`), built live when the search text itself parses as a coordinate.

import { formatCoordinate, parseCoordinate } from "../coordinate";
import type { ChartSettings } from "../style/settings";
import type { CpaMode } from "../collisionSettings";
import { defineCommand, type Command, type ParseResult, type PromptSpec } from "./command";

// Re-exported so existing importers keep one import site; definitions live in
// ./command.ts.
export {
  filterCommands,
  createCommandRegistry,
  paletteCommands,
  formatKeybinding,
  commandKeybindings,
  type Command,
  type CommandContext,
  type CommandRegistry,
  type Keybinding,
  type ParseResult,
  type PromptSpec,
} from "./command";

/** Where a go-to lands: a position and the caller's decision on zoom (see
 * MapView's goto seam). Kept map-free — `{ lng, lat }` is plain numbers. */
export interface GotoTarget {
  lng: number;
  lat: number;
}

/** The go-to-coordinate command. Owns nothing but the glue: parsing is
 * ../coordinate.ts's, the map move is `onGoto`'s (App wires it to the signal
 * MapView subscribes to) — so this file never imports maplibre or the parser. */
export function gotoCoordinateCommand(deps: { onGoto: (t: GotoTarget) => void }): Command {
  return defineCommand({
    id: "goto-coordinate",
    label: "Go to coordinate",
    group: "Navigation",
    hint: "Jump the chart to a position",
    keywords: ["goto", "jump", "position", "latitude", "longitude", "lat", "lon", "navigate"],
    run: (ctx) =>
      ctx.prompt({
        label: "Coordinate",
        placeholder: "e.g. 55°30.5'N 010°30.5'E  or  55.5, 10.5",
        hint: "Decimal, deg-min, or deg-min-sec. Signed or with N/S/E/W.",
        parse: parseGoto,
        submit: (t: GotoTarget) => {
          deps.onGoto(t);
          ctx.close();
        },
      } as PromptSpec<never>),
  });
}

// Kept out of the closure so identity is stable for the `as PromptSpec<never>` bridge above.
function parseGoto(raw: string): ParseResult<GotoTarget> {
  const r = parseCoordinate(raw);
  if (!r.ok) return r;
  return { ok: true, value: { lng: r.value.lng, lat: r.value.lat } };
}

/**
 * The INLINE go-to: given the live search query, returns a one-shot command
 * when the text parses as a position, else `null`. The palette prepends it so
 * a fix ranks above every word-match; runs on the same `onGoto` seam.
 */
export function inlineCoordinateCommand(
  query: string,
  onGoto: (t: GotoTarget) => void,
): Command | null {
  const r = parseCoordinate(query);
  if (!r.ok) return null;
  const { lat, lng } = r.value;
  return {
    id: `goto:${lat},${lng}`,
    label: `Go to ${formatCoordinate(lat, lng)}`,
    group: "Navigation",
    run: (ctx) => {
      onGoto({ lng, lat });
      ctx.close();
    },
  };
}

/** Everything App can hand the registry: accessors a toggle reads for its
 * label, and the setters/handlers a command invokes. Each is a control that
 * already exists on screen; a command is a second way in, never a fork. */
export interface CommandDeps {
  onGoto: (t: GotoTarget) => void;
  settings: () => ChartSettings;
  setSettings: (patch: Partial<ChartSettings>) => void;
  toggleWindUnit: () => void;
  openSettings: () => void;
  /** Same overlay Ctrl/Cmd-F opens (../search/SearchPanel.tsx). */
  openSearch: () => void;
  openRoutes: () => void;
  /** Only asks App to recentre; the camera move stays in MapView's own
   * `centreBoat`. */
  centreBoat: () => void;
  /** Gates `centre-boat` — same predicate "Go here" reads (`routes.model.hasFix`). */
  hasFix: () => boolean;
  openDashboard: () => void;
  /** Opens the board on the Pilot tab, same path as tapping the `ap.status`
   * rail tile (App's `openInstrumentTab("ap.status")`). */
  openAutopilot: () => void;
  hasAutopilot: () => boolean;
  /** Open the board on the tab that owns `id` — the tile-tap path. Optional
   * so a test's deps need not stub it; a feature command that opens its own
   * tab (the Anchor tab) uses this. */
  openInstrument?: (id: string) => void;
  toggleMode: (id: string) => void;
  leaveMode: () => void;
  activeMode: () => string | null;
  togglePalette: () => void;
  debugLayers: () => boolean;
  setDebugLayers: (v: boolean) => void;
  /** The boat's off/show/tell — server config, every screen. Optional so a
   * test's deps need not stub it; absent → the three CPA commands are left out. */
  setCpaMode?: (mode: CpaMode) => void;
}

/** A boolean-setting command that labels itself from the current value and flips
 * it on run. `label(on)` gets the state so it can say "Hide soundings" when on
 * and "Show soundings" when off; the run is unconditional — read, negate, set. */
function toggleCommand(opts: {
  id: string;
  group: string;
  label: (on: boolean) => string;
  hint?: string;
  keywords?: readonly string[];
  get: () => boolean;
  set: (v: boolean) => void;
}): Command {
  return defineCommand({
    id: opts.id,
    label: opts.label(opts.get()),
    group: opts.group,
    hint: opts.hint,
    keywords: opts.keywords,
    run: (ctx) => {
      opts.set(!opts.get());
      ctx.close();
    },
  });
}

/** The rail's Off/Show/Tell as palette commands. */
function cpaCommands(setMode: (mode: CpaMode) => void): Command[] {
  return [
    defineCommand({
      id: "cpa-off",
      label: "CPA off",
      group: "Collision risk",
      hint: "No CPA lines, no alarm — whole boat",
      keywords: ["cpa", "collision", "ais", "risk", "off", "silent"],
      run: (ctx) => {
        setMode("off");
        ctx.close();
      },
    }),
    defineCommand({
      id: "cpa-show",
      label: "Show CPA lines (no alarm)",
      group: "Collision risk",
      hint: "Draw CPA lines, but no alarm — whole boat",
      keywords: ["cpa", "collision", "ais", "risk", "show", "lines"],
      run: (ctx) => {
        setMode("show");
        ctx.close();
      },
    }),
    defineCommand({
      id: "cpa-tell",
      label: "CPA lines and alarm",
      group: "Collision risk",
      hint: "Draw CPA lines and sound the alarm — whole boat",
      keywords: ["cpa", "collision", "ais", "risk", "tell", "alarm"],
      run: (ctx) => {
        setMode("tell");
        ctx.close();
      },
    }),
  ];
}

/** Builds the command list fresh from the current handlers — App calls this
 * inside a memo so a reopened palette reflects live settings. */
export function buildCommands(deps: CommandDeps): Command[] {
  const s = deps.settings;
  const set = deps.setSettings;
  return [
    gotoCoordinateCommand({ onGoto: deps.onGoto }),

    defineCommand({
      id: "centre-boat",
      label: "Centre on boat",
      group: "Navigation",
      hint: "Recentre the chart on the boat's position",
      keywords: ["centre", "center", "boat", "own", "ship", "recentre", "locate", "here"],
      enabled: deps.hasFix,
      run: (ctx) => {
        deps.centreBoat();
        ctx.close();
      },
    }),

    // Per-mode launchers (Measure, Edit route) come from `measureCommands`/
    // `routeCommands`, wired through App.tsx's `features` list; this is only
    // the mode-agnostic exit. Keybinding-only, active only while a mode is on.
    defineCommand({
      id: "exit-mode",
      label: "Exit current mode",
      group: "Chart modes",
      keybinding: { key: "Escape" },
      palette: false,
      enabled: () => deps.activeMode() !== null,
      run: () => deps.leaveMode(),
    }),

    // Day/dusk/night roles are the Modern Paper II family now; theme ids are
    // the persistence key and were deliberately not renamed. Keep these three
    // ids equal to `chrome/Launcher.tsx`'s `PALETTE_MODES` — same switch, two
    // surfaces.
    defineCommand({
      id: "palette-day",
      label: "Day palette",
      group: "Palette",
      hint: "Bright colours for daylight",
      keywords: ["light", "bright", "colour", "color", "theme"],
      run: (ctx) => {
        set({ palette: "modern-paper-2" });
        ctx.close();
      },
    }),
    defineCommand({
      id: "palette-dusk",
      label: "Dusk palette",
      group: "Palette",
      hint: "Dimmed colours for twilight",
      keywords: ["twilight", "dim", "colour", "color", "theme"],
      run: (ctx) => {
        set({ palette: "modern-paper-2-night-dim" });
        ctx.close();
      },
    }),
    defineCommand({
      id: "palette-night",
      label: "Night palette",
      group: "Palette",
      hint: "Red-on-black for dark adaptation",
      keywords: ["dark", "red", "colour", "color", "theme"],
      run: (ctx) => {
        set({ palette: "modern-paper-2-night-red" });
        ctx.close();
      },
    }),

    // Soundings visibility is controlled solely by the `enc:soundings` ENC
    // layer group (Layers panel eye) — no palette toggle, to avoid a second
    // gate that could skew against the panel.
    toggleCommand({
      id: "toggle-text",
      group: "Display",
      label: (on) => `${on ? "Hide" : "Show"} text labels`,
      hint: "Chart place & feature names",
      keywords: ["names", "labels", "annotation"],
      get: () => s().showText,
      set: (v) => set({ showText: v }),
    }),
    toggleCommand({
      id: "toggle-aton-text",
      group: "Display",
      label: (on) => `${on ? "Hide" : "Show"} buoy & beacon names`,
      hint: "Names labelled next to aids to navigation",
      keywords: ["aton", "buoy", "beacon", "labels"],
      get: () => s().showAtonText,
      set: (v) => set({ showAtonText: v }),
    }),
    toggleCommand({
      id: "toggle-lights",
      group: "Display",
      label: (on) => `${on ? "Hide" : "Show"} lights`,
      hint: "Light sectors and beacons",
      keywords: ["light", "sector", "beacon"],
      get: () => s().showLights,
      set: (v) => set({ showLights: v }),
    }),
    toggleCommand({
      id: "toggle-light-descriptions",
      group: "Display",
      label: (on) => `${on ? "Hide" : "Show"} light descriptions`,
      hint: "Light characteristic text (LITDSN)",
      keywords: ["litdsn", "light", "characteristic"],
      get: () => s().showLightDescriptions,
      set: (v) => set({ showLightDescriptions: v }),
    }),
    // Not a `toggleCommand`: the field is `"ms" | "kn"`, and the flip
    // (`toggleWindUnit`) reads the current value rather than taking a `set`.
    defineCommand({
      id: "toggle-wind-unit",
      label: `Show wind speed in ${s().windUnit === "ms" ? "knots" : "m/s"}`,
      group: "Display",
      hint: "Swap the wind-speed unit (m/s ⇄ kn) everywhere it is shown",
      keywords: ["wind", "unit", "knots", "kn", "m/s", "metres", "speed"],
      run: (ctx) => {
        deps.toggleWindUnit();
        ctx.close();
      },
    }),

    toggleCommand({
      id: "toggle-openseamap",
      group: "Overlays",
      label: (on) => `${on ? "Hide" : "Show"} OpenSeaMap overlay`,
      hint: "Community seamark layer",
      keywords: ["seamark", "osm", "overlay"],
      get: () => s().showOpenSeaMap,
      set: (v) => set({ showOpenSeaMap: v }),
    }),
    toggleCommand({
      id: "toggle-osm-on-land",
      group: "Overlays",
      label: (on) => `${on ? "Hide" : "Show"} OpenStreetMap on land`,
      hint: "Roads & towns on the land basemap",
      keywords: ["osm", "roads", "towns", "basemap", "land"],
      get: () => s().showOsmOnLand,
      set: (v) => set({ showOsmOnLand: v }),
    }),
    toggleCommand({
      id: "toggle-ais-risk",
      group: "Overlays",
      label: (on) => `${on ? "Hide" : "Show"} AIS collision risk`,
      hint: "CPA/TCPA colouring on AIS targets",
      keywords: ["ais", "cpa", "risk", "traffic", "collision"],
      get: () => s().showAisRisk,
      set: (v) => set({ showAisRisk: v }),
    }),
    toggleCommand({
      id: "toggle-heading-line",
      group: "Overlays",
      label: (on) => `${on ? "Hide" : "Show"} heading line`,
      hint: "Vector off the ship's own bow",
      keywords: ["heading", "hdg", "vector", "ship"],
      get: () => s().showHeadingLine,
      set: (v) => set({ showHeadingLine: v }),
    }),
    toggleCommand({
      id: "toggle-ais-ghost",
      group: "Overlays",
      label: (on) => `${on ? "Hide" : "Show"} AIS ghost targets`,
      hint: "Faded dead-reckoned position of each moving target",
      keywords: ["ais", "ghost", "dead reckon", "extrapolate", "target", "avnav"],
      get: () => s().showAisGhost,
      set: (v) => set({ showAisGhost: v }),
    }),
    toggleCommand({
      id: "toggle-debug-layers",
      group: "Overlays",
      label: (on) => `${on ? "Hide" : "Show"} debug layers`,
      hint: "Developer tile-boundary overlay",
      keywords: ["debug", "developer", "tiles"],
      get: deps.debugLayers,
      set: deps.setDebugLayers,
    }),

    // CPA ALARM loudness, distinct from the CPA line COLOUR (`toggle-ais-risk` /
    // `showAisRisk`). Mirrors the rail's Off/Show/Tell segment (Launcher.tsx).
    // Boat-wide: sets it for every screen and SignalK.
    ...(deps.setCpaMode ? cpaCommands(deps.setCpaMode) : []),

    defineCommand({
      id: "open-settings",
      label: "Open settings",
      group: "App",
      hint: "This device and the boat — charts, datasets, profiles",
      keywords: ["preferences", "config", "charts", "sidebar", "profiles", "device"],
      keybinding: { key: ",", mod: true },
      run: (ctx) => {
        deps.openSettings();
        ctx.close();
      },
    }),
    // Plain `/` is a bare-key second binding guarded like `measure`'s `m`
    // (features/measure/commands.ts) via `dispatchKey`'s `isChord` split
    // (./command.ts) — a `/` typed into a field stays a slash, not an accelerator.
    defineCommand({
      id: "open-search",
      label: "Search",
      group: "App",
      hint: "Find a town, marina or vessel by name",
      keywords: ["find", "poi", "marina", "fuel", "lookup", "place", "town", "city", "goto"],
      keybinding: [{ key: "f", mod: true }, { key: "/" }],
      run: (ctx) => {
        deps.openSearch();
        ctx.close();
      },
    }),
    defineCommand({
      id: "open-routes",
      label: "Open routes",
      group: "App",
      hint: "Open, reverse, import, export or delete saved routes",
      keywords: ["route", "routes", "list", "saved", "plan", "passage", "gpx", "import", "export", "reverse"],
      run: (ctx) => {
        deps.openRoutes();
        ctx.close();
      },
    }),
    // Open-only, not a stateful toggle: bumps App's request counter, so a
    // repeat invocation re-opens after a manual close.
    defineCommand({
      id: "open-dashboard",
      label: "Open dashboard",
      group: "App",
      hint: "The instrument board (the rail, widened)",
      keywords: ["dashboard", "board", "instruments", "widgets", "rail", "gauges"],
      run: (ctx) => {
        deps.openDashboard();
        ctx.close();
      },
    }),
    defineCommand({
      id: "open-autopilot",
      label: "Open autopilot",
      group: "App",
      hint: "Open the dashboard on the Pilot tab",
      keywords: ["autopilot", "pilot", "ap", "helm", "steer", "dashboard"],
      enabled: deps.hasAutopilot,
      run: (ctx) => {
        deps.openAutopilot();
        ctx.close();
      },
    }),
    // Both bindings are CHORDs, so they fire even with a field focused — why
    // `dispatchKey` exempts chords from the typing/palette guard.
    defineCommand({
      id: "toggle-palette",
      label: "Toggle command palette",
      group: "App",
      keybinding: [{ key: "k", mod: true }, { key: " ", mod: true }],
      palette: false,
      run: () => deps.togglePalette(),
    }),
  ];
}

// Per-feature commands (measure, route) live with their feature —
// `features/measure/commands.ts`, `features/route/commands.ts` — and are
// fanned in alongside `buildCommands` via `featureCommands`.
