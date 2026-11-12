# SPDX-License-Identifier: GPL-2.0-only
"""Marks on SignalK, mirrored in memory. The same posture as the route store
(:mod:`mivnav.features.route.store`): SignalK is the only place a mark
lives, a write the box did not take raises :class:`MarkStorageUnavailable`
(the API's 503) rather than queuing, and a read with the box down serves
the mirror. Last write wins — a mark is one point, there is nothing to merge.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from collections.abc import Callable
from typing import Any, Literal, Protocol, get_args

from pydantic import BaseModel, ConfigDict, Field, ValidationError

log = logging.getLogger(__name__)

MAX_NAME_LENGTH = 64
MAX_NOTE_LENGTH = 500
MAX_ID_LENGTH = 64
MAX_MARKS = 1000

#: The small fixed icon set. The frontend draws each one; a value it does not
#: know (a newer server, a hand-edited resource) falls back to ``pin``.
Icon = Literal["pin", "anchor", "danger", "fish", "star", "flag"]
ICONS: tuple[str, ...] = get_args(Icon)
DEFAULT_ICON: Icon = "pin"

# Same rule as route ids: a URL-safe path segment, ``:`` allowed so ids other
# apps minted (``urn:mrn:signalk:uuid:…``) can be read and written back.
_ID_RE = re.compile(r"^[A-Za-z0-9_:-]{1,%d}$" % MAX_ID_LENGTH)


class MarkError(Exception):
    """An invalid mark id or body."""


class MarkStorageUnavailable(Exception):
    """SignalK could not be reached or refused the read/write."""


class WaypointResources(Protocol):
    """The slice of SignalK's Resources API this store needs."""

    def list_waypoint_resources(self) -> dict[str, Any]: ...

    def put_waypoint_resource(self, waypoint_id: str, resource: dict[str, Any]) -> None: ...

    def delete_waypoint_resource(self, waypoint_id: str) -> bool: ...


class Mark(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    id: str
    name: str = Field(default="", max_length=MAX_NAME_LENGTH)
    note: str = Field(default="", max_length=MAX_NOTE_LENGTH)
    icon: Icon = DEFAULT_ICON
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    #: Server-set on save; 0 for a mark another app wrote without one.
    updated: float = 0.0


def validate_id(mark_id: str) -> str:
    mark_id = mark_id.strip()
    if not _ID_RE.match(mark_id):
        raise MarkError(
            "mark id must be 1-%d characters of [A-Za-z0-9_:-] (it is a URL "
            "path segment); mint a uuid" % MAX_ID_LENGTH
        )
    return mark_id


def parse_mark(mark_id: str, body: Any) -> Mark:
    """A validated :class:`Mark` from an untrusted body; the id is the path's."""
    mark_id = validate_id(mark_id)
    if not isinstance(body, dict):
        raise MarkError("a mark must be a JSON object")
    body = dict(body)
    given = body.pop("id", None)
    if given is not None and str(given).strip() != mark_id:
        raise MarkError(f"mark id in the body ({given!r}) does not match the path ({mark_id!r})")
    body.pop("updated", None)
    for key in ("name", "note"):
        if isinstance(body.get(key), str):
            body[key] = body[key].strip()
    try:
        return Mark(id=mark_id, **body)
    except ValidationError as e:
        err = e.errors()[0]
        where = ".".join(str(p) for p in err["loc"]) or "mark"
        raise MarkError(f"{where}: {err['msg']}") from e
    except TypeError as e:
        raise MarkError(f"invalid mark: {e}") from e


class MarkStore:
    """Marks on SignalK plus an in-memory mirror. Keeps each mark's raw
    resource too, so saving a mark another app placed keeps that app's own
    fields (``type``, its properties) instead of flattening them."""

    def __init__(self, resources: Callable[[], WaypointResources | None]) -> None:
        self._resources = resources
        self._lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._marks: dict[str, Mark] = {}
        self._raw: dict[str, dict[str, Any]] = {}

    def list(self) -> list[Mark]:
        with self._lock:
            return self._sorted()

    def get(self, mark_id: str) -> Mark | None:
        with self._lock:
            return self._marks.get(mark_id.strip())

    def _sorted(self) -> list[Mark]:
        return sorted(self._marks.values(), key=lambda m: (-m.updated, m.name.lower(), m.id))

    def refresh(self) -> list[Mark]:
        """Re-read every waypoint from SignalK. One that cannot be read as a
        mark is skipped, not fatal."""
        from mivnav.features.marks.wire import from_resource

        resources = self._require()
        try:
            listing = resources.list_waypoint_resources()
        except Exception as e:  # noqa: BLE001
            raise MarkStorageUnavailable(f"could not read the marks from SignalK: {e}") from e
        marks: dict[str, Mark] = {}
        raw: dict[str, dict[str, Any]] = {}
        for mark_id, resource in listing.items():
            mark = from_resource(str(mark_id), resource)
            if mark is not None:
                marks[mark.id] = mark
                raw[mark.id] = resource
        with self._lock:
            self._marks = marks
            self._raw = raw
            return self._sorted()

    def save(self, mark_id: str, body: Any) -> Mark:
        """Create or replace a mark on SignalK; the mirror changes only once
        the box has taken it."""
        from mivnav.features.marks.wire import to_resource

        mark = parse_mark(mark_id, body)
        resources = self._require()
        with self._write_lock:
            with self._lock:
                exists = mark.id in self._marks
                if not exists and len(self._marks) >= MAX_MARKS:
                    raise MarkError(f"at most {MAX_MARKS} marks")
                base = self._raw.get(mark.id)
            mark = mark.model_copy(update={"updated": time.time()})
            resource = to_resource(mark, base)
            try:
                resources.put_waypoint_resource(mark.id, resource)
            except Exception as e:  # noqa: BLE001
                raise MarkStorageUnavailable(
                    f"SignalK did not store mark {mark.id!r}, so it is NOT saved: {e}"
                ) from e
            with self._lock:
                self._marks[mark.id] = mark
                self._raw[mark.id] = resource
            return mark

    def delete(self, mark_id: str) -> bool:
        mark_id = validate_id(mark_id)
        resources = self._require()
        with self._write_lock:
            try:
                deleted = resources.delete_waypoint_resource(mark_id)
            except Exception as e:  # noqa: BLE001
                raise MarkStorageUnavailable(
                    f"SignalK did not delete mark {mark_id!r}, so it is NOT deleted: {e}"
                ) from e
            with self._lock:
                had_it = self._marks.pop(mark_id, None) is not None
                self._raw.pop(mark_id, None)
            return deleted or had_it

    def _require(self) -> WaypointResources:
        resources = self._resources()
        if resources is None:
            raise MarkStorageUnavailable(
                "SignalK is disabled in this server's configuration, and it is "
                "the only place marks are stored"
            )
        return resources
