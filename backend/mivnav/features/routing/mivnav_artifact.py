# SPDX-License-Identifier: GPL-2.0-only
"""Where a chart set's precomputed ``.mivnav`` routing artifact lives on
disk, and whether the one that is there may be used right now.

``chartcore::mivnav::persist`` builds and re-loads the file; this module
answers the two questions that are the BACKEND's to answer — which path,
and is it current — and nothing else. See ``MIVNAV_ARTIFACT_TODO.md`` at
the repo root for the whole v3 effort this is one wiring step of.

**The path is a fixed convention, not a config field.** CLAUDE.md's "no
configuration environment variables — one JSON file" rule means anything
tunable would have to be a real ``~/.config/mivnav/config.json`` key with
a real reason to exist; there is none here. An artifact is derived data
keyed entirely by the chart set it was built from, so it belongs under
the same boat-wide ``Config.data_root`` every other provider's derived
data does (:func:`mivnav.config.base.provider_root`, the M-DATA-3 shape),
under the ``routing`` provider that owns it::

    <data_root>/routing/mivnav/<chart_set_id>.catzoc-<mode>.mivnav

**Why NOT beside the chart set** (``data_root/ocharts/<set_id>/``), which
is where this was expected to go — measured, not assumed:
:func:`mivnav.features.ocharts.sets.dir_sequence` defines a chart set's
``sequence`` as *the max ``st_mtime_ns`` over the set directory AND its
direct entries*. Writing an artifact into that directory therefore moves
the very number the artifact records as its own
``ChartSetIdentity.sequence`` — the file would be born stale, every
build's own ``staleness()`` check would report ``Staleness::Sequence``
immediately, and no artifact could ever be used. That is a hard,
mechanical reason, not a preference. It also keeps a big derived file out
of a directory whose contents are otherwise all licensed chart material a
user may back up or move wholesale.

**Why the CATZOC mode is in the FILENAME.** ``catzoc_allowance_mode`` is
the one build-time policy knob ``chartcore::mivnav::build_region`` takes
(§6: a survey-confidence policy for the whole artifact, never a vessel
property), and it is *not* recorded in the file's own header — nothing in
``ArtifactVersions``/``ChartSetIdentity`` covers it, so ``staleness()``
cannot notice a mismatch. An artifact built under ``"off"`` served to a
request running ``"full"`` would be exactly the bug code review already
found once inside ``chartcore::python::topology_diagnostics``: the
topology cross-check silently answering under a laxer hazard policy than
the fine search it is checking. Putting the mode in the name makes that
unrepresentable — a request under a mode nothing was built for simply
finds no file and says so — at the cost of one file per mode actually
used. The alternative (a header field) is a `.mivnav` format change, and
the format is deliberately out of scope for this wiring step.
"""

from __future__ import annotations

import re
from pathlib import Path

import chartcore

from mivnav.config.base import provider_root

#: The provider whose ``data_root`` subtree owns routing-derived data.
#: ``routing`` already exists as a provider id (``routing_data_provider``);
#: this is the first thing it actually keeps on disk.
ARTIFACT_PROVIDER = "routing"

#: One more level under the provider root, so a future second kind of
#: routing-derived artifact does not have to share a flat directory with
#: this one.
ARTIFACT_SUBDIR = "mivnav"

ARTIFACT_SUFFIX = ".mivnav"

#: The two values ``chartcore.MivnavRoute.topology_source`` can take,
#: mirrored here so nothing on this side compares against a bare literal.
#: Defined in Rust (``chartcore/src/python.rs``'s
#: ``TOPOLOGY_SOURCE_ARTIFACT``/``TOPOLOGY_SOURCE_REBUILT``) — this is a
#: mirror of a cross-language contract, not the definition, so a change
#: there has to be made here too. Kept short deliberately: the pair is
#: small enough that a mirror is cheaper and clearer than reaching back
#: across the pyo3 boundary for two constants.
TOPOLOGY_SOURCE_ARTIFACT = "artifact"
TOPOLOGY_SOURCE_REBUILT = "rebuilt"

#: Chart-set ids that may be turned into a path. Identical to
#: :data:`mivnav.features.ocharts.sets._ID_OK` — duplicated rather than
#: imported for ``backend/.importlinter``'s feature-independence contract,
#: the same reason ``routing/hazards.py`` duck-types its ``ocharts``
#: parameter. Nothing here should ever see an id that fails this (the
#: o-charts store skips such directories outright), which is exactly why
#: it is worth refusing loudly: a path built from an unvalidated id is a
#: traversal waiting to happen, and this module's only inputs come off
#: HTTP request bodies.
_ID_OK = re.compile(r"^[A-Za-z0-9._-]+$")


class UnusableChartSetId(ValueError):
    """A chart-set id that must never be joined onto a path."""


def artifact_dir(data_root: Path) -> Path:
    """``<data_root>/routing/mivnav`` — the one directory every chart
    set's artifact lives flat inside. Not created here; the build runner
    creates it when it publishes."""
    return provider_root(data_root, ARTIFACT_PROVIDER) / ARTIFACT_SUBDIR


def artifact_path(data_root: Path, chart_set_id: str, catzoc_allowance_mode: str) -> Path:
    """Where THIS chart set's artifact for THIS CATZOC allowance mode
    lives. See the module docstring for why the mode is part of the name.

    Raises :class:`UnusableChartSetId` for an id that is not a plain
    ``[A-Za-z0-9._-]+`` token — the guard, not a formality: the id
    reaches here straight off a request body."""
    if not _ID_OK.match(chart_set_id):
        raise UnusableChartSetId(
            f"chart set id {chart_set_id!r} is not a plain [A-Za-z0-9._-] token"
        )
    mode = catzoc_allowance_mode if _ID_OK.match(catzoc_allowance_mode) else "unknown"
    return artifact_dir(data_root) / f"{chart_set_id}.catzoc-{mode}{ARTIFACT_SUFFIX}"


def artifact_status(
    data_root: Path,
    chart_set_id: str,
    sequence: int,
    catzoc_allowance_mode: str,
) -> dict:
    """Whether the artifact for ``chart_set_id`` may be used right now,
    and if not, precisely why — ``chartcore.mivnav_artifact_status``
    (§19's own ``Staleness``, which NAMES the stale component) plus the
    two states that stop the file being opened at all.

    ``sequence`` MUST be the o-charts store's own ``cs.sequence``, the
    same max-mtime number that already invalidates the tile cache
    (CLAUDE.md's ``TILE_SCHEMA_VERSION`` note) — that is the whole reason
    ``chartcore::mivnav::ChartSetIdentity`` reuses it, so the two caches
    can never disagree about what "current" means.

    Never raises for a missing/broken file; the returned dict says so
    (``present``/``usable``/``kind``/``reason``). Adds the two facts the
    Rust side has no way to know: which chart set and which CATZOC mode
    this status is about."""
    path = artifact_path(data_root, chart_set_id, catzoc_allowance_mode)
    status = chartcore.mivnav_artifact_status(path, chart_set_id, sequence)
    status["chart_set_id"] = chart_set_id
    status["catzoc_allowance_mode"] = catzoc_allowance_mode
    return status
