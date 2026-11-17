# SPDX-License-Identifier: GPL-2.0-only
"""The outbox: every mivport write made on the boat, kept until mivport has
it (``data_root/mivport/outbox.sqlite``, photo files in ``outbox-photos/``),
and the local place entries those writes produce (see :mod:`.local`).

Item kinds, in upload order (``sync.py``): ``edit`` (one ``/v1/edits``
edit), ``review``, ``review_delete``, ``photo``, ``photo_delete``,
``removal``. States: ``pending`` → ``sending`` → ``done`` | ``failed``
(mivport refused it; kept, with its ``error``, until the skipper discards
it) — back to ``pending`` when the upload did not get through.

Queueing rules (docs/architecture/mivport-editing.md, "Decisions"):

- one pending place edit per place: a ``modify`` is merged into the place's
  pending, never-sent ``create`` or ``modify`` (``set`` fields replaced,
  ``attrs`` key by key, ``made_at`` the newest). An item that was sent once
  is frozen — resending it must send the same ``edit_id`` and body — so a
  later edit becomes a new item behind it;
- editing an OSM-only place (``osm:n123``) is a ``create`` with a new uuid
  and ``set.osm``; the OSM ref is hidden behind the new place from then on,
  and later writes to the OSM ref go to the new place;
- a never-sent ``delete`` and ``restore`` of one place cancel out, and a
  ``delete`` of a never-sent ``create`` cancels the create;
- a second review of a place replaces a never-sent first one;
- deleting a review or photo that is still in the outbox discards it.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
import uuid
from collections.abc import Callable, Iterable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import local

log = logging.getLogger(__name__)

KINDS = ("edit", "review", "review_delete", "photo", "photo_delete", "removal")
STATES = ("pending", "sending", "failed", "done")

#: ``done`` items are kept this long, for the "uploaded" list and so the
#: boat keeps showing its own reviews and photos until a bake has them.
DONE_KEEP_S = 7 * 86400.0

PHOTO_PARTS = ("view", "thumb")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    place_id TEXT,
    payload TEXT NOT NULL,
    summary TEXT NOT NULL,
    state TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL,
    done_at REAL,
    error TEXT,
    conflicts TEXT,
    result TEXT
);
CREATE INDEX IF NOT EXISTS items_place ON items (place_id);
CREATE TABLE IF NOT EXISTS places (ref TEXT PRIMARY KEY, json TEXT NOT NULL);
"""


class OutboxError(Exception):
    """A write the outbox cannot take (the route answers 400/404/409)."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


def iso(ts: float) -> str:
    """RFC 3339 UTC, what mivport's ``made_at`` takes."""
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _dumps(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def _new_id() -> str:
    return str(uuid.uuid4())


class Outbox:
    """One outbox directory. Thread-safe: every method takes the lock, and
    each public write is one SQLite transaction."""

    def __init__(self, directory: Path, clock: Callable[[], float] = time.time) -> None:
        self.dir = Path(directory)
        self.path = self.dir / "outbox.sqlite"
        self.photos = self.dir / "outbox-photos"
        self._clock = clock
        self._lock = threading.RLock()
        self._db: sqlite3.Connection | None = None

    # -- plumbing ---------------------------------------------------------------

    def exists(self) -> bool:
        """Whether anything was ever queued (nothing is created before)."""
        return self.path.is_file()

    def _conn(self) -> sqlite3.Connection:
        if self._db is None:
            self.dir.mkdir(parents=True, exist_ok=True)
            db = sqlite3.connect(self.path, check_same_thread=False, timeout=10.0, isolation_level=None)
            db.row_factory = sqlite3.Row
            db.executescript(_SCHEMA)
            self._db = db
        return self._db

    def close(self) -> None:
        with self._lock:
            if self._db is not None:
                self._db.close()
                self._db = None

    def _tx(self):
        outbox = self

        class _Tx:
            def __enter__(self) -> sqlite3.Connection:
                outbox._lock.acquire()
                db = outbox._conn()
                db.execute("BEGIN IMMEDIATE")
                self.db = db
                return db

            def __exit__(self, exc_type, *_: object) -> None:
                try:
                    self.db.execute("ROLLBACK" if exc_type else "COMMIT")
                finally:
                    outbox._lock.release()

        return _Tx()

    @staticmethod
    def _row(row: sqlite3.Row) -> dict:
        item = dict(row)
        item["payload"] = json.loads(item["payload"])
        item["conflicts"] = json.loads(item["conflicts"]) if item["conflicts"] else None
        item["result"] = json.loads(item["result"]) if item["result"] else None
        item["created_iso"] = iso(item["created_at"])
        return item

    # -- reading ------------------------------------------------------------------

    def items(
        self,
        *,
        kind: str | None = None,
        states: Iterable[str] | None = None,
        place_ids: Iterable[str] | None = None,
    ) -> list[dict]:
        """Items oldest first, filtered."""
        if not self.exists():
            return []
        sql, args = "SELECT * FROM items WHERE 1=1", []
        if kind is not None:
            sql += " AND kind = ?"
            args.append(kind)
        if states is not None:
            states = list(states)
            sql += f" AND state IN ({','.join('?' * len(states))})"
            args.extend(states)
        if place_ids is not None:
            place_ids = list(place_ids)
            sql += f" AND place_id IN ({','.join('?' * len(place_ids))})"
            args.extend(place_ids)
        with self._lock:
            rows = self._conn().execute(sql + " ORDER BY seq", args).fetchall()
        return [self._row(r) for r in rows]

    def get(self, item_id: str) -> dict | None:
        if not self.exists():
            return None
        with self._lock:
            row = self._conn().execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
        return self._row(row) if row is not None else None

    def counts(self) -> dict[str, int]:
        if not self.exists():
            return {"pending": 0, "failed": 0}
        with self._lock:
            rows = dict(self._conn().execute("SELECT state, COUNT(*) FROM items GROUP BY state").fetchall())
        return {"pending": rows.get("pending", 0) + rows.get("sending", 0), "failed": rows.get("failed", 0)}

    def has_pending(self) -> bool:
        return self.counts()["pending"] > 0

    def places(self) -> dict[str, dict]:
        if not self.exists():
            return {}
        with self._lock:
            rows = self._conn().execute("SELECT ref, json FROM places").fetchall()
        return {ref: json.loads(raw) for ref, raw in rows}

    def place(self, ref: str) -> dict | None:
        if not self.exists():
            return None
        with self._lock:
            row = self._conn().execute("SELECT json FROM places WHERE ref = ?", (ref,)).fetchone()
        return json.loads(row[0]) if row is not None else None

    def alias(self, ref: str) -> str:
        """The place an OSM ref now lives behind on the boat, else ``ref``."""
        if not local.OSM_REF_RE.match(ref):
            return ref
        for key, entry in self.places().items():
            if ref in (entry.get("hides") or ()):
                return key
        return ref

    def aliases(self, ref: str) -> set[str]:
        """Every ref that names the same place on the boat."""
        key = self.alias(ref)
        entry = self.place(key)
        return {ref, key, *((entry or {}).get("hides") or ())}

    # -- photo files ------------------------------------------------------------

    def photo_path(self, item_id: str, part: str) -> Path:
        return self.photos / f"{item_id}.{part}.jpg"

    def _remove_photo_files(self, item_id: str) -> None:
        for part in PHOTO_PARTS:
            self.photo_path(item_id, part).unlink(missing_ok=True)

    # -- low-level writes (the sync pass) ---------------------------------------

    def update(self, item_id: str, **fields: Any) -> None:
        for key in ("payload", "conflicts", "result"):
            if key in fields and fields[key] is not None:
                fields[key] = _dumps(fields[key])
        cols = ", ".join(f"{k} = ?" for k in fields)
        with self._tx() as db:
            db.execute(f"UPDATE items SET {cols} WHERE id = ?", (*fields.values(), item_id))

    def mark_sending(self, item_ids: Iterable[str]) -> None:
        """Before a request: frozen from now on (``attempts`` > 0)."""
        with self._tx() as db:
            for item_id in item_ids:
                db.execute("UPDATE items SET state = 'sending', attempts = attempts + 1 WHERE id = ?", (item_id,))

    def unsend(self, item_ids: Iterable[str]) -> None:
        """The request did not get through: pending again."""
        with self._tx() as db:
            for item_id in item_ids:
                db.execute("UPDATE items SET state = 'pending' WHERE id = ? AND state = 'sending'", (item_id,))

    def reset_sending(self) -> None:
        """At start: whatever was in flight when the process died is pending."""
        if self.exists():
            with self._tx() as db:
                db.execute("UPDATE items SET state = 'pending' WHERE state = 'sending'")

    def put_place(self, ref: str, entry: dict) -> None:
        with self._tx() as db:
            db.execute("INSERT OR REPLACE INTO places (ref, json) VALUES (?, ?)", (ref, _dumps(entry)))

    def drop_place(self, ref: str) -> None:
        with self._tx() as db:
            db.execute("DELETE FROM places WHERE ref = ?", (ref,))

    def purge_done(self) -> int:
        """Forget ``done`` items older than :data:`DONE_KEEP_S`."""
        if not self.exists():
            return 0
        cutoff = self._clock() - DONE_KEEP_S
        with self._tx() as db:
            ids = [r[0] for r in db.execute(
                "SELECT id FROM items WHERE state = 'done' AND done_at < ?", (cutoff,))]
            db.executemany("DELETE FROM items WHERE id = ?", ((i,) for i in ids))
        for item_id in ids:
            self._remove_photo_files(item_id)
        return len(ids)

    # -- queueing ---------------------------------------------------------------

    def _insert(self, db: sqlite3.Connection, kind: str, place_id: str | None, payload: dict, summary: str) -> str:
        item_id = _new_id()
        db.execute(
            "INSERT INTO items (id, kind, place_id, payload, summary, state, created_at) "
            "VALUES (?, ?, ?, ?, ?, 'pending', ?)",
            (item_id, kind, place_id, _dumps(payload), summary, self._clock()),
        )
        return item_id

    def _place_in(self, db: sqlite3.Connection, ref: str) -> dict | None:
        row = db.execute("SELECT json FROM places WHERE ref = ?", (ref,)).fetchone()
        return json.loads(row[0]) if row is not None else None

    def _put_in(self, db: sqlite3.Connection, ref: str, entry: dict) -> None:
        db.execute("INSERT OR REPLACE INTO places (ref, json) VALUES (?, ?)", (ref, _dumps(entry)))

    def _open_edit(self, db: sqlite3.Connection, ref: str) -> dict | None:
        """The place's last edit if it is still pending and never sent."""
        row = db.execute(
            "SELECT * FROM items WHERE kind = 'edit' AND place_id = ? ORDER BY seq DESC LIMIT 1", (ref,)
        ).fetchone()
        if row is None or row["state"] != "pending" or row["attempts"] > 0:
            return None
        return self._row(row)

    def _alias_in(self, db: sqlite3.Connection, ref: str) -> str:
        if not local.OSM_REF_RE.match(ref):
            return ref
        for key, raw in db.execute("SELECT ref, json FROM places"):
            if ref in (json.loads(raw).get("hides") or ()):
                return key
        return ref

    def _discard_in(self, db: sqlite3.Connection, item: dict) -> list[str]:
        """Remove ``item``; a never-uploaded create takes the place's entry
        and everything else queued for that place with it."""
        gone = [item["id"]]
        db.execute("DELETE FROM items WHERE id = ?", (item["id"],))
        ref = item["place_id"]
        if item["kind"] == "edit" and ref is not None:
            entry = self._place_in(db, ref)
            if entry is not None and item["payload"].get("op") == "create" and entry.get("synced_at") is None:
                for row in db.execute("SELECT id FROM items WHERE place_id = ? AND state != 'done'", (ref,)).fetchall():
                    gone.append(row[0])
                db.execute("DELETE FROM items WHERE place_id = ? AND state != 'done'", (ref,))
                db.execute("DELETE FROM places WHERE ref = ?", (ref,))
            elif entry is not None and entry.get("synced_at") is None:
                left = db.execute("SELECT COUNT(*) FROM items WHERE kind = 'edit' AND place_id = ?", (ref,)).fetchone()[0]
                if not left:
                    db.execute("DELETE FROM places WHERE ref = ?", (ref,))
        return gone

    def discard(self, item_id: str) -> list[str]:
        """Discard a pending or failed item and undo its local effect.
        Returns every item id removed."""
        with self._tx() as db:
            row = db.execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
            if row is None:
                raise OutboxError(404, "no such outbox item")
            item = self._row(row)
            if item["state"] not in ("pending", "failed"):
                raise OutboxError(409, f"the item is {item['state']}")
            gone = self._discard_in(db, item)
        for gid in gone:
            self._remove_photo_files(gid)
        return gone

    def queue_edit(
        self,
        op: str,
        place_id: str | None,
        base_rev: int | None,
        set_: dict | None,
        stored: dict | None,
        summary_name: str = "",
    ) -> tuple[str, str | None]:
        """Queue one place edit → ``(place_id, item_id)``; ``item_id`` is
        ``None`` when the edit cancelled a never-sent one (see the module
        docstring). ``stored`` is the place as the bake stored it (with
        ``lon``/``lat``), the base of a new local entry."""
        now = self._clock()
        set_ = dict(set_ or {})
        with self._tx() as db:
            if op == "create":
                ref = place_id or _new_id()
                if self._place_in(db, ref) is not None:
                    raise OutboxError(409, f"place {ref} is already queued")
                set_ = {k: v for k, v in set_.items() if v is not None}
                if "attrs" in set_:
                    set_["attrs"] = {k: v for k, v in set_["attrs"].items() if v is not None}
                payload = {"edit_id": _new_id(), "op": "create", "place_id": ref,
                           "made_at": iso(now), "set": set_}
                item_id = self._insert(db, "edit", ref, payload, _summary(payload, summary_name))
                self._put_in(db, ref, {"base": None, "hides": [], "synced_at": None})
                return ref, item_id

            assert place_id is not None
            ref = self._alias_in(db, place_id)
            osm = local.osm_of(ref)
            if osm is not None:
                if op != "modify":
                    raise OutboxError(400, f"{op} needs one of mivport's own places; "
                                           "an OSM-only place can only be edited or reported")
                # Editing an OSM-only place: a create linked to it.
                kind = set_.get("kind") or (stored or {}).get("kind")
                if not kind:
                    raise OutboxError(400, "set.kind is required to edit a place not stored on the boat")
                new_ref = _new_id()
                cset = {k: v for k, v in {**set_, "kind": kind, "osm": osm}.items() if v is not None}
                if "attrs" in cset:
                    cset["attrs"] = {k: v for k, v in cset["attrs"].items() if v is not None}
                payload = {"edit_id": _new_id(), "op": "create", "place_id": new_ref,
                           "made_at": iso(now), "set": cset}
                name = summary_name or (stored or {}).get("name", "")
                item_id = self._insert(db, "edit", new_ref, payload, _summary(payload, name, edit_of_osm=True))
                base = None
                if stored is not None:
                    base = {k: v for k, v in stored.items() if k not in ("reviews", "photos")}
                self._put_in(db, new_ref, {"base": base, "hides": [ref], "synced_at": None})
                return new_ref, item_id

            entry = self._place_in(db, ref)
            if entry is None:
                base = {k: v for k, v in stored.items() if k not in ("reviews", "photos")} if stored else None
                entry = {"base": base, "hides": [], "synced_at": None}
                self._put_in(db, ref, entry)
            name = summary_name or _name_of(entry, stored)
            open_ = self._open_edit(db, ref)
            if open_ is not None:
                prev = open_["payload"]
                if op == "modify" and prev["op"] in ("create", "modify"):
                    merged = {**prev, "made_at": iso(now),
                              "set": local.merge_set(prev.get("set") or {}, set_, create=prev["op"] == "create")}
                    db.execute("UPDATE items SET payload = ?, summary = ? WHERE id = ?",
                               (_dumps(merged), _summary(merged, name), open_["id"]))
                    return ref, open_["id"]
                if {op, prev["op"]} == {"delete", "restore"} or (op == "delete" and prev["op"] == "create"):
                    for gid in self._discard_in(db, open_):
                        self._remove_photo_files(gid)
                    return ref, None
            payload = {"edit_id": _new_id(), "op": op, "place_id": ref, "made_at": iso(now)}
            if base_rev is not None:
                payload["base_rev"] = base_rev
            if op == "modify":
                payload["set"] = set_
            item_id = self._insert(db, "edit", ref, payload, _summary(payload, name))
            return ref, item_id

    def queue_review(self, place_id: str, review: dict, summary_name: str = "") -> str:
        with self._tx() as db:
            ref = self._alias_in(db, place_id)
            for row in db.execute(
                "SELECT id FROM items WHERE kind = 'review' AND place_id = ? AND state = 'pending' AND attempts = 0",
                (ref,),
            ).fetchall():
                db.execute("DELETE FROM items WHERE id = ?", (row[0],))
            summary = f"Review {'★' * int(review['stars'])}" + (f" of {summary_name}" if summary_name else "")
            return self._insert(db, "review", ref, review, summary)

    def queue_review_delete(self, review_id: str, place_id: str | None = None) -> str | None:
        """``None``: it was a review still in the outbox, now discarded."""
        with self._tx() as db:
            row = db.execute("SELECT * FROM items WHERE id = ? AND kind = 'review'", (review_id,)).fetchone()
            if row is not None and row["state"] in ("pending", "failed"):
                self._discard_in(db, self._row(row))
                return None
            return self._insert(db, "review_delete", place_id, {"review_id": review_id}, "Remove a review")

    def queue_photo(self, place_id: str, fields: dict, view: bytes, thumb: bytes, summary_name: str = "") -> str:
        with self._tx() as db:
            ref = self._alias_in(db, place_id)
            item_id = self._insert(db, "photo", ref, fields,
                                   "Photo" + (f" of {summary_name}" if summary_name else ""))
            self.photos.mkdir(parents=True, exist_ok=True)
            for part, body in (("view", view), ("thumb", thumb)):
                tmp = self.photo_path(item_id, part).with_suffix(".part")
                tmp.write_bytes(body)
                tmp.replace(self.photo_path(item_id, part))
            return item_id

    def queue_photo_delete(self, photo_id: str) -> str | None:
        """``photo_id`` is mivport's, or the item id of a photo queued on the
        boat. ``None``: it was still in the outbox, now discarded."""
        with self._tx() as db:
            row = db.execute("SELECT * FROM items WHERE id = ? AND kind = 'photo'", (photo_id,)).fetchone()
            item = self._row(row) if row is not None else None
            if item is not None and item["state"] in ("pending", "failed"):
                self._discard_in(db, item)
                gone = photo_id
            else:
                gone = None
                place = None
                if item is not None:  # uploaded from the boat: mivport's id
                    place = item["place_id"]
                    photo_id = (item["result"] or {}).get("id") or photo_id
                item_id = self._insert(db, "photo_delete", place, {"photo_id": photo_id}, "Remove a photo")
        if gone is not None:
            self._remove_photo_files(gone)
            return None
        return item_id

    def queue_removal(self, target_type: str, target_id: str, reason: str) -> str:
        with self._tx() as db:
            target = self._alias_in(db, target_id) if target_type == "place" else target_id
            place = target if target_type == "place" else None
            return self._insert(db, "removal", place,
                                {"target_type": target_type, "target_id": target, "reason": reason},
                                f"Ask to remove a {target_type}")


def _name_of(entry: dict | None, stored: dict | None) -> str:
    base = (entry or {}).get("base") or stored or {}
    return str(base.get("name") or base.get("kind") or "")


def _summary(payload: dict, name: str, *, edit_of_osm: bool = False) -> str:
    op = payload["op"]
    set_ = payload.get("set") or {}
    name = str(set_.get("name") or name or set_.get("kind") or "a place")
    if op == "create" and not edit_of_osm and "osm" not in set_:
        return f"New {set_.get('kind', 'place')}: {name}"
    if op in ("create", "modify"):
        fields = [k for k in set_ if k not in ("attrs", "osm")]
        fields += [f"attrs.{k}" for k in (set_.get("attrs") or {})]
        return f"Edit {name}" + (f": {', '.join(fields)}" if fields else "")
    return f"{'Delete' if op == 'delete' else 'Restore'} {name}"

