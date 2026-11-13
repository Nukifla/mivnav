# SPDX-License-Identifier: GPL-2.0-only
"""Installer pipeline: synthetic chart zips through unpack → test-open →
install, plus the documented error cases."""

import io
import os
import subprocess
import sys
import tempfile
import time
import zipfile
from datetime import UTC, date, datetime
from pathlib import Path

import httpx
import pytest

from mivnav.features.ocharts.clock import InstallClock
from mivnav.features.ocharts.eulas import EulaAcceptances
from mivnav.features.ocharts.install import STAGING_PREFIX, InstallError, Installer, sweep_stale_staging
from mivnav.features.ocharts.service import OchartsService
from senc_fixture import point_cell


EULA = "EN_rrc_eula_ChartSetsForOpenCPN.html"


def make_zip(
    tmp_path: Path, subdirs: list[str], with_cell: bool = True, eula: str | None = None
) -> bytes:
    buf = io.BytesIO()
    cell = tmp_path / "zip-cell.senc"
    point_cell(cell, name="OC-NEW-1")
    with zipfile.ZipFile(buf, "w") as zf:
        for sub in subdirs:
            zf.writestr(f"{sub}/Chartinfo.txt", "ChartInfo:Zipped Set;2026-1;2099-12-31\n")
            if with_cell:
                zf.write(cell, f"{sub}/OC-NEW-1.senc")
            if eula is not None:
                zf.writestr(f"{sub}/{EULA}", eula)
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
        if st["state"] in ("done", "error", "awaiting_eula", "cancelled") and not installer.busy():
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


# -- accept the EULA before install ------------------------------------------


@pytest.fixture()
def acceptances(tmp_path: Path) -> EulaAcceptances:
    return EulaAcceptances(tmp_path / "state" / "eula-acceptances.json")


def staging_dirs(before: set[Path]) -> set[Path]:
    return set(Path(tempfile.gettempdir()).glob(f"{STAGING_PREFIX}*")) - before


def test_a_set_with_an_eula_stops_before_install(
    service: OchartsService, acceptances: EulaAcceptances, tmp_path: Path
) -> None:
    before = staging_dirs(set())
    installer = Installer(service, acceptances=acceptances)
    installer.install_zip_bytes(make_zip(tmp_path, ["oeuSENC-EULA1"], eula="<p>Licence v1</p>"))
    st = wait_done(installer)
    assert st["state"] == "awaiting_eula", st
    assert st["eula"]["set"] == "Zipped Set"
    eula_id = st["eula"]["id"]
    # nothing installed, the staged set kept, its EULA readable
    assert service.sets() == {}
    assert len(staging_dirs(before)) == 1
    staged = installer.parked_eula()
    assert staged is not None and staged[0] == eula_id
    assert "Licence v1" in staged[1].read_text()
    # the one place is held: no second install meanwhile
    with pytest.raises(InstallError, match="licence agreement"):
        installer.install_zip_bytes(make_zip(tmp_path, ["oeuSENC-OTHER"]))
    with pytest.raises(InstallError):
        installer.accept("0000000000000000")  # not the text shown

    installer.accept(eula_id)
    st = wait_done(installer)
    assert st["state"] == "done", st["error"]
    assert st["eula"] is None
    assert service.get("oeuSENC-EULA1") is not None
    assert staging_dirs(before) == set()
    entry = acceptances.get(eula_id)
    assert entry is not None and entry["via"] == "install" and entry["sets"] == ["Zipped Set"]


def test_an_accepted_eula_does_not_stop_the_next_install(
    service: OchartsService, acceptances: EulaAcceptances, tmp_path: Path
) -> None:
    installer = Installer(service, acceptances=acceptances)
    installer.install_zip_bytes(make_zip(tmp_path, ["oeuSENC-A-2026-1-1"], eula="v1"))
    installer.accept(wait_done(installer)["eula"]["id"])
    assert wait_done(installer)["state"] == "done"
    # same text: straight through. Changed text: stops again.
    installer.install_zip_bytes(make_zip(tmp_path, ["oeuSENC-B-2026-1-1"], eula="v1"))
    assert wait_done(installer)["state"] == "done"
    installer.install_zip_bytes(make_zip(tmp_path, ["oeuSENC-C-2026-1-1"], eula="v2"))
    assert wait_done(installer)["state"] == "awaiting_eula"
    installer.discard()  # don't leak the staged set into the temp dir


def test_declining_deletes_the_staged_set(
    service: OchartsService, acceptances: EulaAcceptances, tmp_path: Path
) -> None:
    before = staging_dirs(set())
    installer = Installer(service, acceptances=acceptances)
    installer.install_zip_bytes(make_zip(tmp_path, ["oeuSENC-EULA1"], eula="v1"))
    eula_id = wait_done(installer)["eula"]["id"]
    installer.decline()
    st = installer.status()
    assert st["state"] == "cancelled" and st["eula"] is None
    assert staging_dirs(before) == set()
    assert service.sets() == {}
    assert not acceptances.accepted(eula_id)
    assert installer.parked_eula() is None
    with pytest.raises(InstallError):
        installer.accept(eula_id)
    # and the installer is free again
    installer.install_zip_bytes(make_zip(tmp_path, ["oeuSENC-FREE"]))
    assert wait_done(installer)["state"] == "done"


def test_discard_drops_a_parked_install(
    service: OchartsService, acceptances: EulaAcceptances, tmp_path: Path
) -> None:
    before = staging_dirs(set())
    installer = Installer(service, acceptances=acceptances)
    installer.install_zip_bytes(make_zip(tmp_path, ["oeuSENC-EULA1"], eula="v1"))
    wait_done(installer)
    installer.discard()
    assert staging_dirs(before) == set() and not installer.parked()


def test_a_shop_download_stops_at_its_eula_too(
    service: OchartsService, acceptances: EulaAcceptances, tmp_path: Path
) -> None:
    zip_bytes = make_zip(tmp_path, ["oeuSENC-SHOP1"], eula="v1")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("charts.zip"):
            return httpx.Response(200, content=zip_bytes)
        return httpx.Response(200, content=b"<keyList></keyList>")

    installer = Installer(
        service,
        http=httpx.Client(transport=httpx.MockTransport(handler)),
        acceptances=acceptances,
    )
    installer.install_from_shop("https://dl.example/charts.zip", "https://dl.example/keys.xml")
    assert wait_done(installer)["state"] == "awaiting_eula"
    assert service.sets() == {}
    installer.discard()


# -- no installs outside the licence period ---------------------------------


def fixed_clock(day: date, synchronised: bool = True, gps: date | None = None) -> InstallClock:
    return InstallClock(
        gps=lambda: gps,
        synchronised=lambda: synchronised,
        now=lambda: datetime(day.year, day.month, day.day, 12, tzinfo=UTC),
    )


def expiring_zip(tmp_path: Path, name: str, valid_to: str, eula: str | None = None) -> bytes:
    buf = io.BytesIO()
    cell = tmp_path / "zip-cell.senc"
    point_cell(cell, name="OC-NEW-1")
    with zipfile.ZipFile(buf, "w") as zf:
        info = zipfile.ZipInfo(f"{name}/Chartinfo.txt", date_time=(2026, 10, 1, 0, 0, 0))
        zf.writestr(info, f"ChartInfo:Expiring Set;2026-1;{valid_to}\n")
        zf.write(cell, f"{name}/OC-NEW-1.senc")
        if eula is not None:
            zf.writestr(f"{name}/{EULA}", eula)
    return buf.getvalue()


def test_an_expired_set_is_refused(service: OchartsService, tmp_path: Path) -> None:
    before = staging_dirs(set())
    installer = Installer(service, clock=fixed_clock(date(2027, 3, 2)))
    installer.install_zip_bytes(expiring_zip(tmp_path, "oeuSENC-OLD", "2027-03-01"))
    st = wait_done(installer)
    assert st["state"] == "error"
    assert "ended on 2027-03-01" in st["error"]
    assert service.sets() == {}
    assert staging_dirs(before) == set()


def test_a_set_is_installable_on_its_last_day(service: OchartsService, tmp_path: Path) -> None:
    installer = Installer(service, clock=fixed_clock(date(2027, 3, 1)))
    installer.install_zip_bytes(expiring_zip(tmp_path, "oeuSENC-LAST", "2027-03-01"))
    assert wait_done(installer)["state"] == "done"


def test_the_period_is_checked_before_the_eula_is_shown(
    service: OchartsService, acceptances: EulaAcceptances, tmp_path: Path
) -> None:
    installer = Installer(service, acceptances=acceptances, clock=fixed_clock(date(2027, 3, 2)))
    installer.install_zip_bytes(expiring_zip(tmp_path, "oeuSENC-OLD", "2027-03-01", eula="v1"))
    st = wait_done(installer)
    assert st["state"] == "error" and "ended on" in st["error"]


def test_a_set_that_expires_while_parked_is_not_installed(
    service: OchartsService, acceptances: EulaAcceptances, tmp_path: Path
) -> None:
    today = [date(2027, 3, 1)]
    clock = InstallClock(
        synchronised=lambda: True,
        now=lambda: datetime(today[0].year, today[0].month, today[0].day, tzinfo=UTC),
    )
    installer = Installer(service, acceptances=acceptances, clock=clock)
    installer.install_zip_bytes(expiring_zip(tmp_path, "oeuSENC-OLD", "2027-03-01", eula="v1"))
    eula_id = wait_done(installer)["eula"]["id"]
    today[0] = date(2027, 3, 2)
    installer.accept(eula_id)
    st = wait_done(installer)
    assert st["state"] == "error" and "ended on" in st["error"]
    assert service.sets() == {}


def test_sets_without_an_expiry_need_no_clock(service: OchartsService, tmp_path: Path) -> None:
    buf = io.BytesIO()
    cell = tmp_path / "c.senc"
    point_cell(cell, name="OC-NEW-1")
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("fnc-de/Chartinfo.txt", "ChartInfo:FNC-DE 2026-08-20\n")
        zf.write(cell, "fnc-de/OC-NEW-1.senc")
    # a clock that can be trusted by no rule at all
    installer = Installer(service, clock=fixed_clock(date(2000, 1, 1), synchronised=False))
    installer.install_zip_bytes(buf.getvalue())
    assert wait_done(installer)["state"] == "done"


def test_no_trustworthy_date_refuses(service: OchartsService, tmp_path: Path) -> None:
    # unsynchronised, no GPS, and the clock predates the set's own zip
    installer = Installer(service, clock=fixed_clock(date(2000, 1, 1), synchronised=False))
    installer.install_zip_bytes(expiring_zip(tmp_path, "oeuSENC-NEW", "2099-12-31"))
    st = wait_done(installer)
    assert st["state"] == "error"
    assert "cannot tell today's date" in st["error"]
    assert service.sets() == {}


def test_clock_rule_order() -> None:
    # 1. synchronised system clock wins, even over the GPS
    assert fixed_clock(date(2027, 1, 1), gps=date(2028, 1, 1)).today() == (
        date(2027, 1, 1),
        "synchronised system clock",
    )
    # 2. else the GPS, even when the system clock looks plausible
    clock = fixed_clock(date(2027, 1, 1), synchronised=False, gps=date(2028, 1, 1))
    assert clock.today() == (date(2028, 1, 1), "GPS")
    # 3. else a plausible system clock: not before the floor nor the set's build
    clock = fixed_clock(date(2027, 1, 1), synchronised=False)
    assert clock.today(not_before=date(2026, 12, 1))[0] == date(2027, 1, 1)
    with pytest.raises(Exception, match="cannot tell"):
        clock.today(not_before=date(2027, 6, 1))
    with pytest.raises(Exception, match="cannot tell"):
        fixed_clock(date(2026, 1, 1), synchronised=False).today()


def test_gps_date_from_a_signalk_snapshot() -> None:
    from mivnav.features.ocharts.clock import gps_date

    live = {"self": {"lng": 1, "lat": 2, "positionAtIso": "2027-05-04T23:30:00.000Z"}}
    assert gps_date(live) == date(2027, 5, 4)
    assert gps_date({**live, "fixAge": 60}) is None  # a stale fix is no clock
    assert gps_date({"self": None}) is None
    assert gps_date({"self": {"positionAtIso": "garbage"}}) is None


# -- stale staging dirs from a crashed server ---------------------------------


def dead_pid() -> int:
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()
    return proc.pid


def test_sweep_removes_only_our_stale_staging_dirs(tmp_path: Path) -> None:
    stale = tmp_path / f"{STAGING_PREFIX}{dead_pid()}-abc123_x"
    (stale / "unpacked" / "set").mkdir(parents=True)
    (stale / "unpacked" / "set" / "cell.oesu").write_bytes(b"x")
    live = tmp_path / f"{STAGING_PREFIX}{os.getpid()}-def456"
    live.mkdir()
    parent = tmp_path / f"{STAGING_PREFIX}{os.getppid()}-ghi789"
    parent.mkdir()
    others = [
        tmp_path / "mivnav-install-abc",  # not our name
        tmp_path / f"{STAGING_PREFIX}notapid-abc",
        tmp_path / f"x{STAGING_PREFIX}{dead_pid()}-abc",
    ]
    for d in others:
        d.mkdir()
    a_file = tmp_path / f"{STAGING_PREFIX}{dead_pid()}-file"
    a_file.write_text("not a dir")
    link = tmp_path / f"{STAGING_PREFIX}{dead_pid()}-link"
    target = tmp_path / "elsewhere"
    target.mkdir()
    link.symlink_to(target)

    assert sweep_stale_staging(tmp_path) == [stale]
    assert not stale.exists()
    assert live.is_dir() and parent.is_dir() and target.is_dir()
    assert all(d.is_dir() for d in others) and a_file.is_file() and link.is_symlink()


def test_sweep_of_a_missing_root_is_harmless(tmp_path: Path) -> None:
    assert sweep_stale_staging(tmp_path / "nope") == []


def test_staging_dirs_carry_the_pid(
    service: OchartsService, acceptances: EulaAcceptances, tmp_path: Path
) -> None:
    before = staging_dirs(set())
    installer = Installer(service, acceptances=acceptances)
    installer.install_zip_bytes(make_zip(tmp_path, ["oeuSENC-EULA1"], eula="v1"))
    wait_done(installer)
    (staged,) = staging_dirs(before)
    assert staged.name.startswith(f"{STAGING_PREFIX}{os.getpid()}-")
    # a live server's parked install survives another process's sweep
    assert staged not in sweep_stale_staging()
    installer.discard()
