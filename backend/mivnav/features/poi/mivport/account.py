# SPDX-License-Identifier: GPL-2.0-only
"""The boat-wide mivport account and the kinds/attrs registry cache.

One login for the whole boat (docs/architecture/mivport-editing.md): the
backend holds the token in ``credentials.mivport`` (a secret, see
``SECRET_FIELDS``), so every screen edits as the same user and the outbox
uploads with no screen open. The token is only ever sent to the server that
issued it (``credentials.mivport.server``): point ``Config.mivport.base_url``
somewhere else and the boat is logged out there.

Logging in, registering and the device flow need mivport; everything else
here answers from what is on the boat.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from . import client as mp_client
from .client import MivportError, MivportUnreachable

log = logging.getLogger(__name__)

#: The ``client`` mivport records on tokens and changesets.
CLIENT = "mivnav"

#: Ask ``/v1/me`` (the role) at most this often while syncing.
ME_REFRESH_S = 3600.0


class AccountError(Exception):
    """An account call mivport refused: ``status`` is what the route answers
    (401 bad login, 409 taken, 400 bad input, 502 anything else)."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


@dataclass
class DeviceLogin:
    """A device login in progress; ``device_code`` never leaves the backend."""

    device_code: str
    user_code: str
    verification_url: str
    expires_at: float
    interval: float

    def public(self) -> dict:
        return {
            "user_code": self.user_code,
            "verification_url": self.verification_url,
            "expires_at": self.expires_at,
        }


def _json(resp: httpx.Response) -> Any:
    try:
        return resp.json()
    except ValueError as exc:
        raise AccountError(502, f"mivport answered HTTP {resp.status_code} without JSON") from exc


def _token_of(resp: httpx.Response) -> str:
    body = _json(resp)
    token = body.get("token") if isinstance(body, dict) else None
    if not isinstance(token, str) or not token:
        raise AccountError(502, "mivport answered without a token")
    return token


def fetch_token(http: httpx.Client, base_url: str, username: str, password: str) -> str:
    resp = mp_client.send(
        http, "POST", base_url, "/v1/auth/token",
        json={"username": username, "password": password, "client": CLIENT},
    )
    if resp.status_code == 401:
        raise AccountError(401, mp_client.error_text(resp))
    if resp.status_code != 200:
        raise AccountError(502, mp_client.error_text(resp))
    return _token_of(resp)


def register_user(
    http: httpx.Client, base_url: str, username: str, password: str, email: str | None
) -> None:
    body: dict[str, str] = {"username": username, "password": password}
    if email:
        body["email"] = email
    resp = mp_client.send(http, "POST", base_url, "/v1/auth/register", json=body)
    if resp.status_code in (200, 201):
        return
    status = resp.status_code if resp.status_code in (400, 409, 429) else 502
    raise AccountError(status, mp_client.error_text(resp))


def fetch_me(http: httpx.Client, base_url: str, token: str) -> dict:
    """``{username, role, ...}``; :class:`AccountError` 401 when the token is dead."""
    resp = mp_client.send(http, "GET", base_url, "/v1/me", token=token, timeout=15.0)
    if resp.status_code == 401:
        raise AccountError(401, mp_client.error_text(resp))
    if resp.status_code != 200:
        raise AccountError(502, mp_client.error_text(resp))
    body = _json(resp)
    if not isinstance(body, dict) or not isinstance(body.get("username"), str):
        raise AccountError(502, "/v1/me: no username")
    return body


# -- registry ---------------------------------------------------------------


class RegistryCache:
    """mivport's ``/v1/kinds`` and ``/v1/attrs`` as-is, in
    ``data_root/mivport/registry.json``, so the place editor works offline."""

    def __init__(self, data_root: Path) -> None:
        self.path = Path(data_root) / "mivport" / "registry.json"

    def load(self) -> dict | None:
        try:
            body = json.loads(self.path.read_text())
        except (OSError, ValueError):
            return None
        return body if isinstance(body, dict) else None

    def age(self, now: float) -> float:
        body = self.load()
        fetched = body.get("fetched_at") if body else None
        return now - fetched if isinstance(fetched, (int, float)) else float("inf")

    def refresh(self, http: httpx.Client, base_url: str, now: float | None = None) -> dict:
        """Fetch both lists and replace the file; raises :class:`MivportError`
        (nothing written) when either fails."""
        kinds = mp_client.fetch_json(http, mp_client._url(base_url, "/v1/kinds"))
        attrs = mp_client.fetch_json(http, mp_client._url(base_url, "/v1/attrs"))
        if not isinstance(kinds, dict) or not isinstance(kinds.get("kinds"), list):
            raise MivportError("/v1/kinds: no kinds list")
        if not isinstance(attrs, dict) or not isinstance(attrs.get("attrs"), list):
            raise MivportError("/v1/attrs: no attrs list")
        body = {
            "kinds": kinds["kinds"],
            "attrs": attrs["attrs"],
            "fetched_at": time.time() if now is None else now,
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=".registry-", suffix=".json")
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(body, f, separators=(",", ":"), ensure_ascii=False)
            os.replace(tmp, self.path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise
        return body

    def max_len(self) -> dict[str, int]:
        """``attr key -> max_len`` for the string attrs that have one."""
        body = self.load() or {}
        out: dict[str, int] = {}
        for attr in body.get("attrs") or ():
            if isinstance(attr, dict) and isinstance(attr.get("key"), str) and isinstance(attr.get("max_len"), int):
                out[attr["key"]] = attr["max_len"]
        return out


# -- the account ----------------------------------------------------------------


class Account:
    """The boat's login, read from and written to ``credentials.mivport``
    through the config store. ``http`` is the runtime's client; ``clock``
    is injectable for tests."""

    def __init__(
        self,
        config: Any,  # mivnav.config.ConfigStore
        http: Callable[[], httpx.Client],
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._config = config
        self._http = http
        self._clock = clock
        self._lock = threading.Lock()
        self._device: DeviceLogin | None = None
        self._me_at = 0.0

    # -- state ---------------------------------------------------------------

    def base_url(self) -> str:
        return self._config.get().mivport.base_url

    def _creds(self):
        return self._config.get().credentials.mivport

    def token(self) -> str | None:
        """The token, but only for the server it was issued by."""
        creds = self._creds()
        token = creds.token.get_secret_value()
        if token and creds.server == self.base_url():
            return token
        return None

    def logged_in(self) -> bool:
        return self.token() is not None

    def username(self) -> str:
        return self._creds().username

    def role(self) -> str:
        return self._creds().role

    def device(self) -> DeviceLogin | None:
        with self._lock:
            if self._device is not None and self._device.expires_at <= self._clock():
                self._device = None
            return self._device

    def summary(self) -> dict:
        logged_in = self.logged_in()
        out: dict[str, Any] = {"server": self.base_url(), "logged_in": logged_in}
        creds = self._creds()
        if creds.username:
            out["username"] = creds.username
        if logged_in and creds.role:
            out["role"] = creds.role
        device = self.device()
        out["device"] = device.public() if device is not None else None
        return out

    def _save(self, username: str, token: str, role: str) -> None:
        self._config.patch({"credentials": {"mivport": {
            "username": username, "token": token, "role": role, "server": self.base_url(),
        }}})
        self._me_at = self._clock()

    def forget_token(self) -> None:
        """Logged out (mivport said 401, or the skipper logged out): the
        username stays for the login form."""
        self._config.patch({"credentials": {"mivport": {"token": "", "role": "", "server": ""}}})

    # -- online calls ------------------------------------------------------------

    def _adopt(self, token: str) -> None:
        me = fetch_me(self._http(), self.base_url(), token)
        self._save(str(me["username"]), token, str(me.get("role") or ""))

    def login(self, username: str, password: str) -> None:
        token = fetch_token(self._http(), self.base_url(), username, password)
        self._adopt(token)
        with self._lock:
            self._device = None

    def register(self, username: str, password: str, email: str | None) -> None:
        register_user(self._http(), self.base_url(), username, password, email)
        self.login(username, password)

    def start_device(self) -> DeviceLogin:
        base = self.base_url()
        resp = mp_client.send(self._http(), "POST", base, "/v1/auth/device", json={"client": CLIENT})
        if resp.status_code != 200:
            raise AccountError(429 if resp.status_code == 429 else 502, mp_client.error_text(resp))
        body = _json(resp)
        try:
            uri = str(body["verification_uri"])
            device = DeviceLogin(
                device_code=str(body["device_code"]),
                user_code=str(body["user_code"]),
                verification_url=uri if uri.startswith(("http://", "https://")) else base.rstrip("/") + uri,
                expires_at=self._clock() + float(body.get("expires_in") or 600),
                interval=max(1.0, float(body.get("interval") or 5)),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise AccountError(502, f"/v1/auth/device: unexpected answer ({exc})") from exc
        with self._lock:
            self._device = device
        return device

    def poll_device(self) -> bool:
        """One poll of a device login in progress (the sync thread's job).
        ``True`` once logged in. Raises :class:`MivportUnreachable`."""
        device = self.device()
        if device is None:
            return False
        resp = mp_client.send(
            self._http(), "POST", self.base_url(), "/v1/auth/device/token",
            json={"device_code": device.device_code}, timeout=15.0,
        )
        if resp.status_code == 428:
            return False
        if resp.status_code == 200:
            try:
                self._adopt(_token_of(resp))
            except AccountError as e:
                log.warning("mivport device login: %s", e.detail)
                return False
            with self._lock:
                self._device = None
            return True
        # 400 expired_token, or anything else: this code is done for.
        log.info("mivport device login ended: %s", mp_client.error_text(resp))
        with self._lock:
            if self._device is device:
                self._device = None
        return False

    def logout(self) -> None:
        """Revoke the token when mivport answers; forget it either way."""
        token = self.token()
        with self._lock:
            self._device = None
        if token is not None:
            try:
                mp_client.send(self._http(), "DELETE", self.base_url(), "/v1/auth/token",
                               token=token, timeout=10.0)
            except MivportUnreachable as e:
                log.info("mivport logout: token not revoked (%s)", e)
        self.forget_token()

    def refresh_me(self, force: bool = False) -> None:
        """Re-read the role (once an hour while syncing). Raises
        :class:`AccountError` 401 for a dead token, :class:`MivportUnreachable`."""
        token = self.token()
        if token is None or (not force and self._clock() - self._me_at < ME_REFRESH_S):
            return
        me = fetch_me(self._http(), self.base_url(), token)
        self._me_at = self._clock()
        role = str(me.get("role") or "")
        if role != self.role() or me["username"] != self.username():
            self._save(str(me["username"]), token, role)
