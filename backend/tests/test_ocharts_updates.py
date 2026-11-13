# SPDX-License-Identifier: GPL-2.0-only
"""o-charts updates: which shop chart is which installed set, which edition
is newer, the superseded set going away only once its replacement is in, and
the unattended run end to end against a fake shop."""

import io
import threading
import time
import zipfile
from pathlib import Path

import httpx
import pytest

from mivnav.features.ocharts import editions, fnc
from mivnav.features.ocharts.eulas import EulaAcceptances
from mivnav.features.ocharts.install import Installer
from mivnav.features.ocharts.service import OchartsService
from mivnav.features.ocharts.shop import (
    ChartSlot,
    Credentials,
    DownloadUrls,
    ShopChart,
    ShopError,
)
from mivnav.features.ocharts.updates import (
    UpdateLoop,
    Updater,
    find_updates,
    installed_editions,
)
from senc_fixture import point_cell

CREDS = Credentials("sailor@example.com", "pw")
SYSTEM = "boatpi"


def chart_zip(
    tmp_path: Path, directory: str, edition: str, with_cell: bool = True, eula: str | None = None
) -> bytes:
    """A shop-shaped zip: one directory, a legacy Chartinfo.txt carrying the
    edition (``2026-31`` parses to ``2026/01-31``), one plain cell."""
    buf = io.BytesIO()
    cell = tmp_path / "zip-cell.senc"
    point_cell(cell, name="OC-1")
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(f"{directory}/Chartinfo.txt", f"ChartInfo:Denmark;{edition};2099-12-31\n")
        if with_cell:
            zf.write(cell, f"{directory}/OC-1.senc")
        if eula is not None:
            zf.writestr(f"{directory}/EN_rrc_eula_ChartSetsForOpenCPN.html", eula)
    return buf.getvalue()


@pytest.fixture()
def service(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> OchartsService:
    svc = OchartsService(
        sets_dir=tmp_path / "sets",
        daemon_dir=tmp_path / "daemon",
        work_dir=tmp_path / "work",
        warm_overview=False,
    )
    monkeypatch.setattr(svc, "fingerprint", lambda: ("fpr.name", "fpr-value"))
    return svc


def wait_done(installer: Installer, timeout: float = 15.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        st = installer.status()
        if st["state"] in ("done", "error"):
            return st
        time.sleep(0.02)
    raise TimeoutError(f"install did not finish: {installer.status()}")


def install(installer: Installer, zip_bytes: bytes) -> dict:
    installer.install_zip_bytes(zip_bytes)
    return wait_done(installer)


def shop_chart(edition: str, *, chart_id: str = "DK", expired: bool = False,
               system: str | None = SYSTEM) -> ShopChart:
    return ShopChart(
        chart_id=chart_id,
        name="Denmark 2026",
        edition=edition,
        expired=expired,
        order="O1",
        quantity_id="1",
        slots=[ChartSlot(slot_uuid="slot-1", assigned_system=system)],
    )


# -- editions ---------------------------------------------------------------


def test_chart_code_is_the_shop_chart_id() -> None:
    assert editions.chart_code("oeuSENC-DK-2026-1-31-base") == "DK"
    assert editions.chart_code("oeuRNC-NOa-2026-1-2") == "NOa"
    # not shop-named: an FNC set, a bare directory
    assert editions.chart_code("fnc-de-2026-08-30") is None
    assert editions.chart_code("oeuSENC") is None


def test_edition_order_is_numeric_not_lexical() -> None:
    assert editions.is_newer("2026/1-38", "2026/1-31")
    assert editions.is_newer("2026/1-9", "2026/01-8")  # legacy zero-padded form
    assert editions.is_newer("2026/1-10", "2026/1-9")  # "10" < "9" as text
    assert editions.is_newer("2026/2-0", "2026/1-38")
    assert editions.is_newer("2027/1-0", "2026/9-9")
    assert not editions.is_newer("2026/1-31", "2026/1-31")
    assert not editions.is_newer("2026/1-30", "2026/1-31")


def test_an_unreadable_edition_never_wins_and_never_blocks() -> None:
    assert not editions.is_newer("", "2026/1-31")
    assert not editions.is_newer("soon", "")
    assert editions.is_newer("2026/1-1", "")


# -- find_updates -----------------------------------------------------------


INSTALLED = {"DK": ("oeuSENC-DK-2026-1-31-base", "2026/1-31")}


def test_a_newer_shop_edition_of_an_installed_set_is_an_update() -> None:
    (update,) = find_updates([shop_chart("2026/1-38")], SYSTEM, INSTALLED)
    assert (update.chart_id, update.set_id, update.installed_edition, update.available_edition,
            update.slot_uuid) == ("DK", "oeuSENC-DK-2026-1-31-base", "2026/1-31", "2026/1-38",
                                  "slot-1")


def test_what_is_never_an_update() -> None:
    # same edition; expired licence (the account lists last year's DK under
    # the same id); a slot bound to another machine; a chart not installed
    assert find_updates([shop_chart("2026/1-31")], SYSTEM, INSTALLED) == []
    assert find_updates([shop_chart("2026/1-38", expired=True)], SYSTEM, INSTALLED) == []
    assert find_updates([shop_chart("2026/1-38", system="laptop")], SYSTEM, INSTALLED) == []
    assert find_updates([shop_chart("2026/1-38", system=None)], SYSTEM, INSTALLED) == []
    assert find_updates([shop_chart("2026/1-38", chart_id="UK")], SYSTEM, INSTALLED) == []


def test_two_live_entries_for_one_chart_yield_one_update_the_newest() -> None:
    charts = [shop_chart("2026/1-35"), shop_chart("2026/1-38"), shop_chart("2026/1-36")]
    (update,) = find_updates(charts, SYSTEM, INSTALLED)
    assert update.available_edition == "2026/1-38"


# -- retiring the superseded set --------------------------------------------


def test_installing_a_newer_edition_removes_the_older_one(
    service: OchartsService, tmp_path: Path
) -> None:
    installer = Installer(service)
    assert install(installer, chart_zip(tmp_path, "oeuSENC-DK-2026-1-31", "2026-31"))["state"] == "done"
    assert install(installer, chart_zip(tmp_path, "oeuSENC-DK-2026-1-38", "2026-38"))["state"] == "done"
    assert sorted(service.sets()) == ["oeuSENC-DK-2026-1-38"]
    assert installed_editions(service) == {"DK": ("oeuSENC-DK-2026-1-38", "2026/01-38")}


def test_other_charts_and_newer_editions_are_left_alone(
    service: OchartsService, tmp_path: Path
) -> None:
    installer = Installer(service)
    for directory, edition in (
        ("oeuSENC-DK-2026-1-38", "2026-38"),
        ("oeuSENC-UK-2026-1-2", "2026-2"),  # another chart
        ("oeuRNC-DK-2026-1-1", "2026-1"),  # the raster DK is not the vector DK
        ("oeuSENC-DK-2026-1-31", "2026-31"),  # an OLDER zip, installed by hand
    ):
        assert install(installer, chart_zip(tmp_path, directory, edition))["state"] == "done"
    assert sorted(service.sets()) == [
        "oeuRNC-DK-2026-1-1",
        "oeuSENC-DK-2026-1-31",
        "oeuSENC-DK-2026-1-38",
        "oeuSENC-UK-2026-1-2",
    ]


def test_a_failed_update_keeps_the_working_set(service: OchartsService, tmp_path: Path) -> None:
    installer = Installer(service)
    assert install(installer, chart_zip(tmp_path, "oeuSENC-DK-2026-1-31", "2026-31"))["state"] == "done"
    broken = chart_zip(tmp_path, "oeuSENC-DK-2026-1-38", "2026-38", with_cell=False)
    assert install(installer, broken)["state"] == "error"
    assert sorted(service.sets()) == ["oeuSENC-DK-2026-1-31"]


# -- the updater against a fake shop ----------------------------------------


class FakeShop:
    """Stands in for ShopClient; records what was asked of it."""

    def __init__(self, charts: list[ShopChart], system: str | None = SYSTEM,
                 error: ShopError | None = None) -> None:
        self.charts = charts
        self.system = system
        self.error = error
        self.requested: list[tuple[str, str, str]] = []
        self.logins = 0

    def __call__(self, creds: Credentials) -> "FakeShop":
        self.logins += 1
        return self

    def identify_system(self, name: str, value: str) -> str | None:
        if self.error:
            raise self.error
        return self.system

    def chart_list(self):
        return [SYSTEM], self.charts

    def download_urls(self, system: str, slot: str, edition: str) -> DownloadUrls:
        self.requested.append((system, slot, edition))
        return DownloadUrls("https://dl.example/charts.zip", "https://dl.example/keys.xml")

    def assign_chart(self, *a):  # must never be reached: it spends a slot
        raise AssertionError("an update must not assign a slot")

    def register_system(self, *a):
        raise AssertionError("an update must not register the system")

    def close(self) -> None:
        pass


def downloading(
    service: OchartsService, zip_bytes: bytes, acceptances: EulaAcceptances | None = None
) -> tuple[Installer, list[str]]:
    fetched: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        fetched.append(request.url.path)
        if request.url.path.endswith("charts.zip"):
            return httpx.Response(200, content=zip_bytes)
        return httpx.Response(200, content=b"<keyList></keyList>")

    return Installer(
        service,
        http=httpx.Client(transport=httpx.MockTransport(handler)),
        acceptances=acceptances,
    ), fetched


def test_run_installs_the_update_and_retires_the_old_set(
    service: OchartsService, tmp_path: Path
) -> None:
    install(Installer(service), chart_zip(tmp_path, "oeuSENC-DK-2026-1-31", "2026-31"))
    installer, _ = downloading(service, chart_zip(tmp_path, "oeuSENC-DK-2026-1-38", "2026-38"))
    shop = FakeShop([shop_chart("2026/1-38")])
    updater = Updater(shop=shop)

    updater.run(service, installer, CREDS)

    assert shop.requested == [(SYSTEM, "slot-1", "2026/1-38")]
    assert sorted(service.sets()) == ["oeuSENC-DK-2026-1-38"]
    st = updater.status()
    assert (st["state"], st["error"], st["updates"]) == ("idle", "", [])
    assert [(i["chart_id"], i["edition"]) for i in st["installed"]] == [("DK", "2026/1-38")]
    # and a second run finds nothing to do — no download
    updater.run(service, installer, CREDS)
    assert len(shop.requested) == 1


def test_check_reports_without_installing(service: OchartsService, tmp_path: Path) -> None:
    install(Installer(service), chart_zip(tmp_path, "oeuSENC-DK-2026-1-31", "2026-31"))
    shop = FakeShop([shop_chart("2026/1-38")])
    updater = Updater(shop=shop)

    (update,) = updater.check(service, CREDS)

    assert update.available_edition == "2026/1-38"
    assert shop.requested == []
    assert sorted(service.sets()) == ["oeuSENC-DK-2026-1-31"]
    assert updater.status()["updates"][0]["installed_edition"] == "2026/01-31"


def test_an_unreachable_shop_is_recorded_not_raised(service: OchartsService) -> None:
    shop = FakeShop([], error=ShopError("AV4", "connect failed"))
    updater = Updater(shop=shop)
    installer, fetched = downloading(service, b"")

    updater.run(service, installer, CREDS)  # at sea: must not raise

    st = updater.status()
    assert "connect failed" in st["error"]
    assert st["state"] == "idle" and st["checked_at"] is not None
    assert fetched == []


def test_an_unregistered_system_updates_nothing(service: OchartsService) -> None:
    updater = Updater(shop=FakeShop([shop_chart("2026/1-38")], system=None))
    installer, fetched = downloading(service, b"")
    updater.run(service, installer, CREDS)
    assert "not registered" in updater.status()["error"]
    assert fetched == []


def test_a_failed_edition_is_not_downloaded_again_unattended(
    service: OchartsService, tmp_path: Path
) -> None:
    install(Installer(service), chart_zip(tmp_path, "oeuSENC-DK-2026-1-31", "2026-31"))
    broken = chart_zip(tmp_path, "oeuSENC-DK-2026-1-38", "2026-38", with_cell=False)
    installer, _ = downloading(service, broken)
    shop = FakeShop([shop_chart("2026/1-38")])
    updater = Updater(shop=shop)

    updater.run(service, installer, CREDS)
    updater.run(service, installer, CREDS)

    assert len(shop.requested) == 1  # the second run skipped the known-bad edition
    (pending,) = updater.status()["updates"]
    assert "no chart cells" in pending["failed"]
    assert sorted(service.sets()) == ["oeuSENC-DK-2026-1-31"]
    # asked for by hand, it is tried again
    updater.run(service, installer, CREDS, retry_failed=True)
    assert len(shop.requested) == 2


def _install_with_eula(
    service: OchartsService, tmp_path: Path, acceptances: EulaAcceptances, text: str
) -> None:
    """The installed DK 2026-31, its licence agreement ``text`` accepted."""
    installer = Installer(service, acceptances=acceptances)
    installer.install_zip_bytes(chart_zip(tmp_path, "oeuSENC-DK-2026-1-31", "2026-31", eula=text))
    st = wait_parked_or_done(installer)
    assert st["state"] == "awaiting_eula"
    installer.accept(st["eula"]["id"])
    assert wait_parked_or_done(installer)["state"] == "done"


def wait_parked_or_done(installer: Installer, timeout: float = 15.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        st = installer.status()
        if st["state"] in ("done", "error", "awaiting_eula") and not installer.busy():
            return st
        time.sleep(0.02)
    raise TimeoutError(f"install did not finish: {installer.status()}")


def test_an_update_with_an_unchanged_eula_installs_unattended(
    service: OchartsService, tmp_path: Path
) -> None:
    acceptances = EulaAcceptances(tmp_path / "state" / "eula-acceptances.json")
    _install_with_eula(service, tmp_path, acceptances, "Licence v1")
    update = chart_zip(tmp_path, "oeuSENC-DK-2026-1-38", "2026-38", eula="Licence v1")
    installer, _ = downloading(service, update, acceptances)
    updater = Updater(shop=FakeShop([shop_chart("2026/1-38")]))

    updater.run(service, installer, CREDS)

    assert sorted(service.sets()) == ["oeuSENC-DK-2026-1-38"]
    assert updater.status()["updates"] == []


def test_an_update_with_a_changed_eula_parks_until_accepted(
    service: OchartsService, tmp_path: Path
) -> None:
    acceptances = EulaAcceptances(tmp_path / "state" / "eula-acceptances.json")
    _install_with_eula(service, tmp_path, acceptances, "Licence v1")
    update = chart_zip(tmp_path, "oeuSENC-DK-2026-1-38", "2026-38", eula="Licence v2")
    installer, _ = downloading(service, update, acceptances)
    shop = FakeShop([shop_chart("2026/1-38")])
    updater = Updater(shop=shop)

    updater.run(service, installer, CREDS)

    # never installed unattended: the old set serves on, the new one waits
    assert sorted(service.sets()) == ["oeuSENC-DK-2026-1-31"]
    st = installer.status()
    assert st["state"] == "awaiting_eula"
    (pending,) = updater.status()["updates"]
    assert pending["awaiting_eula"] == st["eula"]["id"]
    assert pending["failed"] == ""
    assert updater.status()["installed"] == []
    # the next unattended run neither downloads it again nor accepts it
    updater.run(service, installer, CREDS)
    assert len(shop.requested) == 1
    assert installer.status()["state"] == "awaiting_eula"

    installer.accept(st["eula"]["id"])
    assert wait_parked_or_done(installer)["state"] == "done"
    assert sorted(service.sets()) == ["oeuSENC-DK-2026-1-38"]


def test_a_declined_update_is_not_downloaded_again_unattended(
    service: OchartsService, tmp_path: Path
) -> None:
    acceptances = EulaAcceptances(tmp_path / "state" / "eula-acceptances.json")
    _install_with_eula(service, tmp_path, acceptances, "Licence v1")
    update = chart_zip(tmp_path, "oeuSENC-DK-2026-1-38", "2026-38", eula="Licence v2")
    installer, _ = downloading(service, update, acceptances)
    shop = FakeShop([shop_chart("2026/1-38")])
    updater = Updater(shop=shop)

    updater.run(service, installer, CREDS)
    installer.decline()
    updater.run(service, installer, CREDS)
    assert len(shop.requested) == 1
    assert sorted(service.sets()) == ["oeuSENC-DK-2026-1-31"]
    # asked for by hand, it is downloaded and waits for a person again
    updater.run(service, installer, CREDS, retry_failed=True)
    assert len(shop.requested) == 2
    assert installer.status()["state"] == "awaiting_eula"
    installer.discard()  # don't leak the staged set into the temp dir


def test_a_zip_that_is_another_chart_is_refused(service: OchartsService, tmp_path: Path) -> None:
    install(Installer(service), chart_zip(tmp_path, "oeuSENC-DK-2026-1-31", "2026-31"))
    installer, _ = downloading(service, chart_zip(tmp_path, "oeuSENC-UK-2026-1-38", "2026-38"))
    updater = Updater(shop=FakeShop([shop_chart("2026/1-38")]))

    updater.run(service, installer, CREDS)

    assert "not chart DK" in updater.status()["updates"][0]["failed"]
    assert sorted(service.sets()) == ["oeuSENC-DK-2026-1-31"]


def test_only_one_run_at_a_time(service: OchartsService) -> None:
    gate = threading.Event()

    class SlowShop(FakeShop):
        def chart_list(self):
            gate.wait(5)
            return super().chart_list()

    shop = SlowShop([])
    updater = Updater(shop=shop)
    installer, _ = downloading(service, b"")
    first = threading.Thread(target=updater.run, args=(service, installer, CREDS))
    first.start()
    while not updater.busy():
        time.sleep(0.01)
    updater.run(service, installer, CREDS)  # returns at once, no second login
    gate.set()
    first.join(5)
    assert shop.logins == 1


# -- the unattended loop ------------------------------------------------------


class FakeRuntime:
    """Just what UpdateLoop reads off the process Runtime."""

    def __init__(self, service, installer, updater, *, auto_update=True, password="pw"):
        from types import SimpleNamespace

        from pydantic import SecretStr

        self.service_, self.installer_, self.updater = service, installer, updater
        self.cfg = SimpleNamespace(
            ocharts=SimpleNamespace(auto_update=auto_update),
            credentials=SimpleNamespace(
                ocharts=SimpleNamespace(user="sailor@example.com", password=SecretStr(password))
            ),
        )
        self.config = SimpleNamespace(get=lambda: self.cfg)

    def feature(self, feature_id: str):
        assert feature_id == "ocharts"
        return self

    def service(self):
        return self.service_

    def installer(self):
        return self.installer_


def test_the_loop_updates_once_then_waits_a_day(service: OchartsService, tmp_path: Path) -> None:
    install(Installer(service), chart_zip(tmp_path, "oeuSENC-DK-2026-1-31", "2026-31"))
    installer, _ = downloading(service, chart_zip(tmp_path, "oeuSENC-DK-2026-1-38", "2026-38"))
    shop = FakeShop([shop_chart("2026/1-38")])
    loop = UpdateLoop(FakeRuntime(service, installer, Updater(shop=shop)))

    loop.tick()
    assert sorted(service.sets()) == ["oeuSENC-DK-2026-1-38"]
    logins = shop.logins
    loop.tick()  # not due again for a day: the shop is not asked
    assert shop.logins == logins


def test_the_loop_does_nothing_when_switched_off_or_without_a_login(
    service: OchartsService,
) -> None:
    installer, _ = downloading(service, b"")
    for kwargs in ({"auto_update": False}, {"password": ""}):
        shop = FakeShop([shop_chart("2026/1-38")])
        asked: list[str] = []
        updater = Updater(shop=shop, fnc_client=lambda: fnc_client(b"", asked=asked))
        UpdateLoop(FakeRuntime(service, installer, updater, **kwargs)).tick()
        assert shop.logins == 0
        assert asked == []  # no free charts installed: the publisher is not asked


def test_the_loop_retries_a_failed_check_sooner_than_a_day(service: OchartsService) -> None:
    from mivnav.features.ocharts import updates

    installer, _ = downloading(service, b"")
    shop = FakeShop([], error=ShopError("AV4", "offline"))
    loop = UpdateLoop(FakeRuntime(service, installer, Updater(shop=shop)))
    before = time.monotonic()
    loop.tick()
    assert loop._next_at - before < updates.RETRY_INTERVAL_S + 5 < updates.CHECK_INTERVAL_S


# -- routes -------------------------------------------------------------------


def test_updates_routes_without_a_login(client) -> None:
    body = client.get("/ocharts/updates").json()
    assert body["state"] == "idle" and body["updates"] == []
    assert client.get("/ocharts/status").json()["updates"]["state"] == "idle"
    assert body["fnc"] == {"checked_at": None, "error": ""}
    # no credentials in the isolated config: the shop check is refused before
    # any network; a run is not — the free charts need no login, and with
    # none installed it has nothing to ask anyone
    assert client.post("/ocharts/updates/check").status_code == 503
    assert client.post("/ocharts/updates/install").status_code == 200


def test_auto_update_is_on_by_default_and_switching_it_keeps_the_service(client) -> None:
    from mivnav.config.model import Config
    from mivnav.features.ocharts.runtime import service_slice

    on = Config()
    assert on.ocharts.auto_update is True
    off = on.model_copy(update={"ocharts": on.ocharts.model_copy(update={"auto_update": False})})
    assert service_slice(on) == service_slice(off)  # no oexserverd restart, no cache drop
    assert client.patch("/config", json={"ocharts": {"auto_update": False}}).status_code == 200
    assert client.get("/config").json()["config"]["ocharts"]["auto_update"] is False
    assert client.patch("/config", json={"ocharts": {"auto_update": True}}).status_code == 200


# -- freenauticalchart.net ----------------------------------------------------

FNC_CELL = Path(__file__).resolve().parents[1] / "data" / "fnc" / "DE6OSTIM.S57"
FNC_URL = fnc.REGIONS["de"].url
ETAG_OLD, ETAG_NEW = '"old"', '"new"'
LM_OLD, LM_NEW = "Mon, 20 Jul 2026 03:25:39 GMT", "Thu, 20 Aug 2026 04:11:02 GMT"


def fnc_zip(date: str, with_cell: bool = True) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("fnc-de/Chartinfo.txt", f"ChartInfo:FNC-DE {date}\n")
        if with_cell:
            zf.write(FNC_CELL, "fnc-de/DE6OSTIM.S57")
    return buf.getvalue()


def fnc_http(zip_bytes: bytes, etag: str, last_modified: str, asked: list[str] | None = None,
             down: bool = False) -> httpx.Client:
    """The publisher: HEAD answers the version, GET the zip. ``nl`` is never
    installed in these tests, so asking about it is itself a failure."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == FNC_URL, request.url
        if asked is not None:
            asked.append(request.method)
        if down:
            raise httpx.ConnectError("no route to host")
        headers = {"etag": etag, "last-modified": last_modified}
        if request.method == "HEAD":
            return httpx.Response(200, headers=headers)
        return httpx.Response(200, headers=headers, content=zip_bytes)

    return httpx.Client(transport=httpx.MockTransport(handler))


def fnc_client(zip_bytes: bytes, etag: str = ETAG_NEW, last_modified: str = LM_NEW, **kw):
    return fnc.FncClient(fnc_http(zip_bytes, etag, last_modified, **kw))


def install_fnc(service: OchartsService, date: str = "2026-07-19") -> None:
    http = fnc_http(fnc_zip(date), ETAG_OLD, LM_OLD)
    # No EULA ever accepted: a free set ships none, so it never waits for one.
    nothing_accepted = EulaAcceptances(service.sets_dir.parent / "state" / "eula-acceptances.json")
    installer = Installer(service, http=http, acceptances=nothing_accepted)
    installer.install_from_url(
        FNC_URL,
        prepare=fnc.prepare(fnc.FncClient(http).version("de")),
        on_installed=fnc.on_installed(service.sets_dir, "de"),
    )
    assert wait_done(installer)["state"] == "done"


def test_run_updates_an_installed_free_region_with_no_login(service: OchartsService) -> None:
    install_fnc(service)
    assert sorted(service.sets()) == ["fnc-de-2026-07-19"]
    new_zip = fnc_zip("2026-08-19")
    asked: list[str] = []
    updater = Updater(fnc_client=lambda: fnc_client(new_zip, asked=asked))
    installer = Installer(service, http=fnc_http(new_zip, ETAG_NEW, LM_NEW))

    updater.run(service, installer, None)  # no o-charts login at all

    assert sorted(service.sets()) == ["fnc-de-2026-08-19"]  # replaced, not doubled
    st = updater.status()
    assert st["fnc"]["error"] == "" and st["fnc"]["checked_at"] is not None
    assert [(i["chart_id"], i["edition"]) for i in st["installed"]] == [("fnc-de", "2026-08-20")]
    assert asked == ["HEAD"]  # only the installed region was asked about
    # the marker now carries the new ETag, so the next run downloads nothing
    updater.run(service, installer, None)
    assert len(updater.status()["installed"]) == 1


def test_an_unchanged_free_region_is_not_downloaded(service: OchartsService) -> None:
    install_fnc(service)
    fetched: list[str] = []
    updater = Updater(fnc_client=lambda: fnc_client(b"", ETAG_OLD, LM_OLD))
    installer = Installer(service, http=fnc_http(b"", ETAG_OLD, LM_OLD, asked=fetched))
    updater.run(service, installer, None)
    assert fetched == []
    assert sorted(service.sets()) == ["fnc-de-2026-07-19"]
    assert updater.status()["fnc"]["error"] == ""


def test_an_unreachable_publisher_is_recorded_and_the_shop_still_ran(
    service: OchartsService, tmp_path: Path
) -> None:
    install(Installer(service), chart_zip(tmp_path, "oeuSENC-DK-2026-1-31", "2026-31"))
    install_fnc(service)
    installer, _ = downloading(service, chart_zip(tmp_path, "oeuSENC-DK-2026-1-38", "2026-38"))
    updater = Updater(
        shop=FakeShop([shop_chart("2026/1-38")]),
        fnc_client=lambda: fnc_client(b"", down=True),
    )

    updater.run(service, installer, CREDS)

    assert sorted(service.sets()) == ["fnc-de-2026-07-19", "oeuSENC-DK-2026-1-38"]
    st = updater.status()
    assert st["error"] == "" and "cannot reach" in st["fnc"]["error"]


def test_an_unreachable_shop_does_not_stop_the_free_charts(service: OchartsService) -> None:
    install_fnc(service)
    new_zip = fnc_zip("2026-08-19")
    updater = Updater(
        shop=FakeShop([], error=ShopError("AV4", "offline")),
        fnc_client=lambda: fnc_client(new_zip),
    )
    updater.run(service, Installer(service, http=fnc_http(new_zip, ETAG_NEW, LM_NEW)), CREDS)
    assert sorted(service.sets()) == ["fnc-de-2026-08-19"]
    assert "offline" in updater.status()["error"]


def test_a_failed_free_update_keeps_the_set_and_is_not_downloaded_again(
    service: OchartsService,
) -> None:
    install_fnc(service)
    broken = fnc_zip("2026-08-19", with_cell=False)
    fetched: list[str] = []
    updater = Updater(fnc_client=lambda: fnc_client(broken))
    installer = Installer(service, http=fnc_http(broken, ETAG_NEW, LM_NEW, asked=fetched))

    updater.run(service, installer, None)
    updater.run(service, installer, None)

    assert fetched == ["GET"]  # the second run skipped the known-bad zip
    assert sorted(service.sets()) == ["fnc-de-2026-07-19"]
    assert "no OSENC cells" in updater.status()["fnc"]["error"]
    updater.run(service, installer, None, retry_failed=True)
    assert fetched == ["GET", "GET"]
