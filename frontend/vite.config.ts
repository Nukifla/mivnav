import { defineConfig, type ProxyOptions } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// The config runs under node/bun, but the project tsconfig is DOM-only and
// pulling in @types/node for one env read is not worth it.
declare const process: { env: Record<string, string | undefined> };

/** Extra hostnames the dev/preview server answers to beyond localhost and
 * bare IPs, e.g. MIVNAV_ALLOWED_HOSTS=.example.org,nav.local when opening the
 * dev server from another device by name. Comma-separated; a leading dot
 * allows every subdomain. */
const allowedHosts = (process.env.MIVNAV_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

/** A backend vite can't connect to is answered 502 Bad Gateway — what a real
 * reverse proxy says — instead of vite's default 500, which the boot splash
 * (core/splash.ts `describeFetchError`) would read as the server itself
 * failing rather than not running. Runs before vite's own error handler,
 * which then sees the response already sent and leaves it alone. */
const badGatewayOnRefused: NonNullable<ProxyOptions["configure"]> = (proxy) =>
  proxy.on("error", (_err, _req, res) => {
    // `res` is a raw socket for a WebSocket upgrade: nothing to answer.
    if (!("writeHead" in res) || res.headersSent || res.writableEnded) return;
    res.writeHead(502, { "content-type": "text/plain" }).end("backend unreachable");
  });

export default defineConfig({
  plugins: [
    solid(),
    tailwindcss(),
    // ── PWA: installable app shell, SAFE offline policy ──────────────────
    // This is a navigation app. Serving a STALE chart, position or AIS
    // target is a safety hazard, so the service worker NEVER caches dynamic
    // data. It precaches only the built static shell (JS/CSS/HTML/icons) for
    // installability and offline load of the UI itself; everything on the
    // wire (/api/*, tiles, glyphs) is fetched fresh from the network.
    //
    // All URLs are RELATIVE (start_url/scope "/"): HTTPS and the public host
    // live in an external reverse proxy, so the manifest and
    // SW must work behind it regardless of the origin they are served from.
    VitePWA({
      registerType: "autoUpdate",
      // Keep `just dev` fast and predictable: no SW in the dev server.
      // (Tried enabling it: vite-plugin-pwa's dev-mode SW is served through
      // Vite's own dev pipeline, which auto-injects its HMR client into the
      // SW's module graph — and that client touches `document`/`window`,
      // neither of which exist in a ServiceWorkerGlobalScope, so the worker
      // throws during evaluation and registration fails outright. Not worth
      // fighting; dev mode gets its own small fallback cache instead — see
      // chartProtocol.ts's `registerChartProtocol`.)
      devOptions: { enabled: false },
      // injectManifest (not generateSW, the previous default): tiles need a
      // HAND-WRITTEN fetch handler (src/sw.ts) so MapLibre's own tile worker
      // can fetch them directly — see sw.ts's header comment for why.
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      includeAssets: ["favicon-32x32.png", "apple-touch-icon.png", "icon.svg"],
      manifest: {
        name: "mivnav",
        short_name: "mivnav",
        description: "Chart plotter for sailing boats.",
        start_url: "/",
        scope: "/",
        // Immersive by default: an installed PWA gets a truly full-screen,
        // chrome-less surface (`fullscreen`), falling back to `standalone`
        // where the platform won't grant it. `display_override` is consulted
        // first (in order) by browsers that support it; `display` is the
        // legacy single-value fallback. iOS Safari ignores `fullscreen`
        // entirely — it caps at standalone — so on iOS immersion still comes
        // from the black-translucent status bar + edge-to-edge work below, not
        // from this. NOTE: a `display` change only lands after the PWA is
        // RE-INSTALLED; the service worker won't hot-swap the manifest.
        display: "fullscreen",
        display_override: ["fullscreen", "standalone"],
        // No `orientation` key ON PURPOSE. `orientation: "any"` is the one value
        // that tells the PWA to follow the sensor and OVERRIDE the OS auto-rotate
        // lock — so the installed app rotated even with Android auto-rotate OFF.
        // Omitting the member entirely makes the PWA respect the system setting
        // (rotates when auto-rotate is on, stays fixed when off). Do NOT re-add
        // "any" to "allow rotation" — rotation already works via the OS toggle.
        // (Like `display`, an orientation change only lands after the PWA is
        // RE-INSTALLED; the SW won't hot-swap the manifest.)
        // theme_color: EXPLICITLY undefined — REVERSES the prior "black is
        // least-bad" decision (that premise was wrong, see below). Plain
        // omission (leaving the key out of this object) would NOT do it:
        // vite-plugin-pwa does `Object.assign({}, defaultManifest,
        // options.manifest)`, and its default has `theme_color: "#42b883"`
        // (a green) — that default is what the "black" fallback was chosen
        // to beat, on the mistaken premise that the plugin always forces
        // *some* value. It doesn't: an explicit `undefined` is a real
        // own-property, so Object.assign overwrites the default with it, and
        // `JSON.stringify` (which the plugin uses verbatim to emit
        // manifest.webmanifest — verified in dist/) drops the key entirely.
        // With NO theme_color, Android/Chrome draws behind the status bar
        // instead of painting it as an opaque fill — any explicit value
        // (including black) is honoured as a literal slab colour whenever
        // Android falls back from `fullscreen` to `standalone`, which is the
        // solid-black bug this fixes. Same principle index.html already
        // uses for its (deliberately absent) theme-color meta tag.
        // NEEDS A LIVE ANDROID DEVICE to confirm, and needs the PWA
        // UNINSTALLED + REINSTALLED to pick up the manifest change (SW won't
        // hot-swap it, same as `display` above). If the bar instead comes
        // back an opaque white/light default (Android substituting its own
        // default rather than honouring "none" as transparent), revert to
        // `theme_color: "#000000"` — that would mean absence isn't honoured
        // as transparent on that Chrome/Android version, and black was
        // genuinely the better compromise. This also affects desktop
        // installed-PWA window chrome (titlebar goes from black to browser
        // default); iOS is untouched (it uses
        // apple-mobile-web-app-status-bar-style, not this). Triggers the
        // plugin's own build warning ("theme_color is missing... will not be
        // able to be installed") — over-cautious; theme_color isn't part of
        // Chrome's actual install criteria (name/icons/start_url/display
        // are), so the warning is safe to ignore.
        theme_color: undefined,
        background_color: "#ffffff",
        icons: [
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          {
            src: "pwa-maskable-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      // `injectManifest` (unlike `generateSW`) has its OWN top-level option
      // for the precache manifest — `workbox.globPatterns` is a generateSW-only
      // option and is ignored here. Precache ONLY the built shell: charts/
      // tiles/API are not build outputs and are deliberately absent, so they
      // can never be served from the precache; the weather feature's ~2 MB
      // WASM decoder is a build output but is NOT shell either (it is a
      // lazy, feature-gated asset, not something a first paint needs), so
      // it stays out too rather than raising the precache size cap for it.
      // The resulting list seeds `self.__WB_MANIFEST`, consumed by
      // `precacheAndRoute` in src/sw.ts — routing itself lives there, not
      // here; see that file for the tile fetch handler and why.
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
        // Default cap is 2 MiB, and the main JS bundle sits just under it
        // (~1.97 MiB) with no headroom at all — one dependency away from
        // silently dropping the whole app out of the precache.
        //
        // The atlas this was originally raised for is gone: the pre-baked
        // combinatorial ATON sprite sheet (jt tasks skrqzlsx..ktqovmxp) that
        // pushed sprites/s52@2x.png to ~2.46 MiB, along with its 7231
        // per-key `.svg` files (all of them swept in by the `**/*.svg` glob
        // above), is served on demand now (qkmvmwps) — so this only has to
        // clear the JS bundle, and dusk/night palettes will not grow it
        // again. Kept raised anyway, for the bundle's sake rather than the
        // atlas's: a cap the app currently clears by 1.5% is not a cap.
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
    }),
  ],
  // The Open-Meteo weather layer (weather/overlays.ts) ships an Emscripten
  // `.om` reader that locates its WASM at runtime with
  // `fetch(new URL("om_reader_wasm.web.wasm", import.meta.url))`. esbuild's dep
  // pre-bundling rewrites `import.meta.url` to point inside `.vite/deps/`, where
  // the `.wasm` was never copied — so the fetch falls through to the SPA
  // `index.html` and streaming-compile dies on MIME `text/html`. Excluding the
  // three @openmeteo packages keeps them as real ESM served from node_modules,
  // where `import.meta.url` resolves to the actual `.wasm` (vite serves it as
  // `application/wasm`). The production rollup build handles the same
  // `new URL(..., import.meta.url)` natively and emits the wasm as an asset.
  optimizeDeps: {
    exclude: [
      "@openmeteo/weather-map-layer",
      "@openmeteo/file-reader",
      "@openmeteo/file-format-wasm",
    ],
  },
  server: {
    // Listen on all interfaces so other devices on the network can reach it.
    host: true,
    allowedHosts,
    // Plugins live beside the frontend, in <repo>/plugins (src/plugins.ts).
    fs: { allow: [".", "../plugins"] },
    proxy: {
      // Backend (uv run fastapi dev) listens on 8000 by default;
      // MIVNAV_API points a scratch frontend at a scratch backend (e2e).
      //
      // The prefix is forwarded UNCHANGED: the backend mounts its API under
      // /api (mivnav.api.app), so /api is identical in dev and prod. In
      // production the same backend also serves the built SPA, and there is no
      // proxy in front of it — so nothing strips /api there, and nothing may
      // strip it here either, or the two would disagree.
      "/api": {
        target: process.env.MIVNAV_API ?? "http://localhost:8000",
        changeOrigin: true,
        configure: badGatewayOnRefused,
        // /api/signalk/stream is a WebSocket: the backend proxies the
        // boat's one SignalK connection to every device over it, and
        // without this the upgrade is answered by vite instead.
        ws: true,
      },
    },
  },
  // `vite preview` (a built `dist/`, service worker included — `devOptions`
  // disables the SW under plain `vite dev`) needs the SAME /api proxy as
  // `server` above, or every API/tile call 404s from vite's own static
  // server instead of reaching the backend. Previously unneeded: nothing
  // depended on `bun run preview` actually working end-to-end until the
  // tile fetch moved into a Service Worker (src/sw.ts), which can only be
  // exercised against a real build.
  preview: {
    host: true,
    allowedHosts,
    proxy: {
      "/api": {
        target: process.env.MIVNAV_API ?? "http://localhost:8000",
        changeOrigin: true,
        configure: badGatewayOnRefused,
        ws: true,
      },
    },
  },
});
