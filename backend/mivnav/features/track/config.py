# SPDX-License-Identifier: GPL-2.0-only
"""The ``track`` feature's config slice: which history provider to read,
and this boat's earlier SignalK identities, whose history is still this
boat's track.

**Which provider.** SignalK lets several plugins register as a history
provider and answers from its *default* one unless a query names another.
Installing KIP made KIP the default on this boat (measured 2026-10-28): it
answers 200 with no data for every range, while signalk-to-influxdb2 still
held the whole track — so the track silently stopped at the install. Naming
the provider is what keeps a later plugin install from doing that again.

SignalK names its own vessel by a generated ``urn:mrn:signalk:uuid:…``
until an MMSI is entered, then by ``urn:mrn:imo:mmsi:…``; a reinstall mints
a new uuid. History plugins keep each fix under the identity it was written
with, and ``vessels.self`` resolves only to the current one — so without
this list, everything before the last identity change is invisible. The
plugin's own ``/contexts`` does not list them either (measured on the boat,
2026-09-28), hence a hand-set list rather than discovery.
See docs/architecture/track-route.md.
"""

from __future__ import annotations

from pydantic import field_validator

from mivnav.config.base import Frozen


class TrackConfig(Frozen):
    #: A history provider's plugin id, e.g. ``signalk-to-influxdb2``, sent as
    #: the query's ``provider``. ``None`` = whatever SignalK's default is.
    #: The choices are the box's own (``GET /track/providers``).
    history_provider: str | None = None

    #: Full contexts, e.g. ``vessels.urn:mrn:signalk:uuid:…``. Queried
    #: alongside ``vessels.self`` for past days and merged by time.
    past_contexts: tuple[str, ...] = ()

    @field_validator("history_provider")
    @classmethod
    def _blank_is_default(cls, provider: str | None) -> str | None:
        return (provider or "").strip() or None

    @field_validator("past_contexts")
    @classmethod
    def _clean(cls, contexts: tuple[str, ...]) -> tuple[str, ...]:
        cleaned: list[str] = []
        for raw in contexts:
            context = raw.strip()
            if not context or context in cleaned:
                continue
            if not context.startswith("vessels.") or "*" in context:
                raise ValueError(
                    f"track context {context!r} must be a full vessel context "
                    "like 'vessels.urn:mrn:signalk:uuid:…', no wildcards"
                )
            cleaned.append(context)
        return tuple(cleaned)
