# SPDX-License-Identifier: GPL-2.0-only
"""The ship's track: the query we send, and four failures kept apart.

The claims worth proving here are about the *wire* and about *which
failure is which* (the day cache and the line-building have their own
files, test_track_store.py and test_track_geometry.py):

- we ask for own-vessel positions over the window requested;
- lines come back oldest-first as ``[lon, lat]`` (GeoJSON order — the
  one place in this backend where longitude leads), null buckets dropped;
- "this boat keeps no history" (501) is NEVER blurred into "the box is
  down" (502) or "your config is wrong" (503): a UI has to stop asking in
  the first case and keep polling in the second, and it cannot do either
  if the three arrive as one status.

The wire half runs against a real fake History API over loopback (see
tests/fake_history.py for how faithful it is, and to what); the API half
resolves through a real config store, so the URL derivation and the
credential lookup are exercised rather than stubbed past.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from mivnav.config.model import SignalKConfig
from mivnav.features.track.client import (
    MAX_HOURS,
    TrackClient,
    TrackRefused,
    TrackUnavailable,
    TrackUnreachable,
    TrackUnsupported,
)
from tests.conftest import isolated_runtime_at
from tests.fake_history import TOKEN, FakeHistory

T0 = datetime(2026, 7, 29, 6, 0, tzinfo=UTC)
T1 = datetime(2026, 7, 29, 12, 0, tzinfo=UTC)


def at(iso: str) -> float:
    return datetime.fromisoformat(iso).timestamp()


#: A right-angle turn at ~4 kn: nothing for the simplifier to drop, no gap
#: to break at.
FIXES = [
    ("2026-07-29T10:00:00.000Z", 55.0, 12.0),
    ("2026-07-29T10:01:00.000Z", 55.001, 12.0),
    ("2026-07-29T10:02:00.000Z", 55.001, 12.002),
]


@pytest.fixture
def history():
    fake = FakeHistory().start()
    fake.set_positions(FIXES)
    yield fake
    fake.stop()


def client_for(history: FakeHistory, token: str | None = TOKEN) -> TrackClient:
    return TrackClient(history.base_url, token)


@pytest.fixture
def api(tmp_path: Path):
    """``api(history, token) -> TestClient``, wired through the real config
    — so the ``history_url`` derivation and the credential lookup are part
    of what a test proves. Same shape (and the same override-restoring
    care) as test_autopilot.py's fixture."""
    from mivnav.api.app import app
    from mivnav.api.deps import get_runtime

    previous = app.dependency_overrides.get(get_runtime)
    runtimes = []

    def build(history: FakeHistory | None = None, token: str | None = None) -> TestClient:
        runtime = isolated_runtime_at(tmp_path)
        runtimes.append(runtime)
        patch: dict[str, Any] = {}
        if history is not None:
            patch["signalk"] = {"enabled": True, "host": "127.0.0.1", "port": history.port}
        if token is not None:
            patch["credentials"] = {"signalk": {"token": token}}
        if patch:
            runtime.config.patch(patch)
        app.dependency_overrides[get_runtime] = lambda: runtime
        return TestClient(app)

    yield build
    if previous is None:
        app.dependency_overrides.pop(get_runtime, None)
    else:
        app.dependency_overrides[get_runtime] = previous
    for runtime in runtimes:
        runtime.close()


# -- the URL ----------------------------------------------------------------


def test_history_url_is_the_v2_api_root_not_the_vessel_subtree():
    """The History API is boat-wide and takes the vessel as a `context`
    parameter, so it hangs off `/signalk/v2/api`, not `vessels/self` — and
    it shares the host derivation with every other v2 surface, so a UI
    cannot end up reading the track off a different box than the pilot."""
    config = SignalKConfig(host="boat.local", port=3000)
    assert config.history_url == "http://boat.local:3000/signalk/v2/api/history"
    assert config.history_url.rsplit("/", 1)[0] == config.resources_url.rsplit("/", 1)[0]
    assert SignalKConfig(host="boat.local", tls=True).history_url.startswith("https://")


# -- the query we send ------------------------------------------------------


def test_asks_for_own_vessel_positions_over_the_window(history: FakeHistory):
    client_for(history).values(T0, T1, 5)
    query = history.queries[-1]
    assert query["context"] == "vessels.self"
    assert query["paths"] == (
        "navigation.position,navigation.gnss.horizontalDilution,navigation.gnss.satellites"
    )
    assert (query["from"], query["to"]) == ("2026-07-29T06:00:00Z", "2026-07-29T12:00:00Z")
    assert query["resolution"] == "5"


def test_no_aggregate_is_named_so_the_servers_own_position_default_applies(
    history: FakeHistory,
):
    """`paths` carries no `:aggregate` suffix. signalk-server's own parser
    defaults `navigation.position` to `first` (averaging a position object
    is not meaningful) — naming it here could only ever differ from that."""
    client_for(history).values(T0, T1, 5)
    assert ":" not in history.queries[-1]["paths"]


def test_resolution_never_drops_below_a_second(history: FakeHistory):
    client_for(history).values(T0, T1, 0)
    assert int(history.queries[-1]["resolution"]) >= 1


def test_the_token_rides_along_when_there_is_one(history: FakeHistory):
    client_for(history).values(T0, T1, 5)
    assert history.authorised[-1] is True
    client_for(history, token=None).values(T0, T1, 5)
    assert history.authorised[-1] is False


# -- what comes back --------------------------------------------------------


def test_fixes_come_back_in_order(history: FakeHistory):
    points = client_for(history).values(T0, T1, 5)
    assert [(p.t, p.lat, p.lon) for p in points] == [(at(t), lat, lon) for t, lat, lon in FIXES]


def test_null_buckets_are_dropped_not_drawn(history: FakeHistory):
    """ "No data in this bucket" is the documented meaning of a null. A
    plotter that broke the line there would be reporting a GPS dropout as
    a jump ashore."""
    history.rows = [
        ["2026-07-29T10:00:00.000Z", {"latitude": 55.0, "longitude": 12.0}],
        ["2026-07-29T10:01:00.000Z", None],
        ["2026-07-29T10:02:00.000Z", {"latitude": 55.02, "longitude": 12.02}],
    ]
    points = client_for(history).values(T0, T1, 5)
    assert [p.lat for p in points] == [55.0, 55.02]


def test_a_geojson_style_pair_is_read_as_lon_lat(history: FakeHistory):
    """The spec's shape is the object; a plugin round-tripping through a
    database point type may hand back `[lon, lat]` instead, and reading it
    is two lines against a feature that would otherwise draw nothing."""
    history.rows = [["2026-07-29T10:00:00.000Z", [12.5, 55.5]]]
    points = client_for(history).values(T0, T1, 5)
    assert (points[0].lat, points[0].lon) == (55.5, 12.5)


def test_one_unparseable_row_does_not_cost_the_whole_track(history: FakeHistory):
    """`data` is filled by a third-party plugin and its own type says only
    `[Timestamp, ...unknown[]]`."""
    history.rows = [
        ["2026-07-29T10:00:00.000Z", {"latitude": 55.0, "longitude": 12.0}],
        "not a row",
        [12345, {"latitude": 55.1, "longitude": 12.1}],  # timestamp not a string
        ["2026-07-29T10:02:00.000Z", {"latitude": "north", "longitude": 12.2}],
        ["2026-07-29T10:03:00.000Z", {"latitude": 55.3, "longitude": 12.3}],
    ]
    points = client_for(history).values(T0, T1, 5)
    assert [p.lat for p in points] == [55.0, 55.3]


def test_fixes_the_receiver_calls_poor_are_dropped(history: FakeHistory):
    """Measured on the boat: inside a hall, HDOP 2.3-4.0 with ~4 satellites
    and fixes 100-300 m off; good fixes HDOP ~0.9 with ~10. Null means the
    receiver does not say — kept."""
    pos = {"latitude": 55.0, "longitude": 12.0}
    history.rows = [
        ["2026-07-29T10:00:00.000Z", pos, 0.9, 10],
        ["2026-07-29T10:00:05.000Z", pos, 3.5, 10],  # HDOP too high
        ["2026-07-29T10:00:10.000Z", pos, 0.9, 4],  # too few satellites
        ["2026-07-29T10:00:15.000Z", pos, None, None],  # not reported
        ["2026-07-29T10:00:20.000Z", pos],  # position-only row
    ]
    points = client_for(history).values(T0, T1, 5)
    kept = ["2026-07-29T10:00:00.000Z", "2026-07-29T10:00:15.000Z", "2026-07-29T10:00:20.000Z"]
    assert [p.t for p in points] == [at(t) for t in kept]


def test_a_coarse_probe_asks_for_positions_only(history: FakeHistory):
    client_for(history).values(T0, T1, 86400, quality=False)
    assert history.queries[-1]["paths"] == "navigation.position"


def test_rows_outside_the_window_are_dropped(history: FakeHistory):
    """The API's range is inclusive at both ends; ours is half-open, so a
    fix on a day boundary belongs to exactly one day."""
    history.set_positions([*FIXES, ("2026-07-29T12:00:00.000Z", 56.0, 13.0)])
    points = client_for(history).values(T0, T1, 5)
    assert len(points) == len(FIXES)


# -- the four failures, kept apart -----------------------------------------


def test_no_history_plugin_is_its_own_error(history: FakeHistory):
    history.has_provider = False
    with pytest.raises(TrackUnsupported) as e:
        client_for(history).values(T0, T1, 5)
    # The message has to name the fix; "unsupported" alone sends someone
    # looking at the network.
    assert "history plugin" in str(e.value)


def test_a_server_with_no_history_api_at_all_is_the_same_answer(history: FakeHistory):
    """A 404 means the route does not exist — a server older than 2.25.
    Permanent for this box, exactly like a missing plugin, so it is the
    same exception rather than a transport error a UI would keep retrying."""
    client = TrackClient(f"{history.base_url}/nope", TOKEN)
    with pytest.raises(TrackUnsupported):
        client.values(T0, T1, 5)


def test_signalk_disabled_is_unavailable_and_never_reaches_the_network():
    with pytest.raises(TrackUnavailable):
        TrackClient(None, TOKEN).values(T0, T1, 5)


def test_a_dead_box_is_unreachable(history: FakeHistory):
    port = history.port
    history.stop()
    client = TrackClient(f"http://127.0.0.1:{port}/signalk/v2/api/history", TOKEN)
    with pytest.raises(TrackUnreachable):
        client.values(T0, T1, 5)


def test_a_rejected_query_carries_the_servers_own_words(history: FakeHistory):
    history.fail_with = (400, {"error": "Validation errors: bad resolution"})
    with pytest.raises(TrackRefused) as e:
        client_for(history).values(T0, T1, 5)
    assert "bad resolution" in str(e.value)


def test_an_auth_rejection_is_a_config_problem_not_a_transport_one(history: FakeHistory):
    history.fail_with = (401, {"error": "Unauthorized"})
    with pytest.raises(TrackUnavailable) as e:
        client_for(history).values(T0, T1, 5)
    assert "token" in str(e.value)


# -- the HTTP surface -------------------------------------------------------


def test_get_track_returns_lines_in_geojson_order(api, history: FakeHistory):
    """`all=true` so the fixture's fixed date is inside the window whatever
    day the suite runs on."""
    body = api(history, TOKEN).get("/track?all=true").json()
    # The fixture is long past, so all of it is "older than 12 h".
    assert body["lines"] == [[[lon, lat] for _, lat, lon in FIXES]]
    assert body["recent"] == []
    assert body["count"] == len(FIXES)
    assert body["complete"] is True
    assert body["last"] == "2026-07-29T10:02:00Z"


def test_get_track_windows_ask_for_every_recorded_fix(api, history: FakeHistory):
    """The default window is inside the precise last 12 h: every row."""
    api(history, TOKEN).get("/track")
    assert history.queries
    assert all(q["resolution"] == "1" for q in history.queries)


def test_get_track_bounds_the_window_at_our_own_edge(api, history: FakeHistory):
    """Four weeks; longer is `all=true`. NOT a retention policy."""
    client = api(history, TOKEN)
    assert client.get(f"/track?hours={MAX_HOURS + 1}").status_code == 422
    assert client.get("/track?hours=0").status_code == 422


def test_get_track_says_501_when_the_boat_keeps_no_history(api, history: FakeHistory):
    """The status a UI keys "this boat has no track" off. Distinct from 502
    on purpose: one means stop asking, the other means try again."""
    history.has_provider = False
    response = api(history, TOKEN).get("/track")
    assert response.status_code == 501
    assert "history plugin" in response.json()["detail"]


def test_get_track_says_503_when_signalk_is_off(api):
    response = api().get("/track")
    assert response.status_code == 503


def test_get_track_says_502_when_the_box_is_unreachable(api, history: FakeHistory):
    client = api(history, TOKEN)
    history.stop()
    assert client.get("/track").status_code == 502


def test_the_provider_descriptor_reports_wiring_without_touching_the_box(api, history: FakeHistory):
    """`stats()` renders a status page — it must not fire an HTTP request at
    the boat's SignalK box to do it, so it reports configuration only."""
    client = api(history, TOKEN)
    before = len(history.queries)
    providers = client.get("/providers").json()["providers"]
    track = next(p for p in providers if p["id"] == "track")
    assert track["kind"] == "history-query"
    assert track["cache"] is None
    assert track["stats"]["enabled"] is True
    assert track["stats"]["token_configured"] is True
    assert track["stats"]["url"].endswith("/signalk/v2/api/history")
    # And never the token itself.
    assert TOKEN not in repr(track)
    assert len(history.queries) == before


def test_past_contexts_are_config_and_validated():
    from mivnav.features.track.config import TrackConfig

    cfg = TrackConfig(
        past_contexts=(" vessels.urn:mrn:signalk:uuid:a ", "", "vessels.urn:mrn:signalk:uuid:a")
    )
    assert cfg.past_contexts == ("vessels.urn:mrn:signalk:uuid:a",)
    with pytest.raises(ValueError):
        TrackConfig(past_contexts=("urn:mrn:signalk:uuid:a",))
    with pytest.raises(ValueError):
        TrackConfig(past_contexts=("vessels.*",))


def test_get_track_reads_past_contexts_from_config(api, history: FakeHistory):
    old = "vessels.urn:mrn:signalk:uuid:old"
    history.rows_by_context[old] = [
        ["2026-07-20T10:00:00.000Z", {"latitude": 54.0, "longitude": 11.0}],
        ["2026-07-20T10:01:00.000Z", {"latitude": 54.001, "longitude": 11.0}],
    ]
    client = api(history, TOKEN)
    client.patch("/config", json={"track": {"past_contexts": [old]}})
    body = client.get("/track?all=true").json()
    assert [11.0, 54.0] in body["lines"][0]
    assert old in {q["context"] for q in history.queries}


# -- which history provider -------------------------------------------------


def test_no_provider_is_named_unless_one_is_configured(history: FakeHistory):
    client_for(history).values(T0, T1, 5)
    assert "provider" not in history.queries[-1]
    TrackClient(history.base_url, TOKEN, provider="fake-history").values(T0, T1, 5)
    assert history.queries[-1]["provider"] == "fake-history"


def test_a_blank_provider_means_signalks_default():
    from mivnav.features.track.config import TrackConfig

    assert TrackConfig(history_provider="  ").history_provider is None
    assert TrackConfig(history_provider=" kip ").history_provider == "kip"


def test_the_providers_the_box_registered_are_listed(api, history: FakeHistory):
    history.providers = {"kip": True, "signalk-to-influxdb2": False}
    client = api(history, TOKEN)
    assert client.get("/track/providers").json() == {
        "providers": [
            {"id": "kip", "default": True},
            {"id": "signalk-to-influxdb2", "default": False},
        ],
        "selected": None,
    }
    client.patch("/config", json={"track": {"history_provider": "signalk-to-influxdb2"}})
    assert client.get("/track/providers").json()["selected"] == "signalk-to-influxdb2"


def test_the_providers_list_says_503_when_signalk_is_off(api):
    client = api()
    client.patch("/config", json={"signalk": {"enabled": False}})
    assert client.get("/track/providers").status_code == 503


def test_an_empty_default_provider_no_longer_hides_the_track(api, history: FakeHistory):
    """The boat, 2026-10-28: KIP registered as a history provider and
    became SignalK's default. It answers every range with no data, while
    signalk-to-influxdb2 still held the whole track. Naming the provider
    brings the track back, with no restart."""
    history.providers = {"kip": True, "signalk-to-influxdb2": False}
    history.rows_by_provider["signalk-to-influxdb2"] = history.rows
    history.rows = []
    client = api(history, TOKEN)
    assert client.get("/track?all=true").json()["count"] == 0

    client.patch("/config", json={"track": {"history_provider": "signalk-to-influxdb2"}})
    body = client.get("/track?all=true").json()
    assert body["count"] == len(FIXES)
    assert history.queries[-1]["provider"] == "signalk-to-influxdb2"


def test_an_unregistered_provider_is_the_servers_own_words(api, history: FakeHistory):
    client = api(history, TOKEN)
    client.patch("/config", json={"track": {"history_provider": "uninstalled"}})
    response = client.get("/track")
    assert response.status_code == 502
    assert "uninstalled" in response.json()["detail"]
