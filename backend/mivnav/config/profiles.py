# SPDX-License-Identifier: GPL-2.0-only
"""Named opaque-blob stores, stored server-side: visual-settings profiles
and dashboard/band widget layouts. See docs/architecture/named-blob-store.md
for why the blob is opaque and why this is separate from config.json.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable

from .model import default_layouts_path, default_profiles_path

log = logging.getLogger(__name__)

PROFILES_VERSION = 1

MAX_NAME_LENGTH = 64
MAX_PROFILES = 100
# Generous next to a dozen display fields, small enough that the file
# stays a file, not a data store.
MAX_SETTINGS_BYTES = 64 * 1024

# Keyed by kind so a caller that forgets the path for one kind cannot
# silently write its entries into the OTHER kind's file.
_DEFAULT_PATH_BY_KIND: dict[str, Callable[[], Path]] = {
    "profile": default_profiles_path,
    "layout": default_layouts_path,
}


class ProfileError(Exception):
    """An invalid entry name or body; kept its historical name though it
    is raised for layouts too."""


def validate_name(name: str, *, kind: str = "profile") -> str:
    """A trimmed, printable, bounded, slash-free name. Not about path
    traversal (the name is a JSON key, never a filename) — it's about the
    name being a URL path segment (`/config/{kind}s/{name}`), where a
    slash is a route boundary, not an escapable character."""
    name = name.strip()
    if not name:
        raise ProfileError(f"{kind} name must not be empty")
    if len(name) > MAX_NAME_LENGTH:
        raise ProfileError(f"{kind} name must be at most {MAX_NAME_LENGTH} characters")
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in name):
        raise ProfileError(f"{kind} name must not contain control characters")
    if "/" in name or "\\" in name:
        raise ProfileError(f"{kind} name must not contain slashes")
    return name


def validate_settings(settings: Any, *, kind: str = "profile") -> dict[str, Any]:
    if not isinstance(settings, dict):
        raise ProfileError(f"{kind} settings must be a JSON object")
    try:
        encoded = json.dumps(settings)
    except (TypeError, ValueError) as e:
        raise ProfileError(f"{kind} settings must be JSON-serialisable: {e}") from e
    if len(encoded) > MAX_SETTINGS_BYTES:
        raise ProfileError(f"{kind} settings must be at most {MAX_SETTINGS_BYTES} bytes")
    return settings


class NamedBlobStore:
    """Named opaque blobs (profiles, or layouts), persisted as one JSON
    document. See docs/architecture/named-blob-store.md for why this is
    one class for both kinds, and the on-disk shape.
    """

    def __init__(
        self,
        path: Path | None = None,
        *,
        kind: str = "profile",
        collection_key: str = "profiles",
        entry_key: str = "settings",
    ) -> None:
        self.kind = kind
        self._collection_key = collection_key
        self._entry_key = entry_key
        self.path = path or _DEFAULT_PATH_BY_KIND[kind]()
        self._lock = threading.Lock()
        # Name of the entry a brand-new client adopts on first boot.
        # Layouts never expose this via the API but keep the field anyway
        # since it's the same class (see docs/architecture/named-blob-store.md).
        self._entries: dict[str, dict[str, Any]]
        self._default: str | None
        self._entries, self._default = self._read()

    # -- reading -----------------------------------------------------------

    def _read(self) -> tuple[dict[str, dict[str, Any]], str | None]:
        try:
            raw = json.loads(self.path.read_text())
        except FileNotFoundError:
            return {}, None
        except (OSError, json.JSONDecodeError) as e:
            # Never fail startup over a corrupt cosmetic preset file.
            log.warning("ignoring unreadable %ss at %s: %s", self.kind, self.path, e)
            return {}, None
        entries = raw.get(self._collection_key) if isinstance(raw, dict) else None
        if not isinstance(entries, dict):
            log.warning("ignoring malformed %ss at %s", self.kind, self.path)
            return {}, None
        parsed = {
            name: entry
            for name, entry in entries.items()
            if isinstance(entry, dict) and isinstance(entry.get(self._entry_key), dict)
        }
        default = raw.get("default")
        default = default if isinstance(default, str) and default in parsed else None
        return parsed, default

    def list(self) -> list[dict[str, Any]]:
        """Every entry, newest-saved first, blobs included."""
        with self._lock:
            return sorted(
                (self._entry(name) for name in self._entries),
                key=lambda p: (-p["updated"], p["name"].lower()),
            )

    def get(self, name: str) -> dict[str, Any] | None:
        name = name.strip()  # normalised as `save` does it
        with self._lock:
            if name not in self._entries:
                return None
            return self._entry(name)

    def _entry(self, name: str) -> dict[str, Any]:
        entry = self._entries[name]
        return {
            "name": name,
            "updated": float(entry.get("updated") or 0.0),
            self._entry_key: entry[self._entry_key],
        }

    def default(self) -> str | None:
        """The boat-wide default entry's name, or `None` if unset."""
        with self._lock:
            return self._default

    # -- writing -----------------------------------------------------------

    def save(self, name: str, settings: Any) -> dict[str, Any]:
        """Create or replace an entry — idempotent by name."""
        name = validate_name(name, kind=self.kind)
        settings = validate_settings(settings, kind=self.kind)
        with self._lock:
            if name not in self._entries and len(self._entries) >= MAX_PROFILES:
                raise ProfileError(f"at most {MAX_PROFILES} {self._collection_key}")
            self._entries[name] = {self._entry_key: settings, "updated": time.time()}
            self._write()
            return self._entry(name)

    def set_default(self, name: str) -> bool:
        """Anoint an existing entry as default. Returns `False` if no
        such entry exists (endpoint turns that into a 404)."""
        name = name.strip()
        with self._lock:
            if name not in self._entries:
                return False
            self._default = name
            self._write()
            return True

    def clear_default(self, name: str | None = None) -> None:
        """Unset the default. Scoped by `name` when given: a no-op unless
        that entry is the current default."""
        with self._lock:
            if name is not None and self._default != name.strip():
                return
            if self._default is None:
                return
            self._default = None
            self._write()

    def delete(self, name: str) -> bool:
        name = name.strip()
        with self._lock:
            if self._entries.pop(name, None) is None:
                return False
            # Clear the pointer rather than leave it dangling.
            if self._default == name:
                self._default = None
            self._write()
            return True

    def _write(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        body = json.dumps(
            {
                "version": PROFILES_VERSION,
                "default": self._default,
                self._collection_key: self._entries,
            },
            indent=2,
            sort_keys=True,
        )
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=f".{self.kind}s-", suffix=".json")
        try:
            with os.fdopen(fd, "w") as f:
                f.write(body + "\n")
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)
        except BaseException:
            os.unlink(tmp)
            raise


#: Backward-compatible name — every existing caller (and test_profiles.py)
#: imports `ProfileStore`.
ProfileStore = NamedBlobStore


def LayoutStore(path: Path | None = None) -> NamedBlobStore:
    """A `NamedBlobStore` for dashboard/band widget layouts (`layouts.json`),
    storing the blob under `"arrangement"` rather than `"settings"`."""
    return NamedBlobStore(path, kind="layout", collection_key="layouts", entry_key="arrangement")
