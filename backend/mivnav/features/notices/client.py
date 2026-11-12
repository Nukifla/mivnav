# SPDX-License-Identifier: GPL-2.0-only
"""HTTP client for the Danish Maritime Authority's Niord server
(niord.dma.dk; data owner Beredskabsstyrelsen since 2025).

Endpoints (researched 2026-10-03, see efs.md §1.1; paths from
github.com/NiordOrg/niord ``niord-web`` REST services):

* ``/rest/public/v1/messages[?domain=…]`` — the official public feed. NO
  ``lang`` parameter, deliberately: without one every desc comes back in
  both Danish and English in one response.
* ``/rest/public/v1/message/{uuid|shortId}`` — one message, also cancelled
  or expired ones (for resolving ``references[]``).
* ``/rest/firing-schedules/search-firing-area-periods?date=<epoch ms>`` —
  UNOFFICIAL (the editor UI's). ``date`` is a ``Long`` (epoch ms), not an
  ISO date — ``FiringScheduleRestService.searchFiringAreaPeriods``; an ISO
  string 404s. The server truncates it to the day in the domain's time
  zone. Callers must treat any failure here as "no schedule" and fall back
  to the firing-exercise messages' own dates.
* attachments: absolute URLs in ``attachments[].path``.

No gzip, no ETag/Last-Modified upstream (measured), so every refresh is a
full pull; ~1 MB.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, time
from typing import Any
from urllib.parse import quote, urlsplit
from zoneinfo import ZoneInfo

import httpx

log = logging.getLogger(__name__)

USER_AGENT = "mivnav/0.1 (chart plotter; notices to mariners; +https://github.com/mivnav)"

#: Per request. The main feed is ~1 MB and answers in ~1 s; generous for a
#: slow boat LAN uplink, still bounded.
TIMEOUT_S = 30.0

#: An attachment larger than this is not cached (served through upstream
#: only). Measured attachments are tens of KB.
MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

#: The Niord DK domain's time zone — firing days are Danish days.
NIORD_TZ = ZoneInfo("Europe/Copenhagen")

DOMAIN_FIRING_AREAS = "niord-fa"
DOMAIN_ALMANAC = "niord-almanac"  # EfS A
DOMAIN_ANNEX = "niord-annex"  # EfS B


class NiordError(Exception):
    """Niord answered, but not with something usable."""


class NiordUnreachable(NiordError):
    """Transport failure, timeout, or a 5xx: the boat is (probably) offline."""


class NiordNotFound(NiordError):
    """Niord has no such message (HTTP 404)."""


class NiordClient:
    def __init__(
        self,
        base_url: str,
        *,
        transport: httpx.BaseTransport | None = None,
        timeout: float = TIMEOUT_S,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._transport = transport
        self._timeout = timeout

    def _client(self) -> httpx.Client:
        return httpx.Client(
            transport=self._transport,
            timeout=self._timeout,
            headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
            follow_redirects=True,
        )

    def _get(self, url: str, params: dict[str, Any] | None = None) -> httpx.Response:
        try:
            with self._client() as c:
                r = c.get(url, params=params)
        except httpx.HTTPError as e:
            raise NiordUnreachable(f"{url}: {e or type(e).__name__}") from e
        if r.status_code == 404:
            raise NiordNotFound(url)
        if r.status_code >= 500:
            raise NiordUnreachable(f"{url}: HTTP {r.status_code}")
        if r.status_code != 200:
            raise NiordError(f"{url}: HTTP {r.status_code}")
        return r

    def _get_json(self, url: str, params: dict[str, Any] | None = None) -> Any:
        r = self._get(url, params)
        try:
            return r.json()
        except ValueError as e:
            raise NiordError(f"{url}: not JSON: {e}") from e

    # -- feeds -----------------------------------------------------------

    def fetch_messages(self, domain: str | None = None) -> list[Any]:
        """The published messages of the default feed, or of ``domain``.
        Raw JSON (a list); both languages."""
        params = {"domain": domain} if domain else None
        data = self._get_json(f"{self.base_url}/rest/public/v1/messages", params)
        if not isinstance(data, list):
            raise NiordError("messages feed: expected a JSON list")
        return data

    def fetch_message(self, ident: str) -> dict[str, Any]:
        """One message by uuid or shortId, whatever its status. Raises
        :class:`NiordNotFound` when Niord has none."""
        url = f"{self.base_url}/rest/public/v1/message/{quote(ident, safe='')}"
        data = self._get_json(url)
        if not isinstance(data, dict) or "id" not in data:
            # Niord answers an unknown id with 404, but a 200 with no body
            # has been seen from JAX-RS for a null return — same meaning.
            raise NiordNotFound(url)
        return data

    def fetch_firing_periods(self, day: date) -> list[Any]:
        """Every firing area and its firing periods on ``day`` (a Danish
        day). ``date`` is sent as local NOON in epoch ms so the server's
        own truncate-to-day lands on ``day`` whatever its offset."""
        noon = datetime.combine(day, time(12), tzinfo=NIORD_TZ)
        data = self._get_json(
            f"{self.base_url}/rest/firing-schedules/search-firing-area-periods",
            {"date": int(noon.timestamp() * 1000), "lang": "da"},
        )
        if not isinstance(data, list):
            raise NiordError("firing periods: expected a JSON list")
        return data

    def fetch_attachment(self, url: str, *, max_bytes: int = MAX_ATTACHMENT_BYTES) -> tuple[bytes, str | None]:
        """``(body, content type)`` of one attachment URL (absolute, as
        Niord lists it). Refuses non-http(s) URLs and bodies over
        ``max_bytes``."""
        if urlsplit(url).scheme not in ("http", "https"):
            raise NiordError(f"refusing non-http attachment URL {url!r}")
        try:
            with self._client() as c, c.stream("GET", url) as r:
                if r.status_code == 404:
                    raise NiordNotFound(url)
                if r.status_code >= 500:
                    raise NiordUnreachable(f"{url}: HTTP {r.status_code}")
                if r.status_code != 200:
                    raise NiordError(f"{url}: HTTP {r.status_code}")
                buf = bytearray()
                for chunk in r.iter_bytes():
                    buf += chunk
                    if len(buf) > max_bytes:
                        raise NiordError(f"{url}: larger than {max_bytes} bytes")
                return bytes(buf), r.headers.get("content-type")
        except httpx.HTTPError as e:
            raise NiordUnreachable(f"{url}: {e or type(e).__name__}") from e

    def message_pdf_url(self, message_id: str, lang: str) -> str:
        """Niord's own per-message PDF (unofficial ``message-reports``)."""
        return f"{self.base_url}/rest/message-reports/message/{quote(message_id, safe='')}.pdf?lang={lang}"
