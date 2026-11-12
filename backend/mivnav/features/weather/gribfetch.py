# SPDX-License-Identifier: GPL-2.0-only
"""DWD/ICON opendata GRIB catalog — the small, fixed set of products the
weather GRIB bake fetches directly. See docs/architecture/gribfetch.md for
why both products decode with plain ``RegularGrid`` and why step
availability is always discovered from the listing, never assumed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone


@dataclass(frozen=True)
class GribProduct:
    id: str
    label: str
    #: e.g. ``"https://opendata.dwd.de/weather/nwp/icon-eu/grib"`` — a run's
    #: files live at ``{base_url}/{run_hour:02d}/{dir_u or dir_v}/``.
    base_url: str
    #: UTC hours a run may start at, e.g. ``(0, 3, 6, ..., 21)``.
    run_hours: tuple[int, ...]
    dir_u: str
    dir_v: str
    #: Matches ONLY the regular-lat-lon filename shape, capturing run
    #: (YYYYMMDDHH) and lead-time step in hours.
    filename_re: re.Pattern[str]


PRODUCTS: dict[str, GribProduct] = {
    "dwd_icon_eu": GribProduct(
        id="dwd_icon_eu",
        label="DWD ICON-EU (~7 km, Europe, to +120 h)",
        base_url="https://opendata.dwd.de/weather/nwp/icon-eu/grib",
        run_hours=(0, 3, 6, 9, 12, 15, 18, 21),
        dir_u="u_10m",
        dir_v="v_10m",
        # See docs/architecture/gribfetch.md for why the parameter suffix
        # needs [A-Za-z0-9_]+ (not just alnum) and .bz2 is optional.
        filename_re=re.compile(
            r"icon-eu_europe_regular-lat-lon_single-level_"
            r"(?P<run>\d{10})_(?P<step>\d{3})_[A-Za-z0-9_]+\.grib2(\.bz2)?"
        ),
    ),
    "dwd_icon_d2": GribProduct(
        id="dwd_icon_d2",
        label="DWD ICON-D2 (~2.2 km, central Europe, to +48 h)",
        base_url="https://opendata.dwd.de/weather/nwp/icon-d2/grib",
        run_hours=(0, 3, 6, 9, 12, 15, 18, 21),
        dir_u="u_10m",
        dir_v="v_10m",
        filename_re=re.compile(
            r"icon-d2_germany_regular-lat-lon_single-level_"
            r"(?P<run>\d{10})_(?P<step>\d{3})_2d_[a-z0-9_]+\.grib2(\.bz2)?"
        ),
    ),
}


def product_for(product_id: str) -> GribProduct:
    product = PRODUCTS.get(product_id)
    if product is None:
        raise KeyError(
            f"unknown GRIB product {product_id!r} — known products: "
            f"{', '.join(sorted(PRODUCTS))}"
        )
    return product


@dataclass(frozen=True)
class ListedFile:
    filename: str
    run: str  # YYYYMMDDHH, UTC — verbatim from the filename, DWD's own convention
    step: int  # lead-time hours past `run`


def parse_listing(html: str, pattern: re.Pattern[str]) -> list[ListedFile]:
    """Every regular-lat-lon file `pattern` matches in one DWD Apache
    autoindex HTML page. Pure — no I/O — so testable against a captured
    fixture page without a network fixture."""
    return [
        ListedFile(filename=m.group(0), run=m.group("run"), step=int(m.group("step")))
        for m in pattern.finditer(html)
    ]


def run_reference_time(run: str) -> datetime:
    """``run`` (``YYYYMMDDHH``, DWD's filename convention) as a UTC
    ``datetime`` — parsed straight from the filename, not from decoded GRIB
    metadata (see docs/architecture/gribstore.md for why that needs
    correction and shouldn't be trusted here anyway)."""
    return datetime.strptime(run, "%Y%m%d%H").replace(tzinfo=timezone.utc)


def candidate_runs(product: GribProduct, now: datetime, max_back: int = 8) -> list[datetime]:
    """Every run start time this product could plausibly have already
    published, most recent first. ``max_back`` bounds how far back to look
    (8 covers a full day at 3-hourly cadence, past DWD's observed ~2h45m
    publish latency for even the slowest product)."""
    now = now.astimezone(timezone.utc)
    ordered_hours = sorted(product.run_hours, reverse=True)
    # The most recent run hour <= now's hour, on today's date; then walk
    # backward through every (date, hour) combination in schedule order.
    candidates: list[datetime] = []
    day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    while len(candidates) < max_back:
        for h in ordered_hours:
            t = day.replace(hour=h)
            if t <= now:
                candidates.append(t)
            if len(candidates) >= max_back:
                break
        day -= timedelta(days=1)
    return candidates[:max_back]


def steps_for_bake(available_steps: list[int], *, max_forecast_hours: int | None) -> list[int]:
    """Which of a run's ``available_steps`` a bake should fetch. Unlike
    ``.om``'s ``max_forecast_hours``, ``None`` here means "everything this
    run published" — safe to leave uncapped since a product's own forecast
    horizon already bounds the total. See docs/architecture/gribfetch.md."""
    if max_forecast_hours is None:
        return list(available_steps)
    return [s for s in available_steps if s <= max_forecast_hours]
