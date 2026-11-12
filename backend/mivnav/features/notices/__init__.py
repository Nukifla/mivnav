# SPDX-License-Identifier: GPL-2.0-only
"""Notices to mariners — a DATASET provider like POI or weather: each
notices dataset names a source (today the Danish Maritime Authority's Niord
feed — Efterretninger for Søfarende, navigational warnings, firing
exercises and firing areas, EfS A/B), the source's regions it shows
(Denmark, Greenland) and its update schedule, and keeps its own copy on
the boat's disk so it serves offline. ``/notices/*`` serves every enabled
dataset merged.

Modules: :mod:`.catalog` (sources and their regions), :mod:`.client`
(HTTP), :mod:`.model` (raw JSON), :mod:`.classify` and :mod:`.normalize`
(raw → API shapes, pure; the region filter), :mod:`.sanitize` (HTML),
:mod:`.runtime` (pull/serve), :mod:`.ingest` (the dataset runner),
:mod:`.provider` (descriptor + params), :mod:`.routes` (``/notices``).
Plan and wire contract: efs.md (§4.1, §6).
"""
