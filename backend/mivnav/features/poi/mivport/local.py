# SPDX-License-Identifier: GPL-2.0-only
"""The local overlay: places changed on the boat, as the boat now sees them —
pure functions over the outbox's rows (``outbox.py``), no I/O.

A changed place has an *entry* (``{base, hides, synced_at}``): ``base`` is
the place as last known from mivport (the bake's stored detail, or mivport's
answer after an upload; ``None`` for a place created on the boat), ``hides``
the OSM refs now behind it. The place's *view* is ``base`` with every edit
still in the outbox (pending, sending or failed) applied on top, so
discarding an edit undoes it by construction.

The entry goes when a bake that started after its last upload has replaced
every set that still holds the old state (:func:`droppable`).
"""

from __future__ import annotations

import copy
import re
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from typing import Any

from .mapping import point_feature

OSM_REF_RE = re.compile(r"^osm:(?P<t>[nwr])(?P<id>[1-9][0-9]{0,18})$")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

OSM_TYPES = {"n": "node", "w": "way", "r": "relation"}

#: Outbox states that still change the boat's view of a place.
ACTIVE = ("pending", "sending", "failed")

#: The licence every mivport photo is published under.
PHOTO_LICENSE_URL = "https://creativecommons.org/licenses/by-sa/4.0/"


def osm_of(ref: str) -> dict | None:
    """``osm:w5`` → ``{"type": "way", "id": 5}``."""
    m = OSM_REF_RE.match(ref)
    return {"type": OSM_TYPES[m["t"]], "id": int(m["id"])} if m else None


def osm_ref(osm: Any) -> str | None:
    if isinstance(osm, dict) and osm.get("type") in ("node", "way", "relation") and isinstance(osm.get("id"), int):
        return f"osm:{osm['type'][0]}{osm['id']}"
    return None


def is_place_id(ref: str) -> bool:
    return bool(UUID_RE.match(ref) or OSM_REF_RE.match(ref))


# -- applying edits ----------------------------------------------------------


def apply_set(detail: dict, set_: dict) -> dict:
    """mivport's ``set`` on a stored-detail-shaped dict (``null`` removes)."""
    out = copy.deepcopy(detail)
    for key, value in set_.items():
        if key == "geom":
            if isinstance(value, dict):
                out["lat"], out["lon"] = float(value["lat"]), float(value["lon"])
            else:
                out.pop("lat", None)
                out.pop("lon", None)
        elif key == "attrs":
            attrs = dict(out.get("attrs") or {})
            for k, v in (value or {}).items():
                if v is None:
                    attrs.pop(k, None)
                else:
                    attrs[k] = v
            if attrs:
                out["attrs"] = attrs
            else:
                out.pop("attrs", None)
        elif key in ("kind", "name", "parent_id", "osm"):
            if value is None:
                out.pop(key, None)
            else:
                out[key] = value
    return out


def apply_edit(detail: dict | None, edit: dict) -> dict | None:
    """One outbox edit payload (``op``, ``place_id``, ``set``) applied."""
    op = edit.get("op")
    if op == "create":
        start = {**(detail or {}), "ref": edit["place_id"], "source": "core"}
        start.pop("deleted", None)
        start.pop("rev", None)
        return apply_set(start, edit.get("set") or {})
    if detail is None:
        return None
    if op == "modify":
        out = apply_set(detail, edit.get("set") or {})
        out.pop("deleted", None)  # a newer modify brings a deleted place back
        return out
    if op == "delete":
        return {**detail, "deleted": True}
    if op == "restore":
        out = dict(detail)
        out.pop("deleted", None)
        return out
    return detail


def merge_set(old: dict, new: dict, *, create: bool) -> dict:
    """Two ``set``s as one: fields replaced, ``attrs`` merged key by key. In
    a create a removed attribute is simply not sent."""
    out = dict(old)
    for key, value in new.items():
        if key == "attrs" and isinstance(value, dict):
            attrs = dict(out.get("attrs") or {})
            attrs.update(value)
            if create:
                attrs = {k: v for k, v in attrs.items() if v is not None}
            out["attrs"] = attrs
        elif create and value is None:
            out.pop(key, None)
        else:
            out[key] = value
    return out


# -- the view of one place ------------------------------------------------


def entry_state(states: Iterable[str]) -> str:
    """``pending`` while anything is to send, ``failed`` when mivport refused
    something still in the outbox, else ``synced``."""
    states = list(states)
    if any(s in ("pending", "sending") for s in states):
        return "pending"
    if "failed" in states:
        return "failed"
    return "synced"


def view(entry: dict, edits: Sequence[dict]) -> dict | None:
    """``entry.base`` with ``edits`` (outbox rows: ``payload``, ``state``)
    applied in order; ``None`` when there is nothing to show."""
    detail = copy.deepcopy(entry.get("base"))
    active = [e for e in edits if e["state"] in ACTIVE]
    for e in active:
        detail = apply_edit(detail, e["payload"])
    if detail is None:
        return None
    detail["local"] = entry_state(e["state"] for e in active)
    detail["deleted"] = bool(detail.get("deleted"))
    return detail


def feature(detail: dict) -> dict | None:
    """The overlay point: tile-shaped props plus ``local`` and ``deleted``;
    ``None`` for a deleted place or one with no known position."""
    if detail.get("deleted") or not isinstance(detail.get("lon"), (int, float)) or not isinstance(detail.get("lat"), (int, float)) or not detail.get("kind"):
        return None
    lon, lat, props = point_feature(detail["lon"], detail["lat"], detail)
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": {**props, "local": detail["local"], "deleted": False},
    }


def hide_refs(ref: str, entry: dict, detail: dict | None) -> list[str]:
    """What the baked layers must not draw for this entry: the place itself
    and the OSM refs behind it — but only when the overlay draws it instead
    (or it is deleted). A place the boat cannot draw (no position known: a
    bake from before details carried one) keeps its baked point."""
    if detail is None or not (detail.get("deleted") or feature(detail) is not None):
        return []
    return [*(entry.get("hides") or ()), ref]


# -- reviews and photos in a detail --------------------------------------


def merge_detail(
    stored: dict | None,
    place: dict | None,
    items: Sequence[dict],
    *,
    username: str,
    photo_url: Callable[[str, str], str],
) -> dict:
    """The details panel's view: the place fields from the local ``place``
    view when there is one (else ``stored``), the stored reviews and photos,
    and the outbox's reviews/photos for this place on top (``items``: rows
    with ``id``, ``kind``, ``state``, ``payload``, ``result``)."""
    out: dict[str, Any] = dict(place) if place is not None else dict(stored or {})
    reviews = [dict(r) for r in (stored or {}).get("reviews") or ()]
    photos = [dict(p) for p in (stored or {}).get("photos") or ()]
    for item in items:
        state = "synced" if item["state"] == "done" else ("failed" if item["state"] == "failed" else "pending")
        payload, result = item["payload"], item.get("result") or {}
        kind = item["kind"]
        if kind == "review":
            reviews = [r for r in reviews if r.get("user") != username]
            review = {"id": result.get("id") or item["id"], "stars": payload["stars"],
                      "user": username, "local": state}
            for key in ("body", "visited_on"):
                if payload.get(key):
                    review[key] = payload[key]
            review["created_at"] = item.get("created_iso", "")
            reviews.insert(0, review)
        elif kind == "review_delete":
            reviews = [r for r in reviews if r.get("id") != payload["review_id"]]
        elif kind == "photo":
            pid = result.get("id") if isinstance(result.get("id"), str) else item["id"]
            photos = [p for p in photos if p.get("id") != pid]
            photo = {
                "id": pid,
                "url": photo_url(item["id"], "view"),
                "thumb_url": photo_url(item["id"], "thumb"),
                "attribution": result.get("attribution") or f"© {username}, CC BY-SA 4.0",
                "license_url": result.get("license_url") or PHOTO_LICENSE_URL,
                "local": state,
            }
            for key in ("caption", "taken_at"):
                if payload.get(key):
                    photo[key] = payload[key]
            photos.append(photo)
        elif kind == "photo_delete":
            photos = [p for p in photos if p.get("id") != payload["photo_id"]]
    if reviews or "reviews" in out:
        out["reviews"] = reviews
    if photos or "photos" in out:
        out["photos"] = photos
    return out


# -- dropping entries after a bake ------------------------------------------


@dataclass(frozen=True)
class BakedSet:
    """One baked mivport set, as the drop rule needs it."""

    started_at: float  # 0 for a bake older than the field
    contains: Callable[[str], bool]


def droppable(ref: str, entry: dict, states: Iterable[str], sets: Sequence[BakedSet]) -> bool:
    """Whether a local entry can go: everything uploaded, no set baked
    before that upload still holds the place (or an OSM ref it hides), and
    a set baked after it shows the place (a deleted place needs none)."""
    synced_at = entry.get("synced_at")
    if not isinstance(synced_at, (int, float)) or entry_state(states) != "synced":
        return False
    refs = [ref, *(entry.get("hides") or ())]
    if any(s.started_at <= synced_at and any(s.contains(r) for r in refs) for s in sets):
        return False
    base = entry.get("base") or {}
    if base.get("deleted"):
        return True
    return any(s.started_at > synced_at and s.contains(ref) for s in sets)
