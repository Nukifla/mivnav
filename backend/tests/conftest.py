# SPDX-License-Identifier: GPL-2.0-only
"""Session fixtures: a real chart set ingested by the chartcore CLI, and
an isolated Runtime.

The chart set is generated at test time rather than committed — no
binaries in the repo, and the fixture always matches the current chartcore
output format. The cargo build is cached, so after the first compile this
is a ~1s call.
"""

import subprocess
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

REPO = Path(__file__).resolve().parents[2]


def isolate_user_dirs() -> None:
    """Every ``~/.cache`` default under a throwaway directory, for the whole
    run, before any config object exists. A test runtime that forgets to
    override one of those paths must not reach the developer's real
    caches: one that missed ``ocharts.tile_disk_dir`` once had the app's
    startup licence check rewrite (and wipe) the real chart tile cache."""
    import os
    import tempfile

    os.environ["XDG_CACHE_HOME"] = tempfile.mkdtemp(prefix="mivnav-test-cache-")
    # Same for state: the o-charts device list (.devices) defaults to
    # ``$XDG_STATE_HOME/mivnav/devices.json``, and a test registering a
    # device must not take one of the boat's five real slots.
    os.environ["XDG_STATE_HOME"] = tempfile.mkdtemp(prefix="mivnav-test-state-")


def pytest_configure(config: pytest.Config) -> None:
    isolate_user_dirs()
    # The core suite runs without whatever is in <repo>/plugins (a plugin's
    # own tests live, and run, in that plugin — `just test-plugins`).
    from mivnav import plugins

    plugins.disable()


CELL = REPO / "chartcore" / "tests" / "fixtures" / "US5OAKIQ.000"


def isolated_runtime_at(root: Path, features=None):
    """A Runtime whose every path is under ``root``.

    Both halves matter. The config/profile paths keep a test run from
    reading — and seeding, and rewriting — the developer's real
    ``~/.config/mivnav/config.json``, password included; no
    legacy-credentials reader is passed for the same reason. The *data*
    paths matter just as much: the shipped defaults point at
    ``backend/data`` and ``backend/data/ocharts``, which on a developer's
    machine hold real installed chart sets — a test on default config
    would scan their encrypted o-charts set and start the real oexserverd.

    SignalK is off for the same reason: enabled is the shipped default, so
    a test runtime on defaults would dial localhost:3000 — the developer's
    own boat server, if they are running one — the moment anything resolved
    it. Tests that want a connection turn it on and point it at their own
    fake (see test_signalk.py).
    """
    from mivnav.api.deps import Runtime
    from mivnav.config import ConfigStore, LayoutStore, ProfileStore
    from mivnav.features.route.runtime import build_route_resources
    from mivnav.features.route.store import RouteStore

    config = ConfigStore(root / "config.json")
    config.patch(
        {
            # M-DATA-3: one shared data_root replaces charts.dir/poi.dir/
            # satellite.dir/ocharts.sets_dir — every dataset-owning
            # provider's own directory (charts/poi/satellite/ocharts) is
            # `data_root/<provider>`, all still under `root`.
            "data_root": str(root / "data"),
            "ocharts": {
                "daemon_dir": str(root / "ocharts" / "daemon"),
                "work_dir": str(root / "ocharts" / "work"),
                # the default is ~/.cache/mivnav/tiles — a real path a test
                # rendering a union tile would WRITE to (see disk_tiles)
                "tile_disk_dir": str(root / "ocharts" / "tiles"),
                # ...and off: with it on, the licence check that opens it
                # asks oexserverd for the machine fingerprint, which would
                # DOWNLOAD the vendor binary into daemon_dir in every test
                # run. Disk-cache tests build their own service with a key.
                "tile_disk_budget_bytes": 0,
            },
            # Same reasoning as `data_root`: the shipped default
            # (`default_search_db_path`) is `~/.cache/mivnav/search/
            # index.sqlite3` — a real, developer-machine path a test on
            # defaults would read AND WRITE (`mivnav.api.datasets._entry`
            # queries it on every `GET /datasets` since qtvoomtq's
            # search-index size attribution), accumulating real rows across
            # unrelated test runs and (worse) real dev-session usage.
            "search": {"db_path": str(root / "search" / "index.sqlite3")},
            "signalk": {"enabled": False},
            # Same reasoning as SignalK: a fresh config SEEDS a notices
            # dataset (first_start_datasets), and the first `/notices/status`
            # request would pull the real Niord feed for it. Notice tests
            # declare their own against a MockTransport (tests/fake_niord.py).
            "datasets": [],
        }
    )
    return Runtime(
        config,
        ProfileStore(root / "profiles.json"),
        # Routes live on SignalK (#vozswkrl), so this store is wired exactly
        # as production wires it — and with SignalK off (below) that means
        # every route write REFUSES. A test that wants to save a route points
        # the config at its own fake box (tests/fake_course.py) or uses
        # `memory_route_store()`.
        RouteStore(lambda: build_route_resources(config.get())),
        LayoutStore(root / "layouts.json"),
        features=features,
    )


@pytest.fixture(scope="session", autouse=True)
def isolated_runtime(tmp_path_factory: pytest.TempPathFactory):
    """Point the whole dependency graph at a throwaway config, for every
    test — including the ones that never mention it.

    Also seeds ``mivnav.api.deps``'s own process-wide ``_runtime``
    singleton (belt-and-braces, not merely the FastAPI override above).
    ``get_runtime()`` is called directly — bypassing
    ``app.dependency_overrides`` entirely — by ``mivnav.api.app._lifespan``
    whenever a test's own override bookkeeping has (accidentally) dropped
    the ``get_runtime`` key: an unconditional
    ``app.dependency_overrides.pop(get_runtime, None)`` in a function-scoped
    fixture's teardown strands every later ``with TestClient(app) as c:``
    with no override at all, and unguarded that fallback lazily builds
    (and caches, for the rest of the process) a Runtime from the real
    ``$XDG_CONFIG_HOME`` defaults — the developer's real
    config/live SignalK connection (this recurring class of
    bug is exactly what leaked a real ``ActiveLeg`` into
    test_nav_watcher.py's spy under load: ylotntqx). Seeding ``_runtime``
    here means that fallback can never reach past this same isolated
    runtime, no matter which test's bookkeeping is wrong.
    """
    import mivnav.api.deps as deps_module
    from mivnav.api.app import app
    from mivnav.api.deps import get_runtime

    runtime = isolated_runtime_at(tmp_path_factory.mktemp("runtime"))
    app.dependency_overrides[get_runtime] = lambda: runtime
    deps_module._runtime = runtime
    yield runtime
    app.dependency_overrides.pop(get_runtime, None)
    deps_module._runtime = None
    runtime.close()


class MemoryRouteResources:
    """SignalK's route-resource store, as a dict on this side of the socket.

    Satisfies :class:`~mivnav.features.route.store.RouteResources`. It fakes
    the TRANSPORT and nothing else: what goes in and comes back out is the
    real :mod:`mivnav.features.route.wire` encoding, so a store test running
    against this still proves the round trip through the resource format —
    which is the part that can be wrong here. The wire proper (URLs, bodies,
    the bearer header) is pinned separately against a real loopback server,
    tests/fake_course.py, because at THAT seam a mock could only assert our
    own beliefs back at us.

    Set :attr:`down` to make every call raise, which is what "SignalK is not
    answering" looks like from the store's side.
    """

    def __init__(self) -> None:
        self.resources: dict[str, Any] = {}
        self.down = False

    def _reachable(self) -> None:
        if self.down:
            raise ConnectionError("the SignalK box is not answering")

    def list_route_resources(self) -> dict[str, Any]:
        self._reachable()
        return dict(self.resources)

    def put_route_resource(self, route_id: str, resource: dict[str, Any]) -> None:
        self._reachable()
        self.resources[route_id] = resource

    def delete_route_resource(self, route_id: str) -> bool:
        self._reachable()
        return self.resources.pop(route_id, None) is not None


def memory_route_store(resources: "MemoryRouteResources | None" = None):
    """``(store, resources)`` — a real ``RouteStore`` over a dict box."""
    from mivnav.features.route.store import RouteStore

    resources = resources if resources is not None else MemoryRouteResources()
    return RouteStore(lambda: resources), resources


@pytest.fixture(scope="session")
def charts_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    out_dir = tmp_path_factory.mktemp("charts")
    proc = subprocess.run(
        [
            # The ingest CLI is GDAL-backed and gated behind `s57-ingest`
            # (required-features on the bin), so building it needs the flag —
            # this is a dev-box test; the Pi wheel stays gdal-free (#GD2).
            "cargo", "run", "--release", "--quiet",
            "--features", "s57-ingest", "--bin", "chartcore", "--",
            "ingest", str(CELL), "-o", str(out_dir / "US5OAKIQ.pmtiles"),
        ],
        cwd=REPO / "chartcore",
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"chartcore ingest failed:\n{proc.stderr}")
    return out_dir


@pytest.fixture(scope="session")
def client(charts_dir: Path, tmp_path_factory: pytest.TempPathFactory, isolated_runtime):
    from mivnav.api.app import app
    from mivnav.api.charts import get_store
    from mivnav.features.ocharts.routes import get_service
    from mivnav.charts.store import ChartStore
    from mivnav.features.ocharts.service import OchartsService

    store = ChartStore(charts_dir)
    # empty o-charts service: the developer machine may have real
    # encrypted sets installed under the default dir — tests must not
    # see them (or touch the daemon)
    empty = tmp_path_factory.mktemp("ocharts-empty")
    service = OchartsService(
        sets_dir=empty / "sets",
        daemon_dir=empty / "daemon",
        work_dir=empty / "work",
        warm_overview=False,
    )
    app.dependency_overrides[get_store] = lambda: store
    app.dependency_overrides[get_service] = lambda: service
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()
