# SPDX-License-Identifier: GPL-2.0-only
"""freenauticalchart.net as a second chart source, beside the o-charts shop:
CC0 ENC-derived vector charts, no account/subscription/DRM needed. See
docs/architecture/freenauticalchart-source.md for the format/layout/versioning details.
"""

from __future__ import annotations

import json
import logging
import re
import shutil
import struct
from dataclasses import dataclass
from datetime import date
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Mapping

import httpx

log = logging.getLogger(__name__)

#: Base URL of the publisher's download page. The zips are siblings of it;
#: the ``?t=<epoch>`` the page appends to each link is a cache-buster with
#: no effect on the response, so it is deliberately not reproduced here.
FNC_BASE = "https://freenauticalchart.net/download/"

#: Per-installed-set provenance, written into the set directory. Inert to
#: everything else in the package: `.keys.parse_set_info` reads only
#: `*.xml`/`Chartinfo.txt`, and `.sets.cell_files` only cell extensions.
MARKER = ".fnc-source.json"

SOURCE_ID = "freenauticalchart.net"

# OSENC framing: `u16 record_type; u32 record_length` LE. First record is
# HEADER_SENC_VERSION (1); 200..299 is the range chartcore accepts (chartcore/src/osenc/mod.rs).
_OSENC_HEADER = struct.Struct("<HIH")
_OSENC_VERSION_RECORD = (1, 8)
_OSENC_VERSION_RANGE = range(200, 300)

# Cells ship under this extension and must be renamed to be openable.
PUBLISHED_CELL_SUFFIX = ".s57"
NORMALIZED_CELL_SUFFIX = ".senc"

_DATE_IN_TITLE = re.compile(r"(\d{4}-\d{2}-\d{2})")
_SET_ID_OK = re.compile(r"^[A-Za-z0-9._-]+$")


@dataclass(frozen=True)
class FncRegion:
    """One published region."""

    id: str
    label: str

    @property
    def file(self) -> str:
        return f"fnc-{self.id}.zip"

    @property
    def url(self) -> str:
        return FNC_BASE + self.file


REGIONS: dict[str, FncRegion] = {
    r.id: r
    for r in (
        FncRegion("de", "Germany — North Sea and Baltic (BSH)"),
        FncRegion("nl", "Netherlands — inland and coastal (Rijkswaterstaat)"),
    )
}


class FncError(Exception):
    pass


def region(region_id: str) -> FncRegion:
    try:
        return REGIONS[region_id]
    except KeyError:
        known = ", ".join(sorted(REGIONS))
        raise FncError(f"unknown freenauticalchart region {region_id!r} (known: {known})") from None


# -- remote version ---------------------------------------------------------


@dataclass(frozen=True)
class FncVersion:
    """What the publisher currently serves for one region."""

    region: str
    url: str
    etag: str = ""
    last_modified: str = ""
    size: int = 0

    @property
    def published(self) -> str:
        """``Last-Modified`` as ``YYYY-MM-DD``, or ``""``."""
        return _http_date(self.last_modified)

    def as_dict(self) -> dict:
        return {
            "region": self.region,
            "url": self.url,
            "etag": self.etag,
            "last_modified": self.last_modified,
            "published": self.published,
            "size": self.size,
        }


def _http_date(value: str) -> str:
    if not value:
        return ""
    try:
        return parsedate_to_datetime(value).date().isoformat()
    except (TypeError, ValueError):
        return ""


class FncClient:
    """Reads the publisher's current version for a region. Timeouts are
    short: the caller is a synchronous route walking all regions in series —
    a generous connect timeout there just hangs the settings panel."""

    #: (read, connect). Enough for a CDN HEAD over a bad boat-LAN uplink,
    #: little enough that two unreachable regions still answer in ~10 s.
    DEFAULT_TIMEOUT = httpx.Timeout(10.0, connect=5.0)

    def __init__(self, http: httpx.Client | None = None) -> None:
        self._http = http or httpx.Client(timeout=self.DEFAULT_TIMEOUT, follow_redirects=True)

    def version(self, region_id: str) -> FncVersion:
        r = region(region_id)
        try:
            resp = self._http.head(r.url)
            resp.raise_for_status()
        except httpx.HTTPError as e:
            raise FncError(f"cannot reach {r.url}: {e}") from e
        return version_from_headers(r, resp.headers)

    def catalog(self, sets_dir: Path) -> list[dict]:
        """Every region, with its published version and what is installed."""
        out = []
        for r in REGIONS.values():
            entry: dict = {"region": r.id, "label": r.label, "url": r.url}
            try:
                entry["available"] = self.version(r.id).as_dict()
            except FncError as e:
                entry["available"] = None
                entry["error"] = str(e)
            installed = installed_marker(sets_dir, r.id)
            entry["installed"] = installed
            entry["update_available"] = update_available(entry["available"], installed)
            out.append(entry)
        return out


def version_from_headers(r: FncRegion, headers: Mapping[str, str]) -> FncVersion:
    return FncVersion(
        region=r.id,
        url=r.url,
        etag=headers.get("etag", ""),
        last_modified=headers.get("last-modified", ""),
        size=int(headers.get("content-length") or 0),
    )


def update_available(available: dict | None, installed: dict | None) -> bool:
    if available is None:
        return False
    if installed is None:
        return True
    # ETag first, Last-Modified as fallback; not Chartinfo.txt's date, which
    # trails the file's mtime by a day (see freenauticalchart-source.md).
    for field in ("etag", "last_modified"):
        if available.get(field) and installed.get(field):
            return available[field] != installed[field]
    return True


# -- installed-set provenance ----------------------------------------------


def read_marker(set_dir: Path) -> dict | None:
    """The FNC provenance of an installed set, or None if it has none."""
    path = set_dir / MARKER
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get("source") != SOURCE_ID:
        return None
    return data


def installed_sets(sets_dir: Path, region_id: str | None = None) -> list[tuple[Path, dict]]:
    """Installed FNC sets, oldest edition first, optionally one region's.
    Ordered by the *marker's* publication date, not directory name — see
    docs/architecture/freenauticalchart-source.md."""
    if not sets_dir.is_dir():
        return []
    found = []
    for d in sorted(sets_dir.iterdir()):
        if not d.is_dir():
            continue
        marker = read_marker(d)
        if marker is None:
            continue
        if region_id is not None and marker.get("region") != region_id:
            continue
        found.append((d, marker))
    # name as the tiebreaker only, for a stable order among equal dates
    found.sort(
        key=lambda p: (
            _http_date(p[1].get("last_modified", "")),
            p[1].get("published", ""),
            p[0].name,
        )
    )
    return found


def installed_marker(sets_dir: Path, region_id: str) -> dict | None:
    """The marker of the newest installed set for one region."""
    found = installed_sets(sets_dir, region_id)
    if not found:
        return None
    set_dir, marker = found[-1]
    return {**marker, "set_id": set_dir.name}


def write_marker(chart_dir: Path, version: FncVersion) -> None:
    """Record provenance *inside the unpacked set*, before it is moved, so
    it lands with the set instead of dirtying an already-scanned directory."""
    (chart_dir / MARKER).write_text(
        json.dumps(
            {
                "source": SOURCE_ID,
                "region": version.region,
                "url": version.url,
                "etag": version.etag,
                "last_modified": version.last_modified,
                "published": version.published,
                "size": version.size,
                "license": "CC0-1.0",
            },
            indent=2,
        )
        + "\n"
    )


def retire_previous(sets_dir: Path, region_id: str, keep: str) -> list[str]:
    """Delete the region's older FNC sets, keeping ``keep``. Called only
    once the replacement passes its header scan: leaving an old set
    installed would double every cell over the same water. A *failed*
    update never reaches here."""
    removed, failed = [], []
    for set_dir, _ in installed_sets(sets_dir, region_id):
        if set_dir.name == keep:
            continue
        try:
            shutil.rmtree(set_dir)
        except OSError as e:
            log.error("could not retire superseded chart set %s: %s", set_dir.name, e)
            failed.append(set_dir.name)
            continue
        removed.append(set_dir.name)
    if removed:
        log.info("retired superseded FNC set(s): %s", ", ".join(removed))
    if failed:
        # Not fatal — the new set is installed and serving — but it is a real
        # degradation (duplicate coverage over the same water, both editions
        # bidding for the per-tile cell budget) and it will not fix itself.
        log.error(
            "freenauticalchart %s: %d superseded set(s) still installed (%s); "
            "delete them via DELETE /ocharts/sets/{id}",
            region_id,
            len(failed),
            ", ".join(failed),
        )
    return removed


# -- unpacked-set normalisation --------------------------------------------


def is_osenc(path: Path) -> bool:
    """True when the file's first record is an OSENC/SENC version header."""
    try:
        with path.open("rb") as fh:
            head = fh.read(_OSENC_HEADER.size)
    except OSError:
        return False
    if len(head) < _OSENC_HEADER.size:
        return False
    rtype, rlen, version = _OSENC_HEADER.unpack(head)
    return (rtype, rlen) == _OSENC_VERSION_RECORD and version in _OSENC_VERSION_RANGE


def normalize_cells(chart_dir: Path) -> list[Path]:
    """Rename verified-OSENC ``*.S57`` cells to ``*.senc``, in place — the
    publisher's extension is a misnomer chartcore's extension-based
    dispatch can't open. Gated on :func:`is_osenc` rather than applied
    blindly, so a real S-57 cell under the same name is left alone."""
    renamed = []
    for path in sorted(chart_dir.iterdir()):
        if not path.is_file() or path.suffix.lower() != PUBLISHED_CELL_SUFFIX:
            continue
        if not is_osenc(path):
            log.warning("%s is named .S57 but is not OSENC — left as is", path.name)
            continue
        target = path.with_suffix(NORMALIZED_CELL_SUFFIX)
        if target.exists():
            log.warning("%s already exists — leaving %s alone", target.name, path.name)
            continue
        path.rename(target)
        renamed.append(target)
    return renamed


def set_id_for(chart_dir: Path, version: FncVersion) -> str:
    """Installed directory name: the zip's own directory plus the edition
    date, so successive editions never collide. Date comes from
    ``Chartinfo.txt``, else the zip's ``Last-Modified`` — never today, or
    two installs of identical data would look like two editions."""
    from .keys import parse_set_info  # local: keys imports nothing from here

    title = parse_set_info(chart_dir).title
    match = _DATE_IN_TITLE.search(title)
    stamp = match.group(1) if match else (version.published or date.today().isoformat())
    set_id = f"{chart_dir.name}-{stamp}"
    if not _SET_ID_OK.match(set_id):
        raise FncError(f"refusing unusable chart set name {set_id!r}")
    return set_id


def prepare(version: FncVersion):
    """The installer's ``prepare`` hook: normalises cell extensions, records
    provenance, and returns the dated set-id — runs before the test-open."""

    def _prepare(chart_dir: Path) -> str:
        cells = normalize_cells(chart_dir)
        if not cells:
            raise FncError(
                f"no OSENC cells in {chart_dir.name} — "
                "the freenauticalchart archive layout may have changed"
            )
        write_marker(chart_dir, version)
        set_id = set_id_for(chart_dir, version)
        log.info(
            "freenauticalchart %s: %d cells, installing as %s",
            version.region,
            len(cells),
            set_id,
        )
        return set_id

    return _prepare


def on_installed(sets_dir: Path, region_id: str):
    """The installer's post-scan hook: retire the superseded edition."""

    def _done(target: Path) -> None:
        retire_previous(sets_dir, region_id, keep=target.name)

    return _done
