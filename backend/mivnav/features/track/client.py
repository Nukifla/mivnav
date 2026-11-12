# SPDX-License-Identifier: GPL-2.0-only
"""The vessel's past positions, over SignalK's History API. Written without
a running box to test against — **unverified against this boat's server**,
why the feature stays in `testing`. See docs/architecture/signalk-history-api.md.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx

from mivnav.features.track.geometry import Fix

log = logging.getLogger(__name__)

#: Object-valued (``{latitude, longitude}``), so the server's path parser
#: defaults its aggregate to ``first`` rather than ``average`` — relied on
#: rather than named. See docs/architecture/signalk-history-api.md.
POSITION_PATH = "navigation.position"

#: Asked alongside positions on fine queries, to drop fixes the receiver
#: itself reports as poor. Measured on the boat: good fixes HDOP ~0.9 with
#: ~10 satellites (at sea and on the hard alike); fixes from inside a boat
#: hall HDOP 2.3-4.0 with 3.5-4.5 satellites, scattered 100-300 m. The
#: thresholds below dropped 0.1% of a sailing day and 15-45% of the hall
#: days. A null (receiver does not report it) is unknown, not bad: kept.
QUALITY_PATHS = ("navigation.gnss.horizontalDilution", "navigation.gnss.satellites")
MAX_HDOP = 3.0
MIN_SATELLITES = 5

#: ``vessels.self``. Sent explicitly (not left to the server default) since
#: this decides *whose* track is drawn.
SELF_CONTEXT = "vessels.self"

#: Longer than the autopilot's 4s budget on purpose: a database query over
#: up to a day of fine buckets, not a button press. Still bounded.
QUERY_TIMEOUT = 15.0

#: Passage-length default window when a request does not say.
DEFAULT_HOURS = 6.0

#: Four weeks. "Everything the plugin holds" is its own request shape
#: (``all=true``), not a bigger number here.
MAX_HOURS = 4 * 168.0

#: The rate the frontend polls at while the overlay is on, and the one
#: `/providers` reports as this source's staleness clock.
POLL_INTERVAL_S = 60.0


class TrackError(Exception):
    """Base: the track could not be read."""


class TrackUnavailable(TrackError):
    """SignalK is disabled in this server's configuration — a
    misconfiguration, not a fault, not something a retry fixes."""


class TrackUnsupported(TrackError):
    """No history provider (501) or the server predates the History API
    (404) — both permanent for this box: the UI should stop asking."""


class TrackUnreachable(TrackError):
    """The SignalK server did not answer in time, or at all."""


class TrackRefused(TrackError):
    """The server rejected the query itself (HTTP 400) — ours to fix, not
    the user's; surfaced verbatim so the message names the parameter."""


@dataclass(frozen=True)
class HistoryProvider:
    """One history provider registered on the box."""

    id: str
    #: The one SignalK answers from when a query names none.
    default: bool


class TrackClient:
    """The History API, as far as this app reads it. Pure of config and
    environment — a base URL and a token, built per request like the
    autopilot and Course clients (see `mivnav.features.track.runtime`)."""

    def __init__(
        self,
        history_url: str | None,
        token: str | None,
        *,
        provider: str | None = None,
        timeout: float = QUERY_TIMEOUT,
    ) -> None:
        self._base_url = history_url.rstrip("/") if history_url else None
        self._token = token or None
        self._provider = provider or None
        self._timeout = timeout

    @property
    def configured(self) -> bool:
        """Whether there is a server to ask at all (SignalK enabled)."""
        return self._base_url is not None

    @property
    def base_url(self) -> str | None:
        """The History API root — with :attr:`provider`, what a cache of
        this server's answers is keyed on."""
        return self._base_url

    @property
    def provider(self) -> str | None:
        """The history provider asked by name, or ``None`` for SignalK's
        default (see :mod:`mivnav.features.track.config`)."""
        return self._provider

    def providers(self) -> list[HistoryProvider]:
        """The history providers this box has registered, from
        ``GET …/history/_providers`` — ``{id: {isDefault}}`` on
        signalk-server 2.34 (measured on the boat, 2026-10-28)."""
        payload = self._get("_providers", {})
        if not isinstance(payload, dict):
            raise TrackRefused("the SignalK server's provider list was not an object")
        return [
            HistoryProvider(id, isinstance(info, dict) and info.get("isDefault") is True)
            for id, info in sorted(payload.items())
        ]

    def values(
        self,
        start: datetime,
        end: datetime,
        resolution_s: int,
        *,
        context: str = SELF_CONTEXT,
        quality: bool = True,
    ) -> list[Fix]:
        """Own-vessel fixes in ``[start, end)``, oldest first, one per
        ``resolution_s`` bucket (the server's own ``first`` aggregate for
        positions). Rows with ``null`` position are dropped, and so are rows
        outside the window — the API's range is inclusive at both ends.
        ``context`` names an earlier identity of this boat (see
        :mod:`mivnav.features.track.config`); the default is the current one.
        ``quality`` also asks for the receiver's HDOP and satellite count and
        drops poor fixes (see :data:`MAX_HDOP`); coarse probes, where an
        averaged HDOP means nothing, pass ``False``. Asks :attr:`provider`
        by name when one is set."""
        params = {
            "context": context,
            "paths": ",".join((POSITION_PATH, *QUALITY_PATHS)) if quality else POSITION_PATH,
            "from": wire_time(start),
            "to": wire_time(end),
            "resolution": str(max(1, int(resolution_s))),
        }
        if self._provider is not None:
            params["provider"] = self._provider
        payload = self._get("values", params)
        if not isinstance(payload, dict):
            raise TrackRefused("the SignalK server's history reply was not an object")

        rows = payload.get("data")
        lo, hi = start.timestamp(), end.timestamp()
        fixes = [f for f in _parse_rows(rows if isinstance(rows, list) else []) if lo <= f.t < hi]
        # Sorted, not trusted: a provider may merge several stores.
        fixes.sort(key=lambda f: f.t)
        return fixes

    def _get(self, route: str, params: dict[str, str]) -> Any:
        """``GET`` one History API route, its failures sorted into the
        :class:`TrackError` kinds; the parsed JSON body otherwise."""
        if self._base_url is None:
            raise TrackUnavailable(
                "SignalK is disabled in this server's configuration, so there "
                "is no history to read the vessel's track from"
            )
        # Sent when we have one; whether a read needs it is the server's own
        # policy (the boat's `readOnlyAccess: true` lets it through anonymously).
        headers = {"Authorization": f"Bearer {self._token}"} if self._token else {}
        url = f"{self._base_url}/{route}"
        try:
            with httpx.Client(timeout=self._timeout) as http:
                response = http.get(url, params=params, headers=headers)
        except httpx.HTTPError as e:
            raise TrackUnreachable(f"the SignalK server at {url} did not answer: {e}") from e

        if response.status_code == 501:
            raise TrackUnsupported(
                "this SignalK server has no history provider configured, so it "
                "keeps no record of where the boat has been. Install and enable "
                "a history plugin (signalk-parquet or signalk-to-influxdb2) to "
                "get a track"
            )
        if response.status_code == 404:
            raise TrackUnsupported(
                f"this SignalK server has no History API at {url}; it needs "
                "signalk-server 2.25 or newer"
            )
        if response.status_code in (401, 403):
            raise TrackUnavailable(
                "the SignalK server requires authentication for history reads "
                "and no usable token is configured; create a device token in "
                "the SignalK admin UI (Security → Devices) and PATCH it to "
                "credentials.signalk.token"
            )
        if response.status_code >= 400:
            raise TrackRefused(
                _error_message(response)
                or f"the SignalK server refused the history query (HTTP {response.status_code})"
            )

        try:
            return response.json()
        except ValueError as e:
            raise TrackRefused(f"the SignalK server's history reply was not JSON: {e}") from e


def wire_time(t: datetime) -> str:
    """ISO 8601, UTC, whole seconds — the form the API documents."""
    return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_rows(rows: list[Any]) -> list[Fix]:
    """``data`` rows to fixes, skipping every row that is not one. Defensive
    by design: a third-party plugin fills ``data``, and one bad bucket must
    not cost the whole track."""
    points: list[Fix] = []
    for row in rows:
        if not isinstance(row, list) or len(row) < 2:
            continue
        timestamp = row[0]
        if not isinstance(timestamp, str):
            continue
        t = _parse_time(timestamp)
        position = _position(row[1])
        if t is None or position is None or _poor(row[2:4]):
            continue
        points.append(Fix(t, position[0], position[1]))
    return points


def _poor(quality: list[Any]) -> bool:
    """Whether the receiver's own HDOP / satellite count (columns after the
    position, absent on a position-only query) mark this fix as poor."""
    hdop = quality[0] if len(quality) > 0 else None
    sats = quality[1] if len(quality) > 1 else None
    if _is_number(hdop) and hdop > MAX_HDOP:
        return True
    return _is_number(sats) and sats < MIN_SATELLITES


def _parse_time(value: str) -> float | None:
    try:
        t = datetime.fromisoformat(value)
    except ValueError:
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=UTC)
    return t.timestamp()


def _position(value: Any) -> tuple[float, float] | None:
    """``(lat, lon)`` from whatever a provider put in the position column —
    the spec's object shape, or GeoJSON-style ``[lon, lat]`` from a
    third-party plugin backend."""
    if isinstance(value, dict):
        lat, lon = value.get("latitude"), value.get("longitude")
        if _is_number(lat) and _is_number(lon):
            return float(lat), float(lon)
        return None
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        lon, lat = value[0], value[1]
        if _is_number(lat) and _is_number(lon):
            return float(lat), float(lon)
    return None


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _error_message(response: httpx.Response) -> str | None:
    """The server's own ``{"error": …}``, if it sent one."""
    try:
        payload = response.json()
    except ValueError:
        return response.text.strip() or None
    if isinstance(payload, dict) and isinstance(payload.get("error"), str):
        return payload["error"]
    return None
