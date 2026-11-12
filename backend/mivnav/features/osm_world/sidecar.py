# SPDX-License-Identifier: GPL-2.0-only
"""Per-set sidecar metadata for the extracted world basemap.

Built on the shared helpers in :mod:`mivnav.sidecar`. See
docs/architecture/sidecar-shared-plumbing.md's `osm_world/sidecar.py`
section for the field meanings and why this isn't shared code."""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

from mivnav.sidecar import (
    CUSTOM_SET_ID,
    SIDECAR_SUFFIX,
    mtime_iso as _mtime_iso,
    read_sidecar_json,
    resolve_name_and_updated_at,
    sidecar_path,
    slugify,
    write_sidecar_fields,
)

__all__ = [
    "CUSTOM_SET_ID",
    "SIDECAR_SUFFIX",
    "read_sidecar",
    "resolve_metadata",
    "sidecar_path",
    "slugify",
    "write_sidecar",
]


def write_sidecar(
    root: Path,
    set_id: str,
    *,
    name: str,
    source_url: str,
    max_zoom: int,
    boxes: Sequence[tuple[float, float, float, float]] = (),
) -> None:
    """Write ``<root>/<set_id>.json`` atomically, stamping ``updated_at``
    with the current UTC time. ``boxes`` becomes the ENCLOSING bbox — see
    docs/architecture/sidecar-shared-plumbing.md."""
    write_sidecar_fields(
        root,
        set_id,
        {
            "name": name,
            "bbox": _enclosing(boxes),
            "source_url": source_url,
            "max_zoom": max_zoom,
        },
    )


def _enclosing(boxes: Sequence[tuple[float, float, float, float]]) -> list[float] | None:
    """``[w, s, e, n]`` enclosing every box, or ``None`` for no boxes."""
    if not boxes:
        return None
    return [
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    ]


def read_sidecar(root: Path, set_id: str) -> dict | None:
    """Parse ``<root>/<set_id>.json``, or ``None`` when absent/malformed."""
    return read_sidecar_json(root, set_id, kind="osm_world")


def _fallback_name(set_id: str) -> str:
    return set_id.replace("-", " ").replace("_", " ").title()


def resolve_metadata(root: Path, set_id: str, mtime_ns: int) -> tuple[str, str, dict | None]:
    """``(name, updated_at, region)`` for a set: from its sidecar when
    present, else fallbacks derived from the id and the archive mtime.
    ``region`` is ``{"bbox": [...]}`` or ``None``, matching other PMTiles
    stores' catalog entries."""
    data = read_sidecar(root, set_id)
    if data is None:
        return _fallback_name(set_id), _mtime_iso(mtime_ns), None
    name, updated_at = resolve_name_and_updated_at(
        data, set_id, mtime_ns, fallback_name=_fallback_name
    )
    bbox = data.get("bbox")
    region = {"bbox": bbox} if isinstance(bbox, list) and len(bbox) == 4 else None
    return name, updated_at, region
