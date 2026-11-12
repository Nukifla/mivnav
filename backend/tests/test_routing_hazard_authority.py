# SPDX-License-Identifier: GPL-2.0-only
"""``hazards.py``'s own chart-authority orchestration:
``hazard_indexes_for_line`` processes candidate cells finest-scale-first
and clips a coarser cell's hazard against every already-processed (so
at-least-as-fine) cell's own charted coverage — asked for directly, from
a real reported case: a 1:1,500,000 overview chart's simplified
coastline silently overriding an accurate 1:8,000 harbour chart's "this
is open water" for the same ground, because the hazard union used to
just union every overlapping chart with no regard for which one is
authoritative there. See ``ROUTING_TODO.md``.

Also covers the land floor (``ocharts.land_hazard_index``,
``hazard_indexes_for_bbox``'s own docs' "The land floor" section) — the
INVERSE bug, found live against a real commercial chart set: a coarser
cell's correct coastline silently vanishing along a thin strip exactly
where a finer cell's coverage claimed authority over ground it never
itself re-digitized as land. Unlike the ordinary ``hazard_index`` half
above, this half is NEVER clipped — every candidate's land-only union
rides along regardless of chart-authority order.

Driven with FAKE duck-typed stand-ins, not real chart data — chartcore's
own geometry correctness (the actual clip) is covered separately,
``chartcore/src/routing/hazards.rs``'s ``clip_to_authority`` tests. This
file proves the WIRING: which cells get clipped against which coverage,
in what order — not the geometry itself.
"""

from __future__ import annotations

from dataclasses import dataclass

from mivnav.features.routing.geo import Point
from mivnav.features.routing.hazards import hazard_indexes_for_line

A = Point(0.0, 0.0)
B = Point(0.0, 0.1)


class _FakePath:
    def __init__(self, name: str) -> None:
        self.name = name


@dataclass
class _FakeCell:
    name: str
    scale: int
    coverage: object | None
    # Always overlaps any real corridor bbox `_candidate_cells` computes —
    # candidate SELECTION itself isn't what this file is testing.
    extent: tuple[float, float, float, float] = (-180.0, -90.0, 180.0, 90.0)

    @property
    def path(self) -> _FakePath:
        return _FakePath(self.name)


@dataclass
class _FakeSet:
    cells: list[_FakeCell]


class _FakeHazardIndex:
    """Records what it was clipped against. `ring_count` is a fixed
    stand-in (unused by `hazard_indexes_for_line` beyond a `Timings`
    detail string, not asserted on here)."""

    def __init__(self, label: str) -> None:
        self.label = label
        self.ring_count = 1
        self.clipped_against: list | None = None

    def clipped_to_authority(self, finer_coverages: list) -> "_FakeHazardIndex | None":
        self.clipped_against = list(finer_coverages)
        # A synthetic "fully superseded" rule for
        # `test_a_hazard_fully_superseded_by_a_finer_chart_is_dropped_entirely`:
        # a coverage literally named "SUPERSEDE:<this cell>" consumes it whole.
        if f"SUPERSEDE:{self.label}" in finer_coverages:
            return None
        return self


class _FakeLandHazardIndex:
    """`ocharts.land_hazard_index`'s own stand-in — deliberately has NO
    `clipped_to_authority` method at all (unlike `_FakeHazardIndex`
    above): `hazard_indexes_for_bbox` must never call it on this value —
    if a future change ever tried, this would raise `AttributeError`
    instead of silently passing, which a `_FakeHazardIndex`-shaped stub
    would not catch."""

    def __init__(self, label: str) -> None:
        self.label = label
        self.ring_count = 1


class _FakeOcharts:
    """Duck-typed `ocharts` — the shape `hazard_indexes_for_line` needs
    (`.sets()`, `.hazard_index(...)`, `.land_hazard_index(...)`), same
    contract `hazards.py`'s own module docstring documents."""

    def __init__(self, cells: list[_FakeCell]) -> None:
        self._set = _FakeSet(cells)
        self.calls: list[str] = []  # cell names, in the order hazard_index was called
        self.land_calls: list[str] = []

    def sets(self) -> dict[str, _FakeSet]:
        return {"s": self._set}

    def hazard_index(
        self, cs, cell: _FakeCell, safety_depth_m: float, margin_m: float, air_draft_m: float = 0.0
    ) -> _FakeHazardIndex:
        self.calls.append(cell.name)
        return _FakeHazardIndex(cell.name)

    def land_hazard_index(self, cs, cell: _FakeCell, margin_m: float) -> _FakeLandHazardIndex:
        self.land_calls.append(cell.name)
        return _FakeLandHazardIndex(f"land:{cell.name}")


def test_candidates_are_processed_finest_scale_first() -> None:
    coarse = _FakeCell(name="coarse", scale=1_500_000, coverage="coarse-cov")
    mid = _FakeCell(name="mid", scale=90_000, coverage="mid-cov")
    fine = _FakeCell(name="fine", scale=8_000, coverage="fine-cov")
    oc = _FakeOcharts([coarse, mid, fine])  # deliberately NOT in scale order

    hazard_indexes_for_line(oc, A, B, safety_depth_m=2.0, margin_m=0.0)

    assert oc.calls == ["fine", "mid", "coarse"]


def test_a_coarser_cell_is_clipped_against_every_already_processed_finer_coverage() -> None:
    coarse = _FakeCell(name="coarse", scale=1_500_000, coverage="coarse-cov")
    mid = _FakeCell(name="mid", scale=90_000, coverage="mid-cov")
    fine = _FakeCell(name="fine", scale=8_000, coverage="fine-cov")
    oc = _FakeOcharts([coarse, mid, fine])

    indexes = hazard_indexes_for_line(oc, A, B, safety_depth_m=2.0, margin_m=0.0)
    by_label = {i.label: i for i in indexes}

    # The finest cell is processed FIRST — nothing finer exists yet, so
    # it must never even be clipped (not just "clipped against nothing").
    assert by_label["fine"].clipped_against is None
    assert by_label["mid"].clipped_against == ["fine-cov"]
    assert by_label["coarse"].clipped_against == ["fine-cov", "mid-cov"]


def test_a_cell_with_no_declared_coverage_never_becomes_a_finer_authority() -> None:
    # `coverage=None` (no real coverage rings — the same "a bare extent
    # box is not evidence" instinct chartcore::mvt::select's own
    # `is_extent_box` guard applies, see hazard_indexes_for_line's own
    # docstring) must never end up in a COARSER cell's finer_coverages
    # list, even though it is itself processed earlier (finer scale).
    no_coverage = _FakeCell(name="finest-no-coverage", scale=1_000, coverage=None)
    coarse = _FakeCell(name="coarse", scale=1_500_000, coverage="coarse-cov")
    oc = _FakeOcharts([coarse, no_coverage])

    indexes = hazard_indexes_for_line(oc, A, B, safety_depth_m=2.0, margin_m=0.0)
    by_label = {i.label: i for i in indexes}

    # finer_coverages stayed empty the whole way through, so the coarse
    # cell's index is never even asked to clip.
    assert by_label["coarse"].clipped_against is None


def test_a_hazard_fully_superseded_by_a_finer_chart_is_dropped_entirely() -> None:
    fine = _FakeCell(name="fine", scale=8_000, coverage="SUPERSEDE:coarse")
    coarse = _FakeCell(name="coarse", scale=1_500_000, coverage="coarse-cov")
    oc = _FakeOcharts([coarse, fine])

    indexes = hazard_indexes_for_line(oc, A, B, safety_depth_m=2.0, margin_m=0.0)

    labels = [i.label for i in indexes]
    assert "fine" in labels
    assert "coarse" not in labels, "a coarse cell's hazard fully vouched for by a finer chart must not survive"


# -- the land floor: land_hazard_index, unconditional, never clipped --------
#
# The real bug this section closes (found live, against a real commercial
# chart set): a coarser cell's correct coastline silently vanished along a
# thin strip exactly where a finer cell's coverage overlapped ground that
# finer cell never itself re-digitized as land — clip_to_authority is right
# to trust a finer chart's own NAVIGABILITY claims, but land is not a
# navigability disagreement.
#
# Every fixture below uses `scale=90_000` for its "coarse" cell (a real
# IHO Coastal-band scale, well under `_MACRO_OVERVIEW_SCALE_MIN`), not
# `1_500_000` — see `test_a_genuine_overview_scale_candidate_is_excluded_
# from_the_land_floor` for the SECOND real regression that distinction
# closes: an actual `1_500_000`-scale overview candidate must NOT get this
# floor at all, so using that scale everywhere above would have silently
# stopped testing what these tests claim to test.


def test_every_candidate_contributes_its_own_land_hazard_index() -> None:
    coarse = _FakeCell(name="coarse", scale=90_000, coverage="coarse-cov")
    fine = _FakeCell(name="fine", scale=8_000, coverage="fine-cov")
    oc = _FakeOcharts([coarse, fine])

    indexes = hazard_indexes_for_line(oc, A, B, safety_depth_m=2.0, margin_m=0.0)

    assert sorted(oc.land_calls) == ["coarse", "fine"]
    labels = [i.label for i in indexes]
    assert "land:coarse" in labels
    assert "land:fine" in labels


def test_land_hazard_index_is_never_clipped_even_when_the_ordinary_hazard_would_be() -> None:
    # Same fixture shape as `test_a_hazard_fully_superseded_by_a_finer_
    # chart_is_dropped_entirely` (the coarse cell's ORDINARY hazard is
    # fully consumed) — the coarse cell's LAND floor must survive that
    # exact scenario regardless, because `_FakeLandHazardIndex` has no
    # `clipped_to_authority` at all: if `hazard_indexes_for_bbox` ever
    # tried to clip it, this would raise instead of silently passing.
    fine = _FakeCell(name="fine", scale=8_000, coverage="SUPERSEDE:coarse")
    coarse = _FakeCell(name="coarse", scale=90_000, coverage="coarse-cov")
    oc = _FakeOcharts([coarse, fine])

    indexes = hazard_indexes_for_line(oc, A, B, safety_depth_m=2.0, margin_m=0.0)

    labels = [i.label for i in indexes]
    assert "coarse" not in labels  # the ordinary hazard is still gone, as before
    assert "land:coarse" in labels  # but the land floor survives regardless


def test_a_genuine_overview_scale_candidate_is_excluded_from_the_land_floor() -> None:
    # The second real regression (found live, at a real marina): a
    # 1:1,500,000 Denmark-wide OVERVIEW chart generalizes away a small
    # harbour notch by design, so its own simplified coastline shows solid
    # land right where a finer, locally-accurate chart correctly shows
    # water. The first version of this floor had no scale gate at all and
    # unconditionally trusted that overview land — which made the notch
    # unreachable EVERYWHERE, since an overview chart covering "roughly
    # all of Denmark" is always a candidate. An overview-scale candidate's
    # ordinary hazard must still reach `clip_to_authority` exactly as
    # before this floor existed (unchanged, proven elsewhere in this
    # file) — only its LAND-FLOOR contribution is the one thing excluded.
    overview = _FakeCell(name="overview", scale=1_500_000, coverage="overview-cov")
    fine = _FakeCell(name="fine", scale=8_000, coverage="fine-cov")
    oc = _FakeOcharts([overview, fine])

    indexes = hazard_indexes_for_line(oc, A, B, safety_depth_m=2.0, margin_m=0.0)

    assert oc.land_calls == ["fine"]  # land_hazard_index was never even called for "overview"
    labels = [i.label for i in indexes]
    assert "land:overview" not in labels
    assert "land:fine" in labels
    assert "overview" in labels  # its ORDINARY hazard is still there, still clip-eligible


def test_a_broken_land_hazard_build_does_not_discard_the_cell_s_ordinary_hazard() -> None:
    # Mirrors the existing "a broken cell must not fail the whole route
    # check" instinct (`hazard_indexes_for_bbox`'s own try/except around
    # `ocharts.hazard_index`) — a SEPARATE try/except around the land
    # floor means a land-only build failure loses only that cell's land
    # contribution, not its already-succeeded ordinary hazard too.
    class _BrokenLandOcharts(_FakeOcharts):
        def land_hazard_index(self, cs, cell, margin_m):
            raise RuntimeError("boom")

    fine = _FakeCell(name="fine", scale=8_000, coverage="fine-cov")
    oc = _BrokenLandOcharts([fine])

    indexes = hazard_indexes_for_line(oc, A, B, safety_depth_m=2.0, margin_m=0.0)

    labels = [i.label for i in indexes]
    assert "fine" in labels
    assert not any(label.startswith("land:") for label in labels)
