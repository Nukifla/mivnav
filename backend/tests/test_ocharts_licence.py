# SPDX-License-Identifier: GPL-2.0-only
"""The disk tile cache's encryption at rest and the startup o-charts licence
check (mivnav.features.ocharts.disk_tiles / .licence)."""

from __future__ import annotations

import threading
from pathlib import Path

import chartcore
import pytest

from mivnav.features.ocharts import licence
from mivnav.features.ocharts.disk_tiles import KEYCHECK, MISSING, DiskTileStore
from mivnav.features.ocharts.keys import SetInfo
from mivnav.features.ocharts.service import OchartsService
from mivnav.features.ocharts.sets import CellInfo, OchartsSet
from mivnav.features.ocharts.warm import _lonlat_tile

KEY = bytes(range(32))
OTHER_KEY = bytes(range(1, 33))

# ---- encryption at rest -------------------------------------------------------


def _files(root: Path) -> list[Path]:
    return [p for p in root.rglob("*") if p.is_file()]


def test_nothing_on_disk_is_plaintext(tmp_path: Path) -> None:
    store = DiskTileStore(tmp_path, 1 << 20, key=KEY)
    store.put("0123456789abcdef", 5, 1, 2, b"\x1f\x8bSOUNDG depth contours")
    store.put("0123456789abcdef", 5, 1, 3, None)
    store.write_manifest("0123456789abcdef", {"sets": {"DK": {"cells": [[10.5, 55.5, 11, 56]]}}})
    for path in _files(tmp_path):
        data = path.read_bytes()
        assert data.startswith(b"MVE1"), path
        assert b"SOUNDG" not in data and b"\x1f\x8b" not in data and b"DK" not in data, path
    # ...and it all reads back.
    assert store.get("0123456789abcdef", 5, 1, 2) == b"\x1f\x8bSOUNDG depth contours"
    assert store.get("0123456789abcdef", 5, 1, 3) is None
    assert store.read_manifest("0123456789abcdef")["sets"]["DK"]["cells"] == [[10.5, 55.5, 11, 56]]


def test_a_store_starts_locked_and_touches_nothing(tmp_path: Path) -> None:
    store = DiskTileStore(tmp_path / "t", 1 << 20)
    store.put("0123456789abcdef", 5, 1, 2, b"x")
    assert store.get("0123456789abcdef", 5, 1, 2) is MISSING
    assert store.prune("0123456789abcdef") == 0
    assert not (tmp_path / "t").exists()
    assert store.stats()["state"] == "locked"
    store.unlock(KEY)
    assert store.stats()["state"] == "locked", "unlocked is not yet serving"
    store.mark_ready()
    assert store.stats()["state"] == "ready"


def test_a_cache_from_before_encryption_is_sealed_in_place(tmp_path: Path) -> None:
    """Not wiped: on the boat that would be ~17 h of Pi re-rendering."""
    v = tmp_path / "0123456789abcdef"
    plain = v / "5" / "1" / "2.mvt.gz"
    plain.parent.mkdir(parents=True)
    plain.write_bytes(b"\x1f\x8bplaintext chart tile")
    (v / "5" / "1" / "3.mvt.gz").write_bytes(b"")  # an empty tile
    (v / "manifest.json").write_text('{"base": "b", "sets": {}}')
    (v / "5" / "1" / ".7.mvt.gz.123.tmp").write_bytes(b"\x1f\x8bhalf-written")

    store = DiskTileStore(tmp_path, 1 << 20)
    assert store.unlock(KEY) is False
    store.mark_ready()
    for path in _files(tmp_path):
        assert path.read_bytes().startswith(b"MVE1"), path
    assert not (v / "5" / "1" / ".7.mvt.gz.123.tmp").exists()
    assert store.get("0123456789abcdef", 5, 1, 2) == b"\x1f\x8bplaintext chart tile"
    assert store.get("0123456789abcdef", 5, 1, 3) is None
    assert store.read_manifest("0123456789abcdef") == {"base": "b", "sets": {}}
    assert (tmp_path / KEYCHECK).exists()


def test_another_machines_key_wipes_and_the_same_key_keeps(tmp_path: Path) -> None:
    DiskTileStore(tmp_path, 1 << 20, key=KEY).put("0123456789abcdef", 5, 1, 2, b"tile")

    same = DiskTileStore(tmp_path, 1 << 20)
    assert same.unlock(KEY) is False
    same.mark_ready()
    assert same.get("0123456789abcdef", 5, 1, 2) == b"tile"

    other = DiskTileStore(tmp_path, 1 << 20)
    assert other.unlock(OTHER_KEY) is True
    other.mark_ready()
    assert other.get("0123456789abcdef", 5, 1, 2) is MISSING
    assert not (tmp_path / "0123456789abcdef").exists()


def test_a_wipe_deletes_only_what_the_store_made(tmp_path: Path) -> None:
    """A misconfigured tile_disk_dir (a home directory, say) must lose
    nothing but the cache."""
    (tmp_path / "Documents").mkdir()
    (tmp_path / "Documents" / "log.txt").write_text("keep me")
    (tmp_path / "notes.txt").write_text("keep me")
    DiskTileStore(tmp_path, 1 << 20, key=KEY).put("0123456789abcdef", 5, 1, 2, b"tile")
    DiskTileStore(tmp_path, 1 << 20).unlock(OTHER_KEY)  # another machine: wipe
    assert (tmp_path / "Documents" / "log.txt").exists() and (tmp_path / "notes.txt").exists()
    assert not (tmp_path / "0123456789abcdef").exists()


def test_a_tile_sealed_under_another_key_is_a_miss(tmp_path: Path) -> None:
    store = DiskTileStore(tmp_path, 1 << 20, key=KEY)
    store.put("0123456789abcdef", 5, 1, 2, b"tile")
    path = tmp_path / "0123456789abcdef" / "5" / "1" / "2.mvt.gz"
    data = bytearray(path.read_bytes())
    data[-1] ^= 1  # tampered
    path.write_bytes(bytes(data))
    assert store.get("0123456789abcdef", 5, 1, 2) is MISSING


def _fpr(stamp: int, nets: list[tuple[str, str]], uuid: str = "0b1c2d3e-aaaa-bbbb-cccc-0123456789ab") -> tuple[str, str]:
    """An ``oexserverd -g`` fingerprint as the vendor binary writes it: the
    XML XOR-ed with the decimal stamp in its file name, which ``<DATE>``
    repeats (shape measured on the boat's Pi, values made up)."""
    lines = [f'<NET  Name="{n}" MAC="{m}"/>' for n, m in nets] + [
        '<USR  U1="pi"/>',
        f'<DATE  D1="{stamp}"/>',
        '<HOSTNAME  N1="boat"/>',
        f'<UUID  I1="{uuid}"/>',
    ]
    text = "\n".join(lines).encode()
    pad = str(stamp).encode()
    raw = bytes(b ^ pad[i % len(pad)] for i, b in enumerate(text))
    return f"oc03L_{stamp}.fpr", raw.hex()


_HW = [("eth0", "D8:3A:DD:00:00:01"), ("wlan0", "d8:3a:dd:00:00:02")]


def test_the_key_survives_a_new_stamp_and_container_churn() -> None:
    # The raw fingerprint changes every second, and docker/veth/AP entries
    # (locally administered MACs) with every container restart; the key
    # must not — a new key wipes the whole pre-rendered cache.
    a = licence.disk_key(*_fpr(1793938736, _HW + [("docker0", "02:42:ac:11:00:01")]))
    b = licence.disk_key(
        *_fpr(1793938799, [("veth9a8b7c6@if2", "6e:01:02:03:04:05")] + _HW[::-1] + [("wlan9", "da:3a:dd:00:00:03")])
    )
    assert a == b and len(a) == 32
    assert _fpr(1793938736, _HW)[1] != _fpr(1793938737, _HW)[1]  # the raw value does move


def test_the_key_is_bound_to_the_hardware_macs_and_the_uuid() -> None:
    base = licence.disk_key(*_fpr(1793938736, _HW))
    assert licence.disk_key(*_fpr(1793938736, [_HW[0], ("wlan0", "d8:3a:dd:00:00:09")])) != base
    assert licence.disk_key(*_fpr(1793938736, _HW, uuid="ffffffff-0000-0000-0000-000000000000")) != base


@pytest.mark.parametrize(
    "name, value",
    [
        ("fingerprint.fpr", _fpr(1793938736, _HW)[1]),  # no stamp to undo the XOR with
        ("oc03L_1793938736.fpr", "ff" * 64),  # not text
        ("oc03L_1793938736.fpr", _fpr(1793938736, _HW)[1][:20]),  # no UUID
    ],
    ids=["no-stamp", "not-text", "no-uuid"],
)
def test_an_undecodable_fingerprint_is_an_error_not_a_key(name: str, value: str) -> None:
    # An error keeps the store locked (run_once); a wrong key would wipe it.
    with pytest.raises(ValueError):
        licence.disk_key(name, value)


# ---- probing one set ----------------------------------------------------------


class _ProbeService:
    def __init__(self, behaviour) -> None:
        self.behaviour = behaviour  # path.name -> exception to raise, or None
        self.opened: list[str] = []

    def _needs_daemon(self, path: Path) -> bool:
        return path.suffix == ".oesu"

    def open_cell(self, path: Path, key: str):
        self.opened.append(path.name)
        err = self.behaviour(path.name)
        if err is not None:
            raise err
        return object()


def _set_dir(tmp_path: Path, sizes: dict[str, int]) -> OchartsSet:
    d = tmp_path / "set"
    d.mkdir(exist_ok=True)
    for name, size in sizes.items():
        (d / name).write_bytes(bytes(size))
    return OchartsSet(id="S", directory=d, sequence=1, info=SetInfo(directory=d))


def test_probe_tries_the_smallest_cell_first(tmp_path: Path) -> None:
    cs = _set_dir(tmp_path, {"BIG.oesu": 900, "SMALL.oesu": 10, "MID.oesu": 50})
    svc = _ProbeService(lambda name: None)
    assert licence.probe_set(svc, cs) == ("ok", "SMALL.oesu")
    assert svc.opened == ["SMALL.oesu"]


def test_probe_refused_when_the_daemon_will_not_decrypt(tmp_path: Path) -> None:
    cs = _set_dir(tmp_path, {"A.oesu": 10, "B.oesu": 20})
    outcome, detail = licence.probe_set(_ProbeService(lambda n: chartcore.DecryptError("bad key")), cs)
    assert outcome == "refused" and "bad key" in detail
    outcome, _ = licence.probe_set(_ProbeService(lambda n: chartcore.ExpiredError("expired")), cs)
    assert outcome == "refused"


def test_probe_one_decoding_cell_is_enough(tmp_path: Path) -> None:
    cs = _set_dir(tmp_path, {"A.oesu": 10, "B.oesu": 20})
    svc = _ProbeService(lambda n: chartcore.DecryptError("x") if n == "A.oesu" else None)
    assert licence.probe_set(svc, cs)[0] == "ok"


def test_probe_unknown_when_the_daemon_is_down(tmp_path: Path) -> None:
    cs = _set_dir(tmp_path, {"A.oesu": 10})
    assert licence.probe_set(_ProbeService(lambda n: chartcore.DaemonError("dead")), cs)[0] == "unknown"


def test_probe_a_corrupt_cell_says_nothing(tmp_path: Path) -> None:
    cs = _set_dir(tmp_path, {"A.oesu": 10})
    assert licence.probe_set(_ProbeService(lambda n: chartcore.ChartError("truncated")), cs)[0] == "unchecked"


def test_probe_a_set_without_encrypted_cells_needs_no_licence(tmp_path: Path) -> None:
    cs = _set_dir(tmp_path, {"A.senc": 10})
    svc = _ProbeService(lambda n: None)
    assert licence.probe_set(svc, cs) == ("none", "")
    assert svc.opened == []


# ---- the startup check, end to end ------------------------------------------------

DK_CELL = (10.0, 55.0, 12.0, 57.0)
UK_CELL = (-1.6, 50.6, -1.0, 50.9)
DK_TILE = (9, *_lonlat_tile(11.0, 56.0, 1 << 9))
UK_TILE = (9, *_lonlat_tile(-1.3, 50.75, 1 << 9))


def _real_set(root: Path, sid: str, extent) -> OchartsSet:
    d = root / sid
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{sid}1.oesu"
    path.write_bytes(bytes(10))
    cs = OchartsSet(id=sid, directory=d, sequence=1, info=SetInfo(directory=d))
    cs.cells = [CellInfo(path=path, key="", name=f"{sid}1", scale=50000, extent=extent, min_zoom=4, max_zoom=12)]
    return cs


def _boot(tmp_path: Path, refuse: set[str], *, error=chartcore.DecryptError, key=KEY):
    """A service whose check waits until its sets are patched in."""
    patched = threading.Event()
    sets = {sid: _real_set(tmp_path / "sets", sid, ext) for sid, ext in (("DK", DK_CELL), ("UK", UK_CELL))}

    def key_source() -> bytes:
        patched.wait(5)
        if isinstance(key, Exception):
            raise key
        return key

    svc = OchartsService(
        sets_dir=tmp_path / "sets",
        daemon_dir=tmp_path / "daemon",
        work_dir=tmp_path / "work",
        warm_overview=False,
        tile_disk_dir=tmp_path / "tiles",
        disk_key_source=key_source,
    )
    svc.sets = lambda: sets
    svc._needs_daemon = lambda p: True

    def open_cell(path: Path, key: str):
        if path.parent.name in refuse:
            raise error(f"refused {path.name}")
        return object()

    svc.open_cell = open_cell
    rendered: list[tuple] = []

    def cut(z, x, y):
        rendered.append((z, x, y))
        return b"tile"

    svc._cut_tile_all = cut
    patched.set()
    return svc, rendered


def _tile_files(root: Path, tile) -> list[Path]:
    z, x, y = tile
    return list(root.glob(f"*/{z}/{x}/{y}.mvt.gz"))


def test_a_good_licence_changes_nothing(tmp_path: Path) -> None:
    svc, rendered = _boot(tmp_path, refuse=set())
    assert svc.wait_licence(10)
    svc.tile_all(*DK_TILE)
    svc.tile_all(*UK_TILE)
    svc.close()

    again, rendered2 = _boot(tmp_path, refuse=set())
    assert again.wait_licence(10)
    assert again.status()["licence"]["state"] == "ok"
    again.tile_all(*DK_TILE)
    again.tile_all(*UK_TILE)
    assert rendered2 == [], "both tiles come from disk"
    again.close()


def test_a_refused_set_loses_its_stored_tiles_and_only_those(tmp_path: Path) -> None:
    svc, _ = _boot(tmp_path, refuse=set())
    assert svc.wait_licence(10)
    svc.tile_all(*DK_TILE)
    svc.tile_all(*UK_TILE)
    svc.close()
    assert _tile_files(tmp_path / "tiles", UK_TILE)

    svc, rendered = _boot(tmp_path, refuse={"UK"})
    assert svc.wait_licence(10)
    status = svc.status()["licence"]
    assert status["state"] == "refused"
    assert status["sets"]["UK"]["outcome"] == "refused"
    assert status["sets"]["DK"]["outcome"] == "ok"
    assert svc.union_version() == (("DK", 1),)
    assert _tile_files(tmp_path / "tiles", UK_TILE) == [], "the refused set's tile is deleted"
    svc.tile_all(*DK_TILE)
    assert rendered == [], "the other set's tile was kept"
    svc.close()

    # Still refused at the next start: nothing more to delete, nothing re-rendered.
    svc, rendered = _boot(tmp_path, refuse={"UK"})
    assert svc.wait_licence(10)
    svc.tile_all(*DK_TILE)
    assert rendered == []
    svc.close()


def test_an_unreachable_daemon_keeps_the_store_locked(tmp_path: Path) -> None:
    svc, _ = _boot(tmp_path, refuse=set())
    assert svc.wait_licence(10)
    svc.tile_all(*DK_TILE)
    svc.close()

    svc, rendered = _boot(tmp_path, refuse={"DK", "UK"}, error=chartcore.DaemonError)
    assert not svc.wait_licence(1)
    disk = svc.status()["disk_tile_cache"]
    assert disk["state"] == "locked" and "could not check the licence" in disk["locked_reason"]
    svc.tile_all(*DK_TILE)
    assert rendered == [DK_TILE], "served from RAM, not from the locked disk"
    assert _tile_files(tmp_path / "tiles", DK_TILE), "and nothing was deleted"
    svc.close()


def test_no_fingerprint_keeps_the_store_locked(tmp_path: Path) -> None:
    svc, _ = _boot(tmp_path, refuse=set(), key=RuntimeError("oexserverd binary missing"))
    assert not svc.wait_licence(1)
    disk = svc.status()["disk_tile_cache"]
    assert disk["state"] == "locked" and "fingerprint unavailable" in disk["locked_reason"]
    svc.close()


def test_no_disk_cache_no_check(tmp_path: Path) -> None:
    svc = OchartsService(
        sets_dir=tmp_path / "sets",
        daemon_dir=tmp_path / "daemon",
        work_dir=tmp_path / "work",
        warm_overview=False,
        tile_disk_dir=tmp_path / "tiles",
        tile_disk_budget=0,
        disk_key_source=lambda: (_ for _ in ()).throw(AssertionError("must not be asked")),
    )
    assert svc.status()["licence"] == {"state": "off"}
    svc.close()
