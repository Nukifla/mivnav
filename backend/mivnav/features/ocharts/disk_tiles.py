# SPDX-License-Identifier: GPL-2.0-only
"""Persistent on-disk cache of rendered ``/tiles/all`` union tiles.

Why: the RAM tile cache (``OchartsService.tiles``) dies with the process,
and every restart or deploy then pays for every tile again. Most tiles are
cheap cold (0.1-0.2 s on the Pi at z10+), but the zoomed-out ones are not:
a z7 union tile measured 4.2 s cold and z5/z6 ~9 s, because they composite
up to ``max_cells_per_tile`` cells. Rendered tiles are small (300 tiles ~
10 MB gzipped) and the boat's server has an NVMe SSD, so keeping them on
disk makes zooming out instant across restarts. :mod:`.warm` fills this
store ahead of time (its pre-render phase).

Encrypted at rest, bound to the machine
---------------------------------------

Every file this store writes — tiles, empty tiles, manifests — is
ChaCha20-Poly1305 sealed (chosen over AES-GCM because the Pi 4's
Cortex-A72 has no AES instructions; ChaCha is fast in software on both
Pi 4 and Pi 5, ~0.3 ms for an average 33 KB tile at worst, against
100 ms-9 s for the render it saves). The key is derived from the
o-charts system fingerprint (``oexserverd -g``) — the very thing the
o-charts licence is bound to — so a copied cache directory, SD card or
backup is unreadable on any other machine. Only its stable part, the
hardware MACs and a filesystem UUID (:func:`.licence.machine_identity`):
the raw fingerprint changes every second, and keying on it wiped the cache
on every restart. That is the key's only secret, and it is not a strong
one: it is derived from this hardware (and the MACs are seen on the LAN),
so whoever holds the Pi itself, or its card plus a LAN capture, can
rebuild the key. What this guards against is a copy of the card alone — which is
why no route hands the fingerprint out (``GET /ocharts/fpr`` existed and
was removed: one unauthenticated LAN request plus a card copy opened the
cache). Do not add one back. :mod:`.licence` supplies the
key, and the store starts **locked**: no read, write or maintenance until
:meth:`DiskTileStore.unlock` has the key and :meth:`DiskTileStore.mark_ready`
says the startup licence check passed. A ``keycheck`` file in the root
proves the key. A wrong one (another machine's fingerprint) wipes the
store's version directories before anything is served; a missing one means
a cache from before encryption, all plaintext, which is sealed in place
(cheaper than re-rendering it) before anything is served.

Invalidation
------------

A tile is stored under ``root/<version>/<z>/<x>/<y>.mvt.gz``, where
``version`` is a digest of everything that changes the bytes for a given
z/x/y — the same inputs as the RAM key and the HTTP ETag
(``TILE_SCHEMA_VERSION``, every set's id + sequence, the SCAMIN bias), plus
the selection knobs and the S-52 library, which the RAM cache never needed
(a config change rebuilds the service and so empties RAM) but a disk cache
that outlives the process does. Anything else changing tile bytes for the
same input must bump ``TILE_SCHEMA_VERSION`` — already the contract for the
ETag (see CLAUDE.md), and this store relies on the same one. Superseded
version directories are deleted by :meth:`DiskTileStore.prune`.

Carry-over
----------

A version covers *every* installed set, so installing one more set (or
updating one) used to orphan every tile on disk, everywhere, and the Pi spent
up to ~17 hours re-rendering 238k tiles, most of them in waters the change
never touched. Each version directory therefore holds a ``manifest.json``
(:meth:`OchartsService.disk_manifest`): a ``base`` digest of everything in
the version *except* the sets, plus each set's sequence, bounds and cell
extents. When the version changes and the base did not,
:meth:`DiskTileStore.carry_over` moves every tile that no changed set reaches
from the old directory into the new one, so only the changed area renders
again. A union tile's bytes depend only on the cells charting it and on
whether any set's bounds reach it (``OchartsService._cut_tile_all``), so a
tile clear of every changed set's cell extents (and, for an added, removed
or reshaped set, its bounds) is byte-identical under the new version. A
schema bump or a settings change alters the base and still rebuilds
everything.

An empty tile (nothing charted there) is stored as a zero-length file:
gzip output is never empty, so the two cannot be confused.

Failure policy: the disk is an accelerator, never a dependency. Every I/O
error is logged (once per kind) and treated as a miss; a request never
fails because of this module.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import shutil
import threading
from collections.abc import Callable
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305

log = logging.getLogger(__name__)

#: Returned by :meth:`DiskTileStore.get` when the tile is not on disk
#: (distinct from ``None``, which is a stored *empty* tile).
MISSING = object()

#: Default on-disk budget. ~10 MB per 300 tiles measured on the Pi, so this
#: holds every tile a boat plausibly browses many times over.
DEFAULT_TILE_DISK_BUDGET = 4 << 30

#: When over budget, evict down to this fraction of it, so the (full-scan)
#: eviction runs rarely rather than on every write near the limit.
_EVICT_TO = 0.9

_SUFFIX = ".mvt.gz"

MANIFEST = "manifest.json"

#: Proves the key at unlock: a sealed constant, see the module docs.
KEYCHECK = "keycheck"
_KEYCHECK_PLAIN = b"mivnav disk tile cache v1"

#: Every sealed file: magic, 12-byte nonce, ciphertext + 16-byte tag.
_MAGIC = b"MVE1"
_NONCE = 12

#: The only directories :meth:`DiskTileStore.wipe` deletes — what
#: ``OchartsService.disk_version`` names them. A misconfigured
#: ``tile_disk_dir`` (say, a home directory) must not lose anything else.
_VERSION_DIR = re.compile(r"^[0-9a-f]{16}$")

Rect = tuple[float, float, float, float]  # w, s, e, n degrees


def tile_bounds_deg(z: int, x: int, y: int) -> Rect:
    """(w, s, e, n) degrees of a web-mercator tile."""
    n = 1 << z
    w = x / n * 360.0 - 180.0
    e = (x + 1) / n * 360.0 - 180.0

    def lat(yy: int) -> float:
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * yy / n))))

    return (w, lat(y + 1), e, lat(y))


def _hits(a: Rect, b: Rect) -> bool:
    return not (a[2] < b[0] or b[2] < a[0] or a[3] < b[1] or b[3] < a[1])


# Tile bounds are grown by this fraction of the tile before testing them
# against a changed set, so a cell whose coverage strays a hair past its
# header extent (coverage carries its own extent) still counts as reaching
# the tile. Erring this way only re-renders a tile that did not need it.
_MARGIN = 1 / 16


def _grow(b: Rect) -> Rect:
    dx, dy = (b[2] - b[0]) * _MARGIN, (b[3] - b[1]) * _MARGIN
    return (b[0] - dx, b[1] - dy, b[2] + dx, b[3] + dy)


class _Changes:
    """The area where tile bytes may differ between two manifests' sets."""

    def __init__(self, old: dict, new: dict) -> None:
        # (bounds, cell extents, whole): `whole` when the set's bounds
        # themselves changed, since `claim_allowed` reads them.
        self.regions: list[tuple[Rect, list[Rect], bool]] = []
        for sid in sorted(set(old) | set(new)):
            a, b = old.get(sid), new.get(sid)
            if a == b:
                continue
            whole = a is None or b is None or a.get("bounds") != b.get("bounds")
            for entry in (a, b):
                if entry is None:
                    continue
                bounds = tuple(entry["bounds"])
                cells = [tuple(c) for c in entry["cells"]]
                if any(r[0] > r[2] for r in [bounds, *cells]):
                    # crosses the antimeridian: not worth the arithmetic
                    bounds, whole = (-180.0, -90.0, 180.0, 90.0), True
                self.regions.append((bounds, cells, whole))

    def column_clear(self, z: int, x: int) -> bool:
        """No changed set reaches any tile of this column."""
        w, _s, e, _n = _grow(tile_bounds_deg(z, x, 0))
        return all(e < b[0] or b[2] < w for b, _c, _w in self.regions)

    def reaches(self, z: int, x: int, y: int) -> bool:
        t = _grow(tile_bounds_deg(z, x, y))
        for bounds, cells, whole in self.regions:
            if _hits(t, bounds) and (whole or any(_hits(t, c) for c in cells)):
                return True
        return False


class DiskTileStore:
    """Byte-budgeted, versioned directory of sealed, gzipped MVT tiles.

    Thread-safe: writes are atomic (temp file + ``os.replace``), and the
    byte counter is guarded by a lock held only for arithmetic.

    Starts locked (see "Encrypted at rest" in the module docs): pass
    ``key`` to unlock and mark it ready at once — what tests and tools
    want; the service instead unlocks after its licence check.
    """

    def __init__(self, root: Path, budget: int, key: bytes | None = None) -> None:
        self.root = root
        self.budget = budget
        self._lock = threading.Lock()
        self._bytes = 0
        self._sized = False  # _bytes is only meaningful once the scan ran
        self.hits = 0
        self.writes = 0
        self.evictions = 0
        self.errors = 0
        self._warned: set[str] = set()
        self._aead: ChaCha20Poly1305 | None = None
        self._ready = False
        #: Why the store is still locked, for ``stats()`` (never the key).
        self.locked_reason = "waiting for the licence check"
        if key is not None:
            self.unlock(key)
            self.mark_ready()

    @property
    def configured(self) -> bool:
        """A non-zero budget: the store is meant to be used at all."""
        return self.budget > 0

    @property
    def _unlocked(self) -> bool:
        """Maintenance may run: the key is known (but the store may not
        yet be serving — see :meth:`mark_ready`)."""
        return self.configured and self._aead is not None

    @property
    def enabled(self) -> bool:
        """Serving: unlocked and the licence check passed."""
        return self._unlocked and self._ready

    # -- key and licence -------------------------------------------------------

    def unlock(self, key: bytes) -> bool:
        """Take the key. A ``keycheck`` sealed under another key wipes
        every version directory; a missing one seals a pre-encryption cache
        in place. Returns whether it wiped. On an I/O error the store
        stays locked."""
        if not self.configured:
            return False
        aead = ChaCha20Poly1305(key)
        check = self.root / KEYCHECK
        try:
            sealed = check.read_bytes()
        except FileNotFoundError:
            sealed = None
        except OSError as e:
            self._error("keycheck", e)
            return False
        wiped = False
        if sealed is None:
            # A cache from before encryption: seal it where it lies rather
            # than wipe it — re-rendering a full pre-render costs the Pi
            # up to ~17 h; sealing is one read and write per file.
            self._seal_legacy(aead)
        if sealed is not None and self._open(aead, sealed, b"keycheck") != _KEYCHECK_PLAIN:
            self.wipe()
            wiped = True
        if sealed is None or wiped:
            try:
                self.root.mkdir(parents=True, exist_ok=True)
                tmp = check.with_name(f".{KEYCHECK}.tmp")
                tmp.write_bytes(self._seal(aead, _KEYCHECK_PLAIN, b"keycheck"))
                os.replace(tmp, check)
            except OSError as e:
                self._error("keycheck", e)
                return wiped
            if wiped:
                log.info("disk tile cache: sealed under a different machine's key, so it was wiped")
        self._aead = aead
        self.locked_reason = "waiting for the licence check"
        return wiped

    def _seal_legacy(self, aead: ChaCha20Poly1305) -> None:
        """Seal, in place, every plaintext file of a pre-encryption cache.
        A file that cannot be sealed is deleted: nothing stays plaintext."""
        sealed = 0
        try:
            versions = [e for e in self.root.iterdir() if e.is_dir() and _VERSION_DIR.match(e.name)]
        except FileNotFoundError:
            return
        except OSError as e:
            self._error("scan", e)
            return
        for vdir in versions:
            for dirpath, _dirs, files in os.walk(vdir):
                for name in files:
                    path = Path(dirpath) / name
                    if name == MANIFEST:
                        aad = b"manifest"
                    elif name.endswith(_SUFFIX):
                        try:
                            z, x = int(path.parent.parent.name), int(path.parent.name)
                            aad = self._tile_aad(z, x, int(name[: -len(_SUFFIX)]))
                        except ValueError:
                            aad = None
                    else:
                        aad = None  # a stray temp file: nothing we would read
                    try:
                        data = path.read_bytes()
                        if aad is None:
                            path.unlink()
                            continue
                        if data.startswith(_MAGIC):
                            continue
                        tmp = path.with_name(f".{name}.seal.tmp")
                        tmp.write_bytes(self._seal(aead, data, aad))
                        os.replace(tmp, path)
                        sealed += 1
                    except OSError as e:
                        self._error("seal", e)
                        try:
                            path.unlink(missing_ok=True)
                        except OSError:
                            pass
        if sealed:
            log.info("disk tile cache: sealed %d files of a cache from before encryption", sealed)

    def mark_ready(self) -> None:
        """The licence check passed: start serving."""
        self._ready = True
        self.locked_reason = ""

    def wipe(self) -> int:
        """Delete every version directory (and the key record). Only names
        this store creates are touched. Returns directories removed."""
        removed = 0
        try:
            entries = list(self.root.iterdir()) if self.root.is_dir() else []
        except OSError as e:
            self._error("scan", e)
            return 0
        for entry in entries:
            if entry.is_dir() and _VERSION_DIR.match(entry.name):
                shutil.rmtree(entry, ignore_errors=True)
                removed += 1
        try:
            (self.root / KEYCHECK).unlink(missing_ok=True)
        except OSError as e:
            self._error("keycheck", e)
        with self._lock:
            self._bytes = 0
            self._sized = False
        if removed:
            log.info("disk tile cache: wiped %d version(s)", removed)
        return removed

    @staticmethod
    def _seal(aead: ChaCha20Poly1305, data: bytes, aad: bytes) -> bytes:
        nonce = os.urandom(_NONCE)
        return _MAGIC + nonce + aead.encrypt(nonce, data, aad)

    @staticmethod
    def _open(aead: ChaCha20Poly1305, sealed: bytes, aad: bytes) -> bytes | None:
        """The plaintext, or None if not ours / tampered / another key."""
        if not sealed.startswith(_MAGIC) or len(sealed) < len(_MAGIC) + _NONCE:
            return None
        nonce = sealed[len(_MAGIC) : len(_MAGIC) + _NONCE]
        try:
            return aead.decrypt(nonce, sealed[len(_MAGIC) + _NONCE :], aad)
        except InvalidTag:
            return None

    @staticmethod
    def _tile_aad(z: int, x: int, y: int) -> bytes:
        # Not the version: carry-over moves files between versions.
        return f"tile {z}/{x}/{y}".encode()

    # -- request path ------------------------------------------------------

    def _path(self, version: str, z: int, x: int, y: int) -> Path:
        return self.root / version / str(z) / str(x) / f"{y}{_SUFFIX}"

    def get(self, version: str, z: int, x: int, y: int):
        """The stored tile (bytes, or None for a stored empty tile), or
        :data:`MISSING`."""
        if not self.enabled:
            return MISSING
        path = self._path(version, z, x, y)
        try:
            sealed = path.read_bytes()
        except FileNotFoundError:
            return MISSING
        except OSError as e:
            self._error("read", e)
            return MISSING
        data = self._open(self._aead, sealed, self._tile_aad(z, x, y))
        if data is None:
            # Not sealed under our key: unreadable, so useless — a miss,
            # and the render that follows overwrites it.
            self._error("decrypt", OSError(f"{path.name} does not open under this machine's key"))
            return MISSING
        # Recency for eviction (oldest mtime goes first). Best effort.
        try:
            os.utime(path)
        except OSError:
            pass
        self.hits += 1
        return data or None

    def put(self, version: str, z: int, x: int, y: int, data: bytes | None) -> None:
        if not self.enabled:
            return
        path = self._path(version, z, x, y)
        # An empty tile is sealed too (an empty plaintext): which tiles
        # hold nothing is chart coverage, and that is chart data.
        payload = self._seal(self._aead, data or b"", self._tile_aad(z, x, y))
        tmp = path.with_name(f".{path.name}.{threading.get_ident()}.tmp")
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            try:
                old = path.stat().st_size
            except FileNotFoundError:
                old = 0
            tmp.write_bytes(payload)
            os.replace(tmp, path)
        except OSError as e:
            self._error("write", e)
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
            return
        with self._lock:
            self.writes += 1
            self._bytes += len(payload) - old
            over = self._sized and self._bytes > self.budget
        if over:
            self.evict()

    def has(self, version: str, z: int, x: int, y: int) -> bool:
        """Is the tile on disk? A ``stat``, no read and no recency bump —
        for the pre-render walk, which must not make every tile look
        recently used (or read 238k files to learn they exist)."""
        return self.enabled and self._path(version, z, x, y).exists()

    # -- maintenance (background thread) ------------------------------------

    def read_manifest(self, version: str) -> dict | None:
        if not self._unlocked:
            return None
        try:
            sealed = (self.root / version / MANIFEST).read_bytes()
        except OSError:
            return None
        plain = self._open(self._aead, sealed, b"manifest")
        if plain is None:
            return None
        try:
            return json.loads(plain)
        except ValueError:
            return None

    def write_manifest(self, version: str, manifest: dict) -> None:
        # Sealed like the tiles: it lists every cell's extent.
        if not self._unlocked:
            return
        path = self.root / version / MANIFEST
        tmp = path.with_name(f".{MANIFEST}.tmp")
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp.write_bytes(self._seal(self._aead, json.dumps(manifest).encode(), b"manifest"))
            os.replace(tmp, path)
        except OSError as e:
            self._error("manifest", e)

    def carry_over(
        self, version: str, manifest: dict, pause: Callable[[], bool] | None = None
    ) -> tuple[str | None, int]:
        """Move into ``version`` every tile of the newest superseded version
        with the same ``base`` that no changed set reaches — see "Carry-over"
        in the module docs. A tile already in ``version`` (rendered by a
        request in the meantime) is kept. ``pause`` is called between
        columns; returning True abandons the move (shutdown). Returns the
        source version and the number of tiles moved."""
        if not self._unlocked:
            return None, 0
        source, old = None, None
        try:
            entries = list(self.root.iterdir()) if self.root.is_dir() else []
        except OSError as e:
            self._error("scan", e)
            return None, 0
        newest = -1.0
        for entry in entries:
            if entry.name == version or not entry.is_dir():
                continue
            m = self.read_manifest(entry.name)
            if m is None or m.get("base") != manifest.get("base"):
                continue
            try:
                mtime = (entry / MANIFEST).stat().st_mtime
            except OSError:
                continue
            if mtime > newest:
                newest, source, old = mtime, entry.name, m
        if source is None:
            return None, 0
        changes = _Changes(old.get("sets", {}), manifest.get("sets", {}))
        moved = 0
        src_root, dst_root = self.root / source, self.root / version
        for zdir in _int_dirs(src_root):
            z = int(zdir.name)
            for xdir in _int_dirs(zdir):
                if pause is not None and pause():
                    return source, moved
                x = int(xdir.name)
                dst_x = dst_root / zdir.name / xdir.name
                if changes.column_clear(z, x) and not dst_x.exists():
                    try:
                        dst_x.parent.mkdir(parents=True, exist_ok=True)
                        os.replace(xdir, dst_x)
                        moved += sum(1 for n in os.listdir(dst_x) if n.endswith(_SUFFIX))
                        continue
                    except OSError as e:
                        self._error("carry", e)
                        continue
                moved += self._carry_column(xdir, dst_x, z, x, changes)
        log.info("disk tile cache: carried %d tiles over from %s to %s", moved, source, version)
        return source, moved

    def _carry_column(self, src: Path, dst: Path, z: int, x: int, changes: _Changes) -> int:
        moved = 0
        try:
            names = os.listdir(src)
        except OSError as e:
            self._error("carry", e)
            return 0
        for name in names:
            if not name.endswith(_SUFFIX):
                continue
            try:
                y = int(name[: -len(_SUFFIX)])
            except ValueError:
                continue
            if changes.reaches(z, x, y):
                continue
            target = dst / name
            try:
                if target.exists():
                    continue
                dst.mkdir(parents=True, exist_ok=True)
                os.replace(src / name, target)
                moved += 1
            except OSError as e:
                self._error("carry", e)
        return moved

    def prune(self, keep: str) -> int:
        """Delete every version directory except ``keep`` (superseded by a
        chart install/update, a schema bump or a settings change), then
        (re)measure the store. Returns the number of directories removed."""
        if not self._unlocked:
            return 0
        removed = 0
        try:
            entries = list(self.root.iterdir()) if self.root.is_dir() else []
        except OSError as e:
            self._error("scan", e)
            return 0
        for entry in entries:
            if entry.name == keep or not entry.is_dir():
                continue
            shutil.rmtree(entry, ignore_errors=True)
            removed += 1
        if removed:
            log.info("disk tile cache: removed %d superseded version(s)", removed)
        self._measure()
        with self._lock:
            over = self._bytes > self.budget
        if over:
            self.evict()
        return removed

    def _files(self) -> list[tuple[float, int, Path]]:
        out = []
        for dirpath, _dirs, files in os.walk(self.root):
            for name in files:
                if not name.endswith(_SUFFIX):
                    continue
                p = Path(dirpath) / name
                try:
                    st = p.stat()
                except OSError:
                    continue
                out.append((st.st_mtime, st.st_size, p))
        return out

    def _measure(self) -> None:
        total = sum(size for _m, size, _p in self._files())
        with self._lock:
            self._bytes = total
            self._sized = True

    def evict(self) -> None:
        """Delete least-recently-used tiles until under the budget's low mark."""
        files = sorted(self._files())
        total = sum(size for _m, size, _p in files)
        target = int(self.budget * _EVICT_TO)
        evicted = 0
        for _mtime, size, path in files:
            if total <= target:
                break
            try:
                path.unlink()
            except OSError:
                continue
            total -= size
            evicted += 1
        with self._lock:
            self._bytes = total
            self._sized = True
            self.evictions += evicted
        if evicted:
            log.info("disk tile cache: evicted %d tiles to stay under %d bytes", evicted, self.budget)

    # -- reporting -----------------------------------------------------------

    def _error(self, kind: str, e: OSError) -> None:
        self.errors += 1
        if kind not in self._warned:
            self._warned.add(kind)
            log.warning("disk tile cache %s failed under %s (treated as a miss): %s", kind, self.root, e)

    def stats(self) -> dict:
        if not self.configured:
            state = "off"
        elif self.enabled:
            state = "ready"
        else:
            state = "locked"
        with self._lock:
            return {
                "state": state,
                "locked_reason": self.locked_reason if state == "locked" else "",
                "encrypted": True,
                "dir": str(self.root),
                "budget": self.budget,
                "bytes": self._bytes if self._sized else None,
                "hits": self.hits,
                "writes": self.writes,
                "evictions": self.evictions,
                "errors": self.errors,
            }


def _int_dirs(parent: Path) -> list[Path]:
    """The numeric (zoom or column) subdirectories of ``parent``."""
    try:
        return [p for p in parent.iterdir() if p.name.isdigit() and p.is_dir()]
    except OSError:
        return []
