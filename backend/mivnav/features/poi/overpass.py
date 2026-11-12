# SPDX-License-Identifier: GPL-2.0-only
"""The Overpass fetch — the network half of the POI ingest job (pairs with
the pure, network-free :mod:`mivnav.features.poi.tags`). See
docs/architecture/poi-overpass-fetch.md.
"""

from __future__ import annotations

import email.utils
import logging
import math
import random
import time
from collections.abc import Callable, Sequence

import httpx

from mivnav.features.poi.config import DEFAULT_OVERPASS_URL
from mivnav.features.poi.tags import overpass_selectors
from mivnav.ingest.runner import BBox

log = logging.getLogger(__name__)

# Re-exported from mivnav.features.poi.config (poi.overpass_url) as the
# fetcher's default arg — see docs/architecture/poi-overpass-fetch.md.
__all__ = [
    "DEFAULT_OVERPASS_URL",
    "USER_AGENT",
    "OverpassError",
    "build_query",
    "build_area_query",
    "fetch_from",
    "fetch_pois",
    "fetch_pois_area",
    "split_bbox",
]

OVERPASS_QUERY_TIMEOUT = 180  # server-side, embedded in the query header

# Two kinds of transient failure, retried per server with their own budget —
# see docs/architecture/poi-overpass-fetch.md ("Retries").
#
# "Busy" (429/503/504) is Overpass saying its slots are full. A few seconds
# is not enough to outwait that: measured on the boat's Pi, one tile of a
# "Denmark" bake drew 504 on all 4 attempts of the old 5/10/20 s schedule
# and the whole bake failed. So busy waits long, and gets more attempts.
BUSY_STATUS = frozenset({429, 503, 504})
BUSY_BACKOFF_S = (30.0, 60.0, 120.0, 240.0)  # one entry per retry
#: A server's Retry-After is honoured, but never beyond this.
MAX_RETRY_AFTER_S = 600.0
# Anything else transient (502, a transport error / read timeout) keeps the
# short schedule: those are usually a blip, or a dead server that the next
# one in the list should take over from quickly.
OTHER_BACKOFF_S = (5.0, 10.0, 20.0)
RETRYABLE_STATUS = BUSY_STATUS | {502}
#: Attempts per server for a busy server (the old name, kept for callers).
OVERPASS_RETRIES = len(BUSY_BACKOFF_S) + 1
#: Delays are spread ±20 % so several clients (or tiles) don't retry in step.
JITTER = 0.2

# A bbox fetch is split into a grid of tiles no bigger than this (degrees),
# fetched one after another — see docs/architecture/poi-overpass-fetch.md
# ("Tiling"). Measured: the whole "Denmark 2026" box (13.3 x 3.9 deg) as ONE
# query ran 180 s against the 180 s server timeout, i.e. at the edge of
# Overpass silently truncating it.
TILE_MAX_LON_DEG = 4.0
TILE_MAX_LAT_DEG = 2.0
#: Cap per axis, so a degenerate box (an antimeridian country's -180..180
#: enclosing box on the bbox fallback) stays a bounded number of requests.
TILE_MAX_PER_AXIS = 6

# Mandatory, not politeness: overpass-api.de 406s generic/library User-Agents.
# See docs/architecture/poi-overpass-fetch.md.
USER_AGENT = "mivnav/0.1 (chart plotter; POI ingest; +https://github.com/mivnav)"


class OverpassError(Exception):
    """An Overpass request failed (transport, HTTP status, or bad payload)."""


# BBox = (min_lon, min_lat, max_lon, max_lat). Re-exported, not redefined —
# see docs/architecture/poi-overpass-fetch.md.


def _selector(key: str, value: str | None) -> str:
    return f'["{key}"]' if value is None else f'["{key}"="{value}"]'


def _query(body: str, timeout: int, prelude: str = "") -> str:
    """Wrap a selector ``body`` in the QL header/union/out footer. ``prelude``
    is emitted before the union (used by the area path to bind ``.a``)."""
    return (
        f"[out:json][timeout:{timeout}];\n{prelude}(\n{body}\n);\nout center tags;"
    )


def split_bbox(
    bbox: BBox,
    max_lon_deg: float = TILE_MAX_LON_DEG,
    max_lat_deg: float = TILE_MAX_LAT_DEG,
    max_per_axis: int = TILE_MAX_PER_AXIS,
) -> list[BBox]:
    """``bbox`` as an equal grid of tiles at most ``max_lon_deg`` x
    ``max_lat_deg`` (at most ``max_per_axis`` per axis, which may make a tile
    bigger), row-major from the south-west. A box already within the limits
    comes back as ``[bbox]`` unchanged. Tiles share edges; Overpass bbox
    filters are edge-inclusive, so the caller dedupes by OSM ``(type, id)``."""
    min_lon, min_lat, max_lon, max_lat = bbox
    cols = min(max(1, math.ceil((max_lon - min_lon) / max_lon_deg - 1e-9)), max_per_axis)
    rows = min(max(1, math.ceil((max_lat - min_lat) / max_lat_deg - 1e-9)), max_per_axis)
    if cols == 1 and rows == 1:
        return [bbox]
    dlon = (max_lon - min_lon) / cols
    dlat = (max_lat - min_lat) / rows

    def edge(lo: float, step: float, i: int, n: int, hi: float) -> float:
        return hi if i == n else lo + step * i  # exact outer edges, no float drift

    return [
        (
            edge(min_lon, dlon, c, cols, max_lon),
            edge(min_lat, dlat, r, rows, max_lat),
            edge(min_lon, dlon, c + 1, cols, max_lon),
            edge(min_lat, dlat, r + 1, rows, max_lat),
        )
        for r in range(rows)
        for c in range(cols)
    ]


def build_query(bbox: BBox, timeout: int = OVERPASS_QUERY_TIMEOUT) -> str:
    """Overpass QL for every curated selector within ``bbox``. Uses ``nw``
    (nodes + ways; relations skipped as noisy) and ``out center`` so way
    areas collapse to a single centroid point."""
    min_lon, min_lat, max_lon, max_lat = bbox
    area = f"({min_lat},{min_lon},{max_lat},{max_lon})"
    body = "\n".join(
        f"  nw{_selector(key, value)}{area};" for key, value in overpass_selectors()
    )
    return _query(body, timeout)


def build_area_query(iso: str, timeout: int = OVERPASS_QUERY_TIMEOUT) -> str:
    """Overpass QL for every curated selector within a whole country. Binds
    the real administrative boundary (``ISO3166-1``/``admin_level=2``) as an
    ``area`` so the fetch follows the coastline, not a bounding rectangle."""
    iso = iso.upper()
    prelude = f'area["ISO3166-1"="{iso}"]["admin_level"="2"]->.a;\n'
    body = "\n".join(
        f"  nw{_selector(key, value)}(area.a);" for key, value in overpass_selectors()
    )
    return _query(body, timeout, prelude=prelude)


def _host(url: str) -> str:
    return httpx.URL(url).host or url


def _jitter(delay: float) -> float:
    return delay * random.uniform(1.0 - JITTER, 1.0 + JITTER)


def _retry_after(resp: httpx.Response) -> float | None:
    """A ``Retry-After`` header as seconds (delta-seconds or an HTTP date),
    clamped to ``[1, MAX_RETRY_AFTER_S]``; ``None`` if absent/unparseable."""
    raw = resp.headers.get("retry-after")
    if not raw:
        return None
    raw = raw.strip()
    try:
        secs = float(raw)
    except ValueError:
        try:
            when = email.utils.parsedate_to_datetime(raw)
        except (TypeError, ValueError):
            return None
        if when is None:
            return None
        secs = when.timestamp() - time.time()
    return min(max(secs, 1.0), MAX_RETRY_AFTER_S)


def fetch_pois(
    http: httpx.Client,
    bbox: BBox,
    url: str = DEFAULT_OVERPASS_URL,
    query_timeout: int = OVERPASS_QUERY_TIMEOUT,
    on_retry: Callable[[str], None] | None = None,
    *,
    fallback_urls: Sequence[str] = (),
    on_server: Callable[[str], None] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    jitter: Callable[[float], float] = _jitter,
) -> list[dict]:
    """POST a bbox query and return the raw ``elements`` list. Tried on
    ``url`` first, then on each of ``fallback_urls`` in turn once a server
    has used up its retries (:func:`fetch_from`). Any failure is wrapped in
    :class:`OverpassError` for the job spine. ``on_retry``, if given, is
    called with a log line for each retry and each server switch;
    ``on_server`` with the URL that answered."""
    return fetch_from(
        http,
        build_query(bbox, timeout=query_timeout),
        [url, *fallback_urls],
        on_retry=on_retry,
        on_server=on_server,
        sleep=sleep,
        jitter=jitter,
    )


def fetch_pois_area(
    http: httpx.Client,
    iso: str,
    url: str = DEFAULT_OVERPASS_URL,
    query_timeout: int = OVERPASS_QUERY_TIMEOUT,
    on_retry: Callable[[str], None] | None = None,
    *,
    fallback_urls: Sequence[str] = (),
    on_server: Callable[[str], None] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    jitter: Callable[[float], float] = _jitter,
) -> list[dict]:
    """POST a whole-country (boundary-``area``) query and return the raw
    ``elements`` list — the country-region counterpart of :func:`fetch_pois`,
    same servers, error wrapping and reporting. A server without area data
    (it answers such a query with zero elements, silently) is detected by
    the reply's missing ``timestamp_areas_base`` and counts as failed, so a
    bbox-only fallback can never bake an empty country."""
    return fetch_from(
        http,
        build_area_query(iso, timeout=query_timeout),
        [url, *fallback_urls],
        on_retry=on_retry,
        on_server=on_server,
        sleep=sleep,
        jitter=jitter,
        need_areas=True,
    )


def fetch_from(
    http: httpx.Client,
    query: str,
    urls: Sequence[str],
    *,
    on_retry: Callable[[str], None] | None = None,
    on_server: Callable[[str], None] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    jitter: Callable[[float], float] = _jitter,
    need_areas: bool = False,
) -> list[dict]:
    """Run ``query`` on the first of ``urls`` that answers it, each with its
    own full retry budget (:func:`_post_query`); duplicates are tried once.
    Raises the LAST server's error, naming every server tried."""
    tried: list[str] = []
    errors: list[str] = []
    order = list(dict.fromkeys(u for u in urls if u))
    for i, url in enumerate(order):
        tried.append(url)
        try:
            elements = _post_query(
                http, query, url, sleep=sleep, jitter=jitter,
                on_retry=on_retry, need_areas=need_areas,
            )
        except OverpassError as e:
            errors.append(str(e))
            if i + 1 < len(order):
                msg = f"{e} — trying {_host(order[i + 1])} instead"
                log.warning(msg)
                if on_retry is not None:
                    on_retry(msg)
                continue
            if len(order) > 1:
                raise OverpassError(
                    f"{e} (every Overpass server failed: "
                    f"{', '.join(_host(u) for u in tried)})"
                ) from e
            raise
        if on_server is not None:
            on_server(url)
        return elements
    raise OverpassError("no Overpass server configured")


def _post_query(
    http: httpx.Client,
    query: str,
    url: str,
    sleep: Callable[[float], None] = time.sleep,
    on_retry: Callable[[str], None] | None = None,
    *,
    jitter: Callable[[float], float] = lambda d: d,
    need_areas: bool = False,
) -> list[dict]:
    """POST a prebuilt QL query to ONE server and return its ``elements``
    list, retrying transient failures: busy (``BUSY_STATUS``) on the long
    ``BUSY_BACKOFF_S`` schedule (or the server's ``Retry-After``), anything
    else transient on the short ``OTHER_BACKOFF_S`` one — separate budgets.
    ``sleep``/``jitter`` are injected so tests need not wait real seconds;
    ``on_retry`` fires per retry, not on the final failure."""
    busy_plan, other_plan = BUSY_BACKOFF_S, OTHER_BACKOFF_S
    busy_n = other_n = 0
    host = _host(url)
    while True:
        try:
            # per-request, not left to the caller's client — see USER_AGENT
            resp = http.post(url, data={"data": query}, headers={"User-Agent": USER_AGENT})
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            code = e.response.status_code
            last = OverpassError(f"Overpass returned {code} from {host}")
            if code in BUSY_STATUS and busy_n < len(busy_plan):
                told = _retry_after(e.response)
                delay = told if told is not None else jitter(busy_plan[busy_n])
                busy_n += 1
                what = f"Overpass busy ({code}) at {host}, retry {busy_n}/{len(busy_plan)}"
            elif code in RETRYABLE_STATUS and code not in BUSY_STATUS and other_n < len(other_plan):
                delay = jitter(other_plan[other_n])
                other_n += 1
                what = f"Overpass {code} from {host}, retry {other_n}/{len(other_plan)}"
            else:
                raise last from e
        except httpx.HTTPError as e:
            # transport / connect / read-timeout — transient, worth a retry
            last = OverpassError(f"Overpass request to {host} failed: {e!r}")
            if other_n >= len(other_plan):
                raise last from e
            delay = jitter(other_plan[other_n])
            other_n += 1
            what = (
                f"Overpass transport error at {host} ({e!r}), "
                f"retry {other_n}/{len(other_plan)}"
            )
        else:
            return _elements(resp, host, need_areas)
        msg = f"{what} in {delay:.0f}s"
        log.warning(msg)
        if on_retry is not None:
            on_retry(msg)
        sleep(delay)


def _elements(resp: httpx.Response, host: str, need_areas: bool) -> list[dict]:
    try:
        payload = resp.json()
    except ValueError as e:
        raise OverpassError(f"Overpass returned non-JSON from {host}: {e}") from e
    if not isinstance(payload, dict):
        raise OverpassError(f"Overpass payload from {host} is not an object")
    # A query that hits its [timeout:] or memory limit still comes back
    # HTTP 200, with whatever it had so far in `elements` and the reason
    # in `remark` ("runtime error: Query timed out ..."). Returning those
    # elements would bake a silently truncated set.
    remark = payload.get("remark")
    if isinstance(remark, str) and "runtime error" in remark:
        raise OverpassError(f"Overpass aborted the query ({host}): {remark.strip()}")
    if need_areas:
        # A server without area data answers an area query with zero
        # elements and no error; its reply then lacks this timestamp.
        osm3s = payload.get("osm3s")
        if not (isinstance(osm3s, dict) and osm3s.get("timestamp_areas_base")):
            raise OverpassError(f"{host} has no area data (country queries unsupported)")
    elements = payload.get("elements")
    if not isinstance(elements, list):
        raise OverpassError(f"Overpass payload from {host} has no 'elements' list")
    return elements
