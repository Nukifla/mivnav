# SPDX-License-Identifier: GPL-2.0-only
"""The ``notices`` feature's lifecycle: every notices DATASET keeps its own
raw copy of its source on the boat's disk; ``/notices/*`` serves all
enabled ones merged — online or not.

Notices are a dataset provider like POI or satellite: what is pulled
(source + regions) and when (``schedule``/``ttl_s``) is one
``Config.datasets`` entry each, and updates run through the generic path —
:class:`~mivnav.features.notices.ingest.NoticesIngestRunner`, dispatched by
the dataset scheduler, the Datasets tab's Bake button or ``POST
/notices/refresh``. This module is the part that is NOT generic:

* :meth:`NoticesRuntime.pull` — one update's body. The RAW bundle (every
  feed, as Niord sent it) is written atomically to
  ``data_root/notices/<dataset id>/snapshot.json``. **A failed update never
  touches it** (osm_world's rule): stale notices are still the best
  information on a boat with no uplink, and the client shows how old they
  are. Side feeds degrade separately: firing areas, EfS A/B and today's
  firing schedule each fall back to the previous bundle's copy when only
  they fail; the schedule (an unofficial endpoint) falls back further to
  the firing-exercise messages' own dates
  (:func:`normalize.firing_windows_today`).
* :meth:`NoticesRuntime.served` — normalising is a pure function of
  ``(bundle, today, options)`` and simply re-runs when a snapshot changes,
  the Danish day rolls over (today's firing state stays right offline) or
  a dataset's regions change: the REGION FILTER applies here, so editing a
  dataset's regions takes effect at once, without a refetch. The datasets
  are merged in config order (a message two datasets hold appears once),
  and the search index gets one ``notices`` slice per dataset.
* A brand-new dataset on an automatic schedule is pulled on the first
  ``/notices/status`` request (:meth:`NoticesRuntime.first_runs_due`)
  rather than waiting out the scheduler's first poll — safety data should
  be there as soon as the plotter is opened.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

import httpx

from mivnav.config.base import dataset_dir, provider_root
from mivnav.config.model import Config, DatasetConfig
from mivnav.feature import FeatureCtx
from mivnav.features.notices.catalog import NoticeSource
from mivnav.features.notices.client import (
    DOMAIN_ALMANAC,
    DOMAIN_ANNEX,
    DOMAIN_FIRING_AREAS,
    NIORD_TZ,
    NiordClient,
    NiordError,
    NiordNotFound,
)
from mivnav.features.notices.ids import SOURCE_DK_NIORD
from mivnav.features.notices.model import Message
from mivnav.features.notices.normalize import (
    FAMILIES,
    Normalized,
    Options,
    attachment_key,
    merge_normalized,
    normalize_bundle,
    normalize_message,
)

if TYPE_CHECKING:
    from mivnav.ingest.runner import IngestRunner

log = logging.getLogger(__name__)

__all__ = [
    "NoticesNotFound",
    "NoticesRuntime",
    "NoticesUnavailable",
    "OFFLINE_BACKOFF_S",
    "build_notices_runtime",
]

PROVIDER = "notices"
SNAPSHOT_FILE = "snapshot.json"
ATTACHMENTS_DIR = "attachments"
#: Details of notices no dataset holds (cancelled references), fetched once
#: — provider-wide, beside the dataset directories.
REFERENCES_DIR = "extra"
#: Bump when the stored bundle's SHAPE changes (not when normalising does —
#: that re-runs on load anyway). An unknown schema is ignored, not parsed.
BUNDLE_SCHEMA = 1

#: A first pull that failed is not retried from ``/notices/status`` sooner
#: than this (the scheduler's own floor is one attempt per ``ttl_s``).
OFFLINE_BACKOFF_S = 5 * 60.0

#: EfS A/B (yearly general info, ice service) change rarely: pulled at most
#: daily rather than with every update.
SIDE_FEED_MAX_AGE_S = 24 * 3600.0

SEARCH_SOURCE = "notices"

NO_DATASET = (
    "No notices dataset is enabled on the boat's server — add one under "
    "Settings › Datasets."
)


class NoticesNotFound(Exception):
    """No such notice, here or upstream."""


class NoticesUnavailable(Exception):
    """Not held locally, and Niord can't be asked right now."""


class NoticesCancelled(Exception):
    """An update was cancelled before it wrote anything."""


def _iso(ts: float | None) -> str | None:
    return datetime.fromtimestamp(ts, UTC).isoformat().replace("+00:00", "Z") if ts else None


def _write_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_bytes(data)
    tmp.replace(path)


def _dumps(obj: object) -> bytes:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode()


def _trim_periods(raw: list[Any]) -> list[Any]:
    """The firing-schedule answer embeds every area's FULL parent chain with
    geometry (the whole Danish coastline, ~450 KB); only the area's
    identity and its periods are used."""
    out = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        area = entry.get("area") if isinstance(entry.get("area"), dict) else {}
        out.append(
            {
                "area": {k: area.get(k) for k in ("id", "mrn", "descs") if k in area},
                "firingPeriods": entry.get("firingPeriods") or [],
            }
        )
    return out


def dataset_regions(dataset: DatasetConfig) -> frozenset[str] | None:
    """``params.regions`` as the normaliser's filter; ``None`` (absent) =
    every region of the source. Validated on save (``NoticesDatasetParams``);
    read leniently here so a hand-edited config still serves."""
    regions = dataset.params.get("regions")
    if not isinstance(regions, list):
        return None
    return frozenset(r for r in regions if isinstance(r, str))


@dataclass(frozen=True)
class Served:
    """The merged, normalised notices of every enabled dataset, plus the
    pre-serialised bodies."""

    key: tuple
    version: str
    #: The OLDEST dataset's pull time — what "data from …" must mean.
    fetched_at: float
    norm: Normalized
    map_bytes: bytes
    list_bytes: bytes
    #: dataset id → that dataset's own normalised notices (pre-merge).
    parts: dict[str, Normalized]
    #: dataset id → its pull time.
    fetched: dict[str, float]


class NoticesRuntime:
    def __init__(
        self,
        ctx: FeatureCtx,
        *,
        transport: httpx.BaseTransport | None = None,
        clock: Callable[[], float] = time.time,
        backoff_s: float = OFFLINE_BACKOFF_S,
    ) -> None:
        self._config = ctx.config
        self._search_index = ctx.search_index
        self._transport = transport
        self._clock = clock
        self._backoff_s = backoff_s
        self._lock = threading.Lock()
        self._norm_lock = threading.Lock()
        #: snapshot path → ((mtime_ns, size), bundle or None)
        self._bundles: dict[Path, tuple[tuple[int, int], dict[str, Any] | None]] = {}
        self._served: Served | None = None
        self._baked_version: str | None = None
        self._extra: dict[str, dict[str, Any]] = {}
        self._extra_root: Path | None = None
        #: dataset id → its live runner (registered by the runner factory).
        self._runners: dict[str, IngestRunner] = {}
        #: dataset id → clock time of the last first-run kick.
        self._first_kicks: dict[str, float] = {}
        self._adopted: set[Path] = set()

    # -- config ------------------------------------------------------------

    def _cfg(self) -> Config:
        return self._config.get()

    def root(self) -> Path:
        return provider_root(self._cfg().data_root, PROVIDER)

    def dataset_dir(self, dataset_id: str) -> Path:
        return dataset_dir(self._cfg().data_root, PROVIDER, dataset_id)

    def datasets(self, cfg: Config | None = None) -> list[DatasetConfig]:
        """The datasets ``/notices/*`` serves: enabled bakes, config order."""
        cfg = cfg or self._cfg()
        return [d for d in cfg.datasets if d.provider == PROVIDER and d.enabled and d.mode == "bake"]

    def client(self) -> NiordClient:
        return NiordClient(self._cfg().notices.base_url, transport=self._transport)

    def _today(self) -> date:
        return datetime.fromtimestamp(self._clock(), NIORD_TZ).date()

    def _options(self, regions: frozenset[str] | None) -> Options:
        cfg = self._cfg().notices
        return Options(
            base_url=cfg.base_url,
            regions=regions,
            include_firing_areas=cfg.include_firing_areas,
        )

    def register_runner(self, dataset_id: str, runner: IngestRunner) -> None:
        """Called by the runner factory: the runner whose busy/error state
        ``status()`` reports for ``dataset_id``."""
        with self._lock:
            self._runners[dataset_id] = runner

    # -- disk ----------------------------------------------------------------

    def _bundle_at(self, path: Path) -> tuple[tuple[int, int], dict[str, Any] | None]:
        """The snapshot at ``path`` (``None`` if absent/unreadable), cached
        by its ``(mtime, size)`` so a request costs one ``stat``."""
        try:
            st = path.stat()
            stamp = (st.st_mtime_ns, st.st_size)
        except OSError:
            stamp = (0, 0)
        with self._lock:
            cached = self._bundles.get(path)
        if cached is not None and cached[0] == stamp:
            return cached
        bundle: dict[str, Any] | None = None
        if stamp != (0, 0):
            try:
                raw = json.loads(path.read_bytes())
            except (OSError, ValueError) as e:
                log.warning("notices: unreadable snapshot %s, ignoring: %s", path, e)
            else:
                if isinstance(raw, dict) and raw.get("schema") == BUNDLE_SCHEMA:
                    bundle = raw
                else:
                    log.warning("notices: snapshot %s has an unknown schema, ignoring", path)
        entry = (stamp, bundle)
        with self._lock:
            self._bundles[path] = entry
        return entry

    def _adopt_legacy(self, cfg: Config) -> None:
        """Before notices were datasets the one snapshot lived at
        ``data_root/notices/snapshot.json``. Move it (and its attachments)
        into the first notices dataset that has none yet, so a boat that
        upgrades with no uplink keeps its notices."""
        root = provider_root(cfg.data_root, PROVIDER)
        if root in self._adopted:
            return
        self._adopted.add(root)
        legacy = root / SNAPSHOT_FILE
        if not legacy.is_file():
            return
        target = next((d for d in cfg.datasets if d.provider == PROVIDER), None)
        if target is None:
            return
        directory = dataset_dir(cfg.data_root, PROVIDER, target.id)
        if (directory / SNAPSHOT_FILE).exists():
            return
        try:
            directory.mkdir(parents=True, exist_ok=True)
            legacy.replace(directory / SNAPSHOT_FILE)
            if (root / ATTACHMENTS_DIR).is_dir() and not (directory / ATTACHMENTS_DIR).exists():
                (root / ATTACHMENTS_DIR).replace(directory / ATTACHMENTS_DIR)
            log.info("notices: moved the pre-dataset snapshot into dataset %r", target.id)
        except OSError:
            log.warning("notices: could not adopt the legacy snapshot %s", legacy, exc_info=True)

    # -- serving -------------------------------------------------------------

    def served(self) -> Served | None:
        """The merged notices of every enabled dataset (``None`` before any
        of them ever pulled). Never touches the network."""
        cfg = self._cfg()
        self._adopt_legacy(cfg)
        loaded = []
        for ds in self.datasets(cfg):
            path = dataset_dir(cfg.data_root, PROVIDER, ds.id) / SNAPSHOT_FILE
            stamp, bundle = self._bundle_at(path)
            if bundle is not None:
                loaded.append((ds.id, path, stamp, dataset_regions(ds), bundle))
        if not loaded:
            with self._norm_lock:
                self._served = None
            self._clear_search()
            return None
        opts_key = (cfg.notices.base_url, cfg.notices.include_firing_areas)
        key = (
            tuple((ds_id, path, stamp, regions) for ds_id, path, stamp, regions, _ in loaded),
            self._today().isoformat(),
            opts_key,
        )
        with self._norm_lock:
            current = self._served
            if current is not None and current.key == key:
                return current
            served = self._normalize(loaded, key)
            self._served = served
        self._rebake_search(served)
        return served

    def _normalize(self, loaded: list[tuple], key: tuple) -> Served:
        today = date.fromisoformat(key[1])
        parts: dict[str, Normalized] = {}
        fetched: dict[str, float] = {}
        for ds_id, _path, _stamp, regions, bundle in loaded:
            parts[ds_id] = normalize_bundle(bundle, today=today, opts=self._options(regions))
            fetched[ds_id] = float(bundle.get("fetched_at") or 0.0)
        norm = merge_normalized(list(parts.values()))
        fetched_at = min(fetched.values())
        map_bytes = _dumps(norm.feature_collection)
        items_bytes = _dumps(norm.items)
        version = hashlib.sha256(map_bytes + b"\0" + items_bytes).hexdigest()[:16]
        list_bytes = (
            b'{"version":' + _dumps(version) + b',"fetched_at":' + _dumps(_iso(fetched_at))
            + b',"items":' + items_bytes + b"}"
        )
        return Served(key, version, fetched_at, norm, map_bytes, list_bytes, parts, fetched)

    def _clear_search(self) -> None:
        """No dataset serves (all deleted/disabled): no notice may still be
        found by search either."""
        if self._baked_version == "":
            return
        try:
            index = self._search_index()
            for region in index.regions(SEARCH_SOURCE):
                index.rebake(SEARCH_SOURCE, region, [], updated_at=self._clock())
            self._baked_version = ""
        except Exception:  # noqa: BLE001 — search is a convenience, never fail a request
            log.warning("notices: search-index clear failed", exc_info=True)

    def _rebake_search(self, served: Served) -> None:
        """One search slice per dataset (``region`` = dataset id, so the
        Datasets tab attributes its rows), each holding only the notices it
        CONTRIBUTES to the merge — no duplicate hits for a notice two
        datasets share. Slices of datasets no longer served are emptied."""
        if served.version == self._baked_version:
            return
        try:
            index = self._search_index()
            seen: set[str] = set()
            for ds_id, part in served.parts.items():
                own = [r for r in part.search_records if r.id not in seen]
                seen.update(r.id for r in own)
                index.rebake(SEARCH_SOURCE, ds_id, own, updated_at=served.fetched[ds_id])
            for region in index.regions(SEARCH_SOURCE):
                if region not in served.parts:
                    index.rebake(SEARCH_SOURCE, region, [], updated_at=self._clock())
            self._baked_version = served.version
        except Exception:  # noqa: BLE001 — search is a convenience, never fail a request
            log.warning("notices: search-index rebake failed", exc_info=True)

    # -- updates -------------------------------------------------------------

    def pull(
        self,
        directory: Path,
        source: NoticeSource,
        *,
        cancelled: Callable[[], bool] = lambda: False,
        progress: Callable[[int, int, str], None] = lambda c, t, task: None,
        note: Callable[[str], None] = lambda msg: None,
    ) -> int:
        """One dataset update — the runner's job body. Fetches the whole
        source, writes ``directory/snapshot.json`` atomically, then caches
        attachments. Raises on failure WITHOUT touching the old snapshot.
        Returns the number of messages in the main feed."""
        if source.id != SOURCE_DK_NIORD:
            raise ValueError(f"no fetcher for notices source {source.id!r}")
        path = directory / SNAPSHOT_FILE
        _stamp, prev = self._bundle_at(path)
        started = self._clock()
        bundle = self._fetch_bundle(prev, cancelled=cancelled, progress=progress, note=note)
        if cancelled():
            raise NoticesCancelled("cancelled")
        _write_atomic(path, _dumps(bundle))
        count = len(bundle["main"]["data"])
        note(f"saved {count} messages ({self._clock() - started:.1f} s)")
        log.info("notices: %s: %d messages pulled", directory.name, count)
        try:
            self._after_pull(directory, cancelled=cancelled, progress=progress, note=note)
        except Exception:  # noqa: BLE001 — the snapshot is written; extras are best-effort
            log.warning("notices: post-update work failed", exc_info=True)
        return count

    def _after_pull(
        self,
        directory: Path,
        *,
        cancelled: Callable[[], bool],
        progress: Callable[[int, int, str], None],
        note: Callable[[str], None],
    ) -> None:
        served = self.served()  # rebakes the search index
        part = served.parts.get(directory.name) if served is not None else None
        if part is None:
            # Not served (disabled meanwhile, or a stale runner): normalise
            # just this one so its attachments are still right.
            cfg = self._cfg()
            ds = next((d for d in cfg.datasets if d.provider == PROVIDER and d.id == directory.name), None)
            _stamp, bundle = self._bundle_at(directory / SNAPSHOT_FILE)
            if bundle is None:
                return
            regions = dataset_regions(ds) if ds is not None else None
            part = normalize_bundle(bundle, today=self._today(), opts=self._options(regions))
        if self._cfg().notices.cache_attachments:
            self._cache_attachments(part, directory, cancelled=cancelled, progress=progress, note=note)

    def _fetch_bundle(
        self,
        prev: dict[str, Any] | None,
        *,
        cancelled: Callable[[], bool],
        progress: Callable[[int, int, str], None],
        note: Callable[[str], None],
    ) -> dict[str, Any]:
        cfg = self._cfg().notices
        client = self.client()
        prev = prev or {}
        now = self._clock()
        steps = 5 if cfg.include_firing_areas else 3
        progress(0, steps, "notices feed")
        # The main feed is the one that must succeed: it IS the update.
        main = client.fetch_messages()
        note(f"notices feed: {len(main)} messages")
        bundle: dict[str, Any] = {
            "schema": BUNDLE_SCHEMA,
            "fetched_at": now,
            "main": {"at": now, "data": main},
        }
        step = 1

        def side(key: str, label: str, fetch: Callable[[], list[Any]], max_age: float = 0.0) -> None:
            nonlocal step
            if cancelled():
                raise NoticesCancelled("cancelled")
            progress(step, steps, label)
            step += 1
            old = prev.get(key)
            if old and old.get("data") is not None and now - float(old.get("at") or 0) < max_age:
                bundle[key] = old
                note(f"{label}: kept (pulled at most daily)")
                return
            try:
                data = fetch()
                bundle[key] = {"at": now, "data": data}
                note(f"{label}: {len(data)} messages")
            except NiordError as e:
                log.info("notices: %s feed failed, keeping the previous copy: %s", key, e)
                note(f"{label}: failed ({e}); keeping the previous copy")
                if old:
                    bundle[key] = old

        if cfg.include_firing_areas:
            side("fa", "firing areas", lambda: client.fetch_messages(DOMAIN_FIRING_AREAS))
        elif prev.get("fa"):
            bundle["fa"] = prev["fa"]
        side("almanac", "EfS A", lambda: client.fetch_messages(DOMAIN_ALMANAC), SIDE_FEED_MAX_AGE_S)
        side("annex", "EfS B", lambda: client.fetch_messages(DOMAIN_ANNEX), SIDE_FEED_MAX_AGE_S)

        if cfg.include_firing_areas:
            if cancelled():
                raise NoticesCancelled("cancelled")
            progress(step, steps, "firing schedule")
            day = self._today()
            try:
                periods = _trim_periods(client.fetch_firing_periods(day))
                bundle["periods"] = {"at": now, "day": day.isoformat(), "data": periods}
                note(f"firing schedule {day.isoformat()}: {len(periods)} areas")
            except NiordError as e:
                # Unofficial endpoint: expected to break some day. The
                # firing-exercise messages' own dates are the fallback.
                log.info("notices: firing schedule unavailable, using exercise dates: %s", e)
                note(f"firing schedule unavailable ({e}); using the exercises' own dates")
                old = prev.get("periods")
                if old and old.get("day") == day.isoformat():
                    bundle["periods"] = old
        progress(steps, steps, "saving")
        return bundle

    # -- attachments ---------------------------------------------------------

    def _cache_attachments(
        self,
        part: Normalized,
        directory: Path,
        *,
        cancelled: Callable[[], bool],
        progress: Callable[[int, int, str], None],
        note: Callable[[str], None],
    ) -> None:
        """Download every not-yet-held attachment of this dataset once;
        drop files none of its notices lists any more."""
        adir = directory / ATTACHMENTS_DIR
        wanted = part.attachments
        missing = [k for k in wanted if not (adir / k).exists()]
        client = self.client()
        for i, key in enumerate(missing):
            if cancelled():
                return
            progress(i, len(missing), "attachments")
            info = wanted[key]
            try:
                body, _mime = client.fetch_attachment(info["url"])
            except NiordError as e:
                log.info("notices: attachment %s not cached: %s", info["url"], e)
                continue
            _write_atomic(adir / key, body)
        if missing:
            note(f"attachments: {len(missing)} new")
        if adir.is_dir():
            for f in adir.iterdir():
                if f.is_file() and not f.name.startswith(".") and f.name not in wanted:
                    f.unlink(missing_ok=True)

    def attachment(self, key: str) -> tuple[Path, dict[str, Any]]:
        """``(file on disk, info)`` for an attachment key, downloading it
        through when it isn't held yet. Raises :class:`NoticesNotFound` /
        :class:`NoticesUnavailable`."""
        served = self.served()
        info = served.norm.attachments.get(key) if served else None
        owners = [ds_id for ds_id, part in served.parts.items() if key in part.attachments] if served else []
        for extra in self._extra.values():
            info = info or extra["_attachments"].get(key)
        if info is None:
            raise NoticesNotFound(key)
        for ds_id in owners:
            path = self.dataset_dir(ds_id) / ATTACHMENTS_DIR / key
            if path.is_file():
                return path, info
        target = (
            self.dataset_dir(owners[0]) / ATTACHMENTS_DIR / key
            if owners
            else self.root() / REFERENCES_DIR / ATTACHMENTS_DIR / key
        )
        if target.is_file():
            return target, info
        if not self.datasets():
            raise NoticesUnavailable(NO_DATASET)
        try:
            body, _mime = self.client().fetch_attachment(info["url"])
        except NiordNotFound as e:
            raise NoticesNotFound(key) from e
        except NiordError as e:
            raise NoticesUnavailable(str(e)) from e
        _write_atomic(target, body)
        return target, info

    # -- details -------------------------------------------------------------

    def detail(self, ident: str) -> dict[str, Any]:
        """One notice's detail by uuid or shortId. A notice no dataset holds
        (a cancelled/expired reference) is fetched from Niord once and kept
        on disk — such a message never changes again."""
        served = self.served()
        if served is not None:
            doc_id = ident if ident in served.norm.details else served.norm.aliases.get(ident)
            if doc_id is not None:
                return served.norm.details[doc_id]
        root = self.root()
        if self._extra_root != root:
            self._extra.clear()
            self._extra_root = root
        cached = self._extra.get(ident)
        if cached is not None:
            return cached["doc"]
        path = root / REFERENCES_DIR / (hashlib.sha256(ident.encode()).hexdigest()[:24] + ".json")
        raw: dict[str, Any] | None = None
        try:
            raw = json.loads(path.read_bytes())
        except (OSError, ValueError):
            raw = None
        if raw is None:
            if not self.datasets():
                raise NoticesUnavailable(NO_DATASET)
            try:
                raw = self.client().fetch_message(ident)
            except NiordNotFound as e:
                raise NoticesNotFound(ident) from e
            except NiordError as e:
                raise NoticesUnavailable(str(e)) from e
            _write_atomic(path, _dumps(raw))
        try:
            msg = Message.model_validate(raw)
        except ValueError as e:
            raise NoticesUnavailable(f"Niord sent an unreadable message: {e}") from e
        _row, doc, _feats = normalize_message(msg, None, self._options(None))
        atts = {
            attachment_key(a.path): {"url": a.path, "mime": a.type, "file_name": a.fileName, "size": a.fileSize}
            for a in msg.attachments
            if a.path
        }
        self._extra[ident] = {"doc": doc, "_attachments": atts}
        return doc

    # -- status --------------------------------------------------------------

    def first_runs_due(self) -> list[str]:
        """Enabled datasets on an automatic schedule that have never pulled
        and aren't being pulled — kicked by ``GET /notices/status`` so a
        fresh boat has notices at once, not after the scheduler's first
        poll. At most once per :data:`OFFLINE_BACKOFF_S` each."""
        now = self._clock()
        due = []
        for ds in self.datasets():
            if ds.schedule != "ttl":
                continue
            if (self.dataset_dir(ds.id) / SNAPSHOT_FILE).exists():
                continue
            with self._lock:
                runner = self._runners.get(ds.id)
                last = self._first_kicks.get(ds.id)
                if runner is not None and runner.busy():
                    continue
                if last is not None and now - last < self._backoff_s:
                    continue
                self._first_kicks[ds.id] = now
            due.append(ds.id)
        return due

    def _run_states(self, datasets: list[DatasetConfig]) -> tuple[bool, list[str]]:
        """``(any update running, "<name>: <error>" per dataset whose last
        update failed)`` — off each dataset's live runner."""
        loading = False
        errors: list[str] = []
        for ds in datasets:
            with self._lock:
                runner = self._runners.get(ds.id)
            if runner is None:
                continue
            if runner.busy():
                loading = True
                continue
            st = runner.status()
            if st.get("state") == "error" and st.get("error") != "cancelled":
                errors.append(f"{ds.name}: {st.get('error') or 'update failed'}")
        return loading, errors

    def status(self) -> dict[str, Any]:
        """efs.md §6 ``GET /notices/status``, over the merged datasets."""
        served = self.served()
        datasets = self.datasets()
        loading, errors = self._run_states(datasets)
        error: str | None = None
        if not datasets:
            state, error = "offline", NO_DATASET
        elif errors and not loading:
            state, error = "offline", "; ".join(errors)
        elif served is not None:
            state = "ready"
        elif loading:
            state = "loading"
        else:
            state = "idle"
        by_family = dict(served.norm.by_family) if served else {f: 0 for f in FAMILIES}
        return {
            "state": state,
            "version": served.version if served else None,
            "fetched_at": _iso(served.fetched_at) if served else None,
            "count": len(served.norm.items) if served else 0,
            "by_family": by_family,
            "error": error,
        }

    def stats(self) -> dict[str, Any]:
        """``/providers`` stats — no network, no normalising."""
        datasets = self.datasets()
        loading, errors = self._run_states(datasets)
        served = self._served
        return {
            "datasets": len(datasets),
            "fetched_at": _iso(served.fetched_at) if served else None,
            "loading": loading,
            "error": "; ".join(errors) or None,
        }

    def close(self) -> None:
        """No handles held (each pull opens its own client)."""


def build_notices_runtime(ctx: FeatureCtx) -> NoticesRuntime:
    return NoticesRuntime(ctx)
