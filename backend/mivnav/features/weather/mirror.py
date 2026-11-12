# SPDX-License-Identifier: GPL-2.0-only
"""``WeatherMirror`` — the read side of a baked weather dataset
(:mod:`mivnav.features.weather.ingest`): plain local-disk lookups the live
``/weather/data_spatial/...`` routes consult BEFORE the range-caching proxy
(:mod:`mivnav.features.weather.proxy`), completing item 3 of #rktyytqx
("live proxy path stays available for anything NOT downloaded"). See
docs/architecture/weather-mirror.md for why it's a separate store from the
proxy's chunk cache, why it needs no invalidation, and the offline semantics.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

# Duplicates proxy.py's private `_RANGE_RE`/`_parse_range` on purpose: a
# ~5-line parse, not worth importing a private helper across modules for.
_RANGE_RE = re.compile(r"^bytes=(\d+)-(\d*)$")

# Same filename shape as proxy.py's `_OM_NAME_RE` and ingest.py's `_om_path`
# writes — duplicated for the same reason as `_RANGE_RE` above.
_OM_NAME_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})\.om$")

IMMUTABLE_HEADERS_BASE = {
    "Accept-Ranges": "bytes",
    "Content-Type": "application/octet-stream",
    "Cache-Control": "public, max-age=31536000, immutable",
}


def _parse_range(header: str) -> tuple[int | None, int | None]:
    m = _RANGE_RE.match(header.strip()) if header else None
    if not m:
        return None, None
    return int(m.group(1)), (int(m.group(2)) if m.group(2) else None)


@dataclass(frozen=True)
class BakedDomain:
    """What one Open-Meteo domain currently has on this boat's disk.

    ``first``/``last`` are ISO-8601 UTC valid times, a closed range (not a
    list) for the client's "you have this offline, from here to here" ruler.
    See docs/architecture/weather-mirror.md.
    """

    domain: str
    first: str
    last: str
    files: int


class WeatherMirror:
    """Baked ``.om`` files across every declared ``weather`` dataset,
    addressed by the SAME relative path the live route already builds
    (``routes.py``'s ``full = f"data_spatial/{path}"``).

    ``roots`` is ordered by ``Config.datasets`` declaration order; the FIRST
    root that has a path baked wins. See docs/architecture/weather-mirror.md.
    """

    def __init__(self, roots: Sequence[Path]) -> None:
        self._roots = list(roots)

    def resolve(self, full: str) -> Path | None:
        """The first dataset root with ``full`` baked, or ``None``. ``full``
        is the exact string ``mivnav.features.weather.routes`` builds from
        the request path (``f"data_spatial/{path}"``)."""
        for root in self._roots:
            candidate = root / full
            if candidate.is_file():
                return candidate
        return None

    def baked_paths(self) -> dict[str, dict[str, str]]:
        """``{domain: {ISO valid time: om path}}`` for every ``.om`` on disk.

        The path must be SCANNED rather than computed from today's manifest —
        a baked file sits under the run directory current when it was baked,
        not today's reference time. See docs/architecture/weather-mirror.md
        for why, and for the newest-run-wins tie-break.
        """
        out: dict[str, dict[str, str]] = {}
        for root in self._roots:
            base = root / "data_spatial"
            if not base.is_dir():
                continue
            for domain_dir in base.iterdir():
                if not domain_dir.is_dir():
                    continue
                seen_here: dict[str, str] = {}
                for om_file in domain_dir.rglob("*.om"):
                    m = _OM_NAME_RE.match(om_file.name)
                    if m is None:
                        continue
                    y, mo, d, h, mi = m.groups()
                    when = f"{y}-{mo}-{d}T{h}:{mi}:00Z"
                    rel = om_file.relative_to(base).as_posix()
                    if rel > seen_here.get(when, ""):
                        seen_here[when] = rel
                if not seen_here:
                    # A domain directory with nothing decodable in it is not a
                    # domain this boat has — reporting it would put an empty
                    # source in the picker.
                    continue
                per_domain = out.setdefault(domain_dir.name, {})
                for when, rel in seen_here.items():
                    per_domain.setdefault(when, rel)
        return out

    def baked_times(self) -> dict[str, list[str]]:
        """``{domain: [ISO valid time, ...]}`` for every ``.om`` on disk —
        the exact set, not the first/last/count span :meth:`baked` reduces
        to. See docs/architecture/weather-mirror.md.
        """
        return {domain: sorted(times) for domain, times in self.baked_paths().items()}

    def baked(self) -> list[BakedDomain]:
        """Every domain with at least one ``.om`` on disk, across every root,
        with the valid-time span it covers — the "what does this boat have
        offline" answer ``GET /weather/baked`` serves (#tttsxnuo).

        Derived from the FILESYSTEM, not ``Config.datasets``: a declared
        dataset is an intention, and this must match what :meth:`resolve`
        will actually serve. See docs/architecture/weather-mirror.md.
        """
        spans = self.baked_times()
        return [
            # Lexicographic min/max is chronological for this fixed-width,
            # always-UTC ISO shape — no parsing needed.
            BakedDomain(domain=domain, first=min(times), last=max(times), files=len(times))
            for domain, times in sorted(spans.items())
        ]

    def head(self, full: str) -> tuple[int, dict[str, str]] | None:
        """``(200, headers)`` if ``full`` is baked, else ``None`` (fall
        through to the live proxy's own HEAD probe)."""
        path = self.resolve(full)
        if path is None:
            return None
        try:
            size = path.stat().st_size
        except OSError:
            return None
        return 200, {"Content-Length": str(size), **IMMUTABLE_HEADERS_BASE}

    def get_range(
        self, full: str, range_header: str
    ) -> tuple[int, dict[str, str], bytes] | None:
        """``(status, headers, body)`` for a ranged GET of ``full`` if baked,
        else ``None``. Mirrors :meth:`~mivnav.features.weather.proxy.
        WeatherProxy.om_range`'s response shape (206/416 + the same header
        set) so the route handler can return either result unchanged."""
        path = self.resolve(full)
        if path is None:
            return None
        try:
            size = path.stat().st_size
        except OSError:
            return None
        start, end = _parse_range(range_header)
        if start is None:
            return 416, {"Content-Range": "bytes */*"}, b""
        if start >= size:
            return 416, {"Content-Range": f"bytes */{size}"}, b""
        if end is None or end >= size:
            end = size - 1
        try:
            with path.open("rb") as f:
                f.seek(start)
                body = f.read(end - start + 1)
        except OSError:
            return None
        headers = {
            "Content-Range": f"bytes {start}-{end}/{size}",
            # The .om payload is already compressed — see WeatherProxy.om_range
            # for why identity encoding matters with a 206 + Content-Range body.
            "Content-Encoding": "identity",
            **IMMUTABLE_HEADERS_BASE,
        }
        return 206, headers, body
