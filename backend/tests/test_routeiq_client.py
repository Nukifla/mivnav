# SPDX-License-Identifier: GPL-2.0-only
"""``mivnav.features.routing.routeiq.RouteIQClient`` — the remote call
itself, against a real fake HTTP server (:mod:`tests.fake_routeiq`), same
"real HTTP, not a mock at the client's seam" posture as
``test_signalk_access.py``.

The claims worth proving: the request carries the right shape (draft/
beam/airDraft/minCoastDistance, a bearer token) and endpoint path; a
200 with real geometry maps to a `RouteIQRoute` with the right waypoints/
distance/all-clear approximate_legs; multi-feature responses concatenate
and de-duplicate a shared seam point; `ROUTE_NOT_FOUND` (422) raises
`RouteIQNotFound`, not a crash; no token/no base URL is `RouteIQUnavailable`
(a config fact); a dead server, a 401, and a 503 are all `RouteIQUnreachable`.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest

from mivnav.features.routing.routeiq import (
    RouteIQClient,
    RouteIQNotFound,
    RouteIQUnavailable,
    RouteIQUnreachable,
)
from tests.fake_routeiq import FakeRouteIQ


@pytest.fixture
def fake() -> Iterator[FakeRouteIQ]:
    server = FakeRouteIQ().start()
    yield server
    server.stop()


def _client(fake: FakeRouteIQ, token: str = "tok") -> RouteIQClient:
    return RouteIQClient(f"http://127.0.0.1:{fake.port}", token)


def test_sends_the_documented_request_shape(fake: FakeRouteIQ) -> None:
    fake.respond_ok([(10.0, 56.0), (10.1, 56.1)])
    client = _client(fake, token="secret-token")
    client.plan_route(
        56.0, 10.0, 56.1, 10.1,
        draft_m=2.0, beam_m=3.5, air_draft_m=18.0, min_coast_distance_nm=0.5,
    )
    assert fake.requests[-1] == {
        "start": {"latitude": 56.0, "longitude": 10.0},
        "end": {"latitude": 56.1, "longitude": 10.1},
        "draft": 2.0,
        "beam": 3.5,
        "airDraft": 18.0,
        "minCoastDistance": 0.5,
    }
    assert fake.headers[-1]["Authorization"] == "Bearer secret-token"


def test_a_real_route_maps_waypoints_distance_and_clean_legs(fake: FakeRouteIQ) -> None:
    fake.respond_ok([(10.0, 56.0), (10.05, 56.05), (10.1, 56.1)], total_distance_m=5000.0)
    route = _client(fake).plan_route(
        56.0, 10.0, 56.1, 10.1, draft_m=2.0, beam_m=3.5, air_draft_m=18.0, min_coast_distance_nm=0.5
    )
    assert route.waypoints == [(10.0, 56.0), (10.05, 56.05), (10.1, 56.1)]
    assert route.distance_m == 5000.0
    assert route.approximate_legs == [False, False]  # never partial, unlike chartcore


def test_warnings_are_passed_through(fake: FakeRouteIQ) -> None:
    fake.respond_ok(
        [(10.0, 56.0), (10.1, 56.1)],
        warnings=[{"type": "bridge", "message": "low bridge ahead, check air draft"}],
    )
    route = _client(fake).plan_route(
        56.0, 10.0, 56.1, 10.1, draft_m=2.0, beam_m=3.5, air_draft_m=18.0, min_coast_distance_nm=0.5
    )
    assert route.warnings == ["low bridge ahead, check air draft"]


def test_multiple_linestring_features_concatenate_deduping_the_shared_seam(
    fake: FakeRouteIQ,
) -> None:
    fake._status = 200
    fake._body = {
        "type": "FeatureCollection",
        "totalDistance": 2000.0,
        "features": [
            {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[10.0, 56.0], [10.05, 56.0]]}},
            # Shares its first point with the previous feature's last —
            # must appear once, not twice, in the stitched result.
            {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[10.05, 56.0], [10.1, 56.0]]}},
        ],
    }
    route = _client(fake).plan_route(
        56.0, 10.0, 56.0, 10.1, draft_m=2.0, beam_m=3.5, air_draft_m=18.0, min_coast_distance_nm=0.5
    )
    assert route.waypoints == [(10.0, 56.0), (10.05, 56.0), (10.1, 56.0)]


def test_route_not_found_is_its_own_exception_not_a_crash(fake: FakeRouteIQ) -> None:
    fake.respond_not_found()
    with pytest.raises(RouteIQNotFound):
        _client(fake).plan_route(
            0.0, 0.0, 1.0, 1.0, draft_m=2.0, beam_m=3.5, air_draft_m=18.0, min_coast_distance_nm=0.5
        )


def test_a_422_that_is_not_route_not_found_is_unreachable(fake: FakeRouteIQ) -> None:
    fake.respond_status(422, {"code": "BAD_REQUEST", "message": "invalid draft"})
    with pytest.raises(RouteIQUnreachable):
        _client(fake).plan_route(
            0.0, 0.0, 1.0, 1.0, draft_m=2.0, beam_m=3.5, air_draft_m=18.0, min_coast_distance_nm=0.5
        )


def test_a_401_is_unreachable_with_a_reauthorize_hint(fake: FakeRouteIQ) -> None:
    fake.respond_status(401, {"message": "unauthorized"})
    with pytest.raises(RouteIQUnreachable, match="access token"):
        _client(fake).plan_route(
            0.0, 0.0, 1.0, 1.0, draft_m=2.0, beam_m=3.5, air_draft_m=18.0, min_coast_distance_nm=0.5
        )


def test_a_503_is_unreachable_not_a_crash(fake: FakeRouteIQ) -> None:
    fake.respond_status(503, {"message": "still initializing"})
    with pytest.raises(RouteIQUnreachable):
        _client(fake).plan_route(
            0.0, 0.0, 1.0, 1.0, draft_m=2.0, beam_m=3.5, air_draft_m=18.0, min_coast_distance_nm=0.5
        )


def test_no_base_url_is_unavailable_not_unreachable() -> None:
    with pytest.raises(RouteIQUnavailable):
        RouteIQClient(None, "tok").plan_route(
            0.0, 0.0, 1.0, 1.0, draft_m=2.0, beam_m=3.5, air_draft_m=18.0, min_coast_distance_nm=0.5
        )


def test_no_token_is_unavailable_not_unreachable(fake: FakeRouteIQ) -> None:
    with pytest.raises(RouteIQUnavailable):
        RouteIQClient(f"http://127.0.0.1:{fake.port}", "").plan_route(
            0.0, 0.0, 1.0, 1.0, draft_m=2.0, beam_m=3.5, air_draft_m=18.0, min_coast_distance_nm=0.5
        )


def test_a_dead_server_fails_fast_as_unreachable(fake: FakeRouteIQ) -> None:
    base = f"http://127.0.0.1:{fake.port}"
    fake.stop()
    client = RouteIQClient(base, "tok", timeout=1.0)
    with pytest.raises(RouteIQUnreachable):
        client.plan_route(
            0.0, 0.0, 1.0, 1.0, draft_m=2.0, beam_m=3.5, air_draft_m=18.0, min_coast_distance_nm=0.5
        )


def test_a_200_with_no_route_geometry_is_treated_as_not_found(fake: FakeRouteIQ) -> None:
    # A response that satisfies the type (FeatureCollection) but carries
    # no usable LineString must not be handed back as a "successful"
    # route with nothing to draw.
    fake.respond_status(200, {"type": "FeatureCollection", "features": []})
    with pytest.raises(RouteIQNotFound):
        _client(fake).plan_route(
            0.0, 0.0, 1.0, 1.0, draft_m=2.0, beam_m=3.5, air_draft_m=18.0, min_coast_distance_nm=0.5
        )
