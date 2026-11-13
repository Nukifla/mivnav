# SPDX-License-Identifier: GPL-2.0-only
"""/config over HTTP.

The load-bearing test here is `test_a_config_change_is_observed_by_the_next_request`:
the singletons were memoised with @lru_cache and built once from the
environment, so a config UI that reports success and changes nothing until
a restart is the natural failure of this whole feature — and a silent one.
"""

from __future__ import annotations

import json
import logging
import shutil
import threading
import time
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mivnav.api.app import app
from mivnav.api.deps import Runtime, get_runtime
from mivnav.config import ProfileStore

from conftest import isolated_runtime_at

PASSWORD = "correct-horse-battery-staple"

NIGHT = {"colorScheme": "night", "safetyContour": 3}


@pytest.fixture()
def runtime(tmp_path: Path) -> Runtime:
    """A Runtime of this test's own — real config and profile files under
    tmp, every path isolated from the developer's real charts, and every
    derived object built from them for real."""
    return isolated_runtime_at(tmp_path)


@pytest.fixture()
def client(runtime: Runtime) -> Iterator[TestClient]:
    saved = dict(app.dependency_overrides)
    # only get_runtime: the point is that the whole graph follows from it
    app.dependency_overrides[get_runtime] = lambda: runtime
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()
    app.dependency_overrides.update(saved)
    runtime.close()


# -- the config document ---------------------------------------------------


def test_get_config_returns_the_config_and_its_meta(client: TestClient, runtime: Runtime) -> None:
    body = client.get("/config").json()
    assert body["config"]["signalk"] == {
        # False, not the shipped default: this runtime must dial nothing
        # (conftest.isolated_runtime_at). The default itself is a config
        # model fact, and test_config.py is where it belongs.
        "enabled": False,
        "host": "localhost",
        "port": 3000,
        "tls": False,
        "extra_paths": [],
    }
    assert body["config"]["version"] == 1
    assert body["meta"]["path"] == str(runtime.config.path)
    assert body["meta"]["ocharts_password_set"] is False
    assert body["meta"]["signalk_url"] == "ws://localhost:3000/signalk/v1/stream?subscribe=none"


def test_boot_id_is_stable_within_a_process_and_never_persisted(
    client: TestClient, runtime: Runtime
) -> None:
    """The client's restart-detection (frontend serverConfig.ts's `accept()`)
    relies on `meta.boot_id` staying put across requests to the SAME process
    and only ever changing when the process itself does — so it must be
    minted once in Runtime.__init__, not per-request, and never written to
    the config file (that would make it survive a restart, defeating its
    only purpose)."""
    first = client.get("/config").json()["meta"]["boot_id"]
    assert first  # non-empty
    assert client.patch("/config", json={}).json()["meta"]["boot_id"] == first
    assert client.get("/config").json()["meta"]["boot_id"] == first
    assert runtime.boot_id == first
    assert "boot_id" not in json.loads(runtime.config.path.read_text())


def test_patch_merges_persists_and_returns(client: TestClient, runtime: Runtime) -> None:
    body = client.patch("/config", json={"signalk": {"host": "sk.local"}}).json()
    assert body["config"]["signalk"]["host"] == "sk.local"
    assert body["config"]["signalk"]["port"] == 3000  # untouched
    # persisted, not merely in memory
    assert json.loads(runtime.config.path.read_text())["signalk"]["host"] == "sk.local"


def test_patch_rejects_invalid_values(client: TestClient) -> None:
    assert client.patch("/config", json={"signalk": {"port": 70000}}).status_code == 422
    assert client.patch("/config", json={"signalk": {"hsot": "typo"}}).status_code == 422
    assert client.patch("/config", json={"ocharts": {"cell_budget_bytes": -1}}).status_code == 422


def test_reload_re_reads_a_hand_edited_file(client: TestClient, runtime: Runtime) -> None:
    raw = json.loads(runtime.config.path.read_text())
    raw["signalk"]["host"] = "edited-by-hand"
    runtime.config.path.write_text(json.dumps(raw))
    assert client.get("/config").json()["config"]["signalk"]["host"] == "localhost"
    assert client.post("/config/reload").json()["config"]["signalk"]["host"] == "edited-by-hand"


def test_a_get_body_can_be_patched_straight_back(client: TestClient) -> None:
    client.patch("/config", json={"credentials": {"ocharts": {"user": "s", "password": PASSWORD}}})
    document = client.get("/config").json()["config"]
    document["signalk"]["host"] = "edited"
    body = client.patch("/config", json=document).json()
    assert body["config"]["signalk"]["host"] == "edited"
    assert body["meta"]["ocharts_password_set"] is True  # not wiped by the round trip


# -- secrets ---------------------------------------------------------------


def test_the_password_goes_in_and_never_comes_out(client: TestClient) -> None:
    client.patch(
        "/config",
        json={"credentials": {"ocharts": {"user": "sailor@example.com", "password": PASSWORD}}},
    )
    response = client.get("/config")
    # the blunt version of the check: not anywhere in the bytes, in any
    # encoding or nesting we might not have thought of
    assert PASSWORD not in response.text
    body = response.json()
    assert body["config"]["credentials"]["ocharts"]["password"] is None
    assert body["meta"]["ocharts_password_set"] is True
    # the user is not a secret — the UI must show which account is in use
    assert body["config"]["credentials"]["ocharts"]["user"] == "sailor@example.com"
    # nor anywhere else a client can reach
    assert PASSWORD not in client.get("/ocharts/status").text
    assert PASSWORD not in client.get("/openapi.json").text


def test_a_password_written_over_http_never_lands_in_the_primary_config(
    client: TestClient, runtime: Runtime
) -> None:
    """The whole point of the two-file split, asserted at the surface that
    actually writes the secret."""
    client.patch(
        "/config",
        json={"credentials": {"ocharts": {"user": "sailor", "password": PASSWORD}}},
    )
    assert PASSWORD not in runtime.config.path.read_text()
    assert "credentials" not in json.loads(runtime.config.path.read_text())
    assert PASSWORD in runtime.config.credentials_path.read_text()
    assert client.get("/config").json()["meta"]["credentials_path"] == str(
        runtime.config.credentials_path
    )


def test_the_password_never_reaches_a_log(client: TestClient, caplog) -> None:
    with caplog.at_level(logging.DEBUG):
        client.patch(
            "/config",
            json={"credentials": {"ocharts": {"user": "sailor", "password": PASSWORD}}},
        )
        client.get("/config")
        client.get("/ocharts/status")
        # and a rejected patch carrying the password must not echo it back
        # into the error text either
        response = client.patch(
            "/config",
            json={"credentials": {"ocharts": {"password": PASSWORD}}, "signalk": {"port": -5}},
        )
    assert response.status_code == 422
    assert PASSWORD not in response.text
    assert PASSWORD not in caplog.text


def test_credentials_presence_is_reported_to_the_ocharts_status(client: TestClient) -> None:
    assert client.get("/ocharts/status").json()["credentials_present"] is False
    client.patch("/config", json={"credentials": {"ocharts": {"user": "s", "password": "p"}}})
    assert client.get("/ocharts/status").json()["credentials_present"] is True
    # a user with no password is not usable credentials
    client.patch("/config", json={"credentials": {"ocharts": {"password": ""}}})
    assert client.get("/ocharts/status").json()["credentials_present"] is False


# -- the invalidation, which is the whole point ---------------------------


def test_a_config_change_is_observed_by_the_next_request(
    client: TestClient, runtime: Runtime, tmp_path: Path
) -> None:
    """A config change must take effect on the next request, with no
    restart. The old @lru_cache factories built each singleton once and
    forever; this is the regression that would make the config UI a lie.

    Asserted through the HTTP surface — what a request actually observes —
    rather than on the Derived in isolation, because the bug would live in
    the wiring, not the mechanism.
    """
    before = client.get("/ocharts/status").json()["sets_dir"]
    assert before == str(runtime.config.get().data_root / "ocharts")

    # M-DATA-3: there is no more per-provider `ocharts.sets_dir` field — the
    # one boat-wide `data_root` is what moves it (and every other provider's
    # own dir along with it).
    moved = tmp_path / "elsewhere"
    assert client.patch("/config", json={"data_root": str(moved)}).status_code == 200

    assert client.get("/ocharts/status").json()["sets_dir"] == str(moved / "ocharts")


def test_the_charts_dir_change_is_observed_by_the_catalog(
    client: TestClient, charts_dir: Path, tmp_path: Path
) -> None:
    """The same property for the PMTiles store: it holds open mmaps and
    was the other @lru_cache singleton. M-DATA-3: `charts.dir` is gone —
    the chart-set directory is now `data_root/charts`
    (mivnav.config.base.provider_root), so `data_root` is what moves it."""
    empty = tmp_path / "empty"
    empty.mkdir()
    client.patch("/config", json={"data_root": str(empty)})
    assert client.get("/catalog").json()["sets"] == []

    # `charts_dir` (the session fixture) is a flat dir of `<id>.pmtiles`
    # files, not itself named `charts` — copy its one archive into a fresh
    # `<root>/charts/` so `data_root=<root>` addresses it.
    with_charts = tmp_path / "with_charts"
    charts_subdir = with_charts / "charts"
    charts_subdir.mkdir(parents=True)
    for f in charts_dir.glob("*.pmtiles"):
        shutil.copy(f, charts_subdir / f.name)
    client.patch("/config", json={"data_root": str(with_charts)})
    assert [s["id"] for s in client.get("/catalog").json()["sets"]] == ["US5OAKIQ"]

    client.patch("/config", json={"data_root": str(empty)})
    assert client.get("/catalog").json()["sets"] == []


def test_an_unrelated_change_does_not_rebuild_the_chart_service(
    client: TestClient, runtime: Runtime
) -> None:
    """The converse, and the reason Derived keys on a config *slice*
    rather than a generation counter: rebuilding the o-charts service
    stops its daemon and throws away its decoded-cell cache (up to half a
    gigabyte). Changing the SignalK host, or the shop password, must not
    do that."""
    service = runtime.feature("ocharts").service()

    client.patch("/config", json={"signalk": {"host": "sk.local", "port": 3001}})
    assert runtime.feature("ocharts").service() is service

    client.patch("/config", json={"credentials": {"ocharts": {"user": "s", "password": "p"}}})
    assert runtime.feature("ocharts").service() is service

    client.patch("/config", json={"charts": {"dir": "/tmp/elsewhere"}})
    assert runtime.feature("ocharts").service() is service

    # ...but its own slice does
    client.patch("/config", json={"ocharts": {"cell_budget_bytes": 1024}})
    assert runtime.feature("ocharts").service() is not service
    assert runtime.feature("ocharts").service().cells.budget == 1024


def test_prefetch_is_a_live_config_knob(client: TestClient, runtime: Runtime) -> None:
    """Turning the prefetch (overview-warming) knob off must actually stop the
    warming thread, not just
    change a number in a file. It is a behavioural tunable of the o-charts
    service, so it lives in the slice the service is built from — which is
    what makes the rebuild carry it, and what makes forgetting to invalidate
    unreachable (see mivnav.config.derived)."""
    assert runtime.config.get().ocharts.prefetch is True
    warming = runtime.feature("ocharts").service()
    assert warming.status()["warm"]["state"] != "disabled"

    client.patch("/config", json={"ocharts": {"prefetch": False}})

    rebuilt = runtime.feature("ocharts").service()  # lazily, on next use — like every ocharts change
    assert rebuilt is not warming
    assert rebuilt.status()["warm"] == {"state": "disabled"}
    # and the superseded one's thread is really gone, not merely unreferenced
    assert warming.status()["warm"]["state"] == "stopped"


def test_chart_detail_serving_knobs_are_live(
    client: TestClient, runtime: Runtime
) -> None:
    """The reference-scale serving knobs are behavioural tunables of the
    o-charts service, so they live in its config slice: PATCHing one rebuilds
    the service carrying the new value, no restart."""
    service = runtime.feature("ocharts").service()
    assert service.over_zoom == 8
    assert service.under_zoom == 2
    assert service.detail_gap == 1
    assert service.max_cells_per_tile == 128
    assert service.chart_detail == 1.25

    client.patch(
        "/config",
        json={
            "ocharts": {
                "over_zoom": 6,
                "detail_gap": 2,
                "max_cells_per_tile": 64,
                "chart_detail": 2.0,
            }
        },
    )

    rebuilt = runtime.feature("ocharts").service()  # lazily, on next use
    assert rebuilt is not service
    assert rebuilt.over_zoom == 6
    assert rebuilt.detail_gap == 2
    assert rebuilt.max_cells_per_tile == 64
    assert rebuilt.chart_detail == 2.0


def test_a_superseded_service_is_closed_not_orphaned(
    client: TestClient, runtime: Runtime
) -> None:
    """A rebuilt service must be shut down: it owns an oexserverd
    subprocess, and dropping the reference without stopping it leaves the
    process orphaned (holding its FIFOs) until someone reaps it by hand."""
    service = runtime.feature("ocharts").service()
    closed = []
    service.close = lambda: closed.append(True)  # type: ignore[method-assign]

    client.patch("/config", json={"ocharts": {"tile_budget_bytes": 4096}})
    runtime.feature("ocharts").service()  # the rebuild happens on next use

    assert closed == [True]


def test_the_installer_never_holds_a_superseded_service(
    client: TestClient, runtime: Runtime
) -> None:
    installer = runtime.feature("ocharts").installer()
    assert installer.service is runtime.feature("ocharts").service()

    client.patch("/config", json={"ocharts": {"cell_budget_bytes": 2048}})

    assert runtime.feature("ocharts").installer() is not installer
    assert runtime.feature("ocharts").installer().service is runtime.feature("ocharts").service()


def test_a_patch_racing_the_first_installer_build_does_not_deadlock(
    runtime: Runtime,
) -> None:
    """Lock-order regression. A patch runs its guard while holding the
    config store's lock and needs the installer lock; building an
    installer needs a service, which needs the config store. Acquire those
    in the wrong order and a PATCH landing on the same tick as the first
    install-status poll hangs both threads forever — a lost worker thread
    each time, and no error to show for it.
    """
    real_guard = runtime._guard
    in_guard = threading.Event()

    def slow_guard(current, candidate):
        # hold the config store's lock, then reach for the installer's —
        # widening the window that exists whenever a patch touches the
        # o-charts slice
        in_guard.set()
        time.sleep(0.5)
        real_guard(current, candidate)

    runtime._guard = slow_guard  # type: ignore[method-assign]

    errors: list[BaseException] = []

    def run(fn):
        try:
            fn()
        except BaseException as e:  # noqa: BLE001
            errors.append(e)

    # daemon: on a regression these threads are deadlocked and unjoinable,
    # and the test must fail rather than hang the whole run at exit
    patch = threading.Thread(
        target=run,
        args=(lambda: runtime.patch_config({"ocharts": {"cell_budget_bytes": 4096}}),),
        daemon=True,
    )
    patch.start()
    assert in_guard.wait(5), "the guard never ran"
    # now, with the config store's lock held, build an installer: it needs
    # the config to resolve its service. If that happened under the
    # installer lock, the two orders would invert and both threads hang.
    build = threading.Thread(
        target=run, args=(runtime.feature("ocharts").installer,), daemon=True
    )
    build.start()

    patch.join(timeout=10)
    build.join(timeout=10)
    assert not patch.is_alive(), "deadlock: the config patch never finished"
    assert not build.is_alive(), "deadlock: the installer build never finished"
    assert errors == []
    assert runtime.config.get().ocharts.cell_budget_bytes == 4096


def test_chart_config_cannot_change_under_a_running_install(
    client: TestClient, runtime: Runtime
) -> None:
    """Refused, rather than applied and left to strand the install: the
    install's background thread holds the service, and its status lives on
    the installer, so a rebuild of either would lose it."""
    runtime.feature("ocharts").installer()._status.state = "download"
    runtime.feature("ocharts").installer().busy = lambda: True  # type: ignore[method-assign]

    response = client.patch("/config", json={"ocharts": {"cell_budget_bytes": 4096}})
    assert response.status_code == 409
    assert "install" in response.json()["detail"]
    # nothing was written
    assert runtime.config.get().ocharts.cell_budget_bytes != 4096
    assert json.loads(runtime.config.path.read_text())["ocharts"]["cell_budget_bytes"] != 4096

    # a change to an unrelated slice is still allowed
    assert client.patch("/config", json={"signalk": {"host": "sk"}}).status_code == 200


# -- profiles --------------------------------------------------------------


def test_profile_crud_over_http(client: TestClient) -> None:
    assert client.get("/config/profiles").json() == {"profiles": [], "default": None}
    assert client.get("/config/profiles/Night").status_code == 404
    assert client.delete("/config/profiles/Night").status_code == 404

    saved = client.put("/config/profiles/Night", json=NIGHT).json()
    assert saved["name"] == "Night"
    assert saved["settings"] == NIGHT

    assert client.get("/config/profiles/Night").json()["settings"] == NIGHT
    assert client.get("/config/profiles").json()["profiles"][0]["name"] == "Night"

    # saving again replaces
    client.put("/config/profiles/Night", json={"colorScheme": "dusk"})
    assert client.get("/config/profiles/Night").json()["settings"] == {"colorScheme": "dusk"}

    assert client.delete("/config/profiles/Night").status_code == 204
    assert client.get("/config/profiles").json() == {"profiles": [], "default": None}


def test_default_profile_over_http(client: TestClient) -> None:
    # unknown profile cannot be anointed
    assert client.put("/config/profiles/Night/default").status_code == 404

    client.put("/config/profiles/Night", json=NIGHT)
    client.put("/config/profiles/Day", json={"colorScheme": "day"})

    assert client.put("/config/profiles/Night/default").json() == {"default": "Night"}
    assert client.get("/config/profiles").json()["default"] == "Night"

    # replacing the default just points it elsewhere
    client.put("/config/profiles/Day/default")
    assert client.get("/config/profiles").json()["default"] == "Day"

    # clearing is idempotent and scoped: clearing a non-default is a no-op
    assert client.delete("/config/profiles/Night/default").status_code == 204
    assert client.get("/config/profiles").json()["default"] == "Day"
    assert client.delete("/config/profiles/Day/default").status_code == 204
    assert client.get("/config/profiles").json()["default"] is None


def test_deleting_the_default_profile_clears_it_over_http(client: TestClient) -> None:
    client.put("/config/profiles/Night", json=NIGHT)
    client.put("/config/profiles/Night/default")
    assert client.delete("/config/profiles/Night").status_code == 204
    assert client.get("/config/profiles").json()["default"] is None


def test_a_profile_named_default_is_addressable(client: TestClient) -> None:
    # the default pointer lives at /{name}/default, so a profile literally
    # named "default" does not collide with it
    assert client.put("/config/profiles/default", json=NIGHT).json()["name"] == "default"
    assert client.get("/config/profiles/default").json()["settings"] == NIGHT
    assert client.put("/config/profiles/default/default").json() == {"default": "default"}
    assert client.get("/config/profiles").json()["default"] == "default"


def test_profiles_persist_across_a_restart(client: TestClient, runtime: Runtime) -> None:
    client.put("/config/profiles/Night", json=NIGHT)
    assert ProfileStore(runtime.profiles.path).get("Night")["settings"] == NIGHT


def test_profile_names_may_be_prose(client: TestClient) -> None:
    name = "Nattsegling, Skagerrak (2026)"
    assert client.put(f"/config/profiles/{name}", json=NIGHT).json()["name"] == name
    assert client.get(f"/config/profiles/{name}").json()["settings"] == NIGHT


def test_a_name_with_a_slash_is_refused_rather_than_unaddressable(client: TestClient) -> None:
    # a slash in a URL path segment is a route boundary, not an escapable
    # character; the store refuses the name so the API cannot promise a
    # round trip it could not deliver
    assert client.put("/config/profiles/a/b", json=NIGHT).status_code == 404


def test_bad_profiles_are_rejected(client: TestClient) -> None:
    assert client.put("/config/profiles/Night", json=["not", "an", "object"]).status_code == 422
    assert client.put("/config/profiles/   ", json=NIGHT).status_code == 422
    assert client.put("/config/profiles/Night", json={"x": "y" * 70_000}).status_code == 422


def test_profiles_and_config_are_separate_files(client: TestClient, runtime: Runtime) -> None:
    """A botched profile save must not be able to take the o-charts
    credentials with it."""
    client.patch("/config", json={"credentials": {"ocharts": {"user": "s", "password": PASSWORD}}})
    client.put("/config/profiles/Night", json=NIGHT)
    assert runtime.profiles.path != runtime.config.path
    assert PASSWORD not in runtime.profiles.path.read_text()


# -- layouts -----------------------------------------------------------------
# Profiles' twin (mivnav.config.profiles.NamedBlobStore, "layout" kind): same
# CRUD verbs, no `/default` (a new device just starts from `DEFAULT_CHROME`
# locally). The blob is a `{enabled, bands, dashboard}` arrangement on the
# real frontend, but the backend never looks inside it — a plain dict here
# proves that as directly as NIGHT does for a profile's ChartSettings.

ARRANGEMENT = {"enabled": {}, "bands": {"rail": {"order": ["nav.sog"]}, "top": {"order": []}}}


def test_layout_crud_over_http(client: TestClient) -> None:
    assert client.get("/config/layouts").json() == {"layouts": []}
    assert client.get("/config/layouts/Passage").status_code == 404
    assert client.delete("/config/layouts/Passage").status_code == 404

    saved = client.put("/config/layouts/Passage", json=ARRANGEMENT).json()
    assert saved["name"] == "Passage"
    assert saved["arrangement"] == ARRANGEMENT

    assert client.get("/config/layouts/Passage").json()["arrangement"] == ARRANGEMENT
    assert client.get("/config/layouts").json()["layouts"][0]["name"] == "Passage"

    # saving again replaces
    client.put("/config/layouts/Passage", json={"enabled": {"nav.sog": False}})
    assert client.get("/config/layouts/Passage").json()["arrangement"] == {"enabled": {"nav.sog": False}}

    assert client.delete("/config/layouts/Passage").status_code == 204
    assert client.get("/config/layouts").json() == {"layouts": []}


def test_layouts_have_no_default_route(client: TestClient) -> None:
    # unlike a profile, a layout has no boat-wide default to anoint/clear —
    # the sub-resource simply does not exist
    client.put("/config/layouts/Passage", json=ARRANGEMENT)
    assert client.put("/config/layouts/Passage/default").status_code == 404
    assert client.delete("/config/layouts/Passage/default").status_code == 404


def test_bad_layouts_are_rejected(client: TestClient) -> None:
    assert client.put("/config/layouts/Passage", json=["not", "an", "object"]).status_code == 422
    assert client.put("/config/layouts/   ", json=ARRANGEMENT).status_code == 422
    assert client.put("/config/layouts/Passage", json={"x": "y" * 70_000}).status_code == 422


def test_a_layout_name_with_a_slash_is_refused(client: TestClient) -> None:
    assert client.put("/config/layouts/a/b", json=ARRANGEMENT).status_code == 404


def test_layouts_persist_across_a_restart(client: TestClient, runtime: Runtime) -> None:
    from mivnav.config import LayoutStore

    client.put("/config/layouts/Passage", json=ARRANGEMENT)
    assert LayoutStore(runtime.layouts.path).get("Passage")["arrangement"] == ARRANGEMENT


def test_layouts_and_profiles_are_separate_files(client: TestClient, runtime: Runtime) -> None:
    """A layout is not a profile — different store, different file, so an
    entry named the same in both never collides."""
    client.put("/config/profiles/Passage", json=NIGHT)
    client.put("/config/layouts/Passage", json=ARRANGEMENT)
    assert runtime.layouts.path != runtime.profiles.path
    assert client.get("/config/profiles/Passage").json()["settings"] == NIGHT
    assert client.get("/config/layouts/Passage").json()["arrangement"] == ARRANGEMENT


def test_config_meta_reports_the_layouts_path(client: TestClient, runtime: Runtime) -> None:
    assert client.get("/config").json()["meta"]["layouts_path"] == str(runtime.layouts.path)
