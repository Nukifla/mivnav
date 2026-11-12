# SPDX-License-Identifier: GPL-2.0-only
"""Minimal MVT (Mapbox Vector Tile) reader: ONE named layer's point features.

Duplicates chartcore's decoder deliberately: chartcore decodes every layer's
tags with no geometry, while this skips non-matching layers unread to make
whole-planet scans affordable. See docs/architecture/mvt-point-reader.md for
the wire-format details and why.
"""

from __future__ import annotations

import math
import struct
from collections.abc import Iterator

# Wire types (protobuf): 0 varint, 1 fixed64, 2 length-delimited, 5 fixed32.
_WIRE_VARINT = 0
_WIRE_FIXED64 = 1
_WIRE_BYTES = 2
_WIRE_FIXED32 = 5

#: MVT geometry type id for a point (spec §4.3.4).
_GEOM_POINT = 1

#: Geometry-command id for MoveTo (spec §4.3.3) — the only command a point
#: feature's stream starts with.
_CMD_MOVE_TO = 1


class MVTError(Exception):
    """Structurally invalid or unsupported vector-tile bytes."""


def _varint(buf: bytes, pos: int) -> tuple[int, int]:
    result = 0
    shift = 0
    n = len(buf)
    while True:
        if pos >= n:
            raise MVTError("truncated varint")
        byte = buf[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, pos
        shift += 7
        if shift > 63:
            raise MVTError("varint too long")


def _zigzag(value: int) -> int:
    return (value >> 1) ^ -(value & 1)


def _skip(buf: bytes, pos: int, wire: int) -> int:
    """Advance past one field's value — how an unknown/unwanted field (an
    entire ``landcover`` layer, say) costs a length read and nothing more."""
    if wire == _WIRE_VARINT:
        _, pos = _varint(buf, pos)
        return pos
    if wire == _WIRE_FIXED64:
        return pos + 8
    if wire == _WIRE_BYTES:
        length, pos = _varint(buf, pos)
        return pos + length
    if wire == _WIRE_FIXED32:
        return pos + 4
    raise MVTError(f"unsupported wire type {wire}")


def _bytes_field(buf: bytes, pos: int) -> tuple[bytes, int]:
    length, pos = _varint(buf, pos)
    end = pos + length
    if end > len(buf):
        raise MVTError("truncated length-delimited field")
    return buf[pos:end], end


def _layer_name(layer: bytes) -> str | None:
    """A layer's ``name`` (field 1) without decoding anything else — the peek
    that decides whether the rest of these bytes are worth looking at."""
    pos = 0
    while pos < len(layer):
        key, pos = _varint(layer, pos)
        field, wire = key >> 3, key & 0x7
        if field == 1 and wire == _WIRE_BYTES:
            raw, _ = _bytes_field(layer, pos)
            return raw.decode("utf-8", "replace")
        pos = _skip(layer, pos, wire)
    return None


def _layers(tile: bytes, name: str) -> Iterator[bytes]:
    """The raw bytes of every layer called ``name`` (normally zero or one)."""
    pos = 0
    while pos < len(tile):
        key, pos = _varint(tile, pos)
        field, wire = key >> 3, key & 0x7
        if field == 3 and wire == _WIRE_BYTES:
            layer, pos = _bytes_field(tile, pos)
            if _layer_name(layer) == name:
                yield layer
        else:
            pos = _skip(tile, pos, wire)


def _value(raw: bytes) -> object:
    """One entry of a layer's ``values`` table (spec §4.4) — the first field
    present picks the type."""
    pos = 0
    key, pos = _varint(raw, pos)
    field, _wire = key >> 3, key & 0x7
    if field == 1:  # string
        data, _ = _bytes_field(raw, pos)
        return data.decode("utf-8", "replace")
    if field == 2:  # float
        return struct.unpack_from("<f", raw, pos)[0]
    if field == 3:  # double
        return struct.unpack_from("<d", raw, pos)[0]
    if field in (4, 5):  # int64 / uint64
        return _varint(raw, pos)[0]
    if field == 6:  # sint64
        return _zigzag(_varint(raw, pos)[0])
    if field == 7:  # bool
        return bool(_varint(raw, pos)[0])
    raise MVTError(f"unsupported value field {field}")


def _tile_to_lonlat(z: int, x: int, y: int, gx: float, gy: float, extent: int) -> tuple[float, float]:
    """Tile-local geometry units → WGS84 degrees (the standard Web-Mercator
    inverse; ``mivnav.charts.pmtiles`` addresses tiles in the same XYZ scheme
    this assumes)."""
    scale = 1 << z
    lon = (x + gx / extent) / scale * 360.0 - 180.0
    ty = 1 - 2 * (y + gy / extent) / scale
    lat = math.degrees(math.atan(math.sinh(math.pi * ty)))
    return lon, lat


def _first_point(geometry: list[int]) -> tuple[int, int] | None:
    """The first MoveTo target of a geometry command stream, in tile units.

    A point feature may legally carry a multipoint (one MoveTo with a repeat
    count); only its first vertex is taken — a label anchor is one place, and
    the consumer here deduplicates by coordinate anyway.
    """
    if len(geometry) < 3:
        return None
    command = geometry[0]
    if command & 0x7 != _CMD_MOVE_TO:
        return None
    return _zigzag(geometry[1]), _zigzag(geometry[2])


def point_features(
    tile: bytes, layer: str, z: int, x: int, y: int
) -> list[tuple[float, float, dict]]:
    """``(lon, lat, tags)`` for every POINT feature of ``layer`` in ``tile``.

    ``tile`` is DECOMPRESSED tile bytes (PMTiles stores them gzipped — see
    :func:`mivnav.charts.pmtiles.decompress`); ``z``/``x``/``y`` are the
    tile's own address, needed to turn tile-local geometry into degrees.
    Empty when the tile has no such layer. Non-point features (and points
    whose geometry does not start with a MoveTo) are skipped silently: this
    is a label harvester, not a general reader.
    """
    out: list[tuple[float, float, dict]] = []
    for raw_layer in _layers(tile, layer):
        keys: list[str] = []
        values: list[object] = []
        features: list[bytes] = []
        extent = 4096
        pos = 0
        while pos < len(raw_layer):
            key, pos = _varint(raw_layer, pos)
            field, wire = key >> 3, key & 0x7
            if field == 2 and wire == _WIRE_BYTES:
                data, pos = _bytes_field(raw_layer, pos)
                features.append(data)
            elif field == 3 and wire == _WIRE_BYTES:
                data, pos = _bytes_field(raw_layer, pos)
                keys.append(data.decode("utf-8", "replace"))
            elif field == 4 and wire == _WIRE_BYTES:
                data, pos = _bytes_field(raw_layer, pos)
                values.append(_value(data))
            elif field == 5 and wire == _WIRE_VARINT:
                extent, pos = _varint(raw_layer, pos)
            else:
                pos = _skip(raw_layer, pos, wire)
        if extent <= 0:
            raise MVTError("layer extent must be positive")
        for raw_feature in features:
            tags: list[int] = []
            geometry: list[int] = []
            geom_type = 0
            pos = 0
            while pos < len(raw_feature):
                key, pos = _varint(raw_feature, pos)
                field, wire = key >> 3, key & 0x7
                if field == 2 and wire == _WIRE_BYTES:
                    data, pos = _bytes_field(raw_feature, pos)
                    tags = _packed(data)
                elif field == 3 and wire == _WIRE_VARINT:
                    geom_type, pos = _varint(raw_feature, pos)
                elif field == 4 and wire == _WIRE_BYTES:
                    data, pos = _bytes_field(raw_feature, pos)
                    geometry = _packed(data)
                else:
                    pos = _skip(raw_feature, pos, wire)
            if geom_type != _GEOM_POINT:
                continue
            point = _first_point(geometry)
            if point is None:
                continue
            props: dict = {}
            for i in range(0, len(tags) - 1, 2):
                ki, vi = tags[i], tags[i + 1]
                if ki < len(keys) and vi < len(values):
                    props[keys[ki]] = values[vi]
            lon, lat = _tile_to_lonlat(z, x, y, point[0], point[1], extent)
            out.append((lon, lat, props))
    return out


def _packed(data: bytes) -> list[int]:
    """A packed-repeated varint field (a feature's tags or geometry)."""
    out: list[int] = []
    pos = 0
    while pos < len(data):
        value, pos = _varint(data, pos)
        out.append(value)
    return out
