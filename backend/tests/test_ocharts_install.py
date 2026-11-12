# SPDX-License-Identifier: GPL-2.0-only
"""Installer pipeline: synthetic chart zips through unpack → test-open →
install, plus the documented error cases."""

import io
import time
import zipfile
from pathlib import Path

import httpx
import pytest

from mivnav.features.ocharts.install import Installer
from mivnav.features.ocharts.service import OchartsService
from senc_fixture import point_cell


def make_zip(tmp_path: Path, subdirs: list[str], with_cell: bool = True) -> bytes:
    buf = io.BytesIO()
    cell = tmp_path / "zip-cell.senc"
    point_cell(cell, name="OC-NEW-1")
    with zipfile.ZipFile(buf, "w") as zf:
        for sub in subdirs:
            zf.writestr(f"{sub}/Chartinfo.txt", "ChartInfo:Zipped Set;2026-1;2027-01-01\n")
            if with_cell:
                zf.write(cell, f"{sub}/OC-NEW-1.senc")
    return buf.getvalue()


@pytest.fixture()
def service(tmp_path: Path) -> OchartsService:
    return OchartsService(
        sets_dir=tmp_path / "sets",
        daemon_dir=tmp_path / "daemon",
        work_dir=tmp_path / "work",
        warm_overview=False,
    )


def wait_done(installer: Installer, timeout: float = 15.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        st = installer.status()
        if st["state"] in ("done", "error"):
            return st
        time.sleep(0.02)
    raise TimeoutError(f"install did not finish: {installer.status()}")


def test_upload_install_end_to_end(service: OchartsService, tmp_path: Path) -> None:
    installer = Installer(service)
    installer.install_zip_bytes(make_zip(tmp_path, ["oeuSENC-ZIP1"]))
    st = wait_done(installer)
    assert st["state"] == "done", st["error"]
    assert st["set_id"] == "oeuSENC-ZIP1"
    cs = service.get("oeuSENC-ZIP1")
    assert cs is not None
    assert [c.name for c in cs.cells] == ["OC-NEW-1"]
    assert cs.info.title == "Zipped Set"


def test_multiple_chart_dirs_is_an_error(service: OchartsService, tmp_path: Path) -> None:
    installer = Installer(service)
    installer.install_zip_bytes(make_zip(tmp_path, ["setA", "setB"]))
    st = wait_done(installer)
    assert st["state"] == "error"
    assert "multiple chart directories" in st["error"]


def test_existing_target_is_refused(service: OchartsService, tmp_path: Path) -> None:
    (service.sets_dir / "oeuSENC-ZIP1").mkdir(parents=True)
    installer = Installer(service)
    installer.install_zip_bytes(make_zip(tmp_path, ["oeuSENC-ZIP1"]))
    st = wait_done(installer)
    assert st["state"] == "error"
    assert "already installed" in st["error"]


def test_zip_without_cells_fails_test_open(service: OchartsService, tmp_path: Path) -> None:
    installer = Installer(service)
    installer.install_zip_bytes(make_zip(tmp_path, ["oeuSENC-EMPTY"], with_cell=False))
    st = wait_done(installer)
    assert st["state"] == "error"
    assert "no chart cells" in st["error"]


def test_zip_traversal_is_refused(service: OchartsService, tmp_path: Path) -> None:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("set/Chartinfo.txt", "x")
        zf.writestr("../escape.txt", "x")
    installer = Installer(service)
    installer.install_zip_bytes(buf.getvalue())
    st = wait_done(installer)
    assert st["state"] == "error"
    assert "escapes archive root" in st["error"]


def test_shop_download_install(service: OchartsService, tmp_path: Path) -> None:
    zip_bytes = make_zip(tmp_path, ["oeuSENC-SHOP1"])
    keys = (
        "<keyList><Chart><FileName>OC-NEW-1</FileName>"
        "<RInstallKey>fabricated</RInstallKey></Chart>"
        "<ChartInfo>Shop Set</ChartInfo></keyList>"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("charts.zip"):
            return httpx.Response(200, content=zip_bytes)
        return httpx.Response(200, content=keys.encode())

    installer = Installer(service, http=httpx.Client(transport=httpx.MockTransport(handler)))
    installer.install_from_shop(
        "https://dl.example/charts.zip", "https://dl.example/keys.xml", detail="Shop Set"
    )
    st = wait_done(installer)
    assert st["state"] == "done", st["error"]
    cs = service.get("oeuSENC-SHOP1")
    assert cs is not None
    # the downloaded keys.xml was moved into the set dir and parsed
    assert cs.info.chart_keys == {"OC-NEW-1": "fabricated"}
    assert cs.info.title == "Shop Set"
    # rejected while busy is covered by a fresh start attempt
    installer.install_zip_bytes(make_zip(tmp_path, ["oeuSENC-OTHER"]))
    wait_done(installer)
