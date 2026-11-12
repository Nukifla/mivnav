# SPDX-License-Identifier: GPL-2.0-only
"""Buddy persistence: two files, because they change at different rates.

``~/.config/mivnav/buddies.json`` is the list the skipper edits.
``$XDG_STATE_HOME/mivnav/buddy-positions.json`` is last-known positions,
rewritten as they arrive and rebuildable from the sources, so it is state,
not config. A corrupt positions file costs history, never the list.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from mivnav.config.model import config_home

log = logging.getLogger(__name__)


@dataclass
class Buddy:
    """Identified by ``id``, never by MMSI: a boat tracked only by another
    source has none. ``mmsi`` is the first identifier; another source adds a
    field here and a provider."""

    id: str
    nickname: str | None = None
    note: str | None = None
    mmsi: str | None = None


def default_list_path() -> Path:
    return config_home() / "buddies.json"


def default_positions_path() -> Path:
    state_home = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state"))
    return state_home / "mivnav" / "buddy-positions.json"


def _atomic_write(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            json.dump(payload, out, indent=2)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def read_buddies(path: Path) -> list[Buddy]:
    """The list. A corrupt file RAISES: treating it as empty would let the
    next add overwrite the skipper's list with one entry."""
    if not path.exists():
        return []
    raw = json.loads(path.read_text(encoding="utf-8"))
    return [
        # `name` is what the field was called before it became `nickname`.
        Buddy(
            id=str(b["id"]),
            nickname=b.get("nickname", b.get("name")),
            note=b.get("note"),
            mmsi=b.get("mmsi"),
        )
        for b in raw["buddies"]
    ]


def write_buddies(path: Path, buddies: list[Buddy]) -> None:
    _atomic_write(path, {"buddies": [b.__dict__ for b in buddies]})


def read_positions(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        log.exception("buddy positions at %s unreadable; starting empty", path)
        return {}
    return raw if isinstance(raw, dict) else {}


def write_positions(path: Path, positions: dict[str, Any]) -> None:
    _atomic_write(path, positions)
