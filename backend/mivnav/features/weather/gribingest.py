# SPDX-License-Identifier: GPL-2.0-only
# see docs/architecture/weather-grib-bake.md — DWD-probe discovery, ingest-time
# decompression, and filename-scoped pruning, and why each works that way

from __future__ import annotations

import bz2
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import httpx

from mivnav.features.weather import gribfetch
from mivnav.features.weather.gribfetch import GribProduct, ListedFile
from mivnav.ingest.runner import ST_BAKE, ST_FETCH, BaseJobStatus, IngestRunner

log = logging.getLogger(__name__)

GRIB_DIR = "grib"


class WeatherGribIngestError(Exception):
    """A weather GRIB bake could not start, or failed mid-run."""


@dataclass
class GribJobStatus(BaseJobStatus):
    product: str = ""
    run: str = ""  # ISO UTC of the discovered run, once known
    files: int = 0  # files newly fetched this run (skips already-present)
    pruned: int = 0  # files outside the selected window deleted this run


class WeatherGribIngestRunner(IngestRunner[GribJobStatus]):
    status_cls = GribJobStatus
    busy_error = WeatherGribIngestError
    job_name = "weather GRIB bake"

    def __init__(self, dataset_dir: Path, http: httpx.Client | None = None) -> None:
        super().__init__()
        self._dir = dataset_dir
        self._http = http or httpx.Client(
            timeout=httpx.Timeout(60.0, connect=15.0), follow_redirects=True
        )

    def ingest(self, product_id: str, max_forecast_hours: int | None = None) -> None:
        """Start a background bake of ``product_id``'s wind u/v files, from
        the latest published run out to ``max_forecast_hours`` of lead time
        (``None`` = everything published). Returns immediately."""
        if not product_id:
            raise WeatherGribIngestError("a weather GRIB bake needs a product id")
        try:
            product = gribfetch.product_for(product_id)
        except KeyError as e:
            raise WeatherGribIngestError(str(e)) from e
        self._start(product_id, lambda: self._bake(product, max_forecast_hours))

    def _bake(self, product: GribProduct, max_forecast_hours: int | None) -> None:
        self._update(state=ST_FETCH, task="discover run", product=product.id)
        run_hour, run_dt, u_files, v_files = self._discover_run(product)
        if run_dt is None:
            raise WeatherGribIngestError(f"no published run found for {product.id}")
        self._update(run=run_dt.strftime("%Y-%m-%dT%H:%MZ"))
        by_step_u = {f.step: f for f in u_files}
        by_step_v = {f.step: f for f in v_files}
        steps = sorted(set(by_step_u) & set(by_step_v))
        steps = gribfetch.steps_for_bake(steps, max_forecast_hours=max_forecast_hours)

        self._update(state=ST_BAKE, task="fetching", total=len(steps) * 2, current=0)
        fetched = 0
        kept: set[str] = set()
        done = 0
        product_dir = self._dir / GRIB_DIR / product.id
        for step in steps:
            for dirname, listed in (
                (product.dir_u, by_step_u[step]),
                (product.dir_v, by_step_v[step]),
            ):
                done += 1
                out_name = listed.filename.removesuffix(".bz2")
                kept.add(f"{dirname}/{out_name}")
                target = product_dir / dirname / out_name
                if not target.exists():
                    if self._fetch_one(product, run_hour, dirname, listed.filename, target):
                        fetched += 1
                        self._log(f"fetched {dirname}/{out_name}")
                self._progress(done, len(steps) * 2)
        pruned = _prune_stale(product_dir, keep=kept)
        if pruned:
            self._log(f"pruned {pruned} stale file(s) for {product.id}")
        self._update(files=fetched, pruned=pruned)

    def _discover_run(
        self, product: GribProduct
    ) -> tuple[int, datetime | None, list[ListedFile], list[ListedFile]]:
        """Most recent published run, probed backward (DWD has no "latest"
        manifest). Returns ``(run_hour, None, [], [])`` if nothing in the
        probe window has landed yet."""
        now = datetime.now(timezone.utc)
        candidates = gribfetch.candidate_runs(product, now)
        for run_dt in candidates:
            run_hour = run_dt.hour
            u_html = self._get_listing(f"{product.base_url}/{run_hour:02d}/{product.dir_u}/")
            if u_html is None:
                continue
            u_files = [
                f
                for f in gribfetch.parse_listing(u_html, product.filename_re)
                if f.run == run_dt.strftime("%Y%m%d%H")
            ]
            if not u_files:
                continue
            v_html = self._get_listing(f"{product.base_url}/{run_hour:02d}/{product.dir_v}/")
            v_files = (
                [
                    f
                    for f in gribfetch.parse_listing(v_html, product.filename_re)
                    if f.run == run_dt.strftime("%Y%m%d%H")
                ]
                if v_html is not None
                else []
            )
            if not v_files:
                continue
            return run_hour, run_dt, u_files, v_files
        log.warning(
            "weather GRIB bake: no published run found for %s (checked %d scheduled run times)",
            product.id,
            len(candidates),
        )
        return 0, None, [], []

    def _get_listing(self, url: str) -> str | None:
        try:
            r = self._http.get(url)
        except httpx.HTTPError as e:
            log.warning("weather GRIB bake: listing %s failed: %s", url, e)
            return None
        if r.status_code != 200:
            return None
        return r.text

    def _fetch_one(
        self, product: GribProduct, run_hour: int, dirname: str, filename: str, target: Path
    ) -> bool:
        """Fetch, decompress, and atomically write one ``.grib2.bz2`` to
        ``target``. Returns ``False`` (logged, not raised) on failure — one
        broken step must not fail the whole bake."""
        url = f"{product.base_url}/{run_hour:02d}/{dirname}/{filename}"
        try:
            r = self._http.get(url)
        except httpx.HTTPError as e:
            log.warning("weather GRIB bake: fetching %s failed: %s", url, e)
            return False
        if r.status_code != 200:
            log.warning("weather GRIB bake: fetching %s: HTTP %s", url, r.status_code)
            return False
        try:
            body = bz2.decompress(r.content)
        except OSError as e:
            log.warning("weather GRIB bake: decompressing %s failed: %s", url, e)
            return False
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(f"{target.suffix}.{os.getpid()}.tmp")
        tmp.write_bytes(body)
        tmp.replace(target)
        return True


def _prune_stale(product_dir: Path, *, keep: set[str]) -> int:
    """Delete every ``.grib2`` under ``product_dir`` whose relative path is
    not in ``keep``. Mirrors ``ingest.py``'s ``_prune_stale`` for ``.om``;
    see docs/architecture/weather-grib-bake.md."""
    if not product_dir.is_dir():
        return 0
    removed = 0
    for f in product_dir.rglob("*.grib2"):
        rel = f.relative_to(product_dir).as_posix()
        if rel in keep:
            continue
        try:
            f.unlink()
            removed += 1
        except OSError:
            continue
    for d in sorted((p for p in product_dir.rglob("*") if p.is_dir()), reverse=True):
        try:
            d.rmdir()
        except OSError:
            pass
    return removed
