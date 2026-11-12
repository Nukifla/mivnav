# SPDX-License-Identifier: GPL-2.0-only
"""``POST /routing/plan`` with ``RoutingConfig.algorithm == "artifact"`` —
the FOURTH engine (``chartcore::routing::artifact``,
``mivnav_routing_architecture_v3.md``'s own model), and the three
``artifact_*`` config fields that drive it.

Deliberately its own file rather than more of ``test_routing.py``, the
same reason ``chartcore/tests/routing_artifact_de6ostim.rs`` is a sibling
of ``routing_de6ostim.rs`` and not an addition to it: a regression in one
algorithm must not read as a regression in the other.

Everything here runs against the SAME real fixture the raster tests use
(``backend/data/fnc/DE6OSTIM.S57``, a real CC0 freenauticalchart.net
cell), through the real HTTP layer, with no mocking of chartcore — what
is being tested is the WIRING (config → ``routes._plan_via_artifact`` →
``hazards.cells_for_line``/``find_artifact_route`` →
``chartcore.artifact_route`` → ``PlanResponse``), not the algorithm,
whose own hazard/CATZOC/determinism maths is already covered by that
chartcore test file.

Two facts about this fixture shape almost every test below, both measured
directly (``Cell`` feature dump), not assumed:

* it charts **no** ``M_QUAL``, so §3.4's D/U fallback applies and the
  ``"full"`` CATZOC default buffers every hazard by a kilometre — which
  closes a 400m harbour outright. That is v3 §25 open decision #1 working
  as specified; the tests that want a route therefore set
  ``artifact_catzoc_allowance_mode`` explicitly, and one test pins the
  consequence of the default so nobody rediscovers it live.
* it charts **no** ``RESARE``/``MIPARE``/``MARCUL``/``FSHFAC`` (and no
  ``UNSARE``/``M_COVR``/``BRIDGE``) — see
  ``test_plan_via_artifact_allow_restricted_entry_reaches_chartcore`` for
  what that costs the one test it affects, and why it is honest to say so
  rather than assert something weaker and call it end-to-end.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mivnav.api.app import app
from mivnav.api.charts import get_ocharts
from mivnav.api.deps import get_signalk
from mivnav.features.ocharts.service import OchartsService
from mivnav.features.routing.geo import Point, haversine_m
from mivnav.signalk import SignalKService

_FNC_FIXTURE = Path(__file__).resolve().parents[1] / "data" / "fnc" / "DE6OSTIM.S57"

# The same three real points `chartcore/tests/routing_artifact_de6ostim.rs`
# uses, in this router's own `{"lat": ..., "lon": ...}` wire shape. The
# west-side channel is the only substantial stretch this cell leaves
# navigable at a small required depth; the basin is reachable only around
# the charted moles. Deliberately NOT `test_routing.py`'s own
# `_CLEAR_OF_THE_LAND` — its west point (lon 11.3680) lies ~200m OUTSIDE
# this cell's charted coverage, which for the raster algorithm is simply
# "nothing to avoid there" and for this one is uncharted water: a hard
# block beyond the grace radius (v3 §24's "no coverage is not free
# water"). Sharing those constants would have made every test here read
# as "the algorithm is broken".
_CHANNEL_NORTH = {"lat": 53.9930, "lon": 11.3711}
_CHANNEL_SOUTH = {"lat": 53.9896, "lon": 11.3711}
_BASIN = {"lat": 53.992133, "lon": 11.37513}
# Inside the charted land, ~90m from navigable water — within the default
# 150m grace radius, so §9.3 snaps to the nearest navigable point instead
# of refusing.
_INSIDE_THE_LAND = {"lat": 53.9910, "lon": 11.3750}
# ~93m north of the cell's own charted coverage (extent north edge
# 53.993167): uncharted, so grace-eligible on the FIRST leg only.
_JUST_OUTSIDE_COVERAGE = {"lat": 53.9940, "lon": 11.3711}
# ~370m north of it: beyond any plausible grace radius.
_WELL_OUTSIDE_COVERAGE = {"lat": 53.9965, "lon": 11.3711}

_METRES_PER_NM = 1852.0


def _straight_line_m(a: dict, b: dict) -> float:
    return haversine_m(Point(a["lat"], a["lon"]), Point(b["lat"], b["lon"]))


# Deliberately NOT `test_routing.py`'s own `_LAND_BBOX` "no waypoint may
# sit inside this box" check: that box is the BOUNDING box of the land
# polygon, and this harbour's basin sits inside it (the moles wrap around
# the water). It is the right assertion for a route that crosses the
# island and the wrong one for a route that enters the harbour. What
# proves the moles were respected here is instead the pair below — a
# route materially longer than the direct line (it went around), every leg
# of which the EXACT verifier confirmed clear (`approximate_legs` all
# `False`, which for this algorithm means `chartcore::routing::raster::
# verify_route_legs` re-checked each leg against the hard-constraint union
# and found it clean).


@pytest.fixture
def ocharts_with_de6ostim(tmp_path: Path) -> OchartsService:
    """A real ``OchartsService`` serving one real, unencrypted cell — the
    same fixture shape ``test_routing.py`` builds, duplicated rather than
    imported for the same reason this file exists at all (an independent
    setup cannot be broken by an unrelated edit to the raster tests)."""
    set_dir = tmp_path / "ocharts" / "oeuSENC-DE6OSTIM"
    set_dir.mkdir(parents=True)
    shutil.copy(_FNC_FIXTURE, set_dir / "DE6OSTIM.senc")
    (set_dir / "keys.xml").write_text(
        "<keyList><Chart><FileName>DE6OSTIM</FileName>"
        "<RInstallKey>fabricated</RInstallKey></Chart>"
        "<ChartInfo>DE6OSTIM Set</ChartInfo><Edition>2026/01-1</Edition></keyList>"
    )
    return OchartsService(
        sets_dir=tmp_path / "ocharts",
        daemon_dir=tmp_path / "daemon",
        work_dir=tmp_path / "work",
        warm_overview=False,
    )


@pytest.fixture
def artifact_client(ocharts_with_de6ostim: OchartsService, isolated_runtime):
    """``TestClient`` on the real fixture set, with
    ``routing.algorithm == "artifact"`` for the duration and the session
    runtime restored afterwards — the same override-two-dependencies
    shape ``test_routing.py``'s own ``hazard_client`` uses, plus the
    config patch every test here would otherwise repeat.

    ``lateral_margin_m: 0.0`` is load-bearing, not tidy-up: this
    algorithm treats that field as a HARD buffer (see
    ``_plan_via_artifact``'s docs — same call ``_plan_via_graph`` makes),
    and the shipped 30m default walls off this real 400m harbour's own
    basin entrance entirely (measured: the basin is unreachable at 10m
    and above). Tests that care about the margin set it themselves.
    """
    signalk = SignalKService(None)
    app.dependency_overrides[get_ocharts] = lambda: ocharts_with_de6ostim
    app.dependency_overrides[get_signalk] = lambda: signalk
    isolated_runtime.config.patch(
        {
            "routing": {
                "algorithm": "artifact",
                "artifact_catzoc_allowance_mode": "off",
                "lateral_margin_m": 0.0,
                "default_draft_m": 0.5,
            }
        }
    )
    yield TestClient(app)
    isolated_runtime.config.patch(
        {
            "routing": {
                "algorithm": "raster",
                "artifact_catzoc_allowance_mode": "full",
                "artifact_endpoint_grace_radius_m": 150.0,
                "artifact_allow_restricted_entry": False,
                "lateral_margin_m": 30.0,
                "default_draft_m": 2.0,
                # Restored too, not just the fields this fixture set: the
                # `isolated_runtime` config is SESSION-scoped, so anything
                # an individual test here patches leaks into every later
                # test in the run unless it is put back. Found the hard
                # way (a `under_keel_margin_m` left at 0.75 broke an
                # unrelated assertion two tests later).
                "under_keel_margin_m": 1.0,
                "air_draft_m": 0.0,
            }
        }
    )
    app.dependency_overrides.pop(get_ocharts, None)
    app.dependency_overrides.pop(get_signalk, None)
    signalk.close()


def _plan(client: TestClient, a: dict, b: dict, **body) -> dict:
    resp = client.post("/routing/plan", json={"from": a, "to": b, **body})
    assert resp.status_code == 200, resp.text
    return resp.json()


# -- a real route on real chart data ---------------------------------------


def test_plan_via_artifact_bends_around_the_real_moles_into_the_basin(
    artifact_client: TestClient,
) -> None:
    """The wiring's own headline proof: `algorithm: "artifact"` reaches
    `chartcore.artifact_route` (not `shortest_path`, not `graph_route`)
    and comes back with a real, bent, exactly-verified route into
    DE6OSTIM's own harbour basin — the only way in is around the charted
    moles, so a straight line here would mean the hard-constraint set
    never reached the search."""
    body = _plan(artifact_client, _CHANNEL_NORTH, _BASIN, draft_m=0.5)

    assert len(body["waypoints"]) > 2, body
    # Materially longer than the direct line: it went round the moles
    # rather than through them.
    direct_m = _straight_line_m(_CHANNEL_NORTH, _BASIN)
    assert body["distance_nm"] * _METRES_PER_NM > direct_m * 1.15, (body, direct_m)
    # Both per-leg arrays are the algorithm's own, passed straight
    # through: one entry per leg, and nothing flagged on a route that
    # verifies exactly against real geometry.
    legs = len(body["waypoints"]) - 1
    assert len(body["approximate_legs"]) == legs
    assert len(body["check_manually_legs"]) == legs
    assert not any(body["approximate_legs"]), body
    assert not any(body["check_manually_legs"]), body
    assert any("v3 artifact algorithm" in w for w in body["warnings"]), body


def test_plan_via_artifact_never_borrows_the_raster_searchs_own_warning(
    artifact_client: TestClient,
) -> None:
    """`_NO_RULES_WARNING` names the RASTER search's own specific gaps
    ("buoyage side is at most a soft preference for lateral marks when
    enabled"), which is not a true statement about this algorithm — it
    has no buoyage term at all. Each engine states its own gaps."""
    body = _plan(artifact_client, _CHANNEL_NORTH, _CHANNEL_SOUTH, draft_m=0.5)
    assert not any("soft preference for lateral marks" in w for w in body["warnings"]), body


def test_plan_via_artifact_is_deterministic_over_http(artifact_client: TestClient) -> None:
    """v3 §13's whole point, at the wire level: the same request twice is
    the same route, waypoint for waypoint. Cheap to assert here and the
    only place the CELL ORDER handed to the search
    (`hazards.cells_for_line`'s explicit finest-scale-then-name sort, not
    dict-iteration order over the installed sets) is covered at all."""
    first = _plan(artifact_client, _CHANNEL_NORTH, _BASIN, draft_m=0.5)
    second = _plan(artifact_client, _CHANNEL_NORTH, _BASIN, draft_m=0.5)
    assert first["waypoints"] == second["waypoints"]
    assert first["distance_nm"] == second["distance_nm"]


# -- artifact_catzoc_allowance_mode: a real behaviour change ----------------


def test_catzoc_mode_changes_whether_this_harbour_is_navigable_at_all(
    artifact_client: TestClient, isolated_runtime
) -> None:
    """The config field reaching chartcore, proven by BEHAVIOUR rather
    than by capturing an argument: the identical request routes at
    `"off"` and is refused at `"full"`, on the same chart.

    Why so violent a difference is correct here, not a bug: this cell
    charts no `M_QUAL` at all, so §3.4's D/U fallback gives every hazard
    a 1000m horizontal buffer, and a kilometre swallows a 400m harbour.
    `chartcore/tests/routing_artifact_de6ostim.rs`'s own
    `catzoc_full_really_closes_water_this_cell_leaves_open` pins the same
    fact one layer down; this pins that the HTTP layer's own default
    (`"full"`, the shipped `RoutingConfig` value) inherits it, and
    reports it as an honest straight-line fallback rather than a 500."""
    open_water = _plan(artifact_client, _CHANNEL_NORTH, _CHANNEL_SOUTH, draft_m=0.5)
    assert not any(open_water["approximate_legs"]), open_water

    isolated_runtime.config.patch({"routing": {"artifact_catzoc_allowance_mode": "full"}})
    closed = _plan(artifact_client, _CHANNEL_NORTH, _CHANNEL_SOUTH, draft_m=0.5)

    # The honest straight line every algorithm here falls back to, never
    # an error and never a silent gap.
    assert len(closed["waypoints"]) == 2, closed
    assert closed["approximate_legs"] == [True], closed
    assert any("found no path" in w for w in closed["warnings"]), closed
    # The reason names the knob actually responsible, so the fix is
    # findable from the response alone.
    assert any("CATZOC allowance 'full'" in w for w in closed["warnings"]), closed


def test_catzoc_mode_depth_only_still_applies_the_depth_allowance(
    artifact_client: TestClient, isolated_runtime
) -> None:
    """`"depth_only"` skips the horizontal buffer but keeps the depth
    allowance — and D/U's own allowance (2.00m + 5%) is enough on its own
    to close this 0-3.4m harbour to a boat needing 1.5m, so the two modes
    are genuinely distinguishable here rather than merely spelled
    differently."""
    isolated_runtime.config.patch({"routing": {"artifact_catzoc_allowance_mode": "depth_only"}})
    body = _plan(artifact_client, _CHANNEL_NORTH, _CHANNEL_SOUTH, draft_m=0.5)
    assert body["approximate_legs"] == [True], body
    assert any("found no path" in w for w in body["warnings"]), body


# -- artifact_endpoint_grace_radius_m (v3 §9.3) ----------------------------


def test_grace_lets_a_route_start_in_uncharted_water_and_flags_that_leg(
    artifact_client: TestClient,
) -> None:
    """§9.3, end to end: a start ~93m outside this cell's own charted
    coverage is UNKNOWN water, which this algorithm hard-blocks — but the
    first leg alone may cross it within the grace radius, so the request
    still gets a real route, with that leg (and only that leg) flagged
    for a human.

    This is the mechanism that makes the strict `UNSARE`/no-coverage rule
    survivable at all (see `RoutingConfig.artifact_endpoint_grace_radius_m`)
    — without it, a marina charted at the edge of a cell's coverage would
    simply be unreachable."""
    body = _plan(artifact_client, _JUST_OUTSIDE_COVERAGE, _CHANNEL_SOUTH, draft_m=0.5)

    assert len(body["waypoints"]) >= 2, body
    assert body["check_manually_legs"][0] is True, body
    # Never silently "safe": the flag rides in check_manually_legs, not
    # approximate_legs — the leg's geometry IS verified, its chart data
    # is what's missing.
    assert not any(body["approximate_legs"]), body


def test_grace_radius_zero_refuses_that_same_request(
    artifact_client: TestClient, isolated_runtime
) -> None:
    """The other half of the same field, and the proof it is really read
    rather than defaulted somewhere: `0` disables grace entirely, and the
    request that just succeeded now has no route at all."""
    with_grace = _plan(artifact_client, _JUST_OUTSIDE_COVERAGE, _CHANNEL_SOUTH, draft_m=0.5)
    assert with_grace["check_manually_legs"][0] is True, with_grace

    isolated_runtime.config.patch({"routing": {"artifact_endpoint_grace_radius_m": 0.0}})
    without = _plan(artifact_client, _JUST_OUTSIDE_COVERAGE, _CHANNEL_SOUTH, draft_m=0.5)
    assert without["waypoints"] and len(without["waypoints"]) == 2, without
    assert without["approximate_legs"] == [True], without
    assert any("found no path" in w for w in without["warnings"]), without


def test_a_start_well_beyond_the_grace_radius_falls_back_to_a_straight_line(
    artifact_client: TestClient,
) -> None:
    """v3 §24's first trap — "no coverage is not free water" — at the
    default 150m radius: ~370m outside the charted coverage is not merely
    far, it is uncharted, and no grace reaches it. The response is still
    a drawable line with a reason, never an error."""
    body = _plan(artifact_client, _WELL_OUTSIDE_COVERAGE, _CHANNEL_SOUTH, draft_m=0.5)
    assert len(body["waypoints"]) == 2, body
    assert body["approximate_legs"] == [True], body
    assert any("found no path" in w for w in body["warnings"]), body


def test_an_endpoint_inside_charted_land_is_snapped_and_the_move_is_reported(
    artifact_client: TestClient,
) -> None:
    """§9.3's other half: a destination inside a hard-blocking feature is
    moved to the nearest navigable point within the grace radius, and the
    distance it moved is reported — a helmsman must not silently be given
    a route to somewhere other than where they clicked.

    The warning threshold is the grid's own cell size (see
    `_plan_via_artifact`): §13.1's canonical cell-centre snapping moves
    EVERY endpoint by up to half a grid diagonal, so warning on any
    nonzero move would be noise on every route — this asserts both sides
    of that line, since the (perfectly navigable) start of this very same
    request must NOT produce one."""
    body = _plan(artifact_client, _CHANNEL_NORTH, _INSIDE_THE_LAND, draft_m=0.5)

    moved = [w for w in body["warnings"] if "was moved" in w]
    assert len(moved) == 1, body["warnings"]
    assert "destination" in moved[0], moved
    # The route really does end somewhere else than asked for, by roughly
    # the distance the warning claims — and every leg still verifies
    # exactly, i.e. the relocation found navigable water rather than
    # merely a different patch of land.
    end = body["waypoints"][-1]
    assert _straight_line_m(end, _INSIDE_THE_LAND) > 50.0, body
    assert not any(body["approximate_legs"]), body


# -- artifact_allow_restricted_entry ---------------------------------------


def test_allow_restricted_entry_reaches_chartcore_with_the_configured_value(
    artifact_client: TestClient, isolated_runtime, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The exact value captured at the chartcore boundary, the same proof
    shape `test_routing.py`'s own
    `test_plan_air_draft_config_reaches_chartcore` makes for `air_draft_m`
    — and for the same reason, stated plainly rather than dressed up as
    something stronger: a BEHAVIOUR assertion is not available on this
    fixture. `DE6OSTIM` charts no `RESARE`, `MIPARE`, `MARCUL` or
    `FSHFAC` at all (measured directly from the decoded cell's own class
    counts, not assumed), so there is nothing here for this flag to
    release, and no route it could change. That the flag actually changes
    the hard-constraint union is `chartcore::routing::artifact::
    constraints`' own `restrn_8_blocks_by_default_and_the_override_
    releases_it`-family tests, against synthetic areas; what is unproven
    without this test is the wiring in between, which is exactly what it
    covers: config field → `_plan_via_artifact` → `find_artifact_route` →
    the pyo3 keyword."""
    import mivnav.features.routing.hazards as hazards_module

    seen: list[bool] = []
    real = hazards_module.chartcore.artifact_route

    def recording_artifact_route(*args, **kwargs):
        seen.append(kwargs["allow_restricted_entry"])
        return real(*args, **kwargs)

    monkeypatch.setattr(hazards_module.chartcore, "artifact_route", recording_artifact_route)

    _plan(artifact_client, _CHANNEL_NORTH, _CHANNEL_SOUTH, draft_m=0.5)
    assert seen == [False], seen

    isolated_runtime.config.patch({"routing": {"artifact_allow_restricted_entry": True}})
    _plan(artifact_client, _CHANNEL_NORTH, _CHANNEL_SOUTH, draft_m=0.5)
    assert seen == [False, True], seen


def test_depth_tier_config_reaches_chartcore_with_the_name_mapping(
    artifact_client: TestClient, isolated_runtime, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The §6 charted-depth tiers: `RoutingConfig.avoid_depth_below_m` /
    `soft_prefer_depth_below_m` become the pyo3 `avoid_depth_m` /
    `soft_prefer_depth_m` thresholds, and `avoid_depth_weight` /
    `soft_prefer_depth_weight` become `avoid_depth_weight` /
    `prefer_depth_weight`. Wiring-only, same shape/reasoning as
    `test_allow_restricted_entry_reaches_chartcore_with_the_configured_value`
    (behaviour is `chartcore`'s own `constraints` / `artifact` tier
    tests). The name mapping is the part that is easy to get wrong."""
    import mivnav.features.routing.hazards as hazards_module

    seen: list[dict] = []
    real = hazards_module.chartcore.artifact_route

    def recording(*args, **kwargs):
        seen.append({k: kwargs[k] for k in ("avoid_depth_m", "soft_prefer_depth_m", "avoid_depth_weight", "prefer_depth_weight")})
        return real(*args, **kwargs)

    monkeypatch.setattr(hazards_module.chartcore, "artifact_route", recording)

    # Default: tiers on at the config defaults (4 m / 6 m).
    _plan(artifact_client, _CHANNEL_NORTH, _CHANNEL_SOUTH, draft_m=0.5)
    assert seen[-1] == {
        "avoid_depth_m": 4.0,
        "soft_prefer_depth_m": 6.0,
        "avoid_depth_weight": 3.0,
        "prefer_depth_weight": 0.8,
    }, seen[-1]

    isolated_runtime.config.patch(
        {
            "routing": {
                "avoid_depth_below_m": 5.5,
                "avoid_depth_weight": 2.0,
                "soft_prefer_depth_below_m": 9.0,
                "soft_prefer_depth_weight": 0.4,
            }
        }
    )
    _plan(artifact_client, _CHANNEL_NORTH, _CHANNEL_SOUTH, draft_m=0.5)
    assert seen[-1] == {
        "avoid_depth_m": 5.5,
        "soft_prefer_depth_m": 9.0,
        "avoid_depth_weight": 2.0,
        "prefer_depth_weight": 0.4,
    }, seen[-1]


def test_the_shared_vessel_fields_reach_chartcore_combined_the_documented_way(
    artifact_client: TestClient, isolated_runtime, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`required_depth_m` is `draft + under_keel_margin_m` combined ON
    THIS SIDE (chartcore takes one number, not two), and
    `lateral_margin_m` is passed as this algorithm's HARD buffer rather
    than the raster search's soft pull. Both are easy to get subtly wrong
    and invisible in a route's shape, so they are asserted by value."""
    import mivnav.features.routing.hazards as hazards_module

    seen: list[tuple] = []
    real = hazards_module.chartcore.artifact_route

    def recording_artifact_route(*args, **kwargs):
        # positional: from_lon, from_lat, to_lon, to_lat, cells, required_depth_m
        seen.append((args[5], kwargs["lateral_margin_m"], kwargs["required_air_draft_m"]))
        return real(*args, **kwargs)

    monkeypatch.setattr(hazards_module.chartcore, "artifact_route", recording_artifact_route)

    isolated_runtime.config.patch(
        {"routing": {"under_keel_margin_m": 0.75, "lateral_margin_m": 2.0, "air_draft_m": 18.0}}
    )
    _plan(artifact_client, _CHANNEL_NORTH, _CHANNEL_SOUTH, draft_m=1.25)
    assert seen == [(2.0, 2.0, 18.0)], seen


def test_the_draft_falls_back_to_config_when_the_request_omits_it(
    artifact_client: TestClient,
) -> None:
    """Same fallback chain every algorithm here shares (request →
    SignalK → `RoutingConfig.default_draft_m`); the fixture's SignalK
    service has no fix, so this lands on the config value (0.5m, set by
    the fixture) and the request must still route."""
    body = _plan(artifact_client, _CHANNEL_NORTH, _CHANNEL_SOUTH)
    assert not any(body["approximate_legs"]), body


# -- the debug channel -----------------------------------------------------


def test_debug_carries_the_resolution_ladder_and_catzoc_diagnostics(
    artifact_client: TestClient,
) -> None:
    """`PlanRequest.debug` reuses the EXISTING `timings`/`debug_legs`
    channel (no third one invented for this algorithm) and carries the
    numbers that actually explain a surprising route: the resolution the
    corridor was searched at, the §4.1/§4.2 ladder figures behind it, and
    how far CATZOC grew the hazards."""
    body = _plan(artifact_client, _CHANNEL_NORTH, _BASIN, draft_m=0.5, debug=True)

    assert body["timings"], body
    assert any(t["step"] == "artifact_route" for t in body["timings"]), body["timings"]

    assert body["debug_legs"] and len(body["debug_legs"]) == 1, body
    leg = body["debug_legs"][0]
    assert len(leg["bbox"]) == 4
    # Never populated for this algorithm — its constraint geometry is
    # built inside chartcore and never crosses back as rings.
    assert leg["hazard_rings"] == []
    d = leg["artifact"]
    assert d["compilation_scale"] == 4000  # the fixture's own 1:4 000
    assert d["finest_allowed_cell_m"] == 2.0  # §4.1: max(2, 4000/2000, 0)
    assert d["cell_size_m"] >= d["finest_allowed_cell_m"]
    assert d["catzoc_horizontal_m"] == 0.0  # the fixture sets mode "off"
    assert d["nodes_expanded"] > 0
    assert d["route_cost_mm"] > 0


def test_no_debug_payload_without_the_debug_flag(artifact_client: TestClient) -> None:
    body = _plan(artifact_client, _CHANNEL_NORTH, _BASIN, draft_m=0.5)
    assert body["timings"] is None
    assert body["debug_legs"] is None


# -- the config surface itself ---------------------------------------------


def test_the_three_artifact_fields_round_trip_through_the_config_api(
    isolated_runtime,
) -> None:
    """`GET`/`PATCH /config` carry the new fields, with the defaults the
    spec fixes (150m, `"full"`, `False`) and a real persisted change —
    the same contract every other `RoutingConfig` field has, which is the
    whole reason the frontend can bind to them."""
    from mivnav.api.deps import get_runtime

    saved = dict(app.dependency_overrides)
    app.dependency_overrides[get_runtime] = lambda: isolated_runtime
    try:
        with TestClient(app) as client:
            routing = client.get("/config").json()["config"]["routing"]
            assert routing["artifact_endpoint_grace_radius_m"] == 150.0
            assert routing["artifact_catzoc_allowance_mode"] == "full"
            assert routing["artifact_allow_restricted_entry"] is False

            patched = client.patch(
                "/config",
                json={
                    "routing": {
                        "algorithm": "artifact",
                        "artifact_endpoint_grace_radius_m": 400.0,
                        "artifact_catzoc_allowance_mode": "half",
                        "artifact_allow_restricted_entry": True,
                    }
                },
            )
            assert patched.status_code == 200, patched.text
            routing = patched.json()["config"]["routing"]
            assert routing["algorithm"] == "artifact"
            assert routing["artifact_endpoint_grace_radius_m"] == 400.0
            assert routing["artifact_catzoc_allowance_mode"] == "half"
            assert routing["artifact_allow_restricted_entry"] is True
            # A sibling field must be untouched by the merge.
            assert routing["under_keel_margin_m"] == 1.0

            assert client.get("/config").json()["config"]["routing"] == routing
    finally:
        isolated_runtime.config.patch(
            {
                "routing": {
                    "algorithm": "raster",
                    "artifact_endpoint_grace_radius_m": 150.0,
                    "artifact_catzoc_allowance_mode": "full",
                    "artifact_allow_restricted_entry": False,
                }
            }
        )
        app.dependency_overrides.clear()
        app.dependency_overrides.update(saved)


def test_the_config_api_rejects_a_bad_artifact_value(isolated_runtime) -> None:
    """A typo in the CATZOC mode must be a 422, not a silently-weakened
    hard constraint — chartcore's own parser falls back to the strictest
    mode for an unknown string, but the config layer should never let one
    through in the first place. Same for a grace radius outside the
    field's own range and an unknown algorithm name."""
    from mivnav.api.deps import get_runtime

    saved = dict(app.dependency_overrides)
    app.dependency_overrides[get_runtime] = lambda: isolated_runtime
    try:
        with TestClient(app) as client:
            for patch in (
                {"routing": {"artifact_catzoc_allowance_mode": "flul"}},
                {"routing": {"artifact_endpoint_grace_radius_m": -1}},
                {"routing": {"artifact_endpoint_grace_radius_m": 5000}},
                {"routing": {"algorithm": "artefact"}},
            ):
                assert client.patch("/config", json=patch).status_code == 422, patch
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(saved)
