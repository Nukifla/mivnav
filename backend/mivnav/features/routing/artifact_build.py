# SPDX-License-Identifier: GPL-2.0-only
"""The background job that builds one chart set's ``.mivnav`` routing
artifact — the backend half of ``MIVNAV_ARTIFACT_TODO.md``'s "manual
build-trigger endpoint".

**Manual trigger ONLY.** Nothing in this module is wired to chart-set
install, update or delete, and nothing should be: a build is
``O(bands × region size)`` (``chartcore::mivnav::persist``'s own module
docs — ten sweeps of the whole region, because §6 forbids the build from
knowing a vessel's draft, so it precomputes every band or none), which is
minutes of Pi CPU. Making that a side effect of installing charts would
wedge the boat's server exactly when a sailor is trying to get charts
onto it. This was an explicit user decision, recorded here rather than
only in the plan.

**Why it cannot run on the request path**, and why this reuses the ingest
job spine rather than inventing a second one: :class:`mivnav.ingest.
runner.IngestRunner` is already the settled shape for "one long
background bake at a time, poll-able status, a capped log, cancel between
stages" (POI and satellite both ride it). The one thing this adds is the
report: ``chartcore.mivnav_build_artifact`` hands back §20's "record per
run" — tile counts, tiles per resolution rung, blocked/no-coverage/
charted-depth cell counts — and those numbers are the ONLY signal anyone
gets that the build saw the charts it should have. CLAUDE.md's
``#TSSLPT-OVERSCALE`` entry is the same failure one layer up: a fix whose
own tests pass while the deployed thing silently did nothing,
indistinguishable from success. A build that quietly ran over zero cells
would look identical to one that worked, so every one of those numbers
goes on the wire.

**Publishing is already atomic** (``write_artifact_atomically``: temp
file in the same directory, ``sync_all``, rename), so a rebuild cannot
disturb a request holding the old file — this module deliberately adds no
locking of its own around it.

**Cancellation is coarse, honestly so.** The per-cell decode loop checks
:meth:`~mivnav.ingest.runner.IngestRunner.cancel_requested` between
cells, so a cancel during the decode stage lands promptly. The build
itself is ONE ``chartcore.mivnav_build_artifact`` call that releases the
GIL and runs to completion — there is no checkpoint inside it, so a
cancel there does not *stop* it, it runs out its remaining minutes and
then :meth:`~mivnav.ingest.runner.IngestRunner._run_guarded` turns the
normal return into ``state="cancelled"`` (never ``"done"``, and the
atomic publish that already happened leaves a *valid* artifact, not a
partial one). The progress callback does check ``cancel_requested()``
and stops feeding the bar/log the moment a cancel is in, so the UI
reflects it immediately even though the CPU work does not. A build that
could truly abort mid-bake would need a cancel token threaded through
``chartcore.mivnav_build_artifact`` and its refine / band loops —
deferred, not pretended.

**A known, unmeasured cost of decoding the whole set**: cells are decoded
through ``ocharts.load_cell``, which is the shared byte-budgeted LRU
(:mod:`mivnav.features.ocharts.cache` — thread-safe, single-flight, and
already fed from a background thread by the overview warmer, so running
it from here is an established pattern rather than a new race). But a
whole national set is far more bytes than that budget, so a big build
will evict whatever the tile path had warm and leave the cache cold
behind it. On the one committed fixture this is invisible (one 38 KB
cell); on the 314-cell FNC-DE set it has not been measured. Recorded as a
known cost rather than pre-optimised — see ``MIVNAV_ARTIFACT_TODO.md``'s
"measure a real region" item, which is where that number should come
from.

``ocharts`` is duck-typed here, exactly as in
:mod:`mivnav.features.routing.hazards` and for the same reason:
``backend/.importlinter``'s feature-independence contract forbids the
routing feature importing ``mivnav.features.ocharts``, even for a type
hint. ``routes.py`` resolves the real service via ``Depends(get_ocharts)``
and passes it in live.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

import chartcore

from mivnav.ingest.runner import ST_BAKE, ST_FETCH, BaseJobStatus, IngestRunner

from .mivnav_artifact import artifact_path

log = logging.getLogger(__name__)


class MivnavBuildError(Exception):
    """A build could not be started: no such chart set, an ambiguous
    request with several installed, or one already running."""


#: Process-wide, held for the whole of :meth:`MivnavBuildRunner._build`.
#: Belt to :class:`~mivnav.ingest.runner.IngestRunner`'s own braces, and
#: not redundant: the runner instance lives on :class:`mivnav.features.
#: routing.runtime.RoutingRuntime`, so a ``POST /config/reload`` that
#: rebuilds the whole :class:`~mivnav.api.deps.Runtime` mid-build mints a
#: FRESH runner that reports ``idle`` and would happily start a second
#: build for the same chart set. Two concurrent builds of one set are not
#: merely wasteful: ``write_artifact_atomically``'s temp file is
#: ``.<name>.tmp.<pid>`` (``chartcore/src/mivnav/format.rs``), so two
#: builds in the SAME process share one temp path and one of them can
#: rename a half-written file over the real artifact. Found by code
#: review; this is the cheapest fix that does not require a format change.
_PROCESS_BUILD_LOCK = threading.Lock()


@dataclass
class JobStatus(BaseJobStatus):
    """What a ``.mivnav`` build reports, on top of
    :class:`~mivnav.ingest.runner.BaseJobStatus`'s generic
    ``state``/``detail``/``error``/progress/``log`` fields.

    Every ``chartcore.MivnavBuildReport`` number appears here verbatim
    rather than summarised — see this module's docstring for why the
    report IS the point of the endpoint. All default to 0/empty, so a
    status polled before (or during) the first build is well-formed
    rather than absent."""

    #: Which chart set this build is for, and at what ``sequence`` — the
    #: identity written into the artifact's own header, so a reader can
    #: tell what a later ``staleness()`` complaint is comparing against.
    chart_set_id: str = ""
    chart_set_sequence: int = 0
    #: The CATZOC allowance policy the artifact was built under (§6's one
    #: legitimate build-time knob), and where it was published. The mode
    #: is part of the file NAME — see :mod:`.mivnav_artifact`.
    catzoc_allowance_mode: str = ""
    path: str = ""
    bytes: int = 0

    #: Chart cells the build actually decoded and saw. The first number
    #: to read: zero-ish against a set that has hundreds is the "the
    #: build saw nothing" symptom this whole report exists to expose.
    cell_count: int = 0
    #: Cells that would not decode. Always 0 on a ``done`` build — a
    #: single unreadable cell FAILS the job rather than publishing a
    #: partial region (see :meth:`MivnavBuildRunner._build`); this field
    #: exists so a failed job says how many, alongside which.
    skipped_cells: int = 0
    #: §20's record per run, verbatim from ``BuildReport``.
    tile_count: int = 0
    vector_required_tiles: int = 0
    total_cells: int = 0
    blocked_cells: int = 0
    no_coverage_cells: int = 0
    charted_depth_cells: int = 0
    #: Tiles at each rung, and the rung sizes in metres at the same index
    #: (so a reader need not hardcode the resolution ladder to label it).
    tiles_per_rung: list[int] = field(default_factory=list)
    resolution_ladder_m: list[float] = field(default_factory=list)
    #: Precomputed topology actually written: bands (every rung of
    #: ``BAND_LADDER_M``), and portals/shortcuts summed over all of them.
    bands: int = 0
    portals: int = 0
    shortcuts: int = 0
    #: Wall clock, seconds, of the ``chartcore.mivnav_build_artifact``
    #: call alone (not the decode stage before it) — the number that says
    #: whether this is viable on the boat's Pi at all.
    build_seconds: float = 0.0
    #: Wall clock, seconds, of the decode stage (every cell through
    #: ``ocharts.load_cell``) that runs BEFORE the build. Split out from
    #: ``build_seconds`` so a slow national run can be attributed to
    #: decode vs. build — the module docstring's "known, unmeasured cost
    #: of decoding the whole set", now measured.
    decode_seconds: float = 0.0


class MivnavBuildRunner(IngestRunner[JobStatus]):
    """One background ``.mivnav`` build at a time; status is poll-able.

    Holds no store and caches nothing: ``data_root`` and the routing
    config slice are read LIVE at the start of each build (via the two
    callables handed in), so a ``PATCH /config`` takes effect on the next
    build with no restart and without re-minting the runner — the same
    live-read shape :class:`mivnav.features.poi.ingest.PoiIngestRunner`
    uses for its Overpass settings, minus the store identity it has to be
    keyed on and this has not.
    """

    status_cls = JobStatus
    busy_error = MivnavBuildError
    job_name = "mivnav artifact build"

    def __init__(
        self,
        data_root: Callable[[], Path],
        catzoc_allowance_mode: Callable[[], str],
    ) -> None:
        super().__init__()
        self._data_root = data_root
        self._catzoc_allowance_mode = catzoc_allowance_mode

    def build(self, ocharts, chart_set_id: str | None = None) -> None:
        """Start a background build for ``chart_set_id``. Returns
        immediately; poll :meth:`~mivnav.ingest.runner.IngestRunner.
        status`.

        ``chart_set_id=None`` is allowed only when exactly ONE chart set
        is installed, and means that one — a convenience for the common
        single-set boat that refuses to guess as soon as guessing could
        be wrong (several sets installed raises rather than picking the
        first, since building the wrong one wastes minutes of Pi CPU and
        leaves the set you wanted still unbuilt).

        The chart set, its ``sequence``, ``data_root`` and the CATZOC
        mode are all resolved HERE, synchronously, and carried into the
        job — so a concurrent config edit or chart-set rescan cannot
        change what this run is building half way through, and an
        unknown/ambiguous id is an immediate error to the caller rather
        than a background failure they have to poll for.
        """
        sets = ocharts.sets()
        if chart_set_id is None:
            if len(sets) != 1:
                raise MivnavBuildError(
                    f"{len(sets)} chart sets are installed — name the one to build "
                    f"(chart_set_id), there is no safe default"
                )
            chart_set_id = next(iter(sets))
        cs = sets.get(chart_set_id)
        if cs is None:
            raise MivnavBuildError(f"no installed chart set {chart_set_id!r}")
        if not cs.cells:
            raise MivnavBuildError(
                f"chart set {chart_set_id!r} has no readable cells to build from"
            )

        data_root = self._data_root()
        mode = self._catzoc_allowance_mode()
        # Raises UnusableChartSetId for an id that must never be joined
        # onto a path. Deliberately before `_start`, so a bad id is a
        # synchronous error rather than a background one.
        path = artifact_path(data_root, chart_set_id, mode)

        self._start(
            f"{chart_set_id} ({len(cs.cells)} cells, CATZOC {mode})",
            lambda: self._build(ocharts, cs, path, mode),
        )

    def _build(self, ocharts, cs, path: Path, catzoc_allowance_mode: str) -> None:
        if not _PROCESS_BUILD_LOCK.acquire(blocking=False):
            raise MivnavBuildError(
                "another mivnav artifact build is already running in this process "
                "(a config reload can leave one behind a fresh runner) — wait for it"
            )
        try:
            self._build_locked(ocharts, cs, path, catzoc_allowance_mode)
        finally:
            _PROCESS_BUILD_LOCK.release()

    def _build_locked(self, ocharts, cs, path: Path, catzoc_allowance_mode: str) -> None:
        self._update(
            state=ST_FETCH,
            chart_set_id=cs.id,
            chart_set_sequence=cs.sequence,
            catzoc_allowance_mode=catzoc_allowance_mode,
            path=str(path),
        )
        self._log(f"decoding {len(cs.cells)} cells of chart set {cs.id}")

        # -- decode ---------------------------------------------------------
        # Every cell of the set, not a corridor selection: §6 forbids the
        # build from knowing a vessel's draft OR its route, so the region
        # is the whole chart set.
        #
        # **A cell that will not decode FAILS the build**, deliberately
        # unlike `hazards.cells_for_line`, which logs and skips. That
        # difference is the point, and it was a real code-review finding
        # against the first draft of this file, which copied the skip:
        # a route request's cell list is a per-request, best-effort
        # selection that nothing persists, so dropping one broken cell
        # costs that one request some information. An ARTIFACT is a
        # durable, region-wide claim that every later request trusts
        # silently — and the file records only `ChartSetIdentity{id,
        # sequence}`, so `staleness()` can NEVER notice that it covers
        # fewer cells than the set does. One transient oexserverd hiccup
        # mid-build would otherwise publish half a region that
        # `GET /routing/mivnav/artifacts` reports `usable: true` forever.
        # That is precisely CLAUDE.md's `#TSSLPT-OVERSCALE` shape — a
        # silent, permanent, plausible-looking wrong answer — and this
        # module's whole docstring is about not having it. Refusing to
        # publish a knowingly-incomplete region is the safe direction;
        # the error names the cells, so a genuinely broken one can be
        # fixed or removed and the build re-run.
        cells = []
        skipped: list[str] = []
        t_decode = time.monotonic()
        for i, cell in enumerate(cs.cells):
            if self.cancel_requested():
                raise MivnavBuildError("cancelled during decode")
            try:
                cells.append(ocharts.load_cell(cs, cell))
            except Exception:  # noqa: BLE001 — collected, then fatal below
                skipped.append(cell.path.name)
                log.warning("mivnav build: cell %s would not decode", cell.path.name, exc_info=True)
                self._log(f"cell {cell.path.name} would not decode")
            self._progress(i + 1, len(cs.cells), task="decoding cells")
        decode_seconds = time.monotonic() - t_decode
        self._update(
            cell_count=len(cells),
            skipped_cells=len(skipped),
            decode_seconds=decode_seconds,
        )
        self._log(
            f"decoded {len(cells)} cells in {decode_seconds:.1f}s"
            + (f" ({len(skipped)} would not decode)" if skipped else "")
        )
        if skipped:
            shown = ", ".join(skipped[:10]) + (" ..." if len(skipped) > 10 else "")
            raise MivnavBuildError(
                f"{len(skipped)} of {len(cs.cells)} cells in chart set {cs.id!r} would not "
                f"decode ({shown}) — refusing to publish an artifact covering only part of "
                "the region, since nothing downstream could ever tell that it does"
            )
        if not cells:
            raise MivnavBuildError(
                f"chart set {cs.id!r} decoded no cells at all — nothing to build from"
            )

        # -- build + publish ------------------------------------------------
        self._update(state=ST_BAKE)
        self._progress(0, 0, task="starting build")
        self._log(
            f"building {len(cells)} cells into {path} "
            f"(CATZOC {catzoc_allowance_mode}, sequence {cs.sequence})"
        )
        path.parent.mkdir(parents=True, exist_ok=True)

        # `chartcore.mivnav_build_artifact` runs for minutes with the GIL
        # released; it calls this back (GIL re-acquired) at each quadtree
        # refine pass, as each of the ten depth bands finishes, and around
        # the file write. `phase` becomes the sub-stage label, `done`/
        # `total` the bar (`total == 0` -> indeterminate), and a `note`
        # (only some calls carry one) is appended to the job log.
        #
        # It cannot ABORT the build -- that is one GIL-releasing call with
        # no interior checkpoint (see this module's docstring), and
        # `chartcore`'s progress bridge swallows a raising callback by
        # design -- but it is the one place the GIL is held mid-bake, so
        # it checks `cancel_requested()` and goes silent once a cancel is
        # in: the bar stops advancing to 100% under a sailor who already
        # hit Cancel, and `_run_guarded` still turns the eventual normal
        # return into state="cancelled". The `_progress`/`_log` calls
        # themselves must never fail the build, so they stay guarded.
        def _on_progress(phase: str, done: int, total: int, note: str | None) -> None:
            if self.cancel_requested():
                return
            try:
                self._progress(int(done), int(total), task=phase)
                if note:
                    self._log(note)
            except Exception:  # noqa: BLE001 — a status/log hiccup must not break the build
                log.warning("mivnav build: progress callback failed", exc_info=True)

        t0 = time.monotonic()
        report = chartcore.mivnav_build_artifact(
            path,
            cs.id,
            cs.sequence,
            cells,
            catzoc_allowance_mode=catzoc_allowance_mode,
            progress=_on_progress,
        )
        seconds = time.monotonic() - t0

        self._update(
            bytes=report.bytes,
            tile_count=report.tile_count,
            vector_required_tiles=report.vector_required_tiles,
            total_cells=report.total_cells,
            blocked_cells=report.blocked_cells,
            no_coverage_cells=report.no_coverage_cells,
            charted_depth_cells=report.charted_depth_cells,
            tiles_per_rung=list(report.tiles_per_rung),
            resolution_ladder_m=list(report.resolution_ladder_m),
            bands=report.bands,
            portals=report.portals,
            shortcuts=report.shortcuts,
            build_seconds=seconds,
        )
        rungs = ", ".join(
            f"{n}@{m:g}m"
            for n, m in zip(report.tiles_per_rung, report.resolution_ladder_m)
            if n
        )
        self._log(
            f"built {report.tile_count} tiles ({rungs}) / {report.total_cells} cells "
            f"({report.blocked_cells} blocked, {report.no_coverage_cells} no-coverage), "
            f"{report.bands} bands / {report.portals} portals / {report.shortcuts} shortcuts, "
            f"{report.bytes} bytes in {seconds:.1f}s (decode {decode_seconds:.1f}s)"
        )
        # The numbers that answer "did it see the charts it should have",
        # on the server's own console too — a status blob nobody polls is
        # not evidence.
        log.info(
            "mivnav build %s: %d cells -> %d tiles, %d blocked, %d no-coverage, "
            "%d charted-depth, %d bands, %d portals, %d shortcuts, %d bytes, "
            "decode %.1fs + build %.1fs",
            cs.id,
            len(cells),
            report.tile_count,
            report.blocked_cells,
            report.no_coverage_cells,
            report.charted_depth_cells,
            report.bands,
            report.portals,
            report.shortcuts,
            report.bytes,
            decode_seconds,
            seconds,
        )
