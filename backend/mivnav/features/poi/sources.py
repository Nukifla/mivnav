# SPDX-License-Identifier: GPL-2.0-only
"""The POI source REGISTRY — the one place that knows which implementations
of the ``poi`` provider exist (the POI counterpart of
:mod:`mivnav.features.weather.sources`).

- ``"overpass"``: OpenStreetMap via an Overpass API, built in.
- anything else: a :class:`PoiSource` contributed by a plugin
  (:mod:`mivnav.plugins`).

Kept free of the rest of the POI feature on purpose: ``provider.py``
(params validation), ``ingest.py`` (bake dispatch) and ``merge.py`` all
import it, and none of them may import the others.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from mivnav.plugins import plugins

if TYPE_CHECKING:
    from pydantic import BaseModel

    from mivnav.features.poi.ingest import PoiBakeJob

__all__ = [
    "DEFAULT_IMPLEMENTATION",
    "OVERPASS",
    "OVERPASS_LABEL",
    "PoiSource",
    "implementation_labels",
    "implementations",
    "poi_source",
    "poi_sources",
    "resolve_implementation",
]

OVERPASS = "overpass"
OVERPASS_LABEL = "POI (OSM)"

#: What a POI dataset naming no implementation means. The frontend saves an
#: OpenStreetMap dataset with ``implementation: null`` — so ``None`` is a
#: real, permanent spelling of "overpass", not "unset".
DEFAULT_IMPLEMENTATION = OVERPASS


@dataclass(frozen=True)
class PoiSource:
    """One plugin-provided POI implementation.

    ``id`` is the dataset ``implementation`` value AND the ``src`` property
    every point it bakes must carry (OpenStreetMap points carry none) — the
    tile-level tag the merge and the frontend key on.
    """

    id: str
    #: The dataset-list label, e.g. ``"POI (Acme)"``.
    label: str
    #: Fetch + map + publish one dataset. Runs on the bake thread; see
    #: :class:`~mivnav.features.poi.ingest.PoiBakeJob` for what it gets.
    bake: Callable[[PoiBakeJob], None]
    #: This source's dataset ``params`` (validated only for a dataset of this
    #: implementation; an OpenStreetMap dataset must carry no params at all).
    params_model: type[BaseModel] | None = None
    #: The merge family of one of this source's points (see
    #: :mod:`mivnav.features.poi.merge`), or ``None``: never merges. Given,
    #: a point of this source and an OpenStreetMap point of the same family
    #: close together are drawn as ONE marker — this source's — carrying the
    #: OSM point's props.
    family: Callable[[Mapping[str, Any]], str | None] | None = None
    #: Files this source keeps beside set ``set_id`` in ``dataset_dir`` (not
    #: the archive/sidecar), removed with the set and when the set is re-baked
    #: from another source. Return the paths, existing or not.
    extra_files: Callable[[Path, str], list[Path]] = field(default=lambda d, s: [])


def poi_sources() -> dict[str, PoiSource]:
    """Every plugin POI source by id (rebuilt per call — cheap)."""
    out: dict[str, PoiSource] = {}
    for plugin in plugins():
        for source in plugin.poi_sources():
            if source.id == OVERPASS or source.id in out:
                raise ValueError(f"duplicate POI source id {source.id!r}")
            out[source.id] = source
    return out


def poi_source(implementation: str | None) -> PoiSource | None:
    """The plugin source behind ``implementation`` (``None`` for Overpass)."""
    impl = resolve_implementation(implementation)
    return None if impl == OVERPASS else poi_sources()[impl]


def implementations() -> tuple[str, ...]:
    """The legal values of a POI ``DatasetConfig.implementation``."""
    return (OVERPASS, *poi_sources())


def implementation_labels() -> dict[str, str]:
    """The dataset-list label per implementation (the ``poi`` provider's
    ``implementation_labels``). Named after the DATA, not the transport."""
    return {OVERPASS: OVERPASS_LABEL, **{s.id: s.label for s in poi_sources().values()}}


def resolve_implementation(implementation: str | None) -> str:
    """``None``/``""`` → :data:`DEFAULT_IMPLEMENTATION`; a known value as-is;
    anything else raises :class:`ValueError` — an unknown backing (say, its
    plugin was removed) is an error, never a silent fall back to Overpass
    (it would bake the wrong data under the dataset's name)."""
    if not implementation:
        return DEFAULT_IMPLEMENTATION
    known = implementations()
    if implementation not in known:
        raise ValueError(
            f"unknown POI implementation {implementation!r}; "
            f"expected one of {', '.join(known)} (or null = {DEFAULT_IMPLEMENTATION})"
        )
    return implementation
