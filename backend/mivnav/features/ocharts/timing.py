# SPDX-License-Identifier: GPL-2.0-only
"""Which cache tier served an o-charts tile, for the ``Server-Timing`` header.

A tile comes from RAM (``OchartsService.tiles``), the disk cache
(:mod:`.disk_tiles`) or a fresh render. The service's cache loaders call
:func:`note` on a miss; a request that never reaches a loader was a RAM hit
(or waited on another request's single-flight load of the same tile, which
shows as a RAM hit with a long ``dur``). The record lives in a ContextVar so
the service needs no extra return value: the sync tile handler and the
service call run in the same worker thread, under the same context.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from contextvars import ContextVar
from typing import TypeVar

_source: ContextVar[list[str] | None] = ContextVar("ocharts_tile_source", default=None)

T = TypeVar("T")


def note(source: str) -> None:
    """Record that this request's tile came from ``source`` (``disk`` or
    ``render``). A no-op outside :func:`timed` (e.g. the warmer)."""
    rec = _source.get()
    if rec is not None:
        rec.append(source)


def timed(fn: Callable[[], T]) -> tuple[T, str]:
    """Run ``fn`` and return its result plus a ``Server-Timing`` value:
    ``ram``, ``disk`` or ``render``, with its duration in ms."""
    rec: list[str] = []
    token = _source.set(rec)
    start = time.perf_counter()
    try:
        result = fn()
    finally:
        _source.reset(token)
    ms = (time.perf_counter() - start) * 1000
    # The last tier noted wins: a disk miss notes nothing, a render notes "render".
    source = rec[-1] if rec else "ram"
    return result, f"{source};dur={ms:.1f}"
