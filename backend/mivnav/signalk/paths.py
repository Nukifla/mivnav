# SPDX-License-Identifier: GPL-2.0-only
"""Enumerating the boat's SignalK paths, for the dashboard widget picker.
See docs/architecture/signalk-path-enumeration.md for why this needs the
REST tree (not the delta stream) and the pure/IO split.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

log = logging.getLogger(__name__)

#: One attempt, this long. Enumeration is a human-in-front-of-it request
#: (they just opened the picker), so a box that is not answering is an empty
#: list now, not a retry into a hang. Same posture as the access handshake.
REQUEST_TIMEOUT = 10.0

_SELF_PATH = "/signalk/v1/api/vessels/self"

#: Node keys that are SignalK metadata, not child paths — never recursed into.
#: ``value``/``$source``/``timestamp``/``meta`` decorate a leaf; ``pgn`` and
#: ``sentence`` are the NMEA provenance some servers attach.
_RESERVED_KEYS = frozenset(
    {"value", "values", "meta", "timestamp", "source", "$source", "pgn", "sentence"}
)


def flatten_self_tree(tree: Any, prefix: str = "") -> list[dict[str, Any]]:
    """Flatten a SignalK v1 vessel tree to ``[{"path", "units"?}]``. Pure and
    total: unexpected shapes yield fewer paths, never an error. See
    docs/architecture/signalk-path-enumeration.md for the leaf rule."""
    out: list[dict[str, Any]] = []
    if not isinstance(tree, dict):
        return out

    if "value" in tree:
        entry: dict[str, Any] = {"path": prefix}
        meta = tree.get("meta")
        if isinstance(meta, dict):
            units = meta.get("units")
            if isinstance(units, str) and units:
                entry["units"] = units
        if prefix:
            out.append(entry)
        return out

    for key, node in tree.items():
        if not isinstance(key, str) or key in _RESERVED_KEYS or key.startswith("$"):
            continue
        if not isinstance(node, dict):
            continue
        child = f"{prefix}.{key}" if prefix else key
        out.extend(flatten_self_tree(node, child))
    return out


def fetch_self_paths(
    http_base: str, *, timeout: float = REQUEST_TIMEOUT
) -> list[dict[str, Any]]:
    """Fetch and flatten the boat's ``vessels/self`` tree. Raises
    ``httpx.HTTPError`` on any transport/status failure; the caller (the
    API route) softens that to an empty list."""
    url = f"{http_base.rstrip('/')}{_SELF_PATH}"
    with httpx.Client(timeout=timeout) as http:
        response = http.get(url)
    response.raise_for_status()
    return flatten_self_tree(response.json())
