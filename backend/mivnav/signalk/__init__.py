# SPDX-License-Identifier: GPL-2.0-only
"""The server-side SignalK connection.

One upstream socket per boat, held by the always-on server and shared by
every device — see :mod:`mivnav.signalk.service`.
"""

from .access import (
    AccessRequestClient,
    AccessRequestError,
    SignalKUnavailable,
    SignalKUnreachable,
    ws_to_http_base,
)
from .model import STALE_AFTER, Vessel, VesselTracker, stale_age
from .paths import fetch_self_paths, flatten_self_tree
from .service import (
    BROADCAST_INTERVAL,
    STALE_TTL,
    SignalKService,
    Snapshot,
    Status,
)

__all__ = [
    "BROADCAST_INTERVAL",
    "STALE_AFTER",
    "STALE_TTL",
    "AccessRequestClient",
    "AccessRequestError",
    "SignalKService",
    "SignalKUnavailable",
    "SignalKUnreachable",
    "Snapshot",
    "Status",
    "Vessel",
    "VesselTracker",
    "fetch_self_paths",
    "flatten_self_tree",
    "stale_age",
    "ws_to_http_base",
]
