# SPDX-License-Identifier: GPL-2.0-only
"""Plugin-source ↔ OSM POI merging: one marker for one place.

When a point from a plugin POI source (:class:`~mivnav.features.poi.sources.PoiSource`
with a ``family``) and an OpenStreetMap point describe the same place (a
marina, a fuel dock, a harbour office…), the union tile draws only the
plugin source's one and carries the OSM point's props on it (``osm``: a JSON
list), so the info panel lists that hit and then the OSM hit. See
docs/architecture/poi-merge.md for the rule, the data behind its thresholds
and why it is computed here.

Three parts, all pure:

- :func:`family` — which comparable family a point belongs to (``None``: it
  never merges). Conservative: a restaurant can never swallow a marina. A
  plugin point's family comes from its source; an OSM point's from
  :data:`OSM_FAMILY`.
- :func:`match` — pair source and OSM points of one family within a
  per-family distance (a longer one when the names agree), one-to-one,
  nearest first.
- :class:`MergeTable` — the pairs, indexed per zoom by the tile each point
  lands in, and :meth:`MergeTable.rewrite` — drop the merged OSM points from
  a set's tile and annotate their partners.
"""

from __future__ import annotations

import json
import math
import re
import unicodedata
from collections import defaultdict
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from mivnav.charts.pmtiles import Archive, decompress
from mivnav.features.poi.mvt import EXTENT, decode_point_layer, encode_point_layer
from mivnav.features.poi.sources import poi_sources

__all__ = [
    "MERGE_VERSION",
    "OSM_FAMILY",
    "OSM_PROP",
    "RULES",
    "MergeTable",
    "Point",
    "archive_points",
    "build_table",
    "family",
    "match",
    "names_agree",
    "place",
    "place_key",
    "source_families",
]

#: Bump when the rule changes, so a client's cached union tile revalidates
#: into the new merge (folded into the union ETag).
MERGE_VERSION = 1

#: The plugin-source feature's prop carrying the merged OSM point(s): a JSON list of
#: ``{name?, kind, kind_detail?, set}``.
OSM_PROP = "osm"

#: The POI archives' vector layer.
LAYER = "pois"

# -- families -----------------------------------------------------------------

#: OSM ``kind`` (poi/tags.py) → family.
OSM_FAMILY: dict[str, str] = {
    "marina": "harbour",
    "harbour": "harbour",
    "harbourmaster": "office",
    "anchorage": "anchorage",
    "fuel": "fuel",
    "chandlery": "chandlery",
    "supermarket": "grocery",
    "convenience": "grocery",
    "restaurant": "food",
    "cafe": "food",
    "pub": "food",
    "toilets": "toilets",
    "laundry": "laundry",
    "atm": "atm",
    "hardware": "hardware",
    "hospital": "medical",
}


@dataclass(frozen=True)
class Rule:
    """Per family: merge within ``near_m`` whatever the names say, or within
    ``named_m`` when both are named and the names agree. ``near_m = 0``
    means a name match is required."""

    near_m: float
    named_m: float


#: Measured on the real Danish sets (docs/architecture/poi-merge.md).
RULES: dict[str, Rule] = {
    "harbour": Rule(150, 400),
    "office": Rule(50, 150),
    "anchorage": Rule(100, 300),
    "fuel": Rule(100, 200),
    "chandlery": Rule(50, 150),
    "toilets": Rule(50, 50),
    "laundry": Rule(50, 150),
    "atm": Rule(30, 30),
    # Proper-noun families: two restaurants or two supermarkets share a
    # building often (measured: "Super Brugsen" 10 m from "Kvickly"), so a
    # name match is required.
    "grocery": Rule(0, 100),
    "food": Rule(0, 100),
    "hardware": Rule(0, 100),
    "medical": Rule(0, 100),
}


#: ``src`` → that source's family function (``PoiSource.family``).
Families = Mapping[str, Callable[[Mapping[str, Any]], "str | None"]]


def source_families() -> dict[str, Callable[[Mapping[str, Any]], str | None]]:
    """Every registered plugin source that merges, by ``src``."""
    return {sid: s.family for sid, s in poi_sources().items() if s.family is not None}


def family(props: Mapping[str, object], families: Families | None = None) -> str | None:
    """The comparable family of one POI's props, or ``None`` (never merges).
    A point with a ``src`` belongs to that plugin source (``families``,
    default: the registered ones); one without is OpenStreetMap's."""
    src = props.get("src")
    if src:
        fams = source_families() if families is None else families
        fn = fams.get(src) if isinstance(src, str) else None
        return fn(props) if fn is not None else None
    kind = props.get("kind")
    return OSM_FAMILY.get(kind) if isinstance(kind, str) else None


# -- names ------------------------------------------------------------------

#: Words that say what a place is, not which one — never evidence that two
#: names agree (Danish, Swedish, Norwegian, German, English).
_GENERIC = frozenset(
    """
    marina marinas havn havnen hamn hamnen hafen harbour harbor port ports
    lystbadehavn lystbadehavnen badehavn smabatshamn gasthamn gasthamnen
    gjestehavn yachthafen yacht yachting sejlklub baadelaug badelaug
    fritidshavn jollehavn guest guests gaste
    office kontor havnekontor hamnkontor
    fuel dock station diesel tank
    anchorage ankerplads ankarplats mooring buoys
    restaurant restaurants cafe kafe bar pub kro grill pizzeria
    supermarket shop store grocery butik kiosk
    toilet toilets shower showers
    laundry vaskeri
    the and och og und der die das des den det
    """.split()
)


def _tokens(name: object, *, generic: bool = False) -> list[str]:
    if not isinstance(name, str):
        return []
    s = name.lower().replace("æ", "ae").replace("ø", "o").replace("ß", "ss")
    s = "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))
    return [
        t for t in re.findall(r"[a-z0-9]+", s) if len(t) >= 3 and (generic or t not in _GENERIC)
    ]


def _token_match(a: str, b: str) -> bool:
    short, long = (a, b) if len(a) <= len(b) else (b, a)
    if long.startswith(short):
        return True
    # Inflection: "Grönhögen" / "Grönhögens", "Hammerhavnens" / "Hammerhavns".
    n = 0
    for x, y in zip(a, b):
        if x != y:
            break
        n += 1
    return n >= 6


def _covered(short: list[str], long: list[str]) -> bool:
    return all(any(_token_match(s, t) for t in long) for s in short)


def names_agree(a: object, b: object) -> bool:
    """Is one name "the same name" as the other? Every distinctive word of the
    name with fewer of them must match a word of the other (generic words
    such as "Havn" or "Restaurant" ignored, diacritics folded, one word a
    prefix of the other or a ≥ 6-letter common stem). A shared town name
    alone is not enough: "Barth, Wirtschaftshafen" does not agree with
    "Stadthafen Barth Marina Ost". Also true when one squashed name contains
    the other ("Coop Super Brugsen" / "SuperBrugsen", "Willys" / "Willy:s"),
    and — for names made only of generic words — when one's words are all
    in the other ("Café Marina" / "Café Marina Restaurant")."""
    ta, tb = _tokens(a), _tokens(b)
    if ta and tb:
        short, long = (ta, tb) if len(ta) <= len(tb) else (tb, ta)
        if _covered(short, long):
            return True
        sa, sb = "".join(ta), "".join(tb)
        return len(min(sa, sb, key=len)) >= 4 and (sa in sb or sb in sa)
    ga, gb = _tokens(a, generic=True), _tokens(b, generic=True)
    if len(ga) < 2 or len(gb) < 2:
        return False
    short, long = (ga, gb) if len(ga) <= len(gb) else (gb, ga)
    return set(short) <= set(long)


# -- matching ------------------------------------------------------------------


@dataclass(frozen=True)
class Point:
    """One baked POI: its set, position and props (as baked)."""

    set_id: str
    lon: float
    lat: float
    props: Mapping[str, object]


def _distance_m(a: Point, b: Point) -> float:
    """Equirectangular metres — exact enough at a few hundred metres."""
    k = math.cos(math.radians((a.lat + b.lat) / 2))
    return math.hypot((a.lon - b.lon) * k * 111_320.0, (a.lat - b.lat) * 110_540.0)


def _max_reach_m() -> float:
    return max(max(r.near_m, r.named_m) for r in RULES.values())


def place_key(props: Mapping[str, object]) -> str | None:
    """A plugin point's identity across sets: ``"<src>:<ref>"``."""
    src, ref = props.get("src"), props.get("ref")
    return f"{src}:{ref}" if isinstance(src, str) and isinstance(ref, str) else None


def match(
    primary: Iterable[Point], osm: Iterable[Point], families: Families | None = None
) -> list[tuple[Point, Point, float]]:
    """``(primary, osm, metres)`` pairs describing the same place.

    A candidate pair is one family (:func:`family`) within that family's
    :class:`Rule`. Pairs are taken nearest first, one-to-one per OSM SET: a
    plugin place absorbs at most one point of each OSM set, and an OSM point
    joins at most one plugin place (keyed by ``src`` + ``ref``, so a copy in
    a second set of the same source is the same place). What is left keeps
    its own marker — a miss shows two markers, a false merge would hide a
    place."""
    fams = source_families() if families is None else families
    reach = _max_reach_m()
    cell = reach / 111_320.0 * 2  # degrees; generous in lon at high lat
    grid: dict[tuple[str, int, int], list[Point]] = defaultdict(list)
    for o in osm:
        fam = family(o.props, fams)
        if fam is not None:
            grid[(fam, int(o.lon // cell), int(o.lat // cell))].append(o)
    candidates: list[tuple[float, str, Point, Point]] = []
    seen_refs: set[str] = set()
    for n in primary:
        fam = family(n.props, fams)
        ref = place_key(n.props)
        if fam is None or ref is None or ref in seen_refs:
            continue
        seen_refs.add(ref)
        rule = RULES[fam]
        gx, gy = int(n.lon // cell), int(n.lat // cell)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for o in grid.get((fam, gx + dx, gy + dy), ()):
                    d = _distance_m(n, o)
                    if d <= rule.near_m or (
                        d <= rule.named_m and names_agree(n.props.get("name"), o.props.get("name"))
                    ):
                        candidates.append((d, ref, n, o))
    candidates.sort(key=lambda c: c[0])
    taken_osm: set[int] = set()
    taken_pair: set[tuple[str, str]] = set()  # (place key, osm set)
    out: list[tuple[Point, Point, float]] = []
    for d, ref, n, o in candidates:
        if id(o) in taken_osm or (ref, o.set_id) in taken_pair:
            continue
        taken_osm.add(id(o))
        taken_pair.add((ref, o.set_id))
        out.append((n, o, d))
    return out


# -- tiles ---------------------------------------------------------------------

_MAX_LAT = 85.0511


def _round_half_away(v: float) -> int:
    return int(math.floor(v + 0.5)) if v >= 0 else -int(math.floor(-v + 0.5))


def place(lon: float, lat: float, z: int) -> tuple[int, int, int, int]:
    """``(tile x, tile y, x, y in tile)`` exactly as chartcore's
    ``points.rs::place`` bakes a point (same wrap, clamps and rounding), so a
    table entry finds its own feature in a baked tile."""
    while lon > 180.0:
        lon -= 360.0
    while lon < -180.0:
        lon += 360.0
    lat = min(max(lat, -_MAX_LAT), _MAX_LAT)
    n = float(1 << z)
    fx = (lon + 180.0) / 360.0 * n
    fy = (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n
    last = (1 << z) - 1
    tx = min(max(math.floor(fx), 0), last)
    ty = min(max(math.floor(fy), 0), last)
    mx = min(max(_round_half_away((fx - tx) * EXTENT), 0), EXTENT)
    my = min(max(_round_half_away((fy - ty) * EXTENT), 0), EXTENT)
    return tx, ty, mx, my


def unplace(z: int, tx: int, ty: int, mx: int, my: int) -> tuple[float, float]:
    """A lon/lat that :func:`place` puts back in tile ``(tx, ty)`` at ``z``
    at ``(mx, my)`` (±0), and in the same ancestor tile at every lower zoom
    within ±1 unit — the inverse of the bake's quantisation, good to
    ~0.2 m at z14 in Denmark. An edge coordinate (``EXTENT``: rounded up
    from the last quarter unit) is pulled a quarter unit back inside, since
    ``tx + 1`` exactly would be the NEXT tile's west edge."""
    n = float(1 << z)
    fx = (tx + min(max(mx, 0), EXTENT - 0.25) / EXTENT) / n
    fy = (ty + min(max(my, 0), EXTENT - 0.25) / EXTENT) / n
    lon = fx * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * fy))))
    return lon, lat


def archive_points(set_id: str, archive: Archive) -> list[Point]:
    """Every point a baked POI archive holds, read from the archive itself:
    its max-zoom tiles, where each point sits in exactly one tile (baked with
    no buffer; a point above the archive's max zoom is clamped INTO it,
    ``python.rs::feature_min_zoom``), so no dedupe is needed and stacked
    duplicates stay two points, as in the bake's input. Props are the
    baked MVT tags. A tile that is not a one-layer point tile is skipped.
    Measured on the Danish OSM set (28,630 points, 5,096 z14 tiles):
    ~0.4 s on the dev box — see docs/architecture/poi-merge.md."""
    header = archive.header
    z = header.max_zoom
    out: list[Point] = []
    for tx, ty, stored in archive.tiles_at_zoom(z):
        decoded = decode_point_layer(decompress(header.tile_compression, stored), LAYER)
        if decoded is None:
            continue
        for mx, my, props in decoded:
            lon, lat = unplace(z, tx, ty, mx, my)
            out.append(Point(set_id, lon, lat, props))
    return out


def _osm_summary(o: Point) -> dict[str, object]:
    out: dict[str, object] = {"set": o.set_id}
    for key in ("name", "kind", "kind_detail"):
        value = o.props.get(key)
        if isinstance(value, str) and value:
            out[key] = value
    return out


def _int(v: object, default: int) -> int:
    return v if isinstance(v, int) and not isinstance(v, bool) else default


@dataclass
class _Drop:
    x: int
    y: int
    kind: object
    name: object


@dataclass
class MergeTable:
    """The merge, ready to apply per tile. ``drops[z][(x, y)][set_id]`` are
    the OSM points hidden from that tile; ``osm_for[key]`` is what a plugin
    place's feature carries (:func:`place_key`). An OSM point is hidden at
    zoom ``z`` only while its partner is drawn at ``z`` (``zooms_of[key]``),
    so zooming out past the partner's min zoom brings the OSM marker back
    rather than leaving the place blank."""

    pairs: list[tuple[Point, Point, float]] = field(default_factory=list)
    drops: dict[int, dict[tuple[int, int], dict[str, list[_Drop]]]] = field(default_factory=dict)
    #: ``annots[z][(x, y)]`` — the plugin sets whose tile there holds a merged place.
    annots: dict[int, dict[tuple[int, int], set[str]]] = field(default_factory=dict)
    osm_for: dict[str, str] = field(default_factory=dict)  # place key → JSON list
    zooms_of: dict[str, tuple[int, int]] = field(default_factory=dict)

    def __bool__(self) -> bool:
        return bool(self.pairs)

    def touches(self, z: int, x: int, y: int, set_id: str) -> bool:
        """Does set ``set_id``'s tile ``z/x/y`` change at all? Two dict
        lookups; only a tile holding a merged point pays for a rewrite."""
        key = (x, y)
        return set_id in self.drops.get(z, {}).get(key, {}) or set_id in self.annots.get(
            z, {}
        ).get(key, ())

    def rewrite(self, z: int, x: int, y: int, set_id: str, tile: bytes) -> bytes:
        """One set's (decompressed) tile with the merge applied: merged OSM
        points dropped, their partners annotated with ``osm``. Returns ``tile``
        itself when nothing in it changes (no re-encode)."""
        if not self.touches(z, x, y, set_id):
            return tile
        drops = self.drops.get(z, {}).get((x, y), {}).get(set_id, [])
        annotated = set_id in self.annots.get(z, {}).get((x, y), ())
        decoded = decode_point_layer(tile, LAYER)
        if decoded is None:  # not a one-layer point tile: leave it alone
            return tile
        changed = False
        kept: list[tuple[int, int, dict]] = []
        for fx, fy, props in decoded:
            if drops and any(
                abs(fx - d.x) <= 1 and abs(fy - d.y) <= 1
                and props.get("kind") == d.kind and props.get("name") == d.name
                for d in drops
            ):
                changed = True
                continue
            key = place_key(props) if annotated else None
            if key is not None:
                extra = self.osm_for.get(key)
                if extra is not None:
                    props = {**props, OSM_PROP: extra}
                    changed = True
            kept.append((fx, fy, props))
        if not changed:
            return tile
        return encode_point_layer(LAYER, kept)


def build_table(
    points: Sequence[Point],
    zooms: Mapping[str, tuple[int, int]],
    families: Families | None = None,
) -> MergeTable:
    """Match ``points`` (every enabled baked set's) and index the result.
    ``zooms[set_id]`` is the set archive's ``(min_zoom, max_zoom)``: a point
    is in its set's tiles from ``max(archive min, props min_zoom)`` to the
    archive's max (``points.rs::build_point_tileset``). ``families``
    defaults to the registered plugin sources'."""
    fams = source_families() if families is None else families
    primary = [p for p in points if p.props.get("src") in fams]
    osm = [p for p in points if not p.props.get("src")]
    pairs = match(primary, osm, fams)
    table = MergeTable(pairs=pairs)
    if not pairs:
        return table

    # Where each merged plugin place is drawn: the union over the sets
    # holding it (any copy draws the one marker).
    for n in primary:
        key = place_key(n.props)
        if key is None:
            continue
        lo, hi = zooms.get(n.set_id, (0, -1))
        lo = max(lo, _int(n.props.get("min_zoom"), 0))
        if lo > hi:
            continue
        cur = table.zooms_of.get(key)
        table.zooms_of[key] = (lo, hi) if cur is None else (min(cur[0], lo), max(cur[1], hi))

    by_key: dict[str, list[dict[str, object]]] = defaultdict(list)
    for n, o, _d in pairs:
        key = place_key(n.props)
        assert key is not None
        span = table.zooms_of.get(key)
        if span is None:
            continue  # the place is in no tile at all: nothing to merge into
        by_key[key].append(_osm_summary(o))
        olo, ohi = zooms.get(o.set_id, (0, -1))
        olo = max(olo, _int(o.props.get("min_zoom"), 0))
        for z in range(max(olo, span[0]), min(ohi, span[1]) + 1):
            tx, ty, mx, my = place(o.lon, o.lat, z)
            table.drops.setdefault(z, {}).setdefault((tx, ty), {}).setdefault(o.set_id, []).append(
                _Drop(mx, my, o.props.get("kind"), o.props.get("name"))
            )
    for n in primary:
        if place_key(n.props) not in by_key:
            continue
        lo, hi = zooms.get(n.set_id, (0, -1))
        for z in range(max(lo, _int(n.props.get("min_zoom"), 0)), hi + 1):
            tx, ty, _mx, _my = place(n.lon, n.lat, z)
            table.annots.setdefault(z, {}).setdefault((tx, ty), set()).add(n.set_id)
    table.osm_for = {
        key: json.dumps(items, ensure_ascii=False, separators=(",", ":"))
        for key, items in by_key.items()
    }
    return table
