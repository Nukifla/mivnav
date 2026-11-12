# SPDX-License-Identifier: GPL-2.0-only
"""Generic per-set sidecar-JSON mechanics, shared by POI and satellite.

See docs/architecture/sidecar-shared-plumbing.md for why this is a shared
kernel module rather than living in either feature's own package.
"""

from __future__ import annotations

import json
import logging
import os
import re
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger(__name__)

SIDECAR_SUFFIX = ".json"

CUSTOM_SET_ID = "custom"

# Result is always [a-z0-9-], so a slug can never contain "/" or ".." and is
# always a safe path component under a feature's own data dir.
_SLUG_NON_ALNUM = re.compile(r"[^a-z0-9]+")

__all__ = [
    "CUSTOM_SET_ID",
    "SIDECAR_SUFFIX",
    "mtime_iso",
    "read_sidecar_json",
    "resolve_name_and_updated_at",
    "sidecar_path",
    "slugify",
    "write_sidecar_fields",
]


def slugify(name: str) -> str:
    """Filesystem-safe lowercase slug of ``name``, or :data:`CUSTOM_SET_ID`
    if nothing usable remains."""
    slug = _SLUG_NON_ALNUM.sub("-", name.strip().lower()).strip("-")
    return slug or CUSTOM_SET_ID


def sidecar_path(root: Path, set_id: str) -> Path:
    return root / f"{set_id}{SIDECAR_SUFFIX}"


def write_sidecar_fields(root: Path, set_id: str, fields: dict) -> None:
    """Write ``<root>/<set_id>.json`` atomically (temp file + ``os.replace``
    in the same dir, matching the pmtiles writer), stamping ``updated_at``."""
    meta = {**fields, "updated_at": datetime.now(timezone.utc).isoformat()}
    path = sidecar_path(root, set_id)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(meta), encoding="utf-8")
    os.replace(tmp, path)


def read_sidecar_json(root: Path, set_id: str, *, kind: str) -> dict | None:
    """Parse ``<root>/<set_id>.json``, or ``None`` when absent or malformed
    (never raises — a bad sidecar must not break a rescan). ``kind`` labels
    the warning log line only (``"POI"``/``"satellite"``)."""
    path = sidecar_path(root, set_id)
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return None
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        log.warning("ignoring malformed %s sidecar %s", kind, path)
        return None
    return data if isinstance(data, dict) else None


def mtime_iso(mtime_ns: int) -> str:
    """A file's ``st_mtime_ns`` as an ISO-8601 UTC timestamp — the
    ``updated_at`` fallback when a sidecar is absent or malformed."""
    return datetime.fromtimestamp(mtime_ns / 1e9, tz=timezone.utc).isoformat()


def resolve_name_and_updated_at(
    data: dict, set_id: str, mtime_ns: int, *, fallback_name: Callable[[str], str]
) -> tuple[str, str]:
    """``(name, updated_at)`` from an already-parsed sidecar ``data`` dict,
    falling back to ``fallback_name(set_id)`` / the archive mtime. ``data``
    must not be ``None`` — the absent/malformed-sidecar branch stays each
    feature's own."""
    name = data.get("name")
    if not isinstance(name, str) or not name:
        name = fallback_name(set_id)
    updated_at = data.get("updated_at")
    if not isinstance(updated_at, str) or not updated_at:
        updated_at = mtime_iso(mtime_ns)
    return name, updated_at
