# SPDX-License-Identifier: GPL-2.0-only
"""A baked mivport set's offline files, beside ``<set_id>.pmtiles``:

- ``<set_id>.mivport.sqlite`` — one JSON detail per place (attributes,
  reviews, photo records) plus the data attribution. Every bake gets the
  whole region in one go (the export), so the file is written whole, to a
  temp name, and renamed over the old one: a reader never sees half a bake.
- ``<set_id>.mivport-photos/`` — ``<photo uuid>.view.jpg`` and ``.thumb.jpg``.

The routes only ever read these (the boat has no internet at sea).
"""

from __future__ import annotations

import json
import logging
import re
import shutil
import sqlite3
from collections.abc import Iterable
from pathlib import Path

log = logging.getLogger(__name__)

DETAILS_SUFFIX = ".mivport.sqlite"
PHOTOS_SUFFIX = ".mivport-photos"

#: The only photo names stored and served: a uuid + the part + ``.jpg``.
PHOTO_NAME_RE = re.compile(
    r"^(?P<id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"
    r"\.(?P<part>view|thumb)\.jpg$"
)
PHOTO_PARTS = ("view", "thumb")

_TIMEOUT_S = 5.0


def details_path(dataset_dir: Path, set_id: str) -> Path:
    return dataset_dir / f"{set_id}{DETAILS_SUFFIX}"


def photos_dir(dataset_dir: Path, set_id: str) -> Path:
    return dataset_dir / f"{set_id}{PHOTOS_SUFFIX}"


def photo_name(photo_id: str, part: str) -> str:
    return f"{photo_id}.{part}.jpg"


def extra_files(dataset_dir: Path, set_id: str) -> list[Path]:
    details = details_path(dataset_dir, set_id)
    return [
        details,
        Path(f"{details}.part"),
        Path(f"{details}-journal"),
        photos_dir(dataset_dir, set_id),
    ]


def write_details(path: Path, details: Iterable[dict], meta: dict[str, str]) -> int:
    """Replace the details file with ``details`` (keyed by their ``ref``)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    part = Path(f"{path}.part")
    part.unlink(missing_ok=True)
    db = sqlite3.connect(part)
    try:
        db.execute("CREATE TABLE details (ref TEXT PRIMARY KEY, json TEXT NOT NULL)")
        db.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        db.executemany(
            "INSERT OR REPLACE INTO details (ref, json) VALUES (?, ?)",
            ((d["ref"], json.dumps(d, separators=(",", ":"), ensure_ascii=False)) for d in details),
        )
        db.executemany("INSERT INTO meta (key, value) VALUES (?, ?)", meta.items())
        db.commit()
        count = db.execute("SELECT COUNT(*) FROM details").fetchone()[0]
    finally:
        db.close()
    part.replace(path)
    return count


def _open_ro(path: Path) -> sqlite3.Connection | None:
    if not path.is_file():
        return None
    try:
        return sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True, timeout=_TIMEOUT_S)
    except sqlite3.Error as e:
        log.warning("cannot open mivport details %s: %s", path, e)
        return None


def read_detail(path: Path, ref: str) -> tuple[dict, dict[str, str]] | None:
    """One stored detail and the file's meta, or ``None``."""
    db = _open_ro(path)
    if db is None:
        return None
    try:
        row = db.execute("SELECT json FROM details WHERE ref = ?", (ref,)).fetchone()
        meta = dict(db.execute("SELECT key, value FROM meta").fetchall()) if row else {}
    except sqlite3.Error as e:
        log.warning("cannot read mivport details %s: %s", path, e)
        return None
    finally:
        db.close()
    return (json.loads(row[0]), meta) if row is not None else None


def read_meta(path: Path) -> dict[str, str]:
    """The details file's meta (attribution, ``fetched_at``, ``started_at``)."""
    db = _open_ro(path)
    if db is None:
        return {}
    try:
        return dict(db.execute("SELECT key, value FROM meta").fetchall())
    except sqlite3.Error as e:
        log.warning("cannot read mivport details %s: %s", path, e)
        return {}
    finally:
        db.close()


def has_ref(path: Path, ref: str) -> bool:
    db = _open_ro(path)
    if db is None:
        return False
    try:
        return db.execute("SELECT 1 FROM details WHERE ref = ?", (ref,)).fetchone() is not None
    except sqlite3.Error:
        return False
    finally:
        db.close()


def read_all(path: Path) -> dict[str, dict]:
    """Every stored detail by ref (the photo pass and tests)."""
    db = _open_ro(path)
    if db is None:
        return {}
    try:
        return {ref: json.loads(raw) for ref, raw in db.execute("SELECT ref, json FROM details")}
    finally:
        db.close()


def remove_photos(dataset_dir: Path, set_id: str) -> None:
    shutil.rmtree(photos_dir(dataset_dir, set_id), ignore_errors=True)


def store_photo(directory: Path, name: str, body: bytes) -> None:
    """Atomically (``.part`` + rename): never half a file on disk."""
    directory.mkdir(parents=True, exist_ok=True)
    part = directory / f"{name}.part"
    part.write_bytes(body)
    part.replace(directory / name)


def local_photo_url(set_id: str, name: str) -> str:
    """Relative to the API root, like the catalog's ``tiles``."""
    return f"/poi/mivport/photos/{set_id}/{name}"


def with_local_photos(detail: dict, directory: Path | None, set_id: str) -> dict:
    """``detail`` with each photo the bake downloaded pointed at the boat's
    copy; a photo not on disk keeps its remote URLs and gets ``remote``."""
    photos = detail.get("photos")
    if not photos:
        return detail
    have = directory is not None and directory.is_dir()
    out = []
    for photo in photos:
        pid = photo.get("id")
        names = {part: photo_name(pid, part) for part in PHOTO_PARTS} if isinstance(pid, str) else {}
        if have and names and all((directory / n).is_file() for n in names.values()):  # type: ignore[operator]
            out.append({
                **photo,
                "url": local_photo_url(set_id, names["view"]),
                "thumb_url": local_photo_url(set_id, names["thumb"]),
            })
        else:
            out.append({**photo, "remote": True})
    return {**detail, "photos": out}
