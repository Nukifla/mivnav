# SPDX-License-Identifier: GPL-2.0-only
"""`/text/{set_id}/{name}` — serving an S-57 external text description, and the
path-safety contract that keeps a hostile filename from chart data inside the
chart set's own directory.

The filename in these tests is `TXTDSC` data: the decoder hands it straight
through from the cell, so a malicious set could name a traversal or an absolute
path. `_resolve_text_file` is the guard, and the guard — not a green request —
is what proves the traversal is refused, so it is unit-tested directly against
the inputs a naive `directory / name` would happily escape with.
"""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mivnav.api.charts import _contained, _resolve_text_file
from senc_fixture import point_cell

TEXT_BODY = "Nordkap note.\nSecond line.\n"
DK_NOTE = "ROUTE T and THE SOUND\nSee the publication on www.dma.dk\n"


@pytest.fixture
def text_client(charts_dir: Path, tmp_path_factory: pytest.TempPathFactory, isolated_runtime):
    """A function-scoped client serving the US5OAKIQ PMTiles set.

    Deliberately *not* the shared `client` fixture: that one is session-scoped
    and leaves its `get_store`/`get_service` overrides in place for the rest of
    the run, which would clobber the config-driven singletons `test_config_api`
    asserts on. This one saves and restores the override map, so it leaks
    nothing regardless of collection order."""
    from mivnav.api.app import app
    from mivnav.api.charts import get_store
    from mivnav.features.ocharts.routes import get_service
    from mivnav.charts.store import ChartStore
    from mivnav.features.ocharts.service import OchartsService

    store = ChartStore(charts_dir)
    empty = tmp_path_factory.mktemp("ocharts-empty-text")
    service = OchartsService(
        sets_dir=empty / "sets",
        daemon_dir=empty / "daemon",
        work_dir=empty / "work",
        warm_overview=False,
    )
    saved = dict(app.dependency_overrides)
    app.dependency_overrides[get_store] = lambda: store
    app.dependency_overrides[get_service] = lambda: service
    try:
        with TestClient(app) as c:
            yield c
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(saved)


@pytest.fixture
def text_set(charts_dir: Path) -> Path:
    """Drop a `.TXT` sidecar into the charts dir the PMTiles set is served from,
    and a secret file *outside* it (a traversal target)."""
    txt = charts_dir / "US389IQB.TXT"
    txt.write_text(TEXT_BODY)
    (charts_dir.parent / "secret.TXT").write_text("KEY MATERIAL")
    yield txt
    txt.unlink(missing_ok=True)


# --- the guard, proven in isolation --------------------------------------


def test_resolve_accepts_a_plain_txt_name(tmp_path: Path):
    (tmp_path / "DKNOT154.TXT").write_text("x")
    assert _resolve_text_file(tmp_path, "DKNOT154.TXT") == tmp_path / "DKNOT154.TXT"
    # suffix match is case-insensitive; real cells use upper-case
    assert _resolve_text_file(tmp_path, "note.txt") == tmp_path / "note.txt"


@pytest.mark.parametrize(
    "name",
    [
        "../secret.TXT",  # parent traversal
        "../../etc/passwd.TXT",  # deeper traversal
        "/etc/passwd.TXT",  # absolute path
        "sub/DKNOT154.TXT",  # a separator at all
        "..",  # bare parent ref
        "",  # empty
        "DKNOT154.EXE",  # wrong suffix
        "DKNOT154",  # no suffix
        ".TXT",  # suffix only, no stem
    ],
)
def test_resolve_refuses_anything_that_is_not_a_bare_txt_name(tmp_path: Path, name: str):
    assert _resolve_text_file(tmp_path, name) is None


def test_resolve_refuses_a_symlink_escaping_the_set(tmp_path: Path):
    outside = tmp_path.parent / "outside.TXT"
    outside.write_text("secret")
    directory = tmp_path / "set"
    directory.mkdir()
    link = directory / "escape.TXT"
    link.symlink_to(outside)
    assert _resolve_text_file(directory, "escape.TXT") is None


# --- the o-charts layout: notes one level down, in a per-cell directory ----


def test_resolve_finds_a_note_in_a_per_cell_subdirectory(tmp_path: Path):
    """An installed o-charts set files each cell's notes under a directory
    named after the cell, not beside it — the DK layout this endpoint used to
    404 on."""
    cell_dir = tmp_path / "OC-45-AAVIN5"
    cell_dir.mkdir()
    (tmp_path / "OC-45-AAVIN5.oesu").write_bytes(b"encrypted")
    note = cell_dir / "DKNO7001.TXT"
    note.write_text("ROUTE T and THE SOUND\n")
    assert _resolve_text_file(tmp_path, "DKNO7001.TXT") == note


def test_resolve_prefers_a_top_level_file_over_a_subdirectory(tmp_path: Path):
    (tmp_path / "flat.TXT").write_text("flat")
    sub = tmp_path / "OC-45-AAVIN5"
    sub.mkdir()
    (sub / "flat.TXT").write_text("nested")
    assert _resolve_text_file(tmp_path, "flat.TXT") == tmp_path / "flat.TXT"


def test_resolve_does_not_descend_two_levels(tmp_path: Path):
    deep = tmp_path / "a" / "b"
    deep.mkdir(parents=True)
    (deep / "DEEP.TXT").write_text("x")
    resolved = _resolve_text_file(tmp_path, "DEEP.TXT")
    # a path is still returned (so the endpoint 404s rather than 400s), but it
    # is the non-existent flat candidate, never the two-level-deep file
    assert resolved == tmp_path / "DEEP.TXT"
    assert not resolved.exists()


def test_resolve_refuses_a_note_under_a_symlinked_subdirectory(tmp_path: Path):
    """The new hole the subdirectory search could open: a set whose cell
    directory is a symlink out of the set."""
    outside = tmp_path.parent / "elsewhere"
    outside.mkdir(exist_ok=True)
    (outside / "SECRET.TXT").write_text("KEY MATERIAL")
    directory = tmp_path / "set"
    directory.mkdir()
    (directory / "OC-45-EVIL5").symlink_to(outside, target_is_directory=True)
    resolved = _resolve_text_file(directory, "SECRET.TXT")
    assert resolved == directory / "SECRET.TXT"
    assert not resolved.exists()
    # scandir already refuses to enumerate the symlinked directory, so pin the
    # containment arithmetic itself rather than only its belt-and-braces
    assert not _contained(directory.resolve(), outside / "SECRET.TXT", 2)


def test_resolve_refuses_a_symlinked_note_inside_a_subdirectory(tmp_path: Path):
    outside = tmp_path.parent / "outside2.TXT"
    outside.write_text("KEY MATERIAL")
    directory = tmp_path / "set"
    directory.mkdir()
    cell = directory / "OC-45-EVIL5"
    cell.mkdir()
    (cell / "ESCAPE.TXT").symlink_to(outside)
    resolved = _resolve_text_file(directory, "ESCAPE.TXT")
    assert resolved == directory / "ESCAPE.TXT"
    assert not resolved.exists()


# --- the endpoint --------------------------------------------------------


def test_serves_the_text_of_a_referenced_file(text_client, text_set):
    res = text_client.get("/text/US5OAKIQ/US389IQB.TXT")
    assert res.status_code == 200
    assert res.text == TEXT_BODY
    assert res.headers["content-type"].startswith("text/plain")
    assert res.headers["etag"]


def test_serves_a_note_filed_under_a_cell_subdirectory(text_client, text_set, charts_dir: Path):
    """End to end over the layout an installed o-charts set really has."""
    cell_dir = charts_dir / "OC-45-AAVIN5"
    cell_dir.mkdir(exist_ok=True)
    (cell_dir / "DKNO7001.TXT").write_text(TEXT_BODY)
    try:
        res = text_client.get("/text/US5OAKIQ/DKNO7001.TXT")
        assert res.status_code == 200
        assert res.text == TEXT_BODY
    finally:
        (cell_dir / "DKNO7001.TXT").unlink(missing_ok=True)
        cell_dir.rmdir()


def test_missing_file_is_404_not_500(text_client, text_set):
    res = text_client.get("/text/US5OAKIQ/NOSUCH.TXT")
    assert res.status_code == 404


def test_unknown_set_is_404(text_client, text_set):
    res = text_client.get("/text/NOPE/US389IQB.TXT")
    assert res.status_code == 404


def test_non_txt_name_is_rejected(text_client, text_set):
    res = text_client.get("/text/US5OAKIQ/US389IQB.DAT")
    assert res.status_code == 400


def test_etag_revalidates_to_304(text_client, text_set):
    first = text_client.get("/text/US5OAKIQ/US389IQB.TXT")
    etag = first.headers["etag"]
    again = text_client.get("/text/US5OAKIQ/US389IQB.TXT", headers={"If-None-Match": etag})
    assert again.status_code == 304


# --- the o-charts branch, end to end -------------------------------------


def test_ocharts_set_serves_a_note_from_its_cell_subdirectory(tmp_path: Path, isolated_runtime):
    """The reported bug's whole chain, over `_set_directory`'s *o-charts*
    branch — the one the DK report exercises and every test above misses.

    The set id the frontend puts in the URL is the `set` tag chartcore stamps
    on each served feature, which is `OchartsSet.id`, which is the set
    directory's own name (`sets.py`'s `_list`). So a set directory named like
    the real Danish one, holding its notes one level down exactly as an
    installed o-charts set does, must answer that id with that text."""
    from mivnav.api.app import app
    from mivnav.api.charts import get_store
    from mivnav.features.ocharts.routes import get_service
    from mivnav.charts.store import ChartStore
    from mivnav.features.ocharts.service import OchartsService

    sets_dir = tmp_path / "sets"
    set_dir = sets_dir / "oeuSENC-DK-2026-1-27-base"
    set_dir.mkdir(parents=True)
    point_cell(set_dir / "OC-45-AAVIN5.senc", name="OC-45-AAVIN5", bounds=(11.0, 54.0, 11.2, 54.2))
    cell_dir = set_dir / "OC-45-AAVIN5"
    cell_dir.mkdir()
    (cell_dir / "DKNO7001.TXT").write_text(DK_NOTE)

    service = OchartsService(
        sets_dir=sets_dir,
        daemon_dir=tmp_path / "daemon",
        work_dir=tmp_path / "work",
        rescan_interval=0,
        s52_path=tmp_path / "no-s52-data",
        warm_overview=False,
    )
    saved = dict(app.dependency_overrides)
    app.dependency_overrides[get_store] = lambda: ChartStore(tmp_path / "empty-pmtiles")
    app.dependency_overrides[get_service] = lambda: service
    try:
        with TestClient(app) as client:
            res = client.get("/text/oeuSENC-DK-2026-1-27-base/DKNO7001.TXT")
            assert res.status_code == 200
            assert res.text == DK_NOTE
            # a note the set genuinely does not ship still reads as absent
            assert client.get("/text/oeuSENC-DK-2026-1-27-base/DKNOPE99.TXT").status_code == 404
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(saved)
