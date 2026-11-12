# SPDX-License-Identifier: GPL-2.0-only
"""o-charts.org shop API client.

Protocol ported from ochartsng (ShopLogin.js, ShopRequestHandler.h) and
the o-charts_pi plugin (assign, from ochartShop.cpp). See
docs/architecture/ocharts-shop-protocol.md for the task list and the
credential-scrubbing/legacy-env-migration rationale.
"""

from __future__ import annotations

import os
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path

import httpx

SHOP_URL = "https://o-charts.org/shop/index.php?fc=module&module=occharts&controller=apioesu"
SHOP_VERSION = "r.2.1.7"

# ShopLogin.js error table (subset that can reach users)
SHOP_ERRORS = {
    "3c": "unknown request",
    "3d": "empty username",
    "3e": "invalid username",
    "3f": "empty password",
    "3g": "wrong password",
    "3k": "invalid characters",
    "8l": "no system name for this device",
    "8h": "something has changed in the device assigned to this system name",
    "8j": "there is already a system name for this device",
    "2": "server in maintenance mode",
    "4": "user does not exist",
    "5": "invalid version of the plugin",
    "6": "invalid user/email name or password",
    "10": "system name is disabled",
    "20": "chart already assigned to this system",
}

NOT_REGISTERED = "8l"


LEGACY_ENV_FILE = "ocharts.env"


def legacy_env_path() -> Path:
    """The pre-config credentials file. Read once, on migration, never
    written."""
    config_home = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return config_home / "mivnav" / LEGACY_ENV_FILE


@dataclass
class Credentials:
    user: str
    password: str


def load_credentials(path: Path | None = None) -> Credentials | None:
    """OCHARTS_USER/OCHARTS_PASSWORD from the legacy env file; None if
    absent. Migration only — see the module docstring."""
    path = path or legacy_env_path()
    try:
        text = path.read_text()
    except OSError:
        return None
    values: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        name, sep, value = line.partition("=")
        if sep:
            values[name.strip()] = value.strip().strip("'\"")
    user = values.get("OCHARTS_USER", "")
    password = values.get("OCHARTS_PASSWORD", "")
    if not user or not password:
        return None
    return Credentials(user=user, password=password)


class ShopError(Exception):
    """A shop-level failure, code per the reference error table."""

    def __init__(self, code: str, info: str = "") -> None:
        self.code = code
        base = code.partition(":")[0]
        text = SHOP_ERRORS.get(base, "shop error")
        super().__init__(f"{text} (code {code})" + (f": {info}" if info else ""))


@dataclass
class ChartSlot:
    slot_uuid: str
    assigned_system: str | None


@dataclass
class ShopChart:
    chart_id: str
    name: str
    edition: str
    expired: bool
    order: str  # order reference, needed for `assign`
    quantity_id: str  # first purchased quantity, needed for `assign`
    slots: list[ChartSlot] = field(default_factory=list)


@dataclass
class DownloadUrls:
    chart_url: str
    key_url: str


def _scrub(text: str, creds: Credentials) -> str:
    """Remove credential values from text that may reach logs or clients."""
    for secret in (creds.password, creds.password.encode().hex(), creds.user):
        if secret:
            text = text.replace(secret, "[redacted]")
    return text


class ShopClient:
    """One logged-in shop session. Construct via :func:`connect`."""

    def __init__(self, creds: Credentials, http: httpx.Client | None = None) -> None:
        self._creds = creds
        self._http = http or httpx.Client(timeout=httpx.Timeout(60.0, connect=30.0))
        self._key: str | None = None

    # -- plumbing ----------------------------------------------------------

    def _task(self, task: str, params: dict[str, str]) -> ET.Element:
        data = {"version": SHOP_VERSION, "taskId": task, **params}
        try:
            resp = self._http.post(SHOP_URL, data=data)
            resp.raise_for_status()
            root = ET.fromstring(resp.text)
        except ShopError:
            raise
        except ET.ParseError as e:
            raise ShopError("AV2", f"unparseable shop response: {e}") from e
        except httpx.HTTPError as e:
            raise ShopError("AV4", _scrub(str(e), self._creds)) from e
        response = root if root.tag == "response" else root.find("response")
        if response is None:
            raise ShopError("AV2", "no <response> element")
        result = (response.findtext("result") or "").strip()
        if result != "1":
            info = _scrub((response.findtext("info") or "").strip(), self._creds)
            raise ShopError(result or "AV2", info)
        return response

    def _session_key(self) -> str:
        if self._key is None:
            self.login()
        assert self._key is not None
        return self._key

    # -- API ---------------------------------------------------------------

    def login(self) -> None:
        """``login2``: obtain the session key (hex-encoded password)."""
        response = self._task(
            "login2",
            {
                "username": self._creds.user,
                "password": self._creds.password.encode("utf-8").hex(),
            },
        )
        key = (response.findtext("key") or "").strip()
        if not key:
            raise ShopError("AV2", "login succeeded but no session key")
        self._key = key

    def identify_system(self, xfpr_name: str, xfpr: str) -> str | None:
        """The system name this fingerprint is registered under, or None."""
        try:
            response = self._task(
                "identifySystem",
                {
                    "key": self._session_key(),
                    "username": self._creds.user,
                    "xfprName": xfpr_name,
                    "xfpr": xfpr,
                },
            )
        except ShopError as e:
            if e.code.partition(":")[0] == NOT_REGISTERED:
                return None
            raise
        name = (response.findtext("systemName") or "").strip()
        return name or None

    def register_system(self, xfpr_name: str, xfpr: str, system_name: str) -> None:
        """``xfpr``: register this fingerprint under ``system_name``.

        Irreversible; uses up the system-name binding. Callers enforce the
        one-attempt policy.
        """
        self._task(
            "xfpr",
            {
                "username": self._creds.user,
                "key": self._session_key(),
                "xfprName": xfpr_name,
                "xfpr": xfpr,
                "systemName": system_name,
            },
        )

    def chart_list(self) -> tuple[list[str], list[ShopChart]]:
        """``getlist``: (known system names, owned charts with slots)."""
        response = self._task(
            "getlist",
            {"key": self._session_key(), "username": self._creds.user},
        )
        systems = [
            el.text.strip()
            for el in response.findall("systemName")
            if el.text and el.text.strip()
        ]
        charts = []
        for chart in response.iter("chart"):
            chart_id = chart.findtext("chartId", "").strip()
            name = chart.findtext("chartName", "").strip()
            edition = chart.findtext("edition", "").strip()
            expired = chart.findtext("expired", "").strip() == "1"
            if not chart_id or not name:
                continue
            slots = [
                ChartSlot(
                    slot_uuid=slot.findtext("slotUuid", "").strip(),
                    assigned_system=(slot.findtext("assignedSystemName") or "").strip() or None,
                )
                for slot in chart.iter("slot")
                if (slot.findtext("slotUuid") or "").strip()
            ]
            charts.append(
                ShopChart(
                    chart_id=chart_id,
                    name=name,
                    edition=edition,
                    expired=expired,
                    order=chart.findtext("order", "").strip(),
                    quantity_id=(chart.findtext("quantity/quantityId") or "").strip(),
                    slots=slots,
                )
            )
        return systems, charts

    def assign_chart(self, order: str, chart_id: str, quantity_id: str, system_name: str) -> str:
        """``assign``: bind one purchased quantity of a chart to a system.

        Consumes one of the chart's ``maxSlots`` bindings. Returns the new
        slot's UUID for the follow-up ``request``.
        """
        response = self._task(
            "assign",
            {
                "username": self._creds.user,
                "key": self._session_key(),
                "systemName": system_name,
                "order": order,
                "chartid": chart_id,
                "quantityId": quantity_id,
            },
        )
        for el in response.iter("slotUuid"):
            uuid = (el.text or "").strip()
            if uuid:
                return uuid
        raise ShopError("AV2", "assign succeeded but no slotUuid in response")

    def download_urls(self, system_name: str, slot_uuid: str, edition: str) -> DownloadUrls:
        """``request``: URLs of the chart zip and its keys.xml."""
        response = self._task(
            "request",
            {
                "assignedSystemName": system_name,
                "slotUuid": slot_uuid,
                "requestedFile": "base",
                "requestedVersion": edition,
                "username": self._creds.user,
                "key": self._session_key(),
            },
        )
        file_el = response.find("file")
        chart_url = file_el.findtext("link", "").strip() if file_el is not None else ""
        key_url = file_el.findtext("chartKeysLink", "").strip() if file_el is not None else ""
        if not chart_url or not key_url:
            raise ShopError("AV2", "shop response missing download links")
        return DownloadUrls(chart_url=chart_url, key_url=key_url)

    def close(self) -> None:
        self._http.close()
