# SPDX-License-Identifier: GPL-2.0-only
"""The OSM-world-basemap ingest-bake job: resolve today's Protomaps daily
build -> range-extract a zoom-capped sub-pyramid -> ``<id>.pmtiles`` -> rescan.
Uses the external ``pmtiles`` CLI rather than baking from Overpass ourselves
— see docs/architecture/osm-world-ingest.md for why.
"""

from __future__ import annotations

import json
import logging
import subprocess
import tempfile
import threading
import time
from collections.abc import Callable, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

import httpx

from mivnav.config.model import Region
from mivnav.features.osm_world.config import OsmWorldConfig
from mivnav.features.osm_world.sidecar import slugify, write_sidecar
from mivnav.features.osm_world.store import OsmWorldStore
from mivnav.ingest.runner import ST_BAKE, ST_FETCH, BaseJobStatus, IngestRunner

log = logging.getLogger(__name__)

DEFAULT_SET_NAME = "OSM world basemap"

# go-pmtiles prints its own progress bar to stderr, captured only after the
# process exits — so a ticking elapsed-seconds label is the one live signal
# available during an extract.
EXTRACT_HEARTBEAT_S = 10.0

# go-pmtiles' progress bar is one constantly-rewritten line (carriage
# returns, no newlines), so this is really "the last few real lines" (the
# summary), not a truncated progress bar.
STDERR_LOG_LINES = 6


class OsmWorldIngestError(Exception):
    pass


class BuildNotFoundError(OsmWorldIngestError):
    """No Protomaps daily build responded within the configured lookback
    window — see :func:`resolve_build_url`."""


def resolve_build_url(
    http: httpx.Client, build_host: str, *, today: date, lookback_days: int
) -> tuple[str, str]:
    """Most recent Protomaps daily build at or before ``today``, HEAD-checked
    back to ``lookback_days`` ago. Re-resolved at the START of every bake,
    never cached — a pinned date would 404 once it ages out of retention."""
    for i in range(lookback_days):
        d = today - timedelta(days=i)
        datestr = d.strftime("%Y%m%d")
        url = f"{build_host.rstrip('/')}/{datestr}.pmtiles"
        try:
            resp = http.head(url)
        except httpx.HTTPError:
            continue
        if resp.status_code == 200:
            return url, datestr
    raise BuildNotFoundError(
        f"no Protomaps daily build found under {build_host} in the last "
        f"{lookback_days} days"
    )


#: ``(min_lon, min_lat, max_lon, max_lat)``, the same order
#: :meth:`mivnav.config.model.BBox.as_tuple` emits and ``pmtiles extract
#: --bbox`` takes.
Box = tuple[float, float, float, float]


def region_boxes(region: Region | None) -> tuple[Box, ...]:
    """Boxes ``region`` should be extracted to — empty for ``None`` (whole-
    planet bake). Country regions use just ``Region.bbox``; bbox regions use
    ``.bboxes`` in FULL — see docs/architecture/osm-world-ingest.md."""
    if region is None:
        return ()
    if region.country is not None:
        return (region.bbox,)
    return tuple(b.as_tuple() for b in region.bboxes)


def _multipolygon(boxes: Sequence[Box]) -> dict:
    """``boxes`` as a GeoJSON MultiPolygon — the shape ``pmtiles extract
    --region`` reads. Rings are closed (first point repeated last) and wound
    counter-clockwise, the right-hand rule RFC 7946 asks for."""
    return {
        "type": "MultiPolygon",
        "coordinates": [
            [[[w, s], [e, s], [e, n], [w, n], [w, s]]] for (w, s, e, n) in boxes
        ],
    }


@contextmanager
def _area_of_interest_args(boxes: Sequence[Box]):
    """Yield the ``pmtiles extract`` argv fragment for ``boxes``. One box
    takes ``--bbox``; two or more take ``--region`` (needs a temp GeoJSON
    file, kept alive for the duration)."""
    if not boxes:
        yield []
        return
    if len(boxes) == 1:
        w, s, e, n = boxes[0]
        yield [f"--bbox={w},{s},{e},{n}"]
        return
    with tempfile.NamedTemporaryFile("w", suffix=".geojson", delete=True) as f:
        json.dump(_multipolygon(boxes), f)
        f.flush()
        yield [f"--region={f.name}"]


def run_pmtiles_extract(
    binary: str,
    source_url: str,
    out: Path,
    *,
    min_zoom: int,
    max_zoom: int,
    boxes: Sequence[Box] = (),
    on_start: Callable[[subprocess.Popen], None] | None = None,
) -> subprocess.CompletedProcess:
    """Shell out to ``pmtiles extract`` (go-pmtiles). ``on_start`` hands the
    live ``Popen`` to :meth:`OsmWorldIngestRunner._interrupt`, which is why
    this uses ``Popen``/``communicate()`` and not plain ``subprocess.run``."""
    with _area_of_interest_args(boxes) as area_args:
        proc = subprocess.Popen(
            [
                binary,
                "extract",
                source_url,
                str(out),
                f"--minzoom={min_zoom}",
                f"--maxzoom={max_zoom}",
                *area_args,
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        if on_start is not None:
            on_start(proc)
        # Inside the `with`: a `--region` temp file must outlive the process
        # that reads it, and `communicate()` is what waits for that.
        stdout, stderr = proc.communicate()
    return subprocess.CompletedProcess(proc.args, proc.returncode, stdout, stderr)


@dataclass(frozen=True)
class _BakeTarget:
    set_id: str
    name: str
    boxes: tuple[Box, ...] = ()


@dataclass
class JobStatus(BaseJobStatus):
    pass


class OsmWorldIngestRunner(IngestRunner[JobStatus]):
    """One background extract at a time; status is poll-able. Config
    (build host/zoom/binary path) is read fresh at each bake start, so a
    ``PATCH /config`` edit needs no restart."""

    status_cls = JobStatus
    busy_error = OsmWorldIngestError
    job_name = "OSM world basemap extract"

    def __init__(
        self,
        store: OsmWorldStore,
        http: httpx.Client | None = None,
        osm_world_config: Callable[[], OsmWorldConfig] | None = None,
        run_extract: Callable[..., subprocess.CompletedProcess] = run_pmtiles_extract,
        dataset_id: str | None = None,
    ) -> None:
        super().__init__()
        self.store = store
        self._http = http or httpx.Client(timeout=httpx.Timeout(30.0, connect=10.0))
        self._osm_world_config = osm_world_config or OsmWorldConfig
        self._run_extract = run_extract
        # Must match the dataset dir's own name: `mivnav.rescan.pmtiles_candidates`
        # requires `dirname == file stem`, else the bake 404s forever, invisibly.
        self._dataset_id = dataset_id
        # Own lock, not IngestRunner's `_lock`: `_interrupt` runs on the
        # CANCELLING request's thread and must never wait on whatever `_lock`
        # the bake thread might be holding.
        self._proc_lock = threading.Lock()
        self._proc: subprocess.Popen | None = None

    def ingest(
        self,
        name: str | None = None,
        min_zoom: int | None = None,
        max_zoom: int | None = None,
        region: Region | None = None,
    ) -> None:
        """Start a background extract. Returns immediately. ``min_zoom``/
        ``max_zoom`` are per-dataset overrides (``None`` keeps the live
        config); see docs/architecture/osm-world-ingest.md for merge order."""
        cfg = self._osm_world_config()
        boxes = region_boxes(region)
        # Region default applied FIRST so the per-dataset override still wins,
        # and a blank override still tracks a later PATCH /config.
        if boxes and max_zoom is None:
            cfg = cfg.model_copy(update={"max_zoom": cfg.region_max_zoom})
        if min_zoom is not None or max_zoom is not None:
            cfg = cfg.model_copy(
                update={
                    "min_zoom": cfg.min_zoom if min_zoom is None else min_zoom,
                    "max_zoom": cfg.max_zoom if max_zoom is None else max_zoom,
                }
            )
        if cfg.min_zoom > cfg.max_zoom:
            raise ValueError(
                f"dataset zoom override needs min_zoom <= max_zoom (got "
                f"{cfg.min_zoom}..{cfg.max_zoom} once combined with the "
                "boat-wide osm_world config default for whichever side "
                "wasn't overridden)"
            )
        display = name or DEFAULT_SET_NAME
        set_id = self._dataset_id or slugify(display)
        target = _BakeTarget(set_id=set_id, name=display, boxes=boxes)
        self._start(display, lambda: self._bake(target, cfg))

    def _bake(self, target: _BakeTarget, cfg: OsmWorldConfig) -> None:
        self._update(state=ST_FETCH)
        self._progress(0, 0, task="resolving build")
        self._log(f"resolving latest Protomaps daily build from {cfg.build_host}")
        try:
            url, datestr = resolve_build_url(
                self._http, cfg.build_host, today=date.today(), lookback_days=cfg.build_lookback_days
            )
        except BuildNotFoundError as e:
            self._log(str(e))
            raise
        self._log(f"using build {datestr}: {url}")
        if self.cancel_requested():
            raise OsmWorldIngestError("cancelled before the extract started")

        root = self.store.root
        root.mkdir(parents=True, exist_ok=True)
        out = root / f"{target.set_id}.pmtiles"

        self._update(state=ST_BAKE)
        scope = f"{len(target.boxes)} box(es)" if target.boxes else "world"
        self._progress(0, 0, task=f"extracting z{cfg.min_zoom}-{cfg.max_zoom} ({scope})")
        heartbeat_stop = threading.Event()
        heartbeat = threading.Thread(
            target=self._extract_heartbeat, args=(heartbeat_stop, time.time()), daemon=True
        )
        heartbeat.start()
        try:
            try:
                proc = self._run_extract(
                    cfg.pmtiles_binary,
                    url,
                    out,
                    min_zoom=cfg.min_zoom,
                    max_zoom=cfg.max_zoom,
                    boxes=target.boxes,
                    on_start=self._set_current_proc,
                )
            except FileNotFoundError as e:
                raise OsmWorldIngestError(
                    f"pmtiles binary {cfg.pmtiles_binary!r} not found — install go-pmtiles "
                    "(dev box: AUR 'pmtiles'; Pi: deploy/install-deps.sh, i.e. "
                    "`just setup-pi-deps`) or set osm_world.pmtiles_binary to its full path"
                ) from e
        finally:
            heartbeat_stop.set()
            heartbeat.join()
            self._set_current_proc(None)

        for line in proc.stderr.splitlines()[-STDERR_LOG_LINES:]:
            line = line.strip()
            if line:
                self._log(line)
        if proc.returncode != 0:
            tail = proc.stderr.strip()[-500:]
            raise OsmWorldIngestError(f"pmtiles extract failed (exit {proc.returncode}): {tail}")

        self._progress(1, 1)
        write_sidecar(
            root,
            target.set_id,
            name=target.name,
            source_url=url,
            max_zoom=cfg.max_zoom,
            boxes=target.boxes,
        )
        self.store.invalidate()
        self._log(f"{target.name!r} done")

    def _extract_heartbeat(self, stop: threading.Event, start: float) -> None:
        while not stop.wait(EXTRACT_HEARTBEAT_S):
            self._progress(0, 0, task=f"extracting… {int(time.time() - start)}s")

    def _set_current_proc(self, proc: subprocess.Popen | None) -> None:
        """``run_pmtiles_extract``'s ``on_start`` callback, and this bake's
        own cleanup call (``proc=None``) once it exits — see
        :meth:`_interrupt`, the reader of ``self._proc``."""
        with self._proc_lock:
            self._proc = proc

    def _interrupt(self) -> None:
        """Terminate the live ``pmtiles extract`` subprocess — a cancel flag
        alone is never noticed by a process blocked in its own I/O.
        ``terminate()`` is enough; the extract only writes a temp/partial file."""
        with self._proc_lock:
            proc = self._proc
        if proc is not None and proc.poll() is None:
            proc.terminate()
