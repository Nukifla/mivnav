# SPDX-License-Identifier: GPL-2.0-only
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import chartcore
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.datastructures import Headers
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Receive, Scope, Send

from mivnav.api.charts import accepts_gzip_header
from mivnav.api.charts import router as charts_router
from mivnav.api.config import router as config_router
from mivnav.api.datasets import router as datasets_router
from mivnav.api.deps import get_runtime
from mivnav.api.features import FEATURES
from mivnav.api.ingest import router as ingest_router
from mivnav.api.plugins import plugin_gate
from mivnav.api.plugins import router as plugins_router
from mivnav.api.providers import router as providers_router
from mivnav.api.search import router as search_router
from mivnav.api.signalk import router as signalk_router
from mivnav.api.storage import router as storage_router
from mivnav.api.system import router as system_router
from mivnav.collision.publisher import CollisionPublisher
from mivnav.gnss.publisher import GnssPublisher
from mivnav.features.mob.publisher import MobPublisher
from mivnav.data.scheduler import DatasetScheduler
from mivnav.shallow.publisher import ShallowPublisher
from mivnav.features.ocharts.runtime import start_ocharts_at_boot
from mivnav.features.ocharts.updates import UpdateLoop
from mivnav.features.route.watcher import NavWatcher
from mivnav.system import current_version

log = logging.getLogger(__name__)

# Our own INFO lines (pre-render progress, disk cache wipes, the licence
# check) to stderr, i.e. the journal on the Pi. Nothing else configures
# logging, and without a handler Python drops everything below WARNING
# (logging.lastResort) — the disk cache was wiped on every restart for
# days, logging why each time, and none of it was ever visible.
_pkg_log = logging.getLogger("mivnav")
if not _pkg_log.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
    _pkg_log.addHandler(_handler)
    _pkg_log.setLevel(logging.INFO)

# Routes GDAL's error output through our own logging (see
# docs/architecture/api-app-composition.md) — mostly GEOS topology noise
# from the tile mask's rect clipping, which is repaired and retried.
chartcore.install_gdal_log()


@asynccontextmanager
async def _lifespan(fastapi_app: FastAPI) -> AsyncIterator[None]:
    """Start the nav watcher, collision publisher, dataset scheduler and o-charts update loop, stop
    them on exit. See
    docs/architecture/api-app-composition.md for Runtime-ownership and
    mounted-lifespan rules."""
    override = fastapi_app.dependency_overrides.get(get_runtime)
    runtime = override() if override is not None else get_runtime()
    owns_runtime = override is None
    watcher = NavWatcher(runtime)
    watcher.start()
    fastapi_app.state.nav_watcher = watcher
    collision = CollisionPublisher(runtime)
    collision.start()
    fastapi_app.state.collision_publisher = collision
    gnss = GnssPublisher(runtime)
    gnss.start()
    fastapi_app.state.gnss_publisher = gnss
    shallow = ShallowPublisher(runtime)
    shallow.start()
    fastapi_app.state.shallow_publisher = shallow
    mob = MobPublisher(runtime)
    mob.start()
    fastapi_app.state.mob_publisher = mob
    scheduler = DatasetScheduler(runtime)
    scheduler.start()
    fastapi_app.state.dataset_scheduler = scheduler
    chart_updates = UpdateLoop(runtime)
    chart_updates.start()
    start_ocharts_at_boot(runtime)  # its licence check runs on every start
    try:
        yield
    finally:
        watcher.stop()
        collision.stop()
        gnss.stop()
        shallow.stop()
        mob.stop()
        scheduler.stop()
        chart_updates.stop()
        for feature in FEATURES:
            if feature.shutdown is not None:
                try:
                    await feature.shutdown()
                except Exception:  # noqa: BLE001 — one feature must not stop the rest
                    log.exception("shutdown of feature %s failed", feature.id)
        if owns_runtime:
            runtime.close()


app = FastAPI(title="mivnav", lifespan=_lifespan)
app.include_router(charts_router)
app.include_router(config_router)
# Every registered feature mounts all of its routers via one loop over
# FEATURES; see docs/architecture/api-app-composition.md.
for _feature in FEATURES:
    # A plugin's routes answer 404 while it is switched off (mivnav.plugins).
    _gate = plugin_gate(_feature.id)
    for _router in _feature.routers:
        app.include_router(_router, dependencies=[_gate] if _gate is not None else None)
# Unified data-layer status surface (M-DATA-1); see mivnav.api.providers.
app.include_router(providers_router)
# Installed plugins and their on/off switch (Settings → Plugins).
app.include_router(plugins_router)
# Generic declared-dataset API (M-DATA-3's follow-on) — the only way to
# declare/trigger a POI or satellite bake; see mivnav.api.datasets.
app.include_router(datasets_router)
# Whole-disk storage breakdown (datasets + everything else); see mivnav.api.storage.
app.include_router(storage_router)
# Remaining shared, non-feature ingest helper: GET /ingest/countries.
app.include_router(ingest_router)
# Shared search index (M-DATA-4 groundwork); see mivnav.search.index.
app.include_router(search_router)
# The server's own version and release updates; see mivnav.api.system.
app.include_router(system_router)
# Live boat data, mounted last: nothing on the chart path depends on it.
app.include_router(signalk_router)
# Autopilot and sailing routes (route.routes) mount via the FEATURES loop
# above like every other feature — not listed separately here.

class _GZipMiddleware(GZipMiddleware):
    """gzip, honouring ``Accept-Encoding`` q-values — the stdlib middleware
    misreads ``gzip;q=0`` as acceptance, which would double-encode an
    already-gzip chart tile. See docs/architecture/api-app-composition.md."""

    def __init__(self, app: ASGIApp, minimum_size: int = 500) -> None:
        super().__init__(app, minimum_size=minimum_size)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            ae = Headers(scope=scope).get("Accept-Encoding", "")
            if not accepts_gzip_header(ae):
                await self.app(scope, receive, send)
                return
        await super().__call__(scope, receive, send)


# Compresses text/JSON responses over the Pi->client network; the already-
# compressed .om range bodies opt out via Content-Encoding: identity (see
# docs/architecture/api-app-composition.md).
app.add_middleware(_GZipMiddleware, minimum_size=500)

# Frontend dev server (vite) origin. The vite proxy makes this mostly
# redundant, but direct access during development is convenient.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    """Liveness, plus the running version: ``deploy/update.sh`` waits for
    this to answer with the version it just installed before it trusts a
    swap (and rolls back if it never does)."""
    return {"status": "ok", "version": current_version()}


# --- The served app: the API under /api + the built SPA at / --------------
# One process serves both: the API mounted at /api, the built frontend at
# /. See docs/architecture/api-app-composition.md for the mounted-lifespan
# and dev/prod prefix-parity rationale.
_DIST = Path(__file__).resolve().parents[3] / "frontend" / "dist"


class _SPAFiles(StaticFiles):
    """Serve built assets, falling back to ``index.html`` for unknown paths
    (SPA routing); also sets ``Permissions-Policy`` for Local Network Access
    and forces `no-cache` on index.html/sw.js for PWA updates."""

    _NO_CACHE_PATHS = frozenset({"index.html", "sw.js"})

    async def get_response(self, path: str, scope: Scope):
        try:
            response = await super().get_response(path, scope)
            # StaticFiles resolves the bare mount root ("/") to "." (see
            # get_path's os.path.normpath), not "index.html" — normalize so
            # the no-cache check below still matches it.
            served_path = "index.html" if path == "." else path
        except StarletteHTTPException as exc:
            if exc.status_code != 404:
                raise
            response = await super().get_response("index.html", scope)
            served_path = "index.html"
        response.headers["Permissions-Policy"] = "local-network=(self), loopback-network=(self)"
        if served_path in self._NO_CACHE_PATHS:
            response.headers["Cache-Control"] = "no-cache"
        return response


served_app = FastAPI(title="mivnav (server)", lifespan=_lifespan)
# Also at the root, ahead of the SPA mount — otherwise the SPA's
# index.html fallback would answer `/healthz` with a 200 that isn't JSON.
served_app.add_api_route("/healthz", healthz, methods=["GET"])
served_app.mount("/api", app)
if _DIST.is_dir():
    # Only when a production build is present. A backend-only dev run (or a
    # source checkout with no `bun run build`) simply doesn't serve the SPA
    # here — vite does. Mounting a missing directory would fail at startup.
    served_app.mount("/", _SPAFiles(directory=str(_DIST), html=True), name="spa")
