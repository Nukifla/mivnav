# SPDX-License-Identifier: GPL-2.0-only
"""mivport LIVE: every mivport place in the world while the boat is online,
the way the mivport web client sees it — cut per viewport tile from
mivport's own ``GET /v1/places?bbox=`` and held only in RAM, never on disk.

Switched on boat-wide by ``Config.mivport.live``. Each tile the map asks for
is one bbox query (mivport orders it by kind, so a capped answer keeps the
harbours and anchorages); its points are kept for :data:`TILE_TTL_S` so
panning back and forth doesn't ask again. On a failed request the layer goes
offline for :data:`OFFLINE_BACKOFF_S`: tiles answer empty at once instead of
each waiting for a timeout (no internet at sea is the normal case).

A tapped live place's detail is fetched live too (place, reviews, photos —
photos keep their remote URLs), in a small LRU.
"""

from __future__ import annotations

import logging
import math
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Collection, Iterable
from typing import Any
from urllib.parse import quote

import httpx

from mivnav.features.poi.mvt import EXTENT, encode_point_layer

from .client import USER_AGENT, MivportError
from .mapping import normalize, point_feature
from .source import _photo

log = logging.getLogger(__name__)

__all__ = [
    "LIVE_SET",
    "MAX_ZOOM",
    "MIN_ZOOM",
    "MivportLive",
    "MivportOffline",
    "encode_tile",
    "tile_bbox",
]

#: The ``set`` every live point carries; the detail route keys on it.
LIVE_SET = "live"
#: Below this nothing ranks in (marinas are the first, at 7).
MIN_ZOOM = 7
#: The tile ceiling; the map overzooms past it.
MAX_ZOOM = 14
#: Places per tile query (mivport's cap is 5000; it keeps the most
#: important kinds when it truncates).
TILE_LIMIT = 1000
TILE_TTL_S = 120.0
DETAIL_TTL_S = 300.0
OFFLINE_BACKOFF_S = 30.0
TIMEOUT_S = 10.0
MAX_TILES = 256
MAX_DETAILS = 64

_MAX_LAT = 85.0511287798066

#: A tile's points: ``(lon, lat, props)``.
Points = list[tuple[float, float, dict]]


class MivportOffline(MivportError):
    """mivport didn't answer (or the backoff after it didn't still holds)."""


def tile_bbox(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """``(minlon, minlat, maxlon, maxlat)`` of a slippy tile."""
    n = 1 << z

    def lat(ty: int) -> float:
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * ty / n))))

    return x / n * 360.0 - 180.0, lat(y + 1), (x + 1) / n * 360.0 - 180.0, lat(y)


def _tile_xy(lon: float, lat: float, z: int, x: int, y: int) -> tuple[int, int]:
    """lon/lat → tile-local coords, clamped to the tile (bbox edges are
    inclusive, so a point can sit exactly on one)."""
    n = 1 << z
    lat = min(max(lat, -_MAX_LAT), _MAX_LAT)
    fx = (lon + 180.0) / 360.0 * n - x
    fy = (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n - y
    clamp = lambda v: min(max(int(round(v * EXTENT)), 0), EXTENT)  # noqa: E731
    return clamp(fx), clamp(fy)


def points_of(features: Iterable[Any], z: int) -> Points:
    """The tile points of an API feature list: tile-shaped props plus
    ``set``, only those ranked in at ``z`` (the baked archive's per-feature
    ``min_zoom`` floor), never a deleted place."""
    out: Points = []
    for feat in features:
        norm = normalize(feat)
        if norm is None or norm[2].get("deleted"):
            continue
        lon, lat, props = point_feature(*norm)
        if props["min_zoom"] > z:
            continue
        out.append((lon, lat, {**props, "set": LIVE_SET}))
    return out


def encode_tile(points: Points, z: int, x: int, y: int, exclude: Collection[str] = ()) -> bytes:
    """The MVT (layer ``pois``, like a baked set) of the points whose ref
    isn't in ``exclude``; ``b""`` when none is left."""
    return encode_point_layer(
        "pois",
        (
            (*_tile_xy(lon, lat, z, x, y), props)
            for lon, lat, props in points
            if props["ref"] not in exclude
        ),
    )


def _review(row: Any) -> dict | None:
    if not isinstance(row, dict) or not isinstance(row.get("stars"), int) or not isinstance(row.get("id"), str):
        return None
    out: dict[str, Any] = {"id": row["id"], "stars": row["stars"], "user": str(row.get("user") or "")}
    for key in ("body", "visited_on", "created_at"):
        if isinstance(row.get(key), str) and row[key].strip():
            out[key] = row[key]
    return out


class MivportLive:
    """The live layer's RAM: tile points and details, and the offline
    backoff. ``base_url`` is read per call, so a config edit takes effect
    at once (and keys the caches, so another server never answers for it)."""

    def __init__(
        self,
        http: Callable[[], httpx.Client],
        base_url: Callable[[], str],
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._http = http
        self._base_url = base_url
        self._clock = clock
        self._lock = threading.Lock()
        self._tiles: OrderedDict[tuple, tuple[float, Points]] = OrderedDict()
        self._details: OrderedDict[tuple, tuple[float, dict]] = OrderedDict()
        self._offline_until = 0.0
        self.last_error: str | None = None
        self.last_ok: float | None = None

    # -- the wire

    def _get(self, path: str, **params: Any) -> httpx.Response:
        now = self._clock()
        if now < self._offline_until:
            raise MivportOffline(self.last_error or "offline")
        url = self._base_url().rstrip("/") + path
        try:
            resp = self._http().get(
                url, params=params or None, headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT_S
            )
        except httpx.HTTPError as e:
            self._went_offline(f"{url}: {e}")
            raise MivportOffline(self.last_error or str(e)) from e
        if resp.status_code >= 500:
            self._went_offline(f"{url}: HTTP {resp.status_code}")
            raise MivportOffline(self.last_error or "")
        self._offline_until = 0.0
        self.last_error = None
        self.last_ok = now
        return resp

    def _json(self, path: str, ok: tuple[int, ...] = (200,), **params: Any) -> Any:
        resp = self._get(path, **params)
        if resp.status_code not in ok:
            raise MivportError(f"{path}: HTTP {resp.status_code}")
        try:
            return resp.json()
        except ValueError as e:
            raise MivportError(f"{path}: not JSON") from e

    def _went_offline(self, error: str) -> None:
        if self._clock() >= self._offline_until:
            log.info("mivport live: offline (%s)", error)
        self._offline_until = self._clock() + OFFLINE_BACKOFF_S
        self.last_error = error

    @property
    def offline(self) -> bool:
        return self._clock() < self._offline_until

    # -- tiles

    def tile_points(self, z: int, x: int, y: int) -> Points:
        """The points of tile ``z/x/y`` (cached for :data:`TILE_TTL_S`).
        Raises :class:`MivportOffline` / :class:`MivportError`."""
        key = (self._base_url(), z, x, y)
        now = self._clock()
        with self._lock:
            hit = self._tiles.get(key)
            if hit is not None and now - hit[0] < TILE_TTL_S:
                self._tiles.move_to_end(key)
                return hit[1]
        w, s, e, n = tile_bbox(z, x, y)
        body = self._json("/v1/places", bbox=f"{w:.6f},{s:.6f},{e:.6f},{n:.6f}", limit=TILE_LIMIT)
        feats = body.get("features") if isinstance(body, dict) else None
        if not isinstance(feats, list):
            raise MivportError("/v1/places: no feature list")
        points = points_of(feats, z)
        with self._lock:
            self._tiles[key] = (now, points)
            self._tiles.move_to_end(key)
            while len(self._tiles) > MAX_TILES:
                self._tiles.popitem(last=False)
        return points

    # -- details

    def detail(self, ref: str) -> tuple[dict, str] | None:
        """``(detail, attribution)`` of one place as mivport has it now, in
        the baked detail's shape (``lon``/``lat``, reviews, photos with
        their remote URLs); ``None`` when mivport doesn't know it."""
        key = (self._base_url(), ref)
        now = self._clock()
        with self._lock:
            hit = self._details.get(key)
            if hit is not None and now - hit[0] < DETAIL_TTL_S:
                return hit[1]["detail"], hit[1]["attribution"]
        pid = quote(ref, safe=":")
        resp = self._get(f"/v1/places/{pid}")
        if resp.status_code == 404:
            return None
        if resp.status_code not in (200, 410):
            raise MivportError(f"/v1/places/{ref}: HTTP {resp.status_code}")
        try:
            body = resp.json()
        except ValueError as e:
            raise MivportError(f"/v1/places/{ref}: not JSON") from e
        norm = normalize(body.get("feature") if isinstance(body, dict) else None)
        if norm is None:
            raise MivportError(f"/v1/places/{ref}: no place")
        lon, lat, detail = norm
        detail = {**detail, "lon": lon, "lat": lat}
        if resp.status_code == 410:
            detail["deleted"] = True
        attribution = str(body.get("attribution") or "")
        if detail.get("source") == "core":
            # Our places have reviews and photos; a bare OSM element none.
            reviews = self._json(f"/v1/places/{pid}/reviews", ok=(200, 404))
            rows = [r for r in (_review(v) for v in (reviews or {}).get("reviews") or ()) if r]
            if rows:
                detail["reviews"] = rows
            photos = self._json(f"/v1/places/{pid}/photos", ok=(200, 404))
            base = self._base_url()
            shots = [
                {**p, "remote": True}
                for p in (_photo(r, base) for r in (photos or {}).get("photos") or () if isinstance(r, dict))
                if p
            ]
            if shots:
                detail["photos"] = shots
        with self._lock:
            self._details[key] = (now, {"detail": detail, "attribution": attribution})
            self._details.move_to_end(key)
            while len(self._details) > MAX_DETAILS:
                self._details.popitem(last=False)
        return detail, attribution

    def forget(self, ref: str) -> None:
        """Drop a place's detail (after the boat wrote to it)."""
        with self._lock:
            for key in [k for k in self._details if k[1] == ref]:
                del self._details[key]

    def status(self, enabled: bool) -> dict:
        state = "off" if not enabled else "offline" if self.offline else "ready"
        return {
            "enabled": enabled,
            "state": state,
            "error": self.last_error if state == "offline" else None,
            "last_ok": self.last_ok,
            "min_zoom": MIN_ZOOM,
            "max_zoom": MAX_ZOOM,
            "tiles": "/poi/live/mivport/tiles/{z}/{x}/{y}",
        }
