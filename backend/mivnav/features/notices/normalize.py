# SPDX-License-Identifier: GPL-2.0-only
"""Raw Niord messages → the shapes the API serves (efs.md §6, frozen):

* one GeoJSON FeatureCollection for the map — Point/LineString/Polygon
  only, every MultiPoint exploded, each feature tagged with its ``role``
  (``area``/``line``/``point``/``anchor``/``vertex``);
* compact list rows (every notice, also the ones without geometry);
* full detail documents, both languages, HTML sanitised.

Pure functions of ``(bundle, now, options)`` — no I/O — so the runtime can
re-run them on the stored raw bundle whenever "today" or an option
changes, and tests can run them on recorded fixtures.

Geometry conventions are Niord's own (niord-web ``map-service.js
serializeReadableCoordinates`` / niord-core ``GeoJsonUtils``): position
numbers run from the feature's ``startCoordIndex``, polygons skip their
closing coordinate, and a feature with ``parentFeatureIds`` or
``restriction: "affected"`` is an editor-computed buffer whose coordinates
are not numbered.
"""

from __future__ import annotations

import hashlib
import logging
import math
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from typing import Any

from mivnav.features.notices.classify import classify_category, classify_subject, strip_prefix
from mivnav.features.notices.client import NIORD_TZ
from mivnav.features.notices.ids import REGION_DK, REGION_GL
from mivnav.features.notices.model import (
    Area,
    Category,
    FiringAreaPeriods,
    Message,
    Part,
    parse_messages,
    parse_periods,
)
from mivnav.features.notices.sanitize import sanitize_html
from mivnav.search import SearchRecord

log = logging.getLogger(__name__)

LANGS = ("da", "en")
GREENLAND_MRN = "urn:mrn:iho:country:gl"

FAMILIES = ("nw", "fe", "nm-t", "nm-p", "nm-perm", "nm-misc", "fa", "efs-a", "efs-b")

_NM_TYPE_FAMILY = {
    "TEMPORARY_NOTICE": "nm-t",
    "PRELIMINARY_NOTICE": "nm-p",
    "PERMANENT_NOTICE": "nm-perm",
    "MISCELLANEOUS_NOTICE": "nm-misc",
}

#: Where in a bundle each feed lives, and the family it forces (``None`` =
#: derive from series/type).
FEEDS: tuple[tuple[str, str | None], ...] = (
    ("main", None),
    ("fa", "fa"),
    ("almanac", "efs-a"),
    ("annex", "efs-b"),
)

_COORD_DP = 6
_BUFFER_SEGMENTS = 32
_EARTH_R = 6_371_008.8
_UNIT_M = {"m": 1.0, "km": 1000.0, "nm": 1852.0}


Bilingual = dict[str, Any]


# -- small helpers ---------------------------------------------------------


def _pick(descs: Iterable[Any], lang: str, attr: str) -> str | None:
    for d in descs:
        if getattr(d, "lang", None) == lang:
            v = getattr(d, attr, None)
            if isinstance(v, str) and v.strip():
                return v.strip()
            return None
    return None


def _bi(descs: Iterable[Any], attr: str) -> Bilingual:
    descs = list(descs)
    return {lang: _pick(descs, lang, attr) for lang in LANGS}


def _bi_or_none(descs: Iterable[Any], attr: str) -> Bilingual | None:
    b = _bi(descs, attr)
    return b if any(b.values()) else None


def _area_chain(area: Area) -> list[Area]:
    chain: list[Area] = []
    node: Area | None = area
    while node is not None and len(chain) < 16:
        chain.append(node)
        node = node.parent
    chain.reverse()
    return chain


def area_path(msg: Message) -> dict[str, list[str]]:
    """Root-first area names of the message's first area, per language
    (a level missing a language falls back to the other)."""
    out: dict[str, list[str]] = {lang: [] for lang in LANGS}
    if not msg.areas:
        return out
    for node in _area_chain(msg.areas[0]):
        names = {lang: _pick(node.descs, lang, "name") for lang in LANGS}
        for lang in LANGS:
            name = names[lang] or next((n for n in names.values() if n), None)
            if name:
                out[lang].append(name)
    return out


def is_greenland(msg: Message) -> bool:
    return REGION_GL in message_regions(msg)


#: The Niord regions a message can belong to, by its areas' ROOT: Greenland
#: under ``urn:mrn:iho:country:gl``, every other root (Denmark, and the odd
#: cross-border area rooted in Germany/Sweden) is Danish waters. Ids are the
#: ``dk-niord`` source's region ids (:mod:`mivnav.features.notices.catalog`).


def message_regions(msg: Message) -> frozenset[str]:
    """The regions ``msg`` is about; EMPTY for a message with no area at all
    (EfS A general chapters) — such a message belongs to every region."""
    out: set[str] = set()
    for area in msg.areas:
        root = _area_chain(area)[0]
        greenland = root.mrn == GREENLAND_MRN or any(
            (d.name or "").strip() in ("Grønland", "Greenland") for d in root.descs
        )
        out.add(REGION_GL if greenland else REGION_DK)
    return frozenset(out)


def in_regions(msg: Message, regions: frozenset[str] | None) -> bool:
    """Whether ``msg`` is kept for a dataset showing ``regions`` (``None`` =
    every region): any overlap, and a region-less message always."""
    if regions is None:
        return True
    own = message_regions(msg)
    return not own or bool(own & regions)


def area_mrns(msg: Message) -> set[str]:
    return {a.mrn for a in msg.areas if a.mrn}


def family(msg: Message, forced: str | None = None) -> str:
    if forced:
        return forced
    series = msg.series_id or ""
    if series == "dma-fe":
        return "fe"
    if series == "dma-fa":
        return "fa"
    if series.endswith("almanac"):
        return "efs-a"
    if series.endswith("annex"):
        return "efs-b"
    if msg.mainType == "NW":
        return "nw"
    return _NM_TYPE_FAMILY.get(msg.type or "", "nm-misc")


def _category_names(cat: Category) -> list[str]:
    names: list[str] = []
    node: Category | None = cat
    while node is not None and len(names) < 32:
        names.extend(d.name for d in node.descs if d.name)
        node = node.parent
    return names


def classify(msg: Message, fam: str) -> tuple[str, str | None]:
    """``(cls, sub)`` — see :mod:`mivnav.features.notices.classify`."""
    if fam == "fa":
        return "firing", None
    if fam in ("efs-a", "efs-b"):
        return "general", None
    hit = classify_category([_category_names(c) for c in msg.categories])
    if hit is not None:
        return hit
    for lang in LANGS:
        subjects = [_pick(p.descs, lang, "subject") for p in msg.parts]
        text = ". ".join(s.rstrip(". ") for s in subjects if s)
        if not text:
            title = _pick(msg.descs, lang, "title") or ""
            prefix = [*area_path(msg)[lang], _pick(msg.descs, lang, "vicinity") or ""]
            text = strip_prefix(title, prefix)
        hit = classify_subject(text, lang) if text else None
        if hit is not None:
            return hit
    if fam == "nm-misc" or not _has_geometry(msg):
        return "general", None
    return "other", None


def _has_geometry(msg: Message) -> bool:
    return any(p.geometry and p.geometry.get("features") for p in msg.parts)


Window = list  # [from_ms, to_ms | None]


def _part_windows(part: Part) -> list[Window]:
    return [[e.fromDate, e.toDate] for e in part.eventDates if e.fromDate is not None]


def windows(msg: Message) -> list[Window]:
    """Activity windows from every part's ``eventDates`` (deduplicated,
    sorted); else the publication window; else none."""
    seen: set[tuple[int, int | None]] = set()
    for part in msg.parts:
        for w in _part_windows(part):
            seen.add((w[0], w[1]))
    if seen:
        return [[a, b] for a, b in sorted(seen, key=lambda t: (t[0], t[1] or 0))]
    if msg.publishDateFrom is not None:
        return [[msg.publishDateFrom, msg.publishDateTo]]
    return []


# -- geometry --------------------------------------------------------------


def _r(c: Sequence[float]) -> list[float]:
    return [round(float(c[0]), _COORD_DP), round(float(c[1]), _COORD_DP)]


def _valid_coord(c: object) -> bool:
    return (
        isinstance(c, (list, tuple))
        and len(c) >= 2
        and all(isinstance(v, (int, float)) and math.isfinite(v) for v in c[:2])
    )


def _xy(lon: float, lat: float, lat0: float) -> tuple[float, float]:
    """Local equirectangular metres-ish plane (fine at notice scale)."""
    return lon * math.cos(math.radians(lat0)), lat


def line_midpoint(coords: Sequence[Sequence[float]]) -> list[float]:
    """The point halfway along the line, by (locally scaled) length."""
    if len(coords) == 1:
        return _r(coords[0])
    lat0 = sum(c[1] for c in coords) / len(coords)
    pts = [_xy(c[0], c[1], lat0) for c in coords]
    seg = [math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1)]
    total = sum(seg)
    if total == 0:
        return _r(coords[0])
    half = total / 2
    for i, s in enumerate(seg):
        if half <= s and s > 0:
            t = half / s
            a, b = coords[i], coords[i + 1]
            return _r((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
        half -= s
    return _r(coords[-1])


def _point_in_ring(x: float, y: float, ring: Sequence[Sequence[float]]) -> bool:
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y):
            xc = (xj - xi) * (y - yi) / (yj - yi) + xi
            if x < xc:
                inside = not inside
        j = i
    return inside


def _scanline_mid(ring: Sequence[Sequence[float]], y: float) -> tuple[float, float] | None:
    """Midpoint of the widest inside-interval of the horizontal line at
    ``y`` — an interior point even for a concave (C/L-shaped) ring."""
    xs: list[float] = []
    n = len(ring)
    for i in range(n):
        a, b = ring[i], ring[(i + 1) % n]
        if (a[1] > y) != (b[1] > y):
            xs.append(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]))
    xs.sort()
    best: tuple[float, float] | None = None
    for i in range(0, len(xs) - 1, 2):
        width = xs[i + 1] - xs[i]
        if best is None or width > best[0]:
            best = (width, (xs[i] + xs[i + 1]) / 2)
    return (best[1], y) if best is not None and best[0] > 0 else None


def interior_point(ring: Sequence[Sequence[float]]) -> list[float]:
    """A point guaranteed inside the polygon's exterior ring: its area
    centroid when that is inside, else the middle of the widest inside run
    of a few horizontal scanlines (the PostGIS ``ST_PointOnSurface`` idea)."""
    pts = [c for c in ring]
    if len(pts) > 1 and pts[0][0] == pts[-1][0] and pts[0][1] == pts[-1][1]:
        pts = pts[:-1]
    if len(pts) < 3:
        return _r(pts[0]) if pts else [0.0, 0.0]
    a = cx = cy = 0.0
    for i in range(len(pts)):
        x0, y0 = pts[i][0], pts[i][1]
        x1, y1 = pts[(i + 1) % len(pts)][0], pts[(i + 1) % len(pts)][1]
        f = x0 * y1 - x1 * y0
        a += f
        cx += (x0 + x1) * f
        cy += (y0 + y1) * f
    if a != 0:
        c = (cx / (3 * a), cy / (3 * a))
        if _point_in_ring(c[0], c[1], pts):
            return _r(c)
    ys = [p[1] for p in pts]
    lo, hi = min(ys), max(ys)
    best: tuple[float, tuple[float, float]] | None = None
    for k in range(1, 8):
        y = lo + (hi - lo) * k / 8
        # nudge off vertex latitudes so the crossing count stays exact
        if any(abs(y - v) < 1e-12 for v in ys):
            y += (hi - lo) * 1e-6
        mid = _scanline_mid(pts, y)
        if mid is not None:
            # prefer the scanline nearest the middle on ties
            score = -abs(k - 4)
            if best is None or score > best[0]:
                best = (score, mid)
    if best is not None:
        return _r(best[1])
    return _r((sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)))


def _offset(lon: float, lat: float, bearing: float, dist_m: float) -> tuple[float, float]:
    """Destination point on a sphere (fine for a few nm)."""
    d = dist_m / _EARTH_R
    la1, lo1 = math.radians(lat), math.radians(lon)
    la2 = math.asin(math.sin(la1) * math.cos(d) + math.cos(la1) * math.sin(d) * math.cos(bearing))
    lo2 = lo1 + math.atan2(
        math.sin(bearing) * math.sin(d) * math.cos(la1), math.cos(d) - math.sin(la1) * math.sin(la2)
    )
    return math.degrees(lo2), math.degrees(la2)


def _circle(c: Sequence[float], radius_m: float) -> list[list[list[float]]]:
    ring = [
        _r(_offset(c[0], c[1], 2 * math.pi * i / _BUFFER_SEGMENTS, radius_m))
        for i in range(_BUFFER_SEGMENTS)
    ]
    ring.append(ring[0])
    return [ring]


def _capsule(a: Sequence[float], b: Sequence[float], radius_m: float) -> list[list[list[float]]]:
    """One buffered line segment: two half circles joined (a stadium)."""
    lat0 = (a[1] + b[1]) / 2
    ax, ay = _xy(a[0], a[1], lat0)
    bx, by = _xy(b[0], b[1], lat0)
    heading = math.atan2(bx - ax, by - ay)  # bearing-like: 0 = north
    half = _BUFFER_SEGMENTS // 2
    ring: list[list[float]] = []
    for i in range(half + 1):  # around b, left → right
        ring.append(_r(_offset(b[0], b[1], heading - math.pi / 2 + math.pi * i / half, radius_m)))
    for i in range(half + 1):  # around a, right → left
        ring.append(_r(_offset(a[0], a[1], heading + math.pi / 2 + math.pi * i / half, radius_m)))
    ring.append(ring[0])
    return [ring]


def _buffer_radius_m(props: dict[str, Any]) -> float:
    try:
        r = float(props.get("bufferRadius") or 0)
    except (TypeError, ValueError):
        return 0.0
    unit = str(props.get("bufferRadiusType") or "m").lower()
    return max(r, 0.0) * _UNIT_M.get(unit, 1.0)


@dataclass
class _GeoAcc:
    """Features of one message (or one firing area) being built."""

    base: dict[str, Any]
    features: list[dict[str, Any]] = field(default_factory=list)
    coords: list[Sequence[float]] = field(default_factory=list)
    first_anchor: list[float] | None = None
    first_point: list[float] | None = None
    counter: int = 1

    def add(self, geom: dict[str, Any], role: str, **props: Any) -> None:
        p = dict(self.base)
        p["role"] = role
        p.update({k: v for k, v in props.items() if v is not None})
        self.features.append({"type": "Feature", "geometry": geom, "properties": p})


def _labels(props: dict[str, Any], i: int) -> dict[str, str | None]:
    return {f"vl_{lang}": _str(props.get(f"name:{i}:{lang}")) for lang in LANGS}


def _str(v: object) -> str | None:
    return v.strip() if isinstance(v, str) and v.strip() else None


def _explode(acc: _GeoAcc, feature: dict[str, Any]) -> None:
    geom = feature.get("geometry") or {}
    props = feature.get("properties") or {}
    gtype = geom.get("type")
    coords = geom.get("coordinates")
    start = props.get("startCoordIndex")
    if not isinstance(start, int):
        start = acc.counter
    names = {f"name_{lang}": _str(props.get(f"name:{lang}")) for lang in LANGS}
    is_buffer = bool(props.get("parentFeatureIds")) or props.get("restriction") == "affected"
    radius = _buffer_radius_m(props)

    def point(c: Sequence[float], n: int, i: int) -> None:
        acc.coords.append(c)
        if radius > 0:
            area(_circle(c, radius), numbered=False)
            return
        acc.add({"type": "Point", "coordinates": _r(c)}, "point", n=str(n), **_labels(props, i))
        if acc.first_point is None:
            acc.first_point = _r(c)

    def vertices(cs: Sequence[Sequence[float]]) -> None:
        for i, c in enumerate(cs):
            acc.add({"type": "Point", "coordinates": _r(c)}, "vertex", n=str(start + i), **_labels(props, i))

    def area(rings: list[list[list[float]]], *, numbered: bool) -> None:
        ring = [[float(c[0]), float(c[1])] for c in rings[0] if _valid_coord(c)]
        if len(ring) < 3:
            return
        if ring[0] != ring[-1]:
            ring = [*ring, ring[0]]
        acc.coords.extend(ring)
        clean = [[_r(c) for c in ring]] + [
            [_r(c) for c in r if _valid_coord(c)] for r in rings[1:] if isinstance(r, list)
        ]
        acc.add({"type": "Polygon", "coordinates": clean}, "area", **names)
        anchor = interior_point(ring)
        acc.add({"type": "Point", "coordinates": anchor}, "anchor")
        if acc.first_anchor is None:
            acc.first_anchor = anchor
        if numbered:
            vertices(ring[:-1])

    def line(cs: list[Sequence[float]]) -> None:
        cs = [c for c in cs if _valid_coord(c)]
        if len(cs) < 2:
            if cs:
                point(cs[0], start, 0)
            return
        acc.coords.extend(cs)
        if radius > 0:
            for a, b in zip(cs, cs[1:], strict=False):
                area(_capsule(a, b, radius), numbered=False)
            return
        acc.add({"type": "LineString", "coordinates": [_r(c) for c in cs]}, "line", **names)
        anchor = line_midpoint(cs)
        acc.add({"type": "Point", "coordinates": anchor}, "anchor")
        if acc.first_anchor is None:
            acc.first_anchor = anchor
        if not is_buffer:
            vertices(cs)

    n_coords = 0
    if gtype == "Point" and _valid_coord(coords):
        point(coords, start, 0)
        n_coords = 1
    elif gtype == "MultiPoint" and isinstance(coords, list):
        for i, c in enumerate(coords):
            if _valid_coord(c):
                point(c, start + i, i)
        n_coords = len(coords)
    elif gtype == "LineString" and isinstance(coords, list):
        line(coords)
        n_coords = len(coords)
    elif gtype == "MultiLineString" and isinstance(coords, list):
        for cs in coords:
            if isinstance(cs, list):
                line(cs)
                n_coords += len(cs)
    elif gtype == "Polygon" and isinstance(coords, list) and coords:
        area(coords, numbered=not is_buffer and radius == 0)
        n_coords = max(len(coords[0]) - 1, 0)
    elif gtype == "MultiPolygon" and isinstance(coords, list):
        for poly in coords:
            if isinstance(poly, list) and poly:
                area(poly, numbered=not is_buffer)
                n_coords += max(len(poly[0]) - 1, 0)
    elif gtype == "GeometryCollection":
        for g in geom.get("geometries") or []:
            _explode(acc, {"geometry": g, "properties": props})
        return
    elif gtype is not None:
        log.debug("notices: unsupported geometry type %s", gtype)
    if not is_buffer:
        acc.counter = start + n_coords


def _iter_features(msg: Message) -> Iterable[dict[str, Any]]:
    for part in msg.parts:
        g = part.geometry
        if not isinstance(g, dict):
            continue
        if g.get("type") == "FeatureCollection":
            yield from (f for f in g.get("features") or [] if isinstance(f, dict))
        elif g.get("type") == "Feature":
            yield g


def _bbox(coords: Sequence[Sequence[float]]) -> list[float] | None:
    if not coords:
        return None
    xs = [c[0] for c in coords]
    ys = [c[1] for c in coords]
    return [round(min(xs), _COORD_DP), round(min(ys), _COORD_DP), round(max(xs), _COORD_DP), round(max(ys), _COORD_DP)]


# -- firing areas ----------------------------------------------------------


def local_day_bounds(day: date) -> tuple[int, int]:
    start = datetime.combine(day, time(0), tzinfo=NIORD_TZ)
    end = datetime.combine(day + timedelta(days=1), time(0), tzinfo=NIORD_TZ)
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000)


def _overlaps(w: Window, lo: int, hi: int) -> bool:
    return w[0] < hi and (w[1] is None or w[1] > lo)


def firing_windows_today(
    fa_msg: Message,
    periods_by_mrn: dict[str, list[Window]] | None,
    fe_by_mrn: dict[str, list[Window]],
    today: date,
) -> list[Window]:
    """Today's firing periods for a permanent firing area: from the firing
    schedule when it was fetched for today, else from the firing-exercise
    (``dma-fe``) messages naming the same area (their TIME part carries
    every firing day) — the graceful fallback efs.md Q8 asks for."""
    lo, hi = local_day_bounds(today)
    mrns = area_mrns(fa_msg)
    if periods_by_mrn is not None:
        src = [w for m in mrns for w in periods_by_mrn.get(m, [])]
    else:
        src = [w for m in mrns for w in fe_by_mrn.get(m, [])]
    out = sorted({(w[0], w[1]) for w in src if _overlaps(w, lo, hi)}, key=lambda t: t[0])
    return [[a, b] for a, b in out]


# -- the whole bundle ------------------------------------------------------


@dataclass
class Normalized:
    feature_collection: dict[str, Any]
    items: list[dict[str, Any]]
    details: dict[str, dict[str, Any]]
    #: shortId → id, for ``GET /notices/{shortId}``.
    aliases: dict[str, str]
    #: attachment key → {url, mime, file_name}
    attachments: dict[str, dict[str, Any]]
    by_family: dict[str, int]
    search_records: list[SearchRecord]


@dataclass(frozen=True)
class Options:
    base_url: str
    #: The dataset's regions (see :func:`in_regions`); ``None`` = all.
    regions: frozenset[str] | None = None
    include_firing_areas: bool = True


def attachment_key(url: str) -> str:
    return hashlib.sha256(url.encode()).hexdigest()[:24]


def detail(msg: Message, fam: str, cls: str, sub: str | None, win: list[Window], opts: Options) -> dict[str, Any]:
    """The full detail document (efs.md §6 ``GET /notices/{id}``)."""
    coords = [c for f in _iter_features(msg) for c in _all_coords((f.get("geometry") or {}))]
    attachments = []
    for a in msg.attachments:
        if not a.path:
            continue
        attachments.append(
            {
                "url": f"/notices/attachments/{attachment_key(a.path)}",
                "file_name": a.fileName,
                "mime": a.type,
                "size": a.fileSize,
                "caption": _bi_or_none(a.descs, "caption"),
            }
        )
    pub = _bi(msg.descs, "publication")
    return {
        "id": msg.id,
        "sid": msg.shortId,
        "fam": fam,
        "cls": cls,
        "sub": sub,
        "main_type": msg.mainType,
        "type": msg.type,
        "status": msg.status,
        "title": _bi(msg.descs, "title"),
        "vicinity": _bi(msg.descs, "vicinity"),
        "area": area_path(msg),
        "publication": {lang: sanitize_html(pub[lang], opts.base_url) for lang in LANGS},
        "source": _bi(msg.descs, "source"),
        "charts": [
            {"number": c.chartNumber, "int_number": c.internationalNumber, "scale": c.scale}
            for c in msg.charts
        ],
        "references": [
            {"id": r.messageId, "type": r.type, "description": _bi_or_none(r.descs, "description")}
            for r in msg.references
        ],
        "original": bool(msg.originalInformation),
        "win": win,
        "publish_from": msg.publishDateFrom,
        "publish_to": msg.publishDateTo,
        "created": msg.created,
        "updated": msg.updated,
        "parts": [
            {
                "type": p.type,
                "subject": _bi_or_none(p.descs, "subject"),
                "hide_subject": bool(p.hideSubject),
                "details": {
                    lang: sanitize_html(_pick(p.descs, lang, "details"), opts.base_url) for lang in LANGS
                },
                "win": _part_windows(p),
            }
            for p in msg.parts
        ],
        "attachments": attachments,
        "pdf": {
            lang: f"{opts.base_url.rstrip('/')}/rest/message-reports/message/{msg.id}.pdf?lang={lang}"
            for lang in LANGS
        },
        "bbox": _bbox([c for c in coords if _valid_coord(c)]),
    }


def _all_coords(geom: dict[str, Any]) -> list[Sequence[float]]:
    out: list[Sequence[float]] = []

    def walk(x: object) -> None:
        if _valid_coord(x):
            out.append(x)  # type: ignore[arg-type]
        elif isinstance(x, list):
            for y in x:
                walk(y)

    if geom.get("type") == "GeometryCollection":
        for g in geom.get("geometries") or []:
            out.extend(_all_coords(g))
    else:
        walk(geom.get("coordinates"))
    return out


def normalize_message(
    msg: Message,
    forced_family: str | None,
    opts: Options,
    *,
    fa_window: list[Window] | None = None,
) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    """``(list row, detail, map features)`` for one message."""
    fam = family(msg, forced_family)
    cls, sub = classify(msg, fam)
    gl = is_greenland(msg)
    win = fa_window if fam == "fa" and fa_window is not None else windows(msg)
    base: dict[str, Any] = {
        "msg": msg.id,
        "sid": msg.shortId,
        "fam": fam,
        "cls": cls,
        "sub": sub,
        "win": win,
        "gl": gl,
    }
    if fam == "fa":
        base["firing_today"] = bool(fa_window)
    if fam in ("fa", "fe"):
        # The join key between a permanent firing area and the firing-exercise
        # warning Niord publishes for the SAME area (different uuids, same
        # polygon): the info panel folds the two into one entry on it. Only
        # when the message names exactly one area — with several there is no
        # single thing to fold into.
        mrns = area_mrns(msg)
        if len(mrns) == 1:
            base["mrn"] = next(iter(mrns))
    acc = _GeoAcc(base)
    for f in _iter_features(msg):
        _explode(acc, f)
    loc = acc.first_anchor or acc.first_point
    row = {
        "id": msg.id,
        "sid": msg.shortId,
        "fam": fam,
        "cls": cls,
        "sub": sub,
        "title": _bi(msg.descs, "title"),
        "vicinity": _bi(msg.descs, "vicinity"),
        "area": area_path(msg),
        "win": win,
        "publish_from": msg.publishDateFrom,
        "publish_to": msg.publishDateTo,
        "created": msg.created,
        "updated": msg.updated,
        "lon": loc[0] if loc else None,
        "lat": loc[1] if loc else None,
        "gl": gl,
        "has_geometry": bool(acc.features),
    }
    return row, detail(msg, fam, cls, sub, win, opts), acc.features


def search_record(row: dict[str, Any]) -> SearchRecord:
    """One search-index row: title + shortId + vicinity + area names, both
    languages, so "NM-842" and "Årø Sund fyr" both find it."""
    words = [
        row.get("sid") or "",
        *(v for v in row["title"].values() if v),
        *(v for v in row["vicinity"].values() if v),
        *row["area"]["da"],
        *row["area"]["en"],
    ]
    title = row["title"].get("en") or row["title"].get("da") or row.get("sid") or row["id"]
    return SearchRecord(
        id=row["id"],
        category=row["cls"],
        title=f"{row['sid']}: {title}" if row.get("sid") else title,
        text=" ".join(dict.fromkeys(w for w in words if w)),
        lat=row["lat"],
        lon=row["lon"],
        data={"kind": "notice", "id": row["id"], "sid": row.get("sid"), "fam": row["fam"], "cls": row["cls"]},
    )


def normalize_bundle(bundle: dict[str, Any], *, today: date, opts: Options) -> Normalized:
    """Everything the API serves, from one stored raw bundle (see
    :mod:`mivnav.features.notices.runtime` for its shape)."""
    feeds: list[tuple[list[Message], str | None]] = []
    for key, forced in FEEDS:
        raw = (bundle.get(key) or {}).get("data")
        if raw is None:
            continue
        if key == "fa" and not opts.include_firing_areas:
            continue
        feeds.append((parse_messages(raw), forced))

    periods_by_mrn: dict[str, list[Window]] | None = None
    periods = bundle.get("periods") or {}
    if periods.get("data") is not None and periods.get("day") == today.isoformat():
        periods_by_mrn = {}
        for entry in parse_periods(periods["data"]):
            if entry.area.mrn:
                periods_by_mrn[entry.area.mrn] = [
                    [p.fromDate, p.toDate] for p in entry.firingPeriods if p.fromDate is not None
                ]

    fe_by_mrn: dict[str, list[Window]] = {}
    for msgs, forced in feeds:
        for m in msgs:
            if family(m, forced) == "fe":
                for mrn in area_mrns(m):
                    fe_by_mrn.setdefault(mrn, []).extend(windows(m))

    features: list[dict[str, Any]] = []
    items: list[dict[str, Any]] = []
    details: dict[str, dict[str, Any]] = {}
    aliases: dict[str, str] = {}
    attachments: dict[str, dict[str, Any]] = {}
    for msgs, forced in feeds:
        for m in msgs:
            if m.id in details:
                continue  # same message in two feeds: first wins
            if not in_regions(m, opts.regions):
                continue
            fa_window = None
            if family(m, forced) == "fa":
                fa_window = firing_windows_today(m, periods_by_mrn, fe_by_mrn, today)
            try:
                row, doc, feats = normalize_message(m, forced, opts, fa_window=fa_window)
            except Exception:  # noqa: BLE001 — one odd message must not sink the feed
                log.exception("notices: could not normalise message %s", m.id)
                continue
            items.append(row)
            details[m.id] = doc
            features.extend(feats)
            if m.shortId:
                aliases.setdefault(m.shortId, m.id)
            for a in m.attachments:
                if a.path:
                    attachments[attachment_key(a.path)] = {
                        "url": a.path,
                        "mime": a.type,
                        "file_name": a.fileName,
                        "size": a.fileSize,
                    }
    for i, f in enumerate(features):
        f["id"] = i
    by_family = Counter(r["fam"] for r in items)
    return Normalized(
        feature_collection={"type": "FeatureCollection", "features": features},
        items=items,
        details=details,
        aliases=aliases,
        attachments=attachments,
        by_family={fam: by_family.get(fam, 0) for fam in FAMILIES},
        search_records=[search_record(r) for r in items],
    )


def merge_normalized(parts: Sequence[Normalized]) -> Normalized:
    """Several datasets' normalised notices as ONE (what ``/notices/*``
    serves): a message held by two datasets (overlapping regions) appears
    once — the first dataset's copy wins, in config order — and map feature
    ids are renumbered so they stay unique."""
    if len(parts) == 1:
        return parts[0]
    features: list[dict[str, Any]] = []
    items: list[dict[str, Any]] = []
    details: dict[str, dict[str, Any]] = {}
    aliases: dict[str, str] = {}
    attachments: dict[str, dict[str, Any]] = {}
    records: list[SearchRecord] = []
    for part in parts:
        fresh = {doc_id for doc_id in part.details if doc_id not in details}
        items.extend(r for r in part.items if r["id"] in fresh)
        features.extend(dict(f) for f in part.feature_collection["features"] if f["properties"]["msg"] in fresh)
        records.extend(r for r in part.search_records if r.id in fresh)
        for doc_id in fresh:
            details[doc_id] = part.details[doc_id]
        for sid, doc_id in part.aliases.items():
            if doc_id in fresh:
                aliases.setdefault(sid, doc_id)
        for key, info in part.attachments.items():
            attachments.setdefault(key, info)
    for i, f in enumerate(features):
        f["id"] = i
    by_family = Counter(r["fam"] for r in items)
    return Normalized(
        feature_collection={"type": "FeatureCollection", "features": features},
        items=items,
        details=details,
        aliases=aliases,
        attachments=attachments,
        by_family={fam: by_family.get(fam, 0) for fam in FAMILIES},
        search_records=records,
    )
