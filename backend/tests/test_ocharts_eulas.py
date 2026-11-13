# SPDX-License-Identifier: GPL-2.0-only
"""Install-level EULA acceptance (.eulas): the store, its one-time takeover
of what registered devices accepted, and the install-accept / licences
routes."""

import io
import json
import time
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mivnav.features.ocharts.devices import DeviceStore, set_eula
from mivnav.features.ocharts.eulas import EulaAcceptances
from mivnav.features.ocharts.install import Installer
from mivnav.features.ocharts.service import OchartsService
from senc_fixture import point_cell

EULA = "EN_rrc_eula_ChartSetsForOpenCPN.html"


def test_accept_records_and_survives_a_reload(tmp_path: Path) -> None:
    path = tmp_path / "eula-acceptances.json"
    store = EulaAcceptances(path, clock=lambda: 1000.0)
    assert not store.accepted("abc")
    store.accept("abc", "Denmark")
    store.accept("abc", "Sweden")
    again = EulaAcceptances(path)
    assert again.accepted("abc")
    assert again.get("abc") == {"accepted_at": 1000.0, "sets": ["Denmark", "Sweden"], "via": "install"}


def test_first_load_takes_over_what_registered_devices_accepted(tmp_path: Path) -> None:
    devices = DeviceStore(tmp_path / "devices.json", clock=lambda: 50.0)
    devices.register("Chart table", ["eula-1"])
    later = DeviceStore(tmp_path / "devices.json", clock=lambda: 80.0)
    later.register("Cockpit", ["eula-1", "eula-2"])

    store = EulaAcceptances(tmp_path / "eula-acceptances.json", devices=DeviceStore(tmp_path / "devices.json"))
    assert store.accepted("eula-1") and store.accepted("eula-2")
    assert store.get("eula-1") == {"accepted_at": 50.0, "sets": [], "via": "device"}
    assert store.get("eula-2")["accepted_at"] == 80.0
    assert not store.accepted("eula-3")

    # Once only: a device accepting something later is not an install acceptance.
    raw = json.loads((tmp_path / "eula-acceptances.json").read_text())
    assert set(raw["accepted"]) == {"eula-1", "eula-2"}
    later.register("Bunk", ["eula-3"])
    fresh = EulaAcceptances(tmp_path / "eula-acceptances.json", devices=DeviceStore(tmp_path / "devices.json"))
    assert not fresh.accepted("eula-3")


def test_a_corrupt_file_is_kept_aside(tmp_path: Path) -> None:
    path = tmp_path / "eula-acceptances.json"
    path.write_text("{nope")
    store = EulaAcceptances(path, clock=lambda: 7.0)
    assert not store.accepted("x")
    assert (tmp_path / "eula-acceptances.json.corrupt-7").exists()


def test_installer_and_device_gate_agree_on_the_id(tmp_path: Path) -> None:
    (tmp_path / EULA).write_text("same text")
    found = set_eula(tmp_path)
    assert found is not None and found[1].name == EULA
    assert set_eula(tmp_path / "missing") is None


# -- over HTTP ------------------------------------------------------------------


def _zip(tmp_path: Path, directory: str, eula: str | None) -> bytes:
    buf = io.BytesIO()
    cell = tmp_path / "zip-cell.senc"
    point_cell(cell, name="OC-1")
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(f"{directory}/Chartinfo.txt", "ChartInfo:Licensed Set;2026-1;2099-12-31\n")
        zf.write(cell, f"{directory}/OC-1.senc")
        if eula is not None:
            zf.writestr(f"{directory}/{EULA}", eula)
    return buf.getvalue()


@pytest.fixture()
def env(tmp_path: Path):
    from mivnav.api.app import app
    from mivnav.features.ocharts.routes import (
        get_eula_acceptances,
        get_installer,
        get_service,
    )

    service = OchartsService(
        sets_dir=tmp_path / "sets",
        daemon_dir=tmp_path / "daemon",
        work_dir=tmp_path / "work",
        rescan_interval=0,
        warm_overview=False,
    )
    service.licensed = lambda cs: True  # plain cells standing in for encrypted ones
    acceptances = EulaAcceptances(tmp_path / "state" / "eula-acceptances.json")
    installer = Installer(service, acceptances=acceptances)
    saved = dict(app.dependency_overrides)
    app.dependency_overrides[get_service] = lambda: service
    app.dependency_overrides[get_installer] = lambda: installer
    app.dependency_overrides[get_eula_acceptances] = lambda: acceptances
    try:
        with TestClient(app) as client:
            yield client, service, installer
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(saved)


def _upload(client, data: bytes) -> dict:
    r = client.post("/ocharts/upload", files={"file": ("set.zip", data, "application/zip")})
    assert r.status_code == 200, r.text
    deadline = time.time() + 15
    while time.time() < deadline:
        st = client.get("/ocharts/install").json()
        if st["state"] in ("done", "error", "awaiting_eula"):
            return st
        time.sleep(0.02)
    raise TimeoutError(st)


def _wait(client) -> dict:
    deadline = time.time() + 15
    while time.time() < deadline:
        st = client.get("/ocharts/install").json()
        if st["state"] in ("done", "error"):
            return st
        time.sleep(0.02)
    raise TimeoutError(st)


def test_an_upload_waits_for_its_eula_which_can_be_read_first(env, tmp_path: Path) -> None:
    client, service, _ = env
    st = _upload(client, _zip(tmp_path, "oeuSENC-LIC-2026-1-1", "<p>Licence v1</p>"))
    assert st["state"] == "awaiting_eula"
    eula_id = st["eula"]["id"]
    assert st["eula"]["set"] == "Licensed Set"

    # readable before it is installed, sandboxed like an installed one's
    r = client.get(f"/ocharts/eula/{eula_id}")
    assert r.status_code == 200 and "Licence v1" in r.text
    assert r.headers["content-security-policy"] == "sandbox"
    assert client.get("/ocharts/licences").json() == {"sets": []}

    # no other install meanwhile, wrong id refused
    r = client.post("/ocharts/upload", files={"file": ("x.zip", b"x", "application/zip")})
    assert r.status_code == 409
    assert client.post("/ocharts/install/accept", json={"eula_id": "nope"}).status_code == 409

    r = client.post("/ocharts/install/accept", json={"eula_id": eula_id})
    assert r.status_code == 200
    assert _wait(client)["state"] == "done"

    (lic,) = client.get("/ocharts/licences").json()["sets"]
    assert lic["set_id"] == "oeuSENC-LIC-2026-1-1"
    assert lic["eula_id"] == eula_id
    assert lic["accepted_via"] == "install" and lic["accepted_at"] > 0
    # the installed set's EULA stays readable any time, with no device cookie
    assert client.get(f"/ocharts/eula/{eula_id}").status_code == 200


def test_declining_installs_nothing(env, tmp_path: Path) -> None:
    client, service, _ = env
    st = _upload(client, _zip(tmp_path, "oeuSENC-LIC-2026-1-1", "v1"))
    assert client.post("/ocharts/install/decline").json()["state"] == "cancelled"
    assert service.sets() == {}
    assert client.get(f"/ocharts/eula/{st['eula']['id']}").status_code == 404
    assert client.post("/ocharts/install/decline").status_code == 409


def test_licences_lists_a_set_installed_before_acceptance_was_recorded(env) -> None:
    client, service, _ = env
    d = service.sets_dir / "oeuSENC-OLD-2026-1-1"
    d.mkdir(parents=True)
    point_cell(d / "OC-1.senc", name="OC-1")
    (d / EULA).write_text("old text")
    service.invalidate()
    (lic,) = client.get("/ocharts/licences").json()["sets"]
    assert lic["eula_id"] and lic["accepted_at"] is None and lic["accepted_via"] == ""
