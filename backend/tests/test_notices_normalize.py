# SPDX-License-Identifier: GPL-2.0-only
"""Niord → the efs.md §6 shapes: geometry explosion and roles, anchors,
position numbering, classification, firing windows, sanitising. Pure
functions over the recorded fixtures (tests/fixtures/niord) plus small
synthetic messages for what today's real data never carries (buffers,
multi-geometries)."""

from __future__ import annotations

import copy
from collections import Counter
from datetime import date

import pytest

from mivnav.features.notices.classify import classify_subject, strip_prefix
from mivnav.features.notices.model import Message, parse_messages
from mivnav.features.notices.normalize import (
    FAMILIES,
    Options,
    interior_point,
    line_midpoint,
    merge_normalized,
    normalize_bundle,
    normalize_message,
    _point_in_ring,
)
from mivnav.features.notices.sanitize import sanitize_html
from tests.fake_niord import FE_ID, load

OPTS = Options(base_url="https://niord.dma.dk")
TODAY = date(2026, 10, 3)


def bundle(**over):
    b = {
        "main": {"data": load("messages.json")},
        "fa": {"data": load("fa.json")},
        "almanac": {"data": load("almanac.json")},
        "annex": {"data": load("annex.json")},
        "periods": {"day": "2026-10-03", "data": load("periods_2026-10-03.json")},
    }
    b.update(over)
    return b


@pytest.fixture(scope="module")
def norm():
    return normalize_bundle(bundle(), today=TODAY, opts=OPTS)


def feats(norm, key):
    msg = norm.aliases.get(key, key)
    return [f for f in norm.feature_collection["features"] if f["properties"]["msg"] == msg]


def roles(features):
    return Counter(f["properties"]["role"] for f in features)


# -- the whole bundle --------------------------------------------------------


def test_every_feed_lands_in_the_list_with_its_family(norm):
    fams = Counter(r["fam"] for r in norm.items)
    assert fams == {"nm-t": 4, "nw": 2, "nm-perm": 1, "nm-misc": 1, "fe": 1, "fa": 2, "efs-a": 1, "efs-b": 1}
    assert norm.by_family == {f: fams.get(f, 0) for f in FAMILIES}
    assert set(norm.details) == {r["id"] for r in norm.items}


def test_map_has_only_point_line_polygon_and_contract_props(norm):
    fc = norm.feature_collection
    assert fc["type"] == "FeatureCollection"
    for f in fc["features"]:
        assert f["geometry"]["type"] in ("Point", "LineString", "Polygon")
        p = f["properties"]
        for k in ("msg", "sid", "fam", "cls", "sub", "win", "gl", "role"):
            assert k in p, (k, p)
        assert p["role"] in ("area", "line", "point", "anchor", "vertex")
        if p["role"] in ("point", "vertex"):
            assert isinstance(p["n"], str)
        if p["fam"] == "fa":
            assert isinstance(p["firing_today"], bool)
    # numeric feature ids, unique (MapLibre feature-state)
    ids = [f["id"] for f in fc["features"]]
    assert len(ids) == len(set(ids))


def test_point_message(norm):
    fs = feats(norm, "Local Warning-224-26")
    assert roles(fs) == {"point": 1}
    p = fs[0]["properties"]
    assert (p["fam"], p["cls"], p["sub"], p["n"]) == ("nw", "light", "unlit", "1")


def test_multipoint_is_exploded_with_numbers_and_vertex_labels(norm):
    fs = feats(norm, "NM-403-25")
    assert roles(fs) == {"point": 2}
    assert [f["properties"]["n"] for f in fs] == ["1", "2"]
    assert fs[0]["properties"]["vl_da"] == "gul stage med krydstopbetegnelse"
    assert fs[0]["properties"]["vl_en"]


def test_open_line_gets_midpoint_anchor_and_numbered_vertices(norm):
    fs = feats(norm, "NM-842-26")
    r = roles(fs)
    assert r["line"] == 1 and r["anchor"] == 1
    line = next(f for f in fs if f["properties"]["role"] == "line")
    coords = line["geometry"]["coordinates"]
    assert r["vertex"] == len(coords)
    anchor = next(f for f in fs if f["properties"]["role"] == "anchor")
    assert anchor["geometry"]["coordinates"] == pytest.approx(line_midpoint(coords), abs=2e-6)
    assert [f["properties"]["n"] for f in fs if f["properties"]["role"] == "vertex"] == [
        str(i + 1) for i in range(len(coords))
    ]


def test_polygon_gets_interior_anchor_and_skips_closing_vertex(norm):
    fs = feats(norm, "NM-879-26")
    area = next(f for f in fs if f["properties"]["role"] == "area")
    ring = area["geometry"]["coordinates"][0]
    assert ring[0] == ring[-1]
    assert roles(fs)["vertex"] == len(ring) - 1
    anchor = next(f for f in fs if f["properties"]["role"] == "anchor")["geometry"]["coordinates"]
    assert _point_in_ring(anchor[0], anchor[1], ring)


def test_firing_exercise_area_name_and_signal_masts_numbered_on(norm):
    fs = feats(norm, FE_ID)
    area = next(f for f in fs if f["properties"]["role"] == "area")["properties"]
    assert (area["name_da"], area["name_en"]) == ("EK D 396 Hullebæk", "EK D 396 Hullebaek")
    masts = [f["properties"] for f in fs if f["properties"]["role"] == "point"]
    # startCoordIndex 6 continues the polygon's 5 positions
    assert [(m["n"], m["vl_da"], m["vl_en"]) for m in masts] == [
        ("6", "Signalmast 1.", "Signal mast 1."),
        ("7", "Signalmast 2.", "Signal mast 2."),
    ]
    assert area["sid"] is None and area["fam"] == "fe" and area["cls"] == "firing"
    # one window per firing day, from the TIME part
    assert len(area["win"]) == 3 and all(b is not None for _, b in area["win"])


def test_greenland_flag_and_exclusion(norm):
    assert next(r for r in norm.items if r["sid"] == "NM-887-26")["gl"] is True
    assert all(not r["gl"] for r in norm.items if r["sid"] != "NM-887-26")
    without = normalize_bundle(
        bundle(), today=TODAY, opts=Options(base_url=OPTS.base_url, regions=frozenset({"dk"}))
    )
    assert "NM-887-26" not in without.aliases
    assert not [f for f in without.feature_collection["features"] if f["properties"]["gl"]]


def test_regions_filter_by_area_root(norm):
    """Greenland = areas rooted at urn:mrn:iho:country:gl; everything else
    (incl. a DK/DE border notice) is Danish waters; a notice with no area
    at all (EfS A general chapter) belongs to every region."""
    def sids(regions):
        n = normalize_bundle(bundle(), today=TODAY, opts=Options(base_url=OPTS.base_url, regions=regions))
        return {r["sid"] for r in n.items}

    every = {r["sid"] for r in norm.items}
    assert len(every) == 13
    assert sids(frozenset({"dk", "gl"})) == every
    assert sids(frozenset({"dk"})) == every - {"NM-887-26"}
    assert sids(frozenset({"gl"})) == {"NM-887-26", "A/24 2026"}
    assert "NM-053-26" in sids(frozenset({"dk"}))  # rooted in DK and DE


def test_merge_dedupes_and_renumbers():
    dk = normalize_bundle(bundle(), today=TODAY, opts=Options(base_url=OPTS.base_url, regions=frozenset({"dk"})))
    gl = normalize_bundle(bundle(), today=TODAY, opts=Options(base_url=OPTS.base_url, regions=frozenset({"gl"})))
    merged = merge_normalized([dk, gl])
    # A/24 (no area) is in both parts — once in the merge
    assert len(merged.items) == 13 and len({r["id"] for r in merged.items}) == 13
    assert sum(merged.by_family.values()) == 13
    ids = [f["id"] for f in merged.feature_collection["features"]]
    assert ids == list(range(len(ids)))
    assert len(merged.search_records) == 13
    assert set(merged.details) == {r["id"] for r in merged.items}
    assert merged.aliases["NM-887-26"] in merged.details


def test_no_geometry_notice_is_list_only(norm):
    row = next(r for r in norm.items if r["sid"] == "NM-245-25")
    assert (row["has_geometry"], row["lon"], row["lat"]) == (False, None, None)
    assert (row["fam"], row["cls"]) == ("nm-misc", "general")
    assert not feats(norm, "NM-245-25")
    # windows fall back to the publication window when no part has dates
    efs_a = next(r for r in norm.items if r["fam"] == "efs-a")
    assert efs_a["has_geometry"] is False and efs_a["cls"] == "general"


def test_list_row_shape(norm):
    row = next(r for r in norm.items if r["sid"] == "NM-879-26")
    assert set(row) == {
        "id", "sid", "fam", "cls", "sub", "title", "vicinity", "area", "win", "publish_from",
        "publish_to", "created", "updated", "lon", "lat", "gl", "has_geometry",
    }
    assert row["title"]["da"].startswith("Danmark. Østersøen.")
    assert row["title"]["en"].startswith("Denmark. The Baltic Sea.")
    assert row["area"]["da"][:2] == ["Danmark", "Østersøen"]
    assert row["area"]["en"][:2] == ["Denmark", "The Baltic Sea"]


def test_detail_shape_attachments_references_charts(norm):
    d = norm.details[norm.aliases["NM-053-26"]]
    assert set(d) >= {
        "id", "sid", "fam", "cls", "sub", "main_type", "type", "status", "title", "vicinity", "area",
        "publication", "source", "charts", "references", "original", "win", "publish_from",
        "publish_to", "created", "updated", "parts", "attachments", "pdf", "bbox",
    }
    assert [r["id"] for r in d["references"]] == ["NM-270-22", "NM-306-25"]
    assert d["charts"][2] == {"number": "103", "int_number": 1303, "scale": 200000}
    a = d["attachments"][0]
    assert a["url"].startswith("/notices/attachments/") and a["mime"] == "application/pdf"
    assert a["url"].rsplit("/", 1)[1] in norm.attachments
    assert d["pdf"]["da"] == (
        f"https://niord.dma.dk/rest/message-reports/message/{d['id']}.pdf?lang=da"
    )
    west, south, east, north = d["bbox"]
    assert west < east and south < north


def test_detail_parts_are_sanitised_both_languages(norm):
    d = norm.details[FE_ID]
    assert [p["type"] for p in d["parts"]] == ["TIME", "DETAILS", "PROHIBITION", "SIGNALS", "NOTE"]
    signals = d["parts"][3]["details"]
    assert "<span" not in signals["da"] and 'class="no-border"' not in signals["da"]
    assert "<table>" in signals["da"] and signals["en"]
    assert d["parts"][1]["subject"] == {"da": "Skydeøvelser. Advarsel.", "en": "Firing exercises. Warning."}
    assert d["parts"][0]["win"] and d["parts"][2]["win"] == []


# -- firing areas ---------------------------------------------------------------


def _fa(norm, sid):
    return next(r for r in norm.items if r["sid"] == sid)


def test_firing_area_today_from_the_schedule(norm):
    assert _fa(norm, "FA/EK-R-18 2026")["win"] == [[1791007200000, 1791057600000]]
    assert _fa(norm, "FA/EK-D-396 2026")["win"] == []
    flags = {f["properties"]["firing_today"] for f in feats(norm, "FA/EK-R-18 2026")}
    assert flags == {True}


def test_firing_area_and_its_exercise_share_an_area_mrn(norm):
    """The join key the info panel folds a firing area's permanent definition
    (fa) and its firing-exercise warning (fe) on: every feature of both
    carries the one area MRN; no other family carries one."""
    fa = {f["properties"].get("mrn") for f in feats(norm, "FA/EK-D-396 2026")}
    fe = {f["properties"].get("mrn") for f in feats(norm, FE_ID)}
    assert fa == fe == {"urn:mrn:iho:fa:dk:ek-d-396"}
    assert {f["properties"].get("mrn") for f in feats(norm, "FA/EK-R-18 2026")} == {"urn:mrn:iho:fa:dk:ek-r-18"}
    others = [f for f in norm.feature_collection["features"] if f["properties"]["fam"] not in ("fa", "fe")]
    assert others and all("mrn" not in f["properties"] for f in others)


def test_firing_area_falls_back_to_exercise_dates_without_a_schedule():
    """No schedule (unofficial endpoint failed): the dma-fe message for the
    same area carries every firing day — 5 Oct is one of them."""
    n = normalize_bundle(bundle(periods={}), today=date(2026, 10, 5), opts=OPTS)
    assert _fa(n, "FA/EK-D-396 2026")["win"] == [[1791180000000, 1791230400000]]
    assert _fa(n, "FA/EK-R-18 2026")["win"] == []  # no exercise message for it


def test_a_schedule_for_another_day_is_not_used():
    n = normalize_bundle(bundle(), today=date(2026, 10, 4), opts=OPTS)
    assert _fa(n, "FA/EK-R-18 2026")["win"] == []


def test_firing_areas_can_be_switched_off():
    n = normalize_bundle(
        bundle(), today=TODAY, opts=Options(base_url=OPTS.base_url, include_firing_areas=False)
    )
    assert not [r for r in n.items if r["fam"] == "fa"]


# -- defensive geometry -----------------------------------------------------------


def _msg(features, **over):
    raw = {
        "id": "00000000-0000-0000-0000-000000000001",
        "shortId": "NM-001-26",
        "mainType": "NM",
        "type": "TEMPORARY_NOTICE",
        "messageSeries": {"seriesId": "dma-nm"},
        "descs": [{"lang": "da", "title": "Danmark. Kattegat. Vrag."}, {"lang": "en", "title": "Denmark. Kattegat. Wreck."}],
        "parts": [{"type": "DETAILS", "geometry": {"type": "FeatureCollection", "features": features}, "descs": []}],
    }
    raw.update(over)
    return Message.model_validate(raw)


def _feature(geom, **props):
    return {"type": "Feature", "geometry": geom, "properties": props}


def test_buffered_point_becomes_an_area_with_anchor():
    msg = _msg([_feature({"type": "Point", "coordinates": [11.0, 56.0]}, bufferRadius=1, bufferRadiusType="nm")])
    _row, _doc, fs = normalize_message(msg, None, OPTS)
    assert roles(fs) == {"area": 1, "anchor": 1}
    ring = fs[0]["geometry"]["coordinates"][0]
    # ~1 nm = 1852 m ≈ 0.01667° of latitude
    assert max(c[1] for c in ring) == pytest.approx(56.0 + 1852 / 111_195, abs=2e-4)
    anchor = fs[1]["geometry"]["coordinates"]
    assert anchor == pytest.approx([11.0, 56.0], abs=1e-3)


def test_buffered_line_becomes_areas():
    msg = _msg(
        [_feature({"type": "LineString", "coordinates": [[11.0, 56.0], [11.1, 56.0], [11.1, 56.1]]}, bufferRadius=200)]
    )
    _row, _doc, fs = normalize_message(msg, None, OPTS)
    assert roles(fs) == {"area": 2, "anchor": 2}


def test_editor_buffer_feature_is_an_unnumbered_area():
    """``parentFeatureIds`` marks the editor's computed buffer polygon;
    Niord does not number its coordinates, neither do we — and it does not
    advance the position counter of the features after it."""
    ring = [[11.0, 56.0], [11.1, 56.0], [11.1, 56.1], [11.0, 56.0]]
    msg = _msg(
        [
            _feature({"type": "Polygon", "coordinates": [ring]}, parentFeatureIds="a,b", restriction="affected"),
            _feature({"type": "Point", "coordinates": [11.05, 56.05]}),
        ]
    )
    _row, _doc, fs = normalize_message(msg, None, OPTS)
    assert roles(fs) == {"area": 1, "anchor": 1, "point": 1}
    assert next(f for f in fs if f["properties"]["role"] == "point")["properties"]["n"] == "1"


def test_multi_geometries_and_garbage_are_survived():
    msg = _msg(
        [
            _feature({"type": "MultiLineString", "coordinates": [[[11, 56], [11.1, 56]], [[12, 56], [12.1, 56]]]}),
            _feature(
                {"type": "MultiPolygon", "coordinates": [[[[11, 56], [11.1, 56], [11.1, 56.1], [11, 56]]]]}
            ),
            _feature({"type": "Point", "coordinates": ["x", None]}),
            _feature({"type": "Polygon", "coordinates": [[[11, 56], [11.1, 56]]]}),
            _feature(None),
        ]
    )
    _row, _doc, fs = normalize_message(msg, None, OPTS)
    r = roles(fs)
    assert (r["line"], r["area"]) == (2, 1)


def test_one_bad_message_does_not_sink_the_feed():
    raw = load("messages.json")
    bad = copy.deepcopy(raw)
    bad.append({"no": "id"})
    bad.append({"id": "x", "parts": "not a list"})
    assert len(parse_messages(bad)) == len(raw)


def test_interior_point_of_a_concave_ring():
    # a "C": the centroid falls in the notch, outside the ring
    ring = [[0, 0], [10, 0], [10, 2], [2, 2], [2, 8], [10, 8], [10, 10], [0, 10], [0, 0]]
    p = interior_point(ring)
    assert _point_in_ring(p[0], p[1], ring)


def test_line_midpoint_is_by_length():
    assert line_midpoint([[0, 0], [0, 1], [0, 3]]) == [0, 1.5]


# -- classification ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "lang", "expected"),
    [
        ("Fyr slukket", "da", ("light", "unlit")),
        ("Light unlit", "en", ("light", "unlit")),
        ("Lystønde slukket", "da", ("light", "unlit")),
        ("Lystønde flyttet", "da", ("buoy", "moved")),
        ("Dagsømærke forsvundet", "da", ("buoy", "missing")),
        ("Buoy missing", "en", ("buoy", "missing")),
        ("Afmærkning ikke på plads og i orden", "da", ("buoy", "off-station")),
        ("Båke ændret. Rettelse", "da", ("beacon", "changed")),
        ("Vrag. Forbudsområde oprettet", "da", ("wreck", None)),
        ("Mindre dybder. Afmærkning udlagt", "da", ("depth", "reduced")),
        ("Normal dybde", "da", ("depth", "normal")),
        ("Anlægsarbejde. Arbejdsområde oprettet", "da", ("works", None)),
        ("Construction works", "en", ("works", None)),
        ("Geofysiske undersøgelser", "da", ("survey", None)),
        ("Afmærket måleudstyr udlagt", "da", ("survey", "established")),
        ("Oprensning afsluttet", "da", ("dredging", "completed")),
        ("Kabelarbejde afsluttet. Virtuel AtoN nedlagt", "da", ("cable", "completed")),
        ("Rørarbejde. Midlertidigt forbudsområde oprettet", "da", ("cable", None)),
        ("Broklap lukket", "da", ("bridge", None)),
        ("Bridge leaf closed", "en", ("bridge", None)),
        ("Afmærket havbrug inddraget", "da", ("farm", "withdrawn")),
        ("Skydeøvelser. Advarsel", "da", ("firing", None)),
        ("Minelægnings- og minerydningsøvelse", "da", ("exercise", None)),
        ("Drivende container", "da", ("drifting", None)),
        ("RACON ude af drift", "da", ("radionav", None)),
        ("Sommertid 2026 ophører", "da", ("general", None)),
        ("Tilsanding. Havn lukket for anløb. Afmærkning inddraget. Fyr slukket", "da", ("depth", None)),
    ],
)
def test_classification_table(text, lang, expected):
    assert classify_subject(text, lang) == expected


def test_title_prefix_is_not_classified():
    """A bridge named in the LOCALITY must not make a works notice a bridge
    notice."""
    title = "Danmark. Smålandsfarvandet. Guldborgsund. Kong Frederik IX's Bro. Anlægsarbejde."
    subject = strip_prefix(title, ["Danmark", "Smålandsfarvandet", "Guldborgsund. Kong Frederik IX's Bro"])
    assert subject == "Anlægsarbejde"
    assert classify_subject(subject) == ("works", None)


def test_categories_win_over_the_title():
    msg = _msg(
        [],
        categories=[{"descs": [{"lang": "en", "name": "Buoy adrift"}], "parent": {"descs": [{"lang": "en", "name": "Drifting object"}]}}],
        parts=[{"type": "DETAILS", "descs": [{"lang": "da", "subject": "Gult dagsømærke"}]}],
    )
    row, _doc, _fs = normalize_message(msg, None, OPTS)
    assert (row["cls"], row["sub"]) == ("drifting", None)


def test_unknown_subject_with_geometry_is_other_without_is_general():
    geo = [_feature({"type": "Point", "coordinates": [11, 56]})]
    descs = [{"lang": "da", "title": "Danmark. Kattegat. Noget helt andet."}]
    row, _d, _f = normalize_message(_msg(geo, descs=descs), None, OPTS)
    assert row["cls"] == "other"
    row, _d, _f = normalize_message(_msg([], descs=descs, parts=[]), None, OPTS)
    assert row["cls"] == "general"


# -- sanitiser ----------------------------------------------------------------------


def test_sanitiser_allow_list():
    html = (
        '<p class="MsoNormal" style="margin:0">Hej<o:p>&nbsp;</o:p><span style="x">verden</span></p>'
        '<table class="position-table no-border"><tr><td colspan="2">1)</td></tr></table>'
        '<table class="other"><tr><td>x</td></tr></table>'
        '<a href="javascript:alert(1)">bad</a><a href="https://danskehavnelods.dk/x">ok</a>'
        '<a href="mailto:contact@example.com">mail</a><a href="/rest/repo/file/a.pdf">rel</a>'
        "<script>alert(1)</script><img src=x onerror=alert(1)><p>&nbsp;</p>"
    )
    out = sanitize_html(html, "https://niord.dma.dk")
    assert "<p>Hej&nbsp;verden</p>" in out
    assert '<table class="position-table">' in out and '<table><tbody><tr><td>x</td>' in out
    assert 'colspan="2"' in out
    assert "javascript" not in out and "<script" not in out and "alert" not in out and "<img" not in out
    assert 'href="https://danskehavnelods.dk/x"' in out and 'href="mailto:contact@example.com"' in out
    assert 'href="https://niord.dma.dk/rest/repo/file/a.pdf"' in out
    assert "style" not in out and "MsoNormal" not in out and "o:p" not in out
    assert not out.endswith("<p>&nbsp;</p>")


def test_sanitiser_empty():
    assert sanitize_html(None) is None
    assert sanitize_html("   ") is None
    assert sanitize_html("<p>&nbsp;</p><span></span>") is None
