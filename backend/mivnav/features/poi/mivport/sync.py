# SPDX-License-Identifier: GPL-2.0-only
"""Uploading the outbox (docs/architecture/mivport-editing.md, "Sync").

One pass, in this order: place edits (one ``POST /v1/edits`` batch of at
most 500), reviews, review deletes, photo uploads, photo deletes, removal
requests. Rules:

- at most one edit per place in a batch, oldest first: the next one goes
  in the next pass, once the first one's revision is known (``base_rev``);
- anything on a place created on the boat waits until that create is done;
- 401: logged out, everything stays pending; a transport error or a 5xx
  ends the pass (still pending); 429 ends that kind of item for this pass;
- any other refusal is ``failed`` with mivport's ``error``;
- photo 409 (already there: a resend whose answer got lost) is done.

A :class:`Syncer` thread runs passes: every 30 s while something is pending
and the boat is logged in (backing off to 5 min while mivport is
unreachable), every few seconds while a device login waits for approval,
and at once when kicked (a write, ``POST /mivport/sync``).
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from typing import Any

import httpx

from . import client as mp_client
from . import local
from .account import Account, AccountError, RegistryCache
from .client import MivportError, MivportUnreachable
from .mapping import normalize
from .outbox import Outbox

log = logging.getLogger(__name__)

#: ``/v1/edits`` takes at most this many edits per batch.
MAX_BATCH = 500

INTERVAL_S = 30.0
MAX_BACKOFF_S = 300.0

#: Refresh the cached kinds/attrs registry at most this often while syncing.
REGISTRY_REFRESH_S = 3600.0

#: The pass's ``client`` on mivport's changesets.
CLIENT = "mivnav"


class _LoggedOut(Exception):
    pass


class _ServerTrouble(Exception):
    """mivport answered, but not usefully (5xx): stop, retry later."""


class Syncer:
    """The upload loop and its state (online, last sync, last error)."""

    def __init__(
        self,
        account: Account,
        outbox: Callable[[], Outbox],
        registry: Callable[[], RegistryCache],
        http: Callable[[], httpx.Client],
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.account = account
        self._outbox = outbox
        self._registry = registry
        self._http = http
        self._clock = clock
        self._pass_lock = threading.Lock()
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._failures = 0
        self.online: bool | None = None
        self.last_sync: float | None = None
        self.last_error: str | None = None

    # -- the thread ---------------------------------------------------------

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="mivport-sync", daemon=True)
        self._thread.start()
        self.kick()

    def stop(self) -> None:
        thread = self._thread
        if thread is None:
            return
        self._stop.set()
        self._wake.set()
        thread.join(timeout=10.0)
        self._thread = None

    def kick(self) -> None:
        self._wake.set()

    def next_wait(self) -> float | None:
        """Seconds until the next pass, ``None`` = until kicked."""
        device = self.account.device()
        if device is not None:
            return device.interval
        if not self.account.logged_in():
            return None
        outbox = self._outbox()
        if not outbox.has_pending():
            return None
        if self.online is False:
            return min(MAX_BACKOFF_S, INTERVAL_S * 2 ** max(0, self._failures - 1))
        return INTERVAL_S

    def _run(self) -> None:
        try:
            self._outbox().reset_sending()
        except Exception:  # noqa: BLE001 — a broken outbox must not kill the thread
            log.exception("mivport outbox: cannot reset items in flight")
        while not self._stop.is_set():
            try:
                timeout = self.next_wait()
            except Exception:  # noqa: BLE001
                log.exception("mivport sync: cannot read the outbox")
                timeout = MAX_BACKOFF_S
            self._wake.wait(timeout)
            self._wake.clear()
            if self._stop.is_set():
                break
            try:
                self.sync_once()
            except Exception:  # noqa: BLE001 — keep the loop alive
                log.exception("mivport sync pass failed")

    # -- one pass -----------------------------------------------------------

    def sync_once(self, *, force_refresh: bool = False) -> None:
        """One pass. ``force_refresh``: also the registry and role now
        (``POST /mivport/sync``)."""
        with self._pass_lock:
            self._pass(force_refresh)

    def _pass(self, force_refresh: bool) -> None:
        if self.account.device() is not None:
            try:
                self.account.poll_device()
                self._online()
            except MivportUnreachable as e:
                self._offline(e)
                return
        token = self.account.token()
        if token is None:
            return
        outbox = self._outbox()
        base_url = self.account.base_url()
        try:
            self.account.refresh_me(force=force_refresh)
            registry = self._registry()
            if force_refresh or registry.age(self._clock()) > REGISTRY_REFRESH_S:
                try:
                    registry.refresh(self._http(), base_url, now=self._clock())
                except MivportUnreachable:
                    raise
                except MivportError as e:
                    log.warning("mivport registry not refreshed: %s", e)
            if outbox.exists():
                outbox.purge_done()
                self._edits(outbox, base_url, token)
                for kind in ("review", "review_delete", "photo", "photo_delete", "removal"):
                    self._items(outbox, kind, base_url, token)
        except MivportUnreachable as e:
            self._offline(e)
            return
        except (_LoggedOut, AccountError) as e:
            if isinstance(e, AccountError) and e.status != 401:
                self.last_error = e.detail
                return
            log.info("mivport: the token was refused; logged out")
            self.account.forget_token()
            self.last_error = "mivport refused the login; log in again"
            self._online()
            return
        except _ServerTrouble as e:
            self.last_error = str(e)
            self._online()
            return
        self._online()
        self.last_sync = self._clock()
        self.last_error = None

    def _online(self) -> None:
        self.online = True
        self._failures = 0

    def _offline(self, e: Exception) -> None:
        self.online = False
        self._failures += 1
        self.last_error = f"mivport unreachable: {e}"

    def _check(self, resp: httpx.Response) -> None:
        """The answers that end the pass for every item alike."""
        if resp.status_code == 401:
            raise _LoggedOut()
        if resp.status_code >= 500:
            raise _ServerTrouble(f"mivport: {mp_client.error_text(resp)}")

    # -- place edits ----------------------------------------------------------

    def _waits_for_create(self, outbox: Outbox, place_id: str | None) -> bool:
        """Is ``place_id`` a place created on the boat and not yet uploaded?"""
        if place_id is None or not local.UUID_RE.match(place_id):
            return False
        return any(
            e["payload"].get("op") == "create" and e["state"] != "done"
            for e in outbox.items(kind="edit", place_ids=[place_id])
        )

    def _base_rev(self, outbox: Outbox, base_url: str, edit: dict) -> int | None:
        payload = edit["payload"]
        if isinstance(payload.get("base_rev"), int):
            return payload["base_rev"]
        entry = outbox.place(edit["place_id"]) or {}
        rev = (entry.get("base") or {}).get("rev")
        if isinstance(rev, int):
            return rev
        # A bake from before details carried ``rev``: ask mivport.
        feature, _ = mp_client.fetch_place(self._http(), base_url, edit["place_id"])
        props = (feature or {}).get("properties") or {}
        return props.get("rev") if isinstance(props.get("rev"), int) else None

    def _edits(self, outbox: Outbox, base_url: str, token: str) -> None:
        batch: list[dict] = []
        busy: set[str] = set()
        for item in outbox.items(kind="edit", states=("pending", "sending")):
            place = item["place_id"]
            if place in busy:
                continue
            busy.add(place)
            if item["state"] == "pending":
                batch.append(item)
            if len(batch) >= MAX_BATCH:
                break
        if not batch:
            return
        # Frozen first (no more merges or discards), then re-read: a write
        # that landed in between is in what gets sent.
        outbox.mark_sending([i["id"] for i in batch])
        batch = [i for i in (outbox.get(b["id"]) for b in batch) if i is not None and i["state"] == "sending"]
        ids = [i["id"] for i in batch]
        edits = []
        try:
            for item in batch:
                payload = dict(item["payload"])
                if payload["op"] != "create" and not isinstance(payload.get("base_rev"), int):
                    try:
                        rev = self._base_rev(outbox, base_url, item)
                    except MivportUnreachable:
                        raise
                    except MivportError:
                        rev = None
                    if rev is not None:
                        payload["base_rev"] = rev
                        # A resend must send the same body.
                        outbox.update(item["id"], payload=payload)
                edits.append(payload)
            resp = mp_client.send(self._http(), "POST", base_url, "/v1/edits", token=token,
                                  json={"client": CLIENT, "edits": edits})
            self._check(resp)
        except BaseException:
            outbox.unsend(ids)
            raise
        if resp.status_code == 429:
            outbox.unsend(ids)
            self.last_error = f"mivport: {mp_client.error_text(resp)}"
            return
        if resp.status_code != 200:
            error = mp_client.error_text(resp)
            for item_id in ids:
                outbox.update(item_id, state="failed", error=error)
            return
        try:
            results = resp.json().get("results")
        except (ValueError, AttributeError):
            results = None
        by_id = {r.get("edit_id"): r for r in results or () if isinstance(r, dict)}
        for item, payload in zip(batch, edits):
            result = by_id.get(payload["edit_id"])
            if result is None:
                outbox.unsend([item["id"]])
                continue
            self._edit_result(outbox, base_url, item, payload, result)

    def _edit_result(self, outbox: Outbox, base_url: str, item: dict, payload: dict, result: dict) -> None:
        conflicts = [c for c in result.get("conflicts") or () if isinstance(c, dict)] or None
        if result.get("status") not in ("applied", "unchanged"):
            outbox.update(item["id"], state="failed", conflicts=conflicts,
                          error=str(result.get("error") or "rejected"), result=result)
            return
        now = self._clock()
        outbox.update(item["id"], state="done", done_at=now, conflicts=conflicts, result=result, error=None)
        ref = item["place_id"]
        entry = outbox.place(ref) or {"base": None, "hides": [], "synced_at": None}
        base = local.apply_edit(entry.get("base"), payload)
        if base is not None and isinstance(result.get("rev"), int):
            base["rev"] = result["rev"]
        # mivport's own view of the place (conflicts may have gone the other
        # way); keep the folded one when it cannot be had.
        try:
            feature, deleted = mp_client.fetch_place(self._http(), base_url, ref)
        except MivportError:
            feature, deleted = None, False
        fresh = normalize(feature) if feature is not None else None
        if fresh is not None:
            lon, lat, detail = fresh
            base = {**detail, "lon": lon, "lat": lat}
            if deleted:
                base["deleted"] = True
        osm = local.osm_ref((base or {}).get("osm"))
        hides = list(entry.get("hides") or ())
        if osm is not None and osm not in hides:
            hides.append(osm)
        outbox.put_place(ref, {**entry, "base": base, "hides": hides, "synced_at": now})

    # -- everything else ----------------------------------------------------------

    def _items(self, outbox: Outbox, kind: str, base_url: str, token: str) -> None:
        for item in outbox.items(kind=kind, states=("pending",)):
            if self._waits_for_create(outbox, item["place_id"]):
                continue
            outbox.mark_sending([item["id"]])
            item = outbox.get(item["id"])  # as frozen: see _edits
            if item is None or item["state"] != "sending":
                continue
            try:
                resp = self._send_item(kind, item, base_url, token)
                self._check(resp)
            except BaseException:
                outbox.unsend([item["id"]])
                raise
            if resp.status_code == 429:
                outbox.unsend([item["id"]])
                self.last_error = f"mivport: {mp_client.error_text(resp)}"
                return
            self._item_result(outbox, kind, item, resp)

    def _send_item(self, kind: str, item: dict, base_url: str, token: str) -> httpx.Response:
        payload, http = item["payload"], self._http()
        if kind == "review":
            return mp_client.send(http, "PUT", base_url, mp_client.place_path(item["place_id"], "/review"),
                                  token=token, json=payload)
        if kind == "review_delete":
            return mp_client.send(http, "DELETE", base_url, f"/v1/reviews/{payload['review_id']}", token=token)
        if kind == "photo":
            outbox = self._outbox()
            files = {
                part: (f"{part}.jpg", outbox.photo_path(item["id"], part).read_bytes(), "image/jpeg")
                for part in ("view", "thumb")
            }
            data = {k: str(v) for k, v in payload.items() if v is not None}
            return mp_client.send(http, "POST", base_url, mp_client.place_path(item["place_id"], "/photos"),
                                  token=token, files=files, data=data)
        if kind == "photo_delete":
            return mp_client.send(http, "DELETE", base_url, f"/v1/photos/{payload['photo_id']}", token=token)
        if kind == "removal":
            return mp_client.send(http, "POST", base_url, "/v1/removal-requests", token=token, json=payload)
        raise ValueError(kind)

    def _item_result(self, outbox: Outbox, kind: str, item: dict, resp: httpx.Response) -> None:
        status = resp.status_code
        ok = status in (200, 201, 204)
        if kind == "photo" and status == 409:
            ok = True  # already there: an earlier upload's answer got lost
        if kind == "removal" and status == 409:
            ok = True  # already asked
        if kind in ("review_delete", "photo_delete") and status == 404 and item["attempts"] > 1:
            # Sent before (``attempts`` counts this send): an earlier send
            # got through and its answer did not.
            ok = True
        if not ok:
            outbox.update(item["id"], state="failed", error=mp_client.error_text(resp))
            return
        result: Any = None
        if status in (200, 201):
            try:
                result = resp.json()
            except ValueError:
                result = None
        outbox.update(item["id"], state="done", done_at=self._clock(), error=None,
                      result=result if isinstance(result, dict) else None)

