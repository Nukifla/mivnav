# SPDX-License-Identifier: GPL-2.0-only
"""Reading the theme JSON — the built-in set, the user's overrides on top,
and the two rendered responses with their content-derived ETags.

Not a ``Derived``: themes are files, not a config slice, so this store
caches a snapshot and re-reads only when a cheap directory stat-stamp moves.
A malformed override is a warning, not a 500. See
docs/architecture/themes-store.md.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
from dataclasses import dataclass
from pathlib import Path

from mivnav.config.model import config_home
from mivnav.features.themes.css import render_css

log = logging.getLogger(__name__)

BUILTIN_DIR = Path(__file__).parent / "data"

# A theme with no `order` sorts after every shipped one, then by id. Only a
# hand-written file can be in that position — `gen/dump_themes.mjs` always
# writes the frontend's own THEMES index.
_UNORDERED = 10_000


def user_theme_dir() -> Path:
    """``~/.config/mivnav/themes/`` — where a hand-retuned palette lives.

    Resolved on every call rather than captured at import: ``config_home()``
    reads ``XDG_CONFIG_HOME`` at call time (see :mod:`mivnav.config.model`),
    and a module-level constant would freeze whatever the environment said
    when the first import happened — which would make this directory
    untestable and would silently ignore an XDG change.
    """
    return config_home() / "themes"


@dataclass(frozen=True)
class ThemeSnapshot:
    """One consistent read of the theme files: the parsed themes in display
    order, and both rendered responses with their ETags. Everything a request
    needs is precomputed here, so serving is a dict lookup."""

    themes: tuple[dict, ...]
    json_bytes: bytes
    json_etag: str
    css_text: str
    css_etag: str

    @property
    def ids(self) -> tuple[str, ...]:
        return tuple(t["id"] for t in self.themes)


def _etag(payload: bytes) -> str:
    return f'"{hashlib.sha256(payload).hexdigest()[:16]}"'


def _scan(directory: Path) -> dict[str, os.stat_result]:
    """``{theme id: stat}`` for every ``*.json`` in one directory. A missing
    directory is empty, not an error — the user override dir usually does not
    exist, and the built-in one not existing is a broken install that the
    caller will notice as "no themes" rather than a traceback per request."""
    try:
        entries = list(os.scandir(directory))
    except OSError:
        return {}
    return {e.name[:-5]: e.stat() for e in entries if e.is_file() and e.name.endswith(".json")}


class ThemeStore:
    """The live theme set. Call :meth:`snapshot` per request; it re-reads only
    when the files moved."""

    def __init__(self, builtin_dir: Path = BUILTIN_DIR) -> None:
        self._builtin_dir = builtin_dir
        self._lock = threading.Lock()
        self._stamp: tuple | None = None
        self._snapshot: ThemeSnapshot | None = None

    def _stamp_now(self) -> tuple:
        return tuple(
            sorted(
                (source, name, st.st_mtime_ns, st.st_size)
                for source, directory in (("builtin", self._builtin_dir), ("user", user_theme_dir()))
                for name, st in _scan(directory).items()
            )
        )

    def snapshot(self) -> ThemeSnapshot:
        stamp = self._stamp_now()
        with self._lock:
            if self._snapshot is None or stamp != self._stamp:
                self._snapshot = self._build()
                self._stamp = stamp
            return self._snapshot

    def _build(self) -> ThemeSnapshot:
        by_id: dict[str, dict] = {}
        for directory in (self._builtin_dir, user_theme_dir()):
            for name in sorted(_scan(directory)):
                theme = _read(directory / f"{name}.json")
                if theme is not None:
                    # id = FILENAME, not the file's own `id` field: a
                    # `day.json` claiming `"id": "night"` would otherwise
                    # shadow a theme it isn't named after; corrected, not rejected.
                    theme["id"] = name
                    by_id[name] = theme
        themes = tuple(sorted(by_id.values(), key=lambda t: (_order(t), t["id"])))
        payload = json.dumps(list(themes), separators=(",", ":")).encode()
        css = render_css(themes)
        return ThemeSnapshot(
            themes=themes,
            json_bytes=payload,
            json_etag=_etag(payload),
            css_text=css,
            css_etag=_etag(css.encode()),
        )


def _order(theme: dict) -> int:
    order = theme.get("order")
    return order if isinstance(order, int) else _UNORDERED


def _read(path: Path) -> dict | None:
    try:
        theme = json.loads(path.read_text())
    except (OSError, ValueError) as exc:
        log.warning("themes: ignoring %s (%s)", path, exc)
        return None
    if not isinstance(theme, dict):
        log.warning("themes: ignoring %s (not a JSON object)", path)
        return None
    return theme
