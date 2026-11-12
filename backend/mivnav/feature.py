# SPDX-License-Identifier: GPL-2.0-only
"""The ``Feature`` abstraction — one registration point per data-provider.

KERNEL, not composition-root: a feature's own ``provider.py`` needs these
TYPES without importing ``mivnav.data``. See
docs/architecture/feature-abstraction-backend.md.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from typing import TYPE_CHECKING, Generic, Literal, Protocol, TypeVar

if TYPE_CHECKING:
    from pathlib import Path

    from fastapi import APIRouter
    from pydantic import BaseModel

    from mivnav.config import ConfigStore
    from mivnav.config.model import Config, Region
    from mivnav.ingest.runner import IngestRunner
    from mivnav.search import SearchIndex
    from mivnav.signalk import SignalKService

# area-query/static-asset/history-query are documentary extension points
# nothing currently switches on. See docs/architecture/feature-abstraction-backend.md
Kind = Literal[
    "tiled", "range-mirror", "live-stream", "area-query", "static-asset", "history-query"
]
Tier = Literal["ram", "disk"]
Negative = Literal["error-memo", "ttl", "none"]
# "ttl" here is the positive-refresh analogue of Negative's "ttl" (a polled
# source going stale on a clock); no current provider uses it.
RefreshMode = Literal["sequence-rescan", "immutable", "live", "ttl"]


@dataclass(frozen=True)
class CachePolicy:
    """How a provider caches — declared, not implemented. ``negative`` is how
    failures/absences are remembered; ``single_flight`` is whether concurrent
    misses of one key collapse to one load."""

    budget_bytes: int
    tier: Tier
    negative: Negative
    single_flight: bool


@dataclass(frozen=True)
class Refresh:
    """How a provider's data goes stale. ``interval`` applies only to
    ``sequence-rescan`` (the rate limit, in seconds; ``None`` = every access)."""

    mode: RefreshMode
    interval: float | None = None


# Optional IngestSpec DECLARES a source is also bakeable and how; the runner
# lives in the feature's own ingest.py. See
# docs/architecture/feature-abstraction-backend.md for IngestArtifact/IngestSchedule rationale.
IngestSource = Literal["overpass", "ocharts-shop", "upload", "http", "pmtiles-extract"]
IngestRegion = Literal["bbox", "country", "chart-set", "none"]
IngestArtifact = Literal["pmtiles", "ocharts-set", "file-mirror"]
IngestSchedule = Literal["manual", "ttl"]
#: "bake" writes into `data_root/<out_dir_slice>/<id>` on a schedule;
#: "live-cache" is a provider's ONE fetch-through cache, outside `data_root`,
#: never bake-triggerable (`ingest_dataset` 409s it).
DatasetMode = Literal["bake", "live-cache"]


@dataclass(frozen=True)
class IngestSpec:
    """Declarative "how to bake this source" — additive to :class:`DataProvider`.

    ``out_dir_slice`` (M-DATA-3) is LOAD-BEARING: ``mivnav.data.provider``
    reads it to build the real bake directory. See
    docs/architecture/feature-abstraction-backend.md for full field rationale.
    """

    id: str
    source: IngestSource
    out_dir_slice: str
    region: IngestRegion
    artifact: IngestArtifact
    schedule: IngestSchedule = "manual"
    ttl_s: float | None = None
    params: dict = field(default_factory=dict)
    params_model: "type[BaseModel] | None" = field(default=None, repr=False)
    runner_factory: "Callable[[Path], IngestRunner] | None" = field(default=None, repr=False)
    trigger: (
        "Callable[[IngestRunner, Region | None, BaseModel | None, str | None], None] | None"
    ) = field(default=None, repr=False)

    def summary(self) -> dict:
        """JSON-safe description; ``params_model``/``runner_factory`` excluded
        (a class and a callable — :func:`dataclasses.asdict` would choke on them)."""
        return {
            "id": self.id,
            "source": self.source,
            "out_dir_slice": self.out_dir_slice,
            "region": self.region,
            "artifact": self.artifact,
            "schedule": self.schedule,
            "ttl_s": self.ttl_s,
            "params": self.params,
        }


#: Key under which :func:`params_context` carries the implementation.
PARAMS_CONTEXT_IMPLEMENTATION = "implementation"


def params_context(implementation: str | None) -> dict[str, object]:
    """Passed as validation context (not folded into ``params``) because WHICH
    backing is declared changes what a params value legally MEANS (weather's
    ``domains`` validates against a different catalog per implementation)."""
    return {PARAMS_CONTEXT_IMPLEMENTATION: implementation}


def implementation_from_context(context: object) -> str | None:
    """``None`` is legal here — includes validating a params model directly
    with no context at all (a test, or a feature validating its own model)."""
    if isinstance(context, dict):
        value = context.get(PARAMS_CONTEXT_IMPLEMENTATION)
        if isinstance(value, str) and value:
            return value
    return None


@dataclass
class DataProvider:
    """One data source, described — the ``/providers`` descriptor.

    Everything but :attr:`stats` is static policy, serialisable via
    :meth:`summary`. ``label`` is required (no default): see
    docs/architecture/feature-abstraction-backend.md for why.
    """

    id: str
    kind: Kind
    cache: CachePolicy | None
    refresh: Refresh
    prefetch: str | None
    config_slice: str | None
    label: str
    stats: Callable[[], dict] = field(repr=False)
    ingest: IngestSpec | None = None  # None = serve-time-only (weather, signalk)
    #: Per-IMPLEMENTATION display labels, for a provider whose datasets can be
    #: backed by different sources a sailor tells apart in the dataset list
    #: (poi: "POI (OSM)" vs a plugin source's own label). Keyed by implementation id; a
    #: dataset naming no implementation (``None``) resolves through
    #: :attr:`default_implementation`; an unlisted one, or an empty mapping,
    #: shows :attr:`label`. Resolved by the frontend's ``datasetLabel``.
    implementation_labels: dict[str, str] = field(default_factory=dict)
    default_implementation: str | None = None

    @property
    def creatable(self) -> bool:
        """Same check ``mivnav.api.datasets``'s ``put_dataset``/``ingest_dataset``
        make before accepting a PUT/ingest — computed once here so route and
        the ``GET /datasets`` catalog can never drift apart."""
        return self.ingest is not None and self.ingest.runner_factory is not None

    def summary(self) -> dict:
        """The JSON-safe static description (no live stats, no callable)."""
        return {
            "id": self.id,
            "kind": self.kind,
            "cache": asdict(self.cache) if self.cache is not None else None,
            "refresh": asdict(self.refresh),
            "prefetch": self.prefetch,
            "config_slice": self.config_slice,
            "label": self.label,
            "implementation_labels": dict(self.implementation_labels),
            "default_implementation": self.default_implementation,
            "creatable": self.creatable,
            "ingest": self.ingest.summary() if self.ingest else None,
        }


@dataclass(frozen=True)
class FeatureCtx:
    """Shared, cross-feature dependencies a feature's ``build_runtime`` may
    read — deliberately small, never another feature's private state (see
    docs/architecture/feature-abstraction-backend.md)."""

    config: "ConfigStore"
    search_index: Callable[[], "SearchIndex"]
    #: The live connection, resolved per call so a config edit is picked up.
    #: Optional only for a test that builds a ctx by hand.
    signalk: "Callable[[], SignalKService] | None" = None


class FeatureRuntime(Protocol):
    """Process-lifecycle contract only (cleanup at shutdown/config-reload).
    Everything else lives on the feature's OWN typed runtime class, not here —
    no shared god-interface."""

    def close(self) -> None: ...


R = TypeVar("R", bound=FeatureRuntime)


@dataclass(frozen=True)
class Feature(Generic[R]):
    """Everything one provider registers, in ONE call — built in that
    provider's own ``routes.py`` and listed once in ``FEATURES``. See
    docs/architecture/feature-abstraction-backend.md for field-by-field rationale.
    """

    id: str
    routers: tuple["APIRouter", ...]
    build_runtime: Callable[[FeatureCtx], R]
    #: ``None``: the feature has no ``/providers`` entry (e.g. a plugin's
    #: add-on routes over another feature's data).
    data_provider: Callable[["Config", R], DataProvider] | None = None
    guard: Callable[[R, "Config", "Config"], str | None] | None = None
