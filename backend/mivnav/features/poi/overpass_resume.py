# SPDX-License-Identifier: GPL-2.0-only
"""The tiled Overpass fetch's resume file: the tiles a FAILED bake already
fetched, kept beside the set so the next bake of the same dataset fetches
only the missing ones. See docs/architecture/poi-overpass-fetch.md
("Resume").

One JSON file per set, ``<set_id>.overpass-resume.json`` in the set's own
folder, written atomically (temp file + rename) and only when a bake fails.
It is keyed by a hash of every tile's full Overpass query — so the region
box, the tile grid and the selector set (the query "version") are all in
it: any change there and the file simply doesn't match. Each tile keeps
the time it was fetched, and a tile older than :data:`RESUME_MAX_AGE_S`
is fetched again. A missing, corrupt, foreign or stale file reads as
"nothing to resume" and is replaced by the next failure, removed by the
next successful publish.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
from collections.abc import Mapping, Sequence
from pathlib import Path

log = logging.getLogger(__name__)

#: Bump when the file layout changes; an older file then reads as empty.
RESUME_FORMAT = 1
#: A tile fetched longer ago than this is fetched again: OSM moves on, and a
#: bake that failed yesterday is not "the previous attempt" any more.
RESUME_MAX_AGE_S = 6 * 3600.0

#: ``tile index -> (fetched_at, elements)``.
Tiles = dict[int, tuple[float, list[dict]]]


def resume_path(root: Path, set_id: str) -> Path:
    return root / f"{set_id}.overpass-resume.json"


def grid_key(queries: Sequence[str]) -> str:
    """The identity of one tiled fetch: every tile's query, in order."""
    h = hashlib.sha256()
    for q in queries:
        h.update(q.encode())
        h.update(b"\0")
    return h.hexdigest()


def load(path: Path, key: str, n_tiles: int, now: float,
         max_age_s: float = RESUME_MAX_AGE_S) -> Tiles:
    """The still-fresh tiles a previous failed attempt left for THIS fetch
    (``key``), or ``{}``. Never raises: an unreadable file is logged and
    ignored (the next failure overwrites it)."""
    try:
        raw = path.read_text()
    except FileNotFoundError:
        return {}
    except OSError as e:
        log.warning("ignoring unreadable Overpass resume file %s: %s", path, e)
        return {}
    try:
        doc = json.loads(raw)
        if doc.get("format") != RESUME_FORMAT or doc.get("key") != key:
            return {}
        out: Tiles = {}
        for idx, tile in doc["tiles"].items():
            i = int(idx)
            fetched_at = float(tile["fetched_at"])
            elements = tile["elements"]
            if not (0 <= i < n_tiles) or not isinstance(elements, list):
                continue
            if now - fetched_at > max_age_s or fetched_at > now + 60:
                continue  # stale (or from the future: a clock jump)
            out[i] = (fetched_at, elements)
        return out
    except (ValueError, TypeError, KeyError, AttributeError) as e:
        log.warning("ignoring corrupt Overpass resume file %s: %s", path, e)
        return {}


def save(path: Path, key: str, tiles: Mapping[int, tuple[float, list[dict]]]) -> None:
    """Write ``tiles`` atomically (temp file in the same dir + rename), so a
    crash mid-write leaves the old file or none, never half of one."""
    doc = {
        "format": RESUME_FORMAT,
        "key": key,
        "tiles": {
            str(i): {"fetched_at": at, "elements": elements}
            for i, (at, elements) in sorted(tiles.items())
        },
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(doc, f, separators=(",", ":"))
        os.chmod(tmp, 0o644)  # mkstemp's 0600; nothing secret in here
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def remove(path: Path) -> None:
    path.unlink(missing_ok=True)
