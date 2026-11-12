# SPDX-License-Identifier: GPL-2.0-only
"""The shared rescan registry (A1): id-keyed, sequence/token reuse, drop-if-gone,
rate-limited, invalidate-able. Proven twice — once against a tiny synthetic
subclass that isolates the mechanics, once against the real PMTiles ``ChartStore``
that gained the rate-limit + ``invalidate`` in this chunk."""

import os
from pathlib import Path

import pytest

from mivnav.charts.store import ChartStore
from mivnav.rescan import RescanRegistry

SET_ID = "US5OAKIQ"


class FakeRegistry(RescanRegistry[dict]):
    """Lists an in-memory ``{id: token}`` map; each build makes a fresh object
    and records that a (re-)mint happened, so tests can assert reuse vs re-mint
    without touching the filesystem."""

    def __init__(self, entries: dict[str, object], **kw) -> None:
        super().__init__(**kw)
        self.entries = entries
        self.builds: list[str] = []  # ids that were (re-)minted
        self.reuses: list[str] = []  # ids whose object was reused

    def _list(self):
        for sid, token in self.entries.items():
            yield sid, token, lambda i=sid, t=token: self._make(i, t)

    def _make(self, sid: str, token: object) -> dict:
        self.builds.append(sid)
        return {"id": sid, "token": token}

    def _on_reuse(self, obj: dict) -> None:
        self.reuses.append(obj["id"])


# ---- the generic mechanics ------------------------------------------------


def test_reuse_if_unchanged_same_object_stable_sequence():
    reg = FakeRegistry({"a": 1}, rescan_interval=0)  # rescan every access
    first = reg.get("a")
    second = reg.get("a")
    assert second is first  # same object, not a rebuild
    assert reg.builds == ["a"]  # built exactly once
    assert reg.reuses == ["a"]  # the second scan reused it via _on_reuse


def test_changed_token_re_mints():
    reg = FakeRegistry({"a": 1}, rescan_interval=0)
    first = reg.get("a")
    reg.entries["a"] = 2  # the token moved (a re-ingest)
    second = reg.get("a")
    assert second is not first
    assert second["token"] == 2
    assert reg.builds == ["a", "a"]


def test_drop_if_gone():
    reg = FakeRegistry({"a": 1, "b": 1}, rescan_interval=0)
    assert set(reg.sets()) == {"a", "b"}
    del reg.entries["b"]  # b's resource disappeared
    assert set(reg.sets()) == {"a"}
    assert reg.get("b") is None
    assert "b" not in reg._known  # not merely hidden — dropped from the registry


def test_invalidate_forces_re_mint():
    reg = FakeRegistry({"a": 1}, rescan_interval=0)
    first = reg.get("a")
    reg.invalidate()
    second = reg.get("a")
    assert second is not first  # re-minted even though the token is unchanged
    assert reg.builds == ["a", "a"]


def test_rate_limit_throttles_but_invalidate_bypasses():
    reg = FakeRegistry({"a": 1}, rescan_interval=3600.0)  # effectively never
    reg.get("a")
    assert reg.builds == ["a"]

    reg.entries["a"] = 2  # an out-of-band change lands...
    assert reg.get("a")["token"] == 1  # ...unseen inside the interval
    assert reg.builds == ["a"]  # no rescan happened at all

    reg.invalidate()  # an in-process mutation forces the issue
    assert reg.get("a")["token"] == 2  # picked up at once
    assert reg.builds == ["a", "a"]


# ---- the real PMTiles store, exercising what it GAINED --------------------


@pytest.fixture
def pmtiles_bytes(charts_dir: Path) -> bytes:
    return (charts_dir / f"{SET_ID}.pmtiles").read_bytes()


def _bump_mtime(path: Path) -> None:
    st = path.stat()
    os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000))


def test_chartstore_reuses_open_archive(pmtiles_bytes, tmp_path):
    (tmp_path / f"{SET_ID}.pmtiles").write_bytes(pmtiles_bytes)
    store = ChartStore(tmp_path, rescan_interval=0)
    first = store.get(SET_ID)
    second = store.get(SET_ID)
    assert second is first  # same ChartSet, same open mmap
    assert first.sequence == second.sequence


def test_chartstore_rate_limit_defers_out_of_band_reingest(pmtiles_bytes, tmp_path):
    src = tmp_path / f"{SET_ID}.pmtiles"
    src.write_bytes(pmtiles_bytes)
    store = ChartStore(tmp_path, rescan_interval=3600.0)
    seq = store.get(SET_ID).sequence

    _bump_mtime(src)
    assert store.get(SET_ID).sequence == seq  # rate-limited: not yet seen

    store.invalidate()  # the explicit escape hatch PMTiles gained in A1
    assert store.get(SET_ID).sequence != seq


def test_chartstore_drops_deleted_set(pmtiles_bytes, tmp_path):
    src = tmp_path / f"{SET_ID}.pmtiles"
    src.write_bytes(pmtiles_bytes)
    store = ChartStore(tmp_path, rescan_interval=0)
    assert store.get(SET_ID) is not None
    src.unlink()
    assert store.get(SET_ID) is None
