# SPDX-License-Identifier: GPL-2.0-only
"""``GribStore`` — the serve-time index over one weather dataset's baked
GRIB files. See docs/architecture/gribstore.md for the two-directory
identity model and the local-timezone correction ``_to_utc`` applies.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import gribberish

from mivnav.features.weather import gribfetch
from mivnav.features.weather import grid as G

#: Only wind @ 10 m is served (v1). Anything else in `manual/` is silently
#: skipped, not an error — a sailor's file may carry fields we don't render yet.
_LEVEL_10M = "specific height level above ground"
_ABBREV_TO_COMPONENT = {"UGRD": "u10", "VGRD": "v10"}


@dataclass(frozen=True)
class _Entry:
    path: Path
    component: str  # "u10" | "v10"
    valid_time: datetime  # UTC


def _component_for(var_abbrev: str, level_type: str, level_value: float | None) -> str | None:
    if level_type != _LEVEL_10M or level_value != 10.0:
        return None
    return _ABBREV_TO_COMPONENT.get(var_abbrev)


def _local_utc_offset() -> timedelta:
    """Recomputed per call, not cached at import time, so a DST transition
    mid-process can't leave a stale offset."""
    local = datetime.now()
    utc = datetime.now(timezone.utc).replace(tzinfo=None)
    return local - utc


def _to_utc(naive_local: datetime) -> datetime:
    """Local-timezone ``naive_local`` corrected to UTC, rounded to the
    nearest MINUTE — without rounding, ``resolve_uv``'s exact-equality dict
    lookup almost never matches (a real bug; see docs/architecture/gribstore.md)."""
    # attach tzinfo BEFORE .timestamp() — a naive datetime assumes LOCAL time
    corrected = (naive_local - _local_utc_offset()).replace(tzinfo=timezone.utc)
    epoch = corrected.timestamp()
    rounded = round(epoch / 60) * 60
    return datetime.fromtimestamp(rounded, tz=timezone.utc)


def grid_from_metadata(meta) -> dict:
    """A ``GridFactory``-ready dict, built from the message's OWN
    grid-description fields — never a hand-maintained catalog (unlike
    ``.om``'s ``domains.py``, which describes Open-Meteo's own regridding)."""
    if not meta.is_regular_grid:
        raise ValueError(
            f"{meta.var_abbrev} is not on a regular lat/lon grid — "
            "only DWD's regular-lat-lon products are supported"
        )
    lat, lon = meta.latlng()
    ny, nx = meta.grid_shape
    if nx < 2 or ny < 2:
        raise ValueError(f"grid too small to be a real forecast grid: {meta.grid_shape}")
    return {
        "type": "regular",
        "nx": int(nx),
        "ny": int(ny),
        # dx/dy measured near the grid's own origin — always inside the
        # RAW (un-normalised) longitude sequence, so this is unaffected by
        # the 0/360 wrap normalize_lon() below folds away.
        "dx": float(lon[1] - lon[0]),
        "dy": float(lat[1] - lat[0]),
        "lonMin": float(G.normalize_lon(float(lon[0]))),
        "latMin": float(lat[0]),
    }


class GribStore:
    """Resolves wind u/v valid-time queries against one dataset's
    ``grib/<product>/`` + ``grib/manual/`` directories. Built fresh per
    request from ``Config.datasets`` (cheap — no I/O until a method is
    actually called), same posture as
    :class:`~mivnav.features.weather.mirror.WeatherMirror`."""

    def __init__(self, dataset_dir: Path, product_id: str) -> None:
        self._product = gribfetch.product_for(product_id)
        self._product_dir = dataset_dir / "grib" / product_id
        self._manual_dir = dataset_dir / "grib" / "manual"

    @property
    def product_id(self) -> str:
        return self._product.id

    def _fetched_entries(self) -> Iterator[_Entry]:
        for dirname, component in (
            (self._product.dir_u, "u10"),
            (self._product.dir_v, "v10"),
        ):
            d = self._product_dir / dirname
            if not d.is_dir():
                continue
            for f in sorted(d.glob("*.grib2")):
                m = self._product.filename_re.match(f.name)
                if not m:
                    continue
                ref = gribfetch.run_reference_time(m.group("run"))
                valid = ref + timedelta(hours=int(m.group("step")))
                yield _Entry(f, component, valid)

    def _manual_entries(self) -> Iterator[_Entry]:
        if not self._manual_dir.is_dir():
            return
        for f in sorted(self._manual_dir.glob("*.grib2")):
            try:
                data = f.read_bytes()
                meta = gribberish.parse_grib_message_metadata(data, 0)
            except Exception:  # noqa: BLE001 — an unreadable/foreign file is skipped, not fatal
                continue
            component = _component_for(meta.var_abbrev, meta.level_type, meta.level_value)
            if component is None:
                continue
            yield _Entry(f, component, _to_utc(meta.forecast_date))

    def _entries(self) -> Iterator[_Entry]:
        yield from self._fetched_entries()
        yield from self._manual_entries()

    def resolve_uv(self, valid_time: datetime) -> tuple[Path, Path] | None:
        """``(u_path, v_path)`` for ``valid_time`` (UTC), or ``None`` if
        either component is missing. A ``manual/`` file wins a collision
        against a fetched one at the same valid time (checked second)."""
        by_time: dict[datetime, dict[str, Path]] = {}
        for entry in self._entries():
            by_time.setdefault(entry.valid_time, {})[entry.component] = entry.path
        found = by_time.get(valid_time)
        if not found or "u10" not in found or "v10" not in found:
            return None
        return found["u10"], found["v10"]

    def valid_times(self) -> list[datetime]:
        """Every valid time (UTC) with BOTH wind components present, sorted
        ascending — exactly the times :meth:`resolve_uv` will answer for.
        Empty for a dataset/product with nothing baked yet."""
        by_time: dict[datetime, set[str]] = {}
        for entry in self._entries():
            by_time.setdefault(entry.valid_time, set()).add(entry.component)
        return sorted(t for t, comps in by_time.items() if {"u10", "v10"} <= comps)

    def grid_definition(self) -> dict:
        """The product's grid, read from whichever on-disk file comes
        first — every file for one product shares the same grid, so this
        only ever needs to decode one message's header."""
        for entry in self._entries():
            data = entry.path.read_bytes()
            meta = gribberish.parse_grib_message_metadata(data, 0)
            return grid_from_metadata(meta)
        raise FileNotFoundError(
            f"no GRIB files found for product {self._product.id!r} in "
            f"{self._product_dir} (or its manual/ sibling)"
        )
