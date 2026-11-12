# SPDX-License-Identifier: GPL-2.0-only
"""``POST /routing/plan`` with ``RoutingConfig.algorithm == "mivnav"`` —
the FIFTH engine, wired this session as a testability stepping stone for
``chartcore::mivnav`` (the precomputed v3 topology pipeline).

Deliberately its own file, same reasoning as ``test_routing_artifact.py``:
a regression in one algorithm's own wiring must not read as a regression
in another. Runs against real fixtures
(``backend/data/fnc/DE6OSTIM.S57`` for most tests; ``DE6OSBRH.S57``,
which charts a real fairway, for the `fairway_preference_weight` tests
near the bottom — see that fixture's own comment for why) through the
real HTTP layer, no chartcore mocking.

The one fact every test here either proves or leans on: today `"mivnav"`
runs the IDENTICAL `chartcore.artifact_route` fine search `"artifact"`
does, over the identical cells — see `_plan_via_mivnav`'s own docstring
(`mivnav/features/routing/routes.py`) for why. What is genuinely new is
the `chartcore::mivnav` precomputed-topology pipeline running alongside
it — purely for cross-check diagnostics (`debug_legs[...]["mivnav"]`)
today, EXCEPT for the two shared preference weights
(`fairway_preference_weight`/`tss_avoidance_weight`) the fine search
already had its own real support for independently: those genuinely do
reach the topology layer's own reported cost too, which is what the
tests near the bottom of this file prove over HTTP.
"""

from __future__ import annotations

import os
import shutil
import time
from pathlib import Path

import chartcore
import pytest
from fastapi.testclient import TestClient

from mivnav.api.app import app
from mivnav.api.charts import get_ocharts
from mivnav.api.deps import get_signalk
from mivnav.features.ocharts.service import OchartsService
from mivnav.features.routing.geo import Point, haversine_m
from mivnav.signalk import SignalKService

_FNC_FIXTURE = Path(__file__).resolve().parents[1] / "data" / "fnc" / "DE6OSTIM.S57"

# Identical to `test_routing_artifact.py`'s own constants, deliberately
# not re-derived — see that file's own comment for why each one is what
# it is on this fixture.
_CHANNEL_NORTH = {"lat": 53.9930, "lon": 11.3711}
_CHANNEL_SOUTH = {"lat": 53.9896, "lon": 11.3711}
_BASIN = {"lat": 53.992133, "lon": 11.37513}

_METRES_PER_NM = 1852.0


def _straight_line_m(a: dict, b: dict) -> float:
    return haversine_m(Point(a["lat"], a["lon"]), Point(b["lat"], b["lon"]))


@pytest.fixture
def ocharts_with_de6ostim(tmp_path: Path) -> OchartsService:
    """See `test_routing_artifact.py`'s own fixture of the same name —
    duplicated, not imported, for the same independence reason."""
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
def mivnav_client(ocharts_with_de6ostim: OchartsService, isolated_runtime):
    """Same override/patch/restore shape as `test_routing_artifact.py`'s
    own `artifact_client` — `lateral_margin_m: 0.0` is load-bearing there
    for the identical reason (this algorithm treats it as a HARD wall,
    and the shipped 30m default closes this real 400m harbour's own
    basin entrance)."""
    signalk = SignalKService(None)
    app.dependency_overrides[get_ocharts] = lambda: ocharts_with_de6ostim
    app.dependency_overrides[get_signalk] = lambda: signalk
    isolated_runtime.config.patch(
        {
            "routing": {
                "algorithm": "mivnav",
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


def test_plan_via_mivnav_bends_around_the_real_moles_into_the_basin(
    mivnav_client: TestClient,
) -> None:
    """The wiring's own headline proof, mirroring `"artifact"`'s own
    test of the same name: `algorithm: "mivnav"` reaches
    `chartcore.mivnav_route` and comes back with a real, bent,
    exactly-verified route into DE6OSTIM's own harbour basin."""
    body = _plan(mivnav_client, _CHANNEL_NORTH, _BASIN, draft_m=0.5)

    assert len(body["waypoints"]) > 2, body
    direct_m = _straight_line_m(_CHANNEL_NORTH, _BASIN)
    assert body["distance_nm"] * _METRES_PER_NM > direct_m * 1.15, (body, direct_m)
    legs = len(body["waypoints"]) - 1
    assert len(body["approximate_legs"]) == legs
    assert len(body["check_manually_legs"]) == legs
    assert not any(body["approximate_legs"]), body
    assert not any(body["check_manually_legs"]), body
    assert any("v3 artifact algorithm" in w for w in body["warnings"]), body


def test_plan_via_mivnav_matches_plan_via_artifact_byte_for_byte(
    mivnav_client: TestClient, isolated_runtime
) -> None:
    """The load-bearing claim `_plan_via_mivnav`'s own docstring makes:
    today `"mivnav"` is `"artifact"` plus diagnostics, nothing more. Same
    request, same config otherwise, only `algorithm` flipped — the
    waypoints and distance must be IDENTICAL, not merely close."""
    mivnav_body = _plan(mivnav_client, _CHANNEL_NORTH, _BASIN, draft_m=0.5)

    isolated_runtime.config.patch({"routing": {"algorithm": "artifact"}})
    artifact_body = _plan(mivnav_client, _CHANNEL_NORTH, _BASIN, draft_m=0.5)

    assert mivnav_body["waypoints"] == artifact_body["waypoints"]
    assert mivnav_body["distance_nm"] == artifact_body["distance_nm"]
    assert mivnav_body["approximate_legs"] == artifact_body["approximate_legs"]
    assert mivnav_body["check_manually_legs"] == artifact_body["check_manually_legs"]


def test_plan_via_mivnav_is_deterministic_over_http(mivnav_client: TestClient) -> None:
    first = _plan(mivnav_client, _CHANNEL_NORTH, _BASIN, draft_m=0.5)
    second = _plan(mivnav_client, _CHANNEL_NORTH, _BASIN, draft_m=0.5)
    assert first["waypoints"] == second["waypoints"]
    assert first["distance_nm"] == second["distance_nm"]


def test_no_route_falls_back_to_the_honest_straight_line(mivnav_client: TestClient) -> None:
    """A required depth no water on this fixture can satisfy (identical
    reasoning/gate as `"artifact"`'s own default-CATZOC-closes-the-
    harbour case) — must come back 200 with the straight-line fallback
    and the mivnav-specific warning text, never a 500.

    With no `.mivnav` built for this fixture, the fine search finding no
    path now routes through the coarse portal-graph fallback
    (`_plan_via_mivnav_coarse`), which — with no artifact to route around
    the obstruction — returns the same honest straight line, naming that
    a built artifact is what a long detour would need."""
    body = _plan(mivnav_client, _CHANNEL_NORTH, _BASIN, draft_m=50.0)
    assert len(body["waypoints"]) == 2, body
    assert body["approximate_legs"] == [True], body
    assert any(
        "found no direct route" in w and "POST /routing/mivnav/build" in w
        for w in body["warnings"]
    ), body


def test_debug_carries_both_the_artifact_and_topology_diagnostics(
    mivnav_client: TestClient,
) -> None:
    """`debug_legs[...]["mivnav"]` must carry everything `"artifact"`'s
    own key does (same fine search underneath) PLUS the
    `chartcore::mivnav` topology layer's own independent read on the same
    request — the actual point of this algorithm existing yet."""
    body = _plan(mivnav_client, _CHANNEL_NORTH, _BASIN, draft_m=0.5, debug=True)

    assert body["timings"], body
    assert any(t["step"] == "mivnav_route" for t in body["timings"]), body["timings"]

    assert body["debug_legs"] and len(body["debug_legs"]) == 1, body
    d = body["debug_legs"][0]["mivnav"]

    # The fine-search half — EVERY field `artifact_diagnostics` reports
    # (this route IS an `artifact_route_lonlat` result). An earlier
    # version of `mivnav_diagnostics` carried only 3 of these 14 despite
    # its own docstring claiming full parity — found by code review; this
    # checks the actual claim, not just one field of it.
    assert d["grid_cols"] > 0 and d["grid_rows"] > 0
    assert d["cell_size_m"] > 0
    assert d["ladder_cell_m"] > 0
    assert d["finest_allowed_cell_m"] == 2.0  # §4.1: max(2, 4000/2000, 0)
    assert d["catzoc_horizontal_m"] == 0.0  # the fixture sets mode "off"
    assert d["compilation_scale"] == 4000  # the fixture's own 1:4 000
    assert d["nodes_expanded"] > 0
    assert d["route_cost_mm"] > 0

    # The topology-layer half — new to this algorithm. On this real,
    # small, single-cell fixture the whole region is one band-navigable
    # component at 0.5m required depth, with real portals into the
    # basin, so the topology layer must independently confirm a path
    # too — the same real cross-check
    # `chartcore/tests/mivnav_query_de6ostim.rs` already proves at the
    # Rust layer, now exercised through the actual HTTP wiring. `hops`
    # came back `0` when this was first measured here — this fixture's
    # small extent builds so FEW tiles that `channel_north` and `basin`
    # snap to the very same tile at the topology layer's own coarse
    # granularity, a genuine "already there" answer at that granularity,
    # not a bug (`topology_route`'s own contract: same start/goal tile is
    # a valid zero-hop route) — so `hops`/`cost_mm` are asserted `>= 0`
    # here, not `> 0`; `topology_route_found` is the real, meaningful
    # cross-check this test exists for.
    assert d["topology_band_m"] >= 0.5
    assert d["topology_components"] >= 1
    assert d["topology_portals"] > 0
    assert d["topology_route_found"] is True, d
    assert d["topology_hops"] >= 0
    assert d["topology_cost_mm"] >= 0
    assert d["topology_corridor_bbox"] is not None
    west, south, east, north = d["topology_corridor_bbox"]
    assert west <= east
    assert south <= north

    # §14: the optimality statement. `best_known_lower_bound_mm` is a
    # straight-line lower bound on the FINE route cost, so it never
    # exceeds `route_cost_mm`; `optimality_gap` is that ratio, an upper
    # bound on the true gap, so it is never negative.
    assert 0 < d["best_known_lower_bound_mm"] <= d["route_cost_mm"]
    assert d["optimality_gap"] >= 0.0
    expected_gap = (d["route_cost_mm"] - d["best_known_lower_bound_mm"]) / d[
        "best_known_lower_bound_mm"
    ]
    assert abs(d["optimality_gap"] - expected_gap) < 1e-9
    # `topology_lower_bound_mm` bounds the TOPOLOGY cost (ALT landmarks
    # off the artifact) — a different quantity, only present when a built
    # artifact was used, and not comparable to the fine route cost.
    assert d["topology_lower_bound_mm"] >= 0
    if d["topology_source"] == "artifact" and d["topology_route_found"]:
        assert d["topology_lower_bound_mm"] <= d["topology_cost_mm"]
    assert d["verification_status"] in ("verified", "approximate_legs", "unverified")


def test_no_debug_payload_without_the_debug_flag(mivnav_client: TestClient) -> None:
    body = _plan(mivnav_client, _CHANNEL_NORTH, _BASIN, draft_m=0.5)
    assert body["timings"] is None
    assert body["debug_legs"] is None


# -- §8.3/§12.4: mivnav_beam_m demote-and-refine over real HTTP ------------
#
# The CHANNEL_SOUTH -> BASIN passage crosses one real charted portal
# (id 5 on this fixture) whose measured horizontal clearance is ~102 m.
# CHANNEL_NORTH -> BASIN, by contrast, snaps start and goal into the same
# topology tile (see `test_debug_...` above: `hops == 0`), so it has no
# crossing to demote — CHANNEL_SOUTH is deliberate here.


def test_beam_knob_off_by_default_keeps_the_route_identical_to_artifact(
    mivnav_client: TestClient,
) -> None:
    """`mivnav_beam_m` defaults to `0` — the demote/refine path is
    entirely inert and `"mivnav"` is still `"artifact"` plus
    diagnostics."""
    body = _plan(mivnav_client, _CHANNEL_SOUTH, _BASIN, draft_m=0.5, debug=True)
    d = body["debug_legs"][0]["mivnav"]
    assert d["topology_demoted_portals"] == []
    assert d["mivnav_refined_portals"] == []


def test_a_beam_below_the_crossing_width_demotes_nothing(
    mivnav_client: TestClient, isolated_runtime
) -> None:
    """The width threshold is real: a 50 m beam is well under this
    crossing's ~102 m, so nothing is demoted and the route is
    untouched."""
    isolated_runtime.config.patch({"routing": {"mivnav_beam_m": 50.0}})
    body = _plan(mivnav_client, _CHANNEL_SOUTH, _BASIN, draft_m=0.5, debug=True)
    d = body["debug_legs"][0]["mivnav"]
    assert d["topology_demoted_portals"] == []
    assert d["mivnav_refined_portals"] == []


def test_a_beam_above_the_crossing_width_demotes_and_locally_refines_the_route(
    mivnav_client: TestClient, isolated_runtime
) -> None:
    """The headline proof for this task: a beam above the crossing's
    measured width demotes the portal, §12.4 local vector refinement
    re-routes that stretch against the chart's own hazard geometry, the
    splice re-verifies against the DRAFT-AWARE hard constraints, and the
    route the caller gets is the refined one — no longer byte-identical
    to `"artifact"`.

    (~102 m crossing on this fixture; a beam that large is not a real
    hull, it is how a small fixture whose only charted crossings are wide
    exercises the path — see `RoutingConfig.mivnav_beam_m`.)"""
    off = _plan(mivnav_client, _CHANNEL_SOUTH, _BASIN, draft_m=0.5)

    isolated_runtime.config.patch({"routing": {"mivnav_beam_m": 105.0}})
    on = _plan(mivnav_client, _CHANNEL_SOUTH, _BASIN, draft_m=0.5, debug=True)
    d = on["debug_legs"][0]["mivnav"]

    assert d["topology_demoted_portals"], d
    assert d["mivnav_refined_portals"], d
    # every refined portal was one of the demoted ones
    assert set(d["mivnav_refined_portals"]) <= set(d["topology_demoted_portals"])

    # the route actually moved, and did not get longer
    assert on["waypoints"] != off["waypoints"], (on["waypoints"], off["waypoints"])
    assert on["distance_nm"] <= off["distance_nm"] * 1.02

    # ...and it is still a fully exact, hazard-clear route
    legs = len(on["waypoints"]) - 1
    assert len(on["approximate_legs"]) == legs
    assert len(on["check_manually_legs"]) == legs
    assert not any(on["approximate_legs"]), on
    assert not any(on["check_manually_legs"]), on

    # the standing mivnav caveat is still attached
    assert any("v3 artifact algorithm" in w for w in on["warnings"]), on


def test_refinement_shows_up_in_the_live_timing_line(
    mivnav_client: TestClient, isolated_runtime
) -> None:
    """The kept splice moved the route, so it is loud in the per-request
    INFO line the same way the artifact source/fallback reason is."""
    isolated_runtime.config.patch({"routing": {"mivnav_beam_m": 105.0}})
    body = _plan(mivnav_client, _CHANNEL_SOUTH, _BASIN, draft_m=0.5, debug=True)
    line = next(t for t in body["timings"] if t["step"] == "mivnav_route")
    assert "refined" in line["detail"], line


def test_the_optimality_gap_is_in_the_live_timing_line(
    mivnav_client: TestClient,
) -> None:
    """§14's `gap N.NNN` is loud by default in the per-request INFO line,
    the same way the artifact source and refinement notes are."""
    body = _plan(mivnav_client, _CHANNEL_SOUTH, _BASIN, draft_m=0.5, debug=True)
    line = next(t for t in body["timings"] if t["step"] == "mivnav_route")
    assert "gap " in line["detail"], line


# -- fairway_preference_weight reaching the topology diagnostics over HTTP -

# A second real fixture, DE6OSBRH.S57 — chosen (see `backend/data/fnc/
# SOURCE.txt`) specifically because it charts a real NAVLNE/RECTRC
# fairway; DE6OSTIM above charts neither a FAIRWAY-family nor a
# TSS-family feature at all. `chartcore/tests/mivnav_fairway_de6osbrh.rs`
# already proves `fairway_preference_weight` discounts a real route's
# `topology_cost_mm` at the Rust layer directly
# (`topology_route_with`); this proves the SAME real effect survives the
# whole HTTP/backend stack — config parsing, `_plan_via_mivnav`'s own
# weight plumbing, `chartcore.mivnav_route`'s pyo3 boundary — not just
# the Rust function called directly.
_FNC_FAIRWAY_FIXTURE = Path(__file__).resolve().parents[1] / "data" / "fnc" / "DE6OSBRH.S57"

# (lon, lat) — the fairway's own two charted endpoints, identical to
# `mivnav_fairway_de6osbrh.rs`'s own `FAIRWAY_NORTH`/`FAIRWAY_SOUTH`,
# deliberately not re-derived.
_FAIRWAY_NORTH = {"lat": 54.43632, "lon": 13.03045}
_FAIRWAY_SOUTH = {"lat": 54.43316, "lon": 13.03667}


@pytest.fixture
def ocharts_with_de6osbrh(tmp_path: Path) -> OchartsService:
    """Same shape as `ocharts_with_de6ostim`, a different real cell."""
    set_dir = tmp_path / "ocharts" / "oeuSENC-DE6OSBRH"
    set_dir.mkdir(parents=True)
    shutil.copy(_FNC_FAIRWAY_FIXTURE, set_dir / "DE6OSBRH.senc")
    (set_dir / "keys.xml").write_text(
        "<keyList><Chart><FileName>DE6OSBRH</FileName>"
        "<RInstallKey>fabricated</RInstallKey></Chart>"
        "<ChartInfo>DE6OSBRH Set</ChartInfo><Edition>2026/01-1</Edition></keyList>"
    )
    return OchartsService(
        sets_dir=tmp_path / "ocharts",
        daemon_dir=tmp_path / "daemon",
        work_dir=tmp_path / "work",
        warm_overview=False,
    )


@pytest.fixture
def mivnav_fairway_client(ocharts_with_de6osbrh: OchartsService, isolated_runtime):
    """Same override/patch/restore shape as `mivnav_client` above.
    `under_keel_margin_m: 0.0` is load-bearing here (unlike `mivnav_
    client`, which leaves it at the session default): the Rust-layer
    proof this mirrors uses `required_depth_m = 1.0` exactly, so
    `draft_m=1.0` in the request body needs a zero margin on top of it
    to combine to the identical figure — not a magic number, the same
    one `FAIRWAY_NORTH`/`FAIRWAY_SOUTH`'s own charted channel was
    checked against directly in chartcore.

    `artifact_endpoint_grace_radius_m: 500.0` (well above the 150m
    default) is ALSO load-bearing, and specific to this fixture: a
    `NAVLNE` marks a recommended TRACK line, not a promise that its own
    exact endpoint coordinates sit over charted depth soundings — probed
    directly (`find_artifact_route` called by hand at increasing grace
    radii) and confirmed the FINE search genuinely needs this much grace
    to reach real navigable water near these two real charted points; a
    smaller radius (including the 150m default) returns no route at all
    on this real fixture, unrelated to fairway preference. The TOPOLOGY
    layer's own connectivity needs no such grace here — `mivnav_fairway_
    de6osbrh.rs`'s own Rust-layer test connects these same two points at
    grace `0.0` — so this is purely a fine-search-resolution fact about
    this particular real cell, not something wrong with the topology
    proof this test exists to make."""
    signalk = SignalKService(None)
    app.dependency_overrides[get_ocharts] = lambda: ocharts_with_de6osbrh
    app.dependency_overrides[get_signalk] = lambda: signalk
    isolated_runtime.config.patch(
        {
            "routing": {
                "algorithm": "mivnav",
                "artifact_catzoc_allowance_mode": "off",
                "artifact_endpoint_grace_radius_m": 500.0,
                "lateral_margin_m": 0.0,
                "under_keel_margin_m": 0.0,
                "default_draft_m": 1.0,
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
                "under_keel_margin_m": 1.0,
                "air_draft_m": 0.0,
                "fairway_preference_weight": 0.0,
            }
        }
    )
    app.dependency_overrides.pop(get_ocharts, None)
    app.dependency_overrides.pop(get_signalk, None)
    signalk.close()


def test_fairway_preference_weight_reaches_the_topology_diagnostics_over_http(
    mivnav_fairway_client: TestClient, isolated_runtime
) -> None:
    """The real, measurable proof, over the actual HTTP surface: raising
    `fairway_preference_weight` must lower `debug_legs[...]["mivnav"]
    ["topology_cost_mm"]` on a route that runs a real charted fairway's
    own length — the identical effect (and, since nothing about the
    corridor changes between the two requests, the identical ~5x ratio)
    `mivnav_fairway_de6osbrh.rs`'s own
    `fairway_preference_weight_discounts_a_real_route_along_the_charted_
    fairway` already measures one layer down."""
    baseline = _plan(
        mivnav_fairway_client, _FAIRWAY_NORTH, _FAIRWAY_SOUTH, draft_m=1.0, debug=True
    )
    assert baseline["debug_legs"], baseline
    baseline_cost = baseline["debug_legs"][0]["mivnav"]["topology_cost_mm"]
    assert baseline_cost > 0

    isolated_runtime.config.patch({"routing": {"fairway_preference_weight": 0.9}})
    preferred = _plan(
        mivnav_fairway_client, _FAIRWAY_NORTH, _FAIRWAY_SOUTH, draft_m=1.0, debug=True
    )
    assert preferred["debug_legs"], preferred
    preferred_cost = preferred["debug_legs"][0]["mivnav"]["topology_cost_mm"]

    assert preferred_cost < baseline_cost, (baseline_cost, preferred_cost)
    # The route ITSELF (the `"artifact"` fine search's own answer, not
    # yet steered by this weight — see `_plan_via_mivnav`'s own
    # docstring) must be unaffected: only the topology cross-check's own
    # number should move.
    assert preferred["waypoints"] == baseline["waypoints"]


# -- tss_avoidance_weight: wiring-only, not a real-TSS-data proof ----------
#
# Unlike `fairway_preference_weight` above, there is no `.senc`-format (OSENC)
# committed fixture that charts a real TSS-family feature to pair with this
# test the same way `DE6OSBRH.S57` pairs with the fairway test. The real TSS
# data this session found (NOAA ENC `US5OAKEE.000` — see
# `chartcore/tests/mivnav_tss_us5oakee.rs`'s own module doc for full
# provenance and the two real, measured proofs at the chartcore layer:
# `touches_tss` fires on real decoded data, and `tss_avoidance_weight`
# measurably diverts a real route between two real charted buoys onto a
# different real charted crossing) is genuine ISO 8211 S-57, not OSENC — it
# needs the GDAL-backed reader (`chartcore::s57`, the `s57-ingest` cargo
# feature) to decode at all. The backend's own chartcore Python wheel is
# built with `features = ["pyo3"]` ONLY, no `s57-ingest`, even for local dev
# builds (`chartcore/pyproject.toml`; CLAUDE.md's `#GD2` entry) — by design,
# so this HTTP endpoint can never load a raw S-57 cell, real or otherwise.
# A Netherlands FNC candidate (`fnc-nl.zip`, OSENC-format like the other FNC
# fixtures, so it WOULD have worked here) was found and rejected instead:
# see `MIVNAV_ARTIFACT_TODO.md` for why (the publisher's own site marks the
# underlying data source's licence unconfirmed).
#
# `backend/tests/test_routing.py`'s `test_plan_survey_config_reaches_
# chartcore` hit this identical shape already, for `low_confidence_survey_
# avoidance_weight`/real `M_QUAL` zones — this test has the same scope:
# prove `tss_avoidance_weight` reaches `chartcore.mivnav_route` and the
# topology diagnostics over HTTP without erroring, on the existing
# (TSS-free) `DE6OSTIM.S57` fixture, not a real-TSS-data claim.
def test_tss_avoidance_weight_reaches_the_topology_diagnostics_without_erroring(
    mivnav_client: TestClient, isolated_runtime
) -> None:
    baseline = _plan(mivnav_client, _CHANNEL_NORTH, _BASIN, draft_m=0.5, debug=True)
    assert baseline["debug_legs"], baseline
    baseline_cost = baseline["debug_legs"][0]["mivnav"]["topology_cost_mm"]

    isolated_runtime.config.patch({"routing": {"tss_avoidance_weight": 3.0}})
    weighted = _plan(mivnav_client, _CHANNEL_NORTH, _BASIN, draft_m=0.5, debug=True)
    assert weighted["debug_legs"], weighted
    weighted_cost = weighted["debug_legs"][0]["mivnav"]["topology_cost_mm"]

    # This fixture charts no TSS-family feature at all (confirmed directly
    # — see `MIVNAV_ARTIFACT_TODO.md`'s DE6OSTIM notes), so no portal on the
    # winning route is ever TSS-flagged and the weight has nothing to act
    # on: the cost is expected to be UNCHANGED, not lowered/raised. The
    # real, meaningful assertion here is that the request still succeeds
    # (200, not 500) with a real, nonzero weight plumbed all the way
    # through config parsing -> `_plan_via_mivnav` -> `chartcore.mivnav_
    # route`'s pyo3 boundary -> the topology diagnostics.
    assert weighted_cost == baseline_cost, (baseline_cost, weighted_cost)
    assert weighted["waypoints"] == baseline["waypoints"]


# -- §11: mivnav_directional_rules reaches the topology layer over HTTP ----


def test_directional_rules_off_by_default_keep_the_route_identical_to_artifact(
    mivnav_client: TestClient,
) -> None:
    """`mivnav_directional_rules` defaults to `False`: the §11 semantics
    build is skipped entirely and the diagnostics field is an empty
    list, exactly like `mivnav_beam_m`'s own off-by-default posture."""
    body = _plan(mivnav_client, _CHANNEL_NORTH, _BASIN, draft_m=0.5, debug=True)
    d = body["debug_legs"][0]["mivnav"]
    assert d["topology_directional_penalized_portals"] == []


def test_directional_rules_reach_the_topology_diagnostics_without_erroring(
    mivnav_client: TestClient, isolated_runtime
) -> None:
    """Same wiring-scope proof as
    `test_tss_avoidance_weight_reaches_the_topology_diagnostics_without_
    erroring`: DE6OSTIM charts no TSSLPT/DWRTPT and its two lateral
    beacons are not near a topology crossing, so turning the rule on has
    nothing to act on here — the meaningful assertion is that the request
    still succeeds (200, not 500) with the flag plumbed all the way
    through config parsing -> `_plan_via_mivnav` -> `chartcore.
    mivnav_route`'s pyo3 boundary -> `build_directional_semantics` -> the
    topology diagnostics, and that (per `_plan_via_mivnav`'s docstring)
    the fine-search route is untouched. A real-TSS proof at this layer is
    not reachable over HTTP — see `chartcore/tests/mivnav_directional_
    us5oakee.rs` and the note in `mivnav_tss_us5oakee.rs`."""
    baseline = _plan(mivnav_client, _CHANNEL_NORTH, _BASIN, draft_m=0.5, debug=True)

    isolated_runtime.config.patch({"routing": {"mivnav_directional_rules": True}})
    on = _plan(mivnav_client, _CHANNEL_NORTH, _BASIN, draft_m=0.5, debug=True)
    d = on["debug_legs"][0]["mivnav"]

    assert d["topology_directional_penalized_portals"] == []
    assert d["topology_cost_mm"] == baseline["debug_legs"][0]["mivnav"]["topology_cost_mm"]
    assert on["waypoints"] == baseline["waypoints"]
    assert on["distance_nm"] == baseline["distance_nm"]


# -- the persisted `.mivnav` artifact: build it, then actually read it -----
#
# Everything below exercises the OTHER half of this algorithm, the one that
# makes it the v3 architecture rather than a diagnostics cross-check:
# `POST /routing/mivnav/build` publishes a real `.mivnav` for the real
# DE6OSTIM chart set, and the next `/routing/plan` LOADS it instead of
# rebuilding the region from the request's own cells.
#
# `chartcore/tests/mivnav_persist_de6ostim.rs` already proves the load
# equals the fresh build at the Rust layer, on this same real cell. These
# prove the same fact survives the whole backend stack — the path
# convention, the job runner, the pyo3 seam, and `_plan_via_mivnav`'s own
# chart-set resolution — AND that every way it can fail says so on the
# wire rather than quietly rebuilding.

_SET_ID = "oeuSENC-DE6OSTIM"


@pytest.fixture
def mivnav_artifact_client(ocharts_with_de6ostim: OchartsService, isolated_runtime, tmp_path):
    """`mivnav_client` plus an isolated `data_root`.

    The extra `data_root` patch is load-bearing, not tidiness: the
    artifact's path is derived from `data_root` alone
    (`mivnav.features.routing.mivnav_artifact.artifact_path`), and
    `isolated_runtime` is SESSION-scoped — without this every test in
    this file would share one artifact directory, so a build in one test
    would change what a later test's route request reads."""
    signalk = SignalKService(None)
    app.dependency_overrides[get_ocharts] = lambda: ocharts_with_de6ostim
    app.dependency_overrides[get_signalk] = lambda: signalk
    previous_data_root = str(isolated_runtime.config.get().data_root)
    isolated_runtime.config.patch(
        {
            "data_root": str(tmp_path / "artifact-data"),
            "routing": {
                "algorithm": "mivnav",
                "artifact_catzoc_allowance_mode": "off",
                "lateral_margin_m": 0.0,
                "default_draft_m": 0.5,
            },
        }
    )
    yield TestClient(app)
    isolated_runtime.config.patch(
        {
            "data_root": previous_data_root,
            "routing": {
                "algorithm": "raster",
                "artifact_catzoc_allowance_mode": "full",
                "artifact_endpoint_grace_radius_m": 150.0,
                "artifact_allow_restricted_entry": False,
                "lateral_margin_m": 30.0,
                "default_draft_m": 2.0,
                "under_keel_margin_m": 1.0,
                "air_draft_m": 0.0,
            },
        }
    )
    app.dependency_overrides.pop(get_ocharts, None)
    app.dependency_overrides.pop(get_signalk, None)
    signalk.close()


def _build_artifact(client: TestClient, **body) -> dict:
    """Trigger a build and poll to completion — the real endpoint pair, not
    the runner called directly, so the HTTP contract is what is under
    test. Measured on this fixture: the whole ten-band build of the real
    cell takes ~0.4s, so a 60s ceiling is a hang detector, not a timeout
    anyone should normally approach."""
    resp = client.post("/routing/mivnav/build", json=body)
    assert resp.status_code == 200, resp.text
    deadline = time.monotonic() + 60.0
    while time.monotonic() < deadline:
        status = client.get("/routing/mivnav/build")
        assert status.status_code == 200, status.text
        body_ = status.json()
        if body_["state"] in ("done", "error"):
            return body_
        time.sleep(0.02)
    raise AssertionError("the mivnav artifact build never finished")


def _mivnav_debug(client: TestClient, **kw) -> dict:
    body = _plan(client, _CHANNEL_NORTH, _BASIN, draft_m=0.5, debug=True, **kw)
    assert body["debug_legs"], body
    return body


def test_build_publishes_a_real_artifact_and_reports_the_whole_run(
    mivnav_artifact_client: TestClient, tmp_path: Path
) -> None:
    """The build trigger's headline proof: a real `.mivnav` appears on
    disk for the real chart set, and the job status carries §20's record
    per run.

    Every number is asserted, not just "state == done" — the report IS
    the point of the endpoint (CLAUDE.md's `#TSSLPT-OVERSCALE` entry: a
    build that silently saw nothing looks exactly like one that worked,
    unless something reports what it saw). The specific figures are the
    same ones `chartcore/tests/mivnav_persist_de6ostim.rs` and
    `cargo run --example mivnav_route` independently print for this cell,
    so a change in any of them is a real change in the build, not a
    change in this test's expectations."""
    status = _build_artifact(mivnav_artifact_client)

    assert status["state"] == "done", status
    assert status["error"] == "", status
    assert status["chart_set_id"] == _SET_ID
    assert status["chart_set_sequence"] > 0
    assert status["catzoc_allowance_mode"] == "off"

    published = Path(status["path"])
    assert published.is_file(), status
    assert published.parent == tmp_path / "artifact-data" / "routing" / "mivnav"
    assert published.name == f"{_SET_ID}.catzoc-off.mivnav"
    assert status["bytes"] == published.stat().st_size > 0

    # The real, measured figures for this real cell.
    assert status["cell_count"] == 1
    assert status["tile_count"] == 52
    assert status["total_cells"] == 3_407_872
    assert status["bands"] == 10
    assert status["portals"] > 0
    assert sum(status["tiles_per_rung"]) == status["tile_count"]
    assert len(status["tiles_per_rung"]) == len(status["resolution_ladder_m"])
    assert status["resolution_ladder_m"][0] == 2.0
    assert status["no_coverage_cells"] > 0  # §24: this cell is mostly ground
    assert status["charted_depth_cells"] > 0
    assert status["build_seconds"] > 0.0
    assert status["decode_seconds"] >= 0.0
    assert any("built" in line for line in status["log"]), status["log"]


def test_the_bake_reports_per_phase_progress_not_one_opaque_stage(
    mivnav_artifact_client: TestClient,
) -> None:
    """A national bake is minutes; it must not show one opaque "building"
    the whole time. ``chartcore.mivnav_build_artifact``'s ``progress``
    callback drives ``task``/``current``/``total`` and appends a log line
    per quadtree refine pass, per depth band, and around the file write —
    all through the same polled status blob the UI already renders.

    Asserted on the FINAL status because the fixture build is sub-second:
    the capped log (200 lines) still holds every line a build this small
    emits, so "did the phases report" is checkable after the fact."""
    status = _build_artifact(mivnav_artifact_client)
    assert status["state"] == "done", status
    log = status["log"]

    assert any("decoded" in line for line in log), log
    assert any(
        line.startswith("refine pass") or "leaf tiles" in line for line in log
    ), log
    # One line per depth band: "band <m> m: <c> components, <p> portals, ...".
    band_lines = [line for line in log if line.startswith("band ") and " m:" in line]
    assert len(band_lines) == status["bands"] == 10, (band_lines, log)
    assert all("shortcuts" in line for line in band_lines), band_lines
    assert any("writing .mivnav" in line for line in log), log
    # The last phase the build reported is the write.
    assert status["task"] == "writing artifact", status


def test_a_built_artifact_is_actually_read_and_agrees_with_the_rebuild(
    mivnav_artifact_client: TestClient,
) -> None:
    """The load-bearing proof of this whole wiring step, and the HTTP-level
    mirror of `mivnav_persist_de6ostim.rs`'s own claim: the topology
    answer read off the PUBLISHED artifact is identical to the one the
    same request computed by rebuilding the region from its own cells.

    Both halves matter. `topology_source` flipping `rebuilt` -> `artifact`
    proves the file is genuinely being read (without it, "the numbers
    match" would be satisfied by never opening it at all). The numbers
    matching proves it is being read CORRECTLY — a persisted region that
    disagreed with a fresh build would be exactly the silent-wrong-answer
    failure an acceleration structure must never have.

    **Why exact equality is the right assertion HERE and would not be in
    general.** The rebuild's region is the union of this REQUEST's
    candidate cells; the artifact's region is the whole CHART SET. On
    this fixture those are the same one cell, so every count must match
    exactly. On a real multi-cell set the artifact's region is strictly
    larger and its component/portal counts legitimately differ (it is
    more complete, not wrong) — so a future test on a bigger set must
    compare the ROUTE-relevant answer (`topology_route_found`, and the
    corridor containing the fine search's waypoints, as
    `chartcore/tests/mivnav_query_de6ostim.rs` does), not these
    region-wide totals."""
    before = _mivnav_debug(mivnav_artifact_client)["debug_legs"][0]["mivnav"]
    assert before["topology_source"] == "rebuilt", before
    assert "no .mivnav has been built" in (before["topology_fallback_reason"] or ""), before

    _build_artifact(mivnav_artifact_client)

    after = _mivnav_debug(mivnav_artifact_client)["debug_legs"][0]["mivnav"]
    assert after["topology_source"] == "artifact", after
    assert after["topology_fallback_reason"] is None, after

    for field in (
        "topology_band_m",
        "topology_components",
        "topology_portals",
        "topology_shortcuts",
        "topology_route_found",
        "topology_hops",
        "topology_cost_mm",
        "topology_corridor_bbox",
    ):
        assert after[field] == before[field], (field, before[field], after[field])


def test_mivnav_require_artifact_refuses_the_rebuild_then_allows_the_read(
    mivnav_artifact_client: TestClient, isolated_runtime
) -> None:
    """`RoutingConfig.mivnav_require_artifact` turns the silent rebuild
    fallback into a loud refusal, so a test (or a user testing) can be
    certain a `"mivnav"` request went through the persisted `.mivnav` and
    not the per-request topology rebuild. It changes NO route a boat gets
    — the rebuild produces the same fine-search route — so both halves
    are asserted: refused with the flag on and no artifact, served
    normally once one is built."""
    isolated_runtime.config.patch({"routing": {"mivnav_require_artifact": True}})

    # No artifact yet: the request is refused — straight line (the two
    # endpoints, unchanged) plus a warning that names the flag and the
    # reason. `debug_legs` still carries `topology_source == "rebuilt"`.
    refused = _plan(
        mivnav_artifact_client, _CHANNEL_NORTH, _BASIN, draft_m=0.5, debug=True
    )
    assert len(refused["waypoints"]) == 2, refused
    assert refused["waypoints"][0] == {"lat": _CHANNEL_NORTH["lat"], "lon": _CHANNEL_NORTH["lon"]}
    assert any(
        "mivnav_require_artifact is set" in w and "no .mivnav has been built" in w
        for w in refused["warnings"]
    ), refused["warnings"]
    assert refused["debug_legs"][0]["mivnav"]["topology_source"] == "rebuilt"

    # Build it, and the same request is served normally off the artifact.
    _build_artifact(mivnav_artifact_client)
    served = _plan(
        mivnav_artifact_client, _CHANNEL_NORTH, _BASIN, draft_m=0.5, debug=True
    )
    assert served["debug_legs"][0]["mivnav"]["topology_source"] == "artifact"
    assert not any("mivnav_require_artifact" in w for w in served["warnings"]), served["warnings"]
    # A real bent route, not the straight-line refusal.
    assert len(served["waypoints"]) > 2, served

    isolated_runtime.config.patch({"routing": {"mivnav_require_artifact": False}})


def test_a_second_request_reads_the_artifact_from_cache_not_from_disk(
    mivnav_artifact_client: TestClient,
) -> None:
    """`chartcore.mivnav_route` opens the `.mivnav` through a process-global
    cache keyed on `(path, sequence)` (`chartcore::mivnav::artifact_cache`),
    so a national artifact is `std::fs::read` + `load_region` + `load_band`
    once per build, not once per `/routing/plan` — the measured ~2 s /
    ~6 GB-per-request cost the go/no-go flipped on
    (`MIVNAV_ARTIFACT_TODO.md`).

    Two requests against the same built artifact: both answered off the
    artifact, byte-identical topology, and the SECOND added a cache hit
    with no new miss (no file read, no region decode)."""
    _build_artifact(mivnav_artifact_client)

    hits0, misses0 = chartcore.mivnav_artifact_cache_stats()
    first = _mivnav_debug(mivnav_artifact_client)["debug_legs"][0]["mivnav"]
    hits1, misses1 = chartcore.mivnav_artifact_cache_stats()
    second = _mivnav_debug(mivnav_artifact_client)["debug_legs"][0]["mivnav"]
    hits2, misses2 = chartcore.mivnav_artifact_cache_stats()

    assert first["topology_source"] == second["topology_source"] == "artifact"
    for field in (
        "topology_components",
        "topology_portals",
        "topology_shortcuts",
        "topology_route_found",
        "topology_hops",
        "topology_cost_mm",
        "topology_corridor_bbox",
    ):
        assert first[field] == second[field], (field, first[field], second[field])

    # The second request against an unchanged artifact does NO disk read
    # and IS served from the cache.
    assert misses2 == misses1, ("second request re-read the file", misses1, misses2)
    assert hits2 > hits1, ("second request was not a cache hit", hits1, hits2)
    # The first request after a build reads the new file at most once
    # (its key was evicted/absent), never repeatedly.
    assert misses1 - misses0 <= 1, ("first request read more than once", misses0, misses1)


def test_reading_the_artifact_does_not_change_the_route_itself(
    mivnav_artifact_client: TestClient,
) -> None:
    """`test_plan_via_mivnav_matches_plan_via_artifact_byte_for_byte` pins
    "mivnav == artifact" for the same request; this pins the other half of
    that claim now that a second data source exists — the topology layer
    still only cross-checks, so where its numbers came FROM cannot move
    the waypoints. If this ever fails, that is the finding, not something
    to weaken."""
    before = _plan(mivnav_artifact_client, _CHANNEL_NORTH, _BASIN, draft_m=0.5)
    _build_artifact(mivnav_artifact_client)
    after = _plan(mivnav_artifact_client, _CHANNEL_NORTH, _BASIN, draft_m=0.5)

    assert after["waypoints"] == before["waypoints"]
    assert after["distance_nm"] == before["distance_nm"]
    assert after["approximate_legs"] == before["approximate_legs"]
    assert after["check_manually_legs"] == before["check_manually_legs"]


def test_a_stale_artifact_is_refused_by_name_and_warned_about(
    mivnav_artifact_client: TestClient, ocharts_with_de6ostim: OchartsService, tmp_path: Path
) -> None:
    """The failure mode this whole design exists to make impossible to
    miss: an artifact that IS on disk, is out of date, and is therefore
    not used.

    Moving the chart set's own `sequence` (the max mtime over its
    directory — the same number that already invalidates the tile cache)
    is exactly what a chart update does. The request must then (a) NOT use
    the stale file, (b) name WHICH component is stale rather than a bare
    boolean, and (c) say so in a user-facing warning — CLAUDE.md's
    `#TSSLPT-OVERSCALE` entry is the same shape one layer up, where the
    only symptom of a silently-stale cache was that a real fix appeared to
    do nothing."""
    _build_artifact(mivnav_artifact_client)
    fresh = _mivnav_debug(mivnav_artifact_client)["debug_legs"][0]["mivnav"]
    assert fresh["topology_source"] == "artifact", fresh

    # A chart update, mechanically: bump the set directory's own max
    # mtime, then force the store to rescan (its rate limit would
    # otherwise keep serving the cached sequence).
    set_dir = tmp_path / "ocharts" / _SET_ID
    bumped = max(p.stat().st_mtime_ns for p in [set_dir, *set_dir.iterdir()]) + 5_000_000_000
    os.utime(set_dir / "keys.xml", ns=(bumped, bumped))
    ocharts_with_de6ostim.invalidate()

    body = _mivnav_debug(mivnav_artifact_client)
    stale = body["debug_legs"][0]["mivnav"]
    assert stale["topology_source"] == "rebuilt", stale
    reason = stale["topology_fallback_reason"] or ""
    assert "sequence" in reason, reason
    assert any("was not used" in w for w in body["warnings"]), body["warnings"]
    assert any(reason in w for w in body["warnings"]), body["warnings"]

    # And the rebuild still answers — a stale artifact costs the
    # precomputation, never the route.
    assert stale["topology_route_found"] is True, stale
    assert body["waypoints"] == _plan(
        mivnav_artifact_client, _CHANNEL_NORTH, _BASIN, draft_m=0.5
    )["waypoints"]


def test_no_artifact_falls_back_quietly_but_says_so_in_the_diagnostics(
    mivnav_artifact_client: TestClient,
) -> None:
    """The DEFAULT state of a boat that has never run a build: rebuild,
    name the reason in the diagnostics, and do NOT add a user-facing
    warning. Deliberately different from the stale case above — "you have
    not built one" is not a safety signal, and warning about it on every
    route would be noise a helmsman learns to ignore, which is how a real
    warning gets missed."""
    body = _mivnav_debug(mivnav_artifact_client)
    d = body["debug_legs"][0]["mivnav"]
    assert d["topology_source"] == "rebuilt"
    assert "no .mivnav has been built" in (d["topology_fallback_reason"] or "")
    assert not any("was not used" in w for w in body["warnings"]), body["warnings"]


def test_artifacts_listing_reports_missing_then_usable(
    mivnav_artifact_client: TestClient,
) -> None:
    """`GET /routing/mivnav/artifacts` is how you ask "is there a usable
    artifact" WITHOUT planning a route first — the surface that makes the
    route path's fallback checkable rather than merely honest."""
    before = mivnav_artifact_client.get("/routing/mivnav/artifacts")
    assert before.status_code == 200, before.text
    listing = before.json()
    assert listing["catzoc_allowance_mode"] == "off"
    assert len(listing["artifacts"]) == 1
    entry = listing["artifacts"][0]
    assert entry["chart_set_id"] == _SET_ID
    assert entry["cells"] == 1
    assert entry["present"] is False
    assert entry["usable"] is False
    assert entry["kind"] == "missing"

    _build_artifact(mivnav_artifact_client)

    entry = mivnav_artifact_client.get("/routing/mivnav/artifacts").json()["artifacts"][0]
    assert entry["present"] is True
    assert entry["usable"] is True
    assert entry["kind"] is None
    assert entry["reason"] is None
    assert entry["built_sequence"] == entry["current_sequence"]


def test_an_artifact_built_under_another_catzoc_mode_is_not_used(
    mivnav_artifact_client: TestClient, isolated_runtime
) -> None:
    """The one build-time policy the `.mivnav` header does NOT record.

    `catzoc_allowance_mode` is a survey-confidence policy baked into every
    cell of the artifact, and `staleness()` cannot see it — so the mode is
    part of the file NAME instead (see `mivnav.features.routing.
    mivnav_artifact`). Switching modes must therefore read as "no artifact
    for this mode", never as "here is one, close enough": serving an
    artifact built under `off` to a request running `full` is precisely
    the bug code review already found once inside chartcore's own
    `topology_diagnostics` — the cross-check silently answering under a
    laxer hazard policy than the search it is checking."""
    _build_artifact(mivnav_artifact_client)
    assert (
        _mivnav_debug(mivnav_artifact_client)["debug_legs"][0]["mivnav"]["topology_source"]
        == "artifact"
    )

    isolated_runtime.config.patch({"routing": {"artifact_catzoc_allowance_mode": "half"}})
    listing = mivnav_artifact_client.get("/routing/mivnav/artifacts").json()
    assert listing["catzoc_allowance_mode"] == "half"
    assert listing["artifacts"][0]["kind"] == "missing", listing


def test_build_refuses_an_unknown_chart_set(mivnav_artifact_client: TestClient) -> None:
    resp = mivnav_artifact_client.post(
        "/routing/mivnav/build", json={"chart_set_id": "not-installed"}
    )
    assert resp.status_code == 409, resp.text
    assert "not-installed" in resp.json()["detail"]


def test_build_refuses_a_chart_set_id_that_is_not_a_path_token(
    mivnav_artifact_client: TestClient,
) -> None:
    """A traversal guard, not a formality: the id reaches
    `artifact_path` straight off this request body. Refused BEFORE the
    job starts, so it is a 4xx to the caller rather than a background
    failure they have to poll for."""
    resp = mivnav_artifact_client.post(
        "/routing/mivnav/build", json={"chart_set_id": "../../etc/passwd"}
    )
    # 409 (no such installed set) is reached first — which is the real
    # guard: only an INSTALLED set can be built, and the store's own id
    # rule already excludes anything that is not a plain token.
    assert resp.status_code in (409, 422), resp.text


def test_cancelling_when_nothing_runs_is_a_409(mivnav_artifact_client: TestClient) -> None:
    resp = mivnav_artifact_client.post("/routing/mivnav/build/cancel")
    assert resp.status_code == 409, resp.text


def test_build_status_is_always_pollable_and_well_formed(
    mivnav_artifact_client: TestClient,
) -> None:
    """The status endpoint must always answer with the full typed blob,
    never a 404 — a UI polls it before it has ever triggered anything.

    Deliberately does NOT assert `state == "idle"`: the build runner is a
    per-PROCESS singleton (see `mivnav.features.routing.runtime`), so in a
    test session where an earlier test already built something this
    reports that build's own finished status, which is correct behaviour
    and not something to isolate away — it is exactly what a second HTTP
    client would see on the real boat."""
    body = mivnav_artifact_client.get("/routing/mivnav/build").json()
    assert body["state"] in ("idle", "fetch", "bake", "done", "error")
    for key in ("chart_set_id", "catzoc_allowance_mode", "path", "error", "detail"):
        assert isinstance(body[key], str), (key, body)
    for key in ("tile_count", "total_cells", "bands", "portals", "bytes", "cell_count"):
        assert isinstance(body[key], int), (key, body)
    assert isinstance(body["tiles_per_rung"], list)
    assert isinstance(body["log"], list)


@pytest.fixture
def ocharts_with_two_overlapping_sets(tmp_path: Path) -> OchartsService:
    """The SAME real cell installed as two separate chart sets, so one
    corridor genuinely has two sets covering it.

    Contrived on purpose — DE6OSTIM and DE6OSBRH are 100 km apart, so no
    pair of the committed real fixtures overlaps — but every other part
    of the path is real: two real set directories, two real header
    scans, one real corridor selection. What is under test is the
    SELECTION rule, not the geometry.

    Its own sets directory (`two-sets/`, not the `ocharts/` the other
    fixtures use): both live under the same `tmp_path`, and a store
    scanning a shared directory would also pick up
    `ocharts_with_de6ostim`'s set — which `mivnav_artifact_client`
    creates — making this a THREE-set case by accident."""
    for set_id in ("oeuSENC-DE6OSTIM-a", "oeuSENC-DE6OSTIM-b"):
        set_dir = tmp_path / "two-sets" / set_id
        set_dir.mkdir(parents=True)
        shutil.copy(_FNC_FIXTURE, set_dir / "DE6OSTIM.senc")
        (set_dir / "keys.xml").write_text(
            "<keyList><Chart><FileName>DE6OSTIM</FileName>"
            "<RInstallKey>fabricated</RInstallKey></Chart>"
            f"<ChartInfo>{set_id}</ChartInfo><Edition>2026/01-1</Edition></keyList>"
        )
    return OchartsService(
        sets_dir=tmp_path / "two-sets",
        daemon_dir=tmp_path / "two-sets-daemon",
        work_dir=tmp_path / "two-sets-work",
        warm_overview=False,
    )


def test_a_corridor_spanning_two_chart_sets_uses_no_artifact_and_says_so(
    ocharts_with_two_overlapping_sets: OchartsService,
    mivnav_artifact_client: TestClient,
    isolated_runtime,
) -> None:
    """A `.mivnav` covers ONE chart set. A request whose corridor reads
    cells from two of them has no artifact that covers what the fine
    search can see — so the topology layer must rebuild, and must NAME
    that as the reason rather than quietly using a partial artifact for
    one of the two.

    Also proves the build endpoint refuses to guess in the same
    situation: with two sets installed, omitting `chart_set_id` is a 409,
    not "pick the first one" (building the wrong one costs minutes of Pi
    CPU and leaves the one you wanted still unbuilt)."""
    app.dependency_overrides[get_ocharts] = lambda: ocharts_with_two_overlapping_sets

    assert mivnav_artifact_client.post("/routing/mivnav/build", json={}).status_code == 409

    # Build BOTH, so "no artifact exists" cannot be what this measures.
    for set_id in ("oeuSENC-DE6OSTIM-a", "oeuSENC-DE6OSTIM-b"):
        status = _build_artifact(mivnav_artifact_client, chart_set_id=set_id)
        assert status["state"] == "done", status

    d = _mivnav_debug(mivnav_artifact_client)["debug_legs"][0]["mivnav"]
    assert d["topology_source"] == "rebuilt", d
    assert "spans 2 chart sets" in (d["topology_fallback_reason"] or ""), d
    assert d["topology_route_found"] is True, d


def test_coarse_fallback_reports_a_disconnected_portal_graph_at_this_draft(
    mivnav_artifact_client: TestClient,
) -> None:
    """Fine search finds no path AND the built `.mivnav`'s portal graph
    has no connection at the requested draft (this harbour's portals cap
    at ~2 m) — the coarse fallback must say exactly that, as a straight
    line, not a generic "no path" or a 500. The `mivnav_coarse` timing
    line records the disconnection too."""
    _build_artifact(mivnav_artifact_client)
    body = _plan(
        mivnav_artifact_client, _CHANNEL_SOUTH, _BASIN, draft_m=8.0, debug=True
    )
    assert len(body["waypoints"]) == 2, body
    assert body["approximate_legs"] == [True], body
    assert any(
        "portal graph has no connection" in w and "at this draft" in w
        for w in body["warnings"]
    ), body["warnings"]
    assert any(
        t["step"] == "mivnav_coarse" and "no portal path" in t["detail"]
        for t in body["timings"]
    ), body["timings"]


def test_stitch_mivnav_coarse_route_concatenates_real_per_leg_fine_searches(
    ocharts_with_de6ostim: OchartsService,
) -> None:
    """`_stitch_mivnav_coarse_route`'s own contract, isolated from the
    artifact machinery: given a coarse `(lon, lat)` guide whose every
    consecutive pair IS routable by the fine search, it returns one
    `StitchedRoute` from `from` to `to` with the per-leg searches
    concatenated (no duplicated shared point) and a real summed distance.
    CHANNEL_SOUTH -> CHANNEL_NORTH -> BASIN are three known-navigable
    points on this cell; each leg routes on its own. This is the
    multi-leg path DE6OSTIM is too small to trigger through the full
    HTTP route (one harbour, no landmass to detour) — exercised directly
    here, end-to-end against the real DK artifact left as the manual
    check."""
    from mivnav.features.routing.config import RoutingConfig
    from mivnav.features.routing.hazards import Timings
    from mivnav.features.routing.routes import _stitch_mivnav_coarse_route

    cfg = RoutingConfig(artifact_catzoc_allowance_mode="off", lateral_margin_m=0.0)
    guide = [
        (_CHANNEL_SOUTH["lon"], _CHANNEL_SOUTH["lat"]),
        (_CHANNEL_NORTH["lon"], _CHANNEL_NORTH["lat"]),
        (_BASIN["lon"], _BASIN["lat"]),
    ]
    stitched, debug_legs = _stitch_mivnav_coarse_route(
        ocharts_with_de6ostim,
        guide,
        required_depth_m=0.5,
        cfg=cfg,
        timings=Timings(),
    )
    assert stitched is not None
    assert debug_legs == [], "no leg failed, so no debug payload"
    assert len(stitched.waypoints) >= 3, stitched.waypoints
    assert stitched.distance_m > 0
    # One flag per leg, both arrays, matching the concatenated leg count.
    assert len(stitched.approximate_legs) == len(stitched.waypoints) - 1
    assert len(stitched.check_manually_legs) == len(stitched.waypoints) - 1
    # Endpoints are the SNAPPED start/destination (not the raw guide
    # points) — the segments the fine search actually verified — and land
    # within a cell or so of what was asked for.
    first_lon, first_lat = stitched.waypoints[0]
    last_lon, last_lat = stitched.waypoints[-1]
    assert haversine_m(Point(first_lat, first_lon), Point(*reversed(guide[0]))) < 500
    assert haversine_m(Point(last_lat, last_lon), Point(*reversed(guide[-1]))) < 500
    # The shared coarse point (CHANNEL_NORTH) is not duplicated at the
    # leg seam — consecutive waypoints are never equal.
    assert all(
        stitched.waypoints[k] != stitched.waypoints[k + 1]
        for k in range(len(stitched.waypoints) - 1)
    ), stitched.waypoints


def test_stitch_collects_a_debug_bundle_for_a_leg_the_fine_search_rejects(
    ocharts_with_de6ostim: OchartsService,
) -> None:
    """With `collect_debug`, a stitch leg that the fine search cannot
    follow contributes one `find_artifact_route_debug` payload — WHICH
    failure point fired, the constraint rings, the search grid — for the
    route-test overlay. Forced deterministically with an absurd
    `required_depth_m`: no cell of this 4 m harbour clears a 50 m draft,
    so the single CHANNEL_SOUTH -> BASIN leg (the destination, so no
    recovery skip) fails and the stitch returns `None`."""
    from mivnav.features.routing.config import RoutingConfig
    from mivnav.features.routing.hazards import Timings
    from mivnav.features.routing.routes import _stitch_mivnav_coarse_route

    cfg = RoutingConfig(artifact_catzoc_allowance_mode="off", lateral_margin_m=0.0)
    guide = [
        (_CHANNEL_SOUTH["lon"], _CHANNEL_SOUTH["lat"]),
        (_BASIN["lon"], _BASIN["lat"]),
    ]
    stitched, debug_legs = _stitch_mivnav_coarse_route(
        ocharts_with_de6ostim,
        guide,
        required_depth_m=50.0,
        cfg=cfg,
        timings=Timings(),
        collect_debug=True,
    )
    assert stitched is None
    assert len(debug_legs) == 1
    leg = debug_legs[0]
    assert leg["reason"] in {"start_blocked", "goal_blocked", "severed", "no_field"}
    assert leg["from"] == [_CHANNEL_SOUTH["lon"], _CHANNEL_SOUTH["lat"]]
    assert "hard" in leg["constraint_rings"]
    assert "charted_depth" in leg["constraint_rings"]
    if leg["field"] is not None:
        assert isinstance(leg["field"]["codes_b64"], str)
        assert leg["field"]["cols"] > 0 and leg["field"]["rows"] > 0
        assert len(leg["field"]["corners"]) == 4

    # And with debug OFF the failure path allocates nothing.
    _, no_debug = _stitch_mivnav_coarse_route(
        ocharts_with_de6ostim, guide, required_depth_m=50.0, cfg=cfg, timings=Timings()
    )
    assert no_debug == []


def test_coarse_fallback_without_a_single_set_artifact_names_the_build_endpoint(
    ocharts_with_two_overlapping_sets: OchartsService,
    mivnav_artifact_client: TestClient,
    isolated_runtime,
) -> None:
    """Fine search finds no path, the corridor spans two chart sets, and
    NEITHER has a `.mivnav` built — so the coarse fallback has no
    dominant built artifact to route around with either. Honest straight
    line, points at the build endpoint, never a 500."""
    app.dependency_overrides[get_ocharts] = lambda: ocharts_with_two_overlapping_sets
    body = _plan(
        mivnav_artifact_client, _CHANNEL_SOUTH, _BASIN, draft_m=8.0
    )
    assert len(body["waypoints"]) == 2, body
    assert any(
        "no chart set with a built .mivnav covers this route" in w
        and "POST /routing/mivnav/build" in w
        for w in body["warnings"]
    ), body["warnings"]


def test_coarse_fallback_uses_the_dominant_built_set_when_the_bbox_clips_another(
    ocharts_with_two_overlapping_sets: OchartsService,
    mivnav_artifact_client: TestClient,
    isolated_runtime,
) -> None:
    """A fat corridor bbox clipping a second installed set's border cells
    must NOT disqualify the coarse fallback: with one of the two sets'
    `.mivnav` built, a fine-search miss routes the coarse guide against
    THAT set (`_dominant_built_mivnav_artifact`), not straight to a line.
    The draft here still leaves this harbour's ~2 m portal graph
    disconnected, so the end result is a straight line — but the timing
    trail proves the dominant built set was resolved and queried, which
    is the wiring under test."""
    app.dependency_overrides[get_ocharts] = lambda: ocharts_with_two_overlapping_sets
    status = _build_artifact(mivnav_artifact_client, chart_set_id="oeuSENC-DE6OSTIM-a")
    assert status["state"] == "done", status

    body = _plan(
        mivnav_artifact_client, _CHANNEL_SOUTH, _BASIN, draft_m=8.0, debug=True
    )
    assert any(
        t["step"] == "mivnav_coarse_artifact" and "oeuSENC-DE6OSTIM-a" in t["detail"]
        for t in body["timings"]
    ), body["timings"]
    assert any(t["step"] == "mivnav_coarse" for t in body["timings"]), body["timings"]


class _OchartsWithOneUndecodableCell:
    """The real service, with `load_cell` sabotaged for one named cell.

    Duck-typed exactly the way `mivnav.features.routing.hazards` and
    `artifact_build` already take their `ocharts` parameter, so nothing
    is mocked out of the path except the single failure being injected.
    A genuinely undecodable cell cannot be fabricated as a fixture: a
    file that will not read is dropped at the header scan and never
    reaches `cs.cells` at all, so the case this guards — header fine,
    full decode fails, e.g. a transient oexserverd fault mid-build —
    has to be injected here."""

    def __init__(self, inner: OchartsService, fail_cell: str) -> None:
        self._inner = inner
        self._fail_cell = fail_cell

    def sets(self):
        return self._inner.sets()

    def load_cell(self, cs, cell):
        if cell.path.name == self._fail_cell:
            raise RuntimeError("simulated decode failure (a transient daemon fault)")
        return self._inner.load_cell(cs, cell)


def test_a_cell_that_will_not_decode_fails_the_build_instead_of_publishing_half(
    ocharts_with_de6ostim: OchartsService, mivnav_artifact_client: TestClient, tmp_path: Path
) -> None:
    """The most dangerous thing this endpoint could do, and does not.

    A route request drops an undecodable cell and carries on — correct
    there, since the selection is per-request and nothing persists it.
    An ARTIFACT is a durable region-wide claim, and the file records only
    `(chart_set_id, sequence)`, so `staleness()` can never notice it
    covers fewer cells than the set does. Publishing a partial region
    would therefore be permanently invisible: `GET /routing/mivnav/
    artifacts` would report `usable: true` and every route would trust
    it. That is exactly CLAUDE.md's `#TSSLPT-OVERSCALE` shape, so the
    build must FAIL, name the cells, and leave nothing behind."""
    app.dependency_overrides[get_ocharts] = lambda: _OchartsWithOneUndecodableCell(
        ocharts_with_de6ostim, "DE6OSTIM.senc"
    )

    status = _build_artifact(mivnav_artifact_client)

    assert status["state"] == "error", status
    assert "would not decode" in status["error"], status
    assert "DE6OSTIM.senc" in status["error"], status
    assert status["skipped_cells"] == 1, status
    assert status["cell_count"] == 0, status
    # Nothing published, and the status endpoint still says so.
    assert not (tmp_path / "artifact-data" / "routing" / "mivnav").exists()
    entry = mivnav_artifact_client.get("/routing/mivnav/artifacts").json()["artifacts"][0]
    assert entry["usable"] is False and entry["kind"] == "missing", entry


def test_the_config_guard_refuses_a_chart_config_patch_while_a_build_runs() -> None:
    """A build holds the `OchartsService` it was handed and decodes
    through it for minutes; a `PATCH /config` touching the ocharts slice
    or `data_root` rebuilds that service and CLOSES the one still in use
    (and moves where the build is about to publish). Same veto hook, and
    the same "only patches that would actually rebuild it" narrowness, as
    `mivnav.features.ocharts.runtime.ocharts_guard`.

    A unit test of the predicate rather than a race against a real 0.4s
    build — the thing worth pinning is WHICH patches it vetoes, and a
    timing-dependent version of this would be flaky without testing
    anything more."""
    from mivnav.config.model import Config
    from mivnav.features.routing.runtime import routing_guard

    class _Runtime:
        def __init__(self, busy: bool) -> None:
            self._busy = busy

        def build_busy(self) -> bool:
            return self._busy

    current = Config()
    same = Config()
    moved_root = current.model_copy(update={"data_root": current.data_root / "elsewhere"})
    other_ocharts = current.model_copy(
        update={
            "ocharts": current.ocharts.model_copy(
                update={"rescan_interval_s": current.ocharts.rescan_interval_s + 1}
            )
        }
    )

    # Idle: nothing is ever vetoed.
    assert routing_guard(_Runtime(False), current, moved_root) is None
    assert routing_guard(_Runtime(False), current, other_ocharts) is None

    # Busy: only patches that would rebuild the service/move the output.
    assert routing_guard(_Runtime(True), current, same) is None
    for candidate in (moved_root, other_ocharts):
        reason = routing_guard(_Runtime(True), current, candidate)
        assert reason is not None and "build is running" in reason, reason
