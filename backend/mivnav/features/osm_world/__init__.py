# SPDX-License-Identifier: GPL-2.0-only
"""The ``osm_world`` feature: a whole-world basemap layer extracted from
Protomaps' daily build — see docs/architecture/osm-world-ingest.md.
``close_live_http_client`` is the feature's ``shutdown`` hook."""

from mivnav.features.osm_world.live import close_live_http_client

__all__ = ["close_live_http_client"]
