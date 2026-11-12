# SPDX-License-Identifier: GPL-2.0-only
"""``POST /routing/plan`` — the request/response contract, and the real
hazard-avoiding search now wired in.

Pins the shape the frontend builds against (first block below), then
proves the search itself is genuinely live — using the real
``backend/data/fnc/DE6OSTIM.S57`` fixture (a real, small, CC0
freenauticalchart.net cell; renamed to ``.senc`` the same way
``mivnav.features.ocharts.fnc.normalize_cells`` does, since chartcore
classifies a cell by extension), not a synthetic one: ``senc_fixture.py``'s
``SencWriter`` only ports point-geometry records, and a hazard is by
definition an area or a buffered point/line, so a real cell is the
practical way to exercise ``chartcore.shortest_path`` against actual
depth/land polygons rather than a purpose-built stub. See
``mivnav/features/routing/routes.py``'s module docstring and
``ROUTING_TODO.md`` at the repo root.
"""

from __future__ import annotations

import logging.handlers
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mivnav.api.app import app
from mivnav.api.charts import get_ocharts
from mivnav.api.deps import get_signalk
from mivnav.features.ocharts.service import OchartsService
from mivnav.signalk import SignalKService

client = TestClient(app)

_OAKLAND = {"lat": 37.79, "lon": -122.35}
_ALCATRAZ = {"lat": 37.83, "lon": -122.42}

_FNC_FIXTURE = Path(__file__).resolve().parents[1] / "data" / "fnc" / "DE6OSTIM.S57"


def _same_point(a: dict, b: dict, *, abs_deg: float = 1e-4) -> bool:
    """Are `a`/`b` (``{"lat": ..., "lon": ...}``) the same point, within
    `abs_deg` degrees? Not bit-exact on purpose — see
    ``test_plan_returns_the_two_endpoints_as_waypoints_with_nothing_in_the_way``'s
    docstring for why a route's waypoints never round-trip bit-exact."""
    return abs(a["lat"] - b["lat"]) <= abs_deg and abs(a["lon"] - b["lon"]) <= abs_deg


def test_plan_returns_the_two_endpoints_as_waypoints_with_nothing_in_the_way() -> None:
    # No o-charts data loaded for the default `get_ocharts` dependency in
    # this block, so the search has nothing to avoid and returns the plain
    # two-point line — but not BIT-exact: `chartcore.shortest_path`'s
    # waypoints round-trip through world coordinates and back
    # (`worldx_to_lon`/`worldy_to_lat`), which loses sub-metre precision
    # (~7cm) even for an unobstructed line — see `hazard_contains_scaled`'s
    # docs in `chartcore/src/routing/hazards.rs` for why that's inherent,
    # not a bug.
    resp = client.post("/routing/plan", json={"from": _OAKLAND, "to": _ALCATRAZ})
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["waypoints"]) == 2
    assert _same_point(body["waypoints"][0], _OAKLAND)
    assert _same_point(body["waypoints"][1], _ALCATRAZ)


def test_plan_reports_great_circle_distance() -> None:
    resp = client.post("/routing/plan", json={"from": _OAKLAND, "to": _ALCATRAZ})
    body = resp.json()
    # ~4.5 nm between these two points; a loose bound so this isn't pinned
    # to a specific distance implementation's last decimal.
    assert 4.0 < body["distance_nm"] < 5.0


def test_plan_warns_that_no_rules_stage_exists_yet() -> None:
    resp = client.post("/routing/plan", json={"from": _OAKLAND, "to": _ALCATRAZ})
    warnings = resp.json()["warnings"]
    assert any("traffic-lane" in w for w in warnings), warnings


def test_plan_rejects_unknown_fields() -> None:
    resp = client.post(
        "/routing/plan", json={"from": _OAKLAND, "to": _ALCATRAZ, "profile": {}}
    )
    assert resp.status_code == 422


def test_plan_rejects_out_of_range_coordinates() -> None:
    resp = client.post(
        "/routing/plan", json={"from": {"lat": 91, "lon": 0}, "to": _ALCATRAZ}
    )
    assert resp.status_code == 422


# -- real hazard-avoiding routing, against the real DE6OSTIM fixture --------


@pytest.fixture
def ocharts_with_de6ostim(tmp_path: Path) -> OchartsService:
    """A real ``OchartsService`` serving one real, unencrypted cell — same
    shape as ``test_ocharts_s52.py``'s ``service_for``/``make_set``, but
    with the real FNC fixture instead of a synthesized one (see the module
    docstring for why)."""
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
def hazard_client(ocharts_with_de6ostim: OchartsService):
    """``TestClient`` wired to the real fixture set above and a live-but-
    fixless ``SignalKService`` — same override-the-two-dependencies-
    directly shape as ``test_autopilot.py``'s ``engage_client``, for the
    same reason: the behaviour under test lives at exactly this seam, not
    somewhere a full config-derived ``Runtime`` would also exercise."""
    signalk = SignalKService(None)
    app.dependency_overrides[get_ocharts] = lambda: ocharts_with_de6ostim
    app.dependency_overrides[get_signalk] = lambda: signalk
    yield TestClient(app)
    app.dependency_overrides.pop(get_ocharts, None)
    app.dependency_overrides.pop(get_signalk, None)
    signalk.close()


# DE6OSTIM's land polygon (0m safety depth, 0m margin) sits at roughly
# (11.372, 53.989)-(11.377, 53.993) — measured directly against the real
# fixture (`chartcore.Cell.hazard_index(3.0, 0.0).extent()`), not guessed.
# A line straight across it at the vertical midpoint must cross land
# regardless of draft; a point well inside it is unsafe at any plausible
# draft; a line well outside the whole cell's extent must not be affected
# at all.
_LAND_BBOX = (11.3718, 53.9895, 11.3770, 53.9932)  # (w, s, e, n)
_ACROSS_THE_LAND = (
    {"lat": 53.9913, "lon": 11.3712},
    {"lat": 53.9913, "lon": 11.3790},
)
# Same shore, wider either side of `_LAND_BBOX` than `_ACROSS_THE_LAND` —
# for the handful of tests below whose own premise needs BOTH ends to be
# genuinely safe water, not just outside the land polygon itself.
# `_ACROSS_THE_LAND[0]` (11.3712) is, measured directly: it sits inside a
# real charted DEPARE band (drval1=0.0, a drying/shallow strip that hugs
# this coastline well past LNDARE's own edge — `chartcore::routing::
# hazards`' own drval1-based DEPARE fix correctly catches it, this isn't a
# fixture bug). `_ACROSS_THE_LAND` itself is left exactly as-is — most
# tests below only care that the line between its two points crosses real
# land, not that either endpoint is itself safe, and changing a constant
# this widely reused is its own risk independent of this one.
_CLEAR_OF_THE_LAND = (
    {"lat": 53.9913, "lon": 11.3680},
    {"lat": 53.9913, "lon": 11.3810},
)
_INSIDE_THE_LAND = {"lat": 53.9910, "lon": 11.3750}
_FAR_FROM_ANY_CHART = (
    {"lat": 37.79, "lon": -122.35},
    {"lat": 37.83, "lon": -122.42},
)


def _waypoint_in_land_bbox(wp: dict) -> bool:
    w, s, e, n = _LAND_BBOX
    return w <= wp["lon"] <= e and s <= wp["lat"] <= n


def test_plan_routes_around_real_land_instead_of_crossing_it(
    hazard_client: TestClient,
) -> None:
    a, b = _ACROSS_THE_LAND
    resp = hazard_client.post("/routing/plan", json={"from": a, "to": b})
    assert resp.status_code == 200
    body = resp.json()
    # Genuinely bent, not just the two original endpoints relabelled — and
    # not routed straight through the charted island either. The exact
    # every-leg-is-hazard-free proof already lives at the chartcore level
    # (`chartcore/tests/routing_de6ostim.rs`); this is the HTTP-level proof
    # that the wiring itself produces that route, not the old straight
    # line.
    assert len(body["waypoints"]) > 2, body
    assert not any(_waypoint_in_land_bbox(wp) for wp in body["waypoints"]), body
    assert body["distance_nm"] > 0


# -- /routing/verify: exact per-leg check of a caller-supplied route --------
#
# ROUTING_TODO.md's standalone route-safety-check item: unlike `/plan`, this
# endpoint never searches or simplifies anything — it reports back exactly
# the legs it was given, flagged or not.


def test_verify_flags_a_leg_that_crosses_real_land(hazard_client: TestClient) -> None:
    a, b = _ACROSS_THE_LAND
    resp = hazard_client.post("/routing/verify", json={"waypoints": [a, b]})
    assert resp.status_code == 200
    body = resp.json()
    assert body["flagged_legs"] == [True]
    assert body["safe"] is False
    assert len(body["reasons"]) == 1
    assert "charted danger" in body["reasons"][0]


def test_verify_reason_text_does_not_claim_anything_was_routed(hazard_client: TestClient) -> None:
    # The whole point of this endpoint having its own reason text (not
    # `/plan`'s `_unreachable_reason`/`_midroute_reason`): nothing here was
    # ever auto-routed, so neither "routed as close as possible" nor "at
    # this route's grid resolution" may appear.
    a, b = _ACROSS_THE_LAND
    resp = hazard_client.post("/routing/verify", json={"waypoints": [a, b]})
    reason = resp.json()["reasons"][0]
    assert "routed" not in reason
    assert "grid resolution" not in reason


def test_verify_passes_a_clear_line(hazard_client: TestClient) -> None:
    resp = hazard_client.post("/routing/verify", json={"waypoints": list(_FAR_FROM_ANY_CHART)})
    assert resp.status_code == 200
    body = resp.json()
    assert body["flagged_legs"] == [False]
    assert body["safe"] is True
    assert body["reasons"] == []


def test_verify_reports_every_leg_in_the_same_order_as_the_request(hazard_client: TestClient) -> None:
    a, b = _CLEAR_OF_THE_LAND
    clear = _FAR_FROM_ANY_CHART[0]
    # clear -> across-land-leg -> clear: three waypoints the caller chose,
    # in this exact order — the response must not reorder, drop, or add to
    # them (contrast `/plan`, which can legitimately do all three).
    resp = hazard_client.post("/routing/verify", json={"waypoints": [clear, a, b]})
    assert resp.status_code == 200
    body = resp.json()
    assert body["flagged_legs"] == [False, True]
    assert body["safe"] is False


def test_verify_flags_a_waypoint_itself_inside_charted_danger(hazard_client: TestClient) -> None:
    outside = _FAR_FROM_ANY_CHART[0]
    resp = hazard_client.post("/routing/verify", json={"waypoints": [outside, _INSIDE_THE_LAND]})
    assert resp.status_code == 200
    body = resp.json()
    assert body["flagged_legs"] == [True]
    assert "is itself inside charted danger" in body["reasons"][0]


def test_verify_wires_check_manually_legs(hazard_client: TestClient) -> None:
    # DE6OSTIM charts neither UNSARE nor a BRIDGE (measured: `Cell.
    # unsurveyed_union()`/`openable_bridge_union()` are both `None` for
    # this fixture) — a wiring regression guard, not a proof of the
    # underlying detection logic (that's `chartcore::routing::hazards`'
    # own `an_openable_bridge_the_boat_cannot_clear_closed_is_not_a_hard_
    # block`/`unsurveyed_area_is_never_a_hard_block` and friends): the
    # field must still be PRESENT, real-shaped, and all-`False` here,
    # never dropped or mis-lengthed for a chart with nothing to flag.
    a, b = _CLEAR_OF_THE_LAND
    resp = hazard_client.post("/routing/verify", json={"waypoints": [a, b]})
    assert resp.status_code == 200
    body = resp.json()
    assert body["check_manually_legs"] == [False]


def test_plan_wires_check_manually_legs(hazard_client: TestClient) -> None:
    a, b = _CLEAR_OF_THE_LAND
    resp = hazard_client.post("/routing/plan", json={"from": a, "to": b})
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["check_manually_legs"]) == len(body["waypoints"]) - 1
    assert not any(body["check_manually_legs"])


def test_verify_rejects_a_single_waypoint(hazard_client: TestClient) -> None:
    resp = hazard_client.post("/routing/verify", json={"waypoints": [_ACROSS_THE_LAND[0]]})
    assert resp.status_code == 422


def test_verify_rejects_unknown_fields(hazard_client: TestClient) -> None:
    resp = hazard_client.post(
        "/routing/verify", json={"waypoints": list(_ACROSS_THE_LAND), "bogus": True}
    )
    assert resp.status_code == 422


# -- the HazardIndex cache (OchartsService.hazard_index) --------------------
#
# ROUTING_TODO.md's "HazardIndex cache" item: before this existed,
# `/routing/plan` rebuilt every candidate cell's unsafe-water union on
# EVERY request, even with the decoded cell itself warm — measured as the
# largest remaining per-request cost (~0.44s/request). These prove the
# cache actually behaves like one: a repeat build for the same key is a hit,
# not a rebuild, and a genuinely different key (depth or margin) gets its
# own entry rather than being conflated with — or evicting — another.


def test_hazard_index_is_cached_across_calls(ocharts_with_de6ostim: OchartsService) -> None:
    cs = ocharts_with_de6ostim.get("oeuSENC-DE6OSTIM")
    assert cs is not None
    cell = cs.cells[0]

    first = ocharts_with_de6ostim.hazard_index(cs, cell, 3.0, 30.0)
    loads_after_first = ocharts_with_de6ostim.hazards.stats()["loads"]
    second = ocharts_with_de6ostim.hazard_index(cs, cell, 3.0, 30.0)
    stats = ocharts_with_de6ostim.hazards.stats()

    assert first is second  # the cached object itself, not an equal rebuild
    assert stats["loads"] == loads_after_first  # no second build happened
    assert stats["hits"] >= 1


def test_land_hazard_index_is_a_real_land_only_union_on_the_real_fixture(
    ocharts_with_de6ostim: OchartsService,
) -> None:
    cs = ocharts_with_de6ostim.get("oeuSENC-DE6OSTIM")
    assert cs is not None
    cell = cs.cells[0]

    land_only = ocharts_with_de6ostim.land_hazard_index(cs, cell, 30.0)
    # depth-gated at an absurdly permissive "even bottomless water counts
    # as safe" depth: if this fixture's LNDARE alone still shows up, the
    # class really is unconditional end to end (chartcore's own unit
    # tests already prove the Rust half; this proves the Python wiring
    # reaches the real fixture the same way).
    full = ocharts_with_de6ostim.hazard_index(cs, cell, -100.0, 30.0)
    assert land_only is not None
    assert full is not None
    assert land_only.ring_count == full.ring_count  # this fixture charts only LNDARE — see the module docstring


def test_land_hazard_index_is_cached_across_calls(ocharts_with_de6ostim: OchartsService) -> None:
    cs = ocharts_with_de6ostim.get("oeuSENC-DE6OSTIM")
    assert cs is not None
    cell = cs.cells[0]

    first = ocharts_with_de6ostim.land_hazard_index(cs, cell, 30.0)
    loads_after_first = ocharts_with_de6ostim.hazards.stats()["loads"]
    second = ocharts_with_de6ostim.land_hazard_index(cs, cell, 30.0)
    stats = ocharts_with_de6ostim.hazards.stats()

    assert first is second  # the cached object itself, not an equal rebuild
    assert stats["loads"] == loads_after_first  # no second build happened
    assert stats["hits"] >= 1


def test_land_hazard_key_never_collides_with_an_ordinary_hazard_key(
    ocharts_with_de6ostim: OchartsService,
) -> None:
    # The "land_hazard" tag vs. cell_key's own "cell" tag — see
    # land_hazard_key's own docstring for why this can never collide, even
    # by coincidence of the trailing float(s).
    cs = ocharts_with_de6ostim.get("oeuSENC-DE6OSTIM")
    assert cs is not None
    cell = cs.cells[0]

    land_key = ocharts_with_de6ostim.land_hazard_key(cs, cell, 30.0)
    hazard_key = ocharts_with_de6ostim.hazard_key(cs, cell, 3.0, 30.0)
    assert land_key != hazard_key
    assert land_key[0] != hazard_key[0]


def test_hazard_index_cache_keyed_on_depth_and_margin(ocharts_with_de6ostim: OchartsService) -> None:
    cs = ocharts_with_de6ostim.get("oeuSENC-DE6OSTIM")
    assert cs is not None
    cell = cs.cells[0]

    ocharts_with_de6ostim.hazard_index(cs, cell, 3.0, 30.0)
    ocharts_with_de6ostim.hazard_index(cs, cell, 5.0, 30.0)  # different safety depth
    ocharts_with_de6ostim.hazard_index(cs, cell, 3.0, 60.0)  # different margin

    # Three genuinely distinct unions built, not two of them silently
    # served from a key collision with the first.
    assert ocharts_with_de6ostim.hazards.stats()["loads"] == 3


def test_hazard_index_cache_keyed_on_air_draft_too(ocharts_with_de6ostim: OchartsService) -> None:
    cs = ocharts_with_de6ostim.get("oeuSENC-DE6OSTIM")
    assert cs is not None
    cell = cs.cells[0]

    ocharts_with_de6ostim.hazard_index(cs, cell, 3.0, 30.0)  # air_draft_m defaults to 0.0
    ocharts_with_de6ostim.hazard_index(cs, cell, 3.0, 30.0, 0.0)  # same key, explicit default
    ocharts_with_de6ostim.hazard_index(cs, cell, 3.0, 30.0, 18.0)  # genuinely different key

    # Two distinct unions built (the explicit 0.0 call is a cache HIT on
    # the first, default-omitted call — same key), not three.
    assert ocharts_with_de6ostim.hazards.stats()["loads"] == 2


def test_land_bake_is_cached_across_calls(ocharts_with_de6ostim: OchartsService) -> None:
    cs = ocharts_with_de6ostim.get("oeuSENC-DE6OSTIM")
    assert cs is not None
    cell = cs.cells[0]

    first = ocharts_with_de6ostim.land_bake(cs, cell, 30.0)
    loads_after_first = ocharts_with_de6ostim.land_bakes.stats()["loads"]
    second = ocharts_with_de6ostim.land_bake(cs, cell, 30.0)
    stats = ocharts_with_de6ostim.land_bakes.stats()

    assert first is not None  # DE6OSTIM's real land bakes to something
    assert first is second  # the cached object itself, not an equal rebuild
    assert stats["loads"] == loads_after_first  # no second build happened
    assert stats["hits"] >= 1


def test_land_bake_cache_keyed_on_margin_only_not_depth(
    ocharts_with_de6ostim: OchartsService,
) -> None:
    cs = ocharts_with_de6ostim.get("oeuSENC-DE6OSTIM")
    assert cs is not None
    cell = cs.cells[0]

    ocharts_with_de6ostim.land_bake(cs, cell, 30.0)
    ocharts_with_de6ostim.land_bake(cs, cell, 30.0)  # same margin: a hit
    ocharts_with_de6ostim.land_bake(cs, cell, 60.0)  # different margin: its own entry

    # Two genuinely distinct bakes built (one per margin), not three — a
    # LandHazardBake is depth-independent, so there is no third axis to key
    # on the way HazardIndex's cache keys on safety_depth_m too.
    assert ocharts_with_de6ostim.land_bakes.stats()["loads"] == 2


def test_land_bake_key_folds_in_the_schema_version(
    ocharts_with_de6ostim: OchartsService,
) -> None:
    """Regression: `land_bake_key` must fold in `LAND_BAKE_SCHEMA_VERSION`
    the same way `_tile`'s cache key folds in `TILE_SCHEMA_VERSION` — a
    hand-bumped counter is the ONLY thing that would force a fresh build
    after a chartcore-side change to `build_land_hazard_bake` for the SAME
    cell/sequence/margin (see `LAND_BAKE_SCHEMA_VERSION`'s own docs: a
    code-only fix bumps neither `cs.sequence` nor anything else already in
    the key). Simulates exactly that: a monkeypatched higher version must
    produce a DIFFERENT cache key (and thus a fresh build, not a stale
    cached object) for the identical (cs, cell, margin_m) call."""
    from mivnav.features.ocharts import service as service_module

    cs = ocharts_with_de6ostim.get("oeuSENC-DE6OSTIM")
    assert cs is not None
    cell = cs.cells[0]

    key_v1 = ocharts_with_de6ostim.land_bake_key(cs, cell, 30.0)
    assert service_module.LAND_BAKE_SCHEMA_VERSION in key_v1

    original = service_module.LAND_BAKE_SCHEMA_VERSION
    try:
        service_module.LAND_BAKE_SCHEMA_VERSION = original + 1
        key_v2 = ocharts_with_de6ostim.land_bake_key(cs, cell, 30.0)
    finally:
        service_module.LAND_BAKE_SCHEMA_VERSION = original

    assert key_v1 != key_v2  # a version bump must be a genuinely different key


def test_plan_reuses_the_warm_hazard_cache_on_a_repeat_request(
    hazard_client: TestClient, ocharts_with_de6ostim: OchartsService
) -> None:
    a, b = _ACROSS_THE_LAND
    first = hazard_client.post("/routing/plan", json={"from": a, "to": b})
    assert first.status_code == 200
    loads_after_first = ocharts_with_de6ostim.hazards.stats()["loads"]
    assert loads_after_first > 0  # the fixture's land cell built at least one union

    second = hazard_client.post("/routing/plan", json={"from": a, "to": b})
    assert second.status_code == 200
    stats = ocharts_with_de6ostim.hazards.stats()

    assert stats["loads"] == loads_after_first  # same draft/margin: no rebuild
    assert stats["hits"] >= loads_after_first  # the second request hit every one
    assert second.json()["waypoints"] == first.json()["waypoints"]


def test_plan_shallow_avoidance_config_reaches_chartcore(
    hazard_client: TestClient, isolated_runtime
) -> None:
    # `isolated_runtime` (conftest.py, session-scoped autouse) is what
    # `Depends(get_runtime)` already resolves to for every test in this
    # session, `hazard_client` included — reuse the very same instance
    # directly rather than building a second one, and patch it back to
    # RoutingConfig's own defaults afterward so this doesn't leak into
    # later tests sharing the session-scoped runtime.
    a, b = _ACROSS_THE_LAND
    default_resp = hazard_client.post("/routing/plan", json={"from": a, "to": b})
    assert default_resp.status_code == 200

    isolated_runtime.config.patch(
        {"routing": {"shallow_avoidance_radius_m": 300.0, "shallow_avoidance_weight": 3.0}}
    )
    try:
        weighted_resp = hazard_client.post("/routing/plan", json={"from": a, "to": b})
    finally:
        isolated_runtime.config.patch(
            {"routing": {"shallow_avoidance_radius_m": 0.0, "shallow_avoidance_weight": 0.0}}
        )
    assert weighted_resp.status_code == 200

    # The real proof the config value actually reached `chartcore.
    # shortest_path`: a real, non-trivial detour (real DE6OSTIM land,
    # `test_plan_routes_around_real_land_instead_of_crossing_it`'s same
    # fixture) genuinely routes differently once the preference is on —
    # not just a different distance from floating-point noise.
    assert weighted_resp.json()["waypoints"] != default_resp.json()["waypoints"]


def test_plan_lateral_margin_config_reaches_chartcore(
    hazard_client: TestClient, isolated_runtime
) -> None:
    # Same shape as test_plan_shallow_avoidance_config_reaches_chartcore —
    # `lateral_margin_m` is a soft preference now (#owqqcdqe, 2026-08-10),
    # not baked into the hazard union's own hard buffer any more
    # (`routes._HARD_LATERAL_FLOOR_M`, always small and fixed instead), so
    # this proves the CONFIG VALUE still reaches `chartcore.shortest_path`
    # as its own `lateral_margin_radius_m` and genuinely changes the route
    # — the actual "prefers more clearance without hard-blocking a narrow
    # gap" mechanism is chartcore's own, unit-tested directly
    # (`lateral_margin_preference_bulges_when_there_is_room_but_still_
    # threads_a_gap_narrower_than_it`, chartcore/src/routing/raster.rs).
    a, b = _ACROSS_THE_LAND
    default_resp = hazard_client.post("/routing/plan", json={"from": a, "to": b})
    assert default_resp.status_code == 200

    isolated_runtime.config.patch({"routing": {"lateral_margin_m": 300.0}})
    try:
        preferred_resp = hazard_client.post("/routing/plan", json={"from": a, "to": b})
    finally:
        isolated_runtime.config.patch({"routing": {"lateral_margin_m": 30.0}})
    assert preferred_resp.status_code == 200
    assert preferred_resp.json()["waypoints"] != default_resp.json()["waypoints"]


def test_plan_lateral_margin_no_longer_hard_blocks_the_route(
    hazard_client: TestClient, isolated_runtime
) -> None:
    # The regression this whole change exists to fix, at the HTTP level:
    # a huge PREFERRED margin (bigger than the real fixture island itself)
    # used to be baked straight into the hazard union as a hard buffer —
    # `lateral_margin_m` this large would have swallowed the whole
    # passable gap around `_ACROSS_THE_LAND`'s island, and the search's
    # own widen ladder is bounded (`CORRIDOR_PAD_CAP_M`), so a real route
    # would eventually come back badly approximate/unreachable. It must
    # not any more: a route is still found, still avoids the real island,
    # and is not flagged approximate. `_CLEAR_OF_THE_LAND`, not
    # `_ACROSS_THE_LAND` — this test's own premise needs BOTH ends
    # genuinely safe (see that constant's own docs); a huge lateral margin
    # is a separate concern from either endpoint's own depth safety.
    a, b = _CLEAR_OF_THE_LAND
    isolated_runtime.config.patch({"routing": {"lateral_margin_m": 5_000.0}})
    try:
        resp = hazard_client.post("/routing/plan", json={"from": a, "to": b})
    finally:
        isolated_runtime.config.patch({"routing": {"lateral_margin_m": 30.0}})
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["waypoints"]) > 2, body
    assert not any(_waypoint_in_land_bbox(wp) for wp in body["waypoints"]), body
    assert not any(body["approximate_legs"]), body


def test_plan_tss_and_fairway_config_reaches_chartcore(
    hazard_client: TestClient, isolated_runtime
) -> None:
    # Same shape as test_plan_shallow_avoidance_config_reaches_chartcore,
    # but scoped down to "reaches chartcore without error" rather than
    # "waypoints differ": DE6OSTIM.S57 (checked directly, decoded,
    # `cell.features_of("TSSLPT"/"TSSRON"/"TSSCRS"/"PRCARE"/"FAIRWY")`)
    # charts NONE of those classes, only LNDARE — there is no real TSS/
    # fairway geometry anywhere near `_ACROSS_THE_LAND` for a nonzero
    # weight to visibly bend the route around. `fairway_preference_weight`
    # now ALSO covers RECTRC/NAVLNE/DWRTPT (`Cell.fairway_union()`'s own
    # broadened union) — whether this fixture charts any of those three
    # could not be re-checked this round (see
    # `test_preference_indexes_for_line_forwards_the_broadened_fairway_
    # union_untouched`'s own docstring for why), so this test's scope is
    # unchanged: still "reaches chartcore without error", not "waypoints
    # differ". `chartcore/src/routing/raster.rs`'s own synthetic tests
    # (`tss_avoidance_*`/`fairway_preference_*`, plus the new
    # `preferred_route_wiring_bends_a_route_toward_a_real_rectrc_not_just_
    # fairwy`) are what actually prove the search itself responds to
    # these weights; this test only proves the wiring reaches
    # `chartcore.shortest_path` with real, non-empty ring/weight
    # arguments and doesn't error.
    a, b = _ACROSS_THE_LAND
    default_resp = hazard_client.post("/routing/plan", json={"from": a, "to": b})
    assert default_resp.status_code == 200

    isolated_runtime.config.patch(
        {"routing": {"tss_avoidance_weight": 3.0, "fairway_preference_weight": 0.5}}
    )
    try:
        weighted_resp = hazard_client.post("/routing/plan", json={"from": a, "to": b})
    finally:
        isolated_runtime.config.patch(
            {"routing": {"tss_avoidance_weight": 0.0, "fairway_preference_weight": 0.0}}
        )
    assert weighted_resp.status_code == 200
    # Still a real hazard-avoiding route (the fixture's own real land) —
    # the TSS/fairway wiring must not have broken the existing hazard
    # search it rides alongside.
    body = weighted_resp.json()
    assert len(body["waypoints"]) > 2, body
    assert body["distance_nm"] > 0


def test_plan_cable_and_caution_config_reaches_chartcore(
    hazard_client: TestClient, isolated_runtime
) -> None:
    # Same shape/scope as test_plan_tss_and_fairway_config_reaches_chartcore
    # above: DE6OSTIM.S57 was checked directly (decoded, `cell.features_of
    # ("ACHARE"/"CBLSUB"/"PIPSOL"/"CTNARE"/"RESARE"/"MIPARE").count()`, ALL
    # zero — only LNDARE, same finding this session has repeatedly made for
    # every preference-layer S-57 class on this fixture) — so this test's
    # scope is "reaches chartcore without error", not "waypoints differ".
    # `chartcore/src/routing/raster.rs`'s own synthetic tests
    # (`cable_avoidance_*`/`caution_area_avoidance_*`, plus the real-geometry
    # `cable_wiring_bends_a_route_around_a_real_charted_cblsub`/
    # `caution_wiring_bends_a_route_around_a_real_charted_permitted_transit_
    # resare`) are what actually prove the search responds to these weights;
    # this test only proves the wiring reaches `chartcore.shortest_path`
    # with real, non-empty weight arguments and doesn't error.
    a, b = _ACROSS_THE_LAND
    default_resp = hazard_client.post("/routing/plan", json={"from": a, "to": b})
    assert default_resp.status_code == 200

    isolated_runtime.config.patch(
        {"routing": {"cable_avoidance_weight": 3.0, "caution_area_avoidance_weight": 3.0}}
    )
    try:
        weighted_resp = hazard_client.post("/routing/plan", json={"from": a, "to": b})
    finally:
        isolated_runtime.config.patch(
            {"routing": {"cable_avoidance_weight": 0.0, "caution_area_avoidance_weight": 0.0}}
        )
    assert weighted_resp.status_code == 200
    # Still a real hazard-avoiding route (the fixture's own real land) —
    # the cable/caution wiring must not have broken the existing hazard
    # search it rides alongside.
    body = weighted_resp.json()
    assert len(body["waypoints"]) > 2, body
    assert body["distance_nm"] > 0


def test_plan_survey_config_reaches_chartcore(hazard_client: TestClient, isolated_runtime) -> None:
    # Same shape/scope as test_plan_cable_and_caution_config_reaches_chartcore
    # above: DE6OSTIM.S57 was checked directly (decoded via
    # `chartcore::osenc::read_cell`, `cell.features_of("M_QUAL").count()`
    # == 0 — only the classes named in this fixture's own module note,
    # M_QUAL is not among them) — so this test's scope is "reaches
    # chartcore without error", not "waypoints differ". A REAL NOAA S-57
    # cell (`US5OAKIQ.000`, decoded via GDAL, not this fixture) does carry
    # 13 real M_QUAL zones (all CATZOC=3/Zone B) — confirmed directly while
    # investigating this feature, not assumed — but that fixture is the
    # raw-ingest one, not a `.senc`-format cell this HTTP endpoint can load.
    # `chartcore/src/routing/raster.rs`'s own synthetic test
    # (`survey_avoidance_needs_no_heuristic_change_to_stay_exact`) plus the
    # real-geometry
    # `survey_wiring_bends_a_route_around_a_real_charted_low_confidence_zone`
    # are what actually prove the search responds to this weight; this test
    # only proves the wiring reaches `chartcore.shortest_path` with a real,
    # non-zero weight argument and doesn't error.
    a, b = _ACROSS_THE_LAND
    default_resp = hazard_client.post("/routing/plan", json={"from": a, "to": b})
    assert default_resp.status_code == 200

    isolated_runtime.config.patch({"routing": {"low_confidence_survey_avoidance_weight": 3.0}})
    try:
        weighted_resp = hazard_client.post("/routing/plan", json={"from": a, "to": b})
    finally:
        isolated_runtime.config.patch({"routing": {"low_confidence_survey_avoidance_weight": 0.0}})
    assert weighted_resp.status_code == 200
    # Still a real hazard-avoiding route (the fixture's own real land) —
    # the survey wiring must not have broken the existing hazard search it
    # rides alongside.
    body = weighted_resp.json()
    assert len(body["waypoints"]) > 2, body
    assert body["distance_nm"] > 0


def test_plan_turn_cost_config_reaches_chartcore(hazard_client: TestClient, isolated_runtime) -> None:
    # Unlike every other preference-layer test above, `turn_cost_weight`
    # needs no charted S-57 class to have an effect at all — it is a
    # HISTORY-dependent per-heading-change cost baked into the search
    # itself (`chartcore::routing::raster::search_grid_with_turn_cost`),
    # not a zone/distance term over charted geometry — so this fixture's
    # own real land (which already forces a real detour, same as every
    # other test in this file) is enough to exercise it, no "this class
    # isn't charted here" caveat needed. Still scoped to "reaches chartcore
    # without error, still a real route" rather than asserting an exact
    # waypoint shape — `chartcore/src/routing/raster.rs`'s own synthetic
    # brute-force tests (`turn_cost_prefers_the_fewer_turn_arrangement_of_
    # an_exactly_tied_distance_cost`, `turn_cost_search_finds_the_true_
    # optimum_with_a_fairway_discount_active`) and the real-chart
    # measurement (`turn_cost_on_a_real_land_detour_measured`,
    # `routing_de6ostim.rs`) are what actually prove the search responds
    # correctly; this test only proves the config field reaches
    # `chartcore.shortest_path` with a real, non-zero weight and doesn't
    # error.
    a, b = _ACROSS_THE_LAND
    default_resp = hazard_client.post("/routing/plan", json={"from": a, "to": b})
    assert default_resp.status_code == 200

    isolated_runtime.config.patch({"routing": {"turn_cost_weight": 3.0}})
    try:
        weighted_resp = hazard_client.post("/routing/plan", json={"from": a, "to": b})
    finally:
        isolated_runtime.config.patch({"routing": {"turn_cost_weight": 0.0}})
    assert weighted_resp.status_code == 200
    # Still a real hazard-avoiding route (the fixture's own real land) —
    # the turn-cost wiring must not have broken the existing hazard search
    # it rides alongside.
    body = weighted_resp.json()
    assert len(body["waypoints"]) > 2, body
    assert body["distance_nm"] > 0


def test_preference_indexes_for_line_forwards_the_broadened_fairway_union_untouched() -> None:
    """``chartcore::routing::preference::build_preferred_route_union`` was
    broadened from `FAIRWY` alone to `FAIRWY`/`RECTRC`/`NAVLNE`/`DWRTPT`,
    unioned into ONE ring set behind `Cell.fairway_union()` (see that
    module's own docs). This backend function never enumerates S-57
    classes itself — it only calls `.tss_union()`/`.fairway_union()` and
    forwards whatever comes back — so the broadening needed ZERO changes
    here. Proven directly, not just by absence of a diff: a FAKE
    duck-typed cell (same posture as `test_routing_hazard_authority.py`)
    whose own `fairway_union()` returns a sentinel standing in for a
    RECTRC-only union (no real chart data, no real chartcore call)
    round-trips through `preference_indexes_for_line` unchanged.

    Whether `DE6OSTIM.S57` itself charts any real RECTRC/NAVLNE/DWRTPT
    geometry (the same question `test_plan_tss_and_fairway_config_
    reaches_chartcore` above answers for TSS/FAIRWY) could NOT be
    re-checked this session: decoding it needs the `s57-ingest` cargo
    feature, whose `gdal-sys` build fails in this sandbox (missing
    `cpl_atomic_ops.h` — a pre-existing gap, the same one
    `ROUTING_TODO.md`'s own macro-route round already hit and documented,
    not something this change caused) and a raw byte-grep for the ASCII
    acronyms is inconclusive (S-57 encodes OBJL numerically, not as
    literal acronym text — the identical reasoning already established
    for OSENC elsewhere in this codebase). Treat chartcore's own new
    `preference.rs`/`raster.rs` tests as synthetic-only coverage for
    RECTRC/NAVLNE/DWRTPT specifically, same documented limitation the
    original TSS/FAIRWY round already carried."""
    from dataclasses import dataclass

    from mivnav.features.routing.geo import Point
    from mivnav.features.routing.hazards import preference_indexes_for_line

    sentinel = object()  # stands in for a real RECTRC-only `HazardIndex`

    class _FakePath:
        name = "fake-cell"

    @dataclass
    class _FakeCell:
        extent: tuple = (-180.0, -90.0, 180.0, 90.0)

        @property
        def path(self) -> _FakePath:
            return _FakePath()

        def tss_union(self):
            return None  # not under test here — want_tss=False below

        def fairway_union(self):
            return sentinel

    @dataclass
    class _FakeSet:
        cells: list

    class _FakeOcharts:
        def sets(self) -> dict:
            return {"s": _FakeSet(cells=[_FakeCell()])}

        def load_cell(self, cs, cell):
            return cell

    a, b = Point(0.0, 0.0), Point(0.0, 0.1)
    tss_indexes, fairway_indexes, cable_indexes, caution_indexes, survey_indexes = preference_indexes_for_line(
        _FakeOcharts(), a, b, want_tss=False, want_fairway=True
    )
    assert tss_indexes == []
    assert fairway_indexes == [sentinel]
    # want_cable/want_caution/want_survey all default False — the new
    # layers must not
    # be decoded (and `_FakeCell` above deliberately carries no
    # cable_union/caution_union/survey_union method at all, so a wrongly-
    # forced decode
    # would raise AttributeError, not just return the wrong thing).
    assert cable_indexes == []
    assert caution_indexes == []
    assert survey_indexes == []


def test_cable_and_caution_indexes_are_gated_independently_of_tss_and_fairway() -> None:
    """The soft-avoid cost tier's own plumbing test, same shape as
    `test_preference_indexes_for_line_broadened_scope...` above:
    `want_cable`/`want_caution`/`want_survey` decode `Cell.cable_union()`/
    `Cell.caution_union()`/`Cell.survey_union()` independently of
    `want_tss`/`want_fairway` —
    proving the five layers are genuinely separate gates, not one flag
    covering all of them."""
    from dataclasses import dataclass

    from mivnav.features.routing.geo import Point
    from mivnav.features.routing.hazards import preference_indexes_for_line

    cable_sentinel = object()
    caution_sentinel = object()
    survey_sentinel = object()

    class _FakePath:
        name = "fake-cell"

    @dataclass
    class _FakeCell:
        extent: tuple = (-180.0, -90.0, 180.0, 90.0)

        @property
        def path(self) -> _FakePath:
            return _FakePath()

        def tss_union(self):
            return None  # not under test here — want_tss=False below

        def fairway_union(self):
            return None  # not under test here — want_fairway=False below

        def cable_union(self):
            return cable_sentinel

        def caution_union(self):
            return caution_sentinel

        def survey_union(self):
            return survey_sentinel

    @dataclass
    class _FakeSet:
        cells: list

    class _FakeOcharts:
        def sets(self) -> dict:
            return {"s": _FakeSet(cells=[_FakeCell()])}

        def load_cell(self, cs, cell):
            return cell

    a, b = Point(0.0, 0.0), Point(0.0, 0.1)
    tss_indexes, fairway_indexes, cable_indexes, caution_indexes, survey_indexes = preference_indexes_for_line(
        _FakeOcharts(),
        a,
        b,
        want_tss=False,
        want_fairway=False,
        want_cable=True,
        want_caution=True,
        want_survey=True,
    )
    assert tss_indexes == []
    assert fairway_indexes == []
    assert survey_indexes == [survey_sentinel]
    assert cable_indexes == [cable_sentinel]
    assert caution_indexes == [caution_sentinel]


def test_plan_air_draft_off_by_default_never_reaches_ocharts_with_a_nonzero_value(
    hazard_client: TestClient, ocharts_with_de6ostim: OchartsService, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The correctness requirement `air_draft_m`'s own docs state directly:
    # an unconfigured request must never even ASK chartcore about air
    # draft, not just "ask with a value that happens not to match
    # anything" — proven by recording every value `ocharts.hazard_index`
    # actually receives during a real request with today's default config.
    seen_air_draft_m: list[float] = []
    real_hazard_index = OchartsService.hazard_index

    def recording_hazard_index(self, cs, cell, safety_depth_m, margin_m, air_draft_m=0.0):
        seen_air_draft_m.append(air_draft_m)
        return real_hazard_index(self, cs, cell, safety_depth_m, margin_m, air_draft_m)

    monkeypatch.setattr(OchartsService, "hazard_index", recording_hazard_index)

    a, b = _ACROSS_THE_LAND
    resp = hazard_client.post("/routing/plan", json={"from": a, "to": b})
    assert resp.status_code == 200
    assert seen_air_draft_m, "setup invalid: hazard_index was never even called"
    assert all(v == 0.0 for v in seen_air_draft_m), seen_air_draft_m


def test_plan_air_draft_config_reaches_chartcore(
    hazard_client: TestClient, isolated_runtime, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Same "doesn't error" scope as test_plan_tss_and_fairway_config_
    # reaches_chartcore, for the identical reason: DE6OSTIM.S57 charts no
    # BRIDGE/CBLOHD (checked directly, decoded, `cell.features_of("BRIDGE"/
    # "CBLOHD")`) — there is no real vertical-obstruction geometry near
    # `_ACROSS_THE_LAND` for a nonzero air draft to visibly bend the route
    # around. `chartcore/src/routing/raster.rs`'s own
    # `air_draft_wiring_actually_blocks_a_route_through_a_real_too_low_
    # bridge` integration test is what actually proves a real bridge
    # blocks; this test proves the CONFIG VALUE itself reaches
    # `ocharts.hazard_index` end to end (config -> `RoutingConfig.
    # air_draft_m` -> `routes._plan_leg` -> `hazards.hazard_indexes_for_
    # line` -> `OchartsService.hazard_index`), stronger than "doesn't
    # error": the exact value is captured and asserted, not inferred.
    seen_air_draft_m: list[float] = []
    real_hazard_index = OchartsService.hazard_index

    def recording_hazard_index(self, cs, cell, safety_depth_m, margin_m, air_draft_m=0.0):
        seen_air_draft_m.append(air_draft_m)
        return real_hazard_index(self, cs, cell, safety_depth_m, margin_m, air_draft_m)

    monkeypatch.setattr(OchartsService, "hazard_index", recording_hazard_index)

    a, b = _ACROSS_THE_LAND
    isolated_runtime.config.patch({"routing": {"air_draft_m": 18.0}})
    try:
        resp = hazard_client.post("/routing/plan", json={"from": a, "to": b})
    finally:
        isolated_runtime.config.patch({"routing": {"air_draft_m": 0.0}})
    assert resp.status_code == 200
    assert seen_air_draft_m, "setup invalid: hazard_index was never even called"
    assert all(v == 18.0 for v in seen_air_draft_m), seen_air_draft_m
    # Still a real hazard-avoiding route (the fixture's own real land) —
    # the air-draft wiring must not have broken the existing hazard search
    # it rides alongside.
    body = resp.json()
    assert len(body["waypoints"]) > 2, body
    assert body["distance_nm"] > 0


# -- the "graph" algorithm (chartcore::routing::raster::graph) — a second,
# structurally different search, over the SAME real chart data ------------


def test_plan_via_graph_routes_around_real_land(
    hazard_client: TestClient, isolated_runtime
) -> None:
    """`RoutingConfig.algorithm == "graph"` reaches `chartcore.graph_route`
    (not `chartcore.shortest_path`) and produces a real, non-trivial
    detour around DE6OSTIM's own real land — the same "genuinely reaches
    chartcore, not just accepted a config value" proof the raster
    algorithm's own tests above make, for the second algorithm.

    `_CLEAR_OF_THE_LAND`, not `_ACROSS_THE_LAND` — this algorithm has no
    "route as close as possible" fallback the raster search does for an
    unsafe endpoint (`RoutePath.approximate_legs`' own partial-routing
    mechanism), so it needs a genuinely safe start to prove anything about
    detouring around land at all; an unsafe start here just reports "no
    path found" instead (measured directly: even `_ACROSS_THE_LAND[0]`
    alone, moved just outside the charted hazard, still wasn't quite
    enough clearance for this algorithm's own coarser adaptive sampling to
    connect — `_CLEAR_OF_THE_LAND`'s wider margin is load-bearing here,
    not cosmetic)."""
    a, b = _CLEAR_OF_THE_LAND
    isolated_runtime.config.patch({"routing": {"algorithm": "graph"}})
    try:
        resp = hazard_client.post("/routing/plan", json={"from": a, "to": b})
    finally:
        isolated_runtime.config.patch({"routing": {"algorithm": "raster"}})
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["waypoints"]) > 2, body
    assert body["distance_nm"] > 0
    # Real land straight across the middle — no waypoint may sit inside it.
    assert not any(_waypoint_in_land_bbox(wp) for wp in body["waypoints"]), body
    # No approximate/partial-route concept for this algorithm — see its
    # own module docs.
    assert not any(body["approximate_legs"]), body
    assert any("adaptive-graph" in w for w in body["warnings"]), body


def test_plan_via_graph_air_draft_config_reaches_chartcore(
    hazard_client: TestClient, isolated_runtime, monkeypatch: pytest.MonkeyPatch
) -> None:
    # `_plan_via_graph` shares `hazard_indexes_for_line` (and therefore
    # `cfg.air_draft_m`) with the raster algorithm's own `_plan_leg` — this
    # proves that sharing actually happens for the SECOND algorithm too,
    # not just the primary one, the same "reaches chartcore with the real
    # value" proof `test_plan_air_draft_config_reaches_chartcore` makes for
    # `"raster"`.
    seen_air_draft_m: list[float] = []
    real_hazard_index = OchartsService.hazard_index

    def recording_hazard_index(self, cs, cell, safety_depth_m, margin_m, air_draft_m=0.0):
        seen_air_draft_m.append(air_draft_m)
        return real_hazard_index(self, cs, cell, safety_depth_m, margin_m, air_draft_m)

    monkeypatch.setattr(OchartsService, "hazard_index", recording_hazard_index)

    a, b = _ACROSS_THE_LAND
    isolated_runtime.config.patch({"routing": {"algorithm": "graph", "air_draft_m": 18.0}})
    try:
        resp = hazard_client.post("/routing/plan", json={"from": a, "to": b})
    finally:
        isolated_runtime.config.patch({"routing": {"algorithm": "raster", "air_draft_m": 0.0}})
    assert resp.status_code == 200
    assert seen_air_draft_m, "setup invalid: hazard_index was never even called"
    assert all(v == 18.0 for v in seen_air_draft_m), seen_air_draft_m


def test_plan_via_graph_falls_back_to_a_straight_line_when_no_chart_covers_the_request(
    hazard_client: TestClient, isolated_runtime
) -> None:
    """Same honest "never a bare error" contract every algorithm keeps —
    `_FAR_FROM_ANY_CHART` has no hazard data at all, so `graph_route` finds
    the plain direct line (nothing to route around), same as the raster
    search's own equivalent case."""
    a, b = _FAR_FROM_ANY_CHART
    isolated_runtime.config.patch({"routing": {"algorithm": "graph"}})
    try:
        resp = hazard_client.post("/routing/plan", json={"from": a, "to": b})
    finally:
        isolated_runtime.config.patch({"routing": {"algorithm": "raster"}})
    assert resp.status_code == 200
    body = resp.json()
    # Approximate, not exact: WorldXy is an integer-quantized coordinate
    # space (the same round-trip tolerance every other real-fixture test
    # in this module already lives with), not lossless floating point.
    assert body["waypoints"][0] == pytest.approx(a, abs=1e-4)
    assert body["waypoints"][-1] == pytest.approx(b, abs=1e-4)
    assert not any(body["approximate_legs"]), body


def test_plan_buoyage_config_reaches_chartcore_with_real_lateral_marks(
    hazard_client: TestClient, isolated_runtime
) -> None:
    # UNLIKE the TSS/fairway test above, DE6OSTIM.S57 charts REAL lateral
    # marks near this exact line — one BOYLAT (CATLAM=2, starboard) and
    # two BCNLAT mole-head beacons (COLOUR only, no CATLAM — the real-data
    # case `chartcore::routing::buoyage`'s colour fallback exists for),
    # plus a real M_NSYS/MARSYS=1 (region A) meta-object (all checked
    # directly against the fixture, not assumed — see
    # `chartcore/src/routing/buoyage.rs`'s own module docs, which were
    # written FROM decoding this exact cell). So this test can assert more
    # than "doesn't error": that the buoyage step actually ran, resolved a
    # real region, and produced real (possibly-empty, per line) ring data
    # — the directional bend itself is what
    # `raster::tests::buoyage_avoidance_prefers_a_real_alternative_when_
    # one_exists` proves with a controlled synthetic zone; a real fixture
    # this close to a harbour mouth conflates any buoyage-side bend with
    # the land avoidance already happening on the same line, so this test
    # doesn't try to isolate a waypoint difference the way the
    # shallow-water test above does.
    a, b = _ACROSS_THE_LAND
    isolated_runtime.config.patch(
        {"routing": {"buoyage_avoidance_weight": 3.0, "buoyage_avoidance_radius_m": 300.0}}
    )
    try:
        resp = hazard_client.post("/routing/plan", json={"from": a, "to": b, "debug": True})
    finally:
        isolated_runtime.config.patch(
            {"routing": {"buoyage_avoidance_weight": 0.0, "buoyage_avoidance_radius_m": 0.0}}
        )
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["waypoints"]) > 2, body
    assert body["distance_nm"] > 0

    steps = {t["step"]: t["detail"] for t in body["timings"]}
    assert "buoyage_candidate_cells" in steps
    buoyage_step = next(s for s in steps if s.startswith("buoyage["))
    # The fixture's own real M_NSYS/MARSYS=1 resolved, not the
    # `RoutingConfig.iala_region` default this test never touched.
    assert "region A" in steps[buoyage_step], steps


def test_plan_does_not_detour_for_a_line_nowhere_near_the_chart(
    hazard_client: TestClient,
) -> None:
    a, b = _FAR_FROM_ANY_CHART
    resp = hazard_client.post("/routing/plan", json={"from": a, "to": b})
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["waypoints"]) == 2
    assert _same_point(body["waypoints"][0], a)
    assert _same_point(body["waypoints"][1], b)


def test_plan_omits_timings_by_default(hazard_client: TestClient) -> None:
    a, b = _ACROSS_THE_LAND
    resp = hazard_client.post("/routing/plan", json={"from": a, "to": b})
    assert resp.json()["timings"] is None


def test_plan_returns_a_step_by_step_breakdown_when_debug_is_set(
    hazard_client: TestClient,
) -> None:
    a, b = _ACROSS_THE_LAND
    resp = hazard_client.post("/routing/plan", json={"from": a, "to": b, "debug": True})
    assert resp.status_code == 200
    timings = resp.json()["timings"]
    assert timings is not None
    steps = [t["step"] for t in timings]
    # candidate_cells first, shortest_path and total present, and each is a
    # real non-negative measurement, not just a stub field.
    assert steps[0] == "candidate_cells"
    assert "shortest_path" in steps
    assert steps[-1] == "total"
    assert all(t["ms"] >= 0 for t in timings)
    # Per-cell, not one lump sum for the whole fixture set — the exact
    # thing that made the 97-second regression invisible without an
    # offline profiler (ROUTING_TODO.md).
    assert any(s.startswith("hazard_index[") for s in steps)


def test_plan_debug_returns_the_search_geometry_the_debug_layer_draws(
    hazard_client: TestClient,
) -> None:
    # #owqqcdqe, 2026-08-10: "add a debugging layer... to check why it
    # puts points where they are" — `debug_legs`/`debug_macro_waypoints`
    # are that layer's own payload. `_ACROSS_THE_LAND` doesn't need a
    # macro detour, so this only proves the ordinary single-leg path;
    # `test_routing_macro.py` covers the macro-stitched shape via
    # `_stitch_macro_route` directly (its own `collect_debug` unit tests).
    a, b = _ACROSS_THE_LAND
    resp = hazard_client.post("/routing/plan", json={"from": a, "to": b, "debug": True})
    assert resp.status_code == 200
    body = resp.json()
    legs = body["debug_legs"]
    assert legs is not None and len(legs) == 1
    leg = legs[0]
    w, s, e, n = leg["bbox"]
    assert w < e and s < n
    # The real DE6OSTIM island the route bends around must show up as
    # actual ring geometry, not an empty placeholder.
    assert len(leg["hazard_rings"]) > 0
    assert all(len(ring) >= 3 for ring in leg["hazard_rings"])
    # No macro detour was needed for this short, local request.
    assert body["debug_macro_waypoints"] is None


def test_plan_omits_debug_geometry_by_default(hazard_client: TestClient) -> None:
    a, b = _ACROSS_THE_LAND
    resp = hazard_client.post("/routing/plan", json={"from": a, "to": b})
    body = resp.json()
    assert body["debug_legs"] is None
    assert body["debug_macro_waypoints"] is None


def test_plan_explains_when_the_start_point_is_itself_unsafe(
    hazard_client: TestClient,
) -> None:
    # The start point is itself inside charted danger — the search now
    # gets as close as it honestly can (routing right up to the land's
    # own boundary) rather than giving up on a bare straight line for the
    # WHOLE request; `approximate_legs[0]` flags the stitched-on stub, and
    # the reason text still says plainly why.
    resp = hazard_client.post(
        "/routing/plan",
        json={"from": _INSIDE_THE_LAND, "to": _FAR_FROM_ANY_CHART[0], "draft_m": 3.5},
    )
    assert resp.status_code == 200
    body = resp.json()
    warnings = body["warnings"]
    hit = next(w for w in warnings if "is itself inside charted danger" in w)
    assert "start point" in hit
    assert "draft 3.5m" in hit
    legs = body["approximate_legs"]
    assert legs[0] is True
    assert not any(legs[1:])
    # Still returns something to draw, starting at the TRUE (unsafe)
    # point and ending at the TRUE destination — only the first LEG is a
    # straight-line stand-in, not the endpoints themselves.
    assert _same_point(body["waypoints"][0], _INSIDE_THE_LAND)
    assert _same_point(body["waypoints"][-1], _FAR_FROM_ANY_CHART[0])


def test_plan_explains_when_the_destination_is_itself_unsafe(
    hazard_client: TestClient,
) -> None:
    # The mirror image of the start-side test above: the DESTINATION is
    # the one inside charted danger.
    resp = hazard_client.post(
        "/routing/plan",
        json={"from": _FAR_FROM_ANY_CHART[0], "to": _INSIDE_THE_LAND, "draft_m": 3.5},
    )
    assert resp.status_code == 200
    body = resp.json()
    hit = next(w for w in body["warnings"] if "is itself inside charted danger" in w)
    assert "destination" in hit
    legs = body["approximate_legs"]
    assert legs[-1] is True
    assert not any(legs[:-1])
    assert _same_point(body["waypoints"][0], _FAR_FROM_ANY_CHART[0])
    assert _same_point(body["waypoints"][-1], _INSIDE_THE_LAND)


def test_plan_marks_an_ordinary_route_not_approximate(
    hazard_client: TestClient,
) -> None:
    # Regression pin: a normal, fully-reachable route (both ends safe)
    # must not carry any approximate leg. `_CLEAR_OF_THE_LAND`, not
    # `_ACROSS_THE_LAND` — this test's own premise IS "both ends safe"
    # (see that constant's own docs for why they now differ).
    a, b = _CLEAR_OF_THE_LAND
    resp = hazard_client.post("/routing/plan", json={"from": a, "to": b})
    body = resp.json()
    assert not any(body["approximate_legs"])


def test_plan_falls_back_to_a_default_draft_with_no_signalk_fix(
    hazard_client: TestClient,
) -> None:
    # No draft_m in the body, and the fixture SignalKService above has no
    # position fix — so this must fall all the way to the module's default
    # draft rather than erroring or silently skipping the check.
    resp = hazard_client.post(
        "/routing/plan",
        json={"from": _INSIDE_THE_LAND, "to": _FAR_FROM_ANY_CHART[0]},
    )
    warnings = resp.json()["warnings"]
    hit = next(w for w in warnings if "is itself inside charted danger" in w)
    assert "draft 2.0m" in hit


# -- persisted routing log (mivnav.features.routing.hazards) ---------------
#
# `hazards.py`'s logger is configured once, at MODULE IMPORT time (see its
# own docstring on why: the same "attach a handler directly, since nothing
# in this app calls `logging.basicConfig`" reasoning as the live stream
# handler it shipped with first) — by the time any test function runs,
# that has already happened, using whatever `XDG_CACHE_HOME` was in the
# environment at import time. So these tests don't monkeypatch the env and
# expect a fresh handler to appear; they discover whatever file the
# ALREADY-configured `RotatingFileHandler` is actually pointed at and
# check content lands there — the same thing a real `tail -f` against it
# would see, and correct regardless of what environment ran the import.


def test_routing_log_has_a_persisted_rotating_file_handler() -> None:
    from mivnav.features.routing import hazards

    file_handlers = [h for h in hazards.log.handlers if isinstance(h, logging.handlers.RotatingFileHandler)]
    assert len(file_handlers) == 1, hazards.log.handlers
    assert Path(file_handlers[0].baseFilename).name == "routing.log"


def test_a_plan_request_appears_in_the_persisted_log(hazard_client: TestClient) -> None:
    from mivnav.features.routing import hazards

    file_handlers = [h for h in hazards.log.handlers if isinstance(h, logging.handlers.RotatingFileHandler)]
    log_path = Path(file_handlers[0].baseFilename)
    before = log_path.read_text() if log_path.exists() else ""

    a, b = _ACROSS_THE_LAND
    resp = hazard_client.post("/routing/plan", json={"from": a, "to": b})
    assert resp.status_code == 200
    for handler in hazards.log.handlers:
        handler.flush()

    after = log_path.read_text()
    new_lines = after[len(before) :]
    assert "candidate_cells" in new_lines, new_lines
    assert "shortest_path" in new_lines, new_lines


def test_default_log_dir_honors_xdg_cache_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # `default_log_dir` itself is a pure function, callable directly with
    # no import-order concern — unlike the module-level handler wiring
    # above, this one IS meaningfully testable with a redirected env.
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path))
    from mivnav.config.model import default_log_dir

    assert default_log_dir() == tmp_path / "mivnav" / "logs"


