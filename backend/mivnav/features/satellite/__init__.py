# SPDX-License-Identifier: GPL-2.0-only
"""The satellite/aerial-imagery overlay: a self-hosted raster tile layer.

The imagery counterpart of :mod:`mivnav.features.poi`: serve pre-baked
``<id>.pmtiles`` raster sets, bake a region from a source's XYZ tiles, and
write it with :mod:`.pmtiles_writer`. That writer emits the same byte layout
as ``chartcore``'s MVT writer (``chartcore/src/pmtiles/mod.rs``), which the
existing pure-Python reader (:mod:`mivnav.charts.pmtiles`) already reads.
"""
