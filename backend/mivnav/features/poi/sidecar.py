# SPDX-License-Identifier: GPL-2.0-only
"""Per-set sidecar metadata for baked POI sets.

See docs/architecture/poi-sidecar.md for the on-disk JSON shape and why
this wraps mivnav.sidecar's shared mechanics instead of satellite's.
"""

from __future__ import annotations

from pathlib import Path

from mivnav.geo import countries
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

# Fallback id/name for an explicit-bbox bake with no named region (a raw
# ``POST /ingest/poi {bbox}`` carries coordinates but no name).
CUSTOM_SET_NAME = "Custom"

__all__ = [
    "CUSTOM_SET_ID",
    "CUSTOM_SET_NAME",
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
    country: str | None,
    bbox: tuple[float, float, float, float] | None,
    implementation: str | None = None,
    content_hash: str | None = None,
) -> None:
    """Write ``<root>/<set_id>.json`` atomically, stamping ``updated_at``
    with the current UTC time. Re-baking a set overwrites its sidecar in
    place.

    ``implementation`` (``"overpass"`` or a plugin source's id) records which
    source baked the set; ``content_hash`` is a plugin bake's skip key (see
    ``PoiBakeJob.unchanged``). Both are written only when given, so a
    sidecar from before either existed and one written now read the same;
    every reader ignores keys it doesn't know."""
    fields: dict = {
        "name": name,
        "country": country,
        "bbox": list(bbox) if bbox is not None else None,
    }
    if implementation is not None:
        fields["implementation"] = implementation
    if content_hash is not None:
        fields["content_hash"] = content_hash
    write_sidecar_fields(root, set_id, fields)


def read_sidecar(root: Path, set_id: str) -> dict | None:
    """Parse ``<root>/<set_id>.json``, or ``None`` when it is absent or
    malformed (never raises — a bad sidecar must not break a rescan)."""
    return read_sidecar_json(root, set_id, kind="POI")


def _fallback_name(set_id: str) -> str:
    """Display name for a sidecar-less set: country name if the id is a
    valid ISO code, else the id title-cased."""
    if countries.is_country(set_id):
        return countries.country_name(set_id)
    return set_id.replace("-", " ").replace("_", " ").title()


def _fallback_region(set_id: str) -> dict | None:
    return {"country": set_id.upper()} if countries.is_country(set_id) else None


def _region_from_sidecar(data: dict) -> dict | None:
    """The catalog ``region`` shape from a sidecar: ``{"country": iso}`` for a
    country set, ``{"bbox": [...]}`` for a bbox set, else ``None``."""
    country = data.get("country")
    if isinstance(country, str) and country:
        return {"country": country}
    bbox = data.get("bbox")
    if isinstance(bbox, (list, tuple)) and len(bbox) == 4:
        return {"bbox": list(bbox)}
    return None


def resolve_metadata(
    root: Path, set_id: str, mtime_ns: int
) -> tuple[str, str, dict | None]:
    """``(name, updated_at, region)`` for a set: from its sidecar when present,
    else fallbacks derived from the id and the archive mtime."""
    data = read_sidecar(root, set_id)
    if data is None:
        return _fallback_name(set_id), _mtime_iso(mtime_ns), _fallback_region(set_id)
    name, updated_at = resolve_name_and_updated_at(
        data, set_id, mtime_ns, fallback_name=_fallback_name
    )
    return name, updated_at, _region_from_sidecar(data)
