# SPDX-License-Identifier: GPL-2.0-only
"""A tiny pure-Python MVT 2.1 encoder for ONE layer of POINT features — just
enough to cut a live POI tile per request (a plugin's online POI layer),
and to re-encode a merged union tile (:mod:`.merge`).

chartcore's encoder (``chartcore/src/mvt/encode.rs``) only surfaces to Python
through whole-archive bakes (``build_pmtiles``) and tile *merges*; there is no
single-tile encode export, and points need none of its clipping/simplifying
machinery. Hand-rolled protobuf like the Rust one, no new deps (CLAUDE.md
#GD2). The wire shape mirrors ``encode.rs`` so the two kinds of POI tile
decode alike: extent 4096, layer version 2, ints as ``sint_value`` (zigzag),
strings as ``string_value``, keys/values deduplicated per layer, one
``MoveTo(1)`` per feature, no feature id.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping

__all__ = ["EXTENT", "decode_point_layer", "encode_point_layer"]

#: Tile-local coordinates run 0..EXTENT per tile edge (same as chartcore).
EXTENT = 4096

_WIRE_VARINT = 0
_WIRE_LEN = 2


def _varint(out: bytearray, value: int) -> None:
    while value > 0x7F:
        out.append((value & 0x7F) | 0x80)
        value >>= 7
    out.append(value)


def _key(out: bytearray, field: int, wire: int) -> None:
    _varint(out, (field << 3) | wire)


def _len_field(out: bytearray, field: int, data: bytes | bytearray) -> None:
    _key(out, field, _WIRE_LEN)
    _varint(out, len(data))
    out += data


def _zigzag(value: int) -> int:
    return (value << 1) ^ (value >> 63)


def _encode_value(value: object) -> bytes:
    """One ``Layer.values`` entry. bool before int (bool is an int)."""
    out = bytearray()
    if isinstance(value, bool):
        _key(out, 7, _WIRE_VARINT)
        _varint(out, int(value))
    elif isinstance(value, int):
        _key(out, 6, _WIRE_VARINT)
        _varint(out, _zigzag(value))
    elif isinstance(value, str):
        _len_field(out, 1, value.encode())
    else:
        raise TypeError(f"unsupported MVT tag value {value!r}")
    return bytes(out)


def encode_point_layer(
    layer: str, features: Iterable[tuple[int, int, Mapping[str, object]]]
) -> bytes:
    """Encode ``(x, y, props)`` points — tile-local coords in 0..EXTENT — as a
    one-layer tile. ``props`` values must be ``str``/``int``/``bool``; a
    ``None`` value is skipped (absent, not null). Returns ``b""`` for no
    features (a zero-layer tile is a valid, empty MVT)."""
    keys: dict[str, int] = {}
    values: dict[bytes, int] = {}
    body = bytearray()
    count = 0
    for x, y, props in features:
        tags: list[int] = []
        for k, v in props.items():
            if v is None:
                continue
            ki = keys.setdefault(k, len(keys))
            enc = _encode_value(v)
            vi = values.setdefault(enc, len(values))
            tags += (ki, vi)
        fb = bytearray()
        packed = bytearray()
        for t in tags:
            _varint(packed, t)
        _len_field(fb, 2, packed)  # Feature.tags
        _key(fb, 3, _WIRE_VARINT)  # Feature.type = POINT
        _varint(fb, 1)
        geom = bytearray()
        _varint(geom, (1 & 0x7) | (1 << 3))  # MoveTo, count 1
        _varint(geom, _zigzag(int(x)))
        _varint(geom, _zigzag(int(y)))
        _len_field(fb, 4, geom)  # Feature.geometry
        _len_field(body, 2, fb)  # Layer.features
        count += 1
    if count == 0:
        return b""
    lay = bytearray()
    _key(lay, 15, _WIRE_VARINT)  # Layer.version = 2
    _varint(lay, 2)
    _len_field(lay, 1, layer.encode())  # Layer.name
    lay += body
    for k in keys:
        _len_field(lay, 3, k.encode())  # Layer.keys
    for v in values:
        _len_field(lay, 4, v)  # Layer.values
    _key(lay, 5, _WIRE_VARINT)  # Layer.extent
    _varint(lay, EXTENT)
    out = bytearray()
    _len_field(out, 3, lay)  # Tile.layers
    return bytes(out)


# -- decoding ------------------------------------------------------------------


def _read_varint(buf: bytes, i: int) -> tuple[int, int]:
    shift = result = 0
    while True:
        b = buf[i]
        i += 1
        result |= (b & 0x7F) << shift
        if b < 0x80:
            return result, i
        shift += 7


def _fields(buf: bytes):
    """``(field, wire, value)`` for each field of one message; ``value`` is
    an int (varint/fixed) or a bytes slice (length-delimited)."""
    i, n = 0, len(buf)
    while i < n:
        key, i = _read_varint(buf, i)
        field, wire = key >> 3, key & 7
        if wire == _WIRE_VARINT:
            v, i = _read_varint(buf, i)
        elif wire == _WIRE_LEN:
            ln, i = _read_varint(buf, i)
            v = buf[i : i + ln]
            i += ln
        elif wire == 1:
            v = int.from_bytes(buf[i : i + 8], "little")
            i += 8
        elif wire == 5:
            v = int.from_bytes(buf[i : i + 4], "little")
            i += 4
        else:
            raise ValueError(f"unsupported protobuf wire type {wire}")
        yield field, wire, v


def _decode_value(buf: bytes) -> object:
    import struct

    for field, _wire, v in _fields(buf):
        if field == 1:
            return bytes(v).decode()
        if field == 2:
            return struct.unpack("<f", v.to_bytes(4, "little"))[0]
        if field == 3:
            return struct.unpack("<d", v.to_bytes(8, "little"))[0]
        if field == 4:
            return v - (1 << 64) if v >= 1 << 63 else v
        if field == 5:
            return v
        if field == 6:
            return (v >> 1) ^ -(v & 1)
        if field == 7:
            return bool(v)
    return None


def _packed(buf: bytes) -> list[int]:
    out: list[int] = []
    i, n = 0, len(buf)
    while i < n:
        v, i = _read_varint(buf, i)
        out.append(v)
    return out


def decode_point_layer(tile: bytes, layer: str) -> list[tuple[int, int, dict]] | None:
    """The inverse of :func:`encode_point_layer`, for a baked POI tile:
    ``(x, y, props)`` per feature of ``layer``, or ``None`` when the tile is
    anything else (another layer beside it, a non-point or multi-point
    feature, another extent, a feature id) — the caller then leaves the
    tile untouched. ``b""`` (an empty tile) decodes to ``[]``."""
    raw_layer = None
    for field, _wire, v in _fields(tile):
        if field != 3:
            continue
        if raw_layer is not None:
            return None
        raw_layer = v
    if raw_layer is None:
        return []
    name = None
    extent = 4096
    keys: list[str] = []
    values: list[bytes] = []
    feats: list[bytes] = []
    for field, _wire, v in _fields(raw_layer):
        if field == 1:
            name = bytes(v).decode()
        elif field == 2:
            feats.append(v)
        elif field == 3:
            keys.append(bytes(v).decode())
        elif field == 4:
            values.append(v)
        elif field == 5:
            extent = v
    if name != layer or extent != EXTENT:
        return None
    decoded_values = [_decode_value(v) for v in values]
    out: list[tuple[int, int, dict]] = []
    for fb in feats:
        tags: list[int] = []
        geom: list[int] = []
        ftype = 0
        for field, _wire, v in _fields(fb):
            if field == 1:
                return None
            if field == 2:
                tags = _packed(v)
            elif field == 3:
                ftype = v
            elif field == 4:
                geom = _packed(v)
        if ftype != 1 or len(geom) != 3 or geom[0] != (1 | (1 << 3)):
            return None
        x = (geom[1] >> 1) ^ -(geom[1] & 1)
        y = (geom[2] >> 1) ^ -(geom[2] & 1)
        props = {keys[tags[i]]: decoded_values[tags[i + 1]] for i in range(0, len(tags) - 1, 2)}
        out.append((x, y, props))
    return out
