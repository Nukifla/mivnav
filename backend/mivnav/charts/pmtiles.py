# SPDX-License-Identifier: GPL-2.0-only
"""Minimal PMTiles v3 reader: mmap + range reads, no dependencies.

Python counterpart of ``chartcore/src/pmtiles/mod.rs`` (the writer); returns
the *stored* (gzip-compressed) tile bytes untouched so serving never re-compresses.
"""

from __future__ import annotations

import gzip
import json
import mmap
import struct
import zlib
from bisect import bisect_right
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

MAGIC = b"PMTiles"
FORMAT_VERSION = 3
HEADER_LEN = 127

COMPRESSION_NONE = 1
COMPRESSION_GZIP = 2
# tile_type ids (spec §3); mivnav.features.satellite's raster archives use
# COMPRESSION_NONE since re-gzipping JPEG/PNG only grows it. Reader is
# format-agnostic — these exist only so serving picks a Content-Type.
TILE_TYPE_MVT = 1
TILE_TYPE_PNG = 2
TILE_TYPE_JPEG = 3
TILE_TYPE_WEBP = 4


class PMTilesError(Exception):
    """Structurally invalid or unsupported PMTiles archive."""


def tile_id(z: int, x: int, y: int) -> int:
    """Hilbert-curve tile id per the PMTiles spec.

    Port of chartcore's ``tile_id``; coordinates legitimately go negative and
    Python's bitwise ops on negatives are two's-complement, matching Rust.
    """
    base = ((1 << (2 * z)) - 1) // 3  # sum of 4^i, i < z
    tx, ty = x, y
    d = 0
    for a in range(z - 1, -1, -1):
        s = 1 << a
        rx = tx & s
        ry = ty & s
        d += ((3 * rx) ^ ry) << a
        if ry == 0:
            if rx != 0:
                tx = s - 1 - tx
                ty = s - 1 - ty
            tx, ty = ty, tx
    return base + d


def zoom_base(z: int) -> int:
    """The first tile id at zoom ``z`` (``sum(4^i for i < z)``)."""
    return ((1 << (2 * z)) - 1) // 3


def tile_id_to_zxy(tid: int) -> tuple[int, int, int]:
    """Inverse of :func:`tile_id` (PMTiles spec ``tileIdToZxy``)."""
    z = 0
    while zoom_base(z + 1) <= tid:
        z += 1
    pos = tid - zoom_base(z)
    x = y = 0
    s = 1
    while s < (1 << z):
        rx = 1 & (pos // 2)
        ry = 1 & (pos ^ rx)
        if ry == 0:
            if rx == 1:
                x = s - 1 - x
                y = s - 1 - y
            x, y = y, x
        x += s * rx
        y += s * ry
        pos //= 4
        s *= 2
    return z, x, y


def decompress(compression: int, data: bytes) -> bytes:
    """Decompress a section per a PMTiles compression id."""
    if compression == COMPRESSION_NONE:
        return data
    if compression == COMPRESSION_GZIP:
        # gzip.decompress raises BadGzipFile (an OSError) for header
        # damage, EOFError for truncation and zlib.error for a corrupt
        # deflate stream — all of them are "corrupt archive" to callers
        try:
            return gzip.decompress(data)
        except (OSError, EOFError, zlib.error) as e:
            raise PMTilesError(f"bad gzip stream: {e}") from e
    raise PMTilesError(f"unsupported compression {compression}")


def _read_varint(data: bytes, pos: int) -> tuple[int, int]:
    result = 0
    shift = 0
    while pos < len(data):
        b = data[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not b & 0x80:
            return result, pos
        shift += 7
    raise PMTilesError("truncated varint")


# One directory as parallel arrays for bisect: ids plus (offset, length,
# run_length) tuples. run_length 0 marks a leaf-directory pointer.
_Directory = tuple[list[int], list[tuple[int, int, int]]]


def _parse_directory(data: bytes) -> _Directory:
    pos = 0
    count, pos = _read_varint(data, pos)
    ids: list[int] = []
    tid = 0
    for _ in range(count):
        delta, pos = _read_varint(data, pos)
        tid += delta
        ids.append(tid)
    run_lengths = []
    for _ in range(count):
        v, pos = _read_varint(data, pos)
        run_lengths.append(v)
    lengths = []
    for _ in range(count):
        v, pos = _read_varint(data, pos)
        lengths.append(v)
    entries: list[tuple[int, int, int]] = []
    prev_end: int | None = None
    for i in range(count):
        v, pos = _read_varint(data, pos)
        if v == 0:
            if prev_end is None:
                raise PMTilesError("varint-0 offset on first entry")
            offset = prev_end
        else:
            offset = v - 1
        prev_end = offset + lengths[i]
        entries.append((offset, lengths[i], run_lengths[i]))
    if pos != len(data):
        raise PMTilesError("trailing bytes after directory")
    return ids, entries


@dataclass(frozen=True)
class Header:
    root_offset: int
    root_length: int
    metadata_offset: int
    metadata_length: int
    leaf_offset: int
    leaf_length: int
    data_offset: int
    data_length: int
    addressed_tiles: int
    tile_entries: int
    tile_contents: int
    clustered: bool
    internal_compression: int
    tile_compression: int
    tile_type: int
    min_zoom: int
    max_zoom: int
    bounds: tuple[float, float, float, float]  # min lon, min lat, max lon, max lat
    center_zoom: int
    center: tuple[float, float]  # lon, lat


def _parse_header(buf: bytes) -> Header:
    if len(buf) < HEADER_LEN or buf[:7] != MAGIC:
        raise PMTilesError("bad magic or truncated header")
    if buf[7] != FORMAT_VERSION:
        raise PMTilesError(f"unsupported version {buf[7]}")
    u64s = struct.unpack_from("<11Q", buf, 8)
    e7 = struct.unpack_from("<4i", buf, 102)
    center = struct.unpack_from("<2i", buf, 119)
    return Header(
        root_offset=u64s[0],
        root_length=u64s[1],
        metadata_offset=u64s[2],
        metadata_length=u64s[3],
        leaf_offset=u64s[4],
        leaf_length=u64s[5],
        data_offset=u64s[6],
        data_length=u64s[7],
        addressed_tiles=u64s[8],
        tile_entries=u64s[9],
        tile_contents=u64s[10],
        clustered=buf[96] == 1,
        internal_compression=buf[97],
        tile_compression=buf[98],
        tile_type=buf[99],
        min_zoom=buf[100],
        max_zoom=buf[101],
        bounds=tuple(v / 1e7 for v in e7),
        center_zoom=buf[118],
        center=tuple(v / 1e7 for v in center),
    )


def parse_header(buf: bytes) -> Header:
    """Decode logic shared with a caller that fetches the same ``HEADER_LEN``
    bytes via HTTP range GET instead of mmap (see
    ``mivnav.features.osm_world.live``'s ``RemoteArchive``)."""
    return _parse_header(buf)


def parse_directory(data: bytes) -> _Directory:
    """Directory-decode logic for a remote reader that fetched the bytes
    over HTTP, per :func:`parse_header`."""
    return _parse_directory(data)


class Archive:
    """A read-only, mmapped PMTiles v3 archive."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._file = open(path, "rb")
        try:
            self._mm = mmap.mmap(self._file.fileno(), 0, access=mmap.ACCESS_READ)
        except (ValueError, OSError) as e:  # empty file, etc.
            self._file.close()
            raise PMTilesError(f"cannot map {path}: {e}") from e
        # cleanup must not depend on the exception type: any failure here
        # (not just PMTilesError) would otherwise leak the mmap + fd
        try:
            self.header = _parse_header(self._mm[:HEADER_LEN])
            self._root = self._directory(
                self.header.root_offset, self.header.root_length
            )
        except BaseException:
            self.close()
            raise

    def close(self) -> None:
        self._mm.close()
        self._file.close()

    def _section(self, offset: int, length: int) -> bytes:
        end = offset + length
        if end > len(self._mm):
            raise PMTilesError("section out of bounds")
        return self._mm[offset:end]

    def _directory(self, offset: int, length: int) -> _Directory:
        raw = self._section(offset, length)
        return _parse_directory(decompress(self.header.internal_compression, raw))

    def metadata(self) -> dict:
        """The archive's JSON metadata, parsed."""
        raw = self._section(self.header.metadata_offset, self.header.metadata_length)
        return json.loads(decompress(self.header.internal_compression, raw))

    def tile_data(self, z: int, x: int, y: int) -> bytes | None:
        """The *stored* bytes of one tile (compressed per
        ``header.tile_compression``), or None if the archive has no tile at
        that address."""
        target = tile_id(z, x, y)
        ids, entries = self._root
        for _ in range(2):  # at most one level of leaf directories, per spec
            i = bisect_right(ids, target) - 1
            if i < 0:
                return None
            eid = ids[i]
            offset, length, run_length = entries[i]
            if run_length == 0:  # leaf-directory pointer
                ids, entries = self._directory(
                    self.header.leaf_offset + offset, length
                )
                continue
            if target < eid + run_length:
                return self._section(self.header.data_offset + offset, length)
            return None
        raise PMTilesError("leaf directory nesting too deep")

    def tiles_at_zoom(self, z: int) -> Iterator[tuple[int, int, bytes]]:
        """``(x, y, stored bytes)`` of every tile the archive holds at zoom
        ``z`` (in no particular order), by walking the directories (one level of
        leaves, per spec) — leaves wholly outside the zoom's id range are
        never read. A run-length entry yields each tile of its run."""
        lo, hi = zoom_base(z), zoom_base(z + 1)
        for depth_ids, depth_entries in self._walk(self._root, lo, hi, 0):
            for tid, (offset, length, run) in zip(depth_ids, depth_entries):
                data = self._section(self.header.data_offset + offset, length)
                for t in range(max(tid, lo), min(tid + run, hi)):
                    _z, x, y = tile_id_to_zxy(t)
                    yield x, y, data

    def _walk(
        self, directory: _Directory, lo: int, hi: int, depth: int
    ) -> Iterator[_Directory]:
        ids, entries = directory
        tiles: _Directory = ([], [])
        for i, (tid, entry) in enumerate(zip(ids, entries)):
            end = ids[i + 1] if i + 1 < len(ids) else None
            if entry[2] == 0:  # leaf-directory pointer covering [tid, end)
                if tid >= hi or (end is not None and end <= lo):
                    continue
                if depth >= 1:
                    raise PMTilesError("leaf directory nesting too deep")
                yield from self._walk(
                    self._directory(self.header.leaf_offset + entry[0], entry[1]),
                    lo, hi, depth + 1,
                )
            elif tid < hi and tid + entry[2] > lo:
                tiles[0].append(tid)
                tiles[1].append(entry)
        yield tiles
