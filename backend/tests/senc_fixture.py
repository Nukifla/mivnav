# SPDX-License-Identifier: GPL-2.0-only
"""Minimal plain-OSENC (.senc) writer for backend tests.

Python port of the framing used by chartcore's osenc::write test
synthesizer (in turn from ochartsng's tools/senc/senc.py, GPLv2): little
endian, ``u16 record_type; u32 record_length`` where the length includes
the 6-byte header. Enough to synthesize point-feature cells that flow
through the full serving path (key resolution → decode → derive → tile
cut → HTTP) without credentials or a daemon.
"""

from __future__ import annotations

import struct
from pathlib import Path

SENC_VERSION = 201

# S-57 object class codes (standard catalogue)
OBJ_LIGHTS = 75
OBJ_LNDARE = 71
OBJ_LNDMRK = 74
OBJ_BOYLAT = 17
OBJ_TOPMAR = 144

# S-57 attribute codes (standard catalogue)
ATT_COLOUR = 75
ATT_OBJNAM = 116
ATT_VALNMR = 178
ATT_TOPSHP = 171

# A nominal range that makes a LIGHTS point a major all-round ring (VALNMR >= 10).
# The VALNMR-derived SCAMIN gate now applies to *all* light forms, rings included
# (chartcore derive::lights): a light's effective scamin is min(charted, 60000*V),
# so VALNMR=20 gates at 1200000, which would drop the probe at z8 and coarser
# (scale_denom there is >= 1200000) and keep it through z10-z12 (scale_denom
# < 1200000). That gate is only *computed* independent of S-52 — chartcore's
# final derive::scamin pass, which turns a feature's computed scamin into the
# tile's declutter tag, needs S-52 lookup data to resolve exemption and is a
# no-op without it (see scamin_needs_lookup_data in chartcore's derive tests).
# ocharts_env-based tests configure no S-52 data, so a LIGHTS probe there is
# never actually SCAMIN-dropped — the cell-*selection* tests that must survive
# to the coarsest zooms use a named, non-light LNDMRK probe instead (see
# test_ocharts_serving._cell_with_landmark), and the one test that exercises
# the SCAMIN drop itself loads a minimal S-52 LIGHTS lookup just for that case.
PROBE_VALNMR = 20.0


# OSENC coverage records (see chartcore::osenc): u32 count, then
# (f32 lat, f32 lon) pairs, closed ring.
REC_CELL_COVR = 98
REC_CELL_NOCOVR = 99


class SencWriter:
    def __init__(self) -> None:
        self.buf = bytearray()

    def record(self, rtype: int, payload: bytes) -> "SencWriter":
        self.buf += struct.pack("<HI", rtype, 6 + len(payload)) + payload
        return self

    def version(self, v: int = SENC_VERSION) -> "SencWriter":
        return self.record(1, struct.pack("<H", v))

    def cell_name(self, name: str) -> "SencWriter":
        return self.record(2, name.encode())

    def cell_edition(self, e: int) -> "SencWriter":
        return self.record(4, struct.pack("<H", e))

    def native_scale(self, s: int) -> "SencWriter":
        return self.record(7, struct.pack("<I", s))

    def extent(self, w: float, s: float, e: float, n: float) -> "SencWriter":
        # sw, nw, ne, se corners as (lat, lon) doubles
        payload = struct.pack("<8d", s, w, n, w, n, e, s, e)
        return self.record(100, payload)

    def server_status(
        self, decrypt: int = 1, expire: int = 1, expire_days: int = 365
    ) -> "SencWriter":
        return self.record(200, struct.pack("<6H", 1, decrypt, expire, expire_days, 0, 0))

    def feature(self, type_code: int, feature_id: int, primitive: int = 1) -> "SencWriter":
        return self.record(64, struct.pack("<HHB", type_code, feature_id, primitive))

    def attr_str(self, code: int, value: str) -> "SencWriter":
        # value type 4 = NUL-terminated string (list attrs arrive this way)
        return self.record(65, struct.pack("<HB", code, 4) + value.encode() + b"\0")

    def attr_float(self, code: int, value: float) -> "SencWriter":
        # value type 2 = f64
        return self.record(65, struct.pack("<HBd", code, 2, value))

    def coverage_ring(self, rtype: int, ring: list[tuple[float, float]]) -> "SencWriter":
        """A CELL_COVR/CELL_NOCOVR ring: u32 count then (f32 lat, f32 lon)."""
        payload = struct.pack("<I", len(ring))
        for lat, lon in ring:
            payload += struct.pack("<2f", lat, lon)
        return self.record(rtype, payload)

    def covr_box(self, w: float, s: float, e: float, n: float) -> "SencWriter":
        """CELL_COVR over a lat/lon box (closed ring)."""
        return self.coverage_ring(
            REC_CELL_COVR, [(s, w), (n, w), (n, e), (s, e), (s, w)]
        )

    def point(self, lat: float, lon: float) -> "SencWriter":
        return self.record(80, struct.pack("<2d", lat, lon))

    def write(self, path: Path) -> Path:
        path.write_bytes(bytes(self.buf))
        return path


def point_cell(
    path: Path,
    name: str = "OC-TEST-1",
    scale: int = 12000,
    bounds: tuple[float, float, float, float] = (11.0, 54.0, 11.2, 54.2),
    lights: int = 3,
    covr: tuple[float, float, float, float] | None = None,
) -> Path:
    """A valid cell with `lights` LIGHTS point features spread over bounds.

    `covr` adds a CELL_COVR ring (defaults to none, i.e. a cell that
    declares no coverage and falls back to its extent).
    """
    w, s, e, n = bounds
    sw = SencWriter().version().cell_name(name).cell_edition(1).native_scale(scale)
    sw.extent(w, s, e, n)
    if covr is not None:
        sw.covr_box(*covr)
    for i in range(lights):
        f = (i + 1) / (lights + 1)
        sw.feature(OBJ_LIGHTS, i + 1).attr_float(ATT_VALNMR, PROBE_VALNMR)
        sw.point(s + (n - s) * f, w + (e - w) * f)
    return sw.write(path)


def aton_cell(
    path: Path,
    name: str = "OC-ATON-1",
    scale: int = 12000,
    bounds: tuple[float, float, float, float] = (11.0, 54.0, 11.2, 54.2),
) -> Path:
    """A valid cell with one lateral buoy (COLOUR=4, named) at the center,
    for exercising the S-52 ATON symbol resolution in the serving path."""
    w, s, e, n = bounds
    sw = SencWriter().version().cell_name(name).cell_edition(1).native_scale(scale)
    sw.extent(w, s, e, n)
    sw.feature(OBJ_BOYLAT, 1)
    sw.attr_str(ATT_COLOUR, "4").attr_str(ATT_OBJNAM, "No 7")
    sw.point((s + n) / 2, (w + e) / 2)
    return sw.write(path)


def aid_group_cell(
    path: Path,
    name: str = "OC-AIDGRP-1",
    scale: int = 12000,
    bounds: tuple[float, float, float, float] = (11.0, 54.0, 11.2, 54.2),
) -> Path:
    """A lit buoy with a topmark as three *co-located* S-57 objects — a lateral
    buoy, a TOPMAR and a LIGHTS — all at the cell center.

    The plain-OSENC path carries no LNAM/LNAM_REFS, so the chartcore
    ``aid_group`` derive falls back to exact co-location and stamps one shared
    ``aid_group`` id onto all three. Used to prove the tag reaches the served
    tile (the relationship path is covered in chartcore's s57-ingest tests)."""
    w, s, e, n = bounds
    lat, lon = (s + n) / 2, (w + e) / 2
    sw = SencWriter().version().cell_name(name).cell_edition(1).native_scale(scale)
    sw.extent(w, s, e, n)
    # buoy (routed into the ATON layer), its topmark, and its light — one point
    sw.feature(OBJ_BOYLAT, 1).attr_str(ATT_COLOUR, "4").attr_str(ATT_OBJNAM, "No 7")
    sw.point(lat, lon)
    sw.feature(OBJ_TOPMAR, 2).attr_str(ATT_TOPSHP, "2")
    sw.point(lat, lon)
    sw.feature(OBJ_LIGHTS, 3).attr_str(ATT_COLOUR, "4").attr_float(ATT_VALNMR, PROBE_VALNMR)
    sw.point(lat, lon)
    return sw.write(path)
