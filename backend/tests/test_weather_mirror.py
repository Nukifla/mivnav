# SPDX-License-Identifier: GPL-2.0-only
"""``mivnav.features.weather.mirror`` — the baked-file lookup the live
``/weather/data_spatial/...`` routes consult before the range-caching proxy
(#rktyytqx item 3, "live proxy path stays available for anything NOT
downloaded"). Pure filesystem logic, no network/app needed.

``root`` is one weather dataset's OWN directory (``data_root/weather/<id>``
— see ``mivnav.features.weather.runtime.WeatherRuntime.mirror``) and
``full`` is the exact string ``routes.py`` builds
(``f"data_spatial/{path}"``) — so a baked file under test lives at
``root / "data_spatial" / <om path>``, matching where
:class:`~mivnav.features.weather.ingest.WeatherIngestRunner` actually writes
(``dataset_dir / DATA_SPATIAL / om_path``)."""

from __future__ import annotations

from mivnav.features.weather.mirror import WeatherMirror

FULL = "data_spatial/dwd_icon/2026/07/24/1200Z/2026-07-24T1500.om"
BODY = bytes(range(256)) * 4  # 1024 deterministic bytes


def _baked(tmp_path, name="ds-a", body=BODY):
    root = tmp_path / name
    path = root / FULL
    path.parent.mkdir(parents=True)
    path.write_bytes(body)
    return root


def test_resolve_misses_when_nothing_is_baked(tmp_path):
    mirror = WeatherMirror([tmp_path / "ds-a"])
    assert mirror.resolve(FULL) is None
    assert mirror.head(FULL) is None
    assert mirror.get_range(FULL, "bytes=0-9") is None


def test_resolve_finds_a_baked_file(tmp_path):
    root = _baked(tmp_path)
    mirror = WeatherMirror([root])
    assert mirror.resolve(FULL) == root / FULL


def test_head_reports_size_and_immutable_headers(tmp_path):
    root = _baked(tmp_path)
    mirror = WeatherMirror([root])
    status, headers = mirror.head(FULL)
    assert status == 200
    assert headers["Content-Length"] == str(len(BODY))
    assert headers["Accept-Ranges"] == "bytes"
    assert "immutable" in headers["Cache-Control"]


def test_get_range_serves_the_exact_slice(tmp_path):
    root = _baked(tmp_path)
    mirror = WeatherMirror([root])
    status, headers, body = mirror.get_range(FULL, "bytes=100-199")
    assert status == 206
    assert body == BODY[100:200]
    assert headers["Content-Range"] == f"bytes 100-199/{len(BODY)}"
    assert headers["Content-Encoding"] == "identity"


def test_get_range_open_ended_reads_to_eof(tmp_path):
    root = _baked(tmp_path)
    mirror = WeatherMirror([root])
    status, headers, body = mirror.get_range(FULL, f"bytes={len(BODY) - 10}-")
    assert status == 206
    assert body == BODY[-10:]
    assert headers["Content-Range"] == f"bytes {len(BODY) - 10}-{len(BODY) - 1}/{len(BODY)}"


def test_get_range_past_eof_is_416(tmp_path):
    root = _baked(tmp_path)
    mirror = WeatherMirror([root])
    status, headers, body = mirror.get_range(FULL, f"bytes={len(BODY) + 10}-")
    assert status == 416
    assert body == b""
    assert headers["Content-Range"] == f"bytes */{len(BODY)}"


def test_get_range_unparseable_header_on_a_hit_is_416(tmp_path):
    root = _baked(tmp_path)
    mirror = WeatherMirror([root])
    status, headers, body = mirror.get_range(FULL, "not-a-range")
    assert status == 416
    assert body == b""


def test_get_range_on_a_miss_is_none_not_416(tmp_path):
    # No roots at all -> resolve() is None regardless of the range header,
    # so a MISS falls through to the live proxy rather than answering 416
    # for a path this mirror has nothing to say about.
    mirror = WeatherMirror([tmp_path / "never-baked"])
    assert mirror.get_range(FULL, "not-a-range") is None


def test_first_matching_root_wins_when_multiple_datasets_bake_the_same_path(tmp_path):
    first = _baked(tmp_path, name="ds-a", body=b"FIRST")
    second = _baked(tmp_path, name="ds-b", body=b"SECOND")

    mirror = WeatherMirror([first, second])
    assert mirror.resolve(FULL).read_bytes() == b"FIRST"

    mirror_reordered = WeatherMirror([second, first])
    assert mirror_reordered.resolve(FULL).read_bytes() == b"SECOND"


def test_a_second_root_answers_when_the_first_lacks_the_path(tmp_path):
    empty_root = tmp_path / "ds-empty"
    empty_root.mkdir()
    baked_root = _baked(tmp_path, name="ds-a")

    mirror = WeatherMirror([empty_root, baked_root])
    assert mirror.resolve(FULL) == baked_root / FULL


def test_resolve_has_no_om_only_restriction(tmp_path):
    """`WeatherMirror` itself has no `.om`-only rule (routes.py is what
    restricts callers to `.om` paths) — its contract is "does this exact
    relative path exist under some root", nothing more."""
    root = tmp_path / "ds-a"
    path = root / "data_spatial" / "dwd_icon" / "something.txt"
    path.parent.mkdir(parents=True)
    path.write_bytes(b"x")
    mirror = WeatherMirror([root])
    assert mirror.resolve("data_spatial/dwd_icon/something.txt") == path


# -- baked(): what this boat holds offline (#tttsxnuo) -------------------------


def test_baked_is_empty_for_a_root_that_never_baked(tmp_path):
    assert WeatherMirror([tmp_path / "ds-a"]).baked() == []


def test_baked_reports_one_domain_with_its_valid_time_span(tmp_path):
    root = _baked(tmp_path)
    (root / "data_spatial/dwd_icon/2026/07/24/1200Z/2026-07-25T0000.om").write_bytes(BODY)
    (entry,) = WeatherMirror([root]).baked()
    assert entry.domain == "dwd_icon"
    assert entry.first == "2026-07-24T15:00:00Z"
    assert entry.last == "2026-07-25T00:00:00Z"
    assert entry.files == 2


def test_baked_ignores_files_that_are_not_valid_time_om_names(tmp_path):
    root = _baked(tmp_path)
    d = root / "data_spatial/dwd_icon/2026/07/24/1200Z"
    (d / "latest.json").write_bytes(b"{}")
    (d / "scratch.om.tmp").write_bytes(b"x")
    (entry,) = WeatherMirror([root]).baked()
    assert entry.files == 1


def test_baked_merges_roots_and_sorts_domains(tmp_path):
    a = _baked(tmp_path, name="ds-a")
    b = tmp_path / "ds-b"
    for rel in (
        "data_spatial/dwd_icon/2026/07/24/1200Z/2026-07-26T0000.om",
        "data_spatial/dwd_ewam/2026/07/24/1200Z/2026-07-24T1800.om",
    ):
        (b / rel).parent.mkdir(parents=True, exist_ok=True)
        (b / rel).write_bytes(BODY)
    entries = WeatherMirror([a, b]).baked()
    assert [e.domain for e in entries] == ["dwd_ewam", "dwd_icon"]
    icon = next(e for e in entries if e.domain == "dwd_icon")
    assert icon.files == 2
    assert icon.last == "2026-07-26T00:00:00Z"
