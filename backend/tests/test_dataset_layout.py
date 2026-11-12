# SPDX-License-Identifier: GPL-2.0-only
"""M-DATA-3's on-disk mover: relocating pre-existing flat provider dirs into
``data_root/<provider>/<dataset_id>/``, and the small ``dataset.json`` sidecar.

Unit-level (the pure filesystem behaviour), plus one test driving it through
:class:`~mivnav.config.store.ConfigStore` end to end — the same "through the
store" pairing :mod:`test_config_migrate` uses for the pure key-rename half.
"""

from __future__ import annotations

import json
from pathlib import Path

from mivnav.config.dataset_layout import (
    dataset_disk_stats,
    migrate_legacy_dataset_dirs,
    read_dataset_json,
    write_dataset_json,
)
from mivnav.config.store import ConfigStore


def test_write_and_read_dataset_json(tmp_path: Path) -> None:
    write_dataset_json(tmp_path, dataset_id="solent", provider="poi", name="Solent")
    data = read_dataset_json(tmp_path)
    assert data is not None
    assert data["id"] == "solent"
    assert data["provider"] == "poi"
    assert data["name"] == "Solent"
    assert "updated_at" in data


def test_read_dataset_json_absent_is_none(tmp_path: Path) -> None:
    assert read_dataset_json(tmp_path) is None


def test_read_dataset_json_malformed_is_none(tmp_path: Path) -> None:
    (tmp_path / "dataset.json").write_text("not json")
    assert read_dataset_json(tmp_path) is None


# -- dataset_disk_stats: the generic GET /datasets size/last_bake_at facts --


def test_dataset_disk_stats_of_a_missing_directory_is_zero_and_none(tmp_path: Path) -> None:
    assert dataset_disk_stats(tmp_path / "never-baked") == (0, None)


def test_dataset_disk_stats_of_an_empty_directory_is_zero_and_none(tmp_path: Path) -> None:
    empty = tmp_path / "empty"
    empty.mkdir()
    assert dataset_disk_stats(empty) == (0, None)


def test_dataset_disk_stats_sums_every_file_and_reports_the_newest_mtime(
    tmp_path: Path,
) -> None:
    import os
    import time

    directory = tmp_path / "solent"
    directory.mkdir()
    (directory / "solent.pmtiles").write_bytes(b"1234567890")  # 10 bytes
    (directory / "solent.json").write_text("{}")  # 2 bytes
    older = directory / "solent.pmtiles"
    newer = directory / "solent.json"
    now = time.time()
    os.utime(older, (now - 100, now - 100))
    os.utime(newer, (now, now))

    size, last_bake_at = dataset_disk_stats(directory)
    assert size == 12
    assert last_bake_at is not None
    # the newest file's mtime, not the oldest's or an average
    from datetime import datetime, timezone

    assert last_bake_at == datetime.fromtimestamp(now, tz=timezone.utc).isoformat()


def test_dataset_disk_stats_ignores_nested_subdirectories_only_as_containers(
    tmp_path: Path,
) -> None:
    """A nested set of files (o-charts' own layout: a directory per
    installed chart, not a flat file) is walked too, not just the top
    level."""
    directory = tmp_path / "some-chart"
    nested = directory / "cell-dir"
    nested.mkdir(parents=True)
    (nested / "cell.oesu").write_bytes(b"xx")
    size, last_bake_at = dataset_disk_stats(directory)
    assert size == 2
    assert last_bake_at is not None


# -- search_index_share: attributing the SHARED search db back to a dataset --


def _search_index_with(tmp_path: Path, rows: list[tuple[str, str, int]]):
    """A real `SearchIndex` at `tmp_path`, rebaked with `n` throwaway records
    per `(source, region)` triple — real rows, so the db file actually grows
    and `record_count` has something to count."""
    from mivnav.search import SearchIndex, SearchRecord

    index = SearchIndex(tmp_path / "search" / "index.sqlite3")
    for source, region, n in rows:
        records = [
            SearchRecord(id=str(i), category="poi", title=f"{region}-{i}", text="", lat=0.0, lon=0.0)
            for i in range(n)
        ]
        index.rebake(source, region, records, updated_at=0.0)
    return index


def _total_db_bytes(index) -> int:
    """The real on-disk footprint `search_index_share` attributes shares
    of: WAL mode (`SearchIndex.__init__`) defers most writes into the
    `-wal` file rather than the main db file, so `index.path.stat()` alone
    massively undercounts a freshly-rebaked index — same reasoning as
    `search_index_share` itself."""
    total = index.path.stat().st_size
    for suffix in ("-wal", "-shm"):
        p = index.path.with_name(index.path.name + suffix)
        if p.exists():
            total += p.stat().st_size
    return total


def test_search_index_share_is_zero_for_an_empty_index(tmp_path: Path) -> None:
    from mivnav.config.dataset_layout import search_index_share

    index = _search_index_with(tmp_path, [])
    assert search_index_share(index, "poi", "solent") == 0
    index.close()


def test_search_index_share_is_zero_for_a_dataset_with_no_rows(tmp_path: Path) -> None:
    from mivnav.config.dataset_layout import search_index_share

    index = _search_index_with(tmp_path, [("poi", "solent", 5)])
    assert search_index_share(index, "poi", "some-other-region") == 0
    index.close()


def test_search_index_share_splits_the_db_bytes_by_row_count(tmp_path: Path) -> None:
    """Two datasets share one index, one with 3x the other's rows — their
    shares must be proportional AND sum to (about) the real file size, never
    exceeding it (Storage.tsx totals `size` across datasets, so a double- or
    over-count would inflate that total past what is actually on disk)."""
    from mivnav.config.dataset_layout import search_index_share

    index = _search_index_with(tmp_path, [("poi", "solent", 30), ("poi", "denmark", 10)])
    db_bytes = _total_db_bytes(index)
    solent = search_index_share(index, "poi", "solent")
    denmark = search_index_share(index, "poi", "denmark")
    assert solent > denmark > 0
    assert solent + denmark <= db_bytes
    # Roughly 3:1 (30 rows vs 10) — allow rounding slack either way.
    assert abs(solent - 3 * denmark) <= 3
    index.close()


def test_search_index_share_is_zero_for_a_provider_that_never_fed_search(
    tmp_path: Path,
) -> None:
    """satellite/ocharts/charts feed nothing into the shared index today —
    their share must be 0, not a slice of POI's own rows."""
    from mivnav.config.dataset_layout import search_index_share

    index = _search_index_with(tmp_path, [("poi", "solent", 5)])
    assert search_index_share(index, "satellite", "denmark") == 0
    index.close()


# -- the flat-provider mover (charts/poi/satellite) --------------------------


def test_migrates_a_flat_pmtiles_into_its_own_dataset_folder(tmp_path: Path) -> None:
    old_poi = tmp_path / "old-poi"
    old_poi.mkdir()
    (old_poi / "solent.pmtiles").write_bytes(b"fake pmtiles")
    (old_poi / "solent.json").write_text(json.dumps({"name": "Solent"}))

    data_root = tmp_path / "data"
    migrate_legacy_dataset_dirs({"poi": old_poi}, data_root)

    target_dir = data_root / "poi" / "solent"
    assert (target_dir / "solent.pmtiles").read_bytes() == b"fake pmtiles"
    assert json.loads((target_dir / "solent.json").read_text()) == {"name": "Solent"}
    # the generic dataset.json the mover itself writes
    meta = read_dataset_json(target_dir)
    assert meta is not None
    assert meta["id"] == "solent"
    assert meta["provider"] == "poi"

    # the old flat files are gone (moved, not copied)
    assert not (old_poi / "solent.pmtiles").exists()
    assert not (old_poi / "solent.json").exists()


def test_migrates_multiple_datasets_independently(tmp_path: Path) -> None:
    old_sat = tmp_path / "old-sat"
    old_sat.mkdir()
    (old_sat / "dk.pmtiles").write_bytes(b"dk")
    (old_sat / "gb.pmtiles").write_bytes(b"gb")

    data_root = tmp_path / "data"
    migrate_legacy_dataset_dirs({"satellite": old_sat}, data_root)

    assert (data_root / "satellite" / "dk" / "dk.pmtiles").read_bytes() == b"dk"
    assert (data_root / "satellite" / "gb" / "gb.pmtiles").read_bytes() == b"gb"


def test_a_flat_pmtiles_with_no_sidecar_migrates_fine(tmp_path: Path) -> None:
    old = tmp_path / "old-charts"
    old.mkdir()
    (old / "US5OAKIQ.pmtiles").write_bytes(b"chart")
    data_root = tmp_path / "data"
    migrate_legacy_dataset_dirs({"charts": old}, data_root)
    assert (data_root / "charts" / "US5OAKIQ" / "US5OAKIQ.pmtiles").read_bytes() == b"chart"


def test_skips_when_old_root_already_is_the_new_root(tmp_path: Path) -> None:
    # The common no-customisation case: nothing to move, and nothing raises.
    data_root = tmp_path / "data"
    poi_root = data_root / "poi"
    poi_root.mkdir(parents=True)
    (poi_root / "solent.pmtiles").write_bytes(b"x")
    migrate_legacy_dataset_dirs({"poi": poi_root}, data_root)
    # untouched — still flat, not wrapped in an extra `solent/` folder
    assert (poi_root / "solent.pmtiles").read_bytes() == b"x"
    assert not (poi_root / "solent" / "solent.pmtiles").exists()


def test_never_overwrites_an_existing_target(tmp_path: Path) -> None:
    old_poi = tmp_path / "old-poi"
    old_poi.mkdir()
    (old_poi / "solent.pmtiles").write_bytes(b"OLD BYTES")

    data_root = tmp_path / "data"
    target_dir = data_root / "poi" / "solent"
    target_dir.mkdir(parents=True)
    (target_dir / "solent.pmtiles").write_bytes(b"ALREADY MIGRATED")

    migrate_legacy_dataset_dirs({"poi": old_poi}, data_root)

    # the pre-existing target is untouched, and the old flat file is left in
    # place rather than silently dropped
    assert (target_dir / "solent.pmtiles").read_bytes() == b"ALREADY MIGRATED"
    assert (old_poi / "solent.pmtiles").read_bytes() == b"OLD BYTES"


def test_a_missing_old_root_is_a_no_op(tmp_path: Path) -> None:
    migrate_legacy_dataset_dirs({"poi": tmp_path / "never-existed"}, tmp_path / "data")
    assert not (tmp_path / "data").exists()


# -- the o-charts mover (whole directory, or merge set-by-set) ---------------


def test_migrates_the_whole_ocharts_sets_dir_when_new_root_is_absent(tmp_path: Path) -> None:
    old = tmp_path / "old-ocharts"
    old.mkdir()
    (old / "oeuSENC-DK1").mkdir()
    (old / "oeuSENC-DK1" / "cell.oesenc").write_bytes(b"cell")

    data_root = tmp_path / "data"
    migrate_legacy_dataset_dirs({"ocharts": old}, data_root)

    assert (data_root / "ocharts" / "oeuSENC-DK1" / "cell.oesenc").read_bytes() == b"cell"
    assert not old.exists()  # moved, not copied


def test_merges_ocharts_sets_one_at_a_time_when_new_root_already_exists(tmp_path: Path) -> None:
    old = tmp_path / "old-ocharts"
    old.mkdir()
    (old / "set-A").mkdir()
    (old / "set-A" / "a.oesenc").write_bytes(b"a")
    (old / "set-B").mkdir()
    (old / "set-B" / "b.oesenc").write_bytes(b"b")

    data_root = tmp_path / "data"
    new_root = data_root / "ocharts"
    new_root.mkdir(parents=True)
    (new_root / "set-B").mkdir()  # a name collision — must not be clobbered
    (new_root / "set-B" / "existing.oesenc").write_bytes(b"KEEP ME")

    migrate_legacy_dataset_dirs({"ocharts": old}, data_root)

    assert (new_root / "set-A" / "a.oesenc").read_bytes() == b"a"
    assert (new_root / "set-B" / "existing.oesenc").read_bytes() == b"KEEP ME"
    assert not (new_root / "set-B" / "b.oesenc").exists()
    # the un-migrated colliding set is left where it was
    assert (old / "set-B" / "b.oesenc").read_bytes() == b"b"
    assert not (old / "set-A").exists()  # the non-colliding one did move


# -- end to end, through ConfigStore -----------------------------------------


def test_reading_an_old_config_relocates_files_via_the_store(tmp_path: Path) -> None:
    """The same regression shape as test_config_migrate's "an old config
    file loads and migrates", but for the PHYSICAL move, not just the key
    rename: reading a config.json that still names the old per-provider
    dirs must relocate whatever is actually sitting there."""
    old_poi = tmp_path / "old-poi"
    old_poi.mkdir()
    (old_poi / "solent.pmtiles").write_bytes(b"poi bytes")

    config_path = tmp_path / "config.json"
    config_path.write_text(
        json.dumps(
            {
                "version": 1,
                "charts": {"dir": str(tmp_path / "data-root")},
                "poi": {"dir": str(old_poi)},
            }
        )
    )
    config = ConfigStore(config_path).get()
    assert config.data_root == tmp_path / "data-root"
    migrated = tmp_path / "data-root" / "poi" / "solent" / "solent.pmtiles"
    assert migrated.read_bytes() == b"poi bytes"


def test_a_config_already_in_the_new_vocabulary_triggers_no_mover_work(
    tmp_path: Path, monkeypatch
) -> None:
    """No legacy keys present -> the mover is never even called (nothing to
    look at), so a boat long since migrated pays nothing on every boot."""
    from mivnav.config import store as store_mod

    calls = []
    monkeypatch.setattr(
        store_mod,
        "migrate_legacy_dataset_dirs",
        lambda *a, **kw: calls.append((a, kw)),
    )
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps({"version": 1, "data_root": str(tmp_path / "data")}))
    ConfigStore(config_path)
    assert calls == []
