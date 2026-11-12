# SPDX-License-Identifier: GPL-2.0-only
"""Unit tests for the shared search index (mivnav.search.index).

No network, no FastAPI — a bare SearchIndex over a tmp_path file, exercising
rebake (insert, replace-in-place, delete-scope) and search (text/category/
source/bbox filters).
"""

import sqlite3
from pathlib import Path

import pytest

from mivnav.search.index import SearchIndex, SearchRecord


@pytest.fixture
def index(tmp_path: Path) -> SearchIndex:
    idx = SearchIndex(tmp_path / "search" / "index.sqlite3")
    yield idx
    idx.close()


def _rec(id_, category, title, lon, lat) -> SearchRecord:
    return SearchRecord(
        id=id_, category=category, title=title, text=title, lat=lat, lon=lon,
        data={"category": category},
    )


def test_a_database_with_the_old_two_column_fts_table_is_migrated(tmp_path: Path):
    """`CREATE VIRTUAL TABLE IF NOT EXISTS` is a no-op on a database that
    already has the pre-category 2-column `records_fts` — an existing index
    must be rebuilt explicitly, or `rebake`'s 4-column INSERT raises."""
    path = tmp_path / "old.sqlite3"
    conn = sqlite3.connect(str(path))
    conn.executescript(
        """
        CREATE TABLE records (
            id TEXT PRIMARY KEY, source TEXT NOT NULL, region TEXT NOT NULL,
            category TEXT, title TEXT, text TEXT, lat REAL, lon REAL,
            data TEXT NOT NULL DEFAULT '{}', updated_at REAL NOT NULL
        );
        CREATE VIRTUAL TABLE records_rtree USING rtree(id, min_lon, max_lon, min_lat, max_lat);
        CREATE VIRTUAL TABLE records_fts USING fts5(title, text);
        """
    )
    conn.execute(
        "INSERT INTO records VALUES "
        "('poi:solent:1', 'poi', 'solent', 'supermarket', 'Tesco', 'Tesco', "
        "-1.3, 50.75, '{}', 1.0)"
    )
    conn.execute("INSERT INTO records_fts(rowid, title, text) VALUES (1, 'Tesco', 'Tesco')")
    conn.commit()
    conn.close()

    idx = SearchIndex(path)
    try:
        # Pre-existing rows are still found by title, and by category — the
        # whole point of the migration, not just "does not crash".
        assert [r["title"] for r in idx.search("Tesco")] == ["Tesco"]
        assert [r["title"] for r in idx.search("supermarket")] == ["Tesco"]
        # And a fresh bake (a different region, so it doesn't replace the
        # pre-existing "solent" slice) into the migrated table still works.
        idx.rebake(
            "poi", "dk",
            [_rec("2", "marina", "New Marina", 0.0, 0.0)],
            updated_at=2.0,
        )
        assert {r["title"] for r in idx.search()} == {"Tesco", "New Marina"}
    finally:
        idx.close()


def test_rebake_creates_the_db_file(tmp_path: Path):
    path = tmp_path / "nested" / "index.sqlite3"
    idx = SearchIndex(path)
    assert path.is_file()
    idx.close()


def test_search_with_no_filters_returns_inserted_records(index: SearchIndex):
    n = index.rebake(
        "poi", "solent",
        [_rec("1", "marina", "Test Marina", -1.30, 50.75)],
        updated_at=1.0,
    )
    assert n == 1
    results = index.search()
    assert len(results) == 1
    r = results[0]
    assert r["source"] == "poi"
    assert r["region"] == "solent"
    assert r["category"] == "marina"
    assert r["title"] == "Test Marina"
    assert r["data"] == {"category": "marina"}


def test_search_by_text_matches_title(index: SearchIndex):
    index.rebake(
        "poi", "solent",
        [
            _rec("1", "marina", "Cowes Marina", -1.30, 50.75),
            _rec("2", "fuel", "Fuel Berth", -1.20, 50.70),
        ],
        updated_at=1.0,
    )
    results = index.search("Cowes")
    assert [r["title"] for r in results] == ["Cowes Marina"]


def test_search_by_text_matches_a_partial_prefix(index: SearchIndex):
    index.rebake("poi", "solent", [_rec("1", "marina", "Cowes Marina", -1.30, 50.75)], updated_at=1.0)
    assert [r["title"] for r in index.search("Cow")] == ["Cowes Marina"]


@pytest.mark.parametrize(
    "query",
    ["St. John's", '"quoted"', "-leading-dash", "AND OR NOT", "*", ""],
)
def test_search_never_raises_on_punctuated_or_operator_like_input(
    index: SearchIndex, query: str
):
    """A raw MATCH would raise sqlite3.OperationalError on most of these —
    the query is always data, never FTS5 syntax."""
    index.rebake("poi", "solent", [_rec("1", "marina", "St. John's Marina", 0.0, 0.0)], updated_at=1.0)
    index.search(query)  # must not raise


def test_search_by_free_text_matches_category_not_just_title(index: SearchIndex):
    """"supermarket" should surface every supermarket, not just one whose
    name happens to contain the word — category is indexed for free text too."""
    index.rebake(
        "poi", "solent",
        [
            _rec("1", "supermarket", "Tesco Cowes", -1.30, 50.75),
            _rec("2", "supermarket", "Co-op Yarmouth", -1.50, 50.70),
            _rec("3", "marina", "Cowes Marina", -1.30, 50.76),
        ],
        updated_at=1.0,
    )
    titles = sorted(r["title"] for r in index.search("supermarket"))
    assert titles == ["Co-op Yarmouth", "Tesco Cowes"]


def test_search_by_category(index: SearchIndex):
    index.rebake(
        "poi", "solent",
        [
            _rec("1", "marina", "A", -1.30, 50.75),
            _rec("2", "fuel", "B", -1.20, 50.70),
        ],
        updated_at=1.0,
    )
    results = index.search(category="fuel")
    assert [r["title"] for r in results] == ["B"]


def test_search_by_source(index: SearchIndex):
    index.rebake("poi", "solent", [_rec("1", "marina", "A", 0.0, 0.0)], updated_at=1.0)
    index.rebake("navwarning", "solent", [_rec("1", None, "B", 0.0, 0.0)], updated_at=1.0)
    assert [r["title"] for r in index.search(source="poi")] == ["A"]
    assert [r["title"] for r in index.search(source="navwarning")] == ["B"]


def test_search_by_bbox(index: SearchIndex):
    index.rebake(
        "poi", "world",
        [
            _rec("in", "marina", "Inside", 0.0, 0.0),
            _rec("out", "marina", "Outside", 50.0, 50.0),
        ],
        updated_at=1.0,
    )
    results = index.search(bbox=(-1.0, -1.0, 1.0, 1.0))
    assert [r["title"] for r in results] == ["Inside"]


def test_rebake_same_source_and_region_ids_do_not_collide(index: SearchIndex):
    """Two different sources (or the same source, two regions) may reuse the
    same bare SearchRecord.id with no PRIMARY KEY collision — rebake qualifies
    it with source/region internally."""
    index.rebake("poi", "dk", [_rec("1", "marina", "Danish", 10.0, 56.0)], updated_at=1.0)
    index.rebake("poi", "gb", [_rec("1", "marina", "British", -1.0, 51.0)], updated_at=1.0)
    titles = sorted(r["title"] for r in index.search())
    assert titles == ["British", "Danish"]


def test_rebake_replaces_region_in_place(index: SearchIndex):
    index.rebake(
        "poi", "solent",
        [_rec("1", "marina", "Old Marina", -1.30, 50.75)],
        updated_at=1.0,
    )
    index.rebake(
        "poi", "solent",
        [_rec("1", "marina", "New Marina", -1.30, 50.75)],
        updated_at=2.0,
    )
    results = index.search()
    assert [r["title"] for r in results] == ["New Marina"]


def test_rebake_drops_records_no_longer_produced_upstream(index: SearchIndex):
    """A plain upsert-by-id would leave a vanished POI as an orphan row;
    rebake replaces the whole (source, region) slice, so it doesn't."""
    index.rebake(
        "poi", "solent",
        [_rec("1", "marina", "A", 0.0, 0.0), _rec("2", "fuel", "B", 0.0, 0.0)],
        updated_at=1.0,
    )
    index.rebake("poi", "solent", [_rec("1", "marina", "A", 0.0, 0.0)], updated_at=2.0)
    titles = sorted(r["title"] for r in index.search())
    assert titles == ["A"]


def test_rebake_does_not_touch_other_regions(index: SearchIndex):
    index.rebake("poi", "dk", [_rec("1", "marina", "Danish", 10.0, 56.0)], updated_at=1.0)
    index.rebake("poi", "gb", [_rec("1", "marina", "British", -1.0, 51.0)], updated_at=1.0)
    index.rebake("poi", "gb", [], updated_at=2.0)  # GB now empty
    titles = sorted(r["title"] for r in index.search())
    assert titles == ["Danish"]


def test_search_respects_limit(index: SearchIndex):
    records = [_rec(str(i), "marina", f"Marina {i}", 0.0, 0.0) for i in range(5)]
    index.rebake("poi", "solent", records, updated_at=1.0)
    assert len(index.search(limit=2)) == 2


def test_record_with_no_coordinates_is_not_bbox_searchable_but_is_listed(
    index: SearchIndex,
):
    index.rebake(
        "navwarning", "solent",
        [SearchRecord(id="1", category=None, title="No coords", text="", lat=None, lon=None, data={})],
        updated_at=1.0,
    )
    assert index.search()[0]["title"] == "No coords"
    assert index.search(bbox=(-1.0, -1.0, 1.0, 1.0)) == []


def test_record_count_with_no_filters_is_the_whole_table(index: SearchIndex):
    index.rebake("poi", "solent", [_rec("1", "marina", "A", 0.0, 0.0)], updated_at=1.0)
    index.rebake("poi", "denmark", [_rec("1", "marina", "B", 0.0, 0.0)], updated_at=1.0)
    assert index.record_count() == 2


def test_record_count_filters_by_source_and_region(index: SearchIndex):
    index.rebake(
        "poi", "solent", [_rec(str(i), "marina", f"S{i}", 0.0, 0.0) for i in range(3)],
        updated_at=1.0,
    )
    index.rebake("navwarning", "solent", [_rec("1", None, "W", 0.0, 0.0)], updated_at=1.0)
    assert index.record_count(source="poi") == 3
    assert index.record_count(region="solent") == 4
    assert index.record_count(source="poi", region="solent") == 3
    assert index.record_count(source="poi", region="denmark") == 0
