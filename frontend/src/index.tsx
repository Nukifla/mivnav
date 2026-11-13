/* @refresh reload */
import { render } from "solid-js/web";
import { registerSW } from "virtual:pwa-register";
import { loadPlugins } from "./plugins";
import { disabledPlugins } from "./core/pluginSwitch";
import App from "./App";
import { prefetchCatalog } from "./core/catalog";
import { hasStored } from "./core/persist";
import { prefetchDefaultProfile } from "./core/profiles";
import { seedChartDetail } from "./core/serverConfig";
import { prefetchOsmWorldCatalog } from "./features/osm_world/catalog";
import { loadThemes } from "./core/style/themes/source";
import { describeFetchError, faultHint, setSplashFault, setSplashStatus } from "./core/splash";
import "./index.css";

// Every plugin present under <repo>/plugins (none: an empty object) but the
// ones switched off in Settings → Plugins, registered before anything reads
// settings (the default-profile prefetch below coerces them, plugin slices
// included) and before the app renders, so the POI feature, icons and Layers
// panel see what they add.
const PLUGIN_MODULES = import.meta.glob("../../plugins/*/frontend/index.ts", { eager: true });
// Bounded: an unreachable server falls back to the last list this screen saw.
const pluginsLoaded = disabledPlugins(2500).then((off) => loadPlugins(PLUGIN_MODULES, off));

// The app's JS is running: index.html's own load-failure messages stand down
// and the splash status is ours from here (core/splash.ts).
(window as { __mivnavBooted?: boolean }).__mivnavBooted = true;

// A boat plotter PWA stays OPEN for days, and vite-plugin-pwa only checks for
// a new SW on page load, so without an explicit poll it never updates. Poll
// hourly and on focus; autoUpdate then installs + reloads.
registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return;
    const checkForUpdate = () => void registration.update();
    setInterval(checkForUpdate, 60 * 60 * 1000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") checkForUpdate();
    });
  },
});

/** THE THEME BOOT GATE: both theme halves are awaited BEFORE first render, so
 * a night-palette mariner never gets a frame of day chrome. Best-effort with
 * a timeout, so a cold/unreachable backend doesn't hold the plotter on blank. */
const THEME_BOOT_TIMEOUT_MS = 3000;

function loadThemeCss(): Promise<void> {
  return new Promise((resolve) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/api/themes.css";
    link.addEventListener("load", () => resolve());
    link.addEventListener("error", () => resolve());
    document.head.appendChild(link);
  });
}

function withTimeout(p: Promise<unknown>): Promise<unknown> {
  return Promise.race([p, new Promise((resolve) => setTimeout(resolve, THEME_BOOT_TIMEOUT_MS))]);
}

// Every input of the map's style that comes from the server rides the same
// gate (same timeout) — the chart catalog, the chart-detail (SCAMIN) bias,
// the OSM basemap's baked zoom range, a fresh device's default profile — so
// the map is BUILT with its final style instead of diffing them in after
// `load`, which froze the main thread for seconds (see MapView's onMount).
// The catalog is the server probe the splash reports on: it's the one fetch
// every boot needs, and its failure says whether the server answered at all.
setSplashStatus("Connecting to server…");
const slowServer = setTimeout(() => setSplashStatus("Connecting to server…", "Still waiting for an answer."), 1500);
const catalogProbe = prefetchCatalog().then((err) => {
  clearTimeout(slowServer);
  if (err === undefined) setSplashStatus("Connected · loading settings…");
  else setSplashStatus(describeFetchError(err), faultHint(err, navigator.onLine));
});
void Promise.all([
  withTimeout(loadThemes()),
  withTimeout(loadThemeCss()),
  withTimeout(catalogProbe),
  withTimeout(seedChartDetail()),
  withTimeout(prefetchOsmWorldCatalog()),
  withTimeout(pluginsLoaded.then(() => prefetchDefaultProfile(hasStored("settings")))),
  pluginsLoaded,
]).then(() => {
  clearTimeout(slowServer);
  try {
    render(() => <App />, document.getElementById("root")!);
  } catch (e) {
    // No WebGL, a bug on some device: behind the splash this is a blank page.
    console.error(e);
    const why = e instanceof Error ? e.message : String(e);
    setSplashFault("The app failed to start", why, () => location.reload());
  }
});
