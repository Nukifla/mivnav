# SPDX-License-Identifier: GPL-2.0-only
"""mivport API client — the network half of the mivport POI source (pairs
with the pure :mod:`.mapping`). Every function takes the ``httpx.Client`` and
the server's base URL; callers read it from ``Config.mivport`` at bake time.

What a bake reads (see mivport's README / ``/openapi.yaml``):

- ``/exports/manifest.json`` — the offline files, each with sha256, plus
  ``core_seq`` (the last change they include) and the attribution;
- ``/exports/<region>.geojsonl.gz`` — every place, one GeoJSON Feature per
  line, with our ``attrs`` and the OSM ``osm_tags`` / ``osm_attrs``;
- ``/exports/dump/{reviews,photos}.jsonl.gz`` — all reviews and photo
  records (ours only — OSM has none);
- ``/v1/changes?since=<core_seq>`` — what changed after the export;
- ``/v1/places/{id}`` and ``/v1/places/{id}/photos`` — one place / its
  photos with their URLs and attribution.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import tempfile
from collections.abc import Iterator
from typing import Any
from urllib.parse import quote

import httpx

__all__ = [
    "MivportError",
    "USER_AGENT",
    "fetch_changes",
    "fetch_export_lines",
    "fetch_json",
    "fetch_manifest",
    "fetch_place",
    "fetch_place_photos",
]

USER_AGENT = "mivnav"

DEFAULT_TIMEOUT_S = 60.0

#: ``/v1/changes`` page size (the API's maximum is 10000).
CHANGES_PAGE = 5000

#: Stop following ``/v1/changes`` after this many pages: past that the
#: export is so far behind that the next one is the cheaper catch-up.
MAX_CHANGE_PAGES = 50


class MivportError(Exception):
    """A mivport request failed: transport, HTTP status, checksum or bad JSON."""


def _url(base_url: str, path: str) -> str:
    return base_url.rstrip("/") + path


def _get(http: httpx.Client, url: str, **params: Any) -> httpx.Response:
    try:
        resp = http.get(
            url,
            params=params or None,
            headers={"User-Agent": USER_AGENT},
            timeout=DEFAULT_TIMEOUT_S,
        )
    except httpx.HTTPError as exc:
        raise MivportError(f"{url}: {exc}") from exc
    return resp


def fetch_json(http: httpx.Client, url: str, ok: tuple[int, ...] = (200,), **params: Any) -> Any:
    resp = _get(http, url, **params)
    if resp.status_code not in ok:
        raise MivportError(f"{url}: HTTP {resp.status_code}")
    try:
        return resp.json()
    except ValueError as exc:
        raise MivportError(f"{url}: not JSON: {exc}") from exc


def fetch_manifest(http: httpx.Client, base_url: str) -> dict:
    manifest = fetch_json(http, _url(base_url, "/exports/manifest.json"))
    if not isinstance(manifest, dict) or not isinstance(manifest.get("files"), list):
        raise MivportError("exports manifest has no file list")
    return manifest


def manifest_file(manifest: dict, path: str) -> dict | None:
    for entry in manifest.get("files") or ():
        if isinstance(entry, dict) and entry.get("path") == path:
            return entry
    return None


def fetch_export_lines(
    http: httpx.Client, base_url: str, entry: dict
) -> Iterator[dict]:
    """Download one gzipped JSON-lines export to a temp file (streamed, the
    sha256 checked against the manifest ``entry``), then yield its records.
    Spooled to disk, not RAM: the world file is the size that matters."""
    path = entry["path"]
    url = _url(base_url, "/exports/" + quote(path))
    want = entry.get("sha256")
    with tempfile.TemporaryFile() as tmp:
        digest = hashlib.sha256()
        try:
            with http.stream(
                "GET", url, headers={"User-Agent": USER_AGENT}, timeout=DEFAULT_TIMEOUT_S
            ) as resp:
                if resp.status_code != 200:
                    raise MivportError(f"{url}: HTTP {resp.status_code}")
                for chunk in resp.iter_bytes():
                    digest.update(chunk)
                    tmp.write(chunk)
        except httpx.HTTPError as exc:
            raise MivportError(f"{url}: {exc}") from exc
        if isinstance(want, str) and want and digest.hexdigest() != want:
            raise MivportError(f"{path}: checksum mismatch (export rebuilt mid-download?)")
        tmp.seek(0)
        try:
            with gzip.open(tmp, "rt", encoding="utf-8") as lines:
                for line in lines:
                    line = line.strip()
                    if line:
                        yield json.loads(line)
        except (OSError, ValueError, EOFError) as exc:
            raise MivportError(f"{path}: unreadable: {exc}") from exc


def fetch_changes(http: httpx.Client, base_url: str, since: int) -> tuple[list[dict], int]:
    """Every revision after ``since`` (oldest first) and the next ``since``."""
    out: list[dict] = []
    for _ in range(MAX_CHANGE_PAGES):
        page = fetch_json(
            http, _url(base_url, "/v1/changes"), since=since, limit=CHANGES_PAGE
        )
        revisions = page.get("revisions") if isinstance(page, dict) else None
        if not isinstance(revisions, list):
            raise MivportError("/v1/changes: no revisions list")
        out.extend(r for r in revisions if isinstance(r, dict))
        nxt = page.get("next_since")
        if isinstance(nxt, int):
            since = nxt
        if not page.get("more") or not revisions:
            return out, since
    raise MivportError(f"/v1/changes: more than {MAX_CHANGE_PAGES} pages behind the export")


def fetch_place(http: httpx.Client, base_url: str, place_id: str) -> tuple[dict | None, bool]:
    """``(feature, deleted)`` for one place: ``(None, True)`` when it is gone
    (404) and the last state with ``deleted`` for a 410."""
    url = _url(base_url, "/v1/places/" + quote(place_id, safe=":"))
    resp = _get(http, url)
    if resp.status_code == 404:
        return None, True
    if resp.status_code not in (200, 410):
        raise MivportError(f"{url}: HTTP {resp.status_code}")
    try:
        body = resp.json()
    except ValueError as exc:
        raise MivportError(f"{url}: not JSON: {exc}") from exc
    feature = body.get("feature") if isinstance(body, dict) else None
    if not isinstance(feature, dict):
        raise MivportError(f"{url}: no feature")
    return feature, resp.status_code == 410


def fetch_place_photos(http: httpx.Client, base_url: str, place_id: str) -> list[dict]:
    url = _url(base_url, "/v1/places/" + quote(place_id, safe=":") + "/photos")
    body = fetch_json(http, url)
    photos = body.get("photos") if isinstance(body, dict) else None
    return [p for p in photos or () if isinstance(p, dict)]


def fetch_bytes(http: httpx.Client, url: str, max_bytes: int) -> tuple[bytes, str]:
    """One file → ``(body, content type)``."""
    resp = _get(http, url)
    if resp.status_code != 200:
        raise MivportError(f"{url}: HTTP {resp.status_code}")
    body = resp.content
    if not body or len(body) > max_bytes:
        raise MivportError(f"{url}: bad size {len(body)}")
    return body, resp.headers.get("content-type", "").split(";", 1)[0].strip().lower()
