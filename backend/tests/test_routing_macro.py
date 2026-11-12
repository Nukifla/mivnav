# SPDX-License-Identifier: GPL-2.0-only
"""The macro-route orchestration (``hazards.py``'s ``needs_macro_route``/
``flagged_run_spans_nm``/``land_indexes_for_macro_route``, ``routes.py``'s
``_stitch_macro_route``/``_macro_route_improves``) — the fix for a request
that can only be completed by a real detour around a whole landmass (found
live: the Limfjord case, ~150nm off the direct line, entirely outside the
ordinary search's own corridor cap). See ``ROUTING_TODO.md``.

Driven with FAKE duck-typed stand-ins and monkeypatched legs, same posture
as ``test_routing_hazard_authority.py``: `chartcore.macro_route`'s own
grid/A*/optimistic-rasterize correctness is covered separately
(`chartcore/src/routing/raster.rs`'s own `macro_route_*` tests). This file
proves the WIRING — which cells get selected, when the macro pass is even
tried, how several real legs get stitched into one result, and when a
stitched detour is accepted over the honest original.
"""

from __future__ import annotations

from dataclasses import dataclass

import mivnav.features.routing.routes as routes
from mivnav.features.routing.config import RoutingConfig
from mivnav.features.routing.geo import Point
from mivnav.features.routing.hazards import (
    StitchedRoute,
    flagged_run_spans_nm,
    land_indexes_for_macro_route,
    natural_earth_land_rings,
    needs_macro_route,
)

A = Point(56.15, 10.19)
B = Point(55.85, 8.10)


@dataclass
class _FakeRoute:
    """Duck-types exactly the two attributes `needs_macro_route`/
    `flagged_run_spans_nm`/`_macro_route_improves` read."""

    waypoints: list[tuple[float, float]]
    approximate_legs: list[bool]


def test_needs_macro_route_false_when_nothing_is_flagged() -> None:
    route = _FakeRoute(waypoints=[(10.0, 56.0), (10.1, 56.0)], approximate_legs=[False])
    assert not needs_macro_route(route)


def test_needs_macro_route_false_for_a_short_flagged_run() -> None:
    # ~1nm apart — well under the default 3nm trigger: exactly the shape
    # chartcore's own per-leg refinement already converges a real
    # resolution miss down to, so this must NOT trigger the (much more
    # expensive) macro pass.
    route = _FakeRoute(
        waypoints=[(10.0, 56.0), (10.017, 56.0)],
        approximate_legs=[True],
    )
    assert not needs_macro_route(route)


def test_needs_macro_route_true_for_a_long_flagged_run() -> None:
    # ~10nm apart, well over the default threshold.
    route = _FakeRoute(
        waypoints=[(10.0, 56.0), (10.3, 56.0)],
        approximate_legs=[True],
    )
    assert needs_macro_route(route)


def test_needs_macro_route_true_for_a_short_midroute_flagged_run() -> None:
    # The real bug this closes (found live: a narrow isthmus between two
    # bays) — a run in the MIDDLE of the route needs a real detour
    # attempt regardless of how short its own straight-line span is: a
    # short DIRECT gap across a neck of land is no evidence the real
    # water route AROUND it is short too. Only a run touching the
    # start/end gets the span-based exemption (that run is a legitimate
    # "the user's own requested endpoint is unreachable" case the
    # straight-line fallback honestly answers, unlike a midroute land
    # crossing, which is never a legitimate answer to anything asked).
    route = _FakeRoute(
        waypoints=[(10.0, 56.0), (10.05, 56.0), (10.051, 56.0), (10.1, 56.0)],
        approximate_legs=[False, True, False],  # only the MIDDLE leg, ~0.06nm
    )
    assert needs_macro_route(route)


def test_needs_macro_route_false_for_the_same_short_span_at_the_start() -> None:
    # Contrast with the test above: the identically tiny span, but
    # touching the route's own start (`i == 0`) instead of sitting in the
    # middle, still gets the ordinary threshold exemption — same shape as
    # `test_needs_macro_route_false_for_a_short_flagged_run`, just with a
    # run that does not ALSO touch the end, to isolate "start" from "the
    # whole route is one flagged leg" (that other test's own shape).
    route = _FakeRoute(
        waypoints=[(10.0, 56.0), (10.001, 56.0), (10.05, 56.0)],
        approximate_legs=[True, False],  # flagged only at the start
    )
    assert not needs_macro_route(route)


def test_needs_macro_route_checks_every_run_not_just_the_first() -> None:
    # First run short (fine), second run long (should trigger) — proves
    # this walks every run rather than stopping at the first.
    route = _FakeRoute(
        waypoints=[(10.0, 56.0), (10.01, 56.0), (10.01, 56.0), (10.3, 56.0)],
        approximate_legs=[True, False, True],
    )
    assert needs_macro_route(route)


def test_flagged_run_spans_nm_one_entry_per_run() -> None:
    route = _FakeRoute(
        waypoints=[(10.0, 56.0), (10.1, 56.0), (10.2, 56.0), (10.3, 56.0)],
        approximate_legs=[True, False, True],
    )
    spans = flagged_run_spans_nm(route)
    assert len(spans) == 2
    assert all(s > 0 for s in spans)


def test_flagged_run_spans_nm_empty_when_nothing_flagged() -> None:
    route = _FakeRoute(waypoints=[(10.0, 56.0), (10.1, 56.0)], approximate_legs=[False])
    assert flagged_run_spans_nm(route) == []


# ── land_indexes_for_macro_route: candidate selection ──────────────────────


class _FakePath:
    def __init__(self, name: str) -> None:
        self.name = name


@dataclass
class _FakeCell:
    name: str
    scale: int
    # Always overlaps the macro pass's own (large) bbox.
    extent: tuple[float, float, float, float] = (-180.0, -90.0, 180.0, 90.0)

    @property
    def path(self) -> _FakePath:
        return _FakePath(self.name)


@dataclass
class _FakeSet:
    cells: list[_FakeCell]


class _FakeHazardIndex:
    def __init__(self, label: str) -> None:
        self.label = label
        self.ring_count = 1


class _FakeOcharts:
    def __init__(self, cells: list[_FakeCell]) -> None:
        self._set = _FakeSet(cells)
        self.calls: list[tuple[str, float, float]] = []

    def sets(self) -> dict[str, _FakeSet]:
        return {"s": self._set}

    def hazard_index(self, cs, cell: _FakeCell, safety_depth_m: float, margin_m: float) -> _FakeHazardIndex:
        self.calls.append((cell.name, safety_depth_m, margin_m))
        return _FakeHazardIndex(cell.name)


def test_land_indexes_for_macro_route_is_land_only() -> None:
    """`safety_depth_m`/`margin_m` must always be `0.0` — draft/margin are
    questions for the fine per-leg re-search, not this coarse pass."""
    oc = _FakeOcharts([_FakeCell(name="overview", scale=1_500_000)])
    land_indexes_for_macro_route(oc, A, B)
    assert oc.calls == [("overview", 0.0, 0.0)]


def test_land_indexes_for_macro_route_prefers_coarse_cells() -> None:
    fine = _FakeCell(name="fine", scale=8_000)  # a harbour-scale chart
    overview = _FakeCell(name="overview", scale=1_500_000)  # a real overview
    oc = _FakeOcharts([fine, overview])

    indexes = land_indexes_for_macro_route(oc, A, B)

    # Only the coarse/overview-scale cell is used — the fine harbour chart
    # is skipped entirely, since something DOES meet the overview
    # threshold (`_MACRO_OVERVIEW_SCALE_MIN`).
    assert [i.label for i in indexes] == ["overview"]


def test_land_indexes_for_macro_route_falls_back_when_nothing_is_coarse_enough() -> None:
    # A set with no true overview chart at all still gets an answer, not
    # a silent gap — falls back to whatever candidates exist.
    only_fine = _FakeCell(name="fine", scale=8_000)
    oc = _FakeOcharts([only_fine])

    indexes = land_indexes_for_macro_route(oc, A, B)

    assert [i.label for i in indexes] == ["fine"]


def test_land_indexes_for_macro_route_bounds_cell_count() -> None:
    # Many coarse cells, well past `_MACRO_MAX_CELLS` (40) — decode cost
    # must stay bounded regardless of how densely charted the region is.
    many = [_FakeCell(name=f"c{i}", scale=1_500_000 + i) for i in range(60)]
    oc = _FakeOcharts(many)

    indexes = land_indexes_for_macro_route(oc, A, B)

    assert len(indexes) == 40
    # Coarsest first: the 40 highest-scale cells, not an arbitrary subset.
    assert {i.label for i in indexes} == {f"c{i}" for i in range(20, 60)}


# ── _stitch_macro_route: assembling several real legs into one route ───────


@dataclass
class _FakeLeg:
    waypoints: list[tuple[float, float]]
    distance_m: float
    approximate_legs: list[bool]


def _identity_resimplify(monkeypatch) -> None:
    """Stand in for both ``hazard_indexes_for_bbox`` (a real call would
    hit the FAKE ``ocharts=None`` these tests pass) and ``chartcore.
    refine_route`` as a neutral passthrough — these tests are FAKE-data-
    driven (this file's own docstring) with no real chart set to query,
    and the refine/resimplify pass itself (#owqqcdqe, 2026-08-10) is
    proven directly against real chartcore geometry in
    ``chartcore/src/routing/raster.rs``'s own ``resimplify_and_reverify_*``/
    ``refine_stitched_route_*`` tests; the WIRING to it (right arguments,
    its return value actually used) is ``test_stitch_macro_route_
    resimplifies_the_concatenated_chain``, below — this fixture's own
    concern is `_stitch_macro_route`'s CONCATENATION logic, orthogonal to
    what refine then does with the result, so it stays out of the way
    here. `RoutingConfig()`'s own defaults (every preference weight `0`)
    are what keep `preference_indexes_for_line`/`buoyage_indexes_for_line`
    from ever touching the FAKE `ocharts=None` these tests pass — both
    short-circuit before it when their own `want_*` flag is `False`, no
    separate mock needed for either."""

    def fake_refine(waypoints, approximate_legs, indexes, **kwargs):
        return _FakeLeg(waypoints=list(waypoints), distance_m=-1.0, approximate_legs=[])

    monkeypatch.setattr(routes, "hazard_indexes_for_bbox", lambda ocharts, bbox, *a, **k: [])
    monkeypatch.setattr(routes.chartcore, "refine_route", fake_refine)


def test_stitch_macro_route_concatenates_legs_without_duplicating_shared_waypoints(
    monkeypatch,
) -> None:
    legs = {
        ((10.0, 56.0), (10.1, 56.0)): _FakeLeg(
            waypoints=[(10.0, 56.0), (10.05, 56.0), (10.1, 56.0)],
            distance_m=1000.0,
            approximate_legs=[False, False],
        ),
        ((10.1, 56.0), (10.2, 56.0)): _FakeLeg(
            waypoints=[(10.1, 56.0), (10.2, 56.0)],
            distance_m=800.0,
            approximate_legs=[True],
        ),
    }

    def fake_plan_leg(ocharts, a, b, safety_depth_m, cfg, timings, collect_debug=False):
        key = ((a.lon, a.lat), (b.lon, b.lat))
        return legs[key], [], None

    monkeypatch.setattr(routes, "_plan_leg", fake_plan_leg)
    monkeypatch.setattr(routes, "hazard_indexes_for_bbox", lambda ocharts, bbox, *a, **k: [])
    # `distance_m`/`approximate_legs` come from `chartcore.refine_route`'s
    # own PyO3 return now (#owqqcdqe, 2026-08-10) — assert the WAYPOINTS
    # this test actually cares about; a second, dedicated test (`test_
    # stitch_macro_route_resimplifies_the_concatenated_chain`) covers
    # those two fields' own wiring instead, with a fake that returns
    # something visibly different from a plain passthrough.
    monkeypatch.setattr(
        routes.chartcore,
        "refine_route",
        lambda waypoints, approximate_legs, indexes, **kwargs: _FakeLeg(
            waypoints=list(waypoints), distance_m=1800.0, approximate_legs=None
        ),
    )

    macro_waypoints = [(10.0, 56.0), (10.1, 56.0), (10.2, 56.0)]
    stitched = routes._stitch_macro_route(None, macro_waypoints, 3.0, RoutingConfig(), None)

    assert stitched is not None
    # Each leg's SHARED endpoint appears exactly once, not twice.
    assert stitched.waypoints == [
        (10.0, 56.0),
        (10.05, 56.0),
        (10.1, 56.0),
        (10.2, 56.0),
    ]


def test_stitch_macro_route_resimplifies_the_concatenated_chain(monkeypatch) -> None:
    # The wiring `test_stitch_macro_route_concatenates_legs_without_
    # duplicating_shared_waypoints` deliberately doesn't cover: the
    # concatenated chain's `distance_m`/`approximate_legs` (and, if it
    # changed anything, `waypoints`) come from `chartcore.resimplify_
    # route`'s OWN return, not from summing/concatenating each sub-leg's
    # own — a fake that visibly differs from a plain passthrough proves
    # the wiring reaches it, not just that SOME value survives.
    legs = {
        ((10.0, 56.0), (10.1, 56.0)): _FakeLeg(
            waypoints=[(10.0, 56.0), (10.05, 56.0), (10.1, 56.0)],
            distance_m=1000.0,
            approximate_legs=[False, False],
        ),
        ((10.1, 56.0), (10.2, 56.0)): _FakeLeg(
            waypoints=[(10.1, 56.0), (10.2, 56.0)],
            distance_m=800.0,
            approximate_legs=[True],
        ),
    }

    def fake_plan_leg(ocharts, a, b, safety_depth_m, cfg, timings, collect_debug=False):
        key = ((a.lon, a.lat), (b.lon, b.lat))
        return legs[key], [], None

    monkeypatch.setattr(routes, "_plan_leg", fake_plan_leg)

    # A sentinel, not `[]` — proves it's a FRESH `hazard_indexes_for_bbox`
    # call (over the WHOLE chain's own bbox, #owqqcdqe 2026-08-10 — see
    # `_stitch_macro_route`'s own docs for why NOT each sub-leg's own
    # `indexes` concatenated) that actually reaches `refine_route`, not an
    # empty placeholder nobody checked.
    bbox_calls: list[tuple] = []
    sentinel_indexes = ["SENTINEL_INDEX"]

    def fake_hazard_indexes_for_bbox(ocharts, bbox, safety_depth_m, margin_m, timings=None, **kwargs):
        bbox_calls.append(bbox)
        return sentinel_indexes

    monkeypatch.setattr(routes, "hazard_indexes_for_bbox", fake_hazard_indexes_for_bbox)

    seen_calls: list[tuple[list[tuple[float, float]], list[bool], list]] = []

    def fake_refine(waypoints, approximate_legs, indexes, **kwargs):
        seen_calls.append((list(waypoints), list(approximate_legs), list(indexes)))
        # A visibly DIFFERENT shape from the raw concatenation — collapses
        # the middle two points into one, and reports a shorter distance
        # — so the assertions below can only pass if `_stitch_macro_route`
        # actually took THIS return value, not its own running totals.
        return _FakeLeg(waypoints=[(10.0, 56.0), (10.2, 56.0)], distance_m=1234.5, approximate_legs=[True])

    monkeypatch.setattr(routes.chartcore, "refine_route", fake_refine)

    macro_waypoints = [(10.0, 56.0), (10.1, 56.0), (10.2, 56.0)]
    stitched = routes._stitch_macro_route(None, macro_waypoints, 3.0, RoutingConfig(), None)

    assert stitched is not None
    assert stitched.waypoints == [(10.0, 56.0), (10.2, 56.0)]
    assert stitched.distance_m == 1234.5
    assert stitched.approximate_legs == [True]
    # `refine_route` called once, with the FULL concatenated chain (not
    # per-leg), its matching `approximate_legs`, and EXACTLY the indexes
    # `hazard_indexes_for_bbox` returned for it — not `[]`, not each
    # sub-leg's own `indexes`.
    assert len(seen_calls) == 1
    assert seen_calls[0][0] == [(10.0, 56.0), (10.05, 56.0), (10.1, 56.0), (10.2, 56.0)]
    assert seen_calls[0][1] == [False, False, True]
    assert seen_calls[0][2] == sentinel_indexes
    # `hazard_indexes_for_bbox` itself got ONE whole-chain bbox — tightly
    # bounding every waypoint (10.0..10.2 lon, all at lat 56.0), not a
    # per-sub-leg one.
    assert len(bbox_calls) == 1
    w, s, e, n = bbox_calls[0]
    assert w < 10.0 < 10.2 < e
    assert s < 56.0 < n


def test_stitch_macro_route_returns_none_when_a_leg_fails_outright(monkeypatch) -> None:
    def fake_plan_leg(ocharts, a, b, safety_depth_m, cfg, timings, collect_debug=False):
        return None, [], None

    monkeypatch.setattr(routes, "_plan_leg", fake_plan_leg)

    macro_waypoints = [(10.0, 56.0), (10.1, 56.0)]
    stitched = routes._stitch_macro_route(None, macro_waypoints, 3.0, RoutingConfig(), None)

    assert stitched is None


def test_stitch_macro_route_collects_one_debug_entry_per_sub_leg_when_asked(monkeypatch) -> None:
    # #owqqcdqe, 2026-08-10: the debug layer's own payload for a
    # macro-stitched route is per SUB-leg, not per macro waypoint pair
    # collapsed into one — each real search gets its own bbox/rings, in
    # order, so a caller can tell which specific stretch a bend came from.
    legs = {
        ((10.0, 56.0), (10.1, 56.0)): (
            _FakeLeg(waypoints=[(10.0, 56.0), (10.1, 56.0)], distance_m=1000.0, approximate_legs=[False]),
            {"bbox": [9.9, 55.9, 10.2, 56.1], "hazard_rings": []},
        ),
        ((10.1, 56.0), (10.2, 56.0)): (
            _FakeLeg(waypoints=[(10.1, 56.0), (10.2, 56.0)], distance_m=800.0, approximate_legs=[True]),
            {"bbox": [10.0, 55.9, 10.3, 56.1], "hazard_rings": [[[10.15, 56.0], [10.16, 56.0], [10.15, 56.01]]]},
        ),
    }

    def fake_plan_leg(ocharts, a, b, safety_depth_m, cfg, timings, collect_debug=False):
        key = ((a.lon, a.lat), (b.lon, b.lat))
        leg, debug = legs[key]
        return leg, [], (debug if collect_debug else None)

    monkeypatch.setattr(routes, "_plan_leg", fake_plan_leg)
    _identity_resimplify(monkeypatch)

    macro_waypoints = [(10.0, 56.0), (10.1, 56.0), (10.2, 56.0)]

    without_debug = routes._stitch_macro_route(None, macro_waypoints, 3.0, RoutingConfig(), None)
    assert without_debug.leg_debugs == []

    with_debug = routes._stitch_macro_route(None, macro_waypoints, 3.0, RoutingConfig(), None, collect_debug=True)
    assert len(with_debug.leg_debugs) == 2
    assert with_debug.leg_debugs[0]["bbox"] == [9.9, 55.9, 10.2, 56.1]
    assert with_debug.leg_debugs[1]["hazard_rings"] != []


# ── _macro_route_improves: only replace the original when it's genuinely
# better, not just different ──────────────────────────────────────────────


def test_macro_route_improves_true_when_the_stitched_worst_gap_is_smaller() -> None:
    original = StitchedRoute(
        waypoints=[(10.0, 56.0), (10.3, 56.0)],
        approximate_legs=[True],  # ~10nm flagged
    )
    stitched = StitchedRoute(
        waypoints=[(10.0, 56.0), (10.1, 56.0), (10.2, 56.0), (10.3, 56.0)],
        approximate_legs=[False, False, False],  # fully resolved
    )
    assert routes._macro_route_improves(stitched, original)


def test_macro_route_improves_false_when_the_stitch_is_no_better() -> None:
    original = StitchedRoute(
        waypoints=[(10.0, 56.0), (10.05, 56.0), (10.1, 56.0)],
        approximate_legs=[False, True],  # small flagged run already
    )
    stitched = StitchedRoute(
        waypoints=[(10.0, 56.0), (10.3, 56.0)],
        approximate_legs=[True],  # a much WORSE, longer flagged run
    )
    assert not routes._macro_route_improves(stitched, original)


# ── natural_earth_land_rings: chart-independent land truth for the gap a
# chart set's own coverage doesn't reach. Real bundled data (Natural Earth
# Admin-0, `mivnav.geo.countries`), not mocked — small and fast enough that
# testing against the real thing is more valuable than a fake here. Found
# live: with nothing here, a macro request past the edge of the boat's
# installed chart set read the total absence of hazard rings as open water
# and drew a path straight across real, populated land. ──

# Denmark's own bbox (mivnav.geo.countries.country_bbox('DK')): roughly
# (8.1, 54.6, 15.1, 57.7) — used below to build boxes that do/don't reach it.
_DENMARK_BBOX = (8.121, 54.629, 15.137, 57.737)


def test_natural_earth_land_rings_finds_denmark() -> None:
    rings = natural_earth_land_rings(_DENMARK_BBOX)
    assert len(rings) > 0
    # Every ring is a real closed-ish polygon exterior, not a degenerate
    # 0/1/2-point stub.
    assert all(len(r) >= 3 for r in rings)


def test_natural_earth_land_rings_empty_far_from_any_land() -> None:
    # Mid South Atlantic, between South America and Africa — nowhere near
    # any island or coastline. NOT the South Pacific: several Pacific
    # nations' own territories straddle the antimeridian, which is exactly
    # the kind of real bbox pitfall this function's own filtering (per
    # POLYGON, not per country) exists to avoid — see its own docstring.
    rings = natural_earth_land_rings((-30.0, -30.0, -29.0, -29.0))
    assert rings == []


def test_natural_earth_land_rings_not_fooled_by_an_antimeridian_spanning_country() -> None:
    # New Zealand's own AGGREGATE bbox (`country_bbox('NZ')`) spans roughly
    # -177 to +178 longitude — its remote Pacific territories collapsed
    # into one box that matches almost any longitude on Earth. A query
    # bbox nowhere near New Zealand itself (mid North Atlantic) must not
    # pull in New Zealand's polygon just because the naive aggregate bbox
    # would have matched — the real regression this function's own
    # per-polygon filtering exists to fix.
    from mivnav.geo.countries import country_bbox

    nz_bbox = country_bbox("NZ")
    assert nz_bbox[0] < 0 < nz_bbox[2], f"sanity: NZ's own aggregate bbox should span the antimeridian: {nz_bbox}"

    rings = natural_earth_land_rings((-40.0, 40.0, -39.0, 41.0))  # mid North Atlantic
    assert rings == []


def test_natural_earth_land_rings_exterior_only_one_ring_per_polygon() -> None:
    from mivnav.geo.countries import country_polygon

    rings = natural_earth_land_rings(_DENMARK_BBOX)
    dk_polygon_count = len(country_polygon("DK"))
    # At minimum Denmark's own polygons must all be represented — other
    # nearby countries (Germany, Sweden) may contribute rings too, so this
    # is a lower bound, not an exact count.
    assert len(rings) >= dk_polygon_count
