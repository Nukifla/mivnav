# SPDX-License-Identifier: GPL-2.0-only
"""freenauticalchart.net as a chart source.

Everything here is offline: the version check and the download both run
through an ``httpx.MockTransport`` serving a zip built from the committed
fixture cell (``backend/data/fnc/DE6OSTIM.S57``, CC0 — see that
directory's ``SOURCE.txt``), so the suite never touches the network.

The fixture is a *real* published cell rather than a synthesized one
(``senc_fixture.py`` covers that case) precisely because the two things
worth pinning here are facts about the real archive: that the ``.S57``
files are OSENC underneath, and that renaming them is what makes the
existing o-charts serving path able to open them at all.
"""

from __future__ import annotations

import io
import json
import shutil
import struct
import time
import zipfile
from pathlib import Path

import chartcore
import httpx
import pytest

from mivnav.features.ocharts import fnc
from mivnav.features.ocharts.install import Installer
from mivnav.features.ocharts.service import OchartsService

FIXTURE = Path(__file__).resolve().parents[1] / "data" / "fnc" / "DE6OSTIM.S57"

DE_URL = fnc.REGIONS["de"].url
ETAG_1 = '"6a5d9533-3cb28af"'
ETAG_2 = '"7b6ea644-4dc39b0"'
LM_1 = "Mon, 20 Jul 2026 03:25:39 GMT"
LM_2 = "Thu, 20 Aug 2026 04:11:02 GMT"


def make_zip(date: str = "2026-07-19", cell_name: str = "DE6OSTIM.S57") -> bytes:
    """A stand-in for ``fnc-de.zip``: the publisher's directory layout with
    the one committed cell in it."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("fnc-de/Chartinfo.txt", f"ChartInfo:FNC-DE {date}\n")
        zf.write(FIXTURE, f"fnc-de/{cell_name}")
    return buf.getvalue()


def transport(zip_bytes: bytes, etag: str = ETAG_1, last_modified: str = LM_1):
    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == DE_URL, request.url
        headers = {
            "etag": etag,
            "last-modified": last_modified,
            "content-length": str(len(zip_bytes)),
        }
        if request.method == "HEAD":
            return httpx.Response(200, headers=headers)
        return httpx.Response(200, headers=headers, content=zip_bytes)

    return httpx.MockTransport(handler)


@pytest.fixture()
def service(tmp_path: Path) -> OchartsService:
    return OchartsService(
        sets_dir=tmp_path / "sets",
        daemon_dir=tmp_path / "daemon",
        work_dir=tmp_path / "work",
        # No S-52 lookup data (#P0-S52-AMBIENT), matching the other o-charts
        # fixtures — nothing here renders.
        s52_path=tmp_path / "no-s52-data",
        warm_overview=False,
    )


def install(
    service: OchartsService,
    zip_bytes: bytes,
    etag: str = ETAG_1,
    last_modified: str = LM_1,
    timeout: float = 30.0,
) -> dict:
    client = httpx.Client(transport=transport(zip_bytes, etag, last_modified))
    version = fnc.FncClient(client).version("de")
    installer = Installer(service, http=client)
    installer.install_from_url(
        DE_URL,
        detail="test",
        prepare=fnc.prepare(version),
        on_installed=fnc.on_installed(service.sets_dir, "de"),
    )
    deadline = time.time() + timeout
    while time.time() < deadline:
        st = installer.status()
        if st["state"] in ("done", "error"):
            return st
        time.sleep(0.02)
    raise TimeoutError(f"install did not finish: {installer.status()}")


# -- the fixture cell -------------------------------------------------------


def test_published_cell_is_osenc_under_an_s57_name(tmp_path: Path) -> None:
    """The whole integration rests on this: FNC's ``.S57`` files are SENC
    streams, so chartcore can read them — but only once renamed, because it
    classifies cells by extension (``ChartKind::from_path``)."""
    assert fnc.is_osenc(FIXTURE)
    assert chartcore.chart_kind(str(FIXTURE)) is None, "an .S57 name is not a kind chartcore knows"

    chart_dir = tmp_path / "fnc-de"
    chart_dir.mkdir()
    shutil.copy(FIXTURE, chart_dir / FIXTURE.name)
    renamed = fnc.normalize_cells(chart_dir)

    assert [p.name for p in renamed] == ["DE6OSTIM.senc"]
    assert chartcore.chart_kind(str(renamed[0])) == "senc"
    header = chartcore.read_header(str(renamed[0]), "")
    assert header["name"] == "DE6OSTIM"
    w, s, e, n = header["extent"]
    assert 10.0 < w < e < 11.5 and 53.5 < s < n < 54.5, header["extent"]  # Timmendorf, Baltic


def test_fixture_carries_sectored_lights() -> None:
    """Why this cell was chosen. The other committed chart fixture,
    US5OAKIQ, has zero sectored lights (CLAUDE.md), which left sector work
    with no real data to test against.

    Counted at the OSENC record level — ``FEATURE_ATTRIBUTE`` (65) of
    length 17 carrying SECTR1 (attribute 136) as an f64 (value type 2).
    That deliberately stops at "the cell contains sector data": asserting
    rendered arcs needs S-52 lookup data and belongs in the serving tests.
    """
    record = struct.pack("<HIHB", 65, 17, 136, 2)
    assert FIXTURE.read_bytes().count(record) >= 5


def test_normalize_leaves_a_non_osenc_s57_alone(tmp_path: Path) -> None:
    """A genuine ISO-8211 cell under the same extension must not be
    renamed into a SENC it is not — it stays put and is simply not a cell."""
    chart_dir = tmp_path / "fnc-de"
    chart_dir.mkdir()
    (chart_dir / "REAL.S57").write_bytes(b"00123 3LE1 0900073   " + b"\x00" * 64)
    assert fnc.normalize_cells(chart_dir) == []
    assert (chart_dir / "REAL.S57").exists()


# -- version / catalog ------------------------------------------------------


def test_version_reads_the_publisher_headers() -> None:
    client = httpx.Client(transport=transport(b"", ETAG_1, LM_1))
    v = fnc.FncClient(client).version("de")
    assert v.etag == ETAG_1
    assert v.published == "2026-07-20"
    assert v.url == DE_URL


def test_unknown_region_is_an_error() -> None:
    with pytest.raises(fnc.FncError, match="unknown freenauticalchart region"):
        fnc.region("fr")


def test_update_available_compares_etags() -> None:
    now = fnc.FncVersion("de", DE_URL, etag=ETAG_2, last_modified=LM_2).as_dict()
    assert fnc.update_available(now, None) is True
    assert fnc.update_available(now, {"etag": ETAG_2}) is False
    assert fnc.update_available(now, {"etag": ETAG_1}) is True
    # no ETag from the server: fall back to Last-Modified, never to the
    # Chartinfo date (which trails the file mtime by a day)
    no_etag = {**now, "etag": ""}
    assert fnc.update_available(no_etag, {"etag": "", "last_modified": LM_2}) is False
    assert fnc.update_available(no_etag, {"etag": "", "last_modified": LM_1}) is True


# -- install ----------------------------------------------------------------


def test_install_end_to_end(service: OchartsService) -> None:
    st = install(service, make_zip())
    assert st["state"] == "done", st["error"]
    # dated from Chartinfo.txt, not from the zip's directory name: FNC
    # reissues the same `fnc-de` directory every edition
    assert st["set_id"] == "fnc-de-2026-07-19"

    cs = service.get("fnc-de-2026-07-19")
    assert cs is not None
    assert [c.name for c in cs.cells] == ["DE6OSTIM"]
    assert cs.cell_errors == {}
    assert cs.cells[0].key == "", "a CC0 set needs no key"
    assert cs.info.title == "FNC-DE 2026-07-19"


def test_install_records_provenance(service: OchartsService) -> None:
    install(service, make_zip())
    marker = json.loads((service.sets_dir / "fnc-de-2026-07-19" / fnc.MARKER).read_text())
    assert marker["source"] == fnc.SOURCE_ID
    assert marker["region"] == "de"
    assert marker["etag"] == ETAG_1
    assert marker["license"] == "CC0-1.0"
    assert fnc.installed_marker(service.sets_dir, "de")["set_id"] == "fnc-de-2026-07-19"
    assert fnc.installed_marker(service.sets_dir, "nl") is None


def test_update_retires_the_superseded_edition(service: OchartsService) -> None:
    install(service, make_zip("2026-07-19"))
    st = install(service, make_zip("2026-08-20"), etag=ETAG_2, last_modified=LM_2)
    assert st["state"] == "done", st["error"]
    assert st["set_id"] == "fnc-de-2026-08-20"

    # exactly one edition installed — a stale twin would double every cell
    # over the same water and eat the per-tile cell budget
    assert sorted(p.name for p in service.sets_dir.iterdir()) == ["fnc-de-2026-08-20"]
    assert service.get("fnc-de-2026-07-19") is None
    assert service.get("fnc-de-2026-08-20") is not None


def test_newest_edition_wins_even_when_a_retire_failed(
    service: OchartsService, monkeypatch
) -> None:
    """``retire_previous`` only warns when a directory will not delete, so
    two editions *can* end up installed. The update check must still read
    the newest one's ETag — reading a stale one makes ``update_available``
    permanently false, and the boat silently stops being offered updates.

    Pinned with a date whose *name* sorts before the older edition's, so an
    ordering by directory name would fail this and an ordering by the
    marker's own date passes.
    """
    install(service, make_zip("2026-07-19"))
    monkeypatch.setattr(fnc.shutil, "rmtree", _refuse)
    install(service, make_zip("2026-01-05"), etag=ETAG_2, last_modified=LM_2)
    monkeypatch.undo()

    names = sorted(p.name for p in service.sets_dir.iterdir())
    assert names == ["fnc-de-2026-01-05", "fnc-de-2026-07-19"], "retire was meant to fail"

    marker = fnc.installed_marker(service.sets_dir, "de")
    assert marker["set_id"] == "fnc-de-2026-01-05", "took the name-sorted set, not the newest"
    assert marker["etag"] == ETAG_2
    # and so the check still sees the current publication as installed
    now = fnc.FncVersion("de", DE_URL, etag=ETAG_2, last_modified=LM_2).as_dict()
    assert fnc.update_available(now, marker) is False


def _refuse(*_a, **_kw):
    raise OSError("device or resource busy")


def test_failed_update_leaves_the_installed_edition_intact(
    service: OchartsService,
) -> None:
    """A broken download must not cost the boat its working charts — the
    old set is retired only after the new one passes its header scan."""
    install(service, make_zip("2026-07-19"))

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("fnc-de/Chartinfo.txt", "ChartInfo:FNC-DE 2026-08-20\n")
        zf.writestr("fnc-de/DE6OSTIM.S57", b"not an osenc stream at all")
    st = install(service, buf.getvalue(), etag=ETAG_2, last_modified=LM_2)

    assert st["state"] == "error"
    assert "no OSENC cells" in st["error"]
    assert service.get("fnc-de-2026-07-19") is not None
    assert sorted(p.name for p in service.sets_dir.iterdir()) == ["fnc-de-2026-07-19"]


def test_reinstalling_the_same_edition_is_refused(service: OchartsService) -> None:
    """The installer's no-overwrite invariant still holds — the dated name
    is what keeps successive editions from tripping it, not a bypass."""
    install(service, make_zip())
    st = install(service, make_zip())
    assert st["state"] == "error"
    assert "already installed" in st["error"]


# -- routes -----------------------------------------------------------------


@pytest.fixture()
def offline(monkeypatch) -> None:
    """No route in this suite may reach freenauticalchart.net: pin the
    client the routes construct to a mock transport that only knows the DE
    zip, so an NL HEAD fails the way an unreachable publisher would."""
    zip_bytes = make_zip()

    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) != DE_URL:
            raise httpx.ConnectError("blocked in tests")
        headers = {
            "etag": ETAG_1,
            "last-modified": LM_1,
            "content-length": str(len(zip_bytes)),
        }
        if request.method == "HEAD":
            return httpx.Response(200, headers=headers)
        return httpx.Response(200, headers=headers, content=zip_bytes)

    real = fnc.FncClient
    monkeypatch.setattr(
        fnc,
        "FncClient",
        lambda http=None: real(httpx.Client(transport=httpx.MockTransport(handler))),
    )


def test_catalog_route(client, offline) -> None:
    r = client.get("/ocharts/fnc/catalog")
    assert r.status_code == 200
    regions = {e["region"]: e for e in r.json()["regions"]}
    assert set(regions) == {"de", "nl"}
    assert regions["de"]["installed"] is None
    assert regions["de"]["update_available"] is True
    assert regions["de"]["available"]["published"] == "2026-07-20"
    assert regions["de"]["url"] == DE_URL
    # one unreachable region reports its own error; the catalog still answers
    assert regions["nl"]["available"] is None
    assert regions["nl"]["update_available"] is False
    assert "cannot reach" in regions["nl"]["error"]


def test_install_route_rejects_an_unknown_region(client, offline) -> None:
    r = client.post("/ocharts/fnc/install", json={"region": "fr"})
    assert r.status_code == 404
    assert "unknown freenauticalchart region" in r.json()["detail"]
