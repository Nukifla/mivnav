# SPDX-License-Identifier: GPL-2.0-only
"""OSM POI overlay: pre-baked ``.pmtiles`` archives served as a top-most
annotation layer. Reuses :mod:`mivnav.charts` wholesale (its
``RescanRegistry``, PMTiles ``Archive`` reader, ETag/gzip serving) as a
second registry/router rather than a new engine."""

from mivnav.features.poi.store import PoiSet, PoiStore

__all__ = ["PoiSet", "PoiStore"]
