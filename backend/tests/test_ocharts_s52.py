# SPDX-License-Identifier: GPL-2.0-only
"""S-52 LUP wiring on the o-charts on-demand decode path: cells opened by
the service resolve ATON LABELS (lbl_*) from the lookup data when it is
available, degrade gracefully when it is not, and the availability is
visible in the service status.

The SYMBOLS (`sym_s`) no longer come from here. jt task uzosnxzs
ported s57.json's S-57-attribute -> symbol selection into chartcore's
`derive::aton`, replacing chartsymbols.xml LUP resolution for ATON
outright, so an ATON symbol is now derived from the feature's own
attributes and is present whether or not any S-52 lookup data loaded. These
expectations were still the pre-uzosnxzs ones (`BOYLAT24`/`BOYSPR01`); a
stale installed chartcore wheel hid that until qkmvmwps rebuilt it."""

import math
from pathlib import Path

import chartcore

from senc_fixture import aton_cell

from mivnav.features.ocharts.service import OchartsService

# Minimal chartsymbols.xml: a Simplified BOYLAT lookup keyed on COLOUR=4
# with a symbol + OBJNAM label, and an attribute-less Paper fallback.
LUPS_XML = """<lookups>
<lookup id="1" RCID="1" name="BOYLAT"><type>Point</type>
  <disp-prio>Hazards</disp-prio><table-name>Simplified</table-name>
  <attrib-code index="0">COLOUR4</attrib-code>
  <instruction>SY(BOYLAT24);TE('by %s','OBJNAM',2,1,2,'15110',-1,-1,CHBLK,21)</instruction>
  <display-cat>Standard</display-cat></lookup>
<lookup id="2" RCID="2" name="BOYLAT"><type>Point</type>
  <disp-prio>Hazards</disp-prio><table-name>Paper</table-name>
  <instruction>SY(BOYSPR01)</instruction><display-cat>Standard</display-cat></lookup>
</lookups>
"""


def tile_of(lat: float, lon: float, z: int) -> tuple[int, int]:
    n = 1 << z
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return x, y


def make_set(tmp_path: Path) -> Path:
    sets_dir = tmp_path / "ocharts"
    set_dir = sets_dir / "oeuSENC-ATON"
    set_dir.mkdir(parents=True)
    aton_cell(set_dir / "OC-ATON-1.senc", bounds=(11.0, 54.0, 11.2, 54.2))
    (set_dir / "keys.xml").write_text(
        "<keyList><Chart><FileName>OC-ATON-1</FileName>"
        "<RInstallKey>fabricated</RInstallKey></Chart>"
        "<ChartInfo>ATON Set</ChartInfo><Edition>2026/01-1</Edition></keyList>"
    )
    return sets_dir


def service_for(tmp_path: Path, **kwargs) -> OchartsService:
    return OchartsService(
        sets_dir=make_set(tmp_path),
        daemon_dir=tmp_path / "daemon",
        work_dir=tmp_path / "work",
        warm_overview=False,
        **kwargs,
    )


def aton_tags(service: OchartsService) -> list[dict]:
    import gzip

    cs = service.get("oeuSENC-ATON")
    assert cs is not None
    # Serve at z14, not z12: the fixture buoy carries no charted SCAMIN, so the
    # derive pass now assigns it the synthetic point-symbol default (1:45000),
    # which the server-side drop hides at coarse overview zooms. z14
    # (scale_denom ≈ 34124 ≤ 45000) is inside its visible band, so the ATON
    # symbol-resolution assertions below still see the buoy.
    x, y = tile_of(54.1, 11.1, 14)
    tile = service.tile(cs, 14, x, y)
    assert tile is not None
    return chartcore.tile_feature_tags(gzip.decompress(tile), "ATON")


def test_tile_carries_resolved_aton_symbols(tmp_path: Path) -> None:
    s52_file = tmp_path / "chartsymbols.xml"
    s52_file.write_text(LUPS_XML)
    service = service_for(tmp_path, s52_path=s52_file)
    (buoy,) = aton_tags(service)
    # The fixture buoy has COLOUR=4 (green) and no BOYSHP, so `boyshp_symbol`
    # falls to its documented default shape 5 (spar) with COLPAT 0 — the same
    # key chartcore's own icons::pack test pins. One key only: the ported
    # source has no Paper/Simplified split, so the `sym_p` twin is gone.
    assert buoy["sym_s"] == "BOYSHP/5/0/4"
    # The LABEL still comes from this file's TE(...) instruction — that half of
    # the LUP wiring is what this module is actually testing now.
    assert buoy["lbl_s"] == "by No 7"
    s52 = service.status()["s52"]
    assert s52 == {
        "available": True,
        "source": str(s52_file),
        "lookups": 2,
        "error": None,
    }


def test_configured_s52_path_resolves_s52_data(tmp_path: Path) -> None:
    # was test_env_var_resolves_s52_data: MIVNAV_S57DATA is gone with every
    # other config env var, so the path now arrives as what it always
    # really was — a constructor argument, fed from config `ocharts.s52_path`
    s52_file = tmp_path / "chartsymbols.xml"
    s52_file.write_text(LUPS_XML)
    service = service_for(tmp_path, s52_path=s52_file)
    assert service.status()["s52"]["source"] == str(s52_file)
    (buoy,) = aton_tags(service)
    assert buoy["lbl_s"] == "by No 7"


def test_missing_s52_data_degrades_gracefully(tmp_path: Path) -> None:
    # a configured-but-broken path must warn, not fail serving
    service = service_for(tmp_path, s52_path=tmp_path / "nope.xml")
    s52 = service.status()["s52"]
    assert s52["available"] is False
    assert s52["error"]
    (buoy,) = aton_tags(service)  # tile still serves
    # No LUP data -> no label. The SYMBOL survives, because it never came from
    # the LUPs (see the module docstring) — which is the point of having ported
    # the selection logic: a boat with no chartsymbols.xml still gets buoys.
    assert "lbl_s" not in buoy
    assert buoy["sym_s"] == "BOYSHP/5/0/4"
