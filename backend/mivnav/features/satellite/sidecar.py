# SPDX-License-Identifier: GPL-2.0-only
"""Per-set sidecar metadata for baked satellite raster sets.

See docs/architecture/satellite-sidecar.md for the on-disk JSON shape and
why this wraps mivnav.sidecar's shared mechanics instead of importing POI's.
"""

from __future__ import annotations

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
    source: str | None,
    tile_format: str | None,
    bbox: tuple[float, float, float, float] | None,
) -> None:
    """Write ``<root>/<set_id>.json`` atomically, stamping ``updated_at`` with
    the current UTC time. Re-baking a set overwrites its sidecar in place."""
    write_sidecar_fields(
        root,
        set_id,
        {
            "name": name,
            "source": source,
            "tile_format": tile_format,
            "bbox": list(bbox) if bbox is not None else None,
        },
    )


def read_sidecar(root: Path, set_id: str) -> dict | None:
    """Parse ``<root>/<set_id>.json``, or ``None`` when it is absent or
    malformed (never raises — a bad sidecar must not break a rescan)."""
    return read_sidecar_json(root, set_id, kind="satellite")


def _fallback_name(set_id: str) -> str:
    return set_id.replace("-", " ").replace("_", " ").title()


def _region_from_sidecar(data: dict) -> dict | None:
    """The catalog ``region`` shape from a sidecar: ``{"bbox": [...]}`` (with
    the source folded in) or ``None``. Imagery has no country variant."""
    bbox = data.get("bbox")
    if isinstance(bbox, (list, tuple)) and len(bbox) == 4:
        region: dict = {"bbox": list(bbox)}
        source = data.get("source")
        if isinstance(source, str) and source:
            region["source"] = source
        return region
    return None


def resolve_metadata(
    root: Path, set_id: str, mtime_ns: int
) -> tuple[str, str, dict | None, str | None]:
    """``(name, updated_at, region, tile_format)`` for a set: from its sidecar
    when present, else fallbacks derived from the id and the archive mtime.

    ``tile_format`` is ``None`` when the sidecar is absent/malformed — the store
    then relies on the PMTiles header's ``tile_type`` alone, which is the
    authoritative signal anyway."""
    data = read_sidecar(root, set_id)
    if data is None:
        return _fallback_name(set_id), _mtime_iso(mtime_ns), None, None
    name, updated_at = resolve_name_and_updated_at(
        data, set_id, mtime_ns, fallback_name=_fallback_name
    )
    tile_format = data.get("tile_format")
    if not isinstance(tile_format, str) or not tile_format:
        tile_format = None
    return name, updated_at, _region_from_sidecar(data), tile_format
